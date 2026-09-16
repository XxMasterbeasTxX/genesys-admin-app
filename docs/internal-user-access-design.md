# Internal User Access — Design

Status: **Agreed** — design signed off 2026-09-16; not to be built until the production hold lifts and the user says go
Author: Genesys Admin App
Last updated: 2026-09-16

## 0. The requirement

An internal colleague may use the app only if a superuser has added them to it.
Being in the Genesys group that the OAuth integration is restricted to still
gets a person through the sign-in door, as it does today; it no longer gets
them anything past it. Nobody is seeded. Everyone is added on purpose.

This is the pattern the app already applies to customers — group for the
door, named in the app to get in (`docs/customer-user-licensing-design.md`)
— extended to the internal org. It is also the pattern the user intends to
carry forward: customer users will later be added with one of two roles,
Administrator or Supervisor. The field this design adds is shaped so those
two values drop straight into it (§4).

## 1. Confirmed decisions

- **On the list, or not. No app-level roles for internal users.** What a
  named user may *do* is what their own Genesys permissions in the company
  org say, as the permission refinement already decides for write actions.
  Roles in the app would be a second, hand-kept copy of a fact Genesys
  already holds per person. Of the 95 features in the nav, 91 are already
  mapped to a Genesys permission (55 write, 36 read); the remaining five get
  a mapping (§6) and `GROUP_ACCESS` has nothing left to decide.
- **Only superusers add to the internal org.** Checked against the
  `SUPERUSER_IDS` app setting, server-side, fail closed. Not a group, not a
  flag: the app setting, as the one authority that is not in the browser and
  not editable from the app.
- **One deliberate exception to "no roles": a single capability, "may manage
  customer access", on an internal user's record**, settable only by a
  superuser (§5). Adding a user to a customer org starts a charge, and no
  Genesys permission means that. Keeping it in the app keeps every grant and
  revocation on the same page and in the same audit trail, given by a
  superuser — rather than administered through a Genesys group by people who
  may not know the group now starts charges. The Master Admin group stops
  gating this.
- **No seed.** Current group members are not imported. The rollout has to
  survive that (§8).
- **Billing is untouched.** The internal org (`demo`) is a trustee org and is
  never billed, so its rows in the licence store carry no cost meaning and
  need no exclusion.
- **Customers are unchanged** by this document. Their future roles are §10.
- **The store, the gate, the page and the three enforcement points already
  exist.** This is mostly turning them on for one more org (§3).

## 2. What is wrong today

Internal access is enforced in the browser. `resolveAccess()` in
[`accessService.js`](../js/services/accessService.js) fetches the caller's
Genesys groups and maps them to features through `GROUP_ACCESS`; the sidebar
and the buttons follow. The server does not check any of it. The proxy at
[`genesys-proxy/index.js`](../api/genesys-proxy/index.js) classifies a caller
as internal-org or customer from their token and, for an internal-org token,
uses the elevated client credentials for whatever customer org the request
names — no group, no superuser list, no feature check. Any authenticated
member of the internal org can call the proxy directly with any `customerId`.

The client-side `SUPERUSER_IDS` in [`accessConfig.js`](../js/accessConfig.js)
is one symptom of this; the group model being client-side is the condition.
The server-side `SUPERUSER_IDS` app setting, read by
[`superusers.js`](../api/lib/superusers.js), is checked in exactly one place
— the Requests board.

Customers do not have this gap. Their named-user gate is server-side and runs
at three points. Internal users are the only ones who never meet it.

## 3. What already exists

Everything in this list is built, deployed, and used by real customers:

- **The store** — [`licenseStore.js`](../api/lib/licenseStore.js). Table
  `licenses`, one row per assignment interval, partitioned by customer slug,
  keyed `<userId>|<assignedAt>`. `assign`, `revoke`, `isActive`,
  `listActive`. Nothing is hard-deleted.
- **The gate** — [`licenseGate.js`](../api/lib/licenseGate.js).
  `checkLicense(context, token, classification)` verifies the caller's
  identity from the token and asks the store. Fails closed; cached per token
  for five minutes.
- **The three enforcement points**, all calling the gate:
  `orgConfigResolver` at login (line 390 — an unnamed user gets one screen,
  not the shell); `callerContext` for every store endpoint (line 122); and
  the proxy for every Genesys call (line 169). Today all three run the gate
  **only in customer mode**.
