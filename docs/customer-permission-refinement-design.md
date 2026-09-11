# Customer mode — Permission Refinement — Design

Status: **Built** — on main; awaiting the manual case on dev
Author: Genesys Admin App
Last updated: 2026-09-11

Companion to [customer-facing-plan.md](customer-facing-plan.md) §5–§6, which
describe the customer boundary this refines, and to §15, whose package catalog
the licensing decision in §5 below touches.

## 0. The problem

In customer mode nothing is ever greyed. `resolveCustomerAccess` returns
`can() → true` and `getMissingPermissions() → []` unconditionally, and its
`accessState()` knows only `allowed` and `hidden`. So a customer user whose
Genesys role does not permit an action sees the control enabled, clicks it, and
gets a 403 from Genesys rendered as an error. The boundary is enforced — by
Genesys, on every call — but discovered by failing rather than by seeing the
control unavailable. Internal mode has had the better behaviour since §6 of the
plan: writes are greyed in advance from the user's own permissions, with the
missing ones named.

That gap becomes the customer's everyday experience the moment a customer has
more than one role in the org, which is every customer.

## 1. Confirmed decisions

- **Same machinery, not a second copy.** The permission-refinement half of
  `resolveAccess` (`accessState`, `getMissingPermissions`, `can`, fail-closed
  on an unreadable permission set) is extracted into one shared builder that
  both resolvers call. Two resolvers, one refinement.
- **Permissions are read on the session's region, never `CONFIG.apiBase`.**
  `fetchUserPermissions` today calls `api.mypurecloud.de` unconditionally. For
  a customer on `mypurecloud.ie` that is a 401, `permsAvailable` goes false,
  and the fail-closed rule greys *every* write — the exact opposite of the
  goal, and it would have shipped that way. The resolver takes the api base
  from the session (`apiBaseFor(getLoginRegion())`, the same source
  `usersMe` already uses) so the call lands where the token is valid.
- **Fail closed, as internal does.** If the permission set cannot be read, a
  gated write is greyed and the page says the check could not be made — not
  silently enabled. This is the existing internal rule and the reasons in §6 of
  the plan apply unchanged.
- **Entitlements still shape the menu; permissions only refine actions.** A
  page the org has not bought stays *hidden*. A page the org has bought but this
  user cannot act on is *shown, greyed*, with the missing permissions named —
  the same distinction internal mode draws between "not your section" and "not
  your permission". Nothing about `CUSTOMER_EXCLUDED_KEYS` changes.
- **One flag.** `ENFORCE_PERMISSION_REFINEMENT` already governs internal
  refinement; it governs customer refinement too. There is no reason the two
  sides should be switchable separately, and a second flag is a second thing to
  forget.
- **No release note** (confirmed).

## 2. What the user sees

Unchanged surfaces, now populated in customer mode:

- **Nav** — a leaf whose page needs a write permission the user lacks renders
  greyed, with the tooltip `nav.js` already draws for internal users.
- **Page** — routing to such a page renders the existing access-denied panel
  listing the missing permissions (`renderAccessDeniedPage`).
