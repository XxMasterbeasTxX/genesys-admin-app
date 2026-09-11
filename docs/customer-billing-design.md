# Customer mode — Billing Period and Period Comparison — Design

Status: **Built** — on main; manual case pending a real customer org (§7)
Author: Genesys Admin App
Last updated: 2026-09-11

Companion to [customer-facing-plan.md](customer-facing-plan.md) §5 (the customer
boundary this deliberately crosses, once, on purpose) and
[customer-permission-refinement-design.md](customer-permission-refinement-design.md)
(the greying this relies on).

## 0. The requirement

A customer must be able to see their own **overage** — where usage exceeded
what they committed to — for a billing period, and compare periods. Later, they
will be able to choose items and be emailed when overage occurs on them. This
document covers the seeing; it shapes the server so the emailing can reuse it.

Two pages exist that show exactly this for internal staff: Export › Billing ›
Single Org and Period Comparison. Both are hidden from customers by the
`export.billing` prefix in `CUSTOMER_EXCLUDED_KEYS`, and `/api/v2/billing` is on
the proxy's always-deny list for customer sessions.

## 1. Why this cannot be done with the customer's own token

Checked against the full OpenAPI spec (`/api/v2/docs/swagger`, 22 MB,
2026-09-11), not from memory. Genesys exposes two billing endpoints:

| Endpoint | Caller | Permission | Carries |
| --- | --- | --- | --- |
| `GET /billing/reports/billableusage?startDate&endDate` | an org, about itself | `billing:subscription:view` | usage totals per licence, and the resources behind them |
| `GET /billing/trusteebillingoverview/{trustorOrgId}?billingPeriodIndex` | a **trustee**, about a trustor | `affiliateOrganization:clientBilling:view` | prepay qty, usage qty, overage, prices, part numbers, contract dates, per billing period |

Overage is `usage − prepay`. `billableusage` has no prepay, no committed
quantity, no billing period. Nothing else in the spec does either: `license/*`
is assignments, `usage/*` is API-call usage. **The only object that carries
both numbers is the trustee overview, and only a trustee may fetch it.**

Netdesign is the customers' trustee. So the customer's own overage is
reachable in exactly one way: the server fetches the trustee overview for the
customer's org, as Netdesign, and hands it to the customer.

## 2. What this crosses, and how it is contained

Plan §5 says a customer session never triggers client-credential calls. This
design makes one exception, and fences it four ways:

1. **A dedicated endpoint, not the proxy.** `GET /api/billing-overview?billingPeriodIndex=N`.
   The generic proxy keeps `/api/v2/billing` denied for customers; a customer
   cannot reach `trusteebillingoverview` for *any* org id through it.
2. **The org comes from the verified identity, never the request.** The
   endpoint calls `getCallerContext`; in customer mode that yields the customer
   slug and the org id `classifyCaller` verified against the registry. There is
   no `orgId` parameter. A customer cannot ask about another org because there
   is nothing to put another org into.
3. **The user's own Genesys permission is checked server-side.** Genesys does
   not enforce anything here — the call is made as the trustee — so the UI's
   greying cannot be the only gate. The endpoint reads the caller's
   `users/me?expand=authorization` on **their** region and requires
   `billing:subscription:view` (or `:read`, the same ANY Genesys declares for
   `billableusage`). That is the permission Genesys itself uses to decide
   whether this person may see their org's billing in Genesys Admin; the app
   shows them nothing Genesys would not. Fail closed: no permission set, no
   data.
4. **Internal sessions are refused by this endpoint.** Internal staff keep the
   existing proxy path (their reads run as the trustee already, gated by the
   affiliate permission). The endpoint has one caller type.

The rule this leaves behind, for the plan: *a customer session may trigger a
client-credential call only through a dedicated endpoint that derives the org
from the verified identity, enforces the user's own Genesys permission for the
equivalent self-service data, and exposes nothing the customer could not see
in Genesys Admin.*

## 3. Server

### 3.1 `api/lib/billingTrustees.js` (new)

The trustee lookup, server-side. As first shipped it held its own copy of the
four-entry table, making five copies in all (this, the client's
`js/utils/billingTrustees.js`, and the three scheduled exports). **Consolidated
2026-09-11:** the truth is now one field per row in `api/lib/customers.json`,
`billingTrustee` — a trustee slug, or `null` when the org is itself a trustee.
This module derives `trusteeFor()` from that file; the three exports `require`
it and their inline tables are gone; org-config and `/api/customers` send the
field to the browser, and the client module answers from the customer list
instead of a table of its own. Adding a billable customer is one row.

