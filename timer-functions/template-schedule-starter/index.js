/**
 * Template Schedule Starter — HTTP trigger + Durable Client.
 *
 * Manages orchestrator instances for template schedules.
 * Each schedule gets exactly one orchestrator whose instanceId = scheduleId.
 *
 * POST /api/template-schedule-starter
 *
 * Actions:
 *   { action: "start", schedule }   → Start (or restart) an orchestrator
 *   { action: "stop",  scheduleId } → Terminate a running orchestrator
 *   { action: "status", scheduleId } → Check orchestrator status
 *
 * Protected by the same SCHEDULE_RUNNER_KEY shared secret.
 */
const df = require("durable-functions");

module.exports = async function (context, req) {
  // ── Verify shared secret ──────────────────────────────
  const expectedKey = process.env.SCHEDULE_RUNNER_KEY;
  if (!expectedKey) {
    context.res = json(500, { error: "SCHEDULE_RUNNER_KEY not configured" });
    return;
  }

  const providedKey =
    req.headers["x-runner-key"] ||
    (req.query && req.query.key) ||
    (req.body && req.body.key);

  if (providedKey !== expectedKey) {
    context.res = json(403, { error: "Invalid runner key" });
    return;
  }

  const client = df.getClient(context);
  const body = req.body || {};
  const { action } = body;

  if (!action) {
    context.res = json(400, { error: "action is required (start, stop, status)" });
    return;
  }

  try {
    if (action === "start") {
      const { schedule } = body;
      if (!schedule || !schedule.id) {
        context.res = json(400, { error: "schedule with id is required for start" });
        return;
      }

      const instanceId = `tplsched-${schedule.id}`;

      // Terminate any existing orchestrator for this schedule
      try {
        const existing = await client.getStatus(instanceId);
        if (existing && isRunning(existing)) {
          context.log(`Terminating existing orchestrator ${instanceId}`);
          await client.terminate(instanceId, "Restarting schedule");
          // Brief pause so termination propagates
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (_) {
        // No existing instance — fine
      }

      // Start a new orchestrator
      await client.startNew(
        "template-schedule-orchestrator",
        instanceId,
        {
          id: schedule.id,
          scheduleType: schedule.scheduleType,
          scheduleTime: schedule.scheduleTime,
          scheduleDayOfWeek: schedule.scheduleDayOfWeek ?? null,
          scheduleDayOfMonth: schedule.scheduleDayOfMonth ?? null,
          scheduleDate: schedule.scheduleDate || null,
        }
      );

      context.log(`Started orchestrator ${instanceId} for schedule ${schedule.id}`);
      context.res = json(200, { ok: true, instanceId, action: "started" });
      return;
    }

    if (action === "stop") {
      const { scheduleId } = body;
      if (!scheduleId) {
        context.res = json(400, { error: "scheduleId is required for stop" });
        return;
      }

      const instanceId = `tplsched-${scheduleId}`;
      try {
        const status = await client.getStatus(instanceId);
        if (status && isRunning(status)) {
          await client.terminate(instanceId, "Schedule disabled or deleted");
          context.log(`Terminated orchestrator ${instanceId}`);
          context.res = json(200, { ok: true, instanceId, action: "stopped" });
        } else {
          context.res = json(200, { ok: true, instanceId, action: "already-stopped" });
        }
      } catch (_) {
        context.res = json(200, { ok: true, instanceId, action: "not-found" });
      }
      return;
    }

    if (action === "status") {
      const { scheduleId } = body;
      if (!scheduleId) {
        context.res = json(400, { error: "scheduleId is required for status" });
        return;
      }

      const instanceId = `tplsched-${scheduleId}`;
      try {
        const status = await client.getStatus(instanceId);
        context.res = json(200, {
          instanceId,
          runtimeStatus: status?.runtimeStatus || "Unknown",
          lastUpdated: status?.lastUpdatedTime || null,
          input: status?.input || null,
        });
      } catch (_) {
        context.res = json(200, { instanceId, runtimeStatus: "NotFound" });
      }
      return;
    }

    context.res = json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    context.log.error("Starter error:", err);
    context.res = json(500, { error: err.message || "Internal error" });
  }
};

function isRunning(status) {
  const s = status.runtimeStatus;
  return s === "Running" || s === "Pending" || s === "Suspended";
}

function json(status, body) {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body,
  };
}
