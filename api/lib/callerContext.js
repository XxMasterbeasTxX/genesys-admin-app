/**
 * Caller context for the app-owned store endpoints (Step 6 — data-store isolation).
 *
 * Resolves WHO is calling (server-side, from the user's own Genesys token) so the
 * store endpoints can:
 *   - lock a CUSTOMER to their own org (never trust a client-supplied orgId), and
 *   - tag/scope OWNER-scoped stores (Activity Log, Schedules, Template-Schedules)
 *     so an org only ever sees records its own session created.
 *
 * Uses the same X-Genesys-Token + classifyCaller mechanism as the proxy. Never
 * throws — callers inspect `mode`/`authorized` to decide how to respond.
 *
 * ownerOrgId semantics:
 *   - customer session → the customer slug (e.g. "test-ie")
 *   - internal session → the constant INTERNAL_OWNER ("internal")
 *   - legacy records written before Step 6 have no ownerOrgId; readers treat
 *     a missing ownerOrgId as INTERNAL_OWNER so existing internal data stays visible.
 */
const { classifyCaller, getBearerToken, parseRegistry } = require("./orgConfigResolver");

const INTERNAL_COMPANY_ORG_ID = (process.env.INTERNAL_COMPANY_ORG_ID || "").trim();
const INTERNAL_OWNER = "internal";

function isConfigured(registry) {
  return !!INTERNAL_COMPANY_ORG_ID || (registry && registry.length > 0);
}

/**
 * @returns {Promise<{
 *   authorized: boolean,       // false → respond 401/403 (see `status`/`error`)
 *   status?: number,
 *   error?: string,
 *   mode: string,              // customer | internal | fallback | ...
 *   configured: boolean,
 *   customerId: string|null,   // customer slug when in customer mode, else null
 *   ownerOrgId: string,        // owner tag for OWNER-scoped stores
 * }>}
 */
async function getCallerContext(context, req, { hintId = null } = {}) {
  const token = getBearerToken(req);
  const registry = parseRegistry(context);
  const configured = isConfigured(registry);

  // Legacy/compatibility: no org env configured yet → behave as internal (today's behavior).
  if (!configured) {
    return { authorized: true, mode: "fallback", configured, customerId: null, ownerOrgId: INTERNAL_OWNER };
  }

  if (!token) {
    return { authorized: false, status: 401, error: "missing_token", mode: "no-token", configured, customerId: null, ownerOrgId: INTERNAL_OWNER };
  }

  const classification = await classifyCaller(context, token, hintId);

  switch (classification.mode) {
    case "internal":
    case "fallback":
      return { authorized: true, mode: "internal", configured, customerId: null, ownerOrgId: INTERNAL_OWNER };
    case "customer":
      return {
        authorized: true,
        mode: "customer",
        configured,
        customerId: classification.customer.id,
        ownerOrgId: classification.customer.id,
      };
    case "verify_failed":
      return { authorized: false, status: 401, error: "identity_verification_failed", mode: "verify_failed", configured, customerId: null, ownerOrgId: INTERNAL_OWNER };
    case "org_mismatch":
      return { authorized: false, status: 403, error: "org_locked", mode: "org_mismatch", configured, customerId: null, ownerOrgId: INTERNAL_OWNER };
    case "unrecognized":
    default:
      return { authorized: false, status: 403, error: "organization_not_recognized", mode: "unrecognized", configured, customerId: null, ownerOrgId: INTERNAL_OWNER };
  }
}

/** True if a stored record's ownerOrgId is visible to a caller with `callerOwnerId`. */
function ownerVisibleTo(recordOwnerId, callerOwnerId) {
  const owner = (recordOwnerId || INTERNAL_OWNER); // legacy/missing → internal
  return owner === callerOwnerId;
}

module.exports = { getCallerContext, ownerVisibleTo, INTERNAL_OWNER };
