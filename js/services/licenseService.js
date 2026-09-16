/**
 * Named-user licences — the client side of /api/licenses.
 *
 * Internal only: the page these serve is gated to Master Admin, and the
 * endpoint checks the same group again server-side. The caller's identity
 * comes from the forwarded token, never from anything sent here.
 */
import { withUserToken } from "./apiAuth.js";

async function call(method, path, body) {
  const resp = await fetch(path, {
    method,
    headers: withUserToken({ "Content-Type": "application/json", Accept: "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(licenseMessage(json.error, json, resp.status));
    err.code   = json.error || "request_failed";
    err.status = resp.status;
    throw err;
  }
  return json;
}

function licenseMessage(code, json, status) {
  switch (code) {
    case "superuser_required":        return "Only a superuser can change who has access to the internal organisation.";
    case "customer_manager_required": return "You have not been given the right to manage customer access. Ask a superuser.";
    case "identity_unavailable":      return "We could not verify who you are just now, so this change was not made. Try again in a moment.";
    case "internal_org_only":         return "Only users of the internal organisation can be given that right.";
    case "user_not_named":            return "That person is not on the list.";
    case "invalid_role":              return "That is not a role this page knows.";
    case "internal_only":             return "This page is for Netdesign staff.";
    case "not_a_customer":   return "This organisation is not set up as a customer yet — it has no registry entry, so nobody can sign in to it as a customer.";
    default:                 return `The request failed (${code || status}).`;
  }
}

/** Everyone currently named for a customer. */
export async function listLicensedUsers(customerId) {
  const r = await call("GET", `/api/licenses?customerId=${encodeURIComponent(customerId)}`);
  return r.users || [];
}

/** Name a user. Returns { user, created } — created is false if they already had access. */
export function assignLicense(customerId, { id, email, name }) {
  return call("POST", "/api/licenses/assign", { customerId, userId: id, email, name });
}

/**
 * Set the role on an internal user's row: "customer-manager" lets them name
 * users for customer orgs; "" takes that back. Superusers only, server-checked.
 * Returns { user, changed }.
 */
export function setLicenseRole(customerId, userId, role) {
  return call("POST", "/api/licenses/role", { customerId, userId, role });
}

/** Remove a user's access. Returns { user, revoked }. */
export function revokeLicense(customerId, userId) {
  return call("DELETE", "/api/licenses/assign", { customerId, userId });
}
