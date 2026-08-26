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
//
// A page needs every endpoint it touches mapped, not just the one that writes.
// The Divisions pages read the objects they are about to move from the owning
// service — routing, outbound, telephony, WFM, workitems, scripts — and only the
// final move goes to /authorization/divisions. With those reads unmapped the
// whole namespace fell through to the fail-closed branch, so enabling the flag
// produced pages that could move objects they were never allowed to list.
//
// Hence `modules` is a list, not a single key: a configuration read is rarely
// owned by one feature. /routing/queues alone serves Divisions, Configure Users,
// Deployment, Interactions Move and the exports. A path is allowed when the
// session holds an entitlement for ANY listed module; narrowing these to one
// "primary" owner is what breaks the sibling features. Keep the deny list above
// as the hard boundary — this layer is coarse module gating, not isolation.
//
// Module keys are access-key prefixes as a customer can actually hold them (see
// packages.js). Internal-only features are not listed: internal sessions never
// reach this guard. The map is still not exhaustive — Documentation Export alone
// reads ~40 namespaces — so it remains incomplete for `export.*` until the
// customer login path is testable. Anything unmapped fails closed, by design.
const PATH_MODULE_RULES = [
  { test: /^\/api\/v2\/billing\b/i, modules: ["export.billing"] },
  { test: /^\/api\/v2\/audits\b/i, modules: ["audit"] },
  { test: /^\/api\/v2\/(analytics\/conversations|conversations)\b/i, modules: ["interactions"] },
  { test: /^\/api\/v2\/recording\b/i, modules: ["interactions"] },
  { test: /^\/api\/v2\/speechandtextanalytics\b/i, modules: ["interactions"] },
  { test: /^\/api\/v2\/flows\/datatables\b/i, modules: ["data-tables", "export"] },
  { test: /^\/api\/v2\/flows\b/i, modules: ["flows", "divisions", "export"] },
  { test: /^\/api\/v2\/integrations\/actions\b/i, modules: ["data-actions", "export"] },
  { test: /^\/api\/v2\/authorization\/(roles|permissions|subjects)\b/i, modules: ["roles", "users", "export"] },
  { test: /^\/api\/v2\/authorization\/divisions\b/i, modules: ["divisions", "users", "roles", "export"] },
  // Licence definitions, per-user assignments and /license/infer. Read by the
  // WEM check on Permissions vs. Users and by the Licenses → Consumption
  // export; unmapped, both would fail closed the moment the flag is enabled.
  { test: /^\/api\/v2\/license\b/i, modules: ["roles", "export.licenses", "export"] },
  { test: /^\/api\/v2\/gdpr\b/i, modules: ["gdpr"] },

  // Configuration reads behind the Divisions pages, shared with the features
  // that also list the same objects.
  { test: /^\/api\/v2\/routing\/wrapupcodes\b/i, modules: ["wrapupCodes", "divisions", "export"] },
  { test: /^\/api\/v2\/routing\b/i, modules: ["divisions", "users", "interactions", "export"] },
  { test: /^\/api\/v2\/outbound\b/i, modules: ["divisions", "wrapupCodes", "export"] },
  { test: /^\/api\/v2\/telephony\b/i, modules: ["divisions", "phones", "export"] },
  { test: /^\/api\/v2\/stations\b/i, modules: ["phones", "export"] },
  { test: /^\/api\/v2\/workforcemanagement\b/i, modules: ["divisions", "export"] },
  { test: /^\/api\/v2\/(workitems|taskmanagement)\b/i, modules: ["divisions", "export"] },
  { test: /^\/api\/v2\/scripts\b/i, modules: ["divisions", "export"] },
  { test: /^\/api\/v2\/(users|groups|teams)\b/i, modules: ["users", "divisions", "roles", "phones", "interactions", "gdpr", "export"] },
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

/** Map a Genesys path to the app module keys that may use it ([] if unmapped). */
function pathToModules(path) {
  const p = normalizePath(path);
  const rule = PATH_MODULE_RULES.find((r) => r.test.test(p));
  return rule ? rule.modules : [];
}

/** First module key owning a path, or null if unmapped. */
function pathToModule(path) {
  return pathToModules(path)[0] || null;
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

  const moduleKeys = pathToModules(path);
  if (!moduleKeys.length) {
    // Fail-closed: an unmapped endpoint cannot be matched to a purchased module.
    return { allowed: false, reason: "endpoint_not_entitled" };
  }

  const list = Array.isArray(entitlements) ? entitlements : [];
  const ok = list.some((ent) => moduleKeys.some((key) => entitlementGrants(ent, key)));
  return ok ? { allowed: true } : { allowed: false, reason: "endpoint_not_entitled" };
}

module.exports = {
  ENFORCE_ENTITLEMENT_ALLOWLIST,
  isDeniedForCustomer,
  pathToModule,
  pathToModules,
  checkCustomerRequest,
};
