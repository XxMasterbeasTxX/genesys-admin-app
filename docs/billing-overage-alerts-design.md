# Billing — Overage Alerts — Design

Status: **Built** — on main; manual case on Test IE pending
Author: Genesys Admin App
Last updated: 2026-09-11

Companion to [billing-apps-section-design.md](billing-apps-section-design.md)
(the processor and the simulation this reads through),
[customer-billing-design.md](customer-billing-design.md) (how a customer's
billing is read, and by whom) and
[customer-user-licensing-design.md](customer-user-licensing-design.md) (the
named-user list an Admin Tool threshold counts).

## 0. The requirement

A customer, or Netdesign about a customer, wants to be told when a licence
goes into overage in the **current** billing period — not the last complete
one. They choose which licences or features to watch, daily or weekly, and it
runs at midnight. The mail says what is over, by how much.

## 1. Confirmed decisions

- **A schedule type, not a new scheduler.** One handler, `billingOverageAlert`,
  registered like the exports. The store, owner scoping (a customer sees only
  its own alerts), the verified creator, the Europe/Copenhagen cadence, the
  mailer, the Activity Log and the Scheduled Exports listing are all reused
  unchanged. What is new is the handler, the page, and two small runner
  additions (§5).
- **Location: Export › Billing › Overage Alerts.** The existing Billing folder,
  where every other schedule is created and where a customer already looks for
  billing. (Read as "Billing › Overage Alerts" in your answer; if a new
  top-level section was meant, it is a one-line move in the nav.)
- **Current period only** — `billingPeriodIndex` 0, through the same
  server-side read the customer billing pages use (`fetchOverviewForCustomer`),
  which was built for this. A simulated org (Test IE) is served its synthetic
  overview, whose WEM row is deliberately over its commitment — so the alert
  is testable there.
- **Overage per item:**
  - a Genesys licence — On-Demand > 0 (actual above committed), exactly as the
    sheets compute it;
  - AI Tokens — billable tokens > 0;
  - **Admin Tool — a threshold.** Every named user is billable, so "over zero"
    would fire forever; the creator sets *"tell me when more than N users are
    named"*, and the alert compares the period's peak against N.
- **Daily or weekly**, at **00:00** Copenhagen. The time is fixed and not
  shown as editable; weekly takes a weekday. The runner ticks every five
  minutes, so it fires within five minutes of midnight on the chosen days.
- **Two notification modes, chosen at creation:**
  - **Every run while in overage** — a daily alert is a daily reminder until
    the overage clears. Stateless.
  - **Only when an item enters overage** — mail when an item goes from clear
    to over (or, for Admin Tool, first crosses the threshold); silence while
    it stays over; the handler remembers last run's state per item on the
    schedule. A lost mail is not repeated in this mode; the mode says so on the
    form.
- **Recipients: the existing free-text list** (`emailRecipients`), empty by
  default — the creator types who gets the mail (no autofill, at your request). The custom-message field is **not** offered on this form —
  the runner lets a custom message replace the handler's body, and for an
  alert the body *is* the information.
- **Mail only when there is something to say.** A run with nothing in overage
  sends nothing and records "ran — all clear" in the Activity Log.
- **Same permission gate as Billing Period** — `billing:subscription:view`
  for a customer, the affiliate permission internally — through the per-mode
  read map. The named-user gate applies as everywhere on the customer path.
- **No prices.** Quantities over, never what they cost.
- **No release note** unless you say otherwise.

## 2. The page

