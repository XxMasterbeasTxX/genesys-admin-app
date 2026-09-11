# Customers — Access to Admin Tool — Design

Status: **Built** — on main; manual case on Test IE pending
Author: Genesys Admin App
Last updated: 2026-09-11

Companion to [customer-facing-plan.md](customer-facing-plan.md) §5 (the
customer boundary this adds a gate to) and
[customer-billing-design.md](customer-billing-design.md) §2 (the pattern for a
server-side check on a customer session).

## 0. The requirement

Customers pay for the app per **named user**. Netdesign names the users; only
named users may use the app; anyone else in the same org is refused, however
senior their Genesys role. Netdesign can see, per customer, who has access.

Billing — later, not in this document — counts named users per billing
period at their **peak**: a customer that had 5 and dropped to 4 halfway
through a period is billed for 5 that period. This document builds nothing
for billing except the one thing billing cannot do without: a history that
still knows, next year, who was named when.

There is deliberately **no seat count**. The list is the contract. A separate
"seats" number would be a second fact that has to agree with the first, and
the day it did not — contract says 5, six names assigned, or an upsell nobody
typed in — the app would be enforcing something untrue. With no count there is
nothing to drift.

## 1. Confirmed decisions

- **Named by Genesys user id.** The stable GUID the server already verifies
  from the token (`identifyCaller` → `users/me`). E-mail and name are stored
  for display only.
- **The list lives in the app's own store** — a `licenses` table alongside
  schedules, templates and the activity log, same `*Store.js` pattern. Not the
  registry (an app-setting edit per name, no audit), not a Genesys group (the
  customer could edit it, and it has no history).
- **No cap, no count to configure.** Adding a name is the commercial act.
- **Remove is a revocation, not a deletion.** The row gets `revokedAt` and
  stays, so the peak within any past period can be computed later.
- **Only Netdesign assigns**, and only **Genesys App - Master Admin**. No
  customer self-service, therefore no admin flag on a row. If self-service
  comes later it is one boolean.
- **The gate is server-side, on every request.** Not just at login.
- **Fail closed.** If the store cannot be read, the user is not licensed for
  that request.
- **Timestamps in UTC**, ISO-8601. Genesys billing periods arrive as ISO
  datetimes; the peak sweep compares like with like.
- **No prices.** The app knows who; it never knows what one costs.
- **No release note** unless you say otherwise.

## 2. What each side sees

**A named customer user** — nothing changes. Same menu, same entitlements,
same greying.

**An unnamed customer user** — one screen instead of the app shell:

> *No licence for this app is assigned to you. Ask your administrator.*

No menu, no partial page, no 403s trickling in from features. The Genesys
integration is still visible to them in the Apps menu — that is Genesys group
filtering, a separate control the customer's admin owns.

**Internal Master Admins** — **Customers › Access to Admin Tool**, driven by
the header org selector like every other internal page:

- **Add users** — a search box. As you type, a dropdown of matching users
  from the selected customer's org (name and e-mail), each with a checkbox.
  Tick the ones you mean — they collect as chips under the box, across
  searches — then press **Add users** (it says how many). A confirmation
  lists every ticked user by name and e-mail, names the org, and says that
  adding a name is what the customer is billed for. Only OK reaches the
  server. Three deliberate steps, because a single click on a search result
  is not enough of a decision to start a charge (first version had exactly
  that, and it was too easy). A user who already has access shows as such and
  cannot be ticked.
- **Users with access** — name, e-mail, added by, added on, **Remove**. Remove
  confirms first: it locks the person out within five minutes.
- **"N users have access"** — a count. Informational, not a target.

Every add and remove is written to the activity log with the caller's
verified identity.

## 3. The store

`api/lib/licenseStore.js`, table `licenses`, partitioned by customer slug —
the same slug the registry and `customers.json` use, which must agree (they do
for Test IE; the onboarding runbook says so).

