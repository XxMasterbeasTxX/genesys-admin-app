# Genesys Admin Tool — Setup & Deployment Guide

Complete guide for deploying the Genesys Admin Tool to a new Azure subscription. Covers Azure Static Web App, Azure Functions API, Azure Key Vault, Genesys Cloud OAuth, and CI/CD via GitHub Actions.

## Current features

- **Interaction Search** — Search conversations by date range, filter by participant data, view details, export to Excel
- **Move Interactions** — Move conversations between queues with media type and date filters
- **Disconnect Interactions** — Force-disconnect stuck/orphaned conversations by ID or empty a queue, with media type and date filters
- **Data Tables — Copy (Single Org)** — Copy a data table (structure + optionally rows) within the same org, with division selection
- **Data Tables — Copy between Orgs** — Copy a data table (structure + optionally rows) from one customer org to another, with target division and optional row copy
- **Data Actions — Copy between Orgs** — Copy a data action (contract + config) from one customer org to another, with target integration mapping and draft/publish toggle
- **Data Actions — Edit** — View, edit, and test existing data actions with draft/publish workflow, filter by status/category/integration, inline testing
- **WebRTC Phones — Create** — Bulk-create WebRTC phones for all licensed users in a site, with Excel log export

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Create the GitHub Repository](#2-create-the-github-repository)
3. [Create an Azure Static Web App](#3-create-an-azure-static-web-app)
4. [GitHub Actions CI/CD (automatic)](#4-github-actions-cicd-automatic)
5. [Create a Genesys Cloud OAuth Client](#5-create-a-genesys-cloud-oauth-client)
6. [Update config.js](#6-update-configjs)
7. [Create Azure Key Vault](#7-create-azure-key-vault)
8. [Add Customer Secrets to Key Vault](#8-add-customer-secrets-to-key-vault)
9. [Enable Managed Identity](#9-enable-managed-identity)
10. [Grant Key Vault Access](#10-grant-key-vault-access)
11. [Configure App Settings](#11-configure-app-settings)
12. [Update customers.json](#12-update-customersjson)
13. [First Deployment](#13-first-deployment)
14. [Verification Checklist](#14-verification-checklist)
15. [Day-to-Day Operations](#15-day-to-day-operations)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Prerequisites

| Tool / Account | Purpose |
| --- | --- |
| **GitHub account** | Source control and CI/CD |
| **Azure subscription** | Hosting via Azure Static Web Apps (free tier works) |
| **Genesys Cloud org** | OAuth client + API access |
| **Git** installed locally | Push code to GitHub |

---

## 2. Create the GitHub Repository

### Option A — GitHub Web UI

1. Go to [github.com/new](https://github.com/new)
2. **Repository name:** `genesys-admin-app` (or your preferred name)
3. **Visibility:** Private (recommended for internal tools)
4. **Do NOT** initialise with README, `.gitignore`, or license (we'll push existing code)
5. Click **Create repository**
6. Copy the remote URL (HTTPS or SSH)

### Option B — GitHub CLI

```bash
gh repo create genesys-admin-app --private --source=. --remote=origin
```

### Push the scaffold

```bash
cd "C:\Users\thoma\OneDrive\Dokumenter\Python\Github\Genesys-Admin-App"
git init
git add .
git commit -m "feat: initial admin app scaffold"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/genesys-admin-app.git
git push -u origin main
```

---

## 3. Create an Azure Static Web App

### Step-by-step in the Azure Portal

1. Go to the [Azure Portal](https://portal.azure.com)
2. Click **Create a resource** → search **Static Web App** → click **Create**
3. Fill in:

| Field | Value |
| --- | --- |
| **Subscription** | Your Azure subscription |
| **Resource group** | Create new or use existing (e.g. `rg-genesys-admin`) |
| **Name** | `genesys-admin-app` |
| **Plan type** | **Standard** ($9/month — required for Managed Identity) |
| **Region** | West Europe (or closest to your users) |
| **Source** | **GitHub** |

1. Click **Sign in with GitHub** and authorise Azure to access your repos
2. Select:
   - **Organisation:** your GitHub user/org
   - **Repository:** `genesys-admin-app`
   - **Branch:** `main`
3. **Build Details:**

| Field | Value |
| --- | --- |
| **Build Preset** | Custom |
| **App location** | `/` |
| **Api location** | `api` |
| **Output location** | `.` |

1. Click **Review + Create** → **Create**

> **What happens next:** Azure automatically creates a GitHub Actions workflow file (`.github/workflows/azure-static-web-apps-*.yml`) and commits it to your repo. Every push to `main` will deploy automatically.

### Note the URL

After deployment completes (1–2 minutes), go to the Static Web App resource in Azure Portal. Copy the **URL** — it looks like:

```text
https://happy-sky-abc123.azurestaticapps.net
```

You will need this URL for the OAuth redirect URI in step 5.

---

## 4. GitHub Actions CI/CD (automatic)

Azure creates the workflow automatically in step 3. Here's what it does and how to verify it.

### Verify the workflow

1. Go to your GitHub repo → **Actions** tab
2. You should see a workflow named something like `Azure Static Web Apps CI/CD`
3. Click the latest run — it should show ✅ green
4. Every future push to `main` triggers a new deployment

### Workflow file location

```text
.github/workflows/azure-static-web-apps-*.yml
```

### What the workflow file looks like (auto-generated)

```yaml
name: Azure Static Web Apps CI/CD

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, synchronize, reopened, closed]
    branches:
      - main

jobs:
  build_and_deploy_job:
    if: github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.action != 'closed')
    runs-on: ubuntu-latest
    name: Build and Deploy Job
    steps:
      - uses: actions/checkout@v3
        with:
          submodules: true
          lfs: false
      - name: Build And Deploy
        id: builddeploy
        uses: Azure/static-web-apps-deploy@v1
        with:
          azure_static_web_apps_api_token: ${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN_XXXXX }}
          repo_token: ${{ secrets.GITHUB_TOKEN }}
          action: "upload"
          app_location: "/"
          api_location: ""
          output_location: ""

  close_pull_request_job:
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    runs-on: ubuntu-latest
    name: Close Pull Request Job
    steps:
      - name: Close Pull Request
        id: closepullrequest
        uses: Azure/static-web-apps-deploy@v1
        with:
          azure_static_web_apps_api_token: ${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN_XXXXX }}
          action: "close"
```

### Key points

- **`AZURE_STATIC_WEB_APPS_API_TOKEN_XXXXX`**: Azure automatically adds this as a GitHub secret when you link the repo. You don't need to create it manually.
- **Pull request previews**: PRs to `main` get a temporary staging URL automatically. You can see it in the PR comments.
- **No build step needed**: This is a vanilla JS app — no `npm build` required. The deploy action uploads files as-is.

### Optional: Add a routing fallback file

For SPA hash-routing to work correctly, create a `staticwebapp.config.json` in the project root:

```json
{
  "navigationFallback": {
    "rewrite": "/index.html",
    "exclude": ["/css/*", "/js/*", "/images/*", "/*.ico"]
  }
}
```

This ensures that deep-linking (e.g. refreshing on a page) always loads `index.html`.

---

## 5. Create a Genesys Cloud OAuth Client

1. Log in to your Genesys Cloud org (e.g. `https://apps.mypurecloud.de`)
2. Go to **Admin** → **Integrations** → **OAuth**
3. Click **Add Client**
4. Fill in:

| Field | Value |
| --- | --- |
| **App Name** | Genesys Admin Tool |
| **Grant Type** | Token Implicit Grant (Browser) |
| **Authorized redirect URIs** | `https://YOUR-SWA-URL.azurestaticapps.net` |

> **Important:** Use the exact Static Web App URL from step 3. No trailing slash.

1. Click **Save**
2. Copy the **Client ID** — you'll need it for `config.js`

### Required OAuth Scopes / Roles

For the initial Actions feature, the OAuth client's role needs at minimum:

| Permission | Purpose |
| --- | --- |
| `user:readonly` | Fetch `/users/me` for auth verification |

Add more scopes later as features are built (e.g. `processautomation`, `architect`, etc.).

> **Note:** This is a *separate* OAuth client from the customer-facing app. Different client ID, different redirect URI, different role/scopes.

---

## 6. Update config.js

Open `js/config.js` and replace the placeholder values:

```javascript
export const CONFIG = {
  appName:          "Genesys Admin Tool",
  region:           "mypurecloud.de",

  apiBase:          "https://api.mypurecloud.de",
  authHost:         "login.mypurecloud.de",

  oauthClientId:    "paste-your-client-id-here",         // ← from step 5
  oauthRedirectUri: "https://your-swa-url.azurestaticapps.net",  // ← from step 3
  oauthScopes:      ["openid", "profile", "email"],
};
```

Commit and push:

```bash
git add js/config.js
git commit -m "chore: configure OAuth client"
git push
```

GitHub Actions will deploy automatically within ~60 seconds.

---

## 7. Create Azure Key Vault

The Key Vault securely stores all customer Genesys Cloud credentials (Client IDs and Client Secrets).

### Azure Portal — Create Key Vault

1. Search **"Key vaults"** → click **Create**
2. Fill in:

| Field | Value |
| --- | --- |
| **Subscription** | Same as your Static Web App |
| **Resource group** | Same as your Static Web App |
| **Key vault name** | e.g. `genesys-admin-kv` (must be globally unique) |
| **Region** | Same region as your Static Web App |
| **Pricing tier** | Standard |

1. Click **Next: Access configuration**
2. Set **Permission model** to **Azure role-based access control (recommended)**
3. Click **Review + create** → **Create**

### Azure CLI alternative — Create Key Vault

```bash
az keyvault create \
  --name genesys-admin-kv \
  --resource-group rg-genesys-admin \
  --location westeurope
```

---

## 8. Add Customer Secrets to Key Vault

Each customer requires exactly 2 secrets. The naming convention is:

```text
genesys-<customer-id>-client-id
genesys-<customer-id>-client-secret
```

Where `<customer-id>` matches the `id` field in `api/lib/customers.json`.

### Give yourself access first

1. Key Vault → **Access control (IAM)** → **+ Add role assignment**
2. Role: **Key Vault Secrets Officer**
3. Assign to: your own user account

### Add secrets via Azure CLI (recommended for bulk import)

```bash
az keyvault secret set --vault-name genesys-admin-kv \
  --name "genesys-acme-client-id" --value "your-client-id-here"

az keyvault secret set --vault-name genesys-admin-kv \
  --name "genesys-acme-client-secret" --value "your-client-secret-here"
```

### Add secrets via Azure Portal

Key Vault → **Secrets** → **+ Generate/Import** → fill in Name and Secret value → **Create**

Repeat for every customer (2 secrets each).

---

## 9. Enable Managed Identity

Managed Identity allows the Static Web App to authenticate to Key Vault without any passwords in code.

> **Note:** This requires the **Standard plan** ($9/month). Free tier does not support Managed Identity.

### Azure Portal — Enable Managed Identity

1. Azure Portal → **Static Web Apps** → your app
2. Left menu → **Identity**
3. **System assigned** tab → flip **Status** to **On**
4. Click **Save** → confirm **Yes**

### Azure CLI alternative — Grant Key Vault Access

```bash
az staticwebapp identity assign --name genesys-admin-app \
  --resource-group rg-genesys-admin
```

Note the **Object (principal) ID** that appears — needed for the next step.

---

## 10. Grant Key Vault Access

Grant the Managed Identity permission to read secrets from Key Vault.

### Azure Portal

1. Key Vault → **Access control (IAM)** → **+ Add role assignment**
2. Role: **Key Vault Secrets User**
3. Assign access to: **Managed identity**
4. Select members: your Static Web App's managed identity
5. **Review + assign**

### Azure CLI alternative

```bash
# Get the principal ID
PRINCIPAL_ID=$(az staticwebapp show --name genesys-admin-app \
  --resource-group rg-genesys-admin --query "identity.principalId" -o tsv)

# Assign the role
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee-object-id $PRINCIPAL_ID \
  --assignee-principal-type ServicePrincipal \
  --scope /subscriptions/<SUB_ID>/resourceGroups/<RG>/providers/Microsoft.KeyVault/vaults/genesys-admin-kv
```

---

## 11. Configure App Settings

Customer credentials must be stored as encrypted app settings so the Azure Functions can read them via `process.env`.

> **Why not Key Vault References or SDK calls?** Azure Static Web Apps' managed function sandbox does not support Managed Identity token retrieval at runtime. Key Vault Reference syntax (`@Microsoft.KeyVault(...)`) is an App Service feature, not available in SWA. Instead, read the secret values from Key Vault via Azure CLI and set them as plain encrypted app settings.

### Naming convention

For each customer, set two app settings. The env var name uses underscores and uppercase:

```text
GENESYS_<ID>_CLIENT_ID      (e.g. GENESYS_ACME_CLIENT_ID)
GENESYS_<ID>_CLIENT_SECRET   (e.g. GENESYS_ACME_CLIENT_SECRET)
```

Where `<ID>` is the customer id from `customers.json` with hyphens replaced by underscores, uppercased.

### Set app settings via Azure CLI

```bash
# Read secret from Key Vault and set as app setting (repeat for each customer)
CLIENT_ID=$(az keyvault secret show --vault-name genesys-admin-kv \
  --name "genesys-acme-client-id" --query value -o tsv)

CLIENT_SECRET=$(az keyvault secret show --vault-name genesys-admin-kv \
  --name "genesys-acme-client-secret" --query value -o tsv)

az staticwebapp appsettings set --name genesys-admin-app \
  --resource-group rg-genesys-admin \
  --setting-names "GENESYS_ACME_CLIENT_ID=$CLIENT_ID" "GENESYS_ACME_CLIENT_SECRET=$CLIENT_SECRET"
```

### Azure Portal alternative

Static Web App → **Configuration** → **Application settings** → **+ Add** — paste the Name and Value manually.

---

## 12. Update customers.json

Edit `api/lib/customers.json` with all customer orgs. This file contains **metadata only** (no secrets):

```json
[
  { "id": "acme",    "name": "Acme Corp",   "region": "mypurecloud.de" },
  { "id": "contoso", "name": "Contoso Ltd", "region": "mypurecloud.ie" }
]
```

| Field | Description |
| --- | --- |
| `id` | Unique identifier — must match Key Vault secret naming (`genesys-<id>-client-id`) |
| `name` | Display name shown in the org selector dropdown |
| `region` | Genesys Cloud region (`mypurecloud.de`, `mypurecloud.ie`, `mypurecloud.com`, etc.) |

Commit and push to deploy.

---

## 13. First Deployment

After pushing the config update:

1. Go to **GitHub** → **Actions** tab → verify the workflow completes ✅
2. Open your Static Web App URL in a browser
3. You should be redirected to the Genesys Cloud login page
4. After logging in, you'll land on the Welcome page
5. Select a customer org from the dropdown, then navigate using the sidebar

---

## 14. Verification Checklist

| # | Check | Expected |
| --- | --- | --- |
| 1 | GitHub Actions workflow runs | ✅ Green check on Actions tab |
| 2 | Static Web App URL loads | Shows login redirect |
| 3 | OAuth login completes | Redirects back to app |
| 4 | Header shows user name | `Auth: ok · Your Name` |
| 5 | Welcome page is shown | No nav item is pre-selected |
| 6 | Org selector dropdown appears | Lists all customers from `customers.json` |
| 7 | `/api/customers` endpoint works | Returns JSON array of customers |
| 8 | Selecting a customer updates the page | Page responds to org change |
| 9 | Nav menu shows top-level groups | "Data Actions", "Data Tables", "Interactions", "Phones" — items sorted alphabetically |
| 10 | Interaction Search works | Date range search returns conversations |
| 11 | Excel export works | Downloads `.xlsx` file |
| 12 | Move Interactions works | Queue selectors load, preview and move succeed |
| 13 | Data Tables — Copy (Single Org) | Tables, divisions load; copy structure + rows succeeds |
| 14 | Data Tables — Copy between Orgs | Source/dest selectors; copy with division + rows succeeds |
| 15 | Data Actions — Copy between Orgs | Source/dest selectors; integration mapping; copy succeeds |
| 16 | Data Actions — Edit | Load actions; filter/search; edit name/category; save/validate/publish; test |
| 17 | Disconnect Interactions | Single/multiple/queue modes; media type + date filters; disconnect succeeds |
| 18 | WebRTC Phones — Create | Site selector; bulk create runs; summary shows counts; Excel download works |
| 19 | Theme adapts | Dark/light matches OS setting |

---

## 15. Day-to-Day Operations

### Adding a new customer

1. Add 2 secrets to Key Vault:

   ```bash
   az keyvault secret set --vault-name genesys-admin-kv \
     --name "genesys-<id>-client-id" --value "..."
   az keyvault secret set --vault-name genesys-admin-kv \
     --name "genesys-<id>-client-secret" --value "..."
   ```

2. Copy the values into SWA app settings:

   ```bash
   az staticwebapp appsettings set --name genesys-admin-app \
     --resource-group rg-genesys-admin \
     --setting-names "GENESYS_<ID>_CLIENT_ID=..." "GENESYS_<ID>_CLIENT_SECRET=..."
   ```

3. Add an entry to `api/lib/customers.json`
4. Commit and push — the new customer appears in the dropdown after deployment

### Rotating a customer's credentials

1. Update the 2 secrets in Key Vault (same secret names, new values)
2. Update the corresponding SWA app settings with the new values:

   ```bash
   az staticwebapp appsettings set --name genesys-admin-app \
     --resource-group rg-genesys-admin \
     --setting-names "GENESYS_<ID>_CLIENT_ID=<new-value>" "GENESYS_<ID>_CLIENT_SECRET=<new-value>"
   ```

3. The API picks up the new values on the next function cold start

### Removing a customer

1. Remove the entry from `api/lib/customers.json`
2. Commit and push
3. Optionally delete the 2 secrets from Key Vault

### Adding a new feature page

1. Create the page module in `js/pages/` (e.g. `js/pages/actions/triggers.js`)
2. Register the route in `js/pageRegistry.js`
3. Add a nav entry in `js/navConfig.js`
4. Commit, push — GitHub Actions deploys automatically

---

## 16. Troubleshooting

### Login redirects in a loop

- **Cause:** Redirect URI mismatch between OAuth client and `config.js`
- **Fix:** Ensure the URI in Genesys OAuth settings *exactly* matches `CONFIG.oauthRedirectUri` (no trailing slash, same protocol)

### 404 on page refresh

- **Cause:** Missing SPA fallback configuration
- **Fix:** Add `staticwebapp.config.json` to the project root (see step 4)

### GitHub Actions fails with "API token not found"

- **Cause:** The Azure-GitHub link was broken or the secret was deleted
- **Fix:**
  1. Go to Azure Portal → Static Web App → **Manage deployment token**
  2. Copy the token
  3. Go to GitHub repo → **Settings** → **Secrets and variables** → **Actions**
  4. Create/update the secret named `AZURE_STATIC_WEB_APPS_API_TOKEN_XXXXX` with the token

### Blank page after login

- **Cause:** JavaScript module loading error (usually a missing file or incorrect import path)
- **Fix:** Open browser DevTools (F12) → Console tab → check for `404` or `import` errors

### "Missing CONFIG.oauthClientId" error

- **Cause:** `config.js` still has placeholder values
- **Fix:** Update `oauthClientId` and `oauthRedirectUri` with real values from steps 3 and 5

### Org selector shows "Failed to load customers"

- **Cause:** The `/api/customers` endpoint is not deployed or erroring
- **Fix:** Check that `api_location: "api"` is set in the GitHub Actions workflow file. Visit `/api/customers` directly in the browser to see the error.

### Proxy returns "Credentials not configured for ..."

- **Cause:** App settings are missing or named incorrectly
- **Fix:** Verify that app settings `GENESYS_<ID>_CLIENT_ID` and `GENESYS_<ID>_CLIENT_SECRET` exist in Static Web App → Configuration. The `<ID>` is the customer id from `customers.json` with hyphens replaced by underscores, uppercased.

### Proxy returns 401 from Genesys

- **Cause:** The client credentials are invalid or expired
- **Fix:** Verify the Client ID and Secret in Genesys Cloud. Update both Key Vault secrets and the corresponding SWA app settings.

---

## Architecture Overview

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

---

## Project Structure

```text
genesys-admin-app/
├── index.html                    App shell (entry point)
├── download.html                 Iframe-safe file download helper
├── staticwebapp.config.json      SPA routing fallback + Node 18 runtime
├── .gitignore                    Ignores local.settings.json and node_modules
├── css/
│   └── styles.css                Core layout + dark/light theme
├── js/
│   ├── app.js                    Entry point (auth, router, org selector)
│   ├── config.js                 Environment configuration (OAuth, region)
│   ├── nav.js                    Recursive nav tree renderer (alphabetical sorting)
│   ├── navConfig.js              Navigation menu definition (enable/disable nodes)
│   ├── pageRegistry.js           Route → page-loader map
│   ├── router.js                 Hash-based SPA router
│   ├── utils.js                  Shared utilities (formatting, Excel export, etc.)
│   ├── lib/
│   │   └── xlsx.full.min.js      SheetJS library for Excel export
│   ├── components/
│   │   └── multiSelect.js        Reusable multi-select dropdown
│   ├── pages/
│   │   ├── welcome.js            Welcome / landing page
│   │   ├── notfound.js           404 page
│   │   ├── placeholder.js        Generic "coming soon" stub
│   │   └── actions/
│   │       ├── interactionSearch.js    Interaction Search page
│   │       ├── moveInteractions.js     Move Interactions between queues
│   │       ├── datatables/
│   │       │   ├── copySingleOrg.js    Copy data table within same org
│   │       │   └── copyBetweenOrgs.js  Copy data table between orgs
│   │       └── dataactions/
│   │           └── copyBetweenOrgs.js  Copy data action between orgs
│   └── services/
│       ├── apiClient.js          HTTP client + Genesys proxy wrapper
│       ├── authService.js        OAuth 2.0 PKCE authentication
│       ├── customerService.js    Fetches customer list from /api/customers
│       ├── genesysApi.js         Centralized Genesys Cloud API service
│       └── orgContext.js         Selected org state management
├── api/                          Azure Functions backend (auto-deployed)
│   ├── host.json                 Functions host configuration
│   ├── package.json              API dependencies
│   ├── local.settings.json       Local dev settings (git-ignored)
│   ├── customers/
│   │   ├── function.json         HTTP trigger binding
│   │   └── index.js              GET /api/customers → customer metadata
│   ├── genesys-proxy/
│   │   ├── function.json         HTTP trigger binding
│   │   └── index.js              POST /api/genesys-proxy → proxied API calls
│   └── lib/
│       ├── customers.json        Customer metadata (id, name, region)
│       └── genesysAuth.js        Client Credentials token cache per org
└── docs/
    ├── setup-guide.md            This file
    └── conversion-reference.md   Python → JS migration reference
```
