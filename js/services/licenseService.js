/**
 * Named-user licences — the client side of /api/licenses and
 * /api/supervisor-scope.
 *
 * Who may do what is decided server-side from the caller's own row: naming
 * and removing by Netdesign (superusers and customer-managers); a customer
 * Master Admin may read their own org's list, change any user's role and
 * pages, and set the org's Super User scope (docs/customer-roles-design.md
 * §5). The caller's identity comes from the forwarded token, never from
 * anything sent here; a customer's customerId is ignored by the server in
 * favour of the verified one.
 */
import { withUserToken } from "./apiAuth.js";

async function call(method, path, body) {
  const resp = await fetch(path, {
    method,
    headers: withUserToken({ "Content-Type": "application/json", Accept: "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(licenseMessage(json.error, json, resp.status));
    err.code   = json.error || "request_failed";
    err.status = resp.status;
    if (json.users != null) err.users = json.users;
    if (Array.isArray(json.names)) err.names = json.names;
    throw err;
  }
  return json;
}

function licenseMessage(code, json, status) {
  switch (code) {
    case "superuser_required":        return "Only a Super Master Admin can change who has access to the internal organisation.";
    case "customer_manager_required": return "You have not been given the right to manage customer access. Ask a Super Master Admin.";
    case "identity_unavailable":      return "We could not verify who you are just now, so this change was not made. Try again in a moment.";
    case "internal_org_only":         return "Only users of the internal organisation can be given that right.";
    case "internal_org_has_no_scope": return "The internal organisation has no Super User scope.";
    case "user_not_named":            return "That person is not on the list.";
    case "invalid_role":              return "That is not a role this page knows.";
    case "internal_only":             return "This page is for Netdesign staff.";
    case "administrator_required":    return "Only a Master Admin of your organisation can do this.";
    case "role_required":             return "Choose Master Admin or Super User.";
    case "scope_empty":               return "Nothing is in the Super User scope for this organisation yet. Set it on Super User Access first.";
    case "pages_required":            return "Tick at least one page from the Super User scope.";
    case "template_unknown":          return "That template no longer exists. Reload the page and choose again.";
    case "template_in_use":           return "This template is in use. Move its Super Users to another template first.";
    case "name_required":             return "Give the template a name.";
    case "name_taken":                return "A template with that name already exists.";
    case "id_required":               return "Choose a template first.";
    case "tables_required":           return "With Data Tables › Supervisor ticked, tick at least one data table. Only tables a Master Admin has made visible to Super Users (Data Tables › Edit) can be chosen.";
    case "customerId_required":       return "Select a customer organisation first.";
    case "not_a_customer":   return "This organisation is not set up as a customer yet — it has no registry entry, so nobody can sign in to it as a customer.";
    default:                 return `The request failed (${code || status}).`;
  }
}

/** Everyone currently named for a customer. */
export async function listLicensedUsers(customerId) {
  const r = await call("GET", `/api/licenses?customerId=${encodeURIComponent(customerId)}`);
  return r.users || [];
}

/**
 * Name a user. Returns { user, created } — created is false if they already
 * had access. `role` ("administrator" | "supervisor") is required for both
 * kinds of org, and a supervisor's `features` (page keys inside the org's
 * scope) must be non-empty; with the Data Tables › Supervisor page, so must
 * their `dataTables` (ids of tables the org has opened to Super Users).
 */
export function assignLicense(customerId, { id, email, name }, { role = "", features = [], dataTables = [], templateId = "" } = {}) {
  return call("POST", "/api/licenses/assign", { customerId, userId: id, email, name, role, features, dataTables, templateId });
}

/**
 * Set the role, pages and data tables on a row: "administrator" |
 * "supervisor", with a supervisor's `features` and `dataTables`. By whoever may manage that org's list — the
 * internal org's by superusers only — and by a customer org's own
 * Master Admins. Server-checked. Returns { user, changed }.
 */
export function setLicenseRole(customerId, userId, role, features = [], dataTables = [], templateId = "") {
  return call("POST", "/api/licenses/role", { customerId, userId, role, features, dataTables, templateId });
}

/**
 * Grant or withdraw "Manages customer access" on an internal row — the right
 * to name users for customer orgs. Superusers only, internal org only,
 * independent of the role. Returns { user, changed }.
 */
export function setManagesCustomers(customerId, userId, manages) {
  return call("POST", "/api/licenses/manages", { customerId, userId, manages: !!manages });
}

/** The org's Super User scope: sorted page keys, [] when none set. */
export async function getSupervisorScope(customerId) {
  const r = await call("GET", `/api/supervisor-scope?customerId=${encodeURIComponent(customerId)}`);
  return r.features || [];
}

/** The org's Super User templates, by name: [{ id, name, features, dataTables }]. */
export async function listSupervisorTemplates(customerId) {
  const r = await call("GET", `/api/supervisor-templates?customerId=${encodeURIComponent(customerId)}`);
  return r.templates || [];
}

/** Create (no id) or overwrite (id) a template. Returns { template, dropped, droppedTables }. */
export function saveSupervisorTemplate(customerId, { id = "", name, features = [], dataTables = [] }) {
  return call("PUT", "/api/supervisor-templates", { customerId, id, name, features, dataTables });
}

/** Delete a template nobody is on. 409 template_in_use otherwise (err.users, err.names). */
export async function deleteSupervisorTemplate(customerId, id) {
  return call("DELETE", "/api/supervisor-templates", { customerId, id });
}

/** Overwrite the org's Super User scope. Returns { customerId, features, dropped }. */
export function setSupervisorScope(customerId, features) {
  return call("PUT", "/api/supervisor-scope", { customerId, features });
}

/** Remove a user's access. Returns { user, revoked }. */
export function revokeLicense(customerId, userId) {
  return call("DELETE", "/api/licenses/assign", { customerId, userId });
}
