/**
 * Dashboards › Quality › Evaluation Coverage
 *
 * See docs/dashboards-quality-design.md §6.
 *
 * The question: are we evaluating enough, evenly, and are evaluators keeping up?
 *
 * Backed entirely by pre-computed aggregates and the quality activity
 * listings, so it has no date-range limit — unlike the other two pages, which
 * lean on quality/evaluations/search and its 3-month cap.
 *
 *   POST /api/v2/analytics/evaluations/aggregates/query   tiles, trend, bands
 *   GET  /api/v2/quality/evaluators/activity              evaluator workload
 *   POST /api/v2/analytics/conversations/aggregates/query the coverage
 *                                                         denominator (§6.3)
 *
 * Nothing here writes, so there is no Activity Log entry: logAction is for
 * mutations, and reading a dashboard is not one.
 */

import { createEvaluationFilters } from "../../../components/evaluationFilters.js";
import {
  toAggregateQuery, parseGroupedAggregate, parseAggregateTotal,
  parseAggregateSeries, statsMapToSorted,
} from "../../../lib/evaluationQuery.js";
import {
  queryEvaluationAggregates, fetchEvaluatorActivity,
} from "../../../services/genesysApi.js";
import { dayCount, formatRange } from "../../../utils/dateRanges.js";
import { makeStatus, escapeHtml } from "../../../utils.js";

/**
 * Daily buckets up to about two months, weekly beyond.
 *
 * A year at P1D is 365 columns in a 700px panel — under three pixels each,
 * which is noise rather than a trend.
 */
function pickGranularity(from, to) {
  return dayCount(from, to) <= 62 ? "P1D" : "P1W";
}

/** Short id, for when a name cannot be resolved. */
function shortId(id) {
  return typeof id === "string" && id.length > 8 ? `${id.slice(0, 8)}…` : String(id ?? "");
}

