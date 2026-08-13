/**
 * Phones › WebRTC — Change Site
 *
 * Moves phones from one site to another.
 *
 * Flow:
 *   1. Optionally filter by the group or division of the phone's holder
 *   2. Pick a source ("From") and destination ("To") site
 *   3. Load Phones → lists the phones at the source that match the filters
 *   4. Select phones via the searchable multi-select
 *   5. Move → confirm the count and destination, then PUT each phone
 *   6. Summary text + Excel log
 *
 * Moving a phone re-registers it, so anyone on a call through it can drop.
 * That is why the run is behind a confirmation even though it is reversible:
 * the cost is not "an object exists that should not", it is live traffic.
 *
 * API endpoints:
 *   GET /api/v2/telephony/providers/edges/sites            — list sites
 *   GET /api/v2/telephony/providers/edges/phones           — list all phones
 *   GET /api/v2/telephony/providers/edges/phones/{id}      — full phone (holder, version)
 *   PUT /api/v2/telephony/providers/edges/phones/{id}      — update phone site
 *   GET /api/v2/groups, /api/v2/groups/{id}/members        — group filter
 *   GET /api/v2/authorization/divisions, /api/v2/users     — division filter
 */
import { escapeHtml, sleep, timestampedFilename, exportLogXlsx } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import { resolvePhoneHolders } from "../../../lib/phoneHolders.js";
import { logAction } from "../../../services/activityLogService.js";

/**
 * Fields the API rejects on the way back in. A phone PUT is a full-object
 * replace, so the object read from GET has to be handed back minus everything
 * the server owns.
 */
const SERVER_OWNED_FIELDS = [
  "status", "statusSummary", "userAgentInfo", "primaryEdge", "secondaryEdge", "selfUri",
];

/**
 * Which phones does the operator's filter admit?
 *
 * Both filters are optional and independent; a phone must satisfy every filter
 * that IS set. They resolve through the phone's holder, so a phone with no
 * assigned user cannot match any filter and drops out — reported as its own
 * count rather than silently vanishing.
 *
 * @param {Object[]} phones
 * @param {Map<string,string>} holderByPhone     phone id → user id
 * @param {Set<string>|null}   groupMemberIds    null when no group filter
 * @param {Set<string>}        divisionIds       empty when no division filter
 * @param {Map<string,string>} divisionByUser    user id → division id
 * @returns {{ kept: Object[], outsideFilters: number, noHolder: number }}
 */
export function filterPhonesByHolder(phones, holderByPhone, groupMemberIds, divisionIds, divisionByUser) {
  const filtering = !!groupMemberIds || divisionIds.size > 0;
  if (!filtering) return { kept: phones, outsideFilters: 0, noHolder: 0 };

  const kept = [];
  let outsideFilters = 0;
  let noHolder = 0;

  for (const p of phones) {
    const holder = holderByPhone.get(p.id);
    if (!holder) { noHolder++; continue; }
    if (groupMemberIds && !groupMemberIds.has(holder)) { outsideFilters++; continue; }
    if (divisionIds.size && !divisionIds.has(divisionByUser.get(holder))) { outsideFilters++; continue; }
    kept.push(p);
  }
  return { kept, outsideFilters, noHolder };
}

/**
 * Describe a failed move.
 *
 * The proxy forwards the Genesys status verbatim (api/genesys-proxy/index.js),
 * so `err.status` is reliable and worth keeping: a 409 from someone else
 * editing the phone and a 400 from a rejected body are different problems, and
 * the message alone does not distinguish them.
 */
