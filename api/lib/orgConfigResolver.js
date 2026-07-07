const customers = require("./customers.json");

const DEFAULT_REGION = process.env.GENESYS_HOME_REGION || "mypurecloud.de";
const INTERNAL_COMPANY_ORG_ID = (process.env.INTERNAL_COMPANY_ORG_ID || "").trim().toLowerCase();

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
        const entitlements = Array.isArray(entry.entitlements)
          ? entry.entitlements.filter((e) => typeof e === "string" && e.trim())
          : [];

        return {
          id,
          name,
          orgId,
          region,
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

async function fetchOrganizationMe(accessToken, region) {
  const resp = await fetch(`https://api.${region}/api/v2/organizations/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = json.message || json.error || JSON.stringify(json) || "unknown";
    throw new Error(`organizations/me failed (${resp.status}): ${detail}`);
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

async function resolveOrgConfig(context, req) {
  const accessToken = getBearerToken(req);
  if (!accessToken) {
    return { status: 401, body: { error: "Missing bearer token" } };
  }

  const orgHint = getOrgHint(req);
  const registry = parseRegistry(context);

  const userOrg = await fetchOrganizationMe(accessToken, DEFAULT_REGION);
  const normalizedUserOrg = normalizeOrgId(userOrg.id);

  const safeCustomers = customers.map(({ id, name, region }) => ({ id, name, region }));

  // Compatibility mode while Step 3 is being rolled out.
  // If no org config is provided yet, keep the current internal behaviour.
  if (!INTERNAL_COMPANY_ORG_ID && registry.length === 0) {
    return {
      status: 200,
      body: {
        mode: "internal",
        org: userOrg,
        customers: safeCustomers,
        orgHint,
        warning: "org-config-fallback",
      },
    };
  }

  if (INTERNAL_COMPANY_ORG_ID && normalizedUserOrg === INTERNAL_COMPANY_ORG_ID) {
    return {
      status: 200,
      body: {
        mode: "internal",
        org: userOrg,
        customers: safeCustomers,
        orgHint,
      },
    };
  }

  const matchedCustomer = registry.find((entry) => entry.orgId === normalizedUserOrg);
  if (!matchedCustomer) {
    return {
      status: 403,
      body: {
        error: "organization_not_recognized",
      },
    };
  }

  if (orgHint && orgHint !== matchedCustomer.id) {
    return {
      status: 403,
      body: {
        error: "org_hint_mismatch",
      },
    };
  }

  return {
    status: 200,
    body: {
      mode: "customer",
      org: userOrg,
      customer: {
        id: matchedCustomer.id,
        name: matchedCustomer.name,
        region: matchedCustomer.region,
      },
      entitlements: matchedCustomer.entitlements,
    },
  };
}

module.exports = { resolveOrgConfig };
