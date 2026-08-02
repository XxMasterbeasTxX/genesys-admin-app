/**
 * Timer trigger — every minute, claim the next queued onboarding job and process
 * it to completion. Timer triggers are singleton (no overlapping invocations),
 * and claimNextQueued uses an etag guard, so a job is never processed twice.
 *
 * App settings required:
 *   AZURE_STORAGE_CONNECTION_STRING        (job store — same as the SWA api)
 *   GENESYS_<ORGID>_CLIENT_ID / _SECRET    (per org, same convention as the proxy)
 */
const store = require("../lib/onboardingStore");
const { processJob } = require("../lib/processor");

module.exports = async function (context, timer) {
  try {
    const job = await store.claimNextQueued();
    if (!job) {
      context.log("[onboarding-runner] no queued jobs.");
      return;
    }
    context.log(`[onboarding-runner] processing job ${job.jobId} → ${job.targetOrgId} (${job.flows.length} flow(s))`);
    await processJob(job, store, context.log);
  } catch (err) {
    context.log.error(`[onboarding-runner] tick failed: ${err.message}`);
  }
};
