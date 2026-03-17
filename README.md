# Genesys Admin Tool

Internal web application for the Genesys Team to perform administrative actions across multiple customer Genesys Cloud orgs.

## What it does

### Features

- **Interaction Search — Recent (<48h)** — Search conversations from the last 48 hours, today, or yesterday using the synchronous query API (results appear immediately). Server-side filters: Queue (searchable), Direction (Inbound/Outbound), Media Type, Division. Client-side Participant Data attribute filters with key/value matching, exclude mode, and multi-value (CSV) support. Inline row expand shows matched PD values as pills. Sortable results table; click-to-expand detail; right-click to copy Conversation ID. Export Interactions to styled Excel.
- **Interaction Search — Historical (>48h)** — Search historical conversations by date range (up to 48 hours ago) using the async analytics jobs API. Quick-select buttons: Last Week, Last Month, Previous 7 Days, Previous 30 Days. Server-side filters: Queue (searchable), Direction (Inbound/Outbound), Media Type, Division. Client-side Participant Data attribute filters with key/value matching, exclude mode, and multi-value (CSV) support. Inline row expand and right-side detail pane. Collapsible results section (auto-collapses when Multi-value is active to surface the Value Distribution chart). Value Distribution bar chart for multi-value PD keys. Three export buttons: **Export Interactions** (all result rows), **Export Selected Participant Data** (only the filtered PD keys — one row per Conv ID/key/value; CSV values split into individual rows when Multi-value is checked), **Export All Participant Data** (all participant attributes across all conversations). All exports use styled Excel (blue header, alternating rows, auto-filter, frozen row).
- **Transcript Search** — Search conversations and verify whether a Speech & Text Analytics (STA) transcript exists for each one. Two search modes: **Date & Filters** (pick a single day + optional time window, queue, media type, direction — submits an async analytics job) and **Conversation ID(s)** (paste one or more IDs separated by commas, spaces, or newlines — fetches each conversation directly). Transcript existence is checked in parallel batches of 10 via `GET .../transcripturl` (200 = exists, 404 = does not). Live stacked bar chart shows Found / No Transcript / Not Checked counts updating in real time. Transcript filter toggle (All / Found / No Transcript / Not Checked). Click any row to expand and read the full STA transcript content inline. Export to Excel: Conversation ID, Start/End Time, Duration, Queue, Agent, Media Type, Direction, Transcript Exists, Checked At. Access key: `interactions.search.transcripts.search`.
- **Move Interactions** — Move conversations between queues with media type filtering and date range controls
- **Disconnect Interactions** — Force-disconnect stuck/orphaned conversations in three modes: single ID, multiple IDs (comma/newline separated), or empty an entire queue. Queue mode scans up to 6 × 31-day intervals via the async analytics jobs API to find all active conversations. Disconnects execute in parallel batches of 10 for maximum throughput, with a 50 ms pause between batches. Media type filter and date range (older/newer than) filters. Progress shown via status text and progress bar — no table, just a summary of Disconnected / Failed counts on completion.
- **Data Tables — Create** — Create a new data table in the selected org. Required fields: Name, Division, Key (display name of the primary key column, always stored as string). Optional: Description and schema columns. Schema column builder supports Boolean, Decimal, Integer, and String types with optional default values per column. Columns can be reordered by dragging the grip handle. Schema can be imported from an Excel file: select a file, pick the sheet, and the form is pre-filled (Name from row 1; Key, Division, Description from rows 2–4; schema columns from row 5+ — A=Column Name, B=Type, C=Default value optional — invalid or empty defaults are silently skipped). Multiple tabs in the same file can be imported in sequence without re-selecting the file. A **Download Template** button downloads the pre-formatted Excel template directly.
- **Deployment — Basic** — Bulk-create core Genesys Cloud objects from a single Excel workbook. Select a `.xlsx`/`.xls` file; each sheet is matched by tab name to a specific object type and processed automatically. Supported tabs: **DID Pools** (A=Number Start E.164, B=Number End, C=Description, D=Comment, E=Provider: PURE_CLOUD_VOICE / BYOC_CLOUD / BYOC_PREMISES — skipped if an overlapping pool already exists); **Divisions** (A=Name, B=Description — skipped if name already exists); **Sites** (A=Name, B=Media Model Cloud/Premises, C=Media Regions comma-sep for Cloud, D=Location Name, E=TURN Relay Site/Geo, F=Caller ID, G=Caller Name, H=Description — skipped if name already exists); **Skills** (A=Name — skipped if name already exists); **Skills - Language** (A=Name — skipped if name already exists); **Site - Number Plans** (A=Site Name, B=Plan Name, C=Classification, D=Match Type: numberList/digitLength/intraCountryCode/interCountryCode/regex, E=Priority, F=State, G=Numbers one per row for multi-number types, H=Digit Length e.g. 4-10, I=Match Pattern, J=Normalized Format — GET→merge→PUT per site, preserving existing plans); **Site - Outbound Routes** (A=Site Name, B=Route Name, C=Classification Types one per row, D=Distribution: SEQUENTIAL/RANDOM, E=Trunk Names one per row resolved by name, F=State true/false — existing routes not in sheet are untouched; routes matched by name are updated, new ones created); **Schedules** (A=Name req, B=Division, C=Description, D=Start req ISO-8601 no-tz e.g. 2026-01-01T08:00:00.000, E=End req same format, F=RRule optional iCal string e.g. FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR — times interpreted in org timezone; existing schedules matched by name are updated); **Schedule Groups** (multi-row per group — rows sharing the same Group Name are folded into one upsert: A=Group Name req, B=Division first-row-only, C=Description first-row-only, D=Time Zone first-row-only validated against Genesys allowed values e.g. Europe/Copenhagen, E=Type req: open/closed/holiday, F=Schedule Name req resolved by name — existing groups matched by name are updated); **Users** (multi-row per user — rows sharing the same E-mail are folded into one upsert: A=User display name req for new, B=E-mail req, C=Phone Name, D=Phone Site, E=Division, F=Skill one per row, G=Role one per row, H=Extension, I=DID Direct Number, J=Phone Type exact base-settings name, K=Queue one per row — upserts user by email; restores deleted/inactive users before other steps; grants roles and skills additively; creates phone if not found; sets extension and DID as user addresses; adds users to queues in bulk after all users processed; per-step failures are warnings not fatal); **Wrapup Codes** (A=Name req, B=Division, C=Description, D=Queue Name — if set, assigns the code to that queue after upsert; existing codes matched by name are updated); **Queues** (A=Queue Name req, B=Division req, C=Description, D=Scoring Method: TimestampAndPriority/PriorityOnly, E=Last Agent Routing: Disabled/QueueMembersOnly/AnyAgent, F=ACW Prompt: OPTIONAL/MANDATORY/MANDATORY_TIMEOUT/MANDATORY_FORCED_TIMEOUT/AGENT_REQUESTED, G=Skill Eval Method: NONE/BEST/ALL, H=Enable Transcription, I=Enable Manual Assignment, J=Suppress Recording, K=Calling Party Name, L=Calling Party Number, M=Call In-Queue Flow, N=Email In-Queue Flow, O=Message In-Queue Flow, P=Call Script, Q=Callback Script, R=Chat Script, S=Email Script, T=Message Script, U–Z=Call media: Alerting/AutoAnswer/AutoAnswerAlertTone(s)/ManualAnswerAlertTone(s)/SL%/SLDurationMs, AA–AF=Callback media, AG–AL=Chat media, AM–AR=Email media, AS–AX=Message media — blank cells are omitted; only Queue Name and Division are required; invalid non-blank values skip the row). Row 1 per sheet is always a header and is skipped. Results shown per row (✓ created/updated/skipped / ✗ error) with a per-tab summary. All creations logged to the Activity Log with a `[Deployment]` prefix.
- **Deployment — Data Tables** — Bulk-create data tables from an Excel workbook in a single click. Select a `.xlsx`/`.xls` file and every sheet is processed automatically: each sheet produces one data table using the same fixed row format (row 1 = Name, row 2 = Key, row 3 = Division, row 4 = Description, rows 5+ = A=Column Name, B=Type, C=Default value optional — invalid or empty defaults silently skipped). Results are shown inline (✓ created / ✗ error per sheet) with a final summary. A **Download Template** button downloads the pre-formatted Excel template directly. All creations are logged to the Activity Log.
- **Data Tables — Copy (Single Org)** — Copy a data table (structure + optionally rows) within the same org, with division selection
- **Data Tables — Copy between Orgs** — Copy a data table (structure + optionally rows) from one customer org to another, with target division selection
- **Data Actions — Copy between Orgs** — Copy a data action (contract + config) from one customer org to another, with target integration mapping and draft/publish toggle
- **Data Actions — Edit** — View, edit, and test existing data actions with draft/publish workflow, filter by status/category/integration. Edit name, category, request config (URL template, method, body, headers) and response config (translation map, success template) for any action; edit input/output contract schemas for draft-only actions. Save drafts, validate, publish, and run inline tests.
- **WebRTC Phones — Create** — Bulk-create WebRTC phones for all licensed users in a site, skipping collaborate licenses and existing phones, with Excel log export
- **WebRTC Phones — Change Site** — Move selected WebRTC phones from one site to another using a searchable multi-select phone picker, with progress tracking and Excel log export
- **Trustee Export** — Export a matrix of trustee-org users and their access across all customer orgs, determined by group membership, with per-trustee-org Excel sheets and styled formatting matching the Python tool output
- **Last Login Export** — Export user login data with license information for a selected org. One row per user-license combination, optional inactivity filter (months), collapsible preview with per-column filters, styled Excel matching the Python tool output. Supports per-org scheduled automation.
- **All Groups Export** — Export all users (active, inactive, and deleted) with their group memberships for a selected org. One row per user-group combination (shared Index per user), collapsible preview with per-column filters, styled Excel matching the Python tool output. Supports per-org scheduled automation.
- **All Roles Export** — Export all users with role assignments for a selected org. Users with no roles are excluded. One row per (user, role, source): direct assignments show `Manually assigned` / `User`; roles inherited via a group show `Inherited` / group name; if a role is both directly assigned and inherited, both rows appear. Columns: Index, Name, Email, Division, Active, Date Last Login, Role, **Assigned** (Manually assigned / Inherited), **Assigned by** (User or group name). Attribution is resolved via `GET .../users/{id}?expand=groups` and `GET .../authorization/subjects/{groupId}`, batched in parallel (10 concurrent). Collapsible preview with per-column filters, styled Excel. Supports per-org scheduled automation.
- **Filtered on Role(s) Export** — Export active users filtered by one or more roles. Roles are loaded dynamically per org; one row per user with boolean columns for each selected role. Supports per-org scheduled automation with role selection stored in the schedule config.
- **License Consumption Export** — Export per-user licence consumption for a selected org. Fixed columns: Name, Email, Division. One boolean column per licence (or a single column when filtered to a specific licence). Licences are loaded dynamically via `/api/v2/license/definitions`; optionally filter to a single licence. Sheet: "User Licenses". Supports per-org scheduled automation with licence filter stored in the schedule config.
- **Roles Export (Single Org)** — Export all authorization roles for a selected org with accurate member counts (active org users only). Columns: Name, Description, Members. Supports per-org scheduled automation.
- **Roles Export (All Orgs)** — Export roles for all configured orgs in a single multi-sheet workbook (one sheet per org). Accurate member counts, on-demand only.
- **Roles — Compare** — Two modes selectable via a top toggle:
  - **Compare Roles** — Compare permission policies across 2–10 roles from the same org side by side. Roles are loaded on page load; select any combination and click Compare to fetch each role's full permission set in parallel via `GET /api/v2/authorization/roles/{id}`. Wildcard permissions (`*` entity or `*` action) are automatically expanded against the full Genesys permission catalog (`GET /api/v2/authorization/permissions`). Results grouped by domain (collapsible) with a permission matrix: Entity column + one column per role showing action tags or `—`. Rows colour-coded: amber = differs, green = identical. Toggle All / Differences only, filter, expand/collapse all. Export to Excel: Domain, Entity, one column per role.
  - **Compare Users** — Compare the effective permissions of exactly 2 users. Search-as-you-type user picker (`POST /api/v2/users/search`, CONTAINS on name + email). For each user, direct role assignments are fetched via `GET /api/v2/authorization/subjects/{userId}` and group memberships via `GET /api/v2/users/{userId}?expand=groups`; each group's roles are fetched via `GET /api/v2/authorization/subjects/{groupId}` with the group name resolved via `GET /api/v2/groups/{groupId}`. Permissions are unioned per user with full attribution per cell: role name + **Assigned manually** or **Inherited from Group: GroupName**. Defaults to Differences only. Export to Excel includes a `ColName — via roles` attribution column per user.
