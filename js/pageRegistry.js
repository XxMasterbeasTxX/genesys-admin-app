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
  "/export/users/trustee": (ctx) =>
    import("./pages/export/users/trustee.js").then((m) => m.default(ctx)),

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
