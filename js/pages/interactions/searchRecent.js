/**
 * Interactions › Recent Search (<48h)
 *
 * Searches recent Genesys conversation records using the synchronous
 * analytics query API. Results are returned immediately (no batch pipeline).
 * Participant data is loaded lazily when a row is clicked, via the real-time
 * conversations endpoint.
 *
 * Conversations take up to 48 hours to appear in the analytics async jobs
 * pipeline used by Historical Search. Use this page for interactions that
 * occurred recently. Use Historical Search for participant data filtering
 * across older data.
 *
 * Flow:
 *   1. User selects date range (default: yesterday–today) and optional filters
 *   2. POST /api/v2/analytics/conversations/details/query — synchronous, immediate
 *   3. Results displayed in table
 *   4. Click a row → GET /api/v2/conversations/{id} → full participant data shown
 *
 * API endpoints:
 *   POST /api/v2/analytics/conversations/details/query  — synchronous search
 *   GET  /api/v2/conversations/{id}                     — real-time participant data
 */
import { escapeHtml, formatDateTime, buildInterval, todayStr, daysAgoStr, exportXlsx, timestampedFilename, makeStatus, sleep } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { createSingleSelect } from "../../components/multiSelect.js";
import { attrValue, filterByPD } from "../../lib/participantData.js";

// ── Column definitions ───────────────────────────────────────────────
const COLUMNS = [
  { key: "conversationId", label: "Conversation ID", width: "220px" },
  { key: "startTime",      label: "Start Time",      width: "160px" },
  { key: "endTime",        label: "End Time",        width: "160px" },
  { key: "direction",      label: "Direction",       width: "90px"  },
  { key: "mediaType",      label: "Media Type",      width: "100px" },
  { key: "ani",            label: "ANI",             width: "130px" },
  { key: "dnis",           label: "DNIS",            width: "130px" },
  { key: "disconnect",     label: "Disconnect Type", width: "120px" },
];

// ── Status messages ──────────────────────────────────────────────────
/**
 * Concurrent participant-data fetches. The same figure Disconnect paces at;
 * kept local because it is a pacing choice per page, not shared logic.
 */
const REQUEST_BATCH = 10;

/**
 * Above this many results, ask before loading participant data.
 *
 * The cost is one API call per result, so it scales with the search. 250 is
 * about five seconds' work and a search narrowed by queue or media is usually
 * well under it, so the question rarely gets asked.
 */
const PD_CONFIRM_OVER = 250;

const STATUS = {
  ready:     "Ready. Select a period and click Search.",
  found:     (n) => `Found ${n} conversation${n !== 1 ? "s" : ""}. Click a row to load participant data.`,
  loadingPd: (done, total) => `Loading participant data… ${done} of ${total}`,
  foundFiltered: (n, total) => `Found ${n} of ${total} conversation${total !== 1 ? "s" : ""} matching filters.`,
  noFilterMatch: (total) => `${total} conversations loaded, but none matched the filters.`,
  pdSkipped: (n) => `Found ${n} conversation${n !== 1 ? "s" : ""}. Participant data not loaded, so the filters were not applied.`,
  pdCancelled: "Cancelled. Participant data was only partly loaded, so the filters were not applied.",
  noResults: "No conversations found for the selected date range.",
  exported:  (n) => `Exported ${n} rows to Excel.`,
  error:     (msg) => `Error: ${msg}`,
};

// ── Helpers ──────────────────────────────────────────────────────────

function extractSessionField(participants, field) {
  if (!participants) return "";
  for (const p of participants) {
    for (const s of p.sessions || []) {
      if (s[field]) return s[field];
    }
  }
  return "";
}

function extractDisconnect(participants) {
  if (!participants) return "";
  for (const p of participants) {
    for (const s of p.sessions || []) {
      for (const seg of s.segments || []) {
        if (seg.disconnectType) return seg.disconnectType;
      }
    }
  }
  return "";
}

/** Flatten a conversation analytics object to a table row. */
function toRow(conv) {
  return {
    conversationId: conv.conversationId || "",
    startTime:      formatDateTime(conv.conversationStart),
    endTime:        formatDateTime(conv.conversationEnd),
    direction:      extractSessionField(conv.participants, "direction"),
    mediaType:      extractSessionField(conv.participants, "mediaType"),
    ani:            extractSessionField(conv.participants, "ani"),
    dnis:           extractSessionField(conv.participants, "dnis"),
    disconnect:     extractDisconnect(conv.participants),
    _raw: conv,
  };
}

