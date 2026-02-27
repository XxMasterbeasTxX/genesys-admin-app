const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

let client = null;

// ── Manual Managed-Identity token provider for SWA managed functions ──
// The @azure/identity SDK's ManagedIdentityCredential has compatibility
// issues in the SWA managed-functions sandbox. This lightweight helper
// calls the built-in MSI token endpoint directly.

const msiTokenCache = { token: null, expiresOn: 0 };

async function getMsiToken(resource) {
  if (msiTokenCache.token && Date.now() < msiTokenCache.expiresOn - 60_000) {
    return msiTokenCache.token;
  }

  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header   = process.env.IDENTITY_HEADER;

  const url = `${endpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;
  const resp = await fetch(url, {
    headers: { "X-IDENTITY-HEADER": header },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`MSI token request failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  // SWA returns access_token + expires_on (unix seconds string)
  const accessToken = data.access_token;
  const expiresOn   = parseInt(data.expires_on, 10) * 1000 || (Date.now() + 3600_000);

  msiTokenCache.token     = accessToken;
  msiTokenCache.expiresOn = expiresOn;
  return accessToken;
}

/**
 * Creates a credential that satisfies the TokenCredential interface
 * using the raw MSI endpoint.
 */
function createSwaCredential() {
  return {
    async getToken(scopes) {
      // scopes can be a string or string[]
      const resource = (Array.isArray(scopes) ? scopes[0] : scopes)
        .replace(/\/.default$/, "");
      const token = await getMsiToken(resource);
      return { token, expiresOnTimestamp: msiTokenCache.expiresOn };
    },
  };
}

/**
 * Lazily initializes the Key Vault SecretClient.
 *
 * In Azure SWA managed functions: uses a lightweight MSI credential
 * that calls the built-in token endpoint directly (avoids SDK issues).
 *
 * Locally: falls back to DefaultAzureCredential (az login / VS Code).
 */
function getClient() {
  if (!client) {
    const vaultName = process.env.KEY_VAULT_NAME;
    if (!vaultName) {
      throw new Error("KEY_VAULT_NAME environment variable is not set");
    }
    const vaultUrl = `https://${vaultName}.vault.azure.net`;

    // SWA managed functions expose IDENTITY_ENDPOINT + IDENTITY_HEADER
    const credential = process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER
      ? createSwaCredential()
      : new DefaultAzureCredential();

    client = new SecretClient(vaultUrl, credential);
  }
  return client;
}

// Simple in-memory cache for secrets (they don't change often)
const secretCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Retrieve a secret from Azure Key Vault (with caching).
 *
 * @param {string} secretName  The name of the secret in Key Vault
 * @returns {Promise<string>}  The secret value
 */
async function getKeyVaultSecret(secretName) {
  const cached = secretCache.get(secretName);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  const kv = getClient();
  const secret = await kv.getSecret(secretName);
  const value = secret.value;

  secretCache.set(secretName, { value, ts: Date.now() });
  return value;
}

module.exports = { getKeyVaultSecret };