- **Roles — Permissions vs. Users** — Search for all users who hold a specific permission in the org. Select a domain, entity, and one or more actions from the full permission catalog. On search: (1) the catalog is used to find all roles that carry the permission (`GET /api/v2/authorization/roles?permission={domain}:{entity}:{action}` + client-side wildcard filter); (2) all org users are fetched with `expand=authorization` to cross-reference membership; (3) for each matching user the source is resolved asynchronously — direct assignment vs. inherited via group (batches of 10, using `GET /api/v2/authorization/subjects/{userId}`, `GET /api/v2/users/{userId}?expand=groups`, and per-group `GET /api/v2/authorization/subjects/{groupId}` + `GET /api/v2/groups/{groupId}`). Results stream into a table as they resolve. Trustee-org users are excluded. Client-side action-filter chips narrow results after load. Progress bar tracks Step 1 (catalog), Step 2b (per-user group fetch), and Step 3 (attribution). Export to Excel with filename `Roles_Search_{Org}_{Domain}_{Entity}_{Actions}_{timestamp}.xlsx`. Access key: `roles.search`.
- **Roles — Create** — Create a new authorization role with a full permission builder. Domain and entity are selected via searchable comboboxes fed from the permission catalog. Action checkboxes cascade from the entity selection. "Add" appends a policy row; adding a duplicate domain+entity merges actions with a warning. Policy rows are grouped by domain under collapsible amber-labelled accordion sections (all expanded by default). For permissions where any selected action supports conditions (`allowConditions=true` in the catalog), an inline **Conditions** panel can be opened per row to configure a condition variable (QUEUE_ID, MEDIA_TYPE, SKILL_ID, or DIVISION_ID), operator (INCLUDES / EQUALS), and values (multi-select with search; queues, skills, and divisions are lazy-loaded). Submit POSTs a new role via `PUT /api/v2/authorization/roles`. Access key: `roles.create`.
- **Roles — Edit** — Edit an existing authorization role. A searchable combobox loads all roles in the org (`GET /api/v2/authorization/roles`). Selecting a role fetches its full `permissionPolicies` (`GET /api/v2/authorization/roles/{id}`); wildcard actions (`actionSet:["*"]`) and wildcard entities (`entityName:"*"`) are automatically expanded against the catalog so `*` never appears as a raw tag. Policies are pre-loaded into the same permission builder used by Create, with domain sections collapsed by default in edit mode. Conditions panels are pre-populated from `resourceConditionNode`. Save submits a full-replace `PUT /api/v2/authorization/roles/{id}`. Access key: `roles.edit`.
- **Documentation Export** — Generate a full Genesys Cloud configuration export for a selected org, mirroring the Python `Export_All.py` output. Produces up to 42 alphabetically sorted configuration sheets (Agent Copilots, DID Numbers, Flows, Queues, Users, OAuth clients, Outbound, etc.) plus a styled Index cover sheet with table of contents and clickable hyperlinks. A second workbook containing all DataTable contents (one sheet per table with its rows, plus an Index cover sheet showing row counts) is bundled as a ZIP when present. Export can take 5–10 minutes for large orgs. Supports per-org scheduled automation.
- **Scheduled Exports** — Automate any export on a daily, weekly, or monthly schedule with email delivery. Per-export automation toggle, reusable schedule panel with org selector and custom config fields, "All Scheduled Exports" overview page with Last Run and Last Run Status columns (Success / Failure — error description). Server-side execution via GitHub Actions cron + Azure Functions. Catch-up logic ensures missed runs are retried. All times in Danish time (Europe/Copenhagen, CET/CEST).
- **Email notifications** — Send export results as email with attachments via Mailjet (EU-based, GDPR-compliant). Centralized email service reusable by any page.
- **GDPR — Subject Request** — Submit GDPR data subject requests for a selected customer org. Guided step-by-step flow: choose request type (Article 15 Right of Access, Article 16 Right to Rectification, Article 17 Right to Erasure), enter known identifiers (name, email, phone, address, social handles), review matched subjects returned by Genesys, enter replacement values for rectification requests, then confirm and submit. After submission, a direct link to Request Status is shown.
- **GDPR — Request Status** — View all previously submitted GDPR requests for a selected customer org. Columns: Date, Type, Subject, Subject Type, Status, Completed, Details, and full Request ID. For Article 15 Access requests, signed download links appear once Genesys has fulfilled the export (typically 1–2 business days).
- **Divisions** — Reassign objects between divisions across the full Genesys Cloud object hierarchy. All pages share an identical two-column layout: load objects (with source-division filter + text search) on the left; choose target division and apply on the right. Table section is collapsible and auto-collapses after each apply. Uses `POST /api/v2/authorization/divisions/{id}/objects/{TYPE}`.
  - **People:** Users — Work Teams
  - **Routing:** Queues — Call Routes — Emergency Groups — Extension Pools — Routing Schedules — Routing Schedule Groups — Skill Groups
  - **Architect:** Flows *(with Type dropdown filter)* — Flow Milestones — Flow Outcomes — Scripts *(with Status column — Published/Draft — and Status filter)* — Data Tables
  - **Outbound:** Campaigns — Contact Lists — DNC Lists — Email Campaigns — Messaging Campaigns
  - **Workforce Management:** Business Units — Management Units
  - **Task Management:** Workbins — Work Types
