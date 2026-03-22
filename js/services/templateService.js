/**
 * Template Service — frontend API calls for skill/queue template CRUD.
 *
 * All methods talk to the /api/templates Azure Function endpoint.
 */

const BASE = "/api/templates";

/**
 * Fetch all templates for an organisation.
 * @param {string} orgId
 * @returns {Promise<Array>}
 */
export async function fetchTemplates(orgId) {
  const res = await fetch(`${BASE}?orgId=${encodeURIComponent(orgId)}`);
  if (!res.ok) throw new Error(`Failed to fetch templates (${res.status})`);
  return res.json();
}

/**
 * Create a new template.
 * @param {Object} data  Must include orgId, name, userEmail, userName
 * @returns {Promise<Object>}
 */
export async function createTemplate(data) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Create failed (${res.status})`);
  return json;
}

/**
 * Update an existing template.
 * @param {string} id    Template ID
 * @param {Object} data  Fields to update (must include orgId, userEmail)
 * @returns {Promise<Object>}
 */
export async function updateTemplate(id, data) {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Update failed (${res.status})`);
  return json;
}

/**
 * Delete a template.
 * @param {string} id         Template ID
 * @param {string} orgId      Organisation ID
 * @param {string} userEmail  Requesting user's email (for permission check)
 * @returns {Promise<Object>}
 */
export async function deleteTemplate(id, orgId, userEmail) {
  const qs = new URLSearchParams({ orgId, userEmail }).toString();
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}?${qs}`, {
    method: "DELETE",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Delete failed (${res.status})`);
  return json;
}
