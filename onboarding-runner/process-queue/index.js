/**
 * Timer trigger — every minute, claim the next queued onboarding job and process
 * it to completion. Timer triggers are singleton (no overlapping invocations),
 * and claimNextQueued uses an etag guard, so a job is never processed twice.
 *
 * Each tick also sweeps previews nobody approved: their approval window and
 * their cached export artifacts both expire after 30 minutes, so an abandoned
 * preview cannot sit in the queue or leave files on the share indefinitely.
 *
 * App settings required:
 *   AZURE_STORAGE_CONNECTION_STRING        (job store — same as the SWA api)
 *   GENESYS_<ORGID>_CLIENT_ID / _SECRET    (per org, same convention as the proxy)
 */
const store = require("../lib/onboardingStore");
const exportCache = require("../lib/exportCache");
const { processJob, expireJob } = require("../lib/processor");

module.exports = async function (context, timer) {
  // ── Abandon previews past their approval window ──
  try {
    for (const stale of await store.listExpired()) {
      try {
        await expireJob(stale, store, context.log);
      } catch (err) {
        context.log.error(`[onboarding-runner] expiring ${stale.jobId} failed: ${err.message}`);
      }
    }
  } catch (err) {
    context.log.error(`[onboarding-runner] expiry sweep failed: ${err.message}`);
  }

  // Artifacts outlive their job only if something went wrong; drop the strays.
  const purged = exportCache.purgeExpired();
  if (purged) context.log(`[onboarding-runner] purged ${purged} expired cache folder(s).`);

  // ── Claim and process the next queued job ──
  try {
    const job = await store.claimNextQueued();
    if (!job) {
      context.log("[onboarding-runner] no queued jobs.");
      return;
    }
    context.log(
      `[onboarding-runner] processing job ${job.jobId} → ${job.targetOrgId} ` +
      `(${job.flows.length} flow(s)${job.approved ? ", approved" : ""})`
    );
    await processJob(job, store, context.log);
  } catch (err) {
    context.log.error(`[onboarding-runner] tick failed: ${err.message}`);
  }
};
