/**
 * Export › Billing › Period Comparison
 *
 * Side-by-side comparison of 2–4 billing periods for a SINGLE organisation,
 * with variance Δ / % columns between adjacent periods (green for positive,
 * red for negative). Mirrors the Python script
 * GUI_Billing_Export_Period_Comparison.py.
 *
 * Sheet layout:
 *
 *   Row 1:  Title "Billing Period Comparison - {orgName}"          (merged, dark blue)
 *   Row 2:  Generated timestamp (italic, merged)
 *   Row 4:  Headers — "License Name" | {period label} (merged x3) | "Variance" (merged x2) | {next period} ...
 *   Row 5:  Sub-headers — "" | Prepay Qty | Usage Qty | Overage Qty | Δ (Absolute) | % (Percentage) | ...
 *   Row 6+: Data rows (one per unique licence across all periods, sorted alphabetically)
 *
 * Variance:
 *   Δ = next.usage − current.usage
 *   %  = (Δ / current.usage) × 100         (0 if both 0; ±9999 if current=0 and Δ≠0)
 *
 * The "licences" list per period is built from the shared
 * `processBillingOverview` output:
 *   - All regular rows (Name → prepay = committed, usage = actualUsage, overage = onDemand).
 *   - When the org used AI tokens (`summary.hasAi`), an extra "AI Tokens" row
 *     with prepay = aiFairUse, usage = aiRollup, overage = aiBillable.
 *   - AI breakdown sub-items are excluded (Python filters grouping `rollup-usage`).
 *
 * No scheduled / no server variant (Python has none; comparison is interactive).
 */
import { timestampedFilename } from "../../../utils.js";
import {
  fetchBillingOverview,
  fetchBillingPeriods,
  clearBillingPeriodsCache,
} from "../../../services/billingService.js";
import { isTrusteeOrg, filterBillableCustomers } from "../../../utils/billingTrustees.js";
import { processBillingOverview } from "../../../utils/billingProcessor.js";
import { orgContext } from "../../../services/orgContext.js";
import { logAction } from "../../../services/activityLogService.js";
import { sendEmail } from "../../../services/emailService.js";

const MIN_PERIODS = 2;
const MAX_PERIODS = 4;
const VARIANCE_ZERO_HANDLING = 9999;     // matches Python BILLING_PERIOD_COMPARISON_SCRIPT_CONFIG
const COLOR_POS = "70AD47";               // green
const COLOR_NEG = "C00C0C";               // red
const COLOR_TITLE_FILL    = "366092";
const COLOR_HEADER_FILL   = "4472C4";
const COLOR_SUBHEADER_FILL = "D9E1F2";
const COLOR_VARIANCE_FILL = "ED7D31";

// ── Comparison-row builder ───────────────────────────────────────────

/**
 * Turn one period's `processBillingOverview` output into the flat license
 * list used by the comparison grid.
 *
 *   Python equivalent (GUI_tab_billing.py::_preview_period_comparison):
 *     - Skip grouping in ('rollup-usage', 'fair-use')
 *     - Regular rows: {name, prepay=committed_qty, usage=actual_qty, overage=on_demand}
 *     - AI rollup row (grouping=='rollup' & 'AI Token' in name) replaced with
 *       {prepay=fair_use, usage=total_used, overage=billable}
 *
 *   Our `processBillingOverview` already does the per-licence overrides and
 *   the AI fair-use math, so we just translate its outputs.
 */
function buildComparisonLicenses(processed) {
  const out = [];
  for (const r of processed.regularRows) {
    out.push({
      name:             r.name,
      prepay_quantity:  typeof r.committed   === "number" ? r.committed   : 0,
      usage_quantity:   typeof r.actualUsage === "number" ? r.actualUsage : 0,
      overage_quantity: typeof r.onDemand    === "number" ? r.onDemand    : 0,
    });
  }
  if (processed.summary.hasAi) {
    out.push({
      name:             "AI Tokens",
      prepay_quantity:  Math.round(processed.summary.aiFairUse),
      usage_quantity:   Math.round(processed.summary.aiRollup),
      overage_quantity: Math.round(processed.summary.aiBillable),
    });
  }
  return out;
}

// ── Workbook builder ─────────────────────────────────────────────────

