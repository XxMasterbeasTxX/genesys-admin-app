/**
 * Maps route paths → page loaders.
 *
 * Each loader receives a context { route, me, api } and returns
 * a Promise<HTMLElement>.
 *
 * To add a new page:
 *   1. Add the node in navConfig.js
 *   2. Create a module that exports: async function render(ctx) → HTMLElement
 *   3. Add an entry below pointing to that module
 */
import { renderPlaceholder } from "./pages/placeholder.js";

const registry = {
  // ── Data Actions ──────────────────────────────────────
  "/dataactions/copy-between": (ctx) =>
    import("./pages/dataactions/copyBetweenOrgs.js").then((m) => m.default(ctx)),
  "/dataactions/edit": (ctx) =>
    import("./pages/dataactions/edit.js").then((m) => m.default(ctx)),

  // ── Data Tables ───────────────────────────────────────
  "/datatables/copy-between": (ctx) =>
    import("./pages/datatables/copyBetweenOrgs.js").then((m) => m.default(ctx)),
  "/datatables/copy-single": (ctx) =>
    import("./pages/datatables/copySingleOrg.js").then((m) => m.default(ctx)),

  // ── Interactions ─────────────────────────────────────
  "/interactions/search": (ctx) =>
    import("./pages/interactions/search.js").then((m) => m.default(ctx)),
  "/interactions/move": (ctx) =>
    import("./pages/interactions/move.js").then((m) => m.default(ctx)),
  "/interactions/disconnect": (ctx) =>
    import("./pages/interactions/disconnect.js").then((m) => m.default(ctx)),

  // ── Export ─────────────────────────────────────────
  "/export/scheduled": (ctx) =>
    import("./pages/export/scheduledExports.js").then((m) => m.default(ctx)),
  "/export/roles/all-orgs": (ctx) =>
    import("./pages/export/roles/allOrgs.js").then((m) => m.default(ctx)),
  "/export/roles/single-org": (ctx) =>
    import("./pages/export/roles/singleOrg.js").then((m) => m.default(ctx)),
  "/export/users/all-groups": (ctx) =>
    import("./pages/export/users/allGroups.js").then((m) => m.default(ctx)),
  "/export/users/all-roles": (ctx) =>
    import("./pages/export/users/allRoles.js").then((m) => m.default(ctx)),
  "/export/users/filtered-roles": (ctx) =>
    import("./pages/export/users/filteredRoles.js").then((m) => m.default(ctx)),
  "/export/users/last-login": (ctx) =>
    import("./pages/export/users/lastLogin.js").then((m) => m.default(ctx)),
  "/export/licenses/consumption": (ctx) =>
    import("./pages/export/licenses/consumption.js").then((m) => m.default(ctx)),
  "/export/users/trustee": (ctx) =>
    import("./pages/export/users/trustee.js").then((m) => m.default(ctx)),
  "/export/documentation/create": (ctx) =>
    import("./pages/export/documentation/create.js").then((m) => m.default(ctx)),

  // ── GDPR ──────────────────────────────────────────────
  "/gdpr/subject-request": (ctx) =>
    import("./pages/gdpr/subjectRequest.js").then((m) => m.default(ctx)),
  "/gdpr/request-status": (ctx) =>
    import("./pages/gdpr/requestStatus.js").then((m) => m.default(ctx)),

  // ── Phones ─────────────────────────────────────────
  "/phones/webrtc/change-site": (ctx) =>
    import("./pages/phones/webrtc/changeSite.js").then((m) => m.default(ctx)),
  "/phones/webrtc/create": (ctx) =>
    import("./pages/phones/webrtc/createWebRtc.js").then((m) => m.default(ctx)),
};

/**
 * Look up the loader for a route.
 * Returns the loader function, or null if the route is not registered.
 */
export function getPageLoader(route) {
  return registry[route] || null;
}
