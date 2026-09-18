/**
 * The Super User scope — what a Super User in an org may have at all.
 *
 *   GET /api/supervisor-scope?customerId=   → { customerId, features: [...] }
 *   PUT /api/supervisor-scope               { customerId, features: [...] }
 *                                           → { customerId, features, dropped }
 *
 * Who may: lib/scopeRights.js (docs/customer-roles-design.md §5, §6;
 * docs/internal-roles-design.md §4) — shared with the Super User templates.
 *
 * Features are validated against the pages that kind of org may hold
 * (pages.js); the rest are dropped and named in the response. Every PUT is
 * written to the activity log with the before and after lists, under the
 * caller's verified identity.
 *
 * This is the first thing a customer writes in the app. It is scoped to
 * their org server-side, and it is the whole of a customer Master Admin's
 * power over access together with the role and pages of their org's users
 * (/api/licenses/role). Naming a user stays Netdesign's.
 */
const { getCallerContext } = require("../lib/callerContext");
const { resolveScopeOrg } = require("../lib/scopeRights");
const { filterPages } = require("../lib/pages");
const store = require("../lib/orgSettingsStore");
const activityLog = require("../lib/activityLogStore");
const customers = require("../lib/customers.json");

function json(context, status, body) {
  context.res = { status, headers: { "Content-Type": "application/json" }, body };
}

function customerName(id) {
  const c = customers.find((x) => x.id === id);
  return c ? c.name : id;
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

    if (method === "GET") {
      const features = await store.getSupervisorScope(customerId);
      return json(context, 200, { customerId, features });
    }

    if (method === "PUT") {
      const { kept, dropped } = filterPages(body.features, kind);
      const before = await store.getSupervisorScope(customerId);
      const result = await store.setSupervisorScope(customerId, kept, { id: caller.userId, email: caller.userEmail });
      if (JSON.stringify(before) !== JSON.stringify(result.features)) {
        try {
          await activityLog.create({
            userId: caller.userId, userEmail: caller.userEmail, userName: caller.userName,
            orgId: customerId, orgName: customerName(customerId),
            ownerOrgId: caller.mode === "customer" ? customerId : "internal",
            action: "supervisorScope.set",
            description: `Set the Super User scope for ${customerName(customerId)} to ${result.features.length} page${result.features.length === 1 ? "" : "s"}`,
            details: { customerId, before, after: result.features, dropped },
          });
        } catch (err) {
          context.log.warn(`[supervisor-scope] activity log write failed: ${err.message || err}`);
        }
      }
      return json(context, 200, { customerId, features: result.features, dropped });
    }

    return json(context, 405, { error: "method_not_allowed" });
  } catch (err) {
    context.log.error("[supervisor-scope] Error:", err && (err.stack || err.message || err));
    return json(context, 500, { error: "internal_error" });
  }
};
