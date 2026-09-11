/**
 * The caller's own effective Genesys permissions, server-side.
 *
 * For a proxied call Genesys enforces the user's permissions itself, so the
 * server never needed to ask. The customer billing endpoint is the exception:
 * it reads billing AS THE TRUSTEE, so Genesys checks the trustee's permission,
 * not the user's — and the app has to check the user's here or the UI's
 * greying would be the only gate (docs/customer-billing-design.md §2.3).
 *
 * Same reading as the client's accessService.fetchUserPermissions: both
 * `authorization.permissions` (flat, may hold wildcards) and
 * `authorization.permissionPolicies` (domain/entity/actionSet) are merged,
 * because some orgs populate only one of the two.
 *
 * `fetchUserPermissions` returns null when the set cannot be read — never an
 * empty array for a failure — so a caller gating on it fails closed.
 */

/**
 * @param {string} accessToken  The caller's own token.
 * @param {string} region       The region that token is valid on.
 * @returns {Promise<string[]|null>}
 */
async function fetchUserPermissions(accessToken, region) {
  let resp, json;
  try {
    resp = await fetch(`https://api.${region}/api/v2/users/me?expand=authorization`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    json = await resp.json().catch(() => ({}));
  } catch (_) {
    return null;
  }
  if (!resp.ok) return null;

  const auth = json && json.authorization;
  if (!auth) return null;

  const perms = new Set();
  if (Array.isArray(auth.permissions)) {
    for (const p of auth.permissions) if (p) perms.add(String(p));
  }
  if (Array.isArray(auth.permissionPolicies)) {
    for (const pol of auth.permissionPolicies) {
      if (!pol || !pol.domain) continue;
      const entity  = pol.entityName || "*";
      const actions = Array.isArray(pol.actionSet) && pol.actionSet.length ? pol.actionSet : ["*"];
      for (const a of actions) perms.add(`${pol.domain}:${entity}:${a}`);
    }
  }
  if (!Array.isArray(auth.permissions) && !Array.isArray(auth.permissionPolicies)) return null;
  return [...perms];
}

/**
 * True if a granted permission string covers a required one, honouring `*`
 * segments ("routing:queue:*" grants "routing:queue:edit"). Mirrors the
 * client's permGrants exactly.
 */
function permGrants(granted, required) {
  if (granted === "*") return true;
  const g = String(granted).split(":");
  const r = String(required).split(":");
  if (g.length !== 3 || r.length !== 3) return granted === required;
  return g.every((seg, i) => seg === "*" || seg === r[i]);
}

/** True if the set holds ANY of the required permissions. */
function hasAnyPermission(permList, required) {
  if (!Array.isArray(permList)) return false;
  return required.some((req) => permList.some((g) => permGrants(g, req)));
}

module.exports = { fetchUserPermissions, permGrants, hasAnyPermission };