- **Activity Log** — Internal log of all write/mutative actions performed through the tool. Every create, copy, move, disconnect, publish, and GDPR submit records who did it, for which org, when, and a plain-language description. Visible to all logged-in users at `/activity-log` via the header link. Client-side filters: action type, org (admin only), user (admin only), and free-text search. Entries are stored in Azure Table Storage and fetched via `/api/activity-log`. Retention is indefinite; the log cannot be cleared from the UI.
- **Audit — Search** — Query Genesys Cloud audit events across any date range. Ranges ≤ 14 days automatically query **all realtime-supported services** concurrently using the synchronous `POST /api/v2/audits/query/realtime` endpoint (no polling, cursor-paginated to retrieve all results) — results appear in seconds. For ≤ 14-day ranges with a specific service not supported by the realtime endpoint, falls back to the standard async query API automatically. Ranges > 14 days require a service selection and always use the async chunked pipeline (`POST /api/v2/audits/query` → poll → cursor-paginated results, 30-day chunks). Preset quick-filters: Today, Last 7 days, Last month, Last 3 months. Auto-runs today's query on page load with no service pre-selected (all services). Client-side filters: Entity Type → Action (cascading) + Changed By. Results table: Date & Time, Service, Entity Type, Entity Name (resolved via 40+ mapped API paths with `(deleted)` label on 404), Action, Changed By (user or OAuth client name). Click any row to expand a detail panel showing metadata, changed properties (old → new values), additional context, and a raw API response dump. Sticky table header, sortable latest-first, configurable rows per page (50/100/150/200). A blue/amber hint below the service dropdown indicates the current query mode. **Export to Excel** button (far right of filter bar) exports all filtered results — one row per property change — with columns: Date & Time, Service, Entity Type, Entity Name, Action, Changed By, Level, Remote IP, Property, Old Value, New Value, Additional Context.
- **Alphabetical nav sorting** — All menu items are always sorted alphabetically at every level
- **Top-level menu groups** — Data Actions, Data Tables, Deployment, Divisions, Export, Interactions, Phones, and Roles each have their own top-level nav section
- **Editable filter tags** — Click a filter tag to edit it; right-click a result row to copy its Conversation ID

