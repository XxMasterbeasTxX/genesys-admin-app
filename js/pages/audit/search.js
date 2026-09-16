/**
 * Audit › Search
 *
 * Routing (decided by how OLD the interval start is, not how long the range is —
 * the realtime endpoint holds only the last 14 days of audits):
 *   start within 14 days, no service   → realtime API, all realtime-supported services
 *   start within 14 days, service in realtime mapping → realtime API (sync, fast)
 *   start within 14 days, service NOT in realtime mapping → async API
 *   start older than 14 days           → async API, all services unless one is
 *                                        picked. Confirmed 2026-09-16: a
 *                                        service-less query is accepted (3105
 *                                        rows over 30 days). The 400 handler
 *                                        below is kept in case that changes.
 *
 * Realtime endpoints (synchronous, last 14 days, page-number pagination in body):
 *   GET  /api/v2/audits/query/realtime/servicemapping
 *   POST /api/v2/audits/query/realtime?expand=user
 *   POST /api/v2/audits/query/realtime/related   (all audits from one action)
 *
 * Async endpoints (any range, cursor pagination):
 *   GET  /api/v2/audits/query/servicemapping
 *   POST /api/v2/audits/query
 *   GET  /api/v2/audits/query/{transactionId}
 *   GET  /api/v2/audits/query/{transactionId}/results?expand=user
 *
 * Searching for ONE object (docs/audit-object-search-design.md): the user
 * picks a kind (Queue, User, …) and then the object from a list of that kind,
 * or pastes an id. The query is the normal pull for the range; the results
 * are then kept only where the id appears anywhere in the entry bar the
 * actor fields. Genesys's own EntityId filter is not used — it demands an
 * EntityType, and one object is audited under several.
 *
 * Times: the date/time inputs are LOCAL time (the table shows local time too);
 * intervals are converted to UTC ISO strings for the API.
 */
import { escapeHtml, formatDateTime, exportXlsx, timestampedFilename, makeStatus } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { createSingleSelect } from "../../components/multiSelect.js";

// ── Constants ────────────────────────────────────────────────────────

const CHUNK_DAYS          = 30;
const REALTIME_CHUNK_DAYS = 1;  // realtime endpoint times out on multi-day intervals
const REALTIME_WINDOW_MS  = 14 * 86_400_000;
const QUERY_CONCURRENCY   = 3;  // realtime jobs in flight at once — 6 drew 429s on an 8-day, 46-service run
const RETRY_PAUSE_MS      = 8_000; // breather before the second pass over rate-limited jobs
const LOOKUP_CONCURRENCY  = 6;  // name-resolution GETs in flight at once

// ── Helpers ──────────────────────────────────────────────────────────

/** Local date as YYYY-MM-DD (the date inputs are local time). */
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local date N days ago as YYYY-MM-DD. */
function daysAgoLocalStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateStr(d);
}

/** Parse a local date + "HH:MM" into a Date. */
function localDateTime(date, time) {
  return new Date(`${date}T${time}:00`);
}

/**
 * Split a [from, to] local date+time range into chunkDays-day ISO 8601
 * interval strings (UTC).
 */
function buildIntervalChunks(from, fromTime, to, toTime, chunkDays = CHUNK_DAYS) {
  const start = localDateTime(from, fromTime);
  const end   = localDateTime(to, toTime);
  end.setSeconds(59, 999);
  const chunks = [];
  let cursor = start;

  while (cursor < end) {
    const chunkEnd = new Date(Math.min(
      cursor.getTime() + chunkDays * 86_400_000 - 1,
      end.getTime(),
    ));
    chunks.push(`${cursor.toISOString()}/${chunkEnd.toISOString()}`);
    cursor = new Date(chunkEnd.getTime() + 1);
  }

  return chunks;
}

