/**
 * Export › Billing › Single Org
 *
 * Exports billing data for the currently selected customer org for a chosen
 * billing period. Mirrors the Python script GUI_Billing_Export.py — same
 * 4-column layout (Name | Committed | Actual Usage | On-Demand), summary
 * block, AI-tokens breakdown, and red overage section.
 *
 * Period selection matches Python `_get_billing_periods_for_org()`:
 *   - When a customer is selected, periods 0..3 are fetched in parallel
 *     and labelled as "YYYY-MM-DD to YYYY-MM-DD".
 *   - Failed indices fall back to "Current Period" / "Previous Period" etc.
 *   - Cached per-customer; switching back to a loaded org is instant.
 *   - The raw overview is kept on each period so Run reuses it without
 *     a second API call.
 *
 * No preview. Same UX as other exports: Run → status → Download Excel.
 */
import { timestampedFilename } from "../../../utils.js";
import {
  fetchBillingPeriods,
  clearBillingPeriodsCache,
} from "../../../services/billingService.js";
import { isTrusteeOrg } from "../../../utils/billingTrustees.js";
import { processBillingOverview } from "../../../utils/billingProcessor.js";
import { buildBillingSheet, safeSheetName } from "../../../utils/billingExcelStyles.js";
import { logAction } from "../../../services/activityLogService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { sendEmail } from "../../../services/emailService.js";

const DEFAULT_PERIOD_INDEX = 1; // "Previous Period" = latest complete

