/**
 * Access resolution service.
 *
 * Fetches the logged-in user's group memberships from your own Genesys org
 * (using the PKCE access token) and resolves which app features they can access.
 */
import { CONFIG } from "../config.js";
import { SUPERUSER_IDS } from "../accessConfig.js";
import {
  isWriteGated, getRequiredPermissions, getActionPermissions,
  isReadGated, getReadPermissions,
} from "../featurePermissionMap.js";

// Feature flag: when true, WRITE actions are additionally gated by the user's
// OWN Genesys permissions — internal users in the company org (see
// docs/customer-facing-plan.md §6), customers in theirs
// (docs/customer-permission-refinement-design.md). Read-only features are never
// affected; superusers always bypass. Set to false to disable the permission
// refinement entirely on both sides (group / entitlement access only).
const ENFORCE_PERMISSION_REFINEMENT = true;

/** Fetch the names of all groups the authenticated user belongs to. */
async function fetchUserGroupNames(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };

  // Step 1: get group IDs via expand (CORS-safe endpoint)
  let groupIds;
  try {
    const resp = await fetch(`${CONFIG.apiBase}/api/v2/users/me?expand=groups`, { headers });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error("[accessService] users/me API error:", resp.status, json);
      return null;
    }
    groupIds = (json.groups || []).map((g) => g.id).filter(Boolean);
  } catch (err) {
    console.error("[accessService] users/me fetch failed:", err);
    return null;
  }

  if (groupIds.length === 0) {
    console.info("[accessService] user belongs to no groups");
    return [];
  }

  // Step 2: resolve names in parallel by fetching each group by ID
  try {
    const results = await Promise.all(
      groupIds.map((id) =>
        fetch(`${CONFIG.apiBase}/api/v2/groups/${id}`, { headers })
          .then((r) => r.json())
          .then((g) => g.name || null)
          .catch(() => null),
      ),
    );
    const names = results.filter(Boolean);
    console.info("[accessService] user groups:", names);
    return names;
  } catch (err) {
    console.error("[accessService] group name lookup failed:", err);
    return null;
  }
}

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
 *           isSuper: boolean }} p
 */
