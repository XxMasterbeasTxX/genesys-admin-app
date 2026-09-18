/**
 * The named-user gate.
 *
 * `classifyCaller` answers which org a token belongs to. This answers whether
 * the person holding it has been named for that org — by Netdesign for a
 * customer (docs/customer-user-licensing-design.md §4), by a superuser for
 * the internal org itself (docs/internal-user-access-design.md). Being in
 * the Genesys group the OAuth integration is restricted to gets a person
 * through the sign-in door; being named is what gets them past it.
 *
 * One function, three callers — org-config at login, getCallerContext for
 * every store endpoint, the proxy for every Genesys call — so an unnamed
 * user gets nothing, not just a blocked front door. The same three run it
 * for internal sessions now; until this change internal users were the only
 * ones who never met it, and the app's whole internal access model lived in
 * the browser.
 *
 * Superusers (the SUPERUSER_IDS app setting) are the root authority for the
 * internal org and bypass the store: nothing editable from the app can lock a
 * superuser out, so a superuser can always sign in and add the first name.
 *
 * INTERNAL_NAMED_USERS_ENFORCED: while the app setting is not "true", an
 * internal caller who WOULD be refused is admitted and logged instead. That
 * is how the list gets populated before the door shuts — nobody is seeded,
 * so the rollout is deploy, name everyone, flip the setting (design §8).
 * Customer sessions are always enforced; they always were.
 *
 * Fail closed. An unreadable store or an unverifiable identity is a refusal
 * for that request, with a reason that says which. Cached per token for the
 * same window as the classification, so a removal takes effect within it.
 */
const crypto = require("crypto");
const { identifyCaller } = require("./orgConfigResolver");
const { isSuperuser } = require("./superusers");
const store = require("./licenseStore");
const orgSettings = require("./orgSettingsStore");
const { normalizeRules } = require("./dataTableRules");

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

const INTERNAL_ORG_SLUG = String(process.env.INTERNAL_ORG_SLUG || "demo").trim();
const SUPERVISOR_TABLES_PAGE = "data-tables.supervisor";

function internalEnforced() {
  return String(process.env.INTERNAL_NAMED_USERS_ENFORCED || "").trim().toLowerCase() === "true";
}

