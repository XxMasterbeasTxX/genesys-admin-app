/**
 * Billing service — wraps the two Genesys API calls we need for the
 * billing export feature, routed through the existing `/api/genesys-proxy`.
 *
 * Why two calls?
 *   1. We need the trustor org's Genesys UUID
 *      → `GET /api/v2/organizations/me` authenticated as the TRUSTOR org.
 *   2. We then fetch billing data
 *      → `GET /api/v2/billing/trusteebillingoverview/{trustorOrgId}?billingPeriodIndex=N`
 *        authenticated as the TRUSTEE org (which holds the trust relationship).
 *
 * The trustor/trustee mapping is defined in `utils/billingTrustees.js`.
 *
 * All requests go through `apiClient.proxyGenesys(customerId, ...)`, which
 * uses per-customer credentials configured server-side (see `api/genesys-proxy`).
 *
 * CUSTOMER MODE takes a different road to the same data. A customer session
 * has no trustee credentials and the proxy denies /api/v2/billing to it, so
 * `fetchBillingOverview` / `fetchBillingPeriods` call `/api/billing-overview`
 * instead: the server reads the overview FOR the customer, as their trustee,
 * for the org it verified their token against — never one named here. The
 * body is the same TrusteeBillingOverview, so everything downstream of these
 * functions is unchanged. See docs/customer-billing-design.md.
 */

import { getTrusteeForOrg, isBillingSimulated } from "../utils/billingTrustees.js";
import { orgContext } from "./orgContext.js";
import { withUserToken } from "./apiAuth.js";

/**
 * The org's named Admin Tool users at the overview's period peak, from
 * /api/licenses/peak — the app's own row on every billing sheet
 * (docs/billing-apps-section-design.md). Returned as null, never 0, when it
 * cannot be read: the processor writes "—" for null and a number for 0, and
 * those must stay different.
 *
 * A customer session's customerId is ignored server-side in favour of the
 * verified org; sending it is harmless and keeps one call shape.
 */
export async function fetchAdminToolUsers(customerId, overview) {
  const start = overview?.billingPeriodStartDate, end = overview?.billingPeriodEndDate;
  if (!start || !end) return null;
  try {
    const qs = new URLSearchParams({ customerId: customerId || "", start, end });
    const resp = await fetch(`/api/licenses/peak?${qs}`, { headers: withUserToken({ Accept: "application/json" }) });
    if (!resp.ok) return null;
    const body = await resp.json().catch(() => ({}));
    return typeof body.users === "number" ? body.users : null;
  } catch (_) {
    return null;
  }
}

/** Attach the Admin Tool count to an overview, so every consumer sees it. */
async function withAdminToolUsers(customerId, overview) {
  if (!overview || typeof overview !== "object") return overview;
  overview.adminToolUsers = await fetchAdminToolUsers(customerId, overview);
  return overview;
}

/**
 * A simulated org's overview, from the server. Internal callers name the
 * org; a customer session's own org is used regardless. Same shape as the
 * trustee path, flagged `simulated: true`.
 */
async function fetchSimulatedOverview(customerId, billingPeriodIndex) {
  const qs = new URLSearchParams({ customerId, billingPeriodIndex: String(billingPeriodIndex) });
  const resp = await fetch(`/api/billing-overview?${qs}`, { headers: withUserToken({ Accept: "application/json" }) });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`Simulated billing unavailable (${body.error || resp.status}).`);
    err.code = body.error || "billing_unavailable"; err.status = resp.status;
    throw err;
  }
  return body;
}

/**
 * Customer mode: one billing period from the server, read as the trustee.
 *
 * Errors carry `code` from the server (`no_trustee`, `permission_required`,
 * `permission_unverified`, `billing_period_not_found`, …) so a page can render
 * the permanent ones as a state rather than a failure.
 */
