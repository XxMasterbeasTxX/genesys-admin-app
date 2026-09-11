/**
 * Read a customer's billing overview as their trustee.
 *
 * The only Genesys object that carries both prepay and usage per licence — the
 * two numbers overage is made of — is the trustee billing overview, and only a
 * trustee may fetch it (docs/customer-billing-design.md §1). So a customer's
 * own overage is read by this app AS the customer's trustee, for the customer's
 * org, and handed to them.
 *
 * This module knows nothing about HTTP requests or who is asking. The caller
 * (today api/billing-overview; later the overage-alert timer) is responsible
 * for having VERIFIED that `orgId` belongs to `customerId` before calling — the
 * endpoint takes both from the server-side classification, never from the
 * request. Nothing here re-checks that, and nothing here should be handed a
 * client-supplied org id.
 */
const customers = require("./customers.json");
const { getGenesysToken } = require("./genesysAuth");
const { trusteeFor } = require("./billingTrustees");

/**
 * One Genesys call as `customerId`, with that org's client credentials —
 * the same per-slug env convention the scheduled billing exports use
 * (`GENESYS_<SLUG>_CLIENT_ID` / `_CLIENT_SECRET`, slug upper-cased with `-`
 * as `_`).
 */
async function genesysCallAs(customerId, method, path) {
  const customer = customers.find((c) => c.id === customerId);
  if (!customer) throw new Error(`Unknown customer: ${customerId}`);

  const envKey       = `GENESYS_${customerId.replace(/-/g, "_").toUpperCase()}`;
  const clientId     = process.env[`${envKey}_CLIENT_ID`];
  const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    throw new Error(`Credentials not configured for ${customerId} (${envKey}_CLIENT_ID/SECRET)`);
  }

  const token = await getGenesysToken(customerId, customer.region, clientId, clientSecret);
  const resp  = await fetch(`https://api.${customer.region}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`Genesys API ${resp.status} for ${customerId} ${method} ${path}: ${body.message || body.error || ""}`);
    err.status = resp.status;
    throw err;
  }
  return body;
}

/**
 * The trustee billing overview for one of a customer's billing periods.
 *
 * @param {Object} context  Azure Functions context (for logging); optional.
 * @param {{ customerId: string, orgId: string, billingPeriodIndex: number }} p
 *   `customerId` — the customer slug; `orgId` — that customer's VERIFIED
 *   Genesys org id; `billingPeriodIndex` — 0 = current, 1 = latest complete.
 * @returns {Promise<{ ok: true, overview: object, trusteeId: string }
 *                 | { ok: false, error: "no_trustee" }>}
 *   Upstream failures throw, carrying `status` when Genesys answered.
 */
async function fetchOverviewForCustomer(context, { customerId, orgId, billingPeriodIndex }) {
  const trusteeId = trusteeFor(customerId);
  if (trusteeId === null) {
    context?.log?.(`[billing-overview] ${customerId} has no trustee this app can act as`);
    return { ok: false, error: "no_trustee" };
  }

  const index = Number.isInteger(billingPeriodIndex) ? billingPeriodIndex : 0;
  context?.log?.(`[billing-overview] ${customerId}: overview index ${index} for ${orgId} as trustee ${trusteeId}`);
  const overview = await genesysCallAs(
    trusteeId,
    "GET",
    `/api/v2/billing/trusteebillingoverview/${encodeURIComponent(orgId)}?billingPeriodIndex=${index}`,
  );
  return { ok: true, overview, trusteeId };
}

/**
 * The Genesys org id for a customer slug, for callers that hold only the slug
 * (a scheduled alert). The registry knows it for orgs that sign in as
 * customers; for the rest, ask the org itself with its own credentials —
 * the same `organizations/me` the scheduled billing exports make.
 * @returns {Promise<string|null>}
 */
async function resolveTrustorOrgId(context, customerId) {
  const { parseRegistry } = require("./orgConfigResolver");
  const entry = parseRegistry(context).find((e) => e.id === customerId);
  if (entry && entry.orgId) return entry.orgId;
  try {
    const me = await genesysCallAs(customerId, "GET", "/api/v2/organizations/me");
    return me && me.id ? String(me.id) : null;
  } catch (err) {
    context?.log?.warn?.(`[billing-overview] could not resolve org id for ${customerId}: ${err.message || err}`);
    return null;
  }
}

module.exports = { fetchOverviewForCustomer, resolveTrustorOrgId, genesysCallAs };
