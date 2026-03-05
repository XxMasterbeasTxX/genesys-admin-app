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
 *   data-actions.copy.betweenOrgs    data-actions.edit
 *   data-tables.copy.betweenOrgs     data-tables.copy.singleOrg
 *   interactions.disconnect          interactions.search          interactions.move
 *   export.scheduled
 *   export.roles.allOrgs             export.roles.singleOrg
 *   export.licenses.consumption
 *   export.documentation.create
 *   export.users.allGroups           export.users.allRoles
 *   export.users.filteredRoles       export.users.lastLogin       export.users.trustee
 *   phones.webrtc.changeSite         phones.webrtc.create
 *   gdpr.subjectRequest            gdpr.requestStatus
 */
export const GROUP_ACCESS = {
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
