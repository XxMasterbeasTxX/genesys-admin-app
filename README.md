# Genesys Admin Tool

Internal web application for the Genesys Team to perform administrative actions across multiple customer Genesys Cloud orgs.

## What it does

### Features

- **Interaction Search** — Search conversations by date range, filter by participant data, view details, export to Excel (.xlsx)
- **Move Interactions** — Move conversations between queues with media type filtering and date range controls
- **Disconnect Interactions** — Force-disconnect stuck/orphaned conversations by ID or empty an entire queue, with media type and date filters
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
- **Scheduled Exports** — Automate any export on a daily, weekly, or monthly schedule with email delivery. Per-export automation toggle, reusable schedule panel with org selector and custom config fields, "All Scheduled Exports" overview page. Server-side execution via GitHub Actions cron + Azure Functions. Catch-up logic ensures missed runs are retried. All times in Danish time (Europe/Copenhagen, CET/CEST).
- **Email notifications** — Send export results as email with attachments via Mailjet (EU-based, GDPR-compliant). Centralized email service reusable by any page.
- **Alphabetical nav sorting** — All menu items are always sorted alphabetically at every level
- **Top-level menu groups** — Data Actions, Data Tables, Export, Interactions, and Phones each have their own top-level nav section
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
│ Every 5 min │── POST /api/ ───────▶│
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
| Scheduled runner | GitHub Actions cron (every 5 min) |
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
│   │   ├── placeholder.js        Generic "coming soon" stub
│   │   ├── dataactions/
│   │   │   ├── copyBetweenOrgs.js   Copy data action between orgs
│   │   │   └── edit.js              Edit / test existing data actions
│   │   ├── datatables/
│   │   │   ├── copySingleOrg.js     Copy table within same org
│   │   │   └── copyBetweenOrgs.js   Copy table between orgs
│   │   ├── interactions/
│   │   │   ├── search.js            Interaction Search page
│   │   │   ├── move.js              Move Interactions between queues
│   │   │   └── disconnect.js        Force-disconnect conversations
│   │   ├── export/
│   │   │   ├── scheduledExports.js   All Scheduled Exports overview
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
│           ├── allGroups.js      Server-side All Groups export handler
│           ├── allRoles.js       Server-side All Roles export handler
│           ├── filteredRoles.js  Server-side Filtered on Role(s) export handler
│           ├── lastLogin.js      Server-side Last Login export handler
│           └── trustee.js        Server-side trustee export handler
└── docs/
    ├── setup-guide.md            Full deployment guide
    └── conversion-reference.md   Python → JS migration reference
```

## Scheduled Exports

The app supports automated, server-side export execution with email delivery.

### How it works

1. **Schedule creation** — On any export page with automation enabled (e.g. Trustee, Last Login, All Roles, All Groups, Filtered on Role(s)), toggle on automation and configure a daily/weekly/monthly schedule with email recipients. Per-org exports include an org selector in the schedule form; Filtered on Role(s) also shows a dynamic role picker; Last Login also has an inactivity filter.
2. **GitHub Actions cron** — A workflow runs every 5 minutes and POSTs to `/api/scheduled-runner` with a shared secret
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
