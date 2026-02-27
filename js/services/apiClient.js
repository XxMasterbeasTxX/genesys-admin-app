import { CONFIG } from "../config.js";

/**
 * Minimal API client for the Genesys Admin Tool.
 * Expand as new features are added.
 *
 * @param {Function} getToken  Returns a valid access token (string|null).
 * @returns {Object} api methods
 */
export function createApiClient(getToken) {
  async function request(path, { method = "GET", body, query } = {}) {
    const token = typeof getToken === "function" ? getToken() : getToken;
    if (!token) throw new Error("No valid access token");

    let url = `${CONFIG.apiBase}${path}`;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += `?${qs}`;
    }

    const headers = { Authorization: `Bearer ${token}` };
    const opts = { method, headers };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    const resp = await fetch(url, opts);
    if (resp.status === 204) return null;

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(`API ${method} ${path} → ${resp.status}`);
      err.status = resp.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return {
    /** Raw request helper — use for one-off calls. */
    request,

    /** GET /api/v2/users/me */
    getUsersMe: () => request("/api/v2/users/me"),
  };
}
