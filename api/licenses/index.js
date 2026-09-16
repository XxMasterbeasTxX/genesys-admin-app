/**
 * Named users — Customers › Access to Admin Tool, and the internal org's own list.
 *
 *   GET    /api/licenses?customerId=      → { users: [active rows] }
 *   POST   /api/licenses/assign           { customerId, userId, email, name, role, features }
 *   DELETE /api/licenses/assign           { customerId, userId }
 *   POST   /api/licenses/role             { customerId, userId, role, features }
 *   POST   /api/licenses/manages          { customerId, userId, manages }   internal org only
 *   GET    /api/licenses/peak?customerId=&start=&end=
 *                                         → { users: n }  the period's peak
 *
 * Who may change a list is decided here, from the caller's verified identity,
 * never assumed from the page (docs/internal-user-access-design.md §5,
 * docs/customer-roles-design.md §5):
 *
 *   the internal org's list    superusers only (the SUPERUSER_IDS app setting)
 *                              — naming, removing, roles and pages alike
 *                              (docs/internal-roles-design.md §4)
 *   a customer's list          superusers, and internal colleagues whose own
 *                              row says they manage customer access
 *   "Manages customer access"  superusers only (/manages)
 *   a customer's own list      its Administrators may READ it and change any
 *                              user's role and pages (/role) — never add or
 *                              remove a name. The customerId they send is
 *                              ignored and their verified org used.
 *
 * A colleague who manages customer access therefore cannot add anyone to the
 * internal org, and cannot give anyone else that right. Adding a customer name starts a
 * charge, so that right is granted in the app by a superuser and logged — not
 * administered through a Genesys group by people who may not know the group
 * does that. The Master Admin group that used to gate this endpoint gates
 * nothing now.
 *
 * Every row carries a role, "administrator" or "supervisor", required on
 * every add, for both kinds of org (customer-roles-design §4,
 * internal-roles-design §3). A supervisor also carries their own pages: a
 * non-empty subset of the org's Supervisor scope. An empty scope refuses the
 * add with "scope_empty" — the scope must be set first.
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
const orgSettings = require("../lib/orgSettingsStore");
const { filterPages } = require("../lib/pages");
const activityLog = require("../lib/activityLogStore");
const customers = require("../lib/customers.json");

const INTERNAL_ORG_SLUG = String(process.env.INTERNAL_ORG_SLUG || "demo").trim();
const ROLES = new Set(["administrator", "supervisor"]);

/**
 * What a customer session is told about WHO did something to a row. An
 * internal person is the company, not a name — a customer sees "TDC Erhverv"
 * where staff see the colleague; their own Administrator's edits keep the
 * Administrator's name, since that is their own colleague. Ids and e-mails
 * never cross to a customer at all. Decided here, on the server, so the
 * browser is never sent what it must not show.
 */
const INTERNAL_DISPLAY_NAME = "TDC Erhverv";
function forCustomer(row, customerId) {
  const own = row.modifiedAt && row.modifiedByOrg === customerId;
  return {
    ...row,
    assignedBy: "", assignedByEmail: "", assignedByName: INTERNAL_DISPLAY_NAME,   // naming is always internal
    modifiedBy: "", modifiedByEmail: "",
    modifiedByName: row.modifiedAt ? (own ? row.modifiedByName : INTERNAL_DISPLAY_NAME) : "",
  };
}

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
 * colleague whose own row says they manage customer access may change a
 * customer's, never the internal org's. The capability arrives on the
 * context from the gate, read off their own row — not from anything the
 * page sent.
 */
function mayManage(caller, org) {
  if (caller.superuser) return { ok: true };
  if (org.internal) return { ok: false, error: "superuser_required" };
  if (caller.managesCustomers) return { ok: true };
  return { ok: false, error: "customer_manager_required" };
}

/**
 * The role and pages a row is to carry, checked against the org's Supervisor
 * scope. An administrator has no pages of their own (everything); a
 * supervisor must hold at least one page, all of them inside the scope. The
 * pages an org may hold at all depend on its kind (pages.js).
 * @returns {Promise<{ ok: true, role, features } | { ok: false, error, status }>}
 */
