# Genesys Admin Tool

Internal web application for the Genesys Team to perform administrative actions across multiple customer Genesys Cloud orgs.

## What it does

### Features

- **Interaction Search** — Search conversations by date range; server-side filters for queue (searchable dropdown), media type, and division; client-side participant data attribute filters; sortable results table with click-to-expand detail; export to Excel (.xlsx)
- **Move Interactions** — Move conversations between queues with media type filtering and date range controls
- **Disconnect Interactions** — Force-disconnect stuck/orphaned conversations in three modes: single ID, multiple IDs (comma/newline separated), or empty an entire queue. Queue mode scans up to 6 × 31-day intervals via the async analytics jobs API to find all active conversations. Disconnects execute in parallel batches of 10 for maximum throughput, with a 50 ms pause between batches. Media type filter and date range (older/newer than) filters. Progress shown via status text and progress bar — no table, just a summary of Disconnected / Failed counts on completion.
- **Data Tables — Create** — Create a new data table in the selected org. Required fields: Name, Division, Key (display name of the primary key column, always stored as string). Optional: Description and schema columns. Schema column builder supports Boolean, Decimal, Integer, and String types with optional default values per column. Columns can be reordered by dragging the grip handle. Schema can be imported from an Excel file: select a file, pick the sheet, and the form is pre-filled (Name from tab name; Key, Division, Description, and schema columns from fixed rows 1–4). Multiple tabs in the same file can be imported in sequence without re-selecting the file.
- **Data Tables — Copy (Single Org)** — Copy a data table (structure + optionally rows) within the same org, with division selection
- **Data Tables — Copy between Orgs** — Copy a data table (structure + optionally rows) from one customer org to another, with target division selection
- **Data Actions — Copy between Orgs** — Copy a data action (contract + config) from one customer org to another, with target integration mapping and draft/publish toggle
- **Data Actions — Edit** — View, edit, and test existing data actions with draft/publish workflow, filter by status/category/integration. Edit name, category, request config (URL template, method, body, headers) and response config (translation map, success template) for any action; edit input/output contract schemas for draft-only actions. Save drafts, validate, publish, and run inline tests.
- **WebRTC Phones — Create** — Bulk-create WebRTC phones for all licensed users in a site, skipping collaborate licenses and existing phones, with Excel log export
- **WebRTC Phones — Change Site** — Move selected WebRTC phones from one site to another using a searchable multi-select phone picker, with progress tracking and Excel log export
- **Trustee Export** — Export a matrix of trustee-org users and their access across all customer orgs, determined by group membership, with per-trustee-org Excel sheets and styled formatting matching the Python tool output
- **Last Login Export** — Export user login data with license information for a selected org. One row per user-license combination, optional inactivity filter (months), collapsible preview with per-column filters, styled Excel matching the Python tool output. Supports per-org scheduled automation.
- **All Groups Export** — Export all users (active, inactive, and deleted) with their group memberships for a selected org. One row per user-group combination (shared Index per user), collapsible preview with per-column filters, styled Excel matching the Python tool output. Supports per-org scheduled automation.
- **All Roles Export** — Export all users (active, inactive, and deleted) with their role assignments for a selected org. One row per user-role combination (shared Index per user), collapsible preview with per-column filters, styled Excel matching the Python tool output. Supports per-org scheduled automation.
- **Filtered on Role(s) Export** — Export active users filtered by one or more roles. Roles are loaded dynamically per org; one row per user with boolean columns for each selected role. Supports per-org scheduled automation with role selection stored in the schedule config.
- **License Consumption Export** — Export per-user licence consumption for a selected org. Fixed columns: Name, Email, Division. One boolean column per licence (or a single column when filtered to a specific licence). Licences are loaded dynamically via `/api/v2/license/definitions`; optionally filter to a single licence. Sheet: "User Licenses". Supports per-org scheduled automation with licence filter stored in the schedule config.
- **Roles Export (Single Org)** — Export all authorization roles for a selected org with accurate member counts (active org users only). Columns: Name, Description, Members. Supports per-org scheduled automation.
- **Roles Export (All Orgs)** — Export roles for all configured orgs in a single multi-sheet workbook (one sheet per org). Accurate member counts, on-demand only.
- **Documentation Export** — Generate a full Genesys Cloud configuration export for a selected org, mirroring the Python `Export_All.py` output. Produces up to 42 alphabetically sorted configuration sheets (Agent Copilots, DID Numbers, Flows, Queues, Users, OAuth clients, Outbound, etc.) plus a styled Index cover sheet with table of contents and clickable hyperlinks. A second workbook containing all DataTable contents (one sheet per table with its rows, plus an Index cover sheet showing row counts) is bundled as a ZIP when present. Export can take 5–10 minutes for large orgs.
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
- **Activity Log** — Internal log of all write/mutative actions performed through the tool. Every create, copy, move, disconnect, publish, and GDPR submit records who did it, for which org, when, and a plain-language description. Visible to all logged-in users at `/activity-log` via the header link. Client-side filters: action type, org, and free-text search. Entries are stored in Azure Table Storage and fetched via `/api/activity-log`. Retention is indefinite; the log cannot be cleared from the UI.
- **Audit — Search** — Query Genesys Cloud audit events across any date range. Ranges ≤ 14 days automatically query **all realtime-supported services** concurrently using the synchronous `POST /api/v2/audits/query/realtime` endpoint (no polling) — results appear in seconds. For ≤ 14-day ranges with a specific service not supported by the realtime endpoint, falls back to the standard async query API automatically. Ranges > 14 days require a service selection and always use the async chunked pipeline (`POST /api/v2/audits/query` → poll → cursor-paginated results, 30-day chunks). Preset quick-filters: Today, Last 7 days, Last month, Last 3 months. Auto-runs today's query on page load (restoring last-used service from `localStorage`). Client-side filters: Entity Type → Action (cascading) + Changed By. Results table: Date & Time, Service, Entity Type, Entity Name (resolved via 40+ mapped API paths with `(deleted)` label on 404), Action, Changed By (user or OAuth client name). Click any row to expand a detail panel showing metadata, changed properties (old → new values), additional context, and a raw API response dump. Sticky table header, sortable latest-first, configurable rows per page (50/100/150/200). A blue/amber hint below the service dropdown indicates the current query mode.
- **Alphabetical nav sorting** — All menu items are always sorted alphabetically at every level
- **Top-level menu groups** — Data Actions, Data Tables, Divisions, Export, Interactions, and Phones each have their own top-level nav section
- **Editable filter tags** — Click a filter tag to edit it; right-click a result row to copy its Conversation ID

