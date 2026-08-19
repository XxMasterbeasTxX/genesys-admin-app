/**
 * Shared Genesys read helpers for the export handlers.
 *
 * Nine handlers each carried their own copy of these two functions. Eight were
 * byte-identical; the ninth differed only in a default. That meant the fix for
 * the A&Til timeout — concurrent pagination — and the retry that came with it
 * landed in exactly one of the nine, leaving the same latent failure in the
 * rest: a single deep collection turning into a long chain of sequential round
 * trips, which is what pushed that export past the 45-second gateway budget.
 *
 * Two entry shapes, same core:
 *   - `genesysGet(customerId, path)` resolves the org's credentials itself and
 *     is what the handlers use.
 *   - `genesysGetWithToken(region, token, path)` takes an already-resolved
 *     token, which is how the documentation export works — it resolves once and
 *     threads the token through a hundred call sites.
 */
const customers = require("./customers.json");
const { getGenesysToken } = require("./genesysAuth");

// Transient statuses worth a second go. Every request here is an idempotent
// GET, so retrying carries no side effects. 401/403/404 will not improve by
// asking again and fail on the first attempt.
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS   = 3;

/** How many pages of one paged endpoint to fetch at once. */
const PAGE_CONCURRENCY = 5;

/** Resolve a customer's region and access token. Tokens are cached per org. */
async function resolveOrg(customerId) {
  const customer = customers.find((c) => c.id === customerId);
  if (!customer) throw new Error(`Unknown customer: ${customerId}`);

  const envKey       = `GENESYS_${customerId.replace(/-/g, "_").toUpperCase()}`;
  const clientId     = process.env[`${envKey}_CLIENT_ID`];
  const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    throw new Error(`Credentials not configured for ${customerId}`);
  }

  const token = await getGenesysToken(customerId, customer.region, clientId, clientSecret);
  return { region: customer.region, token };
}

/** GET one path with an already-resolved token, retrying transient failures. */
async function genesysGetWithToken(region, token, path) {
  const url = `https://api.${region}${path}`;

  for (let attempt = 1; ; attempt++) {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (resp.ok) return resp.json();

    const body = await resp.text().catch(() => "");
    const err  = new Error(`Genesys API ${resp.status} for ${path}`);
    err.status = resp.status;
    err.detail = body.slice(0, 200);

    if (attempt >= MAX_ATTEMPTS || !RETRY_STATUSES.has(resp.status)) throw err;

    const retryAfter = Number(resp.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 5000)
      : 250 * 2 ** (attempt - 1);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/**
 * Fetch every page of a paged endpoint with an already-resolved token.
 *
 * Page 1 is fetched first for its `pageCount`, then the remainder concurrently.
 * Walking them one at a time made the deepest single collection the critical
 * path for the whole export: 7,038 rows at 100 per page is 71 back-to-back
 * round trips. Endpoints that report no `pageCount` keep the sequential walk.
 */
async function genesysGetAllPagesWithToken(region, token, path, pageSize = 100) {
  const sep     = path.includes("?") ? "&" : "?";
  const pageUrl = (n) => `${path}${sep}pageSize=${pageSize}&pageNumber=${n}`;

  const first = await genesysGetWithToken(region, token, pageUrl(1));
  const all   = (first.entities || []).slice();

  // Short page — that was everything.
  if (all.length < pageSize) return all;

  const pageCount = Number(first.pageCount);

  if (Number.isFinite(pageCount)) {
    if (pageCount <= 1) return all;

    const rest = new Array(pageCount - 1);
    let next = 2;

    const worker = async () => {
      for (let n = next++; n <= pageCount; n = next++) {
        const resp = await genesysGetWithToken(region, token, pageUrl(n));
        rest[n - 2] = resp.entities || [];
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(PAGE_CONCURRENCY, pageCount - 1) }, worker)
    );

    // Page order preserved. Appended item by item rather than spread, which
    // throws on very large arrays.
    for (const items of rest) {
      if (!items) continue;
      for (const item of items) all.push(item);
    }
    return all;
  }

  // No pageCount reported — keep walking until a short page.
  for (let page = 2; ; page++) {
    const resp  = await genesysGetWithToken(region, token, pageUrl(page));
    const items = resp.entities || [];
    for (const item of items) all.push(item);
    if (items.length < pageSize) break;
  }
  return all;
}

/** GET one path for a customer org, resolving credentials. */
async function genesysGet(customerId, path) {
  const { region, token } = await resolveOrg(customerId);
  return genesysGetWithToken(region, token, path);
}

/** Fetch every page of a paged endpoint for a customer org. */
async function genesysGetAllPages(customerId, path, pageSize = 100) {
  const { region, token } = await resolveOrg(customerId);
  return genesysGetAllPagesWithToken(region, token, path, pageSize);
}

module.exports = {
  genesysGet,
  genesysGetAllPages,
  genesysGetWithToken,
  genesysGetAllPagesWithToken,
  resolveOrg,
  PAGE_CONCURRENCY,
};
