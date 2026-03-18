/**
 * Interactions › Transcripts › Search
 *
 * Searches conversations for a single day (with optional time window)
 * and checks whether a STA transcript exists for each one.
 *
 * Flow:
 *   1. User picks a date, optional time range, queue, media type, direction
 *   2. Analytics jobs API returns conversations for the period
 *   3. User clicks "Check Transcripts" — page processes in batches of 10
 *   4. Each conversation: GET /api/v2/conversations/{id} → communicationId
 *                         GET /api/v2/speechandtextanalytics/conversations/{id}/communications/{commId}/transcripturl
 *   5. Clicking a row expands to show the transcript content (fetched on demand)
 *   6. Stacked bar chart updates live; transcript filter above table; export to Excel
 *
 * API endpoints used:
 *   POST /api/v2/analytics/conversations/details/jobs        — submit async job
 *   GET  /api/v2/analytics/conversations/details/jobs/{id}   — poll job status
 *   GET  /api/v2/analytics/conversations/details/jobs/{id}/results — fetch results
 *   GET  /api/v2/conversations/{id}                          — get communicationId
 *   GET  /api/v2/speechandtextanalytics/conversations/{id}/communications/{commId}/transcripturl
 *   GET  {s3PreSignedUrl}                                    — fetch transcript JSON
 */
import {
  escapeHtml, formatDateTime, buildInterval, todayStr,
  exportXlsx, timestampedFilename, sleep,
} from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createSingleSelect } from "../../../components/multiSelect.js";

// ── Concurrency knob ─────────────────────────────────────────────────
const CONCURRENCY = 3;
const MAX_RETRIES  = 6;

// ── Column definitions ───────────────────────────────────────────────
const COLUMNS = [
  { key: "conversationId", label: "Conversation ID", width: "220px" },
  { key: "startTime",      label: "Start Time",      width: "160px" },
  { key: "endTime",        label: "End Time",        width: "160px" },
  { key: "queue",          label: "Queue",           width: "160px" },
  { key: "agentName",      label: "Agent",           width: "140px" },
  { key: "mediaType",      label: "Media Type",      width: "100px" },
  { key: "direction",      label: "Direction",       width: "90px"  },
  { key: "transcriptStatus", label: "Transcript",    width: "100px" },
];

// ── Export column definitions (Sheet 1 — no width needed for XLSX) ───
const EXPORT_COLUMNS = [
  { key: "conversationId",    label: "Conversation ID"       },
  { key: "startTime",         label: "Start Time"            },
  { key: "endTime",           label: "End Time"              },
  { key: "duration",          label: "Duration (s)"          },
  { key: "queue",             label: "Queue"                 },
  { key: "agentName",         label: "Agent"                 },
  { key: "mediaType",         label: "Media Type"            },
  { key: "direction",         label: "Direction"             },
  { key: "transcriptStatus",  label: "Transcript Exists"     },
  { key: "transcriptCheckedAt", label: "Checked At"          },
];

// ── Status messages ──────────────────────────────────────────────────
const STATUS = {
  ready:     "Ready. Select a date and click Search.",
  found:     (n) => `Found ${n} conversation${n !== 1 ? "s" : ""}. Click "Check Transcripts" to verify.`,
  noResults: "No conversations found for the selected filters.",
  checking:  (done, total) => `Checking transcripts… ${done} / ${total}`,
  done:      (found, total) => `Done. ${found} of ${total} conversations have a transcript.`,
  exported:  (n) => `Exported ${n} rows to Excel.`,
  cancelled: "Transcript check cancelled.",
  error:     (msg) => `Error: ${msg}`,
  idReady:   "Ready. Paste one or more conversation IDs and click Search.",
};

// ── Transcript status constants ──────────────────────────────────────
const TS = { UNCHECKED: "—", TRUE: "true", FALSE: "false", CHECKING: "…", ERROR: "error" };

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

function extractQueueName(participants, queueMap) {
  if (!participants) return "";
  for (const p of participants) {
    for (const s of p.sessions || []) {
      for (const seg of s.segments || []) {
        if (seg.queueId) return queueMap[seg.queueId] || seg.queueId;
      }
    }
  }
  return "";
}

function extractAgentName(participants) {
  if (!participants) return "";
  for (const p of participants) {
    if (p.purpose === "agent" && p.participantName) return p.participantName;
  }
  return "";
}

function durationSeconds(conv) {
  if (!conv.conversationStart || !conv.conversationEnd) return "";
  const ms = new Date(conv.conversationEnd) - new Date(conv.conversationStart);
  return Math.round(ms / 1000);
}