`js/pages/export/billing/overageAlerts.js`, nav key
`export.billing.overageAlerts`, customer-visible (added next to the two
customer billing pages in the exclusion list's logic — i.e. *not* excluded).

Driven by the header selector. On load, for the selected org, it fetches the
current period once (index 0, the same path the pages use) and shows:

**Create an alert**
- **Watch** — a checkbox per item found in the current period: each regular
  licence by name; *AI Tokens* if the org uses them; *Admin Tool* with a number
  field beside it, *"when more than [ N ] users are named"* (default: the
  current count, so the alert fires on the next addition). Items already in
  overage are marked as such, so the creator can see what the first run would
  report.
- **Frequency** — Daily / Weekly, and a weekday for weekly.
- **Notify** — *Every run while in overage* / *Only when an item enters
  overage*.
- **Recipients** — free text, empty; required before Create.
- **Create** — a confirmation lists what will be watched, when, and who gets
  mail.

**Your alerts** — the org's existing overage alerts: watched items,
frequency, mode, recipients, last run and its outcome, Delete (confirmed).
The same rows appear in Export › Scheduled Exports with a summary such as
*"Overage: WEM Add-On, AI Tokens, Admin Tool > 3 — daily, on change"*.

## 3. The schedule record

One row in the existing `schedules` table, `exportType: "billingOverageAlert"`,
`exportLabel: "Billing — Overage Alert"`, `scheduleTime: "00:00"`,
`scheduleType` daily|weekly (+ `scheduleDayOfWeek`), `emailRecipients`,
creator fields as today, and:

```json
"exportConfig": {
  "orgId": "test-ie",
  "orgName": "Test IE",
  "items": [
    { "kind": "licence", "name": "Genesys Cloud WEM Add-On Named User" },
    { "kind": "aiTokens" },
    { "kind": "adminTool", "threshold": 3 }
  ],
  "mode": "always" | "onChange",
  "lastState": { "<item key>": true|false }      // onChange only; written by the handler
}
```

For a customer session the endpoint already forces `orgId` to the verified
org; nothing new there.

## 4. The handler — `api/lib/exports/billingOverageAlert.js`

`execute(context, schedule)`:

1. **Creator re-check**, as the exports do (`verifyCreator`), with one
   addition for a customer creator: they must still be on the org's named-user
   list (`licenseStore.isActive`). A de-licensed person's alerts stop, and the
   run records why.
2. **Read the current period** — `fetchOverviewForCustomer(context, { customerId,
   orgId, billingPeriodIndex: 0 })`, or the synthetic overview when the org is
   simulated (the same branch `billing-overview` takes). `orgId` is resolved
   server-side from the registry / customers.json by slug — never from the
   schedule body.
3. **Admin Tool count** — `peakAssigned(customerId, periodStart, periodEnd)`
   when an `adminTool` item is watched.
4. **Process** with the shared `processBillingOverview(overview,
   { adminToolUsers })` and evaluate each watched item:
   - `licence`: find the regular row by name → over if `onDemand > 0`;
     missing → *not in this period's subscription*;
   - `aiTokens`: over if `summary.aiBillable > 0`; absent if `!hasAi`;
   - `adminTool`: over if `peak > threshold`.
5. **Decide** — `always`: report every item currently over. `onChange`:
   report items over now that were not over at the last run (or have no
   recorded state); then persist the new per-item state to
   `exportConfig.lastState` via `scheduleStore.update`.
6. **Return** — with something to report: `{ success, subject, body }`, no
   attachment. Subject `[<org>] Overage alert — <n> item(s) over`. Body: the
   period dates, one block per reported item (committed, actual, over by;
   for Admin Tool: named users, threshold; for AI Tokens: free, used,
   billable), then the not-in-period items if any, then which mode produced
   this mail. With nothing to report: `{ success: true, skipEmail: true,
   summary: "all clear" }`.

Budget: one overview read, one store read, well inside the 45-second cap.

## 5. Runner changes

- **`skipEmail`** — `runExport` sends mail on every successful result today.
  A result carrying `skipEmail: true` records `lastStatus: "success"` with
  the summary and sends nothing. One condition, before the mail step.
- **Creator licence check** — handled inside this handler (§4.1); the runner
  itself is unchanged for that. If a second customer-facing schedule type
  appears, lift it into `verifyCreator`.

## 6. What this does not do

- No hourly or monthly cadence, and no editable time — midnight, daily or
  weekly, as asked.
- No prices or projected cost.
- No alert on the *previous* period; that is what the exports are for.
- No editing an alert in place — delete and create, as with the exports.
- No alerting for the internal org (Demo): its billing is not a trustor's.
  Internal staff create alerts *about customers*, selected in the header.

## 7. Test pass

Harness, real modules; in-memory schedule and licence tables; the overview
either a fixed fixture or the simulation; every mail captured.

| # | Case | Expected |
| --- | --- | --- |
| 1 | licence watched, `onDemand > 0` | mail: item listed with committed / actual / over by |
| 2 | licence watched, not over | `skipEmail: true`; no mail; status success |
| 3 | licence watched, absent from the period | listed under "not in this period"; no overage claimed |
| 4 | AI Tokens watched, billable > 0 | mail with free / used / billable |
| 5 | Admin Tool threshold 3, peak 4 | mail: "4 named, threshold 3" |
| 6 | Admin Tool threshold 3, peak 3 | no mail (not *more than*) |
| 7 | mode `always`, over on two consecutive runs | mail both times |
| 8 | mode `onChange`, over on two consecutive runs | mail once; `lastState` persisted after each run |
| 9 | mode `onChange`, over → clear → over | mail on the first and the third run |
| 10 | mode `onChange`, first run ever, already over | mail (no prior state counts as "entered") |
| 11 | customer creator removed from the named list | run refused, reason recorded, no read, no mail |
| 12 | simulated org (Test IE) | synthetic overview used, no trustee call; the WEM row reports over |
| 13 | schedule with `?orgId` of another org from a customer session | endpoint forces the verified org (existing behaviour, re-asserted) |
| 14 | `isDue` at `00:00` daily / weekly | fires on the first tick past midnight on the right day, once |
| 15 | runner: `skipEmail` result | no mail, `lastStatus: "success"`, summary recorded |
| 16 | mail body never contains a price or currency amount | true |

**Result 2026-09-11:** all sixteen pass against the real handler, store,
creator check, simulation, workbook processor and the schedules endpoint,
with in-memory tables and every Genesys URL recorded. Cases 8–10 drive the
on-change sequences through persisted `lastState`; case 11 confirms a
de-licensed customer creator is refused before any read; case 13 re-asserts
the endpoint forces a customer's own org and records the *verified* creator
id (a hardening made while building: `createdById` now prefers the id from
the token over the body's). Case 14 runs the runner's real `isDue` — and
corrected my own expectation: a daily schedule that has not yet run today is
due at any time after 00:00, the documented catch-up. Case 15 is a source
check that the `skipEmail` branch sits before the mail step, because
`runExport` is not exported; the branch is four lines. Manual: pending.

The Scheduled Exports page lists an alert by label and org only; the watched
items, mode and recipients are on the Overage Alerts page. Manual, on Test
IE: create a daily alert on the WEM add-on, AI Tokens and
Admin Tool > 1, mode *every run*; run it (the Scheduled Exports page's "run
now", or wait for midnight) → a mail with the WEM row over, AI Tokens
billable, Admin Tool 2 > 1. Switch to *on change* → the next run is silent;
remove a named user and re-add → still silent for Admin Tool (the peak holds)
— which is correct and worth seeing once.
