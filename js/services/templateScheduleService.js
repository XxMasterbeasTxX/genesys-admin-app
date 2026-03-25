/**
 * Template Schedule Service — frontend API calls for template schedule CRUD.
 *
 * All methods talk to the /api/template-schedules Azure Function endpoint.
 */

const BASE = "/api/template-schedules";

/**
 * Fetch all template schedules, optionally filtered by org.
 * @param {string} [orgId]
 * @returns {Promise<Array>}
 */
export async function fetchTemplateSchedules(orgId) {
  const url = orgId ? `${BASE}?orgId=${encodeURIComponent(orgId)}` : BASE;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch template schedules (${res.status})`);
  return res.json();
}

/**
 * Create a new template schedule.
 * @param {Object} data  Must include templateId, orgId, mode, scheduleType, scheduleTime, userEmail
 * @returns {Promise<Object>}
 */
export async function createTemplateSchedule(data) {
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
 * Update an existing template schedule.
 * @param {string} id    Schedule ID
 * @param {Object} data  Fields to update (must include userEmail for auth)
 * @returns {Promise<Object>}
 */
export async function updateTemplateSchedule(id, data) {
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
 * Delete a template schedule.
 * @param {string} id         Schedule ID
 * @param {string} userEmail  Requesting user's email (for permission check)
 * @returns {Promise<Object>}
 */
export async function deleteTemplateSchedule(id, userEmail) {
  const res = await fetch(
    `${BASE}/${encodeURIComponent(id)}?userEmail=${encodeURIComponent(userEmail)}`,
    { method: "DELETE" }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Delete failed (${res.status})`);
  return json;
}