/** Build a display row from a raw analytics conversation object. */
function toRow(conv, queueMap) {
  return {
    conversationId:      conv.conversationId || "",
    startTime:           formatDateTime(conv.conversationStart),
    endTime:             formatDateTime(conv.conversationEnd),
    duration:            durationSeconds(conv),
    direction:           extractSessionField(conv.participants, "direction"),
    mediaType:           extractSessionField(conv.participants, "mediaType"),
    queue:               extractQueueName(conv.participants, queueMap),
    agentName:           extractAgentName(conv.participants),
    transcriptStatus:    TS.UNCHECKED,
    transcriptCheckedAt: "",
    transcriptPreview:   "",
    phraseCount:         "",
    firstMessage:        "",
    lastMessage:         "",
    _raw: conv,
    _transcriptContent: null,   // stored when transcript has been fetched
  };
}

/** Build a display row from a GET /api/v2/conversations/{id} response. */
function toRowFromConvDetail(conv, queueMap) {
  let direction = "";
  let mediaType = "";
  let queue     = "";

  for (const p of conv.participants || []) {
    for (const c of p.calls || []) {
      if (!direction && c.direction) direction = c.direction;
      if (!mediaType) mediaType = "voice";
    }
    for (const m of p.messages || []) {
      if (!direction && m.direction) direction = m.direction;
      if (!mediaType) mediaType = m.type || "message";
    }
    if (!queue && p.queueId) queue = queueMap[p.queueId] || p.queueId;
  }

  const agentParticipant = (conv.participants || []).find(p => p.purpose === "agent");
  const agentName = agentParticipant?.name || "";

  const dur = (conv.startTime && conv.endTime)
    ? Math.round((new Date(conv.endTime) - new Date(conv.startTime)) / 1000)
    : "";

  return {
    conversationId:      conv.id || "",
    startTime:           formatDateTime(conv.startTime),
    endTime:             formatDateTime(conv.endTime),
    duration:            dur,
    direction,
    mediaType,
    queue,
    agentName,
    transcriptStatus:    TS.UNCHECKED,
    transcriptCheckedAt: "",
    transcriptPreview:   "",
    phraseCount:         "",
    firstMessage:        "",
    lastMessage:         "",
    _raw: conv,
    _transcriptContent: null,
  };
}

/**
 * Build a concise transcript preview string from STA transcript phrases.
 * Returns { preview, phraseCount, firstMessage, lastMessage }.
 */
function buildTranscriptSummary(transcriptData) {
  const phrases = [];
  for (const t of transcriptData?.transcripts || []) {
    for (const p of t.phrases || []) {
      if (p.text) phrases.push({ speaker: p.participantPurpose, text: p.text });
    }
  }
  if (!phrases.length) return { preview: "", phraseCount: 0, firstMessage: "", lastMessage: "" };

  const first = phrases[0];
  const last  = phrases[phrases.length - 1];
  const PREVIEW_CHARS = 500;
  let preview = "";
  for (const ph of phrases) {
    const line = `[${ph.speaker}] ${ph.text}\n`;
    if (preview.length + line.length > PREVIEW_CHARS) {
      preview += "…";
      break;
    }
    preview += line;
  }
  return {
    preview: preview.trim(),
    phraseCount: phrases.length,
    firstMessage: `[${first.speaker}] ${first.text}`.slice(0, 200),
    lastMessage:  `[${last.speaker}] ${last.text}`.slice(0, 200),
  };
}

/**
 * Build a formatted transcript string for the expand panel.
 * Falls back to raw messages array for non-STA transcripts.
 */
function buildTranscriptHtml(row) {
  const content = row._transcriptContent;
  if (!content) return `<span class="ts-expand-none">No transcript content loaded.</span>`;

  // STA transcript
  if (content.type === "sta") {
    const data = content.data;
    const phrases = [];
    for (const t of data?.transcripts || []) {
      for (const p of t.phrases || []) {
        if (p.text) phrases.push(p);
      }
    }
    if (!phrases.length) return `<span class="ts-expand-none">Transcript exists but contains no phrases.</span>`;

    return phrases.map((p) => {
      const cls = p.participantPurpose === "internal" ? "ts-phrase ts-phrase--agent" : "ts-phrase ts-phrase--customer";
      const speaker = p.participantPurpose === "internal" ? "Agent" : "Customer";
      return `<div class="${cls}">
        <span class="ts-phrase-speaker">${escapeHtml(speaker)}</span>
        <span class="ts-phrase-text">${escapeHtml(p.text)}</span>
      </div>`;
    }).join("");
  }

  // Raw messages fallback
  if (content.type === "raw") {
    const msgs = content.data || [];
    if (!msgs.length) return `<span class="ts-expand-none">No messages found.</span>`;
    return `<div class="ts-expand-raw-note">No STA transcript — showing raw messages</div>` +
      msgs.map((m) => {
        const isAgent = m.fromAddress !== m.toAddress;
        const cls = isAgent ? "ts-phrase ts-phrase--agent" : "ts-phrase ts-phrase--customer";
        const speaker = isAgent ? "Agent" : "Customer";
        const text = m.textBody || m.normalizedMessage?.text || "";
        return `<div class="${cls}">
          <span class="ts-phrase-speaker">${escapeHtml(speaker)}</span>
          <span class="ts-phrase-text">${escapeHtml(text)}</span>
        </div>`;
      }).join("");
  }

  return `<span class="ts-expand-none">Unknown transcript format.</span>`;
}