- **The page** — Customers › Access to Admin Tool
  ([`customers/access.js`](../js/pages/customers/access.js)): search the
  selected org, tick, confirm against the names, add; Remove confirmed too.
- **The endpoint** — [`licenses/index.js`](../api/licenses/index.js), which
  today requires the Master Admin group, checked server-side through
  [`userGroups.js`](../api/lib/userGroups.js).
- **Server-side permission reading** —
  [`userPermissions.js`](../api/lib/userPermissions.js), the same read the
  browser's `accessService` makes, already used by the billing endpoint.
- **The feature → permission map** —
  [`featurePermissionMap.js`](../js/featurePermissionMap.js), 91 of 95
  features.

## 4. The record

A named-user row gains two fields:

```
role       ""                 internal user, may use the app     (the default)
           "customer-manager" internal user who may also name users for customers
           "administrator"    customer user, all of the org's package   (later, §10)
           "supervisor"       customer user, a chosen subset            (later, §10)

features   []                 the subset, for a supervisor only; empty otherwise
```

One `role` column, so the internal capability and the future customer roles
are the same mechanism on the same row, read by the same code — `role` rather
than a boolean precisely because the customer side needs more than a boolean.
And a `features` list beside it, because a Supervisor is not a fixed subset:
each one gets the features ticked for them, out of the set an Administrator
has decided a Supervisor may have at all (§10). Both customer values are
reserved here and read by nothing in this document; internal rows never
carry `features`.

The row's partition for internal users is the internal org's slug, `demo`,
which is how `classifyCaller` already names it.

## 5. Who may add whom

| Adding a user to… | Who may | Checked against |
|---|---|---|
| the internal org | superusers only | `SUPERUSER_IDS` app setting, server-side |
| a customer org | superusers, and internal users whose row says `customer-manager` | the caller's own row in the store, server-side |
| — setting `customer-manager` on an internal row | superusers only | `SUPERUSER_IDS` |

The `licenses` endpoint stops asking `userGroups.js` for the Master Admin
group and asks these two questions instead. It already has the verified
caller id from `getCallerContext`; the store lookup is one `isActive`-shaped
read.

Superusers are not on the list — they do not need to be. `SUPERUSER_IDS` is
the root authority and bypasses the gate for the internal org (§7), so a
superuser can always sign in and always add the first name. Nothing that can
be edited from the app can lock a superuser out.

Customers are unchanged: group for the door, named to get in, and today no
customer can name anyone. §10 changes the last part: a customer Administrator
will be able to name users in their own org.

## 6. What replaces the roles

The sidebar and the buttons draw from the caller's Genesys permissions alone,
through the map that already does this for 91 features. The five with no
mapping get one:

| Feature | Permission |
|---|---|
| `export.users.allGroups` | `directory:group:view` **and** `directory:user:view` — it lists groups with their members, two datasets |
| `export.users.skillTemplates` | none — reads only the app's own template store, calls no Genesys endpoint |
| `gdpr.exportReader` | none — parses a file on the user's machine, calls no Genesys endpoint (the map already said so) |
| `export.scheduled` | none — app-owned data; the store scopes it to the caller's own schedules |
| `utilities.ipRanges` | none — public data |

Only one of the five reads Genesys, so only one gets a permission; the map's
own rule — gate what Genesys gates — decides the rest. The first draft of this
table proposed permissions for Skill Templates and Export Reader before the
pages had been read; both would have gated app data on a Genesys permission
for data that is not Genesys's. "Any named user" is the honest gate for the
four, and being named is exactly what this document introduces. Done ahead of
the rest, on `main`, 2026-09-16.

Features with no Genesys counterpart at all — Customers › Access, the admin
pages — are superuser-gated already and stay so, except that Customers ›
Access also admits `customer-manager` rows (§5).

`GROUP_ACCESS` and the client-side `SUPERUSER_IDS` are then dead and are
removed. `resolveAccess()` stops fetching groups; it asks `org-config`
whether the caller is named (and whether a superuser), and fetches
permissions as now. The Genesys groups keep exactly one job: the OAuth
integration is restricted to them, so they decide who can reach the sign-in
page at all. That is what the user meant by "we will still require group
access to the integration", and nothing here changes it.

## 7. Server-side enforcement

Two changes, both small, and the second is what closes §2.

