/**
 * Evaluation query vocabulary — shared by every Dashboards › Quality page.
 *
 * See docs/dashboards-quality-design.md §5.1.
 *
 * Two Genesys endpoints answer questions about evaluations, and they speak
 * different languages for the same facts:
 *
 *   POST /api/v2/analytics/evaluations/aggregates/query   (§4.1 of the design)
 *     Pre-computed counts and score stats. No range limit. Dimension predicates
 *     with and/or clauses. Answers "how many" and "what score" at any scale.
 *
 *   POST /api/v2/quality/evaluations/search               (§4.2)
 *     Rows AND aggregations. Richer vocabulary — AI scoring, disputes,
 *     question-level detail — but a hard 3-month cap per request.
 *
 * This module owns the translation both ways so no page builds a request body
 * by hand, and owns the exact recombination of aggregation results across
 * 3-month windows (§9.2) so the cap does not limit what a page can show.
 *
 * DELIBERATE OMISSION: `AVERAGE` is not an exposed aggregation type. It returns
 * no count, so it cannot be recombined across windows, and every use of it is
 * served exactly by `STATS` instead. Making it unavailable is cheaper than
 * documenting when not to use it.
 */

// ─────────────────────────────────────────────────────────────────────
// The filter object
// ─────────────────────────────────────────────────────────────────────

import { localIso, utcIso, localTimeZone } from "../utils/dateRanges.js";

/**
 * @typedef {Object} EvaluationFilters
 * @property {string}   from            Inclusive start, yyyy-mm-dd.
 * @property {string}   to              Inclusive end, yyyy-mm-dd.
 * @property {string}   [timeBasis]     "conversation" | "created" | "released".
 * @property {string[]} [agentIds]
 * @property {string[]} [teamIds]       Work Team ids.
 * @property {string[]} [queueIds]
 * @property {string[]} [divisionIds]
 * @property {string[]} [formContextIds] Form CONTEXT ids — see note below.
 * @property {string[]} [mediaTypes]
 */

/**
 * Every filter, in both dialects.
 *
 * This table is the reason the group filter was dropped in the design (§2):
 * with it, one row here would have had no right-hand column and pages would
 * have had to filter some bands client-side and others server-side. Every row
 * below is native on both endpoints, so one filter object serialises to both
 * with nothing lost.
 *
 * NO QUEUE, deliberately (design §9a). An evaluation aggregate carries no
 * `queueId` — the queue a Genesys Interactions row shows belongs to the
 * CONVERSATION, which can pass through several queues, and no single evaluation
 * owns one of them. A queue filter here could only ever return nothing, so it
 * is not offered rather than offered and silently empty.
 *
 * On forms: `formContextIds` maps to the `contextId` field on both sides, not
 * `formId`. A form has a `formId` per VERSION and a `contextId` shared across
 * versions; filtering by version silently excludes evaluations scored on other
 * versions of the same form, which is never what picking a form by name means.
 */
const FILTER_MAP = Object.freeze([
  { key: "agentIds",       dimension: "userId",     searchField: "agentId"     },
  { key: "teamIds",        dimension: "teamId",     searchField: "agentTeamId" },
  { key: "divisionIds",    dimension: "divisionId", searchField: "divisionId"  },
  { key: "formContextIds", dimension: "contextId",  searchField: "contextId"   },
  { key: "mediaTypes",     dimension: "mediaType",  searchField: "mediaType"   },
]);

/**
 * Which timestamp a range is measured against.
 *
 * The three are genuinely different questions, and conflating them is the most
 * common way a QM number fails to reconcile with an interaction-volume number:
 * an evaluation of a January call, submitted in February, released in March,
 * belongs to a different month under each basis.
 */
const TIME_BASIS = Object.freeze({
  conversation: { aggregate: "conversationStart",       search: "conversationDate", label: "Conversation date" },
  created:      { aggregate: "evaluationCreatedDate",   search: "createdDate",      label: "Created" },
  released:     { aggregate: "evaluationReleaseDate",   search: "releaseDate",      label: "Released" },
});

export const TIME_BASIS_OPTIONS = Object.freeze(
  Object.entries(TIME_BASIS).map(([key, v]) => ({ key, label: v.label })),
);

