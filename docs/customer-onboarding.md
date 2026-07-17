# Customer Onboarding Runbook

How to onboard a paying customer to the Genesys Admin App as a **self-service, single-org** user.
Follow these steps in order. **Do it on dev first, verify, then repeat for prod when going live.**

> **Background:** customers authenticate against **their own** Genesys org (PKCE token-forwarding) and
> are locked to that org server-side. Access is driven by **entitlements** (purchased packages). See
> [customer-facing-plan.md](customer-facing-plan.md) for the full architecture, the package catalog
> (§15), and the internal-only exclusions (§5).

---

## Prerequisites (per environment)

The Static Web App must have these environment variables set (see [setup-guide.md](setup-guide.md)):

| Setting | Purpose |
|---|---|
| `INTERNAL_COMPANY_ORG_ID` | GUID of your internal/demo org (distinguishes internal from customer) |
| `GENESYS_HOME_REGION` | Your internal org region (e.g. `mypurecloud.de`) |
| `CUSTOMER_REGISTRY_JSON` | JSON array of customer entries (this runbook adds to it) |

Dev SWA origin: `https://wonderful-rock-07e429f10.7.azurestaticapps.net`
Prod SWA origin: `https://icy-island-0ecc77903.7.azurestaticapps.net`

---

## Step 1 — Create a PKCE OAuth client in the customer's org

In the **customer's** Genesys Cloud org (Admin → Integrations → OAuth → Add client):

1. **Grant type:** `Code Authorization` (this is the PKCE flow).
2. **Authorized redirect URIs:** add the SWA origin(s) **exactly**, with **no trailing slash and no path**:
   - Dev: `https://wonderful-rock-07e429f10.7.azurestaticapps.net`
   - Prod: `https://icy-island-0ecc77903.7.azurestaticapps.net`
   - ⚠ A trailing slash (`…net/`) causes Genesys to reject login with *"The OAuth client ID or redirect
     URI is invalid"*. The app sends `redirect_uri = window.location.origin`, which never has a trailing slash.
3. **Scope:** select the same scopes as the internal/demo client (all scopes). Token access is still
   bounded by the **user's Genesys role**; our server-side org-lock + entitlement guard do the isolation.
4. **Save** and copy the **Client ID** (public — safe to store in the registry). No secret is used.

---

## Step 2 — Gather the customer's org details

1. **Org GUID** — from the customer org: `GET /api/v2/organizations/me` → `id` (or Admin → Organization Settings).
2. **Region** — the customer's Genesys region host, e.g. `mypurecloud.de`, `mypurecloud.ie`, `mypurecloud.com`.
3. **Slug** — a short id you choose for the URL/registry (e.g. `acme`). Lowercase, no spaces.

---

## Step 3 — Choose packages

Pick the customer's purchased packages from the catalog. You list the **package names** in the registry
entry (Step 4) — the backend expands them into access-key prefixes automatically
(`api/lib/packages.js`). No need to write the prefixes by hand.

| Package name (registry value) | Grants (access-key prefixes) |
|---|---|
| `insights` | `audit.*`, `interactions.search.*`, `export.users.*`, `export.interactions.*`, `export.scheduled` |
| `interaction-ops` | `interactions.*` |
| `user-access` | `users.*`, `roles.*`, `divisions.*` |
| `configuration` | `data-tables.*`, `data-actions.edit`, `wrapupCodes.*`, `flows.*`, `phones.*` |
| `gdpr` | `gdpr.*` (add-on) |

> Internal-only features (Utilities, Deployment, cross-org copies, trustee/all-orgs/billing exports) are
> **never** in a package and are blocked server-side + hidden in customer mode.
> (Advanced: an entry may also include an explicit `entitlements` array of prefixes; it is unioned with
> the expanded packages. Prefer packages.)

---

## Step 4 — Add the registry entry

Add one object to `CUSTOMER_REGISTRY_JSON` (Azure → Static Web App → **Environment variables**). It is a
single-line JSON **array**; append your entry to the existing array.

