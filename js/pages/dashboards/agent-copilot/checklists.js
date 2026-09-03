/**
 * Dashboards › Agent Copilot › Checklists & Summaries
 *
 * See docs/dashboards-agent-copilot-design.md.
 *
 * The interactions that ran with an Agent Copilot checklist, whether that
 * checklist was finished, and what the AI wrote afterwards.
 *
 * TWO TICKS, NOT ONE. Every checklist item carries `stateFromAgent` AND
 * `stateFromModel`, and the difference between them is the point of the page:
 * an item the model ticked and the agent never touched counts as complete, but
 * says something quite different about whether the agent was engaged. The
 * "Agent checked" toggle exists to separate those two populations.
 *
 * COMPLETION CAN BE UNDETERMINED. A checklist carrying no items is not a failed
 * checklist. `completion` is null in that case and the row belongs to neither
 * bar — folding it into "incomplete" would invent a failure.
 *
 * NOTHING LOADS ON ARRIVAL beyond the copilot list. This walks conversation
 * rows and then makes three to four more calls per row, so the count is
 * fetched first, the cost is stated, and the walk starts only when asked for.
 *
 * Ported from genesys-copilot-app, whose orchestration lived in a BFF. Here it
 * runs in the browser through the shared proxy, like every other page.
 *
 * Read-only, so no Activity Log entry.
 */

import {
  fetchCopilotAssistants, fetchAssistantQueues, fetchQueueMembers,
  fetchAgentChecklists, fetchConversationSummaries,
  fetchConversationRecordings, fetchConversationRecording,
  getConversation, fetchAllQueues, fetchAllWrapupCodes,
  fetchUsersByIds, fetchWrapupCodesByIds,
  countConversationDetails, queryConversationDetails,
} from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import {
  RANGE_PRESETS, resolvePreset, latestSelectableDay, utcIso, yesterday,
  formatRange, dayCount,
} from "../../../utils/dateRanges.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";
import {
  makeStatus, escapeHtml, downloadWorkbook, timestampedFilename,
} from "../../../utils.js";
import { buildStyledWorkbook, addStyledSheet } from "../../../utils/excelStyles.js";

/**
 * Media-specific keys under which communications hang off a participant.
 *
 * There is no generic key: a participant's calls live under `calls`, its chats
 * under `chats`, and so on. Missing one loses that channel's checklists
 * entirely and silently.
 */
const MEDIA_KEYS = [
  "calls", "chats", "messages", "emails", "callbacks",
  "socialExpressions", "videos", "cobrowsesessions", "screenshares",
  "internalMessages",
];

const PURPOSE_AGENT = "agent";
const TICKED = "Ticked";

/** How many pages of 100 conversations to walk before stopping and saying so. */
const MAX_PAGES = 40;

/**
 * How many conversations to enrich in one run, and how many at once.
 *
 * Enrichment is 3-4 calls per conversation and cannot be aggregated - there is
 * no checklist metric anywhere in the API - so this is the real limit on the
 * page. Past the cap the remaining rows say "not loaded" rather than being
 * quietly presented as having no checklist.
 */
const MAX_ENRICH = 400;
const ENRICH_CONCURRENCY = 5;

/**
 * The interval cap Genesys enforces on a FILTERED conversation-detail query.
 *
 * Measured, not inherited: unfiltered the same endpoint allows only 7 days, and
 * it rewrites the number in its own error message to match. This page always
 * filters by copilot, so 31 is the number that binds. api-reference.md §2.1.
 */
const MAX_INTERVAL_DAYS = 31;

/** Rows drawn at once. Past this the table stops being readable anyway. */
const MAX_TABLE_ROWS = 500;

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "complete", label: "Complete" },
  { key: "incomplete", label: "Incomplete" },
  { key: "summaries", label: "Has summary" },
];

/* ── Pure helpers ──────────────────────────────────────── */

/**
 * Completion across ALL checklists on a conversation.
 *
 * Complete only when every item in every checklist is ticked, by agent or by
 * model. Returns null when there is nothing to judge — no checklists, or
 * checklists carrying no items — which callers must keep separate from
 * "incomplete".
 */
export function checklistCompletion(checklists) {
  const items = (checklists || []).flatMap((cl) => cl?.checklistItems || []);
  if (!items.length) return null;
  return items.every(
    (it) => it.stateFromAgent === TICKED || it.stateFromModel === TICKED)
    ? "complete" : "incomplete";
}

/**
 * Flatten the summaries response into an array.
 *
 * The response is `{summary, sessionSummaries}`, and for a single-session
 * conversation those two ARE the same record. De-duplicate on id; fall back to
 * "the session copies already cover it" only when there is no id to compare.
 */
export function parseSummaries(res) {
  if (!res || typeof res !== "object") return [];
  const out = [];
  if (Array.isArray(res.sessionSummaries)) out.push(...res.sessionSummaries.filter(Boolean));

  const top = res.summary;
  if (top && typeof top === "object" && Object.keys(top).length) {
    const present = top.id ? out.some((s) => s.id === top.id) : out.length > 0;
    if (!present) out.unshift(top);
  }
  return out;
}

/** True when any item on any checklist was ticked by the agent personally. */
function agentTickedAny(checklists) {
  return (checklists || []).some(
    (cl) => (cl?.checklistItems || []).some((it) => it.stateFromAgent === TICKED));
}

