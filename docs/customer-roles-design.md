# Customer Roles — Administrator and Supervisor — Design

Status: **Built** — design signed off 2026-09-16; built the same day. Test pass: [`docs/testing/customer-roles-tests.md`](testing/customer-roles-tests.md)
Author: Genesys Admin App
Last updated: 2026-09-16

## 0. The requirement

In the user's words: "I need a user granularity. Administrator and Supervisor.
When adding a user, it should be decided if it is a Supervisor or
Administrator. If Administrator, the app shows everything (still permission
gated). If it's a Supervisor it should show only supervisor-available things.
The supervisor-available items are defined in a new function — Administrator ›
Supervisor Access, which only administrators can see — which decides the
features the Supervisor should be able to see in the app (still permission
gated). All the items should be checked in this page. When a user is added and
the Supervisor box is ticked, it should pop these checkboxes and either all or
some can be checked. This decides what the individual Supervisor can actually
see."

And: "It's important that the Supervisor cannot see the menu items outside
their role." Not greyed — **absent**.

This is §10 of [`internal-user-access-design.md`](internal-user-access-design.md),
designed in full. Customers still never add users (§5 there); the Supervisor
Access page is the first thing a customer *writes* in the app. Together with
Administrator › Users it is the whole of a customer Administrator's power
over access: the scope, and every named user's role and pages — never who
is named.

## 1. Confirmed decisions

- **Two roles for a customer user, one of them required at add time:**
  `administrator` — everything the app offers customers; `supervisor` — a
  chosen subset. There are no customers yet, so no row exists without a role and
  none has to be migrated. A customer row without a role is refused by the
  endpoint from the day this ships.
- **Three layers, each a subset of the one above** (§2): everything the app
  offers customers, the org's Supervisor scope, the individual Supervisor's
  ticks. The person's own
  Genesys permissions narrow the result at the end, as they do today.
- **Granularity is pages, grouped under sections.** One box per page on both
  the scope page and the per-user popup, with a section box that ticks its
  pages. "Export › Users but not Export › Billing" is expressible.
- **The scope applies live.** A Supervisor's effective features are their
  ticks ∩ the scope *as it is now*, computed at sign-in. Untick Export from
  the scope and every Supervisor loses Export on their next sign-in, with
  nobody editing each row. A scope that only constrained future adds would
  leave stale grants around — the thing scopes exist to prevent.
- **Who sets the scope:** a customer Administrator, for their own org, on
  Administrator › Supervisor Access; and internal superusers and
  customer-managers, for any org, on Customers › Supervisor Access — so a
  customer's scope can be set on the day they are onboarded, before they have
  an Administrator who has signed in.
- **A customer Administrator may change any of their org's users** — promote
  a Supervisor to Administrator, demote the other way, change a Supervisor's
  pages — on Administrator › Users. They may **never add or remove** a user.
  Naming is Netdesign's act because it starts a charge; everything after the
  name is the customer's own business.
- **An empty scope refuses a Supervisor add**, with a sentence pointing at
  Supervisor Access. A Supervisor with nothing ticked would sign in to an
  empty app, which reads as broken.
- **Outside their features, a Supervisor sees nothing.** Pages are absent from
  the sidebar, not shown and refused. The same mechanism that hides internal-
  only pages from a customer hides pages outside the features (§7).
- **Roles and features are editable after the fact**, per row, by whoever may
  edit that org's list. Promote, demote, add a feature — no remove-and-re-add.
- **Internal users are untouched.** They have no role beyond the
  `customer-manager` capability, and no scope. This is customer-only.

## 2. The three layers

```
everything     every page the app offers customers   the nav, minus internal-only pages
   ⊇ scope     what a Supervisor may have            set per org on Supervisor Access
      ⊇ ticks  what THIS Supervisor has              set per user on the add/edit flow

effective(administrator) = everything
effective(supervisor)    = scope ∩ ticks
what they may DO         = effective, narrowed by their Genesys permissions
```

Customers pay **per user, not for content**: every customer gets everything
the app offers customers. There is no package to validate against, and this
document says "the package" nowhere else. The entitlement plumbing stays —
it already carries "everything" for a customer session — but it is plumbing,
not a decision.

Every set is a set of **page access keys** — the leaves in `navConfig.js`,
e.g. `export.users.lastLogin`. The scope and the ticks are stored as leaves.
Pages internal-only by `CUSTOMER_EXCLUDED_KEYS` never appear in any layer.

## 3. What already exists

- The licence row carries `role` and a reserved `features` list
  ([`licenseStore.js`](../api/lib/licenseStore.js)) — reserved for exactly this.
- The gate returns the role with the licence verdict
  ([`licenseGate.js`](../api/lib/licenseGate.js)).
