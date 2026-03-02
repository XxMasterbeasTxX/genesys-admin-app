# Genesys Admin Tool — Setup & Deployment Guide

Complete guide for deploying the Genesys Admin Tool to a new Azure subscription. Covers Azure Static Web App, Azure Functions API, Azure Key Vault, Genesys Cloud OAuth, and CI/CD via GitHub Actions.

## Current features

- **Interaction Search** — Search conversations by date range, filter by participant data, view details, export to Excel
- **Move Interactions** — Move conversations between queues with media type and date filters
- **Disconnect Interactions** — Force-disconnect stuck/orphaned conversations by ID or empty a queue, with media type and date filters
- **Data Tables — Copy (Single Org)** — Copy a data table (structure + optionally rows) within the same org, with division selection
- **Data Tables — Copy between Orgs** — Copy a data table (structure + optionally rows) from one customer org to another, with target division and optional row copy
- **Data Actions — Copy between Orgs** — Copy a data action (contract + config) from one customer org to another, with target integration mapping and draft/publish toggle
- **Data Actions — Edit** — View, edit, and test existing data actions with draft/publish workflow, filter by status/category/integration. Edit name, category, request config (URL template, method, body, headers) and response config (translation map, success template) for any action; edit input/output contract schemas for draft-only actions. Save drafts, validate, publish, and run inline tests.
- **WebRTC Phones — Create** — Bulk-create WebRTC phones for all licensed users in a site, with Excel log export
- **WebRTC Phones — Change Site** — Move selected WebRTC phones from one site to another using a searchable multi-select picker, with progress tracking and Excel log export
- **Trustee Export** — Export a matrix of trustee-org users and their access across all customer orgs, determined by group membership, with per-trustee-org Excel sheets and styled formatting
- **Last Login Export** — Export user login data with license information for a selected org. One row per user-license combination, optional inactivity filter, collapsible preview with per-column filters, styled Excel matching the Python tool. Supports per-org scheduled automation.
- **All Groups Export** — Export all users (active, inactive, and deleted) with their group memberships for a selected org. One row per user-group combination (shared Index per user), collapsible preview with per-column filters, styled Excel matching the Python tool. Supports per-org scheduled automation.
- **All Roles Export** — Export all users (active, inactive, and deleted) with their role assignments for a selected org. One row per user-role combination (shared Index per user), collapsible preview with per-column filters, styled Excel matching the Python tool. Supports per-org scheduled automation.
- **Filtered on Role(s) Export** — Export active users filtered by one or more selected roles. One row per user with dynamic boolean columns (True/False) for each chosen role. Roles are loaded dynamically per org; the schedule form includes a role picker. Supports per-org scheduled automation with role selection stored in `exportConfig`.
- **License Consumption Export** — Export per-user licence consumption for a selected org. Fixed columns: Name, Email, Division. One boolean column per licence (or a single column when filtered to a specific licence). Licences are loaded dynamically via `/api/v2/license/definitions`; the schedule form includes a licence filter. Sheet: "User Licenses". Supports per-org scheduled automation with licence filter stored in `exportConfig`.
- **Roles Export (Single Org)** — Export all authorization roles for a selected org with accurate member counts (active org users only). Columns: Name, Description, Members. Supports per-org scheduled automation.
- **Roles Export (All Orgs)** — Export roles for all configured orgs in a single multi-sheet workbook (one sheet per org). Accurate member counts, on-demand only.
- **Scheduled Exports** — Automate any export on a daily/weekly/monthly schedule with email delivery. Server-side execution via GitHub Actions cron + Azure Functions. Catch-up logic, Danish time (CET/CEST), per-export automation toggle, org selector for per-org exports, "All Scheduled Exports" overview.
- **Email notifications** — Send export results as email with attachments via Mailjet (EU-based, GDPR-compliant)

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
13. [Configure Mailjet Email](#13-configure-mailjet-email)
14. [Configure Scheduled Exports](#14-configure-scheduled-exports)
15. [First Deployment](#15-first-deployment)
16. [Verification Checklist](#16-verification-checklist)
17. [Day-to-Day Operations](#17-day-to-day-operations)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. Prerequisites

| Tool / Account | Purpose |
| --- | --- |
| **GitHub account** | Source control and CI/CD |
| **Azure subscription** | Hosting via Azure Static Web Apps (free tier works) |
| **Genesys Cloud org** | OAuth client + API access |
| **Git** installed locally | Push code to GitHub |
| **Mailjet account** | Email sending (free tier: 200 emails/day) |

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

## 13. Configure Mailjet Email

The app sends email notifications (e.g. trustee export results) via [Mailjet](https://www.mailjet.com/) — a French, EU-based email API provider (GDPR-compliant).

### Create a Mailjet account

1. Go to [app.mailjet.com/signup](https://app.mailjet.com/signup) and create a free account
2. Free tier allows 200 emails/day, 6,000/month

### Verify your sender domain

1. In Mailjet, go to **Account Settings** → **Sender domains & addresses**
2. Add your domain (e.g. `versatech.nu`)
3. Add the required DNS records at your domain registrar:
   - **SPF**: Add `include:spf.mailjet.com` to your existing SPF TXT record
   - **DKIM**: Add the DKIM TXT record provided by Mailjet (host: `mailjet._domainkey`)
4. Verify both records are green in the Mailjet dashboard

### Get API credentials

1. In Mailjet, go to **Account Settings** → **REST API** → **API Key Management**
2. Copy your **API Key** and **Secret Key**

### Set Azure app settings

```bash
az staticwebapp appsettings set --name genesys-admin-app \
  --setting-names \
  "MAILJET_API_KEY=your-api-key" \
  "MAILJET_SECRET_KEY=your-secret-key" \
  "MAILJET_FROM_EMAIL=noreply@yourdomain.com" \
  "MAILJET_FROM_NAME=Genesys Admin App"
```

| Setting | Description |
| --- | --- |
| `MAILJET_API_KEY` | Mailjet API public key |
| `MAILJET_SECRET_KEY` | Mailjet API secret key |
| `MAILJET_FROM_EMAIL` | Sender address (must be on verified domain) |
| `MAILJET_FROM_NAME` | Display name for the sender |

### How it works

- Frontend calls `POST /api/send-email` with recipients, subject, body, and optional base64 attachment
- The Azure Function authenticates to Mailjet's v3.1 Send API using Basic auth
- Email is sent from the configured sender address
- The email service (`js/services/emailService.js`) is a centralized module — any page can import and use it

---

## 14. Configure Scheduled Exports

Scheduled exports let users automate any export (e.g. Trustee) on a daily, weekly, or monthly schedule with email delivery. The system uses Azure Table Storage for schedule data, and a GitHub Actions cron workflow to trigger the server-side runner every 5 minutes.

### 14a. Create an Azure Storage Account

1. Azure Portal → **Create a resource** → search **Storage account** → **Create**
2. Fill in:

    | Field | Value |
    | --- | --- |
    | **Subscription** | Same as your Static Web App |
    | **Resource group** | Same as your Static Web App |
    | **Storage account name** | e.g. `genesysadminstorage` (globally unique, lowercase, no hyphens) |
    | **Region** | Same as your Static Web App |
    | **Performance** | Standard |
    | **Redundancy** | LRS (Locally-redundant) is fine |

3. Click **Review + create** → **Create**
4. After creation, go to the storage account → **Access keys** → click **Show** on key1 → copy the **Connection string**

### 14b. Add Storage connection string to SWA app settings

```bash
az staticwebapp appsettings set --name genesys-admin-app \
  --resource-group rg-genesys-admin \
  --setting-names "AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=..."
```

Or via Azure Portal: Static Web App → **Configuration** → **Application settings** → **+ Add**

| Setting | Value |
| --- | --- |
| `AZURE_STORAGE_CONNECTION_STRING` | The full connection string from step 14a |

### 14c. Generate a shared secret for the runner

Generate any random string (e.g. a UUID) to protect the scheduled-runner endpoint:

```bash
# Example: generate a UUID
python -c "import uuid; print(uuid.uuid4())"
```

Add this value to **both** locations:

1. **Azure SWA app setting:** `SCHEDULE_RUNNER_KEY` = `<your-secret>`
2. **GitHub repository secret:** `SCHEDULE_RUNNER_KEY` = `<your-secret>` (same value)

### 14d. Add GitHub repository secrets

Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret name | Value |
| --- | --- |
| `SCHEDULE_RUNNER_KEY` | The shared secret from step 14c |
| `SWA_URL` | Your Static Web App URL (e.g. `https://happy-sky-abc123.azurestaticapps.net`) |

### 14e. How it works

1. A GitHub Actions workflow (`.github/workflows/scheduled-runner.yml`) runs every 5 minutes via cron
2. It POSTs to `/api/scheduled-runner` with the shared secret in the `x-runner-key` header
3. The Azure Function verifies the secret, loads enabled schedules from Azure Table Storage, checks which are due (in Danish time — Europe/Copenhagen, CET/CEST)
4. For each due schedule, it runs the export server-side using client credentials, builds the Excel file, and emails it via Mailjet
5. Catch-up logic: if a run is missed (GitHub Actions delays), the next cycle picks it up. Only one run per schedule per day.

### 14f. Test the runner

1. Go to GitHub → **Actions** → **Scheduled Export Runner** workflow
2. Click **Run workflow** → **Run workflow** (manual trigger)
3. Check the workflow log — it should show HTTP 200 and the response body

---

## 15. First Deployment

After pushing the config update:

1. Go to **GitHub** → **Actions** tab → verify the workflow completes ✅
2. Open your Static Web App URL in a browser
3. You should be redirected to the Genesys Cloud login page
4. After logging in, you'll land on the Welcome page
5. Select a customer org from the dropdown, then navigate using the sidebar

---

## 16. Verification Checklist

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
| 9 | Nav menu shows top-level groups | "Data Actions", "Data Tables", "Export", "Interactions", "Phones" — items sorted alphabetically |
| 10 | Interaction Search works | Date range search returns conversations |
| 11 | Excel export works | Downloads `.xlsx` file |
| 12 | Move Interactions works | Queue selectors load, preview and move succeed |
| 13 | Data Tables — Copy (Single Org) | Tables, divisions load; copy structure + rows succeeds |
| 14 | Data Tables — Copy between Orgs | Source/dest selectors; copy with division + rows succeeds |
| 15 | Data Actions — Copy between Orgs | Source/dest selectors; integration mapping; copy succeeds |
| 16 | Data Actions — Edit | Load actions; filter/search; published action: edit name/category + request/response config, save draft; draft-only action: also edit input/output contract schemas; validate/publish; test |
| 17 | Disconnect Interactions | Single/multiple/queue modes; media type + date filters; disconnect succeeds |
| 18 | WebRTC Phones — Create | Site selector; bulk create runs; summary shows counts; Excel download works |
| 19 | WebRTC Phones — Change Site | From/To site selectors; Load Phones; searchable multi-select; Move runs; Excel download works |
| 20 | Trustee Export | Export button scans all orgs; progress bar; matrix table displays; Excel download with styled formatting and per-trustee sheets |
| 21 | Email notification | Trustee export with email enabled sends attachment to recipients via Mailjet |
| 22 | Last Login Export | Select org; export runs; collapsible preview table with column filters; Excel download with styled formatting |
| 23 | Last Login email | Last Login export with email enabled sends attachment to recipients via Mailjet |
| 24 | All Groups Export | Select org; export runs (state=any); collapsible preview with column filters; Excel with Index, Name, eMail, Division, Active, LastLogin, WorkTeam, Group |
| 25 | All Groups email | All Groups export with email enabled sends attachment to recipients via Mailjet |
| 26 | All Groups scheduled export creation | Toggle automation on All Groups page; org selector shown in schedule form; schedule saved with exportConfig |
| 27 | All Roles Export | Select org; export runs (state=any); collapsible preview with column filters; Excel with Index, Name, Email, Division, Active, Date Last Login, Role |
| 28 | All Roles email | All Roles export with email enabled sends attachment to recipients via Mailjet |
| 29 | Scheduled export creation | Toggle automation on Trustee page; create daily/weekly/monthly schedule with recipients |
| 30 | Last Login scheduled export creation | Toggle automation on Last Login page; org selector and inactivity filter shown in schedule form; schedule saved with exportConfig |
| 31 | All Roles scheduled export creation | Toggle automation on All Roles page; org selector shown in schedule form; schedule saved with exportConfig |
| 35 | Filtered on Role(s) Export | Select org; load roles; pick ≥1 role; export runs (active users only); collapsible preview; Excel with Name, Email, Division + boolean role columns; sheet "User Roles" |
| 36 | Filtered on Role(s) email | Filtered on Role(s) export with email enabled sends attachment to recipients via Mailjet |
| 37 | Filtered on Role(s) scheduled export | Toggle automation; role picker loads dynamically per org; schedule saved with exportConfig.roles; Config column shown in schedule list |
| 38 | Roles Single Org Export | Select org; export runs; collapsible preview; Excel with Name, Description, Members; accurate member counts (active users only); sheet "Roles" |
| 39 | Roles Single Org email | Roles Single Org export with email enabled sends attachment to recipients via Mailjet |
| 40 | Roles Single Org scheduled export | Toggle automation on Roles Single Org page; org selector shown in schedule form; schedule saved with exportConfig |
| 41 | Roles All Orgs Export | Runs on-demand; one sheet per org in a single workbook; accurate member counts; per-org collapsible preview |
| 42 | Roles All Orgs email | Roles All Orgs export with email enabled sends multi-sheet attachment to recipients via Mailjet |
| 43 | License Consumption Export | Select org; click Load Licenses; licence definitions loaded into dropdown; choose "All Licenses" or a specific licence; export runs; collapsible preview with column filters on Name/Email/Division; Excel with Name, Email, Division + boolean licence columns; sheet "User Licenses" |
| 44 | License Consumption email | License Consumption export with email enabled sends attachment to recipients via Mailjet |
| 45 | License Consumption scheduled export | Toggle automation; licence filter picker loads dynamically per org; schedule saved with exportConfig.licenseFilter; Config column shown in schedule list |
| 32 | Scheduled Exports overview | All schedules visible on "Scheduled Exports" page; Organisation column shown for per-org exports; edit/delete restricted to owner + admin |
| 33 | Automated runner fires | GitHub Actions cron calls `/api/scheduled-runner`; response body visible in workflow logs |
| 34 | Automated email received | Scheduled export runs at configured time; email with Excel attachment arrives |
| 35 | Theme adapts | Dark/light matches OS setting |

---

## 17. Day-to-Day Operations

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

1. Create the page module in `js/pages/<category>/` (folder should mirror the nav tree, e.g. `js/pages/interactions/myFeature.js`)
2. Register the route in `js/pageRegistry.js`
3. Add a nav entry in `js/navConfig.js`
4. Commit, push — GitHub Actions deploys automatically

---

## 18. Troubleshooting

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

### Email sending fails with "Email service not configured"

- **Cause:** Mailjet app settings are missing
- **Fix:** Ensure `MAILJET_API_KEY`, `MAILJET_SECRET_KEY`, `MAILJET_FROM_EMAIL`, and `MAILJET_FROM_NAME` are set in Azure Static Web App → Configuration → Application settings

### Email sending fails with Mailjet API error

- **Cause:** Sender domain not verified, or API credentials incorrect
- **Fix:**
  1. Verify your domain in Mailjet dashboard (SPF + DKIM both green)
  2. Ensure `MAILJET_FROM_EMAIL` uses an address on the verified domain
  3. Confirm API Key and Secret Key are correct

### Scheduled runner returns 403

- **Cause:** `SCHEDULE_RUNNER_KEY` mismatch between GitHub secret and Azure app setting
- **Fix:** Ensure the value is identical in both GitHub repo → Settings → Secrets (`SCHEDULE_RUNNER_KEY`) and Azure SWA → Configuration → Application settings (`SCHEDULE_RUNNER_KEY`)

### Scheduled runner returns 500 "SCHEDULE_RUNNER_KEY not configured"

- **Cause:** The `SCHEDULE_RUNNER_KEY` app setting is missing from Azure SWA
- **Fix:** Add `SCHEDULE_RUNNER_KEY` to Static Web App → Configuration → Application settings

### Scheduled runner returns 500 "Failed to load schedules"

- **Cause:** `AZURE_STORAGE_CONNECTION_STRING` is missing or invalid
- **Fix:** Verify the connection string in Static Web App → Configuration → Application settings. Copy it fresh from Storage Account → Access keys.

### Scheduled exports not firing

- **Cause:** GitHub Actions cron workflow may be disabled or delayed
- **Fix:**
  1. Go to GitHub → Actions → check if "Scheduled Export Runner" is enabled (GitHub auto-disables cron workflows on inactive repos)
  2. GitHub cron can be delayed up to 15-20 minutes — the catch-up logic ensures exports still run
  3. Manually trigger the workflow to verify it works

### Schedule not picked up despite being due

- **Cause:** Schedule time is in the future (Danish time), or it already ran today
- **Fix:** Check the schedule's `lastRun` in the Scheduled Exports overview. The runner uses Europe/Copenhagen time — verify the schedule time is in the past for today.

---

## Architecture Overview

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
├── .github/
│   └── workflows/
│       ├── azure-static-web-apps-*.yml   SWA CI/CD (auto-generated)
│       └── scheduled-runner.yml          Cron trigger for scheduled exports
├── js/
│   ├── app.js                    Entry point (auth, router, org selector)
│   ├── config.js                 Environment configuration (OAuth, region)
│   ├── nav.js                    Recursive nav tree renderer (alphabetical sorting)
│   ├── navConfig.js              Navigation menu definition (enable/disable nodes)
│   ├── pageRegistry.js           Route → page-loader map
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
│   │   │   ├── licenses/
│   │   │   │   └── consumption.js   License Consumption export + per-org automation
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
│       ├── customerService.js    Fetches customer list from /api/customers
│       ├── emailService.js       Centralized email service (Mailjet via /api/send-email)
│       ├── genesysApi.js         Centralized Genesys Cloud API service
│       ├── orgContext.js         Selected org state management
│       └── scheduleService.js    Schedule CRUD API wrappers
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
│   ├── send-email/
│   │   ├── function.json         HTTP trigger binding
│   │   └── index.js              POST /api/send-email → Mailjet email sending
│   ├── schedules/
│   │   ├── function.json         HTTP trigger binding
│   │   └── index.js              CRUD /api/schedules → schedule management
│   ├── scheduled-runner/
│   │   ├── function.json         HTTP trigger binding (POST)
│   │   └── index.js              POST /api/scheduled-runner → export execution
│   └── lib/
│       ├── customers.json        Customer metadata (id, name, region)
│       ├── genesysAuth.js        Client Credentials token cache per org
│       ├── scheduleStore.js      Azure Table Storage CRUD for schedules
│       ├── exportHandlers.js     Export type → handler registry
│       └── exports/
│           ├── allGroups.js         Server-side All Groups export handler
│           ├── allRoles.js          Server-side All Roles export handler
│           ├── filteredRoles.js     Server-side Filtered on Role(s) export handler
│           ├── licensesConsumption.js Server-side License Consumption export handler
│           ├── rolesSingleOrg.js    Server-side Roles Single Org export handler
│           ├── lastLogin.js         Server-side Last Login export handler
│           └── trustee.js           Server-side trustee export handler
└── docs/
    ├── setup-guide.md            This file
    └── conversion-reference.md   Python → JS migration reference
```
