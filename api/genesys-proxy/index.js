const customers = require("../lib/customers.json");
const { getGenesysToken } = require("../lib/genesysAuth");
const {
  classifyCaller,
  getBearerToken,
  parseRegistry,
} = require("../lib/orgConfigResolver");
const { checkCustomerRequest, checkFeatureRequest } = require("../lib/entitlementAllowlist");
const { checkLicense } = require("../lib/licenseGate");
const { checkProxyPermission } = require("../lib/proxyPermissions");
const { parseRowWrite, checkRowWrite, checkTableAccess, normalizeRules, EMPTY_RULES } = require("../lib/dataTableRules");
const { requiredFor } = require("../lib/proxyPermissions");
const divisionScope = require("../lib/divisionScope");
const { INTERNAL_ORG_SLUG } = require("../lib/licenseGate");
const orgSettings = require("../lib/orgSettingsStore");

// ── Data table rules, for Super Users ─────────────────────────────────────
// A Super User's row write into a data table is checked against the table's
// rules (docs/data-table-rules-design.md §7): may they add/delete, is a
// protected column unchanged, a mandatory one filled, a lookup value one
// that exists. The reads the check needs run with the same credentials the
// write would. Rules are cached per org+table for the licence window.
const RULES_TTL_MS = 5 * 60 * 1000;
const rulesCache = new Map();
async function rulesFor(orgId, tableId) {
  const key = `${orgId}|${tableId}`;
  const hit = rulesCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.rules;
  const row = await orgSettings.getDataTableRules(orgId, tableId);
  const rules = row ? normalizeRules(row.rules) : EMPTY_RULES;
  rulesCache.set(key, { rules, expiresAt: Date.now() + RULES_TTL_MS });
  return rules;
}

/**
 * Refuse a Super User's call on a data table that is not one of theirs
 * (docs/data-table-rules-design.md §11), and a row write that breaks the
 * table's rules.
 * @returns {Promise<object|null>} a response to send, or null to proceed.
 */
async function guardDataTableWrite(context, { orgId, features, dataTables, method, path, body, region, token }) {
  if (!Array.isArray(features)) return null;                  // not a Super User
  const access = await checkTableAccess({ method, path, dataTables, rulesOf: (id) => rulesFor(orgId, id) })
    .catch((err) => ({ ok: false, error: "datatable_rule", detail: `The table's rules could not be read, so the call was not made. Try again. (${err.message || err})` }));
  if (!access.ok) {
    context.log.warn(`[datatable-rules] refused ${method} ${path} for ${orgId}: ${access.detail}`);
    return { status: 403, headers: { "Content-Type": "application/json" }, body: { error: access.error, detail: access.detail } };
  }
  const write = parseRowWrite(method, path);
  if (!write) return null;
  let rules;
  try {
    rules = await rulesFor(orgId, write.tableId);
  } catch (err) {
    context.log.error(`[datatable-rules] rules read failed for ${orgId}/${write.tableId}: ${err.message || err}`);
    return { status: 403, headers: { "Content-Type": "application/json" }, body: { error: "datatable_rule", detail: "The table's rules could not be read, so the change was not made. Try again." } };
  }
  const read = (m, p, opts = {}) => callGenesys({ region, token, method: m, path: p, query: opts.query, body: opts.body });
  const verdict = await checkRowWrite({ ...write, body }, rules, read, write.tableId);
  if (verdict.ok) return null;
  context.log.warn(`[datatable-rules] refused ${method} ${path} for ${orgId}: ${verdict.detail}`);
  return { status: 403, headers: { "Content-Type": "application/json" }, body: { error: verdict.error, detail: verdict.detail, column: verdict.column || "" } };
}

const INTERNAL_COMPANY_ORG_ID = (process.env.INTERNAL_COMPANY_ORG_ID || "").trim();
const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Make the actual Genesys Cloud API call and shape the Function response.
 * Used by both the internal (client-credentials) and customer (token-forwarding)
 * paths — only the region + bearer token differ.
 */
