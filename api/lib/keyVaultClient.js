const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

let client = null;

/**
 * Lazily initializes the Key Vault SecretClient.
 * Uses DefaultAzureCredential which works with:
 *   - Managed Identity in Azure (@azure/identity v3 is SWA-compatible)
 *   - Azure CLI / VS Code credential (local dev)
 */
function getClient() {
  if (!client) {
    const vaultName = process.env.KEY_VAULT_NAME;
    if (!vaultName) {
      throw new Error("KEY_VAULT_NAME environment variable is not set");
    }
    const vaultUrl = `https://${vaultName}.vault.azure.net`;
    client = new SecretClient(vaultUrl, new DefaultAzureCredential());
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
