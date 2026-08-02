/**
 * POST /api/onboarding-deploy   → create an onboarding deploy job (returns { jobId })
 * GET  /api/onboarding-deploy?jobId=…  → job status for polling
 *
 * INTERNAL ONLY. Onboarding deploys write into customer orgs using
 * client-credentials, so the caller must be verified server-side as an internal
 * user (same guard as the proxy's internal path). Customer sessions are rejected.
 *
 * This endpoint only records the job and reports status — it does NOT run the
 * (minutes-long, SDK-heavy) deploy. A dedicated runner app processes queued jobs
 * (see docs/onboarding-deployment-design.md §4). Keeping the heavy work out of the
 * SWA managed API mirrors how the repo isolates timer-functions.
 */
const customers = require("../lib/customers.json");
const { createJob, getJob } = require("../lib/onboardingStore");
const { classifyCaller, getBearerToken } = require("../lib/orgConfigResolver");

const ROOT_FLOW_TYPES = new Set([
  "inboundcall", "inboundchat", "inboundemail", "inboundshortmessage", "workflow",
]);

function json(context, status, body) {
  context.res = { status, headers: { "Content-Type": "application/json" }, body };
}

/** True if the caller is a verified internal user (or legacy fallback). */
async function requireInternal(context, req) {
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: "missing_token" };
  let classification;
  try {
    classification = await classifyCaller(context, token, null);
  } catch (err) {
    context.log.error("[onboarding-deploy] classify failed:", err.message || err);
    return { ok: false, status: 401, error: "identity_verification_failed" };
  }
  if (classification.mode === "internal" || classification.mode === "fallback") {
    return { ok: true };
  }
  return { ok: false, status: 403, error: "internal_only" };
}

function validatePlan(body) {
  const errors = [];
  const sourceOrgId = String(body.sourceOrgId || "").trim();
  const targetOrgId = String(body.targetOrgId || "").trim();
  const divisionId = String(body.divisionId || "").trim();
  const divisionName = String(body.divisionName || "").trim();
  const namePrefix = String(body.namePrefix || "").trim();
  const flows = Array.isArray(body.flows) ? body.flows : [];

  if (!sourceOrgId) errors.push("sourceOrgId is required");
  else if (!customers.find((c) => c.id === sourceOrgId)) errors.push(`unknown source org '${sourceOrgId}'`);

  if (!targetOrgId) errors.push("targetOrgId is required");
  else if (!customers.find((c) => c.id === targetOrgId)) errors.push(`unknown target org '${targetOrgId}'`);

  if (sourceOrgId && targetOrgId && sourceOrgId === targetOrgId)
    errors.push("source and target org must differ");

  if (!divisionId) errors.push("divisionId is required");

  if (!flows.length) errors.push("at least one callflow is required");

  const cleanFlows = flows
    .map((f) => ({
      id: String(f.id || "").trim(),
      name: String(f.name || "").trim(),
      type: String(f.type || "").trim().toLowerCase(),
    }))
    .filter((f) => f.id && f.name && f.type);

  if (flows.length && !cleanFlows.length) errors.push("callflows are missing id/name/type");
  for (const f of cleanFlows) {
    if (!ROOT_FLOW_TYPES.has(f.type)) errors.push(`flow '${f.name}' has unsupported type '${f.type}'`);
  }

  return {
    errors,
    plan: { sourceOrgId, targetOrgId, divisionId, divisionName, namePrefix, flows: cleanFlows },
  };
}

module.exports = async function (context, req) {
  try {
    const auth = await requireInternal(context, req);
    if (!auth.ok) return json(context, auth.status, { error: auth.error });

    if (req.method === "GET") {
      const jobId = (req.query && req.query.jobId) || "";
      if (!jobId) return json(context, 400, { error: "jobId is required" });
      const job = await getJob(jobId);
      if (!job) return json(context, 404, { error: "job_not_found" });
      return json(context, 200, job);
    }

    // POST — create job
    const body = req.body || {};
    const { errors, plan } = validatePlan(body);
    if (errors.length) return json(context, 400, { error: "invalid_plan", details: errors });

    const job = await createJob(plan);
    context.log(`[onboarding-deploy] created job ${job.jobId} → ${plan.targetOrgId} (${plan.flows.length} flows)`);
    return json(context, 202, { jobId: job.jobId, status: job.status });
  } catch (err) {
    context.log.error("[onboarding-deploy] error:", err);
    return json(context, 500, { error: err.message || "internal_error" });
  }
};
