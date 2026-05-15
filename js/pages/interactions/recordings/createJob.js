/**
 * Interactions › Recordings › Create Export Job
 *
 * Lets the user submit a Genesys bulk recording export job.
 *
 * Flow:
 *   1. Select customer org
 *   2. Pick date range, integration, optional queue/user filters
 *   3. Submit → POST /api/v2/recording/jobs
 *   4. Show resulting job ID and link to the Jobs page
 *
 * The job runs fully asynchronously in Genesys Cloud — recordings are
 * exported to the configured storage integration. Check the Jobs page
 * for status.
 */
import { escapeHtml, formatDateTime, todayStr, daysAgoStr } from "../../../utils.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import { fetchAllPages } from "../../../services/genesysApi.js";

// Integration type IDs that support recording export
const SUPPORTED_INTEGRATION_TYPES = new Set([
  "amazon-s3",
  "azure-blob-storage",
  "google-cloud-storage",
]);

// Human-readable labels for integration types
const INTEGRATION_TYPE_LABELS = {
  "amazon-s3":            "Amazon S3",
  "azure-blob-storage":   "Azure Blob Storage",
  "google-cloud-storage": "Google Cloud Storage",
};

export default function renderCreateRecordingJob({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  // ── No org selected ──────────────────────────────────────────────
  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Create Recording Export Job</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── Build skeleton ───────────────────────────────────────────────
  const yesterday = daysAgoStr(1);
  const monthAgo  = daysAgoStr(30);

  el.innerHTML = `
    <h1 class="h1">Create Recording Export Job</h1>
    <hr class="hr">

    <p class="page-desc">
      Submit a bulk recording export job for <strong>${escapeHtml(org.name)}</strong>.
      Genesys will scan matching conversations and, once the job is executed,
      export all recordings directly to the selected storage integration.
      Scanning large date ranges can take up to an hour — check the
      <a href="#/interactions/recordings/jobs" class="is-link">Export Jobs</a> page for status.
    </p>

    <div class="rj-status" id="rjStatus"></div>

    <div class="rj-form" id="rjForm">

      <!-- Date range -->
      <div class="rj-field-row">
        <div class="rj-field">
          <label class="rj-label">Date From <span class="rj-required">*</span></label>
          <input type="date" class="input" id="rjDateFrom" value="${monthAgo}" max="${yesterday}">
        </div>
        <div class="rj-field">
          <label class="rj-label">Date To <span class="rj-required">*</span></label>
          <input type="date" class="input" id="rjDateTo" value="${yesterday}" max="${yesterday}">
        </div>
      </div>

      <!-- Storage integration -->
      <div class="rj-field">
        <label class="rj-label">Storage Integration <span class="rj-required">*</span></label>
        <div id="rjIntegrationWrap">
          <p class="sp-empty" style="margin:0">Loading integrations…</p>
        </div>
      </div>

      <!-- Queue filter -->
      <div class="rj-field">
        <label class="rj-label">Queues <span class="rj-hint">(optional — leave blank for all)</span></label>
        <div id="rjQueueWrap">
          <p class="sp-empty" style="margin:0">Loading queues…</p>
        </div>
      </div>

      <!-- User filter -->
      <div class="rj-field">
        <label class="rj-label">Users <span class="rj-hint">(optional — leave blank for all)</span></label>
        <div id="rjUserWrap">
          <p class="sp-empty" style="margin:0">Loading users…</p>
        </div>
      </div>

      <!-- Screen recordings -->
      <div class="rj-field rj-field--inline">
        <label class="rj-check-label">
          <input type="checkbox" id="rjScreenRec" checked>
          Include screen recordings
        </label>
      </div>

      <!-- Action date (when Genesys may purge the job) -->
      <div class="rj-field">
        <label class="rj-label">
          Action Date <span class="rj-required">*</span>
          <span class="rj-hint"> — date by which Genesys should process the export</span>
        </label>
        <input type="date" class="input" id="rjActionDate" style="max-width:200px">
      </div>

      <div class="rj-actions">
        <button class="btn btn-primary" id="rjSubmit">Create Export Job</button>
      </div>
    </div>

    <!-- Result panel (shown after successful submit) -->
    <div class="rj-result" id="rjResult" hidden>
      <div class="rj-result-box">
        <p class="rj-result-title">&#10003; Job created successfully</p>
        <p>Job ID: <code id="rjResultId"></code></p>
        <p>State: <span id="rjResultState"></span></p>
        <p>
          Genesys is now scanning matching conversations. Once the state
          becomes <strong>READY</strong>, you can execute the job from the
          <a href="#/interactions/recordings/jobs" class="is-link">Export Jobs</a> page.
        </p>
      </div>
    </div>
  `;

  // ── Element refs ─────────────────────────────────────────────────
  const $status          = el.querySelector("#rjStatus");
  const $form            = el.querySelector("#rjForm");
  const $dateFrom        = el.querySelector("#rjDateFrom");
  const $dateTo          = el.querySelector("#rjDateTo");
  const $integrationWrap = el.querySelector("#rjIntegrationWrap");
  const $queueWrap       = el.querySelector("#rjQueueWrap");
  const $userWrap        = el.querySelector("#rjUserWrap");
  const $screenRec       = el.querySelector("#rjScreenRec");
  const $actionDate      = el.querySelector("#rjActionDate");
  const $submit          = el.querySelector("#rjSubmit");
  const $result          = el.querySelector("#rjResult");
  const $resultId        = el.querySelector("#rjResultId");
  const $resultState     = el.querySelector("#rjResultState");

  // Default action date: 30 days from now
  const defaultAction = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  $actionDate.value = defaultAction;
  $actionDate.min = todayStr();

  // ── State ────────────────────────────────────────────────────────
  let integrationSelect = null; // <select> element
  let queueMs           = null; // multiSelect instance
  let userMs            = null; // multiSelect instance
  let loadError         = false;

  // ── Status helper ────────────────────────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "rj-status" + (type ? ` rj-status--${type}` : "");
  }
  function clearStatus() {
    $status.textContent = "";
    $status.className = "rj-status";
  }

  // ── Load integrations ────────────────────────────────────────────
  async function loadIntegrations() {
    try {
      // Fetch all integration pages
      const integrations = await fetchAllPages(api, org.id, "/api/v2/integrations", {
        query: { pageSize: "100" },
      });

      // Filter to supported storage types
      const supported = integrations.filter((i) => {
        const typeId = i.integrationType?.id || "";
        return SUPPORTED_INTEGRATION_TYPES.has(typeId);
      });

      $integrationWrap.innerHTML = "";

      if (!supported.length) {
        $integrationWrap.innerHTML = `
          <div class="rj-warn">
            &#9888; No supported storage integrations found for this org.
            A storage integration (Amazon S3, Azure Blob Storage, or Google Cloud Storage)
            must be configured in Genesys Cloud before recordings can be exported.
            Ask a Genesys administrator to set one up under
            <strong>Admin › Integrations</strong>.
          </div>`;
        loadError = true;
        return;
      }

      const sel = document.createElement("select");
      sel.className = "input rj-select";
      sel.style.maxWidth = "420px";

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— Select an integration —";
      sel.append(placeholder);

      for (const i of supported) {
        const typeId    = i.integrationType?.id || "";
        const typeLabel = INTEGRATION_TYPE_LABELS[typeId] || typeId;
        const opt = document.createElement("option");
        opt.value = i.id;
        opt.textContent = `${i.name}  (${typeLabel})`;
        sel.append(opt);
      }

      integrationSelect = sel;
      $integrationWrap.append(sel);
    } catch (err) {
      $integrationWrap.innerHTML = `<p class="rj-error">Failed to load integrations: ${escapeHtml(err.message)}</p>`;
      loadError = true;
    }
  }

  // ── Load queues ──────────────────────────────────────────────────
  async function loadQueues() {
    try {
      const queues = await fetchAllPages(api, org.id, "/api/v2/routing/queues");
      const items  = queues.map((q) => ({ id: q.id, label: q.name }))
                           .sort((a, b) => a.label.localeCompare(b.label));

      $queueWrap.innerHTML = "";
      queueMs = createMultiSelect({ placeholder: "All queues", searchable: true });
      queueMs.setItems(items);
      $queueWrap.append(queueMs.el);
    } catch (err) {
      $queueWrap.innerHTML = `<p class="rj-error">Failed to load queues: ${escapeHtml(err.message)}</p>`;
    }
  }

  // ── Load users ───────────────────────────────────────────────────
  async function loadUsers() {
    try {
      const users = await fetchAllPages(api, org.id, "/api/v2/users", {
        query: { state: "active" },
      });
      const items = users
        .map((u) => ({ id: u.id, label: u.name || u.email || u.id }))
        .sort((a, b) => a.label.localeCompare(b.label));

      $userWrap.innerHTML = "";
      userMs = createMultiSelect({ placeholder: "All users", searchable: true });
      userMs.setItems(items);
      $userWrap.append(userMs.el);
    } catch (err) {
      $userWrap.innerHTML = `<p class="rj-error">Failed to load users: ${escapeHtml(err.message)}</p>`;
    }
  }

  // ── Submit ───────────────────────────────────────────────────────
  $submit.addEventListener("click", async () => {
    clearStatus();

    // Validate
    const from       = $dateFrom.value;
    const to         = $dateTo.value;
    const actionDate = $actionDate.value;
    const intId      = integrationSelect?.value || "";

    if (!from || !to) return setStatus("Please select a date range.", "error");
    if (from > to)    return setStatus("Date From must be before Date To.", "error");
    if (!intId)       return setStatus("Please select a storage integration.", "error");
    if (!actionDate)  return setStatus("Please enter an action date.", "error");

    // Build conversation query
    const interval = `${from}T00:00:00.000Z/${to}T23:59:59.999Z`;
    const conversationQuery = {
      interval,
      order:   "asc",
      orderBy: "conversationStart",
    };

    // Add segment filters for queues and/or users if selected
    const selectedQueues = queueMs ? [...queueMs.getSelected()] : [];
    const selectedUsers  = userMs  ? [...userMs.getSelected()]  : [];

    const segmentFilters = [];

    if (selectedQueues.length) {
      segmentFilters.push({
        type: "and",
        clauses: [{
          type: "or",
          predicates: selectedQueues.map((id) => ({
            type: "dimension",
            dimension: "queueId",
            operator: "matches",
            value: id,
          })),
        }],
      });
    }

    if (selectedUsers.length) {
      segmentFilters.push({
        type: "and",
        clauses: [{
          type: "or",
          predicates: selectedUsers.map((id) => ({
            type: "dimension",
            dimension: "userId",
            operator: "matches",
            value: id,
          })),
        }],
      });
    }

    if (segmentFilters.length) {
      conversationQuery.segmentFilters = segmentFilters;
    }

    const body = {
      action:                "EXPORT",
      actionDate:            `${actionDate}T00:00:00.000Z`,
      integrationId:         intId,
      includeScreenRecordings: $screenRec.checked,
      conversationQuery,
    };

    $submit.disabled = true;
    $submit.textContent = "Creating…";

    try {
      const job = await api.proxyGenesys(org.id, "POST", "/api/v2/recording/jobs", { body });

      // Show result
      $result.hidden = false;
      $resultId.textContent = job.id || "—";
      $resultState.textContent = job.state || "PENDING";
      $form.style.opacity = "0.4";
      $form.style.pointerEvents = "none";
      setStatus("Job created. See result below.", "ok");
    } catch (err) {
      setStatus(`Failed to create job: ${err.message}`, "error");
      $submit.disabled = false;
      $submit.textContent = "Create Export Job";
    }
  });

  // ── Kick off data loads in parallel ──────────────────────────────
  Promise.all([loadIntegrations(), loadQueues(), loadUsers()]);

  return el;
}
