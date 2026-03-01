/**
 * Schedule Service — frontend API calls for schedule CRUD.
 *
 * All methods talk to the /api/schedules Azure Function endpoint.
 */

const BASE = "/api/schedules";

/**
 * Fetch all schedules.
 * @returns {Promise<Array>}
 */
export async function fetchSchedules() {
  const res = await fetch(BASE);
  if (!res.ok) throw new Error(`Failed to fetch schedules (${res.status})`);
  return res.json();
}

/**
 * Create a new schedule.
 * @param {Object} data  Schedule fields (must include userEmail, userName)
 * @returns {Promise<Object>}
 */
export async function createSchedule(data) {
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
 * Update an existing schedule.
 * @param {string} id    Schedule ID
 * @param {Object} data  Fields to update (must include userEmail for auth)
 * @returns {Promise<Object>}
 */
export async function updateSchedule(id, data) {
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
 * Delete a schedule.
 * @param {string} id         Schedule ID
 * @param {string} userEmail  Requesting user's email (for permission check)
 * @returns {Promise<Object>}
 */
export async function deleteSchedule(id, userEmail) {
  const res = await fetch(
    `${BASE}/${encodeURIComponent(id)}?userEmail=${encodeURIComponent(userEmail)}`,
    { method: "DELETE" }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Delete failed (${res.status})`);
  return json;
}
