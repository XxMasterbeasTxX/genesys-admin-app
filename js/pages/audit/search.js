/**
 * Audit › Search
 *
 * Query audit events for a selected service within a date range.
 * Client-side filters: Entity Type → Action (cascading) + Changed By (independent).
 *
 * API endpoints:
 *   GET  /api/v2/audits/query/servicemapping        — service/entity/action mapping
 *   POST /api/v2/audits/query                       — submit async audit query
 *   GET  /api/v2/audits/query/{transactionId}       — poll query status
 *   GET  /api/v2/audits/query/{transactionId}/results — cursor-paginated results
 *   GET  /api/v2/users/{userId}                     — resolve actor display names
 */
import { escapeHtml, formatDateTime, todayStr, daysAgoStr } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { createSingleSelect } from "../../components/multiSelect.js";

// ── Constants ────────────────────────────────────────────────────────

const CHUNK_DAYS = 30;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Split a [from, to] date+time range into CHUNK_DAYS-day ISO 8601 interval strings.
 * fromTime / toTime are "HH:MM" strings (24-hour, UTC).
 */
function buildIntervalChunks(from, fromTime, to, toTime) {
  const start = new Date(`${from}T${fromTime}:00.000Z`);
  const end   = new Date(`${to}T${toTime}:59.999Z`);
  const chunks = [];
  let cursor = start;

  while (cursor < end) {
    const chunkEnd = new Date(Math.min(
      cursor.getTime() + CHUNK_DAYS * 86_400_000 - 1,
      end.getTime(),
    ));
    chunks.push(`${cursor.toISOString()}/${chunkEnd.toISOString()}`);
    cursor = new Date(chunkEnd.getTime() + 1);
  }

  return chunks;
}

