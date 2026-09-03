/**
 * Dashboards › Quality › Evaluation Gaps
 *
 * See docs/dashboards-quality-design.md §14.
 *
 * The individual interactions that should have been evaluated and were not,
 * one row each, with the reason.
 *
 * EVERYTHING IS READ, NOTHING IS INFERRED. The design went through three rounds
 * of me claiming a figure was unobtainable and Thomas pointing out it was not —
 * each time because I had checked one level of the response and stopped:
 *
 *   AnalyticsSession.recording          a boolean on the SESSION, not the
 *                                       segment I had looked at
 *   conversation.evaluations[]          the evaluations ride on the row, with
 *                                       the agent AND the queue, so "was this
 *                                       evaluated" needs no reconciliation
 *   session.segments[] ordering         settles agentToScore: Last, because we
 *                                       are reading rows anyway
 *   transcript aggregate by conversationId   the analysed set, to diff against
 *
 * SEPARATE FROM STA CONFIGURATION (§13) because they are separate costs. That
 * page reads configuration and is instant at any org size; this walks
 * conversation rows and scales with volume. Pairing them would make the cheap
 * half wait for the expensive one.
 *
 * NOTHING LOADS ON ARRIVAL. The count is fetched first and reported, and the
 * walk only starts when asked for — §14.3.
 *
 * Read-only, so no Activity Log entry.
 */

import {
  fetchPrograms, fetchUnpublishedPrograms, fetchProgramMappings,
  fetchAgentScoringRules, fetchTranscriptionSettings, fetchAllQueues,
  fetchRolesWithPermission, fetchRoleUsers, fetchAllUsers,
  countConversationDetails, queryConversationDetails, queryTranscriptAggregates,
} from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import {
  RANGE_PRESETS, resolvePreset, latestSelectableDay, utcIso, yesterday,
  formatRange, dayCount,
} from "../../../utils/dateRanges.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";
import { makeStatus, escapeHtml } from "../../../utils.js";

const PARTICIPATE_PERMISSION = "quality:evaluation:participate";

/** How many pages of 100 conversations to walk before stopping and saying so. */
const MAX_PAGES = 40;

/**
 * The reasons, in the order the chain breaks (§13.2).
 *
 * Order is the whole design of this list: an interaction can fail several
 * links at once, and reporting the FIRST one is what makes the answer
 * actionable. A call that was never recorded is not also "not transcribed" in
 * any useful sense — the recording is the thing to fix.
 */
const REASONS = Object.freeze([
  { key: "noPermission", label: "Agent lacks Participate", fill: "dq-fill-bad",
    hint: "The agent does not hold quality:evaluation:participate, so no evaluation "
      + "can be created against them at all." },
  { key: "noProgram", label: "No program covers the queue", fill: "dq-fill-bad",
    hint: "Nothing maps this queue to a Speech and Text Analytics program, so no "
      + "scoring rule can fire." },
  { key: "noRule", label: "No live scoring rule", fill: "dq-fill-bad",
    hint: "The covering program has no enabled and published Agent Scoring Rule." },
  { key: "queueTranscriptionOff", label: "Queue transcription off", fill: "dq-fill-bad",
    hint: "The queue has voice transcription switched off, so nothing here is "
      + "transcribed and nothing can be AI scored." },
  { key: "notRecorded", label: "Not recorded", fill: "dq-fill-warn",
    hint: "No audio recording was started, so there was nothing to transcribe." },
  { key: "tooShort", label: "Shorter than the threshold", fill: "dq-fill-warn",
    hint: "The agent was on the interaction for less than the threshold set above." },
  { key: "notTranscribed", label: "Not transcribed", fill: "dq-fill-warn",
    hint: "Recorded and long enough, but speech and text analytics produced no "
      + "transcript for it." },
  { key: "notScoredAgent", label: "Another agent was the one scored", fill: "dq-fill-alt",
    hint: "The rule scores only the first or last agent on a conversation, and this "
      + "was not that agent. Working as configured." },
  { key: "unexplained", label: "Unexplained", fill: "dq-fill-bad",
    hint: "Everything checked was in order and there is still no evaluation. This is "
      + "the row worth investigating." },
]);

