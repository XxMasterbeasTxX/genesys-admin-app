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
4. **Billing trustee** — if the customer should see Billing Period / Period Comparison, add a row to
   `api/lib/customers.json` with `"billingTrustee"` set to the org that is their trustee in Genesys
   (`"demo"` for Netdesign DE). Without a row the app assumes `"demo"`; set `null` for an org nobody
   reads billing for. This one field is the only place the trustee is recorded — the scheduled billing
   exports and the browser both read it from here.

---

## Step 3 — Choose packages

Pick the customer's purchased packages from the catalog. You list the **package names** in the registry
entry (Step 4) — the backend expands them into access-key prefixes automatically
(`api/lib/packages.js`). No need to write the prefixes by hand.

| Package name (registry value) | Grants (access-key prefixes) |
|---|---|
| `insights` | `audit.*`, `interactions.search.*`, `export.users.*`, `export.interactions.*`, `export.scheduled` |
| `interaction-ops` | `interactions.*` — except `interactions.recordings.*`, which is internal-only |
| `user-access` | `users.*`, `roles.*`, `divisions.*` |
| `configuration` | `data-tables.*`, `data-actions.edit`, `wrapupCodes.*`, `flows.*`, `phones.*` |
| `gdpr` | `gdpr.*` (add-on) |
| `all` | `*` — every module a customer may hold. **The current commercial model:** customers buy user licences and get everything, so a paying customer's entry is `["all"]` |
| `demo` | `*` — same grant as `all`; the reference customer's bundle (**internal, not for paying customers**) |

> Internal-only features (Utilities, Deployment, cross-org copies, trustee/all-orgs/billing exports,
> recording export jobs) are
> **never** in a package and are blocked server-side + hidden in customer mode. This holds for `demo`
> too — the `*` wildcard is applied *before* the customer-exclusion list, so it cannot reach them.
>
> **Billing pages need a trust relationship.** Export › Billing › Billing Period and Period Comparison show
> a customer their own overage by reading the trustee billing overview *as Netdesign*. They work only for
> orgs where Netdesign DE (or the trustee named in the org's `billingTrustee` row in `api/lib/customers.json`) is a trustee, and only
> for users holding `billing:subscription:view` in their own org. An org with no trustee sees "Billing is
> not available for this organisation through this app" — Test IE is one.
>
> **Which bundle for a paying customer?** `["all"]`, under the current per-user licensing model. The five
> named packages stay in the catalog as the granular tiers for a later return to selling by package —
> do not remove them. `demo` grants the same as `all` but is the reference customer's bundle; keep the
> two distinct in registry entries so it is always clear which kind of org an entry is.
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
  "packages": ["all"],
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

## Step 5 — Name the users who may use the app

Nobody in the customer's org can use the app until they are named. In the app, as a **Genesys App -
Master Admin**, select the customer in the header and open **Customers › Access to Admin Tool**. Type a
name or e-mail, pick the user from the dropdown, **Add**. Repeat for each licensed user. Everyone else in
the org sees *"No licence for this app is assigned to you"* — by design.

Adding a name is what the customer is billed for; removing one keeps the row as history so the billing
period's peak can be computed later. Removal takes effect within five minutes.

## Step 6 — Give the customer their launch URL

The customer opens the app (or embeds it as a Genesys **Integration → Custom Client Application**) with the
`?org=` deep link:

```
https://<swa-origin>/?org=<slug>
```

Example (Test IE on dev): `https://wonderful-rock-07e429f10.7.azurestaticapps.net/?org=test-ie`

On launch the app looks up the org's public login config, sends the user to **their own** region's login,
and after authentication locks the session to that org with the purchased menu.

---

## Step 7 — Verify

1. **Pre-login config resolves** (no login needed):
   ```
   curl.exe -s "https://<swa-origin>/api/org-config?org=<slug>"
   ```
   Expect `200` `{ "prelogin": true, "login": { id, name, region, clientId } }` — only these public fields.
2. **Login** from a fresh/incognito session at `…/?org=<slug>` → redirected to the customer's region login;
   after sign-in the org selector is **locked** to the customer and the menu shows only purchased packages
   (no Utilities, Deployment, cross-org copies, trustee/all-orgs/billing, recording exports).
3. **Data loads** for a purchased page (proves token-forwarding to the customer region).
4. **Isolation spot-check** (customer DevTools console, `t = sessionStorage.getItem('gc_access_token')`):
   ```js
   // own org OK
   fetch('/api/genesys-proxy',{method:'POST',headers:{'Content-Type':'application/json','X-Genesys-Token':t},body:JSON.stringify({customerId:'<slug>',method:'GET',path:'/api/v2/organizations/me'})}).then(r=>console.log('own', r.status));
   // another org blocked
   fetch('/api/genesys-proxy',{method:'POST',headers:{'Content-Type':'application/json','X-Genesys-Token':t},body:JSON.stringify({customerId:'demo',method:'GET',path:'/api/v2/organizations/me'})}).then(r=>console.log('other', r.status)); // expect 401/403
   ```

---

## Step 8 — Go live on prod

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
  "packages": ["insights", "interaction-ops", "user-access", "configuration", "gdpr", "demo"],
  "enabled": true
}
```

Launch URL: `https://wonderful-rock-07e429f10.7.azurestaticapps.net/?org=test-ie`
