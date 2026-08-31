/**
 * Dashboards › Quality › Evaluation Scores
 *
 * See docs/dashboards-quality-design.md §7.
 *
 * The question: how are people scoring, and where are the failures concentrated?
 *
 * Everything on this page is answered by the analytics aggregate domain, so it
 * carries no date-range limit. The question-level breakdown and the row-level
 * detail table (§7.3, §7.4) need `quality/evaluations/search` and its 3-month
 * cap; they are separate build-order steps and are not here yet.
 *
 *   POST /api/v2/analytics/evaluations/aggregates/query
 *
 * Read-only, so no Activity Log entry.
 */

import { createEvaluationFilters } from "../../../components/evaluationFilters.js";
import {
  toAggregateQuery, parseGroupedAggregate, parseAggregateTotal,
  parseAggregateSeries, parseAggregateViews, statsMapToSorted, statsAverage,
  scoreBandViews, SCORE_BANDS, hasScopeFilters,
} from "../../../lib/evaluationQuery.js";
import { queryEvaluationAggregates } from "../../../services/genesysApi.js";
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

      const [totalResp, trendResp, distResp, agentResp, formResp, rescoreResp] =
        await Promise.all([
          q({ metrics: SCORE }),
          q({ metrics: ["oTotalScore"], granularity }),
          q({ metrics: ["oTotalScore"], views: scoreBandViews("oTotalScore") }),
          q({ metrics: ["oTotalScore", "oTotalCriticalScore"], groupBy: ["userId"] }),
          q({ metrics: ["oTotalScore"], groupBy: ["contextId"] }),
          q({ metrics: ["nEvaluationsRescored"] }),
        ]);

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

  return el;
}
