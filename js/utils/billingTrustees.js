/**
 * Billing trustee lookup, client-side — read from the customer list.
 *
 * Trustee orgs hold the credentials used to call
 * `/api/v2/billing/trusteebillingoverview/{trustorOrgId}` on behalf of the
 * orgs they have a trust relationship with. Which org reads a customer's
 * billing is a fact about the customer, and it arrives with the customer:
 * every entry the server sends (`/api/customers`, org-config) carries
 * `billingTrustee` — a trustee slug, or `null` when the org is itself a
 * trustee and nobody reads its billing here.
 *
 * The truth lives in one place, api/lib/customers.json. This module used to
 * hold a copy of the table; the copy is gone, and these three functions
 * answer from `orgContext.getCustomers()` instead, so the pages that import
 * them are unchanged.
 */
import { orgContext } from "../services/orgContext.js";

/** What the server assumes for an org it has no row for. */
const DEFAULT_TRUSTEE_ID = "demo";

/**
 * Determine which trustee customer-id should be used to access the given org.
 * Returns null if the org is itself a trustee (and therefore not exportable).
 *
 * @param {string} customerId
 * @returns {string|null} trustee customer-id, or null if not exportable
 */
export function getTrusteeForOrg(customerId) {
  const c = (orgContext.getCustomers() || []).find((x) => x && x.id === customerId);
  if (c && Object.prototype.hasOwnProperty.call(c, "billingTrustee")) return c.billingTrustee;
  return DEFAULT_TRUSTEE_ID;
}

/**
 * True if the server answers this org's billing with a synthetic overview
 * (BILLING_SIMULATION_ORGS on the server; sent as `billingSimulated`).
 */
export function isBillingSimulated(customerId) {
  const c = (orgContext.getCustomers() || []).find((x) => x && x.id === customerId);
  return !!(c && c.billingSimulated === true);
}

/**
 * True if the given customer is itself a trustee org (cannot be exported
 * as a trustor — it would be self-referential).
 *
 * Every caller of this is really asking "can we NOT read this org's
 * billing?", so a simulated org answers false here: its billing is readable —
 * from the simulation — and the pages and filters should treat it as any
 * other billable org.
 */
export function isTrusteeOrg(customerId) {
  if (isBillingSimulated(customerId)) return false;
  return getTrusteeForOrg(customerId) === null;
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
