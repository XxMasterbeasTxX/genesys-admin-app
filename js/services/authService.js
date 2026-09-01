import { CONFIG } from "../config.js";
import { fetchOrgLoginConfig } from "./orgConfigService.js";

// --- STORAGE KEYS (same as your working template) ---
const K_ACCESS_TOKEN  = "gc_access_token";
const K_EXPIRES_AT    = "gc_expires_at";     // epoch ms
const K_PKCE_VERIFIER = "pkce_verifier";
const K_OAUTH_STATE   = "oauth_state";
const K_ORG_HINT      = "gc_org_hint";
// Which org this session was minted FOR ("" = internal). Not the org the token
// turned out to belong to — the server verifies that. This answers only "which
// login target produced this session", which is what the reuse check below needs.
const K_SESSION_ORG   = "gc_session_org";
// Login target chosen at redirect time (customer org or internal default). These
// keep the authorize redirect, the token exchange, and users/me consistent so a
// customer authenticates against — and is validated in — their OWN Genesys region.
const K_LOGIN_REGION    = "gc_login_region";
const K_LOGIN_CLIENT_ID = "gc_login_client_id";

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

function cacheOrgHintFromUrl() {
  const hint = (qp().get("org") || "").trim();
  if (hint) sessionStorage.setItem(K_ORG_HINT, hint);
}

export function getOrgHint() {
  const fromUrl = (qp().get("org") || "").trim();
  if (fromUrl) return fromUrl;
  return (sessionStorage.getItem(K_ORG_HINT) || "").trim() || null;
}

/**
 * The org the CURRENT URL explicitly asks for, with no fallback to the stored
 * hint — "" when the URL carries no `?org=`.
 *
 * Distinct from `getOrgHint()` on purpose. `clearQueryPreserveHash()` strips the
 * query right after login, so a legitimate customer spends almost all of their
 * time on a URL with no `?org=` and a stored hint that supplies it. A missing
 * param therefore means "this navigation expresses no opinion", NOT "internal" —
 * reading it as internal would sign every customer out on their first reload.
 */
function urlOrgParam() {
  return (qp().get("org") || "").trim();
}

// --- LOGIN TARGET (internal default vs customer org) ---
function storeLoginTarget(region, clientId) {
  sessionStorage.setItem(K_LOGIN_REGION, region);
  sessionStorage.setItem(K_LOGIN_CLIENT_ID, clientId);
}

/** Region the current session authenticated against (customer or internal default). */
function getLoginRegion() {
  return (sessionStorage.getItem(K_LOGIN_REGION) || "").trim() || CONFIG.region;
}

/** OAuth client id used for the current session (customer or internal default). */
function getLoginClientId() {
  return (sessionStorage.getItem(K_LOGIN_CLIENT_ID) || "").trim() || CONFIG.oauthClientId;
}

function authHostFor(region) { return `login.${region}`; }
function apiBaseFor(region) { return `https://api.${region}`; }

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
  // Goes with the token: a session marker outliving its session would tell the
  // next one it belongs to an org it never authenticated against.
  sessionStorage.removeItem(K_SESSION_ORG);
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
  cacheOrgHintFromUrl();

  // Choose the login target: a customer org (from the pre-login registry lookup
  // by `?org=`) or the internal default. Internal login is unchanged when there
  // is no hint or the hint doesn't resolve.
  let region = CONFIG.region;
  let clientId = CONFIG.oauthClientId;
  const hint = getOrgHint();
  if (hint) {
    try {
      const login = await fetchOrgLoginConfig(hint);
      if (login && login.clientId && login.region) {
        region = login.region;
        clientId = login.clientId;
      }
    } catch (_) { /* fall back to internal default */ }
  }
  storeLoginTarget(region, clientId);

  const redirectUri = CONFIG.oauthRedirectUri;
  if (!clientId) throw new Error("Missing OAuth client id");
  if (!redirectUri) throw new Error("Missing CONFIG.oauthRedirectUri");

  const { verifier, challenge } = await buildPkce();
  const state = base64UrlEncode(randomBytes(16));

  sessionStorage.setItem(K_PKCE_VERIFIER, verifier);
  sessionStorage.setItem(K_OAUTH_STATE, state);

  const authUrl =
    `https://${authHostFor(region)}/oauth/authorize` +
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
  const clientId = getLoginClientId();
  const redirectUri = CONFIG.oauthRedirectUri;
  const authHost = authHostFor(getLoginRegion());

  const verifier = sessionStorage.getItem(K_PKCE_VERIFIER);
  if (!verifier) throw new Error("Missing pkce_verifier (session lost).");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier
  });

  const resp = await fetch(`https://${authHost}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Token exchange failed (${resp.status}): ${JSON.stringify(json)}`);
  return json;
}