```json
{
  "id": "acme",
  "name": "Acme Corp",
  "orgId": "11111111-2222-3333-4444-555555555555",
  "region": "mypurecloud.de",
  "clientId": "<pkce-client-id-from-step-1>",
  "packages": ["insights", "gdpr"],
  "enabled": true
}
```

| Field | Notes |
|---|---|
| `id` | The slug (used in `?org=<id>` and as the owner tag for the customer's stored data) |
| `name` | Display name shown in the (locked) org selector |
| `orgId` | Customer org GUID (server verifies the login token against this) |
| `region` | Customer Genesys region |
| `clientId` | PKCE client id from Step 1 |
| `packages` | Purchased package names (Step 3); expanded to entitlements server-side |
| `entitlements` | *(optional)* explicit access-key prefixes, unioned with the packages |
| `enabled` | `true` to activate; set `false` to offboard without deleting |

Save. The Functions app restarts and picks up the change.

> **CLI tip (spaces/quotes safe):** the SWA CLI mangles values containing spaces + quotes. Write
> `CUSTOMER_REGISTRY_JSON=<one-line-json>` to a temp file and set it with
> `az staticwebapp appsettings set --name <swa> --resource-group <rg> --setting-names @<file>`.

---

## Step 5 — Give the customer their launch URL

The customer opens the app (or embeds it as a Genesys **Integration → Custom Client Application**) with the
`?org=` deep link:

```
https://<swa-origin>/?org=<slug>
```

Example (Test IE on dev): `https://wonderful-rock-07e429f10.7.azurestaticapps.net/?org=test-ie`

On launch the app looks up the org's public login config, sends the user to **their own** region's login,
and after authentication locks the session to that org with the purchased menu.

---

## Step 6 — Verify

1. **Pre-login config resolves** (no login needed):
   ```
   curl.exe -s "https://<swa-origin>/api/org-config?org=<slug>"
   ```
   Expect `200` `{ "prelogin": true, "login": { id, name, region, clientId } }` — only these public fields.
2. **Login** from a fresh/incognito session at `…/?org=<slug>` → redirected to the customer's region login;
   after sign-in the org selector is **locked** to the customer and the menu shows only purchased packages
   (no Utilities, Deployment, cross-org copies, trustee/all-orgs/billing).
3. **Data loads** for a purchased page (proves token-forwarding to the customer region).
4. **Isolation spot-check** (customer DevTools console, `t = sessionStorage.getItem('gc_access_token')`):
   ```js
   // own org OK
   fetch('/api/genesys-proxy',{method:'POST',headers:{'Content-Type':'application/json','X-Genesys-Token':t},body:JSON.stringify({customerId:'<slug>',method:'GET',path:'/api/v2/organizations/me'})}).then(r=>console.log('own', r.status));
   // another org blocked
   fetch('/api/genesys-proxy',{method:'POST',headers:{'Content-Type':'application/json','X-Genesys-Token':t},body:JSON.stringify({customerId:'demo',method:'GET',path:'/api/v2/organizations/me'})}).then(r=>console.log('other', r.status)); // expect 401/403
   ```

---

## Step 7 — Go live on prod

Repeat Step 1 redirect URI (prod origin), then Steps 3–6 against the **prod** SWA, adding the entry to the
**prod** `CUSTOMER_REGISTRY_JSON`. Keep dev and prod registries independent.

---

## Offboarding / changing a customer

- **Disable:** set `"enabled": false` on the registry entry (login stops resolving; data is retained).
- **Change packages:** edit the entry's `packages` and save; the customer re-logs in to pick up changes.
- **Remove:** delete the entry from `CUSTOMER_REGISTRY_JSON`.

---

## Worked example — Test IE (dev reference customer)

```json
{
  "id": "test-ie",
  "name": "Test IE",
  "orgId": "fa184a47-28ac-4532-bf31-d8da9de9c8cf",
  "region": "mypurecloud.ie",
  "clientId": "e439fc4f-3b8c-49be-a403-09280ec95510",
  "packages": ["insights", "interaction-ops", "user-access", "configuration", "gdpr"],
  "enabled": true
}
```

Launch URL: `https://wonderful-rock-07e429f10.7.azurestaticapps.net/?org=test-ie`
