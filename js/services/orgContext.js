/**
 * Shared state for the currently selected customer org.
 *
 * Any page or service can:
 *   - orgContext.get()           → current customer id (string | null)
 *   - orgContext.getDetails()    → full customer object { id, name, region } | null
 *   - orgContext.set(id)         → select a customer
 *   - orgContext.clear()         → deselect
 *   - orgContext.onChange(fn)    → subscribe (returns unsubscribe function)
 *   - orgContext.setCustomers([]) → populate available customers list
 *   - orgContext.setMode(m)      → "internal" | "customer", set once on boot
 *   - orgContext.isCustomer()    → true in customer mode
 */

const K_SELECTED_ORG = "gc_selected_org";
const listeners = new Set();
let customerList = []; // populated from /api/customers on boot
let sessionMode  = "internal"; // set by app.js from the server's org-config answer

function notify(orgId) {
  for (const fn of listeners) {
    try { fn(orgId); } catch (_) { /* listener error — ignore */ }
  }
}

export const orgContext = {
  /** Get the currently selected customer id, or null. */
  get() {
    return sessionStorage.getItem(K_SELECTED_ORG) || null;
  },

  /** Set the selected customer by id. Fires change listeners. */
  set(orgId) {
    if (!orgId) return this.clear();
    sessionStorage.setItem(K_SELECTED_ORG, orgId);
    notify(orgId);
  },

  /** Clear the selection. Fires change listeners with null. */
  clear() {
    sessionStorage.removeItem(K_SELECTED_ORG);
    notify(null);
  },

  /** Get full details of the currently selected customer. */
  getDetails() {
    const id = this.get();
    if (!id) return null;
    return customerList.find((c) => c.id === id) || null;
  },

  /** Get the list of all available customers. */
  getCustomers() {
    return customerList;
  },

  /**
   * The session mode the server resolved: "internal" or "customer". Set once
   * by app.js. Services that must take a different path for a customer —
   * billing reads for them as their trustee, where staff read as the trustee
   * themselves — branch on this rather than inferring it from the selection.
   */
  setMode(mode) {
    sessionMode = mode === "customer" ? "customer" : "internal";
  },

  /** True when the session is a customer's. */
  isCustomer() {
    return sessionMode === "customer";
  },

  /** Populate the available customers (called once on boot). */
  setCustomers(list) {
    customerList = list || [];
    // If the stored selection no longer exists in the list, clear it
    const id = this.get();
    if (id && !customerList.find((c) => c.id === id)) {
      this.clear();
    }
  },

  /**
   * Subscribe to org changes.
   * @param {Function} fn  Called with (orgId: string|null)
   * @returns {Function}   Unsubscribe function
   */
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
