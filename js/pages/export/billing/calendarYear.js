/**
 * Export › Billing › Calendar Year
 *
 * Exports 12 months of billing data for every billable customer org for a
 * chosen calendar year. Mirrors the Python script
 * GUI_Billing_Export_Calendar_Year.py — same per-org sheet layout:
 *
 *   ─── CALENDAR YEAR {year}: {orgName} ───
 *   Total Periods: N
 *
 *   ─── {period label} ───            ← repeated per period (green divider)
 *   License Type / Billing Period / Billable Items / [AI summary]
 *   ─── REGULAR LICENSES … ───
 *   …
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
 * No scheduled variant — there is no Python equivalent of
 * GUI_Billing_Export_Scheduled_*.py for calendar year.
 */
import { timestampedFilename } from "../../../utils.js";
import {
  fetchBillingPeriodsForCalendarYear,
} from "../../../services/billingService.js";
import { filterBillableCustomers } from "../../../utils/billingTrustees.js";
import { processBillingOverview } from "../../../utils/billingProcessor.js";
import { buildCalendarYearSheet } from "../../../utils/billingExcelStyles.js";
import { orgContext } from "../../../services/orgContext.js";
import { logAction } from "../../../services/activityLogService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { sendEmail } from "../../../services/emailService.js";

const YEAR_DROPDOWN_COUNT = 5;   // current year + 4 previous

const AUTOMATION_ENABLED      = true;
const AUTOMATION_EXPORT_TYPE  = "billingCalendarYear";
const AUTOMATION_EXPORT_LABEL = "Billing — Calendar Year";

function buildYearOptions() {
  const current = new Date().getUTCFullYear();
  const years   = [];
  for (let i = 0; i < YEAR_DROPDOWN_COUNT; i++) years.push(current - i);
  return years;
}

export default function renderBillingCalendarYearExport({ me, api }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning    = false;
  let cancelled    = false;
  let lastWorkbook = null;
  let lastFilename = null;

  const yearOpts = buildYearOptions();
  const defaultYear = yearOpts[1] || yearOpts[0]; // previous full year by default

  el.innerHTML = `
    <h1 class="h1">Export — Billing — Calendar Year</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports up to 12 billing periods (Jan–Dec) for every billable customer
      org for the chosen calendar year. The output workbook has one sheet
      per organisation, each containing all available periods stacked
      vertically with summary / regular-licenses / AI-tokens-breakdown /
      overage sections — matching the Python report.
    </p>

    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <label class="em-label" for="bcyYear" style="margin:0">Calendar year:</label>
      <select id="bcyYear" class="em-input" style="min-width:120px">
        ${yearOpts.map((y) =>
          `<option value="${y}"${y === defaultYear ? " selected" : ""}>${y}</option>`
        ).join("")}
      </select>
    </div>

    <div class="te-actions">
      <button class="btn te-btn-export" id="bcyRunBtn">Run</button>
      <button class="btn te-btn-cancel" id="bcyCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="bcyStatus"></div>

    <div class="te-progress-wrap" id="bcyProgressWrap" style="display:none">
      <div class="te-progress-bar" id="bcyProgressBar"></div>
    </div>

    <div id="bcyDownload" style="display:none;margin-top:10px">
      <button class="btn te-btn-export" id="bcyDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="bcyEmailChk">
        <span>Send email with export</span>
      </label>
      <div class="em-fields" id="bcyEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="bcyEmailTo">Recipients</label>
          <input type="text" class="em-input" id="bcyEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="bcyEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="bcyEmailBody" rows="3"
                    placeholder="Leave empty for default message"></textarea>
        </div>
      </div>
    </div>
  `;

  // ── Automation panel ──────────────────────────────────
  // Scheduled handler always exports the PREVIOUS calendar year
  // (current year - 1). See api/lib/exports/billingCalendarYear.js.
  if (AUTOMATION_ENABLED) {
    el.appendChild(createSchedulePanel({
      exportType:  AUTOMATION_EXPORT_TYPE,
      exportLabel: AUTOMATION_EXPORT_LABEL,
      me,
      requiresOrg: false,
      configSummary: () => `Previous calendar year (auto: current year − 1)`,
    }));
  }

  const $year      = el.querySelector("#bcyYear");
  const $runBtn    = el.querySelector("#bcyRunBtn");
  const $cancelBtn = el.querySelector("#bcyCancelBtn");
  const $status    = el.querySelector("#bcyStatus");
  const $progWrap  = el.querySelector("#bcyProgressWrap");
  const $progBar   = el.querySelector("#bcyProgressBar");
  const $dlWrap    = el.querySelector("#bcyDownload");
  const $dlBtn     = el.querySelector("#bcyDownloadBtn");
  const $emailChk  = el.querySelector("#bcyEmailChk");
  const $emailFld  = el.querySelector("#bcyEmailFields");
  const $emailTo   = el.querySelector("#bcyEmailTo");
  const $emailBody = el.querySelector("#bcyEmailBody");

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

    const year = $year.value;
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
    setStatus(`Starting export — ${billable.length} org(s), calendar year ${year}…`);
    setProgress(0);

    /** @type {Array<{orgName: string, year: string, periods: Array<{label: string, processed: object}>}>} */
    const orgsData = [];
    const failures = [];

    try {
      // Sequential — each org makes up to 13 sequential API calls
      // (matches Python's serial walk; avoids hammering the proxy).
      for (let i = 0; i < billable.length; i++) {
        if (cancelled) break;
        const customer = billable[i];
        const pct      = Math.round((i / billable.length) * 90);
        setStatus(`Org ${i + 1}/${billable.length}: ${customer.name} — fetching ${year} periods…`);
        setProgress(pct);

        try {
          const { periods } = await fetchBillingPeriodsForCalendarYear(api, customer.id, year);
          if (!periods.length) {
            failures.push({ orgName: customer.name, error: `no periods in ${year}` });
            continue;
          }
          const processedPeriods = periods.map((p) => ({
            label:     p.label,
            processed: processBillingOverview(p.overview),
          }));
          orgsData.push({ orgName: customer.name, year, periods: processedPeriods });
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
      // One sheet per org — matches Python pd.ExcelWriter loop.
      for (const { orgName, year: y, periods } of orgsData) {
        buildCalendarYearSheet({ workbook: wb, orgName, year: y, periods });
      }
      setProgress(100);

      lastWorkbook = wb;
      lastFilename = timestampedFilename(`Billing_Calendar_Year_${year}`, "xlsx");
      $dlWrap.style.display = "";

      const totalPeriods = orgsData.reduce((s, o) => s + o.periods.length, 0);
      const failLine = failures.length
        ? ` | failed: ${failures.map((f) => `${f.orgName} (${f.error})`).join(", ")}`
        : "";
      const doneMsg =
        `Done — ${orgsData.length}/${billable.length} org(s) exported | ` +
        `${totalPeriods} period(s) total | year ${year}${failLine}`;
      setStatus(doneMsg, failures.length ? "warn" : "success");

      logAction({
        me,
        action:      "export_run",
        description: `Exported 'Billing — Calendar Year ${year}' — ${orgsData.length}/${billable.length} orgs, ${totalPeriods} periods`,
        count:       orgsData.length,
      });

      // ── Email ──────────────────────────────────────────
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
          const result  = await sendEmail(api, {
            recipients: $emailTo.value,
            subject:    `[All Orgs] Billing — Calendar Year ${year} Export`,
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
