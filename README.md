# Genesys Admin Tool

Internal web application for the Genesys Team to perform administrative actions across multiple customer Genesys Cloud orgs.

## What it does

- **Org selector** — Pick any customer org from a dropdown; all pages use that org
- **Interaction Search** — Search conversations by date range, filter by participant data, view details, export to Excel (.xlsx)
- **Editable filter tags** — Click a filter tag to edit it; right-click a result row to copy its Conversation ID
- **Secure credential storage** — Customer Client IDs/Secrets managed in Azure Key Vault, delivered to the backend via encrypted app settings
- **Proxied API calls** — All Genesys API calls go through an Azure Functions backend that handles authentication
- **Centralized API service** — Shared `genesysApi.js` module with helpers for analytics, users, queues, flows, and more
- **OAuth PKCE login** — Team members authenticate via Genesys Cloud (your own org)
- **Welcome page** — App always starts on a clean welcome screen; no page or org is pre-selected
- **Dark/light theme** — Adapts to OS preference automatically

## Architecture

```text
Browser (SPA)                    Azure Static Web App (Standard)
┌─────────────┐                 ┌──────────────────────────────┐
│  Frontend   │───── /api/* ───▶│  Azure Functions (Node 18)   │
│  (JS SPA)   │                 │    ├─ GET /api/customers     │
│             │                 │    └─ POST /api/genesys-proxy│
│  Org select │                 │         │                    │
│  dropdown   │                 │         │ reads process.env  │
└─────────────┘                 └─────────┼────────────────────┘
                                          │
                                  Encrypted app settings
                                  (GENESYS_<ORG>_CLIENT_ID/SECRET)
                                          │
                                   ┌──────▼───────┐
                                   │  Azure Key   │
                                   │  Vault       │
                                   │  (source of  │
                                   │   truth)     │
                                   └──────────────┘
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
| CI/CD | GitHub Actions |

## Project Structure

```text
genesys-admin-app/
├── index.html                    App shell
├── staticwebapp.config.json      SPA routing + Node 18 runtime config
├── css/styles.css                Styles (dark + light theme)
├── js/
│   ├── app.js                    App entry point (auth, routing, org selector)
│   ├── config.js                 OAuth & region config
│   ├── nav.js                    Sidebar navigation renderer
│   ├── navConfig.js              Navigation tree definition
│   ├── pageRegistry.js           Route → page loader map
│   ├── router.js                 Hash-based SPA router
│   ├── utils.js                  Shared utilities (formatting, Excel export, etc.)
│   ├── components/
│   │   └── multiSelect.js        Reusable multi-select dropdown
│   ├── pages/
│   │   ├── welcome.js            Welcome / landing page
│   │   ├── notfound.js           404 page
│   │   ├── placeholder.js        Generic "coming soon" stub
│   │   └── actions/
│   │       └── interactionSearch.js  Interaction Search page
│   └── services/
│       ├── apiClient.js          HTTP client + Genesys proxy wrapper
│       ├── authService.js        OAuth 2.0 PKCE authentication
│       ├── customerService.js    Customer list loader
│       ├── genesysApi.js         Centralized Genesys Cloud API service
│       └── orgContext.js         Selected org state management
├── api/                          Azure Functions backend
│   ├── customers/                GET /api/customers
│   ├── genesys-proxy/            POST /api/genesys-proxy
│   └── lib/
│       ├── customers.json        Customer metadata (15 orgs)
│       └── genesysAuth.js        Client Credentials token cache per org
└── docs/
    ├── setup-guide.md            Full deployment guide
    └── conversion-reference.md   Python → JS migration reference
```

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

1. Create a page module in `js/pages/`
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
