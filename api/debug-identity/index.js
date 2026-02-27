/**
 * GET /api/debug-identity
 *
 * Diagnostic endpoint — tests that Key Vault reference app settings resolve.
 * DELETE THIS ENDPOINT after debugging is complete.
 */
module.exports = async function (context, req) {
  const results = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    steps: [],
  };

  // Step 1: Check which GENESYS_* env vars are set
  const customerIds = [
    "3cretail", "a-til", "demo", "dktv", "facitbank", "g4s",
    "milestone", "nemlig", "nuuday", "nuuday-test", "nykredit",
    "simcorp", "tdcnet", "test-ie", "velliv",
  ];

  const envStatus = {};
  for (const id of customerIds) {
    const envKey = `GENESYS_${id.replace(/-/g, "_").toUpperCase()}`;
    const hasId = !!process.env[`${envKey}_CLIENT_ID`];
    const hasSecret = !!process.env[`${envKey}_CLIENT_SECRET`];
    envStatus[id] = {
      clientId: hasId ? `SET (${process.env[`${envKey}_CLIENT_ID`].length} chars)` : "NOT SET",
      clientSecret: hasSecret ? `SET (${process.env[`${envKey}_CLIENT_SECRET`].length} chars)` : "NOT SET",
    };
  }
  results.steps.push({ step: "1. Credential env vars", envStatus });

  // Step 2: Try getting a Genesys token for 'demo' org
  const demoEnvKey = "GENESYS_DEMO";
  const demoClientId = process.env[`${demoEnvKey}_CLIENT_ID`];
  const demoClientSecret = process.env[`${demoEnvKey}_CLIENT_SECRET`];

  if (demoClientId && demoClientSecret) {
    try {
      const { getGenesysToken } = require("../lib/genesysAuth");
      const token = await getGenesysToken("demo", "mypurecloud.de", demoClientId, demoClientSecret);
      results.steps.push({
        step: "2. Genesys token for demo",
        success: true,
        tokenLength: token?.length || 0,
        tokenPreview: token ? token.substring(0, 8) + "****" : null,
      });

      // Step 3: Try a simple API call
      const resp = await fetch("https://api.mypurecloud.de/api/v2/organizations/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await resp.json().catch(() => ({}));
      results.steps.push({
        step: "3. Genesys API /organizations/me",
        status: resp.status,
        orgName: body.name || null,
        orgId: body.id || null,
      });
    } catch (err) {
      results.steps.push({
        step: "2. Genesys token for demo",
        success: false,
        error: err.message?.substring(0, 300),
      });
    }
  } else {
    results.steps.push({
      step: "2. Genesys token for demo",
      skipped: true,
      reason: "GENESYS_DEMO_CLIENT_ID or GENESYS_DEMO_CLIENT_SECRET not set",
    });
  }

  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: results,
  };
};
