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
  // Execute only, deliberately: this is what makes "may test, may not change"
  // expressible at nav level. data-actions.edit grants the page on EITHER of
  // its permissions, so an execute-only user would otherwise get the editor.
  "data-actions.test":            { execute: ["integrations:action:execute"] },
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
  "divisions.routing.skill":                 { edit: ["routing:skill:update"] },
  "divisions.routing.wrapupCode":            { edit: ["routing:wrapupCode:edit"] },
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
  "wrapupCodes.createEditMapping": { create: ["routing:wrapupCode:add"], edit: ["routing:wrapupCode:edit"], mapping: ["outbound:wrapUpCodeMapping:edit"] },

  // ── Phones (no granular phone perm → telephony:plugin:all) ──
  "phones.webrtc.create":     { create: ["telephony:plugin:all"] },
  "phones.webrtc.changeSite": { edit: ["telephony:plugin:all"] },
  "phones.webrtc.delete":     { delete: ["telephony:plugin:all"] },

  // ── Deployment (bulk, composite — any-of for nav; per-sheet at runtime) ──
  "deployment.basic":      { create: ["authorization:division:add", "routing:skill:create", "routing:language:manage", "routing:schedule:add", "routing:scheduleGroup:add", "telephony:plugin:all"] },
  "deployment.datatables": { create: ["architect:datatable:add"] },
  "deployment.onboarding": { create: ["architect:flow:add", "architect:datatable:add", "integrations:action:add"] },

  // ── Flows ────────────────────────────────────────────
  // Delete Flow removes a callflow and its orphaned dependencies. Listed as
  // any-of for nav purposes; each object's delete is gated by Genesys itself at
  // runtime, which is the real enforcement.
  "flows.delete": {
    delete: [
      "architect:flow:delete", "architect:datatable:delete",
      "architect:userPrompt:delete", "integrations:action:delete",
    ],
  },

  // ── Users ────────────────────────────────────────────
  "users.rolesSkills.configureUsers":      { roles: ["authorization:grant:add"], skills: ["routing:skill:assign"], languages: ["routing:language:assign"], queues: ["routing:queueMember:manage"] },
  "users.rolesSkills.copyFromUser":        { apply: ["authorization:grant:add", "routing:skill:assign", "routing:language:assign", "routing:queueMember:manage"] },
  "users.rolesSkills.addUsersToTemplates": { roles: ["authorization:grant:add"], skills: ["routing:skill:assign"], languages: ["routing:language:assign"], queues: ["routing:queueMember:manage"] },
  // Create/Edit Template is gated the same as Manage Templates: a template you
  // cannot apply is useless, so require the same apply permissions.
  "users.rolesSkills.createTemplate":      { roles: ["authorization:grant:add"], skills: ["routing:skill:assign"], languages: ["routing:language:assign"], queues: ["routing:queueMember:manage"] },
  // Template Schedules apply templates on a schedule → same apply permissions.
  "users.rolesSkills.templateSchedules":   { apply: ["authorization:grant:add", "routing:skill:assign", "routing:language:assign", "routing:queueMember:manage"] },
  // Genesys splits direct routing backup three ways. Clearing a backup issues a
  // DELETE, so an admin with edit but not delete could reach the control and
  // collect a 403 nobody had warned them about.
  "users.directRouting.add":               { addresses: ["directory:user:edit"], backup: ["routing:directRoutingBackup:edit"], backupDelete: ["routing:directRoutingBackup:delete"], callRoute: ["routing:callRoute:edit"] },

  // ── GDPR (customer inclusion TBD — O2) ───────────────
  "gdpr.subjectRequest": { create: ["gdpr:request:add"] },
});

