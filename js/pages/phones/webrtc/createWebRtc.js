/**
 * Phones › WebRTC — Create
 *
 * Bulk-creates WebRTC phones for the users in an org who should have one and
 * do not, after reporting exactly who that is.
 *
 * Two phases, and nothing is written in the first:
 *
 *   1. Analyse — read the org's active users, their licence assignments and
 *      its existing phones, then classify every user into "will get a phone"
 *      or "skipped, because…". The result is rendered as a per-user review
 *      with the phone name each create would use.
 *   2. Create — on confirmation, POST one phone per ticked user, recording the
 *      outcome per row. Skips are decided in phase 1, so this phase only ever
 *      issues calls that are expected to succeed.
 *
 * Splitting it this way is what makes the skip rules honest. The previous
 * version decided everything inside the write loop: it POSTed for every user
 * and inferred "already had one" from the error text that came back, which
 * meant a genuine bad request was indistinguishable from a duplicate and the
 * summary counts could not be trusted.
 *
 * API endpoints:
 *   GET  /api/v2/telephony/providers/edges/sites
 *   GET  /api/v2/telephony/providers/edges/phonebasesettings
 *   GET  /api/v2/telephony/providers/edges/phonebasesettings/{id}
 *   GET  /api/v2/telephony/providers/edges/phones
 *   GET  /api/v2/users?expand=division
 *   GET  /api/v2/license/users
 *   POST /api/v2/telephony/providers/edges/phones
 */
import { escapeHtml, sleep, timestampedFilename, exportLogXlsx } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import { logAction } from "../../../services/activityLogService.js";

// ── Licence classification ──────────────────────────────────────────
//
// `GET /api/v2/license/users` returns `{ id, licenses: ["genesysCloudCX2", …] }`
// — the licences are plain id STRINGS, not objects. (The previous version read
// them as `{name|id}` objects, so every licence came back as an empty string
// and the collaborate rule never once fired.)
//
// Collaborate users cannot hold a WebRTC phone, so they are skipped. The test
// is a substring match on the licence id rather than a fixed enum, because the
// id set differs between orgs and grows over time. To keep that guess visible
// rather than silent, every distinct licence id seen during a run is listed in
// the Findings panel with the classification it was given — if an org uses an
// id this does not recognise, the review shows it before anything is written.

const COLLABORATE_HINT = /collaborate/i;

function isCollaborateLicence(id) {
  return COLLABORATE_HINT.test(String(id));
}

// ── WebRTC phone base settings ──────────────────────────────────────

/**
 * Does this phone base describe a WebRTC softphone?
 *
 * `phoneMetaBase.id` is the stable signal — it is the platform's own model
 * identifier and survives renaming. The name check is a fallback for orgs
 * whose base predates that field being populated; on its own it is not
 * enough, since a base called "WebRTC (retired)" would win on name alone.
 */
function isWebRtcBase(base) {
  const meta = String(base?.phoneMetaBase?.id || "").toLowerCase();
  if (meta) return meta.includes("webrtc");
  return String(base?.name || "").toLowerCase().includes("webrtc");
}

// ── Phone naming ────────────────────────────────────────────────────

/**
 * Pick a phone name that is not already taken.
 *
 * Phone names are unique per org, so two users called "Anna Berg" cannot both
 * have "Anna Berg - WebRTC". The old version created the first and let the
 * second fail. Resolving it here means the collision is visible in the review
 * (the row is flagged) and the create still goes through.
 *
 * @param {{ name: string, email: string, userId: string }} user
 * @param {Set<string>} taken  Lower-cased names already in use. Not mutated.
 */
function uniquePhoneName(user, taken) {
  const preferred = `${user.name} - WebRTC`;
  const local = String(user.email || "").split("@")[0];

  const candidates = [preferred];
  if (local) candidates.push(`${user.name} (${local}) - WebRTC`);
  candidates.push(`${user.name} - WebRTC (${String(user.userId).slice(0, 8)})`);
  for (let n = 2; n <= 50; n++) candidates.push(`${preferred} ${n}`);

  for (const candidate of candidates) {
    if (!taken.has(candidate.toLowerCase())) {
      return { phoneName: candidate, renamedFrom: candidate === preferred ? null : preferred };
    }
  }
  // 50+ collisions on one name is not a real org; fail the row rather than
  // POST something we know will be rejected.
  return { phoneName: preferred, renamedFrom: null, nameConflict: true };
}

// ── Analysis ────────────────────────────────────────────────────────

/**
 * Which user does an existing phone belong to?
 *
 * A WebRTC phone carries the user twice — as `webRtcUser` and as `owner` —
 * and either identifies the holder. Only ever applied to phones on a WebRTC
 * base: an ordinary desk phone also has an `owner`, and treating that as a
 * WebRTC assignment would skip a user who genuinely needs one.
 */
function phoneHolder(phone) {
  return phone?.webRtcUser?.id || phone?.owner?.id || null;
}

