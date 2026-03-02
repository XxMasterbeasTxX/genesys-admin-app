/**
 * Export › Licenses — Consumption
 *
 * Exports a per-user licence consumption report for the selected org.
 * Fixed columns: Name, Email, Division.
 * Dynamic columns: one boolean (TRUE/FALSE) per licence.
 *
 * A "License" filter lets the user restrict to a single licence (showing
 * only users who hold it) or choose "All Licenses" (all users, all licences).
 *
 * Matches the Python script: GUI_Users_Export_Licenses.py
 * Sheet name: "User Licenses"
 */
import { escapeHtml, timestampedFilename } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { sendEmail } from "../../../services/emailService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { STYLE_HEADER, STYLE_ROW_EVEN, STYLE_ROW_ODD } from "../../../utils/excelStyles.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";

// ── Automation ──────────────────────────────────────────
const AUTOMATION_ENABLED = true;
const AUTOMATION_EXPORT_TYPE = "licensesConsumption";
const AUTOMATION_EXPORT_LABEL = "License Consumption";

const FIXED_HEADERS = ["Name", "Email", "Division"];
const ALL_LICENSES  = "All Licenses";

// ── Build rows ──────────────────────────────────────────

/**
 * Join licence-user data with user profile data.
 *
 * @param {object[]} licenseUsers   – [{id, licenses:[string]}]
 * @param {object[]} allUsers       – [{id, name, email, division:{name}}]
 * @param {string}   licenseFilter  – specific licence ID or "All Licenses"
 * @returns {{ rows: object[], licenseColumns: string[] }}
 */
function buildRows(licenseUsers, allUsers, licenseFilter) {
  // Build lookup map: userId → Set<licenceId>
  const licenseMap = new Map();
  for (const entry of licenseUsers) {
    licenseMap.set(entry.id, new Set(entry.licenses || []));
  }

  // Determine which licence columns to produce
  let licenseColumns;
  if (licenseFilter === ALL_LICENSES) {
    const all = new Set();
    for (const [, set] of licenseMap) for (const l of set) all.add(l);
    licenseColumns = Array.from(all).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
  } else {
    licenseColumns = [licenseFilter];
  }

  const rows = [];
  for (const user of allUsers) {
    const name     = user.name  || "N/A";
    const email    = user.email || "N/A";
    const division = user.division?.name || "N/A";

    const userLicenses = licenseMap.get(user.id) || new Set();

    // When filtered to a specific licence, skip users who don't hold it
    if (licenseFilter !== ALL_LICENSES && !userLicenses.has(licenseFilter)) continue;

    const licenseValues = licenseColumns.map(l => userLicenses.has(l));
    rows.push({ name, email, division, licenseValues });
  }

  return { rows, licenseColumns };
}

// ── Build workbook ──────────────────────────────────────

function buildWorkbook(rows, licenseColumns) {
  const XLSX = window.XLSX;
  const headers = [...FIXED_HEADERS, ...licenseColumns];

  const ws = XLSX.utils.aoa_to_sheet([]);

  // Header row
  XLSX.utils.sheet_add_aoa(ws, [headers], { origin: "A1" });
  for (let c = 0; c < headers.length; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[cellRef]) ws[cellRef].s = STYLE_HEADER;
  }

  // Data rows
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    const rowData = [r.name, r.email, r.division, ...r.licenseValues];
    XLSX.utils.sheet_add_aoa(ws, [rowData], { origin: { r: ri + 1, c: 0 } });
    const style = ri % 2 === 0 ? STYLE_ROW_EVEN : STYLE_ROW_ODD;
    for (let c = 0; c < rowData.length; c++) {
      const cellRef = XLSX.utils.encode_cell({ r: ri + 1, c });
      if (ws[cellRef]) ws[cellRef].s = style;
    }
  }

  // Column widths
  ws["!cols"] = [
    { wch: 30 }, // Name
    { wch: 35 }, // Email
    { wch: 25 }, // Division
    ...licenseColumns.map(() => ({ wch: 28 })),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "User Licenses");
  return wb;
}

