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
      const detail = json.message || json.error || json.messageWithParams || "";
      const err = new Error(detail || `API ${method} ${path} → ${resp.status}`);
      err.status = resp.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  /**
   * Proxy a Genesys API call through the Azure Functions backend.
   * The backend handles authentication with the customer's org.
   *
   * @param {string} customerId   Customer identifier (e.g. "acme")
   * @param {string} method       HTTP method (GET, POST, PUT, DELETE, PATCH)
   * @param {string} path         Genesys API path (e.g. "/api/v2/users")
   * @param {Object} [body]       Optional request body
   * @param {Object} [query]      Optional query parameters
   */
  async function proxyGenesys(customerId, method, path, { body, query } = {}) {
    const token = typeof getToken === "function" ? getToken() : getToken;
    if (!token) throw new Error("No valid access token");

    const resp = await fetch("/api/genesys-proxy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ customerId, method, path, body, query }),
    });

    if (resp.status === 204) return null;
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // Extract the cleanest error message from the Genesys response
      const detail = json.message || json.error || json.messageWithParams || "";
      const err = new Error(detail || `Proxy ${method} ${path} → ${resp.status}`);
      err.status = resp.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return {
    /** Raw request helper — use for one-off calls. */
    request,

    /** Proxy a Genesys API call through the backend for a customer org. */
    proxyGenesys,

    /** GET /api/v2/users/me */
    getUsersMe: () => request("/api/v2/users/me"),
  };
}
