/**
 * Phones › WebRTC — Delete
 *
 * Finds WebRTC phones nobody is using — no user assigned, or a holder who has
 * been deleted or deactivated — reports them, and deletes the ones confirmed.
 *
 * Two phases, and nothing is written in the first:
 *
 *   1. Analyse — read the org's WebRTC phones and every user in any state,
 *      match each phone to its holder, and sort the results into categories
 *      with the reason attached.
 *   2. Delete — on a typed confirmation, DELETE each ticked phone, re-reading
 *      it immediately beforehand to confirm it is still unused.
 *
 * ── Why this page is more careful than Create ──
 *
 * The phones LIST endpoint does not reliably name a phone's user. Create was
 * shipped trusting it and offered a duplicate phone for every user in the org
 * — annoying, and undone by deleting the duplicates. Here the same mistake
 * deletes a phone that somebody is using, and there is no undo.
 *
 * So the rule this page is built around: **absence of evidence is not evidence
 * of absence**. A phone is only ever a deletion candidate when a successful
 * read of the full object came back with no user on it. A phone we could not
 * read is reported and locked, never quietly treated as an orphan.
 *
 * Scope is WebRTC bases only. A lobby or conference desk phone legitimately
 * has no user; sweeping those in would make "unassigned" meaningless and the
 * review dangerous.
 *
 * API endpoints:
 *   GET    /api/v2/telephony/providers/edges/sites
 *   GET    /api/v2/telephony/providers/edges/phonebasesettings
 *   GET    /api/v2/telephony/providers/edges/phones
 *   GET    /api/v2/telephony/providers/edges/phones/{id}
 *   DELETE /api/v2/telephony/providers/edges/phones/{id}
 *   GET    /api/v2/users?state=any&expand=division
 *
 * There are deliberately no group or division filters here, unlike Create and
 * Change Site. Both resolve through the phone's holder, and the phones this
 * page exists to find have no holder — so setting either one hid every orphan
 * and left the page reporting nothing. A filter that excludes exactly the rows
 * the page is for is worse than no filter. Site is the one that still means
 * something, because it describes the phone rather than a person.
 */
import { escapeHtml, sleep, timestampedFilename, exportLogXlsx, makeStatus } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import { resolvePhoneHolders, phoneHolder } from "../../../lib/phoneHolders.js";
import { logAction } from "../../../services/activityLogService.js";

/** Typed into the confirmation box before anything is deleted. */
const CONFIRM_WORD = "DELETE";

/**
 * The categories, in review order.
 *
 * `ticked` is whether the category is selected by default. Only two are:
 * a phone with no user and a phone whose user has been deleted are both
 * unambiguously finished. An INACTIVE user is not — inactive in Genesys
 * routinely means on leave or suspended rather than gone, and deleting the
 * phone means they come back to no phone. Recoverable through Create, but it
 * should be a deliberate tick rather than something that happens by default.
 *
 * `deletable: false` categories are reported and locked. UNREADABLE is the
 * important one: it is not a finding about the phone, it is a finding about
 * our knowledge of it.
 */
export const CATEGORIES = {
  NO_USER: {
    key: "NO_USER", label: "No user assigned", ticked: true, deletable: true,
    blurb: "The phone was read in full and has neither a WebRTC user nor an owner.",
  },
  DELETED_USER: {
    key: "DELETED_USER", label: "Holder is a deleted user", ticked: true, deletable: true,
    blurb: "The user this phone belongs to has been deleted from the org.",
  },
  MISSING_USER: {
    key: "MISSING_USER", label: "Holder no longer exists", ticked: true, deletable: true,
    blurb: "The phone names a user id that is not in this org in any state.",
  },
  INACTIVE_USER: {
    key: "INACTIVE_USER", label: "Holder is an inactive user", ticked: false, deletable: true,
    blurb: "Inactive often means on leave or suspended rather than gone. If the user is "
         + "reactivated they will have no phone, so these are listed unticked — tick only "
         + "the ones you mean.",
  },
  UNREADABLE: {
    key: "UNREADABLE", label: "Could not be read", ticked: false, deletable: false,
    blurb: "Genesys did not return these phones when asked for them individually, so "
         + "whether anyone holds them is unknown. They cannot be selected: an unread "
         + "phone is not an unused one.",
  },
};

