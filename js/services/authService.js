import { CONFIG } from "../config.js";

// --- STORAGE KEYS (same as your working template) ---
const K_ACCESS_TOKEN  = "gc_access_token";
const K_EXPIRES_AT    = "gc_expires_at";     // epoch ms
const K_PKCE_VERIFIER = "pkce_verifier";
const K_OAUTH_STATE   = "oauth_state";

// Use a small skew to avoid using a token that's about to expire mid-request
const EXPIRY_SKEW_MS = 60 * 1000;

// Key for cross-tab session handoff via localStorage
const K_HANDOFF = "gc_tab_handoff";

/**
 * Save current session to localStorage so a new tab can pick it up.
 * The handoff is consumed (deleted) by the receiving tab.
 */
export function saveTabHandoff() {
  const token = sessionStorage.getItem(K_ACCESS_TOKEN);
  const expiresAt = sessionStorage.getItem(K_EXPIRES_AT);
  if (!token || !expiresAt) return;
  localStorage.setItem(K_HANDOFF, JSON.stringify({ token, expiresAt, ts: Date.now() }));
}

/**
 * If this tab has no session but a handoff exists in localStorage,
 * import it into sessionStorage and remove the handoff.
 */
function consumeTabHandoff() {
  if (sessionStorage.getItem(K_ACCESS_TOKEN)) return; // already have a session
  const raw = localStorage.getItem(K_HANDOFF);
  if (!raw) return;
  try {
    const { token, expiresAt, ts } = JSON.parse(raw);
    // Only accept handoffs less than 30 seconds old
    if (Date.now() - ts > 30_000) { localStorage.removeItem(K_HANDOFF); return; }
    sessionStorage.setItem(K_ACCESS_TOKEN, token);
    sessionStorage.setItem(K_EXPIRES_AT, expiresAt);
  } catch (_) { /* ignore corrupt data */ }
  localStorage.removeItem(K_HANDOFF);
}

// --- UTILS ---
function qp() { return new URLSearchParams(window.location.search); }

// IMPORTANT: preserve hash routing (#/dashboards) after login
function clearQueryPreserveHash() {
  history.replaceState({}, document.title, location.origin + location.pathname + location.hash);
}

function setToken(token) {
  const expiresAt = Date.now() + (Number(token.expires_in) * 1000);
  sessionStorage.setItem(K_ACCESS_TOKEN, token.access_token);
  sessionStorage.setItem(K_EXPIRES_AT, String(expiresAt));
}

export function getValidAccessToken() {
  const accessToken = sessionStorage.getItem(K_ACCESS_TOKEN);
  const expiresAtStr = sessionStorage.getItem(K_EXPIRES_AT);
  if (!accessToken || !expiresAtStr) return null;

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt)) return null;

  if (Date.now() >= (expiresAt - EXPIRY_SKEW_MS)) return null;
  return accessToken;
}

function clearAuthSession() {
  sessionStorage.removeItem(K_ACCESS_TOKEN);
  sessionStorage.removeItem(K_EXPIRES_AT);
  sessionStorage.removeItem(K_PKCE_VERIFIER);
  sessionStorage.removeItem(K_OAUTH_STATE);
}

// --- PKCE HELPERS ---
function base64UrlEncode(bytes) {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBytes(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return arr;
}

async function sha256(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash);
}

