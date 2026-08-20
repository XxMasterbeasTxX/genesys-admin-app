import { CONFIG } from "./config.js";
import { NAV_TREE, getFirstLeafUnder, getRouteAccessMap, getRouteLabelMap } from "./navConfig.js";
import { createNav } from "./nav.js";
import { Router } from "./router.js";
import { getPageLoader } from "./pageRegistry.js";
import { renderNotFoundPage } from "./pages/notfound.js";
import { renderWelcomePage } from "./pages/welcome.js";
import { renderAccessDeniedPage } from "./pages/accessdenied.js";
import { escapeHtml, spinPanel } from "./utils.js";
import {
  ensureAuthenticatedWithMe,
  getValidAccessToken,
  scheduleTokenRefresh,
  refreshSession,
  clearOrgHint,
  hardResetSession,
  isAuthPopup,
  runAuthPopup,
  loginViaPopup,
} from "./services/authService.js";
import { createApiClient } from "./services/apiClient.js";
import { orgContext } from "./services/orgContext.js";
import { fetchOrgConfig } from "./services/orgConfigService.js";
import { GROUP_ACCESS } from "./accessConfig.js";
import { resolveAccess, resolveCustomerAccess } from "./services/accessService.js";
import { APP_VERSION } from "./releaseNotes.js";
import { renderReleaseNotesPage } from "./pages/releaseNotes.js";
import renderRequests, { CONTEXT_KEY as REQUEST_CONTEXT_KEY } from "./pages/requests.js";

function setHeader({ authText }) {
  document.getElementById("brandTitle").textContent = CONFIG.appName;
  document.getElementById("envSubtitle").textContent = CONFIG.region;
  document.getElementById("authPill").textContent = authText;
}

/**
 * Console self-XSS warning + proprietary notice. Printed once on boot. The
 * self-XSS message deters social-engineering attacks where a user is tricked
 * into pasting code into DevTools (this app forwards a live Genesys session).
 */
function printSecurityNotice() {
  try {
    console.log(
      "%cStop!",
      "color:#c00;font-size:32px;font-weight:bold;",
    );
    console.log(
      "%cThis is a browser feature intended for developers. If someone told you to " +
        "copy and paste something here to enable a feature or “fix” something, it is a " +
        "scam and will give them access to your account and data. Do not paste anything here.",
      "font-size:14px;",
    );
    console.log(
      "%c© 2026 TDC Erhverv. Proprietary and confidential — unauthorized copying or reuse is prohibited.",
      "color:#666;font-size:12px;",
    );
  } catch (_) { /* console not available — ignore */ }
}

/** Guard so the automatic re-login below fires once, not in a loop. */
const ORGCFG_RETRY_KEY = "gc_orgcfg_retry";

/**
 * Shown when a session authenticates but cannot be matched to an organisation,
 * and the one automatic retry has already been spent.
 *
 * Before this, that state left a disabled "Failed to resolve org context"
 * dropdown, an empty menu, and nothing else — unrecoverable from inside the app,
 * with the only real fix being to clear browser storage, which nobody would
 * guess. It earns a screen of its own because the app genuinely cannot be used
 * until it is resolved.
 */
function renderOrgRecovery() {
  setHeader({ authText: "Auth: organisation not matched" });
  const orgSelectEl = document.getElementById("orgSelect");
  orgSelectEl.innerHTML = `<option value="">Not signed in to an organisation</option>`;
  orgSelectEl.disabled = true;

  document.getElementById("appMain").innerHTML = `
    <section class="card">
      <h1 class="h1">We could not match your sign-in to an organisation</h1>
      <p class="p">
        You signed in successfully, but this environment did not recognise the
        organisation the sign-in belongs to. That is almost always a session left
        over from an earlier sign-in — signing in again clears it.
      </p>
      <button type="button" class="btn" id="orgResetBtn">Sign in again</button>
      <p class="p" style="margin-top:12px;opacity:0.8;">
        If it happens again straight away, your account may not belong to an
        organisation this environment is set up for — worth sending to an
        administrator rather than retrying.
      </p>
    </section>
  `;

  document.getElementById("orgResetBtn").addEventListener("click", () => {
    // Everything stale goes at once: the token, the org hint, the selected
    // customer and the retry guard — leaving the guard set would disarm the
    // next boot before it starts.
    sessionStorage.removeItem(ORGCFG_RETRY_KEY);
    try { orgContext.clear(); } catch (_) { /* storage unavailable */ }
    hardResetSession();
  });
}

function renderFatalError(message) {
  const outletEl = document.getElementById("appMain");
  outletEl.innerHTML = `
    <section class="card">
      <h1 class="h1">Startup error</h1>
      <p class="p">${escapeHtml(message)}</p>
    </section>
  `;
}

/**
 * Sign-in gate shown when there is no valid session. A user gesture is required
 * because the pop-out login window (window.open) is blocked by browsers unless
 * triggered by a click. On success the app reloads in-frame with the token in
 * place; the boot flow then proceeds normally.
 */
