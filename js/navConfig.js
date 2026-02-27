/**
 * Navigation tree definition.
 *
 * Nodes with `children` are folders (expand/collapse in the sidebar).
 * Nodes without `children` are leaves (navigate to a page).
 *
 * Set `enabled: false` on any node to hide it (and all its descendants)
 * from the sidebar and routing. Default is `true` if omitted.
 */
export const NAV_TREE = [
  {
    label: "Actions",
    path: "actions",
    enabled: true,
    children: [
      { label: "Interaction Search", path: "interaction-search", enabled: true },
    ],
  },
  {
    label: "Conversations",
    path: "conversations",
    enabled: true,
    children: [
      { label: "Move Interactions", path: "move", enabled: true },
    ],
  },
];

/** Collect all leaf routes from enabled nodes only. */
export function getLeafRoutes(nodes = NAV_TREE, parentPath = "") {
  const routes = [];
  for (const node of nodes) {
    if (node.enabled === false) continue;
    const fullPath = `${parentPath}/${node.path}`;
    if (node.children?.length) {
      routes.push(...getLeafRoutes(node.children, fullPath));
    } else {
      routes.push(fullPath);
    }
  }
  return routes;
}

/** Return the first leaf route (used as the default landing page). */
export function getDefaultRoute() {
  const leaves = getLeafRoutes();
  return leaves[0] || "/";
}

/** If `prefix` matches a folder, return its first descendent leaf route. */
export function getFirstLeafUnder(prefix) {
  return getLeafRoutes().find((r) => r.startsWith(prefix + "/")) || null;
}
