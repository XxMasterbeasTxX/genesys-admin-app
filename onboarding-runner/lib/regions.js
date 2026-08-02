/**
 * Org resolution — maps an org id to its region, SDK location, and
 * client-credentials (from GENESYS_<ID>_CLIENT_ID / _SECRET app settings),
 * matching the proxy's credential convention.
 */
"use strict";

const customers = require("./customers.json");

// Genesys API region host → Flow Scripting SDK LOCATIONS id.
const REGION_TO_LOCATION = {
  "mypurecloud.com": "prod_us_east_1",
  "use2.us-gov-pure.cloud": "prod_us_east_2",
  "usw2.pure.cloud": "prod_us_west_2",
  "cac1.pure.cloud": "prod_ca_central_1",
  "mypurecloud.ie": "prod_eu_west_1",
  "euw2.pure.cloud": "prod_eu_west_2",
  "mypurecloud.de": "prod_eu_central_1",
  "euc2.pure.cloud": "prod_eu_central_2",
  "aps1.pure.cloud": "prod_ap_south_1",
  "apne2.pure.cloud": "prod_ap_northeast_2",
  "apne3.pure.cloud": "prod_ap_northeast_3",
  "mypurecloud.jp": "prod_ap_northeast_1",
  "mypurecloud.com.au": "prod_ap_southeast_2",
  "apse1.pure.cloud": "prod_ap_southeast_1",
  "sae1.pure.cloud": "prod_sa_east_1",
  "mec1.pure.cloud": "prod_me_central_1",
};

function credEnvKey(orgId) {
  return `GENESYS_${orgId.replace(/-/g, "_").toUpperCase()}`;
}

/** Resolve an org's region, SDK location, and client-credentials. Throws if missing. */
function resolveOrg(orgId) {
  const cust = customers.find((c) => c.id === orgId);
  if (!cust) throw new Error(`Unknown org '${orgId}'`);

  const envKey = credEnvKey(orgId);
  const clientId = process.env[`${envKey}_CLIENT_ID`];
  const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) throw new Error(`Credentials not configured for org '${orgId}'`);

  const location = REGION_TO_LOCATION[cust.region];
  if (!location) throw new Error(`No SDK location mapping for region '${cust.region}' (org '${orgId}')`);

  return { id: orgId, name: cust.name, region: cust.region, location, clientId, clientSecret };
}

module.exports = { resolveOrg, REGION_TO_LOCATION };
