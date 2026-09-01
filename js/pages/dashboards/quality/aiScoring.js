/**
 * Dashboards › Quality › AI Scoring
 *
 * See docs/dashboards-quality-design.md §8.
 *
 * The question: is AI scoring working, and is anyone accepting what it suggests?
 *
 * Two sources, deliberately:
 *
 *   POST /api/v2/quality/evaluations/search        the AI-specific figures
 *   POST /api/v2/analytics/evaluations/aggregates/query   counts and scores
 *
 * The AI-only data — failure types, suggestion acceptance, disputes, rescores,
 * which questions the model answered — exists ONLY as search aggregations. The
 * plain counts and the score comparison come from the aggregate domain instead,
 * which carries no date-range limit and costs one request rather than a walk
 * across 3-month windows.
 *
 * The page's gate is `quality:evaluation:searchAny`. The aggregate half
 * additionally wants `analytics:evaluationAggregate:view`, which is NOT part of
 * that gate — so those bands degrade on their own and say why, and the
 * AI-specific ones still work. That is the same split Coverage uses for its
 * denominator.
 *
 * Read-only, so no Activity Log entry.
 */

import { createEvaluationFilters } from "../../../components/evaluationFilters.js";
import {
  toAggregateQuery, toSearchRequest, dimensionPredicate,
  parseGroupedAggregate, parseAggregateTotal, parseAggregateSeries,
  statsAverage, aggregateAcrossWindows,
  termAggregation, sumAggregation, statsAggregation,
  AI_FAILURE_LABELS, exceedsSearchWindow,
} from "../../../lib/evaluationQuery.js";
import { queryEvaluationAggregates, searchEvaluations } from "../../../services/genesysApi.js";
import { dayCount, formatRange, includesToday } from "../../../utils/dateRanges.js";
import { makeStatus, escapeHtml, spinHtml } from "../../../utils.js";

/** Hourly for a day or two, daily to about two months, weekly beyond. */
function pickGranularity(from, to) {
  const days = dayCount(from, to);
  if (days <= 2) return "PT1H";
  return days <= 62 ? "P1D" : "P1W";
}

function granularityLabel(g) {
  return g === "PT1H" ? "Hourly" : g === "P1D" ? "Daily" : "Weekly";
}

/** A percentage, or null when the denominator is nothing. */
function share(n, d) {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : null;
}

/**
 * A failure type as a person would read it.
 *
 * `QuotaReached` is the one that matters most here, and it is not a bug: it
 * means the org has scored as much as it bought. Labelling it like an error
 * would send someone hunting for a fault that does not exist.
 */
