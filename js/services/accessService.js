/**
 * Access resolution service.
 *
 * Fetches the logged-in user's group memberships from your own Genesys org
 * (using the PKCE access token) and resolves which app features they can access.
 */
import { CONFIG } from "../config.js";
import { SUPERUSER_ONLY_KEYS, CUSTOMER_MANAGER_KEYS, CUSTOMER_EXCLUDED_KEYS, CUSTOMER_ADMIN_KEYS } from "../accessConfig.js";
import {
  isWriteGated, getRequiredPermissions, getActionPermissions,
  isReadGated, getReadPermissions,
} from "../featurePermissionMap.js";

// Feature flag: when true, WRITE actions are additionally gated by the user's
// OWN Genesys permissions — internal users in the company org (see
// docs/customer-facing-plan.md §6), customers in theirs
// (docs/customer-permission-refinement-design.md). Read-only features are never
// affected; superusers always bypass. Set to false to disable the permission
// refinement entirely on both sides (named-user / entitlement access only).
const ENFORCE_PERMISSION_REFINEMENT = true;

/**
 * Fetch the authenticated user's effective Genesys permissions.
 *
 * `apiBase` defaults to the company org's region. A customer's token is only
 * valid on THEIR region, so the customer resolver passes the session's base —
 * asking `.de` about a `.ie` token is a 401, which the fail-closed rule would
 * turn into every write greyed.
 *
 * Reads BOTH `authorization.permissions` (flat strings, may include wildcards)
 * and `authorization.permissionPolicies` (domain/entityName/actionSet) from the
 * `me` endpoint and merges them — some orgs populate only one of the two. Each
 * policy is flattened to `domain:entity:action` strings (wildcards preserved).
 *
 * Returns an array of permission strings, or null if the call fails / the
 * authorization block is entirely absent (→ callers fail closed for writes).
 */
async function fetchUserPermissions(accessToken, apiBase = CONFIG.apiBase) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  try {
    const resp = await fetch(`${apiBase}/api/v2/users/me?expand=authorization`, { headers });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error("[accessService] users/me?expand=authorization error:", resp.status, json);
      return null;
    }

    const auth = json && json.authorization ? json.authorization : null;
    if (!auth) {
      console.warn("[accessService] users/me returned no authorization block:", json);
      return null;
    }

    const perms = new Set();

    // 1) Flat permission strings (may already include wildcard forms).
    if (Array.isArray(auth.permissions)) {
      for (const p of auth.permissions) if (p) perms.add(p);
    }

    // 2) Derive from permission policies (domain:entity:action, wildcard-aware).
    if (Array.isArray(auth.permissionPolicies)) {
      for (const pol of auth.permissionPolicies) {
        if (!pol || !pol.domain) continue;
        const entity = pol.entityName || "*";
        const actions = Array.isArray(pol.actionSet) && pol.actionSet.length ? pol.actionSet : ["*"];
        for (const action of actions) perms.add(`${pol.domain}:${entity}:${action}`);
      }
    }

    if (!Array.isArray(auth.permissions) && !Array.isArray(auth.permissionPolicies)) {
      console.warn("[accessService] authorization has neither permissions nor permissionPolicies:", auth);
      return null;
    }

    const list = [...perms];
    console.info(`[accessService] fetched ${list.length} effective permission entries`);
    return list;
  } catch (err) {
    console.error("[accessService] permission fetch failed:", err);
    return null;
  }
}

/**
 * True if a granted permission string covers a required one, honouring `*`
 * wildcard segments (e.g. "routing:queue:*" grants "routing:queue:edit").
 */
function permGrants(granted, required) {
  if (granted === "*") return true;
  const g = granted.split(":");
  const r = required.split(":");
  if (g.length !== 3 || r.length !== 3) return granted === required;
  return g.every((seg, i) => seg === "*" || seg === r[i]);
}

/**
 * The permission-refinement half of access, shared by both resolvers.
 *
 * Given a `hasAccess` that already answers "may this session see this page at
 * all" (groups for internal sessions, entitlements for customers), this layers
 * the user's OWN Genesys permissions on top: a page the session may see but the
 * user cannot act on reads `denied-no-permission` — shown greyed with the
 * missing permissions named — rather than `allowed`. The distinction between
 * "not your section" (hidden) and "not your permission" (greyed) is drawn here
 * and nowhere else, which is why there is one builder and not one per resolver.
 *
 * Fail-closed throughout: `permList === null` means the permission set could
 * not be read, and every gated action is then denied rather than assumed.
 *
 * @param {{ hasAccess: (k: string) => boolean,
 *           permList: string[]|null,
 *           isSuper: boolean,
 *           sessionMode: "internal"|"customer" }} p
 *   `sessionMode` selects a read entry's per-mode block where one exists
 *   (see featurePermissionMap.getReadPermissions).
 */
