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
  // ── Actions › Data Actions ────────────────────────────
  "/actions/dataactions/copy-between": (ctx) =>
    import("./pages/actions/dataactions/copyBetweenOrgs.js").then((m) => m.default(ctx)),
  "/actions/dataactions/edit": (ctx) =>
    import("./pages/actions/dataactions/edit.js").then((m) => m.default(ctx)),

  // ── Actions › Data Tables ─────────────────────────────
  "/actions/datatables/copy-between": (ctx) =>
    import("./pages/actions/datatables/copyBetweenOrgs.js").then((m) => m.default(ctx)),
  "/actions/datatables/copy-single": (ctx) =>
    import("./pages/actions/datatables/copySingleOrg.js").then((m) => m.default(ctx)),

  // ── Interactions ─────────────────────────────────────
  "/interactions/search": (ctx) =>
    import("./pages/actions/interactionSearch.js").then((m) => m.default(ctx)),
  "/interactions/move": (ctx) =>
    import("./pages/actions/moveInteractions.js").then((m) => m.default(ctx)),
  "/interactions/disconnect": (ctx) =>
    import("./pages/actions/disconnectInteractions.js").then((m) => m.default(ctx)),

  // ── Phones ─────────────────────────────────────────
  "/phones/webrtc/create": (ctx) =>
    import("./pages/actions/phones/createWebRtc.js").then((m) => m.default(ctx)),
};

/**
 * Look up the loader for a route.
 * Returns the loader function, or null if the route is not registered.
 */
export function getPageLoader(route) {
  return registry[route] || null;
}