async function usersMe(accessToken) {
  const resp = await fetch(`${apiBaseFor(getLoginRegion())}/api/v2/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`/users/me failed (${resp.status}): ${JSON.stringify(json)}`);
  return json;
}

// --- POP-OUT AUTHENTICATION ---
// The app is embedded inside a Genesys Cloud iframe. Genesys is deprecating the
// ability to embed the login web application within an iframe (effective
// 2027-02-04), so we must NOT navigate the iframe to the login page. Instead we
// open a small TOP-LEVEL popup window that performs the whole PKCE flow in a
// first-party context and hands the resulting token back to the iframe via
// postMessage. Because browser storage partitioning gives the third-party iframe
// and the top-level popup separate storage buckets, we cannot share the PKCE
// verifier through sessionStorage/localStorage — the popup therefore runs the
// full flow itself and postMessage (a direct window handle) is the only reliable
// channel back to the opener.
const AUTH_POPUP_NAME = "gcLoginPopup";

/**
 * True when THIS window is the sign-in popup (opened by the iframe). Detected by
 * the presence of an opener plus our own `gcauth=start` marker or the OAuth
 * `code` returned from Genesys.
 */
export function isAuthPopup() {
  let hasOpener = false;
  try { hasOpener = !!window.opener && window.opener !== window; }
  catch (_) { hasOpener = !!window.opener; }
  if (!hasOpener) return false;
  const p = qp();
  return p.get("gcauth") === "start" || p.has("code");
}

/**
 * Controller for the popup window. On the initial `gcauth=start` load it kicks
 * off the PKCE redirect (top-level, so NOT an embedded login). When Genesys
 * redirects back with a `code`, it exchanges it and posts the token to the
 * opener, then closes itself.
 */
export async function runAuthPopup() {
  renderPopupStatus("Completing sign-in\u2026");
  const p = qp();
  try {
    if (p.get("gcauth") === "start") {
      await startLoginRedirect(); // top-level navigation of the popup to Genesys login
      return;
    }
    if (p.has("code")) {
      await completeAuthInPopup(p.get("code"), p.get("state") || "");
      return;
    }
  } catch (e) {
    notifyOpener({ ok: false, error: String((e && e.message) || e) });
    renderPopupStatus("Sign-in failed. You can close this window.");
  }
}

async function completeAuthInPopup(code, returnedState) {
  const expectedState = sessionStorage.getItem(K_OAUTH_STATE) || "";
  if (!expectedState || returnedState !== expectedState) {
    throw new Error("OAuth state mismatch");
  }
  const token = await exchangeCodeForToken(code);
  const expiresAt = Date.now() + (Number(token.expires_in) * 1000);
  sessionStorage.removeItem(K_PKCE_VERIFIER);
  sessionStorage.removeItem(K_OAUTH_STATE);
  notifyOpener({
    ok: true,
    accessToken: token.access_token,
    expiresAt,
    loginRegion: getLoginRegion(),
    loginClientId: getLoginClientId(),
    orgHint: getOrgHint(),
  });
  renderPopupStatus("Signed in. You can close this window.");
  setTimeout(() => { try { window.close(); } catch (_) { /* ignore */ } }, 150);
}

function notifyOpener(payload) {
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ __gcAuth: true, ...payload }, window.location.origin);
    }
  } catch (_) { /* opener gone — nothing to do */ }
}

function renderPopupStatus(text) {
  try {
    document.title = "Sign in";
    const host = document.body || document.documentElement;
    host.textContent = "";
    const box = document.createElement("div");
    box.style.cssText = "font:14px/1.5 system-ui,-apple-system,sans-serif;padding:2rem;color:#333";
    box.textContent = text;
    host.appendChild(box);
  } catch (_) { /* DOM not ready — ignore */ }
}

/**
 * Called from the iframe on a user gesture (Sign-in button). Opens the popup,
 * waits for the token via postMessage, and persists it into the iframe's own
 * session storage. Resolves on success; rejects with `popup-blocked`,
 * `popup-closed`, or an error message.
 */
export function loginViaPopup() {
  return new Promise((resolve, reject) => {
    cacheOrgHintFromUrl();
    const hint = getOrgHint();
    const base = window.location.origin + window.location.pathname;
    const url = base + "?gcauth=start" + (hint ? "&org=" + encodeURIComponent(hint) : "");

    const w = 500, h = 660;
    const dualLeft = (window.screenLeft != null ? window.screenLeft : window.screenX) || 0;
    const dualTop = (window.screenTop != null ? window.screenTop : window.screenY) || 0;
    const outerW = window.outerWidth || document.documentElement.clientWidth || screen.width;
    const outerH = window.outerHeight || document.documentElement.clientHeight || screen.height;
    const left = dualLeft + Math.max(0, (outerW - w) / 2);
    const top = dualTop + Math.max(0, (outerH - h) / 2);

    const popup = window.open(
      url, AUTH_POPUP_NAME,
      `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`
    );
    if (!popup) { reject(new Error("popup-blocked")); return; }
    try { popup.focus(); } catch (_) { /* ignore */ }

    let settled = false;

    const onMsg = (event) => {
      if (event.origin !== window.location.origin) return;
      const d = event.data;
      if (!d || d.__gcAuth !== true) return;
      if (event.source && event.source !== popup) return;
      finish(d);
    };

    const poll = setInterval(() => {
      if (settled) return;
      if (popup.closed) finish({ ok: false, error: "popup-closed" });
    }, 500);

    function cleanup() {
      window.removeEventListener("message", onMsg);
      clearInterval(poll);
    }

    function finish(d) {
      if (settled) return;
      settled = true;
      cleanup();
      try { if (!popup.closed) popup.close(); } catch (_) { /* ignore */ }
      if (d && d.ok) {
        sessionStorage.setItem(K_ACCESS_TOKEN, d.accessToken);
        sessionStorage.setItem(K_EXPIRES_AT, String(d.expiresAt));
        storeLoginTarget(d.loginRegion || CONFIG.region, d.loginClientId || CONFIG.oauthClientId);
        if (d.orgHint) sessionStorage.setItem(K_ORG_HINT, d.orgHint);
        resolve({ status: "authenticated" });
      } else {
        reject(new Error((d && d.error) || "auth-failed"));
      }
    }

    window.addEventListener("message", onMsg);
  });
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
  cacheOrgHintFromUrl();

  const p = qp();

  // A) Returned with a code
  if (p.has("code")) {
    const code = p.get("code");
    const returnedState = p.get("state") || "";
    const expectedState = sessionStorage.getItem(K_OAUTH_STATE) || "";

    if (!expectedState || returnedState !== expectedState) {
      clearAuthSession();
      return { status: "needs-login" };
    }

    try {
      const token = await exchangeCodeForToken(code);
      setToken(token);
      // Stamp the session with the org it was minted for, BEFORE the query is
      // stripped. On this leg the URL carries `?code=`, not `?org=` — the hint
      // survives in storage from the boot that started the login, which is why
      // getOrgHint() (with its fallback) is right here and urlOrgParam() is not.
      sessionStorage.setItem(K_SESSION_ORG, getOrgHint() || "");
      clearQueryPreserveHash(); // avoid re-exchange on refresh

      // Clean transient
      sessionStorage.removeItem(K_PKCE_VERIFIER);
      sessionStorage.removeItem(K_OAUTH_STATE);

      const me = await usersMe(token.access_token);
      return {
        status: "authenticated",
        accessToken: token.access_token,
        me,
        orgHint: getOrgHint(),
      };
    } catch (e) {
      clearAuthSession();
      return { status: "needs-login" };
    }
  }

  // B) Reuse existing token — but only if it belongs to the org being asked for.
  //
  // Without this check, opening a customer deep link in a tab that already holds
  // an INTERNAL session silently kept the internal session: the token is valid,
  // users/me answers on the stored internal region, and classifyCaller then quite
  // correctly reports "internal" because that is genuinely whose token it is. The
  // `?org=` was never consulted. Staff saw the internal app — customer list and
  // all — on a URL that asks for one locked customer.
  //
  // Only an EXPLICIT `?org=` in the URL triggers the check (see urlOrgParam), and
  // a session with no marker is a pre-existing one from before this check shipped:
  // treated as a mismatch, costing one re-login, after which it is self-healing.
  //
  // No loop guard is needed and none is used: clearAuthSession() drops the token,
  // so the next boot has nothing to reuse and lands in branch C's sign-in gate.
  // This branch cannot fire twice in a row, and every new token stamps a marker.
  const existing = getValidAccessToken();
  if (existing) {
    const requested = urlOrgParam();
    if (requested && requested !== sessionStorage.getItem(K_SESSION_ORG)) {
      // The stored hint is deliberately NOT cleared: it is the target the next
      // login must use, and it is what carries `?org=` across the redirect leg,
      // where the URL no longer has it.
      clearAuthSession();
      return { status: "needs-login" };
    }

    try {
      const me = await usersMe(existing);
      return {
        status: "authenticated",
        accessToken: existing,
        me,
        orgHint: getOrgHint(),
      };
    } catch {
      clearAuthSession();
      return { status: "needs-login" };
    }
  }

  // C) No token and no code => show the in-frame Sign-in gate (pop-out login).
  return { status: "needs-login" };
}

/**
 * Force a new login (e.g. after token revocation or manual sign-out).
 * Reloads the app in-frame (same-origin self navigation, NOT an embedded login)
 * so the boot flow presents the Sign-in gate again.
 */
export function refreshSession() {
  clearAuthSession();
  window.location.reload();
}

/**
 * Forget the stored org hint.
 *
 * `clearAuthSession` deliberately leaves this alone — a customer reloading their
 * own deep link should keep it. But when a session cannot be matched to an
 * organisation, a stale hint is one of the things most likely to be the cause,
 * and re-logging without dropping it just fails the same way a second time.
 *
 * A genuine `?org=` deep link re-seeds it from the URL on the next boot, so
 * clearing it costs a real customer nothing.
 */
export function clearOrgHint() {
  sessionStorage.removeItem(K_ORG_HINT);
}

/**
 * Everything this app remembers about who you are, gone — and back to the bare
 * origin, dropping any `?org=` the URL is carrying.
 *
 * The last resort offered to someone whose session cannot be matched to an
 * organisation. `refreshSession` keeps the current URL, which is right for a
 * transient failure and wrong when the URL itself is what is stale.
 */
export function hardResetSession() {
  clearAuthSession();
  clearOrgHint();
  window.location.replace(window.location.origin);
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
    timers.push(setTimeout(() => {
      if (onSessionExpired) onSessionExpired();
      clearAuthSession();
      window.location.reload();
    }, expireIn));
  }

  return () => timers.forEach(clearTimeout);
}
