/**
 * Export › Users — Last Login
 *
 * Exports user login data with license information for the selected
 * Genesys Cloud org. Supports optional filtering by login inactivity.
 *
 * Flow:
 *   1. Fetch all license assignments (GET /api/v2/license/users)
 *   2. Fetch all active users with division + dateLastLogin
 *   3. Optionally filter by months of inactivity
 *   4. Build one row per user-license combination
 *   5. Display as HTML table + downloadable Excel
 *
 * Matches the Python script: GUI_Users_Export_LastLogin.py
 */
import { escapeHtml, timestampedFilename } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { sendEmail, validateRecipients } from "../../../services/emailService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";

// ── Automation ──────────────────────────────────────────
const AUTOMATION_ENABLED = true;
const AUTOMATION_EXPORT_TYPE = "lastLogin";
const AUTOMATION_EXPORT_LABEL = "Users Last Login";

// ── Excel style constants (matching Python openpyxl formatting) ─────
const STYLE_HEADER = {
  fill:      { fgColor: { rgb: "366092" } },
  font:      { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "center", vertical: "center" },
  border:    {
    top:    { style: "thin", color: { rgb: "D3D3D3" } },
    bottom: { style: "thin", color: { rgb: "D3D3D3" } },
    left:   { style: "thin", color: { rgb: "D3D3D3" } },
    right:  { style: "thin", color: { rgb: "D3D3D3" } },
  },
};

const STYLE_ROW_EVEN = {
  fill:      { fgColor: { rgb: "F2F2F2" } },
  alignment: { horizontal: "left", vertical: "center" },
  border:    {
    top:    { style: "thin", color: { rgb: "D3D3D3" } },
    bottom: { style: "thin", color: { rgb: "D3D3D3" } },
    left:   { style: "thin", color: { rgb: "D3D3D3" } },
    right:  { style: "thin", color: { rgb: "D3D3D3" } },
  },
};

const STYLE_ROW_ODD = {
  fill:      { fgColor: { rgb: "FFFFFF" } },
  alignment: { horizontal: "left", vertical: "center" },
  border:    {
    top:    { style: "thin", color: { rgb: "D3D3D3" } },
    bottom: { style: "thin", color: { rgb: "D3D3D3" } },
    left:   { style: "thin", color: { rgb: "D3D3D3" } },
    right:  { style: "thin", color: { rgb: "D3D3D3" } },
  },
};

// ── Columns (matching Python) ───────────────────────────
const HEADERS = ["Index", "Name", "Email", "Division", "Date Last Login", "License"];

/** Format a dateLastLogin value. */
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
 * Build rows: one row per user-license combination.
 * Users with multiple licenses → multiple rows.
 * Users with no licenses → one row with empty license.
 */
function buildRows(users, licenseMap) {
  const rows = [];
  for (const user of users) {
    const name = user.name || "N/A";
    const email = user.email || "N/A";
    const division = user.division?.name || "Unknown";
    const lastLogin = formatLastLogin(user.dateLastLogin);

    const licenses = licenseMap.get(user.id);
    if (licenses && licenses.length > 0) {
      for (const lic of licenses.sort()) {
        rows.push({ name, email, division, lastLogin, license: lic });
      }
    } else {
      rows.push({ name, email, division, lastLogin, license: "" });
    }
  }
  return rows;
}

/**
 * Optionally filter users by inactivity period.
 * If filterMonths <= 0, returns all users.
 * If filterMonths > 0, only users who haven't logged in for X months (or never).
 */
function filterByInactivity(users, filterMonths) {
  if (!filterMonths || filterMonths <= 0) return users;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - filterMonths);
  return users.filter(u => {
    if (!u.dateLastLogin) return true; // never logged in
    const d = new Date(u.dateLastLogin);
    return d < cutoff;
  });
}

/**
 * Build styled Excel workbook matching Python formatting.
 */
