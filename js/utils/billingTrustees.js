/**
 * Billing trustee configuration.
 *
 * Ported verbatim from the Python project's GUI_config.py:
 *   - BILLING_TRUSTEE_ORGS
 *   - BILLING_ORG_TRUSTEE_MAP
 *   - get_trustee_for_org()
 *
 * Trustee orgs hold the credentials used to call the
 * `/api/v2/billing/trusteebillingoverview/{trustorOrgId}` endpoint on
 * behalf of other (trustor) orgs they have a trust relationship with.
 *
 * Customer-id slugs used here match `api/lib/customers.json`.
 */

/** Trustee orgs (have credentials, perform the API calls). */
export const BILLING_TRUSTEE_ORGS = {
  "demo": {
    description: "Netdesign DE — Primary trustee organization",
  },
  "test-ie": {
    description: "Test IE — Secondary trustee organization",
  },
};

/**
 * Org-to-trustee mapping (customer-id keyed).
 * If an org is not listed, it defaults to "demo".
 * A value of `null` means the org IS a trustee and should NOT be exported.
 */
export const BILLING_ORG_TRUSTEE_MAP = {
  "demo":        null,        // trustee — not exportable as trustor
  "test-ie":     null,        // trustee — not exportable as trustor
  "dktv":        "test-ie",
  "nuuday-test": "test-ie",
  // All other customers default to "demo"
};

/** Default trustee when an org has no explicit mapping. */
const DEFAULT_TRUSTEE_ID = "demo";

/**
 * Determine which trustee customer-id should be used to access the given org.
 * Returns null if the org is itself a trustee (and therefore not exportable).
 *
 * @param {string} customerId
 * @returns {string|null} trustee customer-id, or null if not exportable
 */
export function getTrusteeForOrg(customerId) {
  if (customerId in BILLING_ORG_TRUSTEE_MAP) {
    return BILLING_ORG_TRUSTEE_MAP[customerId];
  }
  return DEFAULT_TRUSTEE_ID;
}

/**
 * True if the given customer is itself a trustee org (cannot be exported
 * as a trustor — it would be self-referential).
 */
export function isTrusteeOrg(customerId) {
  return customerId in BILLING_TRUSTEE_ORGS;
}

/**
 * Filter a customer list down to those that are valid billing trustors
 * (i.e. not trustees themselves). Each `customer` must have an `id` field.
 *
 * @param {Array<{id: string}>} customers
 * @returns {Array} filtered customers
 */
export function filterBillableCustomers(customers) {
  return (customers || []).filter((c) => !isTrusteeOrg(c.id));
}
