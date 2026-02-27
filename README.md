# Genesys Admin Tool

Internal web application for the Genesys Team to perform administrative actions across multiple customer Genesys Cloud orgs.

## What it does

- **Org selector** — Pick any customer org from a dropdown; all functions use that org
- **Secure credential storage** — Customer Client IDs/Secrets stored in Azure Key Vault, never in frontend code
- **Proxied API calls** — All Genesys API calls go through an Azure Functions backend that handles authentication
- **OAuth PKCE login** — Team members authenticate via Genesys Cloud (your own org)
- **Dark/light theme** — Adapts to OS preference automatically

## Architecture

```text
Browser (SPA)                    Azure Static Web App (Standard)
┌─────────────┐                 ┌──────────────────────────────┐
│  Frontend   │───── /api/* ───▶│  Azure Functions (managed)   │
│  (JS SPA)   │                 │    ├─ GET /api/customers     │
│             │                 │    └─ POST /api/genesys-proxy│
│  Org select │                 │         │                    │
│  dropdown   │                 │         │ Managed Identity   │
└─────────────┘                 └─────────┼────────────────────┘
                                          │
                                   ┌──────▼───────┐
                                   │  Azure Key   │
                                   │  Vault       │
                                   │  (secrets)   │
                                   └──────────────┘
```

- **Frontend:** Vanilla JavaScript SPA with hash-based routing, deployed as an Azure Static Web App
- **Backend:** Azure Functions (Node.js) auto-deployed from the `api/` folder
- **Secrets:** Azure Key Vault with Managed Identity (no credentials in code)
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
├── staticwebapp.config.json      SPA routing config
├── css/styles.css                Styles (dark + light theme)
├── js/
│   ├── app.js                    App entry point
│   ├── config.js                 OAuth & region config
│   ├── nav.js                    Sidebar navigation
│   ├── navConfig.js              Navigation tree definition
│   ├── pageRegistry.js           Route → page loader map
│   ├── router.js                 Hash-based SPA router
│   ├── pages/                    Page modules
│   └── services/
│       ├── apiClient.js          API client + proxy
│       ├── authService.js        OAuth PKCE auth
│       ├── customerService.js    Customer list loader
│       └── orgContext.js         Selected org state
├── api/                          Azure Functions backend
│   ├── customers/                GET /api/customers
│   ├── genesys-proxy/            POST /api/genesys-proxy
│   └── lib/
│       ├── customers.json        Customer metadata
│       ├── genesysAuth.js        Token cache per org
│       └── keyVaultClient.js     Key Vault reader
└── docs/
    └── setup-guide.md            Full deployment guide
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

   ```text
   genesys-<id>-client-id
   genesys-<id>-client-secret
   ```

2. Add an entry to `api/lib/customers.json`:

   ```json
   { "id": "<id>", "name": "Customer Name", "region": "mypurecloud.de" }
   ```

3. Commit and push

## Adding a New Feature Page

1. Create a page module in `js/pages/`
2. Register the route in `js/pageRegistry.js`
3. Add a nav entry in `js/navConfig.js`
4. Commit and push

Pages receive `{ route, me, api, orgContext }` and can call customer APIs via:

```javascript
const data = await api.proxyGenesys(orgContext.get(), "GET", "/api/v2/...");
```

## License

Internal tool — not for public distribution.
