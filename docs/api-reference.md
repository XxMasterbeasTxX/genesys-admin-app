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

---

## 1. Internal App API

These are the Azure Functions endpoints exposed by the app itself.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/customers` | Fetch the list of configured customer orgs |
| POST | `/api/genesys-proxy` | Proxy any Genesys Cloud API call with injected org token |
| POST | `/api/doc-export` | On-demand Documentation export — body: `{ orgId, includeDataTables? }` — returns base64 workbook (XLSX or ZIP) |
| POST | `/api/send-email` | Send email with attachment via Mailjet |
| GET | `/api/scrape-disqualifying-permissions` | Scrape Genesys Cloud help page for Hourly Interacting disqualifying permissions; returns sorted JSON array; 24 h cache |
| GET | `/api/schedules` | List all saved export schedules (Azure Table Storage) |
| POST | `/api/schedules` | Create a new export schedule |
| PUT | `/api/schedules/{id}` | Update an existing schedule |
| DELETE | `/api/schedules/{id}` | Delete a schedule |
| POST | `/api/scheduled-runner` | Trigger the scheduled export runner (called hourly by GitHub Actions) |
| GET | `/api/activity-log` | Fetch internal activity log entries |
| POST | `/api/activity-log` | Write a new internal activity log entry |

---

## 2. Analytics — Conversations

Used by: Interaction Search (Recent + Historical), Disconnect Interactions, Move Interactions

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v2/analytics/conversations/details/jobs` | Submit an async conversation search job (Historical Search — >48h) |
| GET | `/api/v2/analytics/conversations/details/jobs/{jobId}` | Poll async job status |
| GET | `/api/v2/analytics/conversations/details/jobs/{jobId}/results` | Fetch async job results (paginated) |
| POST | `/api/v2/analytics/conversations/details/query` | Synchronous conversation query (Recent Search — <48h) |
| GET | `/api/v2/conversations/{id}` | Get a single conversation by ID (Recent Search — lazy PD load on row expand; Transcript Search — fetch conversation details and communicationId for ID-mode search) |
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

Used by: Divisions (all object types), Data Tables — Create, export pages, All Roles Export, Deployment — Basic, Roles — Compare (both modes), Roles — Permissions vs. Users, Roles — Create, Roles — Edit

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/authorization/divisions` | List all divisions |
| POST | `/api/v2/authorization/divisions` | **Create** a new division (Deployment — Basic) |
| GET | `/api/v2/authorization/roles` | List all authorization roles |
| GET | `/api/v2/authorization/roles?permission={domain}:{entity}:{action}` | Filter roles by a specific permission — returns roles whose policies match; used by Roles — Permissions vs. Users (Step 1) |
| GET | `/api/v2/authorization/roles/{roleId}` | Get a single role with full `permissionPolicies` (Roles — Compare, Roles — Edit pre-fill, Roles — Copy source pre-fill) |
| POST | `/api/v2/authorization/roles` | **Create** a new authorization role — body: `{ name, description, permissionPolicies }` (Roles — Create, Roles — Copy Same Org, Roles — Copy Between Orgs target) |
| PUT | `/api/v2/authorization/roles/{roleId}` | **Full-replace** an existing authorization role — same body shape (Roles — Edit) |
| GET | `/api/v2/authorization/permissions` | List the full permission catalog — domain/entity/action entries with `allowConditions` flag; used by Roles — Compare, Permissions vs. Users, Create, and Edit to expand wildcard policies (paginated, `pageSize=100`, looped via `pageCount`) |
| GET | `/api/v2/authorization/roles/{roleId}/users` | List users assigned a specific role (Roles — Permissions vs. Users Step 2, Roles Export) |
| POST | `/api/v2/authorization/roles/{roleId}` | **Grant** a role to subjects with division scope (Deployment — Basic Users) |
| GET | `/api/v2/authorization/subjects/{subjectId}` | Get effective role grants for a user or group — returns `{ grants: [{ role: { id, name }, division }] }` at top level (Compare Users, Permissions vs. Users attribution, All Roles Export step 3 attribution) |
| POST | `/api/v2/authorization/divisions/{divisionId}/objects/{type}` | Move objects between divisions (Divisions pages) |

---

## 5. Users & Groups

Used by: All Groups Export, All Roles Export, Filtered on Role(s) Export, Trustee Export, Divisions — Users, Documentation Export, WebRTC Phones, Roles — Compare Users, Roles — Permissions vs. Users, Direct Routing — Add user(s)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/users` | List users (paginated; supports `expand=skills,languages,station,division`) |
| POST | `/api/v2/users/search` | Search users by name/email — body: `{ query: [{ type: "CONTAINS", fields: ["name","email"], value }] }` — response key is `results` (not `entities`); used by Compare Users picker |
| GET | `/api/v2/users/me` | Get current authenticated user and group memberships |
| GET | `/api/v2/users/{userId}` | Get a single user by ID |
| GET | `/api/v2/users/{userId}?expand=groups` | Get user with `groups` array inline — used to resolve group memberships for Compare Users and All Roles Export attribution (phase 2b) |
| PATCH | `/api/v2/users/{userId}` | Update user (e.g., change division) |
| GET | `/api/v2/groups` | List all groups |
| GET | `/api/v2/groups/{groupId}` | Get a single group by ID — used to resolve group display name in Compare Users and All Roles Export (group name for "Assigned by" column) |
| GET | `/api/v2/groups/{groupId}/members` | List members of a group |
| GET | `/api/v2/teams` | List work teams |

