/**
 * Export › Billing › Custom Orgs
 *
 * Exports a single billing period for a user-chosen subset of billable
 * customer orgs. Mirrors the Python script GUI_Billing_Export_Custom_Orgs.py:
 *
 *   - User picks which orgs to include (checkboxes).
 *   - User picks ONE billing period index (Python's "first selected period
 *     only" limitation — multi-period is not supported in the Python script
 *     either).
 *   - The workbook has one sheet per selected org, using the same layout
 *     as the All Orgs (Latest) export — Python re-uses `export_to_excel`.
 *
 * Trustee orgs (Demo, Test IE) are excluded from the picker — they cannot
 * be exported as trustors.
 *
 * No scheduled variant (no Python equivalent; the org list is interactive).
 */
import { timestampedFilename } from "../../../utils.js";
import { fetchBillingOverview } from "../../../services/billingService.js";
import { filterBillableCustomers } from "../../../utils/billingTrustees.js";
import { processBillingOverview } from "../../../utils/billingProcessor.js";
import { buildBillingSheet } from "../../../utils/billingExcelStyles.js";
import { orgContext } from "../../../services/orgContext.js";
import { logAction } from "../../../services/activityLogService.js";
import { sendEmail } from "../../../services/emailService.js";

const PERIOD_OPTIONS = [
  { index: 0, label: "Current (in-progress) period" },
  { index: 1, label: "Latest complete period" },
  { index: 2, label: "Two periods ago" },
  { index: 3, label: "Three periods ago" },
];
const DEFAULT_PERIOD_INDEX = 1;

