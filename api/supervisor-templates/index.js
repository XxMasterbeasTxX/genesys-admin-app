/**
 * Supervisor templates — named sets of pages and data tables a Supervisor
 * can be put on (docs/supervisor-templates-design.md).
 *
 *   GET    /api/supervisor-templates?customerId=   → { customerId, templates: [...] }
 *   PUT    /api/supervisor-templates               { customerId, id?, name, features, dataTables }
 *                                                  → { customerId, template, dropped, droppedTables }
 *   DELETE /api/supervisor-templates               { customerId, id }
 *                                                  → { customerId, deleted } | 409 template_in_use { users }
 *
 * Who may is who may set the scope (lib/scopeRights.js). A template's pages
 * are validated against the org's kind and its Supervisor scope, its tables
 * against the tables open to Supervisors; the rest are dropped and counted
 * in the response. A template that Supervisors are on cannot be deleted —
 * the reply says how many. Every change is written to the activity log
 * under the caller's verified identity.
 */
const { getCallerContext } = require("../lib/callerContext");
const { resolveScopeOrg } = require("../lib/scopeRights");
const { filterPages } = require("../lib/pages");
const { normalizeRules } = require("../lib/dataTableRules");
const store = require("../lib/orgSettingsStore");
const licences = require("../lib/licenseStore");
const activityLog = require("../lib/activityLogStore");
const customers = require("../lib/customers.json");

const NAME_MAX = 60;

function json(context, status, body) {
  context.res = { status, headers: { "Content-Type": "application/json" }, body };
}

function customerName(id) {
  const c = customers.find((x) => x.id === id);
  return c ? c.name : id;
}

async function logQuietly(context, entry) {
  try { await activityLog.create(entry); }
  catch (err) { context.log.warn(`[supervisor-templates] activity log write failed: ${err.message || err}`); }
}

module.exports = async function (context, req) {
  try {
    const caller = await getCallerContext(context, req);
    if (!caller.authorized) return json(context, caller.status || 401, { error: caller.error || "unauthorized" });
    if (!caller.userId) return json(context, 403, { error: "identity_unavailable" });

    const method = String(req.method || "GET").toUpperCase();
    const body   = req.body && typeof req.body === "object" ? req.body : {};
    const org    = resolveScopeOrg(context, caller, method === "GET" ? (req.query && req.query.customerId) : body.customerId);
    if (org.error) return json(context, org.status, { error: org.error });
    const { customerId, kind } = org;
    const by = { id: caller.userId, email: caller.userEmail };
    const who = { userId: caller.userId, userEmail: caller.userEmail, userName: caller.userName, orgId: customerId, orgName: customerName(customerId), ownerOrgId: caller.mode === "customer" ? customerId : "internal" };

    if (method === "GET") {
      const templates = await store.listSupervisorTemplates(customerId);
      return json(context, 200, { customerId, templates });
    }

    if (method === "PUT") {
      const id   = String(body.id || "").trim();
      const name = String(body.name || "").trim().slice(0, NAME_MAX);
      if (!name) return json(context, 400, { error: "name_required" });
      const before = id ? await store.getSupervisorTemplate(customerId, id) : null;
      if (id && !before) return json(context, 404, { error: "template_unknown" });
      const existing = await store.listSupervisorTemplates(customerId);
      if (existing.some((t) => t.id !== id && t.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) {
        return json(context, 400, { error: "name_taken" });
      }

      // Pages: the org's kind, then the scope. Tables: open to Supervisors.
      const scope = await store.getSupervisorScope(customerId);
      const { kept, dropped: unknown } = filterPages(body.features, kind);
      const features = kept.filter((k) => scope.includes(k));
      const dropped = unknown.length + (kept.length - features.length);
      const wanted = [...new Set((Array.isArray(body.dataTables) ? body.dataTables : []).map((v) => String(v || "").trim()).filter(Boolean))];
      const allRules = await store.listDataTableRules(customerId);
      const dataTables = wanted.filter((tid) => allRules[tid] && normalizeRules(allRules[tid].rules).visibleToSupervisors);
      const droppedTables = wanted.length - dataTables.length;

      const template = await store.setSupervisorTemplate(customerId, id, { name, features, dataTables }, by);
      const changed = !before || JSON.stringify([before.name, before.features, before.dataTables]) !== JSON.stringify([template.name, template.features, template.dataTables]);
      if (changed) {
        await logQuietly(context, {
          ...who,
          action: before ? "supervisorTemplate.set" : "supervisorTemplate.create",
          description: before
            ? `Changed the Supervisor template "${template.name}" for ${customerName(customerId)}: ${template.features.length} page${template.features.length === 1 ? "" : "s"}, ${template.dataTables.length} data table${template.dataTables.length === 1 ? "" : "s"}${before.name !== template.name ? ` (was "${before.name}")` : ""}`
            : `Created the Supervisor template "${template.name}" for ${customerName(customerId)}: ${template.features.length} page${template.features.length === 1 ? "" : "s"}, ${template.dataTables.length} data table${template.dataTables.length === 1 ? "" : "s"}`,
          details: { customerId, templateId: template.id, before, after: template, dropped, droppedTables },
        });
      }
      return json(context, 200, { customerId, template, dropped, droppedTables });
    }

    if (method === "DELETE") {
      const id = String(body.id || "").trim();
      if (!id) return json(context, 400, { error: "id_required" });
      const template = await store.getSupervisorTemplate(customerId, id);
      if (!template) return json(context, 404, { error: "template_unknown" });
      // Nobody may be left on a template that no longer exists.
      const users = (await licences.listActive(customerId)).filter((r) => r.templateId === id);
      if (users.length) return json(context, 409, { error: "template_in_use", users: users.length, names: users.map((r) => r.name || r.email || r.userId) });
      const deleted = await store.deleteSupervisorTemplate(customerId, id);
      if (deleted) {
        await logQuietly(context, {
          ...who, action: "supervisorTemplate.delete",
          description: `Deleted the Supervisor template "${template.name}" for ${customerName(customerId)}`,
          details: { customerId, templateId: id, before: template },
        });
      }
      return json(context, 200, { customerId, deleted });
    }

    return json(context, 405, { error: "method_not_allowed" });
  } catch (err) {
    context.log.error("[supervisor-templates] Error:", err && (err.stack || err.message || err));
    return json(context, 500, { error: "internal_error" });
  }
};
