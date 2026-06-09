/**
 * GET /api/ipranges?region=<aws-region-code>
 *
 * Proxies Genesys Cloud's IP-ranges endpoint:
 *   GET https://api.<regional-host>/api/v2/ipranges
 *
 * Authentication uses the same client-credentials flow as /api/genesys-proxy:
 * the function picks any configured customer whose org lives in the requested
 * region and uses that customer's Client ID/Secret to obtain a Genesys token.
 *
 * If no customer is configured for the requested region, returns 400.
 *
 * Response: forwards Genesys' JSON body verbatim, with an extra
 *   meta: { region, host, fetchedAt }
 * field added for client-side display.
 */

const customers = require("../lib/customers.json");
const { getGenesysToken } = require("../lib/genesysAuth");

// AWS region code → Genesys Cloud regional API host.
// Sourced from https://developer.genesys.cloud/platform/api/ (AWS regions table).
// If a region returns 404, verify the host string against the current docs.
const REGION_HOSTS = {
  "us-east-1":      "mypurecloud.com",
  "us-east-2":      "use2.us-gov-pure.cloud",
  "us-west-2":      "usw2.pure.cloud",
  "ca-central-1":   "cac1.pure.cloud",
  "sa-east-1":      "sae1.pure.cloud",
  "eu-west-1":      "mypurecloud.ie",
  "eu-west-2":      "euw2.pure.cloud",
  "eu-central-1":   "mypurecloud.de",
  "eu-central-2":   "euc2.pure.cloud",
  "me-central-1":   "mec1.pure.cloud",
  "ap-south-1":     "aps1.pure.cloud",
  "ap-southeast-2": "mypurecloud.com.au",
  "ap-northeast-1": "mypurecloud.jp",
  "ap-northeast-2": "apne2.pure.cloud",
  "ap-northeast-3": "apne3.pure.cloud",
};

module.exports = async function (context, req) {
  try {
    const region = (req.query.region || "").trim();

    if (!region) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Missing required query parameter: region" },
      };
      return;
    }

    const host = REGION_HOSTS[region];
    if (!host) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: {
          error: `Unknown region: ${region}`,
          supported: Object.keys(REGION_HOSTS),
        },
      };
      return;
    }

    const authHeader =
      req.headers.authorization || req.headers.Authorization || "";
    if (!/^Bearer\s+\S+/i.test(authHeader)) {
      context.res = {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: { error: "Missing or invalid Authorization bearer token" },
      };
      return;
    }

    // --- Find any customer configured for this region ---
    const customer = customers.find((c) => c.region === host);
    if (!customer) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: {
          error:
            `No customer configured for region ${region} (${host}). ` +
            `Add a customer in this region or pick a region that has one.`,
        },
      };
      return;
    }

    // --- Get credentials from app settings (resolved via Key Vault references) ---
    const envKey = `GENESYS_${customer.id.replace(/-/g, "_").toUpperCase()}`;
    const clientId = process.env[`${envKey}_CLIENT_ID`];
    const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];

    if (!clientId || !clientSecret) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: `Credentials not configured for ${customer.id}` },
      };
      return;
    }

    // --- Get Genesys access token (cached per org) ---
    const token = await getGenesysToken(
      customer.id,
      customer.region,
      clientId,
      clientSecret
    );

    const url = `https://api.${host}/api/v2/ipranges`;
    const genesysResp = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const text = await genesysResp.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    if (!genesysResp.ok) {
      const genesysMsg =
        (parsed && (parsed.message || parsed.error || parsed.code)) ||
        (typeof parsed?.raw === "string" ? parsed.raw.slice(0, 200) : "");
      context.log.warn(
        `ipranges: Genesys ${genesysResp.status} for region=${region} host=${host} customer=${customer.id} — ${genesysMsg}`
      );
      context.res = {
        status: genesysResp.status,
        headers: { "Content-Type": "application/json" },
        body: {
          error: `Genesys ipranges call failed (${genesysResp.status})${genesysMsg ? ": " + genesysMsg : ""}`,
          region,
          host,
          detail: parsed,
        },
      };
      return;
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        ...parsed,
        meta: {
          region,
          host,
          fetchedAt: new Date().toISOString(),
        },
      },
    };
  } catch (err) {
    context.log.error("ipranges error:", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: err.message || "Internal error" },
    };
  }
};
