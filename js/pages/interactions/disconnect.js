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

/** Number of 31-day intervals to scan backwards (≈ 6 months). */
const SCAN_INTERVALS = 6;
const INTERVAL_DAYS  = 31;
const RECENT_LOOKBACK_HOURS = 48;
const RECENT_BUCKET_HOURS   = 6;

const STATUS = {
  ready:          "Ready. Select a mode and provide input.",
  loading:        "Loading queues…",
  scanning:       (i, n) => `Scanning interval ${i} of ${n}…`,
  inspecting:     (i, n) => `Inspecting conversation ${i} of ${n}…`,
  disconnecting:  (i, n) => `Disconnecting ${i}–${Math.min(i + 9, n)} of ${n}…`,
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
  previewedQueue(match, waiting, skips) {
    if (!match && !waiting) return this.noResults;
    const parts = [`${match.toLocaleString()} match`];
    if (waiting != null) parts.push(`${waiting.toLocaleString()} waiting in queue`);
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
 * Check one analytics conversation against the address filters.
 * Returns { pass, reason } — `reason` is what the operator is shown.
 *
 * Several addresses in one field are OR'd, the two fields are AND'd, and an
 * empty field imposes nothing. An address that cannot be read is never treated
 * as a match: this filter only ever narrows, so a conversation the page cannot
 * account for stays out of the run.
 */
/**
 * TEMPORARY (2026-08-21): print every address field the analytics response
 * actually carries, for the first few conversations of a scan that has an
 * address filter set.
 *
 * A recipient filter on a queue whose interactions plainly show that address as
 * "To" in Genesys reports "recipient does not match" — so addressTo is
 * populated and holds something else. Remove once the right field is known.
 */
let addrProbeBudget = 0;
function probeAddresses(conv) {
  if (addrProbeBudget <= 0) return;
  addrProbeBudget--;
  const sessions = [];
  for (const p of (conv?.participants || [])) {
    for (const sess of (p.sessions || [])) {
      sessions.push({
        purpose:      p.purpose,
        mediaType:    sess.mediaType,
        direction:    sess.direction,
        addressFrom:  sess.addressFrom,
        addressTo:    sess.addressTo,
        addressSelf:  sess.addressSelf,
        addressOther: sess.addressOther,
        dnis:         sess.dnis,
        ani:          sess.ani,
      });
    }
  }
  console.log("[addr-probe]", conv?.conversationId, JSON.stringify(sessions, null, 2));
}

function matchesAddressFilters(conv, { senders, recipients }) {
  probeAddresses(conv);
  if (!senders.length && !recipients.length) return { pass: true, reason: null };

  const { from, to } = collectSessionAddresses(conv);

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
  function invalidateCandidates() {
    if (!candidates.length || isRunning) return;
    candidates = [];
    renderResults([]);
    setStatus(STATUS.ready);
  }

  // ── Mode switching ──────────────────────────────────
  $modeRadios.forEach(r => r.addEventListener("change", () => {
    currentMode = r.value;
    $singleInput.style.display = currentMode === "single" ? "" : "none";
    $multiInput.style.display  = currentMode === "multiple" ? "" : "none";
    $queueInput.style.display  = currentMode === "queue" ? "" : "none";
    candidates = [];
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
    $previewBtn.disabled    = running;
    $disconnectBtn.disabled = running;
    $cancelBtn.style.display = running ? "" : "none";
    ssQueue.setEnabled(!running);
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

  // ── Scan: queue mode (async analytics jobs) ────────
  //
  // Uses the async jobs API (/analytics/conversations/details/jobs) instead of
  // the synchronous query endpoint, which times out via the proxy at ~8000+
  // conversations. The async path has no per-request timeout constraint.
  //
  // Phase 2 (individual getConversation calls) is eliminated: the analytics
  // response already includes participant sessions and segments, which is
  // enough to determine waiting state without extra API calls.
  //
  // What this matches, stated plainly: every conversation in the queue whose
  // conversationEnd has not been written. The ACD segment is deliberately NOT
  // required to be open — Genesys closes it internally on dead/orphaned
  // interactions while never writing conversationEnd, and those are exactly
  // the ones this page exists to catch.
  //
  // There is no live-agent guard. A conversation an agent is currently handling
  // is matched like any other, and will be disconnected if the operator
  // confirms. The preview and the confirm dialog are the whole of the safety
  // model here. An earlier hasActiveAgentSegment() guard was removed (549dbc3)
  // because it also excluded the orphans above.
  //
  // Returns { matched, waiting, skips } — `skips` is a reason → count tally and
  // `waiting` is the live queue depth, so the status line can account for the
  // difference between what is in the queue and what matched.
  async function scanQueue(queueId, filters) {
    const orgId  = orgContext.get();
    const now    = new Date();
    const recentCutoff = new Date(now.getTime() - RECENT_LOOKBACK_HOURS * 3_600_000);
    const seen   = new Set();
    const matched = [];
    const skips  = new Map();
    const skip = (reason) => { skips.set(reason, (skips.get(reason) || 0) + 1); };
    addrProbeBudget = 3;   // TEMPORARY — see probeAddresses()

    // Started here and awaited at the end: it is one small request and has no
    // bearing on the scan, so it costs nothing to have it in flight throughout.
    // A failure resolves to null rather than rejecting — the queue depth is
    // context, and losing it must never fail a scan that otherwise worked.
    const waitingPromise = gc
      .getQueueWaitingCount(api, orgId, queueId, filters.mediaTypes)
      .catch((err) => {
        console.warn("Could not read queue waiting count:", err.message);
        return null;
      });

    // Phase 1: scan the most recent 48 hours with synchronous analytics +
    // conversation details. This avoids async analytics ingestion lag for
    // today's interactions.
    const recentIntervals = [];
    for (let endMs = now.getTime(); endMs > recentCutoff.getTime(); endMs -= RECENT_BUCKET_HOURS * 3_600_000) {
      const end = new Date(endMs);
      const start = new Date(Math.max(recentCutoff.getTime(), endMs - RECENT_BUCKET_HOURS * 3_600_000));
      recentIntervals.push({ start, end });
    }

    const totalIntervals = recentIntervals.length + SCAN_INTERVALS;
    let intervalNo = 0;

    for (const r of recentIntervals) {
      if (cancelled) break;

      intervalNo++;
      setStatus(`[Recent sync] ${STATUS.scanning(intervalNo, totalIntervals)}`);
      showProgress(((intervalNo - 1) / totalIntervals) * 100);

      const analyticsBody = {
        interval: `${r.start.toISOString()}/${r.end.toISOString()}`,
        order: "desc",
        orderBy: "conversationStart",
        segmentFilters: [
          { type: "and", predicates: [{ dimension: "queueId", value: queueId }] },
          ...addressSegmentFilters(filters),
        ],
        conversationFilters: [{
          type: "and",
          predicates: [{ dimension: "conversationEnd", operator: "notExists" }],
        }],
      };

      let convs = [];
      try {
        convs = await gc.queryConversationDetails(api, orgId, analyticsBody, {
          maxPages: 200,
          onProgress: (n) => {
            const within = Math.min(n / 500, 1);
            showProgress((((intervalNo - 1) + within) / totalIntervals) * 100);
          },
        });
      } catch (err) {
        console.warn(`Recent interval ${intervalNo} scan failed — skipping:`, err.message);
        continue;
      }

      for (const c of convs) {
        if (cancelled) break;
        if (seen.has(c.conversationId)) continue;
        seen.add(c.conversationId);
        if (c.conversationEnd) { skip("already ended"); continue; }

        // Before the per-conversation call, not after: the sync analytics
        // response already carries the sessions this needs, so an address
        // filter makes this path issue fewer requests, not more.
        const addr = matchesAddressFilters(c, filters);
        if (!addr.pass) { skip(addr.reason); continue; }

        try {
          const conv = await gc.getConversation(api, orgId, c.conversationId);
          const mediaType = detectMediaType(conv.participants);

          if (mediaType !== "unknown" && !filters.mediaTypes.includes(mediaType)) {
            skip("media type not selected"); continue;
          }

          const st = conv.startTime ? new Date(conv.startTime) : null;
          if (filters.olderThan && st && st >= new Date(filters.olderThan + "T00:00:00Z")) {
            skip("outside date range"); continue;
          }
          if (filters.newerThan && st && st <= new Date(filters.newerThan + "T23:59:59Z")) {
            skip("outside date range"); continue;
          }

          matched.push({
            convId:    c.conversationId,
            mediaType,
            startTime: formatDateTime(conv.startTime),
          });
        } catch (err) {
          skip("could not be inspected");
          console.warn(`Could not inspect recent conversation ${c.conversationId}:`, err.message);
        }
      }
    }

    for (let i = 0; i < SCAN_INTERVALS; i++) {
      if (cancelled) break;

      const end      = new Date(recentCutoff.getTime() - i * INTERVAL_DAYS * 86_400_000);
      const start    = new Date(end.getTime()  - INTERVAL_DAYS * 86_400_000);
      const interval = `${start.toISOString()}/${end.toISOString()}`;

      intervalNo++;

      const jobBody = {
        order: "desc",
        orderBy: "conversationStart",
        segmentFilters: [
          { type: "and", predicates: [{ dimension: "queueId", value: queueId }] },
          ...addressSegmentFilters(filters),
        ],
        conversationFilters: [{
          type: "and",
          predicates: [{ dimension: "conversationEnd", operator: "notExists" }],
        }],
      };

      let convs;
      try {
        convs = await gc.searchConversations(api, orgId, {
          interval,
          jobBody,
          onStatus: (msg) =>
            setStatus(`[Historical async] Interval ${intervalNo} of ${totalIntervals}: ${msg}`),
          onProgress: (pct) =>
            showProgress((((intervalNo - 1) + pct / 100) / totalIntervals) * 100),
        });
      } catch (err) {
        console.warn(`Interval ${intervalNo} scan failed — skipping:`, err.message);
        continue;
      }

      for (const c of convs) {
        if (cancelled) break;
        if (seen.has(c.conversationId)) continue;
        seen.add(c.conversationId);
        if (c.conversationEnd) { skip("already ended"); continue; }

        // Detect media type from sessions (analytics shape)
        const mediaType = getSessionMediaType(c) || "unknown";

        // Media type filter (pass through if type can't be determined)
        if (mediaType !== "unknown" && !filters.mediaTypes.includes(mediaType)) {
          skip("media type not selected"); continue;
        }

        // Date range filters
        const st = c.conversationStart ? new Date(c.conversationStart) : null;
        if (filters.olderThan && st && st >= new Date(filters.olderThan + "T00:00:00Z")) {
          skip("outside date range"); continue;
        }
        if (filters.newerThan && st && st <= new Date(filters.newerThan + "T23:59:59Z")) {
          skip("outside date range"); continue;
        }

        // Address filters (email only — an address narrows mediaTypes to email)
        const addr = matchesAddressFilters(c, filters);
        if (!addr.pass) { skip(addr.reason); continue; }

        matched.push({
          convId:    c.conversationId,
          mediaType,
          startTime: formatDateTime(c.conversationStart),
        });
      }
    }

    return { matched, waiting: await waitingPromise, skips };
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
    addrProbeBudget = 3;   // TEMPORARY — see probeAddresses()

    for (let i = 0; i < convIds.length; i++) {
      if (cancelled) break;

      setStatus(STATUS.inspecting(i + 1, convIds.length));
      showProgress((i / convIds.length) * 90);

      try {
        const conv = await gc.getConversation(api, orgId, convIds[i]);
        // findAcdParticipant is kept for the media type it reports on a live
        // ACD leg; detectMediaType covers the orphans, where that leg is gone.
        const acd = findAcdParticipant(conv);
        const mediaType = acd ? acd.mediaType : detectMediaType(conv.participants);

        const row = {
          convId: convIds[i],
          mediaType,
          startTime: formatDateTime(conv.startTime),
        };

        const filtered = (reason) => rows.push({ ...row, status: "Filtered", error: reason });

        if (conv.endTime) { filtered("Already ended"); continue; }
        if (!filters.mediaTypes.includes(mediaType)) {
          filtered(`Media type "${mediaType}" not selected`); continue;
        }
        const st = conv.startTime ? new Date(conv.startTime) : null;
        if (filters.olderThan && st && st >= new Date(filters.olderThan + "T00:00:00Z")) {
          filtered("Started after 'Older than' date"); continue;
        }
        if (filters.newerThan && st && st <= new Date(filters.newerThan + "T23:59:59Z")) {
          filtered("Started before 'Newer than' date"); continue;
        }

        // Address filters need the analytics shape, which the live conversation
        // object does not have. Ordered last so the extra call is only made for
        // an ID that has already survived everything cheaper.
        if (filters.senders.length || filters.recipients.length) {
          let analytics;
          try {
            analytics = await gc.getConversationAnalytics(api, orgId, convIds[i]);
          } catch (err) {
            const msg = err.message || "";
            filtered(
              msg.includes("403") ? "Needs the analytics permission to read sender/recipient"
              : msg.includes("404") ? "Sender/recipient not yet available in analytics"
              : `Could not read sender/recipient — ${friendlyError(err)}`);
            continue;
          }
          const addr = matchesAddressFilters(analytics, filters);
          if (!addr.pass) { filtered(addr.reason); continue; }
        }

        rows.push({ ...row, status: "Match", error: "" });
      } catch (err) {
        rows.push({
          convId: convIds[i],
          mediaType: "—",
          startTime: "—",
          status: "Failed",
          error: friendlyError(err),
        });
      }
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
    candidates = [];
    renderResults([]);
    let summary = null;

    try {
      if (currentMode === "queue") {
        const queueId = ssQueue.getValue();
        if (!queueId) { setStatus("Please select a queue.", "error"); setButtonsRunning(false); return; }

        const { matched, waiting, skips } = await scanQueue(queueId, filters);
        candidates = matched;
        summary = STATUS.previewedQueue(matched.length, waiting, skips);
      } else {
        const ids = parseConvIds();
        if (!ids.length) {
          setStatus("Please enter at least one conversation ID.", "error");
          setButtonsRunning(false);
          return;
        }

        const rows = await scanIds(ids, filters);
        candidates = rowsToCandidates(rows);
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
    const filters = validateFilters();
    if (!filters) return;

    // If no candidates yet, scan first
    let summary = null;
    if (!candidates.length) {
      cancelled = false;
      setButtonsRunning(true);

      try {
        if (currentMode === "queue") {
          const queueId = ssQueue.getValue();
          if (!queueId) { setStatus("Please select a queue.", "error"); setButtonsRunning(false); return; }
          const { matched, waiting, skips } = await scanQueue(queueId, filters);
          candidates = matched;
          summary = STATUS.previewedQueue(matched.length, waiting, skips);
        } else {
          const ids = parseConvIds();
          if (!ids.length) {
            setStatus("Please enter at least one conversation ID.", "error");
            setButtonsRunning(false);
            return;
          }
          const rows = await scanIds(ids, filters);
          candidates = rowsToCandidates(rows);
          renderResults(rows);
          summary = STATUS.previewedIds(candidates.length, rows.length);
        }

        if (!candidates.length) {
          setStatus(summary);
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
      const qName = queues.find(q => q.id === ssQueue.getValue())?.name || "";
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

    // Execute disconnects. Deliberately summary-only — rendering per-row
    // outcomes across an unbounded queue set is what e382ca3 removed. The
    // preview table's verdicts are about to go stale, so it is taken down.
    cancelled = false;
    setButtonsRunning(true);
    renderResults([]);
    const orgId = orgContext.get();

    let okCount   = 0;
    let failCount = 0;
    const BATCH   = 10; // concurrent requests per batch

    for (let i = 0; i < candidates.length && !cancelled; i += BATCH) {
      const chunk = candidates.slice(i, i + BATCH);

      setStatus(STATUS.disconnecting(i + 1, candidates.length));
      showProgress((i / candidates.length) * 100);

      const settled = await Promise.allSettled(
        chunk.map(c => gc.disconnectConversation(api, orgId, c.convId))
      );

      for (const r of settled) {
        if (r.status === "fulfilled") okCount++;
        else failCount++;
      }

      if (i + BATCH < candidates.length) await sleep(50);
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
      description: `Disconnected ${okCount} interaction${okCount !== 1 ? "s" : ""}${failCount ? ` (${failCount} failed)` : ""}${
        cancelled ? " [cancelled]" : ""}`,
      result:      okCount === 0 && failCount > 0 ? "failure" : failCount > 0 || cancelled ? "partial" : "success",
      count:       okCount + failCount,
    });

    setTimeout(hideProgress, 800);
    setButtonsRunning(false);
    candidates = [];
  });

  // ── Cancel / Clear ─────────────────────────────────
  $cancelBtn.addEventListener("click", () => { cancelled = true; });

  $clearBtn.addEventListener("click", () => {
    candidates = [];
    renderResults([]);
    hideProgress();
    setStatus(STATUS.ready);
  });

  // ── Initial paint ──────────────────────────────────
  syncEmailFilterUi();

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
