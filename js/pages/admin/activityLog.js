/**
 * Admin — Activity Log
 *
 * Displays a searchable, filterable table of all logged user actions.
 *
 * Access rules:
 *   - Any authenticated user can view their own entries.
 *   - Admin (thva@tdc.dk) can view all users' entries.
 *
 * API: GET /api/activity-log?userEmail={email}&all=true&limit=500
 */
import { escapeHtml, formatDateTime } from "../../utils.js";

const ADMIN_EMAIL = "thva@tdc.dk";

// ── Action labels ────────────────────────────────────────
const ACTION_LABELS = {
  division_move:          "Division Move",
  interaction_move:       "Interaction Move",
  interaction_disconnect: "Interaction Disconnect",
  datatable_copy:         "Data Table Copy",
  dataaction_copy:        "Data Action Copy",
  dataaction_save:        "Data Action Save",
  dataaction_publish:     "Data Action Publish",
  phone_create:           "Phone Create",
  phone_move:             "Phone Move",
  schedule_create:        "Schedule Create",
  schedule_update:        "Schedule Update",
  schedule_delete:        "Schedule Delete",
  gdpr_request:           "GDPR Request",
  export_run:             "Export Run",
};

function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

function resultBadge(result) {
  const cls =
    result === "success" ? "al-badge al-badge--success" :
    result === "partial" ? "al-badge al-badge--partial" :
                           "al-badge al-badge--failure";
  return `<span class="${cls}">${escapeHtml(result)}</span>`;
}

// ── Page renderer ────────────────────────────────────────

