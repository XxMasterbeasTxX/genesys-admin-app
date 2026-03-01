const customers = require("../lib/customers.json");
const { getGenesysToken } = require("../lib/genesysAuth");

/**
 * POST /api/genesys-proxy
 *
 * Proxies Genesys Cloud API calls on behalf of a customer org.
 * The frontend sends:
 *   { customerId, method, path, body?, query? }
 *
 * The function:
 *   1. Looks up the customer metadata
 *   2. Reads Client ID + Secret from app settings (process.env)
 *   3. Gets (or reuses cached) Genesys OAuth token via Client Credentials
 *   4. Makes the API call to Genesys Cloud
 *   5. Returns the result
 */
module.exports = async function (context, req) {
  try {
    const { customerId, method, path, body, query } = req.body || {};

    // --- Validate input ---
    if (!customerId || !method || !path) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Missing required fields: customerId, method, path" },
      };
      return;
    }

    const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    if (!allowedMethods.includes(method.toUpperCase())) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: `Invalid method: ${method}` },
      };
      return;
    }

    // --- Find customer ---
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

    // --- Build and make the Genesys API call ---
    let url = `https://api.${customer.region}${path}`;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += `?${qs}`;
    }

    const fetchOpts = {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${token}`,
      },
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
      if (body && !["GET", "DELETE"].includes(method.toUpperCase())) {
        fetchOpts.body = JSON.stringify(body);
      }
    }

    const genesysResp = await fetch(url, fetchOpts);

    // --- Return the response ---
    if (genesysResp.status === 204) {
      context.res = { status: 204 };
      return;
    }

    const respBody = await genesysResp.text();
    let parsed;
    try {
      parsed = JSON.parse(respBody);
    } catch {
      parsed = { raw: respBody };
    }

    context.res = {
      status: genesysResp.status,
      headers: { "Content-Type": "application/json" },
      body: parsed,
    };
  } catch (err) {
    context.log.error("Proxy error:", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: err.message || "Internal proxy error" },
    };
  }
};
