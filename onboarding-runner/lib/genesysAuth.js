/**
 * Genesys Cloud OAuth2 Client Credentials token manager (copy for the runner app).
 * Caches tokens per org and refreshes before expiry.
 */
const tokenCache = new Map();
const EXPIRY_BUFFER_MS = 60 * 1000;

async function getGenesysToken(customerId, region, clientId, clientSecret) {
  const cached = tokenCache.get(customerId);
  if (cached && Date.now() < cached.expiresAt - EXPIRY_BUFFER_MS) {
    return cached.accessToken;
  }

  const resp = await fetch(`https://login.${region}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Genesys token request failed for ${customerId} (${resp.status}): ${errBody}`);
  }

  const data = await resp.json();
  tokenCache.set(customerId, {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

module.exports = { getGenesysToken };
