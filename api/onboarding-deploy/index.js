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
const { createJob, getJob, updateJob } = require("../lib/onboardingStore");
const activityLog = require("../lib/activityLogStore");
const { classifyCaller, getBearerToken } = require("../lib/orgConfigResolver");

const ROOT_FLOW_TYPES = new Set([
  // Inbound
  "inboundcall", "inboundchat", "inboundemail", "inboundshortmessage",
  // Supporting
  "bot", "digitalbot", "commonmodule", "inqueuecall", "inqueueemail",
  "inqueueshortmessage", "securecall", "voicemail", "workflow", "workitem",
  // Post interaction
  "voicesurvey", "surveyinvite",
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

  // Operator identity, carried through to the runner so it can write the
  // activity-log entry when the job finishes. Client-supplied — the same trust
  // model as every other logAction() writer. Not required: a missing identity
  // costs attribution on the log entry, it must never block a deploy.
  const startedBy = String(body.startedBy || "").trim();
  const startedByName = String(body.startedByName || "").trim();
  const startedById = String(body.startedById || "").trim();

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
    plan: {
      sourceOrgId, targetOrgId, divisionId, divisionName, namePrefix,
      startedBy, startedByName, startedById,
      // "Preview and Deploy" always pauses for approval. Plain "Deploy" pauses
      // only when the preview finds a name conflict or a predicted failure.
      stopForPreview: body.stopForPreview === true,
      flows: cleanFlows,
    },
  };
}

/**
 * Approve a parked job: record the operator's conflict decisions and put it back
 * on the queue for the runner to deploy. The runner deploys the artifacts it
 * cached during the preview, so what lands is what was approved.
 */
async function approve(context, req, jobId) {
  const job = await getJob(jobId);
  if (!job) return json(context, 404, { error: "job_not_found" });
  if (job.status !== "awaiting-approval") {
    return json(context, 409, { error: "not_awaiting_approval", status: job.status });
  }
  if (job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) {
    // The cached exports are gone by now, so this can't be resumed.
    return json(context, 409, { error: "approval_expired", expiresAt: job.expiresAt });
  }

  const body = req.body || {};
  const decisions = (body.decisions && typeof body.decisions === "object") ? body.decisions : {};

  const updated = await updateJob(jobId, { decisions, approved: true, status: "queued" });
  context.log(`[onboarding-deploy] job ${jobId} approved (${Object.keys(decisions).length} decision(s))`);
  return json(context, 200, { jobId, status: updated.status });
}

/**
 * Cancel a parked job. Nothing was written, so this only records that the deploy
 * was considered and abandoned — under the preview action, never the deploy one.
 */
async function cancel(context, req, jobId) {
  const job = await getJob(jobId);
  if (!job) return json(context, 404, { error: "job_not_found" });
  if (job.status !== "awaiting-approval") {
    return json(context, 409, { error: "not_awaiting_approval", status: job.status });
  }

  await updateJob(jobId, { status: "cancelled", finishedAt: new Date().toISOString() });

  const b = req.body || {};
  const planned = (job.phases || [])
    .flatMap((p) => p.items || [])
    .filter((i) => i.status === "planned").length;
  try {
    await activityLog.create({
      userEmail: b.userEmail || job.startedBy || "",
      userName:  b.userName  || job.startedByName || "",
      userId:    b.userId    || job.startedById || "",
      orgId: job.targetOrgId,
      orgName: (customers.find((c) => c.id === job.targetOrgId) || {}).name || job.targetOrgId,
      action: "deployment_onboarding_preview",
      description:
        `[Onboarding] Previewed ${job.flows?.length || 0} callflow(s) into ` +
        `${(customers.find((c) => c.id === job.targetOrgId) || {}).name || job.targetOrgId} ` +
        `· division '${job.divisionName || "Home"}' — NOT deployed (cancelled; ` +
        `${planned} object(s) would have been created)`,
      result: "success",
      count: planned,
      details: {
        summary: {
          jobId: job.jobId, status: "cancelled",
          sourceOrgId: job.sourceOrgId, targetOrgId: job.targetOrgId,
          division: job.divisionName || "Home",
          rootFlows: (job.flows || []).map((f) => f.name),
          plannedObjects: planned,
        },
        phases: job.phases || [],
        warnings: job.warnings || [],
      },
    });
  } catch (err) {
    context.log.warn(`[onboarding-deploy] cancel log write failed (non-critical): ${err.message}`);
  }

  context.log(`[onboarding-deploy] job ${jobId} cancelled before deploying`);
  return json(context, 200, { jobId, status: "cancelled" });
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

    // POST — approve / cancel a parked job, or create a new one
    const body = req.body || {};

    if (body.action === "approve" || body.action === "cancel") {
      const jobId = String(body.jobId || "").trim();
      if (!jobId) return json(context, 400, { error: "jobId is required" });
      return body.action === "approve"
        ? await approve(context, req, jobId)
        : await cancel(context, req, jobId);
    }

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
