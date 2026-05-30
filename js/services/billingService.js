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
 */

import { getTrusteeForOrg } from "../utils/billingTrustees.js";

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
  const trusteeCustomerId = getTrusteeForOrg(trustorCustomerId);
  if (!trusteeCustomerId) {
    throw new Error(
      `${trustorCustomerId} is a trustee organisation itself and cannot be exported as a trustor.`
    );
  }

  // 1) Trustor → org UUID
  const trustorOrgId = await getTrustorOrgId(api, trustorCustomerId);

  // 2) Trustee → billing overview for that trustor UUID
  return api.proxyGenesys(
    trusteeCustomerId,
    "GET",
    `/api/v2/billing/trusteebillingoverview/${encodeURIComponent(trustorOrgId)}`,
    { query: { billingPeriodIndex: String(billingPeriodIndex) } }
  );
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
  const trusteeCustomerId = getTrusteeForOrg(trustorCustomerId);
  if (!trusteeCustomerId) {
    throw new Error(
      `${trustorCustomerId} is a trustee organisation itself and cannot be exported as a trustor.`
    );
  }
  return api.proxyGenesys(
    trusteeCustomerId,
    "GET",
    `/api/v2/billing/trusteebillingoverview/${encodeURIComponent(trustorOrgId)}`,
    { query: { billingPeriodIndex: String(billingPeriodIndex) } }
  );
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

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

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

  const trusteeCustomerId = getTrusteeForOrg(customerId);
  if (!trusteeCustomerId) {
    throw new Error(
      `${customerId} is a trustee organisation itself and cannot be exported as a trustor.`
    );
  }

  const trustorOrgId = await getTrustorOrgId(api, customerId);

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

  const trusteeCustomerId = getTrusteeForOrg(customerId);
  if (!trusteeCustomerId) {
    throw new Error(
      `${customerId} is a trustee organisation itself and cannot be exported as a trustor.`
    );
  }

  // 1) Resolve trustor org UUID (single call).
  const trustorOrgId = await getTrustorOrgId(api, customerId);

  // 2) Fetch indices 0..3 in parallel; tolerate individual failures.
  const results = await Promise.allSettled(
    [0, 1, 2, 3].map((i) =>
      fetchBillingOverviewById(api, customerId, trustorOrgId, i)
    )
  );

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
