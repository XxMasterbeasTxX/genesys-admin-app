/**
 * Template Schedule CRUD API
 *
 * GET    /api/template-schedules            → list all (optionally filter by ?orgId=)
 * GET    /api/template-schedules/{id}       → get single schedule
 * POST   /api/template-schedules            → create schedule
 * PUT    /api/template-schedules/{id}       → update schedule (owner or admin only)
 * DELETE /api/template-schedules/{id}       → delete schedule (owner or admin only)
 *
 * For PUT/DELETE, the request must include `userEmail` so the backend
 * can verify ownership.  POST must include `userEmail` and `userName`
 * so the schedule records who created it.
 *
 * On create/update/delete, the function notifies the Timer Function App
 * (Durable Functions) to start, restart, or stop the orchestrator
 * that manages the precise timer for this schedule.
 */
const store = require("../lib/templateScheduleStore");

// ── Timer App notification ──────────────────────────────

async function notifyTimerApp(action, scheduleOrId) {
  const timerUrl = process.env.TIMER_FUNCTION_URL;
  const runnerKey = process.env.SCHEDULE_RUNNER_KEY;
  if (!timerUrl || !runnerKey) return; // Skip silently if not configured

  const url = `${timerUrl}/api/template-schedule-starter`;
  const body =
    action === "start"
      ? { action: "start", schedule: scheduleOrId }
      : { action: "stop", scheduleId: scheduleOrId };

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-runner-key": runnerKey,
      },
      body: JSON.stringify(body),
    });
  } catch (_) {
    // Non-fatal — schedule was still saved; orchestrator can be synced later
  }
}

module.exports = async function (context, req) {
  const method = req.method.toUpperCase();
  const id = context.bindingData.id || null;

  const json = (status, body) => ({
    status,
    headers: { "Content-Type": "application/json" },
    body,
  });

  try {
    // ── GET ─────────────────────────────────────────────
    if (method === "GET") {
      if (id) {
        const schedule = await store.getById(id);
        if (!schedule) {
          context.res = json(404, { error: "Template schedule not found" });
          return;
        }
        context.res = json(200, schedule);
      } else {
        const orgId = req.query.orgId;
        const schedules = orgId
          ? await store.listByOrg(orgId)
          : await store.listAll();
        context.res = json(200, schedules);
      }
      return;
    }

    // ── POST ────────────────────────────────────────────
    if (method === "POST") {
      const b = req.body || {};

      if (!b.templateId || !b.orgId || !b.mode || !b.scheduleType || !b.scheduleTime || !b.userEmail) {
        context.res = json(400, {
          error:
            "Missing required fields: templateId, orgId, mode, scheduleType, scheduleTime, userEmail",
        });
        return;
      }

      if (!["reset", "add"].includes(b.mode)) {
        context.res = json(400, { error: "mode must be 'reset' or 'add'" });
        return;
      }

      if (!["once", "daily", "weekly", "monthly"].includes(b.scheduleType)) {
        context.res = json(400, { error: "scheduleType must be 'once', 'daily', 'weekly', or 'monthly'" });
        return;
      }

      if (b.scheduleType === "once" && !b.scheduleDate) {
        context.res = json(400, { error: "scheduleDate is required for one-time schedules" });
        return;
      }

      const schedule = await store.create({
        templateId: b.templateId,
        templateName: b.templateName || "",
        orgId: b.orgId,
        mode: b.mode,
        scheduleType: b.scheduleType,
        scheduleTime: b.scheduleTime,
        scheduleDayOfWeek: b.scheduleDayOfWeek ?? null,
        scheduleDayOfMonth: b.scheduleDayOfMonth ?? null,
        scheduleDate: b.scheduleDate || null,
        enabled: b.enabled !== false,
        createdBy: b.userEmail,
        createdByName: b.userName || "",
      });

      // Start a durable orchestrator for this schedule
      if (schedule.enabled) {
        await notifyTimerApp("start", schedule);
      }

      context.res = json(201, schedule);
      return;
    }

    // ── PUT ─────────────────────────────────────────────
    if (method === "PUT") {
      if (!id) {
        context.res = json(400, { error: "Schedule ID required in URL" });
        return;
      }

      const existing = await store.getById(id);
      if (!existing) {
        context.res = json(404, { error: "Template schedule not found" });
        return;
      }

      const b = req.body || {};
      if (!store.canEdit(existing, b.userEmail)) {
        context.res = json(403, {
          error: "Only the creator or admin can edit this schedule",
        });
        return;
      }

      if (b.mode && !["reset", "add"].includes(b.mode)) {
        context.res = json(400, { error: "mode must be 'reset' or 'add'" });
        return;
      }

      if (b.scheduleType && !["once", "daily", "weekly", "monthly"].includes(b.scheduleType)) {
        context.res = json(400, { error: "scheduleType must be 'once', 'daily', 'weekly', or 'monthly'" });
        return;
      }

      const updated = await store.update(id, {
        templateId: b.templateId,
        templateName: b.templateName,
        orgId: b.orgId,
        mode: b.mode,
        scheduleType: b.scheduleType,
        scheduleTime: b.scheduleTime,
        scheduleDayOfWeek: b.scheduleDayOfWeek,
        scheduleDayOfMonth: b.scheduleDayOfMonth,
        scheduleDate: b.scheduleDate,
        enabled: b.enabled,
      });

      // Restart or stop the orchestrator depending on enabled state
      if (updated.enabled) {
        await notifyTimerApp("start", updated);
      } else {
        await notifyTimerApp("stop", id);
      }

      context.res = json(200, updated);
      return;
    }

    // ── DELETE ───────────────────────────────────────────
    if (method === "DELETE") {
      if (!id) {
        context.res = json(400, { error: "Schedule ID required in URL" });
        return;
      }

      const existing = await store.getById(id);
      if (!existing) {
        context.res = json(404, { error: "Template schedule not found" });
        return;
      }

      const userEmail = req.query.userEmail || (req.body && req.body.userEmail);
      if (!store.canEdit(existing, userEmail)) {
        context.res = json(403, {
          error: "Only the creator or admin can delete this schedule",
        });
        return;
      }

      await store.remove(id);

      // Stop the orchestrator
      await notifyTimerApp("stop", id);

      context.res = json(200, { ok: true });
      return;
    }

    context.res = json(405, { error: "Method not allowed" });
  } catch (err) {
    context.log.error("template-schedules error:", err);
    context.res = json(500, { error: err.message || "Internal server error" });
  }
};
