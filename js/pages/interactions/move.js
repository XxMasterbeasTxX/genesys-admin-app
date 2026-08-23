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
import { escapeHtml, formatDateTime, sleep, makeStatus, makeControlBusy } from "../../utils.js";
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

const STATUS = {
  ready:      "Ready. Select source and destination queues.",
  loading:    "Loading queues…",
  scanning:   (i, n) => `Scanning interval ${i} of ${n}…`,
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
  const ssSrc = createSingleSelect({ placeholder: "— Select queue —", searchable: true });
  const ssDst = createSingleSelect({ placeholder: "— Select queue —", searchable: true });
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
    const { srcId, mediaTypes, olderThan, newerThan } = params;
    const orgId = orgContext.get();

    // Step 1: Analytics query — active convs in source queue (6 × 31-day windows)
    const now = new Date();
    const seen = new Set();
    const rawConvIds = [];

    for (let i = 0; i < SCAN_INTERVALS; i++) {
      if (cancelled) break;

      const end   = new Date(now.getTime() - i * INTERVAL_DAYS * 86_400_000);
      const start = new Date(end.getTime()  - INTERVAL_DAYS * 86_400_000);
      const interval = `${start.toISOString()}/${end.toISOString()}`;

      setStatus(STATUS.scanning(i + 1, SCAN_INTERVALS));
      showProgress((i / SCAN_INTERVALS) * 20);

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

      const page = await gc.queryConversationDetails(api, orgId, analyticsBody, {
        maxPages: 200,
        onProgress: (n) => showProgress(
          (i / SCAN_INTERVALS) * 20 + Math.min(n / 500, 1) * (20 / SCAN_INTERVALS)
        ),
      });

      for (const c of page) {
        if (!seen.has(c.conversationId)) {
          seen.add(c.conversationId);
          rawConvIds.push(c.conversationId);
        }
      }
    }

    if (!rawConvIds.length) return [];
    if (cancelled) return [];

    // Build a shim array to keep the rest of the loop compatible
    const rawConvs = rawConvIds.map(id => ({ conversationId: id }));

    // ── [move-probe] TEMPORARY — remove once §6.2 is settled ─────────
    //
    // `findAcdParticipant` is a hard gate here: a conversation it rejects is
    // dropped with no trace, and the page then reports "No active interactions
    // found" whether the queue was empty, everything was filtered, or every
    // leg was unreachable. Disconnect stopped gating on the same function after
    // measuring that the live ACD leg is frequently gone on exactly the stuck
    // interactions these pages exist for.
    //
    // Whether that also applies here cannot be reasoned out — Move genuinely
    // needs a participantId to transfer, so some rejections are correct. Every
    // Genesys semantic assumed from the spec or from existing code on
    // 2026-08-21 turned out wrong, and each was settled in one round by a probe.
    //
    // This adds **no API calls**: it reads the same `conv` the loop already
    // fetched. Only the queue-observation cross-check below is extra, and it is
    // one request, tolerated if it fails.
    const probe = {
      total: rawConvs.length,
      inspected: 0,
      fetchFailed: 0,
      noParticipants: 0,
      acdAnywhere: 0,        // an acd participant exists, any queue
      acdInQueue: 0,         // ...and it is this queue
      acdLegGone: 0,         // no acd participant for this queue at all
      wouldMatch: 0,         // what findAcdParticipant returns today
      byMediaState: {},      // every state seen on this queue's acd legs
      acdNoMedia: 0,         // acd leg for this queue carrying no media at all
      purposes: {},
    };
    // ── end [move-probe] ────────────────────────────────────────────

    // Step 2: Get full details for each and find ACD participant
    const matched = [];
    for (let i = 0; i < rawConvs.length; i++) {
      if (cancelled) break;

      const convId = rawConvs[i].conversationId;
      setStatus(STATUS.inspecting(i + 1, rawConvs.length));
      showProgress(20 + (i / rawConvs.length) * 70);

      try {
        const conv = await gc.getConversation(api, orgId, convId);
        const acd = findAcdParticipant(conv, srcId);

        // ── [move-probe] before any `continue`, so nothing is missed ──
        probe.inspected++;
        const parts = conv.participants || [];
        if (!parts.length) probe.noParticipants++;
        let sawAcdAnywhere = false;
        let sawAcdInQueue  = false;
        for (const p of parts) {
          probe.purposes[p.purpose || "(none)"] =
            (probe.purposes[p.purpose || "(none)"] || 0) + 1;
          if (p.purpose !== "acd") continue;
          sawAcdAnywhere = true;
          if ((p.queueId || p.queue?.id) !== srcId) continue;
          sawAcdInQueue = true;
          let sawMedia = false;
          for (const key of ["calls", "emails", "callbacks", "messages"]) {
            for (const item of (p[key] || [])) {
              sawMedia = true;
              const k = `${key}:${item.state ?? "(no state)"}`;
              probe.byMediaState[k] = (probe.byMediaState[k] || 0) + 1;
            }
          }
          if (!sawMedia) probe.acdNoMedia++;
        }
        if (sawAcdAnywhere) probe.acdAnywhere++;
        if (sawAcdInQueue)  probe.acdInQueue++; else probe.acdLegGone++;
        if (acd) probe.wouldMatch++;
        // ── end [move-probe] ─────────────────────────────────────────

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
        probe.fetchFailed++;   // [move-probe]
        // Skip conversations we can't inspect (may have ended)
        console.warn(`Could not inspect ${convId}:`, err.message);
      }
    }

    // ── [move-probe] TEMPORARY — remove once §6.2 is settled ─────────
    //
    // The cross-check that made the Disconnect probe conclusive: if the queue
    // says 169 are waiting and `wouldMatch` says 0, the gate is wrong. Failure
    // is not fatal — the counts above stand on their own.
    const qs = await gc.getQueueStats(api, orgId, srcId, mediaTypes)
      .catch((err) => {
        console.warn("[move-probe] could not read queue observations:", err.message);
        return { waiting: null, interacting: null, oldestMs: null };
      });
    console.log("[move-probe]", JSON.stringify({
      ...probe,
      matchedAfterFilters: matched.length,
      queueWaiting:     qs.waiting,
      queueInteracting: qs.interacting,
      cancelled,
    }, null, 2));
    // ── end [move-probe] ────────────────────────────────────────────

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
    candidates = []; // A fresh preview is required before another move
    setButtonsRunning(false);
  });

  // ── Cancel ──────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => { cancelled = true; });

  // ── Clear ───────────────────────────────────────────
  $clearBtn.addEventListener("click", () => {
    candidates = [];
    results = [];
    renderResults();
    syncMoveButton();
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
