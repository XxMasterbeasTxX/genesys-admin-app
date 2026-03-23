/**
 * Export › Interactions › Totals
 *
 * Shows the total number of interactions over a given period, broken down
 * into three horizontal bar chart groups:
 *   1. By Media Type  (voice, chat, email, message, callback, …)
 *   2. By Direction    (inbound, outbound)
 *   3. By Routing      (ACD / Non-ACD)  — based on interactionType dimension
 *
 * Date presets: Last Month, Last 3 Months, Last Year (calendar-aligned).
 * Filters: Media Type, Direction.
 *
 * API: POST /api/v2/analytics/conversations/aggregates/query
 *      Returns pre-computed counts grouped by dimension — fast at any scale.
 */

import { escapeHtml, timestampedFilename } from "../../../utils.js";
import { sendEmail } from "../../../services/emailService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { buildStyledWorkbook } from "../../../utils/excelStyles.js";
import { STYLE_HEADER } from "../../../utils/excelStyles.js";
import { logAction } from "../../../services/activityLogService.js";

// ── Automation ──────────────────────────────────────────
const AUTOMATION_ENABLED = true;
const AUTOMATION_EXPORT_TYPE = "interactionTotals";
const AUTOMATION_EXPORT_LABEL = "Interaction Totals";

// ── Date helpers ────────────────────────────────────────────────────

/** First day of the month N months ago. */
function monthStart(offset) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - offset);
  return d.toISOString().slice(0, 10);
}

/** Last day of the previous month. */
function lastDayOfPrevMonth() {
  const d = new Date();
  d.setUTCDate(0); // day 0 = last day of previous month
  return d.toISOString().slice(0, 10);
}

/** First day of last complete year. */
function lastYearStart() {
  return `${new Date().getUTCFullYear() - 1}-01-01`;
}

/** Last day of last complete year. */
function lastYearEnd() {
  return `${new Date().getUTCFullYear() - 1}-12-31`;
}

/** Monday of the previous complete week (ISO week, Mon–Sun). */
function lastWeekStart() {
  const d = new Date();
  const day = d.getUTCDay() || 7; // Sun=7
  d.setUTCDate(d.getUTCDate() - day - 6); // previous Monday
  return d.toISOString().slice(0, 10);
}

/** Sunday of the previous complete week. */
function lastWeekEnd() {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day); // previous Sunday
  return d.toISOString().slice(0, 10);
}

// ── Label maps ──────────────────────────────────────────────────────

const MEDIA_LABELS = {
  voice: "Voice", callback: "Callback", chat: "Chat",
  email: "Email", message: "Message", cobrowse: "Cobrowse",
  screenshare: "Screen Share", internalmessage: "Internal Message",
};

const DIRECTION_LABELS = { inbound: "Inbound", outbound: "Outbound" };
const ROUTING_LABELS   = { contactCenter: "ACD", enterprise: "Non-ACD" };

function friendlyLabel(key, map) {
  return map[key?.toLowerCase?.()] || key || "Unknown";
}

// ── Renderer ────────────────────────────────────────────────────────

