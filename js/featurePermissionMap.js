/**
 * Feature → write-permission map (internal permission-refinement).
 *
 * Maps each app access key to the Genesys Cloud permission(s) that gate its
 * WRITE actions. Used by the internal permission-refinement layer: an internal
 * user may perform a write action only if (a) their app group grants the feature
 * AND (b) they hold the matching permission in the company (demo) org.
 *
 * RULES (see docs/customer-facing-plan.md §6, §8):
 *   - Only WRITE/mutating actions are gated. READ-ONLY features (Export, Audit,
 *     Flows, Roles Compare/Search, Interactions Search) carry NO entry here and
 *     are gated by app group/entitlement alone.
 *   - App-owned storage features (Scheduled Exports, Template create/schedules)
 *     have no Genesys permission and carry NO entry.
 *   - Strings confirmed against the live demo catalog (2026-07-06).
 *
 * SHAPE: accessKey → { <logicalAction>: [ "domain:entity:action", ... ], ... }
 *   The logical action names (create/edit/delete/rows/execute/apply/mapping) let
 *   in-page buttons be gated individually. For nav-level show/hide, use the union
 *   of all permissions for the key (see getRequiredPermissions / isWriteGated).
 */
export const FEATURE_WRITE_PERMISSIONS = Object.freeze({
  // ── Roles ────────────────────────────────────────────
  "roles.create":             { create: ["authorization:role:add"] },
  "roles.edit":               { edit:   ["authorization:role:edit"] },
  "roles.copy.singleOrg":     { create: ["authorization:role:add"] },
  "roles.copy.betweenOrgs":   { create: ["authorization:role:add"] },

  // ── Data Actions ─────────────────────────────────────
  "data-actions.edit":            { edit: ["integrations:action:edit"], execute: ["integrations:action:execute"] },
  "data-actions.copy.betweenOrgs":{ create: ["integrations:action:add"] },

  // ── Data Tables ──────────────────────────────────────
  "data-tables.create":           { create: ["architect:datatable:add"] },
  "data-tables.edit":             { schemaEdit: ["architect:datatable:edit"], rowsAdd: ["architect:datatableRow:add"], rowsEdit: ["architect:datatableRow:edit"], rowsDelete: ["architect:datatableRow:delete"], delete: ["architect:datatable:delete"] },
  "data-tables.copy.singleOrg":   { create: ["architect:datatable:add"] },
  "data-tables.copy.betweenOrgs": { create: ["architect:datatable:add"] },

  // ── Divisions (reassign object to a division → object's edit perm) ──
  "divisions.people.users":                  { edit: ["directory:user:edit"] },
  "divisions.people.team":                   { edit: ["groups:team:edit"] },
  "divisions.routing.queues":                { edit: ["routing:queue:edit"] },
  "divisions.routing.callroute":             { edit: ["routing:callRoute:edit"] },
  "divisions.routing.emergencyGroups":       { edit: ["routing:emergencyGroup:edit"] },
  "divisions.routing.extensionPool":         { edit: ["telephony:extensionPool:edit"] },
  "divisions.routing.routingSchedules":      { edit: ["routing:schedule:edit"] },
  "divisions.routing.routingScheduleGroups": { edit: ["routing:scheduleGroup:edit"] },
  "divisions.routing.skillGroup":            { edit: ["routing:skillgroup:edit"] },
  "divisions.architect.flow":                { edit: ["architect:flow:edit"] },
  "divisions.architect.flowMilestone":       { edit: ["architect:flowMilestone:edit"] },
  "divisions.architect.flowOutcome":         { edit: ["architect:flowOutcome:edit"] },
  "divisions.architect.script":              { edit: ["scripter:script:edit"] },
  "divisions.architect.dataTables":          { edit: ["architect:datatable:edit"] },
  "divisions.outbound.campaign":             { edit: ["outbound:campaign:edit"] },
  "divisions.outbound.contactList":          { edit: ["outbound:contactList:edit"] },
  "divisions.outbound.dncList":              { edit: ["outbound:dncList:edit"] },
  "divisions.outbound.emailCampaign":        { edit: ["outbound:emailCampaign:edit"] },
  "divisions.outbound.messagingCampaign":    { edit: ["outbound:messagingCampaign:edit"] },
  "divisions.workforce.businessUnit":        { edit: ["wfm:businessUnit:edit"] },
  "divisions.workforce.managementUnit":      { edit: ["wfm:managementUnit:edit"] },
  "divisions.task.workbin":                  { edit: ["workitems:workbin:edit"] },
  "divisions.task.worktype":                 { edit: ["workitems:worktype:edit"] },

  // ── Interactions ─────────────────────────────────────
  "interactions.disconnect":        { execute: ["conversation:communication:disconnect"] },
  "interactions.move":              { execute: ["conversation:communication:blindTransferQueue"] },
  "interactions.recordings.create": { create: ["recording:job:add"] },

  // ── Wrapup Codes ─────────────────────────────────────
  "wrapupCodes.createEditMapping": { edit: ["routing:wrapupCode:add", "routing:wrapupCode:edit"], mapping: ["outbound:wrapUpCodeMapping:edit"] },

  // ── Phones (no granular phone perm → telephony:plugin:all) ──
  "phones.webrtc.create":     { create: ["telephony:plugin:all"] },
  "phones.webrtc.changeSite": { edit: ["telephony:plugin:all"] },

  // ── Deployment (bulk, composite — any-of for nav; per-sheet at runtime) ──
  "deployment.basic":      { create: ["authorization:division:add", "routing:skill:create", "routing:language:manage", "routing:schedule:add", "routing:scheduleGroup:add", "telephony:plugin:all"] },
  "deployment.datatables": { create: ["architect:datatable:add"] },

  // ── Users ────────────────────────────────────────────
  "users.rolesSkills.configureUsers":      { roles: ["authorization:grant:add"], skills: ["routing:skill:assign"], languages: ["routing:language:assign"], queues: ["routing:queueMember:manage"] },
  "users.rolesSkills.copyFromUser":        { apply: ["authorization:grant:add", "routing:skill:assign", "routing:language:assign", "routing:queueMember:manage"] },
  "users.rolesSkills.addUsersToTemplates": { apply: ["authorization:grant:add", "routing:skill:assign", "routing:language:assign", "routing:queueMember:manage"] },
  // Create/Edit Template is gated the same as Manage Templates: a template you
  // cannot apply is useless, so require the same apply permissions.
  "users.rolesSkills.createTemplate":      { apply: ["authorization:grant:add", "routing:skill:assign", "routing:language:assign", "routing:queueMember:manage"] },
  // Template Schedules apply templates on a schedule → same apply permissions.
  "users.rolesSkills.templateSchedules":   { apply: ["authorization:grant:add", "routing:skill:assign", "routing:language:assign", "routing:queueMember:manage"] },
  "users.directRouting.add":               { edit: ["directory:user:edit", "routing:directRoutingBackup:edit"] },

  // ── GDPR (customer inclusion TBD — O2) ───────────────
  "gdpr.subjectRequest": { create: ["gdpr:request:add"] },
});

