/**
 * Access control configuration.
 *
 * Maps Genesys Cloud group names (in your own org) to access key arrays.
 *
 * HOW IT WORKS
 * ────────────
 * Each leaf page in navConfig.js has an `access` field — e.g. "interactions.search".
 * When a user logs in, their Genesys group memberships are fetched and looked up
 * in GROUP_ACCESS below. All matching keys are collected into a set.
 * A page is visible if the user's key set contains a matching entry (see below).
 * The URL path is NOT used for access checks — only the `access` field on the nav node.
 *
 * Key formats you can put in GROUP_ACCESS values:
 *   "*"                        — full access (every page)
 *   "section.*"                — all pages whose access key starts with "section."
 *   "section.group.*"          — all pages whose access key starts with "section.group."
 *   "section.group.page"       — exactly one page
 *
 * Examples:
 *   ["*"]                          — everything
 *   ["export.*"]                   — all export pages
 *   ["export.users.*"]             — all export › users pages
 *   ["interactions.search", "interactions.move"]  — two specific pages
 *
 * To grant or restrict access:
 *   1. Create/update the group in your Genesys Cloud org
 *   2. Add or edit the entry here
 *   3. No other code changes needed
 *
 * FULL ACCESS KEY LIST  (these are the `access` values on each nav leaf)
 * Listed alphabetically by section name.
 * ──────────────────────────────────────────────────────────────────────
 *   AUDIT
 *   audit.search                       Search
 *
 *   DATA ACTIONS
 *   data-actions.copy.betweenOrgs      Copy - Between Orgs
 *   data-actions.edit                  Edit
 *
 *   DATA TABLES
 *   data-tables.create                 Create
 *   data-tables.edit                   Edit
 *   data-tables.copy.betweenOrgs       Copy - Between Orgs
 *   data-tables.copy.singleOrg         Copy - Single Org
 *
 *   DEPLOYMENT
 *   deployment.basic                   Basic
 *   deployment.datatables              Data Tables
 *
 *   DIVISIONS  (reassign objects between divisions)
 *   divisions.people.users                  People — Users
 *   divisions.people.team                   People — Work Teams
 *   divisions.routing.queues                Routing — Queues
 *   divisions.routing.callroute             Routing — Call Routes
 *   divisions.routing.emergencyGroups       Routing — Emergency Groups
 *   divisions.routing.extensionPool         Routing — Extension Pools
 *   divisions.routing.routingSchedules      Routing — Routing Schedules
 *   divisions.routing.routingScheduleGroups Routing — Routing Schedule Groups
 *   divisions.routing.skillGroup            Routing — Skill Groups
 *   divisions.architect.flow                Architect — Flows
 *   divisions.architect.flowMilestone       Architect — Milestones
 *   divisions.architect.flowOutcome         Architect — Flow Outcomes
 *   divisions.architect.script              Architect — Scripts
 *   divisions.architect.dataTables          Architect — Data Tables
 *   divisions.outbound.campaign             Outbound — Campaigns
 *   divisions.outbound.contactList          Outbound — Contact Lists
 *   divisions.outbound.dncList              Outbound — DNC Lists
 *   divisions.outbound.emailCampaign        Outbound — Email Campaigns
 *   divisions.outbound.messagingCampaign    Outbound — Messaging Campaigns
 *   divisions.workforce.businessUnit        Workforce Mgmt — Business Units
 *   divisions.workforce.managementUnit      Workforce Mgmt — Management Units
 *   divisions.task.workbin                  Task Mgmt — Workbins
 *   divisions.task.worktype                 Task Mgmt — Work Types
 *
 *   EXPORT
 *   export.scheduled                   Scheduled Exports
 *   export.roles.allOrgs               Roles — All Orgs
 *   export.roles.singleOrg             Roles — Single Org
 *   export.licenses.consumption        Licenses — Consumption
 *   export.billing.singleOrg           Billing — Single Org
 *   export.billing.allOrgsLatest       Billing — All Orgs (Latest)
 *   export.billing.calendarYear        Billing — Calendar Year
 *   export.billing.dateRange           Billing — Date Range
 *   export.billing.customOrgs          Billing — Custom Orgs
 *   export.billing.periodComparison    Billing — Period Comparison
 *   export.documentation.create        Documentation — Create
 *   export.interactions.totals         Interactions — Totals
 *   export.users.allGroups             Users — All Groups
 *   export.users.allRoles              Users — All Roles
 *   export.users.filteredRoles         Users — Filtered on Role(s)
 *   export.users.lastLogin             Users — Last Login
 *   export.users.queuesSkills          Users — Queues/Skills
 *   export.users.skillTemplates        Users — Skill/Role/Queue Templates
 *   export.users.trustee               Users — Trustee
 *
 *   FLOWS
 *   flows.journey                      Journey Flow
 *
 *   GDPR
 *   gdpr.subjectRequest                Subject Request
 *   gdpr.requestStatus                 Request Status
 *
 *   INTERACTIONS
 *   interactions.disconnect                          Disconnect (force-disconnect stuck conversations)
 *   interactions.search.participantData.recent       Search > Participant Data > Recent (<48h)
 *   interactions.search.participantData.historical   Search > Participant Data > Historical (>48h)
 *   interactions.search.participantData.*            Both Participant Data search pages
 *   interactions.search.transcripts.search           Search > Transcripts > Search
 *   interactions.search.transcripts.*                All transcript pages
 *   interactions.search.*                            All search pages (any sub-group)
 *   interactions.move                                Move (move interactions between queues)
 *   interactions.recordings.create                   Recordings > Create Export Job
 *   interactions.recordings.jobs                     Recordings > Export Jobs
 *   interactions.recordings.*                        All recordings pages
 *
 *   PHONES
 *   phones.webrtc.changeSite           WebRTC — Change Site
 *   phones.webrtc.create               WebRTC — Create WebRTC
 *
 *   ROLES
 *   roles.copy.singleOrg               Copy — Copy from current org
 *   roles.copy.betweenOrgs             Copy — Copy between orgs
 *   roles.compare                      Compare
 *   roles.search                       Permissions vs. Users
 *   roles.create                       Create
 *   roles.edit                         Edit
 *
 *   USERS
 *   users.directRouting.add                Direct Routing — Add user(s)
 *   users.rolesSkills.configureUsers       Roles, Queues & Skills — Configure Users
 *   users.rolesSkills.createTemplate       Roles, Queues & Skills — Create/Edit Template
 *   users.rolesSkills.addUsersToTemplates  Roles, Queues & Skills — Manage Templates
 *   users.rolesSkills.templateSchedules    Roles, Queues & Skills — Template Schedules
 *   users.rolesSkills.copyFromUser         Roles, Queues & Skills — Copy from User
 *
 *   UTILITIES
 *   utilities.ipRanges                 IP Ranges
 *
 *   WRAPUP CODES
 *   wrapupCodes.createEditMapping      Create/Edit/Mapping
 */
export const GROUP_ACCESS = {
  "Genesys App - Master Admin": ["*"],
  "Genesys App - Admin": ["*"],
  "Genesys App - Support": ["audit.*", "interactions.search.*", "export.*", "roles.compare", "roles.search", "flows.journey"],
  "Genesys App - Export": ["export.*"],
};

/**
 * Users who always get full access, regardless of group membership.
 * Add Genesys Cloud user IDs here.
 */
export const SUPERUSER_IDS = [
  "519fd42d-d19b-4d6b-9827-d77c9ceb8dc3",
];
