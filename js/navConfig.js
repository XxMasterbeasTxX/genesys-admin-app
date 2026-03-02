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
    label: "Data Actions",
    path: "dataactions",
    enabled: true,
    children: [
      { label: "Copy - Between Orgs", path: "copy-between", enabled: true },
      { label: "Edit", path: "edit", enabled: true },
    ],
  },
  {
    label: "Data Tables",
    path: "datatables",
    enabled: true,
    children: [
      { label: "Copy - Between Orgs", path: "copy-between", enabled: true },
      { label: "Copy - Single Org", path: "copy-single", enabled: true },
    ],
  },
  {
    label: "Interactions",
    path: "interactions",
    enabled: true,
    children: [
      { label: "Disconnect", path: "disconnect", enabled: true },
      { label: "Search", path: "search", enabled: true },
      { label: "Move", path: "move", enabled: true },
    ],
  },
  {
    label: "Export",
    path: "export",
    enabled: true,
    children: [
      { label: "Scheduled Exports", path: "scheduled", enabled: true },
      {
        label: "Roles",
        path: "roles",
        enabled: true,
        children: [
          { label: "All Orgs", path: "all-orgs", enabled: true },
          { label: "Single Org", path: "single-org", enabled: true },
        ],
      },
      {
        label: "Licenses",
        path: "licenses",
        enabled: true,
        children: [
          { label: "Consumption", path: "consumption", enabled: true },
        ],
      },
      {
        label: "Documentation",
        path: "documentation",
        enabled: true,
        children: [
          { label: "Create", path: "create", enabled: true },
        ],
      },
      {
        label: "Users",
        path: "users",
        enabled: true,
        children: [
          { label: "All Groups", path: "all-groups", enabled: true },
          { label: "All Roles", path: "all-roles", enabled: true },
          { label: "Filtered on Role(s)", path: "filtered-roles", enabled: true },
          { label: "Last Login", path: "last-login", enabled: true },
          { label: "Trustee", path: "trustee", enabled: true },
        ],
      },
    ],
  },
  {
    label: "Phones",
    path: "phones",
    enabled: true,
    children: [
      {
        label: "WebRTC",
        path: "webrtc",
        enabled: true,
        children: [
          { label: "Change Site", path: "change-site", enabled: true },
          { label: "Create WebRTC", path: "create", enabled: true },
        ],
      },
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
