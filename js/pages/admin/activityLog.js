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
import { withUserToken } from "../../services/apiAuth.js";

const ADMIN_EMAIL = "thva@tdc.dk";

// ── Action labels ────────────────────────────────────────
const ACTION_LABELS = {
  division_move:          "Division Move",
  interaction_move:       "Interaction Move",
  interaction_disconnect: "Interaction Disconnect",
  datatable_create:       "Data Table Create",
  datatable_copy:         "Data Table Copy",
  dataaction_copy:        "Data Action Copy",
  dataaction_save:        "Data Action Save",
  dataaction_publish:     "Data Action Publish",
  deployment_basic:       "Deployment — Basic",
  deployment_onboarding:  "Deployment — Onboarding",
  deployment_onboarding_preview: "Deployment — Onboarding (previewed only)",
  flow_delete:            "Flow Delete",
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

// ── Structured details (expandable row) ──────────────────
// Written today by the onboarding runner; any writer can supply the same shape:
//   { summary: {…}, phases: [ { phase, items: [ { old, new, status, detail } ],
//     omitted } ], warnings: [ "…" ], truncated }

// Item status → glyph + modifier class. Matches the onboarding page's vocabulary
// so the same deploy reads identically in both places. `none` is informational
// ("No scripts found") and is deliberately excluded from the phase counts.
const ITEM_GLYPH = { ok: "✓", error: "✗", skipped: "↷", none: "–", planned: "+" };

/** "targetOrgName" → "Target org name" — labels summary keys we don't know. */
function humanizeKey(key) {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

const SUMMARY_LABELS = {
  jobId:          "Job",
  plannedObjects: "Would have been created",
  sourceOrgName:  "Source org",
  targetOrgName:  "Target org",
  division:       "Division",
  namePrefix:     "Name prefix",
  rootFlows:      "Selected callflows",
  created:        "Created",
  skipped:        "Skipped",
  failed:         "Failed",
  startedAt:      "Started",
  finishedAt:     "Finished",
};

// Ids duplicate the names already shown, and `status` duplicates the result badge.
const SUMMARY_HIDDEN = new Set(["sourceOrgId", "targetOrgId", "status"]);

function summaryValue(key, value) {
  if (Array.isArray(value)) return value.join(", ");
  if (key === "startedAt" || key === "finishedAt") return formatDateTime(value);
  return String(value);
}

function summaryHtml(summary) {
  const rows = Object.entries(summary)
    .filter(([k, v]) =>
      !SUMMARY_HIDDEN.has(k) && v !== null && v !== "" &&
      !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `
      <div class="al-sum-item">
        <span class="al-sum-key">${escapeHtml(SUMMARY_LABELS[k] || humanizeKey(k))}</span>
        <span class="al-sum-val">${escapeHtml(summaryValue(k, v))}</span>
      </div>`)
    .join("");
  return rows ? `<div class="al-sum">${rows}</div>` : "";
}

function itemHtml(item) {
  const status = ITEM_GLYPH[item.status] ? item.status : "ok";
  // "Template - Sales" → "Sales" renames read best as old → new.
  const renamed = item.old && item.new && item.old !== item.new;
  const label = renamed
    ? `${escapeHtml(item.old)} <span class="al-item-arrow">→</span> ${escapeHtml(item.new)}`
    : escapeHtml(item.new || item.old || "—");
  return `
    <li class="al-item al-item--${status}">
      <span class="al-item-glyph">${ITEM_GLYPH[status]}</span>
      <span class="al-item-name">${label}</span>
      ${item.detail ? `<span class="al-item-detail">${escapeHtml(item.detail)}</span>` : ""}
    </li>`;
}

function phaseHtml(phase) {
  const items = phase.items || [];
  const counts = ["ok", "skipped", "error", "planned"]
    .map(s => [s, items.filter(i => i.status === s).length])
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s === "ok" ? "ok" : s}`)
    .join(" · ");
  return `
    <div class="al-phase">
      <div class="al-phase-head">
        <span class="al-phase-name">${escapeHtml(phase.phase || "—")}</span>
        ${counts ? `<span class="al-phase-counts">${escapeHtml(counts)}</span>` : ""}
      </div>
      <ul class="al-items">${items.map(itemHtml).join("")}</ul>
      ${phase.omitted ? `<p class="al-omitted">…and ${phase.omitted} more not stored</p>` : ""}
    </div>`;
}

function detailsHtml(details) {
  if (!details || typeof details !== "object") return "";
  const parts = [];

  if (details.summary) parts.push(summaryHtml(details.summary));

  for (const phase of details.phases || []) parts.push(phaseHtml(phase));

  if (details.warnings?.length) {
    parts.push(`
      <ul class="al-warnings">
        ${details.warnings.map(w => `<li>⚠ ${escapeHtml(String(w))}</li>`).join("")}
      </ul>`);
  }

  if (details.error) {
    parts.push(`<p class="al-detail-error">${escapeHtml(String(details.error))}</p>`);
  }

  if (details.truncated) {
    parts.push(`<p class="al-omitted">Detail list was shortened to fit the log entry.</p>`);
  }

  return parts.join("") || `<p class="al-omitted">No further detail recorded.</p>`;
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
        <label class="di-label">Org</label>
        <select class="input" id="alOrg">
          <option value="">All orgs</option>
        </select>
      </div>
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
  const $org       = el.querySelector("#alOrg");    // null for non-admin
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

      const resp  = await fetch(`/api/activity-log?${params}`, { headers: withUserToken() });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data  = await resp.json();

      allEntries = data.entries || [];

      // Populate org filter (admin only)
      if ($org && allEntries.length) {
        const orgs = [...new Map(
          allEntries
            .filter(e => e.orgId)
            .map(e => [e.orgId, e.orgName || e.orgId])
        ).entries()].sort((a, b) => a[1].localeCompare(b[1]));
        const currentOrg = $org.value;
        $org.innerHTML = `<option value="">All orgs</option>` +
          orgs.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
        if (currentOrg) $org.value = currentOrg;
      }

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
    const org     = $org?.value  || "";
    const user    = $user?.value || "";

    const filtered = allEntries.filter(e => {
      if (fromStr && e.logTimestamp < fromStr) return false;
      if (toStr   && e.logTimestamp > toStr + "T23:59:59Z") return false;
      if (result  && e.result !== result) return false;
      if (action  && e.action !== action) return false;
      if (org     && e.orgId !== org) return false;
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

    const colSpan = isAdmin ? 6 : 5;

    $tbody.innerHTML = filtered.map((e, i) => {
      const hasDetails = !!e.details && typeof e.details === "object";
      return `
      <tr class="al-row${e.result === "failure" ? " al-row--fail" : e.result === "partial" ? " al-row--partial" : ""}">
        <td class="al-cell-time">${escapeHtml(formatDateTime(e.logTimestamp))}</td>
        ${isAdmin ? `<td class="al-cell-user" title="${escapeHtml(e.userEmail)}">${escapeHtml(e.userName || e.userEmail)}</td>` : ""}
        <td class="al-cell-org">${escapeHtml(e.orgName || e.orgId || "—")}</td>
        <td class="al-cell-action"><span class="al-action-tag">${escapeHtml(actionLabel(e.action))}</span></td>
        <td class="al-cell-desc">
          ${escapeHtml(e.description)}
          ${e.errorMessage ? `<br><span class="al-error-detail">${escapeHtml(e.errorMessage)}</span>` : ""}
          ${hasDetails ? `
            <button type="button" class="al-details-toggle" data-idx="${i}"
                    aria-expanded="false" aria-controls="alDetails${i}">
              <span class="al-caret">▸</span> Details
            </button>` : ""}
        </td>
        <td class="al-cell-result">${resultBadge(e.result)}</td>
      </tr>
      ${hasDetails ? `
      <tr class="al-details-row" id="alDetails${i}" hidden>
        <td colspan="${colSpan}"><div class="al-details">${detailsHtml(e.details)}</div></td>
      </tr>` : ""}`;
    }).join("");

    $count.textContent = `Showing ${filtered.length} of ${allEntries.length} entr${allEntries.length !== 1 ? "ies" : "y"}`;
  }

  // ── Event listeners ───────────────────────────────────

  // Delegated: the table body is rebuilt on every filter change.
  $tbody.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".al-details-toggle");
    if (!btn) return;
    const row = el.querySelector(`#alDetails${btn.dataset.idx}`);
    if (!row) return;
    const open = row.hidden;
    row.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.querySelector(".al-caret").textContent = open ? "▾" : "▸";
  });

  [$from, $to, $result, $action].forEach(el => {
    if (el) el.addEventListener("change", renderTable);
  });
  if ($org)  $org.addEventListener("change", renderTable);
  if ($user) $user.addEventListener("change", renderTable);
  $refresh.addEventListener("click", loadEntries);

  // Initial load
  await loadEntries();

  return el;
}