// ── Page renderer ────────────────────────────────────────────────────

export default function renderRecentSearch({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Recent Interaction Search</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ────────────────────────────────────────────
  let conversations = [];
  // The filters that produced the current results. The form can be edited
  // without re-searching, and everything describing the results must keep
  // describing the search that made them.
  let resultsFilters = [];
  let resultsExclude = false;
  let cancelled = false;
  let rows = [];
  let selectedIdx  = -1;
  let expandedIdx  = -1;
  let realtimeCache = {};   // conversationId → realtime conv object
  let resultsCollapsed = false;
  let pdFilters = [];       // [{key, value}] — form state; see resultsFilters

  let selectedPeriod = 'last48';  // 'last48' | 'today' | 'yesterday'

  el.innerHTML = `
    <h1 class="h1">Recent Interaction Search</h1>
    <hr class="hr">

    <p class="page-desc">
      Search conversations from the last 48 hours. Results are returned immediately
      without analytics processing delay, filtered by conversation <strong>start date</strong>.
      Click a row to load full participant data.
    </p>

    <div class="is-info-banner">
      &#9432; For conversations older than ~48 hours use
      <a href="#/interactions/search/participant-data/historical" class="is-link">Historical Search</a>.
      Participant Data filters are applied after the search, by loading participant data for every result.
    </div>

    <!-- Controls: one container per group of related fields, not one wrapping
         row for all six. In a single container the browser decides the grouping
         and it changes with window width. Same split as Historical Search. -->

    <!-- When -->
    <div class="is-controls">
      <div class="is-control-group">
        <label class="is-label">Period</label>
        <div class="is-period-btns" id="rsPeriodBtns">
          <button class="btn btn-sm is-period-btn is-period-active" data-period="last48">Last 48 hours</button>
          <button class="btn btn-sm is-period-btn" data-period="today">Today</button>
          <button class="btn btn-sm is-period-btn" data-period="yesterday">Yesterday</button>
        </div>
      </div>
    </div>

    <!-- Where -->
    <div class="is-controls">
      <div class="is-control-group">
        <label class="is-label">Queue</label>
        <div id="rsQueueDropdown"></div>
      </div>
      <div class="is-control-group">
        <label class="is-label">Direction</label>
        <div id="rsDirectionDropdown"></div>
      </div>
      <div class="is-control-group">
        <label class="is-label">Media Type</label>
        <div id="rsMediaDropdown"></div>
      </div>
      <div class="is-control-group">
        <label class="is-label">Division</label>
        <div id="rsDivisionDropdown"></div>
      </div>
    </div>

    <!-- Participant data. The hint stays: unlike Historical Search, these do
         not narrow the search at all, they choose what a row shows when it is
         expanded. -->
    <div class="is-controls">
      <div class="is-control-group is-pd-group">
        <label class="is-label">Participant Data Filter</label>
        <div class="is-pd-inputs">
          <input type="text" class="input is-pd-key" id="rsPdKey" placeholder="Key">
          <input type="text" class="input is-pd-value" id="rsPdValue" placeholder="Value">
          <button class="btn btn-sm" id="rsPdAdd">Add</button>
          <button class="btn btn-sm" id="rsPdClear">Clear All</button>
          <!-- Wrapped together so a line break cannot land between them, and
               in the same order as Historical Search. -->
          <div class="is-pd-options">
            <label class="is-pd-exclude-label" title="When checked, shows conversations that do NOT match the filters">
              <input type="checkbox" id="rsPdExclude"> Exclude
            </label>
            <label class="is-pd-exclude-label" title="When checked, attribute values are treated as comma-separated lists and displayed as pills">
              <input type="checkbox" id="rsPdMultiVal"> Multi-value
            </label>
          </div>
        </div>
        <div class="is-pd-hint">Applied after the search, by loading participant data for each result.</div>
        <div class="is-filter-tags" id="rsFilterTags"></div>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="is-actions">
      <button class="btn btn--primary" id="rsSearchBtn">Search</button>
      <button class="btn" id="rsClearBtn">Clear Results</button>
      <button class="btn" id="rsCancelBtn" style="display:none">Cancel</button>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn" id="rsExportBtn" disabled>Export Excel</button>
      </div>
    </div>

    <div class="is-status" id="rsStatus">${STATUS.ready}</div>

    <div class="is-progress-wrap" id="rsProgressWrap" style="display:none">
      <div class="is-progress-bar" id="rsProgressBar"></div>
    </div>

    <!-- Value Distribution panel -->
    <div class="is-dist-panel" id="rsDistChart" style="display:none"></div>

    <!-- Results area: table + detail pane -->
    <div class="is-results-section">
      <!-- Outside .is-results, which is a two-column grid: a child there would
           be placed as a grid item and push the table into the detail column. -->
      <div class="is-hint">Tip: Right-click a row to copy the Conversation ID to clipboard.</div>
      <div class="is-results-toggle" id="rsResultsToggle" style="display:none">
        <span class="is-results-toggle-arrow" id="rsResultsArrow">&#9660;</span>
        <span id="rsResultsToggleLabel">Results</span>
      </div>
      <div class="is-results" id="rsResultsBody">
        <div class="is-table-wrap">
          <table class="data-table is-table" id="rsTable">
            <thead>
              <tr>${COLUMNS.map((c) => `<th style="width:${c.width}">${c.label}</th>`).join("")}</tr>
            </thead>
            <tbody id="rsTbody"></tbody>
          </table>
        </div>
        <div class="is-detail" id="rsDetail">
          <div class="is-detail-title">Conversation Detail</div>
          <pre class="is-detail-content" id="rsDetailContent">Select a row to load participant data.</pre>
        </div>
      </div>
    </div>
  `;

  // ── DOM refs ─────────────────────────────────────────
  const $periodBtns    = el.querySelectorAll(".is-period-btn");
  const $pdKey         = el.querySelector("#rsPdKey");
  const $pdValue       = el.querySelector("#rsPdValue");
  const $pdAdd         = el.querySelector("#rsPdAdd");
  const $pdClear       = el.querySelector("#rsPdClear");
  const $pdExclude     = el.querySelector("#rsPdExclude");
  const $pdMultiVal    = el.querySelector("#rsPdMultiVal");
  const $filterTags    = el.querySelector("#rsFilterTags");
  const $searchBtn     = el.querySelector("#rsSearchBtn");
  const $exportBtn     = el.querySelector("#rsExportBtn");
  const $cancelBtn    = el.querySelector("#rsCancelBtn");
  const $clearBtn      = el.querySelector("#rsClearBtn");
  const $status        = el.querySelector("#rsStatus");
  const $progressWrap  = el.querySelector("#rsProgressWrap");
  const $progressBar   = el.querySelector("#rsProgressBar");
  const $tbody         = el.querySelector("#rsTbody");
  const $detail        = el.querySelector("#rsDetailContent");
  const $distChart     = el.querySelector("#rsDistChart");
  const $resultsToggle = el.querySelector("#rsResultsToggle");
  const $resultsArrow  = el.querySelector("#rsResultsArrow");
  const $resultsLabel  = el.querySelector("#rsResultsToggleLabel");
  const $resultsBody   = el.querySelector("#rsResultsBody");

  // ── PD filter tag management ──────────────────────────
  function renderFilterTags() {
    if (!pdFilters.length) {
      $filterTags.innerHTML = `<span class="is-no-filters">No filters active</span>`;
      return;
    }
    $filterTags.innerHTML = pdFilters.map((f, i) =>
      `<span class="is-filter-tag" data-idx="${i}" title="Click to edit">
        <span class="is-filter-tag-text">${escapeHtml(f.key)}${f.value !== "" ? " = " + escapeHtml(f.value) : ""}</span>
        <button class="is-filter-tag-remove" data-idx="${i}">&times;</button>
       </span>`
    ).join("");
    $filterTags.querySelectorAll(".is-filter-tag-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        pdFilters.splice(Number(btn.dataset.idx), 1);
        renderFilterTags();
      });
    });
    $filterTags.querySelectorAll(".is-filter-tag").forEach((tag) => {
      tag.addEventListener("click", () => {
        const idx = Number(tag.dataset.idx);
        const f = pdFilters[idx];
        $pdKey.value = f.key;
        $pdValue.value = f.value;
        pdFilters.splice(idx, 1);
        renderFilterTags();
        $pdKey.focus();
      });
    });
  }
  renderFilterTags();

  function addPdFilter() {
    const key = $pdKey.value.trim();
    const value = $pdValue.value.trim();
    if (!key) return;
    pdFilters.push({ key, value });
    $pdKey.value = "";
    $pdValue.value = "";
    renderFilterTags();
  }

  $pdAdd.addEventListener("click", addPdFilter);

  $pdKey.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addPdFilter();
  });
  $pdValue.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && $pdKey.value.trim()) addPdFilter();
  });

  $pdClear.addEventListener("click", () => {
    pdFilters = [];
    renderFilterTags();
  });

  $periodBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedPeriod = btn.dataset.period;
      $periodBtns.forEach((b) => b.classList.toggle("is-period-active", b === btn));
    });
  });

  // ── Single-select dropdowns ───────────────────────────
  const ssQueue = createSingleSelect({ placeholder: "All queues", searchable: true });
  el.querySelector("#rsQueueDropdown").append(ssQueue.el);
  ssQueue.setEnabled(false);

  const ssDirection = createSingleSelect({ placeholder: "All", searchable: false });
  el.querySelector("#rsDirectionDropdown").append(ssDirection.el);
  ssDirection.setItems([
    { id: "inbound",  label: "Inbound" },
    { id: "outbound", label: "Outbound" },
  ]);

  const ssMedia = createSingleSelect({ placeholder: "All", searchable: false });
  el.querySelector("#rsMediaDropdown").append(ssMedia.el);
  ssMedia.setItems([
    { id: "voice",    label: "Voice" },
    { id: "email",    label: "Email" },
    { id: "callback", label: "Callback" },
    { id: "message",  label: "Message" },
  ]);

  const ssDivision = createSingleSelect({ placeholder: "All divisions", searchable: true });
  el.querySelector("#rsDivisionDropdown").append(ssDivision.el);
  ssDivision.setEnabled(false);

  // ── Status / progress helpers ─────────────────────────
  const setStatus = makeStatus($status, "is-status");
  function showProgress(pct) {
    $progressWrap.style.display = "";
    $progressBar.style.width = `${Math.min(pct, 100)}%`;
  }
  function hideProgress() {
    $progressWrap.style.display = "none";
    $progressBar.style.width = "0%";
  }
  function copyFallback(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  // ── Render table rows ─────────────────────────────────
  function renderRows() {
    const multiVal = $pdMultiVal.checked;
    let html = "";
    rows.forEach((r, i) => {
      const isSelected = i === selectedIdx;
      const isExpanded = i === expandedIdx;
      const rowClass = [
        "is-row",
        i % 2 === 1 ? "is-row-alt" : "",
        isSelected  ? "is-row-selected" : "",
        isExpanded  ? "is-row-expanded" : "",
      ].filter(Boolean).join(" ");
      html += `<tr class="${rowClass}" data-idx="${i}">
        ${COLUMNS.map((c) => `<td>${escapeHtml(r[c.key])}</td>`).join("")}
      </tr>`;

      // Inline expand row with pills (only if data already fetched)
      if (isExpanded) {
        const cached = realtimeCache[r.conversationId];
        if (!cached) {
          html += `<tr class="is-expand-row" data-expand-idx="${i}">
            <td colspan="${COLUMNS.length}">
              <div class="is-expand-panel"><span style="opacity:0.5;font-size:12px"><span class="spin spin--sm" aria-hidden="true"></span> Loading…</span></div>
            </td></tr>`;
        } else {
          // The filters that produced these rows, not whatever is in the form
          // now: the form can be edited without re-searching.
          const filters = resultsFilters;
          const sections = [];
          if (filters.length) {
            for (const f of filters) {
              const fKeyLower = f.key.toLowerCase();
              const values = new Set();
              for (const p of cached.participants || []) {
                const v = attrValue(p.attributes, fKeyLower);
                if (v != null) values.add(v);
              }
              const rawVal = values.size ? [...values].join(", ") : null;
              let valsHtml;
              if (!rawVal) {
                valsHtml = `<span class="is-expand-raw" style="opacity:0.45">(not found)</span>`;
              } else if (multiVal) {
                valsHtml = rawVal.split(",").map(t => t.trim()).filter(Boolean)
                  .map(t => `<span class="is-pill">${escapeHtml(t)}</span>`).join("");
              } else {
                valsHtml = `<span class="is-expand-raw">${escapeHtml(rawVal)}</span>`;
              }
              sections.push(`<div class="is-expand-attr">
                <span class="is-expand-key">${escapeHtml(f.key)}</span>
                <div class="is-expand-vals">${valsHtml}</div>
              </div>`);
            }
          } else {
            // No filters — show all attributes across all participants
            const seen = new Map();
            for (const p of cached.participants || []) {
              for (const [k, v] of Object.entries(p.attributes || {})) {
                if (!seen.has(k)) seen.set(k, new Set());
                seen.get(k).add(v);
              }
            }
            for (const [k, valSet] of [...seen.entries()].sort()) {
              const rawVal = [...valSet].join(", ");
              const valsHtml = multiVal
                ? rawVal.split(",").map(t => t.trim()).filter(Boolean)
                    .map(t => `<span class="is-pill">${escapeHtml(t)}</span>`).join("")
                : `<span class="is-expand-raw">${escapeHtml(rawVal)}</span>`;
              sections.push(`<div class="is-expand-attr">
                <span class="is-expand-key">${escapeHtml(k)}</span>
                <div class="is-expand-vals">${valsHtml}</div>
              </div>`);
            }
            if (!sections.length) {
              sections.push(`<div class="is-expand-attr"><span class="is-expand-raw" style="opacity:0.45">(no participant data)</span></div>`);
            }
          }
          html += `<tr class="is-expand-row" data-expand-idx="${i}">
            <td colspan="${COLUMNS.length}">
              <div class="is-expand-panel">
                <div class="is-expand-attrs">${sections.join("")}</div>
              </div>
            </td></tr>`;
        }
      }
    });
    $tbody.innerHTML = html;

    $tbody.querySelectorAll(".is-row").forEach((tr) => {
      tr.addEventListener("click", () => {
        loadDetail(Number(tr.dataset.idx));
      });
      tr.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const idx = Number(tr.dataset.idx);
        const id = rows[idx]?.conversationId;
        if (id) {
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(id).catch(() => copyFallback(id));
          } else {
            copyFallback(id);
          }
        }
        selectedIdx = idx;
        renderRows();
        setStatus(`Copied: ${id}`, "success");
      });
    });

    $exportBtn.disabled = !rows.length;
  }

  // ── Detail pane — lazy load via real-time API ─────────
  async function loadDetail(idx) {
    if (idx < 0 || idx >= rows.length) return;

    // Toggle: clicking the same row again collapses it
    if (expandedIdx === idx) {
      expandedIdx = -1;
      selectedIdx = -1;
      renderRows();
      $detail.textContent = "Select a row to load participant data.";
      return;
    }

    expandedIdx = idx;
    selectedIdx = idx;
    renderRows(); // Shows inline expand with "Loading…" placeholder

    const conversationId = rows[idx].conversationId;

    if (realtimeCache[conversationId]) {
      showDetailPane(realtimeCache[conversationId]);
      return;
    }

    $detail.textContent = "Loading…";
    const orgId = orgContext.get();
    try {
      const conv = await gc.getConversation(api, orgId, conversationId);
      realtimeCache[conversationId] = conv;
      renderRows(); // Refresh inline expand with actual participant data
      showDetailPane(conv);
    } catch (err) {
      $detail.textContent = `Error loading data: ${err.message}`;
    }
  }

  /**
   * Show conversation info in the right-hand detail pane.
   *
   * Includes participant data, in the same shape as Historical Search's pane.
   * It was omitted here — the pane printed purpose, name and disconnect type
   * only — although `conv` comes from `getConversation` and has carried
   * `attributes` all along.
   */
  function showDetailPane(conv) {
    const lines = [];
    lines.push(`Conversation ID: ${conv.id || ""}`);
    lines.push(`Start: ${formatDateTime(conv.startTime)}`);
    lines.push(`End:   ${formatDateTime(conv.endTime)}`);
    lines.push("");
    if (conv.participants) {
      conv.participants.forEach((p, pi) => {
        lines.push(`--- Participant #${pi + 1} ---`);
        if (p.purpose)        lines.push(`  Purpose: ${p.purpose}`);
        if (p.name)           lines.push(`  Name: ${p.name}`);
        if (p.disconnectType) lines.push(`  Disconnect: ${p.disconnectType}`);

        const attrs = p.attributes || {};
        const attrKeys = Object.keys(attrs).sort();
        if (attrKeys.length) {
          lines.push("  Participant Data:");
          // `?? ""` for the same reason attrValue coerces: a null would render
          // as the word "null", which reads as a value rather than an absence.
          for (const k of attrKeys) lines.push(`    ${k} = ${attrs[k] ?? ""}`);
        } else {
          lines.push("  (no participant data)");
        }

        lines.push("");
      });
    }
    $detail.textContent = lines.join("\n");
  }

  // ── Value Distribution chart ──────────────────────────
  /**
   * The same panel Historical Search draws, and the half of Multi-value that
   * was missing here: without it the checkbox only changed how an expanded row
   * rendered, which is invisible unless a row happens to be expanded.
   *
   * Historical reads attributes straight off its results. The synchronous query
   * this page uses does not return them, so the source is `realtimeCache` —
   * filled by the prefetch that a participant-data filter triggers. That makes
   * the guard below identical in effect to Historical's rather than merely
   * copied from it: no filters means no prefetch, so there would be nothing to
   * count even if the panel were shown.
   *
   * Counts are per participant, as on Historical: an attribute set on two legs
   * of one conversation counts twice. The panel measures values seen, not
   * conversations, which is what makes it useful for spotting a rare value.
   *
   * @returns {boolean} whether the panel is now showing. The results table
   *   folds away only when there is a chart to fold it away *for* — see
   *   `setResultsCollapsed`.
   */
  function renderDistChart() {
    const multiVal = $pdMultiVal.checked;
    if (!multiVal || !resultsFilters.length || !conversations.length) {
      $distChart.style.display = "none";
      return false;
    }

    const charts = [];
    for (const f of resultsFilters) {
      const fKeyLower = f.key.toLowerCase();
      const freq = new Map();
      for (const c of conversations) {
        const cached = realtimeCache[c.conversationId];
        if (!cached) continue;   // fetch failed; already reported in the status
        for (const p of cached.participants || []) {
          const raw = attrValue(p.attributes, fKeyLower);
          if (raw == null) continue;
          for (const val of raw.split(",").map(v => v.trim()).filter(Boolean)) {
            freq.set(val, (freq.get(val) || 0) + 1);
          }
        }
      }
      if (freq.size) charts.push({ key: f.key, freq });
    }

    if (!charts.length) {
      $distChart.style.display = "none";
      return false;
    }

    let html = `<div class="is-dist-header">
      <span class="is-dist-title">Value Distribution</span>
      <button class="is-dist-close" id="rsDistClose">&times;</button>
    </div>`;

    for (const { key, freq } of charts) {
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
      const maxCount = sorted[0]?.[1] || 1;
      const total = [...freq.values()].reduce((a, b) => a + b, 0);
      html += `<div class="is-dist-chart">
        <div class="is-dist-key">${escapeHtml(key)}</div>
        <div class="is-dist-bars">`;
      for (const [val, count] of sorted) {
        const barPct  = Math.round((count / maxCount) * 100);
        const ofTotal = Math.round((count / total) * 100);
        html += `<div class="is-dist-row">
          <div class="is-dist-val-label" title="${escapeHtml(val)}">${escapeHtml(val)}</div>
          <div class="is-dist-bar-wrap"><div class="is-dist-bar" style="width:${barPct}%"></div></div>
          <div class="is-dist-count">${count} <span class="is-dist-pct">${ofTotal}%</span></div>
        </div>`;
      }
      html += `</div></div>`;
    }

    $distChart.innerHTML = html;
    $distChart.style.display = "";
    el.querySelector("#rsDistClose")?.addEventListener("click", () => {
      $distChart.style.display = "none";
    });
    return true;
  }

  // ── Results collapse ──────────────────────────────────
  // With the chart open the table is the second thing you want, so it folds
  // away. Keyed on the chart being *shown*, not on the checkbox: Multi-value
  // with no participant-data filter draws no chart, and collapsing there hid
  // the results behind a toggle with nothing in their place.
  function setResultsCollapsed(collapsed) {
    resultsCollapsed = collapsed;
    $resultsBody.style.display = collapsed ? "none" : "";
    $resultsArrow.innerHTML = collapsed ? "&#9654;" : "&#9660;";
  }

  function updateResultsToggle() {
    if (rows.length) {
      $resultsToggle.style.display = "";
      $resultsLabel.textContent = `Results (${rows.length})`;
    } else {
      $resultsToggle.style.display = "none";
    }
  }

  $resultsToggle.addEventListener("click", () => {
    setResultsCollapsed(!resultsCollapsed);
  });

  // Re-render the expanded row too, which Historical does not: there the toggle
  // collapses the table, so a stale expansion is hidden anyway. Here it is not.
  $pdMultiVal.addEventListener("change", () => {
    const shown = renderDistChart();
    renderRows();
    setResultsCollapsed(shown && rows.length > 0);
  });

  // ── Clear results ─────────────────────────────────────
  function clearResults() {
    conversations = [];
    resultsFilters = [];
    resultsExclude = false;
    cancelled = false;
    rows = [];
    selectedIdx  = -1;
    expandedIdx  = -1;
    realtimeCache = {};
    $tbody.innerHTML = "";
    $detail.textContent = "Select a row to load participant data.";
    $exportBtn.disabled = true;
    $distChart.style.display = "none";
    $resultsToggle.style.display = "none";
    setResultsCollapsed(false);
    hideProgress();
    setStatus(STATUS.ready);
  }
  $clearBtn.addEventListener("click", clearResults);

  // ── Export ────────────────────────────────────────────
  $exportBtn.addEventListener("click", () => {
    if (!rows.length) return;
    try {
      exportXlsx(
        [{ name: "Interactions", rows, columns: COLUMNS }],
        timestampedFilename("RecentSearch", "xlsx"),
      );
      setStatus(STATUS.exported(rows.length), "success");
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
    }
  });

  /**
   * Load participant data for every result, ten at a time.
   *
   * The synchronous analytics query this page uses returns
   * `AnalyticsConversationWithoutAttributes` — participant data is simply not
   * in the results — so filtering on it means fetching each conversation. The
   * async job path would carry attributes for free, but ingestion lag on the
   * last 48 hours is the entire reason this page exists.
   *
   * Everything lands in `realtimeCache`, which the row expansion and the detail
   * pane already read, so both become instant afterwards.
   *
   * A conversation whose fetch fails is left out of the cache. It then matches
   * nothing and is dropped from the results, in either filter direction — the
   * same rule Disconnect uses: a filter that cannot be evaluated excludes rather
   * than guesses. The count is reported so it is never silent.
   *
   * @returns {Promise<{loaded: number, failed: number}>}
   */
  async function loadParticipantData(convs) {
    const orgId = orgContext.get();
    let loaded = 0;
    let failed = 0;

    for (let i = 0; i < convs.length && !cancelled; i += REQUEST_BATCH) {
      const chunk = convs.slice(i, i + REQUEST_BATCH);
      setStatus(STATUS.loadingPd(i, convs.length));
      showProgress((i / convs.length) * 100);

      await Promise.all(chunk.map(async (c) => {
        const id = c.conversationId;
        if (realtimeCache[id]) { loaded++; return; }
        try {
          realtimeCache[id] = await gc.getConversation(api, orgId, id);
          loaded++;
        } catch (err) {
          failed++;
          console.warn(`Could not load participant data for ${id}:`, err.message);
        }
      }));

      if (i + REQUEST_BATCH < convs.length) await sleep(50);
    }
    return { loaded, failed };
  }

  // ── Search ────────────────────────────────────────────
  $searchBtn.addEventListener("click", async () => {
    clearResults();
    $searchBtn.disabled = true;
    const orgId = orgContext.get();

    try {
      const body = {};
      const segmentPredicates = [];
      const queueId      = ssQueue.getValue();
      const directionVal = ssDirection.getValue();
      const mediaVal     = ssMedia.getValue();
      const divisionId   = ssDivision.getValue();
      if (queueId)      segmentPredicates.push({ dimension: "queueId",   value: queueId });
      if (directionVal) segmentPredicates.push({ dimension: "direction", value: directionVal });
      if (mediaVal)     segmentPredicates.push({ dimension: "mediaType", value: mediaVal });
      if (segmentPredicates.length) {
        body.segmentFilters = [{ type: "and", predicates: segmentPredicates }];
      }
      if (divisionId) {
        body.conversationFilters = [{ type: "and", predicates: [{ dimension: "divisionId", value: divisionId }] }];
      }

      const now = new Date();
      if (selectedPeriod === 'last48') {
        const from48 = new Date(now.getTime() - 48 * 60 * 60 * 1000);
        body.interval = `${from48.toISOString()}/${now.toISOString()}`;
      } else if (selectedPeriod === 'today') {
        body.interval = buildInterval(todayStr(), todayStr());
      } else {
        body.interval = buildInterval(daysAgoStr(1), daysAgoStr(1));
      }

      setStatus("Searching…");
      showProgress(10);

      const allConvs = await gc.queryConversationDetails(api, orgId, body, {
        maxPages: 50,
        onProgress: (n) => {
          setStatus(`Fetching… (${n} so far)`);
          showProgress(10 + Math.min(n / 5, 85));
        },
      });

      conversations = allConvs;
      resultsFilters = [];

      const filters = [...pdFilters];
      const exclude = $pdExclude.checked;
      const total = conversations.length;

      if (filters.length && total) {
        // The cost is one call per result, so say so before spending it rather
        // than during. Roughly a quarter-second per batch of ten.
        const estimate = Math.max(1, Math.round(total / REQUEST_BATCH * 0.25));
        const proceed = total <= PD_CONFIRM_OVER || confirm(
          `${total.toLocaleString()} interactions matched your search.

`
          + `Participant data is not part of the search results, so applying the `
          + `filters means loading it for each one — about ${estimate} seconds.

`
          + "Continue?");

        if (proceed) {
          cancelled = false;
          $cancelBtn.style.display = "";
          const { failed } = await loadParticipantData(conversations);
          $cancelBtn.style.display = "none";

          if (cancelled) {
            // A partial load would filter against data that is only partly
            // there, quietly dropping whatever had not arrived. Show everything
            // instead and say the filters did not run.
            setStatus(STATUS.pdCancelled);
          } else {
            resultsFilters = filters;
            resultsExclude = exclude;
            const cached = conversations
              .map((c) => realtimeCache[c.conversationId])
              .filter(Boolean);
            // Built from `cached`, so a conversation whose fetch failed is
            // absent from the set and dropped in *either* direction. A filter
            // that could not be evaluated excludes rather than guesses; the
            // count is reported below either way.
            const keep = new Set(filterByPD(cached, filters, exclude).map((c) => c.id));
            conversations = conversations.filter((c) => keep.has(c.conversationId));

            const note = failed
              ? ` ${failed} could not be loaded and ${failed === 1 ? "was" : "were"} left out.`
              : "";
            setStatus(
              conversations.length
                ? STATUS.foundFiltered(conversations.length, total) + note
                : STATUS.noFilterMatch(total) + note,
              conversations.length ? "success" : "");
          }
        } else {
          setStatus(STATUS.pdSkipped(total));
        }
      }

      rows = conversations.map(toRow);
      renderRows();
      const chartShown = renderDistChart();
      updateResultsToggle();
      setResultsCollapsed(chartShown && rows.length > 0);
      showProgress(100);

      if (!filters.length || !total) {
        setStatus(rows.length ? STATUS.found(rows.length) : STATUS.noResults,
                  rows.length ? "success" : "");
      }
    } catch (err) {
      setStatus(STATUS.error(err.message || String(err)), "error");
      console.error("Recent search error:", err);
    } finally {
      $searchBtn.disabled = false;
      $cancelBtn.style.display = "none";
      setTimeout(hideProgress, 800);
    }
  });

  $cancelBtn.addEventListener("click", () => { cancelled = true; });

  // ── Load queues + divisions on mount ──────────────────
  (async () => {
    try {
      const orgId = orgContext.get();
      const [queues, divisions] = await Promise.all([
        gc.fetchAllQueues(api, orgId),
        gc.fetchAllDivisions(api, orgId),
      ]);
      queues.sort((a, b) => a.name.localeCompare(b.name));
      divisions.sort((a, b) => a.name.localeCompare(b.name));

      ssQueue.setItems(queues.map(q => ({ id: q.id, label: q.name })));
      ssQueue.setEnabled(true);

      ssDivision.setItems(divisions.map(d => ({ id: d.id, label: d.name })));
      ssDivision.setEnabled(true);
    } catch (err) {
      console.error("Failed to load queues/divisions:", err.message);
      ssQueue.setEnabled(true);
      ssDivision.setEnabled(true);
    }
  })();

  return el;
}
