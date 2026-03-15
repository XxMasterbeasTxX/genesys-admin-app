/**
 * Access resolution service.
 *
 * Fetches the logged-in user's group memberships from your own Genesys org
 * (using the PKCE access token) and resolves which app features they can access.
 */
import { CONFIG } from "../config.js";
import { SUPERUSER_IDS } from "../accessConfig.js";

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
 * Resolve the user's access from their group memberships.
 *
 * @param {string} accessToken   PKCE access token (your own Genesys org).
 * @param {Object} groupAccessMap  GROUP_ACCESS from accessConfig.js.
 * @param {string} [userId]        The authenticated user's Genesys user ID.
 * @returns {Promise<{ hasAccess, hasAnyAccess }>}
 */
export async function resolveAccess(accessToken, groupAccessMap, userId) {
  // Superusers always get full access regardless of groups.
  if (userId && SUPERUSER_IDS.includes(userId)) {
    console.info("[accessService] superuser — full access granted");
    return { hasAccess: () => true, hasAnyAccess: () => true, grantedKeys: ["*"], _isSuperuser: true, _groupNames: [] };
  }

  const groupNames = await fetchUserGroupNames(accessToken);

  // If the groups API failed entirely, fail open (full access) so the app
  // remains usable. The browser console will show the error reason.
  if (groupNames === null) {
    console.warn("[accessService] Could not fetch groups — granting full access as fallback.");
    return {
      hasAccess: () => true,
      hasAnyAccess: () => true,
    };
  }

  const keys = new Set();

  for (const name of groupNames) {
    const granted = groupAccessMap[name];
    if (Array.isArray(granted)) granted.forEach((k) => keys.add(k));
  }

  return {
    /** Debug: the group names that were resolved for this user. */
    _groupNames: groupNames,
    /** Debug: the raw granted keys. */
    grantedKeys: [...keys],

    /**
     * Returns true if the user has access to the given page key.
     * Checks (in order): *, section.*, section.group.*, exact key.
     * If pageKey is falsy (unprotected page), always returns true.
     */
    hasAccess(pageKey) {
      if (!pageKey) return true;
      if (keys.has("*")) return true;
      // Check each wildcard prefix: e.g. for "export.roles.allOrgs"
      // checks "export.roles.*" then "export.*"
      const parts = pageKey.split(".");
      for (let i = parts.length - 1; i > 0; i--) {
        if (keys.has(parts.slice(0, i).join(".") + ".*")) return true;
      }
      return keys.has(pageKey);
    },

    /** True if the user has at least one access key. */
    hasAnyAccess() {
      return keys.size > 0;
    },
  };
}
