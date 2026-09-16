/**
 * The pages a customer may hold, as the tree the sidebar draws them in.
 *
 * One source for three readers: the Supervisor Access page (the scope), the
 * add/edit control on Customers › Access (a Supervisor's own pages), and
 * scripts/build-customer-pages.mjs, which writes the same leaves to
 * api/lib/customerPages.json for the server to validate against
 * (docs/customer-roles-design.md §2, §8). No browser dependencies — the
 * script imports it under Node.
 *
 * A leaf is a nav page with an access key that is not internal-only
 * (CUSTOMER_EXCLUDED_KEYS) and not one of the customer Administrator's own
 * pages (CUSTOMER_ADMIN_KEYS — an Administrator has them by role; a
 * Supervisor never does). Groups with no such leaves are dropped.
 */
import { NAV_TREE } from "../navConfig.js";
import { CUSTOMER_EXCLUDED_KEYS, CUSTOMER_ADMIN_KEYS } from "../accessConfig.js";

function excluded(key) {
  return CUSTOMER_EXCLUDED_KEYS.some((ex) => key === ex || key.startsWith(ex + "."));
}

/**
 * @typedef {{ label: string, key: string }} PageLeaf
 * @typedef {{ label: string, children: Array<PageNode> }} PageGroup
 * @typedef {PageLeaf|PageGroup} PageNode
 */

/** @returns {PageGroup[]} the sections, each with its groups and pages. */
export function customerPageTree() {
  function walk(nodes) {
    const out = [];
    for (const n of nodes) {
      if (n.enabled === false) continue;
      if (n.children?.length) {
        const children = walk(n.children);
        if (children.length) out.push({ label: n.label, children });
        continue;
      }
      if (!n.access || excluded(n.access) || CUSTOMER_ADMIN_KEYS.includes(n.access)) continue;
      out.push({ label: n.label, key: n.access });
    }
    return out;
  }
  return walk(NAV_TREE);
}

/** Every leaf under a node, in nav order. */
export function leavesOf(node) {
  if (!node.children) return [node];
  return node.children.flatMap(leavesOf);
}

/** @returns {PageLeaf[]} every page a customer may hold, in nav order. */
export function customerPageLeaves() {
  return customerPageTree().flatMap(leavesOf);
}

/**
 * The tree cut down to a set of keys — the scope's pages, in the sidebar's
 * order and grouping, for the per-Supervisor control. Groups left with no
 * pages are dropped.
 */
export function pruneTree(tree, keys) {
  const keep = new Set(keys || []);
  function prune(nodes) {
    const out = [];
    for (const n of nodes) {
      if (n.children) {
        const children = prune(n.children);
        if (children.length) out.push({ label: n.label, children });
      } else if (keep.has(n.key)) {
        out.push(n);
      }
    }
    return out;
  }
  return prune(tree);
}
