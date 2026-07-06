/**
 * Access resolution service.
 *
 * Fetches the logged-in user's group memberships from your own Genesys org
 * (using the PKCE access token) and resolves which app features they can access.
 */
import { CONFIG } from "../config.js";
import { SUPERUSER_IDS } from "../accessConfig.js";
import { isWriteGated, getRequiredPermissions, getActionPermissions } from "../featurePermissionMap.js";

// Feature flag: when true, internal users' WRITE actions are additionally gated
// by their OWN Genesys permissions in the company org (see docs/customer-facing-plan.md
// §6). Read-only features are never affected; superusers always bypass. Set to
// false to disable the permission refinement entirely (group access only).
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
 * Fetch the authenticated user's effective Genesys permissions (company org).
 *
 * Reads BOTH `authorization.permissions` (flat strings, may include wildcards)
 * and `authorization.permissionPolicies` (domain/entityName/actionSet) from the
 * `me` endpoint and merges them — some orgs populate only one of the two. Each
 * policy is flattened to `domain:entity:action` strings (wildcards preserved).
 *
 * Returns an array of permission strings, or null if the call fails / the
 * authorization block is entirely absent (→ callers fail closed for writes).
 */
async function fetchUserPermissions(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  try {
    const resp = await fetch(`${CONFIG.apiBase}/api/v2/users/me?expand=authorization`, { headers });
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
    console.info(`[accessService] fetched ${list.length} effective permission entries`, list);
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

  const groupsFailed = groupNames === null;
  if (groupsFailed) {
    console.warn("[accessService] Could not fetch groups — granting group-level access as fallback.");
  }

  const permsAvailable = Array.isArray(permList);
  const hasPermission = (perm) => permsAvailable && permList.some((g) => permGrants(g, perm));

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
    if (isSuper || groupsFailed) return true;
    if (keys.has("*")) return true;
    const parts = pageKey.split(".");
    for (let i = parts.length - 1; i > 0; i--) {
      if (keys.has(parts.slice(0, i).join(".") + ".*")) return true;
    }
    return keys.has(pageKey);
  }

  /**
   * Refined state for a page key:
   *   "hidden"                — no group access (never show)
   *   "denied-no-permission"  — group grants it, but the user lacks the Genesys
   *                             permission for its write action(s) (show disabled)
   *   "allowed"               — usable
   * Read-only / app-storage features (not in the write map) are always "allowed"
   * when group-granted. Superusers are always "allowed".
   */
  function accessState(pageKey) {
    if (!hasAccess(pageKey)) return "hidden";
    if (isSuper) return "allowed";
    if (!ENFORCE_PERMISSION_REFINEMENT || !isWriteGated(pageKey)) return "allowed";
    const required = getRequiredPermissions(pageKey);
    if (!required.length) return "allowed";
    // Fail-closed: if we couldn't read the user's permissions, deny write features.
    if (!permsAvailable) return "denied-no-permission";
    return required.some(hasPermission) ? "allowed" : "denied-no-permission";
  }

  /** The required write permissions the user is missing for a page key. */
  function getMissingPermissions(pageKey) {
    if (isSuper || !isWriteGated(pageKey)) return [];
    const required = getRequiredPermissions(pageKey);
    if (!permsAvailable) return required;
    return required.filter((p) => !hasPermission(p));
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
    const perms = getActionPermissions(accessKey, action);
    if (!perms.length) return true;
    if (!permsAvailable) return false;
    return perms.every(hasPermission);
  }

  return {
    hasAccess,
    hasAnyAccess() { return isSuper || groupsFailed || keys.size > 0; },
    accessState,
    getMissingPermissions,
    can,
  };
}
