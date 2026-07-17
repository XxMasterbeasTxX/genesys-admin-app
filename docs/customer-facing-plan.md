# Customer-Facing Expansion — Architecture & Migration Plan

> **Status:** Planning / living document. We build **one step at a time** and **test each step
> thoroughly** before moving on. Tweak this doc as decisions evolve.
>
> **Last updated:** 2026-07-06

---

## 1. Goal

Make the Genesys Admin App serve **customers** (self-service against **their own org only**) in
addition to internal staff, from **one app**. Customers buy tiered **module access**. A customer
must **never** be able to see or affect another customer's data — enforced **both client-side and
server-side**.

---

## 2. Guiding principle — one app, two auth paths chosen by *who logs in*

Internal staff operate across **many** customer orgs (they have no user account in those orgs), so
they need the existing elevated **client-credentials** path. Customers operate only on their **own**
org and must use **token-forwarding** (their own Genesys token) so Genesys itself enforces access.
"Same app, different access" therefore means the app selects its auth path from the **authenticated
identity**, decided **server-side**.

| | Internal staff | Customer users |
|---|---|---|
| Logs into | Company (demo) Genesys org | Their **own** Genesys org |
| Auth to Genesys | **Client-credentials** (existing) | **Token-forwarding** (user's own token) |
| Org selection | Free selector (all customers) | **Locked** to their own org (no selector) |
| Authorization boundary | Company group membership **+** the user's own demo-org permissions (write actions only) | Genesys's own role enforcement **+** purchased-module entitlements |

---

## 3. The critical security gap to close

Today [`api/genesys-proxy/index.js`](../api/genesys-proxy/index.js) accepts `{ customerId, method,
path, body }` from the browser and executes **any method against any path** on **any** configured
org using full client-credential power, with **no** link between the logged-in user and the org.
Acceptable for trusted internal staff; a **complete tenant-isolation failure** for customers.
Everything below exists to fix that.

---

## 4. Target architecture

### 4.1 Identity & mode detection (server-side)
- On login resolve `organizations/me`; compare org GUID to the **company org GUID**.
  - Match → **Internal mode** (existing behaviour).
  - Else → look the org up in the **server-side customer registry**; found + entitled → **Customer mode**; not found → hard-fail "organization not recognized".
- Mode is decided **server-side** and never trusted from the client.

### 4.2 Customer registry (server-side, chosen approach)
A server-side registry file (mirroring the sibling apps' `api/data/customers.js`) keyed by org:
`orgId` (GUID), `region`, `clientId` (customer-org PKCE client — public, not a secret),
`entitlements` (purchased **modules**). The browser only ever receives its **own** org's public
config via a new `GET /api/org-config`; the full registry never ships to the client.

### 4.3 Two proxy paths, one endpoint
Refactor the proxy so it:
1. Determines mode from the **authenticated session**, not from `customerId` in the body.
2. **Customer mode:** forwards the user's own token (`X-Genesys-Token`, because SWA overwrites
   `Authorization`), resolves the region **from the registry** (never client-supplied), and
   **rejects any request whose path isn't in the entitlement allowlist** for that customer.
3. **Internal mode:** keeps the current client-credentials flow.

### 4.4 Defense in depth — enforce entitlements on **both** sides
- **Client-side (UX):** reuse the existing access-key machinery
  ([`js/services/accessService.js`](../js/services/accessService.js), nav + route gates in
  [`js/app.js`](../js/app.js)). In Customer mode the key set comes from the customer's
  **entitlements** instead of company group membership.
- **Server-side (security):** the proxy independently enforces an **endpoint allowlist derived from
  the same entitlements**. This is the real boundary — the client gate is only for UX.
- ⚠ **Fix fail-open:** `resolveAccess()` currently grants full access if the groups API errors.
  That must be **fail-closed** in Customer mode.

---

## 5. Modules = top-level menu items

The 14 top-level nav sections are the sellable modules; each maps to an access-key prefix already
used by [`js/accessConfig.js`](../js/accessConfig.js). A customer's `entitlements` is a list of
module prefixes (e.g. `["interactions.*", "export.users.*", "audit.*"]`) that plugs directly into
the existing wildcard matching in `hasAccess()` — **no change to that logic**.

| Module | Access prefix | Customer-suitable (token-forwarding)? |
|---|---|---|
| Data Actions | `data-actions.*` | Edit ✅ · Copy Between Orgs ❌ cross-org |
| Data Tables | `data-tables.*` | Create/Edit/Copy-Single ✅ · Copy Between Orgs ❌ |
| Divisions | `divisions.*` | ✅ single-org |
| Interactions | `interactions.*` | ✅ (writes bounded by user's Genesys role) |
| Export | `export.*` | Single-org exports ✅ · All-Orgs/Trustee/**Billing ❌** |
| Phones | `phones.*` | ✅ single-org |
| GDPR | `gdpr.*` | **TBD** (sensitive — see open decisions) |
| Roles | `roles.*` | Compare/Search/Create/Edit/Copy-Single ✅ · Copy Between Orgs ❌ |
| Wrapup Codes | `wrapupCodes.*` | ✅ |
| Flows | `flows.*` | ✅ |
| Audit | `audit.*` | ✅ single-org |
| Deployment | `deployment.*` | ✅ (powerful; consider higher tier) |
| Users | `users.*` | ✅ single-org |
| Utilities | `utilities.*` | IP Ranges uses configured-org client-creds → **internal-only** |

### Features excluded for customers (need elevated / trustee / cross-org power)
- All cross-org copies (Data Actions / Data Tables / Roles "Copy Between Orgs").
- Trustee & All-Orgs exports (Trustee Export, Roles All-Orgs, Billing All-Orgs).
- **Billing (all variants) — excluded completely for customers** (trustee endpoint, requires your
  company's trustee relationship).
- Utilities → IP Ranges (Genesys mode) and scrape/IP-range helpers → **internal-only**.

---

## 6. Internal permission-refinement model (agreed)

For **internal** users, access to **write actions** is a **two-factor AND**:

```
canDoWriteAction(feature) = appGroupGrantsFeature(feature)          // GROUP_ACCESS (menu)
                          AND userHasGenesysPermission(feature)     // user's role in DEMO org
```

The user's **demo-org permission is the authorization template**: if a staffer holds e.g.
`architect:datatable:edit` in demo **and** the app feature is granted, they may perform that action
against **any** customer org (still executed via client-credentials).

- **Granularity:** **action-level** — edit permission to edit, delete permission to delete, add to
  create, etc.
- **Fail behaviour:** **fail-closed** (missing permission → action hidden/disabled).
- **Superusers** (`SUPERUSER_IDS`): **bypass** the permission check.
- **Implementation:** `resolveAccess()` adds `GET /api/v2/users/me?expand=authorization` to obtain
  the effective permission set, expanding wildcards the same way Roles → Compare already does; the
  result combines with group access in `hasAccess()`.

### Read-only exemption (agreed)
Permission-gating **only governs WRITE/mutating actions**. **All read-only features** are gated by
app group/entitlement **alone** — the user's own permission is irrelevant because nothing changes.
This covers **Export**, **Audit → Search**, **Flows → Journey**, **Roles → Compare / Permissions-vs-
Users**, and **Interactions → Search / Transcripts**.

### Group-only features (no Genesys permission gate)
- **Export** — read-only, runs via OAuth client-creds; the **OAuth client's** perms matter, not the
  user's.
- **App-owned storage** — Scheduled Exports, Templates, Activity Log — no Genesys permission exists.

### Composite / multi-endpoint features (agreed)
Documentation export, Configure Users, Deployment bulk import: gate on the **primary write
permission**; sub-call failures surface as per-item errors (as they already do).

### Prerequisite audit before enabling fail-closed
Because gating is fail-closed and action-level, the demo org becomes the single source of truth for
internal write access. Before switching it on:
1. Produce the **feature/action → Genesys-permission map** (see §8).
2. Run a **coverage report** — which staff/roles currently hold each mapped permission vs. the
   features they use today (who would lose access on day one).
3. **Remediate** demo-org roles so no one loses legitimate capability.
4. **Then** enable the fail-closed refinement.

---

## 7. Hide vs. disable UX policy (agreed)

Two layers of the same idea:
1. **Nav menu items** — module/top-level: **hide** if the user has no permission for anything
   inside (existing nav cascade in [`js/nav.js`](../js/nav.js)).
2. **Leaf features + in-page action buttons** (Delete, Publish, …) — **show but disabled** with a
   tooltip naming the missing Genesys permission; clicking routes to an
   [`accessdenied`](../js/pages/accessdenied.js) variant explaining which permission is missing.

**Implementation:** the access object gains
`accessState(key) → "allowed" | "denied-no-permission" | "hidden"` (superseding the plain boolean),
so nav and page code can choose hide vs. disable. Contained change to `resolveAccess()` / `nav.js`;
does **not** touch the customer token-forwarding path.

---

## 8. Feature → write-permission map (FINALIZED)

Confirmed against the live demo permission catalog (2026-07-06). Only **write actions** are gated
(read-only features are group-gated). Read-only features carry **no** entry here.

> Note: WebRTC phones and several Deployment object types (DID pools, sites, number plans, outbound
> routes) have **no granular** `add`/`edit` permission in the catalog — Genesys gates all edge/phone
> configuration behind the single `telephony:plugin:all` permission, which is the correct gate for
> those.

### Roles (`roles.*`)
| Action | Permission |
|---|---|
| Create / Copy-Single | `authorization:role:add` |
| Edit | `authorization:role:edit` |
| Delete | `authorization:role:delete` |

### Users — Configure / Copy / Direct Routing (`users.*`)
| Action | Permission |
|---|---|
| Grant roles | `authorization:grant:add` |
| Assign skills | `routing:skill:assign` |
| Assign languages | `routing:language:assign` |
| Queue membership | `routing:queueMember:manage` |
| Direct Routing — addresses | `directory:user:edit` |
| Direct Routing — backup routing | `routing:directRoutingBackup:edit` |

### Divisions (`divisions.*`) — gate on each object's `edit` permission
| Leaf | Permission |
|---|---|
| People → Users | `directory:user:edit` |
| People → Work Teams | `groups:team:edit` |
| Routing → Queues | `routing:queue:edit` |
| Routing → Call Routes | `routing:callRoute:edit` |
| Routing → Emergency Groups | `routing:emergencyGroup:edit` |
| Routing → Extension Pools | `telephony:extensionPool:edit` |
| Routing → Routing Schedules | `routing:schedule:edit` |
| Routing → Routing Schedule Groups | `routing:scheduleGroup:edit` |
| Routing → Skill Groups | `routing:skillgroup:edit` |
| Architect → Flows | `architect:flow:edit` |
| Architect → Milestones | `architect:flowMilestone:edit` |
| Architect → Flow Outcomes | `architect:flowOutcome:edit` |
| Architect → Scripts | `scripter:script:edit` |
| Architect → Data Tables | `architect:datatable:edit` |
| Outbound → Campaigns | `outbound:campaign:edit` |
| Outbound → Contact Lists | `outbound:contactList:edit` |
| Outbound → DNC Lists | `outbound:dncList:edit` |
| Outbound → Email Campaigns | `outbound:emailCampaign:edit` |
| Outbound → Messaging Campaigns | `outbound:messagingCampaign:edit` |
| Workforce → Business Units | `wfm:businessUnit:edit` |
| Workforce → Management Units | `wfm:managementUnit:edit` |
| Task → Workbins | `workitems:workbin:edit` |
| Task → Work Types | `workitems:worktype:edit` |

### Interactions (`interactions.*`)
| Action | Permission |
|---|---|
| Disconnect | `conversation:communication:disconnect` |
| Move (blind transfer to queue) | `conversation:communication:blindTransferQueue` |
| Recordings → Create Export Job | `recording:job:add` |

### Data Tables (`data-tables.*`)
| Action | Permission |
|---|---|
| Create | `architect:datatable:add` |
| Edit schema | `architect:datatable:edit` |
| Edit / add / delete rows | `architect:datatableRow:add` · `:edit` · `:delete` |
| Delete table | `architect:datatable:delete` |

### Data Actions (`data-actions.edit`)
| Action | Permission |
|---|---|
| Edit | `integrations:action:edit` |
| Test / run | `integrations:action:execute` |

### Wrapup Codes (`wrapupCodes.createEditMapping`)
| Action | Permission |
|---|---|
| Create / edit code | `routing:wrapupCode:add` · `routing:wrapupCode:edit` |
| Outbound mapping | `outbound:wrapUpCodeMapping:edit` |

### Phones (`phones.webrtc.*`)
| Action | Permission |
|---|---|
| Create WebRTC phone | `telephony:plugin:all` (+ `telephony:phone:assign` to assign to a user) |
| Change site | `telephony:plugin:all` |

### Deployment (`deployment.*`) — bulk, gate per object type on the sheet's primary write perm
| Object type | Permission |
|---|---|
| Divisions | `authorization:division:add` |
| Skills | `routing:skill:create` |
| Language skills | `routing:language:manage` |
| Schedules | `routing:schedule:add` |
| Schedule Groups | `routing:scheduleGroup:add` |
| DID pools / Sites / Number plans / Outbound routes | `telephony:plugin:all` |

### GDPR (`gdpr.*`) — internal write (customer inclusion still TBD, O2)
| Action | Permission |
|---|---|
| Submit subject request | `gdpr:request:add` |

---

## 9. Permission Catalog report page (agreed — next buildable piece)

An internal, admin-only page that dumps the **full live permission catalog** for the selected org
(run against **demo**) so we can finalize §8.

- **Nav:** under **Utilities** → "Permission Catalog"; access key `utilities.permissionCatalog`
  (admin-only, **never** in any customer entitlement).
- **Fetch:** reuse `fetchPermissionCatalog(api, orgId)` from
  [`js/pages/roles/compare.js`](../js/pages/roles/compare.js) — `GET
  /api/v2/authorization/permissions?pageSize=100&pageNumber=N`, paginated. Flatten
  `entities[].permissionMap` to rows `{ domain, entity, action, permission, label }`.
- **UI:** status totals, live filter, table (`Domain · Entity · Action · Permission · Label`),
  **Copy** (all filtered strings, one per line), **Export to Excel** (existing iframe-safe machinery).
- **Why low-risk:** no new backend (GET the app already makes), no new export plumbing, read-only,
  reusable (re-run + diff when Genesys changes permissions).
- **Feeds the map:** run against demo → confirm each write-action string verbatim → fix 🟡/⚠ →
  authoritative map.
- **Scope note:** catalog is org-specific; demo = the internal baseline (correct source, since
  internal write access is governed by demo-org permissions). Customers don't need this map at all —
  their writes are enforced by Genesys via token-forwarding.

---

## 10. App-owned data-store isolation

In **Customer mode**, every store operation must derive `orgId` from the **authenticated session**,
never from a request field:
- **Activity Log** ([`api/lib/activityLogStore.js`](../api/lib/activityLogStore.js)) — currently a
  single partition `"log"`; admin filters can see all orgs. Customers **see their own** activity log
  (agreed), filtered to the session org; cross-org filters hidden.
- **Schedules / Templates / Assignments** — partitioned by org, but org currently comes from the
  client; force the partition to the session-derived org and reject mismatches.

---

## 11. Onboarding a customer

1. Create a PKCE OAuth client in **their** org with scopes covering purchased modules (read-only
   variants where possible; write scopes only for write modules).
2. Add the shared SWA origin(s) as Authorized redirect URIs.
3. Add one registry entry (orgId, region, clientId, entitlements).
4. Set their integration Application URL to `…/?org=<key>`.

---

## 12. Phased roadmap (build one step at a time, test each thoroughly)

1. **Permission Catalog report page** (§9) → finalize the write-permission map (§8). **[BUILT — pending testing]**
   - `js/pages/utilities/permissionCatalog.js`; nav leaf under Utilities (`utilities.permission-catalog`);
     route `/utilities/permission-catalog` in `pageRegistry.js`; access key `utilities.permissionCatalog`
     (covered by admin `*`; not granted to Support/Export).
2. **Internal permission-refinement + hide/disable UX** (§6, §7): `accessState()`, fail-closed,
   superuser bypass, read-only exemption. Prerequisite audit first. **[PARTIALLY BUILT]**
   - `js/featurePermissionMap.js` — finalized write-permission map + helpers (`isWriteGated`,
     `getRequiredPermissions`, `getActionPermissions`).
   - `resolveAccess()` now fetches the user's own demo-org permissions
     (`users/me?expand=authorization`), wildcard-aware, and exposes
     `accessState(key) → allowed | denied-no-permission | hidden` + `getMissingPermissions(key)`.
   - Enforcement flag `ENFORCE_PERMISSION_REFINEMENT` in `accessService.js` (default **on**;
     safe because current staff are full-permission).
   - Nav renders group-granted-but-denied write leaves **disabled** with a tooltip naming the
     missing permission; route navigation to a denied write page shows the Access Denied page
     with the missing permission(s). Modules stay visible if they contain any group-granted leaf.
   - Coverage audit (2c) skipped: all current users are full-permission admins; validation is via
     a purpose-made restricted test user.
   - **Remaining:** in-page button-level gating (Delete/Publish/Apply) per page — later increment.
3. **Foundation for customers:** server-side registry + `GET /api/org-config` + `?org=` resolution
   + post-login org-match + server-side mode detection. **[DONE — shipped to prod]**
   - `api/org-config/` endpoint + `api/lib/orgConfigResolver.js` (`classifyCaller`, cached per token).
   - `js/services/orgConfigService.js`; app startup resolves mode before rendering org selection;
     `authService` preserves `?org` through the PKCE redirect.
   - Env: `INTERNAL_COMPANY_ORG_ID`, `GENESYS_HOME_REGION`, `CUSTOMER_REGISTRY_JSON` (+ compatibility fallback).
4. **Harden the proxy:** derive org from session, token-forwarding path, entitlement endpoint
   allowlist, fail-closed Customer mode. **[DONE — shipped to prod]**
   - `api/genesys-proxy/index.js` mode-aware; verified internal token required for client-credentials
     (closes the previous anonymous-proxy hole); customer mode token-forwards + org-lock + guard.
   - `api/lib/entitlementAllowlist.js` — customer deny list (billing/trustee) + optional positive
     allowlist behind `ENFORCE_ENTITLEMENT_ALLOWLIST` (default off).
5. **Entitlement-driven access + customer login path:** dynamic pre-login OAuth per `?org`,
   customer-region `organizations/me`, feed customer key set into `hasAccess()`; org selector locked
   in Customer mode. **[IN PROGRESS]**
   - 5a **[DONE]**: pre-login `GET /api/org-config?org=<slug>` (unauthenticated) returns the org's
     public login config `{ id, name, region, clientId }`; `js/services/orgConfigService.js::fetchOrgLoginConfig`.
   - 5b **[DONE]**: dynamic login in `authService` — when `?org` resolves, the redirect, token exchange,
     and `users/me` all use the customer `clientId` + `login.<region>` / `api.<region>` (stored per session).
     Internal login is unchanged when there is no hint.
   - 5c **[DONE]**: `classifyCaller(token, hintId)` is region-aware — customer tokens are validated against
     the hinted registry region and the org id re-verified (org-config `?org`, proxy `customerId`).
     Customer-mode access keys come from `entitlements` via `accessService.js::resolveCustomerAccess`.
   - 5d: end-to-end test as a customer user (Test IE) incl. tamper/isolation cases. **[DONE — validated on dev 2026-07-15]**
     - Verified: IE-region login via customer PKCE client; org locked to Test IE; menu limited to
       entitlements (no Billing / Permission Catalog); pages load IE-only data (proxy 200).
     - Isolation: proxy call targeting another org → blocked (no other-org data, 401); billing
       endpoint → `403 endpoint_not_available_for_customer`.
   - Prereq for 5d: a PKCE client in the customer org; its `clientId` added to `CUSTOMER_REGISTRY_JSON`.
     **[DONE for Test IE on dev]**
6. **Data-store isolation** (§10). **[DONE — validated on dev 2026-07-17]**
   - Backend `api/lib/callerContext.js` (`getCallerContext` + `ownerVisibleTo`) resolves the caller
     from `X-Genesys-Token` (reuses `classifyCaller`) and returns an `ownerOrgId` (customer slug, or
     `"internal"`; legacy/missing records are treated as internal).
   - Frontend forwards `X-Genesys-Token` on all store calls via `js/services/apiAuth.js::withUserToken`
     (schedule/template/template-assignment/template-schedule services + activity-log page & writer).
   - **Config stores (Templates, Template-Assignments):** internal keeps cross-org; a customer is locked
     to its own org (mismatched `orgId` → `403 org_locked`).
   - **Owner-scoped stores (Activity Log, Schedules, Template-Schedules):** records carry `ownerOrgId`;
     reads are filtered so an org only ever sees records its own session created. Internal sees
     internal-owned (incl. legacy); customers see only their own. Activity Log: customers see their org's
     log (no admin `all`, no cross-org); the timer runners read stores directly (unfiltered) so execution
     is unaffected.
7. **Feature gating:** mark cross-org/trustee/internal-only features unavailable in Customer mode.
   **[DONE — pending test]**
   - `accessService.js::resolveCustomerAccess` now excludes internal-only keys in customer mode even
     when an entitlement prefix would grant them (`CUSTOMER_EXCLUDED_KEYS`): cross-org copies
     (`data-actions.copy.betweenOrgs`, `data-tables.copy.betweenOrgs`, `roles.copy.betweenOrgs`),
     trustee/all-orgs/billing exports (`export.users.trustee`, `export.roles.allOrgs`, `export.billing.*`),
     the internal Utilities module (`utilities.*`), and the **Deployment** module (`deployment.*`).
     GDPR is left available (open decision O2).
   - Belt-and-suspenders on top of the server-side proxy denylist + org-lock; excluded keys are hidden in
     nav and denied on route.
8. **Per-customer onboarding & scope mapping.**
9. **Security review & tenant-isolation testing** (attempt cross-org access with a customer token;
   verify every store and proxy path rejects it). **[DONE — validated on dev 2026-07-17]**
   - Login/identity, proxy isolation (unauth/forged/cross-org/billing), store isolation (read + write
     tamper → `403 org_locked`), owner-scoped writes (forged `ownerOrgId` ignored; customer-created
     schedule visible to the customer, invisible to internal), and customer-mode feature gating all pass.
   - Known limitation: dev has one customer (Test IE); isolation is enforced by org identity, so a second
     registered customer isn't required to validate the mechanism.

---

## 13. Decisions log

| # | Decision | Status |
|---|---|---|
| D1 | Customers use **token-forwarding**; internal keeps client-credentials; one app, path chosen by identity | ✅ agreed |
| D2 | Entitlements stored in a **server-side registry file** | ✅ agreed |
| D3 | **Modules = top-level nav items**; entitlements = list of module prefixes | ✅ agreed |
| D4 | **Billing excluded completely** for customers | ✅ agreed |
| D5 | Customers **see their own Activity Log** | ✅ agreed |
| D6 | Internal write access = group **AND** demo-org permission; **action-level**; **fail-closed**; superusers bypass | ✅ agreed |
| D7 | Permission-gating governs **write actions only**; all read-only features group-gated | ✅ agreed |
| D8 | Exports & app-owned storage = **group-only** (no permission gate) | ✅ agreed |
| D9 | Composite features gate on **primary write permission** | ✅ agreed |
| D10 | Hide modules with no access; **disable** leaf/buttons with tooltip; add `accessState()` | ✅ agreed |
| D11 | Build the **Permission Catalog** report page next (Utilities, admin-only) | ✅ agreed |

## 14. Resolved decisions (were open)

- **O1 — Write-capable customer modules:** ✅ **Offer all customer-safe single-org modules (read + write).**
  Token-forwarding bounds every write to the customer's own Genesys role in their own org, so this is a
  product/pricing choice, not a security one. "Tiers" are just entitlement bundles (see §15).
- **O2 — GDPR module for customers:** ✅ **Include as an opt-in / higher-tier add-on** (only when explicitly
  entitled with `gdpr.*`). Not excluded in code; simply omitted from the base packages.
- **O3 — Sellable catalog:** ✅ **Default package catalog v1** defined in §15 (refine later as pricing evolves).

---

## 15. Sellable package catalog (default v1)

A "package" is a named bundle that expands to a list of access-key prefixes. A customer's
`entitlements` = the **union** of the packages they bought. Internal-only features
(Utilities, Deployment, cross-org copies, trustee/all-orgs/billing exports) are **never** included and
are additionally blocked server-side + hidden in customer mode (§5, Step 7).

| Package | Grants (entitlement prefixes) |
|---|---|
| **Insights** | `audit.*`, `interactions.search.*`, `export.users.*`, `export.interactions.*`, `export.scheduled` |
| **Interaction Ops** | `interactions.*` |
| **User & Access Management** | `users.*`, `roles.*`, `divisions.*` |
| **Configuration** | `data-tables.*`, `data-actions.edit`, `wrapupCodes.*`, `flows.*`, `phones.*` |
| **GDPR (add-on)** | `gdpr.*` |

Ready-to-paste `entitlements` per package:
- Insights: `["audit.*","interactions.search.*","export.users.*","export.interactions.*","export.scheduled"]`
- Interaction Ops: `["interactions.*"]`
- User & Access Management: `["users.*","roles.*","divisions.*"]`
- Configuration: `["data-tables.*","data-actions.edit","wrapupCodes.*","flows.*","phones.*"]`
- GDPR (add-on): `["gdpr.*"]`

Example — a customer buying **Insights + GDPR**:
`["audit.*","interactions.search.*","export.users.*","export.interactions.*","export.scheduled","gdpr.*"]`
