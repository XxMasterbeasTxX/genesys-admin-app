/**
 * Actions › Interaction Search
 *
 * Searches Genesys conversation records by date range with optional
 * participant data attribute filters. Uses the async Analytics Jobs API
 * (only path that returns participant attributes).
 *
 * Results display in a table with click-to-expand detail pane.
 * Supports CSV export and copy-to-clipboard.
 */
import { escapeHtml, formatDateTime, buildInterval, todayStr, daysAgoStr,
         generateCsv, downloadFile, timestampedFilename } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";

// ── Column definitions (page-specific) ──────────────────────────────
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

const PD_COLUMNS = [
  { key: "conversationId", label: "Conversation ID" },
  { key: "participantNum", label: "Participant #" },
  { key: "purpose",        label: "Purpose" },
  { key: "attrKey",        label: "Key" },
  { key: "attrValue",      label: "Value" },
];

// ── Status messages (page-specific) ─────────────────────────────────
const STATUS = {
  ready:           "Ready. Select a date range and click Search.",
  found:           (n) => `Found ${n} conversation${n !== 1 ? "s" : ""}.`,
  foundFiltered:   (n, total) => `Found ${n} of ${total} conversations matching filters.`,
  noResults:       "No conversations found for the selected date range.",
  noFilterMatch:   (total) => `${total} conversations fetched, but none matched the filters.`,
  exported:        (n) => `Exported ${n} rows to CSV.`,
  error:           (msg) => `Error: ${msg}`,
};

// ── Helpers (page-specific data extraction) ─────────────────────────

/** Extract first non-empty session field from participants. */
function extractSessionField(participants, field) {
  if (!participants) return "";
  for (const p of participants) {
    for (const s of p.sessions || []) {
      if (s[field]) return s[field];
    }
  }
  return "";
}

/** Extract first disconnect type from segments. */
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

/** Flatten a conversation API object to a table row. */
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

/**
 * Client-side participant-data filter.
 * A conversation matches if ANY participant has attributes matching
 * ALL filter key/value pairs (case-insensitive value match).
 */
function filterByPD(conversations, filters) {
  if (!filters.length) return conversations;
  return conversations.filter((conv) => {
    if (!conv.participants) return false;
    return conv.participants.some((p) => {
      const attrs = p.attributes || {};
      return filters.every((f) => {
        const v = attrs[f.key];
        return v != null && v.toLowerCase() === f.value.toLowerCase();
      });
    });
  });
}