/**
 * Media types an EVALUATION can carry.
 *
 * Not the same list as the conversation domain, which is the trap here. A
 * conversation is `voice`; the evaluation of that same conversation is `call`
 * (`Evaluation.mediaType` enumerates CALL, CALLBACK, CHAT, COBROWSE, EMAIL,
 * MESSAGE, INTERNAL_MESSAGE, SCREEN_MONITORING, SOCIAL_EXPRESSION, VIDEO,
 * SCREENSHARE). Filtering evaluations by `voice` therefore matches nothing at
 * all — silently, which is how it survived until a By media type band drew the
 * value back out as "call".
 *
 * The three underscored values are deliberately absent: how the aggregate
 * serialises them is unverified, and offering a filter that might silently
 * match nothing is the fault this list exists to fix. `mediaLabel` still names
 * them if they turn up in data.
 */
export const MEDIA_TYPES = Object.freeze([
  { id: "call",        label: "Call" },
  { id: "callback",    label: "Callback" },
  { id: "chat",        label: "Chat" },
  { id: "email",       label: "Email" },
  { id: "message",     label: "Message" },
  { id: "cobrowse",    label: "Cobrowse" },
  { id: "video",       label: "Video" },
  { id: "screenshare", label: "Screen share" },
]);

const MEDIA_LABEL_BY_ID = new Map(MEDIA_TYPES.map((m) => [m.id, m.label]));

/**
 * A media type as a person would write it.
 *
 * Falls back to tidying the raw value rather than calling it unknown: a value
 * this app has not seen is still Genesys' own word for something, and
 * "Internal message" reads better than "Unknown media (internal_message)".
 */
export function mediaLabel(raw) {
  if (!raw) return "No media recorded";
  const key = String(raw).toLowerCase();
  if (MEDIA_LABEL_BY_ID.has(key)) return MEDIA_LABEL_BY_ID.get(key);
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** AI scoring failure types, labelled for people rather than echoed raw. */
export const AI_FAILURE_LABELS = Object.freeze({
  QuotaReached: "Quota reached",
  ParsingError: "Parsing error",
  ServiceError: "Service error",
  InvalidRequest: "Invalid request",
  Unauthorized: "Not authorised",
  DuplicateFormSameAgent: "Duplicate form, same agent",
  DuplicateAutomatedFormWithCopiedScore: "Duplicate automated form (score copied)",
});

/** Evaluation statuses, in lifecycle order. */
export const EVALUATION_STATUSES = Object.freeze([
  "PENDING", "INPROGRESS", "INREVIEW", "FINISHED", "RETRACTED",
]);

// ─────────────────────────────────────────────────────────────────────
// Intervals
// ─────────────────────────────────────────────────────────────────────

/**
 * `yyyy-mm-dd` pair → the ISO-8601 interval the analytics domain expects,
 * carrying the viewer's own UTC offset at each end.
 *
 * The offset matters more than it looks. Genesys uses the INTERVAL's offset
 * for the range bounds even when `timeZone` is also supplied, so a `Z`-suffixed
 * interval asks for a UTC day whatever timezone is named alongside it. At
 * UTC+2 that puts everything from local midnight to 02:00 in the wrong day —
 * invisible across a month, decisive across "Today".
 */
export function toInterval(from, to) {
  return `${localIso(from)}/${localIso(to, true)}`;
}

/**
 * Split an inclusive day range into windows of at most `months` months.
 *
 * `quality/evaluations/search` requires a time range and rejects one longer
 * than 3 months (§9.1). The limit is per REQUEST, not per dataset, and every
 * aggregation this app asks for recombines exactly (§9.2) — so a long range
 * becomes several short requests rather than a refusal.
 *
 * Windows are contiguous and non-overlapping, which is what makes
 * `mergeAggregations` sound: every evaluation falls in exactly one.
 *
 * @returns {Array<{from: string, to: string}>}
 */
export function splitInterval(from, to, months = 3) {
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(end)) return [];

  const windows = [];
  let cursorDay = from;

  // Guard against a pathological range producing an unbounded loop. 3-month
  // windows over even a decade is 40; 200 is far past any legitimate use and
  // still finite.
  for (let i = 0; i < 200; i++) {
    const start = new Date(`${cursorDay}T00:00:00Z`);
    const stop = new Date(start);
    stop.setUTCMonth(stop.getUTCMonth() + months);
    stop.setUTCDate(stop.getUTCDate() - 1); // inclusive end

    const stopDay = stop.toISOString().slice(0, 10);
    if (Date.parse(`${stopDay}T00:00:00Z`) >= end) {
      windows.push({ from: cursorDay, to });
      return windows;
    }

    windows.push({ from: cursorDay, to: stopDay });

    const next = new Date(stop);
    next.setUTCDate(next.getUTCDate() + 1);
    cursorDay = next.toISOString().slice(0, 10);
  }
  return windows;
}

