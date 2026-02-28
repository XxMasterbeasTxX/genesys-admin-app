/**
 * Interactions › Disconnect
 *
 * Force-disconnect stuck/orphaned conversations. Three modes:
 *   1. Single ID   — disconnect one conversation
 *   2. Multiple IDs — disconnect several conversations by ID
 *   3. Empty Queue  — find all active conversations in a queue and disconnect
 *
 * Includes media type and date range filters.
 *
 * API endpoints:
 *   GET  /api/v2/conversations/{id}                        — fetch conversation details
 *   POST /api/v2/conversations/{id}/disconnect              — force-disconnect
 *   POST /api/v2/analytics/conversations/details/query      — queue scan (active convos)
 *   GET  /api/v2/routing/queues                             — list queues
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

/** Number of 31-day intervals to scan backwards (≈ 6 months). */
const SCAN_INTERVALS = 6;
const INTERVAL_DAYS  = 31;

const STATUS = {
  ready:          "Ready. Select a mode and provide input.",
  loading:        "Loading queues…",
  scanning:       (i, n) => `Scanning interval ${i} of ${n}…`,
  inspecting:     (i, n) => `Inspecting conversation ${i} of ${n}…`,
  disconnecting:  (i, n) => `Disconnecting ${i} of ${n}…`,
  previewed:      (n) => `Preview: ${n} conversation${n !== 1 ? "s" : ""} matching criteria.`,
  noResults:      "No conversations found matching the criteria.",
  done(ok, fail, skip) {
    const p = [`Disconnected: ${ok}`];
    if (fail) p.push(`Failed: ${fail}`);
    if (skip) p.push(`Filtered: ${skip}`);
    return `Done. ${p.join(", ")}.`;
  },
};

// ── Helpers ─────────────────────────────────────────────────────────

/** Detect media type from a conversation's participants. */
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