### Platform

- **Secure credential storage** — Customer Client IDs/Secrets managed in Azure Key Vault, delivered to the backend via encrypted app settings
- **Org selector** — Pick any customer org from a dropdown; all pages use that org
- **Proxied API calls** — All Genesys API calls go through an Azure Functions backend that handles authentication
- **Centralized API service** — Shared `genesysApi.js` module with helpers for analytics, users, queues, flows, data tables, data actions, integrations, divisions, and more
- **OAuth PKCE login** — Team members authenticate via Genesys Cloud (your own org)
- **Welcome page** — App always starts on a clean welcome screen; no page or org is pre-selected
- **Dark/light theme** — Adapts to OS preference automatically
- **Iframe-safe Excel export** — Uses SheetJS (xlsx-js-style) with a helper page for reliable downloads inside Genesys Cloud iframes, with full cell styling support

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
│   │   │   └── search.js            Audit Search (realtime + async dual-path, preset filters, row-expand detail panel)
│   │   ├── dataactions/
│   │   │   ├── copyBetweenOrgs.js   Copy data action between orgs
│   │   │   └── edit.js              Edit / test existing data actions
│   │   ├── datatables/
│   │   │   ├── create.js            Create data table (schema builder, drag-to-reorder columns, Excel import)
│   │   │   ├── copySingleOrg.js     Copy table within same org
│   │   │   └── copyBetweenOrgs.js   Copy table between orgs
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
│   │   │   ├── search.js            Interaction Search page
│   │   │   ├── move.js              Move Interactions between queues
│   │   │   └── disconnect.js        Force-disconnect conversations (parallel batch of 10, status + progress only)
│   │   ├── export/
│   │   │   ├── scheduledExports.js   All Scheduled Exports overview (with Last Run Status column)
│   │   │   ├── licenses/
│   │   │   │   └── consumption.js   License Consumption export + per-org automation
│   │   │   ├── documentation/
│   │   │   │   └── create.js        Documentation export (full config workbook + DataTables ZIP)
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