/** True when a range needs more than one search request. */
export function exceedsSearchWindow(from, to) {
  return splitInterval(from, to).length > 1;
}

// ─────────────────────────────────────────────────────────────────────
// Analytics aggregates — request
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a body for POST /api/v2/analytics/evaluations/aggregates/query.
 *
 * Multi-value filters become an `or` clause each, and the clauses AND together
 * — so "queue A or B, on team C" is expressible, which a flat predicate list
 * is not. The domain allows two levels of nesting; this uses one.
 *
 * @param {EvaluationFilters} filters
 * @param {Object}   [opts]
 * @param {string[]} [opts.groupBy]
 * @param {string[]} [opts.metrics=["nEvaluations"]]
 * @param {string}   [opts.granularity]  e.g. "P1D" — omit for a single bucket.
 * @param {Object[]} [opts.extraPredicates] Raw predicates ANDed in.
 * @param {Object[]} [opts.views]
 */
export function toAggregateQuery(filters, opts = {}) {
  const {
    groupBy,
    metrics = ["nEvaluations"],
    granularity,
    extraPredicates = [],
    views,
  } = opts;

  const body = { interval: toInterval(filters.from, filters.to), metrics };
  // Names the zone the response's granularity buckets are cut in, so an
  // hourly or daily series lines up with local days across a DST change.
  body.timeZone = localTimeZone();
  if (groupBy?.length) body.groupBy = groupBy;
  if (granularity) body.granularity = granularity;
  if (views?.length) body.views = views;

  const basis = TIME_BASIS[filters.timeBasis || "conversation"];
  if (basis) body.alternateTimeDimension = basis.aggregate;

  const clauses = [];
  for (const { key, dimension } of FILTER_MAP) {
    const values = filters[key];
    if (!values?.length) continue;
    clauses.push({
      type: "or",
      predicates: values.map((value) => ({ type: "dimension", dimension, value })),
    });
  }

  if (clauses.length || extraPredicates.length) {
    body.filter = { type: "and" };
    if (clauses.length) body.filter.clauses = clauses;
    if (extraPredicates.length) body.filter.predicates = extraPredicates;
  }

  return body;
}

/** A dimension predicate, for `extraPredicates`. */
export function dimensionPredicate(dimension, value) {
  return { type: "dimension", dimension, value: String(value) };
}

// ─────────────────────────────────────────────────────────────────────
// Analytics aggregates — response
// ─────────────────────────────────────────────────────────────────────

/**
 * Read one metric out of an aggregate response, keyed by a group dimension.
 *
 * Returns the whole stats object rather than a count, because an average must
 * be computed as `sum / count` across the WHOLE population — averaging a set of
 * per-group averages is wrong whenever the groups are unequally sized, and
 * returning a bare average here is what would invite it (§7.2).
 *
 * @returns {Map<string, {count:number, sum:number, min:number, max:number}>}
 */
export function parseGroupedAggregate(resp, dimension, metric = "nEvaluations") {
  const out = new Map();
  for (const row of resp?.results || []) {
    // A row whose group LACKS the dimension is data, not noise: an AI-scored
    // evaluation carries no evaluatorId, because no person scored it. Keyed to
    // "" so the page can name the absence rather than dropping the row, which
    // silently under-reported every grouped band by exactly the evaluations
    // that most needed explaining.
    const key = dimension ? (row.group?.[dimension] ?? "") : "__all__";
    const stats = findMetricStats(row, metric);
    if (!stats) continue;
    const prev = out.get(key);
    out.set(key, prev ? mergeStats(prev, stats) : normaliseStats(stats));
  }
  return out;
}

/**
 * Read one metric out of an ungrouped aggregate response.
 * @returns {{count:number, sum:number, min:number, max:number}}
 */
