/**
 * POST /api/flow-yaml   → { yaml, flowName, flowType }
 *
 * Flow Overview needs the *structured* Archy YAML of a flow (the flat REST
 * latestconfiguration omits implicit default connections). Exporting YAML needs
 * the Flow Scripting SDK, which runs in the onboarding-runner. This managed
 * function verifies the caller and forwards to the runner's export-yaml
 * endpoint (shared secret), returning the YAML text.
 *
 * Who may call it:
 *   internal / fallback — any org in customers.json (as before).
 *   customer            — their OWN org only. The export runs on the org's
 *                         client credentials held by the runner (the SDK has
 *                         no token-forwarding), so the same fences as
 *                         billing-overview apply before anything is read:
 *                         named-user licence, org lock, and the user's own
 *                         architect:flow:view — the permission the page is
 *                         gated on in featurePermissionMap.js — read on
 *                         their own region. A customer who could not open
 *                         the flow in Architect gets nothing here either.
 */
const customers = require("../lib/customers.json");
const { classifyCaller, getBearerToken } = require("../lib/orgConfigResolver");
const { checkLicense } = require("../lib/licenseGate");
const { fetchUserPermissions, hasAnyPermission } = require("../lib/userPermissions");
const { entitlementGrants } = require("../lib/entitlementAllowlist");

const CUSTOMER_REQUIRED_ANY = ["architect:flow:view"];
const MODULE_KEY = "flows.flowoverview";

function json(context, status, body) {
  context.res = { status, headers: { "Content-Type": "application/json" }, body };
}

/**
 * Decide who is calling and, for a customer, whether they may read the org
 * named in the body. Returns { ok: true } or { ok: false, status, error }.
 */
async function authorize(context, req, orgId) {
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: "missing_token" };
  let classification;
  try {
    classification = await classifyCaller(context, token, null);
  } catch (err) {
    context.log.error("[flow-yaml] classify failed:", err.message || err);
    return { ok: false, status: 401, error: "identity_verification_failed" };
  }
  if (classification.mode === "internal" || classification.mode === "fallback") return { ok: true };
  if (classification.mode !== "customer") return { ok: false, status: 403, error: "internal_only" };

  // Customer: licence first, then the org lock, then entitlement, then the
  // user's own permission — the same order as the proxy and billing-overview.
  const licence = await checkLicense(context, token, classification);
  if (!licence.licensed) return { ok: false, status: 403, error: "user_not_licensed", reason: licence.reason };
  if (orgId !== classification.customer.id) return { ok: false, status: 403, error: "org_locked" };
  const ents = Array.isArray(classification.entitlements) ? classification.entitlements : [];
  if (!ents.some((e) => entitlementGrants(e, MODULE_KEY))) return { ok: false, status: 403, error: "endpoint_not_entitled" };
  const perms = await fetchUserPermissions(token, classification.org.region);
  if (perms === null) return { ok: false, status: 403, error: "permission_unverified", required: CUSTOMER_REQUIRED_ANY };
  if (!hasAnyPermission(perms, CUSTOMER_REQUIRED_ANY)) return { ok: false, status: 403, error: "permission_required", required: CUSTOMER_REQUIRED_ANY };
  return { ok: true };
}

module.exports = async function (context, req) {
  const body = req.body || {};
  const orgId = String(body.orgId || "").trim();
  const flowName = String(body.flowName || "").trim();
  const flowType = String(body.flowType || "").trim().toLowerCase();

  const guard = await authorize(context, req, orgId);
  if (!guard.ok) {
    const { ok, status, ...rest } = guard;
    return json(context, status, rest);
  }

  if (!orgId || !flowName || !flowType) {
    return json(context, 400, { error: "orgId, flowName and flowType are required" });
  }
  if (!customers.find((c) => c.id === orgId)) {
    return json(context, 400, { error: `unknown org '${orgId}'` });
  }

  const base = (process.env.RUNNER_BASE_URL || "").replace(/\/+$/, "");
  const key = process.env.EXPORT_YAML_KEY;
  if (!base || !key) {
    return json(context, 503, { error: "flow export service not configured" });
  }

  try {
    const resp = await fetch(`${base}/api/export-yaml`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-export-key": key },
      body: JSON.stringify({ orgId, flowName, flowType }),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!resp.ok) return json(context, resp.status, { error: data.error || "export failed" });
    return json(context, 200, data);
  } catch (err) {
    context.log.error("[flow-yaml] runner call failed:", err.message || err);
    return json(context, 502, { error: "flow export runner unavailable" });
  }
};
