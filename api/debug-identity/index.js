/**
 * GET /api/debug-identity
 *
 * Diagnostic endpoint — tests managed identity + Key Vault access.
 * Returns environment info and step-by-step results.
 * DELETE THIS ENDPOINT after debugging is complete.
 */
module.exports = async function (context, req) {
  const results = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    steps: [],
  };

  // Step 1: Check identity-related env vars
  const identityVars = {};
  const checkVars = [
    "IDENTITY_ENDPOINT", "IDENTITY_HEADER",
    "MSI_ENDPOINT", "MSI_SECRET",
    "AZURE_CLIENT_ID", "AZURE_TENANT_ID",
    "KEY_VAULT_NAME",
    "WEBSITE_SITE_NAME",
    "APPSETTING_WEBSITE_SITE_NAME",
  ];
  for (const v of checkVars) {
    identityVars[v] = process.env[v] ? `SET (${process.env[v].length} chars)` : "NOT SET";
  }
  results.steps.push({ step: "1. Environment variables", identityVars });

  // Step 2: Try MSI endpoint directly (if available)
  const msiEndpoint = process.env.MSI_ENDPOINT || process.env.IDENTITY_ENDPOINT;
  const msiSecret = process.env.MSI_SECRET || process.env.IDENTITY_HEADER;

  if (msiEndpoint) {
    try {
      const resource = "https://vault.azure.net";
      let url;
      let headers = {};

      if (process.env.MSI_ENDPOINT) {
        // App Service style
        url = `${process.env.MSI_ENDPOINT}?resource=${encodeURIComponent(resource)}&api-version=2017-09-01`;
        headers = { Secret: process.env.MSI_SECRET || "" };
      } else {
        // SWA / newer style
        url = `${process.env.IDENTITY_ENDPOINT}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;
        headers = { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER || "" };
      }

      results.steps.push({ step: "2a. MSI endpoint URL", url: url.substring(0, 80) + "..." });

      const resp = await fetch(url, { headers });
      const text = await resp.text();

      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }

      results.steps.push({
        step: "2b. MSI token response",
        status: resp.status,
        hasAccessToken: parsed ? !!parsed.access_token : false,
        hasExpiresOn: parsed ? !!parsed.expires_on : false,
        responseKeys: parsed ? Object.keys(parsed) : [],
        rawPreview: text.substring(0, 200),
      });
    } catch (err) {
      results.steps.push({ step: "2. MSI direct call", error: err.message });
    }
  } else {
    results.steps.push({ step: "2. MSI endpoint", note: "No MSI_ENDPOINT or IDENTITY_ENDPOINT set" });
  }

  // Step 3: Try @azure/identity credentials one by one
  try {
    const identity = require("@azure/identity");
    results.steps.push({
      step: "3a. @azure/identity version",
      version: identity.SDK_VERSION || "unknown",
      availableCredentials: Object.keys(identity).filter(k => k.includes("Credential")).sort(),
    });

    // Try ManagedIdentityCredential directly
    try {
      const mic = new identity.ManagedIdentityCredential();
      const token = await mic.getToken("https://vault.azure.net/.default");
      results.steps.push({
        step: "3b. ManagedIdentityCredential",
        success: true,
        tokenLength: token.token?.length || 0,
        expiresOnTimestamp: token.expiresOnTimestamp,
      });
    } catch (err) {
      results.steps.push({
        step: "3b. ManagedIdentityCredential",
        success: false,
        error: err.message?.substring(0, 300),
      });
    }

    // Try DefaultAzureCredential
    try {
      const dac = new identity.DefaultAzureCredential();
      const token = await dac.getToken("https://vault.azure.net/.default");
      results.steps.push({
        step: "3c. DefaultAzureCredential",
        success: true,
        tokenLength: token.token?.length || 0,
      });
    } catch (err) {
      results.steps.push({
        step: "3c. DefaultAzureCredential",
        success: false,
        error: err.message?.substring(0, 500),
      });
    }
  } catch (err) {
    results.steps.push({ step: "3. @azure/identity", error: err.message });
  }

  // Step 4: Try Key Vault access
  try {
    const vaultName = process.env.KEY_VAULT_NAME;
    if (!vaultName) {
      results.steps.push({ step: "4. Key Vault", error: "KEY_VAULT_NAME not set" });
    } else {
      const { getKeyVaultSecret } = require("../lib/keyVaultClient");
      const secret = await getKeyVaultSecret("genesys-demo-client-id");
      results.steps.push({
        step: "4. Key Vault secret read",
        success: true,
        secretLength: secret?.length || 0,
        secretPreview: secret ? secret.substring(0, 4) + "****" : null,
      });
    }
  } catch (err) {
    results.steps.push({
      step: "4. Key Vault secret read",
      success: false,
      error: err.message?.substring(0, 500),
    });
  }

  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: results,
  };
};
