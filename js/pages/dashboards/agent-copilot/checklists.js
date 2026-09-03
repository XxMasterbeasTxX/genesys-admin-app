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
  { key: "complete", label: "✅ Completed" },
  { key: "incomplete", label: "⚠️ Incomplete" },
  { key: "summaries", label: "📝 Summaries" },
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
    <div class="ac-header">
      <h1 class="h1">Dashboards — Agent Copilot — Checklists &amp; Summaries</h1>
      <button class="btn btn-sm" data-c="export" hidden>⬇ Export Excel</button>
    </div>
    <hr class="hr">

    <p class="page-desc">
      The interactions that ran with an Agent Copilot checklist, whether it was
      completed, and the AI summary written afterwards. Items are ticked either
      by the agent or by the model, and the two are shown apart — a checklist
      the model finished on its own is complete, but tells you the agent never
      touched it.
    </p>

    <!-- Filters left, chart right, side by side - the source's top area.
         The chart is not a panel below the results: it sits beside the controls
         and is the first thing the filters change. -->
    <div class="ac-top-area">
      <div class="ac-filters">
        <div class="ac-filter-row">
          <div class="ac-filter-group">
            <label class="ac-filter-label">Agent Copilots</label>
            <div data-c="copilotPicker"></div>
            <div class="is-hint" data-c="queueHint"></div>
          </div>
          <div class="ac-filter-group">
            <label class="ac-filter-label">Queues</label>
            <div data-c="queuePicker"></div>
          </div>
          <div class="ac-filter-group">
            <label class="ac-filter-label">Agents</label>
            <div data-c="agentPicker"></div>
          </div>
        </div>

        <div class="ac-filter-row">
          <div class="ac-filter-group">
            <label class="ac-filter-label">From</label>
            <input class="input is-date" type="date" data-c="from">
          </div>
          <div class="ac-filter-group">
            <label class="ac-filter-label">To</label>
            <input class="input is-date" type="date" data-c="to">
          </div>
          <div class="ac-filter-group">
            <label class="ac-filter-label">Quick ranges</label>
            <div class="ac-presets" data-c="presets"></div>
          </div>
          <button class="btn btn-sm" data-c="count">Count interactions</button>
          <button class="btn btn-sm btn-primary" data-c="load" disabled>Load checklists</button>
        </div>

        <div class="ac-filter-row ac-status-bar" data-c="statusFilters"></div>
      </div>

      <div class="ac-chart-wrap" data-c="chartPanel" hidden>
        <div class="ac-chart" data-c="chart"></div>
      </div>
    </div>

    <div class="cs-status" data-c="status" style="display:none"></div>

    <div data-c="results" hidden>
      <div class="dq-range-line" data-c="rangeLine"></div>

      <div class="dq-panel">
        <button type="button" class="ac-results-toggle" data-c="resultsToggle"
                aria-expanded="true">
          <span class="ac-chevron" data-c="resultsChevron">▼</span>
          <span class="dq-panel-title">Search results</span>
        </button>
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
    btn.className = "btn btn-sm ac-preset";
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
    btn.className = "btn btn-sm ac-preset" + (f.key === "all" ? " is-active" : "");
    btn.textContent = f.label;
    btn.addEventListener("click", () => {
      statusFilter = f.key;
      for (const b of $("statusFilters").children) {
        if (b.tagName !== "BUTTON" || b.dataset.toggle === "agent") continue;
        b.classList.toggle("is-active", b === btn);
      }
      drawAll();
    });
    $("statusFilters").append(btn);
  }
  {
    const sep = document.createElement("span");
    sep.className = "ac-filter-sep";
    sep.setAttribute("aria-hidden", "true");
    sep.textContent = "|";
    $("statusFilters").append(sep);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm ac-preset";
    btn.dataset.toggle = "agent";
    btn.textContent = "✋ Agent Checked";
    btn.title = "Only interactions where the agent ticked at least one item themselves.";
    btn.addEventListener("click", () => {
      agentCheckedOnly = !agentCheckedOnly;
      btn.classList.toggle("is-active", agentCheckedOnly);
      drawAll();
    });
    $("statusFilters").append(btn);
  }

  function drawAll() { drawChart(); drawTable(); highlightRow(); }

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

  /**
   * Complete against Incomplete, two vertical bars, as the source shows them.
   *
   * Counted from the rows currently shown, so it moves with the filters. A
   * checklist carrying no items is in NEITHER bar: it is undetermined, and
   * putting it in Incomplete would invent a failure.
   *
   * The source drew this with Chart.js from a CDN. This app vendors its
   * libraries and a chart of two bars is not worth one.
   */
  function drawChart() {
    let complete = 0;
    let incomplete = 0;
    for (const r of rows.filter(passes)) {
      const info = enriched.get(r.conversationId);
      if (info?.completion === "complete") complete++;
      else if (info?.completion === "incomplete") incomplete++;
    }

    const max = Math.max(complete, incomplete);
    $("chartPanel").hidden = !max;
    if (!max) { $("chart").innerHTML = ""; return; }

    const col = (label, n, cls) => `
      <div class="ac-col">
        <div class="ac-col-value">${n.toLocaleString()}</div>
        <div class="ac-col-track">
          <div class="ac-col-bar ${cls}" style="height:${Math.round((n / max) * 100)}%"></div>
        </div>
        <div class="ac-col-label">${escapeHtml(label)}</div>
      </div>`;

    $("chart").innerHTML =
      '<div class="ac-chart-title">Checklist Completion</div>'
      + '<div class="ac-chart-plot">'
      + col("Complete", complete, "is-complete")
      + col("Incomplete", incomplete, "is-incomplete")
      + "</div>";
  }

  function statusCell(row) {
    const info = enriched.get(row.conversationId);
    if (!info) return '<span class="ac-badge is-loading">…</span>';
    if (info._error) {
      return `<span class="ac-badge is-error" title="${escapeHtml(info._error)}">⚠ Error</span>`;
    }
    if (!info.checklists.length) return '<span class="ac-badge is-none">No checklist</span>';
    if (info.completion === "complete") {
      return '<span class="ac-badge is-complete">✅ Complete</span>';
    }
    if (info.completion === "incomplete") {
      return '<span class="ac-badge is-incomplete">⚠️ Incomplete</span>';
    }
    // A checklist with no items - undetermined, and deliberately not Incomplete.
    return '<span class="ac-badge is-none">No items</span>';
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
      "<thead><tr><th>Time</th><th>Agent</th><th>Queue</th><th>Copilot</th>"
      + '<th>Media</th><th class="is-num">Duration</th><th>Checklist</th>'
      + "<th>Wrapup</th><th>Status</th></tr></thead>"
      + `<tbody>${shown.map((r) => {
        const info = enriched.get(r.conversationId);
        const names = info?.checklists?.length
          ? [...new Set(info.checklists.map((c) => c.name || "Checklist"))].join(", ")
          : (info ? "—" : "…");
        const seconds = r.ms != null ? Math.round(r.ms / 1000) : "";
        return `<tr data-conversation="${escapeHtml(r.conversationId || "")}">
          <td data-value="${escapeHtml(r.when || "")}">${escapeHtml(shortDate(r.when))}</td>
          <td>${escapeHtml(agentNames(r))}</td>
          <td>${escapeHtml(queueLabel(r))}</td>
          <td>${escapeHtml(copilotLabel(r))}</td>
          <td>${escapeHtml(r.media)}</td>
          <td class="is-num" data-value="${seconds}">${escapeHtml(fmtDuration(r.ms))}</td>
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
      numericCols: [5],
      rangeCols: [5],
      dateCols: [0],
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
  /**
   * Copy without assuming the async Clipboard API is there.
   *
   * The bug this replaces: `navigator.clipboard?.writeText(id).then(...)`. The
   * optional chain guards the METHOD, not the call's result, so on any browser
   * or context without `navigator.clipboard` it threw a TypeError - AFTER
   * preventDefault had already suppressed the browser's own menu. The gesture
   * did nothing and reported nothing. Same guard and textarea fallback as
   * Interactions > Search and Evaluation Gaps.
   */
  function copyFallback(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  function copyConversationId(id) {
    if (!id) return;
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(id).catch(() => copyFallback(id));
      } else {
        copyFallback(id);
      }
      setStatus(`Copied: ${id}`, "success");
    } catch {
      setStatus("Could not copy to clipboard.", "error");
    }
  }

  $("rows").addEventListener("contextmenu", (e) => {
    const id = e.target?.closest?.("tbody tr")?.dataset?.conversation;
    if (!id) return;
    e.preventDefault();
    copyConversationId(id);
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
      `<h3 class="dq-panel-title">Interaction Detail</h3>`
      + `<div class="dq-panel-sub">${escapeHtml(convId)}</div>`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn btn-sm";
    close.textContent = "✕";
    close.title = "Close";
    close.addEventListener("click", closeDetail);
    head.append(close);
    $p.append(head);

    // Nothing to show yet, or nothing to show at all - the source says so and
    // stops here rather than opening three empty sections.
    if (!info || (!info.checklists.length && !info.summaries.length)) {
      const msg = document.createElement("p");
      msg.className = "dq-panel-sub";
      msg.textContent = info
        ? "No checklist or summary data for this interaction."
        : "Still loading data" + "\u2026";
      $p.append(msg);
      if (info?._error) {
        const err = document.createElement("p");
        err.className = "dq-panel-sub";
        err.textContent = `Could not read this interaction: ${info._error}`;
        $p.append(err);
      }
      return;
    }

    $p.append(collapsible("🎧 Recording", recordingSection(convId), true));
    $p.append(collapsible("Checklists", checklistSection(info.checklists), true));
    // Only when there is one, and titled by count, as the source does.
    if (info.summaries.length) {
      $p.append(collapsible(
        info.summaries.length === 1
          ? "Conversation Summary"
          : `Conversation Summaries (${info.summaries.length})`,
        summarySection(info.summaries), false));
    }
    $p.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /**
   * Recordings, fetched only when asked for.
   *
   * WHAT COUNTS AS USABLE: an id, and a `fileState` that is not DELETED. That
   * is all, and the "and" I added here before was a bug that hid every
   * recording in the org.
   *
   * The source tests `!r.deletedDate`. No such field exists - the schema calls
   * it `deleteDate` - so that test never excludes anything and the source is
   * effectively filtering on `fileState` alone. Correcting the spelling turned
   * a harmless no-op into a real exclusion: `deleteDate` is the SCHEDULED
   * deletion date, which a retention policy sets on essentially every
   * recording, so the corrected version dropped recordings that plainly exist.
   * The typo was load-bearing. Filtering on fileState alone is the behaviour
   * that works.
   */
  function recordingSection(convId) {
    const wrap = document.createElement("div");
    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "btn btn-sm";
    loadBtn.textContent = "🎧 Load Recordings";
    const area = document.createElement("div");
    area.className = "ac-recordings";
    wrap.append(loadBtn, area);

    const fetchStubs = async () => {
      const org = currentOrg();
      if (!org) return [];
      let stubs;
      try {
        stubs = await fetchConversationRecordings(api, org.id, convId);
      } catch (e) {
        // 404 means the conversation has no recordings - ordinary, not an error.
        if (e?.status === 404 || /\b404\b/.test(e?.message || "")) return [];
        throw e;
      }
      return (stubs || []).filter((r) => r.id && r.fileState !== "DELETED");
    };

    loadBtn.addEventListener("click", async () => {
      if (loadBtn.dataset.loaded) return;
      loadBtn.disabled = true;
      loadBtn.textContent = "⏳ Loading…";
      try {
        // Genesys may not have indexed a recording that has only just ended.
        let available = await fetchStubs();
        for (let retry = 0; !available.length && retry < 2; retry++) {
          loadBtn.textContent = "⏳ Retrying…";
          await new Promise((r) => setTimeout(r, 3000));
          available = await fetchStubs();
        }
        loadBtn.dataset.loaded = "1";

        if (!available.length) {
          loadBtn.remove();
          area.innerHTML =
            '<span class="dq-muted">No recordings for this interaction.</span>';
          return;
        }

        loadBtn.remove();
        // Every button on one row, the players stacked beneath - so opening a
        // second part does not shift the buttons out from under the cursor.
        const btnRow = document.createElement("div");
        btnRow.className = "ac-recording-btns";
        const playerArea = document.createElement("div");
        const multi = available.length > 1;

        available.forEach((stub, i) => {
          const label = multi
            ? "🎧 Part " + (i + 1)
            : "🎧 Play Recording";
          const slot = document.createElement("div");
          slot.hidden = true;
          btnRow.append(recordingButton(convId, stub, label, slot));
          playerArea.append(slot);
        });
        area.append(btnRow, playerArea);
      } catch (e) {
        loadBtn.remove();
        area.innerHTML =
          `<span class="dq-flag">Could not load recordings: ${escapeHtml(e.message)}</span>`;
      }
    });

    return wrap;
  }

  /**
   * One recording: fetch on first click, then toggle.
   *
   * Asking for a format is what triggers transcoding, so the first response for
   * a long call often carries no `mediaUris` at all and has to be repeated.
   * Five attempts, three seconds apart, as the source does.
   */
  function recordingButton(convId, stub, label, slot) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm";
    btn.textContent = label;

    // The Screen enum lives on mediaSubtype; `media` is free text. Both are
    // tested, because only an actual screen recording can match either.
    const isScreen = (stub.mediaSubtype || "").toLowerCase() === "screen"
      || (stub.media || stub.mediaType || "").toLowerCase() === "screen";

    btn.addEventListener("click", async () => {
      if (slot.dataset.loaded) {
        slot.hidden = !slot.hidden;
        btn.classList.toggle("is-active", !slot.hidden);
        return;
      }
      if (stub.fileState === "ARCHIVED") {
        slot.innerHTML =
          '<span class="dq-muted">Archived — not directly playable.</span>';
        slot.dataset.loaded = "1";
        slot.hidden = false;
        btn.classList.add("is-active");
        return;
      }

      const org = currentOrg();
      if (!org) return;
      btn.disabled = true;
      btn.textContent = "⏳ Transcoding…";
      const format = isScreen ? "WEBM" : "MP3";
      try {
        let uri = null;
        let rec = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          rec = await fetchConversationRecording(api, org.id, convId, stub.id, format);
          // The asked-for format first, then anything playable that came back.
          uri = rec?.mediaUris?.[format]?.mediaUri
            ?? rec?.mediaUris?.MP3?.mediaUri
            ?? rec?.mediaUris?.WEBM?.mediaUri
            ?? rec?.mediaUris?.WAV?.mediaUri
            ?? rec?.mediaUri
            ?? Object.values(rec?.mediaUris ?? {})[0]?.mediaUri
            ?? null;
          if (uri) break;
          if (attempt < 4) await new Promise((r) => setTimeout(r, 3000));
        }

        if (!uri) {
          slot.innerHTML =
            '<span class="dq-muted">Recording not yet available '
            + "(may still be processing).</span>";
        } else {
          const screen = isScreen
            || (rec?.media || rec?.mediaType || "").toLowerCase() === "screen";
          const media = document.createElement(screen ? "video" : "audio");
          media.controls = true;
          media.src = uri;
          media.className = "ac-recording-media";
          slot.replaceChildren(media);
        }
      } catch (e) {
        slot.innerHTML =
          `<span class="dq-flag">Could not load: ${escapeHtml(e.message || "Unknown error")}</span>`;
      }
      slot.dataset.loaded = "1";
      slot.hidden = false;
      btn.disabled = false;
      btn.textContent = label;
      btn.classList.add("is-active");
    });

    return btn;
  }

  /**
   * Checklist items, rendered as the source app renders them.
   *
   * Each item shows THREE things, and they are not the same thing: an overall
   * tick (agent OR model), then the agent's own tick and the model's own tick
   * side by side. A single merged tick would hide exactly what this page exists
   * to show - whether a person worked the checklist or the model closed it.
   */
  function checklistSection(checklists) {
    const wrap = document.createElement("div");
    if (!checklists.length) {
      wrap.insertAdjacentHTML("beforeend",
        '<span class="dq-muted">No checklist ran on this interaction.</span>');
      return wrap;
    }

    for (const cl of checklists) {
      const section = document.createElement("div");
      section.className = "ac-checklist";

      const label = cl.name || "Checklist";
      const title = document.createElement("div");
      title.className = "ac-checklist-title";
      title.textContent = cl._agentName ? `${label} (Agent: ${cl._agentName})` : label;
      section.append(title);

      const parts = [];
      if (cl.status) parts.push(`Status: ${cl.status}`);
      if (cl.evaluationStartDate) parts.push(`Started: ${shortDate(cl.evaluationStartDate)}`);
      if (cl.evaluationFinalizedDate) {
        parts.push(`Finalized: ${shortDate(cl.evaluationFinalizedDate)}`);
      }
      if (parts.length) {
        const meta = document.createElement("div");
        meta.className = "ac-meta";
        meta.textContent = parts.join(" \u00b7 ");
        section.append(meta);
      }

      const list = document.createElement("ul");
      list.className = "ac-items";
      for (const item of cl.checklistItems || []) {
        const agentTicked = item.stateFromAgent === TICKED;
        const modelTicked = item.stateFromModel === TICKED;
        const ticked = agentTicked || modelTicked;

        const li = document.createElement("li");
        li.className = "ac-item " + (ticked ? "is-ticked" : "is-unticked");
        li.innerHTML =
          `<span class="ac-item-icon">${ticked ? "\u2705" : "\u274c"}</span>`
          + `<span class="ac-item-name">${escapeHtml(item.name || "")}</span>`
          + (item.important
            ? '<span class="ac-important" title="Important">\u26a1</span>' : "")
          + `<span class="ac-eval" title="Agent: ${agentTicked ? "Ticked" : "Unticked"}">`
          + `Agent: <span class="${agentTicked ? "ac-tick--yes" : "ac-tick--no"}">`
          + `${agentTicked ? "\u2713" : "\u2717"}</span></span>`
          + `<span class="ac-eval" title="AI: ${modelTicked ? "Ticked" : "Unticked"}">`
          + `AI: <span class="${modelTicked ? "ac-tick--yes" : "ac-tick--no"}">`
          + `${modelTicked ? "\u2713" : "\u2717"}</span></span>`;

        if (item.description) {
          const desc = document.createElement("div");
          desc.className = "ac-item-desc";
          desc.textContent = item.description;
          li.append(desc);
        }
        list.append(li);
      }
      section.append(list);
      wrap.append(section);
    }
    return wrap;
  }

  /**
   * AI summaries, rendered as the source app renders them.
   *
   * Two things here are easy to get wrong and were: the headline lives on
   * `headline`, NOT on `text` (which is the full summary shown at the bottom),
   * and an edited field lives in its own top-level `editedReason` /
   * `editedResolution` / `editedFollowup`, NOT inside `editedSummary` - that one
   * holds only the edited full text. None of the edited fields nor `headline`
   * appear in the OpenAPI spec; they are read because the working app reads
   * them, and an absent field simply renders nothing.
   *
   * Unknown keys are rendered too. Copilot can return topics beyond Reason,
   * Resolution and Followup, and a fixed list would silently drop them.
   */
  function summarySection(summaries) {
    const wrap = document.createElement("div");
    if (!summaries.length) {
      wrap.insertAdjacentHTML("beforeend",
        '<span class="dq-muted">No AI summary was written for this interaction.</span>');
      return wrap;
    }

    const hasEdited = (v) => v && typeof v === "object" && Object.keys(v).length > 0;

    summaries.forEach((sum, idx) => {
      const card = document.createElement("div");
      card.className = "ac-summary";

      if (summaries.length > 1) {
        const bits = [`Summary ${idx + 1} of ${summaries.length}`];
        if (sum._agentName) bits.push(`Agent: ${sum._agentName}`);
        const l = document.createElement("div");
        l.className = "ac-sum-label";
        l.textContent = bits.join(" \u2014 ");
        card.append(l);
      } else if (sum._agentName) {
        const l = document.createElement("div");
        l.className = "ac-sum-label";
        l.textContent = `Agent: ${sum._agentName}`;
        card.append(l);
      }

      /** A field, with the edit promoted and the original struck through under it. */
      const renderField = (label, original, edited) => {
        const origText = fieldText(original);
        const editText = hasEdited(edited) ? fieldText(edited) : null;
        if (!origText && !editText) return;

        if (editText) {
          const w = document.createElement("div");
          w.className = "ac-sum-field";
          w.innerHTML =
            `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(editText)} `
            + '<span class="ac-edited" title="Edited by agent">\u270f\ufe0f Edited</span>';
          card.append(w);
          if (origText && origText !== editText) {
            const o = document.createElement("div");
            o.className = "ac-sum-field is-original";
            o.innerHTML =
              `<strong>Original:</strong> <span class="ac-strike">${escapeHtml(origText)}</span>`;
            card.append(o);
          }
        } else {
          const r = document.createElement("div");
          r.className = "ac-sum-field";
          r.innerHTML = `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(origText)}`;
          card.append(r);
        }
      };

      /** A field plus the description and outcome that ride alongside it. */
      const renderTopic = (label, original, edited) => {
        renderField(label, original, edited);
        if (original && typeof original === "object") {
          if (original.description) {
            const d = document.createElement("div");
            d.className = "ac-sum-field is-sub";
            d.textContent = original.description;
            card.append(d);
          }
          if (original.outcome) {
            const o = document.createElement("div");
            o.className = "ac-sum-field is-sub";
            o.innerHTML = `<strong>Outcome:</strong> ${escapeHtml(original.outcome)}`;
            card.append(o);
          }
        }
      };

      const headline = fieldText(sum.headline);
      if (headline) {
        const h = document.createElement("div");
        h.className = "ac-sum-headline";
        h.textContent = headline;
        card.append(h);
      }

      renderTopic("Reason", sum.reason, sum.editedReason);
      renderTopic("Resolution", sum.resolution, sum.editedResolution);
      renderTopic("Followup", sum.followup, sum.editedFollowup);

      const editedText = hasEdited(sum.editedSummary) ? fieldText(sum.editedSummary) : null;

      // Anything Copilot returned that is not part of the known set.
      const known = new Set([
        "id", "text", "description", "confidence", "status", "mediaType",
        "language", "headline", "reason", "resolution", "followup",
        "editedSummary", "editedReason", "editedResolution", "editedFollowup",
        "predictedWrapupCodes", "dateCreated", "extractedEntities",
        "communication", "communicationId", "participants", "selfUri",
        "conversation", "_agentName",
      ]);
      for (const [key, val] of Object.entries(sum)) {
        if (known.has(key)) continue;
        if (!fieldText(val)) continue;
        const editedKey = `edited${key.charAt(0).toUpperCase()}${key.slice(1)}`;
        renderTopic(key.charAt(0).toUpperCase() + key.slice(1), val, sum[editedKey]);
        known.add(editedKey);
      }

      const fullText = fieldText(sum.text) || fieldText(sum.description);
      if (editedText) {
        const t = document.createElement("div");
        t.className = "ac-sum-text";
        t.innerHTML = `${escapeHtml(editedText)} `
          + '<span class="ac-edited" title="Edited by agent">\u270f\ufe0f Edited</span>';
        card.append(t);
        if (fullText && fullText !== editedText) {
          const o = document.createElement("div");
          o.className = "ac-sum-text is-original";
          o.innerHTML =
            `<strong>Original:</strong> <span class="ac-strike">${escapeHtml(fullText)}</span>`;
          card.append(o);
        }
      } else if (fullText) {
        const t = document.createElement("div");
        t.className = "ac-sum-text";
        t.textContent = fullText;
        card.append(t);
      }

      if (sum.status) {
        const m = document.createElement("div");
        m.className = "ac-meta";
        m.textContent = `Status: ${sum.status}`;
        card.append(m);
      }

      if (Array.isArray(sum.predictedWrapupCodes) && sum.predictedWrapupCodes.length) {
        const w = document.createElement("div");
        w.className = "ac-sum-field";
        w.innerHTML = "<strong>Suggested wrapup:</strong> "
          + escapeHtml(sum.predictedWrapupCodes.map((c) => c.name).filter(Boolean).join(", "));
        card.append(w);
      }

      wrap.append(card);
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
