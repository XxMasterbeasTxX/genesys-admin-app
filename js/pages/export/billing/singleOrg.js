/**
 * Export › Billing › Single Org
 *
 * Exports billing data for the currently selected customer org for a chosen
 * billing period. Mirrors the Python script GUI_Billing_Export.py — same
 * 4-column layout (Name | Committed | Actual Usage | On-Demand), summary
 * block, AI-tokens breakdown, and red overage section.
 *
 * No preview. Same UX as other exports: Run → status → Download Excel.
 */
import { escapeHtml, timestampedFilename } from "../../../utils.js";
import { fetchBillingOverview } from "../../../services/billingService.js";
import { isTrusteeOrg } from "../../../utils/billingTrustees.js";
import { processBillingOverview } from "../../../utils/billingProcessor.js";
import { buildBillingSheet, safeSheetName } from "../../../utils/billingExcelStyles.js";
import { logAction } from "../../../services/activityLogService.js";

const PERIOD_OPTIONS = [
  { value: 1, label: "Latest complete period (recommended)" },
  { value: 0, label: "Current (in-progress) period" },
  { value: 2, label: "Previous period" },
  { value: 3, label: "3 periods ago" },
];

export default function renderBillingSingleOrgExport({ me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h1 class="h1">Export — Billing — Single Org</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports billing usage for the currently selected customer org for one
      billing period. Output matches the Python billing report:
      a 4-column sheet (Name, Committed, Actual Usage, On-Demand) with a
      summary block, AI-tokens breakdown, and a highlighted overage section.
    </p>

    <div class="te-actions" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <label class="em-label" for="bsoPeriod" style="margin:0">Billing period:</label>
      <select id="bsoPeriod" class="em-input" style="min-width:280px">
        ${PERIOD_OPTIONS.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join("")}
      </select>
    </div>

    <div class="te-actions">
      <button class="btn te-btn-export" id="bsoRunBtn">Run</button>
    </div>

    <div class="te-status" id="bsoStatus"></div>

    <div class="te-progress-wrap" id="bsoProgressWrap" style="display:none">
      <div class="te-progress-bar" id="bsoProgressBar"></div>
    </div>

    <div id="bsoDownload" style="display:none;margin-top:10px">
      <button class="btn te-btn-export" id="bsoDownloadBtn">Download Excel</button>
    </div>
  `;

  const $period   = el.querySelector("#bsoPeriod");
  const $runBtn   = el.querySelector("#bsoRunBtn");
  const $status   = el.querySelector("#bsoStatus");
  const $progWrap = el.querySelector("#bsoProgressWrap");
  const $progBar  = el.querySelector("#bsoProgressBar");
  const $dlWrap   = el.querySelector("#bsoDownload");
  const $dlBtn    = el.querySelector("#bsoDownloadBtn");

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
  function resetProgress() {
    $progWrap.style.display = "none";
    $progBar.style.width = "0%";
  }

  // ── Run ───────────────────────────────────────────────
  $runBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) {
      setStatus("Please select a customer org first.", "error");
      return;
    }
    if (isTrusteeOrg(org.id)) {
      setStatus(
        `${org.name} is a trustee organisation itself and cannot be exported as a trustor. Pick a customer org instead.`,
        "error"
      );
      return;
    }

    const billingPeriodIndex = Number($period.value);

    $runBtn.disabled = true;
    $dlWrap.style.display = "none";
    lastWorkbook = null;
    lastFilename = null;
    setStatus("Resolving org and fetching billing overview…");
    setProgress(10);

    try {
      const overview = await fetchBillingOverview(api, org.id, billingPeriodIndex);
      setProgress(60);

      setStatus("Processing billing data…");
      const processed = processBillingOverview(overview);
      setProgress(80);

      setStatus("Building Excel…");
      const XLSX = window.XLSX;
      const wb = XLSX.utils.book_new();
      buildBillingSheet({
        workbook:  wb,
        sheetName: safeSheetName(org.name),
        processed,
      });
      setProgress(100);

      const orgSlug = org.name.replace(/\s+/g, "_");
      lastWorkbook  = wb;
      lastFilename  = timestampedFilename(
        `Billing_${orgSlug}_${processed.summary.startDate}_to_${processed.summary.endDate}`,
        "xlsx"
      );
      $dlWrap.style.display = "";

      const billable = processed.summary.billableItems;
      const regular  = processed.regularRows.length;
      setStatus(
        `Done — ${org.name} | ${processed.summary.startDate} to ${processed.summary.endDate} | ${regular} licence rows, ${billable} billable item(s).`,
        "success"
      );

      logAction({
        me,
        orgId:       org.id,
        orgName:     org.name,
        action:      "export_run",
        description: `Exported 'Billing — Single Org' for '${org.name}' (period index ${billingPeriodIndex}, ${processed.summary.startDate} to ${processed.summary.endDate})`,
      });
    } catch (err) {
      resetProgress();
      const detail = err?.status === 404
        ? "Billing data not found for this period. The org may have no trust relationship configured or no billing for this period."
        : (err?.message || String(err));
      setStatus(`Error: ${detail}`, "error");
    } finally {
      $runBtn.disabled = false;
    }
  });

  // ── Download (existing helper pattern: download.html + window._xlsxDownload) ──
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
    if (!popup) {
      delete window._xlsxDownload[key];
      setStatus("Pop-up blocked. Please allow pop-ups for this site.", "error");
    }
  });

  return el;
}
