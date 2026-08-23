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
import { escapeHtml, formatDateTime, formatWait, sleep, makeStatus, makeControlBusy } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { createSingleSelect } from "../../components/multiSelect.js";
import { logAction } from "../../services/activityLogService.js";

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

/**
 * Conversations inspected at once.
 *
 * The same figure Disconnect paces at, and for the same reason: the inspection
 * was serial, so a queue of three thousand meant three thousand round-trips end
 * to end. Kept local because it is a pacing choice per page, not shared logic.
 */
const REQUEST_BATCH = 10;

/**
 * Above this many conversations, ask before inspecting them.
 *
 * The inspection costs one request per conversation, so the wait scales with
 * what the scan found and the operator should learn that before it starts
 * rather than during. The same question Recent Search asks before loading
 * participant data, at the same threshold — about six seconds' work, so a queue
 * of ordinary size never sees it.
 */
const SCAN_CONFIRM_OVER = 250;

const STATUS = {
  ready:      "Ready. Select source and destination queues.",
  loading:    "Loading queues…",
  counting:   "Checking which months hold anything…",
  declined:   (n) =>
    `Preview not run — ${n.toLocaleString()} interactions to inspect. `
    + "Narrow the media types or the date range, or run Preview again to read them all.",
  scanning:   (i, n) => `Scanning interval ${i} of ${n}…`,
  // A window with tens of thousands in it pages for a while, and a status line
  // that does not move reads as a page that has died.
  scanningFound: (i, n, found) =>
    `Scanning interval ${i} of ${n} — ${found.toLocaleString()} found…`,
  inspecting: (i, n) =>
    `Inspecting ${i}–${Math.min(i + REQUEST_BATCH - 1, n)} of ${n}…`,
  moving:     (n, total) => `Moving ${n} of ${total}…`,
  noResults:  "Nothing found in this queue for the selected period.",
  error:      (msg) => `Error: ${msg}`,

  /**
   * Where everything went, not just what survived.
   *
   * "No active interactions found matching the criteria" used to cover five
   * different situations — an empty queue, everything filtered by media type,
   * everything filtered by date, legs that could not be transferred, and calls
   * that failed — and an operator could not tell which. That ambiguity is what
   * cost four rounds on Disconnect, and the fix there was this line.
   *
   * `waiting` comes from live queue observations rather than from the scan,
   * because the two answer different questions: one is what the queue holds
   * now, the other is what this preview could act on. "0 to move · 412
   * waiting in queue" is plainly a filter that is too tight, where a bare "no
   * interactions found" reads as an empty queue.
   */
  previewed(movable, scanned, waiting, oldestMs, skips) {
    const parts = [`${movable.toLocaleString()} to move`];
    if (scanned !== movable) parts.push(`${scanned.toLocaleString()} scanned`);
    if (waiting != null) parts.push(`${waiting.toLocaleString()} waiting in queue`);
    const age = formatWait(oldestMs);
    if (age) parts.push(`oldest waiting ${age}`);
    for (const [reason, n] of [...skips].sort((a, b) => b[1] - a[1])) {
      parts.push(`${n.toLocaleString()} ${reason}`);
    }
    return `Preview: ${parts.join(" · ")}`;
  },

  done(ok, fail) {
    const p = [`Moved: ${ok}`];
    if (fail) p.push(`Failed: ${fail}`);
    return `Done. ${p.join(", ")}.`;
  },
};

/**
 * Why a conversation is not being moved, in two registers: a short phrase that
 * aggregates into the status line, and a sentence for the table's Detail
 * column. Kept together so the two can never drift apart.
 */
const SKIP = {
  beingHandled: { status: "Being handled", short: "being handled by an agent",
                  detail: "An agent is handling this interaction" },
  leftQueue:    { status: "Not movable",   short: "no longer in this queue",
                  detail: "The interaction has moved on to another queue" },
  noLeg:        { status: "Not movable",   short: "no active queue leg",
                  detail: "No active queue leg — there is no participant to transfer" },
  media:        { status: "Filtered",      short: "media type not selected",
                  detail: (t) => `Media type "${t}" not selected` },
  older:        { status: "Filtered",      short: "outside the date range",
                  detail: "Started after the 'Older than' date" },
  newer:        { status: "Filtered",      short: "outside the date range",
                  detail: "Started before the 'Newer than' date" },
};