function buildRefinedAccess({ hasAccess, permList, isSuper }) {
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
      const { mode, permissions } = getReadPermissions(pageKey, action);
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
      const { permissions } = getReadPermissions(pageKey, action);
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
      const { mode, permissions } = getReadPermissions(accessKey, action);
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
 * Resolve the user's access from their group memberships, refined by their own
 * Genesys permissions for WRITE actions (see docs/customer-facing-plan.md §6).
 *
 * @param {string} accessToken   PKCE access token (your own Genesys org).
 * @param {Object} groupAccessMap  GROUP_ACCESS from accessConfig.js.
 * @param {string} [userId]        The authenticated user's Genesys user ID.
 * @returns {Promise<{ hasAccess, hasAnyAccess, accessState, getMissingPermissions }>}
 */
export async function resolveAccess(accessToken, groupAccessMap, userId) {
  const isSuper = !!(userId && SUPERUSER_IDS.includes(userId));

  // Fetch groups and permissions in parallel.
  const [groupNames, permList] = await Promise.all([
    isSuper ? Promise.resolve([]) : fetchUserGroupNames(accessToken),
    isSuper ? Promise.resolve(null) : fetchUserPermissions(accessToken),
  ]);

  // Fail CLOSED. This used to grant every group's access when the lookup
  // failed, which handed full read access to anyone whose token could not read
  // its own groups — while the permission gate twelve lines below was already
  // explicitly fail-closed. Two halves of one function cannot disagree about
  // which way to fail. The failure is surfaced (see `verificationFailed`) so it
  // reads as "we could not check" rather than as an empty menu.
  const groupsFailed = groupNames === null;
  if (groupsFailed) {
    console.error("[accessService] Could not fetch groups — denying access until verified.");
  }

  const keys = new Set();
  for (const name of (groupNames || [])) {
    const granted = groupAccessMap[name];
    if (Array.isArray(granted)) granted.forEach((k) => keys.add(k));
  }

  /**
   * Group-level access check (unchanged semantics).
   * Checks (in order): *, section.*, section.group.*, exact key.
   * Falsy pageKey (unprotected page) → true.
   */
  function hasAccess(pageKey) {
    if (!pageKey) return true;
    if (isSuper) return true;
    if (groupsFailed) return false;
    if (keys.has("*")) return true;
    const parts = pageKey.split(".");
    for (let i = parts.length - 1; i > 0; i--) {
      if (keys.has(parts.slice(0, i).join(".") + ".*")) return true;
    }
    return keys.has(pageKey);
  }

  const refined = buildRefinedAccess({ hasAccess, permList, isSuper });

  return {
    hasAccess,
    hasAnyAccess() { return isSuper || keys.size > 0; },
    ...refined,
    // True when the group lookup failed, so nothing could be verified. Lets the
    // shell say "could not verify your access" instead of showing an empty menu
    // that looks like a permissions decision.
    verificationFailed: groupsFailed,
  };
}

/**
 * Resolve access for a CUSTOMER session: entitlements shape the menu, the
 * user's own permissions refine the actions.
 *
 * Entitlements (e.g. "interactions.*", "export.users.*") decide what the org
 * has bought and therefore what is SHOWN, through the same wildcard key
 * machinery as internal group access. What this user may DO within that is
 * refined from their own Genesys permissions by the shared builder, exactly as
 * for internal users — so a control they cannot use is greyed with the missing
 * permission named, instead of erroring after the click. Genesys still enforces
 * on every forwarded call; this layer only stops the UI lying about it.
 *
 * Exposes the same interface as resolveAccess() so nav, routing, and pages are
 * unchanged.
 *
 * @param {string[]} entitlements  Module access-key prefixes for the customer.
 * @param {string}   [accessToken] The session token. Omitted (the org-config
 *                                 fallback path) → no fetch, permissions
 *                                 unavailable, every gated action fails closed.
 * @param {string}   [apiBase]     The session's region base. A customer's token
 *                                 answers only on its own region.
 */
export async function resolveCustomerAccess(entitlements, accessToken, apiBase) {
  const keys = new Set((entitlements || []).filter((k) => typeof k === "string" && k.trim()));

  function hasAccess(pageKey) {
    if (!pageKey) return true;
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
  const refined = buildRefinedAccess({ hasAccess, permList, isSuper: false });

  return {
    hasAccess,
    hasAnyAccess() { return keys.size > 0; },
    ...refined,
    verificationFailed: false,
  };
}

/**
/**
 * Access keys (or prefixes) that are INTERNAL-ONLY and must never be available in
 * customer mode — cross-org copies, trustee/all-orgs/billing exports, recording
 * exports, and the internal Utilities module (IP Ranges uses client-credentials;
 * Permission Catalog is internal). GDPR is intentionally NOT excluded (open
 * decision O2).
 *
 * `phones.webrtc.delete` is deliberately NOT listed: a customer may have it if
 * their package grants it. Note the consequence — a `phones.*` entitlement
 * carries it implicitly, so a package meant to exclude bulk phone deletion has
 * to name the phone pages it does grant rather than use the wildcard.
 */
const CUSTOMER_EXCLUDED_KEYS = [
  "data-actions.copy.betweenOrgs",
  "data-tables.copy.betweenOrgs",
  "roles.copy.betweenOrgs",
  "export.users.trustee",
  "export.roles.allOrgs",
  "export.billing",
  "utilities",
  "deployment",
  // Flows is otherwise a customer-suitable module, so a `flows.*` entitlement
  // would hand a customer the ability to permanently delete a callflow and its
  // dependencies — irreversibly, with no rollback. Listed explicitly because the
  // wildcard would grant it silently.
  "flows.delete",
  // Recording export jobs pull the org's actual call recordings out in bulk.
  // That is customer data egress, not an interaction operation, and it arrived
  // bundled with Disconnect and Move because `interaction-ops` is the whole
  // `interactions.*` namespace — so both the package wildcard and `demo` granted
  // it silently. Same shape as `flows.delete` above: the module is otherwise
  // customer-suitable, and only the named leaf is held back.
  "interactions.recordings",
];

/** True if a page key is an internal-only feature excluded from customer mode. */
function isCustomerExcluded(pageKey) {
  return CUSTOMER_EXCLUDED_KEYS.some(
    (ex) => pageKey === ex || pageKey.startsWith(ex + "."),
  );
}
