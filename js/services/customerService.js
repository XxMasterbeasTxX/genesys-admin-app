import { withUserToken } from "./apiAuth.js";

/**
 * Fetches the list of available customer orgs from the Azure Functions API.
 * Returns an array of { id, name, region }.
 *
 * Internal callers only — the backend rejects customer sessions. Used by the
 * Trustee export, which is itself internal-only.
 */
export async function fetchCustomers() {
  const resp = await fetch("/api/customers", { headers: withUserToken() });
  if (!resp.ok) {
    throw new Error(`Failed to load customer list (${resp.status})`);
  }
  return resp.json();
}
