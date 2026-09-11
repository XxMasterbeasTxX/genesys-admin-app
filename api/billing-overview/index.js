/**
 * GET /api/billing-overview?billingPeriodIndex=N
 *
 * A customer's own billing overview — prepay, usage, overage per licence for
 * one billing period — read by this app as the customer's trustee and handed
 * to them. The one place a customer session triggers a client-credential call,
 * and it is fenced (docs/customer-billing-design.md §2):
 *
 *   1. It is this endpoint, not the proxy. The proxy keeps /api/v2/billing on
 *      its always-deny list for customers.
 *   2. The org comes from the verified identity. There is no org parameter:
 *      classifyCaller verified the token against the registry and that is the
 *      org whose billing is read. Nothing in the request can point elsewhere.
 *   3. The user's OWN Genesys permission is checked here. Genesys enforces the
 *      trustee's permission on the call, not the user's, so this is the only
 *      place the user's is checked server-side. billing:subscription:view is
 *      what Genesys itself requires to show them billing in Genesys Admin;
 *      they see nothing here they could not see there. Fail closed.
 *   4. Internal sessions are refused. Staff read billing through the proxy as
 *      the trustee already, gated by affiliateOrganization:clientBilling:view.
 */
const { classifyCaller, getBearerToken } = require("../lib/orgConfigResolver");
const { fetchUserPermissions, hasAnyPermission } = require("../lib/userPermissions");
const { fetchOverviewForCustomer } = require("../lib/billingOverview");

// The ANY set Genesys declares for the self-service billableusage report —
// i.e. the permission that decides whether this person may see their own
// org's billing at all.
const REQUIRED_ANY = ["billing:subscription:view", "billing:subscription:read"];

// Index 0 is the current period, 1 the latest complete; the pages walk 0..3.
// Bounded so a client cannot turn this into a walk over an org's history.
const MAX_PERIOD_INDEX = 12;

function json(context, status, body) {
  context.res = { status, headers: { "Content-Type": "application/json" }, body };
}

function orgHint(req) {
  const h = req.headers || {};
  const v = h["x-org-hint"] || h["X-Org-Hint"];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

module.exports = async function (context, req) {
  try {
    const token = getBearerToken(req);
    if (!token) return json(context, 401, { error: "missing_token" });

    const classification = await classifyCaller(context, token, orgHint(req));
    switch (classification.mode) {
      case "customer":
        break;
      case "internal":
      case "fallback":
        // Fence 4. Staff have the proxy path; this endpoint has one caller type.
        return json(context, 403, { error: "customer_only" });
      case "verify_failed":
        return json(context, 401, { error: "identity_verification_failed" });
      case "org_mismatch":
        return json(context, 403, { error: "org_locked" });
      default:
        return json(context, 403, { error: "organization_not_recognized" });
    }

    // Fence 2: both of these come from the classification, not the request.
    const customerId = classification.customer.id;
    const orgId      = classification.org.id;
    const region     = classification.org.region;

    // Fence 3: the user's own permission, read on their own region.
    const perms = await fetchUserPermissions(token, region);
    if (perms === null) {
      return json(context, 403, { error: "permission_unverified", required: REQUIRED_ANY });
    }
    if (!hasAnyPermission(perms, REQUIRED_ANY)) {
      return json(context, 403, { error: "permission_required", required: REQUIRED_ANY });
    }

    const raw = req.query && req.query.billingPeriodIndex;
    const billingPeriodIndex = raw == null || raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(billingPeriodIndex) || billingPeriodIndex < 0 || billingPeriodIndex > MAX_PERIOD_INDEX) {
      return json(context, 400, { error: "invalid_billing_period_index", max: MAX_PERIOD_INDEX });
    }

    const result = await fetchOverviewForCustomer(context, { customerId, orgId, billingPeriodIndex });
    if (!result.ok) {
      // "no_trustee" is a permanent, truthful answer for the org, not a fault:
      // there is no trustee this app can read its billing as. 404, with the
      // code, so the page can render it as a state rather than an error.
      return json(context, 404, { error: result.error });
    }
    return json(context, 200, result.overview);
  } catch (err) {
    // A Genesys-side failure carries its status; anything else is ours.
    const status = err && err.status;
    if (status === 404) return json(context, 404, { error: "billing_period_not_found" });
    context.log.error("[billing-overview] Error:", err && (err.stack || err.message || err));
    return json(context, status && status >= 400 && status < 600 ? 502 : 500, { error: "billing_unavailable" });
  }
};
