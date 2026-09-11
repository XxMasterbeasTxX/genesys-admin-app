/**
 * The named-user gate for customer sessions.
 *
 * `classifyCaller` answers which org a token belongs to. This answers whether
 * the person holding it has been named by Netdesign for that org
 * (docs/customer-user-licensing-design.md §4). It runs only in customer mode;
 * internal and fallback sessions never reach it.
 *
 * One function, three callers — org-config at login, getCallerContext for
 * every store endpoint, the proxy for every Genesys call — so an unnamed
 * user gets nothing, not just a blocked front door.
 *
 * Fail closed. An unreadable store or an unverifiable identity is a refusal
 * for that request, with a reason that says which. Cached per token for the
 * same window as the classification, so a removal takes effect within it.
 */
const crypto = require("crypto");
const { identifyCaller } = require("./orgConfigResolver");
const store = require("./licenseStore");

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function tokenKey(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * @param {Object} context  Azure Functions context (for logging); optional.
 * @param {string} token    The caller's Genesys token.
 * @param {Object} classification  From classifyCaller; must be mode "customer".
 * @returns {Promise<{ licensed: true, userId: string }
 *                 | { licensed: false, reason: "not_assigned"|"identity_unavailable"|"license_check_failed", userId?: string }>}
 */
async function checkLicense(context, token, classification) {
  const key = tokenKey(token);
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  if (hit) cache.delete(key);

  const customerId = classification && classification.customer && classification.customer.id;
  const region     = classification && classification.org && classification.org.region;

  const user = await identifyCaller(context, token, region);
  if (!user || !user.id) {
    // Not cached: "could not verify" is a reason to retry, not a verdict.
    return { licensed: false, reason: "identity_unavailable" };
  }

  let active;
  try {
    active = await store.isActive(customerId, user.id);
  } catch (err) {
    context?.log?.error?.(`[license] store read failed for ${customerId}: ${err.message || err}`);
    // Not cached either — a storage blip should clear with the blip.
    return { licensed: false, reason: "license_check_failed", userId: user.id };
  }

  const value = active
    ? { licensed: true, userId: user.id }
    : { licensed: false, reason: "not_assigned", userId: user.id };
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** For tests and for a future "revoke now" — forget every cached verdict. */
function clearLicenseCache() {
  cache.clear();
}

module.exports = { checkLicense, clearLicenseCache, CACHE_TTL_MS };