export default function renderBillingCustomOrgsExport({ me, api }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning    = false;
  let cancelled    = false;
  let lastWorkbook = null;
  let lastFilename = null;

  const allCustomers = orgContext.getCustomers();
  const billable     = filterBillableCustomers(allCustomers);

  el.innerHTML = `
    <h1 class="h1">Export — Billing — Custom Orgs</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports a single billing period for a custom selection of billable
      customer orgs. The output workbook has one sheet per selected org,
      with the same 4-column layout (Name, Committed, Actual Usage,
      On-Demand) used by the other billing exports — matching the Python
      report.
    </p>

    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <label class="em-label" for="bcoPeriod" style="margin:0">Billing period:</label>
      <select id="bcoPeriod" class="em-input" style="min-width:240px">
        ${PERIOD_OPTIONS.map((p) =>
          `<option value="${p.index}"${p.index === DEFAULT_PERIOD_INDEX ? " selected" : ""}>${p.label}</option>`
        ).join("")}
      </select>
    </div>

    <div class="te-org-picker" style="border:1px solid var(--border, #ddd);border-radius:6px;padding:12px;margin-bottom:10px;max-height:300px;overflow:auto">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <strong>Organizations</strong>
        <span id="bcoSelCount" class="em-hint">(0 selected)</span>
        <span style="flex:1"></span>
        <button class="btn btn-secondary" id="bcoSelectAll" type="button">Select all</button>
        <button class="btn btn-secondary" id="bcoSelectNone" type="button">Deselect all</button>
      </div>
      <div id="bcoOrgList">
        ${billable.length === 0
          ? `<em>No billable customer orgs available.</em>`
          : billable.map((c) => `
              <label style="display:flex;align-items:center;gap:8px;padding:4px 0">
                <input type="checkbox" class="bco-org-chk" value="${c.id}">
                <span>${c.name}</span>
              </label>`).join("")}
      </div>
    </div>

    <div class="te-actions">
      <button class="btn te-btn-export" id="bcoRunBtn" disabled>Run</button>
      <button class="btn te-btn-cancel" id="bcoCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="bcoStatus"></div>

    <div class="te-progress-wrap" id="bcoProgressWrap" style="display:none">
      <div class="te-progress-bar" id="bcoProgressBar"></div>
    </div>

    <div id="bcoDownload" style="display:none;margin-top:10px">
      <button class="btn te-btn-export" id="bcoDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="bcoEmailChk">
        <span>Send email with export</span>
      </label>
      <div class="em-fields" id="bcoEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="bcoEmailTo">Recipients</label>
          <input type="text" class="em-input" id="bcoEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="bcoEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="bcoEmailBody" rows="3"
                    placeholder="Leave empty for default message"></textarea>
        </div>
      </div>
    </div>
  `;

  const $period     = el.querySelector("#bcoPeriod");
  const $runBtn     = el.querySelector("#bcoRunBtn");
  const $cancelBtn  = el.querySelector("#bcoCancelBtn");
  const $status     = el.querySelector("#bcoStatus");
  const $progWrap   = el.querySelector("#bcoProgressWrap");
  const $progBar    = el.querySelector("#bcoProgressBar");
  const $dlWrap     = el.querySelector("#bcoDownload");
  const $dlBtn      = el.querySelector("#bcoDownloadBtn");
  const $emailChk   = el.querySelector("#bcoEmailChk");
  const $emailFld   = el.querySelector("#bcoEmailFields");
  const $emailTo    = el.querySelector("#bcoEmailTo");
  const $emailBody  = el.querySelector("#bcoEmailBody");
  const $selectAll  = el.querySelector("#bcoSelectAll");
  const $selectNone = el.querySelector("#bcoSelectNone");
  const $selCount   = el.querySelector("#bcoSelCount");

  function getCheckboxes() {
    return Array.from(el.querySelectorAll(".bco-org-chk"));
  }
  function updateSelCount() {
    const n = getCheckboxes().filter((c) => c.checked).length;
    $selCount.textContent = `(${n} selected)`;
    $runBtn.disabled = n === 0 || isRunning;
  }

  $selectAll.addEventListener("click", () => {
    getCheckboxes().forEach((c) => { c.checked = true; });
    updateSelCount();
  });
  $selectNone.addEventListener("click", () => {
    getCheckboxes().forEach((c) => { c.checked = false; });
    updateSelCount();
  });
  el.querySelector("#bcoOrgList").addEventListener("change", updateSelCount);

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

    const periodIndex = Number($period.value);
    const periodLabel = PERIOD_OPTIONS.find((p) => p.index === periodIndex)?.label || `Period ${periodIndex}`;

    const selectedIds = getCheckboxes().filter((c) => c.checked).map((c) => c.value);
    const selected    = billable.filter((c) => selectedIds.includes(c.id));
    if (!selected.length) {
      setStatus("Select at least one organisation.", "error");
      return;
    }

    isRunning    = true;
    cancelled    = false;
    lastWorkbook = null;
    lastFilename = null;
    $runBtn.style.display    = "none";
    $cancelBtn.style.display = "";
    $dlWrap.style.display    = "none";
    setStatus(`Starting export — ${selected.length} org(s), ${periodLabel}…`);
    setProgress(0);

    const orgsData = [];
    const failures = [];

    try {
      for (let i = 0; i < selected.length; i++) {
        if (cancelled) break;
        const customer = selected[i];
        const pct      = Math.round((i / selected.length) * 100);
        setStatus(`Org ${i + 1}/${selected.length}: ${customer.name} — fetching billing overview…`);
        setProgress(pct);

        try {
          const overview  = await fetchBillingOverview(api, customer.id, periodIndex);
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
      // One sheet per org — matches Python GUI_Billing_Export.export_to_excel().
      for (const { orgName, processed } of orgsData) {
        buildBillingSheet({ workbook: wb, sheetName: orgName, processed, orgName });
      }
      setProgress(100);

      const firstSummary = orgsData[0].processed.summary;
      lastWorkbook = wb;
      lastFilename = timestampedFilename(
        `Billing_Custom_Orgs_${firstSummary.startDate}_to_${firstSummary.endDate}`,
        "xlsx"
      );
      $dlWrap.style.display = "";

      const totalBillable = orgsData.reduce(
        (sum, o) => sum + (o.processed.summary.billableItems || 0),
        0
      );
      const failLine = failures.length
        ? ` | failed: ${failures.map((f) => `${f.orgName} (${f.error})`).join(", ")}`
        : "";
      const doneMsg =
        `Done — ${orgsData.length}/${selected.length} org(s) exported | ` +
        `${totalBillable} billable item(s) total | period ${firstSummary.startDate} to ${firstSummary.endDate}${failLine}`;
      setStatus(doneMsg, failures.length ? "warn" : "success");

      logAction({
        me,
        action:      "export_run",
        description: `Exported 'Billing — Custom Orgs' — ${orgsData.length}/${selected.length} orgs (${periodLabel}), ${totalBillable} billable items`,
        count:       orgsData.length,
      });

      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
          const result  = await sendEmail(api, {
            recipients: $emailTo.value,
            subject:    `[Custom Orgs] Billing Export — ${periodLabel}`,
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
      updateSelCount();
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

  updateSelCount();
  return el;
}
