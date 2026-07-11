/**
 * Customer-mode request guard for the Genesys proxy.
 *
 * Two layers:
 *   1. DENY list (always enforced in customer mode) — internal-only / trustee /
 *      cross-org / billing endpoints that must never be reachable by a customer
 *      session, regardless of entitlements.
 *   2. Positive entitlement ALLOWLIST (opt-in via ENFORCE_ENTITLEMENT_ALLOWLIST)
 *      — maps a Genesys API path to an app module key and requires a matching
 *      entitlement. Disabled by default because a precise path→module map can
 *      only be validated once the customer login path is testable; a wrong
 *      mapping would break legitimate customer features. Tenant isolation does
 *      NOT depend on this layer — it is enforced by token-forwarding + org lock.
 */

const ENFORCE_ENTITLEMENT_ALLOWLIST =
  String(process.env.ENFORCE_ENTITLEMENT_ALLOWLIST || "").toLowerCase() === "true";

// Endpoints a customer session may never touch (internal / trustee / billing).
const CUSTOMER_DENY_RULES = [
  /^\/api\/v2\/billing\b/i, // billing + trustee billing overview
  /^\/api\/v2\/authorization\/trustee/i, // trustee relationships
  /^\/api\/v2\/organizations\/authorization\/trustee/i,
];

// Best-effort Genesys path → app module key mapping (order matters; specific
// rules first). Only consulted when the positive allowlist is enabled.
const PATH_MODULE_RULES = [
  { test: /^\/api\/v2\/billing\b/i, module: "export.billing" },
  { test: /^\/api\/v2\/audits\b/i, module: "audit" },
  { test: /^\/api\/v2\/(analytics\/conversations|conversations)\b/i, module: "interactions" },
  { test: /^\/api\/v2\/recording\b/i, module: "interactions" },
  { test: /^\/api\/v2\/speechandtextanalytics\b/i, module: "interactions" },
  { test: /^\/api\/v2\/flows\/datatables\b/i, module: "data-tables" },
  { test: /^\/api\/v2\/flows\b/i, module: "flows" },
  { test: /^\/api\/v2\/integrations\/actions\b/i, module: "data-actions" },
  { test: /^\/api\/v2\/authorization\/(roles|permissions|subjects)\b/i, module: "roles" },
  { test: /^\/api\/v2\/authorization\/divisions\b/i, module: "divisions" },
  { test: /^\/api\/v2\/gdpr\b/i, module: "gdpr" },
];

function normalizePath(path) {
  const clean = String(path || "").trim();
  const q = clean.indexOf("?");
  return q === -1 ? clean : clean.slice(0, q);
}

/** True if the path is on the always-deny list for customer sessions. */
function isDeniedForCustomer(path) {
  const p = normalizePath(path);
  return CUSTOMER_DENY_RULES.some((rule) => rule.test(p));
}

/** Map a Genesys path to an app module key, or null if unmapped. */
function pathToModule(path) {
  const p = normalizePath(path);
  const rule = PATH_MODULE_RULES.find((r) => r.test.test(p));
  return rule ? rule.module : null;
}

/**
 * True if a granted entitlement covers a module key.
 * "interactions.*" grants "interactions"; "export.users.*" grants "export.users".
 */
function entitlementGrants(entitlement, moduleKey) {
  const ent = String(entitlement || "").trim();
  if (!ent) return false;
  if (ent === "*") return true;
  const base = ent.endsWith(".*") ? ent.slice(0, -2) : ent;
  return moduleKey === base || moduleKey.startsWith(base + ".") || base.startsWith(moduleKey + ".");
}

/**
 * Decide whether a customer request is permitted.
 *
 * Returns { allowed: boolean, reason?: string }.
 * - Deny list is always enforced.
 * - Positive allowlist only when ENFORCE_ENTITLEMENT_ALLOWLIST is true.
 */
function checkCustomerRequest(path, entitlements) {
  if (isDeniedForCustomer(path)) {
    return { allowed: false, reason: "endpoint_not_available_for_customer" };
  }

  if (!ENFORCE_ENTITLEMENT_ALLOWLIST) {
    return { allowed: true };
  }

  const moduleKey = pathToModule(path);
  if (!moduleKey) {
    // Fail-closed: an unmapped endpoint cannot be matched to a purchased module.
    return { allowed: false, reason: "endpoint_not_entitled" };
  }

  const list = Array.isArray(entitlements) ? entitlements : [];
  const ok = list.some((ent) => entitlementGrants(ent, moduleKey));
  return ok ? { allowed: true } : { allowed: false, reason: "endpoint_not_entitled" };
}

module.exports = {
  ENFORCE_ENTITLEMENT_ALLOWLIST,
  isDeniedForCustomer,
  pathToModule,
  checkCustomerRequest,
};