// ── Helpers ─────────────────────────────────────────────────────────

/** The four media collections a participant can carry, and what each means. */
const MEDIA_COLLECTIONS = [
  { key: "calls",     type: "voice" },
  { key: "emails",    type: "email" },
  { key: "callbacks", type: "callback" },
  { key: "messages",  type: "message" },
];

/**
 * True when a participant is still on the interaction.
 *
 * `connected` and `alerting` are the two live states, measured on 2026-08-23
 * rather than assumed: a queue of waiting emails reported `emails:connected`
 * throughout, and the ones an agent had picked up read `emails:disconnected` on
 * the **queue** leg — the ACD participant's media ends the moment the
 * interaction is answered.
 */
function hasLiveMedia(p) {
  for (const mc of MEDIA_COLLECTIONS) {
    for (const item of (p[mc.key] || [])) {
      if (item.state === "connected" || item.state === "alerting") return true;
    }
  }
  return false;
}

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
 *
 * Requiring **live** media is not merely a way of locating a usable
 * `participantId` — it is also the "not currently being handled" test, and it
 * is the only thing stopping Move blind-transferring an interaction out from
 * under the agent working it. Measured on 2026-08-23: of 34 unended
 * conversations in one queue, the 2 this rejected were exactly the 2 the queue
 * reported as being interacted with. Loosening this to "any transferable
 * participant" would read as a tidy-up and would be a defect.
 */
