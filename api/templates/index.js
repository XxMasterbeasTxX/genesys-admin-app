/**
 * Template CRUD API
 *
 * GET    /api/templates?orgId=…       → list templates for org
 * GET    /api/templates/{id}?orgId=…  → get single template
 * POST   /api/templates               → create template
 * PUT    /api/templates/{id}           → update template (owner or admin only)
 * DELETE /api/templates/{id}           → delete template (owner or admin only)
 *
 * All requests require `orgId` (query param for GET/DELETE, body for POST/PUT).
 * PUT/DELETE require `userEmail` so the backend can verify ownership.
 * POST must include `userEmail` and `userName` to record the creator.
 */
const store = require("../lib/templateStore");

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

      if (id) {
        const template = await store.getById(orgId, id);
        if (!template) {
          context.res = json(404, { error: "Template not found" });
          return;
        }
        context.res = json(200, template);
      } else {
        const templates = await store.listByOrg(orgId);
        context.res = json(200, templates);
      }
      return;
    }

    // ── POST ────────────────────────────────────────────
    if (method === "POST") {
      const b = req.body || {};

      if (!b.orgId || !b.name || !b.userEmail) {
        context.res = json(400, {
          error: "Missing required fields: orgId, name, userEmail",
        });
        return;
      }

      const template = await store.create({
        orgId: b.orgId,
        name: b.name,
        skills: b.skills || [],
        queues: b.queues || [],
        roles: b.roles || [],
        languages: b.languages || [],
        createdBy: b.userEmail,
        createdByName: b.userName || "",
      });

      context.res = json(201, template);
      return;
    }

    // ── PUT ─────────────────────────────────────────────
    if (method === "PUT") {
      if (!id) {
        context.res = json(400, { error: "Template ID required in URL" });
        return;
      }

      const b = req.body || {};
      if (!b.orgId) {
        context.res = json(400, { error: "orgId is required" });
        return;
      }

      const existing = await store.getById(b.orgId, id);
      if (!existing) {
        context.res = json(404, { error: "Template not found" });
        return;
      }

      if (!store.canEdit(existing, b.userEmail)) {
        context.res = json(403, {
          error: "Only the creator or admin can edit this template",
        });
        return;
      }

      const updated = await store.update(b.orgId, id, {
        name: b.name,
        skills: b.skills,
        queues: b.queues,
        roles: b.roles,
        languages: b.languages,
      });

      context.res = json(200, updated);
      return;
    }

    // ── DELETE ───────────────────────────────────────────
    if (method === "DELETE") {
      if (!id) {
        context.res = json(400, { error: "Template ID required in URL" });
        return;
      }

      const orgId = req.query.orgId;
      const userEmail = req.query.userEmail || (req.body && req.body.userEmail);

      if (!orgId) {
        context.res = json(400, { error: "orgId query parameter is required" });
        return;
      }

      const existing = await store.getById(orgId, id);
      if (!existing) {
        context.res = json(404, { error: "Template not found" });
        return;
      }

      if (!store.canEdit(existing, userEmail)) {
        context.res = json(403, {
          error: "Only the creator or admin can delete this template",
        });
        return;
      }

      await store.remove(orgId, id);
      context.res = json(200, { success: true });
      return;
    }

    context.res = json(405, { error: "Method not allowed" });
  } catch (err) {
    context.log.error("Template API error:", err);
    context.res = json(500, { error: err.message || "Internal server error" });
  }
};
