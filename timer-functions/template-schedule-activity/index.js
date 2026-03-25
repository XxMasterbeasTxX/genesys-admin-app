/**
 * Template Schedule Activity — Durable Functions activity.
 *
 * Called by the orchestrator at the exact scheduled time.
 * POSTs to the SWA's /api/template-runner endpoint with the
 * scheduleId, authenticated via the shared SCHEDULE_RUNNER_KEY.
 */
module.exports = async function (context) {
  const { scheduleId } = context.bindings.input;

  if (!scheduleId) {
    throw new Error("scheduleId is required");
  }

  const swaUrl = process.env.SWA_URL;
  const runnerKey = process.env.SCHEDULE_RUNNER_KEY;

  if (!swaUrl || !runnerKey) {
    throw new Error("Missing SWA_URL or SCHEDULE_RUNNER_KEY app setting");
  }

  const url = `${swaUrl}/api/template-runner`;
  context.log(`Calling template-runner for schedule ${scheduleId} at ${new Date().toISOString()}`);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-runner-key": runnerKey,
    },
    body: JSON.stringify({ scheduleId }),
  });

  const body = await resp.json().catch(() => ({}));
  context.log(`template-runner response ${resp.status}: ${JSON.stringify(body)}`);

  if (resp.status >= 500) {
    // Throw so Durable Functions retries (configured in orchestrator)
    throw new Error(`template-runner returned ${resp.status}: ${JSON.stringify(body)}`);
  }

  return {
    scheduleId,
    status: resp.status,
    body,
  };
};
