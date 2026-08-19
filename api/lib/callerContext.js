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
const { classifyCaller, identifyCaller, getBearerToken, parseRegistry } = require("./orgConfigResolver");

const INTERNAL_COMPANY_ORG_ID = (process.env.INTERNAL_COMPANY_ORG_ID || "").trim();
const INTERNAL_OWNER = "internal";

// Spread into every context that carries no verified identity, so the shape is
// the same whether or not the lookup happened. A missing `userId` and a null
// one should not be two different things for a caller to handle.
const NO_IDENTITY = { userId: null, userEmail: "", userName: "" };

function isConfigured(registry) {
  return !!INTERNAL_COMPANY_ORG_ID || (registry && registry.length > 0);
}

/**
 * Derive the region hint for classification: the frontend sends the selected/
 * locked org slug in X-Org-Hint; fall back to the request's own orgId. This lets
 * a cross-region customer token be verified against the right Genesys region even
 * on endpoints that don't otherwise carry an org id.
 */
function getRequestHint(req) {
  const h = req.headers || {};
  const fromHeader = h["x-org-hint"] || h["X-Org-Hint"];
  if (fromHeader && typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
  const q = req.query && req.query.orgId;
  if (q) return String(q).trim();
  const b = req.body && req.body.orgId;
  if (b) return String(b).trim();
  return null;
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
 *   userId: string|null,       // VERIFIED Genesys user id, from the token
 *   userEmail: string,         // verified; "" when identity is unavailable
 *   userName: string,          // verified; "" when identity is unavailable
 * }>}
 *
 * `userId` answers "who is asking", which the org classification alone cannot.
 * It is derived from the caller's own token, never from the request body, and
 * is null when identity could not be established — so anything gating on it
 * fails closed rather than open.
 *
 * Resolving it costs one users/me call per token per cache window. That is
 * cheap and on by default, because the failure mode of forgetting to ask for
 * identity is a privileged action silently denied — hard to diagnose. Pass
 * `{ identify: false }` where the round trip is not worth it and nothing on
 * that path reads `userId`; the failure mode there is only a little latency.
 */
async function getCallerContext(context, req, { hintId = null, identify = true } = {}) {
  const token = getBearerToken(req);
  const hint = hintId || getRequestHint(req);
  const registry = parseRegistry(context);
  const configured = isConfigured(registry);

  // Legacy/compatibility: no org env configured yet → behave as internal (today's
  // behavior). No classification runs here, so there is no verified region to
  // look the user up against and identity stays null. Both deployed
  // environments are configured; this is the local-dev path.
  if (!configured) {
    return { authorized: true, mode: "fallback", configured, customerId: null, ownerOrgId: INTERNAL_OWNER, ...NO_IDENTITY };
  }

  if (!token) {
    return { authorized: false, status: 401, error: "missing_token", mode: "no-token", configured, customerId: null, ownerOrgId: INTERNAL_OWNER, ...NO_IDENTITY };
  }

  const classification = await classifyCaller(context, token, hint);

  /**
   * Attach the caller's verified identity to an authorized context.
   *
   * The region comes from the classification rather than a default: it is the
   * one the token just proved itself against, which is the only region a
   * cross-region customer's token will answer on.
   */
  const withIdentity = async (base) => {
    if (!identify) return { ...base, ...NO_IDENTITY };
    const user = await identifyCaller(context, token, classification.org?.region);
    return {
      ...base,
      userId:    user?.id    || null,
      userEmail: user?.email || "",
      userName:  user?.name  || "",
    };
  };

  switch (classification.mode) {
    case "internal":
    case "fallback":
      return withIdentity({ authorized: true, mode: "internal", configured, customerId: null, ownerOrgId: INTERNAL_OWNER });
    case "customer":
      return withIdentity({
        authorized: true,
        mode: "customer",
        configured,
        customerId: classification.customer.id,
        ownerOrgId: classification.customer.id,
      });
    case "verify_failed":
      return { authorized: false, status: 401, error: "identity_verification_failed", mode: "verify_failed", configured, customerId: null, ownerOrgId: INTERNAL_OWNER, ...NO_IDENTITY };
    case "org_mismatch":
      return { authorized: false, status: 403, error: "org_locked", mode: "org_mismatch", configured, customerId: null, ownerOrgId: INTERNAL_OWNER, ...NO_IDENTITY };
    case "unrecognized":
    default:
      return { authorized: false, status: 403, error: "organization_not_recognized", mode: "unrecognized", configured, customerId: null, ownerOrgId: INTERNAL_OWNER, ...NO_IDENTITY };
  }
}

/** True if a stored record's ownerOrgId is visible to a caller with `callerOwnerId`. */
function ownerVisibleTo(recordOwnerId, callerOwnerId) {
  const owner = (recordOwnerId || INTERNAL_OWNER); // legacy/missing → internal
  return owner === callerOwnerId;
}

module.exports = { getCallerContext, ownerVisibleTo, INTERNAL_OWNER };
