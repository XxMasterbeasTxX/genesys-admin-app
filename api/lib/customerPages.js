/**
 * Every page a customer may be given, server-side.
 *
 * Generated into customerPages.json by scripts/build-customer-pages.mjs from
 * the nav tree minus CUSTOMER_EXCLUDED_KEYS, and checked for staleness in CI.
 * The Supervisor scope and a Supervisor's pages are validated against it
 * (docs/customer-roles-design.md §6): a key that is not here is dropped,
 * whoever sent it, so nothing outside what the app offers customers can be
 * stored as something a Supervisor has.
 */
const { pages } = require("./customerPages.json");

const KEYS = new Set(pages.map((p) => p.key));

function isCustomerPage(key) {
  return KEYS.has(String(key || ""));
}

/**
 * Keep the valid keys from a list, de-duplicated, sorted; report the rest.
 * @param {unknown} list
 * @returns {{ kept: string[], dropped: string[] }}
 */
function filterCustomerPages(list) {
  const kept = new Set(), dropped = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const key = String(raw || "").trim();
    if (!key) continue;
    if (KEYS.has(key)) kept.add(key); else dropped.push(key);
  }
  return { kept: [...kept].sort(), dropped };
}

module.exports = { isCustomerPage, filterCustomerPages, customerPages: pages };
