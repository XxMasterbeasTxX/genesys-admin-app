/**
 * Export › Users — All Groups
 *
 * Exports all users (active, inactive, and deleted) with their group
 * memberships for the selected org. One row per user-group combination.
 * Users with no groups appear as a single row with an empty Group field.
 * The same Index is shared across all group rows for the same user.
 *
 * Flow:
 *   1. Fetch all groups → build groupId → groupName lookup map
 *   2. Fetch all users with expand=groups,team,dateLastLogin (state=any)
 *   3. Build one row per user-group combination
 *   4. Display as collapsible HTML table + downloadable Excel
 *
 * Matches the Python script: GUI_Users_Export_All_Groups.py
 */
import { escapeHtml, timestampedFilename } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { sendEmail } from "../../../services/emailService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { buildStyledWorkbook } from "../../../utils/excelStyles.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";

// ── Automation ──────────────────────────────────────────
const AUTOMATION_ENABLED = true;
const AUTOMATION_EXPORT_TYPE = "allGroups";
const AUTOMATION_EXPORT_LABEL = "Users All Groups";

// ── Columns (matching Python) ───────────────────────────
// Note: Python uses "eMail" and "LastLogin" (not "Email" / "Date Last Login")
const HEADERS = ["Index", "Name", "eMail", "Division", "Active", "LastLogin", "WorkTeam", "Group"];

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
 * Build rows: one row per user-group combination.
 * Users with multiple groups → multiple rows with the same Index.
 * Users with no groups → one row with an empty Group field.
 */
function buildRows(users, groupMap) {
  const rows = [];
  let userIndex = 1;

  for (const user of users) {
    const name      = user.name  || "n/a";
    const email     = user.email || "n/a";
    const division  = user.division?.name || "n/a";
    const active    = user.state || "n/a";
    const lastLogin = formatLastLogin(user.dateLastLogin);
    const workTeam  = user.team?.name || "";

    // Groups: user.groups[] contains {id} objects — look up names in groupMap
    const groupNames = [];
    if (user.groups?.length) {
      for (const g of user.groups) {
        const name = groupMap.get(g.id);
        if (name) groupNames.push(name);
      }
    }

    if (groupNames.length > 0) {
      for (const group of groupNames) {
        rows.push({ index: userIndex, name, email, division, active, lastLogin, workTeam, group });
      }
    } else {
      rows.push({ index: userIndex, name, email, division, active, lastLogin, workTeam, group: "" });
    }

    userIndex++;
  }

  return rows;
}

/**
 * Build styled Excel workbook matching Python formatting.
 * Sheet name: "Users Groups Export"
 */
function buildWorkbook(rows) {
  const wsData = [HEADERS];
  for (const r of rows) {
    wsData.push([r.index, r.name, r.email, r.division, r.active, r.lastLogin, r.workTeam, r.group]);
  }
  return buildStyledWorkbook(wsData, "Users Groups Export");
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderAllGroupsExport({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning = false;
  let cancelled = false;

  el.innerHTML = `
    <h1 class="h1">Export — Users — All Groups</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports all users (active, inactive, and deleted) with their group
      memberships for the selected org. One row per user-group combination.
      Users with no groups appear as a single row with an empty Group field.
    </p>

    <div class="te-actions">
      <button class="btn te-btn-export" id="agExportBtn">Export All Groups</button>
      <button class="btn te-btn-cancel" id="agCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="agStatus"></div>

    <div class="te-progress-wrap" id="agProgressWrap" style="display:none">
      <div class="te-progress-bar" id="agProgressBar"></div>
    </div>

    <div id="agTableWrap" style="display:none"></div>

    <div class="wc-summary" id="agSummary" style="display:none"></div>

    <div id="agDownload" style="display:none">
      <button class="btn te-btn-export" id="agDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="agEmailChk">
        <span>Send email with export</span>
      </label>

      <div class="em-fields" id="agEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="agEmailTo">Recipients</label>
          <input type="text" class="em-input" id="agEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="agEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="agEmailBody" rows="3"
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
  const $btn       = el.querySelector("#agExportBtn");
  const $cancel    = el.querySelector("#agCancelBtn");
  const $status    = el.querySelector("#agStatus");
  const $progWrap  = el.querySelector("#agProgressWrap");
  const $progBar   = el.querySelector("#agProgressBar");
  const $table     = el.querySelector("#agTableWrap");
  const $summary   = el.querySelector("#agSummary");
  const $dlWrap    = el.querySelector("#agDownload");
  const $dlBtn     = el.querySelector("#agDownloadBtn");
  const $emailChk  = el.querySelector("#agEmailChk");
  const $emailFld  = el.querySelector("#agEmailFields");
  const $emailTo   = el.querySelector("#agEmailTo");
  const $emailBody = el.querySelector("#agEmailBody");

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
      // Phase 1: Fetch all groups to build ID → name map (0–15%)
      setStatus("Fetching groups…");
      setProgress(5);
      const allGroups = await gc.fetchAllPages(api, org.id, "/api/v2/groups");
      if (cancelled) return;
      const groupMap = new Map(allGroups.map(g => [g.id, g.name]));
      setProgress(15);

      // Phase 2: Fetch all users with groups + team + dateLastLogin (16–75%)
      setStatus("Fetching users and group memberships…");
      const allUsers = await gc.fetchAllUsers(api, org.id, {
        expand: ["groups", "team", "dateLastLogin"],
        state: "any",
        onProgress: (n) => setProgress(16 + Math.min((n / 500) * 59, 59)),
      });
      if (cancelled) return;
      setProgress(75);

      // Phase 3: Build rows (76–85%)
      setStatus("Processing group memberships…");
      const rows = buildRows(allUsers, groupMap);
      setProgress(85);

      // Phase 4: Build Excel (86–100%)
      setStatus("Building Excel…");
      const wb = buildWorkbook(rows);
      setProgress(95);

      const fname = timestampedFilename(`AllGroups_${org.name.replace(/\s+/g, "_")}`, "xlsx");
      lastWorkbook = wb;
      lastFilename = fname;

      // Show preview table (collapsed by default)
      renderPreviewTable(rows);
      $table.style.display = "";

      // Summary
      const uniqueUsers = new Set(rows.map(r => r.email)).size;
      $summary.textContent = `${uniqueUsers} users, ${rows.length} rows (incl. group duplicates)`;
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
            subject: `All Groups Export — ${org.name} — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
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
        <td>${escapeHtml(r.workTeam)}</td>
        <td>${escapeHtml(r.group)}</td>
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