/**
 * Feature → READ-permission map.
 *
 * Read-only features used to be gated by app group alone (the "read-only
 * exemption" in docs/customer-facing-plan.md §6). That was wrong, because an
 * internal user's reads do not run as them: they run as the org's OAuth client,
 * against any configured customer org. A user who cannot read licences in their
 * own org could read every customer's licence consumption through this app.
 * See docs/read-permission-gating-design.md.
 *
 * THE RULE: require what **Genesys itself requires**, and nothing more. Every
 * entry below is read out of `x-inin-requires-permissions` in the OpenAPI spec
 * (api.mypurecloud.com/api/v2/docs/swagger), not written from memory.
 *
 * Endpoints Genesys does not gate get NO entry here — `/api/v2/users`,
 * `/api/v2/groups`, `/api/v2/license/users` and `/api/v2/authorization/permissions`
 * all declare no permission, so requiring one would be this app inventing policy
 * Genesys does not have and denying people data any Genesys client hands them.
 * Their absence below is a decision, not an oversight.
 *
 * SHAPE: accessKey → { <logicalAction>: spec }, where spec is either
 *   ["a:b:c", "d:e:f"]         → ANY of these
 *   { all: ["a:b:c", ...] }    → ALL of these
 *
 * WHICH TO USE. ANY is for alternatives on the SAME data — where Genesys itself
 * declares `ANY`, e.g. conversationDetail:view or agentConversationDetail:view
 * on one analytics endpoint. **ALL is for a page that aggregates DISTINCT
 * datasets**, each with its own permission.
 *
 * The write map's composite policy ("gate on the primary permission; sub-call
 * failures surface as per-item errors") does not carry over, and assuming it
 * did was a bug here. Sub-calls do not fail: they run as the OAuth client, not
 * as the user, so every one of them succeeds. Under ANY, holding
 * `routing:wrapupCode:view` alone would open Get Lists and hand over the
 * presence definitions too. Aggregating pages therefore require the lot.
 *
 * Composite pages gate on the PRIMARY permission — the data the page exists to
 * show — with sub-call failures surfacing as per-item errors, per §6 of the plan.
 */
export const FEATURE_READ_PERMISSIONS = Object.freeze({
  // ── Audit ────────────────────────────────────────────
  "audit.search":              { view: { all: ["audits:audit:view"] } },

  // ── Dashboards › Quality ─────────────────────────────
  // Coverage is `all:` because it aggregates two genuinely distinct datasets:
  // the analytics evaluation aggregates, and the agent/evaluator activity
  // listings from the quality domain. Neither substitutes for the other, so
  // under ANY someone holding only quality:evaluation:view would be handed the
  // analytics aggregates as well.
  "dashboards.quality.coverage":  { view: { all: ["analytics:evaluationAggregate:view",
                                                  "quality:evaluation:view"] } },
  // Scores gates the page on the data it exists to show, and its row-level
  // drill-down separately: without searchAny you get the charts and no detail
  // table, which is a coherent page rather than a denial.
  "dashboards.quality.scores":    { view:   ["analytics:evaluationAggregate:view"],
                                    detail: ["quality:evaluation:searchAny"] },
  // STA Configuration gates on the program list alone: without it there is no
  // chain to walk and the page has nothing to say. Scoring rules, transcription
  // settings and queues each degrade band by band and name what they want, so
  // putting them in the gate would deny a page that would still be useful.
  // Design §13.5.
  "dashboards.quality.staConfiguration": { view: ["speechAndTextAnalytics:program:view"] },

  // ── Deployment ───────────────────────────────────────
  "deployment.test.testCases": { view: ["architect:flow:view"] },

  // ── Export › Billing (trustee billing overview) ──────
  "export.billing.allOrgsLatest":    { view: ["affiliateOrganization:clientBilling:view"] },
  "export.billing.calendarYear":     { view: ["affiliateOrganization:clientBilling:view"] },
  "export.billing.customOrgs":       { view: ["affiliateOrganization:clientBilling:view"] },
  "export.billing.dateRange":        { view: ["affiliateOrganization:clientBilling:view"] },
  "export.billing.periodComparison": { view: ["affiliateOrganization:clientBilling:view"] },
  "export.billing.singleOrg":        { view: ["affiliateOrganization:clientBilling:view"] },

  // ── Export › other ───────────────────────────────────
  "export.documentation.create":  { view: ["architect:flow:view"] },
  "export.interactions.totals":   { view: ["analytics:conversationDetail:view", "analytics:agentConversationDetail:view"] },
  "export.licenses.consumption":  { view: ["authorization:grant:add", "authorization:license:view"] },
  "export.roles.allOrgs":         { view: ["authorization:role:view"] },
  "export.roles.singleOrg":       { view: ["authorization:role:view"] },
  "export.users.allRoles":        { view: { all: ["authorization:role:view", "authorization:grant:view"] } },
  "export.users.filteredRoles":   { view: { all: ["authorization:role:view", "authorization:grant:view"] } },
  "export.users.queuesSkills":    { view: { all: ["routing:queue:view", "routing:skill:view"] } },
  "export.users.trustee":         { view: ["authorization:orgTrustee:view"] },
  // Deliberate exception to the rule above. `/api/v2/license/users` declares no
  // permission, so "gate what Genesys gates" would leave this open — but the
  // page emits one row per user-LICENCE pair, which is the same data
  // export.licenses.consumption is gated on. Ungated, it is simply the way
  // round that gate, and a gate you can walk around is not a gate.
  "export.users.lastLogin":       { view: ["authorization:grant:add", "authorization:license:view"] },

  // ── Flows ────────────────────────────────────────────
  "flows.flowoverview":        { view: ["architect:flow:view"] },
  "flows.journey":             { view: ["architect:flow:view"] },

  // ── GDPR ─────────────────────────────────────────────
  "gdpr.requestStatus":        { view: ["gdpr:request:view"] },

  // ── Interactions ─────────────────────────────────────
  "interactions.recordings.jobs":                    { view: { all: ["recording:job:view"] } },
  "interactions.search.participantData.historical":  { view: ["analytics:conversationDetail:view", "analytics:agentConversationDetail:view"] },
  "interactions.search.participantData.recent":      { view: ["analytics:conversationDetail:view", "analytics:agentConversationDetail:view"] },
  "interactions.search.transcripts.search":          { view: { all: ["recording:recording:view", "speechAndTextAnalytics:data:view"] } },

  // ── Roles ────────────────────────────────────────────
  "roles.compare":             { view: { all: ["authorization:role:view", "authorization:grant:view"] } },
  // Three tabs, two answers. Permission Search and Hourly Interacting read
  // roles; the WEM tab additionally reads the licence API. Gating the page on
  // the union would deny the first two to someone entitled to them.
  "roles.search":              { view: { all: ["authorization:role:view", "authorization:grant:view"] },
                                 wem:  ["authorization:grant:add", "authorization:license:view"] },

  // ── Utilities ────────────────────────────────────────
  // One action per list, because the page shows ONE list at a time — it is a
  // picker over a registry, not an aggregate. An earlier revision required ALL
  // of these, on a misreading of the file, which denied the whole page to
  // someone entitled to one of its lists. Omitting `action` asks "can they see
  // anything here", which unions to ANY and is the right page-level question.
  "utilities.getLists":        {
    presence: { all: ["presence:presenceDefinition:view"] },
    wrapup:   { all: ["routing:wrapupCode:view"] },
    // Permissions vs. Licenses reads /license/definitions. ANY, mirroring the
    // alternatives Genesys itself declares for that endpoint. Missing this
    // entry left the list ungated — an action with no spec is treated as
    // "nothing to check", so it was open to anyone who could reach the page.
    licenses: ["authorization:grant:add", "authorization:license:view"],
  },

  // NOT gated, deliberately:
  //   export.scheduled, export.users.skillTemplates  — app-owned storage
  //   export.users.allGroups                         — /groups is ungated
  //   utilities.ipRanges                             — no Genesys data
});