function buildRefinedAccess({ hasAccess, permList, isSuper, sessionMode = "internal" }) {
  const permsAvailable = Array.isArray(permList);
  const hasPermission = (perm) => permsAvailable && permList.some((g) => permGrants(g, perm));

  /**
   * Refined state for a page key:
   *   "hidden"                — no group access (never show)
   *   "denied-no-permission"  — group grants it, but the user lacks the Genesys
   *                             permission for its write action(s) (show disabled)
   *   "allowed"               — usable
   * Read-only / app-storage features (not in the write map) are always "allowed"
   * when group-granted. Superusers are always "allowed".
   */
  function accessState(pageKey, action) {
    if (!hasAccess(pageKey)) return "hidden";
    if (isSuper) return "allowed";
    if (!ENFORCE_PERMISSION_REFINEMENT) return "allowed";

    if (isWriteGated(pageKey)) {
      const required = getRequiredPermissions(pageKey);
      if (!required.length) return "allowed";
      // Fail-closed: if we couldn't read the user's permissions, deny.
      if (!permsAvailable) return "denied-no-permission";
      return required.some(hasPermission) ? "allowed" : "denied-no-permission";
    }

    // Reads are gated on what Genesys itself requires for the endpoints the
    // page reads — the client-credentials path means a read here is not the
    // user's own read. See docs/read-permission-gating-design.md.
    if (isReadGated(pageKey)) {
      const { mode, permissions } = getReadPermissions(pageKey, action, sessionMode);
      if (!permissions.length) return "allowed";
      if (!permsAvailable) return "denied-no-permission";
      const ok = mode === "all"
        ? permissions.every(hasPermission)
        : permissions.some(hasPermission);
      return ok ? "allowed" : "denied-no-permission";
    }

    return "allowed";
  }

  /** The required write permissions the user is missing for a page key. */
  function getMissingPermissions(pageKey, action) {
    if (isSuper) return [];
    if (isWriteGated(pageKey)) {
      const required = getRequiredPermissions(pageKey);
      if (!permsAvailable) return required;
      return required.filter((p) => !hasPermission(p));
    }
    if (isReadGated(pageKey)) {
      const { permissions } = getReadPermissions(pageKey, action, sessionMode);
      if (!permsAvailable) return permissions;
      return permissions.filter((p) => !hasPermission(p));
    }
    return [];
  }

  /**
   * In-page capability check for a specific logical action of a feature
   * (e.g. can("data-tables.edit", "rowsDelete")). Returns true when the action
   * has no permission mapping, or the user holds every permission it requires.
   * Superusers always true; fail-closed when permissions couldn't be read.
   */
  function can(accessKey, action) {
    if (isSuper) return true;
    if (!ENFORCE_PERMISSION_REFINEMENT) return true;

    const writePerms = getActionPermissions(accessKey, action);
    if (writePerms.length) {
      if (!permsAvailable) return false;
      return writePerms.every(hasPermission);
    }

    // A read action of a read-gated feature — e.g. the WEM tab of
    // roles.search, which needs the licence permission its siblings do not.
    if (isReadGated(accessKey)) {
      const { mode, permissions } = getReadPermissions(accessKey, action, sessionMode);
      if (!permissions.length) return true;
      if (!permsAvailable) return false;
      return mode === "all"
        ? permissions.every(hasPermission)
        : permissions.some(hasPermission);
    }

    return true;
  }

  return { accessState, getMissingPermissions, can };
}

/**
 * Resolve an internal user's access: their role decides the pages, their own
 * Genesys permissions refine the actions (see docs/customer-facing-plan.md §6,
 * docs/internal-roles-design.md §5).
 *
 * @param {string} accessToken   PKCE access token (your own Genesys org).
 * @param {{ superuser?: boolean, role?: string, features?: string[]|null, managesCustomers?: boolean }} who
 *        What org-config said about this caller, decided server-side by the
 *        named-user gate: whether they are a superuser (the SUPERUSER_IDS app
 *        setting), the role on their own row, a Supervisor's effective pages
 *        (null for an Administrator — everything), and whether their row lets
 *        them manage customer access.
 * @returns {Promise<{ hasAccess, hasAnyAccess, accessState, getMissingPermissions }>}
 */
