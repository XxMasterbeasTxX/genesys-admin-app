const REGION = "mypurecloud.de";

export const CONFIG = {
  region: REGION,
  authHost: `login.${REGION}`,
  apiBase: `https://api.${REGION}`,
  appName: "Genesys Admin Tool",

  // OAuth Client Application (Authorization Code + PKCE)
  // Shared with customer app — admin SWA URL added as redirect URI
  oauthClientId: "3b89b95c-d658-463e-9280-30a5bd7f4c2c",

  // Redirect back to whatever origin the app is served from, so the same code
  // works on both the dev and prod SWA URLs. BOTH SWA URLs must be registered
  // as Authorized redirect URIs on the OAuth client above.
  oauthRedirectUri: window.location.origin,

  // OIDC scopes — API permissions are controlled by the OAuth client roles.
  oauthScopes: ["openid", "profile", "email"],

  router: { mode: "hash" },
};