### Platform

- **Secure credential storage** — Customer Client IDs/Secrets managed in Azure Key Vault, delivered to the backend via encrypted app settings
- **Org selector** — Pick any customer org from a dropdown; all pages use that org
- **Proxied API calls** — All Genesys API calls go through an Azure Functions backend that handles authentication
- **Centralized API service** — Shared `genesysApi.js` module with helpers for analytics, users, queues, flows, data tables, data actions, integrations, divisions, and more
- **OAuth PKCE login** — Team members authenticate via Genesys Cloud (your own org)
- **Sign Out** — Header Sign Out button clears the current session and forces a fresh PKCE login, useful when switching between orgs or clearing a stale token
- **Welcome page** — App always starts on a clean welcome screen; no page or org is pre-selected
- **Dark/light theme** — Adapts to OS preference automatically
- **Iframe-safe Excel export** — Uses SheetJS (xlsx-js-style) with a `download.html` helper page for reliable downloads inside Genesys Cloud iframes. Data is passed via `window.opener` (not the URL hash) to support large exports without hitting browser URL-length limits. All exports use standard cell styling: blue header, alternating rows, auto-filter, frozen row.

## Architecture

```text
Browser (SPA)                    Azure Static Web App (Standard)
┌─────────────┐                 ┌──────────────────────────────┐
│  Frontend   │───── /api/* ───▶│  Azure Functions (Node 18)   │
│  (JS SPA)   │                 │    ├─ GET /api/customers     │
│             │                 │    ├─ POST /api/genesys-proxy│
│  Org select │                 │    ├─ POST /api/send-email   │──▶ Mailjet API
│  dropdown   │                 │    ├─ * /api/schedules       │    (EU servers)
└─────────────┘                 │    └─ POST /api/scheduled-   │
                                │         runner               │
 GitHub Actions (cron)          └────┬─────────────────────────┘
┌─────────────┐                      │
│  Every hour │── POST /api/ ───────▶│
│ scheduled-  │   scheduled-runner   │
│ runner.yml  │                      │
└─────────────┘              Encrypted app settings
                             (GENESYS_<ORG>_CLIENT_ID/SECRET)
                             (MAILJET_API_KEY / SECRET_KEY)
                             (AZURE_STORAGE_CONNECTION_STRING)
                             (SCHEDULE_RUNNER_KEY)
                                     │
                              ┌──────▼───────┐   ┌──────────────┐
                              │  Azure Key   │   │ Azure Table  │
                              │  Vault       │   │ Storage      │
                              │  (source of  │   │ (schedules)  │
                              │   truth)     │   │              │
                              └──────────────┘   └──────────────┘
```