// ── Page renderer ────────────────────────────────────────────────────

export default function renderTranscriptSearch({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Transcript Search</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ────────────────────────────────────────────
  let conversations = [];   // raw analytics results
  let rows = [];            // display rows (augmented with transcript state)
  let expandedIdx = -1;
  let checkAbortCtrl = null;
  let transcriptFilter = "all";  // "all" | "true" | "false" | "unchecked"
  let searchMode = "date";       // "date" | "ids"
  let queues = [];
  let queueMap = {};       // { id → name }

  // ── Build UI ─────────────────────────────────────────
  const todayVal = todayStr();

  el.innerHTML = `
    <h1 class="h1">Transcript Search</h1>
    <hr class="hr">

    <p class="page-desc">
      Search conversations for a single day and verify whether a Speech &amp; Text Analytics
      transcript exists for each one. Use the time filters to narrow down high-volume periods.
    </p>

    <!-- Search mode toggle -->
    <div class="ts-filter-bar" style="margin-bottom:14px">
      <span class="ts-filter-label">Search by:</span>
      <button class="ts-filter-btn ts-filter-active" id="tsModeDate">Date &amp; Filters</button>
      <button class="ts-filter-btn" id="tsModeIds">Conversation ID(s)</button>
    </div>

    <!-- Filter panel -->
    <div class="is-controls" id="tsDateControls">
      <div class="is-control-group">
        <label class="is-label">Date</label>
        <input type="date" class="input is-date" id="tsDate" value="${todayVal}" max="${todayVal}">
      </div>
      <div class="is-control-group">
        <label class="is-label">Time From</label>
        <input type="time" class="input ts-time" id="tsTimeFrom" value="00:00">
      </div>
      <div class="is-control-group">
        <label class="is-label">Time To</label>
        <input type="time" class="input ts-time" id="tsTimeTo" value="23:59">
      </div>
      <div class="is-control-group">
        <label class="is-label">Queue</label>
        <div id="tsQueueDropdown"></div>
      </div>
      <div class="is-control-group">
        <label class="is-label">Media Type</label>
        <div id="tsMediaDropdown"></div>
      </div>
      <div class="is-control-group">
        <label class="is-label">Direction</label>
        <div id="tsDirectionDropdown"></div>
      </div>
    </div>

    <!-- ID input panel -->
    <div id="tsIdControls" style="display:none">
      <div class="is-control-group" style="flex-direction:column;align-items:flex-start;gap:6px">
        <label class="is-label">Conversation ID(s)</label>
        <textarea class="input" id="tsIdInput" rows="5"
          style="width:100%;max-width:640px;resize:vertical;font-family:monospace;font-size:12px"
          placeholder="Paste one or more conversation IDs — separated by commas, spaces, or new lines…"></textarea>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="is-actions">
      <button class="btn" id="tsSearchBtn">Search</button>
      <button class="btn" id="tsCheckBtn" disabled>Check Transcripts</button>
      <button class="btn" id="tsCancelBtn" disabled style="display:none">Cancel Check</button>
      <button class="btn" id="tsClearBtn">Clear Results</button>
      <div style="margin-left:auto">
        <button class="btn" id="tsExportBtn" disabled>Export Interactions</button>
      </div>
    </div>

    <!-- Status -->
    <div class="is-status" id="tsStatus">${STATUS.ready}</div>

    <!-- Progress bar -->
    <div class="is-progress-wrap" id="tsProgressWrap" style="display:none">
      <div class="is-progress-bar" id="tsProgressBar"></div>
    </div>

    <!-- Stacked bar chart -->
    <div class="ts-chart-wrap" id="tsChartWrap" style="display:none">
      <div class="ts-chart-header">
        <span class="ts-chart-title">Transcript Status</span>
        <div class="ts-chart-legend">
          <span class="ts-legend-item ts-legend-found">Transcript Found</span>
          <span class="ts-legend-item ts-legend-none">No Transcript</span>
          <span class="ts-legend-item ts-legend-error">Error</span>
          <span class="ts-legend-item ts-legend-unchecked">Not Checked</span>
        </div>
      </div>
      <div class="ts-stacked-bar" id="tsStackedBar">
        <div class="ts-bar-found"     id="tsBarFound"     style="width:0%"></div>
        <div class="ts-bar-none"      id="tsBarNone"      style="width:0%"></div>
        <div class="ts-bar-error"     id="tsBarError"     style="width:0%"></div>
        <div class="ts-bar-unchecked" id="tsBarUnchecked" style="width:100%"></div>
      </div>
      <div class="ts-chart-counts" id="tsChartCounts"></div>
    </div>

    <!-- Transcript filter toggle -->
    <div class="ts-filter-bar" id="tsFilterBar" style="display:none">
      <span class="ts-filter-label">Show:</span>
      <button class="ts-filter-btn ts-filter-active" data-filter="all">All</button>
      <button class="ts-filter-btn" data-filter="true">Transcript Found</button>
      <button class="ts-filter-btn" data-filter="false">No Transcript</button>
      <button class="ts-filter-btn" data-filter="error">Error</button>
      <button class="ts-filter-btn" data-filter="unchecked">Not Checked</button>
    </div>

    <!-- Results area -->
    <div class="ts-results-section" id="tsResultsSection" style="display:none">
      <div class="is-results">
        <div class="is-table-wrap">
          <table class="data-table is-table" id="tsTable">
            <thead>
              <tr>${COLUMNS.map((c) => `<th style="width:${c.width}">${c.label}</th>`).join("")}</tr>
            </thead>
            <tbody id="tsTbody"></tbody>
          </table>
        </div>
        <div class="is-detail" id="tsDetail">
          <div class="is-detail-title">Transcript Content</div>
          <div class="ts-detail-content" id="tsDetailContent">
            <span class="ts-expand-none">Select a row to view transcript.</span>
          </div>
        </div>
      </div>
    </div>
  `;

  // ── DOM refs ─────────────────────────────────────────
  const $date        = el.querySelector("#tsDate");
  const $timeFrom    = el.querySelector("#tsTimeFrom");
  const $timeTo      = el.querySelector("#tsTimeTo");
  const $searchBtn   = el.querySelector("#tsSearchBtn");
  const $checkBtn    = el.querySelector("#tsCheckBtn");
  const $cancelBtn   = el.querySelector("#tsCancelBtn");
  const $clearBtn    = el.querySelector("#tsClearBtn");
  const $exportBtn   = el.querySelector("#tsExportBtn");
  const $status      = el.querySelector("#tsStatus");
  const $progressWrap = el.querySelector("#tsProgressWrap");
  const $progressBar  = el.querySelector("#tsProgressBar");
  const $chartWrap    = el.querySelector("#tsChartWrap");
  const $barFound     = el.querySelector("#tsBarFound");
  const $barNone      = el.querySelector("#tsBarNone");
  const $barError     = el.querySelector("#tsBarError");
  const $barUnchecked = el.querySelector("#tsBarUnchecked");
  const $chartCounts  = el.querySelector("#tsChartCounts");
  const $filterBar    = el.querySelector("#tsFilterBar");
  const $resultsSection = el.querySelector("#tsResultsSection");
  const $tbody        = el.querySelector("#tsTbody");
  const $detailContent = el.querySelector("#tsDetailContent");
  const $modeDateBtn  = el.querySelector("#tsModeDate");
  const $modeIdsBtn   = el.querySelector("#tsModeIds");
  const $dateControls = el.querySelector("#tsDateControls");
  const $idControls   = el.querySelector("#tsIdControls");
  const $idInput      = el.querySelector("#tsIdInput");

  // ── Dropdowns ────────────────────────────────────────
  const ssQueue = createSingleSelect({ placeholder: "All queues", searchable: true });
  el.querySelector("#tsQueueDropdown").append(ssQueue.el);
  ssQueue.setEnabled(false);

  const ssMedia = createSingleSelect({ placeholder: "All", searchable: false });
  el.querySelector("#tsMediaDropdown").append(ssMedia.el);
  ssMedia.setItems([
    { id: "voice",    label: "Voice"    },
    { id: "message",  label: "Message"  },
    { id: "email",    label: "Email"    },
    { id: "callback", label: "Callback" },
  ]);

  const ssDirection = createSingleSelect({ placeholder: "All", searchable: false });
  el.querySelector("#tsDirectionDropdown").append(ssDirection.el);
  ssDirection.setItems([
    { id: "inbound",  label: "Inbound"  },
    { id: "outbound", label: "Outbound" },
  ]);

  // ── Status / progress ────────────────────────────────
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

  // ── Stacked bar chart ─────────────────────────────────
  function updateChart() {
    const total     = rows.length;
    if (!total) { $chartWrap.style.display = "none"; return; }

    const found     = rows.filter(r => r.transcriptStatus === TS.TRUE).length;
    const notFound  = rows.filter(r => r.transcriptStatus === TS.FALSE).length;
    const errored   = rows.filter(r => r.transcriptStatus === TS.ERROR).length;
    const unchecked = total - found - notFound - errored;

    const pFound     = (found     / total * 100).toFixed(1);
    const pNone      = (notFound  / total * 100).toFixed(1);
    const pError     = (errored   / total * 100).toFixed(1);
    const pUnchecked = (unchecked / total * 100).toFixed(1);

    $barFound.style.width     = `${pFound}%`;
    $barNone.style.width      = `${pNone}%`;
    $barError.style.width     = `${pError}%`;
    $barUnchecked.style.width = `${pUnchecked}%`;

    $chartCounts.innerHTML = `
      <span class="ts-count-found">${found} found (${pFound}%)</span>
      <span class="ts-count-none">${notFound} none (${pNone}%)</span>
      ${errored ? `<span class="ts-count-error">${errored} error (${pError}%)</span>` : ""}
      ${unchecked ? `<span class="ts-count-unchecked">${unchecked} not checked (${pUnchecked}%)</span>` : ""}
    `;
    $chartWrap.style.display = "";
  }

  // ── Transcript filter bar ────────────────────────────
  $filterBar.querySelectorAll(".ts-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      transcriptFilter = btn.dataset.filter;
      $filterBar.querySelectorAll(".ts-filter-btn").forEach(b => b.classList.remove("ts-filter-active"));
      btn.classList.add("ts-filter-active");
      renderRows();
    });
  });

  // ── Search mode toggle ────────────────────────────────
  function setSearchMode(mode) {
    searchMode = mode;
    $modeDateBtn.classList.toggle("ts-filter-active", mode === "date");
    $modeIdsBtn.classList.toggle("ts-filter-active", mode === "ids");
    $dateControls.style.display = mode === "date" ? "" : "none";
    $idControls.style.display   = mode === "ids"  ? "" : "none";
    setStatus(mode === "ids" ? STATUS.idReady : STATUS.ready);
  }
  $modeDateBtn.addEventListener("click", () => setSearchMode("date"));
  $modeIdsBtn.addEventListener("click",  () => setSearchMode("ids"));

  // ── Render table rows ─────────────────────────────────
  function getVisibleRows() {
    if (transcriptFilter === "all")       return rows;
    if (transcriptFilter === "true")      return rows.filter(r => r.transcriptStatus === TS.TRUE);
    if (transcriptFilter === "false")     return rows.filter(r => r.transcriptStatus === TS.FALSE);
    if (transcriptFilter === "error")     return rows.filter(r => r.transcriptStatus === TS.ERROR);
    if (transcriptFilter === "unchecked") return rows.filter(r => r.transcriptStatus === TS.UNCHECKED || r.transcriptStatus === TS.CHECKING);
    return rows;
  }

  function renderRows() {
    const visible = getVisibleRows();
    let html = "";
    visible.forEach((r, i) => {
      const isExpanded = rows.indexOf(r) === expandedIdx;
      const rowIdx     = rows.indexOf(r);
      const statusCls  = r.transcriptStatus === TS.TRUE   ? "ts-status-true"
                       : r.transcriptStatus === TS.FALSE  ? "ts-status-false"
                       : r.transcriptStatus === TS.CHECKING ? "ts-status-checking"
                       : r.transcriptStatus === TS.ERROR  ? "ts-status-error"
                       : "ts-status-unchecked";
      const rowCls = [
        "is-row",
        i % 2 === 1 ? "is-row-alt" : "",
        isExpanded ? "is-row-expanded" : "",
      ].filter(Boolean).join(" ");

      html += `<tr class="${rowCls}" data-row-idx="${rowIdx}">`;
      for (const c of COLUMNS) {
        if (c.key === "transcriptStatus") {
          html += `<td><span class="ts-status-badge ${statusCls}">${escapeHtml(r.transcriptStatus)}</span></td>`;
        } else {
          html += `<td>${escapeHtml(String(r[c.key] ?? ""))}</td>`;
        }
      }
      html += `</tr>`;

      if (isExpanded) {
        html += `<tr class="is-expand-row" data-expand-for="${rowIdx}">
          <td colspan="${COLUMNS.length}">
            <div class="ts-expand-panel">
              <div class="ts-expand-transcript" id="tsExpandTranscript_${rowIdx}">
                ${buildTranscriptHtml(r)}
              </div>
            </div>
          </td>
        </tr>`;
      }
    });
    $tbody.innerHTML = html;

    $tbody.querySelectorAll(".is-row").forEach((tr) => {
      tr.addEventListener("click", () => {
        const idx = Number(tr.dataset.rowIdx);
        if (expandedIdx === idx) {
          expandedIdx = -1;
        } else {
          expandedIdx = idx;
          // Load transcript content into detail pane
          showDetailForRow(idx);
        }
        renderRows();
      });
    });
  }

  // ── Detail pane ──────────────────────────────────────
  function showDetailForRow(idx) {
    const row = rows[idx];
    if (!row) return;

    if (row.transcriptStatus === TS.UNCHECKED || row.transcriptStatus === TS.CHECKING) {
      $detailContent.innerHTML = `<span class="ts-expand-none">Transcript not yet checked for this conversation.</span>`;
      return;
    }
    if (row.transcriptStatus === TS.FALSE) {
      $detailContent.innerHTML = `<span class="ts-expand-none">No transcript found for this conversation.</span>`;
      return;
    }
    if (row.transcriptStatus === TS.ERROR) {
      $detailContent.innerHTML = `<span class="ts-expand-none">Transcript check failed for this conversation.</span>`;
      return;
    }

    // TRUE — content may already be loaded or needs fetching
    if (row._transcriptContent) {
      $detailContent.innerHTML = buildTranscriptHtml(row);
      return;
    }

    // Fetch content on demand
    $detailContent.innerHTML = `<span class="ts-expand-none">Loading transcript…</span>`;
    fetchTranscriptContent(idx)
      .then(() => {
        if (expandedIdx === idx) {
          $detailContent.innerHTML = buildTranscriptHtml(rows[idx]);
          renderRows(); // re-render expanded row too
        }
      })
      .catch((err) => {
        $detailContent.innerHTML = `<span class="ts-expand-none">Failed to load transcript: ${escapeHtml(err.message)}</span>`;
      });
  }

  // ── Transcript content fetcher ────────────────────────
  /**
   * For a row that is confirmed TRUE, fetch the pre-signed S3 URL and
   * then download the transcript JSON. Stores result in row._transcriptContent.
   */
  async function fetchTranscriptContent(idx) {
    const row  = rows[idx];
    const orgId = orgContext.get();

    // We need the communicationId — stored from the check phase
    if (!row._communicationId) {
      // Attempt to re-derive it by looking up the conversation
      const convDetail = await api.proxyGenesys(orgId, "GET",
        `/api/v2/conversations/${row.conversationId}`);
      row._communicationId = extractCustomerCommunicationId(convDetail, row.mediaType);
    }

    if (!row._communicationId) {
      throw new Error("Could not determine communication ID");
    }

    // Fetch the pre-signed URL
    const urlResp = await api.proxyGenesys(orgId, "GET",
      `/api/v2/speechandtextanalytics/conversations/${row.conversationId}/communications/${row._communicationId}/transcripturl`);

    const s3Url = urlResp?.url;
    if (!s3Url) throw new Error("No presigned URL returned");

    // Fetch the transcript JSON from S3 (direct fetch — no auth needed for pre-signed URL)
    const s3Resp = await fetch(s3Url);
    if (!s3Resp.ok) throw new Error(`S3 fetch failed: ${s3Resp.status}`);
    const data = await s3Resp.json();

    // Build summary for export columns
    const summary = buildTranscriptSummary(data);
    row.transcriptPreview = summary.preview;
    row.phraseCount       = summary.phraseCount;
    row.firstMessage      = summary.firstMessage;
    row.lastMessage       = summary.lastMessage;

    row._transcriptContent = { type: "sta", data };
  }

  /**
   * Extract the customer participant's communicationId from a
   * GET /api/v2/conversations/{id} response.
   * Falls back to agent, then any first communication found.
   */
  function extractCustomerCommunicationId(convDetail, mediaType) {
    const mediaKey = (mediaType || "").toLowerCase() === "voice" ? "calls" : "messages";
    // Prefer customer participant
    for (const p of convDetail?.participants || []) {
      if (p.purpose === "customer") {
        for (const comm of p[mediaKey] || p.calls || p.messages || []) {
          if (comm.id) return comm.id;
        }
      }
    }
    // Fallback: any participant
    for (const p of convDetail?.participants || []) {
      for (const key of ["messages", "calls"]) {
        for (const comm of p[key] || []) {
          if (comm.id) return comm.id;
        }
      }
    }
    return null;
  }

  // ── Check transcripts (batched) ──────────────────────
  async function checkTranscripts() {
    if (!rows.length) return;

    checkAbortCtrl = new AbortController();
    const signal = checkAbortCtrl.signal;

    $checkBtn.disabled = true;
    $cancelBtn.style.display  = "";
    $cancelBtn.disabled = false;
    $exportBtn.disabled = true;
    updateChart();
    showProgress(0);

    const orgId = orgContext.get();
    let done    = 0;
    const total = rows.length;

    try {
      // Process in batches of CONCURRENCY
      for (let i = 0; i < total; i += CONCURRENCY) {
        if (signal.aborted) break;

        const batch = rows.slice(i, i + CONCURRENCY);

        // Mark batch as checking
        for (const r of batch) {
          if (r.transcriptStatus === TS.UNCHECKED) r.transcriptStatus = TS.CHECKING;
        }
        renderRows();
        updateChart();

        await Promise.all(batch.map(async (row) => {
          if (signal.aborted) return;
          try {
            // Retry loop for rate-limited calls
            let convDetail;
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
              try {
                convDetail = await api.proxyGenesys(orgId, "GET",
                  `/api/v2/conversations/${row.conversationId}`);
                break;
              } catch (err) {
                if (err.status === 429 && attempt < MAX_RETRIES - 1) {
                  await sleep(3000 * (attempt + 1) + Math.random() * 1000);
                } else {
                  throw err;
                }
              }
            }

            const commId = extractCustomerCommunicationId(convDetail, row.mediaType);
            row._communicationId = commId;

            if (!commId) {
              row.transcriptStatus    = TS.FALSE;
              row.transcriptCheckedAt = formatDateTime(new Date());
            } else {
              // Check if transcript URL exists (200 = exists, 404 = does not)
              let staAttempts = 0;
              while (staAttempts < MAX_RETRIES) {
                try {
                  await api.proxyGenesys(orgId, "GET",
                    `/api/v2/speechandtextanalytics/conversations/${row.conversationId}/communications/${commId}/transcripturl`);
                  row.transcriptStatus    = TS.TRUE;
                  row.transcriptCheckedAt = formatDateTime(new Date());
                  break;
                } catch (err) {
                  if (err.status === 404 || err.status === 400 || err.status === 403) {
                    row.transcriptStatus    = TS.FALSE;
                    row.transcriptCheckedAt = formatDateTime(new Date());
                    break;
                  } else if (err.status === 429 && staAttempts < MAX_RETRIES - 1) {
                    staAttempts++;
                    await sleep(3000 * staAttempts + Math.random() * 1000);
                  } else {
                    row.transcriptStatus    = TS.ERROR;
                    row.transcriptCheckedAt = formatDateTime(new Date());
                    break;
                  }
                }
              }
            }
          } catch (err) {
            // 404 = conversation purged; 400/403 = not accessible — treat as "no transcript"
            if (err.status === 404 || err.status === 400 || err.status === 403) {
              row.transcriptStatus    = TS.FALSE;
            } else {
              row.transcriptStatus    = TS.ERROR;
            }
            row.transcriptCheckedAt = formatDateTime(new Date());
          }

          done++;
          const pct = Math.round(done / total * 100);
          showProgress(pct);
          setStatus(STATUS.checking(done, total));
        }));

        renderRows();
        updateChart();

        // Inter-batch delay to stay under rate limits
        if (i + CONCURRENCY < total && !signal.aborted) {
          await sleep(600);
        }
      }

      if (signal.aborted) {
        setStatus(STATUS.cancelled);
      } else {
        const found   = rows.filter(r => r.transcriptStatus === TS.TRUE).length;
        const errored = rows.filter(r => r.transcriptStatus === TS.ERROR).length;
        const doneSuffix = errored ? ` (${errored} error${errored !== 1 ? "s" : ""} — retry may help)` : "";
        setStatus(STATUS.done(found, total) + doneSuffix, errored ? "" : "success");
      }

    } catch (err) {
      setStatus(STATUS.error(err.message || String(err)), "error");
    } finally {
      $checkBtn.disabled  = !rows.length;
      $cancelBtn.style.display = "none";
      $cancelBtn.disabled = true;
      $exportBtn.disabled = !rows.length;
      checkAbortCtrl = null;
      setTimeout(hideProgress, 800);
    }

    renderRows();
    updateChart();
  }

  // ── Clear results ─────────────────────────────────────
  function clearResults() {
    if (checkAbortCtrl) checkAbortCtrl.abort();
    conversations  = [];
    rows           = [];
    expandedIdx    = -1;
    transcriptFilter = "all";
    $filterBar.querySelectorAll(".ts-filter-btn").forEach(b => {
      b.classList.toggle("ts-filter-active", b.dataset.filter === "all");
    });
    $tbody.innerHTML = "";
    $detailContent.innerHTML = `<span class="ts-expand-none">Select a row to view transcript.</span>`;
    $checkBtn.disabled  = true;
    $exportBtn.disabled = true;
    $cancelBtn.style.display = "none";
    $chartWrap.style.display = "none";
    $filterBar.style.display = "none";
    $resultsSection.style.display = "none";
    hideProgress();
    setStatus(STATUS.ready);
  }
  $clearBtn.addEventListener("click", clearResults);

  // ── Cancel ────────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => {
    if (checkAbortCtrl) checkAbortCtrl.abort();
  });

  // ── Check transcripts button ──────────────────────────
  $checkBtn.addEventListener("click", checkTranscripts);

  // ── Export ────────────────────────────────────────────
  $exportBtn.addEventListener("click", () => {
    if (!rows.length) return;
    const visibleRows = getVisibleRows();
    try {
      exportXlsx(
        [{ name: "Transcript Check", rows: visibleRows, columns: EXPORT_COLUMNS }],
        timestampedFilename("TranscriptSearch", "xlsx"),
      );
      setStatus(STATUS.exported(visibleRows.length), "success");
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
    }
  });

  // ── SEARCH ────────────────────────────────────────────

  async function searchByIds() {
    const raw = $idInput.value.trim();
    if (!raw) {
      setStatus("Please paste at least one conversation ID.", "error");
      return;
    }

    // Split on whitespace, commas, semicolons — deduplicate
    const ids = [...new Set(
      raw.split(/[\s,;]+/).map(s => s.trim()).filter(s => s.length > 0)
    )];

    if (!ids.length) {
      setStatus("No valid IDs found.", "error");
      return;
    }

    clearResults();
    $searchBtn.disabled = true;
    showProgress(0);

    const orgId = orgContext.get();
    let done = 0;
    let skipped = 0;
    const loadedRows = [];

    try {
      setStatus(`Loading ${ids.length} conversation${ids.length !== 1 ? "s" : ""}…`);

      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const batch = ids.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(async (id) => {
          try {
            const conv = await api.proxyGenesys(orgId, "GET", `/api/v2/conversations/${id}`);
            return toRowFromConvDetail(conv, queueMap);
          } catch {
            skipped++;
            return null;
          }
        }));
        for (const r of results) if (r) loadedRows.push(r);
        done += batch.length;
        showProgress(Math.round(done / ids.length * 100));
      }

      rows         = loadedRows;
      conversations = rows.map(r => r._raw);

      renderRows();
      updateChart();
      $filterBar.style.display      = rows.length ? "" : "none";
      $resultsSection.style.display = rows.length ? "" : "none";
      $checkBtn.disabled            = !rows.length;

      if (rows.length) {
        const suffix = skipped ? ` (${skipped} ID${skipped !== 1 ? "s" : ""} not found)` : "";
        setStatus(`Loaded ${rows.length} conversation${rows.length !== 1 ? "s" : ""}${suffix}. Click "Check Transcripts" to verify.`, "success");
      } else {
        setStatus("No conversations found for the given IDs.");
      }
    } catch (err) {
      setStatus(STATUS.error(err.message || String(err)), "error");
      console.error("ID search error:", err);
    } finally {
      $searchBtn.disabled = false;
      setTimeout(hideProgress, 800);
    }
  }

  $searchBtn.addEventListener("click", async () => {
    if (searchMode === "ids") { await searchByIds(); return; }

    const date     = $date.value;
    const timeFrom = $timeFrom.value || "00:00";
    const timeTo   = $timeTo.value   || "23:59";

    if (!date) {
      setStatus("Please select a date.", "error");
      return;
    }
    if (timeFrom >= timeTo) {
      setStatus("'Time From' must be before 'Time To'.", "error");
      return;
    }

    clearResults();
    $searchBtn.disabled = true;

    try {
      const interval = `${date}T${timeFrom}:00.000Z/${date}T${timeTo}:59.999Z`;
      const orgId    = orgContext.get();

      // Build server-side filters
      const jobBody = {};
      const segmentPredicates = [];
      const queueId      = ssQueue.getValue();
      const mediaVal     = ssMedia.getValue();
      const directionVal = ssDirection.getValue();
      if (queueId)      segmentPredicates.push({ dimension: "queueId",   value: queueId });
      if (mediaVal)     segmentPredicates.push({ dimension: "mediaType", value: mediaVal });
      if (directionVal) segmentPredicates.push({ dimension: "direction", value: directionVal });
      if (segmentPredicates.length) {
        jobBody.segmentFilters = [{ type: "and", predicates: segmentPredicates }];
      }

      const allConvs = await gc.searchConversations(api, orgId, {
        interval,
        jobBody: Object.keys(jobBody).length ? jobBody : undefined,
        onStatus: (msg) => setStatus(msg),
        onProgress: (pct) => showProgress(pct),
      });

      conversations = allConvs;
      rows          = conversations.map(c => toRow(c, queueMap));

      renderRows();
      updateChart();

      $filterBar.style.display    = rows.length ? "" : "none";
      $resultsSection.style.display = rows.length ? "" : "none";
      $checkBtn.disabled          = !rows.length;

      if (rows.length) {
        setStatus(STATUS.found(rows.length), "success");
      } else {
        setStatus(STATUS.noResults);
      }

    } catch (err) {
      setStatus(STATUS.error(err.message || String(err)), "error");
      console.error("Transcript search error:", err);
    } finally {
      $searchBtn.disabled = false;
      setTimeout(hideProgress, 800);
    }
  });

  // ── Load queues on mount ──────────────────────────────
  (async () => {
    try {
      const orgId = orgContext.get();
      queues = await gc.fetchAllQueues(api, orgId);
      queues.sort((a, b) => a.name.localeCompare(b.name));
      queueMap = Object.fromEntries(queues.map(q => [q.id, q.name]));
      ssQueue.setItems(queues.map(q => ({ id: q.id, label: q.name })));
      ssQueue.setEnabled(true);
    } catch (err) {
      console.error("Failed to load queues:", err.message);
      ssQueue.setEnabled(true);
    }
  })();

  return el;
}
