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
  parseAggregateSeries, statsMapToSorted, hasScopeFilters,
  toSearchRequest, aggregateAcrossWindows, termAggregation, AI_FAILURE_LABELS,
} from "../../../lib/evaluationQuery.js";
import {
  queryEvaluationAggregates, fetchEvaluatorActivity,
  fetchRolesWithPermission, fetchRoleUsers, searchEvaluations,
} from "../../../services/genesysApi.js";
import { dayCount, formatRange, includesToday } from "../../../utils/dateRanges.js";
import { makeStatus, escapeHtml } from "../../../utils.js";

/**
 * Hourly for a day or two, daily up to about two months, weekly beyond.
 *
 * Each threshold is about column width. A year at P1D is 365 columns in a
 * 700px panel — under three pixels each, which is noise rather than a trend.
 * At the other end, "Today" at P1D is a single column: a chart with one bar,
 * which is not a chart. PT1H gives it 24.
 */
/**
 * A failure cause as a person would read it.
 *
 * Matched case-folded: the schema enumerates these in PascalCase and the live
 * API returns them lower-cased, so an exact-key lookup misses every time and
 * the raw value ("serviceerror") reaches the screen.
 */
const FAILURE_LABELS_LC = new Map(
  Object.entries(AI_FAILURE_LABELS).map(([k, v]) => [k.toLowerCase(), v]),
);