/**
 * True if the given access key gates write actions (i.e. has an entry above).
 * Read-only / app-storage features return false and are group-gated only.
 * @param {string} accessKey
 * @returns {boolean}
 */
export function isWriteGated(accessKey) {
  return Object.prototype.hasOwnProperty.call(FEATURE_WRITE_PERMISSIONS, accessKey);
}

/**
 * The union of all write permissions a feature can use (across its actions).
 * Use for nav-level "can the user do anything here?" (any-of) checks.
 * @param {string} accessKey
 * @returns {string[]}  unique permission strings (empty if not write-gated)
 */
export function getRequiredPermissions(accessKey) {
  const entry = FEATURE_WRITE_PERMISSIONS[accessKey];
  if (!entry) return [];
  const set = new Set();
  for (const perms of Object.values(entry)) {
    for (const p of perms) set.add(p);
  }
  return [...set];
}

/**
 * The permissions gating a specific logical action of a feature (e.g. "delete").
 * Use for in-page button-level gating.
 * @param {string} accessKey
 * @param {string} action   logical action name (create/edit/delete/rows/execute/apply/mapping)
 * @returns {string[]}      permission strings (empty if none defined)
 */
export function getActionPermissions(accessKey, action) {
  const entry = FEATURE_WRITE_PERMISSIONS[accessKey];
  return (entry && entry[action]) ? [...entry[action]] : [];
}
