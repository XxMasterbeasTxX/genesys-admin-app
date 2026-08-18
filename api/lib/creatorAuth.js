/**
 * Is the person who scheduled a job still allowed to run it?
 *
 * A scheduled run has no user token — every runner in this app authenticates
 * with client credentials — so it cannot literally act as its creator. Storing
 * the creator's own credentials was the alternative and was rejected: an access
 * token expires long before a daily schedule matters, and a refresh token at
 * rest turns a leaked table into live access to every org anyone scheduled
 * against.
 *
 * What this does instead: at each run, look the creator up in their own org and
 * refuse if they no longer hold the permission the page requires, or are no
 * longer an active user. The job still executes with client credentials, but it
 * cannot outlive its creator's authority — checked every run, not once at
 * creation.
 *
 * ── The gap, stated plainly ──
 *
 * This only works for orgs the app holds credentials for, i.e. the customer
 * orgs in customers.json. A schedule created by an INTERNAL user has its
 * creator in the internal Genesys org, and the app has no client credentials
 * for that org — `INTERNAL_COMPANY_ORG_ID` is an identifier used for
 * classification, not a credential. Such runs report `verified: false` and the
 * caller decides what to do with that; they are not silently treated as
 * verified.
 *
 * Closing the gap usually needs no new secret. The internal org is normally
 * also one of the entries in customers.json — the onboarding runbook calls it
 * "your internal/demo org" — so credentials for it already exist under that
 * slug. Point at it with:
 *   INTERNAL_ORG_SLUG=demo        (the customers.json id of your own org)
 * and the existing GENESYS_DEMO_CLIENT_ID / _SECRET are used.
 *
 * The region comes from GENESYS_HOME_REGION, which is already configured.
 *
 * If your internal org is NOT in customers.json, set a dedicated pair instead:
 *   GENESYS_INTERNAL_CLIENT_ID / GENESYS_INTERNAL_CLIENT_SECRET
 * Either route works; nothing else changes.
 *
 * Group membership is deliberately NOT checked. App access for internal staff
 * comes from Genesys group membership (GROUP_ACCESS), but internal creators are
 * exactly the ones that cannot be looked up at all — so a group check would add
 * nothing for customers, who are gated by purchased entitlements rather than
 * groups, and would be unreachable for the people it was meant to cover.
 */
const customers = require("./customers.json");
const { getGenesysToken } = require("./genesysAuth");

const INTERNAL_OWNER = "internal";

/** Read a GENESYS_<KEY>_CLIENT_ID/_SECRET pair, or null. */
function credentialPair(key) {
  const envKey = `GENESYS_${String(key).replace(/-/g, "_").toUpperCase()}`;
  const clientId = process.env[`${envKey}_CLIENT_ID`];
  const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Credentials for an org key, or { available: false } when unconfigured.
 *
 * For the internal org, three sources are tried in order so that an existing
 * deployment needs no new secret: an explicit GENESYS_INTERNAL_* pair, then the
 * customers.json entry named by INTERNAL_ORG_SLUG (the usual case — the
 * internal org is normally also a configured org), and its region from that
 * entry or GENESYS_HOME_REGION, which is already set.
 */
function resolveOrgCredentials(orgKey) {
  if (orgKey === INTERNAL_OWNER) {
    const slug = String(process.env.INTERNAL_ORG_SLUG || "").trim();
    const pair = credentialPair(INTERNAL_OWNER) || (slug ? credentialPair(slug) : null);
    const region = process.env.GENESYS_INTERNAL_REGION
      || (slug ? customers.find((c) => c.id === slug)?.region : null)
      || process.env.GENESYS_HOME_REGION;
    if (!pair || !region) return { available: false };
    // The token cache is keyed per org, so use the slug when that is where the
    // credentials came from — otherwise an internal lookup and a job against
    // the same org would fight over one cache entry.
    return { available: true, ...pair, region, tokenKey: slug || INTERNAL_OWNER };
  }

  const pair = credentialPair(orgKey);
  const region = customers.find((c) => c.id === orgKey)?.region;
  if (!pair || !region) return { available: false };
  return { available: true, ...pair, region, tokenKey: orgKey };
}

/**
 * True if a granted permission string covers a required one.
 * Mirrors the browser's permission matching: exact, or a wildcard segment.
 */
function permissionGrants(granted, required) {
  const g = String(granted || "").trim();
  if (!g) return false;
  if (g === "*" || g === required) return true;

  const gp = g.split(":");
  const rp = String(required).split(":");
  if (gp.length !== rp.length) return false;
  return gp.every((seg, i) => seg === "*" || seg === rp[i]);
}

/** Flatten a user's authorization block into permission strings. */
function permissionsOf(user) {
  const auth = user?.authorization || {};
  const out = new Set();
  if (Array.isArray(auth.permissions)) {
    for (const p of auth.permissions) if (p) out.add(p);
  }
  if (Array.isArray(auth.permissionPolicies)) {
    for (const pol of auth.permissionPolicies) {
      const domain = pol.domain || "*";
      const entity = pol.entityName || "*";
      const actions = Array.isArray(pol.actionSet) && pol.actionSet.length ? pol.actionSet : ["*"];
      for (const a of actions) out.add(`${domain}:${entity}:${a}`);
    }
  }
  return [...out];
}

/**
 * Verify a schedule's creator.
 *
 * @param {string} orgKey   Org the creator belongs to — a customer slug, or
 *                          "internal" for staff.
 * @param {Object} opts
 * @param {string} opts.userId              Genesys user id of the creator.
 * @param {string[]} opts.requiredPermissions  Any one of these suffices.
 * @returns {Promise<{ verified: boolean, ok: boolean, reason: string }>}
 *   `verified` false means the check could not be performed at all.
 */
async function verifyCreator(orgKey, { userId, requiredPermissions = [] } = {}) {
  if (!userId) {
    return { verified: false, ok: false, reason: "the schedule does not record who created it" };
  }

  const creds = resolveOrgCredentials(orgKey);
  if (!creds.available) {
    return {
      verified: false,
      ok: false,
      reason: orgKey === INTERNAL_OWNER
        ? "the internal org has no credentials configured (set INTERNAL_ORG_SLUG), so the creator cannot be checked"
        : `no client credentials are configured for ${orgKey}`,
    };
  }

  let user;
  try {
    const token = await getGenesysToken(creds.tokenKey, creds.region, creds.clientId, creds.clientSecret);
    const url = `https://api.${creds.region}/api/v2/users/${encodeURIComponent(userId)}?expand=authorization`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (resp.status === 404) {
      return { verified: true, ok: false, reason: "the user who created this schedule no longer exists" };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { verified: false, ok: false, reason: `could not read the creator (${resp.status}) ${body.slice(0, 120)}` };
    }
    user = await resp.json();
  } catch (err) {
    return { verified: false, ok: false, reason: `could not read the creator (${err.message})` };
  }

  const state = String(user.state || "").toLowerCase();
  if (state && state !== "active") {
    return { verified: true, ok: false, reason: `the user who created this schedule is ${state}` };
  }

  if (requiredPermissions.length) {
    const held = permissionsOf(user);
    const ok = requiredPermissions.some((req) => held.some((g) => permissionGrants(g, req)));
    if (!ok) {
      return {
        verified: true,
        ok: false,
        reason: `the user who created this schedule no longer holds ${requiredPermissions.join(" or ")}`,
      };
    }
  }

  return { verified: true, ok: true, reason: "creator still authorised" };
}

module.exports = { verifyCreator, permissionGrants, permissionsOf, resolveOrgCredentials, INTERNAL_OWNER };
