/**
 * Dashboards › Quality › Evaluation Scores
 *
 * See docs/dashboards-quality-design.md §7.
 *
 * The question: how are people scoring, and where are the failures concentrated?
 *
 * The tiles, trend, distribution and breakdowns come from the analytics
 * aggregate domain and carry no date-range limit. Two bands lower down come
 * from `quality/evaluations/search` instead, and inherit its constraints:
 *
 *   - Question groups (§7.3) needs exactly one form selected, because a
 *     question group is only comparable within the form that defines it.
 *   - The detail table (§7.4) is the only part that cannot be chunked across
 *     3-month windows, so it hides itself on a longer range.
 *
 * Both additionally need `quality:evaluation:searchAny`, which is NOT the
 * page's gate — without it the charts still work and the two bands say so.
 *
 *   POST /api/v2/analytics/evaluations/aggregates/query
 *   POST /api/v2/quality/evaluations/search
 *
 * Read-only, so no Activity Log entry.
 */

import { createEvaluationFilters } from "../../../components/evaluationFilters.js";
import {
  toAggregateQuery, toSearchRequest, parseGroupedAggregate, parseAggregateTotal,
  parseAggregateSeries, parseAggregateViews,
  statsMapToSorted, statsAverage, statsAggregation, termAggregationWith,
  scoreBandViews, SCORE_BANDS, hasScopeFilters, exceedsSearchWindow,
  aggregateAcrossWindows,
} from "../../../lib/evaluationQuery.js";
import {
  queryEvaluationAggregates, searchEvaluations, fetchEvaluationFormsByContext,
} from "../../../services/genesysApi.js";
import { dayCount, formatRange, includesToday } from "../../../utils/dateRanges.js";
import { makeStatus, escapeHtml } from "../../../utils.js";

/** Hourly for a day or two, daily to about two months, weekly beyond. */
function pickGranularity(from, to) {
  const days = dayCount(from, to);
  if (days <= 2) return "PT1H";
  return days <= 62 ? "P1D" : "P1W";
}

function granularityLabel(g) {
  return g === "PT1H" ? "Hourly" : g === "P1D" ? "Daily" : "Weekly";
}

function shortId(id) {
  return typeof id === "string" && id.length > 8 ? `${id.slice(0, 8)}…` : String(id ?? "");
}

/** A score as a percentage, or null when there is nothing to average. */
function pct(stats) {
  const a = statsAverage(stats);
  return a == null ? null : `${a.toFixed(1)}%`;
}