/**
 * Map existing WebRTC phones to the users holding them.
 *
 * The phones LIST endpoint does not reliably return `webRtcUser` — the same
 * omission changeSite.js works around by re-fetching each phone before moving
 * it, and the reason `getPhone` is documented as the "full object". Building
 * this map from the list alone yields an empty map in orgs where the field is
 * absent, which does not fail loudly: it simply reports that nobody has a
 * phone yet and offers to create duplicates for the entire org.
 *
 * So the list is used when it does carry the holder, and only the phones it
 * does not answer for are fetched individually — restricted to phones on a
 * WebRTC base, and run a few at a time so a large org does not issue a
 * thousand serial requests.
 *
 * @param {Function} getFullPhone  `(phoneId) => Promise<phone>`
 * @param {Set<string>} webRtcBaseIds  Every WebRTC base in the org, not just
 *   the one used for creating — a phone on a second WebRTC base still counts.
 * @param {Function} [shouldStop]  Polled between batches so the operator can
 *   cancel a long resolve.
 */
export async function resolvePhoneHolders(phones, webRtcBaseIds, getFullPhone, { onProgress, shouldStop } = {}) {
  const byUser = new Map();
  const needDetail = [];

  for (const p of phones) {
    // A phone with no phoneBaseSettings in the list response cannot be ruled
    // out, so it is checked rather than assumed to be a desk phone.
    const baseId = p.phoneBaseSettings?.id;
    if (baseId && !webRtcBaseIds.has(baseId)) continue;

    const holder = phoneHolder(p);
    if (holder) {
      if (!byUser.has(holder)) byUser.set(holder, p);
    } else {
      needDetail.push(p);
    }
  }

  const CONCURRENCY = 6;
  const queue = [...needDetail];
  let done = 0;

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      if (shouldStop?.()) return;
      const p = queue.shift();
      try {
        const full = await getFullPhone(p.id);
        const holder = phoneHolder(full);
        if (holder && !byUser.has(holder)) byUser.set(holder, full);
      } catch {
        // A phone we cannot read is left out. It can only cause a create that
        // Genesys then rejects — recorded as a failure, not a silent double.
      }
      onProgress?.(++done, needDetail.length);
    }
  }));

  return { byUser, detailFetches: needDetail.length };
}

/**
 * Narrow the org's users to those the operator asked for.
 *
 * Both filters are optional and independent: leaving one empty means "any".
 * A user must satisfy every filter that IS set, so picking a group and a
 * division gives the members of that group who are also in that division,
 * not the union of the two.
 *
 * Filtered-out users are not "skipped" — they were never in scope, and
 * listing them as skipped would bury the users who were considered and
 * rejected for a reason worth reading.
 *
 * @param {Object[]} users        Active users (with `division` expanded).
 * @param {Set<string>|null} groupMemberIds  Union of the selected groups'
 *   members, or null when no group filter is set.
 * @param {Set<string>} divisionIds  Selected division ids; empty means any.
 */
export function applyUserFilters(users, groupMemberIds, divisionIds) {
  return users.filter((u) => {
    if (groupMemberIds && !groupMemberIds.has(u.id)) return false;
    if (divisionIds.size && !divisionIds.has(u.division?.id)) return false;
    return true;
  });
}

/**
 * Classify every user into eligible / skipped. Pure — no API, no DOM.
 *
 * @param {Object[]} users         Active users (with `division` expanded).
 * @param {Object[]} licenseUsers  `/api/v2/license/users` entities.
 * @param {Object[]} phones        Every phone in the org (for name uniqueness).
 * @param {Map}      phoneByUser   From `resolvePhoneHolders`.
 * @returns {{ eligible: Object[], skipped: Object[], licenceKinds: Map }}
 */
export function analyseUsers(users, licenseUsers, phones, phoneByUser = new Map()) {
  const licencesByUser = new Map(
    licenseUsers.map((l) => [l.id, (l.licenses || []).filter(Boolean)])
  );

  // Every phone name in the org, WebRTC or not — the uniqueness constraint
  // Genesys enforces on phone names is org-wide.
  const taken = new Set();
  for (const p of phones) {
    if (p.name) taken.add(String(p.name).toLowerCase());
  }

  const eligible = [];
  const skipped = [];
  const licenceKinds = new Map(); // licence id → { count, collaborate }

  for (const u of users) {
    const licences = licencesByUser.get(u.id) || [];
    for (const id of licences) {
      const seen = licenceKinds.get(id) || { count: 0, collaborate: isCollaborateLicence(id) };
      seen.count++;
      licenceKinds.set(id, seen);
    }

    const row = {
      userId: u.id,
      name: u.name || u.username || u.id,
      email: u.email || "",
      division: u.division?.name || "—",
      licences: licences.join(", "),
    };

    // Order matters: "already has one" is the more useful answer for a user
    // who is also collaborate-licensed, because it needs no action either way.
    const existing = phoneByUser.get(u.id);
    if (existing) {
      skipped.push({ ...row, reason: "Already has a WebRTC phone", detail: existing.name || existing.id });
      continue;
    }
    if (!licences.length) {
      skipped.push({ ...row, reason: "No licence", detail: "no licence assigned" });
      continue;
    }
    if (licences.every(isCollaborateLicence)) {
      skipped.push({ ...row, reason: "Collaborate only", detail: row.licences });
      continue;
    }

    const named = uniquePhoneName(row, taken);
    taken.add(named.phoneName.toLowerCase());
    eligible.push({ ...row, ...named });
  }

  return { eligible, skipped, licenceKinds };
}

// ── Create-time error classification ────────────────────────────────

/**
 * What does a failed create mean?
 *
 * The proxy forwards the Genesys status verbatim (api/genesys-proxy/index.js),
 * so `err.status` and the parsed `err.body.code` are both reliable. The old
 * version sniffed the message text for "400"/"409", which matched any error
 * whose message merely contained those digits — an extension number was enough
 * — and filed every genuine bad request as a duplicate.
 */
