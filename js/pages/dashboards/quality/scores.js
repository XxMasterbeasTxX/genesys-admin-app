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
  queryConversationDetails,
} from "../../../services/genesysApi.js";
import { dayCount, formatRange, includesToday } from "../../../utils/dateRanges.js";
import { makeStatus, escapeHtml, spinHtml } from "../../../utils.js";
import { mediaLabel } from "../../../lib/evaluationQuery.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import { createEvaluationDetail } from "../../../components/evaluationDetail.js";

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
          <h3 class="dq-panel-title">By form</h3>
          <p class="dq-panel-sub">Average score per evaluation form, lowest first.</p>
          <div class="dq-bars" data-c="byForm"></div>
        </div>
        <div class="dq-panel">
          <h3 class="dq-panel-title">By media type</h3>
          <p class="dq-panel-sub">
            Average score per media type, lowest first. A conversation carrying
            more than one counts under each.
          </p>
          <div class="dq-bars" data-c="byMedia"></div>
        </div>
      </div>

      <details class="dq-panel dq-fold" data-c="agentFold">
        <summary class="dq-fold-summary">
          <span class="dq-panel-title">Agent average scores</span>
          <span class="dq-fold-hint" data-c="agentHint"></span>
        </summary>
        <p class="dq-panel-sub">
          Average score per agent. Lowest first, because the bottom of a score
          distribution is the end anyone can act on — reverse it to see the top.
        </p>
        <div class="dq-agent-controls">
          <div class="cs-control-group">
            <label class="cs-label">Score</label>
            <select class="input" data-c="agentMetric">
              <option value="total">Total</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div class="cs-control-group">
            <label class="cs-label">Order</label>
            <select class="input" data-c="agentOrder">
              <option value="asc">Lowest first</option>
              <option value="desc">Highest first</option>
            </select>
          </div>
          <div class="cs-control-group">
            <label class="cs-label">Agents</label>
            <div data-c="agentPick"></div>
          </div>
          <div class="cs-control-group">
            <label class="cs-label">Score between</label>
            <span class="dq-agent-range">
              <input class="input" type="number" data-c="agentMin" placeholder="0">
              <span>–</span>
              <input class="input" type="number" data-c="agentMax" placeholder="100">
            </span>
          </div>
        </div>
        <div class="dq-bars" data-c="byAgent"></div>
        <div class="dq-foot">
          <span class="dq-foot-count" data-c="agentCount"></span>
          <label class="dq-foot-size">
            Agents shown
            <select class="input" data-c="agentSize">
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </label>
        </div>
      </details>

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

      <details class="dq-panel dq-fold" data-c="detailFold">
        <summary class="dq-fold-summary">
          <span class="dq-panel-title">Evaluations</span>
          <span class="dq-fold-hint" data-c="detailHint"></span>
        </summary>
        <p class="dq-panel-sub" data-c="detailSub"></p>
        <div class="dq-detail-controls" data-c="detailControls" hidden>
          <div class="cs-control-group">
            <label class="cs-label">Fetch order</label>
            <select class="input" data-c="detailSort">
              <option value="conversationDate">Conversation date</option>
              <option value="submittedDate">Submitted</option>
              <option value="createdDate">Created</option>
              <option value="releaseDate">Released</option>
            </select>
          </div>
        </div>
        <div class="dq-table-wrap" data-c="detailWrap" hidden>
          <table class="dq-table">
            <thead>
              <tr>
                <th>Agent</th><th>Details</th><th>Evaluator</th><th>Form</th>
                <th>Conversation</th><th>Direction</th><th>Submitted</th>
                <th class="is-num">Score</th><th class="is-num">Critical</th>
                <th>Status</th><th>Released</th>
              </tr>
            </thead>
            <tbody data-c="detailRows"></tbody>
          </table>
        </div>
        <div class="dq-foot" data-c="detailFoot" hidden>
          <span class="dq-foot-count" data-c="detailCount"></span>
          <span class="dq-foot-pager">
            <button class="btn btn-sm" data-c="detailPrev">Previous</button>
            <span class="dq-detail-page" data-c="detailPage"></span>
            <button class="btn btn-sm" data-c="detailNext">Next</button>
          </span>
          <label class="dq-foot-size">
            Rows per page
            <select class="input" data-c="detailSize">
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </label>
        </div>
        <div class="dq-panel-note" data-c="detailNote" hidden></div>
      </details>

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

  const detail = createEvaluationDetail({ api });
  el.append(detail.el);

  // Delegated, because the tbody is rebuilt on every load and page turn — a
  // listener per button would have to be re-attached each time and leak the
  // ones it replaced.
  $("detailRows").addEventListener("click", (e) => {
    const btn = e.target.closest(".dq-detail-btn");
    if (!btn) return;
    const org = currentOrg();
    const cid = btn.dataset.cid;
    const eid = btn.dataset.eid;
    if (!org || !cid || !eid) return;
    const cells = btn.closest("tr").querySelectorAll("td");
    detail.open({
      orgId: org.id,
      conversationId: cid,
      evaluationId: eid,
      summary: {
        agent: cells[0]?.textContent.trim(),
        form: cells[3]?.textContent.trim(),
        conversation: cells[4]?.textContent.trim(),
        score: cells[7]?.textContent.trim(),
      },
    });
  });

  // The two search-backed bands need a permission the PAGE does not require.
  // Absent it the charts still work and the bands say why, per the composite
  // page rule in docs/customer-facing-plan.md §6.
  const canSearch = access && access.can
    ? access.can("dashboards.quality.scores", "detail")
    : true;

  // attachColumnFilters registers a document-level listener and returns its
  // disposer; the table is redrawn on every page turn, so the previous one is
  // released before the next is attached, and again on teardown.
  let disposeFilters = null;
  // The search endpoint refuses a page size over 100, so pages are fetched 100
  // at a time, FIVE AT ONCE — the same shape 750c028 gave the documentation
  // export after a single sequential page-walk ate 44 of its 47 seconds. The
  // response carries no total, so the walk stops when a batch returns a short
  // page; the cost of that is at most four wasted requests on the last batch.
  const FETCH_PAGE_SIZE = 100;
  const FETCH_CONCURRENCY = 5;
  const MAX_DETAIL_PAGES = 25;   // 2,500 rows, then the footer says it is partial
  let detailSize = 25;
  let detailVisible = [];
  let agentRows = { total: [], critical: [] };
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
    if (org && lastLoaded) renderQuestionGroups(org.id, lastLoaded);
    detailDirty = true;
    requestDetail();
  });

  $("detailSize").addEventListener("change", () => {
    detailSize = Number($("detailSize").value) || 25;
    detailPage = 1;
    showPage();
  });

  // Critical scores needs no request for this — the by-agent aggregate already
  // holds every agent, so the selector only decides how many bars are drawn.
  // Every control on this panel re-draws from data already in hand: the
  // by-agent aggregate carries both scores for every agent, so switching
  // metric, order, filter or size costs no request.
  for (const c of ["agentMetric", "agentOrder", "agentSize"]) {
    $(c).addEventListener("change", () => renderAgents());
  }
  for (const c of ["agentMin", "agentMax"]) {
    $(c).addEventListener("input", () => renderAgents());
  }

  // A multi-select rather than a text box: "how are these four doing" is the
  // question a supervisor actually brings, and typing one name at a time
  // cannot answer it. Searchable, so it still works at 400 agents.
  const agentPick = createMultiSelect({
    placeholder: "All agents",
    searchable: true,
    onChange: () => renderAgents(),
  });
  $("agentPick").append(agentPick.el);

  $("detailSort").addEventListener("change", () => {
    detailPage = 1;
    detailDirty = true;
    requestDetail();
  });

  // Collapsed by default, so the rows are fetched when the panel is opened
  // rather than on every load. A table nobody unfolds should not cost a query
  // — and unlike the Critical scores fold, whose data is already in hand from
  // the by-agent aggregate, this one is a request of its own.
  let detailDirty = true;
  $("detailFold").addEventListener("toggle", () => {
    // Only when something has actually changed since the last render. Folding
    // a table shut and open again is navigation, not a new question.
    if ($("detailFold").open && detailDirty) requestDetail();
  });

  /** Render the table if it is open; otherwise remember that it is stale. */
  function requestDetail() {
    const org = currentOrg();
    if (!org || !lastLoaded) return;
    if (!$("detailFold").open) { detailDirty = true; return; }
    detailDirty = false;
    renderDetail(org.id, lastLoaded);
  }
  $("detailPrev").addEventListener("click", () => {
    if (detailPage <= 1) return;
    detailPage -= 1;
    showPage();
  });
  $("detailNext").addEventListener("click", () => {
    detailPage += 1;
    showPage();
  });

  let optionsOrgId = null;
  async function ensureOptions(orgId) {
    if (optionsOrgId === orgId) return [];
    const warnings = await filters.loadOptions(orgId);
    optionsOrgId = orgId;
    return warnings;
  }

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

  const unsubscribe = orgContext?.onChange?.(() => {
    optionsOrgId = null;
    $results.hidden = true;
    // Both directions: a customer chosen fills the lists, a customer cleared
    // puts the prompt back rather than leaving the previous one's names up.
    primeOptions();
  });
  if (unsubscribe) {
    el.__destroy = () => { unsubscribe(); disposeFilters?.(); };
  } else {
    el.__destroy = () => disposeFilters?.();
  }

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

      const [totalResp, trendResp, distResp, agentResp, formResp, mediaResp, rescoreResp, systemResp] =
        await Promise.all([
          q({ metrics: SCORE }),
          q({ metrics: ["oTotalScore"], granularity }),
          q({ metrics: ["oTotalScore"], views: scoreBandViews("oTotalScore") }),
          q({ metrics: ["oTotalScore", "oTotalCriticalScore"], groupBy: ["userId"] }),
          q({ metrics: ["oTotalScore"], groupBy: ["contextId"] }),
          q({ metrics: ["oTotalScore"], groupBy: ["mediaType"] }),
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

      renderScoreBars($("byForm"),
        toScoreRows(parseGroupedAggregate(formResp, "contextId", "oTotalScore"), lookups.forms,
          { unknownLabel: "Unknown form", emptyLabel: "No form recorded" }));

      agentRows = {
        total: toScoreRows(agentScores, lookups.agents,
          { unknownLabel: "Unknown user", emptyLabel: "No agent recorded" }),
        critical: toScoreRows(agentCritical, lookups.agents,
          { unknownLabel: "Unknown user", emptyLabel: "No agent recorded" }),
      };
      // Keyed on the agent id the aggregate grouped by, so a name that repeats
      // is still two people.
      agentPick.setItemsKeepSelection(
        agentRows.total.map((r) => ({ id: r.key, label: r.label })));
      renderAgents();

      // A collapsed panel that says nothing is just a thing to click. The
      // summary carries the count so it is worth reading shut.
      $("agentHint").textContent = agentRows.total.length
        ? `${agentRows.total.length.toLocaleString()} agent(s)`
        : "nothing scored";

      renderScoreBars($("byMedia"),
        statsMapToSorted(parseGroupedAggregate(mediaResp, "mediaType", "oTotalScore"), "average", "asc")
          .map(({ key, stats, value }) => ({ key, label: mediaLabel(key), value, stats })));
      $("detailHint").textContent = exceedsSearchWindow(f.from, f.to)
        ? "needs a range of 3 months or less"
        : `${count.toLocaleString()} in this period`;

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
        why = "Nothing here yet.";
      }
      $why.textContent = why;
      $why.hidden = !why;

      // Search-backed bands, run after the aggregate ones are on screen and
      // never allowed to fail the page: they need a permission this page does
      // not require, and one of them needs a single form selected.
      detailPage = 1;
      lastLoaded = f;
      await renderQuestionGroups(org.id, f);
      detailDirty = true;
      requestDetail();

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
    // This band fetches a form definition and then one search per 3-month
    // window, so on a long range it is the slowest thing on the page. It said
    // nothing at all while it worked.
    $bars.innerHTML = `<div class="dq-bar-empty">${spinHtml("Loading question groups…")}</div>`;
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

  /**
   * Show one page of whatever survived the column filters.
   *
   * Paging is a view over the rows already fetched, so turning a page costs
   * nothing and a filter applies across the whole range rather than the
   * 25 rows that happened to be on screen.
   */
  function showPage(truncatedAt = 0) {
    const $rows = $("detailRows");
    const size = detailSize;
    const total = detailVisible.length;
    const pages = Math.max(Math.ceil(total / size), 1);
    if (detailPage > pages) detailPage = pages;
    const start = (detailPage - 1) * size;

    detailVisible.forEach((tr, i) => {
      tr.style.display = i >= start && i < start + size ? "" : "none";
    });

    const empty = $rows.querySelector(".dq-empty-row");
    if (empty) empty.hidden = total > 0;

    const shown = Math.min(size, Math.max(total - start, 0));
    $("detailCount").textContent = total
      ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}` +
        (truncatedAt ? ` (first ${truncatedAt.toLocaleString()} — narrow the dates for the rest)` : "")
      : "Nothing matches these filters";
    $("detailPage").textContent = `Page ${detailPage} of ${pages}`;
    $("detailPrev").disabled = detailPage <= 1;
    $("detailNext").disabled = detailPage >= pages;
  }

  /**
   * Draw the agent bars for whichever metric, order, filter and size are set.
   *
   * All of it comes from the by-agent aggregate already fetched, so none of
   * these controls costs a request — which is what makes a name filter and a
   * score range worth having here rather than a fixed "worst 25".
   */
  function renderAgents() {
    const metric = $("agentMetric").value === "critical" ? "critical" : "total";
    const size = Number($("agentSize").value) || 25;
    const picked = agentPick.getSelected();
    const min = $("agentMin").value === "" ? null : Number($("agentMin").value);
    const max = $("agentMax").value === "" ? null : Number($("agentMax").value);

    const all = agentRows[metric] || [];
    // No selection means everyone, not nobody — the dropdown reads "All agents"
    // in that state and must behave the way it reads.
    let rows = picked.size ? all.filter((r) => picked.has(r.key)) : all;
    if (min != null) rows = rows.filter((r) => r.value >= min);
    if (max != null) rows = rows.filter((r) => r.value <= max);

    // toScoreRows sorts ascending; reversing is cheaper and keeps one source
    // of truth for the ordering.
    if ($("agentOrder").value === "desc") rows = [...rows].reverse();

    renderScoreBars($("byAgent"), rows, { limit: size });

    const narrowed = picked.size > 0 || min != null || max != null;
    if (!all.length) {
      $("agentCount").textContent = "";
    } else if (!rows.length) {
      $("agentCount").textContent = "No agent matches these filters";
    } else {
      $("agentCount").textContent =
        `Showing ${Math.min(size, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}` +
        (narrowed ? ` matching \u2014 ${all.length.toLocaleString()} agent(s) in total` : " agent(s)");
    }
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
      $("detailFoot").hidden = true;
      return;
    }
    if (exceedsSearchWindow(f.from, f.to)) {
      $sub.textContent = "";
      $wrap.hidden = true;
      $controls.hidden = true;
      $("detailFoot").hidden = true;
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
    $rows.innerHTML = `<tr><td colspan="11" class="dq-bar-empty">${spinHtml("Loading evaluations…")}</td></tr>`;

    try {
      // Every evaluation in the range, not one page of it.
      //
      // The column filters offer the values they can SEE, so a page-at-a-time
      // table could only ever offer the 25 names on screen — which is not a
      // filter, it is a coincidence. Fetching the lot makes the dropdowns
      // complete and lets sorting mean something; paging below becomes a view
      // over the result rather than a query.
      const items = [];
      let truncated = false;
      const fetchPage = (page) => searchEvaluations(api, orgId, toSearchRequest(f, {
        pageSize: FETCH_PAGE_SIZE,
        pageNumber: page,
        sortBy: $("detailSort").value,
        sortOrder: "DESC",
        systemSubmitted: detailWho() === "ai",
      })).then((resp) => resp?.results || []);

      for (let first = 1; first <= MAX_DETAIL_PAGES; first += FETCH_CONCURRENCY) {
        const pages = [];
        for (let p = first; p < first + FETCH_CONCURRENCY && p <= MAX_DETAIL_PAGES; p++) pages.push(p);
        const batches = await Promise.all(pages.map(fetchPage));

        let done = false;
        for (const batch of batches) {
          items.push(...batch);
          if (batch.length < FETCH_PAGE_SIZE) { done = true; break; }
        }
        if (done) break;
        if (first + FETCH_CONCURRENCY > MAX_DETAIL_PAGES) truncated = true;
        $rows.innerHTML =
          `<tr><td colspan="11" class="dq-bar-empty">${spinHtml(
             `Loading evaluations… ${items.length.toLocaleString()} so far`)}</td></tr>`;
      }
      const hint = items.length ? null : otherSideHint();
      if (hint) { $note.textContent = hint; $note.hidden = false; }
      const lookups = filters.getLookups();
      let unresolved = null;
      $rows.innerHTML = "";
      if (!items.length) {
        $rows.innerHTML = '<tr><td colspan="11" class="dq-bar-empty">No evaluations on this page.</td></tr>';
      }
      for (const it of items) {
        const tr = document.createElement("tr");
        if (it.redacted) {
          // Shown rather than dropped: a table that silently omits rows the
          // caller may not see reports a smaller programme than exists.
          tr.innerHTML = '<td colspan="11" class="dq-redacted">An evaluation you do not have permission to see</td>';
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
          <td><button class="btn btn-sm dq-detail-btn" type="button"
                data-cid="${escapeHtml(it.conversation?.id || it.conversationId || "")}"
                data-eid="${escapeHtml(it.id || "")}">Show details</button></td>
          <td>${escapeHtml(evaluatorName)}</td>
          <td>${escapeHtml(formName || "—")}</td>
          <td data-value="${escapeHtml(it.conversationDate || "")}">${escapeHtml(shortDate(it.conversationDate))}</td>
          <td data-dir-for="${escapeHtml(it.conversation?.id || it.conversationId || "")}">—</td>
          <td data-value="${escapeHtml(it.submittedDate || "")}">${escapeHtml(shortDate(it.submittedDate))}</td>
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

      // Filters and sorting act on the rows this page is holding. The count
      // line says so in as many words, because a filter that silently searched
      // a quarter of the matches would be exactly the kind of half-truth this
      // feature has already been caught by twice.
      // Only the tbody is redrawn on a page turn, so the filter row survives —
      // and a second attach would inject a second set of buttons beside the
      // first, leaving the live ones bound to rows no longer in the document.
      // Emptying the row first is what keeps one attach per render.
      // Direction, joined on from the conversation domain (§7.6). Filled BEFORE
      // the column filters attach, because the filter builds its value list by
      // reading the cells — attach first and Direction would offer a list of
      // em-dashes for ever.
      await fillDirections(orgId, items);

      // The header row is also the filter row, so it must be stripped of the
      // previous render's controls before the next attach — otherwise each
      // redraw leaves another caret behind, bound to rows no longer present.
      disposeFilters?.();
      for (const th of $("detailWrap").querySelectorAll("thead th")) {
        th.querySelector(".cf-btn")?.remove();
        th.querySelector(".cf-dropdown")?.remove();
        th.querySelector(".cf-sort-mark")?.remove();
        th.classList.remove("cf-sortable", "cf-sorted", "cf-th");
      }
      // Column 1 is the Show details button: no filter, no sort, no arrow, no
      // tab stop. Every other index below is one higher than it was before that
      // column existed — get one wrong and Score silently gets a list of a
      // hundred values where a range belongs, with no error to notice.
      disposeFilters = attachColumnFilters($("detailWrap"), {
        compact: true,
        sortable: true,
        skipCols: [1],
        noSortCols: [1],
        numericCols: [7, 8],
        // Score and Critical are measured quantities: their distinct values run
        // to nearly one per row, so they get a FROM/TO range rather than a
        // hundred checkboxes. The two date columns get a date range for the
        // same reason — every row has its own timestamp.
        rangeCols: [7, 8],
        dateCols: [4, 6],
        onChange: (visible) => { detailVisible = visible; detailPage = 1; showPage(); },
      });

      detailVisible = Array.from($rows.querySelectorAll("tr"));

      // Added AFTER the filters are attached, so it is never mistaken for data
      // and never appears in a column's value list. It exists so that filtering
      // everything out leaves the table standing: an empty tbody collapses the
      // scroll box to the height of its header, which clips the very dropdown
      // being used and makes the filter impossible to undo.
      const emptyRow = document.createElement("tr");
      emptyRow.className = "dq-empty-row";
      emptyRow.innerHTML = '<td colspan="11" class="dq-bar-empty">No rows match these filters.</td>';
      emptyRow.hidden = true;
      $rows.append(emptyRow);

      detailPage = 1;
      showPage(truncated ? items.length : 0);
      $("detailFoot").hidden = false;
    } catch (err) {
      $rows.innerHTML = '<tr><td colspan="11" class="dq-bar-empty">Could not load evaluations.</td></tr>';
      $note.textContent = err.status === 403
        ? "Needs the quality:evaluation:searchAny permission."
        : `The evaluation search was rejected: ${err.message}`;
      $note.hidden = false;
      $("detailPrev").disabled = detailPage <= 1;
      $("detailNext").disabled = true;
    }
  }

  /**
   * Fill the Direction column by asking the conversation domain.
   *
   * An evaluation carries no direction anywhere (§7.6), so it has to be joined
   * from the conversation that was evaluated. `conversations/details/query`
   * takes `evaluationFilters`, so this asks for exactly the conversations that
   * have evaluations rather than every conversation in the period.
   *
   * The interval is derived from the rows themselves — their earliest and
   * latest conversation date — rather than from the filter bar. That matters
   * whenever "Dates refer to" is Created or Released: the rows are then chosen
   * by evaluation date, and their conversations can have started well outside
   * the range the user picked. Deriving it from the data is exact where padding
   * a guessed margin would not be.
   *
   * Needs `analytics:conversationDetail:view`, which is NOT this page's gate, so
   * a refusal leaves the column as em-dashes and says why rather than failing
   * the table.
   */
  async function fillDirections(orgId, items) {
    const $note = $("detailNote");
    const dates = items.map((it) => it.conversationDate).filter(Boolean).sort();
    if (!dates.length) return;

    const evaluationFilters = [];
    const preds = [];
    for (const id of lastLoaded?.agentIds || []) preds.push({ dimension: "userId", value: id });
    if (preds.length) evaluationFilters.push({ type: "or", predicates: preds });

    try {
      // A Genesys interval is half-open, so an end of exactly the latest
      // conversation start would exclude that conversation — the newest row on
      // the page, silently, every time. One second past it closes the gap.
      const end = new Date(Date.parse(dates[dates.length - 1]) + 1000).toISOString();
      const convs = await queryConversationDetails(api, orgId, {
        interval: `${dates[0]}/${end}`,
        ...(evaluationFilters.length ? { evaluationFilters } : {}),
        order: "asc",
        orderBy: "conversationStart",
      }, { maxPages: MAX_DETAIL_PAGES });

      const byId = new Map();
      for (const c of convs) {
        if (c.conversationId && c.originatingDirection) {
          byId.set(c.conversationId, c.originatingDirection);
        }
      }
      for (const td of $("detailRows").querySelectorAll("[data-dir-for]")) {
        const dir = byId.get(td.dataset.dirFor);
        td.textContent = dir ? dir.charAt(0).toUpperCase() + dir.slice(1) : "—";
      }
    } catch (err) {
      $note.textContent = err.status === 403
        ? "Direction is blank: it comes from the conversation domain, which needs analytics:conversationDetail:view."
        : `Could not load direction: ${err.message}`;
      $note.hidden = false;
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