export function parseAggregateTotal(resp, metric = "nEvaluations") {
  let acc = null;
  for (const row of resp?.results || []) {
    const stats = findMetricStats(row, metric);
    if (!stats) continue;
    acc = acc ? mergeStats(acc, stats) : normaliseStats(stats);
  }
  return acc || emptyStats();
}

/**
 * Read a granular (time-bucketed) metric out of an aggregate response.
 * @returns {Array<{interval:string, stats:Object}>} in response order.
 */
export function parseAggregateSeries(resp, metric = "nEvaluations") {
  const points = [];
  for (const row of resp?.results || []) {
    for (const d of row.data || []) {
      const m = (d.metrics || []).find((x) => x.metric === metric);
      if (!m?.stats) continue;
      points.push({ interval: d.interval, stats: normaliseStats(m.stats) });
    }
  }
  return points;
}

/** First matching metric's stats across every interval bucket in a row. */
function findMetricStats(row, metric) {
  let acc = null;
  for (const d of row.data || []) {
    for (const m of d.metrics || []) {
      if (m.metric !== metric || !m.stats) continue;
      acc = acc ? mergeStats(acc, m.stats) : normaliseStats(m.stats);
    }
  }
  return acc;
}

function emptyStats() {
  return { count: 0, sum: 0, min: null, max: null };
}

function normaliseStats(s) {
  return {
    count: s.count ?? 0,
    sum: s.sum ?? 0,
    min: s.min ?? null,
    max: s.max ?? null,
  };
}

/** Combine two stats objects exactly — the basis of all window merging. */
function mergeStats(a, b) {
  const bn = normaliseStats(b);
  return {
    count: a.count + bn.count,
    sum: a.sum + bn.sum,
    min: a.min == null ? bn.min : bn.min == null ? a.min : Math.min(a.min, bn.min),
    max: a.max == null ? bn.max : bn.max == null ? a.max : Math.max(a.max, bn.max),
  };
}

/**
 * Average of a stats object, or null when there is nothing to average.
 *
 * The only sanctioned way to get an average out of this module. Everything
 * else returns count and sum so that this stays a single computation over the
 * whole population.
 */
export function statsAverage(stats) {
  if (!stats || !stats.count) return null;
  return stats.sum / stats.count;
}

// ─────────────────────────────────────────────────────────────────────
// Search — request
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a body for POST /api/v2/quality/evaluations/search.
 *
 * @param {EvaluationFilters} filters
 * @param {Object}   [opts]
 * @param {Object[]} [opts.aggregations]  Omit pageSize when aggregating.
 * @param {number}   [opts.pageSize]      0/omitted for aggregation requests.
 * @param {number}   [opts.pageNumber]
 * @param {string}   [opts.sortBy]
 * @param {string}   [opts.sortOrder]
 * @param {boolean|null} [opts.systemSubmitted] See the note below.
 * @param {Object[]} [opts.extraCriteria]  Raw criteria ANDed in.
 * @param {{from:string,to:string}} [opts.window] Override the filter's range,
 *        used when walking the windows from `splitInterval`.
 */
export function toSearchRequest(filters, opts = {}) {
  const {
    aggregations,
    pageSize,
    pageNumber,
    sortBy,
    sortOrder,
    systemSubmitted,
    extraCriteria = [],
    window,
  } = opts;

  const basis = TIME_BASIS[filters.timeBasis || "conversation"];
  const from = window?.from ?? filters.from;
  const to = window?.to ?? filters.to;

  const query = [{
    type: "DATE_RANGE",
    field: basis.search,
    // The search endpoint documents its format as yyyy-MM-dd'T'HH:mm:ss.SSS'Z',
    // so the local day boundary is converted to UTC rather than sent as an
    // offset string it may not accept. Same instant either way.
    startValue: utcIso(from),
    endValue: utcIso(to, true),
  }];

  for (const { key, searchField } of FILTER_MAP) {
    const values = filters[key];
    if (!values?.length) continue;
    query.push({ type: "EXACT", field: searchField, values: [...values] });
  }
  query.push(...extraCriteria);

  const body = { query };

  // The endpoint defaults `systemSubmitted` to FALSE, which silently excludes
  // every AI-scored evaluation. A page that wants both must ask for both, and
  // a page that forgets reports only human work while looking correct — hence
  // an explicit null meaning "both" rather than relying on the default.
  if (systemSubmitted === true || systemSubmitted === false) {
    body.systemSubmitted = systemSubmitted;
  }

  if (aggregations?.length) body.aggregations = aggregations;

  // `pageNumber` is REQUIRED even on a pure aggregation request. The endpoint's
  // own docs say only "omit or set pageSize = 0" for aggregations, which reads
  // as though paging is irrelevant there; omitting the page number is rejected
  // with "Page number cannot be null". So it is always sent, and an aggregation
  // request pins pageSize to 0 to ask for no rows alongside the totals.
  body.pageNumber = pageNumber || 1;
  if (aggregations?.length) body.pageSize = 0;
  else if (pageSize) body.pageSize = pageSize;

  if (sortBy) body.sortBy = sortBy;
  if (sortOrder) body.sortOrder = sortOrder;

  return body;
}