export async function resolveAccess(accessToken, who = {}) {
  const isSuper = !!who.superuser;
  const canManageCustomers = isSuper || !!who.managesCustomers;
  // A Supervisor's pages; null means an Administrator (or a superuser).
  const pages = Array.isArray(who.features) ? new Set(who.features) : null;

  // A named user's permissions are the whole of what they may do. There is no
  // group lookup any more: being named is decided by the server before this
  // runs, and what Genesys lets them do is read here, exactly as before.
  const permList = isSuper ? null : await fetchUserPermissions(accessToken);

  /**
   * Page-level access. An Administrator may see every page except the two
   * kinds a permission cannot express (accessConfig.js); a Supervisor only
   * the pages in their set — absent, not greyed. The permission refinement
   * below then greys what their Genesys permissions do not cover.
   * Falsy pageKey (unprotected page) → true.
   */
  function hasAccess(pageKey) {
    if (!pageKey) return true;
    // The customer Administrator's section: internal sessions have the same
    // pages under Customers, with an org selector.
    if (CUSTOMER_ADMIN_KEYS.includes(pageKey)) return false;
    if (isSuper) return true;
    if (SUPERUSER_ONLY_KEYS.includes(pageKey)) return false;
    // The two Customers pages come from the capability, never from a scope.
    if (CUSTOMER_MANAGER_KEYS.includes(pageKey)) return canManageCustomers;
    if (pages) return pages.has(pageKey);
    return true;
  }

  const refined = buildRefinedAccess({ hasAccess, permList, isSuper, sessionMode: "internal" });

  return {
    hasAccess,
    // Named, or a superuser — the server said so. A Supervisor with no pages
    // and no capability has nothing to see, and the shell says so.
    hasAnyAccess() { return !pages || pages.size > 0 || canManageCustomers; },
    ...refined,
    canManageCustomers,
    isSuperuser: isSuper,
    role: who.role || "",
    // A Supervisor's data tables (null for anyone else): the Supervisor page
    // offers only these (docs/data-table-rules-design.md §11).
    dataTables: Array.isArray(who.dataTables) ? [...who.dataTables] : null,
    // True when the permission read failed, so nothing beyond "you are named"
    // could be verified. The refinement already fails closed on every gated
    // page; this lets the shell say "could not verify" instead of showing a
    // menu of greyed pages that looks like a permissions decision.
    verificationFailed: !isSuper && permList === null,
  };
}

/**
 * Resolve access for a CUSTOMER session: the key set shapes the menu, the
 * user's own permissions refine the actions.
 *
 * The key set is what the server said this session may see: for an
 * Administrator the org's entitlements (everything — customers pay per user,
 * not for content); for a Supervisor their effective pages, ticks ∩ the org's
 * Supervisor scope, as leaf keys (docs/customer-roles-design.md §7). A page
 * outside the set is `hidden` — absent from the sidebar, exactly as an
 * internal-only page is — never greyed. What this user may DO within that is
 * refined from their own Genesys permissions by the shared builder, exactly as
 * for internal users — so a control they cannot use is greyed with the missing
 * permission named, instead of erroring after the click. Genesys still enforces
 * on every forwarded call; this layer only stops the UI lying about it.
 *
 * Exposes the same interface as resolveAccess() so nav, routing, and pages are
 * unchanged.
 *
 * @param {string[]} entitlements  Access keys or prefixes the session may see.
 * @param {string}   [accessToken] The session token. Omitted (the org-config
 *                                 fallback path) → no fetch, permissions
 *                                 unavailable, every gated action fails closed.
 * @param {string}   [apiBase]     The session's region base. A customer's token
 *                                 answers only on its own region.
 * @param {{ role?: string }} [who] The role on the caller's own row, decided
 *                                 server-side: "administrator" sees the
 *                                 Administrator section; anything else does not.
 */
export async function resolveCustomerAccess(entitlements, accessToken, apiBase, who = {}) {
  const keys = new Set((entitlements || []).filter((k) => typeof k === "string" && k.trim()));
  const isAdministrator = who.role === "administrator";

  function hasAccess(pageKey) {
    if (!pageKey) return true;
    // The Administrator's own pages are decided by the role, not the key set.
    if (CUSTOMER_ADMIN_KEYS.includes(pageKey)) return isAdministrator;
    // Internal-only features are never available in customer mode, even if an
    // entitlement prefix would otherwise grant them (belt-and-suspenders on top
    // of the server-side proxy denylist + org-lock). See docs/customer-facing-plan.md §5.
    if (isCustomerExcluded(pageKey)) return false;
    if (keys.has("*")) return true;
    const parts = pageKey.split(".");
    for (let i = parts.length - 1; i > 0; i--) {
      if (keys.has(parts.slice(0, i).join(".") + ".*")) return true;
    }
    return keys.has(pageKey);
  }

  const permList = accessToken ? await fetchUserPermissions(accessToken, apiBase) : null;
  const refined = buildRefinedAccess({ hasAccess, permList, isSuper: false, sessionMode: "customer" });

  return {
    hasAccess,
    hasAnyAccess() { return keys.size > 0 || isAdministrator; },
    ...refined,
    role: who.role || "",
    dataTables: Array.isArray(who.dataTables) ? [...who.dataTables] : null,
    isCustomerAdministrator: isAdministrator,
    verificationFailed: false,
  };
}

/**
/**
 * Access keys (or prefixes) that are INTERNAL-ONLY and must never be available in
 * customer mode — cross-org copies, trustee/all-orgs exports, the multi-org and
 * arbitrary-range billing reports, recording exports, and the internal
 * Utilities module (IP Ranges uses client-credentials; Permission Catalog is
 * internal). GDPR is intentionally NOT excluded (open decision O2).
 *
 * `phones.webrtc.delete` is deliberately NOT listed: a customer may have it if
 * their package grants it. Note the consequence — a `phones.*` entitlement
 * carries it implicitly, so a package meant to exclude bulk phone deletion has
 * to name the phone pages it does grant rather than use the wildcard.
 */

/** True if a page key is an internal-only feature excluded from customer mode. */
function isCustomerExcluded(pageKey) {
  return CUSTOMER_EXCLUDED_KEYS.some(
    (ex) => pageKey === ex || pageKey.startsWith(ex + "."),
  );
}
