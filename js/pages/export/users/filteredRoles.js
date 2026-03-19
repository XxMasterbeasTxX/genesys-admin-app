/**
 * Export › Users — Filtered on Role(s)
 *
 * Exports active users filtered to those holding at least one of the
 * selected roles. One row per user; one boolean column per selected role
 * (true = user holds that role, false = does not).
 *
 * Flow:
 *   1. Load Roles → fetch all authorization roles for the selected org
 *   2. User picks one or more roles via checkboxes (Select All / None)
 *   3. Export → fetch all active users with expand=authorization
 *             → skip users who hold none of the selected roles
 *             → build: Name, Email, Division + one TRUE/FALSE column per role
 *
 * Matches the Python script: GUI_Users_Export_Roles.py
 * Sheet name: "User Roles"
 */
import { escapeHtml, timestampedFilename } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { sendEmail } from "../../../services/emailService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { buildStyledWorkbook } from "../../../utils/excelStyles.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";
import { logAction } from "../../../services/activityLogService.js";

// ── Automation ──────────────────────────────────────────
const AUTOMATION_ENABLED = true;
const AUTOMATION_EXPORT_TYPE = "filteredRoles";
const AUTOMATION_EXPORT_LABEL = "Users Filtered on Role(s)";

/** Fixed columns that always appear before the dynamic role columns. */
const FIXED_HEADERS = ["Name", "Email", "Division"];

/**
 * Build rows: one per active user who holds ≥1 of the selected roles.
 * roleValues[] is a parallel boolean array matching selectedRoles[].
 */
function buildRows(users, selectedRoles) {
  const rows = [];
  for (const user of users) {
    const name     = user.name  || "N/A";
    const email    = user.email || "N/A";
    const division = user.division?.name || "N/A";

    const userRoles = new Set(
      (user.authorization?.roles || []).map(r => r.name).filter(Boolean)
    );

    // Skip users who hold none of the selected roles
    if (!selectedRoles.some(r => userRoles.has(r))) continue;

    const roleValues = selectedRoles.map(r => userRoles.has(r));
    rows.push({ name, email, division, roleValues });
  }
  return rows;
}