const REASON_BY_KEY = new Map(REASONS.map((r) => [r.key, r]));

function secs(ms) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 16)
    : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit",
                                    minute: "2-digit" });
}

export default function renderEvaluationGaps({ me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h1 class="h1">Dashboards — Quality — Evaluation Gaps</h1>
    <hr class="hr">

    <p class="page-desc">
      The individual interactions that should have been evaluated and were not,
      with the reason for each. Every reason is read from the interaction or
      from your configuration — none of it is guessed. Configuration itself
      lives on STA Configuration; this page is about what that configuration
      cost you.
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
          <label class="cs-label">Queues</label>
          <div data-c="queuePicker"></div>
        </div>
        <div class="cs-control-group">
          <label class="cs-label">Too short below (seconds)</label>
          <input class="input" type="number" min="0" max="600" step="5"
                 value="30" style="width:110px" data-c="threshold">
        </div>
      </div>
    </div>

    <div class="cs-actions">
      <button class="btn" data-c="count">Count interactions</button>
      <button class="btn btn-primary" data-c="find" disabled>Find gaps</button>
    </div>

    <div class="cs-status" data-c="status" style="display:none"></div>

    <div data-c="results" hidden>
      <div class="dq-range-line" data-c="rangeLine"></div>
      <div class="dq-tiles" data-c="tiles"></div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Why they were not evaluated</h3>
        <p class="dq-panel-sub">
          The first broken link for each one. An interaction can fail several
          checks at once; the earliest is the one to fix.
        </p>
        <div class="dq-bars" data-c="reasons"></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">The interactions</h3>
        <p class="dq-panel-sub" data-c="tableSub"></p>
        <div class="cs-control-group">
          <label class="cs-label">Show</label>
          <select class="input" data-c="reasonFilter"></select>
        </div>
        <div class="is-hint">
          Tip: Right-click a row to copy the Conversation ID to clipboard.
        </div>
        <div class="dq-table-wrap has-filters" data-c="rowsWrap">
          <table class="dq-table" data-c="rows"></table>
        </div>
        <div class="dq-panel-note" data-c="tableNote" hidden></div>
      </div>
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

  // ── Filters ─────────────────────────────────────────
  $("from").value = yesterday();
  $("to").value = yesterday();
  $("from").max = latestSelectableDay();
  $("to").max = latestSelectableDay();

  // Only the short presets. This page reads conversation rows, so offering
  // "Last 12 Months" would offer a walk nobody should start by accident.
  for (const preset of RANGE_PRESETS.filter(
    (x) => ["today", "yesterday", "thisWeek", "lastWeek"].includes(x.key))) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm dq-preset";
    btn.textContent = preset.label;
    btn.dataset.preset = preset.key;
    btn.addEventListener("click", () => {
      const r = resolvePreset(preset.key);
      if (!r) return;
      $("from").value = r.from;
      $("to").value = r.to;
      for (const b of $("presets").children) b.classList.toggle("is-on", b === btn);
      invalidate();
    });
    $("presets").append(btn);
  }

  const queuePicker = createMultiSelect({
    placeholder: "Loading queues…",
    onChange: invalidate,
  });
  $("queuePicker").append(queuePicker.el);
  queuePicker.setEnabled(false);

  $("threshold").addEventListener("change", invalidate);
  $("from").addEventListener("change", invalidate);
  $("to").addEventListener("change", invalidate);

  /** Any filter change invalidates a count, because the count was of the old scope. */
  function invalidate() {
    counted = null;
    $("find").disabled = true;
    $results.hidden = true;
  }

  // ── Config, loaded once per org ─────────────────────
  let config = null;
  let counted = null;
  let configOrgId = null;

  async function loadConfig(orgId) {
    if (configOrgId === orgId && config) return config;
    setStatus("Reading configuration…");

    const [progRes, unpubRes, mapRes, queueRes, settingsRes, usersRes] =
      await Promise.allSettled([
        fetchPrograms(api, orgId),
        fetchUnpublishedPrograms(api, orgId),
        fetchProgramMappings(api, orgId),
        fetchAllQueues(api, orgId),
        fetchTranscriptionSettings(api, orgId),
        fetchAllUsers(api, orgId, { query: { state: "active" } }),
      ]);
    const val = (r) => (r.status === "fulfilled" ? r.value : null);

    const programs = val(progRes) || [];
    const unpublished = new Set((val(unpubRes) || []).map((p) => p.id));
    const mappings = val(mapRes) || [];
    const queues = val(queueRes) || [];
    const mode = val(settingsRes)?.transcription || null;
    const users = val(usersRes) || [];

    // queueId → the program covering it, and that program's live rules.
    const programOfQueue = new Map();
    const mapOf = new Map();
    for (const m of mappings) {
      const id = m.program?.id;
      if (!id) continue;
      const queueIds = (m.queues || []).map((q) => q.id).filter(Boolean);
      mapOf.set(id, queueIds);
      for (const qid of queueIds) if (!programOfQueue.has(qid)) programOfQueue.set(qid, id);
    }

    const ruleResults = await Promise.allSettled(
      programs.map((p) => fetchAgentScoringRules(api, orgId, p.id)));
    const liveRulesOf = new Map();
    programs.forEach((p, i) => {
      const r = ruleResults[i];
      if (r.status !== "fulfilled") return;
      liveRulesOf.set(p.id, (r.value || []).filter((x) => x.enabled && x.published));
    });

    // Agents who may be evaluated at all.
    let participants = null;
    try {
      const roles = await fetchRolesWithPermission(api, orgId, PARTICIPATE_PERMISSION);
      const lists = await Promise.all(roles.map((r) => fetchRoleUsers(api, orgId, r.id)));
      participants = new Set(lists.flat().map((u) => u.id).filter(Boolean));
    } catch {
      // Without the role lookup the permission reason cannot be told from the
      // others, so it is left out entirely rather than guessed at.
      participants = null;
    }

    config = {
      programs, unpublished, mapOf, programOfQueue, liveRulesOf, mode,
      queueById: new Map(queues.map((q) => [q.id, q])),
      userName: new Map(users.map((u) => [u.id, u.name || u.email || u.id])),
      coveredQueueIds: [...programOfQueue.keys()],
      participants,
    };
    configOrgId = orgId;
    return config;
  }

  async function primeQueues() {
    const org = currentOrg();
    if (!org) {
      queuePicker.setPlaceholder("Select a customer org first");
      queuePicker.setEnabled(false);
      $("count").disabled = true;
      setStatus("Please select a customer org from the dropdown above to get started.");
      return;
    }
    $("count").disabled = false;
    hideStatus();
    try {
      const c = await loadConfig(org.id);
      // EVERY queue is offered, not just the covered ones, and the covered ones
      // are pre-selected. "No program covers this queue" is the first link in
      // the chain and a real reason an agent goes unevaluated - scoping the
      // picker to covered queues would make it unreachable by construction.
      const items = [...c.queueById.values()]
        .map((q) => ({ id: q.id, label: q.name || q.id }))
        .sort((a, b) => a.label.localeCompare(b.label));
      if (!items.length) {
        queuePicker.setPlaceholder("No queues");
        queuePicker.setEnabled(false);
        return;
      }
      queuePicker.setItems(items);
      queuePicker.setSelected(c.coveredQueueIds.length
        ? c.coveredQueueIds : items.map((i) => i.id));
      queuePicker.setPlaceholder("Select queues");
      queuePicker.setEnabled(true);
      if (!c.coveredQueueIds.length) {
        setStatus("No queue is mapped to a Speech and Text Analytics program, so nothing "
          + "on any of them can be automatically evaluated. STA Configuration shows the "
          + "mappings.", "error");
      } else {
        hideStatus();
      }
    } catch (err) {
      queuePicker.setPlaceholder("Queues could not be loaded");
      setStatus(`Configuration could not be read: ${err.message}`, "error");
    }
  }

  const unsubscribe = orgContext?.onChange?.(() => {
    config = null;
    configOrgId = null;
    invalidate();
    primeQueues();
  });
  el.__destroy = () => {
    unsubscribe?.();
    detachFilters?.();
  };

  primeQueues();

  // ── The query ───────────────────────────────────────

  function scope() {
    const from = $("from").value;
    const to = $("to").value;
    // getSelected() hands back a Set; everything downstream wants an array it
    // can map into predicates.
    const queueIds = [...queuePicker.getSelected()];
    return { from, to, queueIds, threshold: Number($("threshold").value) || 0 };
  }

  /**
   * Conversations on the chosen queues, agent segments only.
   *
   * `segmentFilters` carries queueId, userId and purpose together, which is
   * what lets one query cover every queue at once instead of one per queue.
   */
  function detailBody({ from, to, queueIds }) {
    return {
      interval: `${utcIso(from)}/${utcIso(to, true)}`,
      order: "asc",
      orderBy: "conversationStart",
      segmentFilters: [{
        type: "and",
        predicates: [{ dimension: "purpose", value: "agent" }],
        clauses: [{
          type: "or",
          predicates: queueIds.map((id) => ({ dimension: "queueId", value: id })),
        }],
      }],
    };
  }

  $("count").addEventListener("click", async () => {
    const org = currentOrg();
    if (!org) return;
    const s = scope();
    if (!s.queueIds.length) {
      setStatus("Select at least one queue.", "error");
      return;
    }
    if (s.from > s.to) {
      setStatus("The From date is after the To date.", "error");
      return;
    }
    $("count").disabled = true;
    setStatus("Counting interactions…");
    try {
      // Returns null when the response carried no usable totalHits - "could not
      // tell" rather than "none" - in which case the walk is still offered and
      // the cost simply is not known in advance.
      const total = await countConversationDetails(api, org.id, detailBody(s));
      counted = { ...s, total };
      if (total == null) {
        $("find").disabled = false;
        setStatus("The interaction count came back empty, so the cost is not known "
          + "in advance. Find gaps will read up to "
          + `${(MAX_PAGES * 100).toLocaleString()} interactions.`);
        return;
      }
      const pages = Math.min(Math.ceil(total / 100), MAX_PAGES);
      $("find").disabled = total === 0;
      setStatus(total === 0
        ? `No interactions on those queues in ${formatRange(s.from, s.to)}.`
        : `${total.toLocaleString()} interaction(s) in scope over ${
          dayCount(s.from, s.to)} day(s) — about ${pages} request(s) to walk them`
          + (total > MAX_PAGES * 100
            ? `. Only the first ${(MAX_PAGES * 100).toLocaleString()} will be read; `
              + "narrow the range or the queues for a complete answer." : "."));
    } catch (err) {
      setStatus(`Could not count: ${err.message}`, "error");
    } finally {
      $("count").disabled = false;
    }
  });

  $("find").addEventListener("click", async () => {
    const org = currentOrg();
    if (!org || !counted) return;
    const s = counted;

    $("find").disabled = true;
    $("count").disabled = true;
    $results.hidden = true;
    setStatus("Reading interactions…");

    try {
      const c = await loadConfig(org.id);

      const conversations = await queryConversationDetails(api, org.id, detailBody(s), {
        maxPages: MAX_PAGES,
        onProgress: (n) => setStatus(`Reading interactions… ${n.toLocaleString()} of ${
          s.total.toLocaleString()}`),
      });

      // Which of them speech and text analytics actually analysed. One grouped
      // aggregate rather than a call per conversation (§14.2).
      setStatus("Checking which were transcribed…");
      let transcribed = null;
      try {
        const resp = await queryTranscriptAggregates(api, org.id, {
          interval: `${utcIso(s.from)}/${utcIso(s.to, true)}`,
          groupBy: ["conversationId"],
          metrics: ["nSpeechTextAnalyzedConversations"],
          filter: {
            type: "or",
            predicates: s.queueIds.map((id) => ({ dimension: "queueId", value: id })),
          },
        });
        transcribed = new Set((resp?.results || [])
          .map((r) => r.group?.conversationId).filter(Boolean));
      } catch {
        // Without it the transcript reason cannot be distinguished; it is
        // dropped rather than guessed, and the table says so.
        transcribed = null;
      }

      const rows = classify(conversations, c, s, transcribed);
      render(rows, c, s, transcribed, conversations.length);

      $results.hidden = false;
      hideStatus();
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $("find").disabled = false;
      $("count").disabled = false;
    }
  });

  /**
   * One row per (interaction, agent) that has no evaluation.
   *
   * An agent who WAS evaluated on the interaction is not a gap and produces no
   * row at all — `conversation.evaluations[]` says so directly, matched on the
   * agent's userId, which is the whole reason a per-interaction verdict is
   * possible.
   */
  function classify(conversations, c, s, transcribed) {
    const rows = [];
    const thresholdMs = s.threshold * 1000;
    const wanted = new Set(s.queueIds);

    for (const conv of conversations) {
      const evaluatedUserIds = new Set(
        (conv.evaluations || []).filter((e) => !e.deleted).map((e) => e.userId));

      // RECORDING IS A PROPERTY OF THE CONVERSATION, NOT OF THE AGENT'S LEG.
      //
      // `AnalyticsSession.recording` is "flag determining if an audio recording
      // was started", and it is set on the leg that carries the audio - which is
      // the external one. Reading it only from the agent participant reported
      // recorded calls as unrecorded: Thomas found a row saying "Not recorded"
      // next to "Transcribed: Yes", which cannot both be true, since a
      // transcript needs audio. The contradiction was the tell.
      //
      // Any session on any participant carrying the flag means the interaction
      // was recorded, which is the granularity the question needs: was there
      // audio for speech and text analytics to work on.
      let recorded = false;
      for (const part of conv.participants || []) {
        for (const sess of part.sessions || []) {
          if (sess.recording) { recorded = true; break; }
        }
        if (recorded) break;
      }

      // Agent participants, with the queue segment they were on and how long.
      const agents = [];
      for (const part of conv.participants || []) {
        if (part.purpose !== "agent" || !part.userId) continue;
        let queueId = null;
        let ms = 0;
        let lastEnd = null;
        for (const sess of part.sessions || []) {
          for (const seg of sess.segments || []) {
            if (seg.queueId && wanted.has(seg.queueId)) queueId = seg.queueId;
            const a = Date.parse(seg.segmentStart || "");
            const b = Date.parse(seg.segmentEnd || "");
            if (!Number.isNaN(a) && !Number.isNaN(b) && b > a) {
              ms += b - a;
              if (lastEnd == null || b > lastEnd) lastEnd = b;
            }
          }
        }
        if (!queueId) continue;   // this agent was not on a queue we asked about
        agents.push({ userId: part.userId, queueId, ms, lastEnd });
      }
      if (!agents.length) continue;

      // Who the rule would score, when it scores only one of them.
      const ordered = [...agents].sort((a, b) => (a.lastEnd || 0) - (b.lastEnd || 0));
      const firstAgentId = ordered[0]?.userId;
      const lastAgentId = ordered[ordered.length - 1]?.userId;

      for (const a of agents) {
        if (evaluatedUserIds.has(a.userId)) continue;

        const programId = c.programOfQueue.get(a.queueId) || null;
        const liveRules = programId ? (c.liveRulesOf.get(programId) || []) : [];
        const rule = liveRules[0] || null;
        const queue = c.queueById.get(a.queueId);

        // First broken link in the chain wins — see REASONS.
        let reason;
        if (c.participants && !c.participants.has(a.userId)) reason = "noPermission";
        else if (!programId) reason = "noProgram";
        else if (!liveRules.length) reason = "noRule";
        else if (c.mode === "EnabledQueueFlow" && queue && queue.enableTranscription === false) {
          reason = "queueTranscriptionOff";
        } else if (!recorded) reason = "notRecorded";
        else if (thresholdMs > 0 && a.ms > 0 && a.ms < thresholdMs) reason = "tooShort";
        else if (transcribed && !transcribed.has(conv.conversationId)) reason = "notTranscribed";
        else if (rule && rule.agentToScore === "First" && a.userId !== firstAgentId) {
          reason = "notScoredAgent";
        } else if (rule && rule.agentToScore === "Last" && a.userId !== lastAgentId) {
          reason = "notScoredAgent";
        } else reason = "unexplained";

        rows.push({
          conversationId: conv.conversationId,
          when: conv.conversationStart,
          queue: queue?.name || a.queueId,
          agent: c.userName.get(a.userId) || a.userId,
          ms: a.ms,
          recorded,
          transcribed: transcribed ? transcribed.has(conv.conversationId) : null,
          reason,
        });
      }
    }
    return rows;
  }

  // ── Rendering ───────────────────────────────────────

  let allRows = [];
  let detachFilters = null;

  function render(rows, c, s, transcribed, convCount) {
    allRows = rows;

    const counts = new Map();
    for (const r of rows) counts.set(r.reason, (counts.get(r.reason) || 0) + 1);
    const unexplained = counts.get("unexplained") || 0;
    const expected = counts.get("notScoredAgent") || 0;

    $("rangeLine").textContent =
      `${formatRange(s.from, s.to)} · ${convCount.toLocaleString()} interaction(s) read`
      + (s.total != null && s.total > convCount ? ` of ${s.total.toLocaleString()}` : "");

    $("tiles").innerHTML = [
      tile("Interactions read", convCount.toLocaleString(),
        s.total != null && s.total > convCount
          ? `capped at ${(MAX_PAGES * 100).toLocaleString()}` : "all in scope"),
      tile("Missing evaluations", rows.length.toLocaleString(), "agent-interaction pairs"),
      tile("Working as configured", expected.toLocaleString(),
        "another agent was the one scored"),
      tile("Unexplained", unexplained.toLocaleString(),
        unexplained ? "nothing accounts for these" : "everything is accounted for"),
    ].join("");

    const bars = REASONS
      .map((r) => ({ ...r, count: counts.get(r.key) || 0 }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);
    const max = Math.max(...bars.map((b) => b.count), 0);
    $("reasons").innerHTML = bars.length
      ? bars.map((b) => `
        <div class="dq-bar-row">
          <span class="dq-bar-label" title="${escapeHtml(b.hint)}">${escapeHtml(b.label)}</span>
          <div class="dq-bar-track"><div class="dq-bar-fill ${b.fill}" style="width:${
            max ? (b.count / max) * 100 : 0}%"></div></div>
          <span class="dq-bar-value">${b.count.toLocaleString()}</span>
        </div>`).join("")
      : '<div class="dq-bar-empty">Every interaction read was evaluated. Nothing is missing.</div>';

    $("reasonFilter").innerHTML =
      `<option value="">All reasons (${rows.length.toLocaleString()})</option>` +
      bars.map((b) => `<option value="${b.key}">${escapeHtml(b.label)} (${b.count})</option>`)
        .join("");

    $("tableSub").textContent = transcribed
      ? "One row per agent who was on the interaction and has no evaluation for it."
      : "One row per agent who was on the interaction and has no evaluation for it. "
        + "Transcript status could not be read, so no row is attributed to a missing "
        + "transcript.";

    $("tableNote").hidden = !!transcribed;
    if (!transcribed) {
      $("tableNote").textContent =
        "The transcript aggregate could not be read (needs "
        + "analytics:speechAndTextAnalyticsAggregates:view), so “not transcribed” is "
        + "absent from the reasons and those interactions fall into Unexplained.";
    }

    drawTable();
  }

  /**
   * Clipboard fallback for contexts where the async API is unavailable — an
   * iframe, or a browser that has not granted clipboard-write. Same approach as
   * Interactions > Search, which is also where the right-click gesture and its
   * wording come from: a reader who has learnt it there should not have to
   * learn it again here.
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
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(id).catch(() => copyFallback(id));
    } else {
      copyFallback(id);
    }
    setStatus(`Copied: ${id}`, "success");
  }

  function tile(label, value, sub) {
    return `
      <div class="dq-tile">
        <div class="dq-tile-label">${escapeHtml(label)}</div>
        <div class="dq-tile-value">${escapeHtml(value)}</div>
        ${sub ? `<div class="dq-tile-sub">${escapeHtml(sub)}</div>` : ""}
      </div>`;
  }

  $("reasonFilter").addEventListener("change", drawTable);

  /**
   * Redraw, then re-attach the column filters.
   *
   * The whole table is rewritten on every reason change, so the previous
   * attachment is detached first: it registers a document-level listener and
   * would otherwise accumulate one per redraw, each bound to rows that are no
   * longer in the document.
   */
  function drawTable() {
    const pick = $("reasonFilter").value;
    const rows = pick ? allRows.filter((r) => r.reason === pick) : allRows;
    const shown = rows.slice(0, 500);
    const $t = $("rows");

    detachFilters?.();
    detachFilters = null;

    if (!rows.length) {
      $t.innerHTML = "";
      return;
    }

    // Agent leads: the reader is looking for a person, not a timestamp.
    // Duration rather than "Agent time" now that Time sits beside it — two
    // columns a glance apart called Time and Agent time is a reading error
    // waiting to happen.
    $t.innerHTML =
      "<thead><tr><th>Agent</th><th>Queue</th><th>Time</th>"
      + '<th class="is-num">Duration</th><th>Recorded</th><th>Transcribed</th>'
      + "<th>Why</th></tr></thead>"
      + `<tbody>${shown.map((r) => {
        const reason = REASON_BY_KEY.get(r.reason);
        const seconds = r.ms != null ? Math.round(r.ms / 1000) : "";
        return `<tr data-conversation="${escapeHtml(r.conversationId || "")}">
          <td>${escapeHtml(r.agent)}</td>
          <td>${escapeHtml(r.queue)}</td>
          <td data-value="${escapeHtml(r.when || "")}" title="${
            escapeHtml(r.conversationId || "")}">${escapeHtml(shortDate(r.when))}</td>
          <td class="is-num" data-value="${seconds}">${escapeHtml(secs(r.ms))}</td>
          <td>${r.recorded ? "Yes" : '<span class="dq-flag">No</span>'}</td>
          <td>${r.transcribed == null ? '<span class="dq-muted">—</span>'
            : r.transcribed ? "Yes" : '<span class="dq-flag">No</span>'}</td>
          <td title="${escapeHtml(reason?.hint || "")}">${escapeHtml(reason?.label || r.reason)}</td>
        </tr>`;
      }).join("")}</tbody>`;

    // One listener on the body rather than one per row: the table is redrawn on
    // every sort, filter and reason change, and per-row listeners would be
    // rebound each time.
    $t.addEventListener("contextmenu", (e) => {
      const tr = e.target?.closest?.("tbody tr");
      const id = tr?.dataset?.conversation;
      if (!id) return;
      e.preventDefault();
      copyConversationId(id);
    });

    // Time and Duration are both measured quantities — nearly one distinct value
    // per row — so both get a FROM/TO range rather than a list of checkboxes.
    // Time reads its real timestamp from data-value, since the displayed text is
    // formatted for people and does not parse back.
    detachFilters = attachColumnFilters($("rowsWrap"), {
      sortable: true,
      compact: true,
      numericCols: [3],
      rangeCols: [3],
      dateCols: [2],
    });

    if (rows.length > shown.length) {
      $("tableNote").textContent =
        `Showing the first ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()}. `
        + "Filter by reason, or narrow the date range.";
      $("tableNote").hidden = false;
    }
  }

  return el;
}
