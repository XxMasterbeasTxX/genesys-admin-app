/**
 * Interactions › Move
 *
 * Transfers active interactions from one queue to another with optional
 * media type and date filtering. Supports preview (count) and move modes.
 *
 * Flow:
 *   1. Sync analytics query → find active conversations in source queue
 *   2. GET each conversation → identify ACD participant in source queue
 *   3. POST replace → blind-transfer to destination queue
 *
 * API endpoints:
 *   POST /api/v2/analytics/conversations/details/query                        — find active conversations
 *   GET  /api/v2/conversations/{id}                                           — get conversation details
 *   POST /api/v2/conversations/{id}/participants/{participantId}/replace       — transfer to dest queue
 *   GET  /api/v2/routing/queues                                               — list queues
 */
import { escapeHtml, formatDateTime, sleep } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";

// ── Constants ───────────────────────────────────────────────────────

const MEDIA_TYPES = [
  { id: "voice",    label: "Voice" },
  { id: "email",    label: "Email" },
  { id: "callback", label: "Callback" },
  { id: "message",  label: "Message" },
];

const STATUS = {
  ready:      "Ready. Select source and destination queues.",
  loading:    "Loading queues…",
  scanning:   "Scanning for active conversations…",
  inspecting: (n, total) => `Inspecting conversation ${n} of ${total}…`,
  previewed:  (n, media) => `Preview: ${n} interaction${n !== 1 ? "s" : ""} found (${media}).`,
  moving:     (n, total) => `Moving ${n} of ${total}…`,
  done:       (ok, fail) => `Done. Moved: ${ok}, Failed: ${fail}.`,
  noResults:  "No active interactions found matching the criteria.",
  error:      (msg) => `Error: ${msg}`,
};

// ── Helpers ─────────────────────────────────────────────────────────

/** Determine media type from conversation participants. */
function detectMediaType(participants) {
  if (!participants) return "unknown";
  for (const p of participants) {
    if (p.calls?.length)     return "voice";
    if (p.emails?.length)    return "email";
    if (p.callbacks?.length) return "callback";
    if (p.messages?.length)  return "message";
  }
  return "unknown";
}

/**
 * Find the ACD participant currently active in the given queue.
 * Returns { participantId, mediaType } or null.
 */
