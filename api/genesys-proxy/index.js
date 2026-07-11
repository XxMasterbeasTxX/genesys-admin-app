const customers = require("../lib/customers.json");
const { getGenesysToken } = require("../lib/genesysAuth");
const {
  classifyCaller,
  getBearerToken,
  parseRegistry,
} = require("../lib/orgConfigResolver");
const { checkCustomerRequest } = require("../lib/entitlementAllowlist");

const INTERNAL_COMPANY_ORG_ID = (process.env.INTERNAL_COMPANY_ORG_ID || "").trim();
const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Make the actual Genesys Cloud API call and shape the Function response.
 * Used by both the internal (client-credentials) and customer (token-forwarding)
 * paths — only the region + bearer token differ.
 */
async function callGenesys({ region, token, method, path, body, query }) {
  let url = `https://api.${region}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }

  const fetchOpts = {
    method: method.toUpperCase(),
    headers: { Authorization: `Bearer ${token}` },
  };

  // Support binary file uploads via __fileUpload in body
  if (body && body.__fileUpload) {
    const { fileName, fileBase64, fileMimeType } = body.__fileUpload;
    const fileBuffer = Buffer.from(fileBase64, "base64");
    const blob = new Blob([fileBuffer], { type: fileMimeType });
    const formData = new FormData();
    formData.append("file", blob, fileName);
    fetchOpts.body = formData;
    // Let fetch set Content-Type with correct multipart boundary
  } else {
    fetchOpts.headers["Content-Type"] = "application/json";
    if (body && !["GET"].includes(method.toUpperCase())) {
      fetchOpts.body = JSON.stringify(body);
    }
  }

  const genesysResp = await fetch(url, fetchOpts);

  if (genesysResp.status === 204) {
    return { status: 204 };
  }

  const respBody = await genesysResp.text();
  let parsed;
  try {
    parsed = JSON.parse(respBody);
  } catch {
    parsed = { raw: respBody };
  }

  return {
    status: genesysResp.status,
    headers: { "Content-Type": "application/json" },
    body: parsed,
  };
}

/**
 * POST /api/genesys-proxy
 *
 * Proxies Genesys Cloud API calls. The mode is decided SERVER-SIDE from the
 * caller's own token (never trusted from the request body):
 *   - Internal org  → client-credentials (existing behavior; body.customerId
 *                     selects any configured customer org).
 *   - Customer org  → token-forwarding, LOCKED to the caller's own org and
 *                     region (body.customerId is ignored / rejected), with the
 *                     customer request guard applied.
 *   - Fallback      → if no org env is configured yet, the legacy
 *                     client-credentials behavior is preserved.
 *
 * The frontend sends:
 *   { customerId, method, path, body?, query? }
 * plus the user's token in the X-Genesys-Token header.
 */
module.exports = async function (context, req) {
  try {
    const { customerId, method, path, body, query } = req.body || {};

    // --- Validate input (customerId is only required for internal mode) ---
    if (!method || !path) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Missing required fields: method, path" },
      };
      return;
    }

    if (!ALLOWED_METHODS.includes(method.toUpperCase())) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: `Invalid method: ${method}` },
      };
      return;
    }

    // --- Classify the caller from their own token (server-side, cached) ---
    const userToken = getBearerToken(req);
    const registry = parseRegistry(context);
    const configured = !!INTERNAL_COMPANY_ORG_ID || registry.length > 0;

    let classification = { mode: "no-token" };
    if (userToken) {
      try {
        classification = await classifyCaller(context, userToken);
      } catch (err) {
        context.log.error("[proxy] caller classification failed:", err.message || err);
        // Cannot verify identity. If the system is configured, fail closed so a
        // request can never fall through to the elevated client-credentials path.
        if (configured) {
          context.res = {
            status: 401,
            headers: { "Content-Type": "application/json" },
            body: { error: "identity_verification_failed" },
          };
          return;
        }
        // Not configured yet → preserve legacy behavior below.
      }
    }

    // --- CUSTOMER MODE: token-forwarding, org-locked, guarded ---
    if (classification.mode === "customer") {
      const cust = classification.customer;

      // Never allow a customer session to target another org via the body.
      if (customerId && customerId !== cust.id) {
        context.res = {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: { error: "org_locked" },
        };
        return;
      }

      const guard = checkCustomerRequest(path, classification.entitlements);
      if (!guard.allowed) {
        context.res = {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: { error: guard.reason },
        };
        return;
      }

      // Forward the user's OWN token to their OWN region (no elevation).
      const result = await callGenesys({
        region: cust.region,
        token: userToken,
        method,
        path,
        body,
        query,
      });
      context.res = result;
      return;
    }

    // --- Configured but caller cannot use client-credentials ---
    if (configured && classification.mode === "unrecognized") {
      context.res = {
        status: 403,
        headers: { "Content-Type": "application/json" },
        body: { error: "organization_not_recognized" },
      };
      return;
    }

    if (configured && classification.mode === "no-token") {
      context.res = {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: { error: "missing_token" },
      };
      return;
    }

    // --- INTERNAL / FALLBACK MODE: client-credentials (existing behavior) ---
    if (!customerId) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Missing required field: customerId" },
      };
      return;
    }

    const customer = customers.find((c) => c.id === customerId);
    if (!customer) {
      context.res = {
        status: 404,
        headers: { "Content-Type": "application/json" },
        body: { error: `Unknown customer: ${customerId}` },
      };
      return;
    }

    // --- Get credentials from app settings (resolved via Key Vault references) ---
    const envKey = `GENESYS_${customerId.replace(/-/g, "_").toUpperCase()}`;
    const clientId = process.env[`${envKey}_CLIENT_ID`];
    const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];

    if (!clientId || !clientSecret) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: `Credentials not configured for ${customerId}` },
      };
      return;
    }

    // --- Get Genesys access token (cached per org) ---
    const token = await getGenesysToken(
      customerId,
      customer.region,
      clientId,
      clientSecret
    );

    const result = await callGenesys({
      region: customer.region,
      token,
      method,
      path,
      body,
      query,
    });
    context.res = result;
  } catch (err) {
    context.log.error("Proxy error:", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: err.message || "Internal proxy error" },
    };
  }
};
