/**
 * Data table rules — what a Supervisor may write into a data table.
 *
 *   GET /api/datatable-rules?customerId=&tableId=   → { customerId, tableId, rules, setAt }
 *   PUT /api/datatable-rules   { customerId, tableId, rules }
 *                                                   → { customerId, tableId, rules, setAt }
 *
 * Who may set (docs/data-table-rules-design.md §3): a customer session
 * whose own row is "administrator", for their own org — the customerId
 * they send is ignored; an internal session that is a superuser, an
 * Administrator, or a Supervisor whose pages include Data Tables › Edit
 * (the page the rules are set on), for the org in the header selector.
 * Anyone who may reach either data-table page may read.
 *
 * The rules are normalized before they are stored (dataTableRules.js) —
 * junk is dropped, never kept — and every PUT is written to the activity
 * log with the before and after, under the caller's verified identity.
 */
const { getCallerContext } = require("../lib/callerContext");
const { parseRegistry } = require("../lib/orgConfigResolver");
const { INTERNAL_ORG_SLUG } = require("../lib/licenseGate");
const { normalizeRules, EMPTY_RULES } = require("../lib/dataTableRules");
const store = require("../lib/orgSettingsStore");
const activityLog = require("../lib/activityLogStore");
const customers = require("../lib/customers.json");

const EDIT_PAGE = "data-tables.edit";
const SUPERVISOR_PAGE = "data-tables.supervisor";

function json(context, status, body) {
  context.res = { status, headers: { "Content-Type": "application/json" }, body };
}

function customerName(id) {
  const c = customers.find((x) => x.id === id);
  return c ? c.name : id;
}

/** May this caller reach a data-table page at all (read), and set rules (write)? */
function rights(caller) {
  if (caller.mode === "customer") {
    const admin = caller.role === "administrator";
    const pages = Array.isArray(caller.features) ? caller.features : null;
    const read = admin || !pages || pages.includes(EDIT_PAGE) || pages.includes(SUPERVISOR_PAGE);
    return { read, write: admin };
  }
  const pages = Array.isArray(caller.features) ? caller.features : null;   // null: administrator or superuser
  const hasEdit = !pages || pages.includes(EDIT_PAGE);
  return { read: hasEdit || (pages && pages.includes(SUPERVISOR_PAGE)), write: hasEdit };
}

/** Which org this caller acts on, or a refusal. */
function resolveOrg(context, caller, requested) {
  if (caller.mode === "customer") return { customerId: caller.customerId };
  if (caller.mode !== "internal") return { error: "internal_only", status: 403 };
  const customerId = String(requested || "").trim();
  if (!customerId) return { error: "customerId_required", status: 400 };
  if (customerId !== INTERNAL_ORG_SLUG && !parseRegistry(context).some((e) => e.id === customerId)) {
    return { error: "not_a_customer", status: 400 };
  }
  return { customerId };
}

module.exports = async function (context, req) {
  try {
    const caller = await getCallerContext(context, req);
    if (!caller.authorized) return json(context, caller.status || 401, { error: caller.error || "unauthorized" });
    if (!caller.userId) return json(context, 403, { error: "identity_unavailable" });

    const method = String(req.method || "GET").toUpperCase();
    const body   = req.body && typeof req.body === "object" ? req.body : {};
    const q      = req.query || {};
    const org    = resolveOrg(context, caller, method === "GET" ? q.customerId : body.customerId);
    if (org.error) return json(context, org.status, { error: org.error });
    const { customerId } = org;
    const tableId = String((method === "GET" ? q.tableId : body.tableId) || "").trim();
    if (!tableId) return json(context, 400, { error: "tableId_required" });
    const may = rights(caller);

    if (method === "GET") {
      if (!may.read) return json(context, 403, { error: "page_required" });
      const row = await store.getDataTableRules(customerId, tableId);
      return json(context, 200, {
        customerId, tableId,
        rules: row ? normalizeRules(row.rules) : EMPTY_RULES,
        setAt: row ? row.setAt : null,
      });
    }

    if (method === "PUT") {
      if (!may.write) return json(context, 403, { error: caller.mode === "customer" ? "administrator_required" : "edit_page_required" });
      const rules  = normalizeRules(body.rules);
      const before = await store.getDataTableRules(customerId, tableId);
      const beforeRules = before ? normalizeRules(before.rules) : EMPTY_RULES;
      const result = await store.setDataTableRules(customerId, tableId, rules, { id: caller.userId, email: caller.userEmail });
      if (JSON.stringify(beforeRules) !== JSON.stringify(rules)) {
        try {
          const n = Object.keys(rules.columns).length;
          await activityLog.create({
            userId: caller.userId, userEmail: caller.userEmail, userName: caller.userName,
            orgId: customerId, orgName: customerName(customerId),
            ownerOrgId: caller.mode === "customer" ? customerId : "internal",
            action: "dataTableRules.set",
            description: `Set the Supervisor rules for data table ${String(body.tableName || tableId)} in ${customerName(customerId)}: ${n} column rule${n === 1 ? "" : "s"}`
              + `${rules.mayAddRows ? ", may add rows" : ""}`,
            details: { customerId, tableId, tableName: body.tableName || "", before: beforeRules, after: rules },
          });
        } catch (err) {
          context.log.warn(`[datatable-rules] activity log write failed: ${err.message || err}`);
        }
      }
      return json(context, 200, { customerId, tableId, rules: result.rules, setAt: result.setAt });
    }

    return json(context, 405, { error: "method_not_allowed" });
  } catch (err) {
    context.log.error("[datatable-rules] Error:", err && (err.stack || err.message || err));
    return json(context, 500, { error: "internal_error" });
  }
};
