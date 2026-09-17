/**
 * The proxy's permission check for internal sessions.
 *
 * For an internal-org caller the proxy elevates to client credentials, so
 * Genesys enforces the CLIENT's permissions on the call, not the person's.
 * Until this check, the person's own permissions were consulted only by the
 * browser, to grey buttons — which meant a named colleague could reach any
 * endpoint the client credentials reach by calling the proxy directly
 * (docs/internal-user-access-design.md §7). This asks the same question the
 * browser asks, server-side, per request: does the caller hold a Genesys
 * permission that means this call?
 *
 * ── The table ──
 *
 * Genesys permissions are `domain:entity:action`, and the proxy sees a
 * method and a path. RULES maps every endpoint the app calls (the catalogue
 * in docs/api-reference.md — 208 method+path pairs) to the permission(s)
 * that mean it, first match wins, using the same vocabulary as
 * js/featurePermissionMap.js so the two never disagree about a name. A
 * required value is one permission, a list meaning any-of, `null` meaning
 * no permission (organizations/me, timezones), or a function of the match
 * for the few paths whose object type is in the URL.
 *
 * ── Two modes ──
 *
 * PROXY_PERMISSION_CHECK unset or "report": a call that WOULD be refused is
 * allowed and logged — both a missing permission and a path this table does
 * not know. That is how the table is proven against real traffic before it
 * refuses anything. "enforce": refused, 403, with the permission named.
 * An unknown path is refused too in enforce mode: the report phase exists
 * so that there are none left by then, and fail-open would leave exactly
 * the hole this closes.
 *
 * Superusers bypass, as they bypass every check: they are the root
 * authority, and the browser's refinement never gated them either.
 *
 * The caller's permissions are cached per token for five minutes, like the
 * classification and the licence verdict.
 */
const crypto = require("crypto");
const { fetchUserPermissions, hasAnyPermission } = require("./userPermissions");

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function enforced() {
  return String(process.env.PROXY_PERMISSION_CHECK || "").trim().toLowerCase() === "enforce";
}