function findAcdParticipant(conversation, sourceQueueId) {
  if (!conversation.participants) return null;

  for (const p of conversation.participants) {
    if (p.purpose !== "acd") continue;

    // Check queue match
    const pQueue = p.queueId || p.queue?.id;
    if (pQueue !== sourceQueueId) continue;

    // Check for active media (connected or alerting)
    const mediaCollections = [
      { key: "calls",     type: "voice" },
      { key: "emails",    type: "email" },
      { key: "callbacks", type: "callback" },
      { key: "messages",  type: "message" },
    ];

    for (const mc of mediaCollections) {
      const items = p[mc.key];
      if (!items?.length) continue;
      for (const item of items) {
        if (item.state === "connected" || item.state === "alerting") {
          return { participantId: p.id, mediaType: mc.type };
        }
      }
    }
  }

  return null;
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderMoveInteractions({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Move Interactions</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ───────────────────────────────────────────
  let queues = [];              // all queues from org
  let candidates = [];          // conversations matching criteria
  let results = [];             // move results [{convId, mediaType, status, error}]
  let isRunning = false;
  let cancelled = false;

  // ── Build UI ────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Move Interactions</h1>
    <hr class="hr">

    <p class="page-desc">
      Transfer active interactions from one queue to another. Supports media
      type filtering and date range controls. Preview matching conversations
      before executing the move.
    </p>

    <!-- Queue selectors -->
    <div class="mi-controls">
      <div class="mi-control-group mi-queue-group">
        <label class="mi-label">Source Queue</label>
        <input type="text" class="input mi-queue-search" id="miSrcSearch" placeholder="Search queues…" disabled>
        <select class="input mi-queue-select" id="miSrcQueue" disabled>
          <option value="">Loading queues…</option>
        </select>
      </div>
      <div class="mi-control-group mi-queue-group">
        <label class="mi-label">Destination Queue</label>
        <input type="text" class="input mi-queue-search" id="miDstSearch" placeholder="Search queues…" disabled>
        <select class="input mi-queue-select" id="miDstQueue" disabled>
          <option value="">Loading queues…</option>
        </select>
      </div>
    </div>

    <!-- Media type filter -->
    <div class="mi-controls">
      <div class="mi-control-group">
        <label class="mi-label">Media Types</label>
        <div class="mi-media-types" id="miMediaTypes">
          <label class="mi-checkbox">
            <input type="checkbox" id="miMediaAll" checked> All
          </label>
          ${MEDIA_TYPES.map(mt => `
            <label class="mi-checkbox">
              <input type="checkbox" class="mi-media-cb" data-type="${mt.id}" checked> ${mt.label}
            </label>
          `).join("")}
        </div>
      </div>
    </div>

    <!-- Date filters -->
    <div class="mi-controls">
      <div class="mi-control-group">
        <label class="mi-label">
          <input type="checkbox" id="miOlderEnable"> Older than
        </label>
        <input type="date" class="input mi-date" id="miOlderDate" disabled>
      </div>
      <div class="mi-control-group">
        <label class="mi-label">
          <input type="checkbox" id="miNewerEnable"> Newer than
        </label>
        <input type="date" class="input mi-date" id="miNewerDate" disabled>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="mi-actions">
      <button class="btn" id="miPreviewBtn" disabled>Preview</button>
      <button class="btn mi-btn-move" id="miMoveBtn" disabled>Move Interactions</button>
      <button class="btn" id="miCancelBtn" style="display:none">Cancel</button>
      <button class="btn" id="miClearBtn">Clear Results</button>
    </div>

    <!-- Status -->
    <div class="mi-status" id="miStatus">${STATUS.loading}</div>

    <!-- Progress bar -->
    <div class="mi-progress-wrap" id="miProgressWrap" style="display:none">
      <div class="mi-progress-bar" id="miProgressBar"></div>
    </div>

    <!-- Results table -->
    <div class="mi-table-wrap" id="miTableWrap" style="display:none">
      <table class="data-table mi-table">
        <thead>
          <tr>
            <th style="width:60px">#</th>
            <th style="width:300px">Conversation ID</th>
            <th style="width:100px">Media Type</th>
            <th style="width:160px">Start Time</th>
            <th style="width:100px">Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody id="miTbody"></tbody>
      </table>
    </div>
  `;

  // ── DOM refs ────────────────────────────────────────
  const $srcSearch    = el.querySelector("#miSrcSearch");
  const $srcQueue     = el.querySelector("#miSrcQueue");
  const $dstSearch    = el.querySelector("#miDstSearch");
  const $dstQueue     = el.querySelector("#miDstQueue");
  const $mediaAll     = el.querySelector("#miMediaAll");
  const $mediaCbs     = el.querySelectorAll(".mi-media-cb");
  const $olderEnable  = el.querySelector("#miOlderEnable");
  const $olderDate    = el.querySelector("#miOlderDate");
  const $newerEnable  = el.querySelector("#miNewerEnable");
  const $newerDate    = el.querySelector("#miNewerDate");
  const $previewBtn   = el.querySelector("#miPreviewBtn");
  const $moveBtn      = el.querySelector("#miMoveBtn");
  const $cancelBtn    = el.querySelector("#miCancelBtn");
  const $clearBtn     = el.querySelector("#miClearBtn");
  const $status       = el.querySelector("#miStatus");
  const $progressWrap = el.querySelector("#miProgressWrap");
  const $progressBar  = el.querySelector("#miProgressBar");
  const $tableWrap    = el.querySelector("#miTableWrap");
  const $tbody        = el.querySelector("#miTbody");

  // ── Queue search / filter wiring ────────────────────
  function populateQueueSelect($select, $search, filterText = "") {
    const lower = filterText.toLowerCase();
    const filtered = lower
      ? queues.filter(q => q.name.toLowerCase().includes(lower))
      : queues;

    const prev = $select.value;
    $select.innerHTML = `<option value="">— Select queue —</option>`
      + filtered.map(q =>
        `<option value="${escapeHtml(q.id)}">${escapeHtml(q.name)}</option>`
      ).join("");

    // Restore selection if still in filtered list
    if (prev && filtered.some(q => q.id === prev)) {
      $select.value = prev;
    }
  }

  $srcSearch.addEventListener("input", () => populateQueueSelect($srcQueue, $srcSearch, $srcSearch.value));
  $dstSearch.addEventListener("input", () => populateQueueSelect($dstQueue, $dstSearch, $dstSearch.value));

  // ── Media type wiring ───────────────────────────────
  $mediaAll.addEventListener("change", () => {
    $mediaCbs.forEach(cb => { cb.checked = $mediaAll.checked; });
  });
  $mediaCbs.forEach(cb => {
    cb.addEventListener("change", () => {
      const allChecked = [...$mediaCbs].every(c => c.checked);
      const noneChecked = [...$mediaCbs].every(c => !c.checked);
      $mediaAll.checked = allChecked;
      $mediaAll.indeterminate = !allChecked && !noneChecked;
    });
  });

  // ── Date filter wiring ──────────────────────────────
  $olderEnable.addEventListener("change", () => { $olderDate.disabled = !$olderEnable.checked; });
  $newerEnable.addEventListener("change", () => { $newerDate.disabled = !$newerEnable.checked; });

  // ── Status / progress ───────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "mi-status" + (type ? ` mi-status--${type}` : "");
  }
  function showProgress(pct) {
    $progressWrap.style.display = "";
    $progressBar.style.width = `${Math.min(pct, 100)}%`;
  }
  function hideProgress() {
    $progressWrap.style.display = "none";
    $progressBar.style.width = "0%";
  }

  function setButtonsRunning(running) {
    isRunning = running;
    $previewBtn.disabled = running;
    $moveBtn.disabled = running;
    $cancelBtn.style.display = running ? "" : "none";
    $srcQueue.disabled = running;
    $dstQueue.disabled = running;
    $srcSearch.disabled = running;
    $dstSearch.disabled = running;
  }

  // ── Render results table ────────────────────────────
  function renderResults() {
    if (!results.length) {
      $tableWrap.style.display = "none";
      return;
    }
    $tableWrap.style.display = "";
    $tbody.innerHTML = results.map((r, i) => {
      const statusClass = r.status === "Moved" ? "mi-ok"
        : r.status === "Failed" ? "mi-fail"
        : r.status === "Cancelled" ? "mi-cancel"
        : "";
      return `<tr>
        <td>${i + 1}</td>
        <td class="mi-mono">${escapeHtml(r.convId)}</td>
        <td>${escapeHtml(r.mediaType)}</td>
        <td>${escapeHtml(r.startTime || "")}</td>
        <td class="${statusClass}">${escapeHtml(r.status)}</td>
        <td>${escapeHtml(r.error || "")}</td>
      </tr>`;
    }).join("");
  }

  // ── Get selected media types ────────────────────────
  function getSelectedMediaTypes() {
    if ($mediaAll.checked) return ["voice", "email", "callback", "message"];
    return [...$mediaCbs].filter(c => c.checked).map(c => c.dataset.type);
  }

  // ── Validate inputs ─────────────────────────────────
  function validate() {
    const srcId = $srcQueue.value;
    const dstId = $dstQueue.value;
    if (!srcId) { setStatus("Please select a source queue.", "error"); return null; }
    if (!dstId) { setStatus("Please select a destination queue.", "error"); return null; }
    if (srcId === dstId) { setStatus("Source and destination queues must be different.", "error"); return null; }

    const mediaTypes = getSelectedMediaTypes();
    if (!mediaTypes.length) { setStatus("Please select at least one media type.", "error"); return null; }

    const olderThan = $olderEnable.checked ? $olderDate.value : null;
    const newerThan = $newerEnable.checked ? $newerDate.value : null;
    if ($olderEnable.checked && !olderThan) { setStatus("Please set the 'Older than' date.", "error"); return null; }
    if ($newerEnable.checked && !newerThan) { setStatus("Please set the 'Newer than' date.", "error"); return null; }

    return { srcId, dstId, mediaTypes, olderThan, newerThan };
  }

  // ── Core: scan for matching conversations ───────────
  async function scanConversations(params) {
    const { srcId, mediaTypes, olderThan, newerThan } = params;
    const orgId = orgContext.get();

    // Step 1: Analytics query — active convs in source queue (last 31 days)
    const now = new Date();
    const start = new Date(now.getTime() - 31 * 86_400_000);
    const interval = `${start.toISOString()}/${now.toISOString()}`;

    setStatus(STATUS.scanning);
    showProgress(10);

    const analyticsBody = {
      interval,
      order: "desc",
      orderBy: "conversationStart",
      segmentFilters: [{
        type: "and",
        predicates: [{ dimension: "queueId", value: srcId }],
      }],
      conversationFilters: [{
        type: "and",
        predicates: [{ dimension: "conversationEnd", operator: "notExists" }],
      }],
    };

    const rawConvs = await gc.queryConversationDetails(api, orgId, analyticsBody, {
      onProgress: (n) => showProgress(10 + Math.min(n / 10, 20)),
    });

    if (!rawConvs.length) return [];
    if (cancelled) return [];

    // Step 2: Get full details for each and find ACD participant
    const matched = [];
    for (let i = 0; i < rawConvs.length; i++) {
      if (cancelled) break;

      const convId = rawConvs[i].conversationId;
      setStatus(STATUS.inspecting(i + 1, rawConvs.length));
      showProgress(30 + (i / rawConvs.length) * 60);

      try {
        const conv = await gc.getConversation(api, orgId, convId);
        const acd = findAcdParticipant(conv, srcId);
        if (!acd) continue;

        // Media type filter
        if (!mediaTypes.includes(acd.mediaType)) continue;

        // Date filters
        const startTime = conv.startTime ? new Date(conv.startTime) : null;
        if (olderThan && startTime) {
          if (startTime >= new Date(olderThan + "T00:00:00Z")) continue;
        }
        if (newerThan && startTime) {
          if (startTime <= new Date(newerThan + "T23:59:59Z")) continue;
        }

        matched.push({
          convId,
          participantId: acd.participantId,
          mediaType: acd.mediaType,
          startTime: formatDateTime(conv.startTime),
        });
      } catch (err) {
        // Skip conversations we can't inspect (may have ended)
        console.warn(`Could not inspect ${convId}:`, err.message);
      }
    }

    return matched;
  }

  // ── Preview ─────────────────────────────────────────
  $previewBtn.addEventListener("click", async () => {
    const params = validate();
    if (!params) return;

    cancelled = false;
    setButtonsRunning(true);
    results = [];
    renderResults();

    try {
      candidates = await scanConversations(params);

      if (cancelled) {
        setStatus("Preview cancelled.");
      } else if (candidates.length === 0) {
        setStatus(STATUS.noResults);
      } else {
        const mediaLabel = params.mediaTypes.length >= 4
          ? "all media types"
          : params.mediaTypes.join(", ");
        setStatus(STATUS.previewed(candidates.length, mediaLabel), "success");

        // Show preview in table  
        results = candidates.map(c => ({
          ...c,
          status: "Pending",
          error: "",
        }));
        renderResults();
      }
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
      console.error("Preview error:", err);
    } finally {
      showProgress(100);
      setTimeout(hideProgress, 800);
      setButtonsRunning(false);
    }
  });

  // ── Move ────────────────────────────────────────────
  $moveBtn.addEventListener("click", async () => {
    const params = validate();
    if (!params) return;

    // If we don't have candidates yet, run scan first
    if (!candidates.length) {
      cancelled = false;
      setButtonsRunning(true);
      results = [];
      renderResults();

      try {
        candidates = await scanConversations(params);
        if (!candidates.length) {
          setStatus(STATUS.noResults);
          setButtonsRunning(false);
          hideProgress();
          return;
        }
      } catch (err) {
        setStatus(STATUS.error(err.message), "error");
        setButtonsRunning(false);
        hideProgress();
        return;
      }
    }

    // Confirmation
    const srcName = $srcQueue.options[$srcQueue.selectedIndex]?.text || "";
    const dstName = $dstQueue.options[$dstQueue.selectedIndex]?.text || "";
    const ok = confirm(
      `Move ${candidates.length} interaction${candidates.length !== 1 ? "s" : ""} from "${srcName}" to "${dstName}"?\n\nThis action cannot be undone.`
    );
    if (!ok) { setButtonsRunning(false); hideProgress(); return; }

    cancelled = false;
    setButtonsRunning(true);
    const orgId = orgContext.get();

    let successCount = 0;
    let failCount = 0;

    results = candidates.map(c => ({
      ...c,
      status: "Pending",
      error: "",
    }));
    renderResults();

    for (let i = 0; i < candidates.length; i++) {
      if (cancelled) {
        // Mark remaining as cancelled
        for (let j = i; j < candidates.length; j++) {
          results[j].status = "Cancelled";
        }
        renderResults();
        break;
      }

      const c = candidates[i];
      setStatus(STATUS.moving(i + 1, candidates.length));
      showProgress((i / candidates.length) * 100);

      try {
        await gc.replaceParticipantQueue(api, orgId, c.convId, c.participantId, params.dstId);
        results[i].status = "Moved";
        successCount++;
      } catch (err) {
        results[i].status = "Failed";
        results[i].error = err.message || String(err);
        failCount++;
      }

      renderResults();

      // Small delay between moves to avoid rate limiting
      if (i < candidates.length - 1) await sleep(200);
    }

    showProgress(100);
    if (cancelled) {
      setStatus(`Cancelled. Moved: ${successCount}, Failed: ${failCount}, Remaining: ${candidates.length - successCount - failCount}.`);
    } else {
      setStatus(STATUS.done(successCount, failCount), failCount > 0 ? "error" : "success");
    }
    setTimeout(hideProgress, 800);
    setButtonsRunning(false);
    candidates = []; // Force re-scan on next move
  });

  // ── Cancel ──────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => { cancelled = true; });

  // ── Clear ───────────────────────────────────────────
  $clearBtn.addEventListener("click", () => {
    candidates = [];
    results = [];
    renderResults();
    hideProgress();
    setStatus(STATUS.ready);
  });

  // ── Load queues on mount ────────────────────────────
  (async () => {
    try {
      queues = await gc.fetchAllQueues(api, orgContext.get());
      queues.sort((a, b) => a.name.localeCompare(b.name));

      populateQueueSelect($srcQueue, $srcSearch);
      populateQueueSelect($dstQueue, $dstSearch);

      $srcQueue.disabled = false;
      $dstQueue.disabled = false;
      $srcSearch.disabled = false;
      $dstSearch.disabled = false;
      $previewBtn.disabled = false;
      $moveBtn.disabled = false;

      setStatus(STATUS.ready);
    } catch (err) {
      setStatus(STATUS.error(`Failed to load queues: ${err.message}`), "error");
      console.error("Queue load error:", err);
    }
  })();

  return el;
}