- `resolveCustomerAccess(entitlements, …)` in
  [`accessService.js`](../js/services/accessService.js) turns a key set into
  the sidebar and the greying: keys not in the set → `hidden`; keys in the set
  but without the Genesys permission → `denied-no-permission`. It takes any
  key set; it does not care whether the keys are everything or a
  Supervisor's ticks.
- The proxy's customer guard `checkCustomerRequest(path, entitlements)` in
  [`entitlementAllowlist.js`](../api/lib/entitlementAllowlist.js) refuses a
  call outside a key set — the same set, so a Supervisor's calls are refused
  outside their features the same way. (It is behind
  `ENFORCE_ENTITLEMENT_ALLOWLIST`, off by default; a customer's calls forward
  the person's *own* token, so Genesys enforces their permissions on every
  call regardless. This guard narrows further by feature when on.)
- Customers › Access — the add flow with its confirm step, the list, Remove,
  and the internal-org role tick.
- `/api/licenses` — who may change which list, decided server-side.

## 4. The record

A **customer** row:

```
role       "administrator" | "supervisor"    required on add; the endpoint refuses a customer add without one
features   ["export.users.lastLogin", …]     supervisor only; leaf keys; empty list for an administrator
```

Internal rows are as they are (`role` "" or `customer-manager`, no
`features`). The endpoint decides validity by which org the row is for.

The **scope** is per org, in a new table `orgsettings`:

```
partitionKey   customer slug
rowKey         "supervisorScope"
features       JSON array of leaf keys
setBy, setByEmail, setAt
```

One row per org. Absent means empty. Written by the endpoint in §6, read by
the gate and the scope page.

## 5. Who may do what

| | Customer Administrator | Customer Supervisor | Internal superuser / customer-manager |
|---|---|---|---|
| Sign in | everything | ticks ∩ scope | — |
| See Supervisor Access | own org | no | any org, under Customers |
| Set the scope | own org | no | any org |
| See who is named | own org | no | any org (as today) |
| Change a user's role or pages | own org | no | any customer org |
| Add a user / remove a user | **never** | never | any customer org (as today) |

The line is the last row. Everything above it is the customer's own
business once a person has been named; the naming itself is Netdesign's,
because it starts a charge.

## 6. The endpoints

**`/api/supervisor-scope`**

```
GET  ?customerId=        → { customerId, features: [...] }
PUT  { customerId, features: [...] }
```

Who may: a customer session whose own row is `administrator`, for their own
org only — the `customerId` they send is ignored and the verified org used,
as the peak endpoint already does; an internal session that is a superuser
or a customer-manager, for any customer org. Anyone else 403. The internal
org has no scope; a request for it is 400. Every PUT is logged to the
Activity Log as `supervisorScope.set` with the before and after lists.

Features in a PUT are validated against the nav's leaves minus
`CUSTOMER_EXCLUDED_KEYS` and `CUSTOMER_ADMIN_KEYS`; anything else is dropped,
and the response says what was kept and what was dropped. The server needs
the nav's leaf keys, but the API is deployed on its own and cannot read
`js/navConfig.js` at runtime, so the list is **generated**:
`scripts/build-customer-pages.mjs` walks the same tree the app's own pages
use ([`js/services/customerPageTree.js`](../js/services/customerPageTree.js))
and writes [`api/lib/customerPages.json`](../api/lib/customerPages.json);
`--check` runs in the dev workflow ahead of the deploy, so a page added to
the nav without regenerating the list fails the build rather than becoming
a page no Supervisor can ever be given.

**`/api/licenses`** gains, for customer orgs:

- `assign` takes `role` (required, one of the two) and `features` (required
  non-empty for a supervisor, ignored for an administrator). A supervisor add
  is refused with `scope_empty` when the org's scope has nothing in it, and
  the ticks are validated as a subset of the scope — anything outside is
  dropped.
- `POST /role` accepts customer orgs too, with `{ customerId, userId, role,
  features }`, same validation. This is the per-row Edit. **A customer
  session whose own row is `administrator` may call it for their own org** —
  the `customerId` they send is ignored and the verified org used — and may
  `GET` their own org's list. `assign` in either direction stays
  `internal_only` for every customer session, whatever their role.

`GET /api/licenses` returns `role` and `features` per row, as it already
returns `role`.

## 7. Effective access, and where it is enforced

**At sign-in.** `org-config` for a customer session already answers with an
`entitlements` set. It now answers with `effective` (§2) as `entitlements`,
plus `role`. The gate computes `effective` from the row and the scope row,
one extra store read for a supervisor (none for an administrator), cached
with the verdict. The Supervisor Access page reads the scope itself from
`/api/supervisor-scope` when it opens, so it shows the scope as it is then,
not as it was at sign-in.

**In the sidebar.** `resolveCustomerAccess(effective, …, { role })` — the
key set as before, plus the role, which alone decides whether the two
`administrator.*` pages are shown. A page outside `effective` gets `hidden`,
and the nav does not draw a hidden page. That is the requirement in §0, and it is already how a customer is
kept from internal-only pages; nothing new is needed to make Supervisors' pages absent rather than
greyed. A page inside `effective` that the person's Genesys permissions do
not cover is greyed with the permission named, as today.

