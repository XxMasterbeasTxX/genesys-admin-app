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
  // ── Actions ───────────────────────────────────────────
  "/actions/overview": (ctx) =>
    import("./pages/actions/overview.js").then((m) => m.default(ctx)),
};

/**
 * Look up the loader for a route.
 * Returns the loader function, or null if the route is not registered.
 */
export function getPageLoader(route) {
  return registry[route] || null;
}
