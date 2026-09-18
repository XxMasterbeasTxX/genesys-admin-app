/**
 * Who may set what a Super User in an org may have — the Super User scope
 * and the Super User templates share the answer (docs/customer-roles-design.md
 * §5, §6; docs/internal-roles-design.md §4; docs/supervisor-templates-design.md §3):
 *
 *   a customer session whose own row is "administrator"   their own org only —
 *                                                          the customerId they
 *                                                          send is ignored
 *   an internal session that is a superuser, or whose      any customer org
 *   own row manages customer access
 *   a superuser                                            the internal org
 */
const { parseRegistry } = require("./orgConfigResolver");
const { INTERNAL_ORG_SLUG } = require("./licenseGate");

/**
 * Which org this caller may act on, and of which kind, or a refusal.
 * @returns {{ customerId: string, kind: "customer"|"internal" } | { error: string, status: number }}
 */
function resolveScopeOrg(context, caller, requested) {
  if (caller.mode === "customer") {
    if (caller.role !== "administrator") return { error: "administrator_required", status: 403 };
    return { customerId: caller.customerId, kind: "customer" };   // never what they sent
  }
  if (caller.mode !== "internal") return { error: "internal_only", status: 403 };
  const customerId = String(requested || "").trim();
  if (!customerId) return { error: "customerId_required", status: 400 };
  if (customerId === INTERNAL_ORG_SLUG) {
    // The internal org's own scope: what its Super Users may see. Superusers
    // only, like everything else about the internal list.
    if (!caller.superuser) return { error: "superuser_required", status: 403 };
    return { customerId, kind: "internal" };
  }
  if (!caller.superuser && !caller.managesCustomers) return { error: "customer_manager_required", status: 403 };
  if (!parseRegistry(context).some((e) => e.id === customerId)) return { error: "not_a_customer", status: 400 };
  return { customerId, kind: "customer" };
}

module.exports = { resolveScopeOrg };
