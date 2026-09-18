import { CONFIG } from "../config.js";
import { parseDivisionRefusal, explainDivisionRefusal } from "../lib/genesysErrors.js";

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

    // Azure Static Web Apps strips/overwrites Authorization before it reaches
    // managed functions, so also forward the user's token in X-Genesys-Token for
    // endpoints that verify the caller's org server-side (Authorization is kept
    // as a fallback for local dev / direct Functions hosts).
    const headers = { Authorization: `Bearer ${token}`, "X-Genesys-Token": token };
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
  async function proxyGenesys(customerId, method, path, { body, query, raw } = {}) {
    const token = typeof getToken === "function" ? getToken() : getToken;
    if (!token) throw new Error("No valid access token");

    const resp = await fetch("/api/genesys-proxy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Azure Static Web Apps strips/overwrites Authorization before it reaches
        // managed functions, so the user's token is forwarded in X-Genesys-Token.
        // The proxy uses it to verify the caller's org server-side (Authorization
        // is kept as a fallback for local dev / direct Functions hosts).
        "X-Genesys-Token": token,
        Authorization: `Bearer ${token}`,
      },
      // `raw: true` tells the proxy not to JSON.parse the response. Used for
      // Velocity template fetches, where a template that happens to be valid
      // JSON would otherwise arrive as an object with its original text gone.
      body: JSON.stringify({ customerId, method, path, body, query, raw }),
    });

    if (resp.status === 204) return null;
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // Extract the cleanest error message from the Genesys response. A
      // refusal by the app's own rules (a Super User's data table write)
      // carries its sentence in `detail`; Genesys's own errors in `message`.
      const detail = json.message || json.detail || json.error || json.messageWithParams || "";
      const err = new Error(detail || `Proxy ${method} ${path} → ${resp.status}`);
      err.status = resp.status;
      err.body = json;
      // The division refusal, said in plain words with the division named —
      // once, here, for every page (js/lib/genesysErrors.js). The original
      // sentence stays on the error for anyone who needs to quote it.
      const parsed = parseDivisionRefusal(detail);
      if (parsed) {
        err.genesysMessage = detail;
        err.message = explainDivisionRefusal(detail, { divisionNames: await divisionNames(customerId, parsed.divisionIds) });
      }
      throw err;
    }
    return json;
  }

  // Division names for the refusal above: one read per id, remembered for
  // the session. Best effort — an id that cannot be read stays an id.
  const divisionNameCache = new Map();
  async function divisionNames(customerId, ids) {
    const out = {};
    for (const id of ids) {
      const key = `${customerId}|${id}`;
      if (!divisionNameCache.has(key)) {
        let name = "";
        try {
          const d = await proxyGenesys(customerId, "GET", `/api/v2/authorization/divisions/${encodeURIComponent(id)}`);
          name = (d && d.name) || "";
        } catch { /* leave it an id */ }
        divisionNameCache.set(key, name);
      }
      if (divisionNameCache.get(key)) out[id] = divisionNameCache.get(key);
    }
    return out;
  }

  return {
    /** Raw request helper — use for one-off calls. */
    request,

    /**
     * Call the app's OWN backend (Azure Functions) at the SAME origin.
     * Unlike `request`, this does NOT prepend CONFIG.apiBase (the Genesys host);
     * it forwards the user's token in X-Genesys-Token so managed functions can
     * verify the caller server-side (SWA strips Authorization).
     */
    async appRequest(path, { method = "GET", body, query } = {}) {
      const token = typeof getToken === "function" ? getToken() : getToken;
      let url = path; // same-origin, relative
      if (query) {
        const qs = new URLSearchParams(query).toString();
        if (qs) url += `?${qs}`;
      }
      const headers = {};
      if (token) {
        headers["X-Genesys-Token"] = token;
        headers["Authorization"] = `Bearer ${token}`;
      }
      const opts = { method, headers };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      const resp = await fetch(url, opts);
      if (resp.status === 204) return null;
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const detail = json.message || json.error || "";
        const err = new Error(detail || `App ${method} ${path} → ${resp.status}`);
        err.status = resp.status;
        err.body = json;
        throw err;
      }
      return json;
    },

    /** Proxy a Genesys API call through the backend for a customer org. */
    proxyGenesys,

    /** GET /api/v2/users/me */
    getUsersMe: () => request("/api/v2/users/me"),
  };
}