async function fetchCustomerOverview(billingPeriodIndex) {
  const resp = await fetch(`/api/billing-overview?billingPeriodIndex=${encodeURIComponent(String(billingPeriodIndex))}`, {
    headers: withUserToken({ Accept: "application/json" }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(customerBillingMessage(body.error, resp.status));
    err.code   = body.error || "billing_unavailable";
    err.status = resp.status;
    throw err;
  }
  return withAdminToolUsers(orgContext.get(), body);
}

/** Plain-language text for the server's billing answers. */
function customerBillingMessage(code, status) {
  switch (code) {
    case "no_trustee":               return "Billing is not available for this organisation through this app.";
    case "permission_required":      return "Your Genesys role does not include billing:subscription:view, which is needed to see billing.";
    case "permission_unverified":    return "Your permissions could not be verified, so billing cannot be shown.";
    case "billing_period_not_found": return "That billing period does not exist for this organisation.";
    case "customer_only":            return "This billing path is for customer sessions.";
    default:                         return `Billing is unavailable right now (${code || status}).`;
  }
}

/** True when a billing error is a permanent state for the org, not a fault. */
export function isPermanentBillingState(err) {
  return err && (err.code === "no_trustee" || err.code === "permission_required");
}

// ── Fallback labels (matches Python BILLING_PERIOD_OPTIONS in GUI_config.py) ──
const PERIOD_FALLBACK_LABELS = [
  "Current Period",
  "Previous Period",
  "Two Periods Ago",
  "Three Periods Ago",
];

/**
 * In-memory cache of billing periods per customer slug.
 * Matches Python `self.billing_periods_cache` — never busted on its own;
 * a hard refresh of the page is the only way to re-fetch.
 *
 *   Map<customerId, Period[]>
 *
 * Each Period:
 *   {
 *     index, label, startDate, endDate,
 *     overview,   // raw Genesys response (so Run can reuse it)
 *     error,      // error message if this index failed (overview is null)
 *   }
 */
const _periodCache = new Map();

/**
 * Fetch the trustor org's Genesys org UUID by authenticating as that org.
 *
 * @param {object} api          apiClient instance
 * @param {string} customerId   trustor customer slug (matches customers.json)
 * @returns {Promise<string>}   trustor org's Genesys UUID
 */
export async function getTrustorOrgId(api, customerId) {
  const me = await api.proxyGenesys(customerId, "GET", "/api/v2/organizations/me");
  if (!me?.id) {
    throw new Error(`Could not resolve org id for ${customerId}`);
  }
  return me.id;
}

/**
 * Fetch a single billing overview period for the given trustor org.
 *
 * @param {object} api                 apiClient instance
 * @param {string} trustorCustomerId   trustor customer slug
 * @param {number} billingPeriodIndex  0 = current, 1 = latest complete, 2.. = historical
 * @returns {Promise<object>}          Raw Genesys BillingOverview response
 */
export async function fetchBillingOverview(api, trustorCustomerId, billingPeriodIndex) {
  if (orgContext.isCustomer()) return fetchCustomerOverview(billingPeriodIndex);
  if (isBillingSimulated(trustorCustomerId)) {
    return withAdminToolUsers(trustorCustomerId, await fetchSimulatedOverview(trustorCustomerId, billingPeriodIndex));
  }

  const trusteeCustomerId = getTrusteeForOrg(trustorCustomerId);
  if (!trusteeCustomerId) {
    throw new Error(
      `${trustorCustomerId} is a trustee organisation itself and cannot be exported as a trustor.`
    );
  }

  // 1) Trustor → org UUID
  const trustorOrgId = await getTrustorOrgId(api, trustorCustomerId);

  // 2) Trustee → billing overview for that trustor UUID
  const overview = await api.proxyGenesys(
    trusteeCustomerId,
    "GET",
    `/api/v2/billing/trusteebillingoverview/${encodeURIComponent(trustorOrgId)}`,
    { query: { billingPeriodIndex: String(billingPeriodIndex) } }
  );
  return withAdminToolUsers(trustorCustomerId, overview);
}

/**
 * Convenience: fetch overview when the trustor org UUID is already known
 * (avoids the extra `/organizations/me` round-trip during multi-period
 * fetches such as Calendar Year or Date Range).
 *
 * @param {object} api
 * @param {string} trustorCustomerId
 * @param {string} trustorOrgId      Genesys UUID of the trustor org
 * @param {number} billingPeriodIndex
 * @returns {Promise<object>}
 */
export async function fetchBillingOverviewById(api, trustorCustomerId, trustorOrgId, billingPeriodIndex) {
  if (orgContext.isCustomer()) return fetchCustomerOverview(billingPeriodIndex);
  if (isBillingSimulated(trustorCustomerId)) {
    return withAdminToolUsers(trustorCustomerId, await fetchSimulatedOverview(trustorCustomerId, billingPeriodIndex));
  }

  const trusteeCustomerId = getTrusteeForOrg(trustorCustomerId);
  if (!trusteeCustomerId) {
    throw new Error(
      `${trustorCustomerId} is a trustee organisation itself and cannot be exported as a trustor.`
    );
  }
  const overview = await api.proxyGenesys(
    trusteeCustomerId,
    "GET",
    `/api/v2/billing/trusteebillingoverview/${encodeURIComponent(trustorOrgId)}`,
    { query: { billingPeriodIndex: String(billingPeriodIndex) } }
  );
  return withAdminToolUsers(trustorCustomerId, overview);
}

/**
 * Format an ISO date string as YYYY-MM-DD (UTC).
 */
function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * Fetch billing periods that fall within a specific calendar year (Jan-Dec)
 * for a single trustor org.
 *
 * Mirrors Python `get_billing_periods_for_calendar_year()` in
 * GUI_Billing_Export_Calendar_Year.py:
 *   - Walks billing period indices 1..13 (index 0 = current incomplete,
 *     skipped).
 *   - Includes a period if its startDate.year OR endDate.year matches.
 *   - On a 404 from the API, stops walking (no more historical periods).
 *   - Result sorted chronologically; capped at the 12 most recent.
 *   - Period label is "Mmm YYYY - Mmm YYYY".
 *
 * Failures other than 404 on individual indices are tolerated (logged
 * by the caller via the returned `errors` array).
 *
 * @param {object} api
 * @param {string} customerId             trustor customer slug
 * @param {number|string} calendarYear    e.g. 2025
 * @returns {Promise<{
 *   periods: Array<{
 *     index: number,
 *     label: string,
 *     startDate: string,
 *     endDate: string,
 *     overview: object,
 *   }>,
 *   errors: Array<{ index: number, error: string }>,
 * }>}
 */
export async function fetchBillingPeriodsForCalendarYear(api, customerId, calendarYear) {
  const year = Number(calendarYear);
  if (!Number.isFinite(year)) {
    throw new Error(`Invalid calendar year: ${calendarYear}`);
  }

  const simulated = orgContext.isCustomer() || isBillingSimulated(customerId);
  const trusteeCustomerId = simulated ? "simulated" : getTrusteeForOrg(customerId);
  if (!trusteeCustomerId) {
    throw new Error(
      `${customerId} is a trustee organisation itself and cannot be exported as a trustor.`
    );
  }

  // A simulated org has no trustor UUID to resolve; fetchBillingOverviewById
  // ignores the id for it anyway.
  const trustorOrgId = simulated ? "" : await getTrustorOrgId(api, customerId);

  const periods = [];
  const errors  = [];

  // Sequential walk — stop on 404 (matches Python `break` on status 404).
  for (let idx = 1; idx <= 13; idx++) {
    let ov;
    try {
      ov = await fetchBillingOverviewById(api, customerId, trustorOrgId, idx);
    } catch (err) {
      const status = err?.status || err?.response?.status;
      const code   = err?.code;
      if (status === 404 || code === 404) break;
      errors.push({ index: idx, error: err?.message || String(err) });
      continue;
    }
    if (!ov) continue;

    const startIso = ov.billingPeriodStartDate;
    const endIso   = ov.billingPeriodEndDate;
    const start    = startIso ? new Date(startIso) : null;
    const end      = endIso   ? new Date(endIso)   : null;
    if (!start || isNaN(start) || !end || isNaN(end)) continue;

    // Python: include if either endpoint's year matches the calendar year.
    if (start.getUTCFullYear() !== year && end.getUTCFullYear() !== year) {
      continue;
    }

    const label = `${MONTH_ABBR[start.getUTCMonth()]} ${start.getUTCFullYear()} - ` +
                  `${MONTH_ABBR[end.getUTCMonth()]} ${end.getUTCFullYear()}`;

    periods.push({
      index:     idx,
      label,
      startDate: fmtDate(startIso),
      endDate:   fmtDate(endIso),
      overview:  ov,
    });
  }

  // Sort chronologically by startDate and cap at 12.
  periods.sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (periods.length > 12) periods.splice(0, periods.length - 12);

  return { periods, errors };
}

/**
 * Fetch billing periods that overlap a given date range for a single trustor org.
 *
 * Mirrors the period-walk logic in
 * `GUI_tab_billing.py::_preview_date_range` / `_export_date_range`:
 *   - Walks billing period indices 1..N (index 0 = current incomplete, skipped).
 *   - A period is included if it OVERLAPS [fromDate, toDate]:
 *         period.start <= toDate AND period.end >= fromDate
 *   - Stops walking once 2 consecutive periods are entirely before `fromDate`
 *     (`periods_past_range >= 2`), which is Python's break condition.
 *   - Stops on a 404 (no more historical periods).
 *   - Result sorted chronologically.
 *
 * @param {object} api
 * @param {string} customerId             trustor customer slug
 * @param {Date|string} fromDate          inclusive lower bound (first of month)
 * @param {Date|string} toDate            inclusive upper bound (last day of month)
 * @returns {Promise<{
 *   periods: Array<{
 *     index: number,
 *     startDate: string,
 *     endDate: string,
 *     overview: object,
 *   }>,
 *   errors: Array<{ index: number, error: string }>,
 * }>}
 */
export async function fetchBillingPeriodsForDateRange(api, customerId, fromDate, toDate) {
  const from = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const to   = toDate   instanceof Date ? toDate   : new Date(toDate);
  if (!from || isNaN(from) || !to || isNaN(to)) {
    throw new Error(`Invalid date range: ${fromDate} to ${toDate}`);
  }
  if (to < from) {
    throw new Error(`Invalid range: to-date precedes from-date.`);
  }

  const trusteeCustomerId = getTrusteeForOrg(customerId);
  if (!trusteeCustomerId) {
    throw new Error(
      `${customerId} is a trustee organisation itself and cannot be exported as a trustor.`
    );
  }

  const trustorOrgId = await getTrustorOrgId(api, customerId);

  const periods = [];
  const errors  = [];
  let consecutiveBeforeRange = 0;
  const MAX_INDEX = 60; // hard safety cap

  for (let idx = 1; idx <= MAX_INDEX; idx++) {
    let ov;
    try {
      ov = await fetchBillingOverviewById(api, customerId, trustorOrgId, idx);
    } catch (err) {
      const status = err?.status || err?.response?.status;
      const code   = err?.code;
      if (status === 404 || code === 404) break;
      errors.push({ index: idx, error: err?.message || String(err) });
      continue;
    }
    if (!ov) continue;

    const startIso = ov.billingPeriodStartDate;
    const endIso   = ov.billingPeriodEndDate;
    const start    = startIso ? new Date(startIso) : null;
    const end      = endIso   ? new Date(endIso)   : null;
    if (!start || isNaN(start) || !end || isNaN(end)) continue;

    const overlaps = start <= to && end >= from;
    if (overlaps) {
      consecutiveBeforeRange = 0;
      periods.push({
        index:     idx,
        startDate: fmtDate(startIso),
        endDate:   fmtDate(endIso),
        overview:  ov,
      });
    } else if (end < from) {
      // Period ends before the range — once we see two of these in a row,
      // we can stop walking (older periods are also out of range).
      consecutiveBeforeRange += 1;
      if (consecutiveBeforeRange >= 2) break;
    } else {
      // Period starts after the range (newer than `to`) — keep walking
      // toward older indices.
      consecutiveBeforeRange = 0;
    }
  }

  periods.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return { periods, errors };
}

/**
 * Pre-fetch billing periods 0..3 for a customer.
 *
 * Mirrors Python `_get_billing_periods_for_org()` in `GUI_tab_billing.py`:
 *   - One `/organizations/me` call (as trustor) for the org UUID.
 *   - Four `trusteebillingoverview` calls (as trustee) for indices 0..3.
 *   - Failed indices fall back to generic labels (BILLING_PERIOD_OPTIONS).
 *   - Result cached per-customer in memory (re-selecting an org is instant).
 *
 * The raw overview is kept on each Period so the page can reuse it on Run
 * without a second API call.
 *
 * @param {object}   api
 * @param {string}   customerId
 * @param {object}   [opts]
 * @param {boolean}  [opts.force=false]   Bypass the cache and re-fetch.
 * @returns {Promise<Array<{
 *   index:     number,
 *   label:     string,
 *   startDate: string|null,
 *   endDate:   string|null,
 *   overview:  object|null,
 *   error:     string|null,
 * }>>}
 */
export async function fetchBillingPeriods(api, customerId, { force = false } = {}) {
  if (!force && _periodCache.has(customerId)) {
    return _periodCache.get(customerId);
  }

  let results;
  if (orgContext.isCustomer() || isBillingSimulated(customerId)) {
    // The server resolves the org and the trustee (or simulates); nothing to look up here.
    results = await Promise.allSettled([0, 1, 2, 3].map((i) =>
      orgContext.isCustomer()
        ? fetchCustomerOverview(i)
        : fetchSimulatedOverview(customerId, i).then((ov) => withAdminToolUsers(customerId, ov))
    ));

    // A permanent answer for the org — no trustee, no permission — comes back
    // on every index alike. Surface it once as the error it is, rather than
    // caching four "Failed to load" rows that hide the reason.
    const permanent = results.find((r) => r.status === "rejected" && isPermanentBillingState(r.reason));
    if (permanent && results.every((r) => r.status === "rejected")) throw permanent.reason;
  } else {
    const trusteeCustomerId = getTrusteeForOrg(customerId);
    if (!trusteeCustomerId) {
      throw new Error(
        `${customerId} is a trustee organisation itself and cannot be exported as a trustor.`
      );
    }

    // 1) Resolve trustor org UUID (single call).
    const trustorOrgId = await getTrustorOrgId(api, customerId);

    // 2) Fetch indices 0..3 in parallel; tolerate individual failures.
    results = await Promise.allSettled(
      [0, 1, 2, 3].map((i) =>
        fetchBillingOverviewById(api, customerId, trustorOrgId, i)
      )
    );
  }

  const periods = results.map((r, index) => {
    if (r.status === "fulfilled" && r.value) {
      const ov        = r.value;
      const startDate = fmtDate(ov.billingPeriodStartDate);
      const endDate   = fmtDate(ov.billingPeriodEndDate);
      const dateLabel = (startDate && endDate)
        ? `${startDate} to ${endDate}`
        : PERIOD_FALLBACK_LABELS[index];
      return {
        index,
        label:     dateLabel,
        startDate,
        endDate,
        overview:  ov,
        error:     null,
      };
    }
    const errMsg = r.reason?.message || "Failed to load";
    return {
      index,
      label:     PERIOD_FALLBACK_LABELS[index],
      startDate: null,
      endDate:   null,
      overview:  null,
      error:     errMsg,
    };
  });

  _periodCache.set(customerId, periods);
  return periods;
}

/**
 * Drop the cached periods for a customer (or all customers if no id given).
 * Useful for a manual "Reload periods" affordance.
 */
export function clearBillingPeriodsCache(customerId) {
  if (customerId == null) _periodCache.clear();
  else _periodCache.delete(customerId);
}
