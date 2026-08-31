/**
 * Calendar-aligned date range helpers.
 *
 * Every date is a `yyyy-mm-dd` string in UTC. The app's analytics pages all
 * work in whole days against a data lake that is not real-time, so a range is
 * a pair of day strings and never a timestamp.
 *
 * "Last <period>" means the last COMPLETE one — last month is the whole of the
 * previous calendar month, not the trailing 30 days. That is what someone
 * comparing a QM report against an invoice means by it.
 */

/** Today, in UTC, as yyyy-mm-dd. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The latest day worth offering as a range end.
 *
 * Yesterday, not today: the analytics data lake lags, and a range ending today
 * reports a partial day as though it were a whole one — which reads as a sudden
 * drop on every trend chart.
 */
export function latestSelectableDay() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** First day of the month `offset` months ago (0 = this month). */
export function monthStart(offset = 0) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - offset);
  return d.toISOString().slice(0, 10);
}

/** Last day of the previous month. */
export function lastDayOfPrevMonth() {
  const d = new Date();
  d.setUTCDate(0); // day 0 of this month = last day of the previous one
  return d.toISOString().slice(0, 10);
}

/** Monday of the previous complete ISO week. */
export function lastWeekStart() {
  const d = new Date();
  const day = d.getUTCDay() || 7; // Sunday counts as 7
  d.setUTCDate(d.getUTCDate() - day - 6);
  return d.toISOString().slice(0, 10);
}

/** Sunday of the previous complete ISO week. */
export function lastWeekEnd() {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** First day of the last complete calendar year. */
export function lastYearStart() {
  return `${new Date().getUTCFullYear() - 1}-01-01`;
}

/** Last day of the last complete calendar year. */
export function lastYearEnd() {
  return `${new Date().getUTCFullYear() - 1}-12-31`;
}

/**
 * The presets offered by the analytics pages, in display order.
 *
 * Shared so that "Last Month" means the same thing on every page that offers
 * it — the failure this list exists to prevent is two pages disagreeing about
 * whether last month includes today.
 */
export const RANGE_PRESETS = Object.freeze([
  { key: "lastWeek",    label: "Last Week",     from: lastWeekStart, to: lastWeekEnd },
  { key: "lastMonth",   label: "Last Month",    from: () => monthStart(1), to: lastDayOfPrevMonth },
  { key: "last3Months", label: "Last 3 Months", from: () => monthStart(3), to: lastDayOfPrevMonth },
  { key: "last12Months",label: "Last 12 Months",from: () => monthStart(12), to: lastDayOfPrevMonth },
  { key: "lastYear",    label: "Last Year",     from: lastYearStart, to: lastYearEnd },
]);

/** Resolve a preset key to `{ from, to }`, or null if the key is unknown. */
export function resolvePreset(key) {
  const p = RANGE_PRESETS.find((x) => x.key === key);
  return p ? { from: p.from(), to: p.to() } : null;
}

/** Whole days spanned by an inclusive `from`–`to` pair. */
export function dayCount(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000) + 1;
}

/** Format an inclusive range for display: "1 Jan 2026 — 31 Mar 2026". */
export function formatRange(from, to) {
  const fmt = (s) => {
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  };
  return `${fmt(from)} — ${fmt(to)}`;
}
