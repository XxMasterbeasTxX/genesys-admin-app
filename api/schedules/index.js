/**
 * Schedule CRUD API
 *
 * GET    /api/schedules       → list all schedules
 * GET    /api/schedules/{id}  → get single schedule
 * POST   /api/schedules       → create schedule
 * PUT    /api/schedules/{id}  → update schedule (owner or admin only)
 * DELETE /api/schedules/{id}  → delete schedule (owner or admin only)
 *
 * For PUT/DELETE, the request must include `userEmail` so the backend
 * can verify ownership.  POST must include `userEmail` and `userName`
 * so the schedule records who created it.
 */
const store = require("../lib/scheduleStore");
const { getCallerContext, ownerVisibleTo } = require("../lib/callerContext");

module.exports = async function (context, req) {
  const method = req.method.toUpperCase();
  const id = context.bindingData.id || null;

  const json = (status, body) => ({
    status,
    headers: { "Content-Type": "application/json" },
    body,
  });

  try {
    // Owner-scoped store: each org only sees schedules its own session created. (Step 6)
    const caller = await getCallerContext(context, req);
    if (!caller.authorized) {
      context.res = json(caller.status || 401, { error: caller.error || "unauthorized" });
      return;
    }

    // ── GET ─────────────────────────────────────────────
    if (method === "GET") {
      if (id) {
        const schedule = await store.getById(id);
        if (!schedule || !ownerVisibleTo(schedule.ownerOrgId, caller.ownerOrgId)) {
          context.res = json(404, { error: "Schedule not found" });
          return;
        }
        context.res = json(200, schedule);
      } else {
        const schedules = (await store.listAll())
          .filter((s) => ownerVisibleTo(s.ownerOrgId, caller.ownerOrgId));
        context.res = json(200, schedules);
      }
      return;
    }

    // ── POST ────────────────────────────────────────────
    if (method === "POST") {
      const b = req.body || {};

      if (!b.exportType || !b.scheduleType || !b.scheduleTime || !b.userEmail) {
        context.res = json(400, {
          error:
            "Missing required fields: exportType, scheduleType, scheduleTime, userEmail",
        });
        return;
      }

      const schedule = await store.create({
        ownerOrgId: caller.ownerOrgId,
        exportType: b.exportType,
        exportLabel: b.exportLabel || b.exportType,
        scheduleType: b.scheduleType,
        scheduleTime: b.scheduleTime,
        scheduleDayOfWeek: b.scheduleDayOfWeek ?? null,
        scheduleDayOfMonth: b.scheduleDayOfMonth ?? null,
        enabled: b.enabled !== false,
        emailRecipients: b.emailRecipients || "",
        emailMessage: b.emailMessage || "",
        exportConfig: b.exportConfig || {},
        createdBy: b.userEmail,
        createdByName: b.userName || "",
      });

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
      if (!existing || !ownerVisibleTo(existing.ownerOrgId, caller.ownerOrgId)) {
        context.res = json(404, { error: "Schedule not found" });
        return;
      }

      const b = req.body || {};
      if (!store.canEdit(existing, b.userEmail)) {
        context.res = json(403, {
          error: "Only the creator or admin can edit this schedule",
        });
        return;
      }

      const updated = await store.update(id, {
        exportType: b.exportType,
        exportLabel: b.exportLabel,
        scheduleType: b.scheduleType,
        scheduleTime: b.scheduleTime,
        scheduleDayOfWeek: b.scheduleDayOfWeek,
        scheduleDayOfMonth: b.scheduleDayOfMonth,
        enabled: b.enabled,
        emailRecipients: b.emailRecipients,
        emailMessage: b.emailMessage,
        exportConfig: b.exportConfig,
      });

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
      if (!existing || !ownerVisibleTo(existing.ownerOrgId, caller.ownerOrgId)) {
        context.res = json(404, { error: "Schedule not found" });
        return;
      }

      // Accept userEmail from query string or request body
      const userEmail =
        req.query.userEmail || (req.body && req.body.userEmail);
      if (!store.canEdit(existing, userEmail)) {
        context.res = json(403, {
          error: "Only the creator or admin can delete this schedule",
        });
        return;
      }

      await store.remove(id);
      context.res = json(200, { success: true });
      return;
    }

    context.res = json(405, { error: "Method not allowed" });
  } catch (err) {
    context.log.error("Schedule API error:", err);
    context.res = json(500, { error: err.message || "Internal server error" });
  }
};
