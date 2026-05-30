/**
 * Export › Billing › Date Range
 *
 * Exports billing data for every billable customer org across a user-chosen
 * date range (month-level granularity). Mirrors the Python script
 * GUI_Billing_Export_Date_Range.py — same per-org sheet layout:
 *
 *   ═══ {orgName} - Date Range: {Mmm YYYY} to {Mmm YYYY} ═══   (blue metadata)
 *   Completed Periods: N
 *
 *   ═══ PERIOD: YYYY-MM-DD to YYYY-MM-DD ═══     ← repeated per period (blue)
 *   ─── BILLING SUMMARY ───                      (green)
 *   License Type / Billable Items / [AI summary]
 *   ─── REGULAR LICENSES ───
 *   ─── AI TOKENS USAGE BREAKDOWN … ─── (if any)
 *   ─── ITEMS WITH OVERAGE AND OTHER BILLABLE ITEMS ─── (if any)
 *
 * One sheet per organisation, sheet name = org name (truncated to 31 chars).
 *
 * Trustee orgs (e.g. Demo, Test IE) are excluded — they cannot be exported
 * as trustors.
 *
 * Per-org failures are tolerated; the status line lists the failing orgs.
 *
 * No scheduled variant — there is no Python equivalent, and the date range
 * requires explicit user-chosen dates.
 */
import { timestampedFilename } from "../../../utils.js";
import {
  fetchBillingPeriodsForDateRange,
  MONTH_ABBR,
} from "../../../services/billingService.js";
import { filterBillableCustomers } from "../../../utils/billingTrustees.js";
import { processBillingOverview } from "../../../utils/billingProcessor.js";
import { buildDateRangeSheet } from "../../../utils/billingExcelStyles.js";
import { orgContext } from "../../../services/orgContext.js";
import { logAction } from "../../../services/activityLogService.js";
import { sendEmail } from "../../../services/emailService.js";

const YEAR_DROPDOWN_COUNT = 5; // current year + 4 previous

const MONTH_FULL = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function buildYearOptions() {
  const current = new Date().getUTCFullYear();
  const years   = [];
  for (let i = 0; i < YEAR_DROPDOWN_COUNT; i++) years.push(current - i);
  return years;
}

/** Last day of (year, monthIdx) — monthIdx is 0-based. */
function lastDayOfMonth(year, monthIdx) {
  // new Date(year, monthIdx + 1, 0) → last day of monthIdx (local).
  // Use UTC parts so we stay consistent with the rest of the app.
  const d = new Date(Date.UTC(year, monthIdx + 1, 1));
  d.setUTCDate(0);
  return d.getUTCDate();
}

