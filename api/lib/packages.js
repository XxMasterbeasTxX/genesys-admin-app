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
