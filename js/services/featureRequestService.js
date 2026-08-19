/**
 * Feature Request Service — frontend API calls for the requests board.
 *
 * All methods talk to the /api/feature-requests Azure Function endpoint.
 *
 * Nothing here decides what the caller may see or do. The backend resolves the
 * caller from their token, scopes every read to their own organisation, and
 * builds the shared board's cards itself — so this module sends what the user
 * typed and renders what comes back. In particular: `isSuperuser` on a list
 * response is the server's answer, not something to re-derive here.
 *
 * See docs/feature-requests-design.md §5 for the endpoint contract.
 */
import { withUserToken } from "./apiAuth.js";

const BASE = "/api/feature-requests";

async function request(path, { method = "GET", body } = {}) {
  const opts = { method, headers: withUserToken() };
  if (body !== undefined) {
    opts.headers = withUserToken({ "Content-Type": "application/json" });
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, opts);
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    // The endpoint's `message` is written for a person; `error` is the code.
    // Prefer the sentence, fall back to the code, and keep both on the error so
    // a caller can branch on `rate_limited` or `already_triaged` if it wants.
    const err = new Error(json.message || json.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = json.error || "";
    throw err;
  }
  return json;
}

/**
 * List requests on one board.
 *
 * @param {"mine"|"shared"|"all"} board
 *   `mine`   — your own organisation's requests, in full
 *   `shared` — promoted requests, as redacted cards, visible to every org
 *   `all`    — every organisation's requests (superuser only; 403 otherwise)
 * @returns {Promise<{ requests: Array, isSuperuser: boolean }>}
 */
export async function fetchRequests(board = "mine") {
  return request(`?board=${encodeURIComponent(board)}`);
}

/** One request by id, in whichever shape the caller is entitled to. */
export async function fetchRequest(id) {
  return request(`/${encodeURIComponent(id)}`);
}

/**
 * Submit a new request.
 *
 * Identity and ownership are NOT sent — the backend takes them from the token.
 * `route`, `pageLabel`, `orgId`, `orgName` and `appVersion` are the captured
 * context (§4), which is what makes a request about an existing page
 * actionable without a round trip.
 */
export async function createRequest({
  title,
  description,
  type = "feature",
  route = "",
  pageLabel = "",
  orgId = "",
  orgName = "",
  appVersion = "",
  publishAnonymously = false,
} = {}) {
  return request("", {
    method: "POST",
    body: { title, description, type, route, pageLabel, orgId, orgName, appVersion, publishAnonymously },
  });
}

/**
 * Edit your own request, while its status is still `new`.
 * Throws with `code === "already_triaged"` (409) once it has been picked up.
 */
export async function updateOwnRequest(id, { title, description, type, publishAnonymously } = {}) {
  const body = {};
  if (title !== undefined) body.title = title;
  if (description !== undefined) body.description = description;
  if (type !== undefined) body.type = type;
  if (publishAnonymously !== undefined) body.publishAnonymously = publishAnonymously;
  return request(`/${encodeURIComponent(id)}`, { method: "PUT", body });
}

/**
 * Triage a request (superuser only).
 *
 * Promoting to the shared board means passing `visibility: "shared"` together
 * with `sharedTitle` — the backend refuses to publish a request that has no
 * curated wording, so the submitter's own text never crosses to another tenant
 * by accident.
 */
export async function triageRequest(id, patch = {}) {
  return request(`/${encodeURIComponent(id)}`, { method: "PUT", body: patch });
}

/** Toggle your vote. Returns the updated card. */
export async function toggleVote(id) {
  return request(`/${encodeURIComponent(id)}/vote`, { method: "POST" });
}

/** Delete a request (superuser only). */
export async function deleteRequest(id) {
  return request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}