- **Frontend:** Vanilla JavaScript SPA with hash-based routing, deployed as an Azure Static Web App
- **Backend:** Azure Functions (Node.js 18) auto-deployed from the `api/` folder
- **Secrets:** Azure Key Vault is the source of truth; secret values are copied into encrypted SWA app settings read via `process.env`
- **CI/CD:** GitHub Actions — push to `main` triggers automatic deployment

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | Vanilla JS (ES Modules), HTML, CSS |
| Backend API | Azure Functions (Node.js) |
| Hosting | Azure Static Web Apps (Standard) |
| Secrets | Azure Key Vault |
| Auth (team) | Genesys Cloud OAuth 2.0 PKCE |
| Auth (customers) | OAuth 2.0 Client Credentials (via backend) |
| Email | Mailjet v3.1 Send API (EU, GDPR-compliant) |
| Schedule storage | Azure Table Storage |
| Scheduled runner | GitHub Actions cron (hourly) |
| CI/CD | GitHub Actions |

## Project Structure

```text
genesys-admin-app/
├── index.html                    App shell
├── download.html                 Iframe-safe file download helper
├── staticwebapp.config.json      SPA routing + Node 18 runtime config
├── css/styles.css                Styles (dark + light theme)
├── .github/
│   └── workflows/
│       ├── azure-static-web-apps-*.yml   SWA CI/CD (auto-generated)
│       └── scheduled-runner.yml          Cron trigger for scheduled exports
├── js/
│   ├── app.js                    App entry point (auth, routing, org selector)
│   ├── config.js                 OAuth & region config
│   ├── nav.js                    Sidebar navigation renderer (alphabetical sorting)
│   ├── navConfig.js              Navigation tree definition
│   ├── pageRegistry.js           Route → page loader map
│   ├── router.js                 Hash-based SPA router
│   ├── utils.js                  Shared utilities (formatting, Excel export, etc.)
│   ├── lib/
│   │   └── xlsx.bundle.js        xlsx-js-style library (SheetJS + cell styling)
│   ├── components/
│   │   ├── multiSelect.js        Reusable multi-select dropdown
│   │   └── schedulePanel.js      Reusable automation schedule panel
│   ├── pages/
│   │   ├── welcome.js            Welcome / landing page
│   │   ├── notfound.js           404 page
│   │   ├── accessdenied.js       Access denied page
│   │   ├── placeholder.js        Generic "coming soon" stub
│   │   ├── activityLog.js        Internal activity log viewer
│   │   ├── audit/
│   │   │   └── search.js            Audit Search (realtime + async dual-path, preset filters, row-expand detail panel, Export to Excel)
│   │   ├── dataactions/
│   │   │   ├── copyBetweenOrgs.js   Copy data action between orgs
│   │   │   └── edit.js              Edit / test existing data actions
│   │   ├── datatables/
│   │   │   ├── create.js            Create data table (schema builder, drag-to-reorder columns, Excel import)
│   │   │   ├── copySingleOrg.js     Copy table within same org
│   │   │   └── copyBetweenOrgs.js   Copy table between orgs
│   │   ├── deployment/
│   │   │   ├── basic.js             Bulk-deploy DID Pools, Divisions, Sites, Skills, Number Plans, Outbound Routes, Schedules, Schedule Groups, Wrapup Codes, Queues, Users (upsert by name where supported)
│   │   │   └── datatables.js        Bulk-create data tables from Excel workbook
│   │   ├── divisions/
│   │   │   ├── _generic.js          Shared generic renderer with hooks (extraFilters, extraFilterFn, onItemsLoaded)
│   │   │   ├── users.js             People — Users
│   │   │   ├── team.js              People — Teams
│   │   │   ├── queues.js            Routing — Queues
│   │   │   ├── callroute.js         Routing — Call Routes
│   │   │   ├── emergencyGroups.js   Routing — Emergency Groups
│   │   │   ├── extensionPool.js     Routing — Extension Pools
│   │   │   ├── routingSchedules.js  Routing — Schedules
│   │   │   ├── routingScheduleGroups.js  Routing — Schedule Groups
│   │   │   ├── skillGroup.js        Routing — Skill Groups
│   │   │   ├── flow.js              Architect — Flows (Type dropdown filter)
│   │   │   ├── flowMilestone.js     Architect — Flow Milestones
│   │   │   ├── flowOutcome.js       Architect — Flow Outcomes
│   │   │   ├── script.js            Architect — Scripts (Status column + filter)
│   │   │   ├── dataTables.js        Architect — Data Tables
│   │   │   ├── campaign.js          Outbound — Campaigns
│   │   │   ├── contactList.js       Outbound — Contact Lists
│   │   │   ├── dncList.js           Outbound — DNC Lists
│   │   │   ├── emailCampaign.js     Outbound — Email Campaigns
│   │   │   ├── messagingCampaign.js Outbound — Messaging Campaigns
│   │   │   ├── businessUnit.js      Workforce Mgmt — Business Units
│   │   │   ├── managementUnit.js    Workforce Mgmt — Management Units
│   │   │   ├── workbin.js           Task Mgmt — Workbins
│   │   │   └── worktype.js          Task Mgmt — Worktypes
│   │   ├── gdpr/
│   │   │   ├── subjectRequest.js    GDPR Subject Request (Articles 15, 16, 17)
│   │   │   └── requestStatus.js     GDPR Request Status + Article 15 download links
│   │   ├── interactions/
│   │   │   ├── search.js            Historical Interaction Search (>48h, async jobs API)
│   │   │   ├── searchRecent.js      Recent Interaction Search (<48h, sync query API)
│   │   │   ├── move.js              Move Interactions between queues
│   │   │   ├── disconnect.js        Force-disconnect conversations (parallel batch of 10, status + progress only)
│   │   │   └── transcripts/
│   │   │       └── search.js        Transcript Search (date+filters or ID list, STA transcript check, live chart, click-to-expand)
│   │   ├── roles/
│   │   │   ├── compare.js           Roles Compare — permission matrix with wildcard expansion
│   │   │   ├── search.js            Roles Permissions vs. Users — find who holds a permission, attribution, export
│   │   │   └── create.js            Roles Create / Edit — shared module (mode param), permission builder with conditions
│   │   ├── export/
│   │   │   ├── scheduledExports.js   All Scheduled Exports overview (with Last Run Status column)
│   │   │   ├── licenses/
│   │   │   │   └── consumption.js   License Consumption export + per-org automation
│   │   │   ├── documentation/
│   │   │   │   └── create.js        Documentation export (full config workbook + DataTables ZIP, per-org scheduled automation)
│   │   │   ├── roles/
│   │   │   │   ├── allOrgs.js       Roles export — all orgs, multi-sheet workbook
│   │   │   │   └── singleOrg.js     Roles export — single org + automation
│   │   │   └── users/
│   │   │       ├── allGroups.js     All Groups export + per-org automation
│   │   │       ├── allRoles.js      All Roles export + per-org automation
│   │   │       ├── filteredRoles.js  Filtered on Role(s) export + dynamic role picker
│   │   │       ├── lastLogin.js      Last Login export + per-org automation
│   │   │       └── trustee.js       Trustee access matrix export + automation
│   │   └── phones/
│   │       └── webrtc/
│   │           ├── changeSite.js     Change site for WebRTC phones
│   │           └── createWebRtc.js  Bulk-create WebRTC phones
│   └── services/
│       ├── apiClient.js          HTTP client + Genesys proxy wrapper
│       ├── authService.js        OAuth 2.0 PKCE authentication
│       ├── customerService.js    Customer list loader
│       ├── emailService.js       Centralized email service (Mailjet via /api/send-email)
│       ├── genesysApi.js         Centralized Genesys Cloud API service
│       ├── activityLogService.js  Write entries to the internal activity log
│       ├── orgContext.js         Selected org state management
│       └── scheduleService.js    Schedule CRUD API wrappers
├── api/                          Azure Functions backend
│   ├── customers/                GET /api/customers
│   ├── genesys-proxy/            POST /api/genesys-proxy
│   ├── send-email/               POST /api/send-email (Mailjet)
│   ├── schedules/                CRUD /api/schedules (schedules management)
│   ├── scheduled-runner/         POST /api/scheduled-runner (export execution)
│   └── lib/
│       ├── customers.json        Customer metadata (15 orgs)
│       ├── genesysAuth.js        Client Credentials token cache per org
│       ├── scheduleStore.js      Azure Table Storage CRUD for schedules
│       ├── exportHandlers.js     Export type → handler registry
│       └── exports/
│           ├── allGroups.js         Server-side All Groups export handler
│           ├── allRoles.js          Server-side All Roles export handler
│           ├── documentation.js     Server-side Documentation export (42 sheets + DataTables workbook)
│           ├── filteredRoles.js     Server-side Filtered on Role(s) export handler
│           ├── licensesConsumption.js Server-side License Consumption export handler
│           ├── rolesSingleOrg.js    Server-side Roles Single Org export handler
│           ├── lastLogin.js         Server-side Last Login export handler
│           └── trustee.js           Server-side trustee export handler
└── docs/
    ├── setup-guide.md            Full deployment guide
    ├── api-reference.md          Complete list of all API endpoints used
    └── conversion-reference.md   Python → JS migration reference
```