function buildWorkbook(rows) {
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();

  // Data: [header, ...dataRows]
  const wsData = [HEADERS];
  rows.forEach((r, i) => {
    wsData.push([i + 1, r.name, r.email, r.division, r.lastLogin, r.license]);
  });

  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Header styles
  for (let c = 0; c < HEADERS.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = STYLE_HEADER;
  }

  // Data styles: alternating rows
  for (let r = 0; r < rows.length; r++) {
    const style = (r + 1) % 2 === 0 ? STYLE_ROW_EVEN : STYLE_ROW_ODD;
    for (let c = 0; c < HEADERS.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: r + 1, c });
      if (ws[addr]) ws[addr].s = style;
    }
  }

  // Auto-adjust column widths (max 50, padding +2)
  const colWidths = HEADERS.map((h, i) => {
    let maxLen = h.length;
    for (const row of wsData.slice(1)) {
      const val = String(row[i] ?? "");
      if (val.length > maxLen) maxLen = val.length;
    }
    return { wch: Math.min(maxLen + 2, 50) };
  });
  ws["!cols"] = colWidths;

  // Freeze header row
  ws["!views"] = [{ state: "frozen", ySplit: 1 }];

  // Auto-filter
  ws["!autofilter"] = { ref: ws["!ref"] };

  XLSX.utils.book_append_sheet(wb, ws, "Users Last Login Export");
  return wb;
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderLastLoginExport({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning = false;
  let cancelled = false;

  el.innerHTML = `
    <h1 class="h1">Export — Users — Last Login</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports user login data with license information for the selected org.
      One row per user-license combination. Optionally filter to only show
      users inactive for a given number of months.
    </p>

    <div class="te-actions">
      <div class="ll-filter-group">
        <label for="llFilterMonths">Filter inactive (months):</label>
        <input type="number" id="llFilterMonths" class="sp-form-input ll-filter-input"
               min="0" value="0" placeholder="0 = no filter">
        <span class="sp-form-hint">0 = show all users</span>
      </div>
      <button class="btn te-btn-export" id="llExportBtn">Export Last Login</button>
      <button class="btn te-btn-cancel" id="llCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="llStatus"></div>

    <div class="te-progress-wrap" id="llProgressWrap" style="display:none">
      <div class="te-progress-bar" id="llProgressBar"></div>
    </div>

    <div id="llTableWrap" style="display:none"></div>

    <div class="wc-summary" id="llSummary" style="display:none"></div>

    <div id="llDownload" style="display:none">
      <button class="btn te-btn-export" id="llDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="llEmailChk">
        <span>Send email with export</span>
      </label>
      <div id="llEmailFields" style="display:none">
        <input class="em-input" id="llEmailTo" type="text"
               placeholder="user@example.com, user2@example.com">
        <input class="em-input" id="llEmailSubject" type="text"
               placeholder="Subject">
        <textarea class="em-input" id="llEmailBody" rows="3"
                  placeholder="Optional message body"></textarea>
        <button class="btn te-btn-export" id="llEmailBtn" disabled>Send Email</button>
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
      extraConfigFields: [
        {
          key: "filterMonths",
          label: "Inactive months filter",
          type: "number",
          min: 0,
          default: 0,
          placeholder: "0 = no filter",
          hint: "0 = export all users",
        },
      ],
    });
    el.appendChild(schedulePanel);
  }

  // ── References ────────────────────────────────────────
  const $btn      = el.querySelector("#llExportBtn");
  const $cancel   = el.querySelector("#llCancelBtn");
  const $status   = el.querySelector("#llStatus");
  const $progWrap = el.querySelector("#llProgressWrap");
  const $progBar  = el.querySelector("#llProgressBar");
  const $table    = el.querySelector("#llTableWrap");
  const $summary  = el.querySelector("#llSummary");
  const $dlWrap   = el.querySelector("#llDownload");
  const $dlBtn    = el.querySelector("#llDownloadBtn");
  const $emailChk = el.querySelector("#llEmailChk");
  const $emailFld = el.querySelector("#llEmailFields");
  const $emailBtn = el.querySelector("#llEmailBtn");
  const $filterIn = el.querySelector("#llFilterMonths");

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

    const filterMonths = parseInt($filterIn.value, 10) || 0;

    try {
      // Phase 1: Fetch license data (0–33%)
      setStatus("Fetching license data…");
      setProgress(5);
      const licenseUsers = await gc.fetchAllLicenseUsers(api, org.id, {
        onProgress: (n) => setProgress(5 + Math.min((n / 500) * 28, 28)),
      });
      if (cancelled) return;

      // Build license map: userId → [licenseNames]
      const licenseMap = new Map();
      for (const lu of licenseUsers) {
        licenseMap.set(lu.id, lu.licenses || []);
      }
      setProgress(33);

      // Phase 2: Fetch user data (34–66%)
      setStatus("Fetching user data…");
      const allUsers = await gc.fetchAllUsers(api, org.id, {
        expand: ["division", "dateLastLogin"],
        state: "any",
        onProgress: (n) => setProgress(34 + Math.min((n / 500) * 32, 32)),
      });
      if (cancelled) return;
      setProgress(66);

      // Phase 3: Filter (67–75%)
      setStatus("Processing data…");
      const filtered = filterByInactivity(allUsers, filterMonths);
      setProgress(75);

      // Phase 4: Build rows + Excel (76–100%)
      setStatus("Building Excel…");
      const rows = buildRows(filtered, licenseMap);
      setProgress(85);

      const wb = buildWorkbook(rows);
      setProgress(95);

      const fname = timestampedFilename(`LastLogin_${org.name.replace(/\s+/g, "_")}`, "xlsx");
      lastWorkbook = wb;
      lastFilename = fname;

      // Show preview table
      renderPreviewTable(rows);
      $table.style.display = "";

      // Summary
      const uniqueUsers = new Set(rows.map(r => r.email)).size;
      $summary.textContent =
        `${uniqueUsers} users, ${rows.length} rows (incl. license duplicates)` +
        (filterMonths > 0 ? ` — filtered: inactive ≥ ${filterMonths} months` : "");
      $summary.style.display = "";

      // Download button
      $dlWrap.style.display = "";

      setProgress(100);
      setStatus(`Export complete — ${org.name}`, "success");
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

  $emailBtn.addEventListener("click", async () => {
    if (!lastWorkbook) return;

    const to = el.querySelector("#llEmailTo").value.trim();
    const subject = el.querySelector("#llEmailSubject").value.trim();
    const body = el.querySelector("#llEmailBody").value.trim();

    const { valid, error: valErr } = validateRecipients(to);
    if (!valid) { setStatus(valErr, "error"); return; }

    const XLSX = window.XLSX;
    const wbout = XLSX.write(lastWorkbook, { bookType: "xlsx", type: "base64" });

    $emailBtn.disabled = true;
    $emailBtn.textContent = "Sending…";
    try {
      await sendEmail({
        to, subject: subject || lastFilename,
        body: body || "Users Last Login export attached.",
        attachments: [{
          filename: lastFilename,
          content: wbout,
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }],
      });
      setStatus("Email sent.", "success");
    } catch (err) {
      setStatus(`Email failed: ${err.message}`, "error");
    } finally {
      $emailBtn.disabled = false;
      $emailBtn.textContent = "Send Email";
    }
  });

  // Enable email send button when any workbook is ready
  const enableEmailBtn = () => { $emailBtn.disabled = !lastWorkbook; };
  el.querySelector("#llEmailTo").addEventListener("input", enableEmailBtn);

  // ── Preview table ─────────────────────────────────────
  function renderPreviewTable(rows) {
    const maxPreview = 500;
    const show = rows.slice(0, maxPreview);

    let html = `<table class="data-table"><thead><tr>`;
    for (const h of HEADERS) html += `<th>${escapeHtml(h)}</th>`;
    html += `</tr></thead><tbody>`;

    show.forEach((r, i) => {
      html += `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(r.division)}</td>
        <td>${escapeHtml(r.lastLogin)}</td>
        <td>${escapeHtml(r.license)}</td>
      </tr>`;
    });

    html += `</tbody></table>`;
    if (rows.length > maxPreview) {
      html += `<p class="sp-form-hint">Showing first ${maxPreview} of ${rows.length} rows</p>`;
    }
    $table.innerHTML = html;
  }

  return el;
}
