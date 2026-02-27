# Genesys Admin Tool — Setup & Deployment Guide

Complete guide for setting up the GitHub repository, Azure Static Web App, CI/CD with GitHub Actions, and Genesys Cloud OAuth.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Create the GitHub Repository](#2-create-the-github-repository)
3. [Create an Azure Static Web App](#3-create-an-azure-static-web-app)
4. [GitHub Actions CI/CD (automatic)](#4-github-actions-cicd-automatic)
5. [Create a Genesys Cloud OAuth Client](#5-create-a-genesys-cloud-oauth-client)
6. [Update config.js](#6-update-configjs)
7. [First Deployment](#7-first-deployment)
8. [Verification Checklist](#8-verification-checklist)
9. [Troubleshooting](#9-troubleshooting)

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
| **Plan type** | Free |
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
| **Api location** | *(leave empty)* |
| **Output location** | *(leave empty)* |

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

## 7. First Deployment

After pushing the config update:

1. Go to **GitHub** → **Actions** tab → verify the workflow completes ✅
2. Open your Static Web App URL in a browser
3. You should be redirected to the Genesys Cloud login page
4. After logging in, you'll land on the admin app with the "Actions — Overview" page

---

## 8. Verification Checklist

| # | Check | Expected |
| --- | --- | --- |
| 1 | GitHub Actions workflow runs | ✅ Green check on Actions tab |
| 2 | Static Web App URL loads | Shows login redirect |
| 3 | OAuth login completes | Redirects back to app |
| 4 | Header shows user name | `Auth: ok · Your Name` |
| 5 | Nav menu shows "Actions" | Collapsible group with "Overview" leaf |
| 6 | Actions Overview page loads | Shows welcome message with your name |
| 7 | Theme adapts | Dark/light matches OS setting |

---

## 9. Troubleshooting

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

---

## Project Structure

```text
genesys-admin-app/
├── index.html                    App shell (entry point)
├── staticwebapp.config.json      SPA routing fallback
├── css/
│   └── styles.css                Core layout + theme
├── js/
│   ├── app.js                    Entry point (auth + router bootstrap)
│   ├── config.js                 Environment configuration
│   ├── nav.js                    Recursive nav tree renderer
│   ├── navConfig.js              Navigation menu definition
│   ├── pageRegistry.js           Route → page-loader map
│   ├── router.js                 Hash-based SPA router
│   ├── utils.js                  Shared utilities
│   ├── components/
│   │   └── multiSelect.js        Reusable multi-select dropdown
│   ├── pages/
│   │   ├── welcome.js            Landing page
│   │   ├── notfound.js           404 page
│   │   ├── placeholder.js        Generic "coming soon" stub
│   │   └── actions/
│   │       └── overview.js       Actions overview page
│   └── services/
│       ├── apiClient.js          Genesys Cloud API wrapper
│       └── authService.js        OAuth 2.0 PKCE authentication
└── docs/
    └── setup-guide.md            This file
```

---

## Adding New Features

When you add a new page:

1. Create the page module in `js/pages/` (e.g. `js/pages/actions/triggers.js`)
2. Register the route in `js/pageRegistry.js`
3. Add a nav entry in `js/navConfig.js`
4. Add any new OAuth scopes to `config.js` and the Genesys OAuth client
5. Commit, push — GitHub Actions deploys automatically