/** A TERM aggregation. `size` caps at 100 server-side. */
export function termAggregation(name, field, size = 100) {
  return { name, field, type: "TERM", size };
}

/** A SUM aggregation. */
export function sumAggregation(name, field) {
  return { name, field, type: "SUM" };
}

/** A STATS aggregation — use instead of AVERAGE, always. */
export function statsAggregation(name, field, subAggregations) {
  const a = { name, field, type: "STATS" };
  if (subAggregations?.length) a.subAggregations = subAggregations;
  return a;
}

/** A TERM aggregation carrying nested aggregations. */
export function termAggregationWith(name, field, subAggregations, size = 100) {
  return { name, field, type: "TERM", size, subAggregations };
}

/**
 * A DATE_HISTOGRAM aggregation, optionally carrying sub-aggregations.
 *
 * The sub-aggregations are what make a RATE over time possible. A bare
 * histogram gives a count per bucket, which only answers "how much"; nesting
 * two SUMs inside each bucket gives a numerator and a denominator per bucket,
 * which answers "what share" — and a share is the only version of most of this
 * data that can be compared between one month and the next.
 *
 * `EvaluationSearchSubAggregationDTO` permits the full type set under a
 * histogram parent, SUM included.
 */
export function dateHistogramAggregation(name, field, calendarInterval = "1d", subAggregations) {
  const a = { name, field, type: "DATE_HISTOGRAM", calendarInterval };
  if (subAggregations?.length) a.subAggregations = subAggregations;
  return a;
}

/**
 * The search-domain date field for a time basis.
 *
 * A histogram has to bucket on the SAME field the range was filtered on, or the
 * chart quietly describes a different period from the one the filter bar says
 * it does.
 */
export function searchDateField(timeBasis) {
  return (TIME_BASIS[timeBasis] || TIME_BASIS.conversation).search;
}

/**
 * A calendar interval for a histogram, matched to the range.
 *
 * Same thresholds as the aggregate domain's granularity so the two never
 * disagree about what "a bucket" means.
 */
export function calendarIntervalFor(days) {
  if (days <= 2) return "1h";
  return days <= 62 ? "1d" : "1w";
}

// ─────────────────────────────────────────────────────────────────────
// Search — response and window merging
// ─────────────────────────────────────────────────────────────────────

/**
 * Normalise the `aggregations` object of a search response.
 *
 * @returns {Object<string, {
 *   value:number|null, count:number, sum:number, min:number|null, max:number|null,
 *   buckets: Array<{key:string, count:number, sum:number, min:number|null, max:number|null}>,
 *   truncated: number
 * }>}
 */
export function parseSearchAggregations(resp) {
  const out = {};
  const raw = resp?.aggregations || {};
  for (const [name, agg] of Object.entries(raw)) {
    out[name] = normaliseAgg(agg);
  }
  return out;
}

