/**
 * Simple hash-based router.
 *
 * The `resolve` callback receives a route string and must return
 * a Promise<HTMLElement> that will be placed in the outlet.
 */
import { spinPanel } from "./utils.js";

/** How long a navigation may take before it earns a throbber. */
const PENDING_DELAY_MS = 150;

function getRouteFromHash() {
  const hash = window.location.hash || "";
  const route = hash.startsWith("#") ? hash.slice(1) : hash;
  return route || "/";
}

export class Router {
  /**
   * @param {Object}   opts
   * @param {Element}  opts.outletEl         Target container element.
   * @param {Function} opts.resolve          (route: string) => Promise<HTMLElement>
   * @param {Function} [opts.onRouteChanged] Called after each render with the current route.
   */
  constructor({ outletEl, resolve, onRouteChanged }) {
    this.outletEl = outletEl;
    this.resolve = resolve;
    this.onRouteChanged = onRouteChanged;
    this._bound = () => this.render();
    this._current = null;
  }

  start() {
    window.addEventListener("hashchange", this._bound);
    this.render();
  }

  stop() {
    window.removeEventListener("hashchange", this._bound);
    this._destroyCurrent();
  }

  /**
   * Tear down the outgoing view.
   *
   * A page that registers anything outside its own subtree — a `document`
   * listener, an orgContext subscription, a timer — must set `el.__destroy`
   * to a function that undoes it. Without this the element is simply dropped by
   * `replaceChildren` and those registrations leak, holding on to whatever their
   * closures captured (which, for the export pages, means a full table of rows).
   *
   * Errors are contained: a broken teardown must not stop the next page rendering.
   */
  _destroyCurrent() {
    const prev = this._current;
    this._current = null;
    if (!prev) return;
    try {
      prev.__destroy?.();
    } catch (err) {
      console.warn("[router] view teardown failed:", err?.message || err);
    }
  }

  /**
   * Resolving a route means a dynamic `import()` of the page module (87 of them
   * in pageRegistry) and, for a few pages, a fetch before the element exists.
   * Until this landed the outgoing page simply sat there, inert, for however
   * long that took.
   *
   * The throbber waits {@link PENDING_DELAY_MS} first. A cached module resolves
   * in a couple of milliseconds, and a throbber that blinks on every navigation
   * is noise that teaches people to stop looking at throbbers — which would
   * cost the ones that matter their meaning.
   */
  async render() {
    const route = getRouteFromHash();

    let settled = false;
    const pending = setTimeout(() => {
      if (!settled) this.outletEl.replaceChildren(spinPanel("Loading…"));
    }, PENDING_DELAY_MS);

    let viewEl;
    try {
      viewEl = await this.resolve(route);
    } finally {
      settled = true;
      clearTimeout(pending);
    }

    this._destroyCurrent();
    this.outletEl.replaceChildren(viewEl);
    this._current = viewEl;
    this.outletEl.focus?.();
    this.onRouteChanged?.(route);
  }
}
