/**
 * Sellable package catalog (server-side) for customer entitlements.
 *
 * A customer's registry entry can list the PACKAGES they bought instead of the
 * raw access-key prefixes. `parseRegistry` expands packages into the flat
 * `entitlements` list the rest of the app already uses (nav/route gating +
 * proxy allowlist), so nothing downstream changes.
 *
 * Keep this in sync with docs/customer-facing-plan.md §15 and
 * docs/customer-onboarding.md. Internal-only features (Utilities, Deployment,
 * cross-org copies, trustee/all-orgs/billing exports) are never packaged.
 */
const PACKAGES = {
  "insights": [
    "audit.*",
    "interactions.search.*",
    "export.users.*",
    "export.interactions.*",
    "export.scheduled",
  ],
  "interaction-ops": ["interactions.*"],
  "user-access": ["users.*", "roles.*", "divisions.*"],
  "configuration": [
    "data-tables.*",
    "data-actions.edit",
    "wrapupCodes.*",
    "flows.*",
    "phones.*",
  ],
  "gdpr": ["gdpr.*"],

  // Demo/evaluation bundle: every module a customer is allowed to hold.
  //
  // "*" is the wildcard both gates already understand — `resolveCustomerAccess`
  // in js/services/accessService.js short-circuits on it, and
  // `entitlementGrants` in ./entitlementAllowlist.js treats it as matching any
  // module key. It is NOT a bypass of the customer boundary: CUSTOMER_EXCLUDED_KEYS
  // (Utilities, Deployment, cross-org copies, trustee/all-orgs/billing exports,
  // flows.delete) is applied *after* the wildcard, and the proxy deny list is
  // independent of entitlements entirely.
  //
  // Deliberately a wildcard rather than the union of the packages above: it also
  // covers the customer-suitable modules no package sells yet (dashboards.*,
  // data-actions.test, export.documentation.*, export.licenses.*,
  // export.roles.singleOrg), and it stays complete as modules are added. The
  // flip side is that it grants each new customer-facing module on the day it
  // ships, with no review — which is why this is a demo bundle, not a sellable
  // tier. Do not hand it to a paying customer.
  "demo": ["*"],
};

/**
 * Expand a list of package names into a de-duplicated list of access-key
 * prefixes. Unknown package names are ignored.
 * @param {string[]} names
 * @returns {string[]}
 */
function expandPackages(names) {
  const out = new Set();
  for (const raw of Array.isArray(names) ? names : []) {
    const key = String(raw || "").trim().toLowerCase();
    const prefixes = PACKAGES[key];
    if (prefixes) prefixes.forEach((p) => out.add(p));
  }
  return [...out];
}

module.exports = { PACKAGES, expandPackages };