| field | meaning |
| --- | --- |
| `partitionKey` | customer slug |
| `rowKey` | `<userId>|<assignedAt>` — one row per assignment interval, so a user removed and re-added has two rows, both true |
| `userId`, `email`, `name` | the named user; e-mail and name for display |
| `assignedBy`, `assignedAt` | who named them, when (UTC ISO) |
| `revokedBy`, `revokedAt` | who removed them, when — absent while active |

Operations:

- `listActive(customerId)` — rows without `revokedAt`. What the page shows and
  what the gate consults.
- `isActive(customerId, userId)` — the gate's question.
- `assign(customerId, user, by)` — idempotent: an existing active row for the
  id is returned, not duplicated.
- `revoke(customerId, userId, by)` — stamps the active row; idempotent.
- `peakAssigned(customerId, start, end)` — **built now, shown nowhere yet.**
  Count active at `start`, then walk every `assignedAt` and `revokedAt`
  inside `[start, end]` in time order, taking the maximum. This is the
  function the billing feature calls; building it now proves the rows carry
  what it needs before any history accumulates.

Nothing is ever hard-deleted from this table.

## 4. The gate

`api/lib/licenseGate.js` — `checkLicense(context, token, classification)`:

- Runs only for `classification.mode === "customer"`.
- `identifyCaller` on the customer's region → verified user id.
- `isActive(customer.id, userId)`.
- Returns `{ licensed: true, userId }` or `{ licensed: false, reason }`,
  `reason` one of `not_assigned`, `identity_unavailable`,
  `license_check_failed`. All three refuse; the code says why.
- Cached per token for the same five minutes as the classification, so a
  removal takes effect within that window.

Four callers, one function (the fourth found while building: `billing-overview`
classifies for itself rather than through `getCallerContext`, so it must ask
the gate itself):

1. **`resolveOrgConfig`** — customer branch. Unlicensed → `200 { mode:
   "customer", licensed: false, reason }`; the client renders the screen.
   Licensed → the existing customer body plus `licensed: true`.
2. **`getCallerContext`** — customer branch. Unlicensed → `authorized: false,
   403 user_not_licensed`. Every store endpoint inherits it.
3. **`genesys-proxy`** — customer branch, before the entitlement guard.
   Unlicensed → `403 user_not_licensed`.
4. **`billing-overview`** — after classification, before the permission
   check. Unlicensed → `403 user_not_licensed`.

Internal and fallback modes never reach it. Superusers are internal.

## 5. The endpoints