/**
 * Sort WebRTC phones into categories. Pure — no API, no DOM.
 *
 * @param {Object[]} phones          WebRTC-base phones under consideration.
 * @param {Map<string,string>} holderByPhone  phone id → user id, resolved.
 * @param {Object[]} unreadable      Phones whose individual read failed.
 * @param {Map<string,Object>} usersById  Every user in any state.
 * @param {Map<string,string>} [siteNames]  site id → name. The phones list
 *   returns `site.id` but not always `site.name`, which left the Site column
 *   showing a dash for every row.
 * @returns {{ rows: Object[], activeCount: number }}
 *   `rows` excludes phones held by an active user; those are only counted.
 */
export function categorisePhones(phones, holderByPhone, unreadable, usersById, siteNames = new Map()) {
  const unreadableIds = new Set(unreadable.map((p) => p.id));
  const rows = [];
  let activeCount = 0;

  for (const phone of phones) {
    const siteId = phone.site?.id || "";
    const base = {
      phoneId: phone.id,
      phoneName: phone.name || phone.id,
      siteName: siteNames.get(siteId) || phone.site?.name || "—",
      siteId,
    };

    if (unreadableIds.has(phone.id)) {
      rows.push({ ...base, category: "UNREADABLE", holderId: "", holderName: "—", detail: "phone could not be read" });
      continue;
    }

    const holderId = holderByPhone.get(phone.id) || null;
    if (!holderId) {
      rows.push({ ...base, category: "NO_USER", holderId: "", holderName: "—", detail: "no user on the phone" });
      continue;
    }

    const user = usersById.get(holderId);
    if (!user) {
      rows.push({ ...base, category: "MISSING_USER", holderId, holderName: "—", detail: `user id ${holderId} not found in the org` });
      continue;
    }

    const holderName = user.name || user.username || holderId;
    const holderEmail = user.email || "";
    const divisionName = user.division?.name || "—";
    const state = String(user.state || "").toLowerCase();

    if (state === "deleted") {
      rows.push({ ...base, category: "DELETED_USER", holderId, holderName, holderEmail, divisionName, detail: "user is deleted" });
    } else if (state === "inactive") {
      rows.push({ ...base, category: "INACTIVE_USER", holderId, holderName, holderEmail, divisionName, detail: "user is inactive" });
    } else {
      activeCount++;
    }
  }

  return { rows, activeCount };
}

/**
 * Confirm a phone is still unused, immediately before deleting it.
 *
 * The review may have sat open for a while, and a phone that has since been
 * assigned to somebody is exactly the phone that must not be deleted. Nothing
 * about the earlier analysis is trusted here — the phone is read again and
 * judged on what comes back.
 *
 * A read that fails is a refusal, not a pass. Unconfirmed is not safe.
 */