/** Extract a friendly message from an API error. */
function friendlyError(err) {
  const msg = err.message || String(err);
  if (msg.includes("403")) return "Permission denied";
  if (msg.includes("404")) return "Not found";
  if (msg.includes("429")) return "Rate limited — try again shortly";
  return msg;
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
  let serviceMapping = null;   // { services: [{ name, entities:[{ name, actions }] }] }
  let allResults     = [];     // all fetched audit entries, sorted latest-first
  let filteredRows   = [];     // current filtered view (subset of allResults)
  let actorMap       = {};     // { userId → displayName }
  let entityNameMap  = {};     // { entityId → resolvedName }
  let isRunning      = false;
  let currentPage    = 1;
  let pageSize       = 50;

  // ── Build skeleton UI ────────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Audit — Search</h1>
    <hr class="hr">
    <p class="page-desc">
      Query audit events for a service within a date range.
      Select optional filters after results load to narrow the view.
    </p>

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
          <span class="di-status">Loading services…</span>
        </div>
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
  const $searchBtn    = el.querySelector("#aqSearchBtn");
  const $status       = el.querySelector("#aqStatus");
  const $progressWrap = el.querySelector("#aqProgressWrap");
  const $progressBar  = el.querySelector("#aqProgressBar");
  const $resultsZone  = el.querySelector("#aqResultsZone");
  const $resultCount  = el.querySelector("#aqResultCount");
  const $tableBody    = el.querySelector("#aqTableBody");
  const $prevBtn      = el.querySelector("#aqPrevBtn");
  const $nextBtn      = el.querySelector("#aqNextBtn");
  const $pageInfo     = el.querySelector("#aqPageInfo");
  const $pageSizeSel  = el.querySelector("#aqPageSize");

  // ── Date defaults ────────────────────────────────────────────────
  const today       = todayStr();
  const defaultFrom = today;   // default to today, matching Genesys UI behaviour
  const minDate     = daysAgoStr(365);

  $dateFrom.value = defaultFrom;
  $dateTo.value   = today;
  $dateFrom.min   = minDate;
  $dateFrom.max   = today;
  $dateTo.min     = minDate;
  $dateTo.max     = today;

  // ── Single-select dropdowns ──────────────────────────────────────
  const ssService    = createSingleSelect({ placeholder: "— Select service —",  searchable: true,  onChange: () => {} });
  const ssEntityType = createSingleSelect({ placeholder: "All entity types",     searchable: false, onChange: onEntityTypeChange });
  const ssAction     = createSingleSelect({ placeholder: "All actions",          searchable: false, onChange: () => applyFilters() });
  const ssChangedBy  = createSingleSelect({ placeholder: "All users",            searchable: true,  onChange: () => applyFilters() });

  // Replace the "Loading services…" placeholder with the real dropdown
  $serviceDrop.innerHTML = "";
  $serviceDrop.append(ssService.el);

  el.querySelector("#aqEntityTypeDropdown").append(ssEntityType.el);
  el.querySelector("#aqActionDropdown").append(ssAction.el);
  el.querySelector("#aqChangedByDropdown").append(ssChangedBy.el);

  // Client-side filters start disabled (no results yet)
  ssEntityType.setEnabled(false);
  ssAction.setEnabled(false);
  ssChangedBy.setEnabled(false);

  // ── Status / progress helpers ────────────────────────────────────
  function setStatus(msg, cls = "") {
    $status.textContent = msg;
    $status.className   = "di-status" + (cls ? ` di-status--${cls}` : "");
  }

  function showProgress(pct) {
    $progressWrap.style.display = "";
    $progressBar.style.width    = `${Math.min(100, pct)}%`;
  }

  function hideProgress() {
    $progressWrap.style.display = "none";
    $progressBar.style.width    = "0%";
  }

  // ── Load service mapping on mount ───────────────────────────────
  async function loadServiceMapping() {
    setStatus("Loading service mapping…");
    try {
      serviceMapping = await gc.fetchAuditServiceMapping(api, orgId);
      const services = (serviceMapping.services || [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(s => ({ id: s.name, label: s.name }));
      ssService.setItems(services);
      $searchBtn.disabled = false;
      setStatus("");
    } catch (err) {
      setStatus(`Failed to load service mapping: ${friendlyError(err)}`, "error");
    }
  }

  loadServiceMapping();

  // ── Search ───────────────────────────────────────────────────────
  $searchBtn.addEventListener("click", async () => {
    if (isRunning) return;

    const from     = $dateFrom.value;
    const fromTime = $timeFrom.value || "00:00";
    const to       = $dateTo.value;
    const toTime   = $timeTo.value   || "23:59";
    const service  = ssService.getValue();

    if (!from)    return setStatus("Please select a Date From.", "error");
    if (!to)      return setStatus("Please select a Date To.", "error");
    if (!service) return setStatus("Please select a Service.", "error");
    if (from > to || (from === to && fromTime > toTime))
      return setStatus("Date/time From must be before Date/time To.", "error");

    isRunning = true;
    $searchBtn.disabled = true;
    allResults = [];
    actorMap   = {};
    entityNameMap = {};
    $tableBody.innerHTML = "";
    $resultsZone.style.display = "none";

    // Reset client-side filters
    ssEntityType.setValue("");
    ssEntityType.setEnabled(false);
    ssAction.setValue("");
    ssAction.setItems([]);
    ssAction.setEnabled(false);
    ssChangedBy.setValue("");
    ssChangedBy.setEnabled(false);

    try {
      const chunks = buildIntervalChunks(from, fromTime, to, toTime);
      const total  = chunks.length;

      setStatus(`Querying ${total} interval${total !== 1 ? "s" : ""}…`);
      showProgress(0);

      for (let i = 0; i < chunks.length; i++) {
        const interval = chunks[i];
        setStatus(`Fetching interval ${i + 1} of ${total}…`);
        showProgress((i / total) * 85);

        const body = { interval, serviceName: service };

        let txId;
        try {
          txId = await gc.submitAuditQuery(api, orgId, body);
        } catch (err) {
          console.warn(`Chunk ${i + 1} submit failed:`, err.message);
          continue;
        }

        try {
          await gc.pollAuditQuery(api, orgId, txId, {
            onPoll: () => setStatus(`Interval ${i + 1} of ${total}: waiting for results…`),
          });
        } catch (err) {
          console.warn(`Chunk ${i + 1} poll failed:`, err.message);
          continue;
        }

        try {
          const entries = await gc.fetchAuditQueryResults(api, orgId, txId, {
            onProgress: (n) =>
              setStatus(`Interval ${i + 1} of ${total}: fetching results… (${n} so far)`),
          });
          allResults.push(...entries);
        } catch (err) {
          console.warn(`Chunk ${i + 1} result fetch failed:`, err.message);
        }
      }

      showProgress(90);
      setStatus("Resolving names…");
      await resolveActors();
      await resolveEntities();

      // Sort all results latest-first
      allResults.sort((a, b) => {
        const ta = new Date(a.eventDate || a.createdDate || 0).getTime();
        const tb = new Date(b.eventDate || b.createdDate || 0).getTime();
        return tb - ta;
      });

      showProgress(100);
      const n = allResults.length;
      setStatus(`Done — ${n} result${n !== 1 ? "s" : ""} found.`, "success");
      hideProgress();

      populateClientFilters(service);
      currentPage = 1;
      applyFilters();
      $resultsZone.style.display = "";

    } catch (err) {
      setStatus(`Error: ${friendlyError(err)}`, "error");
      hideProgress();
    } finally {
      isRunning = false;
      $searchBtn.disabled = false;
    }
  });

  // ── Entity name resolution ───────────────────────────────────────
  // Maps service+entityType to a Genesys API path function.
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
    // Collect unique (service/entityType, id) pairs that have a resolver
    const toResolve = [];
    for (const entry of allResults) {
      const id      = entry.entity?.id;
      const service = entry.serviceName || "";
      const type    = entry.entityType  || entry.entity?.type || "";
      const key     = `${service}/${type}`;
      if (id && ENTITY_PATH[key] && !entityNameMap[id]) {
        entityNameMap[id] = null; // mark as in-flight
        toResolve.push({ key, id });
      }
    }

    await Promise.all(
      toResolve.map(async ({ key, id }) => {
        try {
          const path = ENTITY_PATH[key](id);
          const res  = await gc.fetchEntityByPath(api, orgId, path);
          entityNameMap[id] = res?.name || id;
        } catch (err) {
          entityNameMap[id] = err?.status === 404
            ? `(deleted) ${id}`
            : id; // other errors (permissions, network) — just show GUID
        }
      }),
    );
  }

  // ── Actor name resolution ────────────────────────────────────────
  // Tries user API first; if that fails (e.g. the actor is an OAuth client
  // rather than a human user), falls back to the OAuth client API.
  // Changes made by this app are attributed to the OAuth client ID.
  async function resolveActors() {
    const ids = [...new Set(allResults.map(e => e.user?.id).filter(Boolean))];
    await Promise.all(
      ids.map(async (userId) => {
        // 1. Try user lookup
        try {
          const user = await gc.getUser(api, orgId, userId);
          if (user?.name) { actorMap[userId] = user.name; return; }
        } catch { /* not a user — try OAuth next */ }

        // 2. Try OAuth client lookup
        try {
          const client = await gc.getOAuthClient(api, orgId, userId);
          if (client?.name) { actorMap[userId] = client.name; return; }
        } catch { /* not an OAuth client either */ }

        // 3. Fall back to raw ID
        actorMap[userId] = userId;
      }),
    );
  }

  // ── Populate client-side filter dropdowns ────────────────────────
  function populateClientFilters(serviceName) {
    const svc = (serviceMapping?.services || []).find(s => s.name === serviceName);
    const entityTypes = (svc?.entities || [])
      .map(e => ({ id: e.name, label: e.name }))
      .sort((a, b) => a.label.localeCompare(b.label));

    ssEntityType.setItems(entityTypes);
    ssEntityType.setEnabled(true);

    // Action stays disabled until entity type is chosen
    ssAction.setItems([]);
    ssAction.setEnabled(false);

    // Changed By — populated from resolved actor names in actual results
    const actorNames = [...new Set(Object.values(actorMap))].sort();
    ssChangedBy.setItems(actorNames.map(n => ({ id: n, label: n })));
    ssChangedBy.setEnabled(true);
  }

  // ── Entity Type change → refresh Action options ──────────────────
  function onEntityTypeChange(entityTypeId) {
    if (!entityTypeId) {
      ssAction.setItems([]);
      ssAction.setEnabled(false);
    } else {
      const serviceName = ssService.getValue();
      const svc    = (serviceMapping?.services || []).find(s => s.name === serviceName);
      const entity = (svc?.entities || []).find(e => e.name === entityTypeId);
      const actions = (entity?.actions || []).map(a => ({ id: a, label: a }));
      ssAction.setItems(actions);
      ssAction.setEnabled(true);
    }
    applyFilters();
  }

  // ── Client-side filtering (AND logic) ───────────────────────────
  function applyFilters() {
    const entityType = ssEntityType.getValue();
    const action     = ssAction.getValue();
    const changedBy  = ssChangedBy.getValue();

    filteredRows = allResults.filter(entry => {
      if (entityType && getEntityType(entry) !== entityType) return false;
      if (action     && entry.action !== action)             return false;
      if (changedBy) {
        const actor = actorMap[entry.user?.id] || entry.user?.name || entry.user?.id || "";
        if (actor !== changedBy) return false;
      }
      return true;
    });

    currentPage = 1;
    renderTable();
  }

  // ── Field extractors ─────────────────────────────────────────────
  function getEntityType(entry) {
    return entry.entity?.type || entry.entityType || "";
  }

  function getEntityName(entry) {
    const id = entry.entity?.id;
    if (id && entityNameMap[id] && entityNameMap[id] !== id) return entityNameMap[id];
    return entry.entity?.name || id || "";
  }

  function getActorName(entry) {
    if (entry.user?.id && actorMap[entry.user.id]) return actorMap[entry.user.id];
    return entry.user?.name || entry.user?.id || "—";
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

      // ── Main row ──────────────────────────────────────
      const tr = document.createElement("tr");
      tr.className = "aq-row";
      tr.innerHTML = `
        <td>${escapeHtml(ts)}</td>
        <td>${escapeHtml(service)}</td>
        <td>${escapeHtml(entityType)}</td>
        <td class="aq-entity-name" title="${escapeHtml(entityName)}">${escapeHtml(entityName)}</td>
        <td>${escapeHtml(action)}</td>
        <td>${escapeHtml(actor)}</td>
        <td class="aq-details-cell">
          <button class="aq-expand-btn" type="button" aria-expanded="false" title="Show changes">▶</button>
        </td>
      `;

      // ── Detail row (hidden by default) ────────────────
      const detailTr = document.createElement("tr");
      detailTr.className = "aq-detail-row";
      detailTr.hidden = true;
      detailTr.innerHTML = `<td colspan="7">${buildDiffHtml(entry, entityName, action, ts)}</td>`;

      // ── Toggle expand / collapse (click anywhere on the row) ──
      const expandBtn = tr.querySelector(".aq-expand-btn");
      function toggleRow() {
        const opening = detailTr.hidden;
        detailTr.hidden = !opening;
        expandBtn.textContent = opening ? "▼" : "▶";
        expandBtn.setAttribute("aria-expanded", String(opening));
      }
      tr.addEventListener("click", toggleRow);

      $tableBody.appendChild(tr);
      $tableBody.appendChild(detailTr);
    }
  }

  // ── Build diff HTML for an expanded row ───────────────────────────
  function buildDiffHtml(entry, entityName, action, ts) {
    // ── Metadata row ─────────────────────────────────────────────
    const metaFields = [
      ["Service",    entry.serviceName],
      ["Entity Type",entry.entityType],
      ["Action",     entry.action],
      ["Level",      entry.level],
      ["Date",       entry.eventDate ? formatDateTime(entry.eventDate) : null],
      ["Remote IP",  (entry.remoteIp || []).filter(Boolean).join(", ") || null],
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

    // ── Changed Properties (real field: propertyChanges) ─────────
    const propChanges = entry.propertyChanges || entry.properties || [];
    let propsHtml = "";
    if (propChanges.length) {
      const rows = propChanges.map(p => {
        const prop   = p.property  ?? p.Property  ?? "";
        // Values come as arrays; join for display
        const oldVal = [].concat(p.oldValues ?? p.oldValue ?? []).join(", ");
        const newVal = [].concat(p.newValues ?? p.newValue ?? []).join(", ");
        return `
          <tr>
            <td class="aq-diff-prop">${escapeHtml(String(prop))}</td>
            <td class="aq-diff-old">${escapeHtml(oldVal)}</td>
            <td class="aq-diff-new">${escapeHtml(newVal)}</td>
          </tr>`;
      }).join("");
      propsHtml = `
        <h4 class="aq-diff-section-title">Changed Properties</h4>
        <table class="data-table aq-diff-table">
          <thead><tr><th>Change</th><th>Old Value</th><th>New Value</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    // ── Additional Context (entry.context plain object) ──────────
    let ctxHtml = "";
    const ctxRaw = entry.context ?? entry.additionalContext ?? null;
    if (ctxRaw) {
      let pairs = [];
      if (Array.isArray(ctxRaw)) {
        pairs = ctxRaw.map(item =>
          typeof item === "object" && item !== null
            ? { k: String(item.key ?? item.name ?? ""), v: String(item.value ?? "") }
            : { k: String(item), v: "" }
        );
      } else if (typeof ctxRaw === "object") {
        pairs = Object.entries(ctxRaw)
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => ({ k, v: String(v) }));
      }
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
    }

    return `${metaHtml}${propsHtml}${ctxHtml}
      <details class="aq-raw-details">
        <summary class="aq-raw-summary">Raw API response</summary>
        <pre class="aq-raw-json">${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
      </details>`;
  }

  return el;
}
