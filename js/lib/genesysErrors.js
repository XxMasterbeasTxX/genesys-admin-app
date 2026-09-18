/**
 * Genesys error sentences, turned into ones a person can act on.
 *
 * One today: the division refusal. A role in Genesys is granted per
 * division, so a user who holds a permission in one division does not hold
 * it in another, and any write that lands in a division their role does not
 * cover is refused with a sentence built for Genesys's own UI —
 *
 *   "Unable to perform the requested action. You must have at least one of
 *    the following permissions assigned: [] in at least one of the following
 *    division(s): [dbdb51ee-…]"
 *
 * — the permission list often empty, the division an id. It reaches the app
 * from any page that writes into a division: the Divisions moves, but also
 * queue and skill edits, user changes, and so on. It is rewritten in one
 * place (apiClient.proxyGenesys) so every page says the same thing; a page
 * that knows more — the Divisions template knows the permission it maps —
 * can call explainDivisionRefusal itself with that.
 */

const REFUSAL = /in at least one of the following division\(s\):\s*\[([^\]]*)\]/i;
const PERMS   = /following permissions assigned:\s*\[([^\]]*)\]/i;

/**
 * @returns {{ divisionIds: string[], permissions: string[] } | null}
 *   null when the message is not the division refusal.
 */
export function parseDivisionRefusal(message) {
  const m = REFUSAL.exec(String(message || ""));
  if (!m) return null;
  const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  const p = PERMS.exec(String(message || ""));
  return { divisionIds: list(m[1]), permissions: p ? list(p[1]) : [] };
}

/**
 * The plain-language version.
 *
 * @param {string} message                 Genesys's sentence.
 * @param {Object} [opts]
 * @param {Object<string,string>} [opts.divisionNames]  id → name, for the ids the caller can name.
 * @param {string[]} [opts.permissions]    The permission(s) the caller knows the action needs;
 *                                         used when Genesys's own list is empty.
 * @returns {string|null} null when the message is not the division refusal.
 */
export function explainDivisionRefusal(message, { divisionNames = {}, permissions = [] } = {}) {
  const parsed = parseDivisionRefusal(message);
  if (!parsed) return null;
  const names = parsed.divisionIds.map((id) => divisionNames[id] || id);
  const where = names.length ? names.join(", ") : "that";
  const perms = parsed.permissions.length ? parsed.permissions : permissions;
  const perm  = perms.length ? ` (${perms.join(" or ")})` : "";
  return `Your role does not cover the ${where} division. This action needs the permission${perm} granted in that `
    + `division, and in Genesys a role is granted per division — having it in another division is not enough. `
    + `Ask your administrator to add ${where} to the divisions of your role.`;
}