`api/licenses/` — internal sessions only, and **the caller must be in
`Genesys App - Master Admin`**, checked server-side by reading the caller's
groups on the home region (the same lookup the client makes). The client's
`GROUP_ACCESS` gates the page; this gates the endpoint, so an internal user
outside the group calling it directly is refused too.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/licenses?customerId=` | `{ users: [...active rows...] }` |

Every method first checks that `customerId` is an org that can sign in as a
customer: not the internal org (`400 internal_org` — its users are granted by
group and never meet the gate, so a name there would only mislead) and present
in the registry (`400 not_a_customer` — otherwise nobody can sign in to it as
a customer at all). Found on first use: the page offered the box for Demo.
org-config now sends `internal` and `registered` with each customer, and the
page says why instead of offering a box that would fail.

| | | |
| --- | --- | --- |
| POST | `/api/licenses/assign` `{ customerId, userId, email, name }` | `assign`; `200` with the row, whether new or already active |
| DELETE | `/api/licenses/assign` `{ customerId, userId }` | `revoke`; `200`; idempotent |

`peakAssigned` has no endpoint yet. When billing needs it, it gets one.

## 6. The page

`js/pages/customers/access.js`, nav key `customers.access`, a new section
"Customers" placed after Deployment. Reads the org from the header selector.
User search is `POST /api/v2/users/search` on the selected customer through
the proxy, debounced, name and e-mail.

Access:
- `CUSTOMER_EXCLUDED_KEYS` gains `customers` — never in customer mode.
- `GROUP_ACCESS`: `customers.*` on **Master Admin only**. It sits with
  `flows.delete`, not with `ADMIN_BASE`: adding a name starts a charge.
- Read map: `customers.access` → `directory:user:view`, what Genesys requires
  for `/users/search`; the read runs through client credentials, so the gate
  is the app's, per the read-gating design.

## 7. What this does not do

- No customer self-service, no admin flag (§1).
- No billing. `peakAssigned` exists; nothing calls it and nothing displays it.
- No prices.
- No change to packages, entitlements, permission greying or the billing
  pages — the gate sits in front of all of them.
- No Genesys-side group filtering — that stays the customer's control.
- No hard-delete, ever, and no UI for history. The rows are there when
  billing wants them.

## 8. Test pass

Harness, real modules, store and `fetch` stubbed; every store call and URL
recorded.

| # | Case | Expected |
| --- | --- | --- |
| 1 | customer, active row | org-config `licensed: true`; proxy passes; store endpoints authorize |
| 2 | customer, no row | `licensed: false, not_assigned`; proxy `403 user_not_licensed`; store endpoints `403` |
| 3 | customer, row revoked | as 2 |
| 4 | customer, store throws | `licensed: false, license_check_failed` — fail closed |
| 5 | customer, `users/me` fails | `licensed: false, identity_unavailable`; no store read |
| 6 | internal session | gate never called; behaviour identical to today |
| 7 | assign | row created with `assignedBy` = the caller's verified id; activity-log entry |
| 8 | assign an already-active id | same row back; no second row |
| 9 | revoke | `revokedAt` stamped; row still present; `listActive` no longer returns it |
| 10 | revoke, then assign again | a second row; `listActive` returns one entry for the user |
| 11 | cached session after revoke | still passes until its entry expires, then fails |
| 12 | endpoints, internal caller not in Master Admin | `403 group_required` |
| 13 | endpoints, customer caller | `403 internal_only` |
| 14 | `customers.access` for a customer session | `hidden` |
| 15 | read map | `customers.access` needs `directory:user:view` |
| 16 | `peakAssigned`: 5 active, one revoked mid-period | **5** |
| 17 | `peakAssigned`: 4 active, one added on the last day | **5** |
| 18 | `peakAssigned`: one added and revoked inside the period | counts at that moment |
| 19 | `peakAssigned`: activity entirely before / entirely after the period | not counted |
| 20 | `peakAssigned`: period boundary at 23:30 UTC on the last day | the add at 23:30 counts; one at 00:30 next day does not |
| 21 | assign for the internal org | `400 internal_org`, no row |
| 22 | GET / DELETE for an org with no registry entry | `400 not_a_customer` |
| 23 | org-config customer list | `internal: true` on Demo, `registered: true` on Test IE, both false on an unregistered org |

Manual, on Test IE: add you and your colleague → both in as before; a third
Test IE user → the refusal screen; remove one → refused within five minutes;
add them back → in again.

**Result 2026-09-11:** all twenty-three pass, plus three extras (the assigner's id
is the verified one, not the body's; the activity-log entry is written; a
same-second swap never under-counts the peak). Server cases run the real
endpoint, gate, store, resolver, caller context, proxy and activity log with
an in-memory stand-in for Table Storage and every Genesys URL recorded —
case 2 asserts that an unnamed user's proxied call produces **no** Genesys
request, case 4 that a storage failure refuses even a named user and is not
cached. A fourth gate caller was found while building — `billing-overview`
classifies for itself — and is gated and tested (an unnamed user holding
`billing:subscription:view` gets `403 user_not_licensed` and no trustee call).
Every earlier pass — refinement, auth, billing server and client, the trustee
equivalence — still passes. Manual case: pending Test IE.

**Deployment note.** The moment this is live, every Test IE user is refused
until a Master Admin names them on Customers › Access to Admin Tool. That is
the design working, but it means the page must be used right after the deploy,
before anyone tests as a customer.

## 9. Onboarding, afterwards

The runbook gains one step after the registry entry: open Customers › Access
to Admin Tool for the new org and add the named users. Until that is done the
customer's users see the refusal screen — by design.