A slug with no row keeps the old default of `"demo"`, deliberately: a
registry-only customer (in `CUSTOMER_REGISTRY_JSON`, not yet in
`customers.json`) resolved to Netdesign before and still does. Every org that
is in the file carries the field explicitly.

Verified by an equivalence pass: for every slug in `customers.json` plus
unknown slugs, the new server lookup, the three exports through it, and the
client module reading the sent list all return exactly what the old table
returned — `trusteeFor`, `isTrusteeOrg` and `filterBillableCustomers` alike.
Live: a scheduled All Orgs (Latest) export on dev, 2026-09-11, after the
consolidation — completed, e-mail delivered, sheet identical to before (Demo
and Test IE absent, every other org present). That run is what proves the
`require` resolves and the file is read inside the Functions runtime.

### 3.2 `api/lib/billingOverview.js` (new)

`fetchOverviewForCustomer(context, { customerId, orgId, billingPeriodIndex })`:

- `trusteeFor(customerId)`; `null` → `{ error: "no_trustee" }`.
- `genesysCall(trusteeId, "GET", "/api/v2/billing/trusteebillingoverview/<orgId>?billingPeriodIndex=N")`
  using the per-org client-credential pattern `billingSingleOrg.js` already
  has (`GENESYS_<SLUG>_CLIENT_ID/_SECRET/_REGION`). Lifted into this module
  rather than imported from an export file.
- Returns the `TrusteeBillingOverview` body untouched.

This is the function the later overage-alert timer calls. Nothing in it knows
about HTTP requests.

### 3.3 `api/billing-overview/` (new function)

- `getCallerContext(context, req)`; not authorized → its status/error.
- `mode !== "customer"` → `403 customer_only`.
- Permission check: `identifyCaller`-style `users/me?expand=authorization` on
  `classification.org.region`; require ANY of `billing:subscription:view`,
  `billing:subscription:read` (wildcards honoured as `permGrants` does
  client-side). Missing → `403 permission_required` with the permission named.
  Unreadable → `403 permission_unverified`.
- `billingPeriodIndex` from the query, integer 0..N (bounded; today the pages
  use 0..3).
- `fetchOverviewForCustomer(...)` → `200` body, or `404 no_trustee`, or the
  upstream status.
- Budget: one trustee token + one overview call, well inside the 45 s cap.

## 4. Client

### 4.1 `js/services/billingService.js`

`fetchBillingOverview` and `fetchBillingOverviewById` become mode-aware. In
customer mode (`orgContext` reports a locked customer) they call
`GET /api/billing-overview?billingPeriodIndex=N` via `withUserToken` and return
the body. Same shape as the trustee path, so `processBillingOverview` and both
pages are unchanged downstream. Internal mode is untouched.

The "is a trustee itself" refusal stays for internal mode. In customer mode it
is the server's `no_trustee` answer, rendered by the page.

### 4.2 The two pages

