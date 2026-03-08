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
      { label: "Copy - Between Orgs", path: "copy-between", enabled: true, access: "data-actions.copy.betweenOrgs" },
      { label: "Edit", path: "edit", enabled: true, access: "data-actions.edit" },
    ],
  },
  {
    label: "Data Tables",
    path: "datatables",
    enabled: true,
    children: [
      { label: "Create",             path: "create",       enabled: true, access: "data-tables.create"           },
      { label: "Copy - Between Orgs", path: "copy-between", enabled: true, access: "data-tables.copy.betweenOrgs" },
      { label: "Copy - Single Org",   path: "copy-single",  enabled: true, access: "data-tables.copy.singleOrg"  },
    ],
  },
  {
    label: "Divisions",
    path: "divisions",
    enabled: true,
    children: [
      // ── People ────────────────────────────────────────
      {
        label: "People",
        path: "people",
        enabled: true,
        children: [
          { label: "Users", path: "users", enabled: true, access: "divisions.people.users" },
          { label: "Work Teams", path: "team",  enabled: true, access: "divisions.people.team"  },
        ],
      },
      // ── Routing ───────────────────────────────────────
      {
        label: "Routing",
        path: "routing",
        enabled: true,
        children: [
          { label: "Queues",                  path: "queues",                  enabled: true, access: "divisions.routing.queues"                  },
          { label: "Call Routes",              path: "callroute",               enabled: true, access: "divisions.routing.callroute"               },
          { label: "Emergency Groups",        path: "emergency-groups",        enabled: true, access: "divisions.routing.emergencyGroups"         },
          { label: "Extension Pools",          path: "extension-pool",          enabled: true, access: "divisions.routing.extensionPool"           },
          { label: "Routing Schedules",       path: "routing-schedules",       enabled: true, access: "divisions.routing.routingSchedules"        },
          { label: "Routing Schedule Groups",  path: "routing-schedule-groups", enabled: true, access: "divisions.routing.routingScheduleGroups"   },
          { label: "Skill Groups",             path: "skill-group",             enabled: true, access: "divisions.routing.skillGroup"              },
        ],
      },
      // ── Architect ─────────────────────────────────────
      {
        label: "Architect",
        path: "architect",
        enabled: true,
        children: [
          { label: "Flows",          path: "flow",           enabled: true, access: "divisions.architect.flow"          },
          { label: "Milestones", path: "flow-milestone", enabled: true, access: "divisions.architect.flowMilestone" },
          { label: "Flow Outcomes",   path: "flow-outcome",   enabled: true, access: "divisions.architect.flowOutcome"   },
          { label: "Scripts",        path: "script",         enabled: true, access: "divisions.architect.script"        },
          { label: "Data Tables",    path: "data-tables",    enabled: true, access: "divisions.architect.dataTables"    },
        ],
      },
      // ── Outbound ──────────────────────────────────────
      {
        label: "Outbound",
        path: "outbound",
        enabled: true,
        children: [
          { label: "Campaigns",          path: "campaign",           enabled: true, access: "divisions.outbound.campaign"          },
          { label: "Contact Lists",       path: "contact-list",       enabled: true, access: "divisions.outbound.contactList"       },
          { label: "DNC Lists",           path: "dnc-list",           enabled: true, access: "divisions.outbound.dncList"           },
          { label: "Email Campaigns",     path: "email-campaign",     enabled: true, access: "divisions.outbound.emailCampaign"     },
          { label: "Messaging Campaigns", path: "messaging-campaign", enabled: true, access: "divisions.outbound.messagingCampaign" },
        ],
      },
      // ── Workforce Management ──────────────────────────
      {
        label: "Workforce Mgmt",
        path: "workforce",
        enabled: true,
        children: [
          { label: "Business Units",   path: "business-unit",   enabled: true, access: "divisions.workforce.businessUnit"   },
          { label: "Management Units", path: "management-unit", enabled: true, access: "divisions.workforce.managementUnit" },
        ],
      },
      // ── Task Management ───────────────────────────────
      {
        label: "Task Mgmt",
        path: "task",
        enabled: true,
        children: [
          { label: "Workbins",  path: "workbin",  enabled: true, access: "divisions.task.workbin"  },
          { label: "Work Types", path: "worktype", enabled: true, access: "divisions.task.worktype" },
        ],
      },
    ],
  },
  {
    label: "Interactions",
    path: "interactions",
    enabled: true,
    children: [
      { label: "Disconnect", path: "disconnect", enabled: true, access: "interactions.disconnect" },
      { label: "Search", path: "search", enabled: true, access: "interactions.search" },
      { label: "Move", path: "move", enabled: true, access: "interactions.move" },
    ],
  },
  {
    label: "Export",
    path: "export",
    enabled: true,
    children: [
      { label: "Scheduled Exports", path: "scheduled", enabled: true, access: "export.scheduled" },
      {
        label: "Roles",
        path: "roles",
        enabled: true,
        children: [
          { label: "All Orgs", path: "all-orgs", enabled: true, access: "export.roles.allOrgs" },
          { label: "Single Org", path: "single-org", enabled: true, access: "export.roles.singleOrg" },
        ],
      },
      {
        label: "Licenses",
        path: "licenses",
        enabled: true,
        children: [
          { label: "Consumption", path: "consumption", enabled: true, access: "export.licenses.consumption" },
        ],
      },
      {
        label: "Documentation",
        path: "documentation",
        enabled: true,
        children: [
          { label: "Create", path: "create", enabled: true, access: "export.documentation.create" },
        ],
      },
      {
        label: "Users",
        path: "users",
        enabled: true,
        children: [
          { label: "All Groups", path: "all-groups", enabled: true, access: "export.users.allGroups" },
          { label: "All Roles", path: "all-roles", enabled: true, access: "export.users.allRoles" },
          { label: "Filtered on Role(s)", path: "filtered-roles", enabled: true, access: "export.users.filteredRoles" },
          { label: "Last Login", path: "last-login", enabled: true, access: "export.users.lastLogin" },
          { label: "Trustee", path: "trustee", enabled: true, access: "export.users.trustee" },
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
          { label: "Change Site", path: "change-site", enabled: true, access: "phones.webrtc.changeSite" },
          { label: "Create WebRTC", path: "create", enabled: true, access: "phones.webrtc.create" },
        ],
      },
    ],
  },
  {
    label: "GDPR",
    path: "gdpr",
    enabled: true,
    children: [
      { label: "Subject Request", path: "subject-request", enabled: true, access: "gdpr.subjectRequest" },
      { label: "Request Status",  path: "request-status",  enabled: true, access: "gdpr.requestStatus"  },
    ],
  },
  {
    label: "Audit",
    path: "audit",
    enabled: true,
    children: [
      { label: "Search", path: "search", enabled: true, access: "audit.search" },
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

/**
 * Build a map of { route → accessKey } for every leaf node.
 * Used by the router to guard direct URL navigation.
 */
export function getRouteAccessMap(nodes = NAV_TREE, parentPath = "") {
  const map = {};
  for (const node of nodes) {
    if (node.enabled === false) continue;
    const fullPath = `${parentPath}/${node.path}`;
    if (node.children?.length) {
      Object.assign(map, getRouteAccessMap(node.children, fullPath));
    } else if (node.access) {
      map[fullPath] = node.access;
    }
  }
  return map;
}
