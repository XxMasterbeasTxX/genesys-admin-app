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
  }

  start() {
    window.addEventListener("hashchange", this._bound);
    this.render();
  }

  stop() {
    window.removeEventListener("hashchange", this._bound);
  }

  async render() {
    const route = getRouteFromHash();
    const viewEl = await this.resolve(route);
    this.outletEl.replaceChildren(viewEl);
    this.outletEl.focus?.();
    this.onRouteChanged?.(route);
  }
}
