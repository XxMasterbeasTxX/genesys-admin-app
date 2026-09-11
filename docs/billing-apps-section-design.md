# Billing — Apps section (Admin Tool named users) — Design

Status: **Built** — on main; manual check on Test IE pending
Author: Genesys Admin App
Last updated: 2026-09-11

Companion to [customer-user-licensing-design.md](customer-user-licensing-design.md)
(the list and the peak rule this bills from) and
[customer-billing-design.md](customer-billing-design.md) (how billing reaches
a customer).

## 0. The requirement

Every billing page and export gains a section **Apps**, alongside Regular
Licenses and AI Tokens, with one licence, **Admin Tool**: the number of named
users for the org in the billing period, at the period's **peak**
(`peakAssigned`, customer-user-licensing-design §3). It goes in the
*Actual Usage* column, and whenever it is above zero it also appears under
*Items with Overage and Other Billable Items*, because every named user is
billable — there is nothing prepaid to net it against.

And a way to see it working **without naming users on a real customer**: on
Test IE, which cannot show billing today because Netdesign is not its trustee.

## 1. Confirmed decisions

- **The number is `peakAssigned(org, periodStart, periodEnd)`** — the
  Genesys-style high-water mark already built and tested. Period bounds are
  the overview's own `billingPeriodStartDate` / `EndDate`, so the app count
  and the Genesys usages describe exactly the same window.
- **One row, in every sheet.** `Admin Tool`: Committed blank, Actual Usage =
  peak, On-Demand = peak. Present even when zero (a customer with no named
  users sees `0`, not an absent section — "we counted, it was none").
  When > 0 it is also written in the overage section, styled like the other
  billable rows, and counted in *Billable Items*. Same shape as
  `AI Tokens - Billable`, which already does this.
- **Section placement:** after AI Tokens Usage Breakdown, before Overage.
  Banner `─── APPS ───`.
- **Period Comparison gets the row too**, with Prepay blank, Usage = peak,
  Overage = peak, and the Δ / % columns computed on Usage like every other
  row.
- **Added in the two places every sheet is built from** — the client
  processor + block writer (`billingProcessor.js`, `billingExcelStyles.js`)
  and their server mirrors (`api/lib/billingWorkbook.js`) — so all six pages
  and all three scheduled exports inherit it. No page is edited for the
  section itself.
- **Simulation is a server-side stand-in for Genesys, never for the count.**
  See §4. The Admin Tool number on Test IE is the real list.
- **No prices.** A count of users, as everywhere else.
- **No release note** unless you say otherwise.

## 2. Where the count comes from

### 2.1 Client pages — a peak endpoint

`GET /api/licenses/peak?customerId=&start=&end=` → `{ customerId, start,
end, users: n }`.

- **Internal session:** any `customerId`. No Master Admin requirement —
  reading a count is not the commercial act; naming is. (The list and
  assign/revoke keep their group check.)
- **Customer session:** `customerId` is ignored and replaced by the verified
  org from the classification — a customer sees only their own count, and
  the gate applies as everywhere on the customer path.
- Start/end validated as ISO datetimes; a bad or inverted range is `400`.

`billingService` gains `fetchAdminToolUsers(orgId, overview)`, called once per
overview fetched, and passes the result into the processor. Pages already
call `processBillingOverview(ov)`; they now call
`processBillingOverview(ov, { adminToolUsers })`. That is the one-line edit
per page — six pages, one line each.

### 2.2 Scheduled exports — the store directly

The three server exports already run with store access. They call
`peakAssigned` themselves for each org and period; no endpoint involved.

## 3. The processor change

`processBillingOverview(overview, { adminToolUsers } = {})`:

- `appsRows = [{ name: "Admin Tool", committed: "", actualUsage: n, onDemand: n }]`
  — when `adminToolUsers` is a number. When it is absent (a caller that did
  not ask, or the count could not be read) the section is written with
  Actual Usage `—` and a note, never silently as `0`: a missing count and a
  zero count are different facts and the sheet must not conflate them.
- `n > 0` → pushed to `overageRows` with `overageCost: 0`; `billableItems`
  counts it.
- Returned as `appsRows` alongside `regularRows`, `aiBreakdownRows`,
  `overageRows`. `appendBillingBlock` writes the section. Server mirror
  identical.

## 4. Simulation — seeing it on Test IE

Test IE cannot show billing: no trustee reads it. The point of testing here
is the **Apps** row and its overage behaviour, not Genesys's numbers. So:

- **`BILLING_SIMULATION_ORGS`** — an app setting, comma-separated slugs
  (`test-ie`). Empty by default; set per environment where wanted.
