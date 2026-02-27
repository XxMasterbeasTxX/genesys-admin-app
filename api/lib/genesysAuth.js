/**
 * Genesys Cloud OAuth2 Client Credentials token manager.
 *
 * Caches tokens per customer org and automatically refreshes
 * when they are about to expire.
 */

// Token cache: customerId → { accessToken, expiresAt }
const tokenCache = new Map();
const EXPIRY_BUFFER_MS = 60 * 1000; // refresh 60s before expiry

/**
 * Get a valid Genesys Cloud access token for a customer org.
 * Uses cached token if still valid, otherwise fetches a new one.
 *
 * @param {string} customerId    Customer identifier
 * @param {string} region        Genesys region (e.g. "mypurecloud.de")
 * @param {string} clientId      OAuth Client ID
 * @param {string} clientSecret  OAuth Client Secret
 * @returns {Promise<string>}    Access token
 */
async function getGenesysToken(customerId, region, clientId, clientSecret) {
  const cached = tokenCache.get(customerId);
  if (cached && Date.now() < cached.expiresAt - EXPIRY_BUFFER_MS) {
    return cached.accessToken;
  }

  const tokenUrl = `https://login.${region}/oauth/token`;

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(
      `Genesys token request failed for ${customerId} (${resp.status}): ${errBody}`
    );
  }

  const data = await resp.json();
  const accessToken = data.access_token;
  const expiresAt = Date.now() + data.expires_in * 1000;

  tokenCache.set(customerId, { accessToken, expiresAt });
  return accessToken;
}

module.exports = { getGenesysToken };
