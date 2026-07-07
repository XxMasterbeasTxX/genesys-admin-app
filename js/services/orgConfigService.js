/**
 * Resolve authenticated org context from the backend.
 * The backend decides mode (internal/customer) and returns safe org metadata.
 */
export async function fetchOrgConfig(accessToken, orgHint) {
  const query = orgHint ? `?org=${encodeURIComponent(orgHint)}` : "";
  const resp = await fetch(`/api/org-config${query}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
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
