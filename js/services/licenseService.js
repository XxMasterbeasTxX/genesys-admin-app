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
    case "group_required":   return `Only members of "${json.required}" can change who has access.`;
    case "group_unverified": return "Your group membership could not be verified, so this change was not made.";
    case "internal_only":    return "This page is for Netdesign staff.";
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

/** Remove a user's access. Returns { user, revoked }. */
export function revokeLicense(customerId, userId) {
  return call("DELETE", "/api/licenses/assign", { customerId, userId });
}