async function buildPkce() {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(await sha256(new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

// --- OAUTH + API ---
async function startLoginRedirect() {
  const clientId = CONFIG.oauthClientId;
  const redirectUri = CONFIG.oauthRedirectUri;

  if (!clientId) throw new Error("Missing CONFIG.oauthClientId");
  if (!redirectUri) throw new Error("Missing CONFIG.oauthRedirectUri");

  const { verifier, challenge } = await buildPkce();
  const state = base64UrlEncode(randomBytes(16));

  sessionStorage.setItem(K_PKCE_VERIFIER, verifier);
  sessionStorage.setItem(K_OAUTH_STATE, state);

  const authUrl =
    `https://${CONFIG.authHost}/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge_method=S256` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent((CONFIG.oauthScopes || ["openid"]).join(" "))}`;

  window.location.href = authUrl; // same-tab redirect
}

async function exchangeCodeForToken(code) {
  const clientId = CONFIG.oauthClientId;
  const redirectUri = CONFIG.oauthRedirectUri;

  const verifier = sessionStorage.getItem(K_PKCE_VERIFIER);
  if (!verifier) throw new Error("Missing pkce_verifier (session lost).");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier
  });

  const resp = await fetch(`https://${CONFIG.authHost}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Token exchange failed (${resp.status}): ${JSON.stringify(json)}`);
  return json;
}

async function usersMe(accessToken) {
  const resp = await fetch(`${CONFIG.apiBase}/api/v2/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`/users/me failed (${resp.status}): ${JSON.stringify(json)}`);
  return json;
}

/**
 * Bootstraps auth exactly like your template:
 * - If returned with code: validate state, exchange, store token, clear URL, call /users/me
 * - Else if token exists: call /users/me
 * - Else redirect to login
 *
 * Returns:
 *  { status:"authenticated", accessToken, me }
 *  { status:"redirecting" }
 */
export async function ensureAuthenticatedWithMe() {
  // Check for cross-tab session handoff
  consumeTabHandoff();

  const p = qp();

  // A) Returned with a code
  if (p.has("code")) {
    const code = p.get("code");
    const returnedState = p.get("state") || "";
    const expectedState = sessionStorage.getItem(K_OAUTH_STATE) || "";

    if (!expectedState || returnedState !== expectedState) {
      clearAuthSession();
      await startLoginRedirect();
      return { status: "redirecting" };
    }

    try {
      const token = await exchangeCodeForToken(code);
      setToken(token);
      clearQueryPreserveHash(); // avoid re-exchange on refresh

      // Clean transient
      sessionStorage.removeItem(K_PKCE_VERIFIER);
      sessionStorage.removeItem(K_OAUTH_STATE);

      const me = await usersMe(token.access_token);
      return { status: "authenticated", accessToken: token.access_token, me };
    } catch (e) {
      clearAuthSession();
      await startLoginRedirect();
      return { status: "redirecting" };
    }
  }

  // B) Reuse existing token
  const existing = getValidAccessToken();
  if (existing) {
    try {
      const me = await usersMe(existing);
      return { status: "authenticated", accessToken: existing, me };
    } catch {
      clearAuthSession();
      await startLoginRedirect();
      return { status: "redirecting" };
    }
  }

  // C) No token and no code => login
  await startLoginRedirect();
  return { status: "redirecting" };
}

/**
 * Force a new login (e.g. after token revocation or manual sign-out).
 */
export async function refreshSession() {
  clearAuthSession();
  await startLoginRedirect();
}

// --- PROACTIVE SESSION REFRESH ---
// Warning fires 2 minutes before expiry; auto-redirect fires 1 minute before.
const WARNING_BEFORE_MS = 2 * 60 * 1000;

/**
 * Schedule proactive session monitoring.
 *
 * @param {Object}   callbacks
 * @param {Function} callbacks.onExpiringSoon  Called with seconds remaining when session is about to expire.
 * @param {Function} callbacks.onSessionExpired Called when the token is no longer usable (triggers re-login).
 * @returns {Function} cleanup — call to clear all timers.
 */
export function scheduleTokenRefresh({ onExpiringSoon, onSessionExpired } = {}) {
  const expiresAtStr = sessionStorage.getItem(K_EXPIRES_AT);
  if (!expiresAtStr) return () => {};

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt)) return () => {};

  const timers = [];
  const now = Date.now();

  // Warning callback
  const warningIn = expiresAt - WARNING_BEFORE_MS - now;
  if (warningIn > 0 && onExpiringSoon) {
    timers.push(setTimeout(() => {
      const secsLeft = Math.round((expiresAt - Date.now()) / 1000);
      onExpiringSoon(secsLeft);
    }, warningIn));
  }

  // Auto-redirect when token becomes unusable (EXPIRY_SKEW_MS before actual expiry)
  const expireIn = expiresAt - EXPIRY_SKEW_MS - now;
  if (expireIn > 0) {
    timers.push(setTimeout(async () => {
      if (onSessionExpired) onSessionExpired();
      clearAuthSession();
      await startLoginRedirect();
    }, expireIn));
  }

  return () => timers.forEach(clearTimeout);
}