function failureLabel(raw) {
  if (!raw) return "Unknown";
  const hit = FAILURE_LABELS_LC.get(String(raw).toLowerCase());
  if (hit) return hit;
  const spaced = String(raw).replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function pickGranularity(from, to) {
  const days = dayCount(from, to);
  if (days <= 2) return "PT1H";
  return days <= 62 ? "P1D" : "P1W";
}

/** Human label for a granularity, for the sub-line under a chart title. */
function granularityLabel(g) {
  return g === "PT1H" ? "Hourly" : g === "P1D" ? "Daily" : "Weekly";
}

/**
 * The permission that makes an agent evaluatable at all.
 *
 * An agent can only be the subject of an evaluation if they hold this, so the
 * set of users who hold it IS the population a coverage figure should be
 * measured against — not "everyone active", and not "everyone who took a call".
 *
 * It does not appear in the Genesys OpenAPI spec, and that is expected rather
 * than suspicious: the spec lists permissions that gate API OPERATIONS, and
 * this one gates none — it is a capability flag the permission catalog carries.
 * `GET /api/v2/authorization/permissions` is the authority. Kept as a named
 * constant because it is the one string here that no machine-readable source
 * confirms.
 */
const PARTICIPATE_PERMISSION = "quality:evaluation:participate";

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
      were completed, how they are spread across forms, agents and evaluators,
      and whether evaluators are keeping up with what they have been assigned.
    </p>
    <div data-c="filters"></div>

    <div class="cs-actions">
      <button class="btn" data-c="load">Load dashboard</button>
    </div>

    <div class="cs-status" data-c="status" style="display:none"></div>

    <div data-c="results" hidden>
      <div class="dq-range-line" data-c="rangeLine"></div>
      <div class="dq-panel-note" data-c="emptyWhy" hidden></div>

      <div class="dq-tiles" data-c="tiles"></div>
      <div class="dq-panel-note" data-c="aiFailNote" hidden></div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Evaluations over time</h3>
        <p class="dq-panel-sub" data-c="trendSub"></p>
        <div class="dq-trend" data-c="trend"></div>
        <div class="dq-trend-axis" data-c="trendAxis"></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">By form</h3>
        <p class="dq-panel-sub">Evaluations completed, per evaluation form.</p>
        <div class="dq-bars" data-c="byForm"></div>
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

  /**
   * Fill the filter dropdowns without being asked.
   *
   * Setting a scope BEFORE asking for data is the natural order, and the whole
   * point of the bar. Loading the lists only inside the Load handler left every
   * dropdown empty until the first load — and an empty multiSelect ignores
   * clicks rather than opening, so the controls looked broken rather than
   * unready. Failures are silent here: the Load handler reports them properly,
   * and a warning about a list nobody has tried to use yet is just noise.
   */
  /**
   * Fill the dropdowns, or explain why they are empty.
   *
   * The page is reachable with no customer selected, and every list on it needs
   * one. Saying so beats five dropdowns that read "Loading…" and never resolve.
   */
  async function primeOptions() {
    const org = currentOrg();
    if (!org) {
      filters.setAwaitingOrg();
      $loadBtn.disabled = true;
      setStatus("Please select a customer org from the dropdown above to get started.");
      return;
    }
    $loadBtn.disabled = false;
    hideStatus();
    try { await ensureOptions(org.id); } catch { /* reported on Load, where it matters */ }
  }

  // The org can change under the page from the header dropdown. Reload the
  // dropdowns when it does, rather than offering the previous customer's
  // agents and forms as filters for this one.
  const unsubscribe = orgContext?.onChange?.(() => {
    optionsOrgId = null;
    $results.hidden = true;
    // Both directions: a customer chosen fills the lists, a customer cleared
    // puts the prompt back rather than leaving the previous one's names up.
    primeOptions();
  });
  if (unsubscribe) el.__destroy = unsubscribe;

  primeOptions();

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

  /**
   * @param {boolean} partial  The range runs up to now, so the LAST bucket is
   *   still filling. Marked rather than drawn flat: an unmarked trailing dip
   *   reads as evaluation activity collapsing this morning, which is the one
   *   wrong conclusion this chart could invite.
   */
  function renderTrend(points, granularity, partial) {
    const $trend = $("trend");
    const $axis = $("trendAxis");
    $trend.innerHTML = "";
    $axis.innerHTML = "";
    if (!points.length) {
      $trend.innerHTML = `<div class="dq-bar-empty">No evaluations in this period.</div>`;
      return;
    }

    const hourly = granularity === "PT1H";
    const stamp = (iso) => {
      const at = (iso || "").split("/")[0];
      if (!hourly) return at.slice(0, 10);
      const d = new Date(at);
      return Number.isNaN(d.getTime())
        ? at.slice(0, 16).replace("T", " ")
        : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };

    const max = Math.max(...points.map((p) => p.stats.count), 0);
    points.forEach((p, i) => {
      const col = document.createElement("div");
      const isLast = partial && i === points.length - 1;
      col.className = "dq-trend-col" + (isLast ? " is-partial" : "");
      const h = max > 0 ? (p.stats.count / max) * 100 : 0;
      col.style.height = `${Math.max(h, p.stats.count > 0 ? 2 : 0)}%`;
      col.title = `${stamp(p.interval)}: ${p.stats.count.toLocaleString()}` +
        (isLast ? " (still in progress)" : "");
      $trend.append(col);
    });

    $axis.innerHTML =
      `<span>${escapeHtml(stamp(points[0].interval))}</span>` +
      `<span>peak ${max.toLocaleString()}${partial ? " · last bucket still filling" : ""}</span>` +
      `<span>${escapeHtml(stamp(points[points.length - 1].interval))}</span>`;
  }

  /**
   * Map a grouped aggregate into labelled, sorted bar rows.
   *
   * Two different absences, which an earlier version conflated under one label:
   * a key that is PRESENT but not in the lookup is a real id this app could not
   * resolve — a deactivated user, a deleted form — and deserves the id. A key
   * that is ABSENT means the aggregate carries no such value at all, which is a
   * fact about the data rather than a lookup failure. Labelling an AI-scored
   * evaluation's missing evaluator as "Unknown user" invited exactly the wrong
   * conclusion: that a person was involved and this app lost their name.
   */
  function toRows(map, lookup, { unknownLabel = "Unknown", emptyLabel = unknownLabel } = {}) {
    return statsMapToSorted(map, "count").map(({ key, stats, value }) => ({
      key,
      label: key ? (lookup?.get(key) || `${unknownLabel} (${shortId(key)})`) : emptyLabel,
      value,
      stats,
    }));
  }

  /**
   * Evaluations AI attempted and could not score, by cause.
   *
   * The only thing on this page that comes from `evaluations/search` rather
   * than the aggregate domain: `aiScoringFailureType` exists nowhere else. It
   * therefore needs `quality:evaluation:searchAny`, which the rest of Coverage
   * does not, so it degrades on its own and names the permission — the same
   * shape as the eligible-agent denominator above.
   *
   * A failed AI scoring attempt is a COVERAGE failure: work that should have
   * been evaluated and was not. That is the argument for it being here rather
   * than on a page about how AI scores.
   */
  async function fetchAiFailures(orgId, f) {
    const none = { available: false, total: 0, causes: [], note: "" };
    try {
      const merged = await aggregateAcrossWindows(f, (w) => searchEvaluations(api, orgId,
        toSearchRequest(f, {
          window: w,
          systemSubmitted: true,
          aggregations: [termAggregation("failureType", "aiScoringFailureType")],
        })));
      const causes = (merged.aggregations.failureType?.buckets || [])
        .filter((b) => b.count > 0)
        .sort((a, b) => b.count - a.count);
      return {
        available: true,
        total: causes.reduce((n, b) => n + b.count, 0),
        causes,
        note: "",
      };
    } catch (err) {
      return {
        ...none,
        note: err.status === 403
          ? "needs quality:evaluation:searchAny"
          : "could not be loaded",
      };
    }
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
    setStatus("Loading…");

    try {
      // Usually a no-op — primeOptions has already run. Still awaited, because
      // pressing Load immediately on a slow org must not query with a scope the
      // user could not yet see.
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
        formResp, agentResp, evaluatorResp,
      ] = await Promise.all([
        q({ metrics: ["nEvaluations"] }),
        q({ metrics: ["nEvaluations"], groupBy: ["released"] }),
        q({ metrics: ["nEvaluations"], groupBy: ["systemSubmitted"] }),
        q({ metrics: ["nEvaluations"], granularity }),
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

      setStatus("Working out which agents can be evaluated…");
      const eligible = await fetchEligibleAgents(org.id);
      const aiFail = await fetchAiFailures(org.id, f);

      const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : null);

      // Evaluatable agents with nothing recorded against them in this period —
      // the actionable half of a coverage figure, and only knowable because the
      // eligible set is a real population rather than a proxy.
      let missed = null;
      if (eligible.ids) {
        missed = 0;
        for (const id of eligible.ids) if (!agentMap.has(id)) missed++;
      }

      $("tiles").innerHTML = [
        tile("Evaluations", total.toLocaleString(),
          f.timeBasis === "conversation" ? "by conversation date" : `by ${f.timeBasis} date`),
        tile("Agents evaluated", agentsEvaluated.toLocaleString(),
          eligible.ids
            ? `${pct(agentsEvaluated, eligible.ids.size)} of ${eligible.ids.size.toLocaleString()} who can be evaluated`
            : eligible.note),
        tile("Not evaluated", missed == null ? null : missed.toLocaleString(),
          missed == null ? "needs the eligible list" : "can be evaluated, but were not"),
        tile("Evaluations per agent",
          agentsEvaluated > 0 ? (total / agentsEvaluated).toFixed(1) : null,
          "among agents who were evaluated"),
        tile("Released", pct(released, total),
          `${released.toLocaleString()} of ${total.toLocaleString()}`),
        tile("AI-scored", total > 0 ? pct(aiCount, aiCount + humanCount) : null,
          `${aiCount.toLocaleString()} AI · ${humanCount.toLocaleString()} human`),
        // An evaluation AI could not score is a coverage failure - work that
        // should have been evaluated and was not - which is why this sits here
        // rather than on a page of its own.
        tile("AI could not score", aiFail.available ? aiFail.total.toLocaleString() : null,
          aiFail.available
            ? (aiFail.total ? "attempts that produced nothing" : "no AI scoring failures")
            : aiFail.note),
      ].join("");

      const $aiNote = $("aiFailNote");
      $aiNote.hidden = !aiFail.causes.length;
      if (aiFail.causes.length) {
        $aiNote.innerHTML = "AI could not score " +
          `${aiFail.total.toLocaleString()} evaluation(s): ` +
          aiFail.causes.map((c) =>
            `${escapeHtml(failureLabel(c.key))} \u00d7 ${c.count.toLocaleString()}`).join(" · ") +
          ". Quota reached is a commercial limit rather than a fault \u2014 it means the org " +
          "has scored as much as it bought.";
      }

      // ── Trend ─────────────────────────────────────
      const partial = includesToday(f.to);
      $("trendSub").textContent =
        `${granularityLabel(granularity)} buckets · ${formatRange(f.from, f.to)}` +
        (partial ? " · today is still in progress" : "");
      renderTrend(parseAggregateSeries(trendResp), granularity, partial);

      // ── Bands ─────────────────────────────────────
      const fmtCount = (r) => r.value.toLocaleString();

      renderBars($("byForm"),
        toRows(parseGroupedAggregate(formResp, "contextId"), lookups.forms,
          { unknownLabel: "Unknown form", emptyLabel: "No form recorded" }),
        { format: fmtCount });

      renderBars($("byAgent"),
        toRows(agentMap, lookups.agents,
          { unknownLabel: "Unknown user", emptyLabel: "No agent recorded" }),
        { format: fmtCount });

      // An AI-scored evaluation carries no evaluatorId, because no person
      // scored it — Genesys attributes it to "Virtual Supervisor", which is
      // what the Quality Summary of the conversation shows. Named as such
      // rather than left as an absence, but only when the AI count accounts
      // for the whole bucket: an evaluatorId can also be missing because the
      // evaluator was deleted, and calling that Virtual Supervisor would be
      // the same class of error as calling AI scoring an "Unknown user".
      const evaluatorMap = parseGroupedAggregate(evaluatorResp, "evaluatorId");
      const noEvaluator = evaluatorMap.get("")?.count || 0;
      renderBars($("byEvaluator"),
        toRows(evaluatorMap, lookups.agents, {
          unknownLabel: "Unknown user",
          emptyLabel: noEvaluator > 0 && noEvaluator === aiCount
            ? "Virtual Supervisor (AI scoring)"
            : "No evaluator recorded",
        }),
        { fill: "dq-fill-alt", format: fmtCount });

      $("byAgentSub").textContent =
        `Evaluations per agent — the top 25 of ${agentsEvaluated.toLocaleString()}.`;

      // ── Evaluator workload ────────────────────────
      setStatus("Loading evaluator activity…");
      const workloadWarning = await renderEvaluatorWorkload(org.id, f);

      // An empty result has two very different causes and the page must not
      // present them the same way: nothing happened in this period, or the
      // scope filters excluded everything that did. One extra unfiltered query
      // tells them apart, and it only runs when the answer was zero AND a
      // filter was set — never on the common path.
      let excludedByFilters = 0;
      if (total === 0 && hasScopeFilters(f)) {
        setStatus("Nothing matched — checking whether the filters excluded it…");
        try {
          const bare = toAggregateQuery(
            { ...f, agentIds: [], teamIds: [], divisionIds: [], formContextIds: [], mediaTypes: [] },
            { metrics: ["nEvaluations"] },
          );
          const resp = await queryEvaluationAggregates(api, org.id, bare);
          excludedByFilters = parseAggregateTotal(resp).count;
        } catch { /* the explanation is a nicety; its absence must not fail the load */ }
      }

      // ── Range line and warnings ───────────────────
      $("rangeLine").textContent =
        `${formatRange(f.from, f.to)} · ${total.toLocaleString()} evaluations`;

      // Driven by the RESULT, not by which preset was clicked. A short range
      // on the conversation basis is perfectly meaningful where AI scoring is
      // on — those evaluations land against the conversation almost
      // immediately, so an empty one is worth marking but not lecturing about.
      // The reasoning lives in docs/dashboards-quality-design.md §5.4; the page
      // says only that there is nothing here.
      const $why = $("emptyWhy");
      let why = "";

      if (excludedByFilters > 0) {
        // The filters, not the period, produced the zero. Naming which filter
        // is the user's to discover — the page states the fact and leaves the
        // bisecting to them rather than guessing on their behalf.
        why = `${excludedByFilters.toLocaleString()} evaluation(s) exist in this period, ` +
          "but none match the filters you set. Try clearing them one at a time to see " +
          "which one excludes everything.";
      } else if (total === 0 && f.timeBasis === "conversation" && dayCount(f.from, f.to) <= 7) {
        why = "Nothing here yet.";
      }

      $why.textContent = why;
      $why.hidden = !why;

      $results.hidden = false;
      const warnings = [...optionWarnings, ...(eligible.warning ? [eligible.warning] : []),
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
   * An agent can only be evaluated if they hold `quality:evaluation:participate`,
   * so the users who hold it are exactly the population a coverage figure means.
   * That beats the two proxies an earlier revision used: "everyone active"
   * counts people who were never evaluatable, and "everyone who handled an
   * interaction" both misses evaluatable agents who were quiet that period and
   * needs `analytics:conversationDetail:view` — a permission this page does not
   * otherwise require.
   *
   * Resolved the way Roles › Permissions vs. Users already does it: ask which
   * roles carry the permission, then take the union of their members. Needs
   * `authorization:role:view`, which is NOT part of this page's gate — a 403
   * degrades the tile to a bare count rather than failing the page.
   *
   * @returns {Promise<{ids: Set<string>|null, note: string, warning: string|null}>}
   */
  async function fetchEligibleAgents(orgId) {
    try {
      const roles = await fetchRolesWithPermission(api, orgId, PARTICIPATE_PERMISSION);

      if (!roles.length) {
        // No role carries it. Either the org genuinely grants it to nobody, or
        // the permission string is not what this app thinks it is. Said plainly
        // rather than shown as a coverage of 0%, which would be a lie either way.
        return {
          ids: null,
          note: "no role grants evaluation participate",
          warning: `No role in this org carries ${PARTICIPATE_PERMISSION}, so there is no population to measure coverage against.`,
        };
      }

      // A user can reach the permission through more than one role, so the
      // union is taken over ids rather than summing role membership counts.
      const ids = new Set();
      const lists = await Promise.all(
        roles.map((r) => fetchRoleUsers(api, orgId, r.id).catch(() => [])),
      );
      for (const list of lists) {
        for (const u of list) {
          const id = typeof u === "string" ? u : u?.id;
          if (id) ids.add(id);
        }
      }

      if (!ids.size) {
        return {
          ids: null,
          note: "no users hold evaluation participate",
          warning: null,
        };
      }
      return { ids, note: "", warning: null };
    } catch (err) {
      const denied = err.status === 403;
      return {
        ids: null,
        note: denied ? "coverage % needs authorization:role:view" : "eligible agents unavailable",
        warning: denied
          ? "Coverage percentage hidden: working out who can be evaluated needs authorization:role:view, which this page does not require."
          : `Could not work out who can be evaluated: ${err.message}`,
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
