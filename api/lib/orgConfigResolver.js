const customers = require("./customers.json");
const crypto = require("crypto");

const DEFAULT_REGION = process.env.GENESYS_HOME_REGION || "mypurecloud.de";
const INTERNAL_COMPANY_ORG_ID = (process.env.INTERNAL_COMPANY_ORG_ID || "").trim().toLowerCase();

// Cache caller classification per token to avoid an organizations/me call on
// every proxy request. Keyed by a hash of the token (never the token itself).
const CLASSIFY_TTL_MS = 5 * 60 * 1000;
const classificationCache = new Map();

function tokenKey(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getCachedClassification(token) {
  const key = tokenKey(token);
  const entry = classificationCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.value;
  if (entry) classificationCache.delete(key);
  return null;
}

function setCachedClassification(token, value) {
  classificationCache.set(tokenKey(token), {
    value,
    expiresAt: Date.now() + CLASSIFY_TTL_MS,
  });
}

function normalizeOrgId(value) {
  return String(value || "").trim().toLowerCase();
}

function parseRegistry(context) {
  const raw = process.env.CUSTOMER_REGISTRY_JSON;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : Object.values(parsed || {});

    return list
      .filter(Boolean)
      .map((entry) => {
        const id = String(entry.id || "").trim();
        const orgId = normalizeOrgId(entry.orgId || entry.organizationId);
        const region = String(entry.region || "").trim();
        const name = String(entry.name || id || "").trim();
        const clientId = String(entry.clientId || "").trim();
        const entitlements = Array.isArray(entry.entitlements)
          ? entry.entitlements.filter((e) => typeof e === "string" && e.trim())
          : [];

        return {
          id,
          name,
          orgId,
          region,
          clientId,
          entitlements,
          enabled: entry.enabled !== false,
        };
      })
      .filter((entry) => entry.id && entry.orgId && entry.region && entry.enabled);
  } catch (err) {
    context.log.error("[org-config] Failed to parse CUSTOMER_REGISTRY_JSON:", err.message || err);
    return [];
  }
}

function isConfigured(registry) {
  return !!INTERNAL_COMPANY_ORG_ID || (registry && registry.length > 0);
}

async function fetchOrganizationMe(accessToken, region) {
  const resp = await fetch(`https://api.${region}/api/v2/organizations/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = json.message || json.error || JSON.stringify(json) || "unknown";
    const err = new Error(`organizations/me failed (${resp.status}): ${detail}`);
    err.status = resp.status;
    throw err;
  }

  return {
    id: String(json.id || ""),
    name: String(json.name || ""),
    region,
  };
}

function getBearerToken(req) {
  const headers = req.headers || {};

  // Azure Static Web Apps strips/overwrites the Authorization header before it
  // reaches managed functions, so the frontend forwards the user's Genesys token
  // in a custom X-Genesys-Token header. Prefer it; fall back to Authorization for
  // local dev / direct Functions hosts.
  const custom = headers["x-genesys-token"] || headers["X-Genesys-Token"];
  if (custom && typeof custom === "string" && custom.trim()) {
    return custom.trim();
  }

  const auth = headers.authorization || headers.Authorization;
  if (!auth || typeof auth !== "string") return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function getOrgHint(req) {
  const hint = (req.query && req.query.org) || "";
  if (typeof hint !== "string") return null;
  const clean = hint.trim();
  if (!clean) return null;
  return clean;
}

/**
 * Classify a caller purely from their token, server-side.
 *
 * Returns one of:
 *   { mode: "no-token" }                                       — no token supplied
 *   { mode: "fallback",     org }                              — no env configured yet (legacy behavior)
 *   { mode: "internal",     org }                              — token belongs to the internal/company org
 *   { mode: "customer",     org, customer, entitlements }      — token belongs to a registered customer org
 *   { mode: "unrecognized", org }                              — token org is neither internal nor a known customer
 *
 * Throws if the token cannot be validated against organizations/me.
 * Results are cached per token for CLASSIFY_TTL_MS.
 */
async function classifyCaller(context, token) {
  if (!token) return { mode: "no-token" };

  const cached = getCachedClassification(token);
  if (cached) return cached;

  const registry = parseRegistry(context);
  const configured = isConfigured(registry);

  const userOrg = await fetchOrganizationMe(token, DEFAULT_REGION);
  const normalized = normalizeOrgId(userOrg.id);

  let result;
  if (!configured) {
    result = { mode: "fallback", org: userOrg };
  } else if (INTERNAL_COMPANY_ORG_ID && normalized === INTERNAL_COMPANY_ORG_ID) {
    result = { mode: "internal", org: userOrg };
  } else {
    const matched = registry.find((entry) => entry.orgId === normalized);
    if (matched) {
      result = {
        mode: "customer",
        org: userOrg,
        customer: { id: matched.id, name: matched.name, region: matched.region },
        entitlements: matched.entitlements,
      };
    } else {
      result = { mode: "unrecognized", org: userOrg };
    }
  }

  setCachedClassification(token, result);
  return result;
}

async function resolveOrgConfig(context, req) {
  const accessToken = getBearerToken(req);
  if (!accessToken) {
    return { status: 401, body: { error: "missing_token" } };
  }

  const orgHint = getOrgHint(req);
  const safeCustomers = customers.map(({ id, name, region }) => ({ id, name, region }));

  const classification = await classifyCaller(context, accessToken);

  if (classification.mode === "fallback") {
    return {
      status: 200,
      body: {
        mode: "internal",
        org: classification.org,
        customers: safeCustomers,
        orgHint,
        warning: "org-config-fallback",
      },
    };
  }

  if (classification.mode === "internal") {
    return {
      status: 200,
      body: {
        mode: "internal",
        org: classification.org,
        customers: safeCustomers,
        orgHint,
      },
    };
  }

  if (classification.mode === "customer") {
    if (orgHint && orgHint !== classification.customer.id) {
      return { status: 403, body: { error: "org_hint_mismatch" } };
    }
    return {
      status: 200,
      body: {
        mode: "customer",
        org: classification.org,
        customer: classification.customer,
        entitlements: classification.entitlements,
      },
    };
  }

  return { status: 403, body: { error: "organization_not_recognized" } };
}

module.exports = {
  resolveOrgConfig,
  classifyCaller,
  getBearerToken,
  parseRegistry,
};
