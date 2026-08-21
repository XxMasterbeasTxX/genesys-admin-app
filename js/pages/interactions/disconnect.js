/**
 * Interactions › Disconnect
 *
 * Force-disconnect stuck/orphaned conversations. Three modes:
 *   1. Single ID   — disconnect one conversation
 *   2. Multiple IDs — disconnect several conversations by ID
 *   3. Empty Queue  — find all active conversations in a queue and disconnect
 *
 * Includes media type, date range and — for email — sender/recipient address
 * filters. See docs/disconnect-email-filter-design.md.
 *
 * API endpoints:
 *   GET  /api/v2/conversations/{id}                        — fetch conversation details
 *   POST /api/v2/conversations/{id}/disconnect              — force-disconnect
 *   POST /api/v2/analytics/conversations/details/query      — queue scan (active convos)
 *   GET  /api/v2/analytics/conversations/{id}/details       — sender/recipient for one ID
 *   POST /api/v2/analytics/queues/observations/query        — live queue depth
 *   GET  /api/v2/routing/queues                             — list queues
 */
import { escapeHtml, formatDateTime, sleep, makeStatus } from "../../utils.js";
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

/**
 * Concurrent requests per batch, for both inspecting and disconnecting.
 *
 * Ten at a time with a short pause between batches is what the disconnect loop
 * has run at; the same figure is used for inspection so there is one number to
 * reason about if rate limiting ever needs tuning.
 */
const REQUEST_BATCH = 10;

/** Number of 31-day intervals to scan backwards (≈ 6 months). */
const SCAN_INTERVALS = 6;
const INTERVAL_DAYS  = 31;
const RECENT_LOOKBACK_HOURS = 48;
const RECENT_BUCKET_HOURS   = 6;

