/**
 * Resolve authenticated org context from the backend.
 * The backend decides mode (internal/customer) and returns safe org metadata.
 */
export async function fetchOrgConfig(accessToken, orgHint) {
  const query = orgHint ? `?org=${encodeURIComponent(orgHint)}` : "";
  const resp = await fetch(`/api/org-config${query}`, {
    // Azure Static Web Apps strips/overwrites the Authorization header before it
    // reaches managed functions, so the user's Genesys token is forwarded in a
    // custom header (X-Genesys-Token). Authorization is kept as a fallback for
    // local dev / direct Functions hosts.
    headers: {
      "X-Genesys-Token": accessToken,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = json.error || json.message || `org-config failed (${resp.status})`;
    const err = new Error(detail);
    err.status = resp.status;
    err.body = json;
    throw err;
  }

  return json;
}

/**
 * Pre-login (unauthenticated) lookup of a customer org's PUBLIC login config.
 *
 * Given a customer slug (`?org=<slug>`), returns `{ id, name, region, clientId }`
 * so the app can build the OAuth authorize URL against the customer's own org
 * BEFORE the user authenticates. Only public fields are returned by the backend.
 *
 * Returns null when there is no hint or the org is unknown/not login-configured,
 * so the caller can fall back to the default internal login.
 */
export async function fetchOrgLoginConfig(orgHint) {
  if (!orgHint) return null;
  try {
    const resp = await fetch(`/api/org-config?org=${encodeURIComponent(orgHint)}`);
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json || json.prelogin !== true || !json.login) return null;
    return json.login;
  } catch (err) {
    console.error("[orgConfigService] pre-login lookup failed:", err);
    return null;
  }
}
