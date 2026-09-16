/**
 * The caller's Genesys group names, server-side.
 *
 * Internal access used to be shaped by group membership; it is not any more
 * (docs/internal-user-access-design.md — being named in the app decides who
 * may use it, and Genesys permissions decide what they may do). The one
 * remaining caller is the All Roles export, which lists groups as data.
 *
 * Same two-step read the client's accessService makes: users/me?expand=groups
 * for the ids, then each group by id for its name. Returns null when the
 * lookup fails — never an empty list for a failure — so a caller gating on
 * it fails closed.
 */

/**
 * @param {string} accessToken
 * @param {string} region   the region the token is valid on
 * @returns {Promise<string[]|null>}
 */
async function fetchUserGroupNames(accessToken, region) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  let ids;
  try {
    const resp = await fetch(`https://api.${region}/api/v2/users/me?expand=groups`, { headers });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) return null;
    ids = (json.groups || []).map((g) => g && g.id).filter(Boolean);
  } catch (_) {
    return null;
  }
  if (ids.length === 0) return [];

  try {
    const names = await Promise.all(ids.map(async (id) => {
      const r = await fetch(`https://api.${region}/api/v2/groups/${encodeURIComponent(id)}`, { headers });
      const j = await r.json().catch(() => ({}));
      return r.ok && j.name ? String(j.name) : null;
    }));
    return names.filter(Boolean);
  } catch (_) {
    return null;
  }
}

module.exports = { fetchUserGroupNames };