/** Does the realtime endpoint still hold audits from this start time? */
function withinRealtimeWindow(from, fromTime) {
  return localDateTime(from, fromTime).getTime() >= Date.now() - REALTIME_WINDOW_MS;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Resolves to an
 * allSettled-style array in input order.
 */
async function runLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { status: "fulfilled", value: await fn(items[i], i) }; }
      catch (reason) { results[i] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Extract a friendly message from an API error. */
function friendlyError(err) {
  const msg = err?.message || String(err);
  if (err?.status === 403 || msg.includes("403")) return "Permission denied";
  if (err?.status === 404 || msg.includes("404")) return "Not found";
  if (err?.status === 429 || msg.includes("429")) return "Rate limited — try again shortly";
  return msg;
}

/** Does this error say Genesys wants a serviceName on the query? */
function isServiceRequiredError(err) {
  if (err?.status !== 400) return false;
  const text = `${err.message || ""} ${JSON.stringify(err.body || {})}`.toLowerCase();
  return text.includes("service");
}

// ── Page renderer ─────────────────────────────────────────────────────

export default function renderAuditSearch({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Audit — Search</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above to get started.</p>`;
    return el;
  }

  // ── Module state ─────────────────────────────────────────────────
  const orgId = orgContext.get();
  let serviceMapping         = null;  // async service mapping
  let realtimeServiceMapping = null;  // realtime service mapping (≤14 days)
  let realtimeServiceNames   = new Set(); // service names supported by realtime API
  let allResults     = [];     // all fetched audit entries, sorted latest-first
  let filteredRows   = [];     // current filtered view (subset of allResults)
  let actorMap       = {};     // { userId → displayName } for users expand did not name
  let clientMap      = {};     // { clientId → OAuth client name }
  let nameCache      = {};     // { guid → name } for entities and the GUIDs inside values
  let failures       = [];     // [{ label, message }] queries that returned nothing
  let isRunning      = false;
  let currentPage    = 1;
  let pageSize       = 50;

  // ── Build skeleton UI ────────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Audit — Search</h1>
    <hr class="hr">
    <p class="page-desc">
      The last 14 days query all supported services automatically.
      Older ranges use the standard audit query, which is slower; pick a service to narrow it.
      Times are local.
    </p>

    <!-- Preset quick filters -->
    <div class="aq-presets">
      <button class="btn aq-preset-btn" data-preset="today">Today</button>
      <button class="btn aq-preset-btn" data-preset="yesterday">Yesterday</button>
      <button class="btn aq-preset-btn" data-preset="7d">Last 7 days</button>
      <button class="btn aq-preset-btn" data-preset="30d">Last 30 days</button>
      <button class="btn aq-preset-btn" data-preset="90d">Last 3 months</button>
    </div>

    <!-- Zone 1: Required query inputs -->
    <div class="di-controls">
      <div class="di-control-group">
        <label class="di-label" for="aqDateFrom">Date From</label>
        <input type="date" class="input di-date" id="aqDateFrom">
        <input type="time" class="input aq-time" id="aqTimeFrom" value="00:00">
      </div>
      <div class="di-control-group">
        <label class="di-label" for="aqDateTo">Date To</label>
        <input type="date" class="input di-date" id="aqDateTo">
        <input type="time" class="input aq-time" id="aqTimeTo" value="23:59">
      </div>
      <div class="di-control-group aq-service-group">
        <label class="di-label">Service</label>
        <div id="aqServiceDropdown" class="aq-service-dropdown">
          <span class="di-status"><span class="spin spin--sm" aria-hidden="true"></span> Loading services…</span>
        </div>
        <p class="aq-service-hint" id="aqServiceHint"></p>
      </div>
      <div class="di-control-group aq-kind-group">
        <label class="di-label">Object (optional)</label>
        <div id="aqKindDropdown"></div>
        <p class="aq-service-hint aq-service-hint--info" id="aqKindHint">Everything that mentions one queue, user, flow, …</p>
      </div>
      <div class="di-control-group aq-object-group" id="aqObjectGroup" hidden>
        <label class="di-label">Which one</label>
        <div id="aqObjectDropdown"></div>
        <p class="aq-service-hint" id="aqObjectHint"></p>
      </div>
      <div class="di-control-group" style="justify-content:flex-end;padding-top:20px">
        <button class="btn" id="aqSearchBtn" disabled>Search</button>
      </div>
    </div>
    <div class="aq-id-row">
      <button type="button" class="aq-link" id="aqToggleId">…or paste an id</button>
      <span id="aqIdWrap" hidden>
        <input type="text" class="input aq-entity-id" id="aqEntityId" placeholder="GUID of an object — also one that no longer exists" spellcheck="false">
        <span class="aq-service-hint aq-service-hint--info" id="aqIdHint"></span>
      </span>
    </div>
    <p class="aq-object-note" id="aqObjectNote" hidden>
      Searching for one object reads every audit in the date range and keeps the ones that mention it,
      so a long range can take several minutes. Narrow the dates above if you know roughly when the change happened.
    </p>

    <!-- Status + progress -->
    <div class="di-status" id="aqStatus"></div>
    <div class="di-progress-wrap" id="aqProgressWrap" style="display:none">
      <div class="di-progress-bar" id="aqProgressBar"></div>
    </div>
    <details class="aq-failures" id="aqFailures" hidden>
      <summary class="aq-failures-summary" id="aqFailuresSummary"></summary>
      <ul class="aq-failures-list" id="aqFailuresList"></ul>
    </details>

    <!-- Zone 2: Filters + results (hidden until first search completes) -->
    <div id="aqResultsZone" style="display:none">

      <h3 class="aq-zone-title">Filter these results</h3>
      <div class="di-controls">
        <div class="di-control-group">
          <label class="di-label">Entity Type</label>
          <div id="aqEntityTypeDropdown"></div>
        </div>
        <div class="di-control-group">
          <label class="di-label">Action</label>
          <div id="aqActionDropdown"></div>
        </div>
        <div class="di-control-group">
          <label class="di-label">Changed By</label>
          <div id="aqChangedByDropdown"></div>
        </div>
        <div class="di-control-group">
          <label class="di-label">Status</label>
          <div id="aqStatusDropdown"></div>
        </div>
        <div class="di-control-group" style="margin-left:auto;justify-content:flex-end;padding-top:20px">
          <button class="btn" id="aqExportBtn" disabled>Export to Excel</button>
        </div>
      </div>

      <p class="di-status" id="aqResultCount"></p>

      <div class="aq-table-wrap">
        <table class="data-table aq-table">
          <thead>
            <tr>
              <th>Date &amp; Time</th>
              <th>Service</th>
              <th>Entity Type</th>
              <th>Entity Name</th>
              <th>Action</th>
              <th>Changed By</th>
              <th style="width:60px" title="Click to expand changes">Details</th>
            </tr>
          </thead>
          <tbody id="aqTableBody"></tbody>
        </table>
      </div>

      <!-- Pagination controls -->
      <div class="aq-pagination" id="aqPagination">
        <button class="btn aq-page-btn" id="aqPrevBtn">&#8592; Prev</button>
        <span class="aq-page-info" id="aqPageInfo"></span>
        <button class="btn aq-page-btn" id="aqNextBtn">Next &#8594;</button>
        <div class="aq-page-size-group">
          <label class="di-label" for="aqPageSize">Rows per page</label>
          <select class="input aq-page-size-sel" id="aqPageSize">
            <option value="50" selected>50</option>
            <option value="100">100</option>
            <option value="150">150</option>
            <option value="200">200</option>
          </select>
        </div>
      </div>

    </div>
  `;

  // ── DOM refs ─────────────────────────────────────────────────────
  const $dateFrom     = el.querySelector("#aqDateFrom");
  const $timeFrom     = el.querySelector("#aqTimeFrom");
  const $dateTo       = el.querySelector("#aqDateTo");
  const $timeTo       = el.querySelector("#aqTimeTo");
  const $serviceDrop  = el.querySelector("#aqServiceDropdown");
  const $serviceHint  = el.querySelector("#aqServiceHint");
  const $entityId     = el.querySelector("#aqEntityId");
  const $idWrap       = el.querySelector("#aqIdWrap");
  const $idHint       = el.querySelector("#aqIdHint");
  const $toggleId     = el.querySelector("#aqToggleId");
  const $kindHint     = el.querySelector("#aqKindHint");
  const $objectGroup  = el.querySelector("#aqObjectGroup");
  const $objectHint   = el.querySelector("#aqObjectHint");
  const $objectNote   = el.querySelector("#aqObjectNote");
  const $searchBtn    = el.querySelector("#aqSearchBtn");
  const $status       = el.querySelector("#aqStatus");
  const $progressWrap = el.querySelector("#aqProgressWrap");
  const $progressBar  = el.querySelector("#aqProgressBar");
  const $failures     = el.querySelector("#aqFailures");
  const $failuresSum  = el.querySelector("#aqFailuresSummary");
  const $failuresList = el.querySelector("#aqFailuresList");
  const $resultsZone  = el.querySelector("#aqResultsZone");
  const $resultCount  = el.querySelector("#aqResultCount");
  const $tableBody    = el.querySelector("#aqTableBody");
  const $prevBtn      = el.querySelector("#aqPrevBtn");
  const $nextBtn      = el.querySelector("#aqNextBtn");
  const $pageInfo     = el.querySelector("#aqPageInfo");
  const $pageSizeSel  = el.querySelector("#aqPageSize");
  const $exportBtn    = el.querySelector("#aqExportBtn");

  // ── Date defaults ────────────────────────────────────────────────
  const today   = localDateStr();
  const minDate = daysAgoLocalStr(365);

  $dateFrom.value = today;   // default to today, matching Genesys UI behaviour
  $dateTo.value   = today;
  $dateFrom.min   = minDate;
  $dateFrom.max   = today;
  $dateTo.min     = minDate;
  $dateTo.max     = today;

  // ── Object kinds ─────────────────────────────────────────────────
  // What the Object picker offers, in plain words, and how to list each.
  // Every loader returns [{ id, name }] and is cached per org for the page's
  // lifetime. A kind with no list endpoint (recordings, evaluations, tokens)
  // is not here — the pasted-id route covers those.
  const pages = (path, query) => (a, o) => gc.fetchAllPages(a, o, path, query ? { query } : {});
  const KINDS = [
    ["User",                 (a, o) => gc.fetchAllUsers(a, o, { state: "any" })],
    ["Queue",                gc.fetchAllQueues],
    ["Flow",                 (a, o) => gc.fetchAllFlows(a, o, { query: { deleted: "true" } })],
    ["Role",                 gc.fetchAllAuthorizationRoles],
    ["Division",             gc.fetchAllDivisions],
    ["Group",                gc.fetchAllGroups],
    ["Team",                 gc.fetchAllTeams],
    ["Skill",                gc.fetchAllSkills],
    ["Skill group",          gc.fetchAllSkillGroups],
    ["Language",             gc.fetchAllLanguages],
    ["Wrap-up code",         gc.fetchAllWrapupCodes],
    ["Data table",           gc.fetchAllDataTables],
    ["Data action",          gc.fetchAllDataActions],
    ["Integration",          gc.fetchAllIntegrations],
    ["OAuth client",         pages("/api/v2/oauth/clients")],
    ["Schedule",             gc.fetchAllSchedules],
    ["Schedule group",       gc.fetchAllScheduleGroups],
    ["Emergency group",      gc.fetchAllEmergencyGroups],
    ["IVR (call route)",     pages("/api/v2/architect/ivrs")],
    ["Prompt",               pages("/api/v2/architect/prompts")],
    ["Site",                 gc.fetchAllSites],
    ["Location",             gc.fetchAllLocations],
    ["Phone",                gc.fetchAllPhones],
    ["Phone base settings",  gc.fetchAllPhoneBaseSettings],
    ["Trunk base settings",  gc.fetchAllTrunkBaseSettings],
    ["Edge",                 pages("/api/v2/telephony/providers/edges")],
    ["DID pool",             gc.fetchAllDidPools],
    ["Extension pool",       gc.fetchAllExtensionPools],
    ["Campaign",             gc.fetchAllCampaigns],
    ["Contact list",         gc.fetchAllContactLists],
    ["DNC list",             gc.fetchAllDncLists],
    ["Evaluation form",      gc.fetchAllEvaluationForms],
    ["Response library",     gc.fetchAllLibraries],
    ["Knowledge base",       pages("/api/v2/knowledge/knowledgebases")],
    ["Trigger",              pages("/api/v2/processautomation/triggers")],
    ["Web deployment",       pages("/api/v2/webdeployments/deployments")],
    ["Business unit (WFM)",  gc.fetchAllBusinessUnits],
    ["Management unit (WFM)", gc.fetchAllManagementUnits],
  ];
  const kindCache = {};   // kind label → [{ id, label }]
  let   pastedName = "";  // name to show for a pasted id, when a row gave us one

  // ── Single-select dropdowns ──────────────────────────────────────
  const ssKind       = createSingleSelect({ placeholder: "— Any object —",       searchable: true,  onChange: onKindChange });
  const ssObject     = createSingleSelect({ placeholder: "— Pick one —",         searchable: true,  onChange: onObjectChange });
  const ssService    = createSingleSelect({ placeholder: "— All services —",    searchable: true,  onChange: () => updateServiceMode() });
  const ssEntityType = createSingleSelect({ placeholder: "All entity types",     searchable: false, onChange: onEntityTypeChange });
  const ssAction     = createSingleSelect({ placeholder: "All actions",          searchable: false, onChange: () => applyFilters() });
  const ssChangedBy  = createSingleSelect({ placeholder: "All users",            searchable: true,  onChange: () => applyFilters() });
  const ssStatus     = createSingleSelect({ placeholder: "All statuses",         searchable: false, onChange: () => applyFilters() });

  // Replace the "Loading services…" placeholder with the real dropdown
  $serviceDrop.innerHTML = "";
  $serviceDrop.append(ssService.el);
  el.querySelector("#aqKindDropdown").append(ssKind.el);
  el.querySelector("#aqObjectDropdown").append(ssObject.el);
  ssKind.setItems(KINDS.map(([label]) => ({ id: label, label })).sort((a, b) => a.label.localeCompare(b.label)));

  $toggleId.addEventListener("click", () => {
    $idWrap.hidden = !$idWrap.hidden;
    if (!$idWrap.hidden) $entityId.focus();
  });
  $entityId.addEventListener("input", () => {
    pastedName = ""; $idHint.textContent = "";
    $objectNote.hidden = !$entityId.value.trim() && !ssObject.getValue();
  });

  el.querySelector("#aqEntityTypeDropdown").append(ssEntityType.el);
  el.querySelector("#aqActionDropdown").append(ssAction.el);
  el.querySelector("#aqChangedByDropdown").append(ssChangedBy.el);
  el.querySelector("#aqStatusDropdown").append(ssStatus.el);

  // Client-side filters start disabled (no results yet)
  ssEntityType.setEnabled(false);
  ssAction.setEnabled(false);
  ssChangedBy.setEnabled(false);
  ssStatus.setEnabled(false);
  updateServiceMode(); // set initial hint (needs ssService)

  // ── Status / progress helpers ────────────────────────────────────
  const setStatus = makeStatus($status, "di-status");

  // ── Object picker ────────────────────────────────────────────────
  async function onKindChange(kind) {
    ssObject.setValue("");
    $objectHint.textContent = "";
    $objectNote.hidden = !$entityId.value.trim();
    if (!kind) { $objectGroup.hidden = true; return; }
    $objectGroup.hidden = false;
    if (!kindCache[kind]) {
      ssObject.setItems([]);
      ssObject.setEnabled(false);
      $objectHint.textContent = `Loading ${kind} list…`;
      $objectHint.className   = "aq-service-hint aq-service-hint--info";
      try {
        const loader = KINDS.find(([label]) => label === kind)[1];
        const rows = await loader(api, orgId);
        kindCache[kind] = (rows || [])
          .filter(r => r?.id)
          .map(r => ({ id: r.id, label: r.name || r.displayName || r.id }))
          .sort((a, b) => a.label.localeCompare(b.label));
        $objectHint.textContent = `${kindCache[kind].length} to choose from`;
      } catch (err) {
        $objectHint.textContent = `Could not load ${kind} list: ${friendlyError(err)}`;
        $objectHint.className   = "aq-service-hint aq-service-hint--warn";
        return;
      }
      if (ssKind.getValue() !== kind) return; // user moved on while loading
    }
    ssObject.setItems(kindCache[kind]);
    ssObject.setEnabled(true);
    $objectHint.textContent = `${kindCache[kind].length} to choose from`;
    $objectHint.className   = "aq-service-hint aq-service-hint--info";
  }

  function onObjectChange(id) {
    $objectNote.hidden = !id && !$entityId.value.trim();
    if (!id) return;
    // A picked object supersedes a pasted id.
    $entityId.value = "";
    pastedName = "";
    $idHint.textContent = "";
  }

  /** What the search is about: { id, name } or null for a plain range search. */
  function searchTarget() {
    const picked = ssObject.getValue();
    if (picked) {
      const item = (kindCache[ssKind.getValue()] || []).find(i => i.id === picked);
      return { id: picked, name: item?.label || picked };
    }
    const pasted = $entityId.value.trim();
    if (pasted) return { id: pasted, name: pastedName || "" };
    return null;
  }

  /**
   * Does this audit mention the id anywhere that is ABOUT the object —
   * entity, composite names, property and entity changes, context, message —
   * as opposed to who did it (user, client) or the audit's own ids?
   */
  function mentionsId(entry, id) {
    const { id: _own, user, client, userHomeOrgId, remoteIp, initiatingAction, ...about } = entry;
    return JSON.stringify(about).toLowerCase().includes(id.toLowerCase());
  }

  /** Run the object search for an entity seen in a row. */
  function searchHistoryOf(entry) {
    const id = entry.entity?.id;
    if (!id) return;
    ssKind.setValue("");
    ssObject.setValue("");
    $objectGroup.hidden = true;
    $idWrap.hidden = false;
    $entityId.value = id;
    $objectNote.hidden = false;
    pastedName = getEntityName(entry) !== id ? getEntityName(entry) : "";
    $idHint.textContent = pastedName ? `= ${pastedName}` : "";
    window.scrollTo({ top: 0, behavior: "smooth" });
    runSearch();
  }

  function showProgress(pct) {
    $progressWrap.style.display = "";
    $progressBar.style.width    = `${Math.min(100, pct)}%`;
  }

  function hideProgress() {
    $progressWrap.style.display = "none";
    $progressBar.style.width    = "0%";
  }

  function renderFailures() {
    if (!failures.length) { $failures.hidden = true; $failures.open = false; return; }
    $failuresSum.textContent = `${failures.length} quer${failures.length === 1 ? "y" : "ies"} returned nothing — show which`;
    $failuresList.innerHTML = failures.map(f =>
      `<li><strong>${escapeHtml(f.label)}</strong> — ${escapeHtml(f.message)}</li>`).join("");
    $failures.hidden = false;
  }

  // ── Load service mappings on mount (both async + realtime in parallel) ──
  async function loadServiceMapping() {
    setStatus("Loading service mapping…");
    try {
      [serviceMapping, realtimeServiceMapping] = await Promise.all([
        gc.fetchAuditServiceMapping(api, orgId),
        gc.fetchRealtimeAuditServiceMapping(api, orgId).catch(() => null), // non-fatal
      ]);
      realtimeServiceNames = new Set(
        (realtimeServiceMapping?.services || []).map(s => s.name)
      );
      const services = (serviceMapping.services || [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(s => ({ id: s.name, label: s.name }));
      ssService.setItems(services);
      $searchBtn.disabled = false;
      setStatus("");
      // Always auto-run today in allMode (no service pre-selected)
      el.querySelector('[data-preset="today"]')?.classList.add("aq-preset-btn--active");
      updateServiceMode();
      runSearch();
    } catch (err) {
      setStatus(`Failed to load service mapping: ${friendlyError(err)}`, "error");
    }
  }

  loadServiceMapping();

  // ── Service mode hint ────────────────────────────────────────────
  function updateServiceMode() {
    const from    = $dateFrom.value;
    const service = ssService.getValue();
    if (!from) { $serviceHint.textContent = ""; return; }
    if (withinRealtimeWindow(from, $timeFrom.value || "00:00")) {
      if (service && realtimeServiceNames.size && !realtimeServiceNames.has(service)) {
        $serviceHint.textContent = `${service} is not in the realtime set — the standard query will be used.`;
        $serviceHint.className   = "aq-service-hint aq-service-hint--info";
      } else {
        $serviceHint.textContent = "Last 14 days — all supported services shown; select one to narrow.";
        $serviceHint.className   = "aq-service-hint aq-service-hint--info";
      }
    } else {
      $serviceHint.textContent = service
        ? "Older than 14 days — standard query, fetched in 30-day chunks."
        : "Older than 14 days — standard query across all services, in 30-day chunks. Select one to narrow.";
      $serviceHint.className   = "aq-service-hint aq-service-hint--warn";
    }
  }

  // ── Preset quick-filter buttons ──────────────────────────────────
  el.querySelectorAll(".aq-preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.preset;
      $dateTo.value   = localDateStr();
      $timeTo.value   = "23:59";
      $timeFrom.value = "00:00";
      if (preset === "today")     $dateFrom.value = localDateStr();
      else if (preset === "yesterday") { $dateFrom.value = daysAgoLocalStr(1); $dateTo.value = daysAgoLocalStr(1); }
      else if (preset === "7d")   $dateFrom.value = daysAgoLocalStr(7);
      else if (preset === "30d")  $dateFrom.value = daysAgoLocalStr(30);
      else if (preset === "90d")  $dateFrom.value = daysAgoLocalStr(90);
      // Highlight active preset
      el.querySelectorAll(".aq-preset-btn").forEach(b => b.classList.remove("aq-preset-btn--active"));
      btn.classList.add("aq-preset-btn--active");
      updateServiceMode();
      // A preset only sets the dates; the user presses Search. Only the
      // page's first load runs on its own (Today, in loadServiceMapping).
    });
  });

  // ── Search ───────────────────────────────────────────────────────
  // Deactivate preset highlight when user edits dates manually
  [$dateFrom, $dateTo, $timeFrom, $timeTo].forEach(input =>
    input.addEventListener("change", () => {
      el.querySelectorAll(".aq-preset-btn").forEach(b => b.classList.remove("aq-preset-btn--active"));
      updateServiceMode();
    })
  );

  $searchBtn.addEventListener("click", () => runSearch());
  $entityId.addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); });

  async function runSearch() {
    if (isRunning) return;

    const from     = $dateFrom.value;
    const fromTime = $timeFrom.value || "00:00";
    const to       = $dateTo.value;
    const toTime   = $timeTo.value   || "23:59";
    const service  = ssService.getValue();
    const target   = searchTarget();
    const filters  = undefined; // EntityId is unusable without EntityType — see header

    if (!from) return setStatus("Please select a Date From.", "error");
    if (!to)   return setStatus("Please select a Date To.", "error");
    if (localDateTime(from, fromTime) > localDateTime(to, toTime))
      return setStatus("Date/time From must be before Date/time To.", "error");

    const realtime = withinRealtimeWindow(from, fromTime)
      && realtimeServiceNames.size > 0
      && (!service || realtimeServiceNames.has(service));
    const allMode  = !service;

    if (service) localStorage.setItem("aq-last-service", service);

    isRunning = true;
    $searchBtn.disabled = true;
    allResults    = [];
    actorMap      = {};
    clientMap     = {};
    nameCache     = {};
    failures      = [];
    renderFailures();
    $tableBody.innerHTML = "";
    $resultsZone.style.display = "none";

    ssEntityType.setValue("");
    ssEntityType.setEnabled(false);
    ssAction.setValue("");
    ssAction.setItems([]);
    ssAction.setEnabled(false);
    ssChangedBy.setValue("");
    ssChangedBy.setEnabled(false);
    ssStatus.setValue("");
    ssStatus.setEnabled(false);

    let totalJobs = 0;
    try {
      if (realtime) {
        // ── Realtime: one job per (service, day); a bounded number in flight ──
        const svcList = allMode ? [...realtimeServiceNames].sort() : [service];
        const chunks  = buildIntervalChunks(from, fromTime, to, toTime, REALTIME_CHUNK_DAYS);
        const jobs    = [];
        for (const interval of chunks)
          for (const svcName of svcList) jobs.push({ interval, svcName });
        totalJobs = jobs.length;

        let done = 0;
        setStatus(`Querying ${svcList.length} service${svcList.length !== 1 ? "s" : ""} over ${chunks.length} day${chunks.length !== 1 ? "s" : ""} (realtime)…`);
        showProgress(5);

        const runJob = async ({ interval, svcName }) => {
          const entries = await gc.submitRealtimeAuditQuery(api, orgId, { interval, serviceName: svcName, filters });
          done++;
          setStatus(`Realtime: ${done} of ${totalJobs} queries done (${allResults.length + entries.length} entries)…`);
          showProgress(5 + (done / totalJobs) * 80);
          allResults.push(...entries);
          return entries.length;
        };
        const settled = await runLimited(jobs, QUERY_CONCURRENCY, runJob);

        // Anything Genesys rate-limited past withRateLimitRetry's own attempts
        // gets one more pass after a pause, one job at a time. Only 429s —
        // a 403 or a 400 will not improve by waiting.
        const rateLimited = [];
        settled.forEach((r, i) => {
          if (r.status !== "rejected") return;
          if (r.reason?.status === 429) rateLimited.push(jobs[i]);
          else failures.push({ label: `${jobs[i].svcName} ${jobs[i].interval.slice(0, 10)}`, message: friendlyError(r.reason) });
        });
        if (rateLimited.length) {
          setStatus(`Rate limited on ${rateLimited.length} queries — pausing, then retrying them one at a time…`);
          await new Promise(r => setTimeout(r, RETRY_PAUSE_MS));
          const again = await runLimited(rateLimited, 1, runJob);
          again.forEach((r, i) => {
            if (r.status === "rejected")
              failures.push({ label: `${rateLimited[i].svcName} ${rateLimited[i].interval.slice(0, 10)}`, message: friendlyError(r.reason) });
          });
        }

      } else {
        // ── Async: older than 14 days, or service not in realtime mapping ─
        if (withinRealtimeWindow(from, fromTime)) setStatus(`${service} not in realtime mapping — using standard query…`);
        totalJobs = await runAsyncQuery(service, from, fromTime, to, toTime, filters);
      }

      if (target) {
        const before = allResults.length;
        allResults = allResults.filter(e => mentionsId(e, target.id));
        console.debug(`Object search: ${allResults.length} of ${before} audits mention ${target.id}`);
      }

      showProgress(90);
      setStatus("Resolving names…");
      await resolveActors();
      await resolveClients();
      await resolveEntities();

      allResults.sort((a, b) => {
        const ta = new Date(a.eventDate || a.createdDate || 0).getTime();
        const tb = new Date(b.eventDate || b.createdDate || 0).getTime();
        return tb - ta;
      });

      showProgress(100);
      hideProgress();
      const n = allResults.length;
      if (target && !target.name) {
        // A pasted id: let its own audits name it.
        const named = allResults.map(getEntityName).find(nm => nm && nm !== target.id && !nm.includes(target.id));
        if (named) { target.name = named; pastedName = named; $idHint.textContent = `= ${named}`; }
      }
      const found = target
        ? `${n} audit${n !== 1 ? "s" : ""} mention${n === 1 ? "s" : ""} ${target.name ? `“${target.name}”` : "that id"}`
        : `${n} result${n !== 1 ? "s" : ""} found`;
      if (failures.length) {
        setStatus(`Done — ${found}, but results are incomplete: ${failures.length} of ${totalJobs} queries failed (${failures[0].message}).`, "warn");
      } else {
        setStatus(`Done — ${found}.`, "success");
      }
      renderFailures();

      populateClientFilters();
      currentPage = 1;
      applyFilters();
      $resultsZone.style.display = "";

    } catch (err) {
      hideProgress();
      if (isServiceRequiredError(err)) {
        setStatus("Genesys requires a service for this query — select one and search again.", "error");
      } else {
        setStatus(`Error: ${friendlyError(err)}`, "error");
      }
    } finally {
      isRunning = false;
      $searchBtn.disabled = false;
    }
  }

  /**
   * Chunked async query (older than 14 days, or realtime-unsupported service).
   * Returns the number of chunks attempted. A 400 that names the service on the
   * FIRST chunk is thrown so the caller can ask for a service; any other chunk
   * failure is recorded and the run continues.
   */
  async function runAsyncQuery(service, from, fromTime, to, toTime, filters) {
    const chunks = buildIntervalChunks(from, fromTime, to, toTime);
    const total  = chunks.length;
    const label  = service || "all services";
    const runChunk = async (interval, i) => {
      const body = { interval, filters };
      if (service) body.serviceName = service;
      const txId = await gc.submitAuditQuery(api, orgId, body);
      await gc.pollAuditQuery(api, orgId, txId, {
        onPoll: (elapsed, state) =>
          setStatus(`Interval ${i + 1} of ${total}: ${(state || "waiting").toLowerCase()} (${Math.round(elapsed)}s)…`),
      });
      const entries = await gc.fetchAuditQueryResults(api, orgId, txId, {
        onProgress: (n) => setStatus(`Interval ${i + 1} of ${total}: fetching… (${n} so far)`),
      });
      allResults.push(...entries);
    };

    const rateLimited = [];
    for (let i = 0; i < chunks.length; i++) {
      const interval = chunks[i];
      setStatus(`Fetching interval ${i + 1} of ${total} (${label})…`);
      showProgress(5 + (i / total) * 80);
      try {
        await runChunk(interval, i);
      } catch (err) {
        if (i === 0 && !service && isServiceRequiredError(err)) throw err;
        if (err?.status === 429) rateLimited.push(i);
        else failures.push({ label: `${label} ${interval.slice(0, 10)}`, message: friendlyError(err) });
      }
    }
    // The audit-job limit clears with time, not retries: give it a breather
    // and take the rate-limited chunks again, one by one.
    if (rateLimited.length) {
      setStatus(`Rate limited on ${rateLimited.length} interval${rateLimited.length !== 1 ? "s" : ""} — pausing, then retrying…`);
      await new Promise(r => setTimeout(r, RETRY_PAUSE_MS));
      for (const i of rateLimited) {
        try { await runChunk(chunks[i], i); }
        catch (err) { failures.push({ label: `${label} ${chunks[i].slice(0, 10)}`, message: friendlyError(err) }); }
      }
    }
    return total;
  }

  // ── Name resolution ──────────────────────────────────────────────
  // Genesys audits refer to almost everything by GUID: the entity, the
  // actor, and the old/new values of any property that points at another
  // object. Every GUID that can be turned into a name is, through the one
  // cache below (id → name | null while in flight).
  //
  // Paths are keyed on the ENTITY TYPE alone: the same type appears under
  // several services (Queue under ContactCenter and Routing, Schedule under
  // Architect and Telephony) and the resource behind it is the same. The
  // few cases where the service changes the meaning are overridden by
  // "Service/Type" in SERVICE_TYPE_PATH.
  const TYPE_PATH = {
    // People
    User:                  id => `/api/v2/users/${id}`,
    AuthUser:              id => `/api/v2/users/${id}`,
    UserPresence:          id => `/api/v2/users/${id}`,   // entity id is the user
    Agent:                 id => `/api/v2/users/${id}`,
    Station:               id => `/api/v2/stations/${id}`,
    Location:              id => `/api/v2/locations/${id}`,
    Role:                  id => `/api/v2/authorization/roles/${id}`,
    Division:              id => `/api/v2/authorization/divisions/${id}`,
    OAuthClient:           id => `/api/v2/oauth/clients/${id}`,
    Group:                 id => `/api/v2/groups/${id}`,
    DirectoryGroup:        id => `/api/v2/groups/${id}`,
    Team:                  id => `/api/v2/teams/${id}`,
    SkillGroup:            id => `/api/v2/routing/skillgroups/${id}`,
    // Routing
    Queue:                 id => `/api/v2/routing/queues/${id}`,
    AssistantQueue:        id => `/api/v2/routing/queues/${id}`,   // Agent Copilot binding; entity id is the queue
    Skill:                 id => `/api/v2/routing/skills/${id}`,
    RoutingSkill:          id => `/api/v2/routing/skills/${id}`,
    Language:              id => `/api/v2/routing/languages/${id}`,
    RoutingLanguage:       id => `/api/v2/routing/languages/${id}`,
    WrapupCode:            id => `/api/v2/routing/wrapupcodes/${id}`,
    WrapUpCode:            id => `/api/v2/routing/wrapupcodes/${id}`,
    UtilizationLabel:      id => `/api/v2/routing/utilization/labels/${id}`,
    EmailDomain:           id => `/api/v2/routing/email/domains/${id}`,
    Predictor:             id => `/api/v2/routing/predictors/${id}`,
    // Architect
    Flow:                  id => `/api/v2/flows/${id}`,
    Prompt:                id => `/api/v2/architect/prompts/${id}`,
    UserPrompt:            id => `/api/v2/architect/prompts/${id}`,
    SystemPrompt:          id => `/api/v2/architect/systemprompts/${id}`,
    IVR:                   id => `/api/v2/architect/ivrs/${id}`,
    Schedule:              id => `/api/v2/architect/schedules/${id}`,
    ScheduleGroup:         id => `/api/v2/architect/schedulegroups/${id}`,
    EmergencyGroup:        id => `/api/v2/architect/emergencygroups/${id}`,
    FlowOutcome:           id => `/api/v2/flows/outcomes/${id}`,
    FlowMilestone:         id => `/api/v2/flows/milestones/${id}`,
    Datatable:             id => `/api/v2/flows/datatables/${id}`,
    Schema:                id => `/api/v2/flows/datatables/${id}`,
    Trigger:               id => `/api/v2/processautomation/triggers/${id}`,
    // Telephony
    Site:                  id => `/api/v2/telephony/providers/edges/sites/${id}`,
    Trunk:                 id => `/api/v2/telephony/providers/edges/trunks/${id}`,
    TrunkBase:             id => `/api/v2/telephony/providers/edges/trunkbasesettings/${id}`,
    TrunkBaseSettings:     id => `/api/v2/telephony/providers/edges/trunkbasesettings/${id}`,
    Phone:                 id => `/api/v2/telephony/providers/edges/phones/${id}`,
    PhoneBase:             id => `/api/v2/telephony/providers/edges/phonebasesettings/${id}`,
    PhoneBaseSettings:     id => `/api/v2/telephony/providers/edges/phonebasesettings/${id}`,
    Line:                  id => `/api/v2/telephony/providers/edges/lines/${id}`,
    LineBase:              id => `/api/v2/telephony/providers/edges/linebasesettings/${id}`,
    LineBaseSettings:      id => `/api/v2/telephony/providers/edges/linebasesettings/${id}`,
    Edge:                  id => `/api/v2/telephony/providers/edges/${id}`,
    EdgeGroup:             id => `/api/v2/telephony/providers/edges/edgegroups/${id}`,
    DID:                   id => `/api/v2/telephony/providers/edges/dids/${id}`,
    DIDPool:               id => `/api/v2/telephony/providers/edges/didpools/${id}`,
    Extension:             id => `/api/v2/telephony/providers/edges/extensions/${id}`,
    ExtensionPool:         id => `/api/v2/telephony/providers/edges/extensionpools/${id}`,
    OutboundRoute:         id => `/api/v2/telephony/providers/edges/outboundroutes/${id}`,
    // Outbound
    Campaign:              id => `/api/v2/outbound/campaigns/${id}`,
    ContactList:           id => `/api/v2/outbound/contactlists/${id}`,
    ContactListFilter:     id => `/api/v2/outbound/contactlistfilters/${id}`,
    DNCList:               id => `/api/v2/outbound/dnclists/${id}`,
    RuleSet:               id => `/api/v2/outbound/rulesets/${id}`,
    CallableTimeSet:       id => `/api/v2/outbound/callabletimesets/${id}`,
    CampaignSequence:      id => `/api/v2/outbound/sequences/${id}`,
    Sequence:              id => `/api/v2/outbound/sequences/${id}`,
    CampaignRule:          id => `/api/v2/outbound/campaignrules/${id}`,
    AttemptLimits:         id => `/api/v2/outbound/attemptlimits/${id}`,
    ResponseSet:           id => `/api/v2/outbound/callanalysisresponsesets/${id}`,
    // Content
    Response:              id => `/api/v2/responsemanagement/responses/${id}`,
    ResponseLibrary:       id => `/api/v2/responsemanagement/libraries/${id}`,
    Library:               id => `/api/v2/responsemanagement/libraries/${id}`,
    KnowledgeBase:         id => `/api/v2/knowledge/knowledgebases/${id}`,
    // Integrations / deployments
    Integration:           id => `/api/v2/integrations/${id}`,
    Action:                id => `/api/v2/integrations/actions/${id}`,
    DataAction:            id => `/api/v2/integrations/actions/${id}`,
    Deployment:            id => `/api/v2/webdeployments/deployments/${id}`,
    Configuration:         id => `/api/v2/webdeployments/configurations/${id}`,
    // Quality / analytics / WFM / other
    EvaluationForm:        id => `/api/v2/quality/forms/evaluations/${id}`,
    SurveyForm:            id => `/api/v2/quality/forms/surveys/${id}`,
    MediaRetentionPolicy:  id => `/api/v2/recording/mediaretentionpolicies/${id}`,
    RecordingPolicy:       id => `/api/v2/recording/mediaretentionpolicies/${id}`,
    Topic:                 id => `/api/v2/speechandtextanalytics/topics/${id}`,
    Program:               id => `/api/v2/speechandtextanalytics/programs/${id}`,
    BusinessUnit:          id => `/api/v2/workforcemanagement/businessunits/${id}`,
    ManagementUnit:        id => `/api/v2/workforcemanagement/managementunits/${id}`,
    LearningModule:        id => `/api/v2/learning/modules/${id}`,
    Module:                id => `/api/v2/learning/modules/${id}`,
    Appointment:           id => `/api/v2/coaching/appointments/${id}`,
    ExternalContact:       id => `/api/v2/externalcontacts/contacts/${id}`,
    Contact:               id => `/api/v2/externalcontacts/contacts/${id}`,
    ExternalOrganization:  id => `/api/v2/externalcontacts/organizations/${id}`,
    Organization:          id => `/api/v2/externalcontacts/organizations/${id}`,
  };

  // "Service/Type" overrides where the service changes what the id means.
  const SERVICE_TYPE_PATH = {
    "Datatables/Row":          id => `/api/v2/flows/datatables/${id}`,  // id is the parent datatable
    "Messaging/Integration":   id => `/api/v2/messaging/integrations/${id}`,
    "Outbound/Schedule":       null,  // campaign schedules have no name endpoint
  };

  function pathFor(service, type, id) {
    const key = `${service}/${type}`;
    if (key in SERVICE_TYPE_PATH) return SERVICE_TYPE_PATH[key] ? SERVICE_TYPE_PATH[key](id) : null;
    return TYPE_PATH[type] ? TYPE_PATH[type](id) : null;
  }

  // Property name → the type its GUID values point at. Ordered: the first
  // match wins, so the specific ("skillGroup") sits above the general
  // ("group"), and anything naming people ("members", "owner") sits above
  // the object they belong to ("queueMembers" holds users, not queues).
  const PROPERTY_TYPE_HINTS = [
    [/skill.?group/i,                                                "SkillGroup"],
    [/division/i,                                                    "Division"],
    [/member|user|agent|owner|supervisor|manager|createdby|modifiedby|evaluator|reviewer|participant/i, "User"],
    [/wrap.?up/i,                                                    "WrapupCode"],
    [/queue/i,                                                       "Queue"],
    [/skill/i,                                                       "Skill"],
    [/language/i,                                                    "Language"],
    [/role/i,                                                        "Role"],
    [/team/i,                                                        "Team"],
    [/group/i,                                                       "Group"],
    [/site/i,                                                        "Site"],
    [/flow/i,                                                        "Flow"],
    [/schedule.?group/i,                                             "ScheduleGroup"],
    [/schedule/i,                                                    "Schedule"],
    [/prompt/i,                                                      "Prompt"],
    [/location/i,                                                    "Location"],
    [/station/i,                                                     "Station"],
    [/phone.?base/i,                                                 "PhoneBase"],
    [/phone/i,                                                       "Phone"],
    [/trunk.?base/i,                                                 "TrunkBase"],
    [/trunk/i,                                                       "Trunk"],
    [/edge.?group/i,                                                 "EdgeGroup"],
    [/edge/i,                                                        "Edge"],
    [/campaign/i,                                                    "Campaign"],
    [/contact.?list/i,                                               "ContactList"],
    [/integration/i,                                                 "Integration"],
    [/data.?action|action.?id/i,                                     "Action"],
    [/knowledge/i,                                                   "KnowledgeBase"],
    [/evaluation.?form|form.?id/i,                                   "EvaluationForm"],
    [/topic/i,                                                       "Topic"],
    [/program/i,                                                     "Program"],
    [/business.?unit/i,                                              "BusinessUnit"],
    [/management.?unit/i,                                            "ManagementUnit"],
    [/client/i,                                                      "OAuthClient"],
  ];

  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const GUID_G  = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  /** Type a property's GUID values point at, or null when nothing in the name says. */
  function hintedType(property) {
    const name = String(property || "");
    for (const [re, type] of PROPERTY_TYPE_HINTS) if (re.test(name)) return type;
    return null;
  }

  /**
   * Every GUID reference an entry makes in its values: property changes and
   * entity changes. Returns [{ type, id }] (type may be null for an entity
   * change with no entityType).
   */
  function valueRefs(entry) {
    const refs = [];
    for (const p of (entry.propertyChanges || [])) {
      const type = hintedType(p.property);
      if (!type) continue;
      // GUIDs may sit in the property name itself ("QueueMember/<queue>:<user>:joined")
      // or anywhere inside a value, not only as the whole value.
      const texts = [String(p.property ?? ""), ...[].concat(p.oldValues ?? [], p.newValues ?? []).map(String)];
      for (const t of texts) for (const g of t.match(GUID_G) || []) refs.push({ type, id: g });
    }
    for (const { k, v } of contextPairs(entry)) {
      const type = hintedType(k);
      if (type && GUID_RE.test(v)) refs.push({ type, id: v });
    }
    for (const c of (entry.entityChanges || [])) {
      if (c.entityId && !c.entityName && GUID_RE.test(c.entityId))
        refs.push({ type: c.entityType || null, id: c.entityId });
      for (const v of [].concat(c.oldValues ?? [], c.newValues ?? []))
        if (GUID_RE.test(String(v))) refs.push({ type: c.entityType || null, id: String(v) });
    }
    return refs;
  }

  /**
   * Look up the names for [{ path, id }] not already in nameCache.
   * A 404 is recorded as "(deleted) <id>"; any other failure leaves the id.
   */
  async function resolvePaths(items) {
    const todo = [];
    for (const { path, id, label } of items) {
      if (!path || !id || id in nameCache) continue;
      nameCache[id] = null; // in flight
      todo.push({ path, id, label });
    }
    await runLimited(todo, LOOKUP_CONCURRENCY, async ({ path, id, label }) => {
      try {
        const res = await gc.fetchEntityByPath(api, orgId, path);
        nameCache[id] = (label && label(res)) || res?.name || res?.displayName || id;
      } catch (err) {
        if (err?.status !== 404) { nameCache[id] = id; return; }
        // A deleted user is still readable with state=deleted — the only
        // resource type Genesys keeps after deletion.
        if (/^\/api\/v2\/users\/[^/?]+$/.test(path)) {
          try {
            const res = await gc.fetchEntityByPath(api, orgId, `${path}?state=deleted`);
            if (res?.name) { nameCache[id] = `(deleted) ${res.name}`; return; }
          } catch { /* fall through */ }
        }
        nameCache[id] = `(deleted) ${id}`;
      }
    });
  }

  /**
   * User ids that hide inside an entity NAME rather than the id:
   * ContactCenter/AgentRoutingInfo is "Agent <orgId>:<userId>".
   */
  function embeddedUserId(entry) {
    const m = String(entry.entity?.name ?? "").match(/^Agent [0-9a-f-]{36}:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1] : "";
  }

  /**
   * Genesys-internal name formats made readable. Telephony/DID names a
   * user-owned number "<orgId>+4540153795contactInfo.phone_cell-<rest>":
   * the number and the contact field are the parts a person wants.
   */
  function prettyEntityName(entry, name) {
    const did = name.match(/^[0-9a-f-]{36}\+(\d+)(?:contactInfo\.([a-z_]+))?/i);
    if (did) return `+${did[1]}${did[2] ? ` (${did[2]})` : ""}`;
    const agent = embeddedUserId(entry);
    if (agent) return `Agent ${nameCache[agent] || agent}`;
    return name;
  }

  /** Resolve the GUIDs inside the values of these entries (bounded, cached). */
  async function resolveValueRefs(entries) {
    const items = [];
    for (const entry of entries)
      for (const { type, id } of valueRefs(entry))
        if (type && TYPE_PATH[type]) items.push({ path: TYPE_PATH[type](id), id });
    await resolvePaths(items);
  }

  /**
   * Some audits carry a composite entity id — Role MemberAdd/MemberRemove
   * uses "roleId--subjectId". Split it into its GUID parts; the first is the
   * entity itself, the rest are members (users, or groups).
   */
  function compositeParts(id) {
    if (!id || !id.includes("--")) return null;
    const parts = id.split("--").filter(Boolean);
    return parts.length > 1 && parts.some(p => GUID_RE.test(p)) ? parts : null;
  }

  /**
   * entity.name when it is an actual name. Some audits (Role MemberAdd,
   * for one) put the id — or the whole composite id — in entity.name too,
   * and that must not stop the lookup.
   */
  function realEntityName(entry) {
    const name = String(entry.entity?.name ?? "").trim();
    if (!name || name === entry.entity?.id) return "";
    if (GUID_RE.test(name) || compositeParts(name)) return "";
    return name;
  }

  /** The entity of every result, unless the audit already carries its name. */
  /**
   * Role MemberAdd / MemberRemove: entity.id is the role, and entity.name is
   * Genesys's grant triple "subjectId--roleId--divisionId" ("*" = every
   * division). Seen live 2026-09-16:
   *   entity.id   a698b9e2-…   (the role)
   *   entity.name 786d6179-…--a698b9e2-…--*
   * Returns { subjectId, roleId, divisionId } or null.
   */
  function grantParts(entry) {
    if (!/^Member(Add|Remove)$/i.test(entry.action || "")) return null;
    const parts = compositeParts(String(entry.entity?.name ?? ""));
    if (!parts || parts.length < 2 || !GUID_RE.test(parts[0])) return null;
    return { subjectId: parts[0], roleId: parts[1], divisionId: parts[2] || "" };
  }

  async function resolveEntities() {
    // An audit that names its own entity names that id for every other audit
    // too — AssistantQueue rows carry the queue's id without its name, while
    // the Queue rows beside them carry both.
    for (const entry of allResults) {
      const id = entry.entity?.id;
      const name = realEntityName(entry);
      if (id && name && !grantParts(entry) && !(id in nameCache)) nameCache[id] = name;
    }
    const items = [];
    const members = [];
    for (const entry of allResults) {
      const id = entry.entity?.id;
      if (!id) continue;
      const grant = grantParts(entry);
      const embedded = embeddedUserId(entry);
      if (grant) {
        members.push(grant.subjectId);
        if (GUID_RE.test(grant.divisionId)) items.push({ path: TYPE_PATH.Division(grant.divisionId), id: grant.divisionId });
      } else if (embedded) {
        members.push(embedded);
        continue;
      } else if (realEntityName(entry)) {
        continue;
      }
      const scoped = conversationScoped(entry);
      if (scoped) { items.push(scoped); continue; }
      const path = pathFor(entry.serviceName || "", getEntityType(entry), id);
      if (path) items.push({ path, id });
    }
    await resolvePaths(items);
    // A member is a user or, failing that, a group.
    await resolvePaths(members.map(m => ({ path: TYPE_PATH.User(m), id: m })));
    const notUsers = members.filter(m => nameCache[m] === `(deleted) ${m}`);
    for (const m of notUsers) delete nameCache[m];
    await resolvePaths(notUsers.map(m => ({ path: TYPE_PATH.Group(m), id: m })));
    recoverDeletedNames();
  }

  /**
   * A deleted object still has a name in the audits themselves: its Delete
   * audit (or any Create/Update) usually lists "name" among the property
   * changes. Use that instead of "(deleted) <guid>".
   */
  function recoverDeletedNames() {
    const deleted = new Set(Object.keys(nameCache).filter(id => nameCache[id] === `(deleted) ${id}`));
    if (!deleted.size) return;
    for (const entry of allResults) {
      const id = entry.entity?.id;
      if (!id || !deleted.has(id)) continue;
      const name = nameFromAudit(entry, id);
      if (name) { nameCache[id] = `(deleted) ${name}`; deleted.delete(id); }
      if (!deleted.size) return;
    }
  }

  /**
   * Where an audit may carry its own entity's name, in order of trust:
   * entity.name; a "name"/"…Name" property change; an entityChanges row
   * for the same id; a name-like key in context or in message.messageParams;
   * and finally the quoted name in Genesys's own message text.
   */
  function nameFromAudit(entry, id) {
    const clean = v => (v === null || v === undefined) ? "" : String(v).trim();
    if (realEntityName(entry)) return realEntityName(entry);

    for (const p of (entry.propertyChanges || [])) {
      if (!/(^|[^a-z])name$/i.test(String(p.property || ""))) continue;
      const v = [].concat(p.newValues ?? [], p.oldValues ?? []).map(clean).find(Boolean);
      if (v && !GUID_RE.test(v)) return v;
    }
    for (const c of (entry.entityChanges || [])) {
      if (c.entityId === id && clean(c.entityName)) return clean(c.entityName);
    }
    const bags = [entry.context, entry.message?.messageParams].filter(b => b && typeof b === "object");
    for (const bag of bags) {
      for (const [k, v] of Object.entries(bag)) {
        if (!/name$/i.test(k) || /user|actor|client|division|type/i.test(k)) continue;
        const str = clean(v);
        if (str && !GUID_RE.test(str)) return str;
      }
    }
    const text = clean(entry.message?.message);
    const quoted = text.match(/["'\u2018\u2019\u201c\u201d]([^"'\u2018\u2019\u201c\u201d]{1,120})["'\u2018\u2019\u201c\u201d]/);
    if (quoted && !GUID_RE.test(quoted[1])) return quoted[1];
    return "";
  }

  /**
   * Evaluations and recordings have no name and are only addressable
   * together with their conversation, which the audit's context supplies.
   * Returns a resolvePaths item with a label builder, or null.
   */
  function conversationScoped(entry) {
    const id   = entry.entity?.id;
    const conv = String(entry.context?.conversationId ?? "");
    if (!id || !GUID_RE.test(conv)) return null;
    const type = getEntityType(entry);
    if (type === "Evaluation") {
      return {
        id,
        path: `/api/v2/quality/conversations/${conv}/evaluations/${id}?expand=agent,evaluator,evaluationForm`,
        label: res => {
          const bits = [];
          if (res?.evaluationForm?.name) bits.push(res.evaluationForm.name);
          if (res?.agent?.name)          bits.push(`agent ${res.agent.name}`);
          if (res?.evaluator?.name)      bits.push(`by ${res.evaluator.name}`);
          if (res?.status)               bits.push(res.status.toLowerCase());
          return bits.length ? `Evaluation: ${bits.join(" · ")}` : "";
        },
      };
    }
    if (type === "Recording") {
      return {
        id,
        path: `/api/v2/conversations/${conv}/recordings/${id}`,
        label: res => {
          const kind = [res?.media, res?.mediaSubtype].filter(Boolean).join(" ");
          return `Recording${kind ? ` (${kind})` : ""} of conversation ${conv}`;
        },
      };
    }
    return null;
  }

  // ── Actor name resolution ────────────────────────────────────────
  // `expand=user` names most actors. What it leaves unnamed is either a
  // trustee user from another org or — for anything this app did — the
  // OAuth client, whose id Genesys puts in user.id. Try the user first,
  // then the OAuth client, then give up and show the id.
  async function resolveActors() {
    const ids = [...new Set(
      allResults.filter(e => e.user?.id && !e.user?.name).map(e => e.user.id)
    )];
    await runLimited(ids, LOOKUP_CONCURRENCY, async (userId) => {
      try {
        const user = await gc.getUser(api, orgId, userId);
        if (user?.name) { actorMap[userId] = user.name; return; }
      } catch { /* not a user in this org — try OAuth next */ }
      try {
        const client = await gc.getOAuthClient(api, orgId, userId);
        if (client?.name) { actorMap[userId] = client.name; return; }
      } catch { /* not an OAuth client either */ }
      actorMap[userId] = userId;
    });
  }

  // `client` is the OAuth client the action came through — separate from
  // `user`. Genesys's own clients (the web UI) 404 here and keep their id.
  async function resolveClients() {
    const ids = [...new Set(allResults.map(e => e.client?.id).filter(Boolean))];
    await runLimited(ids, LOOKUP_CONCURRENCY, async (clientId) => {
      if (actorMap[clientId] && actorMap[clientId] !== clientId) { clientMap[clientId] = actorMap[clientId]; return; }
      try {
        const client = await gc.getOAuthClient(api, orgId, clientId);
        clientMap[clientId] = client?.name || clientId;
      } catch {
        clientMap[clientId] = clientId;
      }
    });
  }

  // ── Post-filters — populated from what the results actually hold ──
  function populateClientFilters() {
    const entityTypes = [...new Set(allResults.map(getEntityType).filter(Boolean))].sort();
    ssEntityType.setItems(entityTypes.map(t => ({ id: t, label: t })));
    ssEntityType.setEnabled(entityTypes.length > 0);
    ssAction.setItems([]);
    ssAction.setEnabled(false);
    const actorNames = [...new Set(allResults.map(getActorName))].filter(n => n !== "—").sort();
    ssChangedBy.setItems(actorNames.map(n => ({ id: n, label: n })));
    ssChangedBy.setEnabled(actorNames.length > 0);
    const statuses = [...new Set(allResults.map(e => e.status).filter(Boolean))].sort();
    ssStatus.setItems(statuses.map(st => ({ id: st, label: st })));
    ssStatus.setEnabled(statuses.length > 0);
  }

  // ── Entity Type change → Action options seen for that type ───────
  function onEntityTypeChange(entityTypeId) {
    if (!entityTypeId) {
      ssAction.setItems([]);
      ssAction.setEnabled(false);
    } else {
      const actions = [...new Set(
        allResults.filter(e => getEntityType(e) === entityTypeId).map(e => e.action).filter(Boolean)
      )].sort();
      ssAction.setItems(actions.map(a => ({ id: a, label: a })));
      ssAction.setEnabled(actions.length > 0);
    }
    applyFilters();
  }

  // ── Client-side filtering (AND logic) ───────────────────────────
  function applyFilters() {
    const entityType = ssEntityType.getValue();
    const action     = ssAction.getValue();
    const changedBy  = ssChangedBy.getValue();
    const status     = ssStatus.getValue();

    filteredRows = allResults.filter(entry => {
      if (entityType && getEntityType(entry) !== entityType) return false;
      if (action     && entry.action !== action)             return false;
      if (status     && entry.status !== status)             return false;
      if (changedBy  && getActorName(entry) !== changedBy)   return false;
      return true;
    });

    currentPage = 1;
    renderTable();
    $exportBtn.disabled = filteredRows.length === 0;
  }

  // ── Field extractors ─────────────────────────────────────────────
  function getEntityType(entry) {
    return entry.entity?.type || entry.entityType || "";
  }

  function getEntityName(entry) {
    const id = entry.entity?.id;
    const grant = grantParts(entry);
    if (grant) {
      const role     = nameCache[id] || id;
      const member   = nameCache[grant.subjectId] || grant.subjectId;
      const division = grant.divisionId === "*" ? "all divisions"
        : grant.divisionId ? (nameCache[grant.divisionId] || grant.divisionId) : "";
      return `${role} → ${member}${division ? ` (${division})` : ""}`;
    }
    const own = realEntityName(entry);
    if (own) return prettyEntityName(entry, own);
    if (!id) return "";
    return nameCache[id] || id;
  }

  /** A value as displayed: its resolved name when it is a known GUID, else itself. */
  function displayValue(v) {
    return String(v ?? "").replace(GUID_G, g => nameCache[g] || g);
  }

  /** Comma-joined values with GUIDs resolved. */
  function joinValues(values) {
    return [].concat(values ?? []).map(displayValue).join(", ");
  }

  function getClientName(entry) {
    const id = entry.client?.id;
    if (!id) return "";
    return clientMap[id] || id;
  }

  function getActorName(entry) {
    if (entry.user?.name) return entry.user.name;
    if (entry.user?.id)   return actorMap[entry.user.id] || entry.user.id;
    const client = getClientName(entry);
    if (client) return client;
    return entry.level === "SYSTEM" || entry.level === "GENESYS_INTERNAL" ? "Genesys (system)" : "—";
  }

  // ── Pagination wiring ────────────────────────────────────────────
  $prevBtn.addEventListener("click", () => {
    if (currentPage > 1) { currentPage--; renderTable(); }
  });
  $nextBtn.addEventListener("click", () => {
    const totalPages = Math.ceil(filteredRows.length / pageSize);
    if (currentPage < totalPages) { currentPage++; renderTable(); }
  });
  $pageSizeSel.addEventListener("change", () => {
    pageSize = Number($pageSizeSel.value);
    currentPage = 1;
    renderTable();
  });

  // ── Render results table ─────────────────────────────────────────
  function renderTable() {
    const total      = allResults.length;
    const shown      = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(shown / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;

    const start    = (currentPage - 1) * pageSize;
    const pageRows = filteredRows.slice(start, start + pageSize);

    $resultCount.textContent =
      shown === total
        ? `${total} result${total !== 1 ? "s" : ""}`
        : `${total} results (${shown} shown after filters)`;

    // Pagination info + button states
    $pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    $prevBtn.disabled = currentPage <= 1;
    $nextBtn.disabled = currentPage >= totalPages;

    $tableBody.innerHTML = "";

    if (!pageRows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td colspan="7" style="text-align:center;color:var(--muted);padding:20px;">
          No results match the current filters.
        </td>`;
      $tableBody.appendChild(tr);
      return;
    }

    for (const entry of pageRows) {
      const entityType = getEntityType(entry);
      const entityName = getEntityName(entry);
      const actor      = getActorName(entry);
      const ts         = formatDateTime(entry.eventDate || entry.createdDate);
      const action     = entry.action || "—";
      const service    = entry.serviceName || ssService.getValue() || "—";
      const status     = entry.status || "";
      const statusHtml = status && status !== "SUCCESS"
        ? ` <span class="aq-status aq-status--${escapeHtml(status.toLowerCase())}" title="Genesys audited this action as ${escapeHtml(status)}">${escapeHtml(status)}</span>`
        : "";

      // ── Main row ──────────────────────────────────────
      const tr = document.createElement("tr");
      tr.className = "aq-row";
      tr.innerHTML = `
        <td>${escapeHtml(ts)}</td>
        <td>${escapeHtml(service)}</td>
        <td>${escapeHtml(entityType)}</td>
        <td class="aq-entity-name" title="${escapeHtml(entityName)}">${escapeHtml(entityName)}</td>
        <td>${escapeHtml(action)}${statusHtml}</td>
        <td>${escapeHtml(actor)}</td>
        <td class="aq-details-cell">
          <button class="aq-expand-btn" type="button" aria-expanded="false" title="Show changes">▶</button>
        </td>
      `;

      // ── Detail row (hidden by default, built on first open) ──
      const detailTr = document.createElement("tr");
      detailTr.className = "aq-detail-row";
      detailTr.hidden = true;
      let detailBuilt = false;

      // ── Toggle expand / collapse (click anywhere on the row) ──
      const expandBtn = tr.querySelector(".aq-expand-btn");
      function toggleRow() {
        const opening = detailTr.hidden;
        if (opening && !detailBuilt) {
          detailTr.innerHTML = `<td colspan="7"><div class="aq-diff-body">${buildDiffHtml(entry)}</div>${relatedHtml(entry)}</td>`;
          wireRelatedButton(detailTr, entry);
          detailBuilt = true;
          // The GUIDs inside old/new values are looked up on first open only —
          // doing it for every result up front would be hundreds of calls for
          // rows nobody expands. Repaint the diff once they are known.
          const body = detailTr.querySelector(".aq-diff-body");
          resolveValueRefs([entry]).then(() => { body.innerHTML = buildDiffHtml(entry); });
        }
        detailTr.hidden = !opening;
        expandBtn.textContent = opening ? "▼" : "▶";
        expandBtn.setAttribute("aria-expanded", String(opening));
      }
      tr.addEventListener("click", toggleRow);

      $tableBody.appendChild(tr);
      $tableBody.appendChild(detailTr);
    }
  }

  // ── Related audits (all audits written by the same action) ────────
  function wireRelatedButton(detailTr, entry) {
    detailTr.querySelector(".aq-history-btn")?.addEventListener("click", () => searchHistoryOf(entry));
    const btn = detailTr.querySelector(".aq-related-btn");
    const out = detailTr.querySelector(".aq-related-out");
    if (!btn || !out) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      out.innerHTML = `<span class="di-status"><span class="spin spin--sm" aria-hidden="true"></span> Loading related audits…</span>`;
      try {
        const related = (await gc.fetchRelatedAudits(api, orgId, entry.id))
          .filter(r => r.id !== entry.id)
          .sort((a, b) => new Date(a.eventDate || 0) - new Date(b.eventDate || 0));
        if (!related.length) {
          out.innerHTML = `<p class="aq-diff-empty">No other audits were written by this action.</p>`;
          return;
        }
        await resolvePaths(related
          .filter(r => r.entity?.id && !r.entity?.name)
          .map(r => ({ path: pathFor(r.serviceName || "", getEntityType(r), r.entity.id), id: r.entity.id })));
        out.innerHTML = `
          <table class="data-table aq-diff-table aq-related-table">
            <thead><tr><th>Date &amp; Time</th><th>Service</th><th>Entity Type</th><th>Entity</th><th>Action</th><th>Status</th></tr></thead>
            <tbody>${related.map(r => `
              <tr>
                <td>${escapeHtml(formatDateTime(r.eventDate))}</td>
                <td>${escapeHtml(r.serviceName || "")}</td>
                <td>${escapeHtml(getEntityType(r))}</td>
                <td title="${escapeHtml(r.entity?.id || "")}">${escapeHtml(getEntityName(r))}</td>
                <td>${escapeHtml(r.action || "")}</td>
                <td>${escapeHtml(r.status || "")}</td>
              </tr>`).join("")}
            </tbody>
          </table>`;
      } catch (err) {
        out.innerHTML = `<p class="aq-diff-empty">Could not load related audits: ${escapeHtml(friendlyError(err))}</p>`;
        btn.disabled = false;
      }
    });
  }

  // ── Build diff HTML for an expanded row ───────────────────────────
  function buildDiffHtml(entry) {
    // ── Metadata ────────────────────────────────────────────────
    const initiating = entry.initiatingAction
      ? `${entry.initiatingAction.actionContext || ""}${entry.initiatingAction.transactionId ? ` (${entry.initiatingAction.transactionId})` : ""}`.trim()
      : "";
    const metaFields = [
      ["Service",     entry.serviceName],
      ["Entity Type", entry.entityType],
      ["Entity",      getEntityName(entry) !== entry.entity?.id ? getEntityName(entry) : null],
      ["Entity ID",   entry.entity?.id],
      ["Action",      entry.action],
      ["Status",      entry.status],
      ["Message",     entry.message?.message],
      ["Changed By",  getActorName(entry)],
      ["User ID",     entry.user?.id],
      ["Client",      getClientName(entry)],
      ["Application", entry.application],
      ["Level",       entry.level],
      ["Date",        entry.eventDate ? formatDateTime(entry.eventDate) : null],
      ["Remote IP",   (entry.remoteIp || []).filter(Boolean).join(", ") || null],
      ["Initiated by", initiating || null],
      ["Transaction",  entry.transactionInitiator === true ? "this audit started the transaction" : null],
    ].filter(([, v]) => v);

    const metaHtml = metaFields.length ? `
      <table class="data-table aq-diff-meta-table">
        <tbody>
          ${metaFields.map(([k, v]) => `
            <tr>
              <td class="aq-diff-meta-key">${escapeHtml(k)}</td>
              <td class="aq-diff-meta-val">${escapeHtml(String(v))}</td>
            </tr>`).join("")}
        </tbody>
      </table>` : "";

    // ── Changed Properties (propertyChanges[]) ───────────────────
    const propChanges = entry.propertyChanges || [];
    let propsHtml = "";
    if (propChanges.length) {
      const rows = propChanges.map(p => `
          <tr>
            <td class="aq-diff-prop" title="${escapeHtml(String(p.property ?? ""))}">${escapeHtml(displayValue(p.property))}</td>
            <td class="aq-diff-old" title="${escapeHtml([].concat(p.oldValues ?? []).join(", "))}">${escapeHtml(joinValues(p.oldValues))}</td>
            <td class="aq-diff-new" title="${escapeHtml([].concat(p.newValues ?? []).join(", "))}">${escapeHtml(joinValues(p.newValues))}</td>
          </tr>`).join("");
      propsHtml = `
        <h4 class="aq-diff-section-title">Changed Properties</h4>
        <table class="data-table aq-diff-table">
          <thead><tr><th>Change</th><th>Old Value</th><th>New Value</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    // ── Changed Entities (entityChanges[] — e.g. queue members) ──
    const entChanges = entry.entityChanges || [];
    let entHtml = "";
    if (entChanges.length) {
      const rows = entChanges.map(c => `
          <tr>
            <td class="aq-diff-prop">${escapeHtml(c.entityType || "")}</td>
            <td title="${escapeHtml(c.entityId || "")}">${escapeHtml(c.entityName || displayValue(c.entityId))}</td>
            <td class="aq-diff-old" title="${escapeHtml([].concat(c.oldValues ?? []).join(", "))}">${escapeHtml(joinValues(c.oldValues))}</td>
            <td class="aq-diff-new" title="${escapeHtml([].concat(c.newValues ?? []).join(", "))}">${escapeHtml(joinValues(c.newValues))}</td>
          </tr>`).join("");
      entHtml = `
        <h4 class="aq-diff-section-title aq-diff-section-title--ctx">Changed Entities</h4>
        <table class="data-table aq-diff-table">
          <thead><tr><th>Type</th><th>Entity</th><th>Old Value</th><th>New Value</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    // ── Additional Context (entry.context plain object) ──────────
    const pairs = contextPairs(entry);
    let ctxHtml = "";
    if (pairs.length) {
      const ctxRows = pairs.map(({ k, v }) => `
        <tr>
          <td class="aq-diff-ctx-key">${escapeHtml(k)}</td>
          <td class="aq-diff-ctx-val" title="${escapeHtml(v)}">${escapeHtml(displayValue(v))}</td>
        </tr>`).join("");
      ctxHtml = `
        <h4 class="aq-diff-section-title aq-diff-section-title--ctx">Additional Context</h4>
        <table class="data-table aq-diff-table aq-diff-ctx-table">
          <thead><tr><th>Key</th><th>Value</th></tr></thead>
          <tbody>${ctxRows}</tbody>
        </table>`;
    }

    const noChanges = !propChanges.length && !entChanges.length
      ? `<p class="aq-diff-empty">Genesys recorded no property changes for this audit.</p>` : "";

    return `${metaHtml}${propsHtml}${entHtml}${noChanges}${ctxHtml}`;
  }

  /** The part of the detail row that is NOT repainted when names resolve. */
  function relatedHtml(entry) {
    const history = entry.entity?.id ? `
      <button class="btn aq-history-btn" type="button" title="Search this whole range for everything that mentions this object">History of this object</button>` : "";
    // The related endpoint is part of the realtime API and shares its window.
    const age = Date.now() - new Date(entry.eventDate || 0).getTime();
    const related = !entry.id ? "" : age > REALTIME_WINDOW_MS ? `
      <p class="aq-diff-empty">Related audits are only available for the last 14 days.</p>` : `
      <div class="aq-related">
        <button class="btn aq-related-btn" type="button" title="Genesys writes several audits for one action — list the others">Show related audits</button>
        <div class="aq-related-out"></div>
      </div>`;
    return `<div class="aq-row-actions">${history}</div>${related}
      <details class="aq-raw-details">
        <summary class="aq-raw-summary">Raw API response</summary>
        <pre class="aq-raw-json">${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
      </details>`;
  }

  /** entry.context as [{k, v}] — it is a plain object per the spec, but tolerate arrays. */
  function contextPairs(entry) {
    const ctxRaw = entry.context ?? entry.additionalContext ?? null;
    if (!ctxRaw) return [];
    if (Array.isArray(ctxRaw)) {
      return ctxRaw.map(item =>
        typeof item === "object" && item !== null
          ? { k: String(item.key ?? item.name ?? ""), v: String(item.value ?? "") }
          : { k: String(item), v: "" });
    }
    if (typeof ctxRaw === "object") {
      return Object.entries(ctxRaw)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => ({ k, v: typeof v === "object" ? JSON.stringify(v) : String(v) }));
    }
    return [];
  }

  // ── Export to Excel ─────────────────────────────────────────────────────────
  const EXPORT_COLUMNS = [
    { key: "dateTime",    label: "Date & Time",       wch: 22 },
    { key: "service",     label: "Service",            wch: 20 },
    { key: "entityType",  label: "Entity Type",        wch: 25 },
    { key: "entityName",  label: "Entity Name",        wch: 35 },
    { key: "entityId",    label: "Entity ID",          wch: 38 },
    { key: "action",      label: "Action",             wch: 20 },
    { key: "status",      label: "Status",             wch: 10 },
    { key: "changedBy",   label: "Changed By",         wch: 30 },
    { key: "client",      label: "Client",             wch: 30 },
    { key: "application", label: "Application",        wch: 24 },
    { key: "message",     label: "Message",            wch: 50 },
    { key: "level",       label: "Level",              wch: 12 },
    { key: "remoteIp",    label: "Remote IP",          wch: 20 },
    { key: "property",    label: "Property",           wch: 30 },
    { key: "oldValue",    label: "Old Value",          wch: 40 },
    { key: "newValue",    label: "New Value",          wch: 40 },
    { key: "context",     label: "Additional Context", wch: 50 },
  ];

  async function exportToExcel() {
    if (!filteredRows.length || isRunning) return;
    isRunning = true;
    $exportBtn.disabled = true;
    try {
      setStatus(`Resolving names for ${filteredRows.length} rows…`);
      await resolveValueRefs(filteredRows);
      setStatus("");
    } catch (err) {
      setStatus(`Some names could not be resolved: ${friendlyError(err)}`, "warn");
    } finally {
      isRunning = false;
      $exportBtn.disabled = false;
    }

    const rows = [];
    for (const entry of filteredRows) {
      const base = {
        dateTime:    formatDateTime(entry.eventDate || entry.createdDate),
        service:     entry.serviceName || ssService.getValue() || "",
        entityType:  getEntityType(entry),
        entityName:  getEntityName(entry),
        entityId:    entry.entity?.id || "",
        action:      entry.action || "",
        status:      entry.status || "",
        changedBy:   getActorName(entry),
        client:      getClientName(entry),
        application: entry.application || "",
        message:     entry.message?.message || "",
        level:       entry.level || "",
        remoteIp:    (entry.remoteIp || []).filter(Boolean).join(", "),
        context:     contextPairs(entry).map(({ k, v }) => `${k}: ${displayValue(v)}`).join("; "),
      };

      const changes = [
        ...(entry.propertyChanges || []).map(p => ({
          property: displayValue(p.property),
          oldValue: joinValues(p.oldValues),
          newValue: joinValues(p.newValues),
        })),
        ...(entry.entityChanges || []).map(c => ({
          property: `${c.entityType || "Entity"}: ${c.entityName || displayValue(c.entityId)}`,
          oldValue: joinValues(c.oldValues),
          newValue: joinValues(c.newValues),
        })),
      ];

      if (changes.length) for (const c of changes) rows.push({ ...base, ...c });
      else rows.push({ ...base, property: "", oldValue: "", newValue: "" });
    }

    const org      = orgContext?.getDetails?.();
    const safeName = (org?.name || orgId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
    const from     = $dateFrom.value || "unknown";
    const to       = $dateTo.value   || "unknown";
    const filename = timestampedFilename(`Audit_Search_${safeName}_${from}_${to}`, "xlsx");

    try {
      exportXlsx([{ name: "Audit Search", rows, columns: EXPORT_COLUMNS }], filename);
    } catch (err) {
      setStatus(`Export failed: ${err.message}`, "error");
    }
  }

  $exportBtn.addEventListener("click", exportToExcel);

  return el;
}
