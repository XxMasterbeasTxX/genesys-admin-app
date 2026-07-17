import { CONFIG } from "./config.js";
import { NAV_TREE, getFirstLeafUnder, getRouteAccessMap } from "./navConfig.js";
import { createNav } from "./nav.js";
import { Router } from "./router.js";
import { getPageLoader } from "./pageRegistry.js";
import { renderNotFoundPage } from "./pages/notfound.js";
import { renderWelcomePage } from "./pages/welcome.js";
import { renderAccessDeniedPage } from "./pages/accessdenied.js";
import { escapeHtml } from "./utils.js";
import {
  ensureAuthenticatedWithMe,
  getValidAccessToken,
  scheduleTokenRefresh,
  refreshSession,
} from "./services/authService.js";
import { createApiClient } from "./services/apiClient.js";
import { orgContext } from "./services/orgContext.js";
import { fetchOrgConfig } from "./services/orgConfigService.js";
import { GROUP_ACCESS } from "./accessConfig.js";
import { resolveAccess, resolveCustomerAccess } from "./services/accessService.js";
import { APP_VERSION } from "./releaseNotes.js";
import { renderReleaseNotesPage } from "./pages/releaseNotes.js";

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

function renderFatalError(message) {
  const outletEl = document.getElementById("appMain");
  outletEl.innerHTML = `
    <section class="card">
      <h1 class="h1">Startup error</h1>
      <p class="p">${escapeHtml(message)}</p>
    </section>
  `;
}

(async function main() {
  printSecurityNotice();
  setHeader({ authText: "Auth: starting…" });

  // --- Authenticate ---
  setHeader({ authText: "Auth: checking token / login…" });
  const res = await ensureAuthenticatedWithMe();

  if (res.status === "redirecting") {
    setHeader({ authText: "Auth: redirecting…" });
    return;
  }

  const userName = res.me?.name || "user";
  setHeader({ authText: `Auth: ok \u00B7 ${userName}` });

  const routeAccessMap = getRouteAccessMap();

  // --- API client ---
  const api = createApiClient(getValidAccessToken);

  // --- Resolve server-owned org mode/context, then access, then wire selector ---
  // Access source depends on mode: internal users are gated by group membership
  // (+ permission refinement); customers are gated by their purchased entitlements.
  const orgSelectEl = document.getElementById("orgSelect");
  let access;
  try {
    const orgCfg = await fetchOrgConfig(res.accessToken, res.orgHint);

    if (orgCfg.mode === "customer" && orgCfg.customer) {
      access = resolveCustomerAccess(orgCfg.entitlements);

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
    orgSelectEl.innerHTML = `<option value="">⚠ Failed to resolve org context</option>`;
    orgSelectEl.disabled = true;
    // Fail-closed for a customer deep link; keep internal resilience otherwise.
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

  // --- Sign-out button ---
  document.getElementById("signOutBtn").addEventListener("click", () => refreshSession());

  // --- Start router ---
  const outletEl = document.getElementById("appMain");
  const router = new Router({
    outletEl,
    resolve: async (route) => {
      // Root route — show welcome page with no preselection
      if (route === "/") return renderWelcomePage();

      // Release notes (reached from the sidebar version footer) — no access key
      if (route === "/release-notes") return renderReleaseNotesPage();

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
