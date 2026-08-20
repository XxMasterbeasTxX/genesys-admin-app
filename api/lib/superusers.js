/**
 * Who may perform privileged actions — decided server-side, from a verified id.
 *
 * The app already has a `SUPERUSER_IDS` list in js/accessConfig.js. That one is
 * client-side and read only by accessService.js to decide what the sidebar
 * shows. It cannot be the authority here: it is a constant in a file the
 * browser downloads, which makes it a claim rather than proof.
 *
 * This reads the `SUPERUSER_IDS` app setting instead — a comma-separated list
 * of Genesys user ids. An app setting rather than a checked-in constant for two
 * reasons: the list gains or loses a person without a deploy, and it never
 * enters the bundle the browser downloads.
 *
 * ── Ids, not email addresses ──
 *
 * Every ownership check written before this one compares email addresses.
 * creatorAuth.js already argues against that for schedules, and the 3.6 release
 * notes record the concrete failure: Genesys releases a deleted user's address
 * for reuse. An email-keyed privilege check silently transfers to whoever
 * inherits the address. An id does not.
 *
 * ── Fails closed ──
 *
 * An unset or empty setting means NOBODY is a superuser. The alternative —
 * treating "unconfigured" as "unrestricted" — turns a missing app setting in a
 * fresh environment into a wide-open one, which is exactly when nobody is
 * looking.
 */

const SETTING_NAME = "SUPERUSER_IDS";

/** The configured ids, lowercased. Empty when unset. */
function superuserIds() {
  return String(process.env[SETTING_NAME] || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** True when the app setting names at least one superuser. */
function isConfigured() {
  return superuserIds().length > 0;
}

/**
 * May this caller perform privileged actions?
 *
 * Takes the CALLER CONTEXT, not a bare id. That is deliberate: the only id
 * allowed to decide this is the one `getCallerContext` derived from the
 * caller's own token. Accepting a string would leave the function one careless
 * call away from trusting `req.body.userId`, which is the mistake this whole
 * mechanism exists to prevent.
 *
 * @param {{ userId: string|null }} caller  From getCallerContext().
 * @returns {boolean}
 */
function isSuperuser(caller) {
  if (!caller || typeof caller !== "object") return false;

  // Null userId means identity could not be established — Genesys was
  // unreachable, or the token could not be resolved to a user. Not a superuser.
  const userId = caller.userId;
  if (!userId || typeof userId !== "string") return false;

  const ids = superuserIds();
  if (!ids.length) return false;

  return ids.includes(userId.trim().toLowerCase());
}

// ── Notification addresses ──────────────────────────────
//
// `SUPERUSER_IDS` holds ids, which is right for deciding privilege and useless
// for sending mail. Rather than add a second setting that can drift out of step
// with the first, the addresses are looked up from the ids in the internal org,
// using the client credentials creatorAuth already resolves for exactly this
// purpose. One Genesys call per id, cached for an hour — the list changes when
// somebody edits an app setting, not by the minute.

const { resolveOrgCredentials, INTERNAL_OWNER } = require("./creatorAuth");
const { getGenesysToken } = require("./genesysAuth");

const EMAIL_TTL_MS = 60 * 60 * 1000;
let _emailCache = { at: 0, emails: [] };

/**
 * Email addresses for the configured superusers.
 *
 * Never throws and never partially fails a caller: an id that cannot be
 * resolved is left out, and an empty result means "nobody to tell", which the
 * caller should treat as a reason to skip the mail rather than to fail the
 * write it was reporting.
 *
 * @param {Object} [context]  Azure Functions context, for logging.
 * @returns {Promise<string[]>}
 */
async function superuserEmails(context) {
  const ids = superuserIds();
  if (!ids.length) return [];

  if (Date.now() - _emailCache.at < EMAIL_TTL_MS) return _emailCache.emails;

  const creds = resolveOrgCredentials(INTERNAL_OWNER);
  if (!creds.available) {
    context?.log?.warn?.(
      "[superusers] no internal org credentials (set INTERNAL_ORG_SLUG) — cannot resolve notification addresses"
    );
    return [];
  }

  const emails = [];
  try {
    const token = await getGenesysToken(creds.tokenKey, creds.region, creds.clientId, creds.clientSecret);
    for (const id of ids) {
      try {
        const resp = await fetch(`https://api.${creds.region}/api/v2/users/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) continue;
        const user = await resp.json();
        if (user?.email) emails.push(String(user.email));
      } catch (_) { /* one unresolvable id must not lose the others */ }
    }
  } catch (err) {
    context?.log?.warn?.(`[superusers] could not resolve notification addresses: ${err.message}`);
    return [];
  }

  // Only cache a result that found somebody. Caching an empty list would turn a
  // momentary Genesys outage into an hour of silent notifications.
  if (emails.length) _emailCache = { at: Date.now(), emails };
  return emails;
}

module.exports = { isSuperuser, superuserIds, superuserEmails, isConfigured, SETTING_NAME };
