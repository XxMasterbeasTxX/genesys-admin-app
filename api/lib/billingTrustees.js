/**
 * Billing trustee lookup, server-side — read from customers.json.
 *
 * Trustee orgs hold the client credentials that may call
 * `/api/v2/billing/trusteebillingoverview/{trustorOrgId}` on behalf of the
 * orgs they have a trust relationship with. Each row in customers.json names
 * the trustee this app reads that org's billing as, in `billingTrustee`:
 *
 *   "demo"      — Netdesign DE reads it (the common case)
 *   "test-ie"   — Test IE reads it (dktv, nuuday-test)
 *   null        — nobody can: the org is itself a trustee, not a trustor
 *
 * This used to be a four-entry table copied into five files (this one, the
 * client's js/utils/billingTrustees.js, and the three scheduled billing
 * exports) with "unlisted means demo" implied in each. Now the row is the
 * truth: the exports require this module, and the browser receives the field
 * with the customer list, so adding a billable customer is one row in
 * customers.json and nothing else.
 *
 * A slug with no row keeps the old default of "demo". That is deliberate: a
 * customer can exist in CUSTOMER_REGISTRY_JSON without a customers.json row,
 * and the customer billing endpoint used to resolve such an org to Netdesign.
 * Every org that IS in customers.json carries the field explicitly, so the
 * default is only ever exercised for orgs the file does not know.
 */
const customers = require("./customers.json");

const DEFAULT_TRUSTEE_ID = "demo";

/**
 * The trustee slug to read `customerId`'s billing as, or `null` when there is
 * none.
 * @param {string} customerId
 * @returns {string|null}
 */
function trusteeFor(customerId) {
  const row = customers.find((c) => c.id === customerId);
  if (row && Object.prototype.hasOwnProperty.call(row, "billingTrustee")) return row.billingTrustee;
  return DEFAULT_TRUSTEE_ID;
}

/** Same lookup under the name the scheduled exports have always used. */
const getTrusteeForOrg = trusteeFor;

/** True if the org is itself a trustee — nobody reads its billing here. */
function isTrusteeOrg(customerId) {
  return trusteeFor(customerId) === null;
}

/** The customer list without the trustee orgs. Each item needs an `id`. */
function filterBillableCustomers(list) {
  return (list || []).filter((c) => !isTrusteeOrg(c.id));
}

module.exports = { trusteeFor, getTrusteeForOrg, isTrusteeOrg, filterBillableCustomers, DEFAULT_TRUSTEE_ID };
