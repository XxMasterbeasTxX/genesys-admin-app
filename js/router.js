/**
 * Simple hash-based router.
 *
 * The `resolve` callback receives a route string and must return
 * a Promise<HTMLElement> that will be placed in the outlet.
 */
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

  async render() {
    const route = getRouteFromHash();
    const viewEl = await this.resolve(route);
    this._destroyCurrent();
    this.outletEl.replaceChildren(viewEl);
    this._current = viewEl;
    this.outletEl.focus?.();
    this.onRouteChanged?.(route);
  }
}