function tokenKey(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ── The table ─────────────────────────────────────────────────────────────
//
// Each rule: [methods, path pattern, required]. `{id}` in a pattern is any
// one path segment. Methods "*" means any. Paths are matched after
// "/api/v2", with the query string removed.

const ANY = "*";
const TEL_VIEW = ["telephony:plugin:view", "telephony:plugin:all"];
const TEL_ALL  = "telephony:plugin:all";

// Moving an object into a division needs the OBJECT's edit permission, and
// the object type is the last path segment.
const DIVISION_OBJECT_EDIT = {
  USER: "directory:user:edit", QUEUE: "routing:queue:edit", CALLROUTE: "routing:callRoute:edit",
  CAMPAIGN: "outbound:campaign:edit", CONTACTLIST: "outbound:contactList:edit", DNCLIST: "outbound:dncList:edit",
  EMAILCAMPAIGN: "outbound:emailCampaign:edit", MESSAGINGCAMPAIGN: "outbound:messagingCampaign:edit",
  DATATABLE: "architect:datatable:edit", DATATABLES: "architect:datatable:edit",
  FLOW: "architect:flow:edit", FLOWMILESTONE: "architect:flowMilestone:edit",
  FLOWOUTCOME: "architect:flowOutcome:edit", EMERGENCYGROUP: "routing:emergencyGroup:edit", EMERGENCYGROUPS: "routing:emergencyGroup:edit",
  EXTENSIONPOOL: "telephony:extensionPool:edit", MANAGEMENTUNIT: "wfm:managementUnit:edit",
  BUSINESSUNIT: "wfm:businessUnit:edit", SCHEDULE: "routing:schedule:edit", ROUTINGSCHEDULES: "routing:schedule:edit",
  SCHEDULEGROUP: "routing:scheduleGroup:edit", ROUTINGSCHEDULEGROUPS: "routing:scheduleGroup:edit", LIBRARY: "responses:library:edit",
  SCRIPT: "scripter:script:edit", SKILL: "routing:skill:edit", SKILLGROUP: "routing:skillgroup:edit",
  TEAM: "groups:team:edit", WORKBIN: "workitems:workbin:edit", WORKTYPE: "workitems:worktype:edit",
  WRAPUPCODE: "routing:wrapupCode:edit",
};

const RULES = [
  // ── no permission ──
  ["GET",  "/organizations/me",                                   null],
  ["GET",  "/users/me",                                           null],
  ["GET",  "/timezones",                                          null],
  ["GET",  "/ipranges",                                           null],
  ["GET",  "/locations",                                          null],

  // ── analytics ──
  ["POST", "/analytics/conversations/aggregates/query",           "analytics:conversationAggregate:view"],
  ["*",    "/analytics/conversations/details(/.*)?",              "analytics:conversationDetail:view"],
  ["POST", "/analytics/evaluations/aggregates/query",             "analytics:evaluationAggregate:view"],
  ["POST", "/analytics/transcripts/aggregates/query",             "analytics:transcriptAggregate:view"],

  // ── architect ──
  ["GET",  "/architect/dependencytracking(/.*)?",                 "architect:dependencyTracking:view"],
  ["GET",  "/architect/emergencygroups",                          "routing:emergencyGroup:view"],
  ["GET",  "/architect/ivrs(/{id})?",                             "routing:callRoute:view"],
  ["PUT",  "/architect/ivrs/{id}",                                "routing:callRoute:edit"],
  ["GET",  "/architect/prompts(/{id}/resources)?",                "architect:userPrompt:view"],
  ["POST", "/architect/prompts(/{id}/resources)?",                "architect:userPrompt:add"],
  ["DELETE","/architect/prompts/{id}",                            "architect:userPrompt:delete"],
  ["GET",  "/architect/schedulegroups",                           "routing:scheduleGroup:view"],
  ["POST", "/architect/schedulegroups",                           "routing:scheduleGroup:add"],
  ["PUT",  "/architect/schedulegroups/{id}",                      "routing:scheduleGroup:edit"],
  ["GET",  "/architect/schedules",                                "routing:schedule:view"],
  ["POST", "/architect/schedules",                                "routing:schedule:add"],
  ["PUT",  "/architect/schedules/{id}",                           "routing:schedule:edit"],

  // ── assistants ──
  ["GET",  "/assistants",                                         "assistants:assistant:view"],
  ["GET",  "/assistants/queues",                                  "assistants:queue:view"],

  // ── audits ──
  ["*",    "/audits(/.*)?",                                       "audits:audit:view"],

  // ── authorization ──
  ["GET",  "/authorization/divisions",                            "authorization:division:view"],
  ["POST", "/authorization/divisions",                            "authorization:division:add"],
  ["POST", "/authorization/divisions/{id}/objects/{type}",        (m) => DIVISION_OBJECT_EDIT[String(m.type).toUpperCase()] || "authorization:division:edit"],
  ["GET",  "/authorization/permissions",                          "authorization:role:view"],
  ["GET",  "/authorization/roles(/{id}(/users)?)?",               "authorization:role:view"],
  ["POST", "/authorization/roles",                                "authorization:role:add"],
  ["POST", "/authorization/roles/{id}",                           "authorization:grant:add"],        // bulk grant subjects to a role
  ["PUT",  "/authorization/roles/{id}",                           "authorization:role:edit"],
  ["DELETE","/authorization/roles/{id}/subjectuser/{id}",         "authorization:grant:delete"],
  ["GET",  "/authorization/subjects/{id}(/grants)?",              "authorization:grant:view"],

  // ── billing ──
  ["GET",  "/billing/trusteebillingoverview/{id}",                "billing:subscription:view"],

  // ── conversations ──
  ["GET",  "/conversations/{id}",                                 "conversation:communication:view"],
  ["POST", "/conversations/{id}/disconnect",                      "conversation:communication:disconnect"],
  ["POST", "/conversations/{id}/participants/{id}/replace",       "conversation:communication:blindTransferQueue"],
  ["GET",  "/conversations/{id}/recordingmetadata",               "recording:recording:view"],

  // ── external contacts ──
  ["GET",  "/externalcontacts/contacts(/{id})?",                  "externalContacts:contact:view"],

  // ── flows ──
  ["GET",  "/flows",                                              "architect:flow:view"],
  ["GET",  "/flows/datatables(/{id})?",                           "architect:datatable:view"],
  ["POST", "/flows/datatables",                                   "architect:datatable:add"],
  ["PUT",  "/flows/datatables/{id}",                              "architect:datatable:edit"],
  ["DELETE","/flows/datatables/{id}",                             "architect:datatable:delete"],
  ["GET",  "/flows/datatables/{id}/rows(/{id})?",                 "architect:datatableRow:view"],
  ["POST", "/flows/datatables/{id}/rows",                         "architect:datatableRow:add"],
  ["PUT",  "/flows/datatables/{id}/rows/{id}",                    "architect:datatableRow:edit"],
  ["DELETE","/flows/datatables/{id}/rows/{id}",                   "architect:datatableRow:delete"],
  ["GET",  "/flows/milestones",                                   "architect:flowMilestone:view"],
  ["GET",  "/flows/outcomes",                                     "architect:flowOutcome:view"],
  ["GET",  "/flows/{id}",                                         "architect:flow:view"],
  ["DELETE","/flows/{id}",                                        "architect:flow:delete"],

  // ── gdpr ──
  ["GET",  "/gdpr/requests(/{id})?",                              "gdpr:request:view"],
  ["POST", "/gdpr/requests",                                      "gdpr:request:add"],
  ["GET",  "/gdpr/subjects",                                      "gdpr:subject:view"],

  // ── groups / teams ──
  ["GET",  "/groups(/.*)?",                                       "directory:group:view"],
  ["GET",  "/teams(/.*)?",                                        "groups:team:view"],

  // ── integrations ──
  ["GET",  "/integrations",                                       "integrations:integration:view"],
  ["GET",  "/integrations/actions(/.*)?",                         "integrations:action:view"],
  ["POST", "/integrations/actions(/drafts)?",                     "integrations:action:add"],
  ["POST", "/integrations/actions/{id}/(draft/)?test",            "integrations:action:execute"],
  ["*",    "/integrations/actions/{id}/draft(/publish)?",         "integrations:action:edit"],

  // ── journey ──
  ["POST", "/journey/flows/paths/query",                          "architect:flow:view"],

  // ── license ──
  ["*",    "/license(/.*)?",                                      "authorization:license:view"],

  // ── oauth ──
  ["GET",  "/oauth/clients(/{id})?",                              "oauth:client:view"],

  // ── org authorization (trustees) ──
  ["GET",  "/orgauthorization/trustees(/.*)?",                    "authorization:orgTrustee:view"],

  // ── outbound ──
  ["GET",  "/outbound/attemptlimits",                             "outbound:attemptLimits:view"],
  ["GET",  "/outbound/callabletimesets",                          "outbound:callableTimeSet:view"],
  ["GET",  "/outbound/callanalysisresponsesets",                  "outbound:callAnalysisResponseSet:view"],
  ["GET",  "/outbound/campaignrules",                             "outbound:campaignRule:view"],
  ["GET",  "/outbound/campaigns(/all)?",                          "outbound:campaign:view"],
  ["GET",  "/outbound/contactlistfilters",                        "outbound:contactListFilter:view"],
  ["GET",  "/outbound/contactlists",                              "outbound:contactList:view"],
  ["GET",  "/outbound/contactlisttemplates",                      "outbound:contactListTemplate:view"],
  ["GET",  "/outbound/dnclists",                                  "outbound:dncList:view"],
  ["GET",  "/outbound/messagingcampaigns",                        "outbound:messagingCampaign:view"],
  ["GET",  "/outbound/settings",                                  "outbound:settings:view"],
  ["GET",  "/outbound/wrapupcodemappings",                        "outbound:wrapUpCodeMapping:view"],
  ["PUT",  "/outbound/wrapupcodemappings",                        "outbound:wrapUpCodeMapping:edit"],

  // ── process automation ──
  ["GET",  "/processautomation/triggers(/{id})?",                 "processautomation:trigger:view"],

  // ── quality ──
  ["POST", "/quality/evaluations/search",                         "quality:evaluation:view"],
  ["GET",  "/quality/evaluators/activity",                        "quality:evaluation:view"],
  ["GET",  "/quality/forms/evaluations(/.*)?",                    "quality:evaluationForm:view"],
  ["GET",  "/quality/publishedforms/evaluations",                 "quality:evaluationForm:view"],
  ["GET",  "/quality/forms/surveys(/{id})?",                      "quality:surveyForm:view"],
  ["POST", "/quality/forms/surveys",                              "quality:surveyForm:add"],
  ["POST", "/quality/publishedforms/surveys",                     "quality:surveyForm:add"],
  ["GET",  "/quality/programs/{id}/agentscoringrules",            "quality:evaluation:view"],

  // ── recording ──
  ["GET",  "/recording/mediaretentionpolicies",                   "recording:retentionPolicy:view"],

  // ── response management ──
  ["GET",  "/responsemanagement/libraries",                       "responses:library:view"],
  ["GET",  "/responsemanagement/responses/{id}",                  "responses:response:view"],

  // ── routing ──
  ["GET",  "/routing/email/domains(/.*)?",                        "routing:email:view"],
  ["GET",  "/routing/email/outbound/domains",                     "routing:email:view"],
  ["GET",  "/routing/languages",                                  "routing:language:view"],
  ["POST", "/routing/languages",                                  "routing:language:add"],
  ["GET",  "/routing/message/recipients",                         "routing:message:view"],
  ["GET",  "/routing/queues(/{id})?",                             "routing:queue:view"],
  ["POST", "/routing/queues",                                     "routing:queue:add"],
  ["PATCH","/routing/queues/{id}",                                "routing:queue:edit"],
  ["PUT",  "/routing/queues/{id}",                                "routing:queue:edit"],
  ["*",    "/routing/queues/{id}/members",                        "routing:queueMember:manage"],
  ["POST", "/routing/queues/{id}/wrapupcodes",                    "routing:queue:edit"],
  ["GET",  "/routing/skillgroups",                                "routing:skillgroup:view"],
  ["GET",  "/routing/skills",                                     "routing:skill:view"],
  ["POST", "/routing/skills",                                     "routing:skill:add"],
  ["GET",  "/routing/users/{id}/directroutingbackup/settings",    "routing:directRoutingBackup:view"],
  ["PUT",  "/routing/users/{id}/directroutingbackup/settings",    "routing:directRoutingBackup:edit"],
  ["DELETE","/routing/users/{id}/directroutingbackup/settings",   "routing:directRoutingBackup:delete"],
  ["GET",  "/routing/wrapupcodes",                                "routing:wrapupCode:view"],
  ["POST", "/routing/wrapupcodes",                                "routing:wrapupCode:add"],
  ["PUT",  "/routing/wrapupcodes/{id}",                           "routing:wrapupCode:edit"],

  // ── scripts ──
  ["GET",  "/scripts(/.*)?",                                      "scripter:script:view"],
  ["POST", "/scripts/{id}/export",                                "scripter:script:view"],
  ["POST", "/scripts/published",                                  "scripter:publishedScript:add"],
  ["DELETE","/scripts/{id}",                                      "scripter:script:delete"],

  // ── speech & text analytics ──
  ["GET",  "/speechandtextanalytics/conversations/.*",            "speechAndTextAnalytics:data:view"],
  ["GET",  "/speechandtextanalytics/programs(/.*)?",              "speechAndTextAnalytics:program:view"],
  ["GET",  "/speechandtextanalytics/settings",                    "speechAndTextAnalytics:settings:view"],

  // ── stations ──
  ["GET",  "/stations",                                           TEL_VIEW],

  // ── task management ──
  ["POST", "/taskmanagement/workbins/query",                      "workitems:workbin:view"],
  ["POST", "/taskmanagement/worktypes/query",                     "workitems:worktype:view"],

  // ── telephony (edges) ──
  ["GET",  "/telephony/providers/edges/extensionpools",           ["telephony:extensionPool:view", ...TEL_VIEW]],
  ["GET",  "/telephony/providers/edges(/.*)?",                    TEL_VIEW],
  ["*",    "/telephony/providers/edges(/.*)?",                    TEL_ALL],

  // ── users ──
  ["GET",  "/users",                                              "directory:user:view"],
  ["POST", "/users",                                              "directory:user:add"],
  ["POST", "/users/search",                                       "directory:user:view"],
  ["GET",  "/users/{id}(/directreports)?",                        "directory:user:view"],
  ["GET",  "/users/{id}/queues",                                  "routing:queue:view"],
  ["PATCH","/users/{id}",                                         "directory:user:edit"],
  ["*",    "/users/{id}/routinglanguages(/.*)?",                  "routing:language:assign"],
  ["*",    "/users/{id}/routingskills(/.*)?",                     "routing:skill:assign"],

  // ── web deployments ──
  ["GET",  "/webdeployments/configurations",                      "webDeployments:configuration:view"],
  ["GET",  "/webdeployments/deployments",                         "webDeployments:deployment:view"],

  // ── workforce management ──
  ["GET",  "/workforcemanagement/businessunits",                  "wfm:businessUnit:view"],
  ["GET",  "/workforcemanagement/managementunits",                "wfm:managementUnit:view"],
];

const compiled = RULES.map(([methods, pattern, required]) => ({
  methods: new Set(methods === ANY ? ["*"] : methods.split(",")),
  re: new RegExp("^" + pattern.replace(/\{type\}/g, "(?<type>[^/]+)").replace(/\{id\}/g, "[^/]+") + "$"),
  required,
}));

/**
 * The permission(s) a call needs, or `undefined` when the table has no
 * rule for it. `null` means "none".
 */
function requiredFor(method, path) {
  const m = String(method || "GET").toUpperCase();
  const p = String(path || "").split("?")[0].replace(/^\/api\/v2/, "").replace(/\/+$/, "") || "/";
  for (const rule of compiled) {
    if (!(rule.methods.has("*") || rule.methods.has(m))) continue;
    const hit = rule.re.exec(p);
    if (!hit) continue;
    const req = typeof rule.required === "function" ? rule.required(hit.groups || {}) : rule.required;
    return req;
  }
  return undefined;
}

async function permissionsFor(context, token, region) {
  const key = tokenKey(token);
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  if (hit) cache.delete(key);
  const value = await fetchUserPermissions(token, region);
  if (value !== null) cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;   // null when unreadable — not cached, like the gate
}

/**
 * @param {Object} context
 * @param {{ token: string, region: string, method: string, path: string, superuser: boolean, userId?: string }} call
 * @returns {Promise<{ allowed: true } | { allowed: false, error: string, required?: string[] }>}
 */
async function checkProxyPermission(context, { token, region, method, path, superuser, userId }) {
  if (superuser) return { allowed: true };
  const enforce = enforced();
  const who = userId || "?";

  const required = requiredFor(method, path);
  if (required === null) return { allowed: true };
  if (required === undefined) {
    context?.log?.warn?.(`[proxy-perm] unmapped ${method} ${path} by ${who}${enforce ? " — refused" : ""}`);
    return enforce ? { allowed: false, error: "path_not_mapped" } : { allowed: true };
  }
  const list = Array.isArray(required) ? required : [required];

  const perms = await permissionsFor(context, token, region);
  if (perms === null) {
    context?.log?.warn?.(`[proxy-perm] permissions unreadable for ${who} on ${method} ${path}${enforce ? " — refused" : ""}`);
    return enforce ? { allowed: false, error: "permissions_unverified", required: list } : { allowed: true };
  }
  if (hasAnyPermission(perms, list)) return { allowed: true };

  context?.log?.warn?.(`[proxy-perm] ${who} lacks ${list.join(" | ")} for ${method} ${path}${enforce ? " — refused" : " (would refuse)"}`);
  return enforce ? { allowed: false, error: "permission_required", required: list } : { allowed: true };
}

/** For tests: forget every cached permission set. */
function clearPermissionCache() { cache.clear(); }

module.exports = { checkProxyPermission, requiredFor, clearPermissionCache, RULES };
