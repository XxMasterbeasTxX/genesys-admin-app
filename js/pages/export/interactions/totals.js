/**
 * Export › Interactions › Totals
 *
 * Shows the total number of interactions over a given period, broken down
 * into three horizontal bar chart groups:
 *   1. By Media Type  (voice, chat, email, message, callback, …)
 *   2. By Direction    (inbound, outbound)
 *   3. By Routing      (ACD / Non-ACD)
 *
 * Date presets: Last Month, Last 3 Months, Last Year (calendar-aligned).
 * Filters: Media Type, Direction (server-side via the aggregation API).
 *
 * API: POST /api/v2/analytics/conversations/aggregates/query
 */

import { escapeHtml } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";

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

// ── Label maps ──────────────────────────────────────────────────────

const MEDIA_LABELS = {
  voice: "Voice", callback: "Callback", chat: "Chat",
  email: "Email", message: "Message", cobrowse: "Cobrowse",
  screenshare: "Screen Share", internalmessage: "Internal Message",
};

const DIRECTION_LABELS = { inbound: "Inbound", outbound: "Outbound" };
const ROUTING_LABELS   = { acd: "ACD", "non-acd": "Non-ACD" };

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

    <div class="cs-actions">
      <button class="btn" id="itLoadBtn">Load Totals</button>
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
  `;

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

  // Default to Last Month
  applyPreset(monthStart(1), lastDayOfPrevMonth());

  // ── Presets ─────────────────────────────────────────
  el.querySelector("#itPresetMonth").addEventListener("click", () =>
    applyPreset(monthStart(1), lastDayOfPrevMonth()));

  el.querySelector("#itPreset3Mo").addEventListener("click", () =>
    applyPreset(monthStart(3), lastDayOfPrevMonth()));

  el.querySelector("#itPresetYear").addEventListener("click", () =>
    applyPreset(lastYearStart(), lastYearEnd()));

  // ── Build interval from date inputs ─────────────────
  function getInterval() {
    const from = $from.value;
    const to   = $to.value;
    if (!from || !to) return null;
    return `${from}T00:00:00.000Z/${to}T23:59:59.999Z`;
  }

  // ── Build filter predicates ─────────────────────────
  function buildPredicates() {
    const preds = [];
    const mt  = $mediaFilter.value;
    const dir = $dirFilter.value;
    if (mt)  preds.push({ dimension: "mediaType", value: mt });
    if (dir) preds.push({ dimension: "direction", value: dir });
    return preds;
  }

  function buildFilter() {
    const preds = buildPredicates();
    return preds.length ? { type: "and", predicates: preds } : undefined;
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

  // ── Load handler ────────────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const interval = getInterval();
    if (!interval) {
      setStatus("Please select a date range.", "error");
      return;
    }

    $loadBtn.disabled = true;
    $charts.style.display = "none";
    hideStatus();
    showProgress(5);
    setStatus("Querying interaction totals…");

    try {
      const filter = buildFilter();

      // ACD = interactions where a queue was involved (queueId exists)
      const acdPreds = [{ dimension: "queueId", operator: "exists" }, ...buildPredicates()];
      const acdFilter = { type: "and", predicates: acdPreds };

      // Run three aggregation queries in parallel
      showProgress(10);
      const [mediaData, dirData, acdCount] = await Promise.all([
        gc.queryConversationAggregates(api, orgId, interval, "mediaType", filter),
        gc.queryConversationAggregates(api, orgId, interval, "direction", filter),
        gc.queryConversationCount(api, orgId, interval, acdFilter),
      ]);

      showProgress(90);

      // Grand total (from mediaType breakdown since it covers all)
      const grandTotal = mediaData.reduce((s, d) => s + d.count, 0);
      $totalBanner.textContent = `Total Interactions: ${grandTotal.toLocaleString()}`;

      // Render charts
      renderBars($chartMedia, mediaData, MEDIA_LABELS, "it-fill-media");
      renderBars($chartDir, dirData, DIRECTION_LABELS, "it-fill-dir");

      // ACD = queue was involved, Non-ACD = no queue
      const nonAcdCount = grandTotal - acdCount;
      const routingSummary = [
        { key: "acd", count: acdCount },
        { key: "non-acd", count: nonAcdCount > 0 ? nonAcdCount : 0 },
      ].filter(d => d.count > 0).sort((a, b) => b.count - a.count);

      renderBars($chartRouting, routingSummary, ROUTING_LABELS, "it-fill-routing");

      showProgress(100);
      $charts.style.display = "";
      hideStatus();
      setTimeout(hideProgress, 600);
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
      hideProgress();
    } finally {
      $loadBtn.disabled = false;
    }
  });

  return el;
}