- For a listed org, **the server answers the billing overview itself** with a
  fixed synthetic `TrusteeBillingOverview`: organisation name suffixed
  **`(SIMULATED)`**, a short set of made-up usages including one AI-token row
  and one prepaid licence over its commitment (so Regular, AI and Overage all
  render), currency and subscription type set, and billing periods derived
  from the requested index — index 0 is the current calendar month, 1 the
  previous, and so on. Deterministic: the same index always yields the same
  numbers.
- **The Admin Tool count is real** — `peakAssigned` over Test IE's actual
  rows for the synthetic period. Name a second user, the number moves; remove
  one mid-month, the peak holds. That is the behaviour under test.
- Where it applies: `billing-overview` (the customer path — so a Test IE
  customer user sees Billing Period and Period Comparison with simulated
  Genesys data and their real Apps row) **and** the internal pages. For the
  latter, org-config sends `billingSimulated: true` on the org, and
  `billingService` routes a simulated org to `billing-overview` with
  `customerId` — accepted from an **internal** caller only, and only for a
  simulated org; a customer session still gets its verified org and nothing
  else. `filterBillableCustomers` treats a simulated org as billable, so All
  Orgs / Calendar Year / Date Range / Custom Orgs include it too.
- **Unmistakable in the output.** The org name carries `(SIMULATED)` in the
  summary banner and sheet name; the page status line says *"Simulated
  billing data — the Genesys figures are not real; the Admin Tool count is."*
- **The scheduled exports do not simulate.** They are real-world jobs that
  e-mail people; Test IE stays excluded there as today.
- **Production:** the setting is what turns it on. Leaving it empty in prod
  means prod never simulates; setting it to `test-ie` there lets your
  colleague run the same check in prod. Your call per environment; the code
  is identical.

## 5. What this does not do

- No pricing, no invoice lines, no per-user cost.
- No history view of named users — the peak is a number in a sheet.
- No simulation of the Admin Tool count itself, ever; and no simulation in the
  scheduled exports.
- No change to who may see billing (permission gates unchanged), nor to the
  named-user gate.

## 6. Test pass

Harness, real modules.

| # | Case | Expected |
| --- | --- | --- |
| 1 | processor, `adminToolUsers: 3` | `appsRows` = one row, usage 3, on-demand 3; appears in `overageRows`; `billableItems` +1 |
| 2 | processor, `adminToolUsers: 0` | row present with 0; **not** in `overageRows`; `billableItems` unchanged |
| 3 | processor, count absent | row present with `—`; not in overage; distinguishable from 0 |
| 4 | block writer | `─── APPS ───` banner after AI breakdown, before Overage; row styled as data; overage copy styled as overage |
| 5 | server mirror | same three outcomes as 1–3 from `billingWorkbook.processBillingOverview` |
| 6 | peak endpoint, internal, any org | `200 { users }` matching `peakAssigned` for the bounds |
| 7 | peak endpoint, customer session with `?customerId=<other>` | count for **their own** org; the parameter ignored |
| 8 | peak endpoint, unnamed customer | `403 user_not_licensed` |
| 9 | peak endpoint, bad range | `400` |
| 10 | `billing-overview` for a simulated org, customer session | synthetic overview, org name `(SIMULATED)`, no Genesys call |
| 11 | `billing-overview` for a simulated org, internal caller with `customerId` | same; for a non-simulated org with `customerId` → `403 customer_only` as today |
| 12 | simulation off (setting empty) | Test IE → `no_trustee` as today |
| 13 | Period Comparison rows | `Admin Tool` present per period; Δ computed on usage |
| 14 | scheduled Single Org export | sheet has the Apps section with the store's peak |
| 15 | every existing billing pass | unchanged |

**Result 2026-09-11:** all fifteen pass. Client cases (1–4, 13) run the real
processor, block writer and Period Comparison row builder with xlsx-js-style
as `window.XLSX`, reading the written sheet back cell by cell for the banner
order and the two `Admin Tool` rows. Server cases (5–12, 14) run the real
`billing-overview`, `licenses`, store, gate, resolver and workbook modules with
in-memory Table Storage and every Genesys URL recorded — case 14 drives the
real `billingSingleOrg` scheduled export end to end and reads `Admin Tool = 2`
out of the produced workbook. Case 12 re-loads the modules with the setting
empty and gets `no_trustee` back. Every earlier pass still passes.
`BILLING_SIMULATION_ORGS=test-ie` is set in dev and prod. Manual: pending.

Manual, on dev with `BILLING_SIMULATION_ORGS=test-ie`: as a Test IE customer,
Billing Period shows the simulated org, an Apps section with `Admin Tool = 2`,
and `Admin Tool` in the overage section; name a third user, reload after five
minutes, `3`; remove them, the current period still shows `3`. Internally,
All Orgs (Latest) includes `Test IE (SIMULATED)` with the same row. Scheduled
All Orgs export: no Test IE, real orgs carry `Admin Tool = 0`.
