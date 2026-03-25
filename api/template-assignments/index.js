/**
 * Template Assignment API
 *
 * GET    /api/template-assignments?orgId=…                → list all assignments for org
 * GET    /api/template-assignments?orgId=…&userId=…       → list assignments for a user
 * POST   /api/template-assignments                        → create assignment
 * DELETE /api/template-assignments/{id}?orgId=…           → delete single assignment
 * DELETE /api/template-assignments?orgId=…&userId=…&templateId=… → delete by user+template
 */
const store = require("../lib/templateAssignmentStore");

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
      const orgId = req.query.orgId;
      if (!orgId) {
        context.res = json(400, { error: "orgId query parameter is required" });
        return;
      }

      const userId = req.query.userId;
      if (userId) {
        const assignments = await store.listByUser(orgId, userId);
        context.res = json(200, assignments);
      } else {
        const assignments = await store.listByOrg(orgId);
        context.res = json(200, assignments);
      }
      return;
    }

    // ── POST ────────────────────────────────────────────
    if (method === "POST") {
      const b = req.body || {};
      const type = b.type || "user";

      if (!b.orgId || !b.templateId) {
        context.res = json(400, {
          error: "Missing required fields: orgId, templateId",
        });
        return;
      }

      if (type === "user" && !b.userId) {
        context.res = json(400, { error: "Missing required field: userId" });
        return;
      }
      if (type === "group" && !b.groupId) {
        context.res = json(400, { error: "Missing required field: groupId" });
        return;
      }
      if (type === "workteam" && !b.workteamId) {
        context.res = json(400, { error: "Missing required field: workteamId" });
        return;
      }

      const assignment = await store.create({
        orgId: b.orgId,
        type,
        userId: b.userId || "",
        userName: b.userName || "",
        groupId: b.groupId || "",
        groupName: b.groupName || "",
        workteamId: b.workteamId || "",
        workteamName: b.workteamName || "",
        templateId: b.templateId,
        templateName: b.templateName || "",
        assignedBy: b.assignedBy || "",
      });

      context.res = json(201, assignment);
      return;
    }

    // ── DELETE ───────────────────────────────────────────
    if (method === "DELETE") {
      const orgId = req.query.orgId;
      if (!orgId) {
        context.res = json(400, { error: "orgId query parameter is required" });
        return;
      }

      // Delete by ID
      if (id) {
        const success = await store.remove(orgId, id);
        context.res = success
          ? json(200, { ok: true })
          : json(404, { error: "Assignment not found" });
        return;
      }

      // Delete by userId + templateId
      const userId = req.query.userId;
      const templateId = req.query.templateId;
      if (userId && templateId) {
        const removed = await store.removeByUserAndTemplate(orgId, userId, templateId);
        context.res = json(200, { ok: true, removed });
        return;
      }

      // Delete by groupId + templateId
      const groupId = req.query.groupId;
      if (groupId && templateId) {
        const removed = await store.removeByEntityAndTemplate(orgId, groupId, "groupId", templateId);
        context.res = json(200, { ok: true, removed });
        return;
      }

      // Delete by workteamId + templateId
      const workteamId = req.query.workteamId;
      if (workteamId && templateId) {
        const removed = await store.removeByEntityAndTemplate(orgId, workteamId, "workteamId", templateId);
        context.res = json(200, { ok: true, removed });
        return;
      }

      context.res = json(400, {
        error: "Provide assignment ID in URL, or userId/groupId/workteamId and templateId query params",
      });
      return;
    }

    context.res = json(405, { error: "Method not allowed" });
  } catch (err) {
    context.log.error("template-assignments error:", err);
    context.res = json(500, { error: err.message });
  }
};