- **Controls inside a page** — every `access.can(key, action)` call already in
  the pages (Data Tables Edit's row delete, Data Actions Edit/execute, Direct
  Routing's address/backup/call-route edits, Templates apply, Roles modes, the
  dashboards' detail actions, …) starts returning real answers. No page is
  edited; each one already branches on `can()`.

## 3. Changes

### 3.1 `js/services/accessService.js`

- Extract `buildRefinedAccess({ keys, hasAccess, permList, isSuper })` from
  the body of `resolveAccess`. It owns `permsAvailable`, `hasPermission`,
  `accessState`, `getMissingPermissions` and `can`, exactly as they read today.
  `resolveAccess` becomes: fetch groups + permissions, derive `keys`, call the
  builder.
- `resolveCustomerAccess(entitlements, accessToken, apiBase)` becomes
  **async**. It derives `keys` from entitlements as now, applies
  `isCustomerExcluded` inside its `hasAccess` as now, fetches permissions when
  a token is supplied, and calls the same builder with `isSuper: false`.
  `hasAnyAccess()` and `verificationFailed` keep their current customer
  semantics.
- `fetchUserPermissions(accessToken, apiBase = CONFIG.apiBase)` gains the
  optional base so the customer path can point it at the right region. The
  internal caller is unchanged.
- **Called with no token** (the fail-closed fallback in `app.js` that builds
  `resolveCustomerAccess([])` when org-config cannot be resolved) the fetch is
  skipped and `permsAvailable` is false: every gated write greys, which is the
  right answer for a session that could not even be matched to an org.

### 3.2 `js/services/authService.js`

- Export `getSessionApiBase()` — `apiBaseFor(getLoginRegion())`. One source of
  truth for "which region is this session on", already what `usersMe` uses.

### 3.3 `js/app.js`

- Customer branch: `access = await resolveCustomerAccess(orgCfg.entitlements,
  res.accessToken, getSessionApiBase())`.
- Fallback branch: `await resolveCustomerAccess([])` — no token, as today.

Nothing else. `nav.js`, `renderAccessDeniedPage`, and every page's `can()`
call are consumers of the same interface and need no change.

## 4. What this does not do

- **No group-shaped menus for customers.** Entitlements are per org and remain
  so. "Our agents see Interactions, our admins see everything" is a separate
  design (a per-customer group→keys map in the registry, intersected with
  entitlements) and is not started here.
- **No seat counting.** The per-user licensing model (§5) is commercial; the
  app does not count, cap, or report seats in this change.
- **No change to the server-side guard.** Refinement is a UI-honesty layer.
  Isolation and enforcement stay where they are: org-lock and Genesys's own
  authorisation on every forwarded call.

## 5. Licensing decision and the catalog

Decision received 2026-09-11: for now customers **buy user licences and get
access to everything**. Packages may return later and are **not removed**.

That collides with the catalog as documented: the only "everything" bundle is
`demo`, and both `packages.js` and the onboarding runbook say not to hand it to
a paying customer. Proposed, as part of this change:

- Add **`all: ["*"]`** to `PACKAGES` as the sellable full tier. Same expansion
  as `demo`; the customer-exclusion list still applies, so it grants exactly
  what a customer may hold and nothing internal.
- Keep `demo` as it is, still marked internal — it remains the reference
  customer's bundle, and a future "sell packages again" world will want the
  two to be distinguishable in a registry entry.
- Runbook and §15: a paying customer's entry is `"packages": ["all"]` for now;
  the five named packages stay documented as the future granular tiers.

Test IE keeps its current list plus `all` is not needed — it already holds
`demo`. New paying customers get `["all"]`.

## 6. Test pass

Harness, against the real modules with only imports and the DOM stubbed
(same approach as §5e of the plan):

| # | Session | Permissions | Key / action | Expected |
|---|---|---|---|---|
| 1 | customer, `all` | holds `routing:queue:edit` | `divisions.routing.queues` state | `allowed` |
| 2 | customer, `all` | lacks it | same | `denied-no-permission`; `getMissingPermissions` names it |
| 3 | customer, `all` | lacks it | nav for that leaf | rendered greyed, not hidden |
| 4 | customer, `insights` only | holds everything | `divisions.routing.queues` | `hidden` — entitlement beats permission |
| 5 | customer, `all` | permission fetch fails (401) | any gated write | `denied-no-permission` (fail closed); `can()` false |
| 6 | customer, `all` | — | ungated read page | `allowed`, `can()` true — refinement never touches ungated keys |
| 7 | customer, `all` | lacks `directory:group:edit` | `can("data-tables.edit","rowsDelete")` | `false`; other actions on the page unaffected |
| 8 | customer, `all` on `mypurecloud.ie` | — | the permission call | goes to `api.mypurecloud.ie`, not `.de` |
| 9 | internal, any group | as today | every case in the existing internal pass | unchanged — same builder, same answers |
| 10 | fallback (`resolveCustomerAccess([])`, no token) | — | gated write | greyed; no fetch attempted |

Manual, on dev, in Genesys: a Test IE user whose role lacks a write permission
opens a page they are entitled to and sees the control greyed with the
permission named, instead of an error after the click.

Case 8 is the one that would have shipped wrong without this document.

**Result 2026-09-11:** all ten pass against the real `accessService.js` and the
real `featurePermissionMap.js`, with only `config.js`, `accessConfig.js` and
`fetch` stubbed; the fetch stub records every URL, which is how case 8 asserts
the region. Case 8 was confirmed to FAIL with the `.de` hardcode put back —
the fetch went to `api.mypurecloud.de` — and pass with the session base. The
Recordings exclusion pass (§5f of the plan) still passes after the refactor.
Manual case: pending the user's narrow-role test on dev.