/** Seconds → "3m 07s", or an em dash when there is nothing to show. */
function fmtDuration(ms) {
  if (!ms) return "—";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

/** The text of a summary field, which may be a string or a wrapped object. */
function fieldText(v) {
  if (typeof v === "string") return v;
  return v?.text ?? v?.value ?? null;
}

export default function renderAgentCopilotChecklists({ me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h1 class="h1">Dashboards — Agent Copilot — Checklists &amp; Summaries</h1>
    <hr class="hr">

    <p class="page-desc">
      The interactions that ran with an Agent Copilot checklist, whether it was
      completed, and the AI summary written afterwards. Items are ticked either
      by the agent or by the model, and the two are shown apart — a checklist
      the model finished on its own is complete, but tells you the agent never
      touched it.
    </p>

    <div class="dq-filter-band">
      <span class="dq-filter-caption">WHEN</span>
      <div class="dq-filter-fields">
        <div class="cs-control-group">
          <label class="cs-label">From</label>
          <input class="input is-date" type="date" data-c="from">
        </div>
        <div class="cs-control-group">
          <label class="cs-label">To</label>
          <input class="input is-date" type="date" data-c="to">
        </div>
        <div class="cs-control-group">
          <label class="cs-label">Quick ranges</label>
          <div class="dq-presets" data-c="presets"></div>
        </div>
      </div>
    </div>

    <div class="dq-filter-band">
      <span class="dq-filter-caption">WHERE</span>
      <div class="dq-filter-fields">
        <div class="cs-control-group">
          <label class="cs-label">Copilots</label>
          <div data-c="copilotPicker"></div>
        </div>
        <div class="cs-control-group">
          <label class="cs-label">Queues (optional)</label>
          <div data-c="queuePicker"></div>
          <div class="is-hint" data-c="queueHint"></div>
        </div>
        <div class="cs-control-group">
          <label class="cs-label">Agents (optional)</label>
          <div data-c="agentPicker"></div>
        </div>
      </div>
    </div>

    <div class="cs-actions">
      <button class="btn" data-c="count">Count interactions</button>
      <button class="btn btn-primary" data-c="load" disabled>Load checklists</button>
      <button class="btn" data-c="export" hidden>Export to Excel</button>
    </div>

    <div class="cs-status" data-c="status" style="display:none"></div>

    <div data-c="results" hidden>
      <div class="dq-range-line" data-c="rangeLine"></div>
      <div class="dq-tiles" data-c="tiles"></div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Checklist completion</h3>
        <p class="dq-panel-sub">
          Counted from the rows currently shown. A checklist with no items is
          neither complete nor incomplete and is left out of both bars.
        </p>
        <div class="dq-bars" data-c="bars"></div>
      </div>

      <div class="dq-panel">
        <button type="button" class="ac-results-toggle" data-c="resultsToggle"
                aria-expanded="true">
          <span class="ac-chevron" data-c="resultsChevron">▼</span>
          <span class="dq-panel-title">Search results</span>
        </button>
        <div class="cs-control-group">
          <label class="cs-label">Show</label>
          <div class="dq-presets" data-c="statusFilters"></div>
        </div>
        <div class="is-hint">
          Tip: Right-click a row to copy the Conversation ID. Click a row to open
          its checklists, summary and recording.
        </div>
        <div data-c="tableArea">
          <div class="dq-table-wrap has-filters" data-c="rowsWrap">
            <table class="dq-table" data-c="rows"></table>
          </div>
          <div class="dq-panel-note" data-c="tableNote" hidden></div>
        </div>
      </div>

      <div class="dq-panel" data-c="detailPanel" hidden></div>
    </div>
  `;

  const $ = (n) => el.querySelector(`[data-c="${n}"]`);
  const $status = $("status");
  const $results = $("results");

  const applyStatus = makeStatus($status, "cs-status");
  function setStatus(msg, type = "") {
    applyStatus(msg, type);
    $status.style.display = "";
  }
  function hideStatus() { $status.style.display = "none"; }

  const currentOrg = () => orgContext?.getDetails?.() || null;

  // ── State ───────────────────────────────────────────
  let assistantName = new Map();   // assistantId → name
  let queueName = new Map();       // queueId → name
  let userName = new Map();        // userId → name
  let wrapUpName = new Map();      // wrapUpCode id → name
  let queuesOfCopilot = new Map(); // assistantId → Set<queueId>

  let rows = [];                   // one per interaction, in display order
  let enriched = new Map();        // conversationId → {checklists, summaries, completion, _error}
  let counted = null;              // totalHits from the count step
  let truncated = false;
  let statusFilter = "all";
  let agentCheckedOnly = false;
  let detachFilters = null;
  let openRowId = null;            // the interaction whose detail is showing
  let abort = null;                // aborts an in-flight load/enrichment

  /** Bumped by every new load, so a stale run cannot write into fresh state. */
  let runSeq = 0;

  // ── Filters ─────────────────────────────────────────
  $("from").value = yesterday();
  $("to").value = yesterday();
  $("from").max = latestSelectableDay();
  $("to").max = latestSelectableDay();

  // Short presets only. This walks conversation rows and then enriches each
  // one, so a long range is a walk nobody should start by accident — the API
  // would allow 31 days (§api-reference 2.1), the cost will not.
  for (const preset of RANGE_PRESETS.filter(
    (x) => ["today", "yesterday", "thisWeek", "lastWeek"].includes(x.key))) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm dq-preset";
    btn.textContent = preset.label;
    btn.addEventListener("click", () => {
      const r = resolvePreset(preset.key);
      if (!r) return;
      $("from").value = r.from;
      $("to").value = r.to;
      for (const b of $("presets").children) b.classList.toggle("is-active", b === btn);
      invalidate();
    });
    $("presets").append(btn);
  }

  const copilotPicker = createMultiSelect({
    placeholder: "Loading copilots…",
    searchable: true,
    onChange: (ids) => { invalidate(); cascadeQueues(ids); },
  });
  $("copilotPicker").append(copilotPicker.el);
  copilotPicker.setEnabled(false);

  const queuePicker = createMultiSelect({
    placeholder: "All queues for these copilots",
    searchable: true,
    onChange: (ids) => { invalidate(); cascadeAgents(ids); },
  });
  $("queuePicker").append(queuePicker.el);
  queuePicker.setEnabled(false);

  const agentPicker = createMultiSelect({
    placeholder: "All agents",
    searchable: true,
    onChange: invalidate,
  });
  $("agentPicker").append(agentPicker.el);
  agentPicker.setEnabled(false);

  $("from").addEventListener("change", invalidate);
  $("to").addEventListener("change", invalidate);

  /** Any filter change invalidates the count, because it counted the old scope. */
  function invalidate() {
    counted = null;
    $("load").disabled = true;
    $results.hidden = true;
    $("export").hidden = true;
  }

  // ── Stage 1: the copilot list, and nothing else ─────
  (async () => {
    const org = currentOrg();
    if (!org) { setStatus("Select a customer organisation first.", "error"); return; }

    setStatus("Loading copilots…");
    try {
      const assistants = await fetchCopilotAssistants(api, org.id);
      if (!assistants.length) {
        copilotPicker.setPlaceholder("No copilot-enabled assistants");
        setStatus(
          "No assistants in this organisation have Agent Copilot switched on. "
          + "An assistant counts when copilot is enabled or live on a queue.", "error");
        return;
      }
      assistantName = new Map(assistants.map((a) => [a.id, a.name || a.id]));
      copilotPicker.setItems(assistants.map((a) => ({ id: a.id, label: a.name || a.id })));
      copilotPicker.setPlaceholder("Select copilots…");
      copilotPicker.setEnabled(true);
      hideStatus();
    } catch (e) {
      setStatus(
        `Could not load copilots: ${e.message}. `
        + "This needs assistants:assistant:view.", "error");
    }
  })();

  /**
   * Queues covered by the selected copilots.
   *
   * Best-effort: without assistants:queue:view there is no cascade, but the
   * search still works, because agentAssistantId is a segment dimension and
   * the copilot alone is a complete filter. Losing the cascade costs the
   * narrowing controls, not the page.
   */
  async function cascadeQueues(copilotIds) {
    const org = currentOrg();
    if (!org || !copilotIds.size) {
      queuePicker.setItems([]);
      queuePicker.setEnabled(false);
      agentPicker.setItems([]);
      agentPicker.setEnabled(false);
      $("queueHint").textContent = "";
      return;
    }

    queuePicker.setEnabled(false);
    queuePicker.setPlaceholder("Loading queues…");
    try {
      if (!queueName.size) {
        for (const q of await fetchAllQueues(api, org.id)) queueName.set(q.id, q.name || q.id);
      }
      const ids = new Set();
      for (const cid of copilotIds) {
        if (!queuesOfCopilot.has(cid)) {
          const qs = await fetchAssistantQueues(api, org.id, cid);
          queuesOfCopilot.set(cid, new Set(qs.map((q) => q.id).filter(Boolean)));
        }
        for (const qid of queuesOfCopilot.get(cid)) ids.add(qid);
      }
      queuePicker.setItems([...ids].map((id) => ({ id, label: queueName.get(id) || id })));
      queuePicker.setPlaceholder("All queues for these copilots");
      queuePicker.setEnabled(ids.size > 0);
      $("queueHint").textContent = ids.size
        ? `${ids.size} queue(s) covered — leave empty to include them all.`
        : "These copilots cover no queues. The search still works: the copilot "
          + "itself is the filter.";
    } catch (e) {
      queuePicker.setPlaceholder("Queues unavailable");
      $("queueHint").textContent =
        `Could not read queue assignments (${e.message}). Needs assistants:queue:view. `
        + "Searching by copilot alone still works.";
    }
  }

  /** Agents who are members of the selected queues. */
  async function cascadeAgents(queueIds) {
    const org = currentOrg();
    if (!org || !queueIds.size) {
      agentPicker.setItems([]);
      agentPicker.setEnabled(false);
      return;
    }
    agentPicker.setEnabled(false);
    agentPicker.setPlaceholder("Loading agents…");
    try {
      const found = new Map();
      for (const qid of queueIds) {
        for (const m of await fetchQueueMembers(api, org.id, qid)) {
          const id = m.id || m.user?.id;
          if (id) found.set(id, m.name || m.user?.name || id);
        }
      }
      for (const [id, name] of found) userName.set(id, name);
      agentPicker.setItems([...found].map(([id, label]) => ({ id, label })));
      agentPicker.setPlaceholder("All agents");
      agentPicker.setEnabled(found.size > 0);
    } catch {
      agentPicker.setPlaceholder("Agents unavailable");
    }
  }

  // ── The query ───────────────────────────────────────

  /** The scope currently selected, or an error string if it cannot be queried. */
  function currentScope() {
    const from = $("from").value;
    const to = $("to").value;
    if (!from || !to) return { error: "Choose a date range." };
    if (from > to) return { error: "The From date is after the To date." };

    const days = dayCount(from, to);
    if (days > MAX_INTERVAL_DAYS) {
      return { error:
        `That period is ${days} days. Genesys allows at most ${MAX_INTERVAL_DAYS} `
        + "on a filtered conversation query." };
    }

    const copilotIds = [...copilotPicker.getSelected()];
    if (!copilotIds.length) return { error: "Select at least one copilot." };

    return {
      from, to, copilotIds,
      queueIds: [...queuePicker.getSelected()],
      agentIds: [...agentPicker.getSelected()],
    };
  }

  /**
   * The analytics query body.
   *
   * Each list is its own OR clause, ANDed with the others by being separate
   * segment filters: any of these copilots, AND any of these queues, AND any of
   * these agents. The copilot clause alone is a complete filter, which is why
   * the other two are omitted rather than defaulted when empty.
   */
  function detailBody(s) {
    const segmentFilters = [{
      type: "or",
      predicates: s.copilotIds.map((id) => ({ dimension: "agentAssistantId", value: id })),
    }];
    if (s.queueIds.length) {
      segmentFilters.push({
        type: "or",
        predicates: s.queueIds.map((id) => ({ dimension: "queueId", value: id })),
      });
    }
    if (s.agentIds.length) {
      segmentFilters.push({
        type: "or",
        predicates: s.agentIds.map((id) => ({ dimension: "userId", value: id })),
      });
    }
    return {
      interval: `${utcIso(s.from)}/${utcIso(s.to, true)}`,
      order: "desc",
      orderBy: "conversationStart",
      segmentFilters,
    };
  }

  $("count").addEventListener("click", async () => {
    const org = currentOrg();
    if (!org) { setStatus("Select a customer organisation first.", "error"); return; }
    const s = currentScope();
    if (s.error) { setStatus(s.error, "error"); return; }

    setStatus("Counting interactions…");
    try {
      const total = await countConversationDetails(api, org.id, detailBody(s));
      counted = total;
      if (total === 0) {
        setStatus(`No interactions in ${formatRange(s.from, s.to)}.`, "error");
        $("load").disabled = true;
        return;
      }
      const willRead = total == null ? null : Math.min(total, MAX_PAGES * 100);
      const willEnrich = willRead == null ? null : Math.min(willRead, MAX_ENRICH);
      $("load").disabled = false;
      setStatus(
        total == null
          ? `${formatRange(s.from, s.to)} — the count came back empty, so the size `
            + "is unknown. Loading will read up to "
            + `${(MAX_PAGES * 100).toLocaleString()} interactions.`
          : `${total.toLocaleString()} interaction(s) in ${formatRange(s.from, s.to)}. `
            + `Loading reads ${willRead.toLocaleString()} and fetches checklists for `
            + `${willEnrich.toLocaleString()} of them — roughly `
            + `${(willEnrich * 3).toLocaleString()}–${(willEnrich * 4).toLocaleString()} `
            + "requests, so it takes a few minutes.");
    } catch (e) {
      setStatus(`Could not count interactions: ${e.message}`, "error");
    }
  });

  $("load").addEventListener("click", () => { load().catch(() => {}); });

  async function load() {
    const org = currentOrg();
    if (!org) return;
    const s = currentScope();
    if (s.error) { setStatus(s.error, "error"); return; }

    // A second load while one runs would interleave two result sets.
    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;
    const ticket = ++runSeq;

    rows = [];
    enriched = new Map();
    truncated = false;
    statusFilter = "all";
    agentCheckedOnly = false;
    $results.hidden = true;
    $("export").hidden = true;
    openRowId = null;
    $("detailPanel").hidden = true;
    showTable(true);
    $("load").disabled = true;
    $("count").disabled = true;

    try {
      setStatus("Reading interactions…");
      const convs = await queryConversationDetails(api, org.id, detailBody(s), {
        maxPages: MAX_PAGES,
        onProgress: (n) => setStatus(`Reading interactions… ${n.toLocaleString()}`),
        shouldStop: () => signal.aborted,
      });
      if (ticket !== runSeq) return;
      truncated = counted != null && convs.length < counted;

      if (!convs.length) {
        setStatus(`No interactions in ${formatRange(s.from, s.to)}.`, "error");
        return;
      }

      // Wrap-up names are one call and make a whole column readable.
      try {
        for (const w of await fetchAllWrapupCodes(api, org.id)) {
          wrapUpName.set(w.id, w.name || w.id);
        }
      } catch { /* the column falls back to ids */ }

      rows = convs.map(buildRow).filter(Boolean);

      // Before the first draw, so the table does not visibly flip from GUIDs
      // to names a moment later.
      setStatus("Resolving names…");
      await resolveNames(org.id, rows);
      if (ticket !== runSeq) return;

      $("rangeLine").textContent =
        `${formatRange(s.from, s.to)} · ${convs.length.toLocaleString()} interaction(s) read`
        + (truncated ? ` of ${counted.toLocaleString()}` : "");
      $results.hidden = false;
      drawAll();

      await enrichAll(org.id, signal, ticket);
    } catch (e) {
      if (!signal.aborted) setStatus(`Could not load: ${e.message}`, "error");
    } finally {
      if (ticket === runSeq) {
        $("load").disabled = false;
        $("count").disabled = false;
      }
    }
  }

  /**
   * One analytics record → one row.
   *
   * Agents are merged by userId rather than by participant entry, because a
   * transfer or a consult gives the same person several entries and each would
   * otherwise become a separate name in the Agent column.
   */
  function buildRow(conv) {
    const byUser = new Map();
    let queueId = null;
    let assistantId = null;
    let mediaType = null;
    const wrapUps = new Set();

    for (const part of conv.participants || []) {
      if (part.purpose !== PURPOSE_AGENT) {
        // The assistant id rides on any session, not only an agent's.
        for (const sess of part.sessions || []) {
          if (!assistantId && sess.agentAssistantId) assistantId = sess.agentAssistantId;
        }
        continue;
      }
      for (const sess of part.sessions || []) {
        if (!assistantId && sess.agentAssistantId) assistantId = sess.agentAssistantId;
        if (!mediaType && sess.mediaType) mediaType = sess.mediaType;
        for (const seg of sess.segments || []) {
          if (!queueId && seg.queueId) queueId = seg.queueId;
          if (seg.wrapUpCode) wrapUps.add(seg.wrapUpCode);
        }
        for (const m of sess.metrics || []) {
          if (m.name === "tHandle") {
            const cur = byUser.get(part.userId) || 0;
            byUser.set(part.userId, cur + (m.value || 0));
          }
        }
      }
      if (part.userId && !byUser.has(part.userId)) byUser.set(part.userId, 0);
      if (part.userId && part.participantName) userName.set(part.userId, part.participantName);
    }

    if (!byUser.size) return null;   // no agent — nothing this page can say

    return {
      conversationId: conv.conversationId,
      when: conv.conversationStart || null,
      agents: [...byUser.keys()],
      queueId,
      assistantId,
      media: mediaType || "—",
      ms: [...byUser.values()].reduce((a, b) => a + b, 0),
      wrapUpIds: [...wrapUps],
    };
  }

  /* ── Names ────────────────────────────────────────
   *
   * Rows carry ids and are named here, so a lookup that finishes after the
   * table is drawn still reaches the screen. Every id falls back to itself:
   * a GUID on screen is poor, but blank would be worse.
   */
  const agentNames = (r) =>
    r.agents.map((id) => userName.get(id) || id).join(", ") || "—";
  const queueLabel = (r) =>
    r.queueId ? (queueName.get(r.queueId) || r.queueId) : "—";
  const copilotLabel = (r) =>
    r.assistantId ? (assistantName.get(r.assistantId) || r.assistantId) : "—";
  const wrapUpLabel = (r) =>
    r.wrapUpIds.map((id) => wrapUpName.get(id) || id).join(", ") || "—";

  /**
   * Look up the ids nothing has named yet.
   *
   * Agent names reached the page two ways before this: `participantName` when
   * the analytics row happened to carry it, and queue members when queues
   * happened to be selected. Neither is reliable - outbound rows in particular
   * arrive with a bare userId - so the Agent column printed GUIDs. The same is
   * true of wrap-up codes, where Genesys built-ins are absent from the routing
   * list entirely.
   *
   * Best-effort by design: a failure here leaves ids on screen, which is worse
   * than names and much better than losing the rows.
   */
  async function resolveNames(orgId, rowsToName) {
    const userIds = [...new Set(rowsToName.flatMap((r) => r.agents))]
      .filter((id) => id && !userName.has(id));
    const codeIds = [...new Set(rowsToName.flatMap((r) => r.wrapUpIds))]
      .filter((id) => id && !wrapUpName.has(id));

    if (userIds.length) {
      try {
        for (const u of await fetchUsersByIds(api, orgId, userIds)) {
          if (u?.id) userName.set(u.id, u.name || u.email || u.id);
        }
      } catch { /* ids stay on screen */ }
    }
    if (codeIds.length) {
      try {
        for (const w of await fetchWrapupCodesByIds(api, orgId, codeIds)) {
          if (w?.id) wrapUpName.set(w.id, w.name || w.id);
        }
      } catch { /* ids stay on screen */ }
    }
  }

  // ── Enrichment ──────────────────────────────────────

  /**
   * Fetch checklists and summaries for each row, a few at a time.
   *
   * The table is already on screen: this fills the Checklist and Status columns
   * as answers arrive, so the page is usable throughout rather than after.
   */
  async function enrichAll(orgId, signal, ticket) {
    const todo = rows.slice(0, MAX_ENRICH);
    let done = 0;
    let withChecklist = 0;
    let failed = 0;

    for (let i = 0; i < todo.length; i += ENRICH_CONCURRENCY) {
      if (signal.aborted || ticket !== runSeq) return;
      const batch = todo.slice(i, i + ENRICH_CONCURRENCY);
      const results = await Promise.all(
        batch.map((r) => enrichOne(orgId, r.conversationId)));

      // Checked BEFORE writing: a batch already in flight when a new load
      // started would otherwise land in the new run's state and show stale
      // checklists for any conversation the two searches have in common.
      if (signal.aborted || ticket !== runSeq) return;

      for (let k = 0; k < batch.length; k++) {
        enriched.set(batch[k].conversationId, results[k]);
        if (results[k]._error) failed++;
        else if (results[k].checklists.length) withChecklist++;
      }
      done += batch.length;
      setStatus(`Fetching checklists… ${done.toLocaleString()} of ${todo.length.toLocaleString()}`);
      drawAll();
    }

    if (signal.aborted || ticket !== runSeq) return;

    let msg = `${rows.length.toLocaleString()} interaction(s) — `
      + `${withChecklist.toLocaleString()} with a checklist`;
    if (failed) msg += `, ${failed.toLocaleString()} could not be read`;
    if (rows.length > todo.length) {
      msg += `. Checklists were fetched for the first ${todo.length.toLocaleString()}; `
        + "narrow the range to cover the rest";
    }
    if (truncated) msg += ". The result set is partial";
    setStatus(msg + ".", failed ? "" : "success");
    $("export").hidden = !withChecklist;
    drawAll();
  }

  /**
   * One conversation: its agent communications, their checklists, its summaries.
   *
   * Never throws. A failure comes back as `_error` on the record so one bad
   * conversation cannot stop the run.
   */
  async function enrichOne(orgId, convId) {
    const empty = { checklists: [], summaries: [], completion: null };
    try {
      const conv = await getConversation(api, orgId, convId);

      // Communication id → agent name, walking the media-specific keys.
      const commAgent = new Map();
      const idName = new Map();
      for (const p of conv.participants || []) {
        if (p.purpose !== PURPOSE_AGENT) continue;
        const name = p.name || p.participantName || userName.get(p.userId) || p.userId || "Unknown";
        if (p.userId) idName.set(p.userId, name);
        for (const key of MEDIA_KEYS) {
          for (const c of p[key] || []) if (c?.id) commAgent.set(c.id, name);
        }
      }

      let summaries = [];
      try {
        const res = await fetchConversationSummaries(api, orgId, convId);
        summaries = parseSummaries(res);
        for (const s of summaries) {
          const cid = s.communication?.id ?? s.communicationId ?? null;
          if (cid && commAgent.has(cid)) s._agentName = commAgent.get(cid);
        }
      } catch { /* no summaries, or no permission — the checklists still stand */ }

      if (!commAgent.size) return { ...empty, summaries };

      const all = [];
      for (const commId of commAgent.keys()) {
        try {
          const list = await fetchAgentChecklists(api, orgId, convId, commId);
          for (const cl of list) {
            // Attribute by the checklist's OWN agentId where it has one: a
            // transfer can leave one agent's checklist hanging off another's
            // communication, and the queried communication would misname it.
            cl._agentName = cl.agentId
              ? (idName.get(cl.agentId) || cl.agentId)
              : (commAgent.get(commId) || "Unknown");
          }
          all.push(...list);
        } catch (e) {
          // 404 is ordinary: this communication simply had no checklist.
          if (e?.status !== 404) throw e;
        }
      }

      // Keep each agent's copy of a shared template — same id, different agent.
      const seen = new Set();
      const checklists = all.filter((cl) => {
        if (!cl.id) return true;
        const key = `${cl.id}__${cl.agentId ?? ""}__${cl.participantId ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return { checklists, summaries, completion: checklistCompletion(checklists) };
    } catch (e) {
      return { ...empty, _error: e.message || String(e) };
    }
  }

  // ── Filtering, bars, table ──────────────────────────

  /**
   * The single definition of "is this row in scope".
   *
   * Used by the table, the bars AND the export, so the download can never
   * disagree with what is on screen.
   */
  function passes(row) {
    const info = enriched.get(row.conversationId);
    if (statusFilter === "summaries") {
      if (!info?.summaries?.length) return false;
    } else if (statusFilter !== "all") {
      if (info?.completion !== statusFilter) return false;
    }
    if (agentCheckedOnly && !agentTickedAny(info?.checklists)) return false;
    return true;
  }

  for (const f of STATUS_FILTERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm dq-preset" + (f.key === "all" ? " is-active" : "");
    btn.textContent = f.label;
    btn.addEventListener("click", () => {
      statusFilter = f.key;
      for (const b of $("statusFilters").children) {
        if (b.dataset.toggle !== "agent") b.classList.toggle("is-active", b === btn);
      }
      drawAll();
    });
    $("statusFilters").append(btn);
  }
  {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm dq-preset";
    btn.dataset.toggle = "agent";
    btn.textContent = "Agent checked";
    btn.title = "Only interactions where the agent ticked at least one item themselves.";
    btn.addEventListener("click", () => {
      agentCheckedOnly = !agentCheckedOnly;
      btn.classList.toggle("is-active", agentCheckedOnly);
      drawAll();
    });
    $("statusFilters").append(btn);
  }

  function drawAll() { drawTiles(); drawBars(); drawTable(); highlightRow(); }

  /* ── Showing and hiding the results table ─────────────
   *
   * Opening an interaction collapses the table rather than pushing the detail
   * below it. Nine columns and a drill-down do not fit on one screen together,
   * and scrolling past the whole table to reach the detail you just asked for
   * is worse than losing sight of the table you had finished with.
   */
  function showTable(on) {
    $("tableArea").hidden = !on;
    $("resultsToggle").setAttribute("aria-expanded", String(on));
    $("resultsChevron").textContent = on ? "▼" : "▶";
  }

  function highlightRow() {
    for (const tr of $("rows").querySelectorAll("tbody tr")) {
      tr.classList.toggle("is-active", tr.dataset.conversation === openRowId);
    }
  }

  $("resultsToggle").addEventListener("click", () => {
    showTable($("tableArea").hidden);
  });

  function tile(label, value, sub) {
    return `
      <div class="dq-tile">
        <div class="dq-tile-label">${escapeHtml(label)}</div>
        <div class="dq-tile-value">${escapeHtml(value)}</div>
        ${sub ? `<div class="dq-tile-sub">${escapeHtml(sub)}</div>` : ""}
      </div>`;
  }

  function drawTiles() {
    const visible = rows.filter(passes);
    let complete = 0, incomplete = 0, noItems = 0, withSummary = 0, agentTicked = 0;
    let unread = 0;
    for (const r of visible) {
      const info = enriched.get(r.conversationId);
      if (!info) { unread++; continue; }
      if (info.completion === "complete") complete++;
      else if (info.completion === "incomplete") incomplete++;
      else if (info.checklists.length) noItems++;
      if (info.summaries.length) withSummary++;
      if (agentTickedAny(info.checklists)) agentTicked++;
    }
    const judged = complete + incomplete;
    $("tiles").innerHTML =
      tile("Interactions", visible.length.toLocaleString(),
        unread ? `${unread.toLocaleString()} not yet read` : "in scope")
      + tile("Complete", complete.toLocaleString(),
        judged ? `${Math.round((complete / judged) * 100)}% of those judged` : "—")
      + tile("Agent ticked", agentTicked.toLocaleString(),
        "the agent touched the checklist")
      + tile("With summary", withSummary.toLocaleString(),
        noItems ? `${noItems.toLocaleString()} checklist(s) had no items` : "AI wrote one");
  }

  /** Horizontal bars, widths relative to the larger of the two. */
  function drawBars() {
    let complete = 0, incomplete = 0;
    for (const r of rows.filter(passes)) {
      const info = enriched.get(r.conversationId);
      if (info?.completion === "complete") complete++;
      else if (info?.completion === "incomplete") incomplete++;
    }
    const max = Math.max(complete, incomplete);
    if (!max) {
      $("bars").innerHTML =
        '<div class="dq-bar-empty">No checklist has been judged yet.</div>';
      return;
    }
    const bar = (label, n, fill) => `
      <div class="dq-bar-row">
        <span class="dq-bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        <div class="dq-bar-track">
          <div class="dq-bar-fill ${fill}" style="width:${Math.round((n / max) * 100)}%"></div>
        </div>
        <span class="dq-bar-value">${n.toLocaleString()}</span>
      </div>`;
    $("bars").innerHTML =
      bar("Complete", complete, "dq-fill-alt") + bar("Incomplete", incomplete, "dq-fill-warn");
  }

  function statusCell(row) {
    const info = enriched.get(row.conversationId);
    if (!info) return '<span class="dq-muted">…</span>';
    if (info._error) {
      return `<span class="dq-flag" title="${escapeHtml(info._error)}">Error</span>`;
    }
    if (!info.checklists.length) return '<span class="dq-muted">No checklist</span>';
    if (info.completion === "complete") return "Complete";
    if (info.completion === "incomplete") return '<span class="dq-flag">Incomplete</span>';
    return '<span class="dq-muted">No items</span>';
  }

  function drawTable() {
    const visible = rows.filter(passes);
    const shown = visible.slice(0, MAX_TABLE_ROWS);
    const $t = $("rows");

    detachFilters?.();
    detachFilters = null;
    $("tableNote").hidden = true;

    if (!visible.length) {
      $t.innerHTML = "";
      $("tableNote").textContent = "No interactions match these filters.";
      $("tableNote").hidden = false;
      return;
    }

    $t.innerHTML =
      "<thead><tr><th>Agent</th><th>Queue</th><th>Copilot</th><th>Time</th>"
      + '<th class="is-num">Duration</th><th>Media</th><th>Checklist</th>'
      + "<th>Wrap-up</th><th>Status</th></tr></thead>"
      + `<tbody>${shown.map((r) => {
        const info = enriched.get(r.conversationId);
        const names = info?.checklists?.length
          ? [...new Set(info.checklists.map((c) => c.name || "Checklist"))].join(", ")
          : (info ? "—" : "…");
        const seconds = r.ms != null ? Math.round(r.ms / 1000) : "";
        return `<tr data-conversation="${escapeHtml(r.conversationId || "")}">
          <td>${escapeHtml(agentNames(r))}</td>
          <td>${escapeHtml(queueLabel(r))}</td>
          <td>${escapeHtml(copilotLabel(r))}</td>
          <td data-value="${escapeHtml(r.when || "")}">${escapeHtml(shortDate(r.when))}</td>
          <td class="is-num" data-value="${seconds}">${escapeHtml(fmtDuration(r.ms))}</td>
          <td>${escapeHtml(r.media)}</td>
          <td>${escapeHtml(names)}</td>
          <td>${escapeHtml(wrapUpLabel(r))}</td>
          <td>${statusCell(r)}</td>
        </tr>`;
      }).join("")}</tbody>`;

    // Time and Duration are measured quantities — nearly one distinct value per
    // row — so both get a FROM/TO range rather than a list of checkboxes. Time
    // reads its real timestamp from data-value, since the displayed text is
    // formatted for people and does not parse back.
    detachFilters = attachColumnFilters($("rowsWrap"), {
      sortable: true,
      compact: true,
      numericCols: [4],
      rangeCols: [4],
      dateCols: [3],
    });

    if (visible.length > shown.length) {
      $("tableNote").textContent =
        `Showing the first ${shown.length.toLocaleString()} of `
        + `${visible.length.toLocaleString()}. Narrow the filters or the date range.`;
      $("tableNote").hidden = false;
    }
  }

  // One listener for the life of the page rather than one per redraw: the table
  // element survives every redraw, so re-binding inside drawTable would stack a
  // fresh copy on each one.
  $("rows").addEventListener("contextmenu", (e) => {
    const id = e.target?.closest?.("tbody tr")?.dataset?.conversation;
    if (!id) return;
    e.preventDefault();
    navigator.clipboard?.writeText(id).then(
      () => setStatus(`Conversation ID copied: ${id}`, "success"),
      () => setStatus("Could not copy to clipboard.", "error"));
  });

  $("rows").addEventListener("click", (e) => {
    const id = e.target?.closest?.("tbody tr")?.dataset?.conversation;
    if (!id) return;
    // Clicking the row that is already open closes it again, so the row is a
    // toggle rather than a one-way door.
    if (openRowId === id) closeDetail();
    else openDetail(id);
  });

  function closeDetail() {
    openRowId = null;
    $("detailPanel").hidden = true;
    showTable(true);
    highlightRow();
  }

  // ── Drill-down ──────────────────────────────────────

  /**
   * A collapsible block: a chevron header and a body that folds away.
   *
   * Recording and Checklists open, Summary closed — the same defaults the
   * source shipped, on the reasoning that a summary is prose you go looking
   * for while a checklist is what you came to see.
   */
  function collapsible(title, content, expanded = true) {
    const wrap = document.createElement("div");
    wrap.className = "dq-panel-block";

    const chevron = document.createElement("span");
    chevron.className = "ac-chevron";
    chevron.textContent = expanded ? "▼" : "▶";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ac-collapse-toggle";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.append(chevron, document.createTextNode(" " + title));

    const body = document.createElement("div");
    body.hidden = !expanded;
    body.append(content);

    toggle.addEventListener("click", () => {
      const open = !body.hidden;
      body.hidden = open;
      toggle.setAttribute("aria-expanded", String(!open));
      chevron.textContent = open ? "▶" : "▼";
    });

    wrap.append(toggle, body);
    return wrap;
  }

  function openDetail(convId) {
    const info = enriched.get(convId);
    const $p = $("detailPanel");
    openRowId = convId;
    highlightRow();
    showTable(false);
    $p.hidden = false;
    $p.innerHTML = "";

    const head = document.createElement("div");
    head.className = "dq-panel-head";
    head.innerHTML =
      `<h3 class="dq-panel-title">Interaction detail</h3>`
      + `<div class="dq-panel-sub">${escapeHtml(convId)}</div>`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn btn-sm";
    close.textContent = "Close";
    close.addEventListener("click", closeDetail);
    head.append(close);
    $p.append(head);

    if (!info) {
      const p = document.createElement("p");
      p.className = "dq-panel-sub";
      p.textContent = "This interaction has not been read yet.";
      $p.append(p);
      return;
    }
    if (info._error) {
      const p = document.createElement("p");
      p.className = "dq-panel-sub";
      p.textContent = `Could not read this interaction: ${info._error}`;
      $p.append(p);
    }

    $p.append(collapsible("Recording", recordingSection(convId), true));
    $p.append(collapsible("Checklists", checklistSection(info.checklists), true));
    $p.append(collapsible(
      "Conversation summary"
        + (info.summaries.length > 1 ? ` (${info.summaries.length})` : ""),
      summarySection(info.summaries), false));
    $p.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /**
   * Recordings, fetched only when asked for.
   *
   * Nothing here loads with the page: a recording stub is one call per
   * conversation and the audio itself is far heavier, so both wait for a click.
   */
  function recordingSection(convId) {
    const wrap = document.createElement("div");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm";
    btn.textContent = "Load recordings";
    const area = document.createElement("div");
    area.className = "dq-recordings";
    wrap.append(btn, area);

    btn.addEventListener("click", async () => {
      const org = currentOrg();
      if (!org) return;
      btn.disabled = true;
      btn.textContent = "Loading…";
      try {
        let stubs = await fetchConversationRecordings(api, org.id, convId);
        // Genesys may not have indexed a just-ended call yet.
        for (let i = 0; !stubs.length && i < 2; i++) {
          btn.textContent = "Retrying…";
          await new Promise((r) => setTimeout(r, 3000));
          stubs = await fetchConversationRecordings(api, org.id, convId);
        }
        // `deleteDate` is the real field name. The app this came from tested
        // `deletedDate`, which never matches anything.
        const usable = stubs.filter(
          (r) => r.id && !r.deleteDate && r.fileState !== "DELETED" && r.fileState !== "ERROR");

        btn.remove();
        if (!usable.length) {
          area.innerHTML = '<span class="dq-muted">No recording for this interaction.</span>';
          return;
        }
        usable.forEach((stub, i) => {
          area.append(recordingPlayer(convId, stub, usable.length > 1 ? `Part ${i + 1}` : "Play recording"));
        });
      } catch (e) {
        btn.remove();
        area.innerHTML =
          `<span class="dq-flag">Could not load recordings: ${escapeHtml(e.message)}</span>`;
      }
    });

    return wrap;
  }

  /** One recording: a button that fetches, transcodes if needed, then plays. */
  function recordingPlayer(convId, stub, label) {
    const row = document.createElement("div");
    row.className = "dq-recording";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm";
    btn.textContent = label;
    const slot = document.createElement("div");
    slot.hidden = true;
    row.append(btn, slot);

    // The Screen enum lives on mediaSubtype; `media` is a free-text field and
    // testing it is how the source app got screen recordings wrong.
    const isScreen = (stub.mediaSubtype || "").toLowerCase() === "screen"
      || (stub.media || "").toLowerCase() === "screen";

    btn.addEventListener("click", async () => {
      if (slot.dataset.loaded) {           // already fetched — just toggle
        slot.hidden = !slot.hidden;
        btn.classList.toggle("is-active", !slot.hidden);
        return;
      }
      if (stub.fileState === "ARCHIVED") {
        slot.innerHTML = '<span class="dq-muted">Archived — not directly playable.</span>';
        slot.dataset.loaded = "1";
        slot.hidden = false;
        return;
      }

      const org = currentOrg();
      if (!org) return;
      btn.disabled = true;
      btn.textContent = "Transcoding…";
      const format = isScreen ? "WEBM" : "MP3";
      try {
        let uri = null;
        for (let attempt = 0; attempt < 5 && !uri; attempt++) {
          const rec = await fetchConversationRecording(
            api, org.id, convId, stub.id, format);
          uri = rec?.mediaUris?.[format]?.mediaUri
            || Object.values(rec?.mediaUris || {})[0]?.mediaUri
            || null;
          if (uri) break;
          // The server's own estimate beats a fixed delay: a long call can take
          // far more than three seconds, a short one far less.
          const wait = Math.min(Math.max(rec?.estimatedTranscodeTimeMs || 3000, 1000), 15000);
          await new Promise((r) => setTimeout(r, wait));
        }
        if (!uri) {
          slot.innerHTML =
            '<span class="dq-muted">Not available yet — still processing.</span>';
        } else {
          const media = document.createElement(isScreen ? "video" : "audio");
          media.controls = true;
          media.src = uri;
          media.className = "dq-recording-media";
          slot.replaceChildren(media);
        }
      } catch (e) {
        slot.innerHTML = `<span class="dq-flag">Could not load: ${escapeHtml(e.message)}</span>`;
      }
      slot.dataset.loaded = "1";
      slot.hidden = false;
      btn.disabled = false;
      btn.textContent = label;
      btn.classList.add("is-active");
    });

    return row;
  }

  /** Checklist items, agent tick and AI tick shown apart. */
  function checklistSection(checklists) {
    const wrap = document.createElement("div");
    if (!checklists.length) {
      wrap.insertAdjacentHTML("beforeend",
        '<span class="dq-muted">No checklist ran on this interaction.</span>');
      return wrap;
    }

    for (const cl of checklists) {
      const box = document.createElement("div");
      box.className = "dq-checklist";
      const title = cl._agentName
        ? `${cl.name || "Checklist"} — ${cl._agentName}`
        : (cl.name || "Checklist");
      const meta = [
        cl.status,
        cl.evaluationStartDate ? `started ${shortDate(cl.evaluationStartDate)}` : null,
        cl.evaluationFinalizedDate ? `finalised ${shortDate(cl.evaluationFinalizedDate)}` : null,
      ].filter(Boolean).join(" · ");

      box.innerHTML =
        `<div class="dq-checklist-title">${escapeHtml(title)}</div>`
        + (meta ? `<div class="dq-panel-sub">${escapeHtml(meta)}</div>` : "")
        + `<table class="dq-table dq-checklist-items">
             <thead><tr><th>Item</th><th>Agent</th><th>AI</th></tr></thead>
             <tbody>${(cl.checklistItems || []).map((it) => `
               <tr>
                 <td>
                   ${it.important ? '<span class="dq-flag" title="Important">!</span> ' : ""}
                   ${escapeHtml(it.name || "—")}
                   ${it.description
                      ? `<div class="dq-panel-sub">${escapeHtml(it.description)}</div>` : ""}
                 </td>
                 <td>${it.stateFromAgent === TICKED ? "Yes" : '<span class="dq-muted">No</span>'}</td>
                 <td>${it.stateFromModel === TICKED ? "Yes" : '<span class="dq-muted">No</span>'}</td>
               </tr>`).join("")}
             </tbody>
           </table>`;
      if (!(cl.checklistItems || []).length) {
        box.insertAdjacentHTML("beforeend",
          '<span class="dq-muted">This checklist carries no items, so it is '
          + "neither complete nor incomplete.</span>");
      }
      wrap.append(box);
    }
    return wrap;
  }

  /** AI summaries, with the original shown where an agent edited a field. */
  function summarySection(summaries) {
    const wrap = document.createElement("div");
    if (!summaries.length) {
      wrap.insertAdjacentHTML("beforeend",
        '<span class="dq-muted">No AI summary was written for this interaction.</span>');
      return wrap;
    }

    summaries.forEach((s, i) => {
      const box = document.createElement("div");
      box.className = "dq-summary";
      const label = summaries.length > 1 ? `Summary ${i + 1} of ${summaries.length}` : "Summary";
      const who = s._agentName ? ` — ${s._agentName}` : "";
      const edited = s.editedSummary || {};

      const field = (name, original, key) => {
        const orig = fieldText(original);
        const ed = fieldText(edited?.[key]);
        if (!orig && !ed) return "";
        return `<div class="dq-summary-field">
          <span class="dq-summary-label">${escapeHtml(name)}</span>
          ${ed
            ? `<span class="dq-flag">edited</span>
               <div>${escapeHtml(ed)}</div>
               ${orig ? `<div class="dq-muted"><s>${escapeHtml(orig)}</s></div>` : ""}`
            : `<div>${escapeHtml(orig)}</div>`}
        </div>`;
      };

      const codes = (s.predictedWrapupCodes || [])
        .map((c) => wrapUpName.get(c?.wrapupCode?.id ?? c?.id) || c?.wrapupCode?.name || c?.name)
        .filter(Boolean);

      box.innerHTML =
        `<div class="dq-checklist-title">${escapeHtml(label + who)}</div>`
        + field("Headline", s.text, "text")
        + field("Reason", s.reason, "reason")
        + field("Resolution", s.resolution, "resolution")
        + field("Follow-up", s.followup, "followup")
        + (codes.length
          ? `<div class="dq-summary-field">
               <span class="dq-summary-label">Suggested wrap-up</span>
               <div>${escapeHtml(codes.join(", "))}</div>
             </div>`
          : "");
      wrap.append(box);
    });
    return wrap;
  }

  // ── Export ──────────────────────────────────────────

  $("export").addEventListener("click", () => {
    // The rows the filters currently show — the download must not disagree with
    // the screen.
    const visible = rows.filter(passes)
      .filter((r) => enriched.get(r.conversationId)?.checklists?.length);

    if (!visible.length) {
      setStatus("Nothing to export for the current filters.", "error");
      return;
    }

    const interactions = [[
      "Conversation ID", "Time", "Agent", "Queue", "Copilot", "Media",
      "Duration (s)", "Checklist", "Wrap-up", "Status",
    ]];
    const items = [[
      "Conversation ID", "Checklist", "Agent", "Item", "Description",
      "Agent ticked", "AI ticked", "Important",
    ]];
    const pivot = new Map();

    for (const r of visible) {
      const info = enriched.get(r.conversationId);
      const names = [...new Set(info.checklists.map((c) => c.name || "Checklist"))].join(", ");
      const status = info.completion === "complete" ? "Complete"
        : info.completion === "incomplete" ? "Incomplete" : "No items";

      const wrap = wrapUpLabel(r);
      interactions.push([
        r.conversationId, r.when ? new Date(r.when) : "", agentNames(r),
        queueLabel(r), copilotLabel(r), r.media,
        r.ms ? Math.round(r.ms / 1000) : 0, names,
        wrap === "—" ? "" : wrap, status,
      ]);

      for (const cl of info.checklists) {
        for (const it of cl.checklistItems || []) {
          items.push([
            r.conversationId, cl.name || "", cl._agentName || "", it.name || "",
            it.description || "",
            it.stateFromAgent === TICKED ? "Yes" : "No",
            it.stateFromModel === TICKED ? "Yes" : "No",
            it.important ? "Yes" : "No",
          ]);
        }
      }

      const key = `${agentNames(r)}|${queueLabel(r)}|${copilotLabel(r)}|${names}`;
      const p = pivot.get(key)
        || { agent: agentNames(r), queue: queueLabel(r), copilot: copilotLabel(r),
             checklist: names, total: 0, complete: 0, incomplete: 0 };
      p.total++;
      if (status === "Complete") p.complete++;
      else if (status === "Incomplete") p.incomplete++;
      pivot.set(key, p);
    }

    const summary = [[
      "Agent", "Queue", "Copilot", "Checklist", "Total", "Complete",
      "Incomplete", "Completion %",
    ]];
    for (const p of pivot.values()) {
      const judged = p.complete + p.incomplete;
      summary.push([
        p.agent, p.queue, p.copilot, p.checklist, p.total, p.complete, p.incomplete,
        judged ? Math.round((p.complete / judged) * 100) : "",
      ]);
    }

    const wb = buildStyledWorkbook(summary, "Summary");
    addStyledSheet(wb, interactions, "Interactions");
    addStyledSheet(wb, items, "Checklist Items");
    downloadWorkbook(wb, timestampedFilename("Agent_Copilot_Checklists", "xlsx"));
    setStatus(`Exported ${visible.length.toLocaleString()} interaction(s).`, "success");
  });

  // ── Teardown ────────────────────────────────────────
  const unsubscribe = orgContext?.onChange?.(() => {
    abort?.abort();
    runSeq++;
    invalidate();
  });
  el.__destroy = () => {
    // An in-flight enrichment run keeps making calls long after the page has
    // gone if nothing stops it - hundreds of them, against a customer org.
    abort?.abort();
    runSeq++;
    detachFilters?.();
    unsubscribe?.();
  };

  return el;
}
