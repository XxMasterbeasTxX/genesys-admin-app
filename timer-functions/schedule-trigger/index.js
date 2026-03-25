/**
 * Timer Trigger — calls the SWA scheduled-runner endpoint every 5 minutes.
 *
 * Replaces the GitHub Actions cron workflow with precise Azure-native scheduling.
 * Reads SWA_URL and SCHEDULE_RUNNER_KEY from app settings.
 */
module.exports = async function (context, timer) {
  if (timer.isPastDue) {
    context.log("Timer is past due — running immediately.");
  }

  const swaUrl = process.env.SWA_URL;
  const runnerKey = process.env.SCHEDULE_RUNNER_KEY;

  if (!swaUrl || !runnerKey) {
    context.log.error("Missing SWA_URL or SCHEDULE_RUNNER_KEY app setting.");
    return;
  }

  const url = `${swaUrl}/api/scheduled-runner`;
  context.log(`Calling ${url} at ${new Date().toISOString()}`);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-runner-key": runnerKey,
      },
    });

    const body = await resp.json().catch(() => ({}));
    context.log(`Response ${resp.status}: ${JSON.stringify(body)}`);

    if (resp.status >= 500) {
      throw new Error(`Runner returned ${resp.status}: ${JSON.stringify(body)}`);
    }
  } catch (err) {
    context.log.error(`Failed to call scheduled-runner: ${err.message}`);
    throw err;
  }
};
