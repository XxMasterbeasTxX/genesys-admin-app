/**
 * Named-user licences — Customers › Access to Admin Tool.
 *
 *   GET    /api/licenses?customerId=      → { users: [active rows] }
 *   POST   /api/licenses/assign           { customerId, userId, email, name }
 *   DELETE /api/licenses/assign           { customerId, userId }
 *
 * Internal sessions only, and the caller must be in "Genesys App - Master
 * Admin" — checked here from the caller's own groups, not assumed from the
 * page (docs/customer-user-licensing-design.md §5). Adding a name starts a
 * charge; the endpoint is gated as tightly as the page.
 *
 * Every add and remove is written to the activity log with the caller's
 * VERIFIED identity (from the token, never the body).
 */
const { getCallerContext } = require("../lib/callerContext");
const { getBearerToken, parseRegistry } = require("../lib/orgConfigResolver");
const { fetchUserGroupNames } = require("../lib/userGroups");
const store = require("../lib/licenseStore");
const activityLog = require("../lib/activityLogStore");
const customers = require("../lib/customers.json");

const REQUIRED_GROUP = "Genesys App - Master Admin";
const HOME_REGION = process.env.GENESYS_HOME_REGION || "mypurecloud.de";
const INTERNAL_ORG_SLUG = String(process.env.INTERNAL_ORG_SLUG || "demo").trim();

/**
 * Only an org that can sign in AS A CUSTOMER has a list. The internal org's
 * users are gated by group membership and never meet the licence gate, so a
 * name added for it would do nothing but mislead; an org with no registry
 * entry cannot sign in as a customer at all. Both are refused with a code the
 * page turns into a sentence.
 */
function licensableCustomer(context, customerId) {
  if (!customerId) return { ok: false, error: "customerId_required" };
  if (customerId === INTERNAL_ORG_SLUG) return { ok: false, error: "internal_org" };
  const registry = parseRegistry(context);
  if (!registry.some((e) => e.id === customerId)) return { ok: false, error: "not_a_customer" };
  return { ok: true };
}

function json(context, status, body) {
  context.res = { status, headers: { "Content-Type": "application/json" }, body };
}

function customerName(id) {
  const c = customers.find((x) => x.id === id);
  return c ? c.name : id;
}

async function logQuietly(context, entry) {
  try { await activityLog.create(entry); }
  catch (err) { context.log.warn(`[licenses] activity log write failed: ${err.message || err}`); }
}

module.exports = async function (context, req) {
  try {
    const caller = await getCallerContext(context, req);
    if (!caller.authorized) return json(context, caller.status || 401, { error: caller.error || "unauthorized" });
    if (caller.mode !== "internal") return json(context, 403, { error: "internal_only" });

    // The group check. fetchUserGroupNames returns null on failure → refuse.
    const token  = getBearerToken(req);
    const groups = await fetchUserGroupNames(token, HOME_REGION);
    if (!Array.isArray(groups)) return json(context, 403, { error: "group_unverified", required: REQUIRED_GROUP });
    if (!groups.includes(REQUIRED_GROUP)) return json(context, 403, { error: "group_required", required: REQUIRED_GROUP });

    const method = String(req.method || "GET").toUpperCase();
    const action = String((req.params && req.params.action) || "").toLowerCase();
    const body   = req.body && typeof req.body === "object" ? req.body : {};
    const by     = { id: caller.userId || "", email: caller.userEmail || "", name: caller.userName || "" };

    // ── GET /api/licenses?customerId= ────────────────────────────────────
    if (method === "GET" && !action) {
      const customerId = String((req.query && req.query.customerId) || "").trim();
      const lc = licensableCustomer(context, customerId);
      if (!lc.ok) return json(context, 400, { error: lc.error });
      const users = await store.listActive(customerId);
      return json(context, 200, { customerId, users });
    }

    // ── POST /api/licenses/assign ────────────────────────────────────────
    if (method === "POST" && action === "assign") {
      const customerId = String(body.customerId || "").trim();
      const userId     = String(body.userId || "").trim();
      const lc = licensableCustomer(context, customerId);
      if (!lc.ok) return json(context, 400, { error: lc.error });
      if (!userId) return json(context, 400, { error: "customerId_and_userId_required" });

      const result = await store.assign(customerId, { id: userId, email: body.email, name: body.name }, by);
      if (result.created) {
        await logQuietly(context, {
          userId: by.id, userEmail: by.email, userName: by.name,
          orgId: customerId, orgName: customerName(customerId), ownerOrgId: "internal",
          action: "licenses.assign",
          description: `Gave ${body.name || body.email || userId} access to the Admin Tool for ${customerName(customerId)}`,
          details: { customerId, userId, email: body.email || "", name: body.name || "" },
        });
      }
      return json(context, 200, { user: result.row, created: result.created });
    }

    // ── DELETE /api/licenses/assign ──────────────────────────────────────
    if (method === "DELETE" && action === "assign") {
      const customerId = String(body.customerId || "").trim();
      const userId     = String(body.userId || "").trim();
      const lc = licensableCustomer(context, customerId);
      if (!lc.ok) return json(context, 400, { error: lc.error });
      if (!userId) return json(context, 400, { error: "customerId_and_userId_required" });

      const result = await store.revoke(customerId, userId, by);
      if (result.revoked) {
        await logQuietly(context, {
          userId: by.id, userEmail: by.email, userName: by.name,
          orgId: customerId, orgName: customerName(customerId), ownerOrgId: "internal",
          action: "licenses.revoke",
          description: `Removed ${result.row.name || result.row.email || userId}'s access to the Admin Tool for ${customerName(customerId)}`,
          details: { customerId, userId, email: result.row.email, name: result.row.name },
        });
      }
      return json(context, 200, { user: result.row, revoked: result.revoked });
    }

    return json(context, 404, { error: "not_found" });
  } catch (err) {
    context.log.error("[licenses] Error:", err && (err.stack || err.message || err));
    return json(context, 500, { error: "internal_error" });
  }
};