function findAcdParticipant(conversation, sourceQueueId) {
  if (!conversation.participants) return null;

  for (const p of conversation.participants) {
    if (p.purpose !== "acd") continue;

    // Check queue match
    const pQueue = p.queueId || p.queue?.id;
    if (pQueue !== sourceQueueId) continue;

    // Check for active media (connected or alerting)
    for (const mc of MEDIA_COLLECTIONS) {
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

/**
 * What Move can do with one conversation, and why — one verdict per row.
 *
 * Every path returns something. The page used to `continue` past anything it
 * could not move, which is how five different outcomes came to share one
 * message.
 */
function classifyConversation(conv, queueId, filters) {
  const acd = findAcdParticipant(conv, queueId);
  const mediaType = acd ? acd.mediaType : detectMediaType(conv.participants);
  const row = { mediaType, startTime: formatDateTime(conv.startTime) };

  if (!acd) {
    // The reasons are worth separating: an interaction an agent is working is
    // fine and deliberately left alone, one with no leg at all may need
    // attention, and one that has moved on is neither.
    const parts = conv.participants || [];
    if (parts.some(p => p.purpose === "agent" && hasLiveMedia(p))) {
      return { ...row, skip: SKIP.beingHandled };
    }
    const stillHere = parts.some(
      p => p.purpose === "acd" && (p.queueId || p.queue?.id) === queueId);
    return { ...row, skip: stillHere ? SKIP.noLeg : SKIP.leftQueue };
  }

  if (!filters.mediaTypes.includes(acd.mediaType)) {
    return { ...row, skip: SKIP.media, detail: SKIP.media.detail(acd.mediaType) };
  }

  const startTime = conv.startTime ? new Date(conv.startTime) : null;
  if (filters.olderThan && startTime
      && startTime >= new Date(filters.olderThan + "T00:00:00Z")) {
    return { ...row, skip: SKIP.older };
  }
  if (filters.newerThan && startTime
      && startTime <= new Date(filters.newerThan + "T23:59:59Z")) {
    return { ...row, skip: SKIP.newer };
  }

  return { ...row, participantId: acd.participantId };
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
      Transfer interactions waiting in one queue to another, by blind transfer.
      Filters: media type and date range. Preview before moving — Move acts on
      what the preview found, and cannot be undone.
    </p>

    <div class="mi-warning">
      <div class="mi-warning-title">&#9888; WARNING: Move is a blind transfer and cannot be undone</div>
      Each matching interaction is transferred to the destination queue and
      re-queued there. It cannot be moved back automatically, and its wait time
      in the destination queue starts again.
    </div>

    <!-- Route. One row with the direction shown: source and destination were
         two identically sized blocks 400px apart, distinguished only by a 12px
         grey label, on an action where reversing them is the expensive mistake. -->
    <div class="mi-controls">
      <div class="mi-route">
        <div class="mi-control-group">
          <label class="mi-label" id="miSrcLabel">Source queue</label>
          <div id="miSrcDropdown"></div>
        </div>
        <div class="mi-route-arrow" aria-hidden="true">&#8594;</div>
        <div class="mi-control-group">
          <label class="mi-label" id="miDstLabel">Destination queue</label>
          <div id="miDstDropdown"></div>
        </div>
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
      <button class="btn btn--primary" id="miPreviewBtn" disabled>Preview</button>
      <button class="btn mi-btn-move" id="miMoveBtn" disabled
              title="Run a preview first">Move Interactions</button>
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
  const ssSrc = createSingleSelect({
    placeholder: "— Select queue —",
    searchable: true,
    onChange: () => invalidateCandidates(),
  });
  const ssDst = createSingleSelect({
    placeholder: "— Select queue —",
    searchable: true,
    onChange: () => invalidateCandidates(),
  });
  el.querySelector("#miSrcDropdown").append(ssSrc.el);
  el.querySelector("#miDstDropdown").append(ssDst.el);
  ssSrc.setEnabled(false);
  ssDst.setEnabled(false);
  const srcBusy       = makeControlBusy(el.querySelector("#miSrcLabel"));
  const dstBusy       = makeControlBusy(el.querySelector("#miDstLabel"));
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

  /** A queue name, for the confirmation dialog and the Activity Log entry. */
  function queueName(id) {
    return queues.find(q => q.id === id)?.name || "";
  }

  // ── Media type wiring ───────────────────────────────
  $mediaAll.addEventListener("change", () => {
    $mediaCbs.forEach(cb => { cb.checked = $mediaAll.checked; });
    invalidateCandidates();
  });
  $mediaCbs.forEach(cb => {
    cb.addEventListener("change", () => {
      const allChecked = [...$mediaCbs].every(c => c.checked);
      const noneChecked = [...$mediaCbs].every(c => !c.checked);
      $mediaAll.checked = allChecked;
      $mediaAll.indeterminate = !allChecked && !noneChecked;
      invalidateCandidates();
    });
  });

  // ── Date filter wiring ──────────────────────────────
  // The dates themselves invalidate too, not only the checkboxes that enable
  // them: editing a date after a preview changes what the preview would have
  // found just as much as turning the filter on does.
  $olderEnable.addEventListener("change", () => {
    $olderDate.disabled = !$olderEnable.checked;
    invalidateCandidates();
  });
  $newerEnable.addEventListener("change", () => {
    $newerDate.disabled = !$newerEnable.checked;
    invalidateCandidates();
  });
  $olderDate.addEventListener("change", () => invalidateCandidates());
  $newerDate.addEventListener("change", () => invalidateCandidates());

  // ── Status / progress ───────────────────────────────
  const setStatus = makeStatus($status, "mi-status");
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
    $cancelBtn.style.display = running ? "" : "none";
    ssSrc.setEnabled(!running);
    ssDst.setEnabled(!running);
    syncMoveButton();
  }

  /**
   * Move is available only once a preview has produced a set to act on.
   *
   * It used to be enabled as soon as the queues loaded, and pressing it ran the
   * scan itself — so the whole set could be transferred without ever being
   * shown, on an action that cannot be undone. Disconnect was given the same
   * failsafe on 2026-08-21, for the same reason.
   */
  function syncMoveButton() {
    $moveBtn.disabled = isRunning || !candidates.length;
    $moveBtn.title = candidates.length
      ? `Move the ${candidates.length} previewed interaction${candidates.length !== 1 ? "s" : ""}`
      : "Run a preview first";
  }

  /** The only place `candidates` is assigned, so the button cannot drift. */
  function setCandidates(next) {
    candidates = next;
    syncMoveButton();
  }

  /**
   * Anything that changes what a preview would find discards the preview.
   *
   * Without this the previewed set outlived the filters that produced it, and
   * Move acted on it: preview against queue A, switch the source to B, press
   * Move, and the interactions from **A** were transferred — while the
   * confirmation read "from B", because that name was taken from the control
   * rather than from the search. Disconnect was given the same rule in release
   * 4.1 for the same reason.
   */
  function invalidateCandidates() {
    if (!candidates.length || isRunning) return;
    setCandidates([]);
    results = [];
    renderResults();
    setStatus(STATUS.ready);
  }

  // ── Render results table ────────────────────────────
  function renderResults() {
    if (!results.length) {
      // Emptied, not just hidden: a discarded preview's rows used to stay in
      // the DOM behind a hidden wrapper, which is the same stale state this
      // page has just been taught not to keep.
      $tbody.innerHTML = "";
      $tableWrap.style.display = "none";
      return;
    }
    $tableWrap.style.display = "";
    $tbody.innerHTML = results.map((r, i) => {
      const statusClass = r.status === "Moved" ? "mi-ok"
        : r.status === "Failed" || r.status === "Not movable" ? "mi-fail"
        : r.status === "Filtered" || r.status === "Being handled" ? "mi-skip"
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
    const srcId = ssSrc.getValue();
    const dstId = ssDst.getValue();
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
    const { srcId, mediaTypes } = params;   // the rest is read by classifyConversation
    const orgId = orgContext.get();

    // Step 1: analytics — unended conversations in the source queue, over six
    // 31-day windows.
    const now = new Date();
    const seen = new Set();
    const rawConvIds = [];

    const segmentFilters = [{
      type: "and",
      predicates: [{ dimension: "queueId", value: srcId }],
    }];
    const conversationFilters = [{
      type: "and",
      predicates: [{ dimension: "conversationEnd", operator: "notExists" }],
    }];

    const allIntervals = [];
    for (let i = 0; i < SCAN_INTERVALS; i++) {
      const end   = new Date(now.getTime() - i * INTERVAL_DAYS * 86_400_000);
      const start = new Date(end.getTime()  - INTERVAL_DAYS * 86_400_000);
      allIntervals.push(`${start.toISOString()}/${end.toISOString()}`);
    }

    // Ask each window whether it holds anything before paging through it. The
    // response carries `totalHits`, so one request with a page size of 1
    // answers it — and a queue's unended interactions are usually recent, so
    // most windows are empty. Measured 2026-08-23: a queue of 34 had every one
    // of them in the newest window, and the other five were paged for nothing.
    //
    // A failed count scans that window anyway. Guessing "empty" from an error
    // would silently narrow the run, which is the one outcome this page has
    // just been cleaned of.
    setStatus(STATUS.counting);
    const counts = await Promise.all(allIntervals.map(interval =>
      gc.countConversationDetails(api, orgId, {
        interval, segmentFilters, conversationFilters,
      }).catch((err) => {
        console.warn("Interval count failed, scanning it anyway:", err.message);
        return null;
      })));
    const intervals = allIntervals.filter((_, i) => counts[i] === null || counts[i] > 0);

    for (let i = 0; i < intervals.length; i++) {
      if (cancelled) break;

      setStatus(STATUS.scanning(i + 1, intervals.length));
      showProgress((i / intervals.length) * 20);

      const page = await gc.queryConversationDetails(api, orgId, {
        interval: intervals[i],
        order: "desc",
        orderBy: "conversationStart",
        segmentFilters,
        conversationFilters,
      }, {
        // No page limit. It used to stop at 200 pages of 100 — 20,000
        // conversations per window — and the pager cannot tell a caller whether
        // it reached the end or ran out of pages, so a bigger queue was
        // silently reported short. Worse, the query runs newest-first, so what
        // it dropped were the oldest: exactly the interactions this page exists
        // to shift. A scan that quietly answers a different question than the
        // one asked is the fault this page has spent several commits removing.
        //
        // Unbounded needs an exit, hence `shouldStop`: Cancel now takes effect
        // between pages rather than only between windows.
        maxPages: Infinity,
        shouldStop: () => cancelled,
        onProgress: (n) => {
          setStatus(STATUS.scanningFound(i + 1, intervals.length, n));
          showProgress(
            (i / intervals.length) * 20 + Math.min(n / 500, 1) * (20 / intervals.length));
        },
      });

      for (const c of page) {
        if (!seen.has(c.conversationId)) {
          seen.add(c.conversationId);
          rawConvIds.push(c.conversationId);
        }
      }
    }

    // The queue's own depth, read from live observations rather than counted
    // from the scan: the two answer different questions, and the status line
    // wants both. Not fatal if the permission is missing — the fields come back
    // null and the phrase is left out.
    const stats = await gc.getQueueStats(api, orgId, srcId, mediaTypes)
      .catch((err) => {
        console.warn("Could not read queue observations:", err.message);
        return { waiting: null, interacting: null, oldestMs: null };
      });

    if (!rawConvIds.length || cancelled) {
      return { movable: [], rows: [], scanned: 0, skips: new Map(), stats };
    }

    // The inspection is one request per conversation, so this is where the time
    // goes. Asked here rather than before the scan: the analytics count is a
    // sum over windows, and a long-running conversation appears in more than
    // one of them, so it overstates. `rawConvIds` is deduplicated and exact.
    if (rawConvIds.length > SCAN_CONFIRM_OVER) {
      const estimate = formatWait(
        Math.max(1, Math.round(rawConvIds.length / REQUEST_BATCH * 0.25)) * 1000);
      const proceed = confirm(
        `${rawConvIds.length.toLocaleString()} unended interactions were found in this queue.\n\n`
        + `Previewing them means reading each one — about ${estimate}.\n\n`
        + "Continue?");
      if (!proceed) {
        return { movable: [], rows: [], scanned: 0, skips: new Map(), stats,
                 declined: rawConvIds.length };
      }
    }

    // Step 2: fetch each conversation and record a verdict for every one.
    //
    // Every conversation gets a row. Anything that cannot be moved used to be
    // skipped with `continue`, which is how an empty queue, a media filter, a
    // date filter, an agent-held interaction and a failed request all came to
    // produce the same sentence.
    const rows    = [];   // one per conversation, in scan order
    const movable = [];   // the subset Move will act on, pointing back at rows
    const skips   = new Map();
    const note = (short) => skips.set(short, (skips.get(short) || 0) + 1);

    // One conversation's verdict, self-contained and never rejecting, so a
    // batch can go through Promise.all without one bad id taking the rest with
    // it.
    async function inspect(convId) {
      try {
        const conv = await gc.getConversation(api, orgId, convId);
        return { convId, ...classifyConversation(conv, srcId, params) };
      } catch (err) {
        return { convId, failed: err.message || String(err) };
      }
    }

    // Batched, not serial: ten at a time rather than one, the pacing Disconnect
    // already runs at. Batches are awaited in order and their verdicts appended
    // in order, so the table still reads in scan order and `rowIdx` still
    // points where it should.
    for (let i = 0; i < rawConvIds.length && !cancelled; i += REQUEST_BATCH) {
      const chunk = rawConvIds.slice(i, i + REQUEST_BATCH);
      setStatus(STATUS.inspecting(i + 1, rawConvIds.length));
      showProgress(20 + (i / rawConvIds.length) * 70);

      for (const v of await Promise.all(chunk.map(inspect))) {
        if (v.failed) {
          note("could not be inspected");
          rows.push({ convId: v.convId, mediaType: "—", startTime: "—",
                      status: "Failed", error: v.failed });
        } else if (v.skip) {
          note(v.skip.short);
          rows.push({ convId: v.convId, mediaType: v.mediaType, startTime: v.startTime,
                      status: v.skip.status, error: v.detail || v.skip.detail });
        } else {
          movable.push({
            convId: v.convId,
            participantId: v.participantId,
            mediaType: v.mediaType,
            startTime: v.startTime,
            rowIdx: rows.length,
          });
          rows.push({ convId: v.convId, mediaType: v.mediaType, startTime: v.startTime,
                      status: "Pending", error: "" });
        }
      }

      if (i + REQUEST_BATCH < rawConvIds.length) await sleep(50);
    }

    return { movable, rows, scanned: rows.length, skips, stats };
  }

  // ── Preview ─────────────────────────────────────────
  $previewBtn.addEventListener("click", async () => {
    const params = validate();
    if (!params) return;

    cancelled = false;
    setCandidates([]);   // an error mid-scan must not leave the previous set armed
    setButtonsRunning(true);
    results = [];
    renderResults();

    try {
      const scan = await scanConversations(params);

      if (cancelled) {
        // A cancelled scan stops mid-inspection and returns what it had. That
        // partial set was previously kept and armed the Move button, so the
        // operator could transfer a set they had never been shown, at a count
        // that looked authoritative. A partial result is not a result.
        setCandidates([]);
        setStatus("Preview cancelled — nothing was previewed. Run it again.");
      } else if (scan.declined) {
        // Declining is not an error and not an empty queue: it is a queue big
        // enough to be worth narrowing first, and the count is the useful part
        // of saying so.
        setCandidates([]);
        setStatus(STATUS.declined(scan.declined));
      } else if (!scan.scanned) {
        setCandidates([]);
        setStatus(STATUS.noResults);
      } else {
        // Every conversation gets a row, movable or not, so the table explains
        // the status line rather than only listing what survived it.
        results = scan.rows;
        renderResults();
        setCandidates(scan.movable);
        setStatus(
          STATUS.previewed(scan.movable.length, scan.scanned,
                           scan.stats.waiting, scan.stats.oldestMs, scan.skips),
          scan.movable.length ? "success" : "");
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

    // No scan-on-press branch. The button is disabled until a preview has
    // produced a set (`syncMoveButton`), so there is always something to move
    // and it has always been shown first.
    if (!candidates.length) return;

    // Confirmation
    const srcName = queueName(params.srcId);
    const dstName = queueName(params.dstId);
    const ok = confirm(
      `Move ${candidates.length} interaction${candidates.length !== 1 ? "s" : ""} from "${srcName}" to "${dstName}"?\n\nThis action cannot be undone.`
    );
    if (!ok) { setButtonsRunning(false); hideProgress(); return; }

    cancelled = false;
    setButtonsRunning(true);
    const orgId = orgContext.get();

    let successCount = 0;
    let failCount = 0;

    // The preview's rows stay as they are and the movable ones are updated in
    // place through `rowIdx`. Rebuilding the table from `candidates` would drop
    // every row explaining why something was left out, at the moment those
    // explanations are most worth having.
    for (let i = 0; i < candidates.length; i++) {
      if (cancelled) {
        for (let j = i; j < candidates.length; j++) {
          results[candidates[j].rowIdx].status = "Cancelled";
        }
        renderResults();
        break;
      }

      const c = candidates[i];
      setStatus(STATUS.moving(i + 1, candidates.length));
      showProgress((i / candidates.length) * 100);

      try {
        await gc.replaceParticipantQueue(api, orgId, c.convId, c.participantId, params.dstId);
        results[c.rowIdx].status = "Moved";
        successCount++;
      } catch (err) {
        results[c.rowIdx].status = "Failed";
        results[c.rowIdx].error = err.message || String(err);
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
    logAction({
      me,
      orgId:       orgContext.get() || "",
      action:      "interaction_move",
      description: `Moved ${successCount} interaction${successCount !== 1 ? "s" : ""} from '${srcName}' to '${dstName}'${failCount ? ` (${failCount} failed)` : ""}${
        cancelled ? " [cancelled]" : ""}`,
      result:      successCount === 0 && failCount > 0 ? "failure" : failCount > 0 || cancelled ? "partial" : "success",
      count:       successCount + failCount,
    });
    setTimeout(hideProgress, 800);
    setCandidates([]);   // a fresh preview is required before another move
    setButtonsRunning(false);
  });

  // ── Cancel ──────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => { cancelled = true; });

  // ── Clear ───────────────────────────────────────────
  $clearBtn.addEventListener("click", () => {
    setCandidates([]);
    results = [];
    renderResults();
    hideProgress();
    setStatus(STATUS.ready);
  });

  // ── Load queues on mount ────────────────────────────
  (async () => {
    srcBusy(true); dstBusy(true);
    try {
      queues = await gc.fetchAllQueues(api, orgContext.get());
      queues.sort((a, b) => a.name.localeCompare(b.name));

      const items = queues.map(q => ({ id: q.id, label: q.name }));
      ssSrc.setItems(items);
      ssDst.setItems(items);
      ssSrc.setEnabled(true);
      ssDst.setEnabled(true);
      $previewBtn.disabled = false;
      // Move stays disabled: it needs a preview, not a queue list.

      setStatus(STATUS.ready);
    } catch (err) {
      setStatus(STATUS.error(`Failed to load queues: ${err.message}`), "error");
      console.error("Queue load error:", err);
    } finally {
      srcBusy(false); dstBusy(false);
    }
  })();

  return el;
}