async function callGenesys({ region, token, method, path, body, query, raw }) {
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

  // `raw` callers want the bytes, not an interpretation of them.
  //
  // Data action Velocity templates are fetched through here, and a template
  // whose placeholders sit inside quotes — {"Status": "${Status}"} — is itself
  // valid JSON. Parsing it turns the template into an object and destroys the
  // original text: the caller can only guess the formatting back, and
  // JSON.stringify would happily rewrite 1.0 as 1. Since the whole point of
  // fetching a template is to write it somewhere else unchanged, opt out of
  // parsing entirely rather than round-tripping through a parser.
  let parsed;
  if (raw) {
    parsed = { raw: respBody };
  } else {
    try {
      parsed = JSON.parse(respBody);
    } catch {
      parsed = { raw: respBody };
    }
  }

  // A 405 body says only that the method is wrong; the Allow header says which
  // one is right. Genesys does not document every method it accepts, so for
  // newer endpoints this header is the only way to find out — surface it in the
  // message the page shows instead of dropping it with the other headers.
  if (genesysResp.status === 405 && parsed && !Array.isArray(parsed)) {
    const allow = genesysResp.headers.get("allow");
    if (allow) {
      parsed.allowedMethods = allow;
      parsed.message = `${parsed.message || "HTTP 405 Method Not Allowed"} (allowed: ${allow})`;
    }
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
    const { customerId, method, path, body, query, raw } = req.body || {};

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
    // `customerId` from the body is used ONLY as a region hint to validate the
    // token against the right Genesys region; the org id is still verified
    // server-side, so a forged customerId cannot escalate.
    const userToken = getBearerToken(req);
    const registry = parseRegistry(context);
    const configured = !!INTERNAL_COMPANY_ORG_ID || registry.length > 0;

    let classification = { mode: "no-token" };
    if (userToken) {
      try {
        classification = await classifyCaller(context, userToken, customerId);
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

      // The named-user gate, before anything else on the customer path: an
      // unnamed user gets no Genesys call through here, whatever the org
      // bought (licenseGate.js).
      const licence = await checkLicense(context, userToken, classification);
      if (!licence.licensed) {
        context.res = {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: { error: "user_not_licensed", reason: licence.reason },
        };
        return;
      }

      // Never allow a customer session to target another org via the body.
      if (customerId && customerId !== cust.id) {
        context.res = {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: { error: "org_locked" },
        };
        return;
      }

      // A supervisor's effective pages stand in for the org's entitlements, so a
      // call outside their pages is refused as one outside the entitlements is.
      const guard = checkCustomerRequest(path, licence.features || classification.entitlements);
      if (!guard.allowed) {
        context.res = {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: { error: guard.reason },
        };
        return;
      }

      // A Super User's data table row writes meet the table's rules.
      const refused = await guardDataTableWrite(context, {
        orgId: cust.id, features: licence.features, dataTables: licence.dataTables, method, path, body, region: cust.region, token: userToken,
      });
      if (refused) { context.res = refused; return; }

      // Forward the user's OWN token to their OWN region (no elevation).
      const result = await callGenesys({
        region: cust.region,
        token: userToken,
        method,
        path,
        body,
        query,
        raw,
      });
      context.res = result;
      return;
    }

    // --- Configured but caller cannot use client-credentials ---
    if (configured && classification.mode === "verify_failed") {
      context.res = {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: { error: "identity_verification_failed" },
      };
      return;
    }

    if (configured && classification.mode === "org_mismatch") {
      context.res = {
        status: 403,
        headers: { "Content-Type": "application/json" },
        body: { error: "org_locked" },
      };
      return;
    }

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

    // The named-user gate, for internal sessions (licenseGate.js). Until this
    // check the proxy asked an internal caller nothing beyond "is your token
    // from our org" and elevated them to client credentials for any customer
    // org; the app's whole internal access model lived in the browser. An
    // unnamed colleague now gets no Genesys call through here. Superusers
    // pass; while INTERNAL_NAMED_USERS_ENFORCED is not "true" an unnamed
    // colleague passes and is logged.
    let internalFeatures = null;   // an internal Super User's pages; null otherwise
    let internalTables   = null;   // …and their data tables; null otherwise
    let divisionGrants = null;     // the person's grants by division, for the internal org (docs/division-scope-design.md)
    if (classification.mode === "internal") {
      const licence = await checkLicense(context, userToken, classification);
      if (!licence.licensed) {
        context.res = {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: { error: "user_not_licensed", reason: licence.reason },
        };
        return;
      }

      // And the person's OWN permissions, for this call (proxyPermissions.js).
      // The call below runs as the client, so Genesys checks the client's
      // permissions, not the person's — this is the only place theirs are
      // asked. Reports until PROXY_PERMISSION_CHECK is "enforce".
      const perm = await checkProxyPermission(context, {
        token: userToken, region: classification.org && classification.org.region,
        method, path, superuser: !!licence.superuser, userId: licence.userId,
      });
      if (!perm.allowed) {
        context.res = {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: { error: perm.error, required: perm.required || [] },
        };
        return;
      }

      internalFeatures = Array.isArray(licence.features) ? licence.features : null;
      internalTables   = Array.isArray(licence.dataTables) ? licence.dataTables : null;

      // In the internal org, the person's own divisions bound what they see
      // and change. Superusers bypass; an unreadable grant set refuses.
      if (!licence.superuser && customerId === INTERNAL_ORG_SLUG) {
        divisionGrants = await divisionScope.grantsFor(userToken, classification.org && classification.org.region);
        if (!divisionGrants) {
          context.res = { status: 403, headers: { "Content-Type": "application/json" }, body: { error: "divisions_unverified" } };
          return;
        }
      }

      // An internal Super User's pages, through the same coarse allowlist a
      // customer's are, under the same flag (docs/internal-roles-design.md
      // §5). The permission check above is the security layer; this is the
      // menu, held to server-side when the allowlist is on.
      if (Array.isArray(licence.features)) {
        const guard = checkFeatureRequest(path, licence.features);
        if (!guard.allowed) {
          context.res = {
            status: 403,
            headers: { "Content-Type": "application/json" },
            body: { error: guard.reason },
          };
          return;
        }
      }
    }

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

    // An internal Super User's data table row writes meet the table's rules.
    const refused = await guardDataTableWrite(context, {
      orgId: customerId, features: internalFeatures, dataTables: internalTables, method, path, body, region: customer.region, token,
    });
    if (refused) { context.res = refused; return; }

    // The person's divisions, in the internal org: a write outside them is
    // refused before it goes; a read is filtered after it returns.
    const divRequired = divisionGrants ? requiredFor(method, path) : null;
    const divRead = (p) => callGenesys({ region: customer.region, token, method: "GET", path: p });
    const divisionRefusal = (divisionId, required) => {
      const name = divisionGrants.divisionNames.get(divisionId) || divisionId || "that";
      const perms = [].concat(required || []).filter(Boolean);
      return {
        status: 403,
        headers: { "Content-Type": "application/json" },
        body: {
          error: "division_required", division: name, required: perms,
          detail: `Your role does not cover the ${name} division. This action needs the permission${perms.length ? ` (${perms.join(" or ")})` : ""} granted in that division, `
            + `and in Genesys a role is granted per division — having it in another division is not enough. Ask your administrator to add ${name} to the divisions of your role.`,
        },
      };
    };
    if (divisionGrants && divRequired) {
      const home = await divisionScope.homeDivisionFor(divRead, customerId);
      const verdict = await divisionScope.checkWrite({ method, path, body, grants: divisionGrants, required: [].concat(divRequired), read: divRead, homeDivisionId: home });
      if (!verdict.ok) {
        context.log.warn(`[division-scope] refused ${method} ${path} — division ${verdict.divisionId}`);
        context.res = divisionRefusal(verdict.divisionId, divRequired);
        return;
      }
    }

    const result = await callGenesys({
      region: customer.region,
      token,
      method,
      path,
      body,
      query,
      raw,
    });
    const isRead = String(method).toUpperCase() === "GET" || /\/(search|query)$/i.test(String(path).split("?")[0]);
    if (divisionGrants && !raw && isRead && result && result.status === 200) {
      const f = divisionScope.filterResponse({ path, body: result.body, grants: divisionGrants, required: divRequired ? [].concat(divRequired) : [] });
      if (f.refused) { context.res = divisionRefusal(f.divisionId, divRequired); return; }
      result.body = f.body;
    }
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
