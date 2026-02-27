import { CONFIG } from "./config.js";
import { NAV_TREE, getFirstLeafUnder } from "./navConfig.js";
import { createNav } from "./nav.js";
import { Router } from "./router.js";
import { getPageLoader } from "./pageRegistry.js";
import { renderNotFoundPage } from "./pages/notfound.js";
import { renderWelcomePage } from "./pages/welcome.js";
import { escapeHtml } from "./utils.js";
import {
  ensureAuthenticatedWithMe,
  getValidAccessToken,
  scheduleTokenRefresh,
} from "./services/authService.js";
import { createApiClient } from "./services/apiClient.js";
import { orgContext } from "./services/orgContext.js";
import { fetchCustomers } from "./services/customerService.js";

function setHeader({ authText }) {
  document.getElementById("brandTitle").textContent = CONFIG.appName;
  document.getElementById("envSubtitle").textContent = CONFIG.region;
  document.getElementById("authPill").textContent = authText;
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

  // --- API client ---
  const api = createApiClient(getValidAccessToken);

  // --- Load customer list & wire org selector ---
  const orgSelectEl = document.getElementById("orgSelect");
  try {
    const customers = await fetchCustomers();
    orgContext.setCustomers(customers);

    orgSelectEl.innerHTML = `<option value="">Select customer…</option>`
      + customers.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.region)})</option>`).join("");
    orgSelectEl.disabled = false;

    // Always start fresh — no auto-selected org
    orgContext.clear();
  } catch (err) {
    console.error("Failed to load customers:", err);
    orgSelectEl.innerHTML = `<option value="">⚠ Failed to load customers</option>`;
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
  const nav = createNav(navEl, NAV_TREE);

  // --- Start router ---
  const outletEl = document.getElementById("appMain");
  const router = new Router({
    outletEl,
    resolve: async (route) => {
      // Root route — show welcome page with no preselection
      if (route === "/") return renderWelcomePage();

      const loader = getPageLoader(route);
      if (loader) return loader({ route, me: res.me, api, orgContext });

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
