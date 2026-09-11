/**
 * Billing trustee map, server-side.
 *
 * Trustee orgs hold the client credentials that may call
 * `/api/v2/billing/trusteebillingoverview/{trustorOrgId}` on behalf of the
 * orgs they have a trust relationship with. The map answers "as which org do
 * we read this customer's billing?".
 *
 * The same table lives in js/utils/billingTrustees.js and is copied into the
 * three scheduled billing exports under ./exports. This module is the one the
 * customer billing endpoint reads (docs/customer-billing-design.md §3.1); the
 * exports are deliberately left on their own copies for now — re-pointing a
 * scheduled job is a separate change. Keep the five in step until then.
 *
 * `null` means the org is itself a trustee and has no trustee this app can act
 * as, so its billing cannot be read here. Test IE is such an org: Netdesign DE
 * is not its trustee (confirmed 2026-09-11), so on Test IE the customer path
 * answers `no_trustee` — correctly, and by design (§7 of the design).
 */
const BILLING_ORG_TRUSTEE_MAP = {
  "demo":        null,        // trustee — not a trustor
  "test-ie":     null,        // trustee — not a trustor
  "dktv":        "test-ie",
  "nuuday-test": "test-ie",
  // All other customers default to "demo"
};

const DEFAULT_TRUSTEE_ID = "demo";

/**
 * The trustee slug to read `customerId`'s billing as, or `null` when there is
 * none.
 * @param {string} customerId
 * @returns {string|null}
 */
function trusteeFor(customerId) {
  if (Object.prototype.hasOwnProperty.call(BILLING_ORG_TRUSTEE_MAP, customerId)) {
    return BILLING_ORG_TRUSTEE_MAP[customerId];
  }
  return DEFAULT_TRUSTEE_ID;
}

module.exports = { BILLING_ORG_TRUSTEE_MAP, trusteeFor };