function buildComparisonWorkbook({ orgName, periodsData }) {
  const XLSX = window.XLSX;
  const wb   = XLSX.utils.book_new();
  const ws   = XLSX.utils.aoa_to_sheet([]);

  const numPeriods = periodsData.length;
  // Total cols: 1 (license name) + 3 per period + 2 per variance gap.
  const totalCols  = 1 + (numPeriods * 3) + ((numPeriods - 1) * 2);

  const BORDER_THIN = {
    top:    { style: "thin", color: { rgb: "999999" } },
    bottom: { style: "thin", color: { rgb: "999999" } },
    left:   { style: "thin", color: { rgb: "999999" } },
    right:  { style: "thin", color: { rgb: "999999" } },
  };
  const STYLE_TITLE = {
    fill:      { fgColor: { rgb: COLOR_TITLE_FILL } },
    font:      { bold: true, sz: 14, color: { rgb: "FFFFFF" }, name: "Calibri" },
    alignment: { horizontal: "center", vertical: "center" },
  };
  const STYLE_META = {
    font:      { italic: true, sz: 10, color: { rgb: "606060" }, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
  };
  const STYLE_HEADER = {
    fill:      { fgColor: { rgb: COLOR_HEADER_FILL } },
    font:      { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border:    BORDER_THIN,
  };
  const STYLE_VARIANCE_HEADER = {
    fill:      { fgColor: { rgb: COLOR_VARIANCE_FILL } },
    font:      { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border:    BORDER_THIN,
  };
  const STYLE_SUBHEADER = {
    fill:      { fgColor: { rgb: COLOR_SUBHEADER_FILL } },
    font:      { bold: true, sz: 10, color: { rgb: "000000" }, name: "Calibri" },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border:    BORDER_THIN,
  };
  const STYLE_NAME = {
    font:      { sz: 10, color: { rgb: "000000" }, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
    border:    BORDER_THIN,
  };
  const STYLE_NUM = {
    font:      { sz: 10, color: { rgb: "000000" }, name: "Calibri" },
    alignment: { horizontal: "right", vertical: "center" },
    numFmt:    "#,##0",
    border:    BORDER_THIN,
  };
  const STYLE_NUM_POS = {
    fill:      { fgColor: { rgb: COLOR_POS } },
    font:      { bold: true, sz: 10, color: { rgb: "FFFFFF" }, name: "Calibri" },
    alignment: { horizontal: "right", vertical: "center" },
    numFmt:    "#,##0",
    border:    BORDER_THIN,
  };
  const STYLE_NUM_NEG = {
    fill:      { fgColor: { rgb: COLOR_NEG } },
    font:      { bold: true, sz: 10, color: { rgb: "FFFFFF" }, name: "Calibri" },
    alignment: { horizontal: "right", vertical: "center" },
    numFmt:    "#,##0",
    border:    BORDER_THIN,
  };
  const STYLE_PCT_POS = { ...STYLE_NUM_POS, numFmt: "0.0%" };
  const STYLE_PCT_NEG = { ...STYLE_NUM_NEG, numFmt: "0.0%" };
  const STYLE_PCT     = { ...STYLE_NUM,     numFmt: "0.0%" };

  const merges = [];

  // -- Row 1: title (merged across all cols)
  setCell(ws, 0, 0, `Billing Period Comparison - ${orgName}`, STYLE_TITLE, "s");
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } });

  // -- Row 2: metadata
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts  = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
              `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  setCell(ws, 1, 0, `Generated: ${ts}`, STYLE_META, "s");
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: totalCols - 1 } });

  // -- Row 4 (index 3): period headers
  // -- Row 5 (index 4): sub-headers
  const HEADER_ROW = 3;
  const SUBHEAD_ROW = 4;
  setCell(ws, HEADER_ROW, 0, "License Name", STYLE_HEADER, "s");
  setCell(ws, SUBHEAD_ROW, 0, "", STYLE_HEADER, "s");
  merges.push({ s: { r: HEADER_ROW, c: 0 }, e: { r: SUBHEAD_ROW, c: 0 } });

  let col = 1;
  for (let i = 0; i < numPeriods; i++) {
    const p = periodsData[i];
    setCell(ws, HEADER_ROW, col, p.label, STYLE_HEADER, "s");
    merges.push({ s: { r: HEADER_ROW, c: col }, e: { r: HEADER_ROW, c: col + 2 } });
    setCell(ws, SUBHEAD_ROW, col,     "Prepay Qty",  STYLE_SUBHEADER, "s");
    setCell(ws, SUBHEAD_ROW, col + 1, "Usage Qty",   STYLE_SUBHEADER, "s");
    setCell(ws, SUBHEAD_ROW, col + 2, "Overage Qty", STYLE_SUBHEADER, "s");
    col += 3;
    if (i < numPeriods - 1) {
      const next = periodsData[i + 1];
      setCell(ws, HEADER_ROW, col,
        `Variance\n(${p.label} → ${next.label})`, STYLE_VARIANCE_HEADER, "s");
      merges.push({ s: { r: HEADER_ROW, c: col }, e: { r: HEADER_ROW, c: col + 1 } });
      setCell(ws, SUBHEAD_ROW, col,     "Δ (Absolute)",   STYLE_SUBHEADER, "s");
      setCell(ws, SUBHEAD_ROW, col + 1, "% (Percentage)", STYLE_SUBHEADER, "s");
      col += 2;
    }
  }

  // -- Collect all unique licence names across all periods
  const allNames = new Set();
  for (const p of periodsData) for (const lic of p.licenses) allNames.add(lic.name);
  const sortedNames = Array.from(allNames).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );

  // -- Data rows
  let r = SUBHEAD_ROW + 1;
  for (const name of sortedNames) {
    const byPeriod = periodsData.map((p) =>
      p.licenses.find((l) => l.name === name) ||
      { prepay_quantity: 0, usage_quantity: 0, overage_quantity: 0 }
    );

    setCell(ws, r, 0, name, STYLE_NAME, "s");
    let c = 1;
    for (let i = 0; i < numPeriods; i++) {
      const lic = byPeriod[i];
      setCell(ws, r, c,     lic.prepay_quantity,  STYLE_NUM, "n");
      setCell(ws, r, c + 1, lic.usage_quantity,   STYLE_NUM, "n");
      setCell(ws, r, c + 2, lic.overage_quantity, STYLE_NUM, "n");
      c += 3;
      if (i < numPeriods - 1) {
        const cur  = lic.usage_quantity;
        const nxt  = byPeriod[i + 1].usage_quantity;
        const delta = nxt - cur;
        let pct;
        if (cur !== 0)            pct = delta / cur;          // stored as ratio for "0.0%" fmt
        else if (delta === 0)     pct = 0;
        else                      pct = (delta > 0 ? VARIANCE_ZERO_HANDLING : -VARIANCE_ZERO_HANDLING) / 100;

        const dStyle = delta > 0 ? STYLE_NUM_POS : delta < 0 ? STYLE_NUM_NEG : STYLE_NUM;
        const pStyle = delta > 0 ? STYLE_PCT_POS : delta < 0 ? STYLE_PCT_NEG : STYLE_PCT;
        setCell(ws, r, c,     delta, dStyle, "n");
        setCell(ws, r, c + 1, pct,   pStyle, "n");
        c += 2;
      }
    }
    r += 1;
  }

  ws["!merges"] = merges;

  // Column widths
  const cols = [{ wch: 42 }];
  for (let i = 1; i < totalCols; i++) cols.push({ wch: 15 });
  ws["!cols"]  = cols;

  // Freeze header (5 rows) + first column
  ws["!views"] = [{ state: "frozen", xSplit: 1, ySplit: SUBHEAD_ROW + 1 }];

  // Set sheet range
  ws["!ref"] = `A1:${XLSX.utils.encode_col(totalCols - 1)}${r}`;

  XLSX.utils.book_append_sheet(wb, ws, "Period Comparison");
  return wb;
}

function setCell(ws, r, c, value, style, type) {
  const XLSX = window.XLSX;
  const addr = XLSX.utils.encode_cell({ r, c });
  ws[addr] = { t: type, v: value };
  if (style) ws[addr].s = style;
}

// ── Page renderer ────────────────────────────────────────────────────

export default function renderBillingPeriodComparisonExport({ me, api }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning    = false;
  let cancelled    = false;
  let lastWorkbook = null;
  let lastFilename = null;
  let availablePeriods = []; // {index, label, error}
  let currentOrg = null;

  const billable = filterBillableCustomers(orgContext.getCustomers());

  el.innerHTML = `
    <h1 class="h1">Export — Billing — Period Comparison</h1>
    <hr class="hr">
    <p class="page-desc">
      Compare ${MIN_PERIODS}–${MAX_PERIODS} billing periods side-by-side for a single
      organisation. Each pair of adjacent periods gets a variance column
      (Δ + %) with green/red highlighting. Matches the Python report.
    </p>

    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <label class="em-label" for="bpcOrg" style="margin:0">Organization:</label>
      <select id="bpcOrg" class="em-input" style="min-width:280px">
        <option value="">Select a customer org…</option>
        ${billable.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}
      </select>
      <button class="btn btn-secondary" id="bpcReloadBtn" type="button" disabled>Reload periods</button>
    </div>

    <div id="bpcPeriodsBox" style="display:none;border:1px solid var(--border, #ddd);border-radius:6px;padding:12px;margin-bottom:10px">
      <div style="margin-bottom:8px">
        <strong>Periods</strong>
        <span class="em-hint">— select ${MIN_PERIODS}–${MAX_PERIODS} (oldest → newest order on the sheet)</span>
      </div>
      <div id="bpcPeriodList"></div>
    </div>

    <div class="te-actions">
      <button class="btn te-btn-export" id="bpcRunBtn" disabled>Run</button>
      <button class="btn te-btn-cancel" id="bpcCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="bpcStatus"></div>

    <div class="te-progress-wrap" id="bpcProgressWrap" style="display:none">
      <div class="te-progress-bar" id="bpcProgressBar"></div>
    </div>

    <div id="bpcDownload" style="display:none;margin-top:10px">
      <button class="btn te-btn-export" id="bpcDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="bpcEmailChk">
        <span>Send email with export</span>
      </label>
      <div class="em-fields" id="bpcEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="bpcEmailTo">Recipients</label>
          <input type="text" class="em-input" id="bpcEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="bpcEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="bpcEmailBody" rows="3"
                    placeholder="Leave empty for default message"></textarea>
        </div>
      </div>
    </div>
  `;

  const $org       = el.querySelector("#bpcOrg");
  const $reload    = el.querySelector("#bpcReloadBtn");
  const $box       = el.querySelector("#bpcPeriodsBox");
  const $list      = el.querySelector("#bpcPeriodList");
  const $runBtn    = el.querySelector("#bpcRunBtn");
  const $cancelBtn = el.querySelector("#bpcCancelBtn");
  const $status    = el.querySelector("#bpcStatus");
  const $progWrap  = el.querySelector("#bpcProgressWrap");
  const $progBar   = el.querySelector("#bpcProgressBar");
  const $dlWrap    = el.querySelector("#bpcDownload");
  const $dlBtn     = el.querySelector("#bpcDownloadBtn");
  const $emailChk  = el.querySelector("#bpcEmailChk");
  const $emailFld  = el.querySelector("#bpcEmailFields");
  const $emailTo   = el.querySelector("#bpcEmailTo");
  const $emailBody = el.querySelector("#bpcEmailBody");

  $emailChk.addEventListener("change", () => {
    $emailFld.style.display = $emailChk.checked ? "" : "none";
  });

  function setStatus(msg, cls) {
    $status.textContent = msg;
    $status.className = "te-status" + (cls ? ` te-status--${cls}` : "");
  }
  function setProgress(pct) {
    $progWrap.style.display = "";
    $progBar.style.width = `${pct}%`;
  }
  function resetProgress() {
    $progWrap.style.display = "none";
    $progBar.style.width = "0%";
  }

  function updateRunButton() {
    const checked = Array.from($list.querySelectorAll(".bpc-period-chk")).filter((c) => c.checked);
    const ok = checked.length >= MIN_PERIODS && checked.length <= MAX_PERIODS;
    $runBtn.disabled = !ok || isRunning;
  }

  function renderPeriodOptions(periods) {
    availablePeriods = periods;
    if (!periods.length || periods.every((p) => p.error)) {
      $list.innerHTML = `<em>No periods available.</em>`;
      $runBtn.disabled = true;
      return;
    }
    $list.innerHTML = periods.map((p) => {
      const label = p.error
        ? `<span style="color:#999">${p.label} (unavailable)</span>`
        : p.label;
      const disabled = p.error ? "disabled" : "";
      return `<label style="display:flex;align-items:center;gap:8px;padding:4px 0">
        <input type="checkbox" class="bpc-period-chk" value="${p.index}" ${disabled}>
        <span>${label}</span>
      </label>`;
    }).join("");
    $list.querySelectorAll(".bpc-period-chk").forEach((c) => {
      c.addEventListener("change", () => {
        const checked = Array.from($list.querySelectorAll(".bpc-period-chk")).filter((x) => x.checked);
        // Enforce MAX limit by un-checking the just-checked box if over.
        if (checked.length > MAX_PERIODS) {
          c.checked = false;
        }
        updateRunButton();
      });
    });
    updateRunButton();
  }

  async function loadPeriodsForOrg(org, { force = false } = {}) {
    lastWorkbook = null;
    lastFilename = null;
    $dlWrap.style.display = "none";
    currentOrg = org || null;

    if (!org) {
      $box.style.display = "none";
      $reload.disabled = true;
      $runBtn.disabled = true;
      setStatus("");
      return;
    }
    if (isTrusteeOrg(org.id)) {
      $box.style.display = "none";
      $reload.disabled = true;
      $runBtn.disabled = true;
      setStatus(`${org.name} is a trustee organisation and cannot be exported as a trustor.`, "error");
      return;
    }

    $box.style.display = "";
    $list.innerHTML = `<em>Loading billing periods…</em>`;
    $reload.disabled = true;
    $runBtn.disabled = true;
    setStatus(`Loading billing periods for ${org.name}…`);
    setProgress(20);

    try {
      if (force) clearBillingPeriodsCache(org.id);
      const periods = await fetchBillingPeriods(api, org.id, { force });
      renderPeriodOptions(periods);
      resetProgress();
      const ok = periods.filter((p) => !p.error).length;
      if (ok === 0) {
        setStatus(`Could not load any billing periods for ${org.name}.`, "error");
      } else if (ok < periods.length) {
        setStatus(`Loaded ${ok}/4 billing periods. Select ${MIN_PERIODS}–${MAX_PERIODS} to compare.`, "warn");
      } else {
        setStatus(`Loaded 4 billing periods. Select ${MIN_PERIODS}–${MAX_PERIODS} to compare.`);
      }
      $reload.disabled = false;
    } catch (err) {
      resetProgress();
      $list.innerHTML = `<em>Failed to load periods.</em>`;
      $reload.disabled = false;
      setStatus(`Error loading billing periods: ${err.message || err}`, "error");
    }
  }

  $org.addEventListener("change", () => {
    const id = $org.value;
    const customer = billable.find((c) => c.id === id);
    loadPeriodsForOrg(customer || null);
  });
  $reload.addEventListener("click", () => {
    if (currentOrg) loadPeriodsForOrg(currentOrg, { force: true });
  });

  $runBtn.addEventListener("click", async () => {
    if (isRunning || !currentOrg) return;

    const checked = Array.from($list.querySelectorAll(".bpc-period-chk")).filter((c) => c.checked);
    if (checked.length < MIN_PERIODS || checked.length > MAX_PERIODS) {
      setStatus(`Select between ${MIN_PERIODS} and ${MAX_PERIODS} periods.`, "error");
      return;
    }

    // Sort chronologically (oldest → newest) by start date — uses the
    // overview stored in the period cache so no extra calls.
    const selected = checked.map((c) => {
      const idx = Number(c.value);
      return availablePeriods.find((p) => p.index === idx);
    }).filter(Boolean);
    selected.sort((a, b) => {
      const aStart = a.overview?.billingPeriodStartDate || "";
      const bStart = b.overview?.billingPeriodStartDate || "";
      return aStart.localeCompare(bStart);
    });

    isRunning    = true;
    cancelled    = false;
    lastWorkbook = null;
    lastFilename = null;
    $runBtn.style.display    = "none";
    $cancelBtn.style.display = "";
    $dlWrap.style.display    = "none";
    setStatus(`Building comparison — ${selected.length} period(s)…`);
    setProgress(0);

    const periodsData = [];
    const failures    = [];

    try {
      for (let i = 0; i < selected.length; i++) {
        if (cancelled) break;
        const p = selected[i];
        setStatus(`Period ${i + 1}/${selected.length}: ${p.label} — processing…`);
        setProgress(Math.round((i / selected.length) * 90));
        try {
          // Re-use the cached overview (saves an API call).
          const ov = p.overview || await fetchBillingOverview(api, currentOrg.id, p.index);
          const processed = processBillingOverview(ov);
          periodsData.push({
            index:     p.index,
            label:     p.label,
            licenses:  buildComparisonLicenses(processed),
          });
        } catch (err) {
          failures.push({ label: p.label, error: err?.message || String(err) });
        }
      }

      if (cancelled) {
        resetProgress();
        setStatus("Cancelled.", "error");
        return;
      }
      if (periodsData.length < MIN_PERIODS) {
        resetProgress();
        const detail = failures.map((f) => `${f.label}: ${f.error}`).join("; ");
        setStatus(`Not enough successful periods (${periodsData.length}). ${detail}`, "error");
        return;
      }

      setStatus("Building workbook…");
      setProgress(95);
      const wb = buildComparisonWorkbook({ orgName: currentOrg.name, periodsData });
      setProgress(100);

      lastWorkbook = wb;
      lastFilename = timestampedFilename(`${currentOrg.name}_Period_Comparison`, "xlsx");
      $dlWrap.style.display = "";

      const failLine = failures.length
        ? ` | failed: ${failures.map((f) => `${f.label} (${f.error})`).join(", ")}`
        : "";
      const doneMsg =
        `Done — ${periodsData.length} period(s) compared for ${currentOrg.name}${failLine}`;
      setStatus(doneMsg, failures.length ? "warn" : "success");

      logAction({
        me,
        action:      "export_run",
        description: `Exported 'Billing — Period Comparison' for ${currentOrg.name} — ${periodsData.length} periods`,
        count:       periodsData.length,
      });

      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const XLSX     = window.XLSX;
          const xlsxB64  = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
          const result   = await sendEmail(api, {
            recipients: $emailTo.value,
            subject:    `[${currentOrg.name}] Billing Period Comparison Export`,
            body:       $emailBody.value,
            attachment: {
              filename: lastFilename,
              base64:   xlsxB64,
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          });
          if (result.success) {
            setStatus(`${doneMsg} | Email sent to: ${$emailTo.value.trim()}`, "success");
          } else {
            setStatus(`${doneMsg} | Email failed: ${result.error}`, "error");
          }
        } catch (emailErr) {
          setStatus(`${doneMsg} | Email failed: ${emailErr.message}`, "error");
        }
      }
    } catch (err) {
      resetProgress();
      setStatus(`Error: ${err.message || err}`, "error");
    } finally {
      isRunning = false;
      $runBtn.style.display    = "";
      $cancelBtn.style.display = "none";
      updateRunButton();
    }
  });

  $cancelBtn.addEventListener("click", () => {
    cancelled = true;
    setStatus("Cancelling…", "error");
  });

  $dlBtn.addEventListener("click", () => {
    if (!lastWorkbook || !lastFilename) return;
    const XLSX = window.XLSX;
    const b64  = XLSX.write(lastWorkbook, { bookType: "xlsx", type: "base64" });
    const key  = "xlsx_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    window._xlsxDownload = window._xlsxDownload || {};
    window._xlsxDownload[key] = { filename: lastFilename, b64 };
    const helperUrl = new URL("download.html", document.baseURI);
    helperUrl.hash = key;
    const popup = window.open(helperUrl.href, "_blank");
    if (!popup) {
      delete window._xlsxDownload[key];
      setStatus("Pop-up blocked. Please allow pop-ups for this site.", "error");
    }
  });

  // Auto-populate from current org context if it's a billable customer.
  const initialOrg = orgContext?.getDetails?.() || null;
  if (initialOrg && billable.some((c) => c.id === initialOrg.id)) {
    $org.value = initialOrg.id;
    loadPeriodsForOrg(initialOrg);
  }

  return el;
}