export default async function renderActivityLog({ me }) {
  const el = document.createElement("section");
  el.className = "card";

  const isAdmin = me?.email?.toLowerCase() === ADMIN_EMAIL;

  el.innerHTML = `
    <div class="al-header">
      <div>
        <h2 class="h2">Activity Log</h2>
        <p class="page-desc">
          ${isAdmin
            ? "All user activity across the app (admin view). Entries older than 12 months are automatically purged."
            : "Your own activity log. Shows actions you have performed in the app."}
        </p>
      </div>
      <button class="btn al-refresh-btn" id="alRefreshBtn">Refresh</button>
    </div>

    <hr class="hr">

    <!-- Filters -->
    <div class="al-filters" id="alFilters">
      <div class="di-control-group">
        <label class="di-label">From</label>
        <input type="date" class="input" id="alFrom">
      </div>
      <div class="di-control-group">
        <label class="di-label">To</label>
        <input type="date" class="input" id="alTo">
      </div>
      <div class="di-control-group">
        <label class="di-label">Result</label>
        <select class="input" id="alResult">
          <option value="">All</option>
          <option value="success">Success</option>
          <option value="partial">Partial</option>
          <option value="failure">Failure</option>
        </select>
      </div>
      <div class="di-control-group">
        <label class="di-label">Action</label>
        <select class="input" id="alAction">
          <option value="">All</option>
          ${Object.entries(ACTION_LABELS).map(([k, v]) =>
            `<option value="${escapeHtml(k)}">${escapeHtml(v)}</option>`
          ).join("")}
        </select>
      </div>
      ${isAdmin ? `
      <div class="di-control-group">
        <label class="di-label">User</label>
        <select class="input" id="alUser">
          <option value="">All users</option>
        </select>
      </div>` : ""}
    </div>

    <!-- Status / loading -->
    <p class="al-status" id="alStatus">Loading…</p>

    <!-- Table -->
    <div class="al-table-wrap" id="alTableWrap" style="display:none">
      <table class="al-table">
        <thead>
          <tr>
            <th>Date &amp; Time</th>
            ${isAdmin ? "<th>User</th>" : ""}
            <th>Org</th>
            <th>Action</th>
            <th>Description</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody id="alTbody"></tbody>
      </table>
      <p class="al-count" id="alCount"></p>
    </div>
  `;

  const $status    = el.querySelector("#alStatus");
  const $tableWrap = el.querySelector("#alTableWrap");
  const $tbody     = el.querySelector("#alTbody");
  const $count     = el.querySelector("#alCount");
  const $from      = el.querySelector("#alFrom");
  const $to        = el.querySelector("#alTo");
  const $result    = el.querySelector("#alResult");
  const $action    = el.querySelector("#alAction");
  const $user      = el.querySelector("#alUser");   // null for non-admin
  const $refresh   = el.querySelector("#alRefreshBtn");

  let allEntries = [];

  // ── Set default date range: last 7 days ──────────────
  const today = new Date();
  const week  = new Date(today);
  week.setDate(week.getDate() - 6);
  $to.value   = today.toISOString().slice(0, 10);
  $from.value = week.toISOString().slice(0, 10);

  // ── Fetch entries ────────────────────────────────────
  async function loadEntries() {
    $status.textContent  = "Loading…";
    $status.style.display = "";
    $tableWrap.style.display = "none";
    $refresh.disabled = true;

    try {
      const params = new URLSearchParams({ userEmail: me.email });
      if (isAdmin) params.set("all", "true");

      const resp  = await fetch(`/api/activity-log?${params}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data  = await resp.json();

      allEntries = data.entries || [];

      // Populate user filter (admin only)
      if ($user && allEntries.length) {
        const emails = [...new Set(allEntries.map(e => e.userEmail).filter(Boolean))].sort();
        const current = $user.value;
        $user.innerHTML = `<option value="">All users</option>` +
          emails.map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join("");
        if (current) $user.value = current;
      }

      $status.style.display = "none";
      renderTable();
    } catch (err) {
      $status.textContent = `Failed to load activity log: ${err.message}`;
    } finally {
      $refresh.disabled = false;
    }
  }

  // ── Render table with active filters ─────────────────
  function renderTable() {
    const fromStr = $from.value;
    const toStr   = $to.value;
    const result  = $result.value;
    const action  = $action.value;
    const user    = $user?.value || "";

    const filtered = allEntries.filter(e => {
      if (fromStr && e.logTimestamp < fromStr) return false;
      if (toStr   && e.logTimestamp > toStr + "T23:59:59Z") return false;
      if (result  && e.result !== result) return false;
      if (action  && e.action !== action) return false;
      if (user    && e.userEmail?.toLowerCase() !== user.toLowerCase()) return false;
      return true;
    });

    if (!filtered.length) {
      $status.textContent   = "No log entries match the selected filters.";
      $status.style.display = "";
      $tableWrap.style.display = "none";
      return;
    }

    $status.style.display   = "none";
    $tableWrap.style.display = "";

    $tbody.innerHTML = filtered.map(e => `
      <tr class="al-row${e.result === "failure" ? " al-row--fail" : e.result === "partial" ? " al-row--partial" : ""}">
        <td class="al-cell-time">${escapeHtml(formatDateTime(e.logTimestamp))}</td>
        ${isAdmin ? `<td class="al-cell-user" title="${escapeHtml(e.userEmail)}">${escapeHtml(e.userName || e.userEmail)}</td>` : ""}
        <td class="al-cell-org">${escapeHtml(e.orgName || e.orgId || "—")}</td>
        <td class="al-cell-action"><span class="al-action-tag">${escapeHtml(actionLabel(e.action))}</span></td>
        <td class="al-cell-desc">
          ${escapeHtml(e.description)}
          ${e.errorMessage ? `<br><span class="al-error-detail">${escapeHtml(e.errorMessage)}</span>` : ""}
        </td>
        <td class="al-cell-result">${resultBadge(e.result)}</td>
      </tr>
    `).join("");

    $count.textContent = `Showing ${filtered.length} of ${allEntries.length} entr${allEntries.length !== 1 ? "ies" : "y"}`;
  }

  // ── Event listeners ───────────────────────────────────
  [$from, $to, $result, $action].forEach(el => {
    if (el) el.addEventListener("change", renderTable);
  });
  if ($user) $user.addEventListener("change", renderTable);
  $refresh.addEventListener("click", loadEntries);

  // Initial load
  await loadEntries();

  return el;
}
