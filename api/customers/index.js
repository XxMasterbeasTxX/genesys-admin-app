const customers = require("../lib/customers.json");
const { getCallerContext } = require("../lib/callerContext");

/**
 * GET /api/customers
 *
 * Returns the list of customer orgs (metadata only — no secrets).
 * Used by the Trustee export, which is internal-only.
 *
 * INTERNAL CALLERS ONLY. Azure Static Web Apps serves /api/* anonymously
 * unless a route rule says otherwise, and staticwebapp.config.json declares
 * none — so without this check the endpoint handed anyone the id, name and
 * region of every configured customer. Those ids are the input other
 * org-scoped endpoints take, so the list is the first step of an attack
 * rather than harmless metadata. A customer session has no business
 * enumerating other customers either, hence internal rather than merely
 * authenticated.
 */
module.exports = async function (context, req) {
  const json = (status, body) => ({
    status,
    headers: { "Content-Type": "application/json" },
    body,
  });

  const caller = await getCallerContext(context, req);
  if (!caller.authorized) {
    context.res = json(caller.status || 401, { error: caller.error || "unauthorized" });
    return;
  }
  if (caller.mode === "customer") {
    context.res = json(403, { error: "internal_only" });
    return;
  }

  // Return only safe metadata (id, name, region) — never secrets
  const safeList = customers.map(({ id, name, region }) => ({
    id,
    name,
    region,
  }));

  context.res = json(200, safeList);
};