/** Map common HTTP error codes to user-friendly messages. */
function friendlyError(err) {
  const msg = err.message || String(err);
  if (msg.includes("404")) return "Not found (already disconnected?)";
  if (msg.includes("403")) return "Permission denied";
  if (msg.includes("400")) return "Invalid state — cannot disconnect";
  if (msg.includes("429")) return "Rate limited (too many requests)";
  return msg;
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderDisconnectInteractions({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Conversations — Disconnect Interactions</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ───────────────────────────────────────────
  let queues     = [];
  let candidates = [];     // conversations that passed filters
  let results    = [];     // display rows [{convId, mediaType, startTime, status, error}]
  let isRunning  = false;
  let cancelled  = false;
  let currentMode = "single";

  // ── Build UI ────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Conversations — Disconnect Interactions</h1>
    <hr class="hr">

    <!-- Warning banner -->
    <div class="di-warning">
      <div class="di-warning-title">⚠ WARNING: Force Disconnect — Emergency Use Only</div>
      This will force-disconnect conversations, applying system wrap-up codes and terminating
      all media. Only use for stuck or orphaned interactions that cannot be ended normally.
    </div>

    <!-- Mode selector -->
    <div class="di-controls">
      <div class="di-control-group">
        <label class="di-label">Mode</label>
        <div class="di-mode-group">
          <label class="di-radio"><input type="radio" name="diMode" value="single" checked> Single ID</label>
          <label class="di-radio"><input type="radio" name="diMode" value="multiple"> Multiple IDs</label>
          <label class="di-radio"><input type="radio" name="diMode" value="queue"> Empty Queue</label>
        </div>
      </div>
    </div>

    <!-- Dynamic input areas (only one visible at a time) -->
    <div id="diInputArea">
      <!-- Single ID -->
      <div class="di-controls" id="diSingleInput">
        <div class="di-control-group" style="flex:1;max-width:500px">
          <label class="di-label">Conversation ID</label>
          <input type="text" class="input" id="diConvId"
                 placeholder="e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6">
        </div>
      </div>

      <!-- Multiple IDs -->
      <div class="di-controls" id="diMultiInput" style="display:none">
        <div class="di-control-group" style="flex:1;max-width:500px">
          <label class="di-label">Conversation IDs (comma or newline separated)</label>
          <textarea class="input di-textarea" id="diConvIds" rows="4"
                    placeholder="Enter one ID per line, or comma-separated"></textarea>
        </div>
      </div>

      <!-- Queue selector -->
      <div id="diQueueInput" style="display:none">
        <div class="di-controls">
          <div class="di-control-group di-queue-group">
            <label class="di-label">Queue</label>
            <input type="text" class="input di-queue-search" id="diQueueSearch"
                   placeholder="Search queues…" disabled>
            <select class="input di-queue-select" id="diQueue" disabled>
              <option value="">Loading queues…</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- Media type filter -->
    <div class="di-controls">
      <div class="di-control-group">
        <label class="di-label">Media Types</label>
        <div class="di-media-types">
          <label class="di-checkbox">
            <input type="checkbox" id="diMediaAll" checked> All
          </label>
          ${MEDIA_TYPES.map(mt => `
            <label class="di-checkbox">
              <input type="checkbox" class="di-media-cb" data-type="${mt.id}" checked> ${mt.label}
            </label>
          `).join("")}
        </div>
      </div>
    </div>

    <!-- Date filters -->
    <div class="di-controls">
      <div class="di-control-group">
        <label class="di-label">
          <input type="checkbox" id="diOlderEnable"> Older than
        </label>
        <input type="date" class="input di-date" id="diOlderDate" disabled>
      </div>
      <div class="di-control-group">
        <label class="di-label">
          <input type="checkbox" id="diNewerEnable"> Newer than
        </label>
        <input type="date" class="input di-date" id="diNewerDate" disabled>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="di-actions">
      <button class="btn" id="diPreviewBtn">Preview</button>
      <button class="btn di-btn-disconnect" id="diDisconnectBtn">Disconnect</button>
      <button class="btn" id="diCancelBtn" style="display:none">Cancel</button>
      <button class="btn" id="diClearBtn">Clear Results</button>
    </div>

    <!-- Status -->
    <div class="di-status" id="diStatus">${STATUS.ready}</div>

    <!-- Progress bar -->
    <div class="di-progress-wrap" id="diProgressWrap" style="display:none">
      <div class="di-progress-bar" id="diProgressBar"></div>
    </div>

    <!-- Results table -->
    <div class="di-table-wrap" id="diTableWrap" style="display:none">
      <table class="data-table di-table">
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
        <tbody id="diTbody"></tbody>
      </table>
    </div>
  `;

  // ── DOM refs ────────────────────────────────────────
  const $modeRadios   = el.querySelectorAll('input[name="diMode"]');
  const $singleInput  = el.querySelector("#diSingleInput");
  const $multiInput   = el.querySelector("#diMultiInput");
  const $queueInput   = el.querySelector("#diQueueInput");
  const $convId       = el.querySelector("#diConvId");
  const $convIds      = el.querySelector("#diConvIds");
  const $queueSearch  = el.querySelector("#diQueueSearch");
  const $queue        = el.querySelector("#diQueue");
  const $mediaAll     = el.querySelector("#diMediaAll");
  const $mediaCbs     = el.querySelectorAll(".di-media-cb");
  const $olderEnable  = el.querySelector("#diOlderEnable");
  const $olderDate    = el.querySelector("#diOlderDate");
  const $newerEnable  = el.querySelector("#diNewerEnable");
  const $newerDate    = el.querySelector("#diNewerDate");
  const $previewBtn   = el.querySelector("#diPreviewBtn");
  const $disconnectBtn = el.querySelector("#diDisconnectBtn");
  const $cancelBtn    = el.querySelector("#diCancelBtn");
  const $clearBtn     = el.querySelector("#diClearBtn");
  const $status       = el.querySelector("#diStatus");
  const $progressWrap = el.querySelector("#diProgressWrap");
  const $progressBar  = el.querySelector("#diProgressBar");
  const $tableWrap    = el.querySelector("#diTableWrap");
  const $tbody        = el.querySelector("#diTbody");

  // ── Mode switching ──────────────────────────────────
  $modeRadios.forEach(r => r.addEventListener("change", () => {
    currentMode = r.value;
    $singleInput.style.display = currentMode === "single" ? "" : "none";
    $multiInput.style.display  = currentMode === "multiple" ? "" : "none";
    $queueInput.style.display  = currentMode === "queue" ? "" : "none";
    candidates = [];
    results = [];
    renderResults();
    setStatus(STATUS.ready);
  }));

  // ── Queue search / filter ──────────────────────────
  function populateQueueSelect(filterText = "") {
    const lower = filterText.toLowerCase();
    const filtered = lower
      ? queues.filter(q => q.name.toLowerCase().includes(lower))
      : queues;

    const prev = $queue.value;
    $queue.innerHTML = `<option value="">— Select queue —</option>`
      + filtered.map(q =>
        `<option value="${escapeHtml(q.id)}">${escapeHtml(q.name)}</option>`
      ).join("");

    if (prev && filtered.some(q => q.id === prev)) $queue.value = prev;
  }

  $queueSearch.addEventListener("input", () => populateQueueSelect($queueSearch.value));

  // ── Media type wiring ──────────────────────────────
  $mediaAll.addEventListener("change", () => {
    $mediaCbs.forEach(cb => { cb.checked = $mediaAll.checked; });
  });
  $mediaCbs.forEach(cb => {
    cb.addEventListener("change", () => {
      const allChecked  = [...$mediaCbs].every(c => c.checked);
      const noneChecked = [...$mediaCbs].every(c => !c.checked);
      $mediaAll.checked       = allChecked;
      $mediaAll.indeterminate = !allChecked && !noneChecked;
    });
  });

  // ── Date filter wiring ─────────────────────────────
  $olderEnable.addEventListener("change", () => { $olderDate.disabled = !$olderEnable.checked; });
  $newerEnable.addEventListener("change", () => { $newerDate.disabled = !$newerEnable.checked; });

  // ── Status / progress helpers ──────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "di-status" + (type ? ` di-status--${type}` : "");
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
    $previewBtn.disabled    = running;
    $disconnectBtn.disabled = running;
    $cancelBtn.style.display = running ? "" : "none";
    $queue.disabled       = running;
    $queueSearch.disabled = running;
  }

  // ── Render results table ───────────────────────────
  function renderResults() {
    if (!results.length) { $tableWrap.style.display = "none"; return; }
    $tableWrap.style.display = "";
    $tbody.innerHTML = results.map((r, i) => {
      const cls = r.status === "Disconnected" ? "di-ok"
        : r.status === "Failed"    ? "di-fail"
        : r.status === "Filtered"  ? "di-skip"
        : r.status === "Cancelled" ? "di-cancel"
        : "";
      return `<tr>
        <td>${i + 1}</td>
        <td class="di-mono">${escapeHtml(r.convId)}</td>
        <td>${escapeHtml(r.mediaType || "—")}</td>
        <td>${escapeHtml(r.startTime || "—")}</td>
        <td class="${cls}">${escapeHtml(r.status)}</td>
        <td>${escapeHtml(r.error || "")}</td>
      </tr>`;
    }).join("");
  }

  // ── Get selected media types ───────────────────────
  function getSelectedMediaTypes() {
    if ($mediaAll.checked) return MEDIA_TYPES.map(m => m.id);
    return [...$mediaCbs].filter(c => c.checked).map(c => c.dataset.type);
  }

  // ── Parse IDs from input fields ────────────────────
  function parseConvIds() {
    if (currentMode === "single") {
      const id = $convId.value.trim();
      return id ? [id] : [];
    }
    if (currentMode === "multiple") {
      return $convIds.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    }
    return [];
  }

  // ── Validate filters ──────────────────────────────
  function validateFilters() {
    const mediaTypes = getSelectedMediaTypes();
    if (!mediaTypes.length) { setStatus("Please select at least one media type.", "error"); return null; }

    const olderThan = $olderEnable.checked ? $olderDate.value : null;
    const newerThan = $newerEnable.checked ? $newerDate.value : null;
    if ($olderEnable.checked && !olderThan) { setStatus("Please set the 'Older than' date.", "error"); return null; }
    if ($newerEnable.checked && !newerThan) { setStatus("Please set the 'Newer than' date.", "error"); return null; }

    return { mediaTypes, olderThan, newerThan };
  }

  // ── Check a conversation against active filters ────
  function passesFilters(conv, { mediaTypes, olderThan, newerThan }) {
    const mt = detectMediaType(conv.participants);
    if (!mediaTypes.includes(mt)) return { pass: false, mediaType: mt, reason: `Media type "${mt}" not selected` };

    const st = conv.startTime ? new Date(conv.startTime) : null;
    if (olderThan && st && st >= new Date(olderThan + "T00:00:00Z"))
      return { pass: false, mediaType: mt, reason: "Started after 'Older than' date" };
    if (newerThan && st && st <= new Date(newerThan + "T23:59:59Z"))
      return { pass: false, mediaType: mt, reason: "Started before 'Newer than' date" };

    return { pass: true, mediaType: mt, reason: null };
  }

  // ── Scan: queue mode (multi-interval analytics) ────
  async function scanQueue(queueId, filters) {
    const orgId = orgContext.get();
    const now   = new Date();
    const seen  = new Set();
    const foundIds = [];

    // Phase 1 — analytics scan across 6 × 31-day windows
    for (let i = 0; i < SCAN_INTERVALS; i++) {
      if (cancelled) break;

      const end   = new Date(now.getTime() - i * INTERVAL_DAYS * 86_400_000);
      const start = new Date(end.getTime()  - INTERVAL_DAYS * 86_400_000);
      const interval = `${start.toISOString()}/${end.toISOString()}`;

      setStatus(STATUS.scanning(i + 1, SCAN_INTERVALS));
      showProgress((i / SCAN_INTERVALS) * 30);

      const body = {
        interval,
        order: "desc",
        orderBy: "conversationStart",
        segmentFilters: [{
          type: "and",
          predicates: [{ dimension: "queueId", value: queueId }],
        }],
        conversationFilters: [{
          type: "and",
          predicates: [{ dimension: "conversationEnd", operator: "notExists" }],
        }],
      };

      const convs = await gc.queryConversationDetails(api, orgId, body, {
        maxPages: 200,
        onProgress: (n) => showProgress(
          (i / SCAN_INTERVALS) * 30 + Math.min(n / 500, 1) * (30 / SCAN_INTERVALS)
        ),
      });

      for (const c of convs) {
        if (!seen.has(c.conversationId)) {
          seen.add(c.conversationId);
          foundIds.push(c.conversationId);
        }
      }
    }

    if (cancelled || !foundIds.length) return [];

    // Phase 2 — fetch full details and apply filters
    const matched = [];
    for (let i = 0; i < foundIds.length; i++) {
      if (cancelled) break;

      setStatus(STATUS.inspecting(i + 1, foundIds.length));
      showProgress(30 + (i / foundIds.length) * 60);

      try {
        const conv = await gc.getConversation(api, orgId, foundIds[i]);
        const { pass, mediaType } = passesFilters(conv, filters);
        if (pass) {
          matched.push({
            convId: foundIds[i],
            mediaType,
            startTime: formatDateTime(conv.startTime),
          });
        }
      } catch (err) {
        console.warn(`Could not inspect ${foundIds[i]}:`, err.message);
      }
    }

    return matched;
  }

  // ── Scan: single / multiple IDs ────────────────────
  async function scanIds(convIds, filters) {
    const orgId  = orgContext.get();
    const matched = [];
    const skipped = [];

    for (let i = 0; i < convIds.length; i++) {
      if (cancelled) break;

      setStatus(STATUS.inspecting(i + 1, convIds.length));
      showProgress((i / convIds.length) * 90);

      try {
        const conv = await gc.getConversation(api, orgId, convIds[i]);
        const { pass, mediaType, reason } = passesFilters(conv, filters);

        const row = {
          convId: convIds[i],
          mediaType,
          startTime: formatDateTime(conv.startTime),
        };

        if (pass) {
          matched.push(row);
        } else {
          skipped.push({ ...row, status: "Filtered", error: reason });
        }
      } catch (err) {
        skipped.push({
          convId: convIds[i],
          mediaType: "—",
          startTime: "—",
          status: "Failed",
          error: friendlyError(err),
        });
      }
    }

    return { matched, skipped };
  }

  // ── Preview button ─────────────────────────────────
  $previewBtn.addEventListener("click", async () => {
    const filters = validateFilters();
    if (!filters) return;

    cancelled = false;
    setButtonsRunning(true);
    candidates = [];
    results = [];
    renderResults();

    try {
      if (currentMode === "queue") {
        const queueId = $queue.value;
        if (!queueId) { setStatus("Please select a queue.", "error"); setButtonsRunning(false); return; }

        candidates = await scanQueue(queueId, filters);
        results = candidates.map(c => ({ ...c, status: "Pending", error: "" }));
      } else {
        const ids = parseConvIds();
        if (!ids.length) {
          setStatus("Please enter at least one conversation ID.", "error");
          setButtonsRunning(false);
          return;
        }

        const { matched, skipped } = await scanIds(ids, filters);
        candidates = matched;
        results = [
          ...matched.map(c => ({ ...c, status: "Pending", error: "" })),
          ...skipped,
        ];
      }

      if (cancelled) {
        setStatus("Preview cancelled.");
      } else if (candidates.length === 0) {
        setStatus(STATUS.noResults);
      } else {
        setStatus(STATUS.previewed(candidates.length), "success");
      }
      renderResults();
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
      console.error("Preview error:", err);
    } finally {
      showProgress(100);
      setTimeout(hideProgress, 800);
      setButtonsRunning(false);
    }
  });

  // ── Disconnect button ──────────────────────────────
  $disconnectBtn.addEventListener("click", async () => {
    const filters = validateFilters();
    if (!filters) return;

    // If no candidates yet, scan first
    if (!candidates.length) {
      cancelled = false;
      setButtonsRunning(true);
      results = [];
      renderResults();

      try {
        if (currentMode === "queue") {
          const queueId = $queue.value;
          if (!queueId) { setStatus("Please select a queue.", "error"); setButtonsRunning(false); return; }
          candidates = await scanQueue(queueId, filters);
        } else {
          const ids = parseConvIds();
          if (!ids.length) {
            setStatus("Please enter at least one conversation ID.", "error");
            setButtonsRunning(false);
            return;
          }
          const { matched, skipped } = await scanIds(ids, filters);
          candidates = matched;
          results = [...skipped];
        }

        if (!candidates.length) {
          setStatus(STATUS.noResults);
          renderResults();
          setButtonsRunning(false);
          hideProgress();
          return;
        }
      } catch (err) {
        setStatus(`Error: ${err.message}`, "error");
        setButtonsRunning(false);
        hideProgress();
        return;
      }
    }

    // Confirmation dialog
    const count = candidates.length;
    let target = `${count} conversation${count !== 1 ? "s" : ""}`;
    if (currentMode === "queue") {
      const qName = $queue.options[$queue.selectedIndex]?.text || "";
      target += ` in queue "${qName}"`;
    }

    const ok = confirm(
      `You are about to force-disconnect ${target}.\n\n`
      + "This will:\n"
      + "  • Disconnect all media\n"
      + "  • Apply system wrap-up codes\n"
      + "  • Force conversation termination\n\n"
      + "This action cannot be undone. Continue?"
    );
    if (!ok) { setButtonsRunning(false); hideProgress(); return; }

    // Execute disconnects
    cancelled = false;
    setButtonsRunning(true);
    const orgId = orgContext.get();

    const existingNonPending = results.filter(r => r.status !== "Pending");
    results = [
      ...candidates.map(c => ({ ...c, status: "Pending", error: "" })),
      ...existingNonPending,
    ];
    renderResults();

    let okCount   = 0;
    let failCount = 0;

    for (let i = 0; i < candidates.length; i++) {
      if (cancelled) {
        for (let j = i; j < candidates.length; j++) results[j].status = "Cancelled";
        renderResults();
        break;
      }

      setStatus(STATUS.disconnecting(i + 1, candidates.length));
      showProgress((i / candidates.length) * 100);

      try {
        await gc.disconnectConversation(api, orgId, candidates[i].convId);
        results[i].status = "Disconnected";
        okCount++;
      } catch (err) {
        results[i].status = "Failed";
        results[i].error  = friendlyError(err);
        failCount++;
      }

      renderResults();
      if (i < candidates.length - 1) await sleep(50);
    }

    showProgress(100);
    const skipCount = results.filter(r => r.status === "Filtered").length;

    if (cancelled) {
      const rem = candidates.length - okCount - failCount;
      setStatus(`Cancelled. Disconnected: ${okCount}, Failed: ${failCount}, Remaining: ${rem}.`);
    } else {
      setStatus(STATUS.done(okCount, failCount, skipCount), failCount > 0 ? "error" : "success");
    }

    setTimeout(hideProgress, 800);
    setButtonsRunning(false);
    candidates = [];
  });

  // ── Cancel / Clear ─────────────────────────────────
  $cancelBtn.addEventListener("click", () => { cancelled = true; });

  $clearBtn.addEventListener("click", () => {
    candidates = [];
    results = [];
    renderResults();
    hideProgress();
    setStatus(STATUS.ready);
  });

  // ── Load queues on mount ───────────────────────────
  (async () => {
    try {
      queues = await gc.fetchAllQueues(api, orgContext.get());
      queues.sort((a, b) => a.name.localeCompare(b.name));
      populateQueueSelect();
      $queue.disabled = false;
      $queueSearch.disabled = false;
      setStatus(STATUS.ready);
    } catch (err) {
      setStatus(`Error: Failed to load queues — ${err.message}`, "error");
      console.error("Queue load error:", err);
    }
  })();

  return el;
}