## Scheduled Exports

The app supports automated, server-side export execution with email delivery.

### How it works

1. **Schedule creation** — On any export page with automation enabled (e.g. Trustee, Last Login, All Roles, All Groups, Filtered on Role(s), License Consumption), toggle on automation and configure a daily/weekly/monthly schedule with email recipients. Per-org exports include an org selector in the schedule form; Filtered on Role(s) also shows a dynamic role picker; License Consumption also shows a dynamic licence filter; Last Login also has an inactivity filter.
2. **GitHub Actions cron** — A workflow runs every hour and POSTs to `/api/scheduled-runner` with a shared secret
3. **Server-side execution** — The Azure Function checks Azure Table Storage for due schedules, runs the export using client credentials, and emails the result via Mailjet
4. **Catch-up logic** — If a run is missed (GitHub Actions delays), the next cycle picks it up automatically. Only one run per schedule per day.
5. **All times are Danish time** — Europe/Copenhagen (CET in winter, CEST in summer)

### Permissions

- Any logged-in user can create a schedule
- Only the creator (or admin `thva@tdc.dk`) can edit or delete a schedule
- The "All Scheduled Exports" overview page lists all schedules across all export types

### Required configuration

See [docs/setup-guide.md](docs/setup-guide.md) for full details. In summary:

| Setting | Where | Purpose |
| --- | --- | --- |
| `AZURE_STORAGE_CONNECTION_STRING` | Azure SWA app settings | Azure Table Storage for schedule data |
| `SCHEDULE_RUNNER_KEY` | Azure SWA app settings + GitHub secret | Shared secret to protect the runner endpoint |
| `SWA_URL` | GitHub secret | Static Web App URL for the cron workflow to call |

## Quick Start (local development)

1. Serve the frontend with any static file server:

   ```bash
   npx serve .
   ```

2. For the API, install and use the [Azure Static Web Apps CLI](https://github.com/Azure/static-web-apps-cli):

   ```bash
   npm install -g @azure/static-web-apps-cli
   cd api && npm install && cd ..
   swa start . --api-location api
   ```

3. Log in to Azure CLI (`az login`) for local Key Vault access

## Deployment

See [docs/setup-guide.md](docs/setup-guide.md) for the complete step-by-step deployment guide covering:

- Azure Static Web App creation (Standard plan)
- Azure Key Vault setup
- Managed Identity + RBAC configuration
- Customer credential import
- Mailjet email service configuration
- GitHub Actions CI/CD
- Genesys Cloud OAuth client setup

## Adding a New Customer

1. Add 2 secrets to Azure Key Vault:

   ```bash
   az keyvault secret set --vault-name genesys-admin-kv \
     --name "genesys-<id>-client-id" --value "..."
   az keyvault secret set --vault-name genesys-admin-kv \
     --name "genesys-<id>-client-secret" --value "..."
   ```

2. Copy the values into SWA app settings (env var names use underscores, uppercase):

   ```bash
   az staticwebapp appsettings set --name genesys-admin-app \
     --resource-group genesys-admin-app_group \
     --setting-names "GENESYS_<ID>_CLIENT_ID=..." "GENESYS_<ID>_CLIENT_SECRET=..."
   ```

3. Add an entry to `api/lib/customers.json`:

   ```json
   { "id": "<id>", "name": "Customer Name", "region": "mypurecloud.de" }
   ```

4. Commit and push

## Adding a New Feature Page

1. Create a page module in `js/pages/<category>/` (folder should mirror the nav tree)
2. Register the route in `js/pageRegistry.js`
3. Add a nav entry in `js/navConfig.js`
4. Commit and push

Pages receive `{ route, me, api, orgContext }` and can call customer APIs via:

```javascript
// Direct proxy call
const data = await api.proxyGenesys(orgContext.get(), "GET", "/api/v2/...");

// Or use the centralized Genesys API service (preferred)
import { fetchAllQueues } from "../services/genesysApi.js";
const queues = await fetchAllQueues(api, orgContext.get());
```

## License

Internal tool — not for public distribution.