function failureLabel(raw) {
  if (!raw) return "Unknown";
  return AI_FAILURE_LABELS[raw] || raw.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export default function renderAiScoring({ me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h1 class="h1">Dashboards — Quality — AI Scoring</h1>
    <hr class="hr">

    <p class="page-desc">
      How much of your quality programme AI is doing, whether it is succeeding,
      and whether anyone is accepting what it suggests: the AI share of
      evaluations, suggestion acceptance, scoring failures by cause, and how
      AI-scored evaluations compare with human-scored ones.
    </p>
    <p class="page-desc dq-perm-note">
      Needs <code>quality:evaluation:searchAny</code>. The counts and score
      comparison additionally use <code>analytics:evaluationAggregate:view</code>
      — without it those bands say so and the rest still works. Note that
      <code>analytics:evaluationAggregate:view</code> is on the Hourly
      Interacting disqualifying list.
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
        <h3 class="dq-panel-title">AI and human evaluations over time</h3>
        <p class="dq-panel-sub" data-c="trendSub"></p>
        <div class="dq-trend" data-c="trend"></div>
        <div class="dq-trend-axis" data-c="trendAxis"></div>
        <div class="dq-panel-note" data-c="trendNote" hidden></div>
      </div>

      <div class="dq-grid-2">
        <div class="dq-panel">
          <h3 class="dq-panel-title">Why AI scoring failed</h3>
          <p class="dq-panel-sub">
            Evaluations AI could not score, by cause. Quota reached is a
            commercial limit rather than a fault.
          </p>
          <div class="dq-bars" data-c="failures"></div>
        </div>
        <div class="dq-panel">
          <h3 class="dq-panel-title">Suggestions offered and accepted</h3>
          <p class="dq-panel-sub" data-c="suggestSub">
            AI scoring and Evaluation Assistance, side by side.
          </p>
          <div class="dq-bars" data-c="suggestions"></div>
        </div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">AI-scored against human-scored</h3>
        <p class="dq-panel-sub" data-c="compareSub">
          Average score by who did the scoring. A gap is worth understanding
          before it is worth acting on — the two are rarely scoring the same
          sample of work.
        </p>
        <div class="dq-bars" data-c="compare"></div>
        <div class="dq-panel-note" data-c="compareNote" hidden></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">After the model answered</h3>
        <p class="dq-panel-sub">
          What happened to AI-scored evaluations once a person saw them.
        </p>
        <div class="dq-bars" data-c="after"></div>
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

  const filters = createEvaluationFilters({ api });
  $("filters").append(filters.el);

  let optionsOrgId = null;
  async function ensureOptions(orgId) {
    if (optionsOrgId === orgId) return [];
    const warnings = await filters.loadOptions(orgId);
    optionsOrgId = orgId;
    return warnings;
  }

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

  /** Count bars, widths relative to the largest. */
  function renderCountBars(container, rows, { empty = "Nothing in this period." } = {}) {
    container.innerHTML = "";
    const total = rows.reduce((s, r) => s + r.count, 0);
    if (!total) {
      container.innerHTML = `<div class="dq-bar-empty">${escapeHtml(empty)}</div>`;
      return;
    }
    const max = Math.max(...rows.map((r) => r.count));
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "dq-bar-row";
      const w = max > 0 ? (r.count / max) * 100 : 0;
      row.innerHTML = `
        <span class="dq-bar-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>
        <div class="dq-bar-track"><div class="dq-bar-fill ${r.fill || ""}" style="width:${w}%"></div></div>
        <span class="dq-bar-value">${escapeHtml(r.value ?? r.count.toLocaleString())}</span>`;
      container.append(row);
    }
  }

  /**
   * Two series on one axis: AI and human, per bucket.
   *
   * Stacked rather than side by side, because the question is "how much of the
   * whole is AI doing" and a stack answers that at a glance where two adjacent
   * bars make you do the arithmetic.
   */
  function renderTrend(aiPoints, humanPoints, granularity, partial) {
    const $trend = $("trend");
    const $axis = $("trendAxis");
    $trend.innerHTML = "";
    $axis.innerHTML = "";

    const byInterval = new Map();
    for (const p of aiPoints) byInterval.set(p.interval, { ai: p.stats.count, human: 0 });
    for (const p of humanPoints) {
      const e = byInterval.get(p.interval) || { ai: 0, human: 0 };
      e.human = p.stats.count;
      byInterval.set(p.interval, e);
    }
    const points = [...byInterval.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (!points.length) {
      $trend.innerHTML = `<div class="dq-bar-empty">No evaluations in this period.</div>`;
      return;
    }

    const max = Math.max(...points.map(([, v]) => v.ai + v.human), 0);
    const hourly = granularity === "PT1H";
    const stamp = (iso) => {
      const at = (iso || "").split("/")[0];
      if (!hourly) return at.slice(0, 10);
      const d = new Date(at);
      return Number.isNaN(d.getTime()) ? at.slice(0, 16).replace("T", " ")
        : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };

    points.forEach(([interval, v], i) => {
      const col = document.createElement("div");
      const isLast = partial && i === points.length - 1;
      col.className = "dq-stack" + (isLast ? " is-partial" : "");
      const total = v.ai + v.human;
      col.style.height = max > 0 ? `${Math.max((total / max) * 100, total > 0 ? 2 : 0)}%` : "0%";
      col.innerHTML = `
        <div class="dq-stack-human" style="height:${total ? (v.human / total) * 100 : 0}%"></div>
        <div class="dq-stack-ai" style="height:${total ? (v.ai / total) * 100 : 0}%"></div>`;
      col.title = `${stamp(interval)}: ${v.ai} AI · ${v.human} human` +
        (isLast ? " (still in progress)" : "");
      $trend.append(col);
    });

    const totals = points.reduce((a, [, v]) => ({ ai: a.ai + v.ai, human: a.human + v.human }),
      { ai: 0, human: 0 });
    $axis.innerHTML =
      `<span>${escapeHtml(stamp(points[0][0]))}</span>` +
      `<span><span class="dq-key dq-key--ai"></span>${totals.ai.toLocaleString()} AI · ` +
      `<span class="dq-key dq-key--human"></span>${totals.human.toLocaleString()} human` +
      `${partial ? " · last bucket still filling" : ""}</span>` +
      `<span>${escapeHtml(stamp(points[points.length - 1][0]))}</span>`;
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
      const granularity = pickGranularity(f.from, f.to);
      const windows = exceedsSearchWindow(f.from, f.to)
        ? Math.ceil(dayCount(f.from, f.to) / 90) : 1;

      $("failures").innerHTML = `<div class="dq-bar-empty">${spinHtml("Loading failures…")}</div>`;
      $("suggestions").innerHTML = `<div class="dq-bar-empty">${spinHtml("Loading suggestions…")}</div>`;
      $("after").innerHTML = `<div class="dq-bar-empty">${spinHtml("Loading…")}</div>`;

      // ── The AI-specific half: search aggregations, chunked ──
      // Every one of these is TERM, SUM or STATS, all of which recombine across
      // consecutive 3-month windows exactly (§9.2), and every TERM field is a
      // low-cardinality enum — so chunking is safe and this band works at any
      // date range.
      setStatus("Querying AI scoring…");
      const aiAgg = await aggregateAcrossWindows(f, (w) => searchEvaluations(api, org.id,
        toSearchRequest(f, {
          window: w,
          systemSubmitted: true,
          aggregations: [
            termAggregation("failureType", "aiScoringFailureType"),
            termAggregation("answerFailure", "questionAiAnswerFailureType"),
            termAggregation("aiScored", "questionAiScored"),
            termAggregation("eaScored", "questionEaScored"),
            sumAggregation("aiSuggested", "aiSuggestionCount"),
            sumAggregation("aiAccepted", "aiAcceptedSuggestionCount"),
            sumAggregation("eaSuggested", "eaSuggestionCount"),
            sumAggregation("eaAccepted", "eaAcceptedSuggestionCount"),
            sumAggregation("disputes", "disputeCount"),
            sumAggregation("rescores", "rescoreCount"),
            statsAggregation("aiScore", "totalScore"),
          ],
        })));
      const A = aiAgg.aggregations;
      const sum = (name) => A[name]?.sum ?? A[name]?.value ?? 0;

      // ── The counting half: aggregates, unbounded ──
      setStatus("Counting AI and human evaluations…");
      let aiCount = 0, humanCount = 0, aiScore = null, humanScore = null;
      let aiSeries = [], humanSeries = [], aggregateFailed = null;
      try {
        const aiPred = [dimensionPredicate("systemSubmitted", "true")];
        const huPred = [dimensionPredicate("systemSubmitted", "false")];
        const [splitResp, scoreResp, aiTrend, huTrend] = await Promise.all([
          queryEvaluationAggregates(api, org.id,
            toAggregateQuery(f, { metrics: ["nEvaluations"], groupBy: ["systemSubmitted"] })),
          queryEvaluationAggregates(api, org.id,
            toAggregateQuery(f, { metrics: ["oTotalScore"], groupBy: ["systemSubmitted"] })),
          queryEvaluationAggregates(api, org.id,
            toAggregateQuery(f, { metrics: ["nEvaluations"], granularity, extraPredicates: aiPred })),
          queryEvaluationAggregates(api, org.id,
            toAggregateQuery(f, { metrics: ["nEvaluations"], granularity, extraPredicates: huPred })),
        ]);
        const split = parseGroupedAggregate(splitResp, "systemSubmitted");
        aiCount = split.get("true")?.count || 0;
        humanCount = split.get("false")?.count || 0;
        const scores = parseGroupedAggregate(scoreResp, "systemSubmitted", "oTotalScore");
        aiScore = scores.get("true") || null;
        humanScore = scores.get("false") || null;
        aiSeries = parseAggregateSeries(aiTrend);
        humanSeries = parseAggregateSeries(huTrend);
      } catch (err) {
        aggregateFailed = err.status === 403
          ? "Needs analytics:evaluationAggregate:view, which this page does not require."
          : err.message;
      }

      // ── Tiles ─────────────────────────────────────
      const total = aiCount + humanCount;
      const suggested = sum("aiSuggested") + sum("eaSuggested");
      const accepted = sum("aiAccepted") + sum("eaAccepted");
      const failures = (A.failureType?.buckets || []).reduce((s, b) => s + b.count, 0);

      $("tiles").innerHTML = [
        tile("AI-scored", aggregateFailed ? null : aiCount.toLocaleString(),
          aggregateFailed ? "count unavailable" : "evaluations submitted by AI"),
        tile("AI share", aggregateFailed ? null : share(aiCount, total),
          aggregateFailed ? "" : `${humanCount.toLocaleString()} scored by a person`),
        tile("Suggestions accepted", share(accepted, suggested),
          `${accepted.toLocaleString()} of ${suggested.toLocaleString()} offered`),
        tile("Scoring failures", failures ? failures.toLocaleString() : "0",
          failures ? "AI could not score these" : "none in this period"),
        tile("Disputed", sum("disputes").toLocaleString(), "AI-scored evaluations disputed"),
        tile("Rescored", sum("rescores").toLocaleString(), "scored again after AI"),
      ].join("");

      // ── Trend ─────────────────────────────────────
      const partial = includesToday(f.to);
      $("trendSub").textContent =
        `${granularityLabel(granularity)} buckets · ${formatRange(f.from, f.to)}` +
        (partial ? " · today is still in progress" : "");
      if (aggregateFailed) {
        $("trend").innerHTML = `<div class="dq-bar-empty">Not available.</div>`;
        $("trendNote").textContent = aggregateFailed;
        $("trendNote").hidden = false;
      } else {
        $("trendNote").hidden = true;
        renderTrend(aiSeries, humanSeries, granularity, partial);
      }

      // ── Failure types ─────────────────────────────
      renderCountBars($("failures"),
        (A.failureType?.buckets || [])
          .map((b) => ({ label: failureLabel(b.key), count: b.count, fill: "dq-fill-bad" }))
          .sort((a, b) => b.count - a.count),
        { empty: "No AI scoring failures in this period." });

      // ── Suggestions ───────────────────────────────
      // AI scoring and Evaluation Assistance are different features and are
      // kept apart: an org may run one, both or neither, and adding them
      // together would hide which one people actually accept.
      renderCountBars($("suggestions"), [
        { label: "AI suggested", count: sum("aiSuggested") },
        { label: "AI accepted", count: sum("aiAccepted"), fill: "dq-fill-good" },
        { label: "Assistance suggested", count: sum("eaSuggested") },
        { label: "Assistance accepted", count: sum("eaAccepted"), fill: "dq-fill-good" },
      ], { empty: "No suggestions were offered in this period." });
      $("suggestSub").textContent =
        `AI scoring and Evaluation Assistance, side by side.` +
        (windows > 1 ? ` Queried in ${windows} three-month windows and combined.` : "");

      // ── Score comparison ──────────────────────────
      const cmp = [];
      if (aiScore?.count) {
        cmp.push({ label: "AI-scored", count: aiScore.count,
          value: `${statsAverage(aiScore).toFixed(1)}% · ${aiScore.count.toLocaleString()} eval(s)`,
          fill: "dq-fill-alt" });
      }
      if (humanScore?.count) {
        cmp.push({ label: "Human-scored", count: humanScore.count,
          value: `${statsAverage(humanScore).toFixed(1)}% · ${humanScore.count.toLocaleString()} eval(s)`,
          fill: "dq-fill-good" });
      }
      // Widths track the AVERAGE, not the count, so the bars compare what the
      // panel is about. The count rides along in the label.
      $("compare").innerHTML = "";
      if (aggregateFailed) {
        $("compare").innerHTML = `<div class="dq-bar-empty">Not available.</div>`;
        $("compareNote").textContent = aggregateFailed;
        $("compareNote").hidden = false;
      } else if (!cmp.length) {
        $("compare").innerHTML = `<div class="dq-bar-empty">Nothing scored in this period.</div>`;
        $("compareNote").hidden = true;
      } else {
        $("compareNote").hidden = true;
        for (const c of cmp) {
          const avg = c.label === "AI-scored" ? statsAverage(aiScore) : statsAverage(humanScore);
          const row = document.createElement("div");
          row.className = "dq-bar-row";
          row.innerHTML = `
            <span class="dq-bar-label">${escapeHtml(c.label)}</span>
            <div class="dq-bar-track"><div class="dq-bar-fill ${c.fill}" style="width:${
              Math.max(Math.min(avg, 100), 0)}%"></div></div>
            <span class="dq-bar-value">${escapeHtml(c.value)}</span>`;
          $("compare").append(row);
        }
        if (cmp.length === 1) {
          $("compareNote").textContent =
            "Only one kind of scoring happened in this period, so there is nothing to compare it with.";
          $("compareNote").hidden = false;
        }
      }

      // ── After the model answered ──────────────────
      const bool = (agg, key) =>
        (agg?.buckets || []).find((b) => String(b.key).toLowerCase() === key)?.count || 0;
      renderCountBars($("after"), [
        { label: "Questions the model answered", count: bool(A.aiScored, "true") },
        { label: "Questions Evaluation Assistance answered", count: bool(A.eaScored, "true") },
        { label: "Answer-level failures", count:
            (A.answerFailure?.buckets || []).reduce((s, b) => s + b.count, 0), fill: "dq-fill-warn" },
        { label: "Disputes raised", count: sum("disputes"), fill: "dq-fill-warn" },
        { label: "Rescored by a person", count: sum("rescores"), fill: "dq-fill-warn" },
      ], { empty: "Nothing recorded against AI-scored evaluations in this period." });

      // ── Range line and empty state ────────────────
      $("rangeLine").textContent =
        `${formatRange(f.from, f.to)}` +
        (aggregateFailed ? "" : ` · ${aiCount.toLocaleString()} AI-scored of ${total.toLocaleString()}`);

      const $why = $("emptyWhy");
      if (!aggregateFailed && total > 0 && aiCount === 0) {
        $why.textContent =
          `Nothing on this page: none of the ${total.toLocaleString()} evaluation(s) in this ` +
          "period were scored by AI. Every figure here is about AI scoring, so it is all zero " +
          "by definition rather than because something failed.";
        $why.hidden = false;
      } else {
        $why.hidden = true;
      }

      $results.hidden = false;
      if (optionWarnings.length) setStatus(optionWarnings.join(" "), "error");
      else hideStatus();
    } catch (err) {
      setStatus(err.status === 403
        ? "This page needs the quality:evaluation:searchAny permission."
        : `Error: ${err.message}`, "error");
    } finally {
      $loadBtn.disabled = false;
      filters.setEnabled(true);
    }
  });

  return el;
}
