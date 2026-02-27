const customers = require("../lib/customers.json");

/**
 * GET /api/customers
 *
 * Returns the list of customer orgs (metadata only — no secrets).
 * The frontend uses this to populate the org selector dropdown.
 */
module.exports = async function (context, req) {
  // Return only safe metadata (id, name, region) — never secrets
  const safeList = customers.map(({ id, name, region }) => ({
    id,
    name,
    region,
  }));

  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: safeList,
  };
};
