/**
 * Export › Users — All Roles
 *
 * Exports all users (active, inactive, and deleted) with their role
 * assignments for the selected org. One row per user-role combination.
 * Users with no roles appear as a single row with an empty Role field.
 * The same Index is shared across all role rows for the same user.
 *
 * Flow:
 *   1. Fetch all users with expand=authorization,dateLastLogin (state=any)
 *   2. Build one row per user-role combination
 *   3. Display as collapsible HTML table + downloadable Excel
 *
 * Matches the Python script: GUI_Users_Export_All_Roles.py
 */
import { escapeHtml, timestampedFilename } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { sendEmail } from "../../../services/emailService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { buildStyledWorkbook } from "../../../utils/excelStyles.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";

// ── Automation ──────────────────────────────────────────
const AUTOMATION_ENABLED = true;
const AUTOMATION_EXPORT_TYPE = "allRoles";
const AUTOMATION_EXPORT_LABEL = "Users All Roles";

// ── Columns (matching Python) ───────────────────────────
const HEADERS = ["Index", "Name", "Email", "Division", "Active", "Date Last Login", "Role"];

/** Format a dateLastLogin value to Danish locale. */
function formatLastLogin(dateStr) {
  if (!dateStr) return "Never";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "Never";
    return d.toLocaleString("da-DK", {
      timeZone: "Europe/Copenhagen",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return "Never"; }
}

/**
 * Build rows: one row per user-role combination.
 * Users with multiple roles → multiple rows with the same Index.
 * Users with no roles → one row with an empty Role field.
 */
function buildRows(users) {
  const rows = [];
  let userIndex = 1;

  for (const user of users) {
    const name      = user.name || "N/A";
    const email     = user.email || "N/A";
    const division  = user.division?.name || "N/A";
    const active    = user.state || "N/A";
    const lastLogin = formatLastLogin(user.dateLastLogin);

    const roleNames = [];
    if (user.authorization?.roles?.length) {
      for (const role of user.authorization.roles) {
        if (role.name) roleNames.push(role.name);
      }
    }

    if (roleNames.length > 0) {
      for (const role of roleNames) {
        rows.push({ index: userIndex, name, email, division, active, lastLogin, role });
      }
    } else {
      rows.push({ index: userIndex, name, email, division, active, lastLogin, role: "" });
    }

    userIndex++;
  }

  return rows;
}

/**
 * Build styled Excel workbook matching Python formatting.
 * Sheet name: "Users Roles Export"
 */
function buildWorkbook(rows) {
  const wsData = [HEADERS];
  for (const r of rows) {
    wsData.push([r.index, r.name, r.email, r.division, r.active, r.lastLogin, r.role]);
  }
  return buildStyledWorkbook(wsData, "Users Roles Export");
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderAllRolesExport({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning = false;
  let cancelled = false;

  el.innerHTML = `
    <h1 class="h1">Export — Users — All Roles</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports all users (active, inactive, and deleted) with their role
      assignments for the selected org. One row per user-role combination.
      Users with no roles appear as a single row with an empty Role field.
    </p>

    <div class="te-actions">
      <button class="btn te-btn-export" id="arExportBtn">Export All Roles</button>
      <button class="btn te-btn-cancel" id="arCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="arStatus"></div>

    <div class="te-progress-wrap" id="arProgressWrap" style="display:none">
      <div class="te-progress-bar" id="arProgressBar"></div>
    </div>

    <div id="arTableWrap" style="display:none"></div>

    <div class="wc-summary" id="arSummary" style="display:none"></div>

    <div id="arDownload" style="display:none">
      <button class="btn te-btn-export" id="arDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="arEmailChk">
        <span>Send email with export</span>
      </label>

      <div class="em-fields" id="arEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="arEmailTo">Recipients</label>
          <input type="text" class="em-input" id="arEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="arEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="arEmailBody" rows="3"
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
    });
    el.appendChild(schedulePanel);
  }

  // ── References ────────────────────────────────────────
  const $btn       = el.querySelector("#arExportBtn");
  const $cancel    = el.querySelector("#arCancelBtn");
  const $status    = el.querySelector("#arStatus");
  const $progWrap  = el.querySelector("#arProgressWrap");
  const $progBar   = el.querySelector("#arProgressBar");
  const $table     = el.querySelector("#arTableWrap");
  const $summary   = el.querySelector("#arSummary");
  const $dlWrap    = el.querySelector("#arDownload");
  const $dlBtn     = el.querySelector("#arDownloadBtn");
  const $emailChk  = el.querySelector("#arEmailChk");
  const $emailFld  = el.querySelector("#arEmailFields");
  const $emailTo   = el.querySelector("#arEmailTo");
  const $emailBody = el.querySelector("#arEmailBody");

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

  // ── Export flow ───────────────────────────────────────
  $btn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    isRunning = true;
    cancelled = false;
    $btn.style.display = "none";
    $cancel.style.display = "";
    $table.style.display = "none";
    $dlWrap.style.display = "none";
    $summary.style.display = "none";
    setStatus("Starting export…");
    setProgress(0);

    try {
      // Phase 1: Fetch all users with roles + dateLastLogin (0–80%)
      setStatus("Fetching users and role assignments…");
      setProgress(5);
      const allUsers = await gc.fetchAllUsers(api, org.id, {
        expand: ["authorization", "dateLastLogin"],
        state: "any",
        onProgress: (n) => setProgress(5 + Math.min((n / 500) * 65, 65)),
      });
      if (cancelled) return;
      setProgress(75);

      // Phase 2: Build rows (76–85%)
      setStatus("Processing role data…");
      const rows = buildRows(allUsers);
      setProgress(85);

      // Phase 3: Build Excel (86–100%)
      setStatus("Building Excel…");
      const wb = buildWorkbook(rows);
      setProgress(95);

      const fname = timestampedFilename(`AllRoles_${org.name.replace(/\s+/g, "_")}`, "xlsx");
      lastWorkbook = wb;
      lastFilename = fname;

      // Show preview table (collapsed by default)
      renderPreviewTable(rows);
      $table.style.display = "";

      // Summary
      const uniqueUsers = new Set(rows.map(r => r.email)).size;
      $summary.textContent = `${uniqueUsers} users, ${rows.length} rows (incl. role duplicates)`;
      $summary.style.display = "";

      // Download button
      $dlWrap.style.display = "";

      setProgress(100);

      // Send email if enabled
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const XLSX = window.XLSX;
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });

          const result = await sendEmail(api, {
            recipients: $emailTo.value,
            subject: `All Roles Export — ${org.name} — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
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
        setStatus(`Export complete — ${org.name}`, "success");
      }
    } catch (err) {
      if (!cancelled) setStatus(`Error: ${err.message}`, "error");
    } finally {
      isRunning = false;
      $btn.style.display = "";
      $cancel.style.display = "none";
    }
  });

  // ── Cancel ────────────────────────────────────────────
  $cancel.addEventListener("click", () => {
    cancelled = true;
    isRunning = false;
    setStatus("Cancelled.", "error");
    $btn.style.display = "";
    $cancel.style.display = "none";
  });

  // ── Download ──────────────────────────────────────────
  $dlBtn.addEventListener("click", () => {
    if (!lastWorkbook) return;
    const XLSX = window.XLSX;
    const b64 = XLSX.write(lastWorkbook, { bookType: "xlsx", type: "base64" });
    const helperUrl = new URL("download.html", document.baseURI);
    helperUrl.hash = encodeURIComponent(lastFilename) + "|" + b64;

    const popup = window.open(helperUrl.href, "_blank");
    if (!popup) {
      setStatus("Pop-up blocked. Please allow pop-ups for this site.", "error");
    }
  });

  // ── Email toggle ──────────────────────────────────────
  $emailChk.addEventListener("change", () => {
    $emailFld.style.display = $emailChk.checked ? "" : "none";
  });

  // ── Preview table with dropdown column filters ──────────
  function renderPreviewTable(rows) {
    let html = `<details class="te-details">`;
    html += `<summary class="te-sheet-title">Preview <span class="te-user-count">${rows.length} rows</span></summary>`;
    html += `<div class="te-table-scroll"><table class="data-table ll-preview-table"><thead><tr>`;
    for (const h of HEADERS) html += `<th>${escapeHtml(h)}</th>`;
    html += `</tr><tr class="ll-filter-row">`;
    for (let i = 0; i < HEADERS.length; i++) html += `<th></th>`;
    html += `</tr></thead><tbody>`;

    for (const r of rows) {
      html += `<tr>
        <td>${r.index}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(r.division)}</td>
        <td>${escapeHtml(r.active)}</td>
        <td>${escapeHtml(r.lastLogin)}</td>
        <td>${escapeHtml(r.role)}</td>
      </tr>`;
    }

    html += `</tbody></table></div></details>`;
    $table.innerHTML = html;

    attachColumnFilters($table, {
      skipCols: [0],
      countEl: $table.querySelector(".te-user-count"),
      totalLabel: "rows",
    });
  }

  return el;
}
