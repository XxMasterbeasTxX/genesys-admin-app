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

module.exports = { isSuperuser, superuserIds, isConfigured, SETTING_NAME };