function renderSignInGate() {
  setHeader({ authText: "Auth: sign in required" });
  const outletEl = document.getElementById("appMain");
  outletEl.innerHTML = `
    <section class="card">
      <h1 class="h1">Sign in</h1>
      <p class="p">Sign in with your Genesys Cloud account to continue.</p>
      <button type="button" class="btn" id="signInBtn">Sign in with Genesys</button>
      <p class="p" id="signInHint" style="margin-top:12px;opacity:0.8;"></p>
    </section>
  `;
  const btn = document.getElementById("signInBtn");
  const hint = document.getElementById("signInHint");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    hint.textContent = "Opening sign-in window…";
    try {
      await loginViaPopup();
      hint.textContent = "Signed in. Loading…";
      window.location.reload();
    } catch (e) {
      btn.disabled = false;
      const msg = (e && e.message) || "unknown error";
      if (msg === "popup-blocked") {
        hint.textContent = "Your browser blocked the sign-in window. Please allow pop-ups for this app, then click Sign in again.";
      } else if (msg === "popup-closed") {
        hint.textContent = "The sign-in window was closed before completing. Click Sign in to try again.";
      } else {
        hint.textContent = "Sign-in failed: " + msg + ". Click Sign in to try again.";
      }
    }
  });
}

(async function main() {
  // If this window is the OAuth sign-in popup, run the popup controller and stop
  // before booting the full app shell.
  if (isAuthPopup()) {
    await runAuthPopup();
    return;
  }

  printSecurityNotice();
  setHeader({ authText: "Auth: starting…" });

  // Boot runs authentication and then /api/org-config before the nav or any
  // page exists. That used to be a blank screen with only the header pill
  // moving; a throbber says the app is working rather than broken.
  const $main = document.getElementById("appMain");
  $main.replaceChildren(spinPanel("Signing you in…"));

  // --- Authenticate ---
  setHeader({ authText: "Auth: checking token / login…" });
  const res = await ensureAuthenticatedWithMe();

  if (res.status === "redirecting") {
    setHeader({ authText: "Auth: redirecting…" });
    return;
  }

  if (res.status === "needs-login") {
    renderSignInGate();
    return;
  }

  const userName = res.me?.name || "user";
  setHeader({ authText: `Auth: ok \u00B7 ${userName}` });

  $main.replaceChildren(spinPanel("Loading your organisations…"));

  const routeAccessMap = getRouteAccessMap();

  // --- API client ---
  const api = createApiClient(getValidAccessToken);

  // --- Resolve server-owned org mode/context, then access, then wire selector ---
  // Access source depends on mode: internal users are gated by group membership
  // (+ permission refinement); customers are gated by their purchased entitlements.
  const orgSelectEl = document.getElementById("orgSelect");
  let access;
  let isInternalMode = true; // staff vs customer — gates internal-only release notes
  try {
    const orgCfg = await fetchOrgConfig(res.accessToken, res.orgHint);
    // Org context resolved — clear any prior self-heal guard.
    sessionStorage.removeItem(ORGCFG_RETRY_KEY);

    if (orgCfg.mode === "customer" && orgCfg.customer) {
      access = resolveCustomerAccess(orgCfg.entitlements);
      isInternalMode = false;

      const customer = orgCfg.customer;
      orgContext.setCustomers([customer]);

      orgSelectEl.innerHTML =
        `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)} (${escapeHtml(customer.region)})</option>`;
      orgSelectEl.value = customer.id;
      orgSelectEl.disabled = true;
      orgContext.set(customer.id);
    } else {
      access = await resolveAccess(res.accessToken, GROUP_ACCESS, res.me?.id);

      const customers = Array.isArray(orgCfg.customers) ? orgCfg.customers : [];
      orgContext.setCustomers(customers);

      orgSelectEl.innerHTML = `<option value="">Select customer…</option>`
        + customers.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.region)})</option>`).join("");
      orgSelectEl.disabled = false;

      // Always start fresh in internal mode — no auto-selected org.
      orgContext.clear();
    }
  } catch (err) {
    console.error("Failed to resolve org config:", err);

    // Self-heal a stale/invalid session — a leftover token, or an org hint that
    // no longer resolves (401/403). Clear it and re-login ONCE, guarded against
    // a loop.
    //
    // A customer deep link no longer skips this. It used to, to avoid looping,
    // but the guard already prevents that — and a stale hint is among the most
    // likely causes, so exempting it meant the one case that needed clearing was
    // the one case never cleared. The STORED hint is dropped with the session; a
    // genuine `?org=` deep link re-seeds it from the URL on the way back, so a
    // real customer loses nothing.
    const status = err && err.status;
    const authish = status === 401 || status === 403;
    if (authish && !sessionStorage.getItem(ORGCFG_RETRY_KEY)) {
      sessionStorage.setItem(ORGCFG_RETRY_KEY, "1");
      setHeader({ authText: "Auth: refreshing session\u2026" });
      clearOrgHint();
      await refreshSession(); // clears session + reloads into login
      return;
    }

    // The retry is spent and it still fails. Rather than leave a dead dropdown
    // and an empty menu with no way out, say what happened and offer the one
    // action that fixes it.
    if (authish) {
      renderOrgRecovery();
      return;
    }

    orgSelectEl.innerHTML = `<option value="">⚠ Failed to resolve org context</option>`;
    orgSelectEl.disabled = true;
    // Fail-closed for a customer deep link; keep internal resilience otherwise.
    isInternalMode = !res.orgHint;
    access = res.orgHint
      ? resolveCustomerAccess([])
      : await resolveAccess(res.accessToken, GROUP_ACCESS, res.me?.id);
  }

  orgSelectEl.addEventListener("change", () => {
    orgContext.set(orgSelectEl.value || null);
  });

  // --- Session monitoring ---
  scheduleTokenRefresh({
    onExpiringSoon: (secsLeft) => {
      setHeader({
        authText: `Auth: ok \u00B7 ${userName} \u00B7 session expires in ${secsLeft}s`,
      });
    },
    onSessionExpired: () => {
      setHeader({ authText: "Auth: session expired \u2014 redirecting\u2026" });
    },
  });

  // --- Build navigation ---
  const navEl = document.getElementById("appNav");
  const nav = createNav(navEl, NAV_TREE, access);

  // --- Version footer (bottom of the sidebar) ---
  const versionEl = document.createElement("button");
  versionEl.type = "button";
  versionEl.className = "nav-version";
  versionEl.textContent = `v${APP_VERSION}`;
  versionEl.title = "View release notes";
  versionEl.addEventListener("click", () => {
    window.location.hash = "#/release-notes";
  });
  navEl.append(versionEl);

  // --- Copyright footer (bottom of the sidebar) ---
  const copyrightEl = document.createElement("div");
  copyrightEl.className = "nav-copyright";
  copyrightEl.textContent = "© 2026 TDC Erhverv";
  copyrightEl.title = "Proprietary and confidential";
  navEl.append(copyrightEl);

  // --- Requests button: remember the page it was pressed from ---
  //
  // The route IS the hash (see router.js), so "#/requests?from=..." would be a
  // route the registry does not know. Stashing it instead needs no router
  // change, and it is what lets a request arrive already naming the page it is
  // about instead of costing a round trip to find out.
  const routeLabelMap = getRouteLabelMap();
  document.getElementById("requestsBtn").addEventListener("click", () => {
    const from = (window.location.hash || "").replace(/^#/, "");
    const label = routeLabelMap[from];
    try {
      if (label) {
        sessionStorage.setItem(REQUEST_CONTEXT_KEY, JSON.stringify({ route: from, pageLabel: label }));
      } else {
        // Pressed from the welcome page, the release notes or the board itself
        // — there is no page to name, so do not carry a stale one over.
        sessionStorage.removeItem(REQUEST_CONTEXT_KEY);
      }
    } catch (_) { /* storage unavailable — the form simply asks nothing */ }
  });

  // --- Sign-out button ---
  document.getElementById("signOutBtn").addEventListener("click", () => refreshSession());

  // --- Start router ---
  const outletEl = $main;
  const router = new Router({
    outletEl,
    resolve: async (route) => {
      // Root route — show welcome page with no preselection
      if (route === "/") return renderWelcomePage();

      // Release notes (reached from the sidebar version footer) — no access key
      if (route === "/release-notes") return renderReleaseNotesPage(isInternalMode);

      // Requests board — no access key either, and like the release notes it
      // needs to know whether the viewer is staff, so a shipped request does not
      // link a customer to an internal-only note.
      if (route === "/requests") {
        return renderRequests({ me: res.me, orgContext, isInternal: isInternalMode });
      }

      const loader = getPageLoader(route);
      if (loader) {
        const accessKey = routeAccessMap[route];
        const state = accessKey ? access.accessState(accessKey) : "allowed";
        if (state === "hidden") {
          return renderAccessDeniedPage();
        }
        if (state === "denied-no-permission") {
          return renderAccessDeniedPage({ missing: access.getMissingPermissions(accessKey) });
        }
        return loader({ route, me: res.me, api, orgContext, access });
      }

      // Folder prefix? Redirect to its first leaf.
      const firstLeaf = getFirstLeafUnder(route);
      if (firstLeaf) {
        window.location.hash = `#${firstLeaf}`;
        return document.createElement("div");
      }

      return renderNotFoundPage({ route });
    },
    onRouteChanged: (route) => nav.updateActive(route),
  });

  // Re-render current page when customer org changes
  orgContext.onChange(() => router.render());

  // Always start at the welcome page — clear any leftover hash
  if (window.location.hash) {
    history.replaceState(null, "", window.location.pathname);
  }

  router.start();
})().catch((err) => {
  setHeader({ authText: "Auth: failed" });
  renderFatalError(err?.message || String(err));
});
