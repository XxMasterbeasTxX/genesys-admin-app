/**
 * POST /api/flow-yaml   → { yaml, flowName, flowType }
 *
 * Flow Overview needs the *structured* Archy YAML of a flow (the flat REST
 * latestconfiguration omits implicit default connections). Exporting YAML needs
 * the Flow Scripting SDK, which runs in the onboarding-runner. This managed
 * function verifies the caller is internal and forwards to the runner's
 * export-yaml endpoint (shared secret), returning the YAML text.
 *
 * INTERNAL ONLY — reading flows via client-credentials must be gated the same way
 * as the onboarding deploy endpoint.
 */
const customers = require("../lib/customers.json");
const { classifyCaller, getBearerToken } = require("../lib/orgConfigResolver");

function json(context, status, body) {
  context.res = { status, headers: { "Content-Type": "application/json" }, body };
}

async function requireInternal(context, req) {
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
  return { ok: false, status: 403, error: "internal_only" };
}

module.exports = async function (context, req) {
  const guard = await requireInternal(context, req);
  if (!guard.ok) return json(context, guard.status, { error: guard.error });

  const body = req.body || {};
  const orgId = String(body.orgId || "").trim();
  const flowName = String(body.flowName || "").trim();
  const flowType = String(body.flowType || "").trim().toLowerCase();
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