function normaliseAgg(agg) {
  return {
    value: agg?.value ?? null,
    count: agg?.count ?? 0,
    sum: agg?.sum ?? 0,
    min: agg?.minimum ?? null,
    max: agg?.maximum ?? null,
    // `sumOtherDocumentCount` is what a TERM aggregation could not fit in its
    // 100 buckets. Carried through rather than dropped so a page can say the
    // breakdown is partial instead of quietly under-reporting (§9.2).
    truncated: agg?.sumOtherDocumentCount ?? 0,
    buckets: (agg?.buckets || []).map((b) => ({
      key: b.keyAsString ?? String(b.key ?? b.keyValue ?? ""),
      keyValue: b.keyValue ?? null,
      count: b.documentCount ?? b.count ?? 0,
      sum: b.sum ?? 0,
      min: b.minimum ?? null,
      max: b.maximum ?? null,
      value: b.value ?? null,
      // Nested aggregations, normalised the same way — a TERM on
      // questionGroupId carries its STATS sub-aggregation here, which is where
      // the per-group score actually lives.
      sub: Object.fromEntries(
        Object.entries(b.subAggregations || {}).map(([n, a]) => [n, normaliseAgg(a)]),
      ),
    })),
  };
}

/**
 * Recombine parsed aggregation sets from consecutive windows — exactly.
 *
 * This is sound only because every aggregation type this module exposes
 * carries both a count and a sum (§9.2 of the design):
 *
 *   TERM / COUNT     bucket counts add
 *   SUM              sums add
 *   STATS            counts add, sums add, min/max fold; average is recomputed
 *                    downstream as sum/count, never averaged from averages
 *   DATE_HISTOGRAM   buckets are disjoint across windows — they concatenate
 *   RANGE            bucket counts add
 *
 * `AVERAGE` is absent from that list and absent from this module, because it
 * returns no count and so cannot be recombined. `STATS` replaces it exactly.
 *
 * CAVEAT — high-cardinality TERM fields. A TERM aggregation returns at most
 * 100 buckets. A key that makes the top 100 in one window but not the next is
 * under-counted in the merge. `truncated` sums across windows so a page can
 * detect it; the design's rule is to chunk only low-cardinality TERM fields
 * and take high-cardinality breakdowns from the analytics domain, which has no
 * such cap.
 *
 * @param {Object[]} sets Output of `parseSearchAggregations`, one per window.
 */
export function mergeAggregations(sets) {
  const out = {};
  for (const set of sets) {
    for (const [name, agg] of Object.entries(set || {})) {
      const prev = out[name];
      if (!prev) {
        out[name] = { ...agg, buckets: agg.buckets.map((b) => ({ ...b })) };
        continue;
      }
      prev.count += agg.count;
      prev.sum += agg.sum;
      prev.truncated += agg.truncated;
      prev.min = prev.min == null ? agg.min : agg.min == null ? prev.min : Math.min(prev.min, agg.min);
      prev.max = prev.max == null ? agg.max : agg.max == null ? prev.max : Math.max(prev.max, agg.max);
      // `value` is a plain scalar for SUM/COUNT, so it adds. For anything
      // where adding is meaningless the pages read count/sum instead.
      if (typeof agg.value === "number") {
        prev.value = typeof prev.value === "number" ? prev.value + agg.value : agg.value;
      }
      mergeBuckets(prev.buckets, agg.buckets);
    }
  }
  return out;
}

function mergeBuckets(into, from) {
  const index = new Map(into.map((b, i) => [b.key, i]));
  for (const b of from) {
    const at = index.get(b.key);
    if (at === undefined) {
      index.set(b.key, into.length);
      into.push({ ...b });
      continue;
    }
    const t = into[at];
    t.count += b.count;
    t.sum += b.sum;
    t.min = t.min == null ? b.min : b.min == null ? t.min : Math.min(t.min, b.min);
    t.max = t.max == null ? b.max : b.max == null ? t.max : Math.max(t.max, b.max);
    if (typeof b.value === "number") {
      t.value = typeof t.value === "number" ? t.value + b.value : b.value;
    }
    mergeSub(t, b);
  }
}

/**
 * Fold one bucket's nested aggregations into another's.
 *
 * Without this a windowed TERM-with-STATS silently reports only the FIRST
 * window's sub-totals while its own count covers them all — the per-group score
 * would be right for January and wrong for the year.
 */