const STATUS = {
  ready:          "Ready. Select a mode, provide input, then Preview.",
  loading:        "Loading queues…",
  scanning:       (i, n) => `Scanning interval ${i} of ${n}…`,
  inspecting:     (i, n) =>
    `Inspecting ${i}–${Math.min(i + REQUEST_BATCH - 1, n)} of ${n}…`,
  disconnecting:  (i, n) =>
    `Disconnecting ${i}–${Math.min(i + REQUEST_BATCH - 1, n)} of ${n}…`,
  noResults:      "No conversations found matching the criteria.",

  /** ID modes: the table carries the detail, the line carries the split. */
  previewedIds(match, total) {
    if (match === total) return `Preview: all ${total} ID${total !== 1 ? "s" : ""} match.`;
    return `Preview: ${match} of ${total} ID${total !== 1 ? "s" : ""} match — see the table for the rest.`;
  },

  /**
   * Queue mode: no per-row table, so the line has to say where everything went.
   *
   * `waiting` is what is actually in the queue right now, read from real-time
   * observations rather than counted from the scan. Once the address filters
   * are pushed to Genesys the scan never sees the conversations it excluded, so
   * a count derived from the scan would report the size of the filtered result
   * and nothing else — "4 match" beside a queue holding 5. The two numbers
   * answer different questions and both are worth knowing.
   *
   * It also restores the diagnostic the server-side filtering took away:
   * "0 match · 2,847 waiting in queue" is plainly a filter that is too tight,
   * where a bare "no conversations found" reads as an empty queue.
   */
  previewedQueue(match, waiting, interacting, oldestMs, skips) {
    if (!match && !waiting) return this.noResults;
    const parts = [`${match.toLocaleString()} match`];
    if (waiting != null) parts.push(`${waiting.toLocaleString()} waiting in queue`);

    // Only when something is live, because that is when it changes what the
    // scan did: it is the condition that turns the agent guard on.
    if (interacting) parts.push(`${interacting.toLocaleString()} being handled`);

    // Context about the queue, not about the search. `oLongestWaiting` describes
    // the waiting population; this scan's population is the unended one, and
    // Intervare proved those differ. It is shown, never acted on.
    const age = formatWait(oldestMs);
    if (age) parts.push(`oldest waiting ${age}`);

    for (const [reason, n] of [...skips].sort((a, b) => b[1] - a[1])) {
      parts.push(`${n.toLocaleString()} ${reason}`);
    }
    return parts.join(" · ");
  },
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

/**
 * Find an ACD participant that is actively waiting (connected or alerting).
 * If queueId is provided, also requires the participant to be in that queue.
 * Returns { participantId, mediaType } or null.
 */
function findAcdParticipant(conversation, queueId = null) {
  if (!conversation.participants) return null;

  const mediaCollections = [
    { key: "calls",     type: "voice" },
    { key: "emails",    type: "email" },
    { key: "callbacks", type: "callback" },
    { key: "messages",  type: "message" },
  ];

  for (const p of conversation.participants) {
    if (p.purpose !== "acd") continue;

    if (queueId !== null) {
      const pQueue = p.queueId || p.queue?.id;
      if (pQueue !== queueId) continue;
    }

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

/**
 * True when the conversation is still sitting in this queue: the **ACD**
 * participant has an open segment for this queue.
 *
 * Keyed on `purpose`, not on `segmentType`. Observed on a live queue of 169
 * waiting emails (2026-08-21), every one of them shaped like this:
 *
 *   { purpose: "external", segmentType: "interact", open: true  }
 *   { purpose: "workflow", segmentType: "interact", open: false }
 *   { purpose: "acd",      segmentType: "interact", open: true, queueId: "…" }
 *
 * So for email there is no `delay` segment and nothing called `wait`: the ACD
 * leg's segment reads `interact` for the whole time the email is queued.
 * `segmentType` therefore says nothing about whether an agent has it, and two
 * earlier attempts here failed on exactly that — one looking for a `wait` type
 * that does not exist in the enum, one treating `interact` as agent-held and so
 * excluding the entire queue.
 *
 * What carries the meaning is the ACD participant having an unfinished segment:
 * the queue leg is still open, so the interaction has not left the queue. A
 * conversation that moved on, or died, has that segment closed — which is what
 * keeps `Intervare`'s two out.
 *
 * A segment naming a different queue is skipped; one naming no queue is
 * accepted, since the conversation reached this scan through a queueId filter.
 */
function isWaitingInQueue(conversation, queueId) {
  for (const p of (conversation.participants || [])) {
    if (p.purpose !== "acd") continue;
    for (const session of (p.sessions || [])) {
      for (const seg of (session.segments || [])) {
        if (seg.segmentEnd) continue;                        // the queue leg closed
        if (queueId && seg.queueId && seg.queueId !== queueId) continue;
        return true;
      }
    }
  }
  return false;
}

/**
 * TEMPORARY (2026-08-21): whether the open ACD segment actually named this
 * queue, or was accepted because it named no queue at all. Part of accounting
 * for 173 matched against a depth of 169.
 */
function acdSegmentNamesQueue(conversation, queueId) {
  for (const p of (conversation.participants || [])) {
    if (p.purpose !== "acd") continue;
    for (const session of (p.sessions || [])) {
      for (const seg of (session.segments || [])) {
        if (seg.segmentEnd) continue;
        if (seg.queueId === queueId) return true;
      }
    }
  }
  return false;
}

/** Participant purposes that mean a person is on the interaction. */
const AGENT_PURPOSES = new Set(["agent", "user"]);

/**
 * True when an agent has the interaction — connected, or ringing.
 *
 * Also keyed on `purpose`. An agent joins as its own participant, so an open
 * segment on an `agent` or `user` participant is what "an agent has it" looks
 * like. The previous version tested `segmentType` for `interact`/`alert` on any
 * participant, which the shape above shows is true of every *queued* email — it
 * would have excluded a whole queue the moment `oInteracting` went non-zero.
 * That is very likely why `549dbc3` removed it.
 *
 * Inferred from the participant model rather than observed: the probe ran
 * against a queue with nothing live in it, so no agent-held conversation was
 * seen. It is consulted only when the queue reports live interactions, and
 * `isWaitingInQueue` already excludes anything whose ACD leg has closed, so this
 * is a second line rather than the only one.
 */
function hasAgentEngaged(conversation) {
  for (const p of (conversation.participants || [])) {
    if (!AGENT_PURPOSES.has(p.purpose)) continue;
    for (const session of (p.sessions || [])) {
      for (const seg of (session.segments || [])) {
        if (!seg.segmentEnd) return true;
      }
    }
  }
  return false;
}

/**
 * Detect media type from an analytics conversation's participant sessions.
 * Returns the first mediaType found (lowercased), or null.
 */
function getSessionMediaType(conversation) {
  for (const p of (conversation.participants || [])) {
    for (const session of (p.sessions || [])) {
      if (session.mediaType) return session.mediaType.toLowerCase();
    }
  }
  return null;
}

/**
 * Reduce an address to the form the Genesys analytics fields carry.
 *
 * Operators paste from mail clients, so `Support <SUPPORT@Acme.com>` and
 * `mailto:support@acme.com` both turn up. Both are the same filter as
 * `support@acme.com`, and matching is case-insensitive, so everything is
 * folded to one shape once here rather than at each comparison.
 */
// Confirmed against live Genesys data (2026-08-21): `addressFrom` keeps the
// sender's original casing — THVA@tdc.nuuway.dk — while `addressTo` came back
// lowercase. The fold below is therefore load-bearing, not tidying: without it
// a sender filter typed in lowercase matches nothing.
function normaliseAddress(raw) {
  let v = String(raw || "").trim();
  const angled = v.match(/<([^>]*)>/);       // "Display Name <a@b.com>"
  if (angled) v = angled[1].trim();
  v = v.replace(/^mailto:/i, "").trim();
  return v.toLowerCase();
}

/**
 * Why an address row is unusable, or null if it is fine.
 *
 * A malformed row is never silently dropped: dropping it would widen the run
 * the operator thought they were narrowing.
 */
function addressRowError(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;                        // blank rows are simply ignored
  if (/[,;]/.test(v)) return "One address per row.";
  const norm = normaliseAddress(v);
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(norm)) return "Not a valid email address.";
  return null;
}

/**
 * Every sender and recipient address an analytics conversation carries.
 *
 * `addressFrom` / `addressTo` live on the session, and the same pair repeats on
 * each side of the conversation, so both are gathered into sets.
 */
// Live data (2026-08-21) shows `addressFrom` / `addressTo` identical across all
// three sessions of an inbound email — external, workflow and acd — while
// `addressSelf` / `addressOther` swap sides per participant. That is why this
// pair is the source of truth and the other is not.
function collectSessionAddresses(conv) {
  const from = new Set();
  const to   = new Set();
  for (const p of (conv?.participants || [])) {
    for (const sess of (p.sessions || [])) {
      if (sess.addressFrom) from.add(normaliseAddress(sess.addressFrom));
      if (sess.addressTo)   to.add(normaliseAddress(sess.addressTo));
    }
  }
  return { from, to };
}

/**
 * Check a conversation's addresses against the address filters.
 * Returns { pass, reason } — `reason` is what the operator is shown.
 *
 * Several addresses in one field are OR'd, the two fields are AND'd, and an
 * empty field imposes nothing. An address that cannot be read is never treated
 * as a match: this filter only ever narrows, so a conversation the page cannot
 * account for stays out of the run.
 */
function matchesAddressFilters({ from, to }, { senders, recipients }) {
  if (!senders.length && !recipients.length) return { pass: true, reason: null };

  if (senders.length) {
    if (!from.size) return { pass: false, reason: "no sender address on record" };
    if (!senders.some(a => from.has(a))) return { pass: false, reason: "sender does not match" };
  }
  if (recipients.length) {
    if (!to.size) return { pass: false, reason: "no recipient address on record" };
    if (!recipients.some(a => to.has(a))) return { pass: false, reason: "recipient does not match" };
  }
  return { pass: true, reason: null };
}

/**
 * Address filters expressed as Genesys `segmentFilters` entries.
 *
 * `addressFrom` and `addressTo` are both segment dimensions, so the filter can
 * be pushed to the server instead of pulling six months of a queue back to
 * filter here. Several addresses in one field become an `or` clause; the two
 * fields become separate entries.
 *
 * Separate entries deliberately: entries are ANDed across the conversation and
 * may each be satisfied by a *different* segment, while predicates inside one
 * clause must be satisfied together. `queueId` lives on the ACD segment and the
 * addresses come from the session, so folding them into one clause could match
 * nothing.
 *
 * This is an optimisation, never the correctness boundary —
 * matchesAddressFilters() still runs on everything that comes back. The only
 * operator available is `matches`, which is exact, which is why the filter was
 * defined as exact-match in the first place.
 *
 * `matches` is case-insensitive: values go out lowercased and were confirmed
 * on 2026-08-21 to match a stored `THVA@tdc.nuuway.dk`.
 */
function addressSegmentFilters({ senders, recipients }) {
  const out = [];
  if (senders.length) {
    out.push({ type: "or", predicates: senders.map(v => ({ dimension: "addressFrom", value: v })) });
  }
  if (recipients.length) {
    out.push({ type: "or", predicates: recipients.map(v => ({ dimension: "addressTo", value: v })) });
  }
  return out;
}

/**
 * A wait duration, compact enough to sit inside a status line: 45s, 12m, 3h,
 * 6d, 4mo. Precision past the leading unit is noise here — the question this
 * answers is "how far back does this queue reach", not "exactly how long".
 */
function formatWait(ms) {
  if (typeof ms !== "number" || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60)      return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60)      return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48)      return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 60)      return `${d}d`;
  return `${Math.round(d / 30)}mo`;
}