/** Build styled workbook with dynamic role columns. Sheet name: "User Roles". */
function buildWorkbook(rows, selectedRoles) {
  const headers = [...FIXED_HEADERS, ...selectedRoles];
  const wsData = [headers];
  for (const r of rows) {
    wsData.push([r.name, r.email, r.division, ...r.roleValues]);
  }
  return buildStyledWorkbook(wsData, "User Roles");
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderFilteredRolesExport({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning = false;
  let cancelled = false;
  let availableRoles = [];
  let selectedRoles  = [];

  el.innerHTML = `
    <h1 class="h1">Export — Users — Filtered on Role(s)</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports active users filtered to those holding at least one of the
      selected roles. One row per user; one boolean column per selected role.
    </p>

    <!-- Phase 1: Load roles -->
    <div class="te-actions">
      <button class="btn te-btn-export" id="frLoadBtn">Load Roles</button>
    </div>

    <div id="frRolesWrap" style="display:none;margin-top:10px">
      <div class="fr-roles-header" style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span id="frRoleCount" class="te-user-count"></span>
        <button class="btn btn-sm" id="frSelectAll">Select All</button>
        <button class="btn btn-sm" id="frSelectNone">Select None</button>
      </div>
      <div class="fr-roles-scroll" id="frRolesList"
           style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;padding:6px 10px;column-count:3;column-gap:12px"></div>
    </div>

    <!-- Phase 2: Export -->
    <div id="frExportWrap" style="display:none;margin-top:14px">
      <div class="te-actions">
        <button class="btn te-btn-export" id="frExportBtn" disabled>Export Filtered Users</button>
        <button class="btn te-btn-cancel" id="frCancelBtn" style="display:none">Cancel</button>
      </div>
    </div>

    <div class="te-status" id="frStatus"></div>

    <div class="te-progress-wrap" id="frProgressWrap" style="display:none">
      <div class="te-progress-bar" id="frProgressBar"></div>
    </div>

    <div id="frTableWrap" style="display:none"></div>

    <div class="wc-summary" id="frSummary" style="display:none"></div>

    <div id="frDownload" style="display:none">
      <button class="btn te-btn-export" id="frDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="frEmailChk">
        <span>Send email with export</span>
      </label>

      <div class="em-fields" id="frEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="frEmailTo">Recipients</label>
          <input type="text" class="em-input" id="frEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="frEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="frEmailBody" rows="3"
                    placeholder="Leave empty for default message"></textarea>
        </div>
      </div>
    </div>
  `;

  // ── Automation panel ──────────────────────────────────
  if (AUTOMATION_ENABLED) {
    const schedulePanel = createSchedulePanel({
      exportType: AUTOMATION_EXPORT_TYPE,
      exportLabel: AUTOMATION_EXPORT_LABEL,
      me,
      requiresOrg: true,
      dynamicOrgFields: async (orgId) => {
        const roles = await gc.fetchAllAuthorizationRoles(api, orgId);
        return [{
          key: "roles",
          label: "Roles to export",
          options: roles
            .map(r => r.name)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
        }];
      },
      configSummary: (cfg) => {
        const roles = cfg.roles || [];
        if (!roles.length) return "—";
        const shown = roles.slice(0, 2).join(", ");
        return roles.length > 2 ? `${shown} +${roles.length - 2} more` : shown;
      },
    });
    el.appendChild(schedulePanel);
  }

  // ── References ────────────────────────────────────────
  const $loadBtn    = el.querySelector("#frLoadBtn");
  const $rolesWrap  = el.querySelector("#frRolesWrap");
  const $roleCount  = el.querySelector("#frRoleCount");
  const $rolesList  = el.querySelector("#frRolesList");
  const $selectAll  = el.querySelector("#frSelectAll");
  const $selectNone = el.querySelector("#frSelectNone");
  const $exportWrap = el.querySelector("#frExportWrap");
  const $exportBtn  = el.querySelector("#frExportBtn");
  const $cancelBtn  = el.querySelector("#frCancelBtn");
  const $status     = el.querySelector("#frStatus");
  const $progWrap   = el.querySelector("#frProgressWrap");
  const $progBar    = el.querySelector("#frProgressBar");
  const $tableWrap  = el.querySelector("#frTableWrap");
  const $summary    = el.querySelector("#frSummary");
  const $dlWrap     = el.querySelector("#frDownload");
  const $dlBtn      = el.querySelector("#frDownloadBtn");
  const $emailChk   = el.querySelector("#frEmailChk");
  const $emailFld   = el.querySelector("#frEmailFields");
  const $emailTo    = el.querySelector("#frEmailTo");
  const $emailBody  = el.querySelector("#frEmailBody");

  let lastWorkbook = null;
  let lastFilename = null;

  function setStatus(msg, cls) {
    $status.textContent = msg;
    $status.className = "te-status" + (cls ? ` te-status--${cls}` : "");
  }

  function setProgress(pct) {
    $progWrap.style.display = "";
    $progBar.style.width = `${pct}%`;
  }

  function getCheckedRoles() {
    return Array.from($rolesList.querySelectorAll(".fr-role-chk:checked")).map(cb => cb.value);
  }

  function updateExportBtn() {
    $exportBtn.disabled = getCheckedRoles().length === 0;
  }

  // ── Phase 1: Load Roles ───────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    setStatus("Loading roles…");
    $loadBtn.disabled = true;
    $rolesWrap.style.display = "none";
    $exportWrap.style.display = "none";

    try {
      availableRoles = await gc.fetchAllAuthorizationRoles(api, org.id);
      availableRoles.sort((a, b) =>
        (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
      );

      $rolesList.innerHTML = availableRoles.map(r =>
        `<label class="fr-role-item" style="display:block;white-space:nowrap;margin-bottom:3px">
          <input type="checkbox" class="fr-role-chk" value="${escapeHtml(r.name || "")}">
          ${escapeHtml(r.name || "Unnamed")}
        </label>`
      ).join("");

      $rolesList.querySelectorAll(".fr-role-chk").forEach(cb =>
        cb.addEventListener("change", updateExportBtn)
      );

      $roleCount.textContent = `${availableRoles.length} role(s)`;
      $rolesWrap.style.display = "";
      $exportWrap.style.display = "";
      $exportBtn.disabled = true;
      setStatus(`Loaded ${availableRoles.length} roles for ${org.name}. Select at least one and click Export.`);
    } catch (err) {
      setStatus(`Error loading roles: ${err.message}`, "error");
    } finally {
      $loadBtn.disabled = false;
    }
  });

  $selectAll.addEventListener("click", () => {
    $rolesList.querySelectorAll(".fr-role-chk").forEach(cb => { cb.checked = true; });
    updateExportBtn();
  });

  $selectNone.addEventListener("click", () => {
    $rolesList.querySelectorAll(".fr-role-chk").forEach(cb => { cb.checked = false; });
    updateExportBtn();
  });

  // ── Phase 2: Export ───────────────────────────────────
  $exportBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    selectedRoles = getCheckedRoles();
    if (!selectedRoles.length) { setStatus("Select at least one role.", "error"); return; }

    isRunning = true;
    cancelled = false;
    $exportBtn.style.display = "none";
    $cancelBtn.style.display = "";
    $tableWrap.style.display = "none";
    $dlWrap.style.display = "none";
    $summary.style.display = "none";
    setStatus("Starting export…");
    setProgress(0);

    try {
      setStatus(`Fetching active users (${selectedRoles.length} role(s) selected)…`);
      setProgress(5);

      const allUsers = await gc.fetchAllUsers(api, org.id, {
        expand: ["authorization"],
        onProgress: (n) => setProgress(5 + Math.min((n / 500) * 70, 70)),
      });
      if (cancelled) return;
      setProgress(75);

      setStatus("Processing role assignments…");
      const rows = buildRows(allUsers, selectedRoles);
      setProgress(85);

      setStatus("Building Excel…");
      const wb = buildWorkbook(rows, selectedRoles);
      setProgress(95);

      const fname = timestampedFilename(`FilteredRoles_${org.name.replace(/\s+/g, "_")}`, "xlsx");
      lastWorkbook = wb;
      lastFilename = fname;

      renderPreviewTable(rows, selectedRoles);
      $tableWrap.style.display = "";

      $summary.textContent = `${rows.length} matched users out of ${allUsers.length} active users — ${selectedRoles.length} role(s) selected`;
      $summary.style.display = "";
      $dlWrap.style.display = "";
      setProgress(100);
      logAction({ me, orgId: org?.id || "", orgName: org?.name || "", action: "export_run",
        description: `Exported '${AUTOMATION_EXPORT_LABEL}' for '${org?.name || ""}'` });

      // Email
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const XLSX = window.XLSX;
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
          const result = await sendEmail(api, {
            recipients: $emailTo.value,
            subject: `Filtered Roles Export — ${org.name} — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
            body: $emailBody.value,
            attachment: {
              filename: fname,
              base64: xlsxB64,
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          });
          if (result.success) {
            setStatus(`Done. Email sent to: ${$emailTo.value.trim()}`, "success");
          } else {
            setStatus(`Export completed but email failed: ${result.error}`, "error");
          }
        } catch (emailErr) {
          setStatus(`Export completed but email failed: ${emailErr.message}`, "error");
        }
      } else {
        setStatus(`Export complete — ${org.name} — ${rows.length} users, ${selectedRoles.length} roles`, "success");
      }
    } catch (err) {
      if (!cancelled) setStatus(`Error: ${err.message}`, "error");
    } finally {
      isRunning = false;
      $exportBtn.style.display = "";
      $cancelBtn.style.display = "none";
    }
  });

  // ── Cancel ────────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => {
    cancelled = true;
    isRunning = false;
    setStatus("Cancelled.", "error");
    $exportBtn.style.display = "";
    $cancelBtn.style.display = "none";
  });

  // ── Download ──────────────────────────────────────────
  $dlBtn.addEventListener("click", () => {
  if (!lastWorkbook || !lastFilename) return;
  const XLSX = window.XLSX;
  const b64 = XLSX.write(lastWorkbook, { bookType: "xlsx", type: "base64" });
  const key = "xlsx_" + Date.now() + "_" + Math.random().toString(36).slice(2);
  window._xlsxDownload = window._xlsxDownload || {};
  window._xlsxDownload[key] = { filename: lastFilename, b64 };
  const helperUrl = new URL("download.html", document.baseURI);
  helperUrl.hash = key;
  const popup = window.open(helperUrl.href, "_blank");
  if (!popup) { delete window._xlsxDownload[key]; setStatus("Pop-up blocked. Please allow pop-ups for this site.", "error"); }
  });

  // ── Email toggle ──────────────────────────────────────
  $emailChk.addEventListener("change", () => {
    $emailFld.style.display = $emailChk.checked ? "" : "none";
  });

  // ── Preview table with dropdown column filters ──────────
  function renderPreviewTable(rows, roles) {
    const headers = [...FIXED_HEADERS, ...roles];
    const FIXED_COUNT = FIXED_HEADERS.length;

    let html = `<details class="te-details">`;
    html += `<summary class="te-sheet-title">Preview <span class="te-user-count">${rows.length} users</span></summary>`;
    html += `<div class="te-table-scroll"><table class="data-table ll-preview-table"><thead><tr>`;
    for (const h of headers) html += `<th>${escapeHtml(h)}</th>`;
    html += `</tr><tr class="ll-filter-row">`;
    for (let i = 0; i < headers.length; i++) html += `<th></th>`;
    html += `</tr></thead><tbody>`;

    for (const r of rows) {
      html += `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(r.division)}</td>
        ${r.roleValues.map(v => `<td style="text-align:center">${v ? "✓" : ""}</td>`).join("")}
      </tr>`;
    }

    html += `</tbody></table></div></details>`;
    $tableWrap.innerHTML = html;

    // Dropdown filters on all columns (Name, Email, Division + role booleans)
    attachColumnFilters($tableWrap, {
      countEl: $tableWrap.querySelector(".te-user-count"),
      totalLabel: "users",
    });
  }

  return el;
}