function mergeSub(target, source) {
  if (!source.sub) return;
  target.sub = target.sub || {};
  for (const [name, agg] of Object.entries(source.sub)) {
    const prev = target.sub[name];
    if (!prev) {
      target.sub[name] = { ...agg, buckets: (agg.buckets || []).map((x) => ({ ...x })) };
      continue;
    }
    prev.count += agg.count;
    prev.sum += agg.sum;
    prev.truncated += agg.truncated;
    prev.min = prev.min == null ? agg.min : agg.min == null ? prev.min : Math.min(prev.min, agg.min);
    prev.max = prev.max == null ? agg.max : agg.max == null ? prev.max : Math.max(prev.max, agg.max);
    if (typeof agg.value === "number") {
      prev.value = typeof prev.value === "number" ? prev.value + agg.value : agg.value;
    }
    mergeBuckets(prev.buckets, agg.buckets || []);
  }
}

/**
 * Run a search-backed aggregation across however many windows the range needs,
 * and hand back one merged result.
 *
 * @param {Function} runOne  (window) => Promise<rawSearchResponse>
 */
export async function aggregateAcrossWindows(filters, runOne, months = 3) {
  const windows = splitInterval(filters.from, filters.to, months);
  if (!windows.length) return { aggregations: {}, windows: 0 };
  const responses = await Promise.all(windows.map((w) => runOne(w)));
  return {
    aggregations: mergeAggregations(responses.map(parseSearchAggregations)),
    // Windows are disjoint, so the row totals add exactly. Worth carrying: it
    // is the only count of matching evaluations a pure aggregation request
    // gets back, and fetching it separately would be a second request for a
    // number already in the response.
    total: responses.reduce((s, r) => s + (r?.total || 0), 0),
    windows: windows.length,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────

/**
 * Sort a Map of stats into an array, for bar rendering.
 *
 * `dir` matters more than it looks. Counts are read largest-first — who did the
 * most. Scores are read smallest-first, because the actionable end of a score
 * distribution is the bottom of it, and a chart that buries the worst performer
 * below a "…and 40 more" line answers the wrong question.
 */
export function statsMapToSorted(map, by = "count", dir = "desc") {
  const rows = [...map.entries()]
    .map(([key, stats]) => ({ key, stats, value: by === "average" ? statsAverage(stats) : stats[by] }))
    .filter((r) => r.value != null);
  rows.sort((a, b) => (dir === "asc" ? a.value - b.value : b.value - a.value));
  return rows;
}

// ─────────────────────────────────────────────────────────────────────
// Score distribution
// ─────────────────────────────────────────────────────────────────────

/**
 * The bands a total score is bucketed into.
 *
 * Genesys total scores are percentages, so these are fixed rather than derived
 * from the data: a distribution whose buckets move with the sample cannot be
 * compared between two periods, which is the main thing anyone does with one.
 */
export const SCORE_BANDS = Object.freeze([
  { name: "band0", label: "Under 60%", gte: 0,  lt: 60 },
  { name: "band1", label: "60–79%",    gte: 60, lt: 80 },
  { name: "band2", label: "80–89%",    gte: 80, lt: 90 },
  { name: "band3", label: "90% and above", gte: 90, lt: 101 },
]);

/**
 * Build the `views` array that buckets a metric into the score bands.
 *
 * `rangeBound` is computed server-side, so the distribution costs nothing extra
 * and — unlike the search endpoint's RANGE aggregation — carries no 3-month
 * limit. It is the reason this band works at any date range.
 */
export function scoreBandViews(target = "oTotalScore") {
  return SCORE_BANDS.map((b) => ({
    name: b.name,
    target,
    function: "rangeBound",
    range: { gte: b.gte, lt: b.lt },
  }));
}

/**
 * Read the `views` out of an aggregate response.
 * @returns {Map<string, {count:number, sum:number, min:number, max:number}>}
 */
export function parseAggregateViews(resp) {
  const out = new Map();
  for (const row of resp?.results || []) {
    for (const d of row.data || []) {
      for (const v of d.views || []) {
        if (!v.name || !v.stats) continue;
        const prev = out.get(v.name);
        out.set(v.name, prev ? mergeStats(prev, v.stats) : normaliseStats(v.stats));
      }
    }
  }
  return out;
}

/** An empty filter object, for a page's initial state. */
export function emptyFilters(from, to) {
  return {
    from, to,
    timeBasis: "conversation",
    agentIds: [], teamIds: [],
    divisionIds: [], formContextIds: [], mediaTypes: [],
  };
}

/** True when any scope filter (not the date range) is set. */
export function hasScopeFilters(filters) {
  return FILTER_MAP.some(({ key }) => filters?.[key]?.length);
}
