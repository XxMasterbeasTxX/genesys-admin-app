/**
 * Dashboards › Quality › AI Scoring
 *
 * See docs/dashboards-quality-design.md §8.
 *
 * The question: is AI doing the work, is it succeeding, and is anyone letting
 * it stand?
 *
 * TWO LANES, NEVER ADDED TOGETHER. Genesys ships two different AI features and
 * the first build of this page averaged them into one word:
 *
 *   Auto-evaluation      AI scores and SUBMITS the evaluation itself.
 *                        systemSubmitted: true. Fails by producing nothing.
 *                        Trust signal: a person disputing or rescoring it.
 *
 *   Evaluation Assistance  AI SUGGESTS answers to a human evaluator, who
 *                        accepts or overrides. systemSubmitted: false. Fails
 *                        by producing something nobody takes.
 *                        Trust signal: the acceptance rate.
 *
 * They are configured differently, fail differently and are trusted
 * differently, so one blended "AI acceptance" number answers nothing about
 * either. That split also fixes a real bug: the old page asked a
 * systemSubmitted:true request for eaSuggestionCount — assistance figures from
 * the population that by definition has none.
 *
 * ONE SOURCE: POST /api/v2/quality/evaluations/search. The analytics aggregate
 * domain was only ever here to carry the counts and the AI-vs-human
 * comparison; the comparison is gone (the two never score the same sample, so
 * the gap was not evidence of anything) and the search response's own `total`
 * carries the counts. So the page needs one permission,
 * `quality:evaluation:searchAny`, and has no half that degrades separately.
 *
 * RATES, NOT COUNTS, for the two bands that matter. A count says what
 * happened; a rate over time says whether it is getting better or worse, which
 * is the only version of this anyone can act on.
 *
 * Read-only, so no Activity Log entry.
 */

import { createEvaluationFilters } from "../../../components/evaluationFilters.js";
import {
  toSearchRequest, aggregateAcrossWindows,
  termAggregation, termAggregationWith, sumAggregation,
  dateHistogramAggregation, searchDateField, calendarIntervalFor,
  AI_FAILURE_LABELS, exceedsSearchWindow,
} from "../../../lib/evaluationQuery.js";
import { searchEvaluations, fetchEvaluationFormsByContext } from "../../../services/genesysApi.js";
import { dayCount, formatRange, includesToday } from "../../../utils/dateRanges.js";
import { makeStatus, escapeHtml, spinHtml } from "../../../utils.js";

