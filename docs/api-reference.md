# API Reference

Complete list of every API endpoint called by the Genesys Admin Tool, grouped by domain.

All Genesys Cloud calls are proxied through `POST /api/genesys-proxy` on the Azure Functions backend, which injects the customer-org access token. Direct calls to Genesys from the browser never occur.

---

## Table of Contents

1. [Internal App API](#1-internal-app-api)
2. [Analytics — Conversations](#2-analytics--conversations)
3. [Audits](#3-audits)
4. [Authorization & Divisions](#4-authorization--divisions)
5. [Users & Groups](#5-users--groups)
6. [Org Authorization (Trustee)](#6-org-authorization-trustee)
7. [Routing](#7-routing)
8. [Architect](#8-architect)
9. [Scripts](#9-scripts)
10. [Telephony / Edges](#10-telephony--edges)
11. [License](#11-license)
12. [Integrations & Data Actions](#12-integrations--data-actions)
13. [OAuth Clients](#13-oauth-clients)
14. [GDPR](#14-gdpr)
15. [Recording](#15-recording)
16. [Outbound](#16-outbound)
17. [Process Automation](#17-process-automation)
18. [Workforce Management](#18-workforce-management)
19. [Task Management](#19-task-management)
20. [Web Deployments](#20-web-deployments)
21. [Assistants / Agent Copilot](#21-assistants--agent-copilot)
22. [Response Management](#22-response-management)
23. [External Contacts](#23-external-contacts)
24. [Stations](#24-stations)
25. [Locations](#25-locations)
26. [Utilities](#26-utilities)
27. [Speech & Text Analytics](#27-speech--text-analytics)
28. [Journey](#28-journey)
29. [Billing](#29-billing)
30. [Onboarding Deployment](#30-onboarding-deployment)

---

## 1. Internal App API

These are the Azure Functions endpoints exposed by the app itself.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/customers` | Fetch the list of configured customer orgs |
| GET | `/api/org-config` | Resolve org context server-side. **Authenticated** (user token via `X-Genesys-Token`): returns `{ mode: "internal", org, customers }` for the internal org, or `{ mode: "customer", org, customer, entitlements }` for a registered customer org (org verified via `organizations/me`); `403 organization_not_recognized` otherwise. **Pre-login** (no token, `?org=<slug>`): returns `{ prelogin: true, login: { id, name, region, clientId } }` — the customer org's PUBLIC OAuth login config so the SPA can build the authorize URL before login. Never returns secrets, entitlements, or other orgs' data. |
| POST | `/api/genesys-proxy` | Proxy any Genesys Cloud API call. Mode is decided server-side from the caller's own token (never the request body): internal org → client-credentials (body `customerId` selects any org); customer org → token-forwarding locked to the caller's own org/region (`403 org_locked` on mismatch) with a customer request guard; unverified/absent token → `401`. |
| GET | `/api/ipranges?region={awsRegionCode}` | Genesys public IP ranges for a region. Resolves a configured customer org for the region's host, authenticates via client-credentials, and forwards `GET /api/v2/ipranges`. Injects four Cloud Media Services CIDRs as `CLOUD_MEDIA_SERVICES` entries for commercial regions. Returns 400 if no customer org is configured for the region. Adds `meta: { region, host, fetchedAt, cloudMediaInjected, cloudMediaSource }`. |
| GET | `/api/aws-ipranges` | Proxies the Amazon feed `https://ip-ranges.amazonaws.com/ip-ranges.json`. Anonymous; 15-min in-process cache (`?force=true` to bypass). Adds `meta: { fetchedAt, cached, ttlMs }`. |
| POST | `/api/doc-export` | On-demand Documentation export — body: `{ orgId, includeDataTables? }` — returns base64 workbook (XLSX or ZIP) |
| POST | `/api/send-email` | Send email with attachment via Mailjet |
| GET | `/api/scrape-disqualifying-permissions` | Scrape Genesys Cloud help page for Hourly Interacting disqualifying permissions; returns sorted JSON array; 24 h cache |
| GET | `/api/schedules?userEmail={email}` | List all saved export schedules (Azure Table Storage). Each row carries `canEdit` — whether that caller may edit or delete it (creator or admin). Decided server-side so the browser never needs the admin's address; omit `userEmail` and `canEdit` is `false` throughout. |
| POST | `/api/schedules` | Create a new export schedule. For `exportType: "queuesSkills"`, `exportConfig` supports optional arrays: `users`, `groups`, `teams`, `queues`, `skills`, `languages` (plus `*Labels` arrays for display summaries). |
| PUT | `/api/schedules/{id}` | Update an existing schedule. For `exportType: "queuesSkills"`, the same optional filter arrays are persisted and used by scheduled runs. |
| DELETE | `/api/schedules/{id}` | Delete a schedule |
| POST | `/api/scheduled-runner` | Trigger the scheduled export runner (called every 5 min by Azure Timer Trigger) |
| GET | `/api/activity-log` | Fetch internal activity log entries |
| POST | `/api/activity-log` | Write a new internal activity log entry |
| GET | `/api/feature-requests?board=mine` | The caller's own organisation's feature requests, in full. Scoped by `ownerOrgId`. |
| GET | `/api/feature-requests?board=shared` | Requests promoted to the shared board, as a **server-side redacted projection** — curated title/description, status, vote count, and the submitter as `Thomas V.` or `A customer`. The submitter's own wording, identity, org and page context are never sent. Any authenticated caller. |
| GET | `/api/feature-requests?board=all` | Every organisation's requests, unredacted — **superuser only** (`SUPERUSER_IDS` app setting, matched against the caller's token-derived user id). The triage queue; also triggers the 12-month retention purge. |
| GET | `/api/feature-requests/{id}` | One request: in full if it belongs to the caller's org, as a shared card if promoted, otherwise 404 (never 403 — confirming an id exists would leak another tenant's board). |
| POST | `/api/feature-requests` | Create — body: `{ title, description, type?, route?, pageLabel?, orgId?, orgName?, appVersion?, publishAnonymously? }`. Owner and identity come from the token, never the body; every request starts `private`/`new`. Capped at 120/4000 chars and 20 creates per user per 24h. |
| PUT | `/api/feature-requests/{id}` | Submitter edits their own `title`/`description`/`type` **while status is `new`** (409 after triage). Superuser sets `status`, `adminNote`, `shippedVersion`, `duplicateOf`, `visibility`, `sharedTitle`, `sharedDescription`. Promoting to `shared` without a `sharedTitle` is refused. |
| POST | `/api/feature-requests/{id}/vote` | Toggle the caller's vote. Permitted on anything the caller can see, so votes on a promoted request aggregate across every org. Idempotent by construction. |
| DELETE | `/api/feature-requests/{id}` | Delete a request — superuser only. |
| GET | `/api/templates?orgId={orgId}&userEmail={email}` | List all skill templates for an org (Azure Table Storage). Each row carries `canEdit` — see `/api/schedules`. |
| POST | `/api/templates` | Create a new skill template — body: `{ orgId, name, userEmail, roles, skills, languages, queues }` |
| PUT | `/api/templates/{id}` | Update an existing skill template (owner or admin only) |
| DELETE | `/api/templates/{id}?orgId={orgId}&userEmail={email}` | Delete a skill template (owner or admin only) |
| GET | `/api/template-assignments?orgId={orgId}` | List all template assignments for an org (users, groups, and work teams) |
| GET | `/api/template-assignments?orgId={orgId}&userId={userId}` | List template assignments for a specific user |
| POST | `/api/template-assignments` | Create a template assignment — body: `{ orgId, type, userId?, userName?, groupId?, groupName?, workteamId?, workteamName?, templateId, templateName, assignedBy }` — `type` is `"user"` (default), `"group"`, or `"workteam"`; the corresponding ID field is required per type |
| DELETE | `/api/template-assignments/{id}?orgId={orgId}` | Delete a template assignment by ID |
| DELETE | `/api/template-assignments?orgId={orgId}&userId={userId}&templateId={templateId}` | Delete a template assignment by user+template combo |
| DELETE | `/api/template-assignments?orgId={orgId}&groupId={groupId}&templateId={templateId}` | Delete a template assignment by group+template combo |
| DELETE | `/api/template-assignments?orgId={orgId}&workteamId={workteamId}&templateId={templateId}` | Delete a template assignment by work team+template combo |
| GET | `/api/template-schedules?orgId={orgId}&userEmail={email}` | List all template schedules for an org (Azure Table Storage). Each row carries `canEdit` — see `/api/schedules`. |
| GET | `/api/template-schedules/{id}` | Get a single template schedule by ID |
| POST | `/api/template-schedules` | Create a template schedule — body: `{ templateId, templateName, orgId, mode, scheduleType, scheduleTime, scheduleDayOfWeek?, scheduleDayOfMonth?, scheduleDate?, targets, enabled?, userEmail, userName }` — `mode` is `"reset"` or `"add"`; `scheduleType` is `"once"`, `"daily"`, `"weekly"`, or `"monthly"`; `targets` is an array of `{ type: "user" \| "group" \| "workteam", id, name }` (at least one required) |
| PUT | `/api/template-schedules/{id}` | Update a template schedule (owner or admin only) — body includes `userEmail` for ownership check; `targets` array can be updated |
| DELETE | `/api/template-schedules/{id}?userEmail={email}` | Delete a template schedule (owner or admin only) |
| POST | `/api/template-runner` | Execute a template schedule — body: `{ scheduleId }` — called by Azure Durable Functions activity; protected by `x-runner-key` header |
| POST | `/api/onboarding-deploy` | **Internal-only.** Create an onboarding-deployment job — body: `{ sourceOrgId, targetOrgId, divisionId, divisionName?, namePrefix?, stopForPreview?, startedBy?, startedByName?, startedById?, flows: [{ id, name, type }] }`. Validates the plan (orgs in `customers.json`, source ≠ target, every flow one of the 16 supported root types in `ROOT_FLOW_TYPES` — inbound call/chat/email/message, bot, digitalbot, commonmodule, the in-queue types, securecall, voicemail, workflow, workitem, voicesurvey, surveyinvite) and writes a queued job to the `onboardingjobs` Table Storage table. Returns `202 { jobId, status }`. Does **not** run the deploy — the onboarding runner picks it up. `stopForPreview: true` ("Preview and Deploy") always pauses for approval; otherwise the job pauses only if the preview finds a name conflict or a predicted failure. `startedBy*` is the operator identity the runner attributes the Activity Log entry to. Caller must be a verified internal user (same guard as the proxy's client-credentials path); customer sessions get `403 internal_only`. |
| POST | `/api/onboarding-deploy` (approve) | **Internal-only.** Body `{ action: "approve", jobId, decisions }` — resolves a job parked at `awaiting-approval` and re-queues it for the runner to deploy. `decisions` is keyed by collision id (`{ action: "existing" \| "new", name }`) plus a reserved `__suffix` key holding the suffix chosen for "create new". `409 not_awaiting_approval` if the job is in another state, `409 approval_expired` once the 30-minute window has passed (the cached export artifacts are gone by then, so it cannot be resumed). |
| POST | `/api/onboarding-deploy` (cancel) | **Internal-only.** Body `{ action: "cancel", jobId, userEmail?, userName?, userId? }` — abandons a parked job. Nothing was written, so this only records the outcome: an Activity Log entry under `deployment_onboarding_preview`, never the deploy action. |
| GET | `/api/onboarding-deploy?jobId={jobId}` | **Internal-only.** Poll a job's status — returns the stored job (`status`, per-object `phases`, `warnings`, `error`, plus `collisions` and `expiresAt` while parked). `status` is one of `queued`, `running`, `awaiting-approval`, `succeeded`, `partial`, `failed`, `expired`, `cancelled`. `404 job_not_found` if unknown. |
| POST | `/api/flow-yaml` | **Internal-only.** Returns the *structured* Archy YAML of a flow for the **Flow Overview** page — body: `{ orgId, flowName, flowType }`. The SWA function classifies the caller server-side (verified internal user required; customer/absent token → `401`/`403`) and forwards to the onboarding runner's `POST /api/export-yaml` using `RUNNER_BASE_URL` + a shared `x-export-key` (`EXPORT_YAML_KEY`). Returns `{ yaml, flowName, flowType }`. The flat REST `latestconfiguration` is deliberately **not** used because it omits implicit *Default* reconvergence links. Runs on the runner because the export needs the Flow Scripting SDK (Node 20+, one SDK session per child process). |

---

## 2. Analytics — Conversations

Used by: Interaction Search (Recent + Historical), Disconnect Interactions, Move Interactions, Interaction Totals

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v2/analytics/conversations/aggregates/query` | Conversation aggregates — pre-computed counts by dimension (Interaction Totals: `nConversations` grouped by `mediaType`, `originatingDirection`, `interactionType`; `nOffered` with `firstQueue` filter for non-voice ACD counts) |
| POST | `/api/v2/analytics/conversations/details/jobs` | Submit an async conversation search job (Historical Search — >48h; ranges >7 days are split into 7-day chunks, one job per chunk; Disconnect Interactions — historical phase, windows shifted to start after the 48 h cutoff) |
| GET | `/api/v2/analytics/conversations/details/jobs/{jobId}` | Poll async job status |
| GET | `/api/v2/analytics/conversations/details/jobs/{jobId}/results` | Fetch async job results (paginated) |
| POST | `/api/v2/analytics/conversations/details/query` | Synchronous conversation query (Recent Search — <48h; Disconnect Interactions — recent phase, 6-hour buckets within last 48 h) |
| GET | `/api/v2/conversations/{id}` | Get a single conversation by ID (Recent Search — lazy PD load on row expand; Transcript Search — fetch conversation details and communicationId for ID-mode search; Disconnect Interactions — per-conversation fetch during recent sync phase for accurate media-type detection) |
| POST | `/api/v2/conversations/{id}/disconnect` | Force-disconnect an active conversation |
| POST | `/api/v2/conversations/{id}/participants/{participantId}/replace` | Blind transfer (move interaction to a different queue) |

---

## 3. Audits

Used by: Audit — Search (including Export to Excel of filtered results)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/audits/query/servicemapping` | Load service map for async audit queries |
| GET | `/api/v2/audits/query/realtime/servicemapping` | Load service map for realtime audit queries |
| POST | `/api/v2/audits/query/realtime` | Synchronous audit query (date ranges ≤ 14 days) |
| POST | `/api/v2/audits/query` | Submit async audit query (date ranges > 14 days) |
| GET | `/api/v2/audits/query/{transactionId}` | Poll async audit job status |
| GET | `/api/v2/audits/query/{transactionId}/results` | Fetch async audit results (cursor-paginated) |

---

## 4. Authorization & Divisions

Used by: Divisions (all object types), Data Tables — Create, Data Tables — Edit, export pages, All Roles Export, Deployment — Basic, Roles — Compare (all three modes), Roles — Permissions vs. Users, Roles — Create, Roles — Edit, Skill Templates — Add Users To Templates, Utilities — Permission Catalog, WebRTC Phones — Create (division filter)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/authorization/divisions` | List all divisions |
| POST | `/api/v2/authorization/divisions` | **Create** a new division (Deployment — Basic) |
| GET | `/api/v2/authorization/roles` | List all authorization roles |
| GET | `/api/v2/authorization/roles?permission={domain}:{entity}:{action}` | Filter roles by a specific permission — returns roles whose policies match; used by Roles — Permissions vs. Users (Step 1) |
| GET | `/api/v2/authorization/roles/{roleId}` | Get a single role with full `permissionPolicies` (Roles — Compare, Roles — Compare Hourly Interacting, Roles — Edit pre-fill, Roles — Copy source pre-fill) |
| POST | `/api/v2/authorization/roles` | **Create** a new authorization role — body: `{ name, description, permissionPolicies }` (Roles — Create, Roles — Copy Same Org, Roles — Copy Between Orgs target) |
| PUT | `/api/v2/authorization/roles/{roleId}` | **Full-replace** an existing authorization role — same body shape (Roles — Edit) |
| GET | `/api/v2/authorization/permissions` | List the full permission catalog — domain/entity/action entries with `allowConditions` flag; used by Roles — Compare (Compare Roles + Hourly Interacting), Permissions vs. Users, Create, and Edit to expand wildcard policies, and by Utilities — Permission Catalog to list every `domain:entity:action` (paginated, `pageSize=100`, looped via `pageCount`) |
| GET | `/api/v2/authorization/roles/{roleId}/users` | List users assigned a specific role (Roles — Permissions vs. Users Step 2, Roles Export) |
| POST | `/api/v2/authorization/roles/{roleId}` | **Grant** a role to subjects with division scope. Payload must include real division IDs when scoping by division; do not send synthetic zero-GUID scope IDs (Deployment — Basic Users, Configure Users) |
| GET | `/api/v2/authorization/subjects/{subjectId}` | Get effective role grants for a user or group — returns `{ grants: [{ role: { id, name }, division }] }` at top level (Compare Users, Permissions vs. Users attribution, All Roles Export step 3 attribution) |
| POST | `/api/v2/authorization/divisions/{divisionId}/objects/{type}` | Move objects between divisions (Divisions pages) |

---

## 5. Users & Groups

Used by: All Groups Export, All Roles Export, Filtered on Role(s) Export, Trustee Export, Divisions — Users, Documentation Export, WebRTC Phones, Roles — Compare Users, Roles — Permissions vs. Users, Direct Routing — Add user(s), Skill Templates — Add Users To Templates, access control (group + permission refinement)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/users` | List users (paginated; supports `expand=skills,languages,station,division`) |
| POST | `/api/v2/users/search` | Search users by name/email — body: `{ query: [{ type: "CONTAINS"/"QUERY_STRING", fields: ["name","email"], value }] }` — response key is `results` (not `entities`); used by Compare Users picker, Configure Users |
| GET | `/api/v2/users/me` | Get current authenticated user and group memberships |
| GET | `/api/v2/users/me?expand=authorization` | Get the signed-in user's own effective permissions (`authorization.permissions` + `authorization.permissionPolicies`) — used by the access-control layer to gate write features by the user's Genesys permissions (see docs/customer-facing-plan.md §6) |
| GET | `/api/v2/users/{userId}` | Get a single user by ID |
| GET | `/api/v2/users/{userId}/directreports` | Get direct reports of a user (Configure Users — Reports To mode) |
| GET | `/api/v2/users/{userId}?expand=groups` | Get user with `groups` array inline — used to resolve group memberships for Compare Users and All Roles Export attribution (phase 2b) |
| PATCH | `/api/v2/users/{userId}` | Update user (e.g., change division) |
| GET | `/api/v2/groups` | List all groups |
| GET | `/api/v2/groups/{groupId}` | Get a single group by ID — used to resolve group display name in Compare Users and All Roles Export (group name for "Assigned by" column) |
| GET | `/api/v2/groups/{groupId}/members` | List members of a group — also the group filter on WebRTC Phones — Create and Change Site, which offer every group type the list returns |
| GET | `/api/v2/teams` | List all work teams (paginated) — used by Skill Templates — Add Users To Templates for work team assignment |
| GET | `/api/v2/teams/{teamId}/members` | List members of a work team — used by Add Users To Templates to apply/remove template for all team members |

---

## 6. Org Authorization (Trustee)

Used by: Trustee Export

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/orgauthorization/trustees` | List all trustee orgs |
| GET | `/api/v2/orgauthorization/trustees/{trusteeOrgId}/groups` | Get trustee groups for a specific org |

---

## 7. Routing

Used by: Interaction Search, Move Interactions, Disconnect Interactions, Divisions — Queues/Wrapup/Skills, Documentation Export, Deployment — Basic, Direct Routing — Add user(s), Wrapup Codes — Create/Edit/Mapping

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/routing/queues` | List queues (paginated) |
| POST | `/api/v2/routing/queues` | **Create** a routing queue (Deployment — Basic) |
| GET | `/api/v2/routing/queues/{queueId}` | Get a single queue (full object, includes version) |
| PATCH | `/api/v2/routing/queues/{queueId}` | Partial update a queue (e.g., division change) |
| PUT | `/api/v2/routing/queues/{queueId}` | Full queue update |
| POST | `/api/v2/routing/queues/{queueId}/members` | **Bulk-add members** to a queue (Deployment — Basic Users, Configure Users, batches of 100) |
| DELETE | `/api/v2/routing/queues/{queueId}/members` | **Remove** a member from a queue — body: `[{ id }]` (Configure Users — remove mode) |
| GET | `/api/v2/routing/skills` | List routing skills |
| POST | `/api/v2/routing/skills` | **Create** a routing skill (Deployment — Basic) |
| GET | `/api/v2/routing/languages` | List routing languages |
| POST | `/api/v2/routing/languages` | **Create** a routing language (Deployment — Basic) |
| GET | `/api/v2/routing/skillgroups` | List routing skill groups |
| POST | `/api/v2/users` | **Create** a user (Deployment — Basic) |
| GET | `/api/v2/users/{userId}` | **Get** a single user — version refresh before address PATCH (Deployment — Basic) |
| PATCH | `/api/v2/users/{userId}` | **Update** a user — name, state (restore deleted), addresses, extension, DID (Deployment — Basic) |
| POST | `/api/v2/authorization/roles/{roleId}` | **Grant** a role to a user per-role with division scope. In Configure Users (Add mode), each selected role requires at least one division before apply; requests only send real division IDs (Deployment — Basic, Configure Users) |
| DELETE | `/api/v2/authorization/roles/{roleId}/subjectuser/{userId}` | **Remove** a role grant from a user (Configure Users — remove mode) |
| PATCH | `/api/v2/users/{userId}/routingskills/bulk` | **Add** routing skills to a user (Deployment — Basic, Configure Users) |
| DELETE | `/api/v2/users/{userId}/routingskills/{skillId}` | **Remove** a routing skill from a user (Configure Users — remove mode) |
| PATCH | `/api/v2/users/{userId}/routinglanguages/bulk` | **Add** routing languages to a user (Configure Users) |
| DELETE | `/api/v2/users/{userId}/routinglanguages/{languageId}` | **Remove** a routing language from a user (Configure Users — remove mode) |
| GET | `/api/v2/authorization/subjects/{userId}/grants` | Get all role grants for a user — returns structured `{ roleId, roleName, divisionId, divisionName }` array (Configure Users — user detail) |
| GET | `/api/v2/users/{userId}/queues` | Get queues a user is a member of (Configure Users — user detail) |
| GET | `/api/v2/routing/wrapupcodes` | List wrapup codes |
| POST | `/api/v2/routing/wrapupcodes` | **Create** a wrap-up code (Deployment — Basic) |
| PUT | `/api/v2/routing/wrapupcodes/{codeId}` | **Update** a wrap-up code (Deployment — Basic) |
| POST | `/api/v2/routing/queues/{queueId}/wrapupcodes` | **Assign** wrap-up codes to a queue (Deployment — Basic) |
| GET | `/api/v2/routing/message/recipients` | List messaging recipients |
| GET | `/api/v2/routing/email/domains` | List inbound email domains (also used by Direct Routing to validate email addresses) |
| GET | `/api/v2/routing/email/outbound/domains` | List outbound email domains |
| GET | `/api/v2/routing/users/{userId}/directroutingbackup/settings` | Get agent-level direct routing backup settings (Direct Routing — Add user(s)) |
| PUT | `/api/v2/routing/users/{userId}/directroutingbackup/settings` | Set agent-level direct routing backup (type: USER/QUEUE, waitForAgent, agentWaitSeconds) |
| DELETE | `/api/v2/routing/users/{userId}/directroutingbackup/settings` | Remove agent-level direct routing backup |
| GET | `/api/v2/routing/email/domains/{domainId}/routes` | List email routes for a domain |

---

## 8. Architect

Used by: Data Tables — Create/Copy/Edit, Deployment — Data Tables, Divisions — Flows/DataTables/Schedules/etc., Documentation Export, Deployment — Basic, **Flows — Delete Flow**

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/flows` | List architect flows |
| GET | `/api/v2/flows/{id}` | Get a flow by ID (entity name resolution in audit; Delete Flow reads `publishedVersion` for its version + creator) |
| DELETE | `/api/v2/flows/{flowId}` | **Delete** a flow of any type (Delete Flow). No unpublish step is required |
| GET | `/api/v2/flows/outcomes` | List flow outcomes |
| GET | `/api/v2/flows/milestones` | List flow milestones |
| GET | `/api/v2/flows/datatables` | List data tables (add `?expand=schema` for full schema) |
| GET | `/api/v2/flows/datatables/{id}` | Get a single data table (with schema) |
| PUT | `/api/v2/flows/datatables/{id}` | Update a data table (incl. division change) |
| POST | `/api/v2/flows/datatables` | **Create** a new data table |
| GET | `/api/v2/flows/datatables/{id}/rows` | List rows of a data table |
| POST | `/api/v2/flows/datatables/{id}/rows` | Insert a row into a data table |
| PUT | `/api/v2/flows/datatables/{id}/rows/{rowKey}` | Replace a single row by row key (Data Tables — Edit, Rows mode save) |
| DELETE | `/api/v2/flows/datatables/{id}/rows/{rowKey}` | Delete a single row by row key (Data Tables — Edit, Delete Selected / key-change replace flow) |
| GET | `/api/v2/architect/ivrs` | List IVRs (Call Routing) |
| GET | `/api/v2/architect/schedules` | List routing schedules |
| POST | `/api/v2/architect/schedules` | **Create** a routing schedule (Deployment — Basic) |
| PUT | `/api/v2/architect/schedules/{scheduleId}` | **Update** a routing schedule (Deployment — Basic) |
| GET | `/api/v2/architect/schedulegroups` | List routing schedule groups |
| POST | `/api/v2/architect/schedulegroups` | **Create** a routing schedule group (Deployment — Basic) |
| PUT | `/api/v2/architect/schedulegroups/{groupId}` | **Update** a routing schedule group (Deployment — Basic) |
| GET | `/api/v2/architect/emergencygroups` | List emergency groups |
| GET | `/api/v2/architect/prompts` | List architect prompts |
| DELETE | `/api/v2/flows/datatables/{id}` | **Delete** a data table, rows included (Delete Flow) |
| DELETE | `/api/v2/architect/prompts/{promptId}?allResources=true` | **Delete** a user prompt (Delete Flow). `allResources` is **required** — without it Genesys refuses while the prompt still holds its own per-language resources |

### 8.1 Dependency Tracking

Used by: **Flows — Delete Flow**. The index that answers what a flow uses and
what uses an object. Built asynchronously by Genesys; `status` must be
`OPERATIONAL` before any answer can be trusted. `dateCompleted` refers to the
last *full* rebuild and is routinely years old — publishing updates the index
incrementally, so an old date is **not** a staleness signal.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/architect/dependencytracking/build` | Index build status (`status`, `dateCompleted`, `failedObjects`) |
| GET | `/api/v2/architect/dependencytracking/consumedresources` | What an object uses. Requires `id`, `objectType`, `version` |
| GET | `/api/v2/architect/dependencytracking/consumingresources` | What uses an object — the orphan test. Same required params |

Three constraints learned the hard way, all load-bearing:

- **`version` is required**, and answers are **scoped to it**. Each flow has its
  own version, and a caller may reference an older one than the object's
  current — so consumers are queried across every known version and unioned. A
  single-version query reported *zero* consumers for a common module a flow was
  actively calling.
- **There is no generic `FLOW` objectType.** Values are per type
  (`INBOUNDCALLFLOW`, `COMMONMODULEFLOW`, …); scripts are `COMPOSERSCRIPT`,
  prompts `USERPROMPT`, workitem flows `WORKITEMFLOW`.
- **Results include platform vocabulary** — `FLOWACTION`, `FLOWDATATYPE`,
  `LANGUAGE`, `SYSTEMPROMPT`, `TTSENGINE`/`TTSVOICE`/`STTENGINE`. A single flow
  pulls in 50+ of these; they exist in every org and are filtered out.
- **It does not index every attachment.** A flow attached to a web/messaging
  deployment reports no consumers at all, so attachments are probed separately
  (see §7 Routing, §10 Telephony).

---

## 9. Scripts

Used by: Divisions — Scripts, Documentation Export, Flows — Delete Flow

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/scripts` | List scripts (supports `?status=PUBLISHED`) |
| DELETE | `/api/v2/scripts/{scriptId}` | **Delete** a script (Delete Flow) |

---

## 10. Telephony / Edges

Used by: WebRTC Phones — Create/Change Site, Documentation Export, Divisions — Extension Pools, Deployment — Basic

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/telephony/providers/edges/sites` | List sites |
| POST | `/api/v2/telephony/providers/edges/sites` | **Create** a site (Deployment — Basic) |
| GET | `/api/v2/telephony/providers/edges/sites/{id}/outboundroutes` | List outbound routes for a site (Deployment — Basic) |
| POST | `/api/v2/telephony/providers/edges/sites/{id}/outboundroutes` | Create an outbound route on a site (Deployment — Basic) |
| PUT | `/api/v2/telephony/providers/edges/sites/{id}/outboundroutes/{routeId}` | Update an outbound route on a site (Deployment — Basic) |
| GET | `/api/v2/telephony/providers/edges/trunkbasesettings` | List trunk base settings — name→ID lookup for outbound routes (Deployment — Basic) |
| GET | `/api/v2/telephony/providers/edges/sites/{id}/numberplans` | Read existing number plans for a site (Deployment — Basic) |
| PUT | `/api/v2/telephony/providers/edges/sites/{id}/numberplans` | Replace all number plans for a site (Deployment — Basic, merged with existing defaults) |
| GET | `/api/v2/telephony/providers/edges/didpools` | List DID pools |
| POST | `/api/v2/telephony/providers/edges/didpools` | **Create** a DID pool (Deployment — Basic) |
| GET | `/api/v2/telephony/providers/edges/didpools/dids` | List DID numbers (assigned and unassigned) |
| GET | `/api/v2/telephony/providers/edges/phonebasesettings` | List phone base settings |
| GET | `/api/v2/telephony/providers/edges/phonebasesettings/{id}` | Get a phone base setting (includes line templates) |
| GET | `/api/v2/telephony/providers/edges/phones` | List phones (paginated). **`siteId` is documented by the platform SDK but is NOT honoured in practice** — observed 2026-08-13: one request per site returned the full org list each time, tripling the counts on a 3-site selection. Filter by site in JS instead. Other documented filters (`phoneBaseSettingsId`, `webRtcUserId`, `linesId`, `name`) are unverified; `expand` values are undocumented — do not guess one in. **The list does not reliably return `webRtcUser`, and `site` may carry an id without a name** — use `GET .../phones/{id}` for the holder (see `js/lib/phoneHolders.js`) and resolve site names from the sites list |
| POST | `/api/v2/telephony/providers/edges/phones` | Create a phone |
| GET | `/api/v2/telephony/providers/edges/phones/{id}` | Get a phone by ID — the only reliable source of a phone's `webRtcUser`/`owner` |
| DELETE | `/api/v2/telephony/providers/edges/phones/{id}` | **Delete** a phone and its lines (WebRTC Phones — Delete). Irreversible. A 404 is treated as already gone |
| PUT | `/api/v2/telephony/providers/edges/phones/{id}` | Update a phone (e.g., change site) |
| GET | `/api/v2/telephony/providers/edges/trunkbasesettings` | List trunk base settings |
| GET | `/api/v2/telephony/providers/edges/extensionpools` | List extension pools |

---

## 11. License

Used by: License Consumption Export, WebRTC Phones — Create

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/license/users` | Per-user license consumption (paginated). Entities are `{ id, licenses: ["genesysCloudCX2", …] }` — **`licenses` is an array of id strings, not objects**; reading `.name`/`.id` off them yields `undefined` |
| GET | `/api/v2/license/definitions` | List all available license definitions |

---

## 12. Integrations & Data Actions

Used by: Data Actions — Copy between Orgs, Data Actions — Edit, Documentation Export

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/integrations` | List all integrations |
| GET | `/api/v2/integrations/actions` | List all published data actions |
| GET | `/api/v2/integrations/actions/drafts` | List all draft data actions |
| POST | `/api/v2/integrations/actions` | Create a published data action (copy) |
| POST | `/api/v2/integrations/actions/drafts` | Create a draft data action |
| GET | `/api/v2/integrations/actions/{id}` | Get a published data action (use `?expand=contract&includeConfig=true` for full contract + config) |
| GET | `/api/v2/integrations/actions/{id}/draft` | Get the draft of a data action |
| PUT | `/api/v2/integrations/actions/{id}/draft` | Update a data action draft |
| PATCH | `/api/v2/integrations/actions/{id}/draft` | Patch a data action draft (`UpdateDraftInput`: name, category, integrationId, secure, version, contract, config) — used by Copy between Orgs to write the full config after `POST /drafts` |
| GET | `/api/v2/integrations/actions/{id}/templates/requesttemplate.vm` | Fetch raw request Velocity template (inlined by Copy between Orgs when source action stores templates as file references) |
| GET | `/api/v2/integrations/actions/{id}/templates/successtemplate.vm` | Fetch raw success Velocity template (inlined by Copy between Orgs) |
| POST | `/api/v2/integrations/actions/{id}/draft/validation` | Validate a draft action |
| POST | `/api/v2/integrations/actions/{id}/draft/publish` | Publish a draft action |
| POST | `/api/v2/integrations/actions/{id}/test` | Run a test against a published action |
| POST | `/api/v2/integrations/actions/{id}/draft/test` | Run a test against a draft action |

---

## 13. OAuth Clients

Used by: Documentation Export, Audit — Search (entity name resolution)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/oauth/clients` | List all OAuth clients |
| GET | `/api/v2/oauth/clients/{clientId}` | Get a single OAuth client by ID |

---

## 14. GDPR

Used by: GDPR — Subject Request, GDPR — Request Status

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/gdpr/subjects` | Search for GDPR data subjects by identifier |
| POST | `/api/v2/gdpr/requests` | Submit a GDPR data subject request (Articles 15, 16, 17) |
| GET | `/api/v2/gdpr/requests` | List all previously submitted GDPR requests |
| GET | `/api/v2/gdpr/requests/{requestId}` | Get a single GDPR request by ID — returns `resultsUrl` (string) and/or `resultsUrls` (array) for fulfilled Access exports; used by Request Status to retrieve download URLs |

---

## 15. Recording

Used by: Documentation Export

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/recording/mediaretentionpolicies` | List media retention policies |

---

## 16. Outbound

Used by: Divisions — Outbound pages, Documentation Export, Wrapup Codes — Create/Edit/Mapping

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/outbound/campaigns` | List outbound voice campaigns |
| GET | `/api/v2/outbound/campaigns/all` | List all campaigns (voice + email + messaging combined) |
| GET | `/api/v2/outbound/contactlists` | List contact lists |
| GET | `/api/v2/outbound/contactlistfilters` | List contact list filters |
| GET | `/api/v2/outbound/contactlisttemplates` | List contact list templates |
| GET | `/api/v2/outbound/dnclists` | List DNC (Do Not Contact) lists |
| GET | `/api/v2/outbound/attemptlimits` | List attempt limit sets |
| GET | `/api/v2/outbound/callabletimesets` | List callable time sets |
| GET | `/api/v2/outbound/callanalysisresponsesets` | List call analysis response sets |
| GET | `/api/v2/outbound/campaignrules` | List campaign rules |
| GET | `/api/v2/outbound/messagingcampaigns` | List messaging campaigns |
| GET | `/api/v2/outbound/settings` | Get global outbound settings |
| GET | `/api/v2/outbound/wrapupcodemappings` | Get Dialer wrap-up code mapping document (includes `defaultSet`, `mapping`, `version`) |
| PUT | `/api/v2/outbound/wrapupcodemappings` | Update Dialer wrap-up code mapping document (full-body update, requires current `version`) |

---

## 17. Process Automation

Used by: Documentation Export (Triggers sheet), Audit — Search (entity name resolution)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/processautomation/triggers` | List all event triggers |
| GET | `/api/v2/processautomation/triggers/{id}` | Get a trigger by ID (entity name resolution) |

---

## 18. Workforce Management

Used by: Divisions — Business Units / Management Units, Documentation Export

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/workforcemanagement/businessunits` | List business units |
| GET | `/api/v2/workforcemanagement/managementunits` | List management units |

---

## 19. Task Management

Used by: Divisions — Workbins / Work Types

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v2/taskmanagement/workbins/query` | Query workbins (POST-based pagination) |
| POST | `/api/v2/taskmanagement/worktypes/query` | Query work types (POST-based pagination) |

---

## 20. Web Deployments

Used by: Documentation Export, Flows — Delete Flow

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/webdeployments/configurations` | List web deployment configurations (published only) |
| GET | `/api/v2/webdeployments/deployments` | List web deployments. **Delete Flow reads `flow.id`** — a deployment holding a flow is invisible to Dependency Tracking, so this is the only thing preventing a deployed messaging flow from reading as free to delete |

---

## 21. Assistants / Agent Copilot

Used by: Documentation Export (Agent Copilots sheet)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/assistants` | List agent copilot assistants (cursor pagination) |
| GET | `/api/v2/assistants/queues` | List queue assignments for assistants (cursor pagination) |

---

## 22. Response Management

Used by: Documentation Export (Responses/Libraries sheet)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/responsemanagement/libraries` | List response libraries |
| GET | `/api/v2/responsemanagement/responses/{libraryId}` | Get responses within a library |

---

## 23. External Contacts

Used by: Audit — Search (entity name resolution)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/externalcontacts/contacts` | List external contacts (cursor-based pagination) |
| GET | `/api/v2/externalcontacts/contacts/{contactId}` | Get an external contact by ID |

---

## 24. Stations

Used by: Documentation Export (Users sheet — station name resolution via `associatedStation` fallback when user is offline)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/stations` | List all stations |

---

## 25. Locations

Used by: Deployment — Basic (resolves location names to IDs for site creation)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/locations` | List all configured locations |

---

## 26. Utilities

Used by: Deployment — Basic (Schedule Groups timezone validation), Utilities — IP Ranges

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/timezones` | List all valid Genesys Cloud timezone IDs (used to validate Schedule Group timezone before API call) |
| GET | `/api/v2/ipranges` | Public IP ranges (CIDR blocks) for the regional host. Called server-side by `GET /api/ipranges` with a client-credentials token for a configured customer org in that region (never called directly from the browser). |

---

## 27. Speech & Text Analytics

Used by: Transcript Search

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/speechandtextanalytics/conversations/{id}/communications/{commId}/transcripturl` | Check whether a STA transcript exists for a specific communication. HTTP 200 = transcript exists and returns a pre-signed S3 URL; HTTP 404 = no transcript. Called in parallel batches of 10 per conversation result row. |
| GET | `{s3PreSignedUrl}` | Fetch the full transcript JSON content from AWS S3 using the pre-signed URL returned above. Direct browser request — no Authorization header. Called on-demand when the user expands a row to read the transcript. |

---

## 28. Journey

Used by: Flows — Journey Flow

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v2/journey/flows/paths/query` | Query journey-flow path data for an Architect flow. Body includes `flowId`, `category` (All/Abandoned/AgentEscalation/Complete/Disconnect/Error/RecognitionFailure/Transfer), and date range. All 8 categories are fetched in parallel on load and cached client-side. |

---

## 29. Billing

Used by: Billing — Single Org, All Orgs (Latest), Calendar Year, Date Range, Custom Orgs, Period Comparison.

All billing exports use the **trustee billing overview** endpoint, which must be called as the **trustee** organisation (the one that holds the billing relationship for the target customer org). The trustee customer for each org is configured in `api/lib/customers.json::trusteeForOrg`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/organizations/me` | Resolve the **trustor org ID** when called with the trustor org's own credentials. The billing overview endpoint takes this org ID in the URL path. |
| GET | `/api/v2/billing/trusteebillingoverview/{trustorOrgId}?billingPeriodIndex={N}` | Fetch the billing overview for one period. Called as the **trustee** customer (token injected from `customers.json::trusteeForOrg`). `billingPeriodIndex`: `0` = current in-progress period, `1` = latest complete, `2` = two ago, `3` = three ago, etc. Browser caches periods 0..3 via `js/services/billingService.js::fetchBillingPeriods`. Returns metadata (`billingPeriodStartDate`, `billingPeriodEndDate`), license usage, and AI token rollup which the processor (`js/utils/billingProcessor.js` / `api/lib/billingWorkbook.js`) translates into Regular Licenses, AI Tokens Breakdown, and Items with Overage sections. Returns 404 when the requested period does not exist — used as the stop condition when walking older indices for Calendar Year and Date Range exports. |

---

## 30. Onboarding Deployment

Used by: Deployment — Onboarding (internal only).

The **Deployment — Onboarding** feature replicates a set of Architect callflows (and everything they depend on) from the Demo org into a customer org, stripping the `Template - ` prefix and optionally applying an operator-supplied name prefix. The browser only calls the internal endpoints in [§1](#1-internal-app-api) (`POST`/`GET /api/onboarding-deploy`, plus the `approve`/`cancel` POST actions); the minutes-long work runs in a dedicated background **onboarding runner** Function App that processes queued jobs from the `onboardingjobs` table.

The runner authenticates to each org with client credentials (`GENESYS_<ORG>_CLIENT_ID/_SECRET`) and performs the Genesys Cloud operations below. Flows themselves are created and published with the **Genesys Flow Scripting SDK** (`purecloud-flow-scripting-api-sdk-javascript`, run in a child process per org — one Scripting session is one org, so export from Demo and publish to the customer run as separate processes) — **not** via REST — so only the supporting REST calls are listed here.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/flows?nameOrDescription={name}` | Resolve a referenced flow's type by exact name (transfer-target discovery); also used to skip flows that already exist in the target |
| GET | `/api/v2/flows/{id}` | Verify a published flow actually persisted in the target org (type-agnostic existence check after each SDK publish) |
| GET | `/api/v2/flows/datatables?expand=schema` | List source data tables + schema for dependency resolution |
| POST | `/api/v2/flows/datatables` | Create a renamed data table in the target org |
| GET | `/api/v2/flows/datatables/{id}/rows` | Read source rows to copy |
| POST | `/api/v2/flows/datatables/{id}/rows` | Insert copied rows into the target table |
| GET | `/api/v2/integrations` | List target integrations to match a data action's integration by type/name |
| GET | `/api/v2/integrations/actions` | List source data actions referenced by a flow |
| POST | `/api/v2/integrations/actions` | Create a renamed data action in the target org |
| GET | `/api/v2/scripts` | List source/target scripts (screen-pop references) |
| POST | `/api/v2/scripts/{id}/export` | Get a temporary export URL for a source script |
| POST | `uploads/v2/scripter` | Multipart upload to import a script into the target org (apps host, not under `/api/v2`) |
| GET | `/api/v2/scripts/uploads/{uploadId}/status` | Poll the script-import status |
| POST | `/api/v2/scripts/published?scriptDataVersion=0` | Publish an imported script (body `{ scriptId }`) so flows can reference it |
| GET | `/api/v2/quality/forms/surveys` | List source/target survey forms (for voice-survey flows) |
| GET | `/api/v2/quality/forms/surveys/{id}` | Get a source survey form definition to copy |
| POST | `/api/v2/quality/forms/surveys` | Create a renamed survey form in the target org |
| POST | `/api/v2/quality/publishedforms/surveys` | Publish a survey form (body `{ id, published: true }`) — a voice-survey flow is generated from its published form |
| GET | `/api/v2/architect/prompts` | List source/target **user prompts**, to resolve prompts a flow references directly and to detect name conflicts in the target |
| GET | `/api/v2/architect/prompts/{promptId}/resources` | Read a source prompt's per-language resources (TTS text, tags) to copy |
| POST | `/api/v2/architect/prompts` | Create a user prompt in the target org (body `{ name, description }`) |
| POST | `/api/v2/architect/prompts/{promptId}/resources` | Add one language resource (body `{ language, ttsString?, text?, tags? }`) — **audio is never copied**, see below |
| GET | `/api/v2/authorization/divisions` | Resolve the target division; the operator can also **create** one via `POST` (see [§4](#4-authorization--divisions)) from the page |

**Preview before deploy:** every job runs a preview pass first that resolves names, checks what already exists in the target and matches integrations, **performing no writes**. It then either parks at `awaiting-approval` (always for *Preview and Deploy*; otherwise only on a name conflict or a failure the preview proved will happen) or continues straight into the deploy. The same code path performs both modes — only the create/publish calls are guarded — so the preview cannot drift from the real deploy. A parked job expires after 30 minutes; its exported artifacts are cached under `%HOME%\data` with the same TTL, so an approved job deploys exactly the snapshot that was previewed without re-exporting anything.

**Prompts:** a user prompt referenced *directly* by a flow action (`prompt: Prompt.<Name>` in the Archy YAML, and by id in the `.i3` — confirmed: the `.i3` stores prompt references as GUIDs, which the runner remaps) is created in the target with its description and every language resource's TTS text and tags. **The recorded audio is deliberately not copied** — customers record their own — so a copied prompt carries the wording but no media. A source resource that has *only* a recording would therefore land empty, and Architect rejects any flow referencing a prompt with nothing to play (`Error in sequence item 1 for Audio`); such resources are given the prompt's own name as **placeholder wording**, reported per language in the phase item and as a job warning. The placeholder is self-clearing — a recorded audio resource takes precedence over the TTS string, so it is never heard once the customer records over it. Prompt names are identifiers, so the `Template - ` strip and the operator name prefix are both skipped and the name is carried across verbatim; a "create new" conflict choice suffixes with `_2` rather than ` (2)`. **System prompts are not handled** — they exist in every org, so there is nothing to copy. Prompts resolved *dynamically* at runtime (`FindUserPrompt(<variable>)`, where the name comes from a data table cell) are **out of scope**: those names are row data, not flow content, and cannot be discovered from the flow.

**Not supported:** outbound-call flows — their contact-list dependency is a flow *setting* referenced by GUID (not a name-based reference) and cannot be remapped, so outbound flows are deliberately excluded from the callflow picker.

---

## Notes

- **Pagination**: Most list endpoints use offset pagination (`pageNumber`/`pageSize`). Exceptions: External Contacts and Assistants use **cursor pagination** (`nextUri`). Task Management (Workbins/Work Types) uses **POST-based queries**.
- **Proxying**: All Genesys calls go through `POST /api/genesys-proxy`, which adds `Authorization: Bearer <token>` for the selected org and forwards the request to the correct Genesys region.
- **Entity name resolution**: The Audit — Search page resolves entity names for 40+ entity types by calling the appropriate `GET /api/v2/{path}/{id}` endpoint on-demand when a row is expanded.
- **Server-side endpoints**: Endpoints in sections 2, 4, 5, 7–27, 29 that are also called from `api/lib/exports/` run server-side during scheduled export execution (including Documentation Export and the billing exports) — not from the browser.
- **Registered export handlers**: The `api/lib/exportHandlers.js` registry maps export type strings to handler modules. Registered types: `allGroups`, `allRoles`, `billingAllOrgsLatest`, `billingCalendarYear`, `billingSingleOrg`, `documentation`, `filteredRoles`, `interactionTotals`, `licensesConsumption`, `rolesSingleOrg`, `lastLogin`, `trustee`, `skillTemplates`.
- **Outbound email**: every message the app sends goes through `api/lib/mailer.js`, the single Mailjet caller. `POST /api/send-email` is the HTTP front for it (token required, callers choose recipients); the scheduled runner calls the module directly with no HTTP hop. Note that Mailjet fails in two ways — the request can fail, and a `200` can still carry `Messages[0].Status === "error"` — and the module reports both as `{ success: false, error, reason }`. A caller that checks only the HTTP status reports success for mail that was never sent.
- **Billing trustee resolution**: Billing exports require the call to be authenticated as the **trustee** customer for the target org. The mapping is stored in `api/lib/customers.json::trusteeForOrg`. If the target customer is itself a trustee (no entry), the export is blocked client-side (`isTrusteeOrg(orgId)` in `js/utils/billingTrustees.js`).
