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