- **Rename "Single Org" to "Billing Period"** — nav label and page title, the
  same in both modes (internal staff still pick the org in the header, so "Single
  Org" was only ever describing the selector). "Period Comparison" keeps its
  name. Access keys `export.billing.singleOrg` and
  `export.billing.periodComparison` are kept so `GROUP_ACCESS` and the read map
  need no churn.
- **Period Comparison drops its in-page org `<select>`** and reads the org from
  `orgContext`, as Single Org already does. Internal staff pick the org in the
  main selector; customers are locked to their own. The page re-renders on
  `orgContext.onChange` and says "Select a customer org in the header" when
  none is chosen internally.
- Remove the sentence "Matches the Python report." from Period Comparison's
  intro.

### 4.3 Access

- `CUSTOMER_EXCLUDED_KEYS`: replace the `export.billing` prefix with the four
  pages that stay internal — `export.billing.allOrgsLatest`,
  `export.billing.calendarYear`, `export.billing.dateRange`,
  `export.billing.customOrgs`. The other two become customer-visible under
  the `*` packages (`all`, `demo`) and, should tiers return, whichever package
  lists `export.billing.singleOrg` / `.periodComparison`.
- **Read map, per mode.** Internally these pages need
  `affiliateOrganization:clientBilling:view` (the trustee's permission — the
  read runs as the trustee). For a customer they need
  `billing:subscription:view`. One entry cannot say both under ANY: an
  internal user holding only `billing:subscription:view` in the company org
  would pass the UI gate for reading a *customer's* billing, which is the exact
  escalation the read gate exists to stop. So the map gains an optional
  per-mode override:

  ```js
  "export.billing.singleOrg": { view: ["affiliateOrganization:clientBilling:view"],
                                customer: { view: ["billing:subscription:view",
                                                   "billing:subscription:read"] } },
  ```

  `getReadPermissions(accessKey, action, mode)` returns the `customer` block
  when `mode === "customer"` and it exists, else the default. The shared
  builder receives `mode` from its resolver. Entries without a `customer` block
  behave exactly as today.

## 5. What this does not do

- No self-service `billableusage` page. It cannot show overage, and a page
  that looks like billing but cannot show overage is worse than none.
- No overage e-mail. §3.2 is shaped for it; the timer, the selection UI and
  the e-mail are their own design.
- No change to the four internal-only billing pages, nor to the three
  scheduled billing exports.

## 6. Test pass

Harness, real modules, fetch and env stubbed; every URL recorded.

| # | Case | Expected |
| --- | --- | --- |
| 1 | customer session, holds `billing:subscription:view` | trustee call made for **the verified org id**, as **the mapped trustee**; body returned |
| 2 | customer, lacks it | `403 permission_required`; **no trustee call** |
| 3 | customer, permission set unreadable | `403 permission_unverified`; no trustee call |
| 4 | request carries `?orgId=<other>` | ignored — the call still targets the verified org |
| 5 | internal session | `403 customer_only`; no trustee call |
| 6 | customer whose org maps to `null` | `404 no_trustee`; no call |
| 7 | generic proxy, customer, `/api/v2/billing/...` | still `endpoint_not_available_for_customer` |
| 8 | read map, internal mode, `export.billing.singleOrg` | requires the affiliate permission |
| 9 | read map, customer mode, same key | requires `billing:subscription:view`/`:read` |
| 10 | read map, key without a `customer` block, customer mode | falls back to the default — no behaviour change elsewhere |
| 11 | `CUSTOMER_EXCLUDED_KEYS` | the four internal billing pages hidden, the two customer ones visible under `all`; everything from the §5f Recordings pass unchanged |
| 12 | `billingService` in customer mode | calls `/api/billing-overview`, never `proxyGenesys` |
| 13 | `billingService` in internal mode | unchanged — `proxyGenesys` as trustee, as today |

Manual, on dev, as a user of a **real customer org** (a trustor of Netdesign)
holding `billing:subscription:view`: Billing Period shows the overview with
prepay, usage and overage; Period Comparison shows 2–4 periods with Δ/% and no
org selector on the page. Without the permission: both pages greyed, permission
named. On Test IE: both pages render "Billing is not available for this
organisation through this app." Internally: both pages unchanged, Period
Comparison now driven by the header selector.

**Result 2026-09-11:** all thirteen pass — cases 1–7 against the real
`api/billing-overview/index.js` with the real resolver, permission, trustee,
token and allow-list modules (env and `fetch` stubbed; every URL and
Authorization header recorded, so "which org, as whom" is asserted from what
was sent), cases 8–13 against the real `featurePermissionMap.js`,
`accessService.js`, `orgContext.js` and `billingService.js`. Extras: a
`billing:*:*` wildcard is honoured; an out-of-range index is a 400; the
permanent `no_trustee` answer surfaces once from `fetchBillingPeriods` rather
than as four "Failed to load" rows. The ten-case permission-refinement pass and
the §5f Recordings pass still pass after the read-map change. Manual case:
pending the first real customer org on dev.

## 7. Test IE cannot exercise the customer path

Resolved 2026-09-11: **Netdesign DE is not a trustee of Test IE.** Both Demo
and Test IE are trustees (authorised organisations) *for* customers; neither is
a trustor of the other. So `"test-ie"` stays `null` in the map, and on Test IE
the endpoint returns `no_trustee`.

Two things follow:

- **The `no_trustee` state is a first-class page state, not an error.** Both
  pages render "Billing is not available for this organisation through this
  app" — plain, no stack trace, no retry — because it is the true and permanent
  answer for that org. On Test IE this is what the demo user sees on these two
  pages; everything else in the customer demo is unaffected.
- **The manual test moves to a real customer.** The harness cases in §6 prove
  the server and client logic, including that the trustee call targets the
  verified org and is made as the mapped trustee; what they cannot prove is
  that a live trustee token reads a live trustor's overview. That is verified
  the first time a customer org — a real trustor of Netdesign — holding
  `billing:subscription:view` opens Billing Period on dev. Recorded as pending
  here; the plan's §5 gets the same line.
