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

/**
 * Lock the schedule's TARGET org to the caller.
 *
 * `ownerOrgId` decides who can SEE a schedule. It says nothing about which org
 * the schedule RUNS AGAINST — that lives in `exportConfig.orgId`, which the
 * runner hands to the export handler, which authenticates to it with the app's
 * client credentials.
 *
 * Until now that field was stored verbatim. A customer session could therefore
 * create a schedule naming a different customer's org and have that org's data
 * exported and emailed to an address of its choosing — the schedule would be
 * invisible to them afterwards, since owner scoping hid it, but it would still
 * run. `templates` and `template-schedules` already lock the target org this
 * way; the export scheduler was missed because the org id is nested inside
 * config it otherwise never inspects.
 *
 * Internal sessions may target any configured org — that is what internal mode
 * is for.
 *
 * @returns {{ config: Object } | { error: string }}
 */
function lockTargetOrg(exportConfig, caller) {
  const cfg = exportConfig && typeof exportConfig === "object" ? exportConfig : {};
  if (caller.mode !== "customer") return { config: cfg };

  if (cfg.orgId && cfg.orgId !== caller.customerId) return { error: "org_locked" };
  // Absent or matching → pin it to the caller's own org explicitly, so a stored
  // schedule always records the org it is allowed to run against.
  return { config: { ...cfg, orgId: caller.customerId } };
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

      const lock = lockTargetOrg(b.exportConfig, caller);
      if (lock.error) {
        context.res = json(403, { error: lock.error });
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
        exportConfig: lock.config,
        createdBy: b.userEmail,
        createdByName: b.userName || "",
        // Recorded so a job that writes can re-check its creator at run
        // time. Optional: existing schedules predate it and simply
        // report as unverifiable rather than failing.
        createdById: b.userId || "",
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

      // An edit can retarget the schedule, so the same lock applies here. The
      // store treats an absent exportConfig as "leave unchanged", so only a
      // supplied one is checked — and an existing schedule cannot have been
      // stored with a foreign org once POST enforces this.
      let exportConfig = b.exportConfig;
      if (exportConfig !== undefined) {
        const lock = lockTargetOrg(exportConfig, caller);
        if (lock.error) {
          context.res = json(403, { error: lock.error });
          return;
        }
        exportConfig = lock.config;
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
        exportConfig,
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