**In the proxy.** The customer guard receives `effective`, so a Supervisor
calling the proxy directly for a feature outside their ticks is refused
`endpoint_not_entitled`, when the allowlist is on.
When it is off, Genesys refuses on the person's own token as it always has.

**When the scope changes.** The gate caches per token for five minutes, so a
scope edit reaches every Supervisor within that window or on their next
sign-in. The Supervisor Access page says so after a save.

## 8. The pages

**Administrator › Supervisor Access** (customer) / **Customers › Supervisor
Access** (internal, with the org selector, beside Access to Admin Tool). One
page, two routes, the same module. It renders the nav tree the app offers
customers — sections, sub-groups, pages — as checkboxes: a page box per leaf, a
section box that ticks and unticks its pages and shows the mixed state when
some are ticked. Save writes the scope; the status line says how many pages
and that Supervisors see the change within five minutes.

**Customers › Access — the add flow** gains, when the selected org is a
customer: a required choice, Administrator or Supervisor. Choosing Supervisor
reveals the scope's pages as checkboxes — the same tree, filtered to the
scope — and Add stays disabled until at least one is ticked. If the scope is
empty the choice says "Set the Supervisor scope for this org first" with a
link, and Supervisor cannot be chosen. The confirm step names the role and,
for a Supervisor, the pages.

**Customers › Access — the list** shows the role per row, and for a
Supervisor the count of pages; an Edit per row opens the same role-and-pages
control pre-filled, and saves through `/role`.

**Administrator › Users** (customer) is the same list module as Customers ›
Access, served to a customer Administrator for their own org with the add
box and the Remove buttons absent — the Edit per row is the whole of it. The
server refuses add and remove from any customer session regardless, so the
page is showing what is true, not enforcing it. Customers › Access itself
stays internal-only in the nav, as today.

The customer's **Administrator** section therefore has two pages: Supervisor
Access and Users.

## 9. Rollout

No customers exist, so there is nothing to migrate and no flag: this ships
enforced. The first customer onboarded after it ships gets a scope set by the
internal person onboarding them, then their users, each with a role — and
from then on their own Administrator can adjust both. Dev may
hold test rows without a role from before this; a customer row with no role
is treated as `administrator` and logged, so a test account is not locked out
by data that predates the field — and the log says which rows to fix.

## 10. Test pass

Written in the same commit as the change, in
[`docs/testing/customer-roles-tests.md`](testing/customer-roles-tests.md):
57 automated server checks, 46 automated client checks, 20 by hand. The
outline it was written to:

- Add a customer user with no role → 400 `role_required`.
- Add an Administrator → in; sees everything the app offers customers; sees
  Administrator › Supervisor Access and Administrator › Users; does not see
  Customers › Access.
- Administrator › Users: the list with Edit, no add box, no Remove; a direct
  `assign` (POST or DELETE) from the Administrator's session → 403
  `internal_only`; `/role` for a user in their org → 200 and logged.
- Administrator sets the scope; PUT with an internal-only key → dropped and
  reported; log has `supervisorScope.set`.
- Add a Supervisor with the scope empty → refused `scope_empty`; the page
  says so.
- Add a Supervisor with two of three scope pages → in; sidebar shows exactly
  those two pages and their sections, nothing else — **absent, not greyed**.
- Supervisor with a ticked page but without its Genesys permission → page
  shown greyed with the permission named (unchanged behaviour inside the set).
- Supervisor calls the proxy for a page outside their ticks → refused when the
  allowlist is on; Genesys refuses on their own token when off.
- Administrator unticks a page from the scope → a Supervisor who had it loses
  it within five minutes / on next sign-in, with no row edited.
- Administrator edits a Supervisor's ticks; promotes them to Administrator;
  demotes back — each logged under the Administrator's own identity, each
  effective within the cache window. The same three by an internal
  customer-manager.
- A customer Administrator PUTs the scope with another org's `customerId` →
  their own org is used; a Supervisor PUTs → 403.
- Internal customer-manager sets a scope for a customer → works; for the
  internal org → 400.
- Internal users: nothing changes — no role choice on the internal org's
  list, no scope, sidebar as before.

## 11. Out of scope

- A per-Supervisor scope (different scopes for different groups of
  Supervisors). One scope per org; the per-user ticks are the granularity.
- Customers naming anyone. "Never."
- Internal user roles. None.

## 12. Resolved questions

1. **Should a customer Administrator see who is named in their org?** Asked
   as read-only; answered as more than that. The Administrator sees the list
   and may change any user's role and pages — promote, demote, re-tick — on
   Administrator › Users. Add and remove stay Netdesign's. Recorded in §1, §5,
   §6 and §8. Nothing remains open.
