/**
 * Audit › Search
 *
 * Routing (decided by how OLD the interval start is, not how long the range is —
 * the realtime endpoint holds only the last 14 days of audits):
 *   start within 14 days, no service   → realtime API, all realtime-supported services
 *   start within 14 days, service in realtime mapping → realtime API (sync, fast)
 *   start within 14 days, service NOT in realtime mapping → async API
 *   start older than 14 days           → async API; service optional. The spec
 *                                        requires only `interval`; if Genesys
 *                                        rejects a service-less query the user
 *                                        is asked to pick one.
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
 * Both query endpoints accept server-side filters (UserId, ClientId, Action,
 * EntityType, EntityId). Entity ID is exposed here as the "history of one
 * object" query; the others stay client-side because the values come from
 * the results.
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
const QUERY_CONCURRENCY   = 6;  // realtime jobs in flight at once
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
  let entityNameMap  = {};     // { entityId → resolvedName }
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
      Older ranges use the standard audit query, which is slower and may need a service.
      Times are local.
    </p>

    <!-- Preset quick filters -->
    <div class="aq-presets">
      <button class="btn aq-preset-btn" data-preset="today">Today</button>
      <button class="btn aq-preset-btn" data-preset="7d">Last 7 days</button>
      <button class="btn aq-preset-btn" data-preset="30d">Last month</button>
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
      <div class="di-control-group aq-entity-id-group">
        <label class="di-label" for="aqEntityId">Entity ID (optional)</label>
        <input type="text" class="input aq-entity-id" id="aqEntityId" placeholder="GUID of one object" spellcheck="false">
        <p class="aq-service-hint aq-service-hint--info">Full change history of one queue, flow, user, …</p>
      </div>
      <div class="di-control-group" style="justify-content:flex-end;padding-top:20px">
        <button class="btn" id="aqSearchBtn" disabled>Search</button>
      </div>
    </div>

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

      <div class="di-controls" style="margin-top:12px">
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

  // ── Single-select dropdowns ──────────────────────────────────────
  const ssService    = createSingleSelect({ placeholder: "— All services —",    searchable: true,  onChange: () => updateServiceMode() });
  const ssEntityType = createSingleSelect({ placeholder: "All entity types",     searchable: false, onChange: onEntityTypeChange });
  const ssAction     = createSingleSelect({ placeholder: "All actions",          searchable: false, onChange: () => applyFilters() });
  const ssChangedBy  = createSingleSelect({ placeholder: "All users",            searchable: true,  onChange: () => applyFilters() });
  const ssStatus     = createSingleSelect({ placeholder: "All statuses",         searchable: false, onChange: () => applyFilters() });

  // Replace the "Loading services…" placeholder with the real dropdown
  $serviceDrop.innerHTML = "";
  $serviceDrop.append(ssService.el);

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
        : "Older than 14 days — standard query. Genesys may require a service; select one if asked.";
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
      else if (preset === "7d")   $dateFrom.value = daysAgoLocalStr(7);
      else if (preset === "30d")  $dateFrom.value = daysAgoLocalStr(30);
      else if (preset === "90d")  $dateFrom.value = daysAgoLocalStr(90);
      // Highlight active preset
      el.querySelectorAll(".aq-preset-btn").forEach(b => b.classList.remove("aq-preset-btn--active"));
      btn.classList.add("aq-preset-btn--active");
      updateServiceMode();
      runSearch();
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
    const entityId = $entityId.value.trim();
    const filters  = entityId ? [{ property: "EntityId", value: entityId }] : undefined;

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
    entityNameMap = {};
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

        const settled = await runLimited(jobs, QUERY_CONCURRENCY, async ({ interval, svcName }) => {
          const entries = await gc.submitRealtimeAuditQuery(api, orgId, { interval, serviceName: svcName, filters });
          done++;
          setStatus(`Realtime: ${done} of ${totalJobs} queries done (${allResults.length + entries.length} entries)…`);
          showProgress(5 + (done / totalJobs) * 80);
          allResults.push(...entries);
          return entries.length;
        });
        settled.forEach((r, i) => {
          if (r.status === "rejected") {
            failures.push({ label: `${jobs[i].svcName} ${jobs[i].interval.slice(0, 10)}`, message: friendlyError(r.reason) });
          }
        });

      } else {
        // ── Async: older than 14 days, or service not in realtime mapping ─
        if (withinRealtimeWindow(from, fromTime)) setStatus(`${service} not in realtime mapping — using standard query…`);
        totalJobs = await runAsyncQuery(service, from, fromTime, to, toTime, filters);
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
      const found = `${n} result${n !== 1 ? "s" : ""} found`;
      if (failures.length) {
        setStatus(`Done — ${found}, but results are incomplete: ${failures.length} of ${totalJobs} queries failed (${failures[0].message}).`, "warn");
      } else {
        setStatus(`Done — ${found}.`, "success");
      }
      renderFailures();

      populateClientFilters(allMode ? null : service);
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
    for (let i = 0; i < chunks.length; i++) {
      const interval = chunks[i];
      const chunkLabel = `${label} ${interval.slice(0, 10)}`;
      setStatus(`Fetching interval ${i + 1} of ${total} (${label})…`);
      showProgress(5 + (i / total) * 80);
      try {
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
      } catch (err) {
        if (i === 0 && !service && isServiceRequiredError(err)) throw err;
        failures.push({ label: chunkLabel, message: friendlyError(err) });
      }
    }
    return total;
  }

  // ── Entity name resolution ───────────────────────────────────────
  // Maps service+entityType to a Genesys API path function. Only used when
  // the audit entry carries no entity.name of its own.
  // entity.id in audit entries is always the resource GUID (or for
  // Datatables/Row it is the parent datatable ID).
  const ENTITY_PATH = {
    // Triggers / ProcessAutomation
    "Triggers/Trigger":                   id => `/api/v2/processautomation/triggers/${id}`,
    "ProcessAutomation/Trigger":           id => `/api/v2/processautomation/triggers/${id}`,
    // Datatables
    "Datatables/Schema":              id => `/api/v2/flows/datatables/${id}`,
    "Datatables/Row":                 id => `/api/v2/flows/datatables/${id}`,
    // Architect
    "Architect/Flow":                 id => `/api/v2/flows/${id}`,
    "Architect/Prompt":               id => `/api/v2/architect/prompts/${id}`,
    "Architect/IVR":                  id => `/api/v2/architect/ivrs/${id}`,
    "Architect/Schedule":             id => `/api/v2/architect/schedules/${id}`,
    "Architect/ScheduleGroup":        id => `/api/v2/architect/schedulegroups/${id}`,
    "Architect/EmergencyGroup":       id => `/api/v2/architect/emergencygroups/${id}`,
    "Architect/FlowOutcome":          id => `/api/v2/flows/outcomes/${id}`,
    "Architect/FlowMilestone":        id => `/api/v2/flows/milestones/${id}`,
    // ContactCenter
    "ContactCenter/Queue":            id => `/api/v2/routing/queues/${id}`,
    "ContactCenter/WrapupCode":       id => `/api/v2/routing/wrapupcodes/${id}`,
    // PeoplePermissions
    "PeoplePermissions/Role":         id => `/api/v2/authorization/roles/${id}`,
    "PeoplePermissions/OAuthClient":  id => `/api/v2/oauth/clients/${id}`,
    // Directory
    "Directory/User":                 id => `/api/v2/users/${id}`,
    // Groups
    "Groups/DirectoryGroup":          id => `/api/v2/groups/${id}`,
    "Groups/Team":                    id => `/api/v2/teams/${id}`,
    "Groups/SkillGroup":              id => `/api/v2/routing/skillgroups/${id}`,
    // Routing
    "Routing/RoutingSkill":           id => `/api/v2/routing/skills/${id}`,
    // ResponseManagement
    "ResponseManagement/Response":        id => `/api/v2/responsemanagement/responses/${id}`,
    "ResponseManagement/ResponseLibrary": id => `/api/v2/responsemanagement/libraries/${id}`,
    // Telephony
    "Telephony/Site":                 id => `/api/v2/telephony/providers/edges/sites/${id}`,
    "Telephony/Trunk":                id => `/api/v2/telephony/providers/edges/trunks/${id}`,
    "Telephony/TrunkBase":            id => `/api/v2/telephony/providers/edges/trunkbasesettings/${id}`,
    "Telephony/Phone":                id => `/api/v2/telephony/providers/edges/phones/${id}`,
    "Telephony/Edge":                 id => `/api/v2/telephony/providers/edges/${id}`,
    "Telephony/IVR":                  id => `/api/v2/architect/ivrs/${id}`,
    "Telephony/Schedule":             id => `/api/v2/architect/schedules/${id}`,
    "Telephony/ScheduleGroup":        id => `/api/v2/architect/schedulegroups/${id}`,
    "Telephony/EmergencyGroup":       id => `/api/v2/architect/emergencygroups/${id}`,
    // Outbound
    "Outbound/Campaign":              id => `/api/v2/outbound/campaigns/${id}`,
    "Outbound/ContactList":           id => `/api/v2/outbound/contactlists/${id}`,
    "Outbound/DNCList":               id => `/api/v2/outbound/dnclists/${id}`,
    "Outbound/RuleSet":               id => `/api/v2/outbound/rulesets/${id}`,
    "Outbound/CallableTimeSet":       id => `/api/v2/outbound/callabletimesets/${id}`,
    // Knowledge
    "Knowledge/KnowledgeBase":        id => `/api/v2/knowledge/knowledgebases/${id}`,
    // Integrations
    "Integrations/Integration":       id => `/api/v2/integrations/${id}`,
    // WebDeployments
    "WebDeployments/Deployment":      id => `/api/v2/webdeployments/deployments/${id}`,
    "WebDeployments/Configuration":   id => `/api/v2/webdeployments/configurations/${id}`,
    // WorkforceManagement
    "WorkforceManagement/BusinessUnit":   id => `/api/v2/workforcemanagement/businessunits/${id}`,
    "WorkforceManagement/ManagementUnit": id => `/api/v2/workforcemanagement/managementunits/${id}`,
    // Messaging
    "Messaging/Integration":          id => `/api/v2/messaging/integrations/${id}`,
  };

  async function resolveEntities() {
    // Unique (service/entityType, id) pairs that have a resolver AND no name
    // of their own. An entity.name in the audit is the name at the time of the
    // change, which beats today's name — and beats "(deleted)".
    const toResolve = [];
    for (const entry of allResults) {
      const id      = entry.entity?.id;
      if (!id || entry.entity?.name) continue;
      const service = entry.serviceName || "";
      const type    = entry.entityType  || entry.entity?.type || "";
      const key     = `${service}/${type}`;
      if (ENTITY_PATH[key] && !(id in entityNameMap)) {
        entityNameMap[id] = null; // mark as in-flight
        toResolve.push({ key, id });
      }
    }

    await runLimited(toResolve, LOOKUP_CONCURRENCY, async ({ key, id }) => {
      try {
        const path = ENTITY_PATH[key](id);
        const res  = await gc.fetchEntityByPath(api, orgId, path);
        entityNameMap[id] = res?.name || id;
      } catch (err) {
        entityNameMap[id] = err?.status === 404
          ? `(deleted) ${id}`
          : id; // other errors (permissions, network) — just show GUID
      }
    });
  }

  // ── Actor name resolution ────────────────────────────────────────
  // `expand=user` already puts user.name on most entries. Anything left —
  // typically a trustee user from another org — gets one lookup here.
  async function resolveActors() {
    const ids = [...new Set(
      allResults.filter(e => e.user?.id && !e.user?.name).map(e => e.user.id)
    )];
    await runLimited(ids, LOOKUP_CONCURRENCY, async (userId) => {
      try {
        const user = await gc.getUser(api, orgId, userId);
        if (user?.name) { actorMap[userId] = user.name; return; }
      } catch { /* not a user in this org */ }
      actorMap[userId] = userId;
    });
  }

  // `client` is the OAuth client the action came through — separate from
  // `user`. Changes made by this app are attributed to its client.
  async function resolveClients() {
    const ids = [...new Set(allResults.map(e => e.client?.id).filter(Boolean))];
    await runLimited(ids, LOOKUP_CONCURRENCY, async (clientId) => {
      try {
        const client = await gc.getOAuthClient(api, orgId, clientId);
        clientMap[clientId] = client?.name || clientId;
      } catch {
        clientMap[clientId] = clientId; // Genesys-internal clients 404 here
      }
    });
  }

  // ── Populate client-side filter dropdowns ────────────────────────
  function populateClientFilters(serviceName) {
    let entityTypes;
    if (serviceName) {
      // Single service: use async mapping
      const svc = (serviceMapping?.services || []).find(s => s.name === serviceName);
      entityTypes = (svc?.entities || [])
        .map(e => ({ id: e.name, label: e.name }))
        .sort((a, b) => a.label.localeCompare(b.label));
    } else {
      // allMode: aggregate unique entity types from realtime service mapping
      const src  = realtimeServiceMapping || serviceMapping;
      const seen = new Set();
      entityTypes = [];
      for (const svc of (src?.services || [])) {
        for (const e of (svc.entities || [])) {
          if (!seen.has(e.name)) { seen.add(e.name); entityTypes.push({ id: e.name, label: e.name }); }
        }
      }
      entityTypes.sort((a, b) => a.label.localeCompare(b.label));
    }

    ssEntityType.setItems(entityTypes);
    ssEntityType.setEnabled(true);
    ssAction.setItems([]);
    ssAction.setEnabled(false);
    const actorNames = [...new Set(allResults.map(getActorName))].filter(n => n !== "—").sort();
    ssChangedBy.setItems(actorNames.map(n => ({ id: n, label: n })));
    ssChangedBy.setEnabled(true);
    const statuses = [...new Set(allResults.map(e => e.status).filter(Boolean))].sort();
    ssStatus.setItems(statuses.map(s => ({ id: s, label: s })));
    ssStatus.setEnabled(statuses.length > 0);
  }

  // ── Entity Type change → refresh Action options ──────────────────
  function onEntityTypeChange(entityTypeId) {
    if (!entityTypeId) {
      ssAction.setItems([]);
      ssAction.setEnabled(false);
    } else {
      const serviceName = ssService.getValue();
      let actions;
      if (serviceName) {
        // Single service: actions from async mapping
        const svc    = (serviceMapping?.services || []).find(s => s.name === serviceName);
        const entity = (svc?.entities || []).find(e => e.name === entityTypeId);
        actions = (entity?.actions || []).map(a => ({ id: a, label: a }));
      } else {
        // allMode: aggregate actions for this entity type across all realtime services
        const src  = realtimeServiceMapping || serviceMapping;
        const seen = new Set();
        actions = [];
        for (const svc of (src?.services || [])) {
          const entity = (svc.entities || []).find(e => e.name === entityTypeId);
          if (entity) for (const a of (entity.actions || []))
            if (!seen.has(a)) { seen.add(a); actions.push({ id: a, label: a }); }
        }
        actions.sort((a, b) => a.label.localeCompare(b.label));
      }
      ssAction.setItems(actions);
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
    if (entry.entity?.name) return entry.entity.name;
    const id = entry.entity?.id;
    if (id && entityNameMap[id]) return entityNameMap[id];
    return id || "";
  }

  function getClientName(entry) {
    const id = entry.client?.id;
    if (!id) return "";
    return clientMap[id] || id;
  }

  function getActorName(entry) {
    if (entry.user?.name) return entry.user.name;
    if (entry.user?.id)   return actorMap[entry.user.id] || entry.user.id;
    return getClientName(entry) || "—";
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
          detailTr.innerHTML = `<td colspan="7">${buildDiffHtml(entry)}</td>`;
          wireRelatedButton(detailTr, entry);
          detailBuilt = true;
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
        out.innerHTML = `
          <table class="data-table aq-diff-table aq-related-table">
            <thead><tr><th>Date &amp; Time</th><th>Service</th><th>Entity Type</th><th>Entity</th><th>Action</th><th>Status</th></tr></thead>
            <tbody>${related.map(r => `
              <tr>
                <td>${escapeHtml(formatDateTime(r.eventDate))}</td>
                <td>${escapeHtml(r.serviceName || "")}</td>
                <td>${escapeHtml(getEntityType(r))}</td>
                <td>${escapeHtml(r.entity?.name || r.entity?.id || "")}</td>
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
      ["Entity ID",   entry.entity?.id],
      ["Action",      entry.action],
      ["Status",      entry.status],
      ["Message",     entry.message?.message],
      ["Changed By",  entry.user?.name || actorMap[entry.user?.id] || entry.user?.id],
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
            <td class="aq-diff-prop">${escapeHtml(String(p.property ?? ""))}</td>
            <td class="aq-diff-old">${escapeHtml([].concat(p.oldValues ?? []).join(", "))}</td>
            <td class="aq-diff-new">${escapeHtml([].concat(p.newValues ?? []).join(", "))}</td>
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
            <td>${escapeHtml(c.entityName || c.entityId || "")}</td>
            <td class="aq-diff-old">${escapeHtml([].concat(c.oldValues ?? []).join(", "))}</td>
            <td class="aq-diff-new">${escapeHtml([].concat(c.newValues ?? []).join(", "))}</td>
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
          <td class="aq-diff-ctx-val">${escapeHtml(v)}</td>
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

    const relatedHtml = entry.id ? `
      <div class="aq-related">
        <button class="btn aq-related-btn" type="button" title="Genesys writes several audits for one action — list the others">Show related audits</button>
        <div class="aq-related-out"></div>
      </div>` : "";

    return `${metaHtml}${propsHtml}${entHtml}${noChanges}${ctxHtml}${relatedHtml}
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

  function exportToExcel() {
    if (!filteredRows.length) return;

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
        context:     contextPairs(entry).map(({ k, v }) => `${k}: ${v}`).join("; "),
      };

      const changes = [
        ...(entry.propertyChanges || []).map(p => ({
          property: String(p.property ?? ""),
          oldValue: [].concat(p.oldValues ?? []).join(", "),
          newValue: [].concat(p.newValues ?? []).join(", "),
        })),
        ...(entry.entityChanges || []).map(c => ({
          property: `${c.entityType || "Entity"}: ${c.entityName || c.entityId || ""}`,
          oldValue: [].concat(c.oldValues ?? []).join(", "),
          newValue: [].concat(c.newValues ?? []).join(", "),
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