---

## 6. Org Authorization (Trustee)

Used by: Trustee Export

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/orgauthorization/trustees` | List all trustee orgs |
| GET | `/api/v2/orgauthorization/trustees/{trusteeOrgId}/groups` | Get trustee groups for a specific org |

---

## 7. Routing

Used by: Interaction Search, Move Interactions, Disconnect Interactions, Divisions — Queues/Wrapup/Skills, Documentation Export, Deployment — Basic, Direct Routing — Add user(s)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/routing/queues` | List queues (paginated) |
| POST | `/api/v2/routing/queues` | **Create** a routing queue (Deployment — Basic) |
| GET | `/api/v2/routing/queues/{queueId}` | Get a single queue (full object, includes version) |
| PATCH | `/api/v2/routing/queues/{queueId}` | Partial update a queue (e.g., division change) |
| PUT | `/api/v2/routing/queues/{queueId}` | Full queue update |
| POST | `/api/v2/routing/queues/{queueId}/members` | **Bulk-add members** to a queue (Deployment — Basic Users, batches of 100) |
| GET | `/api/v2/routing/skills` | List routing skills |
| POST | `/api/v2/routing/skills` | **Create** a routing skill (Deployment — Basic) |
| GET | `/api/v2/routing/languages` | List routing languages |
| POST | `/api/v2/routing/languages` | **Create** a routing language (Deployment — Basic) |
| GET | `/api/v2/routing/skillgroups` | List routing skill groups |
| POST | `/api/v2/users` | **Create** a user (Deployment — Basic) |
| GET | `/api/v2/users/{userId}` | **Get** a single user — version refresh before address PATCH (Deployment — Basic) |
| PATCH | `/api/v2/users/{userId}` | **Update** a user — name, state (restore deleted), addresses, extension, DID (Deployment — Basic) |
| POST | `/api/v2/authorization/roles/{roleId}` | **Grant** a role to a user per-role with division scope (Deployment — Basic) |
| PATCH | `/api/v2/users/{userId}/routingskills/bulk` | **Add** routing skills to a user (Deployment — Basic) |
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