export async function stillUnused(row, getFullPhone, usersById) {
  let phone;
  try {
    phone = await getFullPhone(row.phoneId);
  } catch (err) {
    if (err?.status === 404) return { ok: true, gone: true };
    return { ok: false, reason: `could not re-read the phone (${err?.message || err})` };
  }
  if (!phone) return { ok: false, reason: "the phone could not be re-read" };

  const holderId = phoneHolder(phone);
  if (!holderId) return { ok: true };

  const user = usersById.get(holderId);
  if (!user) return { ok: true };   // holder still does not exist in the org

  const state = String(user.state || "").toLowerCase();
  if (state === "deleted" || state === "inactive") return { ok: true };

  return { ok: false, reason: `now assigned to ${user.name || holderId}` };
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderWebRtcDelete({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Phones — WebRTC — Delete</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  const state = {
    sites: [],
    analysis: null,
    selection: new Set(),
    results: new Map(),
    statusCells: new Map(),
    running: false,
    cancelled: false,
    done: false,
  };

  const onFilterChange = () => {
    resetReport();
    setStatus("Filters changed. Click Analyse.");
  };
  const siteSelect = createMultiSelect({ placeholder: "All sites", searchable: true, onChange: onFilterChange });

  el.innerHTML = `
    <style>
      .wd-sect { border:1px solid var(--border);border-radius:8px;margin:14px 0;overflow:hidden; }
      .wd-sect-head { padding:9px 12px;background:var(--panel);border-bottom:1px solid var(--border);
                      font-size:.95rem;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
      .wd-sect--locked .wd-sect-head { background:rgba(251,191,36,.07); }
      .wd-sect-blurb { padding:7px 12px;color:var(--muted);font-size:.8rem;border-bottom:1px solid var(--border);line-height:1.5; }
      .wd-sect-body { max-height:360px;overflow:auto; }
      .wd-tbl { width:100%;border-collapse:collapse;font-size:.85rem; }
      .wd-tbl th { position:sticky;top:0;background:var(--panel);text-align:left;font-weight:600;
                   padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap;z-index:1; }
      .wd-tbl td { padding:6px 10px;border-bottom:1px solid var(--border);vertical-align:top; }
      .wd-tbl tr:last-child td { border-bottom:none; }
      .wd-muted { color:var(--muted);font-size:.79rem; }
      .wd-badge { display:inline-block;font-size:.72rem;padding:1px 7px;border-radius:999px;
                  border:1px solid var(--border);color:var(--muted); }
      .wd-warn { color:#fbbf24; }
      .wd-bad { color:#f87171; }
      .wd-good { color:#34d399; }
      .wd-find { background:rgba(96,165,250,.07);border:1px solid rgba(96,165,250,.28);
                 border-radius:8px;padding:11px 13px;margin:12px 0;font-size:.84rem; }
      .wd-find ul { margin:6px 0 0;padding-left:18px;line-height:1.6; }
      .wd-caveat { background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.35);
                   border-radius:8px;padding:11px 13px;margin:0 0 12px;font-size:.83rem; }
      /* Destructive action — deliberately not the same colour as Analyse. */
      .wd-danger { background:#b91c1c;border-color:#b91c1c;color:#fff; }
      .wd-danger:hover:not(:disabled) { background:#dc2626;border-color:#dc2626; }
    </style>

    <h1 class="h1">Phones — WebRTC — Delete</h1>
    <hr class="hr">

    <p class="page-desc">
      Finds WebRTC phones nobody is using — no user assigned, or a holder who has
      been deleted or deactivated — and removes the ones you confirm. Only phones
      on a WebRTC base are considered, so shared desk and conference phones are
      never listed. Analyse first: nothing is deleted until you have reviewed the
      list and confirmed.
    </p>
    <p class="wd-caveat">
      <strong>Deleting a phone cannot be undone.</strong> A phone can be recreated
      from Phones › WebRTC › Create, but its id is gone and anything referring to
      it goes with it. Phones this page could not read are reported and locked
      rather than assumed to be unused.
    </p>

    <div class="wc-controls">
      <div class="wc-control-group">
        <label class="wc-label">Site</label>
        <div id="wdSiteSlot"></div>
      </div>
    </div>

    <div class="wc-actions">
      <button class="btn" id="wdAnalyseBtn">Analyse</button>
      <button class="btn wd-danger" id="wdDeleteBtn" hidden>Delete…</button>
      <button class="btn" id="wdCancelBtn" hidden>Cancel</button>
    </div>

    <div class="wc-status" id="wdStatus">Ready. Optionally filter, then click Analyse.</div>

    <div class="wc-progress-wrap" id="wdProgressWrap" style="display:none">
      <div class="wc-progress-bar" id="wdProgressBar"></div>
    </div>

    <div class="wc-summary" id="wdSummary" style="display:none"></div>
    <div id="wdReport"></div>

    <div class="wc-download" id="wdDownload" style="display:none">
      <button class="btn wc-btn-download" id="wdDownloadBtn">Download Excel Log</button>
    </div>
  `;

  el.querySelector("#wdSiteSlot").append(siteSelect.el);

  const $ = (sel) => el.querySelector(sel);
  const $analyseBtn   = $("#wdAnalyseBtn");
  const $deleteBtn    = $("#wdDeleteBtn");
  const $cancelBtn    = $("#wdCancelBtn");
  const $status       = $("#wdStatus");
  const $progressWrap = $("#wdProgressWrap");
  const $progressBar  = $("#wdProgressBar");
  const $summary      = $("#wdSummary");
  const $report       = $("#wdReport");
  const $download     = $("#wdDownload");
  const $downloadBtn  = $("#wdDownloadBtn");

  const setStatus = makeStatus($status, "wc-status");
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
    $analyseBtn.disabled = busy;
    $cancelBtn.hidden = !busy;
    siteSelect.setEnabled(!busy);
    updateDeleteBtn();
    // Locked rows stay locked whatever the page is doing — re-enabling a
    // checkbox for a phone we could not read would offer exactly the deletion
    // this page exists to refuse.
    $report.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.disabled = busy || state.done || cb.dataset.locked === "1";
    });
  }

  function updateDeleteBtn() {
    const ready = !!state.analysis && !state.done && state.selection.size > 0;
    $deleteBtn.hidden = !ready;
    $deleteBtn.disabled = state.running;
    $deleteBtn.textContent = `Delete ${state.selection.size} Phone${state.selection.size === 1 ? "" : "s"}…`;
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
    updateDeleteBtn();
  }

  // ── Phase 1: analyse ────────────────────────────────

  function describeFilters(siteIds) {
    if (!siteIds.size) return "";
    if (siteIds.size === 1) {
      const id = [...siteIds][0];
      return `site '${state.sites.find((s) => s.id === id)?.name || id}'`;
    }
    return `${siteIds.size} sites`;
  }

  $analyseBtn.addEventListener("click", async () => {
    const orgId = orgContext.get();
    resetReport();
    state.cancelled = false;
    setBusy(true);

    try {
      setStatus("Finding the WebRTC phone bases…");
      showProgress(4);
      const bases = await gc.fetchAllPhoneBaseSettings(api, orgId);
      const webRtcBases = bases.filter((b) => {
        const meta = String(b?.phoneMetaBase?.id || "").toLowerCase();
        return meta ? meta.includes("webrtc") : String(b?.name || "").toLowerCase().includes("webrtc");
      });
      if (!webRtcBases.length) {
        setStatus("No WebRTC phone base settings found in this org — nothing to consider.", "error");
        return;
      }
      const webRtcBaseIds = new Set(webRtcBases.map((b) => b.id));

      const siteIds = siteSelect.getSelected();
      const filterLabel = describeFilters(siteIds);

      setStatus("Reading phones and users…");
      showProgress(10);
      const [allPhones, users] = await Promise.all([
        // ONE request, filtered locally by site.
        //
        // This used to fan out — a request per selected site, carrying the
        // `siteId` filter, flattened together. Selecting three sites then
        // counted every phone three times, because the endpoint returns the
        // whole org regardless of that parameter. Fanning out is only safe
        // when the responses are actually disjoint, and here they were not.
        gc.fetchAllPhones(api, orgId),
        // `state: "any"` returns active, inactive and deleted users in one
        // pass, each carrying its own `state` — which is the whole question.
        gc.fetchAllUsers(api, orgId, { expand: ["division"], state: "any" }),
      ]);
      if (state.cancelled) { setStatus("Cancelled."); return; }

      const usersById = new Map(users.map((u) => [u.id, u]));

      // Count what came back by state. The deleted- and inactive-user
      // categories can only ever be populated if this request actually
      // returns those users, and `state: "any"` is exactly the kind of
      // parameter that turned out to be ignored for `siteId`. Reported in
      // Findings so an empty category can be read as "none exist" rather
      // than "we never looked".
      const userStates = users.reduce((acc, u) => {
        const s = String(u.state || "unknown").toLowerCase();
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {});

      // De-duplicate by phone id as well as filtering. Every count on this
      // page — and the delete loop itself — assumes one row per phone; a
      // repeated phone inflates the totals and would be deleted once and then
      // 404-ed twice more, each 404 counted as another successful deletion.
      const seen = new Set();
      const candidates = allPhones.filter((p) => {
        if (!p?.id || seen.has(p.id)) return false;
        if (siteIds.size && !siteIds.has(p.site?.id)) return false;
        const baseId = p.phoneBaseSettings?.id;
        if (baseId && !webRtcBaseIds.has(baseId)) return false;
        seen.add(p.id);
        return true;
      });

      if (!candidates.length) {
        setStatus(`No WebRTC phones found${filterLabel ? ` for ${filterLabel}` : ""}.`, "success");
        return;
      }

      setStatus("Matching phones to their users…");
      const { byPhone: holderByPhone, detailFetches, unreadable } = await resolvePhoneHolders(
        candidates, webRtcBaseIds, (id) => gc.getPhone(api, orgId, id),
        {
          shouldStop: () => state.cancelled,
          onProgress: (n, total) => {
            showProgress(15 + (n / Math.max(total, 1)) * 75);
            setStatus(`Matching phones to their users… ${n} of ${total}`);
          },
        }
      );
      if (state.cancelled) { setStatus("Cancelled."); return; }

      const siteNames = new Map(state.sites.map((s) => [s.id, s.name || s.id]));
      const { rows, activeCount } = categorisePhones(candidates, holderByPhone, unreadable, usersById, siteNames);

      state.analysis = {
        orgId, rows, activeCount, filterLabel,
        phoneCount: candidates.length, detailFetches,
        usersById, webRtcBaseIds, userStates,
      };
      state.selection = new Set(
        rows.filter((r) => CATEGORIES[r.category].deletable && CATEGORIES[r.category].ticked)
          .map((r) => r.phoneId)
      );

      renderReport();
      showProgress(100);

      // "Unused" and "ticked" are different numbers, because the unticked-by-
      // default categories sit between them. Saying only the first leaves the
      // delete button looking like it disagrees with the summary, so the gap
      // is spelled out.
      //
      // The remainder is COUNTED, never assumed. An earlier version wrote
      // "held by inactive users" on the strength of the arithmetic alone, and
      // when a different bug made the two numbers diverge, that sentence
      // dressed the discrepancy up as an explanation instead of exposing it.
      const deletable = rows.filter((r) => CATEGORIES[r.category].deletable);
      const unticked = deletable.filter((r) => !state.selection.has(r.phoneId));
      const untickedReasons = [...new Set(unticked.map((r) => CATEGORIES[r.category].label.toLowerCase()))];
      setStatus(
        deletable.length
          ? `${deletable.length} phone${deletable.length === 1 ? "" : "s"} look unused — `
            + `${state.selection.size} ticked for deletion`
            + (unticked.length ? `, ${unticked.length} left unticked (${untickedReasons.join("; ")})` : "")
            + `. Review below, then confirm.`
          : "Nothing to delete — every WebRTC phone in scope belongs to an active user.",
        deletable.length ? "" : "success"
      );
      setTimeout(hideProgress, 800);
    } catch (err) {
      setStatus(`Analysis failed: ${err.message}`, "error");
      console.error("WebRTC delete analyse error:", err);
    } finally {
      if (!state.analysis) hideProgress();
      setBusy(false);
    }
  });

  // ── Review rendering ────────────────────────────────

  function statusCellHtml(phoneId) {
    const res = state.results.get(phoneId);
    if (!res) return `<span class="wd-muted">—</span>`;
    const cls = res.status.startsWith("Deleted") ? "wd-good"
      : res.status.startsWith("Failed") ? "wd-bad" : "wd-warn";
    return `<span class="${cls}">${escapeHtml(res.status)}</span>`;
  }

  function sectionHtml(category, rows) {
    if (!rows.length) return "";
    const meta = CATEGORIES[category];
    return `
      <div class="wd-sect${meta.deletable ? "" : " wd-sect--locked"}">
        <div class="wd-sect-head">
          <span>${escapeHtml(meta.label)}</span>
          <span class="wd-badge">${rows.length}</span>
          ${meta.deletable ? "" : `<span class="wd-badge wd-warn">not selectable</span>`}
        </div>
        <div class="wd-sect-blurb">${escapeHtml(meta.blurb)}</div>
        <div class="wd-sect-body">
          <table class="wd-tbl">
            <thead>
              <tr><th style="width:28px"></th><th>Phone</th><th>Site</th>
                  <th>Holder</th><th>Result</th></tr>
            </thead>
            <tbody>
              ${rows.map((r) => `
                <tr data-phone="${escapeHtml(r.phoneId)}">
                  <td><input type="checkbox" data-phone="${escapeHtml(r.phoneId)}"
                       ${state.selection.has(r.phoneId) ? "checked" : ""}
                       ${meta.deletable ? "" : `disabled data-locked="1"`}></td>
                  <td>${escapeHtml(r.phoneName)}<div class="wd-muted">${escapeHtml(r.phoneId)}</div></td>
                  <td>${escapeHtml(r.siteName)}</td>
                  <td>${escapeHtml(r.holderName || "—")}
                      <div class="wd-muted">${escapeHtml(r.detail || "")}</div></td>
                  <td class="wd-cell-status">${statusCellHtml(r.phoneId)}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function findingsHtml() {
    const a = state.analysis;
    const notes = [
      `${a.phoneCount} WebRTC phone${a.phoneCount === 1 ? "" : "s"} examined`
      + (a.detailFetches ? `, ${a.detailFetches} read individually because the list did not name their user` : "")
      + `.`,
      `${a.activeCount} belong${a.activeCount === 1 ? "s" : ""} to an active user and ${a.activeCount === 1 ? "is" : "are"} not listed.`,
    ];
    // What the org actually contains, so an empty category can be told apart
    // from a lookup that never returned the users it needed.
    const st = a.userStates || {};
    const total = Object.values(st).reduce((n, v) => n + v, 0);
    const breakdown = Object.entries(st).sort((x, y) => y[1] - x[1])
      .map(([s, n]) => `${n} ${s}`).join(", ");
    notes.push(`${total} user${total === 1 ? "" : "s"} read — ${breakdown || "none"}.`);
    if (!st.inactive && !st.deleted) {
      notes.push(
        `<span class="wd-warn">No inactive or deleted users came back, so those two categories `
        + `could not be populated by this run. If the org does have inactive or deleted users, `
        + `the lookup is not returning them and an empty category here means nothing.</span>`
      );
    }

    const unreadable = a.rows.filter((r) => r.category === "UNREADABLE").length;
    if (unreadable) {
      notes.push(`<span class="wd-warn">${unreadable} phone${unreadable === 1 ? "" : "s"} could not be read and ${unreadable === 1 ? "is" : "are"} locked. Unknown is not unused.</span>`);
    }
    return `<div class="wd-find"><strong>Findings</strong><ul>${notes.map((n) => `<li>${n}</li>`).join("")}</ul></div>`;
  }

  /**
   * The summary carries the ticked count, so it has to follow the ticks. It is
   * rewritten on every selection change — a summary that still reports the
   * count from analysis time is the same mismatch in a different place.
   * Not called once a run has finished: the results replace it.
   */
  function renderSummary() {
    if (!state.analysis || state.done) return;
    const { rows, filterLabel, phoneCount, activeCount } = state.analysis;
    const deletable = rows.filter((r) => CATEGORIES[r.category].deletable).length;

    $summary.textContent =
      `${phoneCount} WebRTC phone${phoneCount === 1 ? "" : "s"} examined`
      + (filterLabel ? ` (${filterLabel})` : "")
      + ` — ${deletable} unused (${state.selection.size} ticked)`
      + `, ${activeCount} in use`;
    $summary.style.display = "";
  }

  function renderReport() {
    const { rows } = state.analysis;
    const byCategory = (key) => rows.filter((r) => r.category === key);

    renderSummary();

    $report.innerHTML = findingsHtml()
      + Object.keys(CATEGORIES).map((key) => sectionHtml(key, byCategory(key))).join("");

    state.statusCells.clear();
    for (const tr of $report.querySelectorAll("tr[data-phone]")) {
      state.statusCells.set(tr.dataset.phone, tr.querySelector(".wd-cell-status"));
    }
    updateDeleteBtn();
  }

  $report.addEventListener("change", (ev) => {
    const cb = ev.target;
    if (cb?.type !== "checkbox" || state.running || state.done) return;
    if (cb.dataset.phone) {
      if (cb.checked) state.selection.add(cb.dataset.phone);
      else state.selection.delete(cb.dataset.phone);
      updateDeleteBtn();
      renderSummary();
    }
  });

  // ── Phase 2: confirm ────────────────────────────────

  function showDeleteConfirm() {
    const rows = state.analysis.rows.filter((r) => state.selection.has(r.phoneId));
    const preview = rows.slice(0, 12);
    const inactive = rows.filter((r) => r.category === "INACTIVE_USER").length;

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center";
    overlay.innerHTML = `
      <div style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:22px;min-width:420px;max-width:640px;width:92%">
        <h3 style="margin:0 0 12px;font-size:1.05rem">
          Delete ${rows.length} WebRTC phone${rows.length === 1 ? "" : "s"}?
        </h3>
        <p style="margin:0 0 10px;font-size:.88rem">
          <strong class="wd-bad">This cannot be undone.</strong> Each phone is
          re-checked immediately before it is removed, and any that has since
          been assigned to an active user is kept and reported.
        </p>
        ${inactive ? `
          <div class="wd-caveat">
            ${inactive} of these belong${inactive === 1 ? "s" : ""} to an <strong>inactive</strong> user.
            If that user is reactivated they will have no phone until one is created again.
          </div>` : ""}
        <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin:10px 0">
          ${preview.map((r) => `
            <div style="padding:5px 10px;border-bottom:1px solid var(--border);font-size:.85rem">
              ${escapeHtml(r.phoneName)}
              <span style="color:var(--muted)">— ${escapeHtml(CATEGORIES[r.category].label.toLowerCase())}</span>
            </div>`).join("")}
          ${rows.length > preview.length ? `
            <div style="padding:5px 10px;font-size:.85rem;color:var(--muted)">
              …and ${rows.length - preview.length} more
            </div>` : ""}
        </div>
        <label class="wc-label" for="wdConfirmWord" style="font-size:.85rem">
          Type ${CONFIRM_WORD} to confirm:
        </label>
        <input class="input" id="wdConfirmWord" type="text" autocomplete="off"
               placeholder="${CONFIRM_WORD}" style="width:100%;margin-top:4px" />
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
          <button id="wdCancelDel" class="btn btn--secondary">Cancel</button>
          <button id="wdDoDelete" class="btn wd-danger" disabled>Delete permanently</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const $word = overlay.querySelector("#wdConfirmWord");
    const $go = overlay.querySelector("#wdDoDelete");
    const close = () => { if (overlay.parentNode) document.body.removeChild(overlay); };
    $word.focus();
    $word.addEventListener("input", () => {
      $go.disabled = $word.value.trim().toUpperCase() !== CONFIRM_WORD;
    });
    overlay.querySelector("#wdCancelDel").addEventListener("click", close);
    $go.addEventListener("click", () => { close(); runDelete(rows); });
  }

  $deleteBtn.addEventListener("click", () => {
    if (!state.analysis || !state.selection.size) return;
    if (orgContext.get() !== state.analysis.orgId) {
      setStatus("The organisation changed since this analysis was run. Analyse again.", "error");
      resetReport();
      return;
    }
    showDeleteConfirm();
  });

  // ── Phase 3: delete ─────────────────────────────────

  async function runDelete(rows) {
    const { orgId, usersById } = state.analysis;
    state.cancelled = false;
    setBusy(true);
    $download.style.display = "none";

    let deleted = 0, kept = 0, failed = 0;

    const record = (row, status, detail) => {
      state.results.set(row.phoneId, { status, detail });
      const cell = state.statusCells.get(row.phoneId);
      if (cell) cell.innerHTML = statusCellHtml(row.phoneId);
    };

    const writeLog = (aborted) => logAction({
      me, orgId, orgName: org.name || "",
      action: "phone_delete",
      description: `Deleted ${deleted} WebRTC phone${deleted === 1 ? "" : "s"}`
        + `${kept ? ` (${kept} kept — in use again)` : ""}`
        + `${failed ? ` (${failed} failed)` : ""}`
        + `${aborted ? " [aborted]" : state.cancelled ? " [cancelled]" : ""}`,
      result: deleted === 0 && (failed > 0 || aborted) ? "failure"
        : failed > 0 || kept > 0 || state.cancelled || aborted ? "partial" : "success",
      count: deleted,
    });

    try {
      for (let i = 0; i < rows.length; i++) {
        if (state.cancelled) break;
        const row = rows[i];

        setStatus(`Deleting phone ${i + 1} of ${rows.length} — ${row.phoneName}`);
        showProgress((i / rows.length) * 100);

        const check = await stillUnused(row, (id) => gc.getPhone(api, orgId, id), usersById);
        if (!check.ok) {
          kept++;
          record(row, `Kept: ${check.reason}`.slice(0, 200));
          continue;
        }
        if (check.gone) {
          deleted++;
          record(row, "Deleted (already gone)");
          continue;
        }

        try {
          await gc.withRateLimitRetry(() => gc.deletePhone(api, orgId, row.phoneId));
          deleted++;
          record(row, "Deleted");
        } catch (err) {
          if (err?.status === 404) {
            deleted++;
            record(row, "Deleted (already gone)");
          } else {
            failed++;
            record(row, `Failed: ${err?.status ? `${err.status} — ` : ""}${err?.message || err}`.slice(0, 200));
          }
        }

        if (i < rows.length - 1) await sleep(50);
      }

      state.done = true;
      showProgress(100);

      const notRun = rows.length - deleted - kept - failed;
      const parts = [];
      if (deleted) parts.push(`Deleted: ${deleted}`);
      if (kept)    parts.push(`Kept (in use again): ${kept}`);
      if (failed)  parts.push(`Failed: ${failed}`);
      if (notRun)  parts.push(`Not run: ${notRun}`);

      setStatus(state.cancelled ? "Cancelled." : "Done.", failed ? "error" : "success");
      $summary.textContent = (state.cancelled ? "Cancelled.  " : "") + parts.join("  •  ");

      writeLog(false);
      $download.style.display = "";
      setTimeout(hideProgress, 800);
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
      console.error("WebRTC delete error:", err);
      writeLog(true);
      $download.style.display = "";
      hideProgress();
    } finally {
      setBusy(false);
      updateDeleteBtn();
    }
  }

  $cancelBtn.addEventListener("click", () => {
    state.cancelled = true;
    setStatus("Cancelling after the current phone…");
  });

  // ── Excel log ───────────────────────────────────────
  $downloadBtn.addEventListener("click", () => {
    if (!state.analysis) return;
    const rows = state.analysis.rows.map((r) => {
      const res = state.results.get(r.phoneId);
      return {
        phoneName: r.phoneName,
        phoneId: r.phoneId,
        site: r.siteName,
        category: CATEGORIES[r.category].label,
        holder: r.holderName || "—",
        holderEmail: r.holderEmail || "—",
        division: r.divisionName || "—",
        reason: r.detail || "",
        status: res ? res.status
          : CATEGORIES[r.category].deletable ? "Not run" : "Skipped (not selectable)",
      };
    });

    try {
      exportLogXlsx({
        sheetName: "WebRTC Phone Deletions",
        columns: [
          { key: "phoneName",   label: "Phone Name", wch: 32 },
          { key: "phoneId",     label: "Phone ID",   wch: 38 },
          { key: "site",        label: "Site",       wch: 22 },
          { key: "category",    label: "Category",   wch: 26 },
          { key: "holder",      label: "Holder",     wch: 26 },
          { key: "holderEmail", label: "Holder Email", wch: 30 },
          { key: "division",    label: "Division",   wch: 22 },
          { key: "reason",      label: "Reason",     wch: 34 },
          { key: "status",      label: "Status",     wch: 34 },
        ],
        rows,
        filename: timestampedFilename(`WebRTC_Phone_Deletions_${org.name || orgContext.get()}`, "xlsx"),
      });
    } catch (err) {
      setStatus(err.message, "error");
    }
  });

  // ── Load the site filter on mount ──────────────────
  (async () => {
    try {
      state.sites = await gc.fetchAllSites(api, orgContext.get());
      siteSelect.setItems(state.sites.map((s) => ({ id: s.id, label: s.name || s.id })));
      siteSelect.setPlaceholder(`All sites (${state.sites.length})`);
      setStatus("Ready. Optionally narrow to particular sites, then click Analyse.");
    } catch (err) {
      // The filter is optional, so a failure here does not block Analyse —
      // it just means the sweep covers the whole org.
      siteSelect.setPlaceholder("Sites unavailable");
      siteSelect.setEnabled(false);
      console.error("Site load error:", err);
      setStatus("Ready, but the site filter could not load. Click Analyse to sweep the whole org.", "error");
    }
  })();

  return el;
}