export default function renderScores({ me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h1 class="h1">Dashboards — Quality — Evaluation Scores</h1>
    <hr class="hr">

    <p class="page-desc">
      How evaluations are scoring, and where the low scores are concentrated:
      the average and its spread over time, how scores are distributed across
      bands, and which agents and forms sit at the bottom.
    </p>
    <p class="page-desc dq-perm-note">
      Needs <code>analytics:evaluationAggregate:view</code>, which is on the
      Hourly Interacting disqualifying list — granting it makes that user
      ineligible for an Hourly Interacting licence.
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

      <div class="dq-panel">
        <h3 class="dq-panel-title">Average score over time</h3>
        <p class="dq-panel-sub" data-c="trendSub"></p>
        <div class="dq-trend" data-c="trend"></div>
        <div class="dq-trend-axis" data-c="trendAxis"></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Score distribution</h3>
        <p class="dq-panel-sub">
          How many evaluations fell in each band. Bands are fixed percentages,
          not derived from the sample, so two periods can be compared.
        </p>
        <div class="dq-bars" data-c="distribution"></div>
      </div>

      <div class="dq-grid-2">
        <div class="dq-panel">
          <h3 class="dq-panel-title">Lowest-scoring agents</h3>
          <p class="dq-panel-sub" data-c="byAgentSub">Average score per agent, lowest first.</p>
          <div class="dq-bars" data-c="byAgent"></div>
        </div>
        <div class="dq-panel">
          <h3 class="dq-panel-title">By form</h3>
          <p class="dq-panel-sub">Average score per evaluation form, lowest first.</p>
          <div class="dq-bars" data-c="byForm"></div>
        </div>
      </div>

      <div class="dq-panel dq-scored-by">
        <h3 class="dq-panel-title">The two sections below read individual evaluations</h3>
        <p class="dq-panel-sub">
          Everything above counts every evaluation. These two can show
          human-scored or AI-scored evaluations, but not both at once — the
          evaluation search takes one or the other.
        </p>
        <div class="cs-control-group">
          <label class="cs-label">Scored by</label>
          <select class="input" data-c="detailWho">
            <option value="human">A person</option>
            <option value="ai">AI (Virtual Supervisor)</option>
          </select>
        </div>
        <div class="dq-panel-note" data-c="whoNote" hidden></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Weakest question groups</h3>
        <p class="dq-panel-sub" data-c="groupSub"></p>
        <div class="dq-bars" data-c="byGroup"></div>
        <div class="dq-panel-note" data-c="groupNote" hidden></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Evaluations</h3>
        <p class="dq-panel-sub" data-c="detailSub"></p>
        <div class="dq-detail-controls" data-c="detailControls" hidden>
          <div class="cs-control-group">
            <label class="cs-label">Sort by</label>
            <select class="input" data-c="detailSort">
              <option value="conversationDate">Conversation date</option>
              <option value="submittedDate">Submitted</option>
              <option value="createdDate">Created</option>
              <option value="releaseDate">Released</option>
            </select>
          </div>
          <div class="cs-control-group">
            <label class="cs-label">&nbsp;</label>
            <button class="btn btn-sm" data-c="detailPrev">Previous</button>
          </div>
          <div class="cs-control-group">
            <label class="cs-label">&nbsp;</label>
            <button class="btn btn-sm" data-c="detailNext">Next</button>
          </div>
          <div class="cs-control-group">
            <label class="cs-label">&nbsp;</label>
            <span class="dq-detail-page" data-c="detailPage"></span>
          </div>
        </div>
        <div class="dq-table-wrap" data-c="detailWrap" hidden>
          <table class="dq-table">
            <thead><tr>
              <th>Agent</th><th>Evaluator</th><th>Form</th>
              <th>Conversation</th><th>Submitted</th>
              <th class="is-num">Score</th><th class="is-num">Critical</th>
              <th>Status</th><th>Released</th>
            </tr></thead>
            <tbody data-c="detailRows"></tbody>
          </table>
        </div>
        <div class="dq-panel-note" data-c="detailNote" hidden></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Critical scores</h3>
        <p class="dq-panel-sub">
          Average critical score per agent, lowest first. A critical score can
          fall while the total score holds up, which is the case worth catching.
        </p>
        <div class="dq-bars" data-c="byAgentCritical"></div>
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

  const currentOrg = () => orgContext?.getDetails?.() || null;

  // The time basis is set on Coverage and inherited here through the shared
  // sessionStorage state — one scope across the three pages, set in one place.
  const filters = createEvaluationFilters({ api });
  $("filters").append(filters.el);

  // The two search-backed bands need a permission the PAGE does not require.
  // Absent it the charts still work and the bands say why, per the composite
  // page rule in docs/customer-facing-plan.md §6.
  const canSearch = access && access.can
    ? access.can("dashboards.quality.scores", "detail")
    : true;

  const DETAIL_PAGE_SIZE = 25;
  let detailPage = 1;
  let aiCount = 0;
  let humanCount = 0;
  let lastLoaded = null;   // filters of the last successful load

  // Once the user picks a side, the page stops choosing for them.
  let whoChosen = false;

  $("detailWho").addEventListener("change", () => {
    whoChosen = true;
    detailPage = 1;
    const org = currentOrg();
    if (org && lastLoaded) {
      renderQuestionGroups(org.id, lastLoaded);
      renderDetail(org.id, lastLoaded);
    }
  });

  $("detailSort").addEventListener("change", () => {
    detailPage = 1;
    const org = currentOrg();
    if (org && lastLoaded) renderDetail(org.id, lastLoaded);
  });
  $("detailPrev").addEventListener("click", () => {
    if (detailPage <= 1 || !lastLoaded) return;
    detailPage -= 1;
    const org = currentOrg();
    if (org) renderDetail(org.id, lastLoaded);
  });
  $("detailNext").addEventListener("click", () => {
    if (!lastLoaded) return;
    detailPage += 1;
    const org = currentOrg();
    if (org) renderDetail(org.id, lastLoaded);
  });

  let optionsOrgId = null;
  async function ensureOptions(orgId) {
    if (optionsOrgId === orgId) return [];
    const warnings = await filters.loadOptions(orgId);
    optionsOrgId = orgId;
    return warnings;
  }

  async function primeOptions() {
    const org = currentOrg();
    if (!org) return;
    try { await ensureOptions(org.id); } catch { /* reported on Load */ }
  }

  const unsubscribe = orgContext?.onChange?.(() => {
    optionsOrgId = null;
    $results.hidden = true;
    primeOptions();
  });
  if (unsubscribe) el.__destroy = unsubscribe;

  primeOptions();

  // ── Rendering ───────────────────────────────────────

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
   * Bars whose width is a share of 100%, not of the largest value.
   *
   * Scores are percentages on a fixed scale, so scaling to the maximum in the
   * set would make a group averaging 88% fill the track whenever nobody beat
   * it — reading as excellent when it is only the best of a poor field.
   */
  function renderScoreBars(container, rows, { limit = 25, fill = "" } = {}) {
    container.innerHTML = "";
    if (!rows.length) {
      container.innerHTML = `<div class="dq-bar-empty">No scored evaluations in this period.</div>`;
      return;
    }
    for (const row of rows.slice(0, limit)) {
      const el2 = document.createElement("div");
      el2.className = "dq-bar-row";
      const width = Math.max(Math.min(row.value, 100), 0);
      el2.innerHTML = `
        <span class="dq-bar-label" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span>
        <div class="dq-bar-track"><div class="dq-bar-fill ${fill || scoreFill(row.value)}" style="width:${width}%"></div></div>
        <span class="dq-bar-value">${row.value.toFixed(1)}% · ${row.stats.count.toLocaleString()} eval(s)</span>`;
      container.append(el2);
    }
    if (rows.length > limit) {
      const more = document.createElement("div");
      more.className = "dq-bar-empty";
      more.textContent = `…and ${rows.length - limit} more.`;
      container.append(more);
    }
  }

  /** Colour a score bar by the band it falls in, so the chart reads at a glance. */
  function scoreFill(v) {
    if (v < 60) return "dq-fill-bad";
    if (v < 80) return "dq-fill-warn";
    return "dq-fill-good";
  }

  /** Count bars, for the distribution — widths relative to the biggest band. */
  function renderCountBars(container, rows) {
    container.innerHTML = "";
    const total = rows.reduce((s, r) => s + r.count, 0);
    if (!total) {
      container.innerHTML = `<div class="dq-bar-empty">No scored evaluations in this period.</div>`;
      return;
    }
    const max = Math.max(...rows.map((r) => r.count));
    for (const r of rows) {
      const el2 = document.createElement("div");
      el2.className = "dq-bar-row";
      const w = max > 0 ? (r.count / max) * 100 : 0;
      const share = ((r.count / total) * 100).toFixed(1);
      el2.innerHTML = `
        <span class="dq-bar-label">${escapeHtml(r.label)}</span>
        <div class="dq-bar-track"><div class="dq-bar-fill ${r.fill}" style="width:${w}%"></div></div>
        <span class="dq-bar-value">${r.count.toLocaleString()} · ${share}%</span>`;
      container.append(el2);
    }
  }

  function renderTrend(points, granularity, partial) {
    const $trend = $("trend");
    const $axis = $("trendAxis");
    $trend.innerHTML = "";
    $axis.innerHTML = "";
    const scored = points.filter((p) => p.stats.count > 0);
    if (!scored.length) {
      $trend.innerHTML = `<div class="dq-bar-empty">No scored evaluations in this period.</div>`;
      return;
    }
    const hourly = granularity === "PT1H";
    const stamp = (iso) => {
      const at = (iso || "").split("/")[0];
      if (!hourly) return at.slice(0, 10);
      const d = new Date(at);
      return Number.isNaN(d.getTime()) ? at.slice(0, 16).replace("T", " ")
        : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };

    // Height is the score itself against a 0–100 axis, not a share of the best
    // bucket: an average score chart that rescales itself hides exactly the
    // decline it exists to show.
    points.forEach((p, i) => {
      const avg = statsAverage(p.stats);
      const col = document.createElement("div");
      const isLast = partial && i === points.length - 1;
      col.className = "dq-trend-col" + (isLast ? " is-partial" : "");
      col.style.height = avg == null ? "0%" : `${Math.max(Math.min(avg, 100), 1)}%`;
      col.title = avg == null
        ? `${stamp(p.interval)}: no evaluations`
        : `${stamp(p.interval)}: ${avg.toFixed(1)}% over ${p.stats.count} evaluation(s)` +
          (isLast ? " (still in progress)" : "");
      $trend.append(col);
    });

    const overall = scored.reduce((acc, p) => ({
      count: acc.count + p.stats.count, sum: acc.sum + p.stats.sum,
    }), { count: 0, sum: 0 });
    $axis.innerHTML =
      `<span>${escapeHtml(stamp(points[0].interval))}</span>` +
      `<span>average ${statsAverage(overall).toFixed(1)}% · axis 0–100%` +
      `${partial ? " · last bucket still filling" : ""}</span>` +
      `<span>${escapeHtml(stamp(points[points.length - 1].interval))}</span>`;
  }

  function toScoreRows(map, lookup, { unknownLabel = "Unknown", emptyLabel = unknownLabel } = {}) {
    return statsMapToSorted(map, "average", "asc").map(({ key, stats, value }) => ({
      key,
      label: key ? (lookup?.get(key) || `${unknownLabel} (${shortId(key)})`) : emptyLabel,
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
    setStatus("Loading…");

    try {
      const optionWarnings = await ensureOptions(org.id);
      const f = filters.getFilters();
      const lookups = filters.getLookups();

      setStatus("Querying evaluation scores…");
      const granularity = pickGranularity(f.from, f.to);
      const q = (opts) => queryEvaluationAggregates(api, org.id, toAggregateQuery(f, opts));

      const SCORE = ["nEvaluations", "oTotalScore", "oTotalCriticalScore"];

      const [totalResp, trendResp, distResp, agentResp, formResp, rescoreResp, systemResp] =
        await Promise.all([
          q({ metrics: SCORE }),
          q({ metrics: ["oTotalScore"], granularity }),
          q({ metrics: ["oTotalScore"], views: scoreBandViews("oTotalScore") }),
          q({ metrics: ["oTotalScore", "oTotalCriticalScore"], groupBy: ["userId"] }),
          q({ metrics: ["oTotalScore"], groupBy: ["contextId"] }),
          q({ metrics: ["nEvaluationsRescored"] }),
          q({ metrics: ["nEvaluations"], groupBy: ["systemSubmitted"] }),
        ]);

      // The two search-backed bands can only ask about one side at a time, and
      // a page that defaults to the empty side looks broken through no fault of
      // the query. So the default follows the data: if every evaluation in this
      // period was scored by AI, that is what those bands open on. A choice the
      // user has made is never overridden.
      const systemMap = parseGroupedAggregate(systemResp, "systemSubmitted");
      aiCount = systemMap.get("true")?.count || 0;
      humanCount = systemMap.get("false")?.count || 0;
      if (!whoChosen) {
        $("detailWho").value = aiCount > humanCount ? "ai" : "human";
      }
      $("whoNote").textContent =
        `${humanCount.toLocaleString()} scored by a person · ${aiCount.toLocaleString()} scored by AI in this period.`;
      $("whoNote").hidden = false;

      const count = parseAggregateTotal(totalResp, "nEvaluations").count;
      const score = parseAggregateTotal(totalResp, "oTotalScore");
      const critical = parseAggregateTotal(totalResp, "oTotalCriticalScore");
      const rescored = parseAggregateTotal(rescoreResp, "nEvaluationsRescored").count;

      // ── Tiles ─────────────────────────────────────
      // Averages are computed once over the whole population as sum/count.
      // Averaging the per-agent averages would be wrong whenever agents have
      // unequal evaluation counts, and is the mistake this data shape invites.
      $("tiles").innerHTML = [
        tile("Evaluations", count.toLocaleString(), "scored in this period"),
        tile("Average score", pct(score),
          score.count ? `over ${score.count.toLocaleString()} scored` : "nothing scored"),
        tile("Average critical", pct(critical),
          critical.count ? `over ${critical.count.toLocaleString()} scored` : "no critical questions"),
        tile("Lowest", score.min == null ? null : `${score.min.toFixed(1)}%`, "single evaluation"),
        tile("Highest", score.max == null ? null : `${score.max.toFixed(1)}%`, "single evaluation"),
        tile("Rescored", rescored.toLocaleString(), "evaluations scored again"),
      ].join("");

      // ── Trend ─────────────────────────────────────
      const partial = includesToday(f.to);
      $("trendSub").textContent =
        `${granularityLabel(granularity)} buckets · ${formatRange(f.from, f.to)}` +
        (partial ? " · today is still in progress" : "");
      renderTrend(parseAggregateSeries(trendResp, "oTotalScore"), granularity, partial);

      // ── Distribution ──────────────────────────────
      const views = parseAggregateViews(distResp);
      renderCountBars($("distribution"), SCORE_BANDS.map((b, i) => ({
        label: b.label,
        count: views.get(b.name)?.count || 0,
        fill: ["dq-fill-bad", "dq-fill-warn", "dq-fill-good", "dq-fill-good"][i],
      })));

      // ── Agents and forms ──────────────────────────
      const agentScores = parseGroupedAggregate(agentResp, "userId", "oTotalScore");
      const agentCritical = parseGroupedAggregate(agentResp, "userId", "oTotalCriticalScore");

      renderScoreBars($("byAgent"),
        toScoreRows(agentScores, lookups.agents,
          { unknownLabel: "Unknown user", emptyLabel: "No agent recorded" }));
      $("byAgentSub").textContent =
        `Average score per agent, lowest first — ${agentScores.size.toLocaleString()} agent(s) scored.`;

      renderScoreBars($("byForm"),
        toScoreRows(parseGroupedAggregate(formResp, "contextId", "oTotalScore"), lookups.forms,
          { unknownLabel: "Unknown form", emptyLabel: "No form recorded" }));

      renderScoreBars($("byAgentCritical"),
        toScoreRows(agentCritical, lookups.agents,
          { unknownLabel: "Unknown user", emptyLabel: "No agent recorded" }));

      // ── Empty-state explanation ───────────────────
      let excludedByFilters = 0;
      if (count === 0 && hasScopeFilters(f)) {
        setStatus("Nothing matched — checking whether the filters excluded it…");
        try {
          const bare = toAggregateQuery(
            { ...f, agentIds: [], teamIds: [], divisionIds: [], formContextIds: [], mediaTypes: [] },
            { metrics: ["nEvaluations"] },
          );
          excludedByFilters = parseAggregateTotal(
            await queryEvaluationAggregates(api, org.id, bare)).count;
        } catch { /* the explanation is a nicety; it must not fail the load */ }
      }

      const $why = $("emptyWhy");
      let why = "";
      if (excludedByFilters > 0) {
        why = `${excludedByFilters.toLocaleString()} evaluation(s) exist in this period, ` +
          "but none match the filters you set. Try clearing them one at a time to see " +
          "which one excludes everything.";
      } else if (count > 0 && score.count === 0) {
        // Evaluations exist but none carry a score — in progress, or a form
        // with nothing scorable. Worth saying, because every band below will
        // be empty and the page would otherwise look broken.
        why = "These evaluations carry no score yet — they may still be in progress, " +
          "or not released. The counts above are real; the score bands are empty because " +
          "there is nothing scored to average.";
      } else if (count === 0 && f.timeBasis === "conversation" && dayCount(f.from, f.to) <= 7) {
        why = "Nothing here yet. These dates are matched against the CONVERSATION, " +
          "and a conversation is usually evaluated days after it happens — only AI " +
          "scoring lands the same day. Switch “Dates refer to” to Created or Released " +
          "to see the evaluation work done in this period.";
      }
      $why.textContent = why;
      $why.hidden = !why;

      // Search-backed bands, run after the aggregate ones are on screen and
      // never allowed to fail the page: they need a permission this page does
      // not require, and one of them needs a single form selected.
      detailPage = 1;
      lastLoaded = f;
      await renderQuestionGroups(org.id, f);
      await renderDetail(org.id, f);

      $("rangeLine").textContent =
        `${formatRange(f.from, f.to)} · ${count.toLocaleString()} evaluations` +
        (score.count ? ` · average ${statsAverage(score).toFixed(1)}%` : "");

      $results.hidden = false;
      if (optionWarnings.length) setStatus(optionWarnings.join(" "), "error");
      else hideStatus();
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $loadBtn.disabled = false;
      filters.setEnabled(true);
    }
  });

  // ── §7.3 Question groups ────────────────────────────

  /**
   * Average score per question group, weakest first.
   *
   * Requires EXACTLY ONE form. A question group is only comparable within the
   * form that defines it — "Compliance" on two forms is two different sets of
   * questions, and averaging across them yields a number describing nothing.
   * The search endpoint enforces its own version of the same rule.
   */
  async function renderQuestionGroups(orgId, f) {
    const $bars = $("byGroup");
    const $sub = $("groupSub");
    const $note = $("groupNote");
    $bars.innerHTML = "";
    $note.hidden = true;

    if (!canSearch) {
      $sub.textContent = "Needs the quality:evaluation:searchAny permission.";
      $bars.innerHTML = '<div class="dq-bar-empty">Not available with your permissions.</div>';
      return;
    }
    if (f.formContextIds.length !== 1) {
      $sub.textContent = f.formContextIds.length === 0
        ? "Select exactly one form in the filter bar to break its scores down by question group."
        : `Select exactly one form — ${f.formContextIds.length} are selected, and question groups are not comparable across forms.`;
      $bars.innerHTML = '<div class="dq-bar-empty">No single form selected.</div>';
      return;
    }

    const windows = splitCount(f);
    try {
      // The endpoint is explicit about what it will accept here: "a single top
      // level Term aggregation for questionGroupId and querying by either a
      // single formId or a list of questionGroupIds". A form CONTEXT id — which
      // is what the filter bar carries, and what every other band uses — is
      // rejected. So the context is resolved to the id of its latest published
      // VERSION and the query is scoped to that.
      //
      // The consequence is real and is stated on screen: this band covers the
      // current published version of the form only. Evaluations scored on an
      // earlier version are not in it, which is exactly the trade the context
      // id exists to avoid everywhere else.
      const forms = await fetchEvaluationFormsByContext(api, orgId, f.formContextIds);
      const form = forms[0];
      if (!form?.id) {
        $sub.textContent = "Average score per question group, weakest first.";
        $bars.innerHTML = '<div class="dq-bar-empty">Could not resolve that form.</div>';
        $note.textContent = "The form could not be looked up, so there is no version to query by.";
        $note.hidden = false;
        return;
      }

      const names = new Map();
      for (const g of form.questionGroups || []) {
        if (g.id) names.set(g.id, g.name || g.id);
      }

      $sub.textContent =
        `Average score per question group, weakest first — ${form.name || "this form"}, ` +
        "current published version only." +
        (windows > 1 ? ` Queried in ${windows} three-month windows and combined.` : "");

      // The search endpoint caps each request at three months, but this
      // aggregation is TERM with a STATS child — both recombine across
      // consecutive windows exactly (§9.2), and questionGroupId is far below
      // the 100-bucket TERM limit that makes chunking unsafe for high-
      // cardinality fields. So a long range becomes several requests rather
      // than a refusal, and this band keeps working where the row-level table
      // below genuinely cannot.
      const merged = await aggregateAcrossWindows(f, (w) => searchEvaluations(api, orgId,
        toSearchRequest({ ...f, formContextIds: [] }, {
          window: w,
          systemSubmitted: detailWho() === "ai",
          extraCriteria: [{ type: "EXACT", field: "formId", values: [form.id] }],
          aggregations: [termAggregationWith("byGroup", "questionGroupId",
            [statsAggregation("score", "questionGroupScorePercentage")])],
        })));

      const buckets = merged.aggregations.byGroup?.buckets || [];
      const rows = buckets
        .map((b) => {
          const st = b.sub?.score;
          const avg = st && st.count ? st.sum / st.count : null;
          return avg == null ? null : {
            label: names.get(b.key) || `Question group (${shortId(b.key)})`,
            value: avg,
            stats: { count: b.count },
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.value - b.value);

      renderScoreBars($bars, rows);
      if (!rows.length) {
        $note.textContent = otherSideHint()
          || "The search returned no question-group scores for this form and period.";
        $note.hidden = false;
      }
    } catch (err) {
      $bars.innerHTML = '<div class="dq-bar-empty">Could not load question groups.</div>';
      $note.textContent = err.status === 403
        ? "Needs the quality:evaluation:searchAny permission."
        : `The question-group query was rejected: ${err.message}`;
      $note.hidden = false;
    }
  }

  // ── §7.4 Detail table ───────────────────────────────

  function detailWho() { return $("detailWho").value; }

  /**
   * When a search band comes back empty, say whether the OTHER side has the
   * data. Nothing else on the page distinguishes "no evaluations" from "none
   * of the kind you asked for", and the two look identical.
   */
  function otherSideHint() {
    const wantAi = detailWho() === "ai";
    const other = wantAi ? humanCount : aiCount;
    if (!other) return null;
    return wantAi
      ? `No AI-scored evaluations here, but ${other.toLocaleString()} were scored by a person — switch “Scored by” above.`
      : `No evaluations scored by a person here, but ${other.toLocaleString()} were scored by AI — switch “Scored by” above.`;
  }

  /** How many 3-month windows a range needs. */
  function splitCount(f) {
    return exceedsSearchWindow(f.from, f.to)
      ? Math.ceil(dayCount(f.from, f.to) / 90)
      : 1;
  }

  /**
   * The row-level table.
   *
   * The one part of this feature that genuinely cannot exceed three months.
   * Aggregations recombine across consecutive windows exactly; a paged, sorted
   * list does not — merging sorted pages across windows means either fetching
   * every row to sort them, or paging that jumps between windows. So the table
   * hides itself on a longer range and says why, rather than showing a list
   * that is silently only the first quarter of the answer.
   */
  /**
   * A name for a person or form on a detail row.
   *
   * The row may carry a populated object, or only an id, depending on the
   * field. Every other band on this page resolves ids through the lists the
   * filter bar already loaded, and the row-level table has no reason to be
   * different — an em-dash where a name belongs is a lookup this page declined
   * to do, not a fact about the evaluation.
   */
  function resolveName(ref, lookup, extraKeys = []) {
    if (!ref) return null;
    if (typeof ref === "string") return lookup?.get(ref) || shortId(ref);
    if (ref.name) return ref.name;
    for (const key of ["id", "contextId", ...extraKeys]) {
      const v = ref[key];
      if (v && lookup?.get(v)) return lookup.get(v);
    }
    const id = ref.id || ref.contextId;
    return id ? shortId(id) : null;
  }

  async function renderDetail(orgId, f) {
    const $sub = $("detailSub");
    const $wrap = $("detailWrap");
    const $rows = $("detailRows");
    const $note = $("detailNote");
    const $controls = $("detailControls");
    $note.hidden = true;

    if (!canSearch) {
      $sub.textContent = "Individual evaluations need the quality:evaluation:searchAny permission.";
      $wrap.hidden = true;
      $controls.hidden = true;
      return;
    }
    if (exceedsSearchWindow(f.from, f.to)) {
      $sub.textContent = "";
      $wrap.hidden = true;
      $controls.hidden = true;
      $note.textContent =
        "Individual evaluations are shown for ranges of three months or less. " +
        "Everything above works at any range; this table is the one part that cannot, " +
        "because a paged, sorted list cannot be stitched across several queries the way " +
        "totals can. Narrow the date range to see the rows.";
      $note.hidden = false;
      return;
    }

    $controls.hidden = false;
    $wrap.hidden = false;
    $sub.textContent = "Individual evaluations in this period.";
    $rows.innerHTML = '<tr><td colspan="9" class="dq-bar-empty">Loading…</td></tr>';

    try {
      const resp = await searchEvaluations(api, orgId, toSearchRequest(f, {
        pageSize: DETAIL_PAGE_SIZE,
        pageNumber: detailPage,
        sortBy: $("detailSort").value,
        sortOrder: "DESC",
        systemSubmitted: detailWho() === "ai",
      }));

      const items = resp?.results || [];
      const hint = items.length ? null : otherSideHint();
      if (hint) { $note.textContent = hint; $note.hidden = false; }
      const lookups = filters.getLookups();
      let unresolved = null;
      $rows.innerHTML = "";
      if (!items.length) {
        $rows.innerHTML = '<tr><td colspan="9" class="dq-bar-empty">No evaluations on this page.</td></tr>';
      }
      for (const it of items) {
        const tr = document.createElement("tr");
        if (it.redacted) {
          // Shown rather than dropped: a table that silently omits rows the
          // caller may not see reports a smaller programme than exists.
          tr.innerHTML = '<td colspan="9" class="dq-redacted">An evaluation you do not have permission to see</td>';
          $rows.append(tr);
          continue;
        }
        const score = it.answers?.totalScore;
        const crit = it.answers?.totalCriticalScore;

        const agentName = resolveName(it.agent ?? it.agentId, lookups.agents);
        const formName = resolveName(it.evaluationForm ?? it.formId, lookups.forms);
        // Only claim Virtual Supervisor when AI rows were asked for. A human
        // evaluation whose name failed to resolve is a lookup miss, and saying
        // "Virtual Supervisor" there would invent a scorer.
        const evaluatorName = resolveName(it.evaluator ?? it.evaluatorId, lookups.agents)
          || (detailWho() === "ai" ? "Virtual Supervisor" : "—");

        if (!agentName || !formName) unresolved = unresolved || it;

        tr.innerHTML = `
          <td>${escapeHtml(agentName || "—")}</td>
          <td>${escapeHtml(evaluatorName)}</td>
          <td>${escapeHtml(formName || "—")}</td>
          <td>${escapeHtml(shortDate(it.conversationDate))}</td>
          <td>${escapeHtml(shortDate(it.submittedDate))}</td>
          <td class="is-num">${score == null ? "—" : Number(score).toFixed(1) + "%"}</td>
          <td class="is-num">${crit == null ? "—" : Number(crit).toFixed(1) + "%"}</td>
          <td>${escapeHtml(it.status || "—")}</td>
          <td>${it.releaseDate ? "Yes" : "No"}</td>`;
        $rows.append(tr);
      }

      // If a row still cannot be named, say what the row DID carry rather than
      // leaving a silent em-dash. One line, and it names the field to fix.
      if (unresolved) {
        $note.textContent =
          "Some rows have no agent or form name. The evaluation record carried: " +
          Object.keys(unresolved).filter((k) => !["answers", "versionHistory"].includes(k)).join(", ");
        $note.hidden = false;
      }

      $("detailPage").textContent = `Page ${detailPage}`;
      $("detailPrev").disabled = detailPage <= 1;
      $("detailNext").disabled = items.length < DETAIL_PAGE_SIZE;
    } catch (err) {
      $rows.innerHTML = '<tr><td colspan="9" class="dq-bar-empty">Could not load evaluations.</td></tr>';
      $note.textContent = err.status === 403
        ? "Needs the quality:evaluation:searchAny permission."
        : `The evaluation search was rejected: ${err.message}`;
      $note.hidden = false;
      $("detailPrev").disabled = detailPage <= 1;
      $("detailNext").disabled = true;
    }
  }

  function shortDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso.slice(0, 16).replace("T", " ")
      : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  return el;
}
