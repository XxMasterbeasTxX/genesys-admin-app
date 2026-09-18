# Internal Roles — Administrator and Supervisor for the internal org — Design

Status: **Built** — agreed and built 2026-09-17. Test pass: [`docs/testing/customer-roles-tests.md`](testing/customer-roles-tests.md) §C
Author: Genesys Admin App
Last updated: 2026-09-17

## 0. The requirement

In the user's words: "I also need the same feature administrator/supervisor
for the internal org. We have users whom should only see export etc."

This reverses one decision of
[`internal-user-access-design.md`](internal-user-access-design.md) §1 —
"no roles for internal users" — and extends
[`customer-roles-design.md`](customer-roles-design.md) to the internal org.
Everything else there stands: only superusers name internal users; no seed;
Genesys permissions still narrow what a page lets you do.

## 1. What changes, in one paragraph

An internal row carries a role, required on add: **Administrator** (every
page, as today) or **Supervisor** (their ticks ∩ the internal org's
Supervisor scope). The internal org gets a scope, set by superusers on
Customers › Supervisor Access with the internal org selected. The add flow
and the Edit on Customers › Access for the internal org gain the same role
control customers have. "Manages customer access" stays a separate tick,
independent of the role. A Supervisor's sidebar shows only their pages —
absent, not greyed — and then their Genesys permissions grey what is left,
exactly as for a customer Supervisor.

## 2. The layers, for the internal org

```
everything     every internal page          the nav minus SUPERUSER_ONLY_KEYS
                                             minus CUSTOMER_MANAGER_KEYS
                                             minus the customer Administrator section
   ⊇ scope     what a Supervisor may have   set on Supervisor Access for the internal org
      ⊇ ticks  what THIS Supervisor has     set per row

effective(administrator) = everything
effective(supervisor)    = scope ∩ ticks
                           + CUSTOMER_MANAGER_KEYS if the row manages customers
what they may DO         = effective, narrowed by their Genesys permissions
superuser                = everything, always, including the superuser-only pages
```

Onboarding (superuser-only) is never in a scope. Customers › Access and
Customers › Supervisor Access are never in a scope either: they come from
the "Manages customer access" tick, which is a capability about *customers*,
not a page choice about the internal org. A Supervisor who manages
customers therefore sees those two pages plus their ticks; an Administrator
who does not manage customers does not see them. Unchanged from today.

## 3. The record

Today the internal row's `role` holds `""` or `"customer-manager"`. That
column now holds the role, so the capability moves to its own column:

```
role              "administrator" | "supervisor"     required on add, both orgs
features          JSON array of page keys            supervisor only
managesCustomers  "true" | ""                        internal rows only; the tick
```

**Reading old rows** (dev has a handful; prod has none yet):
`role: "customer-manager"` is read as `administrator` + `managesCustomers`;
`role: ""` on an internal row is read as `administrator` and logged, the
same fallback a customer row without a role already gets. No migration
script; the row is rewritten in the new shape the first time it is edited.
The list shows such rows as "Administrator (unset)" with Edit, as the
customer list does.

**The internal org's scope** is a row in `orgsettings` under the internal
slug, like any customer's. The "internal org has no scope" refusal in
`/api/supervisor-scope` goes.

## 4. Who may do what — the internal org

| | Superuser | Internal Administrator | Internal Supervisor |
|---|---|---|---|
| Sign in | everything, incl. Onboarding | everything but Onboarding (as today) | ticks ∩ scope |
| Set the internal scope | yes | no | no |
| See the internal list; add, remove, edit roles | yes | no | no |
| Set "Manages customer access" | yes | no | no |
| Name customer users, set customer scopes and roles | yes | if the tick is set | if the tick is set |

Only the first row is new. The internal list stays superuser-only in
every respect, including roles — an internal Administrator is a *page*
role, not an administrator of access. That is deliberate: the sentence
"only superusers can add members to the internal org" (the user, yesterday)
extends naturally to "only superusers decide what members of the internal
org see".

## 5. What is enforced where

**Server.** The gate returns `role` and `features` for internal rows as it
does for customer rows (one scope read for a Supervisor, cached with the
verdict). The proxy's internal path today checks the caller's Genesys
permissions (`proxyPermissions.js`); it additionally refuses a call outside
a Supervisor's features through the same coarse path→module allowlist
customers get, under the same `ENFORCE_ENTITLEMENT_ALLOWLIST` flag (off).
That is the honest position: the feature layer is a *menu* restriction on
both sides, and the permission check is the security layer. A Supervisor
who lacks a Genesys permission is refused by the proxy in enforce mode
regardless of their ticks.

**Client.** `resolveAccess` takes the key set: `null` for an Administrator
(everything, as today), a list for a Supervisor. `hasAccess` returns false
outside the set → `hidden` → the nav does not draw it. `CUSTOMER_MANAGER_KEYS`
are decided by the tick, `SUPERUSER_ONLY_KEYS` by superuser, both before the
set is consulted.

## 6. The pages

- **Customers › Supervisor Access** with the internal org selected: the
  tree of internal pages (every nav leaf minus Onboarding minus the two
  Customers pages minus the two `administrator.*` pages = **93**),
  superusers only — anyone else is told so, as the Access page already
  tells them.
- **Customers › Access** with the internal org selected: the role control
  on add (required), the Role column, Edit per row, "Manages customer
  access" as today, and the new Modified columns. The role control's tree
  is the internal scope's pages.
- The customer pages are untouched.

One tree-builder (`customerPageTree.js`) gained `internalPageTree()` and
`pageTreeFor(internal)`, applying the internal exclusions instead of the
customer ones. The server's generated list is one file, `api/lib/pages.json`
(`scripts/build-pages.mjs`): every internal page, with `customer: true` on
the ones a customer may hold — the customer set is a subset of the internal
set, and the script refuses to write if it ever is not.

## 7. Rollout

No flag. Dev: the handful of existing internal rows read as Administrator
(+ the tick where they had it) and can be edited to Supervisor at will.
Prod: nobody is named yet, so every internal row is added with a role
from the first day — the same sequence as before, with one more choice
per person.

## 8. Out of scope

- Internal Administrators managing the internal list. Superusers only.
- A per-Supervisor scope. One scope per org.

## 9. Questions

Answered by the recommendation in each row unless the user says otherwise.

1. **Existing dev rows without a role** → read as Administrator, logged,
   shown as "Administrator (unset)", fixed by Edit. (§3)
2. **"Manages customer access" and the role are independent** — a
   Supervisor can hold the tick. (§2)
3. **The internal scope is superusers-only** — internal Administrators
   cannot set it. (§4)
4. **One generated pages file** with a per-page scope, not two. (§6)