/** Flatten conversations to participant-data CSV rows. */
function toParticipantDataRows(conversations) {
  const rows = [];
  for (const conv of conversations) {
    if (!conv.participants) continue;
    conv.participants.forEach((p, idx) => {
      const attrs = p.attributes || {};
      for (const [k, v] of Object.entries(attrs).sort()) {
        rows.push({
          conversationId: conv.conversationId,
          participantNum: idx + 1,
          purpose: p.purpose || "",
          attrKey: k,
          attrValue: v,
        });
      }
    });
  }
  return rows;
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderInteractionSearch({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Actions — Interaction Search</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ───────────────────────────────────────────
  let pdFilters = [];      // [{key, value}, ...]
  let conversations = [];  // raw API results (after filtering)
  let rows = [];           // flattened rows for display
  let selectedIdx = -1;
  let abortCtrl = null;    // AbortController for cancelling

  // ── Build UI ────────────────────────────────────────
  const today = todayStr();
  const weekAgo = daysAgoStr(7);

  el.innerHTML = `
    <h1 class="h1">Actions — Interaction Search</h1>
    <hr class="hr">

    <!-- Controls row -->
    <div class="is-controls">
      <div class="is-control-group">
        <label class="is-label">Date From</label>
        <input type="date" class="input is-date" id="isDateFrom" value="${weekAgo}">
      </div>
      <div class="is-control-group">
        <label class="is-label">Date To</label>
        <input type="date" class="input is-date" id="isDateTo" value="${today}">
      </div>
      <div class="is-control-group is-pd-group">
        <label class="is-label">Participant Data Filter</label>
        <div class="is-pd-inputs">
          <input type="text" class="input is-pd-key" id="isPdKey" placeholder="Key">
          <input type="text" class="input is-pd-value" id="isPdValue" placeholder="Value">
          <button class="btn btn-sm" id="isPdAdd">Add</button>
          <button class="btn btn-sm" id="isPdClear">Clear All</button>
        </div>
        <div class="is-pd-hint">Filters applied client-side. Conversation matches if ANY participant has ALL key/value pairs.</div>
        <div class="is-filter-tags" id="isFilterTags"></div>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="is-actions">
      <button class="btn" id="isSearchBtn">Search</button>
      <button class="btn" id="isExportBtn" disabled>Export CSV</button>
      <button class="btn" id="isExportPdBtn" disabled>Export Participant Data</button>
      <button class="btn" id="isClearBtn">Clear Results</button>
    </div>

    <!-- Status -->
    <div class="is-status" id="isStatus">${STATUS.ready}</div>

    <!-- Progress bar -->
    <div class="is-progress-wrap" id="isProgressWrap" style="display:none">
      <div class="is-progress-bar" id="isProgressBar"></div>
    </div>

    <!-- Results area: table + detail pane -->
    <div class="is-results">
      <div class="is-table-wrap">
        <table class="data-table is-table" id="isTable">
          <thead>
            <tr>${COLUMNS.map((c) => `<th style="width:${c.width}">${c.label}</th>`).join("")}</tr>
          </thead>
          <tbody id="isTbody"></tbody>
        </table>
      </div>
      <div class="is-detail" id="isDetail">
        <div class="is-detail-title">Conversation Detail</div>
        <pre class="is-detail-content" id="isDetailContent">Select a row to view details.</pre>
      </div>
    </div>
  `;

  // ── DOM refs ────────────────────────────────────────
  const $dateFrom     = el.querySelector("#isDateFrom");
  const $dateTo       = el.querySelector("#isDateTo");
  const $pdKey        = el.querySelector("#isPdKey");
  const $pdValue      = el.querySelector("#isPdValue");
  const $pdAdd        = el.querySelector("#isPdAdd");
  const $pdClear      = el.querySelector("#isPdClear");
  const $filterTags   = el.querySelector("#isFilterTags");
  const $searchBtn    = el.querySelector("#isSearchBtn");
  const $exportBtn    = el.querySelector("#isExportBtn");
  const $exportPdBtn  = el.querySelector("#isExportPdBtn");
  const $clearBtn     = el.querySelector("#isClearBtn");
  const $status       = el.querySelector("#isStatus");
  const $progressWrap = el.querySelector("#isProgressWrap");
  const $progressBar  = el.querySelector("#isProgressBar");
  const $tbody        = el.querySelector("#isTbody");
  const $detail       = el.querySelector("#isDetailContent");

  // ── Filter tag management ───────────────────────────
  function renderFilterTags() {
    if (!pdFilters.length) {
      $filterTags.innerHTML = `<span class="is-no-filters">No filters active</span>`;
      return;
    }
    $filterTags.innerHTML = pdFilters.map((f, i) =>
      `<span class="is-filter-tag">${escapeHtml(f.key)} = ${escapeHtml(f.value)}
        <button class="is-filter-tag-remove" data-idx="${i}">&times;</button>
       </span>`
    ).join("");
    $filterTags.querySelectorAll(".is-filter-tag-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        pdFilters.splice(Number(btn.dataset.idx), 1);
        renderFilterTags();
      });
    });
  }
  renderFilterTags();

  $pdAdd.addEventListener("click", () => {
    const key = $pdKey.value.trim();
    const value = $pdValue.value.trim();
    if (!key || !value) return;
    pdFilters.push({ key, value });
    $pdKey.value = "";
    $pdValue.value = "";
    renderFilterTags();
  });

  $pdClear.addEventListener("click", () => {
    pdFilters = [];
    renderFilterTags();
  });

  // ── Status / progress helpers ───────────────────────
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

  // ── Render table rows ───────────────────────────────
  function renderRows() {
    $tbody.innerHTML = rows.map((r, i) =>
      `<tr class="is-row${i % 2 === 1 ? " is-row-alt" : ""}${i === selectedIdx ? " is-row-selected" : ""}" data-idx="${i}">
        ${COLUMNS.map((c) => `<td>${escapeHtml(r[c.key])}</td>`).join("")}
       </tr>`
    ).join("");

    $tbody.querySelectorAll(".is-row").forEach((tr) => {
      tr.addEventListener("click", () => {
        selectedIdx = Number(tr.dataset.idx);
        renderRows();
        showDetail(selectedIdx);
      });
      tr.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const idx = Number(tr.dataset.idx);
        const id = rows[idx]?.conversationId;
        if (id) navigator.clipboard.writeText(id).catch(() => {});
        selectedIdx = idx;
        renderRows();
        setStatus(`Copied: ${id}`, "success");
      });
    });

    $exportBtn.disabled = !rows.length;
    $exportPdBtn.disabled = !conversations.length;
  }

  // ── Detail pane ─────────────────────────────────────
  function showDetail(idx) {
    if (idx < 0 || idx >= rows.length) return;
    const conv = rows[idx]._raw;
    const lines = [];

    lines.push(`Conversation ID: ${conv.conversationId}`);
    lines.push(`Start: ${formatDateTime(conv.conversationStart)}`);
    lines.push(`End:   ${formatDateTime(conv.conversationEnd)}`);
    lines.push(`Direction: ${conv.originatingDirection || ""}`);
    lines.push("");

    if (conv.participants) {
      conv.participants.forEach((p, pi) => {
        lines.push(`--- Participant #${pi + 1} ---`);
        if (p.purpose) lines.push(`  Purpose: ${p.purpose}`);
        if (p.participantName) lines.push(`  Name: ${p.participantName}`);

        const attrs = p.attributes || {};
        const attrKeys = Object.keys(attrs).sort();
        if (attrKeys.length) {
          lines.push("  Participant Data:");
          for (const k of attrKeys) lines.push(`    ${k} = ${attrs[k]}`);
        } else {
          lines.push("  (no participant data)");
        }

        for (const s of p.sessions || []) {
          if (s.mediaType) lines.push(`  Media: ${s.mediaType}`);
          if (s.ani) lines.push(`  ANI: ${s.ani}`);
          if (s.dnis) lines.push(`  DNIS: ${s.dnis}`);
          for (const seg of s.segments || []) {
            if (seg.disconnectType) lines.push(`  Disconnect: ${seg.disconnectType}`);
            if (seg.queueId) lines.push(`  Queue: ${seg.queueId}`);
            if (seg.wrapUpCode) lines.push(`  Wrap-up Code: ${seg.wrapUpCode}`);
            if (seg.wrapUpNote) lines.push(`  Wrap-up Note: ${seg.wrapUpNote}`);
          }
        }
        lines.push("");
      });
    }

    $detail.textContent = lines.join("\n");
  }

  // ── Clear results ───────────────────────────────────
  function clearResults() {
    conversations = [];
    rows = [];
    selectedIdx = -1;
    $tbody.innerHTML = "";
    $detail.textContent = "Select a row to view details.";
    $exportBtn.disabled = true;
    $exportPdBtn.disabled = true;
    hideProgress();
    setStatus(STATUS.ready);
  }
  $clearBtn.addEventListener("click", clearResults);

  // ── Export buttons ──────────────────────────────────
  $exportBtn.addEventListener("click", () => {
    if (!rows.length) return;
    downloadFile(timestampedFilename("InteractionSearch"), generateCsv(rows, COLUMNS));
    setStatus(STATUS.exported(rows.length), "success");
  });

  $exportPdBtn.addEventListener("click", () => {
    if (!conversations.length) return;
    const pdRows = toParticipantDataRows(conversations);
    downloadFile(timestampedFilename("ParticipantData"), generateCsv(pdRows, PD_COLUMNS));
    setStatus(STATUS.exported(pdRows.length), "success");
  });

  // ── SEARCH ──────────────────────────────────────────
  $searchBtn.addEventListener("click", async () => {
    const dateFrom = $dateFrom.value;
    const dateTo = $dateTo.value;
    if (!dateFrom || !dateTo) {
      setStatus("Please select both dates.", "error");
      return;
    }
    if (dateFrom > dateTo) {
      setStatus("'Date From' must be before 'Date To'.", "error");
      return;
    }

    // Cancel any in-flight search
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    clearResults();
    $searchBtn.disabled = true;
    const currentFilters = [...pdFilters];
    const orgId = orgContext.get();

    try {
      // Use the centralized genesysApi service for the full search flow
      const interval = buildInterval(dateFrom, dateTo);
      const allConvs = await gc.searchConversations(api, orgId, {
        interval,
        onStatus: (msg) => setStatus(msg),
        onProgress: (pct) => showProgress(pct),
      });

      // Client-side participant data filtering
      const totalFetched = allConvs.length;
      let filtered = allConvs;
      if (currentFilters.length) {
        setStatus(`Filtering ${totalFetched} conversations by participant data…`);
        filtered = filterByPD(allConvs, currentFilters);
      }

      conversations = filtered;
      rows = conversations.map(toRow);
      renderRows();
      showProgress(100);

      // Status message
      if (rows.length > 0) {
        if (currentFilters.length) {
          setStatus(STATUS.foundFiltered(rows.length, totalFetched), "success");
        } else {
          setStatus(STATUS.found(rows.length), "success");
        }
      } else {
        if (currentFilters.length && totalFetched > 0) {
          setStatus(STATUS.noFilterMatch(totalFetched));
        } else {
          setStatus(STATUS.noResults);
        }
      }

    } catch (err) {
      if (err.message === "Search cancelled") {
        setStatus("Search cancelled.", "");
      } else {
        setStatus(STATUS.error(err.message || String(err)), "error");
        console.error("Interaction search error:", err);
      }
    } finally {
      $searchBtn.disabled = false;
      setTimeout(hideProgress, 800);
    }
  });

  return el;
}
