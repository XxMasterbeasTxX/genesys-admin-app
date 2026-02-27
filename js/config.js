const REGION = "mypurecloud.de";

export const CONFIG = {
  region: REGION,
  authHost: `login.${REGION}`,
  apiBase: `https://api.${REGION}`,
  appName: "Genesys Admin Tool",

  // OAuth Client Application (Authorization Code + PKCE)
  // Shared with customer app — admin SWA URL added as redirect URI
  oauthClientId: "3b89b95c-d658-463e-9280-30a5bd7f4c2c",

  // Must match the Azure Static Web App URL exactly
  oauthRedirectUri: "https://red-wave-0cb77561e.6.azurestaticapps.net",

  // OIDC scopes — API permissions are controlled by the OAuth client roles.
  oauthScopes: ["openid", "profile", "email"],

  router: { mode: "hash" },
};
