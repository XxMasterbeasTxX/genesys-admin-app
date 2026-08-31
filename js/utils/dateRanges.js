/**
 * Calendar-aligned date range helpers.
 *
 * Every date is a `yyyy-mm-dd` string in the VIEWER'S OWN timezone, not UTC.
 * That distinction is invisible over a month and decisive over a day: at
 * UTC+2, a UTC "today" begins at 02:00 local, so anything done between
 * midnight and 02:00 lands on the wrong day and "Today" at 09:00 quietly
 * means "the last seven hours". The short presets below are the reason this
 * file works in local time at all.
 *
 * "Last <period>" means the last COMPLETE one — last month is the whole of
 * the previous calendar month, not the trailing 30 days. The three short
 * presets are the deliberate exception: Today and This week are partial by
 * definition, and the pages that offer them say so.
 */

/** The viewer's IANA timezone, e.g. "Europe/Copenhagen". */
export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Format a Date as `yyyy-mm-dd` in local time. */
export function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse `yyyy-mm-dd` into a local Date at the given time of day. */
function atLocal(day, h = 0, m = 0, s = 0, ms = 0) {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(y, mo - 1, d, h, m, s, ms);
}

/**
 * `yyyy-mm-dd` → an ISO-8601 timestamp carrying the LOCAL UTC offset,
 * e.g. `2026-08-31T00:00:00.000+02:00`.
 *
 * The offset is read from that specific date, so a range spanning a DST
 * change gets the right offset at each end rather than today's applied to
 * both. Genesys uses the interval's own offset for the range bounds even
 * when a `timeZone` is also supplied, so this is what actually decides
 * which evaluations fall inside "today".
 */
export function localIso(day, endOfDay = false) {
  const d = endOfDay ? atLocal(day, 23, 59, 59, 999) : atLocal(day);
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * `yyyy-mm-dd` → the same instant expressed as a UTC `…Z` timestamp.
 *
 * `quality/evaluations/search` documents its date format as
 * `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`, so it gets the local day boundary
 * converted to UTC rather than an offset string it may not accept.
 */
export function utcIso(day, endOfDay = false) {
  return (endOfDay ? atLocal(day, 23, 59, 59, 999) : atLocal(day)).toISOString();
}

/** Today, local, as yyyy-mm-dd. */
export function today() {
  return localDay();
}

/** Yesterday, local. */
export function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDay(d);
}

/**
 * The latest day a range may end on.
 *
 * Today — the dashboards deliberately allow a part-day range and mark it as
 * in progress. An earlier revision capped this at yesterday, borrowed from
 * the billing-style exports where a partial day silently corrupts a monthly
 * total. That is the right rule there and the wrong one here: "what happened
 * today" is a legitimate question of a dashboard.
 */
export function latestSelectableDay() {
  return today();
}

/** Monday of the current (incomplete) ISO week. */
export function thisWeekStart() {
  const d = new Date();
  const day = d.getDay() || 7; // Sunday counts as 7
  d.setDate(d.getDate() - day + 1);
  return localDay(d);
}

/** First day of the month `offset` months ago (0 = this month). */
export function monthStart(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - offset);
  return localDay(d);
}

/** Last day of the previous month. */
export function lastDayOfPrevMonth() {
  const d = new Date();
  d.setDate(0); // day 0 of this month = last day of the previous one
  return localDay(d);
}

/** Monday of the previous complete ISO week. */
export function lastWeekStart() {
  const d = new Date();
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day - 6);
  return localDay(d);
}

/** Sunday of the previous complete ISO week. */
export function lastWeekEnd() {
  const d = new Date();
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day);
  return localDay(d);
}

/** First day of the last complete calendar year. */
export function lastYearStart() {
  return `${new Date().getFullYear() - 1}-01-01`;
}

/** Last day of the last complete calendar year. */
export function lastYearEnd() {
  return `${new Date().getFullYear() - 1}-12-31`;
}

/**
 * The presets offered by the analytics pages, in display order.
 *
 * `partial: true` marks a preset whose range runs up to now rather than to a
 * completed day. Pages use it to mark the trailing bucket as in progress —
 * without it, a range ending today always looks like activity collapsed this
 * morning.
 */
export const RANGE_PRESETS = Object.freeze([
  { key: "today",       label: "Today",         partial: true, from: today,          to: today },
  { key: "yesterday",   label: "Yesterday",                    from: yesterday,      to: yesterday },
  { key: "thisWeek",    label: "This week",     partial: true, from: thisWeekStart,  to: today },
  { key: "lastWeek",    label: "Last Week",                    from: lastWeekStart,  to: lastWeekEnd },
  { key: "lastMonth",   label: "Last Month",                   from: () => monthStart(1), to: lastDayOfPrevMonth },
  { key: "last3Months", label: "Last 3 Months",                from: () => monthStart(3), to: lastDayOfPrevMonth },
  { key: "last12Months",label: "Last 12 Months",               from: () => monthStart(12), to: lastDayOfPrevMonth },
  { key: "lastYear",    label: "Last Year",                    from: lastYearStart,  to: lastYearEnd },
]);

/** Resolve a preset key to `{ from, to }`, or null if the key is unknown. */
export function resolvePreset(key) {
  const p = RANGE_PRESETS.find((x) => x.key === key);
  return p ? { from: p.from(), to: p.to() } : null;
}

/** True when a range runs up to today, so its last bucket is still filling. */
export function includesToday(to) {
  return to === today();
}

/** Whole days spanned by an inclusive `from`–`to` pair. */
export function dayCount(from, to) {
  const a = atLocal(from).getTime();
  const b = atLocal(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  // Round rather than floor: a DST change makes one of these days 23 or 25
  // hours long, and flooring would drop a day from any range spanning one.
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Format an inclusive range for display: "1 Jan 2026 — 31 Mar 2026". */
export function formatRange(from, to) {
  const fmt = (s) => {
    const d = atLocal(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };
  return from === to ? fmt(from) : `${fmt(from)} — ${fmt(to)}`;
}