// ── Page renderer ───────────────────────────────────────

export default function renderLicenseConsumptionExport({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning  = false;
  let cancelled  = false;
  let licDefs    = [];   // [{id}]

  el.innerHTML = `
    <h1 class="h1">Export — Licenses — Consumption</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports a per-user licence consumption report. Fixed columns: Name, Email, Division.
      One boolean column per licence. Use the filter to restrict to a single licence.
    </p>

    <!-- Phase 1: Load licence definitions -->
    <div class="te-actions">
      <button class="btn te-btn-export" id="lcLoadBtn">Load Licenses</button>
    </div>

    <!-- Phase 2: Filter + Export -->
    <div id="lcExportWrap" style="display:none;margin-top:14px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <label class="em-label" for="lcLicenseSelect" style="margin:0">License filter:</label>
        <select id="lcLicenseSelect" class="em-input" style="min-width:260px;max-width:440px"></select>
        <span id="lcLicCount" class="te-user-count"></span>
      </div>
      <div class="te-actions">
        <button class="btn te-btn-export" id="lcExportBtn">Export</button>
        <button class="btn te-btn-cancel" id="lcCancelBtn" style="display:none">Cancel</button>
      </div>
    </div>

    <div class="te-status" id="lcStatus"></div>

    <div class="te-progress-wrap" id="lcProgressWrap" style="display:none">
      <div class="te-progress-bar" id="lcProgressBar"></div>
    </div>

    <div id="lcTableWrap" style="display:none"></div>

    <div class="wc-summary" id="lcSummary" style="display:none"></div>

    <div id="lcDownload" style="display:none">
      <button class="btn te-btn-export" id="lcDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="lcEmailChk">
        <span>Send email with export</span>
      </label>

      <div class="em-fields" id="lcEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="lcEmailTo">Recipients</label>
          <input type="text" class="em-input" id="lcEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="lcEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="lcEmailBody" rows="3"
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
        const defs = await gc.fetchLicenseDefinitions(api, orgId);
        const ids  = defs.map(d => d.id).filter(Boolean).sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: "base" })
        );
        return [{
          key:     "licenseFilter",
          label:   "License filter",
          options: [ALL_LICENSES, ...ids],
        }];
      },
      configSummary: (cfg) => cfg.licenseFilter || ALL_LICENSES,
    });
    el.appendChild(schedulePanel);
  }

  // ── References ────────────────────────────────────────
  const $loadBtn      = el.querySelector("#lcLoadBtn");
  const $exportWrap   = el.querySelector("#lcExportWrap");
  const $licSelect    = el.querySelector("#lcLicenseSelect");
  const $licCount     = el.querySelector("#lcLicCount");
  const $exportBtn    = el.querySelector("#lcExportBtn");
  const $cancelBtn    = el.querySelector("#lcCancelBtn");
  const $status       = el.querySelector("#lcStatus");
  const $progWrap     = el.querySelector("#lcProgressWrap");
  const $progBar      = el.querySelector("#lcProgressBar");
  const $tableWrap    = el.querySelector("#lcTableWrap");
  const $summary      = el.querySelector("#lcSummary");
  const $dlWrap       = el.querySelector("#lcDownload");
  const $dlBtn        = el.querySelector("#lcDownloadBtn");
  const $emailChk     = el.querySelector("#lcEmailChk");
  const $emailFld     = el.querySelector("#lcEmailFields");
  const $emailTo      = el.querySelector("#lcEmailTo");
  const $emailBody    = el.querySelector("#lcEmailBody");

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

  // ── Phase 1: Load Licenses ────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    setStatus("Loading licence definitions…");
    $loadBtn.disabled = true;
    $exportWrap.style.display = "none";

    try {
      licDefs = await gc.fetchLicenseDefinitions(api, org.id);
      licDefs.sort((a, b) =>
        (a.id || "").localeCompare(b.id || "", undefined, { sensitivity: "base" })
      );

      // Populate select
      $licSelect.innerHTML =
        `<option value="${ALL_LICENSES}">${ALL_LICENSES}</option>` +
        licDefs
          .filter(d => d.id)
          .map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.id)}</option>`)
          .join("");

      $licCount.textContent = `${licDefs.length} licence(s)`;
      $exportWrap.style.display = "";
      setStatus(`Loaded ${licDefs.length} licence definitions for ${org.name}. Choose a filter and click Export.`);
    } catch (err) {
      setStatus(`Error loading licence definitions: ${err.message}`, "error");
    } finally {
      $loadBtn.disabled = false;
    }
  });

  // ── Phase 2: Export ───────────────────────────────────
  $exportBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    const licenseFilter = $licSelect.value || ALL_LICENSES;

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
      setStatus("Fetching licence assignments…");
      setProgress(5);

      const licenseUsers = await gc.fetchAllLicenseUsers(api, org.id, {
        onProgress: (n) => setProgress(5 + Math.min((n / 500) * 28, 28)),
      });
      if (cancelled) return;
      setProgress(33);

      setStatus("Fetching user profiles…");
      const allUsers = await gc.fetchAllUsers(api, org.id, {
        expand: ["division"],
        onProgress: (n) => setProgress(33 + Math.min((n / 500) * 33, 33)),
      });
      if (cancelled) return;
      setProgress(66);

      setStatus("Processing…");
      const { rows, licenseColumns } = buildRows(licenseUsers, allUsers, licenseFilter);
      setProgress(75);

      setStatus("Building rows…");
      setProgress(85);

      setStatus("Building Excel…");
      const wb = buildWorkbook(rows, licenseColumns);
      setProgress(95);

      const orgSlug  = org.name.replace(/\s+/g, "_");
      const fname    = timestampedFilename(`LicenseConsumption_${orgSlug}`, "xlsx");
      lastWorkbook   = wb;
      lastFilename   = fname;

      renderPreviewTable(rows, licenseColumns);
      $tableWrap.style.display = "";

      const filterLabel = licenseFilter === ALL_LICENSES
        ? "All Licenses"
        : licenseFilter;
      $summary.textContent =
        `${rows.length} user(s) — ${filterLabel} — ${licenseColumns.length} licence column(s) — ${org.name}`;
      $summary.style.display = "";
      $dlWrap.style.display = "";
      setProgress(100);

      // Email
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const XLSX = window.XLSX;
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
          const result = await sendEmail(api, {
            recipients: $emailTo.value,
            subject: `License Consumption Export — ${org.name} — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
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
        setStatus(
          `Export complete — ${org.name} — ${rows.length} users, ${licenseColumns.length} licence column(s)`,
          "success"
        );
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
    if (!lastWorkbook) return;
    const XLSX = window.XLSX;
    const b64 = XLSX.write(lastWorkbook, { bookType: "xlsx", type: "base64" });
    const helperUrl = new URL("download.html", document.baseURI);
    helperUrl.hash = encodeURIComponent(lastFilename) + "|" + b64;
    const popup = window.open(helperUrl.href, "_blank");
    if (!popup) setStatus("Pop-up blocked. Please allow pop-ups for this site.", "error");
  });

  // ── Email toggle ──────────────────────────────────────
  $emailChk.addEventListener("change", () => {
    $emailFld.style.display = $emailChk.checked ? "" : "none";
  });

  // ── Preview table ─────────────────────────────────────
  function renderPreviewTable(rows, licenseColumns) {
    const headers    = [...FIXED_HEADERS, ...licenseColumns];
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
        ${r.licenseValues.map(v => `<td style="text-align:center">${v ? "✓" : ""}</td>`).join("")}
      </tr>`;
    }

    html += `</tbody></table></div></details>`;
    $tableWrap.innerHTML = html;

    // Dropdown filters for fixed columns (Name, Email, Division) only
    attachColumnFilters($tableWrap, {
      filterCols: Array.from({ length: FIXED_COUNT }, (_, i) => i),
      countEl:    $tableWrap.querySelector(".te-user-count"),
      totalLabel: "users",
    });
  }

  return el;
}