export default function renderCoverage({ me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h1 class="h1">Dashboards — Quality — Evaluation Coverage</h1>
    <hr class="hr">

    <p class="page-desc">
      How much quality evaluation is actually happening: how many evaluations
      were completed, how they are spread across queues, forms, agents and
      evaluators, and whether evaluators are keeping up with what they have
      been assigned.
    </p>
    <p class="page-desc dq-perm-note">
      Needs <code>analytics:evaluationAggregate:view</code> and
      <code>quality:evaluation:view</code>. Note that
      <code>analytics:evaluationAggregate:view</code> is on the Hourly
      Interacting disqualifying list — granting it makes that user ineligible
      for an Hourly Interacting licence.
    </p>

    <div data-c="filters"></div>

    <div class="cs-actions">
      <button class="btn" data-c="load">Load dashboard</button>
    </div>

    <div class="cs-status" data-c="status" style="display:none"></div>

    <div data-c="results" hidden>
      <div class="dq-range-line" data-c="rangeLine"></div>

      <div class="dq-tiles" data-c="tiles"></div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Evaluations over time</h3>
        <p class="dq-panel-sub" data-c="trendSub"></p>
        <div class="dq-trend" data-c="trend"></div>
        <div class="dq-trend-axis" data-c="trendAxis"></div>
      </div>

      <div class="dq-grid-2">
        <div class="dq-panel">
          <h3 class="dq-panel-title">By queue</h3>
          <p class="dq-panel-sub">Evaluations completed, per queue.</p>
          <div class="dq-bars" data-c="byQueue"></div>
        </div>
        <div class="dq-panel">
          <h3 class="dq-panel-title">By form</h3>
          <p class="dq-panel-sub">Evaluations completed, per evaluation form.</p>
          <div class="dq-bars" data-c="byForm"></div>
        </div>
      </div>

      <div class="dq-grid-2">
        <div class="dq-panel">
          <h3 class="dq-panel-title">By agent</h3>
          <p class="dq-panel-sub" data-c="byAgentSub">Evaluations per agent — the top 25.</p>
          <div class="dq-bars" data-c="byAgent"></div>
        </div>
        <div class="dq-panel">
          <h3 class="dq-panel-title">By evaluator</h3>
          <p class="dq-panel-sub">Evaluations completed, per evaluator — the top 25.</p>
          <div class="dq-bars" data-c="byEvaluator"></div>
        </div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Evaluator workload</h3>
        <p class="dq-panel-sub">
          Assigned against completed, from the quality domain rather than the
          aggregates — so it counts work allocated, including what has not been
          done yet.
        </p>
        <div class="dq-table-wrap">
          <table class="dq-table">
            <thead>
              <tr>
                <th>Evaluator</th>
                <th class="is-num">Assigned</th>
                <th class="is-num">Started</th>
                <th class="is-num">Completed</th>
                <th class="is-num">Outstanding</th>
                <th class="is-num">Calibrations assigned</th>
                <th class="is-num">Calibrations completed</th>
              </tr>
            </thead>
            <tbody data-c="evaluatorRows"></tbody>
          </table>
        </div>
        <div class="dq-panel-note" data-c="evaluatorNote" hidden></div>
      </div>
    </div>
  `;

  const $ = (n) => el.querySelector(`[data-c="${n}"]`);
  const $status = $("status");
  const $results = $("results");
  const $loadBtn = $("load");

  const applyStatus = makeStatus($status, "cs-status");
  function setStatus(msg, type = "") {
    applyStatus(msg, type);
    $status.style.display = "";
  }
  function hideStatus() { $status.style.display = "none"; }

  // Resolved on each load, never captured at render: switching org in the
  // header must not leave this page querying the previous customer while
  // labelling the results with the previous customer's name.
  const currentOrg = () => orgContext?.getDetails?.() || null;

  const filters = createEvaluationFilters({ api, showTimeBasis: true });
  $("filters").append(filters.el);

  // ── Option loading, per org ─────────────────────────
  let optionsOrgId = null;
  async function ensureOptions(orgId) {
    if (optionsOrgId === orgId) return [];
    const warnings = await filters.loadOptions(orgId);
    optionsOrgId = orgId;
    return warnings;
  }

  // The org can change under the page from the header dropdown. Reload the
  // dropdowns when it does, rather than offering the previous customer's
  // queues as filters for this one.
  const unsubscribe = orgContext?.onChange?.(() => {
    optionsOrgId = null;
    $results.hidden = true;
  });
  if (unsubscribe) el.__destroy = unsubscribe;

  // ── Rendering helpers ───────────────────────────────

  function tile(label, value, sub) {
    const empty = value == null;
    return `
      <div class="dq-tile">
        <div class="dq-tile-label">${escapeHtml(label)}</div>
        <div class="dq-tile-value${empty ? " is-empty" : ""}">${empty ? "—" : escapeHtml(value)}</div>
        ${sub ? `<div class="dq-tile-sub">${escapeHtml(sub)}</div>` : ""}
      </div>`;
  }

  /**
   * Horizontal bars. Widths are relative to the largest value, so the longest
   * bar always fills the track — a chart scaled to an absolute maximum reads
   * as empty whenever the numbers are small, which for evaluation counts is
   * most of the time.
   */
  function renderBars(container, rows, { fill = "", limit = 25, format } = {}) {
    container.innerHTML = "";
    if (!rows.length) {
      container.innerHTML = `<div class="dq-bar-empty">No evaluations in this period.</div>`;
      return;
    }
    const shown = rows.slice(0, limit);
    const max = Math.max(...shown.map((r) => r.value || 0), 0);
    for (const row of shown) {
      const pct = max > 0 ? ((row.value || 0) / max) * 100 : 0;
      const el2 = document.createElement("div");
      el2.className = "dq-bar-row";
      el2.innerHTML = `
        <span class="dq-bar-label" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span>
        <div class="dq-bar-track"><div class="dq-bar-fill ${fill}" style="width:${pct}%"></div></div>
        <span class="dq-bar-value">${escapeHtml(format ? format(row) : String(row.value))}</span>`;
      container.append(el2);
    }
    if (rows.length > limit) {
      const more = document.createElement("div");
      more.className = "dq-bar-empty";
      more.textContent = `…and ${rows.length - limit} more.`;
      container.append(more);
    }
  }

  function renderTrend(points) {
    const $trend = $("trend");
    const $axis = $("trendAxis");
    $trend.innerHTML = "";
    $axis.innerHTML = "";
    if (!points.length) {
      $trend.innerHTML = `<div class="dq-bar-empty">No evaluations in this period.</div>`;
      return;
    }
    const max = Math.max(...points.map((p) => p.stats.count), 0);
    for (const p of points) {
      const col = document.createElement("div");
      col.className = "dq-trend-col";
      const h = max > 0 ? (p.stats.count / max) * 100 : 0;
      col.style.height = `${Math.max(h, p.stats.count > 0 ? 2 : 0)}%`;
      const day = (p.interval || "").slice(0, 10);
      col.title = `${day}: ${p.stats.count.toLocaleString()}`;
      $trend.append(col);
    }
    const first = (points[0].interval || "").slice(0, 10);
    const last = (points[points.length - 1].interval || "").slice(0, 10);
    $axis.innerHTML = `<span>${escapeHtml(first)}</span><span>peak ${max.toLocaleString()}</span><span>${escapeHtml(last)}</span>`;
  }

  /** Map a grouped aggregate into labelled, sorted bar rows. */
  function toRows(map, lookup, { unknownLabel = "Unknown" } = {}) {
    return statsMapToSorted(map, "count").map(({ key, stats, value }) => ({
      key,
      label: lookup?.get(key) || (key ? `${unknownLabel} (${shortId(key)})` : unknownLabel),
      value,
      stats,
    }));
  }

  // ── Load ────────────────────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const org = currentOrg();
    if (!org) {
      setStatus("Please select a customer org from the dropdown above.", "error");
      return;
    }
    if (!filters.isValid()) {
      setStatus("Fix the date range before loading.", "error");
      return;
    }

    $loadBtn.disabled = true;
    filters.setEnabled(false);
    $results.hidden = true;
    setStatus("Loading filter options…");

    try {
      const optionWarnings = await ensureOptions(org.id);
      const f = filters.getFilters();
      const lookups = filters.getLookups();

      setStatus("Querying evaluation aggregates…");

      const granularity = pickGranularity(f.from, f.to);
      const q = (opts) => queryEvaluationAggregates(api, org.id, toAggregateQuery(f, opts));

      // One fan-out of parallel proxy calls from the browser, in the shape
      // export/interactions/totals.js uses. Deliberately not one server call
      // assembling the page: every /api request dies at 45 seconds, and these
      // are independent.
      const [
        totalResp, releasedResp, systemResp, trendResp,
        queueResp, formResp, agentResp, evaluatorResp,
      ] = await Promise.all([
        q({ metrics: ["nEvaluations"] }),
        q({ metrics: ["nEvaluations"], groupBy: ["released"] }),
        q({ metrics: ["nEvaluations"], groupBy: ["systemSubmitted"] }),
        q({ metrics: ["nEvaluations"], granularity }),
        q({ metrics: ["nEvaluations"], groupBy: ["queueId"] }),
        q({ metrics: ["nEvaluations"], groupBy: ["contextId"] }),
        q({ metrics: ["nEvaluations"], groupBy: ["userId"] }),
        q({ metrics: ["nEvaluations"], groupBy: ["evaluatorId"] }),
      ]);

      const total = parseAggregateTotal(totalResp).count;
      const releasedMap = parseGroupedAggregate(releasedResp, "released");
      const systemMap = parseGroupedAggregate(systemResp, "systemSubmitted");
      const agentMap = parseGroupedAggregate(agentResp, "userId");

      // ── Tiles ─────────────────────────────────────
      const released = releasedMap.get("true")?.count || 0;
      const aiCount = systemMap.get("true")?.count || 0;
      const humanCount = systemMap.get("false")?.count || 0;
      const agentsEvaluated = agentMap.size;

      setStatus("Working out how many agents could have been evaluated…");
      const denominator = await fetchAgentDenominator(org.id, f);

      const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : null);

      $("tiles").innerHTML = [
        tile("Evaluations", total.toLocaleString(),
          f.timeBasis === "conversation" ? "by conversation date" : `by ${f.timeBasis} date`),
        tile("Agents evaluated", agentsEvaluated.toLocaleString(),
          denominator.value != null
            ? `${pct(agentsEvaluated, denominator.value)} of ${denominator.value.toLocaleString()} ${denominator.label}`
            : denominator.note),
        tile("Evaluations per agent",
          agentsEvaluated > 0 ? (total / agentsEvaluated).toFixed(1) : null,
          "among agents who were evaluated"),
        tile("Released", pct(released, total),
          `${released.toLocaleString()} of ${total.toLocaleString()}`),
        tile("AI-scored", total > 0 ? pct(aiCount, aiCount + humanCount) : null,
          `${aiCount.toLocaleString()} AI · ${humanCount.toLocaleString()} human`),
      ].join("");

      // ── Trend ─────────────────────────────────────
      $("trendSub").textContent =
        `${granularity === "P1D" ? "Daily" : "Weekly"} buckets · ${formatRange(f.from, f.to)}`;
      renderTrend(parseAggregateSeries(trendResp));

      // ── Bands ─────────────────────────────────────
      const fmtCount = (r) => r.value.toLocaleString();

      renderBars($("byQueue"),
        toRows(parseGroupedAggregate(queueResp, "queueId"), lookups.queues,
          { unknownLabel: "No queue" }),
        { format: fmtCount });

      renderBars($("byForm"),
        toRows(parseGroupedAggregate(formResp, "contextId"), lookups.forms,
          { unknownLabel: "Unknown form" }),
        { format: fmtCount });

      renderBars($("byAgent"),
        toRows(agentMap, lookups.agents, { unknownLabel: "Unknown user" }),
        { format: fmtCount });

      renderBars($("byEvaluator"),
        toRows(parseGroupedAggregate(evaluatorResp, "evaluatorId"), lookups.agents,
          { unknownLabel: "Unknown user" }),
        { fill: "dq-fill-alt", format: fmtCount });

      $("byAgentSub").textContent =
        `Evaluations per agent — the top 25 of ${agentsEvaluated.toLocaleString()}.`;

      // ── Evaluator workload ────────────────────────
      setStatus("Loading evaluator activity…");
      const workloadWarning = await renderEvaluatorWorkload(org.id, f);

      // ── Range line and warnings ───────────────────
      $("rangeLine").textContent =
        `${formatRange(f.from, f.to)} · ${total.toLocaleString()} evaluations`;

      $results.hidden = false;
      const warnings = [...optionWarnings, ...(denominator.warning ? [denominator.warning] : []),
        ...(workloadWarning ? [workloadWarning] : [])];
      if (warnings.length) setStatus(warnings.join(" "), "error");
      else hideStatus();
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $loadBtn.disabled = false;
      filters.setEnabled(true);
    }
  });

  /**
   * The denominator for "agents evaluated" — §6.3 of the design.
   *
   * Evaluation data cannot know how many agents COULD have been evaluated, so
   * the honest denominator is agents who handled an interaction in the period,
   * which comes from the conversation aggregate domain.
   *
   * That domain needs `analytics:conversationDetail:view`, which is NOT part of
   * this page's gate. When it is missing the tile falls back to a bare count
   * rather than failing the page — a coverage percentage nobody is entitled to
   * see is not a reason to withhold the evaluation counts.
   */
  async function fetchAgentDenominator(orgId, f) {
    try {
      const body = {
        interval: `${f.from}T00:00:00.000Z/${f.to}T23:59:59.999Z`,
        metrics: ["nConversations"],
        groupBy: ["userId"],
      };
      const resp = await api.proxyGenesys(orgId, "POST",
        "/api/v2/analytics/conversations/aggregates/query", { body });
      const handled = new Set();
      for (const row of resp?.results || []) {
        const id = row.group?.userId;
        if (id) handled.add(id);
      }
      if (!handled.size) {
        return { value: null, note: "no interaction data for this period", warning: null };
      }
      return { value: handled.size, label: "agents who handled interactions", warning: null };
    } catch (err) {
      const denied = err.status === 403;
      return {
        value: null,
        note: denied ? "coverage % needs analytics:conversationDetail:view" : "denominator unavailable",
        warning: denied
          ? "Coverage percentage hidden: it needs analytics:conversationDetail:view, which this page does not require."
          : `Could not work out the agent denominator: ${err.message}`,
      };
    }
  }

  /** Evaluator workload table, from the quality domain. */
  async function renderEvaluatorWorkload(orgId, f) {
    const $rows = $("evaluatorRows");
    const $note = $("evaluatorNote");
    $rows.innerHTML = "";
    $note.hidden = true;

    try {
      const query = {
        startTime: `${f.from}T00:00:00.000Z`,
        endTime: `${f.to}T23:59:59.999Z`,
      };
      // The endpoint takes ONE team id, not a list, so a multi-team filter
      // cannot be pushed down. Applied only when exactly one team is selected;
      // otherwise the table is org-wide and says so.
      if (f.teamIds.length === 1) query.agentTeamId = f.teamIds[0];

      const rows = await fetchEvaluatorActivity(api, orgId, { query });
      const sorted = rows
        .map((r) => ({
          name: r.evaluator?.name || r.name || shortId(r.id),
          assigned: r.numEvaluationsAssigned || 0,
          started: r.numEvaluationsStarted || 0,
          completed: r.numEvaluationsCompleted || 0,
          calAssigned: r.numCalibrationsAssigned || 0,
          calCompleted: r.numCalibrationsCompleted || 0,
          hidden: r.numEvaluationsWithoutViewPermission || 0,
        }))
        .filter((r) => r.assigned || r.started || r.completed || r.calAssigned)
        .sort((a, b) => b.assigned - a.assigned);

      if (!sorted.length) {
        $rows.innerHTML = `<tr><td colspan="7" class="dq-bar-empty">No evaluator activity in this period.</td></tr>`;
        return null;
      }

      for (const r of sorted) {
        const outstanding = Math.max(r.assigned - r.completed, 0);
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(r.name)}</td>
          <td class="is-num">${r.assigned.toLocaleString()}</td>
          <td class="is-num">${r.started.toLocaleString()}</td>
          <td class="is-num">${r.completed.toLocaleString()}</td>
          <td class="is-num">${outstanding.toLocaleString()}</td>
          <td class="is-num">${r.calAssigned.toLocaleString()}</td>
          <td class="is-num">${r.calCompleted.toLocaleString()}</td>`;
        $rows.append(tr);
      }

      // Surfaced rather than dropped: a non-zero value means every number on
      // this page is a subset of what happened, and a dashboard that quietly
      // under-reports is worse than one that says so.
      const hidden = sorted.reduce((s, r) => s + r.hidden, 0);
      if (hidden > 0) {
        $note.textContent =
          `${hidden.toLocaleString()} evaluation(s) are not visible to you and are excluded from these figures.`;
        $note.hidden = false;
      }
      if (f.teamIds.length > 1) {
        $note.textContent = `${$note.textContent} This table is org-wide: the evaluator activity endpoint accepts only one team at a time.`.trim();
        $note.hidden = false;
      }
      return null;
    } catch (err) {
      $rows.innerHTML = `<tr><td colspan="7" class="dq-bar-empty">Evaluator activity unavailable.</td></tr>`;
      return `Could not load evaluator activity: ${err.message}`;
    }
  }

  return el;
}
