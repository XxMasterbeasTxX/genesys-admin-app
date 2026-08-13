/**
 * Flow deletion — dependency graph rules. Pure, dependency-free logic.
 *
 * Extracted from the page for the same reason onboardingEngine.js is separate
 * from its processor: this is the logic that decides what may be deleted, and it
 * needs to be readable and testable on its own. A bug here does not render
 * something wrong — it removes something that was still in use.
 *
 * See docs/flow-deletion-design.md §5.
 *
 * A `graph` is:
 *   {
 *     closure:   Map<key, node>   every object reachable from the root
 *     consumers: Map<key, dep[] | null>   who uses each object; null = UNKNOWN
 *     selection: Set<key>         ticked for deletion (never includes the root)
 *     rootKey:   string           the callflow being removed
 *     rootHardBlocked: boolean    something outside the closure holds the root
 *   }
 *
 * `null` consumers mean the lookup failed. That is deliberately NOT the same as
 * an empty list: an object we could not check must never read as safe.
 */

export const keyOf = (type, id) => `${String(type || "").toUpperCase()}::${id}`;

/** The set treated as "going away": the root plus everything currently ticked. */
export function inDeleteSet(graph, key) {
  return key === graph.rootKey || graph.selection.has(key);
}

/**
 * Consumers sitting OUTSIDE the closure. Nothing the operator can tick in this
 * review will release them, so they block the object outright.
 */
export function hardBlockers(graph, key) {
  const list = graph.consumers.get(key);
  if (!list) return [];                       // null handled by isDeletable
  return list.filter((c) => !graph.closure.has(keyOf(c.type, c.id)));
}

/**
 * Consumers inside the closure that are not currently ticked. These are live but
 * releasable: ticking the consumer unlocks this object.
 */
export function softBlockers(graph, key) {
  const list = graph.consumers.get(key);
  if (!list) return [];
  return list
    .map((c) => keyOf(c.type, c.id))
    .filter((k) => graph.closure.has(k) && k !== key && !inDeleteSet(graph, k))
    .map((k) => graph.closure.get(k));
}

/**
 * The rule:  deletable(o) ⟺ consumers(o) \ (selection ∪ {root}) = ∅
 *
 * Evaluated against the CURRENT selection — orphan status is relative, not
 * absolute, which is why unticking a common module re-locks the data table only
 * that module used.
 */
export function isDeletable(graph, key) {
  const node = graph.closure.get(key);
  if (!node || node.isRoot) return false;     // the root is not optional
  if (node.noDeleteApi) return false;
  if (graph.rootHardBlocked) return false;    // §7 — a blocked root locks the tree
  if (graph.consumers.get(key) === null) return false;   // unknown ≠ safe
  return hardBlockers(graph, key).length === 0
      && softBlockers(graph, key).length === 0;
}

/**
 * Drop everything from the selection that is no longer deletable, to a fixpoint.
 *
 * One pass is not enough: unticking A can re-lock B, and unticking B can re-lock
 * C. The loop runs until nothing changes. It terminates because the selection
 * only ever shrinks.
 *
 * Mutates and returns `graph.selection`.
 */
export function settleSelection(graph) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...graph.selection]) {
      if (!isDeletable(graph, key)) {
        graph.selection.delete(key);
        changed = true;
      }
    }
  }
  return graph.selection;
}

/**
 * The largest self-consistent set of tier A objects — the default selection.
 *
 * Starts from every candidate and settles, rather than adding one at a time:
 * an object's eligibility depends on what else is selected, so the maximal
 * consistent set is what "tick everything onboarding created" actually means.
 */
export function defaultSelection(graph) {
  graph.selection = new Set(
    [...graph.closure.values()]
      .filter((n) => !n.isRoot && n.tier === "A" && !n.noDeleteApi)
      .map((n) => n.key)
  );
  settleSelection(graph);
  return graph.selection;
}