Used by: Data Tables — Create/Copy, Deployment — Data Tables, Divisions — Flows/DataTables/Schedules/etc., Documentation Export, Deployment — Basic

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/flows` | List architect flows |
| GET | `/api/v2/flows/{id}` | Get a flow by ID (entity name resolution in audit) |
| GET | `/api/v2/flows/outcomes` | List flow outcomes |
| GET | `/api/v2/flows/milestones` | List flow milestones |
| GET | `/api/v2/flows/datatables` | List data tables (add `?expand=schema` for full schema) |
| GET | `/api/v2/flows/datatables/{id}` | Get a single data table (with schema) |
| PUT | `/api/v2/flows/datatables/{id}` | Update a data table (incl. division change) |
| POST | `/api/v2/flows/datatables` | **Create** a new data table |
| GET | `/api/v2/flows/datatables/{id}/rows` | List rows of a data table |
| POST | `/api/v2/flows/datatables/{id}/rows` | Insert a row into a data table |
| GET | `/api/v2/architect/ivrs` | List IVRs (Call Routing) |
| GET | `/api/v2/architect/schedules` | List routing schedules |
| POST | `/api/v2/architect/schedules` | **Create** a routing schedule (Deployment — Basic) |
| PUT | `/api/v2/architect/schedules/{scheduleId}` | **Update** a routing schedule (Deployment — Basic) |
| GET | `/api/v2/architect/schedulegroups` | List routing schedule groups |
| POST | `/api/v2/architect/schedulegroups` | **Create** a routing schedule group (Deployment — Basic) |
| PUT | `/api/v2/architect/schedulegroups/{groupId}` | **Update** a routing schedule group (Deployment — Basic) |
| GET | `/api/v2/architect/emergencygroups` | List emergency groups |
| GET | `/api/v2/architect/prompts` | List architect prompts |

---

## 9. Scripts

Used by: Divisions — Scripts, Documentation Export

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/scripts` | List scripts (supports `?status=PUBLISHED`) |

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
| GET | `/api/v2/telephony/providers/edges/phones` | List phones (paginated) |
| POST | `/api/v2/telephony/providers/edges/phones` | Create a phone |
| GET | `/api/v2/telephony/providers/edges/phones/{id}` | Get a phone by ID |
| PUT | `/api/v2/telephony/providers/edges/phones/{id}` | Update a phone (e.g., change site) |
| GET | `/api/v2/telephony/providers/edges/trunkbasesettings` | List trunk base settings |
| GET | `/api/v2/telephony/providers/edges/extensionpools` | List extension pools |

---

## 11. License

Used by: License Consumption Export, WebRTC Phones — Create

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/license/users` | Per-user license consumption (paginated) |
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
| GET | `/api/v2/integrations/actions/{id}` | Get a published data action |
| GET | `/api/v2/integrations/actions/{id}/draft` | Get the draft of a data action |
| PUT | `/api/v2/integrations/actions/{id}/draft` | Update a data action draft |
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

Used by: Divisions — Outbound pages, Documentation Export

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

Used by: Documentation Export

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/webdeployments/configurations` | List web deployment configurations (published only) |
| GET | `/api/v2/webdeployments/deployments` | List web deployments |

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

Used by: Deployment — Basic (Schedule Groups timezone validation)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/timezones` | List all valid Genesys Cloud timezone IDs (used to validate Schedule Group timezone before API call) |

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

## Notes

- **Pagination**: Most list endpoints use offset pagination (`pageNumber`/`pageSize`). Exceptions: External Contacts and Assistants use **cursor pagination** (`nextUri`). Task Management (Workbins/Work Types) uses **POST-based queries**.
- **Proxying**: All Genesys calls go through `POST /api/genesys-proxy`, which adds `Authorization: Bearer <token>` for the selected org and forwards the request to the correct Genesys region.
- **Entity name resolution**: The Audit — Search page resolves entity names for 40+ entity types by calling the appropriate `GET /api/v2/{path}/{id}` endpoint on-demand when a row is expanded.
- **Server-side endpoints**: Endpoints in sections 2, 4, 5, 7–27 that are also called from `api/lib/exports/` run server-side during scheduled export execution (including Documentation Export) — not from the browser.
