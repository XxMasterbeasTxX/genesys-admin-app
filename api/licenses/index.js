/**
 * Named users — Customers › Access to Admin Tool, and the internal org's own list.
 *
 *   GET    /api/licenses?customerId=      → { users: [active rows] }
 *   POST   /api/licenses/assign           { customerId, userId, email, name }
 *   DELETE /api/licenses/assign           { customerId, userId }
 *   POST   /api/licenses/role             { customerId, userId, role }   internal org only
 *   GET    /api/licenses/peak?customerId=&start=&end=
 *                                         → { users: n }  the period's peak
 *
 * Who may change a list is decided here, from the caller's verified identity,
 * never assumed from the page (docs/internal-user-access-design.md §5):
 *
 *   the internal org's list    superusers only (the SUPERUSER_IDS app setting)
 *   a customer's list          superusers, and internal colleagues whose own
 *                              row carries role "customer-manager"
 *   setting "customer-manager" superusers only
 *
 * A customer-manager therefore cannot add anyone to the internal org, and
 * cannot make anyone else a customer-manager. Adding a customer name starts a
 * charge, so that right is granted in the app by a superuser and logged — not
 * administered through a Genesys group by people who may not know the group
 * does that. The Master Admin group that used to gate this endpoint gates
 * nothing now.
 *
 * The peak is different: reading a count is not the commercial act. Any
 * internal session may ask for any org; a customer session may ask only
 * about its own — the customerId it sends is ignored and the verified org
 * used (docs/billing-apps-section-design.md §2.1).
 *
 * Every add, remove and role change is written to the activity log with the
 * caller's VERIFIED identity (from the token, never the body).
 */
const { getCallerContext } = require("../lib/callerContext");
const { parseRegistry } = require("../lib/orgConfigResolver");
const store = require("../lib/licenseStore");
const activityLog = require("../lib/activityLogStore");
const customers = require("../lib/customers.json");

const INTERNAL_ORG_SLUG = String(process.env.INTERNAL_ORG_SLUG || "demo").trim();
const INTERNAL_ROLES = new Set(["", "customer-manager"]);

/**
 * An org has a list if it can sign in as a customer, or if it is the internal
 * org itself. Anything else is refused with a code the page turns into a
 * sentence.
 */
function listableOrg(context, customerId) {
  if (!customerId) return { ok: false, error: "customerId_required" };
  if (customerId === INTERNAL_ORG_SLUG) return { ok: true, internal: true };
  const registry = parseRegistry(context);
  if (!registry.some((e) => e.id === customerId)) return { ok: false, error: "not_a_customer" };
  return { ok: true, internal: false };
}

/**
 * May this caller change THIS org's list? Superusers may change any. A
 * colleague whose own row says "customer-manager" may change a customer's,
 * never the internal org's. The caller's role arrives on the context from
 * the gate, read off their own row — not from anything the page sent.
 */
function mayManage(caller, org) {
  if (caller.superuser) return { ok: true };
  if (org.internal) return { ok: false, error: "superuser_required" };
  if (caller.role === "customer-manager") return { ok: true };
  return { ok: false, error: "customer_manager_required" };
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

    const method = String(req.method || "GET").toUpperCase();
    const action = String((req.params && req.params.action) || "").toLowerCase();

    // ── GET /api/licenses/peak?customerId=&start=&end= ───────────────────
    // Before the internal-only and group checks: a customer may read its
    // own count (the gate in getCallerContext already vouched for them).
    if (method === "GET" && action === "peak") {
      const q = req.query || {};
      const customerId = caller.mode === "customer"
        ? caller.customerId                                   // never what they sent
        : String(q.customerId || "").trim();
      if (!customerId) return json(context, 400, { error: "customerId_required" });
      const start = String(q.start || "").trim(), end = String(q.end || "").trim();
      const s = Date.parse(start), e = Date.parse(end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return json(context, 400, { error: "invalid_period" });
      const users = await store.peakAssigned(customerId, start, end);
      return json(context, 200, { customerId, start, end, users });
    }

    if (caller.mode !== "internal") return json(context, 403, { error: "internal_only" });
    if (!caller.userId) return json(context, 403, { error: "identity_unavailable" });

    const body   = req.body && typeof req.body === "object" ? req.body : {};
    const by     = { id: caller.userId || "", email: caller.userEmail || "", name: caller.userName || "" };

    // ── GET /api/licenses?customerId= ────────────────────────────────────
    if (method === "GET" && !action) {
      const customerId = String((req.query && req.query.customerId) || "").trim();
      const org = listableOrg(context, customerId);
      if (!org.ok) return json(context, 400, { error: org.error });
      const may = mayManage(caller, org);
      if (!may.ok) return json(context, 403, { error: may.error });
      const users = await store.listActive(customerId);
      return json(context, 200, { customerId, internal: org.internal, users });
    }

    // ── POST /api/licenses/assign ────────────────────────────────────────
    if (method === "POST" && action === "assign") {
      const customerId = String(body.customerId || "").trim();
      const userId     = String(body.userId || "").trim();
      const org = listableOrg(context, customerId);
      if (!org.ok) return json(context, 400, { error: org.error });
      const may = mayManage(caller, org);
      if (!may.ok) return json(context, 403, { error: may.error });
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
      const org = listableOrg(context, customerId);
      if (!org.ok) return json(context, 400, { error: org.error });
      const may = mayManage(caller, org);
      if (!may.ok) return json(context, 403, { error: may.error });
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

    // ── POST /api/licenses/role ──────────────────────────────────────────
    // Only the internal org's rows carry a role today, and only a superuser
    // sets one: "customer-manager" is the right to start charges to customers.
    if (method === "POST" && action === "role") {
      const customerId = String(body.customerId || "").trim();
      const userId     = String(body.userId || "").trim();
      const role       = String(body.role || "").trim();
      if (!caller.superuser) return json(context, 403, { error: "superuser_required" });
      if (customerId !== INTERNAL_ORG_SLUG) return json(context, 400, { error: "internal_org_only" });
      if (!userId) return json(context, 400, { error: "customerId_and_userId_required" });
      if (!INTERNAL_ROLES.has(role)) return json(context, 400, { error: "invalid_role" });

      const result = await store.setRole(customerId, userId, role, by);
      if (!result.row) return json(context, 404, { error: "user_not_named" });
      if (result.changed) {
        await logQuietly(context, {
          userId: by.id, userEmail: by.email, userName: by.name,
          orgId: customerId, orgName: customerName(customerId), ownerOrgId: "internal",
          action: "licenses.role",
          description: role
            ? `Let ${result.row.name || result.row.email || userId} manage customer access to the Admin Tool`
            : `Withdrew ${result.row.name || result.row.email || userId}'s right to manage customer access`,
          details: { customerId, userId, email: result.row.email, name: result.row.name, role },
        });
      }
      return json(context, 200, { user: result.row, changed: result.changed });
    }

    return json(context, 404, { error: "not_found" });
  } catch (err) {
    context.log.error("[licenses] Error:", err && (err.stack || err.message || err));
    return json(context, 500, { error: "internal_error" });
  }
};