export default function renderTotals({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Export — Interactions — Totals</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── Build UI ────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Export — Interactions — Totals</h1>
    <hr class="hr">

    <p class="page-desc">
      View total interaction counts for a date range, grouped by media type,
      direction, and ACD / Non-ACD routing.
    </p>

    <!-- Date controls -->
    <div class="cs-controls">
      <div class="cs-control-group">
        <label class="cs-label">Period</label>
        <div class="it-date-row">
          <input type="date" class="input is-date" id="itFrom">
          <span class="cs-dash">—</span>
          <input type="date" class="input is-date" id="itTo">
        </div>
        <div class="it-presets">
          <button class="btn btn-sm" id="itPresetWeek">Last Week</button>
          <button class="btn btn-sm" id="itPresetMonth">Last Month</button>
          <button class="btn btn-sm" id="itPreset3Mo">Last 3 Months</button>
          <button class="btn btn-sm" id="itPresetYear">Last Year</button>
        </div>
      </div>

      <div class="cs-control-group">
        <label class="cs-label">Media Type</label>
        <select class="input" id="itMediaFilter">
          <option value="">All</option>
          <option value="voice">Voice</option>
          <option value="callback">Callback</option>
          <option value="chat">Chat</option>
          <option value="email">Email</option>
          <option value="message">Message</option>
        </select>
      </div>

      <div class="cs-control-group">
        <label class="cs-label">Direction</label>
        <select class="input" id="itDirFilter">
          <option value="">All</option>
          <option value="inbound">Inbound</option>
          <option value="outbound">Outbound</option>
        </select>
      </div>
    </div>

    <div class="cs-actions" style="display:flex;justify-content:space-between;align-items:center">
      <button class="btn" id="itLoadBtn">Load Totals</button>
      <button class="btn te-btn-export" id="itExportBtn" style="display:none">Export Excel</button>
    </div>

    <!-- Status -->
    <div class="cs-status" id="itStatus" style="display:none"></div>

    <!-- Progress bar -->
    <div class="cs-progress-wrap" id="itProgressWrap" style="display:none">
      <div class="cs-progress-bar" id="itProgressBar"></div>
    </div>

    <!-- Charts -->
    <div id="itCharts" style="display:none">
      <div class="it-total-banner" id="itTotalBanner"></div>

      <div class="it-chart-group">
        <h3 class="it-chart-title">By Media Type</h3>
        <div id="itChartMedia" class="it-bars"></div>
      </div>

      <div class="it-chart-group">
        <h3 class="it-chart-title">By Direction</h3>
        <div id="itChartDir" class="it-bars"></div>
      </div>

      <div class="it-chart-group">
        <h3 class="it-chart-title">By Routing (ACD / Non-ACD)</h3>
        <div id="itChartRouting" class="it-bars"></div>
      </div>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="itEmailChk">
        <span>Send email with export</span>
      </label>
      <div class="em-fields" id="itEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="itEmailTo">Recipients</label>
          <input type="text" class="em-input" id="itEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="itEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="itEmailBody" rows="3"
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
      extraConfigFields: [
        {
          key: "periodPreset",
          label: "Period",
          type: "select",
          options: [
            { value: "lastWeek",    label: "Last Week" },
            { value: "lastMonth",   label: "Last Month" },
            { value: "last3Months", label: "Last 3 Months" },
            { value: "lastYear",    label: "Last Year" },
          ],
          default: "lastMonth",
        },
      ],
    });
    el.appendChild(schedulePanel);
  }

  // ── DOM refs ────────────────────────────────────────
  const $from         = el.querySelector("#itFrom");
  const $to           = el.querySelector("#itTo");
  const $mediaFilter  = el.querySelector("#itMediaFilter");
  const $dirFilter    = el.querySelector("#itDirFilter");
  const $loadBtn      = el.querySelector("#itLoadBtn");
  const $status       = el.querySelector("#itStatus");
  const $progressWrap = el.querySelector("#itProgressWrap");
  const $progressBar  = el.querySelector("#itProgressBar");
  const $charts       = el.querySelector("#itCharts");
  const $totalBanner  = el.querySelector("#itTotalBanner");
  const $chartMedia   = el.querySelector("#itChartMedia");
  const $chartDir     = el.querySelector("#itChartDir");
  const $chartRouting = el.querySelector("#itChartRouting");
  const $exportBtn = el.querySelector("#itExportBtn");
  const $emailChk  = el.querySelector("#itEmailChk");
  const $emailFld  = el.querySelector("#itEmailFields");
  const $emailTo   = el.querySelector("#itEmailTo");
  const $emailBody = el.querySelector("#itEmailBody");

  const orgId = orgContext.get();

  // ── Helpers ─────────────────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "cs-status" + (type ? ` cs-status--${type}` : "");
    $status.style.display = "";
  }
  function hideStatus() { $status.style.display = "none"; }
  function showProgress(pct) {
    $progressWrap.style.display = "";
    $progressBar.style.width = `${Math.min(pct, 100)}%`;
  }
  function hideProgress() {
    $progressWrap.style.display = "none";
    $progressBar.style.width = "0%";
  }

  /** Apply preset dates. */
  function applyPreset(fromStr, toStr) {
    $from.value = fromStr;
    $to.value   = toStr;
  }

  // Restrict date pickers: max = yesterday (data lake is not real-time)
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const maxDate = yesterday.toISOString().slice(0, 10);
  $from.max = maxDate;
  $to.max   = maxDate;

  // Default to Last Month
  applyPreset(monthStart(1), lastDayOfPrevMonth());

  // ── Presets ─────────────────────────────────────────
  el.querySelector("#itPresetWeek").addEventListener("click", () =>
    applyPreset(lastWeekStart(), lastWeekEnd()));
  el.querySelector("#itPresetMonth").addEventListener("click", () =>
    applyPreset(monthStart(1), lastDayOfPrevMonth()));

  el.querySelector("#itPreset3Mo").addEventListener("click", () =>
    applyPreset(monthStart(3), lastDayOfPrevMonth()));

  el.querySelector("#itPresetYear").addEventListener("click", () =>
    applyPreset(lastYearStart(), lastYearEnd()));

  // ── Build interval from date inputs ─────────────────
  function getDates() {
    return { from: $from.value, to: $to.value };
  }

  // ── Aggregates helper ─────────────────────────────
  async function fetchAggregates(interval, mt, dir) {
    const makeBody = (groupBy, extraPreds = []) => {
      const body = { interval, metrics: ["nConversations"] };
      if (groupBy) body.groupBy = [groupBy];
      const preds = [...extraPreds];
      if (mt)  preds.push({ type: "dimension", dimension: "mediaType", value: mt });
      if (dir) preds.push({ type: "dimension", dimension: "originatingDirection", value: dir });
      if (preds.length) body.filter = { type: "and", predicates: preds };
      return body;
    };

    const path = "/api/v2/analytics/conversations/aggregates/query";
    const [mediaResp, dirResp, routingResp, totalResp] = await Promise.all([
      api.proxyGenesys(orgId, "POST", path, { body: makeBody("mediaType") }),
      api.proxyGenesys(orgId, "POST", path, { body: makeBody("originatingDirection") }),
      api.proxyGenesys(orgId, "POST", path, { body: makeBody("interactionType") }),
      api.proxyGenesys(orgId, "POST", path, { body: makeBody(null) }),
    ]);

    function parseGrouped(resp, key) {
      const map = new Map();
      for (const r of resp.results || []) {
        const v = r.group?.[key];
        if (!v) continue;
        const c = r.data?.[0]?.metrics?.[0]?.stats?.count || 0;
        map.set(v, c);
      }
      return map;
    }
    function parseTotal(resp) {
      return resp.results?.[0]?.data?.[0]?.metrics?.[0]?.stats?.count || 0;
    }

    return {
      mediaCounts:   parseGrouped(mediaResp, "mediaType"),
      dirCounts:     parseGrouped(dirResp, "originatingDirection"),
      routingCounts: parseGrouped(routingResp, "interactionType"),
      grandTotal:    parseTotal(totalResp),
    };
  }

  // ── Render bar chart ────────────────────────────────
  function renderBars(container, data, labelMap, colorClass) {
    container.innerHTML = "";
    if (!data.length) {
      container.innerHTML = `<div class="it-bar-empty">No data</div>`;
      return;
    }
    const maxCount = data[0].count; // sorted desc
    const total = data.reduce((s, d) => s + d.count, 0);

    for (const { key, count } of data) {
      const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
      const share = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";

      const row = document.createElement("div");
      row.className = "it-bar-row";

      const label = document.createElement("span");
      label.className = "it-bar-label";
      label.textContent = friendlyLabel(key, labelMap);

      const track = document.createElement("div");
      track.className = "it-bar-track";

      const fill = document.createElement("div");
      fill.className = `it-bar-fill ${colorClass}`;
      fill.style.width = `${pct}%`;

      const value = document.createElement("span");
      value.className = "it-bar-value";
      value.textContent = `${count.toLocaleString()}  (${share}%)`;

      track.append(fill);
      row.append(label, track, value);
      container.append(row);
    }
  }

  // ── Email toggle ────────────────────────────────────
  $emailChk.addEventListener("change", () => {
    $emailFld.style.display = $emailChk.checked ? "" : "none";
  });

  // ── Last export data (for download / email) ─────────
  let lastWorkbook = null;
  let lastFilename = null;
  let lastSummaryData = null;



  /** Convert a Map to sorted [{key, count}] array. */
  function mapToSorted(map) {
    return [...map.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ── Load handler ────────────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const { from, to } = getDates();
    if (!from || !to) {
      setStatus("Please select a date range.", "error");
      return;
    }

    $loadBtn.disabled = true;
    $charts.style.display = "none";
    hideStatus();
    showProgress(5);

    try {
      const interval = `${from}T00:00:00.000Z/${to}T23:59:59.999Z`;

      setStatus("Querying aggregates…");
      showProgress(30);

      const { mediaCounts, dirCounts, routingCounts, grandTotal } =
        await fetchAggregates(interval, $mediaFilter.value, $dirFilter.value);

      $totalBanner.textContent = `Total Interactions: ${grandTotal.toLocaleString()}`;

      renderBars($chartMedia, mapToSorted(mediaCounts), MEDIA_LABELS, "it-fill-media");
      renderBars($chartDir, mapToSorted(dirCounts), DIRECTION_LABELS, "it-fill-dir");
      renderBars($chartRouting, mapToSorted(routingCounts), ROUTING_LABELS, "it-fill-routing");

      // Build summary data for Excel
      lastSummaryData = { mediaCounts, dirCounts, routingCounts, grandTotal, from, to };

      // Build workbook
      const wb = buildSummaryWorkbook(lastSummaryData);
      const fname = timestampedFilename(
        `InteractionTotals_${org.name.replace(/\s+/g, "_")}`, "xlsx"
      );
      lastWorkbook = wb;
      lastFilename = fname;

      $exportBtn.style.display = "";

      logAction({ me, orgId: org?.id || "", orgName: org?.name || "",
        action: "export_run",
        description: `Loaded '${AUTOMATION_EXPORT_LABEL}' for '${org?.name || ""}'` });

      // Send email if enabled
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const XLSX = window.XLSX;
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
          const result = await sendEmail(api, {
            recipients: $emailTo.value,
            subject: `Interaction Totals — ${org.name} — ${from} to ${to}`,
            body: $emailBody.value,
            attachment: { filename: fname, base64: xlsxB64,
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
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
        hideStatus();
      }

      showProgress(100);
      $charts.style.display = "";
      setTimeout(hideProgress, 600);
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
      hideProgress();
    } finally {
      $loadBtn.disabled = false;
    }
  });

  // ── Export Excel (download) ─────────────────────────
  $exportBtn.addEventListener("click", () => {
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

  // ── Build summary workbook ──────────────────────────
  function buildSummaryWorkbook({ mediaCounts, dirCounts, routingCounts, grandTotal, from, to }) {
    const mt  = $mediaFilter.value;
    const dir = $dirFilter.value;
    const filterParts = [];
    if (mt)  filterParts.push(`Media: ${friendlyLabel(mt, MEDIA_LABELS)}`);
    if (dir) filterParts.push(`Direction: ${friendlyLabel(dir, DIRECTION_LABELS)}`);
    const filterStr = filterParts.length ? filterParts.join(", ") : "None";

    // Title rows
    const rows = [
      ["Interaction Totals"],
      [`Org: ${org.name}`, "", `Period: ${from} — ${to}`, `Filters: ${filterStr}`],
      [],
    ];
    const titleRowCount = rows.length;

    // Data header + body
    const HEADERS = ["Category", "Value", "Count", "Percentage"];
    rows.push(HEADERS);
    rows.push(["Total", "All Interactions", grandTotal, "100.0%"]);
    rows.push([]);

    const mediaArr = mapToSorted(mediaCounts);
    const mediaTotal = mediaArr.reduce((s, d) => s + d.count, 0);
    for (const { key, count } of mediaArr) {
      const pct = mediaTotal > 0 ? ((count / mediaTotal) * 100).toFixed(1) + "%" : "0.0%";
      rows.push(["Media Type", friendlyLabel(key, MEDIA_LABELS), count, pct]);
    }
    rows.push([]);

    const dirArr = mapToSorted(dirCounts);
    const dirTotal = dirArr.reduce((s, d) => s + d.count, 0);
    for (const { key, count } of dirArr) {
      const pct = dirTotal > 0 ? ((count / dirTotal) * 100).toFixed(1) + "%" : "0.0%";
      rows.push(["Direction", friendlyLabel(key, DIRECTION_LABELS), count, pct]);
    }
    rows.push([]);

    const routingArr = mapToSorted(routingCounts);
    const routingTotal = routingArr.reduce((s, d) => s + d.count, 0);
    for (const { key, count } of routingArr) {
      const pct = routingTotal > 0 ? ((count / routingTotal) * 100).toFixed(1) + "%" : "0.0%";
      rows.push(["Routing", friendlyLabel(key, ROUTING_LABELS), count, pct]);
    }

    // Build workbook, then style title rows over the top
    const wb = buildStyledWorkbook(rows, "Interaction Totals");
    const ws = wb.Sheets["Interaction Totals"];
    const XLSX = window.XLSX;

    // Re-style: title rows should be bold, not header-blue
    const titleStyle = { font: { bold: true, sz: 12, name: "Calibri" } };
    for (let r = 0; r < titleRowCount; r++) {
      for (let c = 0; c < 4; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (ws[addr]) ws[addr].s = titleStyle;
      }
    }
    // Apply header style to the real column header row
    for (let c = 0; c < HEADERS.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: titleRowCount, c });
      if (ws[addr]) ws[addr].s = STYLE_HEADER;
    }
    // Freeze pane below the header row (not row 0)
    ws["!views"] = [{ state: "frozen", ySplit: titleRowCount + 1 }];
    // Autofilter on header row
    const lastRow = rows.length - 1;
    ws["!autofilter"] = {
      ref: `${XLSX.utils.encode_cell({ r: titleRowCount, c: 0 })}:${XLSX.utils.encode_cell({ r: lastRow, c: HEADERS.length - 1 })}`,
    };

    return wb;
  }

  return el;
}