function classifyCreateError(err) {
  const message = err?.message || String(err);
  const code = String(err?.body?.code || "");
  if (err?.status === 409 || code.startsWith("duplicate")) {
    return { kind: "exists", text: "Skipped (created by someone else during this run)" };
  }
  return { kind: "failed", text: `Failed: ${err?.status ? `${err.status} — ` : ""}${message}`.slice(0, 200) };
}

/**
 * POST with backoff on 429.
 *
 * The proxy returns only a JSON body, so `Retry-After` is not visible to the
 * browser; the delay is a fixed exponential instead of the server's own hint.
 */
async function createWithRetry(fn, attempts = 4) {
  let wait = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err?.status !== 429 || attempt >= attempts) throw err;
      await sleep(wait);
      wait *= 2;
    }
  }
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderWebRtcCreate({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Phones — WebRTC — Create</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ───────────────────────────────────────────
  const state = {
    sites: [],
    groups: [],          // filter options; empty is fine, the filter is optional
    divisions: [],
    analysis: null,      // { orgId, siteId, siteName, base, eligible, skipped, licenceKinds }
    selection: new Set(),// user ids ticked for creation
    results: new Map(),  // user id → { status, detail }
    statusCells: new Map(), // user id → the row's result <td>, indexed at render
    running: false,
    cancelled: false,
    done: false,         // a create run has been carried out
  };

  // ── Build UI ────────────────────────────────────────
  el.innerHTML = `
    <style>
      .wc-sect { border:1px solid var(--border);border-radius:8px;margin:14px 0;overflow:hidden; }
      .wc-sect-head { padding:9px 12px;background:var(--panel);border-bottom:1px solid var(--border);
                      font-size:.95rem;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
      .wc-sect-body { max-height:420px;overflow:auto; }
      .wc-tbl { width:100%;border-collapse:collapse;font-size:.85rem; }
      .wc-tbl th { position:sticky;top:0;background:var(--panel);text-align:left;font-weight:600;
                   padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap;z-index:1; }
      .wc-tbl td { padding:6px 10px;border-bottom:1px solid var(--border);vertical-align:top; }
      .wc-tbl tr:last-child td { border-bottom:none; }
      .wc-muted { color:var(--muted);font-size:.79rem; }
      .wc-badge { display:inline-block;font-size:.72rem;padding:1px 7px;border-radius:999px;
                  border:1px solid var(--border);color:var(--muted);margin-left:6px; }
      .wc-warn { color:#fbbf24; }
      .wc-bad { color:#f87171; }
      .wc-good { color:#34d399; }
      .wc-find { background:rgba(96,165,250,.07);border:1px solid rgba(96,165,250,.28);
                 border-radius:8px;padding:11px 13px;margin:12px 0;font-size:.84rem; }
      .wc-find ul { margin:6px 0 0;padding-left:18px;line-height:1.6; }
      .wc-caveat { background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);
                   border-radius:6px;padding:8px 11px;margin:0;font-size:.82rem; }
      .wc-details summary { cursor:pointer;padding:9px 12px;background:var(--panel);font-size:.9rem;font-weight:600; }
    </style>

    <h1 class="h1">Phones — WebRTC — Create</h1>
    <hr class="hr">

    <p class="page-desc">
      Creates a WebRTC phone for every active user who should have one. Optionally
      narrow the scope to particular groups or divisions, pick the destination site,
      and analyse first: nothing is created until you have seen who is in scope and
      confirmed. Users who already have a WebRTC phone, hold only a
      <strong>collaborate</strong> licence, or hold no licence at all are skipped,
      and the review says which applies to whom.
    </p>

    <!-- Filters: narrow which users are considered. Both optional. -->
    <div class="wc-controls">
      <div class="wc-control-group">
        <label class="wc-label">Groups</label>
        <div id="wcGroupSlot"></div>
      </div>
      <div class="wc-control-group">
        <label class="wc-label">Division</label>
        <div id="wcDivisionSlot"></div>
      </div>
    </div>

    <!-- Site selector -->
    <div class="wc-controls">
      <div class="wc-control-group">
        <label class="wc-label" for="wcSite">Destination Site</label>
        <select class="input wc-site-select" id="wcSite" disabled>
          <option value="">Loading sites…</option>
        </select>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="wc-actions">
      <button class="btn" id="wcAnalyseBtn" disabled>Analyse</button>
      <button class="btn wc-btn-run" id="wcRunBtn" hidden>Create Phones</button>
      <button class="btn" id="wcCancelBtn" hidden>Cancel</button>
    </div>

    <!-- Status -->
    <div class="wc-status" id="wcStatus">Loading sites…</div>

    <!-- Progress bar -->
    <div class="wc-progress-wrap" id="wcProgressWrap" style="display:none">
      <div class="wc-progress-bar" id="wcProgressBar"></div>
    </div>

    <!-- Summary -->
    <div class="wc-summary" id="wcSummary" style="display:none"></div>

    <!-- Review / results -->
    <div id="wcReport"></div>

    <!-- Download Excel button -->
    <div class="wc-download" id="wcDownload" style="display:none">
      <button class="btn wc-btn-download" id="wcDownloadBtn">Download Excel Log</button>
    </div>
  `;

  // ── Filter pickers ──────────────────────────────────
  // Changing a filter invalidates any report on screen: it was computed for a
  // different set of users, and leaving it visible under new filter settings
  // would misrepresent what a create would do.
  const onFilterChange = () => {
    resetReport();
    setStatus($site.value ? "Filters changed. Click Analyse." : "Select a destination site.");
  };
  const groupSelect = createMultiSelect({
    placeholder: "All groups", searchable: true, onChange: onFilterChange,
  });
  const divisionSelect = createMultiSelect({
    placeholder: "All divisions", searchable: true, onChange: onFilterChange,
  });
  el.querySelector("#wcGroupSlot").append(groupSelect.el);
  el.querySelector("#wcDivisionSlot").append(divisionSelect.el);

  // ── DOM refs ────────────────────────────────────────
  const $ = (sel) => el.querySelector(sel);
  const $site         = $("#wcSite");
  const $analyseBtn   = $("#wcAnalyseBtn");
  const $runBtn       = $("#wcRunBtn");
  const $cancelBtn    = $("#wcCancelBtn");
  const $status       = $("#wcStatus");
  const $progressWrap = $("#wcProgressWrap");
  const $progressBar  = $("#wcProgressBar");
  const $summary      = $("#wcSummary");
  const $report       = $("#wcReport");
  const $download     = $("#wcDownload");
  const $downloadBtn  = $("#wcDownloadBtn");

  // ── Helpers ─────────────────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "wc-status" + (type ? ` wc-status--${type}` : "");
  }
  function showProgress(pct) {
    $progressWrap.style.display = "";
    $progressBar.style.width = `${Math.min(pct, 100)}%`;
  }
  function hideProgress() {
    $progressWrap.style.display = "none";
    $progressBar.style.width = "0%";
  }
  function setBusy(busy) {
    state.running = busy;
    $site.disabled = busy;
    groupSelect.setEnabled(!busy);
    divisionSelect.setEnabled(!busy);
    $analyseBtn.disabled = busy || !$site.value;
    $cancelBtn.hidden = !busy;
    updateRunBtn();
    // `data-conflict` rows have no free phone name, so they stay unselectable
    // whatever the page is doing — re-enabling them here would hand back a
    // checkbox for a create that is known in advance to fail.
    $report.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.disabled = busy || state.done || cb.dataset.conflict === "1";
    });
  }

  /**
   * The create button exists only while there is an un-run analysis to act on,
   * so a finished result cannot be mistaken for a live one.
   */
  function updateRunBtn() {
    const ready = !!state.analysis && !state.done && state.selection.size > 0;
    $runBtn.hidden = !ready;
    $runBtn.disabled = state.running;
    $runBtn.textContent = `Create ${state.selection.size} Phone${state.selection.size === 1 ? "" : "s"}`;
  }

  function resetReport() {
    state.analysis = null;
    state.selection.clear();
    state.results.clear();
    state.statusCells.clear();
    state.done = false;
    $report.innerHTML = "";
    $summary.style.display = "none";
    $download.style.display = "none";
    updateRunBtn();
  }

  $site.addEventListener("change", () => {
    $analyseBtn.disabled = !$site.value;
    resetReport();
    setStatus($site.value ? "Ready. Click Analyse." : "Select a destination site.");
  });

  // ── Phase 1: analyse ────────────────────────────────

  /** Name the active filters for the summary, or "" when none are set. */
  function describeFilters(groupIds, divisionIds) {
    const nameOf = (items, id) => items.find((i) => i.id === id)?.name || id;
    const parts = [];
    if (groupIds.size) {
      parts.push(groupIds.size === 1
        ? `group '${nameOf(state.groups, [...groupIds][0])}'`
        : `${groupIds.size} groups`);
    }
    if (divisionIds.size) {
      parts.push(divisionIds.size === 1
        ? `division '${nameOf(state.divisions, [...divisionIds][0])}'`
        : `${divisionIds.size} divisions`);
    }
    return parts.join(" + ");
  }

  async function findWebRtcBase(orgId) {
    const bases = await gc.fetchAllPhoneBaseSettings(api, orgId);
    const webRtcBases = bases.filter(isWebRtcBase);
    if (!webRtcBases.length) return null;

    // New phones go on the first WebRTC base, but every WebRTC base counts
    // when deciding whether a user already has a phone — an org that has more
    // than one must not get a second phone per user.
    const match = webRtcBases[0];
    const full = await gc.getPhoneBaseSetting(api, orgId, match.id); // list omits `lines`
    return {
      phoneBaseSettingsId: match.id,
      phoneBaseSettingsName: match.name || match.id,
      lineBaseSettingsId: full.lines?.[0]?.id ?? null,
      webRtcBaseIds: new Set(webRtcBases.map((b) => b.id)),
      webRtcBaseCount: webRtcBases.length,
    };
  }

  $analyseBtn.addEventListener("click", async () => {
    const siteId = $site.value;
    if (!siteId) { setStatus("Please select a site.", "error"); return; }

    const orgId = orgContext.get();
    const siteName = state.sites.find((s) => s.id === siteId)?.name || siteId;

    resetReport();
    state.cancelled = false;
    setBusy(true);

    try {
      setStatus("Finding the WebRTC phone base settings…");
      showProgress(3);
      const base = await findWebRtcBase(orgId);
      if (!base) {
        setStatus("No WebRTC phone base settings found in this org.", "error");
        return;
      }
      if (!base.lineBaseSettingsId) {
        setStatus(`Phone base '${base.phoneBaseSettingsName}' has no line base settings configured.`, "error");
        return;
      }

      setStatus("Reading users, licences and existing phones…");
      showProgress(8);
      const [users, licenseUsers, phones] = await Promise.all([
        gc.fetchAllUsers(api, orgId, {
          expand: ["division"],
          state: "active",
          onProgress: (n) => showProgress(8 + Math.min(n / 40, 55)),
        }),
        gc.fetchAllLicenseUsers(api, orgId),
        gc.fetchAllPhones(api, orgId),
      ]);

      if (state.cancelled) { setStatus("Cancelled."); return; }
      showProgress(80);

      if (!users.length) {
        setStatus("No active users found in this org.", "error");
        return;
      }

      // Apply the filters. Group membership needs a call per selected group;
      // division comes off the user records already fetched.
      const groupIds = groupSelect.getSelected();
      const divisionIds = divisionSelect.getSelected();
      let groupMemberIds = null;
      if (groupIds.size) {
        setStatus(`Reading members of ${groupIds.size} group${groupIds.size === 1 ? "" : "s"}…`);
        const memberLists = await Promise.all(
          [...groupIds].map((id) => gc.fetchGroupMembers(api, orgId, id).catch(() => []))
        );
        groupMemberIds = new Set(memberLists.flat().map((m) => m.id));
      }
      if (state.cancelled) { setStatus("Cancelled."); return; }

      const scopedUsers = applyUserFilters(users, groupMemberIds, divisionIds);
      const filterLabel = describeFilters(groupIds, divisionIds);

      if (!scopedUsers.length) {
        setStatus(`No active users match the selected ${filterLabel || "filters"}.`, "error");
        return;
      }
      showProgress(85);

      setStatus("Matching existing WebRTC phones to their users…");
      const { byUser: phoneByUser, detailFetches } = await resolvePhoneHolders(
        phones,
        base.webRtcBaseIds,
        (phoneId) => gc.getPhone(api, orgId, phoneId),
        {
          shouldStop: () => state.cancelled,
          onProgress: (n, total) => {
            showProgress(85 + (n / Math.max(total, 1)) * 10);
            setStatus(`Matching existing WebRTC phones to their users… ${n} of ${total}`);
          },
        }
      );
      if (state.cancelled) { setStatus("Cancelled."); return; }

      setStatus("Classifying users…");
      const { eligible, skipped, licenceKinds } = analyseUsers(scopedUsers, licenseUsers, phones, phoneByUser);

      state.analysis = {
        orgId, siteId, siteName, base, eligible, skipped, licenceKinds,
        userCount: scopedUsers.length,
        orgUserCount: users.length,
        filterLabel,
        phoneCount: phones.length,
        existingWebRtc: phoneByUser.size,
        detailFetches,
      };
      // Everything eligible is ticked by default; untick to narrow the run.
      state.selection = new Set(eligible.filter((r) => !r.nameConflict).map((r) => r.userId));

      renderReport();
      showProgress(100);
      setStatus(
        eligible.length
          ? `${eligible.length} phone${eligible.length === 1 ? "" : "s"} to create. Review below, then confirm.`
          : "Nothing to create — every active user is already covered or skipped.",
        eligible.length ? "" : "success"
      );
      setTimeout(hideProgress, 800);
    } catch (err) {
      setStatus(`Analysis failed: ${err.message}`, "error");
      console.error("WebRTC analyse error:", err);
    } finally {
      // Every early return above leaves the bar part-filled with no report to
      // show for it; only a completed analysis animates it away.
      if (!state.analysis) hideProgress();
      setBusy(false);
    }
  });

  // ── Review rendering ────────────────────────────────

  function statusCellHtml(userId) {
    const res = state.results.get(userId);
    if (!res) return `<span class="wc-muted">—</span>`;
    const cls = res.status.startsWith("Created") ? "wc-good"
      : res.status.startsWith("Failed") ? "wc-bad" : "wc-warn";
    return `<span class="${cls}">${escapeHtml(res.status)}</span>`;
  }

  function eligibleRowHtml(r) {
    const flags = [
      r.renamedFrom ? `<span class="wc-badge wc-warn" title="'${escapeHtml(r.renamedFrom)}' is already in use">renamed</span>` : "",
      r.nameConflict ? `<span class="wc-badge wc-bad" title="Could not find a free phone name">name conflict</span>` : "",
    ].join("");
    return `
      <tr data-user="${escapeHtml(r.userId)}">
        <td><input type="checkbox" data-user="${escapeHtml(r.userId)}"
             ${state.selection.has(r.userId) ? "checked" : ""}
             ${r.nameConflict ? `disabled data-conflict="1"` : ""}></td>
        <td>${escapeHtml(r.name)}<div class="wc-muted">${escapeHtml(r.email || "no email")}</div></td>
        <td>${escapeHtml(r.division)}</td>
        <td class="wc-muted">${escapeHtml(r.licences)}</td>
        <td>${escapeHtml(r.phoneName)}${flags}</td>
        <td class="wc-cell-status">${statusCellHtml(r.userId)}</td>
      </tr>`;
  }

  function skippedSectionHtml(skipped) {
    if (!skipped.length) return "";
    const groups = new Map();
    for (const r of skipped) {
      if (!groups.has(r.reason)) groups.set(r.reason, []);
      groups.get(r.reason).push(r);
    }
    const blocks = [...groups.entries()].map(([reason, rows]) => `
      <details class="wc-sect wc-details">
        <summary>${escapeHtml(reason)} — ${rows.length} user${rows.length === 1 ? "" : "s"}</summary>
        <div class="wc-sect-body">
          <table class="wc-tbl">
            <thead><tr><th>User</th><th>Division</th><th>Licences</th><th>Detail</th></tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td>${escapeHtml(r.name)}<div class="wc-muted">${escapeHtml(r.email || "no email")}</div></td>
                  <td>${escapeHtml(r.division)}</td>
                  <td class="wc-muted">${escapeHtml(r.licences || "—")}</td>
                  <td class="wc-muted">${escapeHtml(r.detail || "")}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </details>`);
    return blocks.join("");
  }

  function findingsHtml() {
    const { licenceKinds, eligible, base, phoneCount, existingWebRtc, detailFetches } = state.analysis;
    const notes = [];

    const collab = [...licenceKinds.entries()].filter(([, v]) => v.collaborate);
    const other = [...licenceKinds.entries()].filter(([, v]) => !v.collaborate);
    notes.push(
      `Phone base: <strong>${escapeHtml(base.phoneBaseSettingsName)}</strong>`
      + (base.webRtcBaseCount > 1
        ? ` — ${base.webRtcBaseCount} WebRTC bases exist in this org; new phones use this one, and a phone on any of them counts as already having one.`
        : ".")
    );

    // The existing-phone count is the number this run will NOT duplicate, so
    // it is stated outright: a zero here on an org that plainly has WebRTC
    // phones means the match failed, not that the org is empty.
    notes.push(
      `Existing WebRTC phones matched to users: <strong>${existingWebRtc}</strong>`
      + ` (of ${phoneCount} phone${phoneCount === 1 ? "" : "s"} in the org)`
      + (detailFetches
        ? ` — ${detailFetches} had to be read individually, because the phones list did not name their user.`
        : ".")
    );
    notes.push(
      `Licences read as <em>collaborate</em> (holders skipped when they hold nothing else): ` +
      (collab.length
        ? collab.map(([id, v]) => `<strong>${escapeHtml(id)}</strong> (${v.count})`).join(", ")
        : "<em>none found in this org</em>")
    );
    notes.push(
      `Other licences seen: ` +
      (other.length
        ? other.map(([id, v]) => `${escapeHtml(id)} (${v.count})`).join(", ")
        : "<em>none</em>")
    );

    const renamed = eligible.filter((r) => r.renamedFrom).length;
    if (renamed) {
      notes.push(`${renamed} phone name${renamed === 1 ? " was" : "s were"} adjusted to avoid clashing with an existing phone.`);
    }
    const conflicts = eligible.filter((r) => r.nameConflict).length;
    if (conflicts) {
      notes.push(`<span class="wc-bad">${conflicts} user${conflicts === 1 ? "" : "s"} could not be given a free phone name and cannot be selected.</span>`);
    }

    return `
      <div class="wc-find">
        <strong>Findings</strong>
        <ul>${notes.map((n) => `<li>${n}</li>`).join("")}</ul>
      </div>`;
  }

  function renderReport() {
    const { eligible, skipped, siteName, userCount, orgUserCount, filterLabel } = state.analysis;

    // When a filter is on, both numbers are stated: how many the org has, and
    // how many the filter left. A create that covers 40 of 900 users should
    // not read the same as one that covers the whole org.
    const scope = filterLabel
      ? `${userCount} of ${orgUserCount} active users (${filterLabel})`
      : `${userCount} active users`;

    $summary.textContent =
      `${scope} — ${eligible.length} to create, ${skipped.length} skipped — site '${siteName}'`;
    $summary.style.display = "";

    $report.innerHTML = `
      ${findingsHtml()}
      ${eligible.length ? `
        <div class="wc-sect">
          <div class="wc-sect-head">
            <span>Phones to create</span>
            <span class="wc-badge" id="wcSelCount">${state.selection.size} selected</span>
            <span style="flex:1"></span>
            <label class="wc-muted" style="font-weight:400;cursor:pointer">
              <input type="checkbox" id="wcSelectAll" checked> select all
            </label>
          </div>
          <div class="wc-sect-body">
            <table class="wc-tbl">
              <thead>
                <tr><th style="width:28px"></th><th>User</th><th>Division</th>
                    <th>Licences</th><th>Phone name</th><th>Result</th></tr>
              </thead>
              <tbody id="wcEligibleBody">
                ${eligible.map(eligibleRowHtml).join("")}
              </tbody>
            </table>
          </div>
        </div>` : ""}
      ${skippedSectionHtml(skipped)}
    `;

    // Index the result cells once. The run updates one per create, and on a
    // large org re-querying the table for every row is both slower and one
    // more thing that can silently fail to match.
    state.statusCells.clear();
    for (const tr of $report.querySelectorAll("#wcEligibleBody tr[data-user]")) {
      state.statusCells.set(tr.dataset.user, tr.querySelector(".wc-cell-status"));
    }

    updateRunBtn();
  }

  function updateSelCount() {
    const $count = $("#wcSelCount");
    if ($count) $count.textContent = `${state.selection.size} selected`;
    updateRunBtn();
  }

  $report.addEventListener("change", (ev) => {
    const cb = ev.target;
    if (cb?.type !== "checkbox" || state.running || state.done) return;

    if (cb.id === "wcSelectAll") {
      const rows = state.analysis?.eligible || [];
      state.selection.clear();
      for (const r of rows) {
        if (cb.checked && !r.nameConflict) state.selection.add(r.userId);
      }
      $report.querySelectorAll("#wcEligibleBody input[type=checkbox]").forEach((box) => {
        if (!box.disabled) box.checked = cb.checked;
      });
    } else if (cb.dataset.user) {
      if (cb.checked) state.selection.add(cb.dataset.user);
      else state.selection.delete(cb.dataset.user);
    }
    updateSelCount();
  });

  // ── Phase 2: confirm ────────────────────────────────

  function showCreateConfirm() {
    const { siteName, eligible } = state.analysis;
    const rows = eligible.filter((r) => state.selection.has(r.userId));
    const preview = rows.slice(0, 12);

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center";
    overlay.innerHTML = `
      <div style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:22px;min-width:420px;max-width:620px;width:92%">
        <h3 style="margin:0 0 12px;font-size:1.05rem">
          Create ${rows.length} WebRTC phone${rows.length === 1 ? "" : "s"} in “${escapeHtml(siteName)}”?
        </h3>
        <p class="wc-caveat" style="margin-bottom:12px">
          Each phone is assigned to its user as both owner and WebRTC user.
          Phones are not removed by this tool — undoing a run means deleting
          them in Genesys Cloud.
        </p>
        <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin:10px 0">
          ${preview.map((r) => `
            <div style="padding:5px 10px;border-bottom:1px solid var(--border);font-size:.85rem">
              ${escapeHtml(r.phoneName)}
              <span style="color:var(--muted)">— ${escapeHtml(r.name)}</span>
            </div>`).join("")}
          ${rows.length > preview.length ? `
            <div style="padding:5px 10px;font-size:.85rem;color:var(--muted)">
              …and ${rows.length - preview.length} more
            </div>` : ""}
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
          <button id="wcCancelCreate" class="btn btn--secondary">Cancel</button>
          <button id="wcDoCreate" class="btn wc-btn-run">Create ${rows.length} phone${rows.length === 1 ? "" : "s"}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => { if (overlay.parentNode) document.body.removeChild(overlay); };
    overlay.querySelector("#wcCancelCreate").addEventListener("click", close);
    overlay.querySelector("#wcDoCreate").addEventListener("click", () => {
      close();
      runCreate(rows);
    });
  }

  $runBtn.addEventListener("click", () => {
    if (!state.analysis || !state.selection.size) return;

    // The org selector sits outside this page and the review may have been
    // open for a while. Creating this org's phones in a different org would
    // be both silent and wrong, so a switch invalidates the analysis.
    if (orgContext.get() !== state.analysis.orgId) {
      setStatus("The organisation changed since this analysis was run. Analyse again.", "error");
      resetReport();
      return;
    }
    showCreateConfirm();
  });

  // ── Phase 3: create ─────────────────────────────────

  async function runCreate(rows) {
    const { orgId, siteId, siteName, base } = state.analysis;
    state.cancelled = false;
    setBusy(true);
    $download.style.display = "none";

    let created = 0, existed = 0, failed = 0;

    function recordResult(row, status, detail) {
      state.results.set(row.userId, { status, detail });
      const cell = state.statusCells.get(row.userId);
      if (cell) cell.innerHTML = statusCellHtml(row.userId);
    }

    try {
      for (let i = 0; i < rows.length; i++) {
        if (state.cancelled) break;
        const row = rows[i];

        setStatus(`Creating phone ${i + 1} of ${rows.length} — ${row.name}`);
        showProgress((i / rows.length) * 100);

        try {
          await createWithRetry(() => gc.createPhone(api, orgId, {
            name: row.phoneName,
            site: { id: siteId },
            phoneBaseSettings: { id: base.phoneBaseSettingsId },
            lines: [{ lineBaseSettings: { id: base.lineBaseSettingsId } }],
            webRtcUser: { id: row.userId, type: "USER" },
            owner: { id: row.userId, type: "USER" },
          }));
          created++;
          recordResult(row, "Created", row.phoneName);
        } catch (err) {
          const { kind, text } = classifyCreateError(err);
          if (kind === "exists") existed++; else failed++;
          recordResult(row, text, err?.message || "");
        }

        // Rate limit: 50ms between creates. 429s are retried with backoff.
        if (i < rows.length - 1) await sleep(50);
      }

      state.done = true;
      showProgress(100);

      const notRun = rows.length - created - existed - failed;
      const parts = [];
      if (created) parts.push(`Created: ${created}`);
      if (existed) parts.push(`Already existed: ${existed}`);
      if (failed) parts.push(`Failed: ${failed}`);
      if (notRun) parts.push(`Not run: ${notRun}`);

      setStatus(state.cancelled ? "Cancelled." : "Done.", failed ? "error" : "success");
      $summary.textContent = (state.cancelled ? "Cancelled.  " : "") + parts.join("  •  ");

      logAction({
        me, orgId, orgName: org.name || "",
        action: "phone_create",
        description: `Created ${created} WebRTC phone${created === 1 ? "" : "s"} in '${siteName}'`
          + `${existed ? ` (${existed} already existed)` : ""}`
          + `${failed ? ` (${failed} failed)` : ""}`
          + `${state.cancelled ? " [cancelled]" : ""}`,
        result: created === 0 && failed > 0 ? "failure"
          : failed > 0 || state.cancelled ? "partial" : "success",
        count: created,
      });

      $download.style.display = "";
      setTimeout(hideProgress, 800);
    } catch (err) {
      // The per-phone try/catch above handles create failures; reaching here
      // means something outside the loop broke. Log what was already written.
      setStatus(`Error: ${err.message}`, "error");
      console.error("WebRTC create error:", err);
      logAction({
        me, orgId, orgName: org.name || "",
        action: "phone_create",
        description: `WebRTC phone creation in '${siteName}' aborted after ${created} created`,
        result: "partial", errorMessage: err.message, count: created,
      });
      $download.style.display = "";
      hideProgress();
    } finally {
      setBusy(false);
      updateRunBtn();
    }
  }

  $cancelBtn.addEventListener("click", () => {
    state.cancelled = true;
    setStatus("Cancelling after the current phone…");
  });

  // ── Excel log ───────────────────────────────────────

  $downloadBtn.addEventListener("click", () => {
    if (!state.analysis) return;
    const { eligible, skipped, siteName } = state.analysis;

    const rows = [
      ...eligible.map((r) => {
        const res = state.results.get(r.userId);
        return {
          division: r.division, name: r.name, email: r.email || "—", userId: r.userId,
          licences: r.licences || "—", phoneName: r.phoneName, site: siteName,
          status: res ? res.status : "Not run",
          detail: res ? res.detail || "" : "not selected, or run cancelled before this row",
        };
      }),
      ...skipped.map((r) => ({
        division: r.division, name: r.name, email: r.email || "—", userId: r.userId,
        licences: r.licences || "—", phoneName: "—", site: siteName,
        status: `Skipped (${r.reason.toLowerCase()})`, detail: r.detail || "",
      })),
    ];

    const columns = [
      { key: "division",  label: "Division",   wch: 22 },
      { key: "name",      label: "Name",       wch: 28 },
      { key: "email",     label: "Email",      wch: 32 },
      { key: "userId",    label: "User ID",    wch: 38 },
      { key: "licences",  label: "Licences",   wch: 30 },
      { key: "phoneName", label: "Phone Name", wch: 32 },
      { key: "site",      label: "Site",       wch: 22 },
      { key: "status",    label: "Status",     wch: 34 },
      { key: "detail",    label: "Detail",     wch: 40 },
    ];

    try {
      exportLogXlsx({
        sheetName: "WebRTC Phones",
        columns,
        rows,
        filename: timestampedFilename(`WebRTC_Phones_${org.name || orgContext.get()}`, "xlsx"),
      });
    } catch (err) {
      setStatus(err.message, "error");
    }
  });

  // ── Load sites and filter options on mount ─────────
  (async () => {
    // Sites gate the page; the filters do not. A failure to load groups or
    // divisions leaves those pickers empty and the page still usable, rather
    // than blocking a create over an optional filter.
    const [sitesRes, groupsRes, divisionsRes] = await Promise.allSettled([
      gc.fetchAllSites(api, orgContext.get()),
      gc.fetchAllGroups(api, orgContext.get()),
      gc.fetchAllDivisions(api, orgContext.get()),
    ]);

    if (sitesRes.status === "rejected") {
      setStatus(`Failed to load sites: ${sitesRes.reason?.message || sitesRes.reason}`, "error");
      console.error("Site load error:", sitesRes.reason);
      return;
    }

    state.sites = sitesRes.value.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || "")));
    $site.innerHTML = `<option value="">— Select a site —</option>`
      + state.sites.map((s) =>
        `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name || s.id)}</option>`
      ).join("");
    $site.disabled = false;

    const notes = [];

    if (groupsRes.status === "fulfilled") {
      state.groups = groupsRes.value;
      // Every group type is offered. The type is shown for anything that is
      // not an official group, so a social group is not mistaken for one.
      groupSelect.setItems(state.groups.map((g) => ({
        id: g.id,
        label: g.type && String(g.type).toLowerCase() !== "official"
          ? `${g.name} (${String(g.type).toLowerCase()})`
          : g.name || g.id,
      })));
      groupSelect.setPlaceholder(`All groups (${state.groups.length})`);
    } else {
      groupSelect.setPlaceholder("Groups unavailable");
      groupSelect.setEnabled(false);
      notes.push("groups");
      console.error("Group load error:", groupsRes.reason);
    }

    if (divisionsRes.status === "fulfilled") {
      state.divisions = divisionsRes.value;
      divisionSelect.setItems(state.divisions.map((d) => ({ id: d.id, label: d.name || d.id })));
      divisionSelect.setPlaceholder(`All divisions (${state.divisions.length})`);
    } else {
      divisionSelect.setPlaceholder("Divisions unavailable");
      divisionSelect.setEnabled(false);
      notes.push("divisions");
      console.error("Division load error:", divisionsRes.reason);
    }

    setStatus(notes.length
      ? `Ready, but the ${notes.join(" and ")} filter could not load. Select a destination site, then click Analyse.`
      : "Ready. Optionally filter by group or division, select a destination site, then click Analyse.",
    notes.length ? "error" : "");
  })();

  return el;
}