async function roleAndPages(customerId, body, kind) {
  const role = String(body.role || "").trim();
  if (!ROLES.has(role)) return { ok: false, status: 400, error: "role_required" };
  if (role === "administrator") return { ok: true, role, features: [] };

  const scope = await orgSettings.getSupervisorScope(customerId);
  if (!scope.length) return { ok: false, status: 400, error: "scope_empty" };
  const { kept } = filterPages(body.features, kind);
  const features = kept.filter((k) => scope.includes(k));
  if (!features.length) return { ok: false, status: 400, error: "pages_required" };
  return { ok: true, role, features };
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

    if (!caller.userId) return json(context, 403, { error: "identity_unavailable" });

    const body   = req.body && typeof req.body === "object" ? req.body : {};
    const by     = {
      id: caller.userId || "", email: caller.userEmail || "", name: caller.userName || "",
      org: caller.mode === "customer" ? caller.customerId : "internal",
    };

    // ── A customer session: an Administrator's view of their own org ──────
    // Read the list; change a user's role and pages. Never add or remove a
    // name — that stays Netdesign's (customer-roles-design §5). The org is
    // the verified one, whatever the body says.
    if (caller.mode === "customer") {
      if (action === "assign") return json(context, 403, { error: "internal_only" });
      if (caller.role !== "administrator") return json(context, 403, { error: "administrator_required" });
      const customerId = caller.customerId;

      if (method === "GET" && !action) {
        const users = (await store.listActive(customerId)).map((r) => forCustomer(r, customerId));
        return json(context, 200, { customerId, internal: false, users });
      }
      if (method === "POST" && action === "role") {
        const userId = String(body.userId || "").trim();
        if (!userId) return json(context, 400, { error: "customerId_and_userId_required" });
        const out = await setRoleAndPages(context, customerId, userId, body, by, customerId, "customer");
        if (context.res && context.res.status === 200 && context.res.body.user) {
          context.res.body.user = forCustomer(context.res.body.user, customerId);
        }
        return out;
      }
      return json(context, 404, { error: "not_found" });
    }

    if (caller.mode !== "internal") return json(context, 403, { error: "internal_only" });

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

      // Every row needs its role (and a supervisor its pages) from the
      // first day. The capability is granted separately (/manages).
      const rolePages = await roleAndPages(customerId, body, org.internal ? "internal" : "customer");
      if (!rolePages.ok) return json(context, rolePages.status, { error: rolePages.error });

      const result = await store.assign(customerId, { id: userId, email: body.email, name: body.name }, by, rolePages);
      if (result.created) {
        await logQuietly(context, {
          userId: by.id, userEmail: by.email, userName: by.name,
          orgId: customerId, orgName: customerName(customerId), ownerOrgId: "internal",
          action: "licenses.assign",
          description: `Gave ${body.name || body.email || userId} access to the Admin Tool for ${customerName(customerId)} as ${rolePages.role}`,
          details: { customerId, userId, email: body.email || "", name: body.name || "", role: rolePages.role, features: rolePages.features },
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
    // Whoever may manage the list may set a user's role and pages: on the
    // internal org that is a superuser; on a customer org, a superuser or a
    // colleague who manages customer access.
    if (method === "POST" && action === "role") {
      const customerId = String(body.customerId || "").trim();
      const userId     = String(body.userId || "").trim();
      if (!userId) return json(context, 400, { error: "customerId_and_userId_required" });
      const org = listableOrg(context, customerId);
      if (!org.ok) return json(context, 400, { error: org.error });
      const may = mayManage(caller, org);
      if (!may.ok) return json(context, 403, { error: may.error });
      return setRoleAndPages(context, customerId, userId, body, by, "internal", org.internal ? "internal" : "customer");
    }

    // ── POST /api/licenses/manages ───────────────────────────────────────
    // "Manages customer access": the right to start charges to customers.
    // Internal rows only, superusers only, independent of the row's role.
    if (method === "POST" && action === "manages") {
      const customerId = String(body.customerId || "").trim();
      const userId     = String(body.userId || "").trim();
      const on         = body.manages === true || body.manages === "true";
      if (!userId) return json(context, 400, { error: "customerId_and_userId_required" });
      if (!caller.superuser) return json(context, 403, { error: "superuser_required" });
      if (customerId !== INTERNAL_ORG_SLUG) return json(context, 400, { error: "internal_org_only" });

      const result = await store.setManagesCustomers(customerId, userId, on, by);
      if (!result.row) return json(context, 404, { error: "user_not_named" });
      if (result.changed) {
        await logQuietly(context, {
          userId: by.id, userEmail: by.email, userName: by.name,
          orgId: customerId, orgName: customerName(customerId), ownerOrgId: "internal",
          action: "licenses.manages",
          description: on
            ? `Let ${result.row.name || result.row.email || userId} manage customer access to the Admin Tool`
            : `Withdrew ${result.row.name || result.row.email || userId}'s right to manage customer access`,
          details: { customerId, userId, email: result.row.email, name: result.row.name, manages: on },
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

/**
 * Set a user's role and pages. Shared by the internal path (any org the
 * caller may manage, the internal org included) and the customer path (their
 * own org), which have already decided the caller may. `ownerOrgId` says
 * whose log the entry belongs in; `kind` which pages the org may hold.
 */
async function setRoleAndPages(context, customerId, userId, body, by, ownerOrgId, kind) {
  const checked = await roleAndPages(customerId, body, kind);
  if (!checked.ok) return json(context, checked.status, { error: checked.error });

  const result = await store.setRole(customerId, userId, checked.role, by, checked.features);
  if (!result.row) return json(context, 404, { error: "user_not_named" });
  if (result.changed) {
    const who = result.row.name || result.row.email || userId;
    await logQuietly(context, {
      userId: by.id, userEmail: by.email, userName: by.name,
      orgId: customerId, orgName: customerName(customerId), ownerOrgId,
      action: "licenses.role",
      description: checked.role === "administrator"
        ? `Made ${who} an Administrator of the Admin Tool for ${customerName(customerId)}`
        : `Made ${who} a Supervisor of the Admin Tool for ${customerName(customerId)} with ${checked.features.length} page${checked.features.length === 1 ? "" : "s"}`,
      details: { customerId, userId, email: result.row.email, name: result.row.name, role: checked.role, features: checked.features },
    });
  }
  return json(context, 200, { user: result.row, changed: result.changed });
}