function tokenKey(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * @param {Object} context  Azure Functions context (for logging); optional.
 * @param {string} token    The caller's Genesys token.
 * @param {Object} classification  From classifyCaller; mode "customer" or "internal".
 * @returns {Promise<
 *   { licensed: true,  userId: string, role: string, superuser: boolean, unenforced?: true }
 * | { licensed: false, reason: "not_assigned"|"identity_unavailable"|"license_check_failed", userId?: string }>}
 *
 * `role` is the row's role, "administrator" or "supervisor", for both kinds
 * of org; "superuser" for a superuser, who has no row. `features` is null
 * (an administrator — everything) or the supervisor's effective page keys;
 * `dataTables` is the supervisor's effective data table ids when their pages
 * include Data Tables › Supervisor, else null — no list, nothing bounded.
 * `managesCustomers` (internal only) is the row's capability to name users
 * for customer orgs; always true for a superuser. `unenforced` marks an
 * internal caller admitted only because INTERNAL_NAMED_USERS_ENFORCED is not
 * yet "true".
 */
async function checkLicense(context, token, classification) {
  const key = tokenKey(token);
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  if (hit) cache.delete(key);

  const internal = classification && classification.mode === "internal";
  const orgId    = internal
    ? INTERNAL_ORG_SLUG
    : classification && classification.customer && classification.customer.id;
  const region   = classification && classification.org && classification.org.region;

  const user = await identifyCaller(context, token, region);
  if (!user || !user.id) {
    // Not cached: "could not verify" is a reason to retry, not a verdict.
    return { licensed: false, reason: "identity_unavailable" };
  }

  // The root authority for the internal org. Checked before the store so an
  // unreadable store can never lock a superuser out.
  if (internal && isSuperuser({ userId: user.id })) {
    const value = { licensed: true, userId: user.id, role: "superuser", features: null, superuser: true, managesCustomers: true };
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  let row;
  try {
    row = await store.activeRow(orgId, user.id);
  } catch (err) {
    context?.log?.error?.(`[license] store read failed for ${orgId}: ${err.message || err}`);
    // Not cached either — a storage blip should clear with the blip.
    return { licensed: false, reason: "license_check_failed", userId: user.id };
  }

  let value;
  if (row) {
    // Their role decides what they may see, for both kinds of org. An
    // administrator sees everything the org offers (features null = no
    // narrowing); a supervisor sees their own pages ∩ the org's Super User
    // scope, computed here so a scope edit reaches every supervisor without
    // touching their rows (docs/customer-roles-design.md §2, §7;
    // docs/internal-roles-design.md §2).
    let role = row.role || "";
    if (role !== "administrator" && role !== "supervisor") {
      // Rows from before roles existed. Treated as an administrator and said
      // so, rather than locking a test account out over data that predates
      // the field. No production row should ever hit this.
      context?.log?.warn?.(`[license] row without a role treated as administrator: ${orgId} ${user.id}`);
      role = "administrator";
    }
    let features = null, dataTables = null;
    if (role === "supervisor") {
      let scope;
      try {
        scope = await orgSettings.getSupervisorScope(orgId);
      } catch (err) {
        context?.log?.error?.(`[license] scope read failed for ${orgId}: ${err.message || err}`);
        return { licensed: false, reason: "license_check_failed", userId: user.id };
      }
      // On a template, its pages and tables come first and the row's own are
      // extras; a template edit reaches every Super User on it here, their
      // extras untouched (docs/supervisor-templates-design.md §2). A template
      // since deleted contributes nothing.
      let template = null;
      if (row.templateId) {
        try {
          template = await orgSettings.getSupervisorTemplate(orgId, row.templateId);
        } catch (err) {
          context?.log?.error?.(`[license] template read failed for ${orgId}/${row.templateId}: ${err.message || err}`);
          return { licensed: false, reason: "license_check_failed", userId: user.id };
        }
      }
      const own = new Set([...(template ? template.features : []), ...(Array.isArray(row.features) ? row.features : [])]);
      features = scope.filter((k) => own.has(k));
      // Their data tables, the same way: the row's list ∩ the tables the org
      // has made visible to Super Users now, so a Master Admin closing a
      // table takes it from every Super User without touching their rows.
      // Only when they hold the Super User page — the list means nothing
      // otherwise (docs/data-table-rules-design.md §11).
      if (features.includes(SUPERVISOR_TABLES_PAGE)) {
        let allRules;
        try {
          allRules = await orgSettings.listDataTableRules(orgId);
        } catch (err) {
          context?.log?.error?.(`[license] data table rules read failed for ${orgId}: ${err.message || err}`);
          return { licensed: false, reason: "license_check_failed", userId: user.id };
        }
        const ownTables = [...new Set([...(template ? template.dataTables : []), ...(Array.isArray(row.dataTables) ? row.dataTables : [])])];
        // { [tableId]: { rules, setAt } } — the rules as stored, normalized here
        dataTables = ownTables.filter((id) => allRules[id] && normalizeRules(allRules[id].rules).visibleToSupervisors);
      }
    }
    value = { licensed: true, userId: user.id, role, features, dataTables, superuser: false };
    if (internal) value.managesCustomers = !!row.managesCustomers;
  } else if (internal && !internalEnforced()) {
    // Reporting mode: admitted as an administrator, and said so, so the log
    // is the list of who still needs naming before the setting flips.
    context?.log?.warn?.(`[license] internal caller not named (unenforced): ${user.id} ${user.email || ""} ${user.name || ""}`);
    value = { licensed: true, userId: user.id, role: "administrator", features: null, superuser: false, managesCustomers: false, unenforced: true };
  } else {
    value = { licensed: false, reason: "not_assigned", userId: user.id };
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** For tests and for a future "revoke now" — forget every cached verdict. */
function clearLicenseCache() {
  cache.clear();
}

module.exports = { checkLicense, clearLicenseCache, CACHE_TTL_MS, INTERNAL_ORG_SLUG };