/** Normalize a spec to { mode: "any"|"all", permissions: string[] }. */
function normalizeSpec(spec) {
  if (!spec) return { mode: "any", permissions: [] };
  if (Array.isArray(spec)) return { mode: "any", permissions: [...spec] };
  if (Array.isArray(spec.all)) return { mode: "all", permissions: [...spec.all] };
  if (Array.isArray(spec.any)) return { mode: "any", permissions: [...spec.any] };
  return { mode: "any", permissions: [] };
}

/** True if the access key gates reads (i.e. has an entry in the read map). */
export function isReadGated(accessKey) {
  return Object.prototype.hasOwnProperty.call(FEATURE_READ_PERMISSIONS, accessKey);
}

/**
 * The read permissions gating a feature, or one logical action of it.
 *
 * Omitting `action` asks "can the user read anything here?" and answers ANY
 * across the actions — a page whose one tab is permitted should not be hidden
 * because another is not. Naming an action asks about that tab alone.
 *
 * @returns {{mode: "any"|"all", permissions: string[]}}
 */
export function getReadPermissions(accessKey, action) {
  const entry = FEATURE_READ_PERMISSIONS[accessKey];
  if (!entry) return { mode: "any", permissions: [] };
  if (action) return normalizeSpec(entry[action]);

  // Union across actions. A mixed page falls back to ANY: the strict ALL sets
  // are per-action, and a page-level check is only deciding hide vs. show.
  const specs = Object.values(entry).map(normalizeSpec);
  if (specs.length === 1) return specs[0];
  const set = new Set();
  for (const sp of specs) for (const p of sp.permissions) set.add(p);
  return { mode: "any", permissions: [...set] };
}

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
