/**
 * Export › Billing › All Orgs — Latest Period
 *
 * Exports the latest complete billing period (index=1) for every billable
 * customer org and emits a SINGLE worksheet with all orgs stacked
 * vertically — matching the Python script GUI_Billing_Export_Scheduled_All.py.
 *
 * Trustee orgs (e.g. Demo, Test IE) are excluded — they cannot be exported
 * as trustors.
 *
 * No period selector: locked to "Latest complete period", same as the
 * scheduled handler.
 *
 * Per-org failures are tolerated and reported in the status summary.
 */
import { timestampedFilename } from "../../../utils.js";
import { fetchBillingOverview } from "../../../services/billingService.js";
import { filterBillableCustomers } from "../../../utils/billingTrustees.js";
import { processBillingOverview } from "../../../utils/billingProcessor.js";
import { buildAllOrgsLatestSheet } from "../../../utils/billingExcelStyles.js";
import { orgContext } from "../../../services/orgContext.js";
import { logAction } from "../../../services/activityLogService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { sendEmail } from "../../../services/emailService.js";

const LATEST_COMPLETE_PERIOD_INDEX = 1;

const AUTOMATION_ENABLED      = true;
const AUTOMATION_EXPORT_TYPE  = "billingAllOrgsLatest";
const AUTOMATION_EXPORT_LABEL = "Billing — All Orgs Latest";

export default function renderBillingAllOrgsLatestExport({ me, api }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning    = false;
  let cancelled    = false;
  let lastWorkbook = null;
  let lastFilename = null;

  el.innerHTML = `
    <h1 class="h1">Export — Billing — All Orgs (Latest Period)</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports the latest complete billing period for every billable customer org
      into a single workbook. All orgs are stacked on one sheet using the same
      4-column layout (Name, Committed, Actual Usage, On-Demand) with per-org
      summary banners, AI-tokens breakdowns and highlighted overage sections —
      matching the Python report.
    </p>

    <div class="te-actions">
      <button class="btn te-btn-export" id="balRunBtn">Run</button>
      <button class="btn te-btn-cancel" id="balCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="balStatus"></div>

    <div class="te-progress-wrap" id="balProgressWrap" style="display:none">
      <div class="te-progress-bar" id="balProgressBar"></div>
    </div>

    <div id="balDownload" style="display:none;margin-top:10px">
      <button class="btn te-btn-export" id="balDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="balEmailChk">
        <span>Send email with export</span>
      </label>
      <div class="em-fields" id="balEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="balEmailTo">Recipients</label>
          <input type="text" class="em-input" id="balEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="balEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="balEmailBody" rows="3"
                    placeholder="Leave empty for default message"></textarea>
        </div>
      </div>
    </div>
  `;

  // ── Automation panel ──────────────────────────────────
  // Mirrors Python GUI_Billing_Export_Scheduled_All.py.
  if (AUTOMATION_ENABLED) {
    el.appendChild(createSchedulePanel({
      exportType:  AUTOMATION_EXPORT_TYPE,
      exportLabel: AUTOMATION_EXPORT_LABEL,
      me,
      requiresOrg: false,
      configSummary: () => "All billable orgs, latest complete period",
    }));
  }

  const $runBtn    = el.querySelector("#balRunBtn");
  const $cancelBtn = el.querySelector("#balCancelBtn");
  const $status    = el.querySelector("#balStatus");
  const $progWrap  = el.querySelector("#balProgressWrap");
  const $progBar   = el.querySelector("#balProgressBar");
  const $dlWrap    = el.querySelector("#balDownload");
  const $dlBtn     = el.querySelector("#balDownloadBtn");
  const $emailChk  = el.querySelector("#balEmailChk");
  const $emailFld  = el.querySelector("#balEmailFields");
  const $emailTo   = el.querySelector("#balEmailTo");
  const $emailBody = el.querySelector("#balEmailBody");

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

  // ── Run ───────────────────────────────────────────────
  $runBtn.addEventListener("click", async () => {
    if (isRunning) return;

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
    setStatus(`Starting export — ${billable.length} org(s)…`);
    setProgress(0);

    const orgsData = [];
    const failures = [];

    try {
      // Sequential to avoid hammering the proxy + token endpoints.
      for (let i = 0; i < billable.length; i++) {
        if (cancelled) break;
        const customer = billable[i];
        const pct      = Math.round((i / billable.length) * 100);
        setStatus(`Org ${i + 1}/${billable.length}: ${customer.name} — fetching billing overview…`);
        setProgress(pct);

        try {
          const overview  = await fetchBillingOverview(api, customer.id, LATEST_COMPLETE_PERIOD_INDEX);
          const processed = processBillingOverview(overview);
          orgsData.push({ orgName: customer.name, processed });
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
        setStatus(`All orgs failed. ${detail}`, "error");
        return;
      }

      setStatus("Building workbook…");
      setProgress(95);

      const XLSX = window.XLSX;
      const wb   = XLSX.utils.book_new();
      buildAllOrgsLatestSheet({ workbook: wb, sheetName: "All Orgs", orgsData });
      setProgress(100);

      const firstSummary = orgsData[0].processed.summary;
      lastWorkbook = wb;
      lastFilename = timestampedFilename(
        `Billing_All_Orgs_Latest_${firstSummary.startDate}_to_${firstSummary.endDate}`,
        "xlsx"
      );
      $dlWrap.style.display = "";

      const totalBillable = orgsData.reduce(
        (sum, o) => sum + (o.processed.summary.billableItems || 0),
        0
      );
      const failLine = failures.length
        ? ` | failed: ${failures.map((f) => f.orgName).join(", ")}`
        : "";
      const doneMsg =
        `Done — ${orgsData.length}/${billable.length} org(s) exported | ` +
        `${totalBillable} billable item(s) total | period ${firstSummary.startDate} to ${firstSummary.endDate}${failLine}`;
      setStatus(doneMsg, failures.length ? "warn" : "success");

      logAction({
        me,
        action:      "export_run",
        description: `Exported 'Billing — All Orgs Latest' — ${orgsData.length}/${billable.length} orgs, ${totalBillable} billable items`,
        count:       orgsData.length,
      });

      // ── Email ──────────────────────────────────────────
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
          const result  = await sendEmail(api, {
            recipients: $emailTo.value,
            subject:    `[All Orgs] ${AUTOMATION_EXPORT_LABEL} Export`,
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

  // ── Cancel ────────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => {
    cancelled = true;
    setStatus("Cancelling…", "error");
  });

  // ── Download ──────────────────────────────────────────
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