const AUTOMATION_ENABLED      = true;
const AUTOMATION_EXPORT_TYPE  = "billingSingleOrg";
const AUTOMATION_EXPORT_LABEL = "Billing — Single Org";

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

    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <label class="em-label" for="bsoPeriod" style="margin:0">Billing period:</label>
      <select id="bsoPeriod" class="em-input" style="min-width:320px" disabled>
        <option value="">Select a customer org…</option>
      </select>
      <button class="btn te-btn-secondary" id="bsoReloadBtn" type="button" disabled title="Re-fetch billing periods for this customer">Reload</button>
    </div>

    <div class="te-actions">
      <button class="btn te-btn-export" id="bsoRunBtn" disabled>Run</button>
    </div>

    <div class="te-status" id="bsoStatus"></div>

    <div class="te-progress-wrap" id="bsoProgressWrap" style="display:none">
      <div class="te-progress-bar" id="bsoProgressBar"></div>
    </div>

    <div id="bsoDownload" style="display:none;margin-top:10px">
      <button class="btn te-btn-export" id="bsoDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="bsoEmailChk">
        <span>Send email with export</span>
      </label>

      <div class="em-fields" id="bsoEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="bsoEmailTo">Recipients</label>
          <input type="text" class="em-input" id="bsoEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="bsoEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="bsoEmailBody" rows="3"
                    placeholder="Leave empty for default message"></textarea>
        </div>
      </div>
    </div>
  `;

  // ── Automation panel ──────────────────────────────────
  // Mirrors Python GUI_Billing_Export_Scheduled_Single.py: schedule a single-org
  // billing export, always for the latest complete period (index 1).
  if (AUTOMATION_ENABLED) {
    el.appendChild(createSchedulePanel({
      exportType:  AUTOMATION_EXPORT_TYPE,
      exportLabel: AUTOMATION_EXPORT_LABEL,
      me,
      requiresOrg: true,
      // Exclude trustee orgs — they cannot be exported as trustors.
      orgFilter:   (c) => !isTrusteeOrg(c.id),
      configSummary: (cfg) => "Latest complete period",
    }));
  }

  const $period    = el.querySelector("#bsoPeriod");
  const $reloadBtn = el.querySelector("#bsoReloadBtn");
  const $runBtn    = el.querySelector("#bsoRunBtn");
  const $status    = el.querySelector("#bsoStatus");
  const $progWrap  = el.querySelector("#bsoProgressWrap");
  const $progBar   = el.querySelector("#bsoProgressBar");
  const $dlWrap    = el.querySelector("#bsoDownload");
  const $dlBtn     = el.querySelector("#bsoDownloadBtn");
  const $emailChk  = el.querySelector("#bsoEmailChk");
  const $emailFld  = el.querySelector("#bsoEmailFields");
  const $emailTo   = el.querySelector("#bsoEmailTo");
  const $emailBody = el.querySelector("#bsoEmailBody");

  $emailChk.addEventListener("change", () => {
    $emailFld.style.display = $emailChk.checked ? "" : "none";
  });

  let currentPeriods = []; // most recently loaded periods array
  let lastWorkbook   = null;
  let lastFilename   = null;

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
  function clearDownload() {
    lastWorkbook = null;
    lastFilename = null;
    $dlWrap.style.display = "none";
  }

  // ── Period dropdown population ────────────────────────
  function renderPeriodOptions(periods) {
    currentPeriods = periods;
    $period.innerHTML = "";
    for (const p of periods) {
      const opt = document.createElement("option");
      opt.value = String(p.index);
      const prefix =
        p.index === 0 ? "Current (in progress) — " :
        p.index === 1 ? "Latest complete — "        : "";
      const note = p.error ? " (could not load)" : "";
      opt.textContent = `${prefix}${p.label}${note}`;
      if (p.error) opt.disabled = true;
      $period.appendChild(opt);
    }

    // Default to "Previous Period" (latest complete) if available,
    // otherwise the first selectable index.
    const fallback = currentPeriods.find((p) => p.index === DEFAULT_PERIOD_INDEX && !p.error)
                  || currentPeriods.find((p) => !p.error);
    if (fallback) {
      $period.value = String(fallback.index);
      $period.disabled = false;
      $runBtn.disabled = false;
    } else {
      $period.disabled = true;
      $runBtn.disabled = true;
    }
  }

  // ── Load (or reload) periods for the current org ──────
  async function loadPeriodsForOrg(org, { force = false } = {}) {
    clearDownload();
    if (!org) {
      $period.innerHTML = `<option value="">Select a customer org…</option>`;
      $period.disabled = true;
      $runBtn.disabled = true;
      $reloadBtn.disabled = true;
      setStatus("");
      return;
    }
    if (isTrusteeOrg(org.id)) {
      $period.innerHTML = `<option value="">N/A</option>`;
      $period.disabled = true;
      $runBtn.disabled = true;
      $reloadBtn.disabled = true;
      setStatus(
        `${org.name} is a trustee organisation itself and cannot be exported as a trustor. Pick a customer org instead.`,
        "error"
      );
      return;
    }

    $period.innerHTML = `<option value="">Loading billing periods…</option>`;
    $period.disabled = true;
    $runBtn.disabled = true;
    $reloadBtn.disabled = true;
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
        setStatus(`Loaded ${ok}/4 billing periods for ${org.name}. Some periods are unavailable.`, "warn");
      } else {
        setStatus(`Loaded 4 billing periods for ${org.name}. Select one and click Run.`);
      }
      $reloadBtn.disabled = false;
    } catch (err) {
      resetProgress();
      $period.innerHTML = `<option value="">Failed to load periods</option>`;
      $reloadBtn.disabled = false;
      setStatus(`Error loading billing periods: ${err.message || err}`, "error");
    }
  }

  // ── Wire to org context ──────────────────────────────
  const initialOrg = orgContext?.getDetails?.() || null;
  loadPeriodsForOrg(initialOrg);

  const unsubscribe = orgContext?.onChange?.(() => {
    const org = orgContext?.getDetails?.() || null;
    loadPeriodsForOrg(org);
  });

  // Clean up the subscription when the page element is removed from the DOM.
  if (unsubscribe) {
    const observer = new MutationObserver(() => {
      if (!document.body.contains(el)) {
        unsubscribe();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Reload button ─────────────────────────────────────
  $reloadBtn.addEventListener("click", () => {
    const org = orgContext?.getDetails?.();
    if (!org) return;
    loadPeriodsForOrg(org, { force: true });
  });

  // ── Run (reuses cached overview — no extra API call) ──
  $runBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    const idx    = Number($period.value);
    const period = currentPeriods.find((p) => p.index === idx);
    if (!period || !period.overview) {
      setStatus("Selected period has no data — pick a different period or click Reload.", "error");
      return;
    }

    $runBtn.disabled = true;
    clearDownload();
    setStatus("Processing billing data…");
    setProgress(30);

    try {
      const processed = processBillingOverview(period.overview);
      setProgress(70);

      const XLSX = window.XLSX;
      const wb = XLSX.utils.book_new();
      buildBillingSheet({
        workbook:  wb,
        sheetName: safeSheetName(org.name),
        processed,
        orgName:   org.name,
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
      const doneMsg  =
        `Done — ${org.name} | ${processed.summary.startDate} to ${processed.summary.endDate} | ${regular} licence rows, ${billable} billable item(s).`;
      setStatus(doneMsg, "success");

      logAction({
        me,
        orgId:       org.id,
        orgName:     org.name,
        action:      "export_run",
        description: `Exported 'Billing — Single Org' for '${org.name}' (period index ${idx}, ${processed.summary.startDate} to ${processed.summary.endDate})`,
      });

      // ── Email (matches Python `[{customer}] {task} Export` subject) ──
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const XLSX    = window.XLSX;
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
          const result  = await sendEmail(api, {
            recipients: $emailTo.value,
            subject:    `[${org.name}] ${AUTOMATION_EXPORT_LABEL} Export`,
            body:       $emailBody.value,
            attachment: {
              filename: lastFilename,
              base64:   xlsxB64,
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          });
          if (result.success) {
            setStatus(`${doneMsg} Email sent to: ${$emailTo.value.trim()}`, "success");
          } else {
            setStatus(`${doneMsg} Email failed: ${result.error}`, "error");
          }
        } catch (emailErr) {
          setStatus(`${doneMsg} Email failed: ${emailErr.message}`, "error");
        }
      }
    } catch (err) {
      resetProgress();
      setStatus(`Error: ${err.message || err}`, "error");
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