/**
 * A plain account of the address filters in force, or "" when there are none.
 *
 * Used at the two points where what was acted on has to be legible after the
 * fact: the confirmation, and the Activity Log entry. "4 conversations in queue
 * Support" reads as a queue holding four; it may hold five, with one belonging
 * to someone else entirely.
 */
function describeAddressFilters({ senders, recipients }) {
  const parts = [];
  if (senders.length)    parts.push(`sender ${senders.join(", ")}`);
  if (recipients.length) parts.push(`recipient ${recipients.join(", ")}`);
  return parts.join("; ");
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

export default function renderDisconnectInteractions({ me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Disconnect Interactions</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ───────────────────────────────────────────
  let queues     = [];
  let candidates = [];     // conversations that passed filters
  let isRunning  = false;
  let cancelled  = false;
  let currentMode = "single";

  // ── Build UI ────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Disconnect Interactions</h1>
    <hr class="hr">

    <p class="page-desc">
      Force-disconnect stuck or orphaned conversations. Choose between
      disconnecting a single conversation, multiple IDs, or emptying an
      entire queue. Supports media type and date range filters.
    </p>

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
          <div class="di-control-group">
            <label class="di-label">Queue</label>
            <div id="diQueueDropdown"></div>
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

    <!-- Address filters (email only) -->
    <div class="di-controls di-email-filters" id="diEmailFilters" style="display:none">
      <div class="di-control-group">
        <label class="di-label">Sender Email</label>
        <div class="di-email-stack" id="diSenderStack"></div>
        <button class="btn btn-sm di-email-add" id="diSenderAdd" type="button">+ Add</button>
      </div>
      <div class="di-control-group">
        <label class="di-label">Recipient Email</label>
        <div class="di-email-stack" id="diRecipientStack"></div>
        <button class="btn btn-sm di-email-add" id="diRecipientAdd" type="button">+ Add</button>
      </div>
      <div class="di-email-note" id="diEmailNote" style="display:none">
        Address filters are set — only Email interactions will be matched.
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

    <!-- Preview results (ID modes only — queue mode reports counts in the status) -->
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
  const ssQueue = createSingleSelect({
    placeholder: "— Select queue —",
    searchable: true,
    onChange: () => invalidateCandidates(),
  });
  el.querySelector("#diQueueDropdown").append(ssQueue.el);
  ssQueue.setEnabled(false);
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

  // ── Candidate invalidation ─────────────────────────
  //
  // Preview caches its result in `candidates`, and Disconnect reuses that cache
  // rather than rescanning. Anything that changes what a scan would return has
  // to throw the cache away, or the operator edits a filter, presses Disconnect
  // and gets the set the *previous* filter produced. Every control that feeds
  // validateFilters() or the ID inputs is wired to this.
  // Disconnect is gated on a preview. Force-disconnect cannot be undone, so
  // the set being acted on has to have been seen first — the button is dead
  // until a preview produces candidates, and dies again the moment anything
  // that would change the result is touched.
  function syncActionButtons() {
    $previewBtn.disabled     = isRunning;
    $disconnectBtn.disabled  = isRunning || candidates.length === 0;
    $disconnectBtn.title     = $disconnectBtn.disabled && !isRunning
      ? "Run Preview first — Disconnect acts only on a previewed set"
      : "";
    $cancelBtn.style.display = isRunning ? "" : "none";
    ssQueue.setEnabled(!isRunning);
  }

  /** The only place `candidates` is assigned, so the buttons cannot drift. */
  function setCandidates(next) {
    candidates = next;
    syncActionButtons();
  }

  function invalidateCandidates() {
    if (!candidates.length || isRunning) return;
    setCandidates([]);
    renderResults([]);
    setStatus(STATUS.ready);
  }

  // ── Mode switching ──────────────────────────────────
  $modeRadios.forEach(r => r.addEventListener("change", () => {
    currentMode = r.value;
    $singleInput.style.display = currentMode === "single" ? "" : "none";
    $multiInput.style.display  = currentMode === "multiple" ? "" : "none";
    $queueInput.style.display  = currentMode === "queue" ? "" : "none";
    setCandidates([]);
    renderResults([]);
    setStatus(STATUS.ready);
  }));

  // ── Media type wiring ──────────────────────────────
  $mediaAll.addEventListener("change", () => {
    $mediaCbs.forEach(cb => { cb.checked = $mediaAll.checked; });
    invalidateCandidates();
    syncEmailFilterUi();
  });
  $mediaCbs.forEach(cb => {
    cb.addEventListener("change", () => {
      const allChecked  = [...$mediaCbs].every(c => c.checked);
      const noneChecked = [...$mediaCbs].every(c => !c.checked);
      $mediaAll.checked       = allChecked;
      $mediaAll.indeterminate = !allChecked && !noneChecked;
      invalidateCandidates();
      syncEmailFilterUi();
    });
  });

  // ── Address filters (email only) ───────────────────
  //
  // Each field is a stack of one-address rows rather than one comma-separated
  // box, so a single bad address can be marked where it was typed instead of
  // failing — or worse, being quietly dropped from — the whole field.
  const $emailFilters = el.querySelector("#diEmailFilters");
  const $emailNote    = el.querySelector("#diEmailNote");
  const STACKS = {
    sender:    { $stack: el.querySelector("#diSenderStack"),
                 $add:   el.querySelector("#diSenderAdd"),
                 placeholder: "sender@example.com" },
    recipient: { $stack: el.querySelector("#diRecipientStack"),
                 $add:   el.querySelector("#diRecipientAdd"),
                 placeholder: "support@yourorg.com" },
  };

  function addAddressRow(which, value = "", focus = false) {
    const { $stack, placeholder } = STACKS[which];
    const $row = document.createElement("div");
    $row.className = "di-email-row";
    $row.innerHTML = `
      <div class="di-email-line">
        <input type="text" class="input di-email-input" placeholder="${placeholder}">
        <button class="btn btn-sm di-email-remove" type="button" title="Remove">&times;</button>
      </div>
      <div class="di-email-error" style="display:none"></div>`;

    const $input = $row.querySelector(".di-email-input");
    const $error = $row.querySelector(".di-email-error");
    $input.value = value;

    const showError = (msg) => {
      $row.classList.toggle("is-invalid", !!msg);
      $error.textContent = msg || "";
      $error.style.display = msg ? "" : "none";
    };

    $input.addEventListener("input", () => {
      showError(null);            // stop shouting while they are still typing
      invalidateCandidates();
      syncEmailFilterUi();
    });
    $input.addEventListener("blur", () => showError(addressRowError($input.value)));

    $row.querySelector(".di-email-remove").addEventListener("click", () => {
      // The last row is emptied rather than removed: a field with no rows at
      // all offers nowhere to type.
      if ($stack.children.length > 1) $row.remove();
      else { $input.value = ""; showError(null); }
      invalidateCandidates();
      syncEmailFilterUi();
    });

    $stack.append($row);
    if (focus) $input.focus();
  }

  for (const which of Object.keys(STACKS)) {
    addAddressRow(which);
    STACKS[which].$add.addEventListener("click", () => addAddressRow(which, "", true));
  }

  /** Normalised, deduped, blank-free addresses from one stack. */
  function readAddresses(which) {
    const seen = new Set();
    for (const $input of STACKS[which].$stack.querySelectorAll(".di-email-input")) {
      const v = normaliseAddress($input.value);
      if (v) seen.add(v);
    }
    return [...seen];
  }

  /** True while the Email media type is ticked — the only time these apply. */
  function emailSelected() {
    return getSelectedMediaTypes().includes("email");
  }

  /** Any address typed into either stack, valid or not. */
  function hasAnyAddress() {
    return Object.keys(STACKS).some(which =>
      [...STACKS[which].$stack.querySelectorAll(".di-email-input")]
        .some($i => $i.value.trim() !== ""));
  }

  /**
   * Show the block only while Email is ticked, and say out loud that an address
   * narrows the run to email. Silently reinterpreting the media ticks would be
   * this feature's worst surprise, so the other types are struck through.
   */
  function syncEmailFilterUi() {
    const on = emailSelected();
    $emailFilters.style.display = on ? "" : "none";

    const narrowing = on && hasAnyAddress();
    $emailNote.style.display = narrowing ? "" : "none";
    for (const $cb of [$mediaAll, ...$mediaCbs]) {
      const isEmail = $cb.dataset.type === "email";
      $cb.closest(".di-checkbox")?.classList.toggle("di-media-muted", narrowing && !isEmail);
    }
  }

  // ── Date filter wiring ─────────────────────────────
  $olderEnable.addEventListener("change", () => {
    $olderDate.disabled = !$olderEnable.checked;
    invalidateCandidates();
  });
  $newerEnable.addEventListener("change", () => {
    $newerDate.disabled = !$newerEnable.checked;
    invalidateCandidates();
  });
  $olderDate.addEventListener("change", invalidateCandidates);
  $newerDate.addEventListener("change", invalidateCandidates);

  // ── ID input wiring ────────────────────────────────
  $convId.addEventListener("input", invalidateCandidates);
  $convIds.addEventListener("input", invalidateCandidates);

  // ── Status / progress helpers ──────────────────────
  const setStatus = makeStatus($status, "di-status");
  function showProgress(pct) {
    $progressWrap.style.display = "";
    $progressBar.style.width = `${Math.min(pct, 100)}%`;
  }
  function hideProgress() {
    $progressWrap.style.display = "none";
    $progressBar.style.width = "0%";
  }

  // ── Preview results ────────────────────────────────
  //
  // ID modes only. The operator typed the list, so the row count is bounded and
  // every ID can account for itself — which is the point: a filtered ID used to
  // vanish from the count with no reason given. Queue mode stays out of here;
  // its result set is unbounded, and rendering it per row is what made the
  // original table a performance problem (e382ca3). It reports counts by reason
  // in the status line instead.
  function renderResults(rows) {
    if (!rows.length) {
      $tableWrap.style.display = "none";
      $tbody.innerHTML = "";
      return;
    }
    $tableWrap.style.display = "";
    $tbody.innerHTML = rows.map((r, i) => {
      const statusClass = r.status === "Match" ? "di-ok"
        : r.status === "Failed" ? "di-fail"
        : r.status === "Filtered" ? "di-skip"
        : "";
      return `<tr>
        <td>${i + 1}</td>
        <td class="di-mono">${escapeHtml(r.convId)}</td>
        <td>${escapeHtml(r.mediaType || "")}</td>
        <td>${escapeHtml(r.startTime || "")}</td>
        <td class="${statusClass}">${escapeHtml(r.status)}</td>
        <td>${escapeHtml(r.error || "")}</td>
      </tr>`;
    }).join("");
  }

  function setButtonsRunning(running) {
    isRunning = running;
    syncActionButtons();
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
    let mediaTypes = getSelectedMediaTypes();
    if (!mediaTypes.length) { setStatus("Please select at least one media type.", "error"); return null; }

    // Addresses only exist for email, and only apply while Email is ticked.
    const on = mediaTypes.includes("email");
    const senders    = on ? readAddresses("sender")    : [];
    const recipients = on ? readAddresses("recipient") : [];

    if (on) {
      // A malformed row blocks the run. Ignoring it would widen the very thing
      // the operator was narrowing, on an action that cannot be undone.
      for (const which of Object.keys(STACKS)) {
        for (const $input of STACKS[which].$stack.querySelectorAll(".di-email-input")) {
          const err = addressRowError($input.value);
          if (err) {
            $input.closest(".di-email-row").classList.add("is-invalid");
            const label = which === "sender" ? "Sender Email" : "Recipient Email";
            setStatus(`${label}: ${err} (“${$input.value.trim()}”)`, "error");
            $input.focus();
            return null;
          }
        }
      }
    }

    // An address narrows the run to email whatever else is ticked — §2 of
    // docs/disconnect-email-filter-design.md. syncEmailFilterUi() has already
    // said so on screen; this is where it takes effect.
    if (senders.length || recipients.length) mediaTypes = ["email"];

    const olderThan = $olderEnable.checked ? $olderDate.value : null;
    const newerThan = $newerEnable.checked ? $newerDate.value : null;
    if ($olderEnable.checked && !olderThan) { setStatus("Please set the 'Older than' date.", "error"); return null; }
    if ($newerEnable.checked && !newerThan) { setStatus("Please set the 'Newer than' date.", "error"); return null; }

    return { mediaTypes, olderThan, newerThan, senders, recipients };
  }

  // ── Scan: queue mode ───────────────────────────────
  //
  // Analytics enumerates; queue observations supply context.
  //
  // Observations were tried as the source of candidates and could not do it:
  // the detail list caps at 100, cannot be paged, and its filter takes only
  // queueId and mediaType, so a large queue cannot be sliced into under-cap
  // chunks. A preview could only ever report matches within an arbitrary 100.
  // Analytics pages properly and takes the address predicates server-side, so a
  // filtered preview has Genesys return the matches rather than the queue.
  //
  // Two phases because analytics completeness varies with age: the sync query
  // for the last 48 hours, where the async job has not ingested yet, and async
  // jobs beyond it, where the sync query would 502 on volume (b52b0be).
  //
  // Both phases evaluate through one function. They used to carry separate
  // copies of the same filter chain, which is how they came to disagree about
  // unknown media types.
  //
  // See docs/disconnect-empty-queue-design.md.
  async function scanQueue(queueId, filters) {
    const orgId  = orgContext.get();
    const now    = new Date();
    const recentCutoff = new Date(now.getTime() - RECENT_LOOKBACK_HOURS * 3_600_000);
    const seen    = new Set();
    const matched = [];
    const skips   = new Map();
    const skip = (reason) => { skips.set(reason, (skips.get(reason) || 0) + 1); };
    const probe = { total: 0, byMedia: {}, withAgent: 0, acdSegmentHadNoQueueId: 0 };  // TEMPORARY

    // Read first: `interacting` decides whether the live-agent guard applies at
    // all. Failure is not fatal — nulls fall through to "assume nothing live",
    // which is how the page behaved before this existed.
    setStatus("Reading queue state…");
    const { waiting, interacting, oldestMs } = await gc
      .getQueueStats(api, orgId, queueId, filters.mediaTypes)
      .catch((err) => {
        console.warn("Could not read queue observations:", err.message);
        return { waiting: null, interacting: null, oldestMs: null };
      });

    // Only guard when the queue says something is actually live. An orphan's
    // segments are often left unclosed for the same reason conversationEnd was
    // never written, so a blanket guard skips exactly the interactions this page
    // exists for — which is why 549dbc3 removed it. With nothing live, an
    // unclosed interact segment is stale and safe to disconnect.
    const guardLiveAgents = (interacting || 0) > 0;

    /** One analytics conversation's verdict; pushes to matched or tallies a skip. */
    function evaluate(c) {
      if (seen.has(c.conversationId)) return;
      seen.add(c.conversationId);

      if (c.conversationEnd) { skip("already ended"); return; }

      // Not a skip — the population, silently. Empty Queue means what the queue
      // is holding, so a conversation that never ended but is no longer queued
      // was never a candidate. Counting it as an exclusion would imply it was in
      // scope and got filtered out, which is a different claim and a wrong one.
      // If nothing is waiting, nothing is waiting.
      if (!isWaitingInQueue(c, queueId)) return;

      if (guardLiveAgents && hasAgentEngaged(c)) {
        skip("excluded, agent connected"); return;
      }

      const addr = matchesAddressFilters(collectSessionAddresses(c), filters);
      if (!addr.pass) { skip(addr.reason); return; }

      const mediaType = getSessionMediaType(c) || "unknown";
      if (mediaType !== "unknown" && !filters.mediaTypes.includes(mediaType)) {
        skip("media type not selected"); return;
      }

      const st = c.conversationStart ? new Date(c.conversationStart) : null;
      if (filters.olderThan && st && st >= new Date(filters.olderThan + "T00:00:00Z")) {
        skip("outside date range"); return;
      }
      if (filters.newerThan && st && st <= new Date(filters.newerThan + "T23:59:59Z")) {
        skip("outside date range"); return;
      }

      // TEMPORARY (2026-08-21): 173 matched against a depth of 169. Tally the
      // three things that could put a conversation in the matched set without
      // the queue counting it as waiting, rather than guessing which. Remove
      // once the four are accounted for.
      probe.total++;
      probe.byMedia[mediaType] = (probe.byMedia[mediaType] || 0) + 1;
      if (hasAgentEngaged(c)) probe.withAgent++;
      if (!acdSegmentNamesQueue(c, queueId)) probe.acdSegmentHadNoQueueId++;

      matched.push({
        convId:    c.conversationId,
        mediaType,
        startTime: formatDateTime(c.conversationStart),
      });
    }

    const recentIntervals = [];
    for (let endMs = now.getTime(); endMs > recentCutoff.getTime(); endMs -= RECENT_BUCKET_HOURS * 3_600_000) {
      const end = new Date(endMs);
      const start = new Date(Math.max(recentCutoff.getTime(), endMs - RECENT_BUCKET_HOURS * 3_600_000));
      recentIntervals.push({ start, end });
    }

    const totalIntervals = recentIntervals.length + SCAN_INTERVALS;
    let intervalNo = 0;

    const queueAndAddressFilters = [
      { type: "and", predicates: [{ dimension: "queueId", value: queueId }] },
      ...addressSegmentFilters(filters),
    ];
    const unendedOnly = [{
      type: "and",
      predicates: [{ dimension: "conversationEnd", operator: "notExists" }],
    }];

    // Phase 1 — the last 48 hours, synchronously.
    //
    // No getConversation per row. It used to fetch each conversation purely to
    // read a media type that the analytics sessions already carry, alongside
    // both addresses: 3,000 rows meant 3,000 round-trips for data already in
    // hand. The historical phase dropped them in b52b0be; this one never did.
    for (const r of recentIntervals) {
      if (cancelled) break;

      intervalNo++;
      setStatus(`[Recent] ${STATUS.scanning(intervalNo, totalIntervals)}`);
      showProgress(((intervalNo - 1) / totalIntervals) * 100);

      try {
        const convs = await gc.queryConversationDetails(api, orgId, {
          interval: `${r.start.toISOString()}/${r.end.toISOString()}`,
          order: "desc",
          orderBy: "conversationStart",
          segmentFilters: queueAndAddressFilters,
          conversationFilters: unendedOnly,
        }, {
          maxPages: 200,
          onProgress: (n) => {
            const within = Math.min(n / 500, 1);
            showProgress((((intervalNo - 1) + within) / totalIntervals) * 100);
          },
        });
        for (const c of convs) {
          if (cancelled) break;
          evaluate(c);
        }
      } catch (err) {
        console.warn(`Recent interval ${intervalNo} scan failed — skipping:`, err.message);
      }
    }

    // Phase 2 — the six months before that, as async jobs.
    for (let i = 0; i < SCAN_INTERVALS; i++) {
      if (cancelled) break;

      const end   = new Date(recentCutoff.getTime() - i * INTERVAL_DAYS * 86_400_000);
      const start = new Date(end.getTime() - INTERVAL_DAYS * 86_400_000);
      intervalNo++;

      try {
        const convs = await gc.searchConversations(api, orgId, {
          interval: `${start.toISOString()}/${end.toISOString()}`,
          jobBody: {
            order: "desc",
            orderBy: "conversationStart",
            segmentFilters: queueAndAddressFilters,
            conversationFilters: unendedOnly,
          },
          onStatus: (msg) =>
            setStatus(`[Historical] Interval ${intervalNo} of ${totalIntervals}: ${msg}`),
          onProgress: (pct) =>
            showProgress((((intervalNo - 1) + pct / 100) / totalIntervals) * 100),
        });
        for (const c of convs) {
          if (cancelled) break;
          evaluate(c);
        }
      } catch (err) {
        console.warn(`Interval ${intervalNo} scan failed — skipping:`, err.message);
      }
    }

    console.log("[match-probe]", JSON.stringify(probe));   // TEMPORARY

    return { matched, waiting, interacting, oldestMs, skips };
  }

  // ── Scan: single / multiple IDs ────────────────────
  //
  // Returns one row per ID, in the order they were entered, each carrying its
  // own verdict. Callers take the matches with `rowsToCandidates`; the rest are
  // rendered so a filtered or failed ID says why rather than silently thinning
  // the count.
  //
  // Eligibility is the same rule queue mode uses: a conversation with no
  // endTime written is disconnectable. It used to be stricter here — an ACD
  // participant had to be connected or alerting — which refused exactly the
  // orphans whose ACD segment Genesys had already closed, the interactions this
  // page exists for. The same conversation was found by queue mode and turned
  // away by ID mode.
  //
  // The consequence is the one queue mode already carries: a conversation an
  // agent is actively handling is eligible too. The preview table and the
  // confirm dialog are the guard.
  async function scanIds(convIds, filters) {
    const orgId = orgContext.get();
    const rows  = [];

    // One ID's verdict, self-contained and never rejecting, so a batch can be
    // run through Promise.all without one bad ID taking the others with it.
    async function inspectId(convId) {
      try {
        const conv = await gc.getConversation(api, orgId, convId);
        // findAcdParticipant is kept for the media type it reports on a live
        // ACD leg; detectMediaType covers the orphans, where that leg is gone.
        const acd = findAcdParticipant(conv);
        const mediaType = acd ? acd.mediaType : detectMediaType(conv.participants);

        const row = {
          convId,
          mediaType,
          startTime: formatDateTime(conv.startTime),
        };

        const filtered = (reason) => ({ ...row, status: "Filtered", error: reason });

        if (conv.endTime) return filtered("Already ended");
        if (!filters.mediaTypes.includes(mediaType)) {
          return filtered(`Media type "${mediaType}" not selected`);
        }
        const st = conv.startTime ? new Date(conv.startTime) : null;
        if (filters.olderThan && st && st >= new Date(filters.olderThan + "T00:00:00Z")) {
          return filtered("Started after 'Older than' date");
        }
        if (filters.newerThan && st && st <= new Date(filters.newerThan + "T23:59:59Z")) {
          return filtered("Started before 'Newer than' date");
        }

        // Address filters need the analytics shape, which the live conversation
        // object does not have. Ordered last so the extra call is only made for
        // an ID that has already survived everything cheaper.
        if (filters.senders.length || filters.recipients.length) {
          let analytics;
          try {
            analytics = await gc.getConversationAnalytics(api, orgId, convId);
          } catch (err) {
            const msg = err.message || "";
            return filtered(
              msg.includes("403") ? "Needs the analytics permission to read sender/recipient"
              : msg.includes("404") ? "Sender/recipient not yet available in analytics"
              : `Could not read sender/recipient — ${friendlyError(err)}`);
          }
          const addr = matchesAddressFilters(collectSessionAddresses(analytics), filters);
          if (!addr.pass) return filtered(addr.reason);
        }

        return { ...row, status: "Match", error: "" };
      } catch (err) {
        return {
          convId,
          mediaType: "—",
          startTime: "—",
          status: "Failed",
          error: friendlyError(err),
        };
      }
    }

    // Batched rather than one at a time: 3,000 IDs inspected serially is 3,000
    // round-trips end to end. Batches are awaited in order and their results
    // appended in order, so the table still reads in the order they were typed.
    for (let i = 0; i < convIds.length && !cancelled; i += REQUEST_BATCH) {
      const chunk = convIds.slice(i, i + REQUEST_BATCH);

      setStatus(STATUS.inspecting(i + 1, convIds.length));
      showProgress((i / convIds.length) * 90);

      rows.push(...await Promise.all(chunk.map(inspectId)));

      if (i + REQUEST_BATCH < convIds.length) await sleep(50);
    }

    return rows;
  }

  /** The rows a disconnect run would act on, stripped of their preview verdict. */
  function rowsToCandidates(rows) {
    return rows.filter(r => r.status === "Match")
               .map(({ convId, mediaType, startTime }) => ({ convId, mediaType, startTime }));
  }

  // ── Preview button ─────────────────────────────────
  $previewBtn.addEventListener("click", async () => {
    const filters = validateFilters();
    if (!filters) return;

    cancelled = false;
    setButtonsRunning(true);
    setCandidates([]);
    renderResults([]);
    let summary = null;

    try {
      if (currentMode === "queue") {
        const queueId = ssQueue.getValue();
        if (!queueId) { setStatus("Please select a queue.", "error"); setButtonsRunning(false); return; }

        const { matched, waiting, interacting, oldestMs, skips } =
          await scanQueue(queueId, filters);
        setCandidates(matched);
        summary = STATUS.previewedQueue(
          matched.length, waiting, interacting, oldestMs, skips);
      } else {
        const ids = parseConvIds();
        if (!ids.length) {
          setStatus("Please enter at least one conversation ID.", "error");
          setButtonsRunning(false);
          return;
        }

        const rows = await scanIds(ids, filters);
        setCandidates(rowsToCandidates(rows));
        renderResults(rows);
        summary = STATUS.previewedIds(candidates.length, rows.length);
      }

      if (cancelled) {
        setStatus("Preview cancelled.");
      } else {
        // Always the summary, match or no match: the reason breakdown is the
        // whole point when nothing matched.
        setStatus(summary, candidates.length ? "success" : "");
      }
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
    // Unreachable without a preview: the button is disabled until one produces
    // candidates (syncActionButtons), and re-disabled by any change that would
    // alter the result. The scan-on-demand branch that used to live here is
    // gone with it — Disconnect no longer has a path that acts on a set the
    // operator has not seen.
    if (!candidates.length || isRunning) return;

    const filters = validateFilters();
    if (!filters) return;

    // Confirmation dialog
    const count = candidates.length;
    let target = `${count} conversation${count !== 1 ? "s" : ""}`;
    if (currentMode === "queue") {
      const qName = queues.find(q => q.id === ssQueue.getValue())?.name || "";
      target += ` in queue "${qName}"`;
    }

    const filterNote = describeAddressFilters(filters);

    const ok = confirm(
      `You are about to force-disconnect ${target}.\n\n`
      + (filterNote ? `Matching ${filterNote}.\n\n` : "")
      + "This will:\n"
      + "  • Disconnect all media\n"
      + "  • Apply system wrap-up codes\n"
      + "  • Force conversation termination\n\n"
      + "This action cannot be undone. Continue?"
    );
    if (!ok) { setButtonsRunning(false); hideProgress(); return; }

    // Execute disconnects. Deliberately summary-only — rendering per-row
    // outcomes across an unbounded queue set is what e382ca3 removed. The
    // preview table's verdicts are about to go stale, so it is taken down.
    cancelled = false;
    setButtonsRunning(true);
    renderResults([]);
    const orgId = orgContext.get();

    let okCount   = 0;
    let failCount = 0;
    for (let i = 0; i < candidates.length && !cancelled; i += REQUEST_BATCH) {
      const chunk = candidates.slice(i, i + REQUEST_BATCH);

      setStatus(STATUS.disconnecting(i + 1, candidates.length));
      showProgress((i / candidates.length) * 100);

      const settled = await Promise.allSettled(
        chunk.map(c => gc.disconnectConversation(api, orgId, c.convId))
      );

      for (const r of settled) {
        if (r.status === "fulfilled") okCount++;
        else failCount++;
      }

      if (i + REQUEST_BATCH < candidates.length) await sleep(50);
    }

    showProgress(100);

    if (cancelled) {
      const rem = candidates.length - okCount - failCount;
      setStatus(`Cancelled. Disconnected: ${okCount}, Failed: ${failCount}, Remaining: ${rem}.`);
    } else {
      setStatus(STATUS.done(okCount, failCount, 0), failCount > 0 ? "error" : "success");
    }

    logAction({
      me,
      orgId:       orgContext.get() || "",
      action:      "interaction_disconnect",
      description: `Disconnected ${okCount} interaction${okCount !== 1 ? "s" : ""}${
        filterNote ? ` matching ${filterNote}` : ""}${failCount ? ` (${failCount} failed)` : ""}${
        cancelled ? " [cancelled]" : ""}`,
      result:      okCount === 0 && failCount > 0 ? "failure" : failCount > 0 || cancelled ? "partial" : "success",
      count:       okCount + failCount,
    });

    setTimeout(hideProgress, 800);
    setButtonsRunning(false);
    // After the setter, not before: setButtonsRunning re-enables Disconnect
    // against the set it just acted on. Clearing it through setCandidates is
    // what takes the button back down, so a second run needs a fresh preview.
    setCandidates([]);
  });

  // ── Cancel / Clear ─────────────────────────────────
  $cancelBtn.addEventListener("click", () => { cancelled = true; });

  $clearBtn.addEventListener("click", () => {
    setCandidates([]);
    renderResults([]);
    hideProgress();
    setStatus(STATUS.ready);
  });

  // ── Initial paint ──────────────────────────────────
  syncEmailFilterUi();
  syncActionButtons();   // Disconnect starts dead — nothing has been previewed

  // ── Load queues on mount ───────────────────────────
  (async () => {
    try {
      queues = await gc.fetchAllQueues(api, orgContext.get());
      queues.sort((a, b) => a.name.localeCompare(b.name));
      ssQueue.setItems(queues.map(q => ({ id: q.id, label: q.name })));
      ssQueue.setEnabled(true);
      setStatus(STATUS.ready);
    } catch (err) {
      setStatus(`Error: Failed to load queues — ${err.message}`, "error");
      console.error("Queue load error:", err);
    }
  })();

  return el;
}