function intervalLabel(ci) {
  return ci === "1h" ? "Hourly" : ci === "1d" ? "Daily" : "Weekly";
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

/**
 * A histogram bucket key as a date.
 *
 * The endpoint returns either an epoch-millisecond key or a formatted
 * `keyAsString` depending on the aggregation, and the normaliser hands over
 * whichever it got. Both are handled rather than one assumed.
 */
function bucketDate(key) {
  const raw = String(key ?? "");
  const d = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function bucketStamp(key, ci) {
  const d = bucketDate(key);
  if (!d) return String(key ?? "").slice(0, 16);
  return ci === "1h"
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function renderAiScoring({ me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h1 class="h1">Dashboards — Quality — AI Scoring</h1>
    <hr class="hr">

    <p class="page-desc">
      What AI is doing in your quality programme, whether it is succeeding, and
      whether people are letting it stand. Auto-evaluation and Evaluation
      Assistance are two different features and are reported separately: one
      submits evaluations on its own, the other suggests answers to a human.
    </p>

    <div data-c="filters"></div>

    <div class="cs-actions">
      <button class="btn" data-c="load">Load dashboard</button>
    </div>

    <div class="cs-status" data-c="status" style="display:none"></div>

    <div data-c="results" hidden>
      <div class="dq-range-line" data-c="rangeLine"></div>

      <!-- ── Lane A — auto-evaluation ─────────────────────────────── -->
      <div class="dq-lane">
        <h2 class="dq-lane-title">Auto-evaluation</h2>
        <p class="dq-lane-sub">
          AI scores and submits the whole evaluation itself, as Virtual
          Supervisor. No person is involved unless one disputes or rescores it.
        </p>

        <div class="dq-tiles" data-c="autoTiles"></div>
        <div class="dq-panel-note" data-c="autoEmpty" hidden></div>

        <div class="dq-panel">
          <h3 class="dq-panel-title">Did it run?</h3>
          <p class="dq-panel-sub">
            Evaluations AI could not score, by cause. Quota reached is a
            commercial limit rather than a fault — it means the org has scored
            as much as it bought.
          </p>
          <div class="dq-bars" data-c="failures"></div>
        </div>

        <div class="dq-panel">
          <h3 class="dq-panel-title">Did it stick?</h3>
          <p class="dq-panel-sub" data-c="overturnSub"></p>
          <div class="dq-trend is-rate" data-c="overturnTrend"></div>
          <div class="dq-trend-axis" data-c="overturnAxis"></div>
          <div class="dq-panel-note" data-c="overturnNote" hidden></div>
        </div>

        <div class="dq-panel">
          <h3 class="dq-panel-title">Which questions it answered</h3>
          <p class="dq-panel-sub" data-c="autoQSub"></p>
          <div class="dq-bars is-long-label" data-c="autoQuestions"></div>
          <div class="dq-panel-note" data-c="autoQNote" hidden></div>
        </div>
      </div>

      <!-- ── Lane B — evaluation assistance ───────────────────────── -->
      <div class="dq-lane">
        <h2 class="dq-lane-title">Evaluation Assistance</h2>
        <p class="dq-lane-sub">
          AI suggests answers to a human evaluator, who accepts them or writes
          their own. These evaluations are submitted by a person.
        </p>

        <div class="dq-tiles" data-c="eaTiles"></div>
        <div class="dq-panel-note" data-c="eaEmpty" hidden></div>

        <div class="dq-panel">
          <h3 class="dq-panel-title">Are the suggestions taken?</h3>
          <p class="dq-panel-sub" data-c="acceptSub"></p>
          <div class="dq-trend is-rate" data-c="acceptTrend"></div>
          <div class="dq-trend-axis" data-c="acceptAxis"></div>
          <div class="dq-panel-note" data-c="acceptNote" hidden></div>
        </div>

        <div class="dq-panel">
          <h3 class="dq-panel-title">Which questions it answered</h3>
          <p class="dq-panel-sub" data-c="eaQSub"></p>
          <div class="dq-bars is-long-label" data-c="eaQuestions"></div>
          <div class="dq-panel-note" data-c="eaQNote" hidden></div>
        </div>
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
   * A rate per bucket, plotted against a fixed 0–100% axis.
   *
   * Fixed rather than scaled to the data, deliberately: the whole reason these
   * bands are rates is so two periods can be compared, and an axis that moves
   * with the sample defeats that.
   *
   * A bucket with a zero denominator has NO rate — nothing was offered, or
   * nothing was scored. It draws as a flat tick rather than a zero-height bar,
   * because "nothing happened here" and "everything here was rejected" are
   * opposite facts and a zero-height bar says the second one.
   *
   * @param {Array<{key:string, num:number, den:number}>} points
   */
  function renderRateTrend($trend, $axis, points, opts) {
    const { ci, partial, fill = "", noun, verb } = opts;
    $trend.innerHTML = "";
    $axis.innerHTML = "";

    if (!points.length) {
      $trend.innerHTML = `<div class="dq-bar-empty">Nothing in this period.</div>`;
      return;
    }

    points.forEach((p, i) => {
      const col = document.createElement("div");
      const isLast = partial && i === points.length - 1;
      const hasRate = p.den > 0;
      const rate = hasRate ? (p.num / p.den) * 100 : 0;
      col.className = `dq-trend-col ${fill}` +
        (hasRate ? "" : " is-nodata") + (isLast && hasRate ? " is-partial" : "");
      col.style.height = hasRate ? `${Math.max(Math.min(rate, 100), rate > 0 ? 2 : 0)}%` : "";
      col.title = hasRate
        ? `${bucketStamp(p.key, ci)}: ${rate.toFixed(1)}% — ` +
          `${p.num.toLocaleString()} of ${p.den.toLocaleString()} ${noun}` +
          (isLast ? " (still in progress)" : "")
        : `${bucketStamp(p.key, ci)}: no ${noun}`;
      $trend.append(col);
    });

    const num = points.reduce((s, p) => s + p.num, 0);
    const den = points.reduce((s, p) => s + p.den, 0);
    $axis.innerHTML =
      `<span>${escapeHtml(bucketStamp(points[0].key, ci))}</span>` +
      `<span>${escapeHtml(share(num, den) ?? "—")} ${escapeHtml(verb)} overall · ` +
      `${num.toLocaleString()} of ${den.toLocaleString()} ${escapeHtml(noun)}` +
      `${partial ? " · last bucket still filling" : ""}</span>` +
      `<span>${escapeHtml(bucketStamp(points[points.length - 1].key, ci))}</span>`;
  }

  /**
   * Which questions on a form the model answered, least often first.
   *
   * The interesting question nothing else answers: a model that scores most of
   * a form but never touches three questions is telling you something about
   * those three — usually that they are badly worded, or need a human.
   *
   * Question-level fields (anything named question*) are only aggregatable
   * alongside a single top-level TERM on `questionId` and a query scoped to one
   * form, and mixing one into a request with evaluation-level fields is
   * rejected outright rather than degraded. So this is its own request per
   * lane, and a refusal costs this band alone (§8.2a).
   */
  async function renderPerQuestion(orgId, f, lane) {
    const { bars: barsKey, sub: subKey, note: noteKey, field, systemSubmitted, who } = lane;
    const $bars = $(barsKey);
    const $sub = $(subKey);
    const $note = $(noteKey);
    $note.hidden = true;

    if (f.formContextIds.length !== 1) {
      $sub.textContent = f.formContextIds.length === 0
        ? `Select exactly one form in the filter bar to see which of its questions ${who} answered.`
        : `Select exactly one form — ${f.formContextIds.length} are selected, and questions are not comparable across forms.`;
      $bars.innerHTML = '<div class="dq-bar-empty">No single form selected.</div>';
      return;
    }

    $sub.textContent = `How often ${who} answered each question, least often first.`;
    $bars.innerHTML = `<div class="dq-bar-empty">${spinHtml("Loading questions…")}</div>`;

    try {
      const forms = await fetchEvaluationFormsByContext(api, orgId, f.formContextIds);
      const form = forms[0];
      if (!form?.id) {
        $bars.innerHTML = '<div class="dq-bar-empty">Could not resolve that form.</div>';
        return;
      }
      const names = new Map();
      for (const g of form.questionGroups || []) {
        for (const q of g.questions || []) if (q.id) names.set(q.id, q.text || q.id);
      }

      const merged = await aggregateAcrossWindows(f, (w) => searchEvaluations(api, orgId,
        toSearchRequest({ ...f, formContextIds: [] }, {
          window: w,
          systemSubmitted,
          extraCriteria: [{ type: "EXACT", field: "formId", values: [form.id] }],
          aggregations: [termAggregationWith("byQuestion", "questionId",
            [termAggregation("scored", field)], 100)],
        })));

      const rows = (merged.aggregations.byQuestion?.buckets || []).map((b) => {
        const yes = (b.sub?.scored?.buckets || [])
          .find((x) => String(x.key).toLowerCase() === "true")?.count || 0;
        return {
          label: names.get(b.key) || `Question (${String(b.key).slice(0, 8)}…)`,
          count: yes,
          value: `${yes.toLocaleString()} of ${b.count.toLocaleString()}`,
          total: b.count,
        };
      }).sort((a, b) => (a.count / (a.total || 1)) - (b.count / (b.total || 1)));

      renderCountBars($bars, rows,
        { empty: `No question-level scoring by ${who} for this form and period.` });
      $sub.textContent =
        `How often ${who} answered each question on ${form.name || "this form"}, ` +
        "least often first — current published version only.";
    } catch (err) {
      $bars.innerHTML = '<div class="dq-bar-empty">Could not load questions.</div>';
      $note.textContent = `The per-question query was rejected: ${err.message}`;
      $note.hidden = false;
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
      const optionWarnings = await ensureOptions(org.id);
      const f = filters.getFilters();
      const ci = calendarIntervalFor(dayCount(f.from, f.to));
      const dateField = searchDateField(f.timeBasis);
      const partial = includesToday(f.to);
      const windows = exceedsSearchWindow(f.from, f.to)
        ? Math.ceil(dayCount(f.from, f.to) / 90) : 1;
      const windowNote = windows > 1
        ? ` Queried in ${windows} three-month windows and combined.` : "";

      $("failures").innerHTML = `<div class="dq-bar-empty">${spinHtml("Loading failures…")}</div>`;

      // FOUR requests, not two, and the reason is a rule the endpoint does not
      // document in its schema: "When using sub-aggregations, only one
      // top-level aggregation is allowed."
      //
      // So a histogram carrying SUM sub-aggregations — the only way to express
      // a rate per bucket — has to travel alone. Each lane therefore splits in
      // two: a flat request for its totals, and a histogram request for its
      // trend. That is not just a workaround; it means a lane's tiles survive
      // its trend being refused, and vice versa.
      //
      // The lanes themselves are separate because they are separate
      // POPULATIONS — systemSubmitted true and false — not for tidiness.
      const run = (systemSubmitted, aggregations) => aggregateAcrossWindows(
        f, (w) => searchEvaluations(api, org.id,
          toSearchRequest(f, { window: w, systemSubmitted, aggregations })));

      setStatus("Querying auto-evaluation and assistance…");
      const [autoRes, autoTrendRes, eaRes, eaTrendRes] = await Promise.allSettled([
        // R1 — auto-evaluation totals. Evaluation-level fields only (§8.2a).
        run(true, [
          termAggregation("failureType", "aiScoringFailureType"),
          sumAggregation("disputes", "disputeCount"),
          sumAggregation("rescores", "rescoreCount"),
        ]),
        // R1b — auto-evaluation trend. One top-level aggregation, alone.
        run(true, [
          dateHistogramAggregation("overTime", dateField, ci, [
            sumAggregation("disputes", "disputeCount"),
            sumAggregation("rescores", "rescoreCount"),
          ]),
        ]),
        // R2 — assistance totals. Attached to evaluations a PERSON submitted,
        // which is why these cannot ride along with the requests above.
        run(false, [
          sumAggregation("offered", "eaSuggestionCount"),
          sumAggregation("accepted", "eaAcceptedSuggestionCount"),
        ]),
        // R2b — assistance trend.
        run(false, [
          dateHistogramAggregation("overTime", dateField, ci, [
            sumAggregation("offered", "eaSuggestionCount"),
            sumAggregation("accepted", "eaAcceptedSuggestionCount"),
          ]),
        ]),
      ]);

      // `value` first, not `sum`. A SUM aggregation answers in `value` and
      // leaves `sum` unset (EvaluationSearchAggregationResponse), and the
      // normaliser defaults an unset `sum` to 0 — so reading `sum` first made
      // every suggestion, dispute and rescore figure read zero no matter what
      // came back. `sum` stays as the fallback for STATS.
      const readSum = (agg) => agg?.value ?? agg?.sum ?? 0;

      /** Report a refused trend in its own panel, leaving the lane's tiles alone. */
      function trendFailed(trendKey, axisKey, noteKey, reason) {
        $(trendKey).innerHTML =
          '<div class="dq-bar-empty">Trend not available.</div>';
        $(axisKey).innerHTML = "";
        $(noteKey).textContent = `The trend query was rejected: ${reason?.message || reason}`;
        $(noteKey).hidden = false;
      }

      // ── Lane A — auto-evaluation ──────────────────
      if (autoRes.status === "rejected") {
        $("autoTiles").innerHTML = "";
        $("autoEmpty").textContent =
          `Auto-evaluation figures could not be loaded: ${autoRes.reason?.message || autoRes.reason}`;
        $("autoEmpty").hidden = false;
        $("failures").innerHTML = '<div class="dq-bar-empty">Not available.</div>';
      } else {
        const A = autoRes.value.aggregations;
        const scored = autoRes.value.total;
        const failures = (A.failureType?.buckets || []).reduce((s, b) => s + b.count, 0);
        const disputes = readSum(A.disputes);
        const rescores = readSum(A.rescores);

        $("autoTiles").innerHTML = [
          tile("Auto-evaluated", scored.toLocaleString(), "submitted by Virtual Supervisor"),
          tile("Scoring failures", failures.toLocaleString(),
            share(failures, scored) ? `${share(failures, scored)} of them` : "none in this period"),
          tile("Disputed", disputes.toLocaleString(), "disputes raised against them"),
          tile("Rescored", rescores.toLocaleString(), "scored again by a person"),
        ].join("");

        $("autoEmpty").hidden = scored > 0;
        if (!scored) {
          $("autoEmpty").textContent =
            "No auto-evaluations in this period. Every figure in this lane is about " +
            "evaluations AI submitted itself, so they are all zero by definition rather " +
            "than because something failed.";
        }

        renderCountBars($("failures"),
          (A.failureType?.buckets || [])
            .map((b) => ({ label: failureLabel(b.key), count: b.count, fill: "dq-fill-bad" }))
            .sort((a, b) => b.count - a.count),
          { empty: "No AI scoring failures in this period." });

        $("overturnNote").hidden = !!(disputes + rescores);
        if (!(disputes + rescores)) {
          $("overturnNote").textContent =
            "Nothing was disputed or rescored in this period.";
        }
      }

      // ── Lane A trend, its own request ─────────────
      $("overturnSub").textContent =
        `Disputes and rescores per auto-evaluation, ${intervalLabel(ci).toLowerCase()}. ` +
        "A line that climbs means people are trusting the model less over time." + windowNote;
      if (autoTrendRes.status === "rejected") {
        trendFailed("overturnTrend", "overturnAxis", "overturnNote", autoTrendRes.reason);
      } else {
        // Disputes and rescores are EVENT counts — one evaluation can be
        // disputed twice — so this is events per evaluation, not a share of
        // evaluations, and the wording says so rather than implying a
        // percentage of evaluations that were overturned.
        const points = (autoTrendRes.value.aggregations.overTime?.buckets || [])
          .map((b) => ({
            key: b.key,
            num: readSum(b.sub?.disputes) + readSum(b.sub?.rescores),
            den: b.count,
          }))
          .sort((a, b) => (bucketDate(a.key) || 0) - (bucketDate(b.key) || 0));
        renderRateTrend($("overturnTrend"), $("overturnAxis"), points,
          { ci, partial, fill: "is-warnfill", noun: "auto-evaluations", verb: "overturned" });
      }

      // ── Lane B — evaluation assistance ────────────
      if (eaRes.status === "rejected") {
        $("eaTiles").innerHTML = "";
        $("eaEmpty").textContent =
          `Assistance figures could not be loaded: ${eaRes.reason?.message || eaRes.reason}`;
        $("eaEmpty").hidden = false;
      } else {
        const B = eaRes.value.aggregations;
        const offered = readSum(B.offered);
        const accepted = readSum(B.accepted);

        // Deliberately no "evaluations assisted" tile. `eaSuggestionCount` is
        // not a queryable criteria field, so there is no way to ask for "human
        // evaluations where assistance offered something" — the response total
        // here is every human evaluation, assisted or not. The lane reports
        // suggestions, and says "suggestions" (§8.1a).
        $("eaTiles").innerHTML = [
          tile("Suggestions offered", offered.toLocaleString(), "by Evaluation Assistance"),
          tile("Suggestions accepted", accepted.toLocaleString(), "kept by the evaluator"),
          tile("Acceptance rate", share(accepted, offered),
            offered ? "of what was offered" : "nothing offered in this period"),
        ].join("");

        $("eaEmpty").hidden = offered > 0;
        if (!offered) {
          $("eaEmpty").textContent =
            "No assistance suggestions in this period. Either Evaluation Assistance is not " +
            "switched on for these forms, or no human evaluations were submitted.";
        }

      }

      // ── Lane B trend, its own request ─────────────
      $("acceptSub").textContent =
        `Share of suggestions the evaluator kept, ${intervalLabel(ci).toLowerCase()}. ` +
        "This is the clearest signal on the page: it is people voting on the model's " +
        "answers one question at a time." + windowNote;
      if (eaTrendRes.status === "rejected") {
        trendFailed("acceptTrend", "acceptAxis", "acceptNote", eaTrendRes.reason);
      } else {
        $("acceptNote").hidden = true;
        const points = (eaTrendRes.value.aggregations.overTime?.buckets || [])
          .map((b) => ({
            key: b.key,
            num: readSum(b.sub?.accepted),
            den: readSum(b.sub?.offered),
          }))
          .sort((a, b) => (bucketDate(a.key) || 0) - (bucketDate(b.key) || 0));
        renderRateTrend($("acceptTrend"), $("acceptAxis"), points,
          { ci, partial, fill: "is-goodfill", noun: "suggestions", verb: "accepted" });
      }

      // ── Per-question bands, one per lane ──────────
      await Promise.all([
        renderPerQuestion(org.id, f, {
          bars: "autoQuestions", sub: "autoQSub", note: "autoQNote",
          field: "questionAiScored", systemSubmitted: true, who: "AI",
        }),
        renderPerQuestion(org.id, f, {
          bars: "eaQuestions", sub: "eaQSub", note: "eaQNote",
          field: "questionEaScored", systemSubmitted: false, who: "Assistance",
        }),
      ]);

      $("rangeLine").textContent = formatRange(f.from, f.to) +
        (partial ? " · today is still in progress" : "");

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
