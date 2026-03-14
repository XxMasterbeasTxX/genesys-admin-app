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
import { escapeHtml, formatDateTime, buildInterval, todayStr, daysAgoStr,
         exportXlsx, timestampedFilename } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { createSingleSelect } from "../../components/multiSelect.js";

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
const STATUS = {
  ready:     "Ready. Select a date range and click Search.",
  found:     (n) => `Found ${n} conversation${n !== 1 ? "s" : ""}. Click a row to load participant data.`,
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
  let rows = [];
  let selectedIdx = -1;

  const today     = todayStr();
  const yesterday = daysAgoStr(1);

  el.innerHTML = `
    <h1 class="h1">Recent Interaction Search</h1>
    <hr class="hr">

    <p class="page-desc">
      Search conversations from the last 48 hours. Results are returned immediately
      without analytics processing delay. Click a row to load full participant data.
    </p>

    <div class="is-info-banner">
      &#9432; For conversations older than ~48 hours, or to filter by participant data,
      use <a href="#/interactions/search/historical" class="is-link">Historical Search</a>.
    </div>

    <!-- Controls row -->
    <div class="is-controls">
      <div class="is-control-group">
        <label class="is-label">Date From</label>
        <input type="date" class="input is-date" id="rsDateFrom" value="${yesterday}">
      </div>
      <div class="is-control-group">
        <label class="is-label">Date To</label>
        <input type="date" class="input is-date" id="rsDateTo" value="${today}">
      </div>
      <div class="is-control-group">
        <label class="is-label">Queue</label>
        <div id="rsQueueDropdown"></div>
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

    <!-- Action buttons -->
    <div class="is-actions">
      <button class="btn" id="rsSearchBtn">Search</button>
      <button class="btn" id="rsExportBtn" disabled>Export Excel</button>
      <button class="btn" id="rsClearBtn">Clear Results</button>
    </div>

    <div class="is-hint">Tip: Right-click a row to copy the Conversation ID to clipboard.</div>

    <div class="is-status" id="rsStatus">${STATUS.ready}</div>

    <div class="is-progress-wrap" id="rsProgressWrap" style="display:none">
      <div class="is-progress-bar" id="rsProgressBar"></div>
    </div>

    <!-- Results area: table + detail pane -->
    <div class="is-results">
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
  `;

  // ── DOM refs ─────────────────────────────────────────
  const $dateFrom     = el.querySelector("#rsDateFrom");
  const $dateTo       = el.querySelector("#rsDateTo");
  const $searchBtn    = el.querySelector("#rsSearchBtn");
  const $exportBtn    = el.querySelector("#rsExportBtn");
  const $clearBtn     = el.querySelector("#rsClearBtn");
  const $status       = el.querySelector("#rsStatus");
  const $progressWrap = el.querySelector("#rsProgressWrap");
  const $progressBar  = el.querySelector("#rsProgressBar");
  const $tbody        = el.querySelector("#rsTbody");
  const $detail       = el.querySelector("#rsDetailContent");

  // ── Single-select dropdowns ───────────────────────────
  const ssQueue = createSingleSelect({ placeholder: "All queues", searchable: true });
  el.querySelector("#rsQueueDropdown").append(ssQueue.el);
  ssQueue.setEnabled(false);

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
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "is-status" + (type ? ` is-status--${type}` : "");
  }
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
    let html = "";
    rows.forEach((r, i) => {
      const rowClass = [
        "is-row",
        i % 2 === 1 ? "is-row-alt" : "",
        i === selectedIdx ? "is-row-selected" : "",
      ].filter(Boolean).join(" ");
      html += `<tr class="${rowClass}" data-idx="${i}">
        ${COLUMNS.map((c) => `<td>${escapeHtml(r[c.key])}</td>`).join("")}
      </tr>`;
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
    selectedIdx = idx;
    renderRows();
    $detail.textContent = "Loading participant data…";

    const orgId = orgContext.get();
    try {
      const conv = await gc.getConversation(api, orgId, rows[idx].conversationId);
      showDetailFromRealtime(conv);
    } catch (err) {
      $detail.textContent = `Error loading participant data: ${err.message}`;
    }
  }

  /**
   * Format detail from GET /api/v2/conversations/{id} response.
   * This endpoint uses a different schema than the analytics API:
   * - conv.id (not conversationId)
   * - conv.startTime / conv.endTime (not conversationStart/End)
   * - p.attributes is a flat object (same as analytics)
   * - p.disconnectType is directly on participant (not nested in sessions)
   */
  function showDetailFromRealtime(conv) {
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

        const attrs = p.attributes || {};
        const attrKeys = Object.keys(attrs).sort();
        if (attrKeys.length) {
          lines.push("  Participant Data:");
          for (const k of attrKeys) lines.push(`    ${k} = ${attrs[k]}`);
        } else {
          lines.push("  (no participant data)");
        }

        if (p.disconnectType) lines.push(`  Disconnect: ${p.disconnectType}`);
        lines.push("");
      });
    }

    $detail.textContent = lines.join("\n");
  }

  // ── Clear results ─────────────────────────────────────
  function clearResults() {
    conversations = [];
    rows = [];
    selectedIdx = -1;
    $tbody.innerHTML = "";
    $detail.textContent = "Select a row to load participant data.";
    $exportBtn.disabled = true;
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

  // ── Search ────────────────────────────────────────────
  $searchBtn.addEventListener("click", async () => {
    const dateFrom = $dateFrom.value;
    const dateTo   = $dateTo.value;
    if (!dateFrom || !dateTo) {
      setStatus("Please select both dates.", "error");
      return;
    }
    if (dateFrom > dateTo) {
      setStatus("'Date From' must be before 'Date To'.", "error");
      return;
    }

    clearResults();
    $searchBtn.disabled = true;
    const orgId = orgContext.get();

    try {
      const body = {};
      const segmentPredicates = [];
      const queueId    = ssQueue.getValue();
      const mediaVal   = ssMedia.getValue();
      const divisionId = ssDivision.getValue();
      if (queueId)  segmentPredicates.push({ dimension: "queueId",   value: queueId });
      if (mediaVal) segmentPredicates.push({ dimension: "mediaType", value: mediaVal });
      if (segmentPredicates.length) {
        body.segmentFilters = [{ type: "and", predicates: segmentPredicates }];
      }
      if (divisionId) {
        body.conversationFilters = [{ type: "and", predicates: [{ dimension: "divisionId", value: divisionId }] }];
      }

      body.interval = buildInterval(dateFrom, dateTo);

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
      rows = conversations.map(toRow);
      renderRows();
      showProgress(100);

      if (rows.length > 0) {
        setStatus(STATUS.found(rows.length), "success");
      } else {
        setStatus(STATUS.noResults);
      }
    } catch (err) {
      setStatus(STATUS.error(err.message || String(err)), "error");
      console.error("Recent search error:", err);
    } finally {
      $searchBtn.disabled = false;
      setTimeout(hideProgress, 800);
    }
  });

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
