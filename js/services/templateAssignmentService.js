/**
 * Template Assignment Service — frontend API calls for template assignment tracking.
 *
 * All methods talk to the /api/template-assignments Azure Function endpoint.
 */

const BASE = "/api/template-assignments";

/**
 * Fetch all template assignments for an organisation.
 * @param {string} orgId
 * @returns {Promise<Array>}
 */
export async function fetchAssignments(orgId) {
  const res = await fetch(`${BASE}?orgId=${encodeURIComponent(orgId)}`);
  if (!res.ok) throw new Error(`Failed to fetch assignments (${res.status})`);
  return res.json();
}

/**
 * Fetch template assignments for a specific user.
 * @param {string} orgId
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function fetchUserAssignments(orgId, userId) {
  const qs = new URLSearchParams({ orgId, userId }).toString();
  const res = await fetch(`${BASE}?${qs}`);
  if (!res.ok) throw new Error(`Failed to fetch user assignments (${res.status})`);
  return res.json();
}

/**
 * Create a template assignment record.
 * @param {Object} data  Must include orgId, userId, templateId
 * @returns {Promise<Object>}
 */
export async function createAssignment(data) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Create assignment failed (${res.status})`);
  return json;
}

/**
 * Delete a specific assignment by ID.
 * @param {string} id    Assignment ID
 * @param {string} orgId Organisation ID
 * @returns {Promise<Object>}
 */
export async function deleteAssignment(id, orgId) {
  const qs = new URLSearchParams({ orgId }).toString();
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}?${qs}`, {
    method: "DELETE",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Delete assignment failed (${res.status})`);
  return json;
}

/**
 * Delete all assignments for a user+template combination.
 * @param {string} orgId
 * @param {string} userId
 * @param {string} templateId
 * @returns {Promise<Object>}
 */
export async function deleteAssignmentByUserTemplate(orgId, userId, templateId) {
  const qs = new URLSearchParams({ orgId, userId, templateId }).toString();
  const res = await fetch(`${BASE}?${qs}`, {
    method: "DELETE",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Delete assignment failed (${res.status})`);
  return json;
}

/**
 * Delete all assignments for a group+template combination.
 * @param {string} orgId
 * @param {string} groupId
 * @param {string} templateId
 * @returns {Promise<Object>}
 */
export async function deleteAssignmentByGroupTemplate(orgId, groupId, templateId) {
  const qs = new URLSearchParams({ orgId, groupId, templateId }).toString();
  const res = await fetch(`${BASE}?${qs}`, {
    method: "DELETE",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Delete assignment failed (${res.status})`);
  return json;
}

/**
 * Delete all assignments for a workteam+template combination.
 * @param {string} orgId
 * @param {string} workteamId
 * @param {string} templateId
 * @returns {Promise<Object>}
 */
export async function deleteAssignmentByWorkteamTemplate(orgId, workteamId, templateId) {
  const qs = new URLSearchParams({ orgId, workteamId, templateId }).toString();
  const res = await fetch(`${BASE}?${qs}`, {
    method: "DELETE",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Delete assignment failed (${res.status})`);
  return json;
}
