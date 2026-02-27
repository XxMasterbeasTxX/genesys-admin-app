const REGION = "mypurecloud.de";

export const CONFIG = {
  region: REGION,
  authHost: `login.${REGION}`,
  apiBase: `https://api.${REGION}`,
  appName: "Genesys Admin Tool",

  // OAuth Client Application (Authorization Code + PKCE)
  // TODO: Replace with a new PKCE client ID for the admin app
  oauthClientId: "REPLACE_ME",

  // Must match the Azure Static Web App URL exactly
  // TODO: Replace after creating the SWA
  oauthRedirectUri: "https://REPLACE_ME.azurestaticapps.net",

  // OIDC scopes — API permissions are controlled by the OAuth client roles.
  oauthScopes: ["openid", "profile", "email"],

  router: { mode: "hash" },
};
