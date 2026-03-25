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
 * ──────────────────────────────────────────────────────────────────────
 *   DATA ACTIONS
 *   data-actions.copy.betweenOrgs      Copy a data action between orgs
 *   data-actions.edit                  View, edit, and test data actions
 *
 *   DATA TABLES
 *   data-tables.create                 Create a new data table
 *   data-tables.edit                   Edit an existing data table
 *   data-tables.copy.betweenOrgs       Copy a data table between orgs
 *   data-tables.copy.singleOrg         Copy a data table within the same org
 *
 *   INTERACTIONS
 *   interactions.search.participantData.recent     Recent Interaction Search (<48h)
 *   interactions.search.participantData.historical  Historical Interaction Search (>48h)
 *   interactions.search.participantData.*           Both Participant Data search pages
 *   interactions.search.transcripts.search          Transcript Search (under Search > Transcripts)
 *   interactions.search.transcripts.*               All transcript pages
 *   interactions.search.*                           All search pages (any sub-group)
 *   interactions.move                               Move interactions between queues
 *   interactions.disconnect                         Force-disconnect stuck conversations
 *
 *   EXPORT
 *   export.scheduled                   All Scheduled Exports overview + automation
 *   export.documentation.create        Documentation / full config workbook export
 *   export.licenses.consumption        License Consumption export
 *   export.roles.allOrgs               Roles export — all orgs (multi-sheet)
 *   export.roles.singleOrg             Roles export — single org
 *   export.users.allGroups             All Groups export
 *   export.users.allRoles              All Roles export
 *   export.users.filteredRoles         Filtered on Role(s) export
 *   export.users.lastLogin             Last Login export
 *   export.users.skillTemplates        Skill/Role/Queue Templates export
 *   export.users.trustee               Trustee export
 *   export.interactions.totals         Interaction Totals — bar charts by media/direction/routing
 *
 *   PHONES
 *   phones.webrtc.changeSite           WebRTC Phones — Change Site
 *   phones.webrtc.create               WebRTC Phones — Create
 *
 *   GDPR
 *   gdpr.subjectRequest                Submit GDPR data subject requests
 *   gdpr.requestStatus                 View GDPR request status
 *
 *   ROLES
 *   roles.compare                      Compare permission policies across roles
 *   roles.search                       Search permissions and see which users hold them (Permissions vs. Users)
 *   roles.create                       Create a new role with permission policies
 *   roles.edit                         Edit an existing role's permission policies
 *   roles.copy.singleOrg               Copy a role within the same org (pre-filled permission builder)
 *   roles.copy.betweenOrgs             Copy a role from one org to another
 *
 *   FLOWS
 *   flows.journey                      Journey Flow — visualise flow path data
 *
 *   AUDIT
 *   audit.search                       Audit event search
 *
 *   DEPLOYMENT
 *   deployment.basic                   Deployment — Basic (bulk-create core objects)
 *   deployment.datatables              Deployment — Data Tables (bulk-create data tables)
 *
 *   USERS
 *   users.directRouting.add            Direct Routing — Add user(s)
 *   users.rolesSkills.configureUsers     Roles & Skills — Configure Users
 *   users.rolesSkills.createTemplate    Roles & Skills — Create Template
 *   users.rolesSkills.addUsersToTemplates  Roles & Skills — Add Users To Templates
 *   users.rolesSkills.templateSchedules    Roles & Skills — Template Schedules
 *
 *   DIVISIONS  (reassign objects between divisions)
 *   divisions.people.users             People — Users
 *   divisions.people.team              People — Work Teams
 *   divisions.routing.queues           Routing — Queues
 *   divisions.routing.callroute        Routing — Call Routes
 *   divisions.routing.emergencyGroups  Routing — Emergency Groups
 *   divisions.routing.extensionPool    Routing — Extension Pools
 *   divisions.routing.routingSchedules      Routing — Schedules
 *   divisions.routing.routingScheduleGroups Routing — Schedule Groups
 *   divisions.routing.skillGroup       Routing — Skill Groups
 *   divisions.architect.flow           Architect — Flows
 *   divisions.architect.flowMilestone  Architect — Flow Milestones
 *   divisions.architect.flowOutcome    Architect — Flow Outcomes
 *   divisions.architect.script         Architect — Scripts
 *   divisions.architect.dataTables     Architect — Data Tables
 *   divisions.outbound.campaign        Outbound — Campaigns
 *   divisions.outbound.contactList     Outbound — Contact Lists
 *   divisions.outbound.dncList         Outbound — DNC Lists
 *   divisions.outbound.emailCampaign   Outbound — Email Campaigns
 *   divisions.outbound.messagingCampaign Outbound — Messaging Campaigns
 *   divisions.workforce.businessUnit   Workforce Mgmt — Business Units
 *   divisions.workforce.managementUnit Workforce Mgmt — Management Units
 *   divisions.task.workbin             Task Mgmt — Workbins
 *   divisions.task.worktype            Task Mgmt — Work Types
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
