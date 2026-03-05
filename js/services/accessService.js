/**
 * Access resolution service.
 *
 * Fetches the logged-in user's group memberships from your own Genesys org
 * (using the PKCE access token) and resolves which app features they can access.
 */
import { CONFIG } from "../config.js";

/** Fetch the names of all groups the authenticated user belongs to. */
async function fetchUserGroupNames(accessToken) {
  try {
    const resp = await fetch(
      `${CONFIG.apiBase}/api/v2/users/me/groups?pageSize=500`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error("[accessService] groups API error:", resp.status, json);
      return null; // signal failure
    }
    const names = (json.entities || []).map((g) => g.name).filter(Boolean);
    console.info("[accessService] user groups:", names);
    return names;
  } catch (err) {
    console.error("[accessService] groups fetch failed:", err);
    return null; // signal failure
  }
}

/**
 * Resolve the user's access from their group memberships.
 *
 * @param {string} accessToken   PKCE access token (your own Genesys org).
 * @param {Object} groupAccessMap  GROUP_ACCESS from accessConfig.js.
 * @returns {Promise<{ hasAccess, hasAnyAccess }>}
 */
export async function resolveAccess(accessToken, groupAccessMap) {
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
