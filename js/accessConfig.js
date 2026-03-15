/**
 * Access control configuration.
 *
 * Maps Genesys Cloud group names (in your own org) to access key arrays.
 *
 * Key formats:
 *   "*"                        — full access (everything)
 *   "section.*"                — all pages in a top-level section
 *   "section.group.*"          — all pages in a sub-group
 *   "section.group.page"       — one specific page
 *
 * To grant or restrict access:
 *   1. Create/update the group in your Genesys Cloud org
 *   2. Add or edit the entry here
 *   3. No other code changes needed
 *
 * Access key reference:
 *
 *   DATA ACTIONS
 *   data-actions.copy.betweenOrgs      Copy a data action between orgs
 *   data-actions.edit                  View, edit, and test data actions
 *
 *   DATA TABLES
 *   data-tables.create                 Create a new data table
 *   data-tables.copy.betweenOrgs       Copy a data table between orgs
 *   data-tables.copy.singleOrg         Copy a data table within the same org
 *
 *   INTERACTIONS
 *   interactions.search                Recent (<48h) and Historical (>48h) search
 *   interactions.move                  Move interactions between queues
 *   interactions.disconnect            Force-disconnect stuck conversations
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
 *   export.users.trustee               Trustee export
 *
 *   PHONES
 *   phones.webrtc.changeSite           WebRTC Phones — Change Site
 *   phones.webrtc.create               WebRTC Phones — Create
 *
 *   GDPR
 *   gdpr.subjectRequest                Submit GDPR data subject requests
 *   gdpr.requestStatus                 View GDPR request status
 *
 *   AUDIT
 *   audit.search                       Audit event search
 *
 *   DEPLOYMENT
 *   deployment.basic                   Deployment — Basic (bulk-create core objects)
 *   deployment.datatables              Deployment — Data Tables (bulk-create data tables)
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
  "Genesys App - Admin":  ["*"],
  "Genesys App - Export": ["export.*"],
};

/**
 * Users who always get full access, regardless of group membership.
 * Add Genesys Cloud user IDs here.
 */
export const SUPERUSER_IDS = [
  "519fd42d-d19b-4d6b-9827-d77c9ceb8dc3",
];