function describeMoveError(err) {
  const message = err?.message || String(err);
  return `Failed: ${err?.status ? `${err.status} — ` : ""}${message}`.slice(0, 200);
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderChangeSite({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Phones — WebRTC — Change Site</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ───────────────────────────────────────────
  const state = {
    sites: [],
    groups: [],
    divisions: [],
    phonesAtSource: [],     // phones at the source site, after filtering
    holderByPhone: new Map(),
    loadedFrom: "",         // the site `phonesAtSource` was loaded for
    isRunning: false,
    cancelled: false,
    logRows: [],
  };

  // ── Phone picker ────────────────────────────────────
  // `onMoveReady` is a hoisted declaration, so the callback can safely run
  // before the DOM refs further down are initialised.
  const phoneSelect = createMultiSelect({
    placeholder: "Load phones first…",
    searchable: true,
    onChange: () => onMoveReady(),
  });

  // ── Filters ─────────────────────────────────────────
  // Changing a filter invalidates the loaded phone list: it was built for a
  // different filter and the picker would otherwise still offer phones the
  // operator has just excluded.
  const onFilterChange = () => {
    clearLoadedPhones();
    setStatus("Filters changed. Click Load Phones.");
  };
  const groupSelect = createMultiSelect({
    placeholder: "All groups", searchable: true, onChange: onFilterChange,
  });
  const divisionSelect = createMultiSelect({
    placeholder: "All divisions", searchable: true, onChange: onFilterChange,
  });

  // ── Build UI ────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Phones — WebRTC — Change Site</h1>
    <hr class="hr">

    <p class="page-desc">
      Move phones from one site to another. Optionally narrow the list to the
      phones held by particular groups or divisions, load the phones at the
      source site, then select the ones to move. Moving a phone re-registers
      it, so it is worth doing outside busy hours.
    </p>

    <!-- Filters: narrow which phones are offered. Both optional. -->
    <div class="cs-controls">
      <div class="cs-control-group">
        <label class="cs-label">Groups</label>
        <div id="csGroupSlot"></div>
      </div>
      <div class="cs-control-group">
        <label class="cs-label">Division</label>
        <div id="csDivisionSlot"></div>
      </div>
    </div>

    <!-- Site selectors -->
    <div class="cs-controls">
      <div class="cs-control-group">
        <label class="cs-label" for="csFromSite">From Site</label>
        <select class="input cs-site-select" id="csFromSite" disabled>
          <option value="">Loading sites…</option>
        </select>
      </div>
      <div class="cs-control-group">
        <label class="cs-label" for="csToSite">To Site</label>
        <select class="input cs-site-select" id="csToSite" disabled>
          <option value="">Loading sites…</option>
        </select>
      </div>
    </div>

    <!-- Load phones button -->
    <div class="cs-actions">
      <button class="btn" id="csLoadBtn" disabled>Load Phones</button>
    </div>

    <!-- Phone selector (multi-select injected here) -->
    <div class="cs-controls" id="csPhoneWrap" style="display:none">
      <div class="cs-control-group">
        <label class="cs-label">Phones</label>
        <div id="csPhoneSlot"></div>
      </div>
    </div>

    <!-- Move button -->
    <div class="cs-actions" id="csMoveWrap" style="display:none">
      <button class="btn cs-btn-move" id="csMoveBtn" disabled>Move Selected</button>
      <button class="btn" id="csCancelBtn" hidden>Cancel</button>
    </div>

    <!-- Status -->
    <div class="cs-status" id="csStatus">Loading sites…</div>

    <!-- Progress bar -->
    <div class="cs-progress-wrap" id="csProgressWrap" style="display:none">
      <div class="cs-progress-bar" id="csProgressBar"></div>
    </div>

    <!-- Summary -->
    <div class="wc-summary" id="csSummary" style="display:none"></div>

    <!-- Download Excel button -->
    <div class="wc-download" id="csDownload" style="display:none">
      <button class="btn wc-btn-download" id="csDownloadBtn">Download Excel Log</button>
    </div>
  `;

  el.querySelector("#csPhoneSlot").append(phoneSelect.el);
  el.querySelector("#csGroupSlot").append(groupSelect.el);
  el.querySelector("#csDivisionSlot").append(divisionSelect.el);

  // ── DOM refs ────────────────────────────────────────
  const $ = (sel) => el.querySelector(sel);
  const $fromSite     = $("#csFromSite");
  const $toSite       = $("#csToSite");
  const $loadBtn      = $("#csLoadBtn");
  const $phoneWrap    = $("#csPhoneWrap");
  const $moveWrap     = $("#csMoveWrap");
  const $moveBtn      = $("#csMoveBtn");
  const $cancelBtn    = $("#csCancelBtn");
  const $status       = $("#csStatus");
  const $progressWrap = $("#csProgressWrap");
  const $progressBar  = $("#csProgressBar");
  const $summary      = $("#csSummary");
  const $download     = $("#csDownload");
  const $downloadBtn  = $("#csDownloadBtn");

  // ── Helpers ─────────────────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "cs-status" + (type ? ` cs-status--${type}` : "");
  }
  function showProgress(pct) {
    $progressWrap.style.display = "";
    $progressBar.style.width = `${Math.min(pct, 100)}%`;
  }
  function hideProgress() {
    $progressWrap.style.display = "none";
    $progressBar.style.width = "0%";
  }
  function setRunning(running) {
    state.isRunning = running;
    $fromSite.disabled = running;
    $toSite.disabled = running;
    $loadBtn.disabled = running || !loadReady();
    groupSelect.setEnabled(!running);
    divisionSelect.setEnabled(!running);
    phoneSelect.setEnabled(!running);
    $cancelBtn.hidden = !running;
    onMoveReady();
  }

  /** Both sites chosen, and not the same one. */
  function loadReady() {
    return !!$fromSite.value && !!$toSite.value && $fromSite.value !== $toSite.value;
  }

  /**
   * The Move button tracks the selection, and is refused when the destination
   * is the source. Without that check a "move" to the phone's current site
   * PUTs a no-op and the log still reports it as moved.
   */
  function onMoveReady() {
    const count = phoneSelect.getSelected().size;
    const sameSite = $fromSite.value && $fromSite.value === $toSite.value;
    $moveBtn.disabled = state.isRunning || count === 0 || sameSite || !state.phonesAtSource.length;
    $moveBtn.textContent = sameSite
      ? "Destination is the source site"
      : count
        ? `Move ${count} Phone${count === 1 ? "" : "s"}`
        : "Move Selected";
  }

  /** Drop the loaded phone list — used whenever it stops being valid. */
  function clearLoadedPhones() {
    state.phonesAtSource = [];
    state.holderByPhone = new Map();
    state.loadedFrom = "";
    phoneSelect.setItems([]);
    phoneSelect.setPlaceholder("Load phones first…");
    $phoneWrap.style.display = "none";
    $moveWrap.style.display = "none";
    onMoveReady();
  }

  $fromSite.addEventListener("change", () => {
    $loadBtn.disabled = !loadReady();
    clearLoadedPhones();
  });
  $toSite.addEventListener("change", () => {
    $loadBtn.disabled = !loadReady();
    onMoveReady();
  });

  // ── Load phones at source site ─────────────────────

  /**
   * Resolve the filters to the sets the phone filter needs.
   *
   * Only fetched when a filter is actually set: with no filters this page has
   * no reason to know who holds a phone, and resolving holders can mean a read
   * per phone at the source site.
   */
  async function resolveFilters(orgId, phones) {
    const groupIds = groupSelect.getSelected();
    const divisionIds = divisionSelect.getSelected();
    if (!groupIds.size && !divisionIds.size) {
      return { groupMemberIds: null, divisionIds, divisionByUser: new Map(), holderByPhone: new Map(), label: "" };
    }

    setStatus("Matching phones to the users who hold them…");
    const { byPhone: holderByPhone } = await resolvePhoneHolders(
      phones,
      null, // no base restriction: a desk phone belongs to its owner too
      (phoneId) => gc.getPhone(api, orgId, phoneId),
      {
        shouldStop: () => state.cancelled,
        onProgress: (n, total) => setStatus(`Matching phones to their users… ${n} of ${total}`),
      }
    );

    let groupMemberIds = null;
    if (groupIds.size) {
      setStatus(`Reading members of ${groupIds.size} group${groupIds.size === 1 ? "" : "s"}…`);
      const lists = await Promise.all(
        [...groupIds].map((id) => gc.fetchGroupMembers(api, orgId, id).catch(() => []))
      );
      groupMemberIds = new Set(lists.flat().map((m) => m.id));
    }

    const divisionByUser = new Map();
    if (divisionIds.size) {
      setStatus("Reading user divisions…");
      const users = await gc.fetchAllUsers(api, orgId, { expand: ["division"], state: "active" });
      for (const u of users) divisionByUser.set(u.id, u.division?.id);
    }

    const nameOf = (items, id) => items.find((i) => i.id === id)?.name || id;
    const parts = [];
    if (groupIds.size) {
      parts.push(groupIds.size === 1 ? `group '${nameOf(state.groups, [...groupIds][0])}'` : `${groupIds.size} groups`);
    }
    if (divisionIds.size) {
      parts.push(divisionIds.size === 1 ? `division '${nameOf(state.divisions, [...divisionIds][0])}'` : `${divisionIds.size} divisions`);
    }

    return { groupMemberIds, divisionIds, divisionByUser, holderByPhone, label: parts.join(" + ") };
  }

  $loadBtn.addEventListener("click", async () => {
    const fromId = $fromSite.value;
    if (!fromId) return;

    clearLoadedPhones();
    $summary.style.display = "none";
    $download.style.display = "none";
    state.cancelled = false;
    $loadBtn.disabled = true;

    try {
      const orgId = orgContext.get();
      setStatus("Loading phones…");

      // `siteId` is the filter name the platform SDK documents for this
      // endpoint, but it is NOT honoured in practice: the Delete page briefly
      // issued one request per selected site and got the full org list back
      // from each, tripling its counts for three sites. The parameter is left
      // in place because it costs nothing and may be honoured on other org
      // versions — but nothing depends on it.
      //
      // The client-side filter below is what actually scopes this page, which
      // is why that discovery cost a page's counts and not a wrong site's
      // phones being moved.
      const allPhones = await gc.fetchAllPhones(api, orgId, { query: { siteId: fromId } });
      const atSource = allPhones.filter((p) => p.site?.id === fromId);

      if (!atSource.length) {
        setStatus("No phones found at the selected source site.", "error");
        return;
      }

      const { groupMemberIds, divisionIds, divisionByUser, holderByPhone, label } =
        await resolveFilters(orgId, atSource);

      const { kept, outsideFilters, noHolder } =
        filterPhonesByHolder(atSource, holderByPhone, groupMemberIds, divisionIds, divisionByUser);

      state.holderByPhone = holderByPhone;

      if (!kept.length) {
        setStatus(
          `${atSource.length} phone${atSource.length === 1 ? "" : "s"} at the source site, but none match ${label}.`,
          "error"
        );
        return;
      }

      state.phonesAtSource = kept;
      state.loadedFrom = fromId;

      phoneSelect.setPlaceholder("Select phones…");
      phoneSelect.setItems(kept.map((p) => ({ id: p.id, label: p.name || p.id })));

      $phoneWrap.style.display = "";
      $moveWrap.style.display = "";
      onMoveReady();

      // With a filter on, say what the filter removed. "12 phones" reads very
      // differently when the site actually holds 300.
      const detail = label
        ? ` of ${atSource.length} at the site (${label}` +
          (noHolder ? `; ${noHolder} with no assigned user excluded` : "") + ")"
        : "";
      setStatus(`Found ${kept.length} phone${kept.length === 1 ? "" : "s"}${detail}. Select the ones to move.`);
    } catch (err) {
      setStatus(`Failed to load phones: ${err.message}`, "error");
      console.error("Phone load error:", err);
    } finally {
      $loadBtn.disabled = !loadReady() || state.isRunning;
    }
  });

  // ── Confirm ─────────────────────────────────────────

  function showMoveConfirm(phonesToMove, toSite) {
    const preview = phonesToMove.slice(0, 12);

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center";
    overlay.innerHTML = `
      <div style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:22px;min-width:420px;max-width:620px;width:92%">
        <h3 style="margin:0 0 12px;font-size:1.05rem">
          Move ${phonesToMove.length} phone${phonesToMove.length === 1 ? "" : "s"} to “${escapeHtml(toSite.name)}”?
        </h3>
        <p style="margin:0 0 10px;font-size:.85rem;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);border-radius:6px;padding:8px 11px">
          Each phone re-registers against the new site. Anyone on a call through
          one of these phones can be disconnected. The move is reversible by
          moving them back.
        </p>
        <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin:10px 0">
          ${preview.map((p) => `
            <div style="padding:5px 10px;border-bottom:1px solid var(--border);font-size:.85rem">
              ${escapeHtml(p.name || p.id)}
            </div>`).join("")}
          ${phonesToMove.length > preview.length ? `
            <div style="padding:5px 10px;font-size:.85rem;color:var(--muted)">
              …and ${phonesToMove.length - preview.length} more
            </div>` : ""}
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
          <button id="csCancelMove" class="btn btn--secondary">Cancel</button>
          <button id="csDoMove" class="btn cs-btn-move">Move ${phonesToMove.length} phone${phonesToMove.length === 1 ? "" : "s"}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => { if (overlay.parentNode) document.body.removeChild(overlay); };
    overlay.querySelector("#csCancelMove").addEventListener("click", close);
    overlay.querySelector("#csDoMove").addEventListener("click", () => {
      close();
      runMove(phonesToMove, toSite);
    });
  }

  $moveBtn.addEventListener("click", () => {
    const selectedIds = phoneSelect.getSelected();
    if (!selectedIds.size) { setStatus("No phones selected.", "error"); return; }

    const toId = $toSite.value;
    const toSite = state.sites.find((s) => s.id === toId);
    if (!toId || !toSite) { setStatus("Please select a destination site.", "error"); return; }
    if (toId === $fromSite.value) {
      setStatus("The destination is the same as the source site.", "error");
      return;
    }
    if ($fromSite.value !== state.loadedFrom) {
      setStatus("The source site changed since these phones were loaded. Load Phones again.", "error");
      clearLoadedPhones();
      return;
    }

    showMoveConfirm(state.phonesAtSource.filter((p) => selectedIds.has(p.id)), toSite);
  });

  // ── Move ────────────────────────────────────────────

  async function runMove(phonesToMove, toSite) {
    const orgId = orgContext.get();
    const fromSite = state.sites.find((s) => s.id === state.loadedFrom);
    const total = phonesToMove.length;

    state.cancelled = false;
    setRunning(true);
    state.logRows = [];
    $summary.style.display = "none";
    $download.style.display = "none";

    let moved = 0, failed = 0;

    const record = (phone, status) => state.logRows.push({
      phoneName: phone.name || "—",
      phoneId: phone.id,
      fromSite: fromSite?.name || state.loadedFrom,
      toSite: toSite.name,
      status,
      timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
    });

    const writeLog = (aborted) => logAction({
      me, orgId, orgName: org.name || "",
      action: "phone_move",
      description: `Moved ${moved} phone${moved === 1 ? "" : "s"} to '${toSite.name}'`
        + `${failed ? ` (${failed} failed)` : ""}`
        + `${aborted ? " [aborted]" : state.cancelled ? " [cancelled]" : ""}`,
      result: moved === 0 && (failed > 0 || aborted) ? "failure"
        : failed > 0 || state.cancelled || aborted ? "partial" : "success",
      count: moved,
    });

    try {
      for (let i = 0; i < total; i++) {
        if (state.cancelled) break;

        const phone = phonesToMove[i];
        setStatus(`Moving phone ${i + 1} of ${total}… ${phone.name || phone.id}`);
        showProgress((i / total) * 100);

        try {
          // The full object is needed for its `version` and for the fields a
          // PUT must echo back — the list response carries neither.
          const fullPhone = await gc.getPhone(api, orgId, phone.id);

          const updatedPhone = { ...fullPhone, site: { id: toSite.id, name: toSite.name } };
          for (const field of SERVER_OWNED_FIELDS) delete updatedPhone[field];

          await gc.withRateLimitRetry(() => gc.updatePhone(api, orgId, phone.id, updatedPhone));
          moved++;
          record(phone, "Moved");
        } catch (err) {
          failed++;
          record(phone, describeMoveError(err));
        }

        // Rate limit: 50ms between PUTs. 429s are retried with backoff.
        if (i < total - 1) await sleep(50);
      }

      showProgress(100);

      const notRun = total - moved - failed;
      const parts = [];
      if (moved)  parts.push(`Moved: ${moved}`);
      if (failed) parts.push(`Failed: ${failed}`);
      if (notRun) parts.push(`Not run: ${notRun}`);

      setStatus(
        (state.cancelled ? "Cancelled." : "Done.") + " Load Phones again to move more.",
        failed ? "error" : "success"
      );
      $summary.textContent = (state.cancelled ? "Cancelled.  " : "") + parts.join("  •  ");
      $summary.style.display = "";

      writeLog(false);
      if (state.logRows.length) $download.style.display = "";
      setTimeout(hideProgress, 800);
    } catch (err) {
      // The per-phone try/catch handles move failures; reaching here means
      // something outside the loop broke. Record what was already moved.
      setStatus(`Error: ${err.message}`, "error");
      console.error("Change site error:", err);
      writeLog(true);
      if (state.logRows.length) $download.style.display = "";
      hideProgress();
    } finally {
      setRunning(false);
      // The loaded list is now wrong — those phones are at the destination,
      // not the source. Keeping it on screen would invite a second move of
      // phones that are no longer where the picker claims they are.
      clearLoadedPhones();
    }
  }

  $cancelBtn.addEventListener("click", () => {
    state.cancelled = true;
    setStatus("Cancelling after the current phone…");
  });

  // ── Download Excel ─────────────────────────────────
  $downloadBtn.addEventListener("click", () => {
    if (!state.logRows.length) return;
    try {
      exportLogXlsx({
        sheetName: "Phone Site Changes",
        columns: [
          { key: "phoneName", label: "Phone Name", wch: 30 },
          { key: "phoneId",   label: "Phone ID",   wch: 38 },
          { key: "fromSite",  label: "From Site",  wch: 22 },
          { key: "toSite",    label: "To Site",    wch: 22 },
          { key: "status",    label: "Status",     wch: 34 },
          { key: "timestamp", label: "Timestamp",  wch: 20 },
        ],
        rows: state.logRows,
        filename: timestampedFilename(`Phone_Site_Changes_${org.name || orgContext.get()}`, "xlsx"),
      });
    } catch (err) {
      setStatus(err.message, "error");
    }
  });

  // ── Load sites and filter options on mount ─────────
  (async () => {
    // Sites gate the page; the filters do not. A failure to load groups or
    // divisions leaves those pickers disabled and the page still usable.
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
    const siteOptions = `<option value="">— Select a site —</option>`
      + state.sites.map((s) =>
        `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name || s.id)}</option>`
      ).join("");

    $fromSite.innerHTML = siteOptions;
    $toSite.innerHTML = siteOptions;
    $fromSite.disabled = false;
    $toSite.disabled = false;

    const notes = [];

    if (groupsRes.status === "fulfilled") {
      state.groups = groupsRes.value;
      // Every group type is offered; the type is shown for anything that is
      // not official, so a social group is not mistaken for one.
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
      ? `Ready, but the ${notes.join(" and ")} filter could not load. Select source and destination sites, then load phones.`
      : "Ready. Optionally filter by group or division, select source and destination sites, then load phones.",
    notes.length ? "error" : "");
  })();

  return el;
}
