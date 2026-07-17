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
import { orgContext } from "./orgContext.js";

/** Merge X-Genesys-Token (+ X-Org-Hint) into a headers object. */
export function withUserToken(headers = {}) {
  const out = { ...headers };
  const token = getValidAccessToken();
  if (token) out["X-Genesys-Token"] = token;
  // The selected/locked org slug lets the backend pick the correct Genesys
  // region to verify a (cross-region) customer token against. Internal callers
  // are still classified by their home region, so this is a safe no-op for them.
  const org = orgContext.get();
  if (org) out["X-Org-Hint"] = org;
  return out;
}
