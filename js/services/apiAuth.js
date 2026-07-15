/**
 * Attach the signed-in user's Genesys token to app-owned store API calls.
 *
 * Azure Static Web Apps strips/overwrites Authorization, so the token is sent in
 * the custom X-Genesys-Token header — the same channel the proxy uses. The
 * backend uses it to enforce data-store isolation (customers are locked to their
 * own org; owner-scoped stores only return the caller org's records). See Step 6
 * in docs/customer-facing-plan.md.
 */
import { getValidAccessToken } from "./authService.js";

/** Merge X-Genesys-Token into a headers object (no-op if there is no token). */
export function withUserToken(headers = {}) {
  const token = getValidAccessToken();
  return token ? { ...headers, "X-Genesys-Token": token } : headers;
}