export default function renderBillingDateRangeExport({ me, api }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning    = false;
  let cancelled    = false;
  let lastWorkbook = null;
  let lastFilename = null;

  const yearOpts = buildYearOptions();
  const now      = new Date();
  // Default range = last 3 completed months ending with previous month.
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const fromDef   = new Date(Date.UTC(prevMonth.getUTCFullYear(), prevMonth.getUTCMonth() - 2, 1));
  const defaultFromMonth = fromDef.getUTCMonth();
  const defaultFromYear  = fromDef.getUTCFullYear();
  const defaultToMonth   = prevMonth.getUTCMonth();
  const defaultToYear    = prevMonth.getUTCFullYear();

  const monthOptHtml = (selected) =>
    MONTH_FULL.map((m, i) =>
      `<option value="${i}"${i === selected ? " selected" : ""}>${m}</option>`
    ).join("");
  const yearOptHtml = (selected) =>
    yearOpts.map((y) =>
      `<option value="${y}"${y === selected ? " selected" : ""}>${y}</option>`
    ).join("");

  el.innerHTML = `
    <h1 class="h1">Export — Billing — Date Range</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports all billing periods overlapping a chosen month range for every
      billable customer org. The output workbook has one sheet per
      organisation, each containing every period in the range stacked
      vertically with summary / regular-licenses / AI-tokens-breakdown /
      overage sections — matching the Python report.
    </p>

    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <label class="em-label" style="margin:0">From:</label>
      <select id="bdrFromMonth" class="em-input" style="min-width:130px">${monthOptHtml(defaultFromMonth)}</select>
      <select id="bdrFromYear"  class="em-input" style="min-width:100px">${yearOptHtml(defaultFromYear)}</select>

      <label class="em-label" style="margin:0 0 0 12px">To:</label>
      <select id="bdrToMonth" class="em-input" style="min-width:130px">${monthOptHtml(defaultToMonth)}</select>
      <select id="bdrToYear"  class="em-input" style="min-width:100px">${yearOptHtml(defaultToYear)}</select>
    </div>

    <div class="te-actions">
      <button class="btn te-btn-export" id="bdrRunBtn">Run</button>
      <button class="btn te-btn-cancel" id="bdrCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="bdrStatus"></div>

    <div class="te-progress-wrap" id="bdrProgressWrap" style="display:none">
      <div class="te-progress-bar" id="bdrProgressBar"></div>
    </div>

    <div id="bdrDownload" style="display:none;margin-top:10px">
      <button class="btn te-btn-export" id="bdrDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="bdrEmailChk">
        <span>Send email with export</span>
      </label>
      <div class="em-fields" id="bdrEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="bdrEmailTo">Recipients</label>
          <input type="text" class="em-input" id="bdrEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="bdrEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="bdrEmailBody" rows="3"
                    placeholder="Leave empty for default message"></textarea>
        </div>
      </div>
    </div>
  `;

  const $fromMonth = el.querySelector("#bdrFromMonth");
  const $fromYear  = el.querySelector("#bdrFromYear");
  const $toMonth   = el.querySelector("#bdrToMonth");
  const $toYear    = el.querySelector("#bdrToYear");
  const $runBtn    = el.querySelector("#bdrRunBtn");
  const $cancelBtn = el.querySelector("#bdrCancelBtn");
  const $status    = el.querySelector("#bdrStatus");
  const $progWrap  = el.querySelector("#bdrProgressWrap");
  const $progBar   = el.querySelector("#bdrProgressBar");
  const $dlWrap    = el.querySelector("#bdrDownload");
  const $dlBtn     = el.querySelector("#bdrDownloadBtn");
  const $emailChk  = el.querySelector("#bdrEmailChk");
  const $emailFld  = el.querySelector("#bdrEmailFields");
  const $emailTo   = el.querySelector("#bdrEmailTo");
  const $emailBody = el.querySelector("#bdrEmailBody");

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

  $runBtn.addEventListener("click", async () => {
    if (isRunning) return;

    const fromMonth = Number($fromMonth.value);
    const fromYear  = Number($fromYear.value);
    const toMonth   = Number($toMonth.value);
    const toYear    = Number($toYear.value);

    const fromDate = new Date(Date.UTC(fromYear, fromMonth, 1));
    const toDate   = new Date(Date.UTC(toYear, toMonth, lastDayOfMonth(toYear, toMonth), 23, 59, 59));
    if (toDate < fromDate) {
      setStatus("Invalid range: to-date precedes from-date.", "error");
      return;
    }

    const fromLabel = `${MONTH_ABBR[fromMonth]} ${fromYear}`;
    const toLabel   = `${MONTH_ABBR[toMonth]} ${toYear}`;

    const allCustomers = orgContext.getCustomers();
    const billable     = filterBillableCustomers(allCustomers);
    if (!billable.length) {
      setStatus("No billable customer orgs available.", "error");
      return;
    }

    isRunning    = true;
    cancelled    = false;
    lastWorkbook = null;
    lastFilename = null;
    $runBtn.style.display    = "none";
    $cancelBtn.style.display = "";
    $dlWrap.style.display    = "none";
    setStatus(`Starting export — ${billable.length} org(s), ${fromLabel} to ${toLabel}…`);
    setProgress(0);

    /** @type {Array<{orgName: string, periods: Array<{startDate: string, endDate: string, processed: object}>}>} */
    const orgsData = [];
    const failures = [];

    try {
      for (let i = 0; i < billable.length; i++) {
        if (cancelled) break;
        const customer = billable[i];
        const pct      = Math.round((i / billable.length) * 90);
        setStatus(`Org ${i + 1}/${billable.length}: ${customer.name} — fetching periods…`);
        setProgress(pct);

        try {
          const { periods } = await fetchBillingPeriodsForDateRange(api, customer.id, fromDate, toDate);
          if (!periods.length) {
            failures.push({ orgName: customer.name, error: "no periods in range" });
            continue;
          }
          const processedPeriods = periods.map((p) => ({
            startDate: p.startDate,
            endDate:   p.endDate,
            processed: processBillingOverview(p.overview),
          }));
          orgsData.push({ orgName: customer.name, periods: processedPeriods });
        } catch (err) {
          failures.push({ orgName: customer.name, error: err?.message || String(err) });
        }
      }

      if (cancelled) {
        resetProgress();
        setStatus("Cancelled.", "error");
        return;
      }

      if (orgsData.length === 0) {
        resetProgress();
        const detail = failures.map((f) => `${f.orgName}: ${f.error}`).join("; ");
        setStatus(`No data exported. ${detail}`, "error");
        return;
      }

      setStatus("Building workbook…");
      setProgress(95);

      const XLSX = window.XLSX;
      const wb   = XLSX.utils.book_new();
      for (const { orgName, periods } of orgsData) {
        buildDateRangeSheet({ workbook: wb, orgName, fromLabel, toLabel, periods });
      }
      setProgress(100);

      lastWorkbook = wb;
      lastFilename = timestampedFilename(
        `Billing_Date_Range_${fromYear}-${String(fromMonth + 1).padStart(2, "0")}_to_${toYear}-${String(toMonth + 1).padStart(2, "0")}`,
        "xlsx"
      );
      $dlWrap.style.display = "";

      const totalPeriods = orgsData.reduce((s, o) => s + o.periods.length, 0);
      const failLine = failures.length
        ? ` | failed: ${failures.map((f) => `${f.orgName} (${f.error})`).join(", ")}`
        : "";
      const doneMsg =
        `Done — ${orgsData.length}/${billable.length} org(s) exported | ` +
        `${totalPeriods} period(s) total | ${fromLabel} to ${toLabel}${failLine}`;
      setStatus(doneMsg, failures.length ? "warn" : "success");

      logAction({
        me,
        action:      "export_run",
        description: `Exported 'Billing — Date Range ${fromLabel} to ${toLabel}' — ${orgsData.length}/${billable.length} orgs, ${totalPeriods} periods`,
        count:       orgsData.length,
      });

      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
          const result  = await sendEmail(api, {
            recipients: $emailTo.value,
            subject:    `[All Orgs] Billing — Date Range ${fromLabel} to ${toLabel} Export`,
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

  return el;
}