**The gate runs for internal sessions.** `licenseGate.checkLicense` gains an
internal branch: if the caller's verified id is in `SUPERUSER_IDS`, licensed;
otherwise ask the store under the `demo` partition. The three call sites in
§3 stop skipping internal mode. The client-side handling of `licensed: false`
at login ([`app.js:244`](../js/app.js)) already renders the "not named" screen
for customers; it does the same for internal users, with the Requests board
offered as the way to ask.

**The proxy checks the caller's permissions.** For an internal-org call it
reads the caller's effective permissions through `userPermissions.js` (cached
per token, as `classifyCaller` is) and refuses a request whose feature the
caller lacks the permission for. The honest limit: the proxy sees a Genesys
endpoint and a method, not a feature, and the map is feature → permission.
The first cut is therefore **by permission domain**: the request's path
(`/api/v2/routing/queues/…`, `/api/v2/authorization/roles/…`) names its
domain, the method names view/add/edit/delete, and the caller must hold a
permission in that domain at that level. That is real enforcement — an
Export-only person cannot delete a flow through the proxy — and it is exact
for the large majority of Genesys endpoints, whose path segment *is* the
permission domain. The exceptions are catalogued during the build and either
mapped by hand or left to Genesys, which enforces the user's permissions
itself on every call it receives, as it always has. Genesys is the last gate
either way; this makes the app stop being a hole in front of it.

## 8. Rollout — surviving "no seed"

The moment the internal gate is on, every internal user except the superusers
is locked out until added. The page that adds them ships in the same deploy.
That window has to be deliberate, not an accident, so the gate is switched on
by an app setting:

```
INTERNAL_NAMED_USERS_ENFORCED   unset / "false"   gate reports, does not refuse
                                "true"            gate refuses
```

Deploy with it unset. Superusers add everyone who should be there, on the
production page, in whatever order they like. Flip it to `"true"` — an app
setting, no deploy. Anyone missed sees the "not named" screen and asks. Set it
in dev first, live with it, then prod. The flag is removed once it has been
`"true"` in production for long enough that nobody remembers it.

While unset, the gate still runs and logs every internal caller it *would*
have refused, so the list of who needs adding is in the log before the flag
flips.

## 9. Test pass

Written in the same commit as the change, never after
([`update-test-cases-with-behaviour`]).

- Not in the Genesys group → cannot reach sign-in. (Unchanged; recorded.)
- In the group, not named, flag on → org-config returns `licensed: false`;
  the "not named" screen; every store endpoint 403; every proxy call 403.
- In the group, not named, flag unset → signed in as before; a log line.
- Named → in. Sidebar shows what their permissions allow, nothing more.
- Superuser, not named → in. Can add.
- Named, no permission for a feature → not in the sidebar; proxy refuses the
  call anyway when made directly. (The §2 hole, closed.)
- Named `customer-manager` → can add users to a customer org; cannot add to
  the internal org.
- Named without it → cannot add to a customer org; the page does not offer it.
- Superuser sets and clears `customer-manager` on a row; both logged.
- Removal takes effect within the five-minute cache window; sooner on the
  next sign-in.
- Adding an internal user writes no billing-relevant row: the peak sweep for
  `demo` is never asked, and would return nothing meaningful if it were.

## 10. Later — customer roles

Customer users will be added with one of two roles:

- **Administrator** — everything in the org's package, and may name users in
  the org.
- **Supervisor** — a subset, chosen per person. When Supervisor is selected on
  the add flow, checkboxes appear, one per feature, and the person doing the
  adding ticks the ones this Supervisor gets.

The checkboxes are not the whole package. They are **the Supervisor scope**:
the set of features an Administrator — internal, or the customer's own — has
decided a Supervisor in that org may have at all. Defining that scope is its
own control, per org, and is what makes "Supervisor" mean something
consistent inside one customer while differing between customers.

So three things carry it: the org's Supervisor scope (per-org configuration,
alongside its entitlements); the `role` on the row; and the `features` list
on the row, always a subset of the scope. The gate returns role and features
with the licence verdict, and `resolveAccess` narrows the package by them.
The add flow, the scope control, and what a Supervisor scope may contain are
the whole of that work and none of it is started here — but the record in §4
is shaped so that none of it changes the record again.

## 11. Out of scope

- Per-user extras on top of permissions for internal users. If a need
  appears, the `role` field can carry it; nothing is designed for it.
- Replacing the Genesys OAuth group restriction. It stays as the door.
- The customer Supervisor subset (§10).
