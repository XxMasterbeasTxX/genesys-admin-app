/**
 * The caller's Genesys group names, server-side.
 *
 * Internal access is shaped by group membership (js/accessConfig.js
 * GROUP_ACCESS), and until now only the browser ever asked. The licence
 * endpoints ask again here: naming a user for a customer starts a charge,
 * so the endpoint checks that the verified caller is in the group the page
 * is gated on, rather than trusting that only the page would call it.
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
