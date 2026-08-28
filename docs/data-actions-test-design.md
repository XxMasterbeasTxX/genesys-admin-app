# Data Actions — Test (new page) — Design

Status: **Implemented** — shipped in 4.8, not yet run against a live org
Author: Genesys Admin App
Last updated: 2026-08-28

## 1. Purpose

A **Data Actions › Test** page whose only job is running data actions and
showing what came back.

The Edit page can already do this, so the page exists for a reason that has
nothing to do with layout: **`data-actions.edit` bundles write access with
execute access**, and there is currently no way to let someone test an action
without also letting them rewrite and publish it.

```js
"data-actions.edit": { edit: ["integrations:action:edit"],
                       execute: ["integrations:action:execute"] }
```

`accessState()` grants the page if the user holds **either** permission, so an
execute-only user gets the whole editor and is stopped only by the in-page
`can()` checks. A separate key mapping execute alone makes "may test, may not
change" expressible at the nav level, which is where it belongs.

The second reason is capability: a dedicated page has room to run **Published
and Draft together**, which is usually why anyone tests a draft at all.

## 2. Access

| | |
|---|---|
| Route | `/dataactions/test` |
| Access key | `data-actions.test` |
| Permission map | `{ execute: ["integrations:action:execute"] }` |
| Nav | Data Actions › Test, after Edit |

Not added to `CUSTOMER_EXCLUDED_KEYS` — it is single-org and carries no
cross-org reach, so it follows `data-actions.*` like Edit does. Note this means
a customer entitlement of `data-actions.*` grants it; see §7.

## 3. Layout

Inputs and results side by side, because a test is a request/response loop and
the point of a dedicated page is seeing both without scrolling.

```
┌───────────────────────────────────────────────────────────────┐
│  [ searchable action dropdown        ▾ ]      [ Refresh ]     │
│  [ category ▾ ] [ integration ▾ ] [ status ▾ ]                │
├───────────────────────────────────────────────────────────────┤
│  ⬤ Published + Draft   v3 · Genesys Cloud Public API          │
│  ▸ Contract                                    (read-only)    │
├──────────────────────┬────────────────────────────────────────┤
│  INPUTS       1fr    │  RESULTS                    1.6fr      │
│                      │                                        │
│  conversationId [ ]  │  ✓ Published — succeeded               │
│  communicationId[ ]  │    url   string   https://…            │
│                      │                                        │
│  [ Run Test ]        │  ✗ Draft — failed: 404 Not Found       │
│                      │    url   string   —                    │
└──────────────────────┴────────────────────────────────────────┘
  ▸ Steps · Published        ▸ Steps · Draft        (full width)
  ▸ Raw response · Published ▸ Raw response · Draft
```

**Asymmetric, not 50/50.** Inputs are short text fields; outputs are not.
`TDCE - Get Transcript URL` returns a signed URL that overflowed a *full-width*
card — half width would be worse.

**Steps and Raw response stay full width**, below the split. Steps is a
four-column table and Raw is pretty-printed JSON; either at half width
reproduces the overflow that was just fixed on the Edit page.

**One column below ~900px.** Inputs first, then results.

The known-awkward case is an action like `Demo - Bot - Voice - Update Row -
Callback Data Table` with ~25 inputs: the left column gets tall and the right
sits mostly empty. That is still better than the Edit page today, where the
result is 25 fields further down the page.

## 4. Running both targets

A **segmented control — Published · Draft · Both** — defaulting to **Both** when
the action has a draft, and to whichever exists when it has only one. Options
that do not apply are disabled, not hidden, so it is clear why.

Results render as one block per target, stacked in the right column, each with
its own outcome banner and Outputs table. Steps and Raw response get one
collapsible per target, labelled.

**Running Both executes the action twice.** For a GET that is free; for a POST,
PUT or DELETE action it means the side effect happens **twice** — two rows
created, two records deleted. This is why Both is a visible choice rather than
silent behaviour, and why §7 carries a standing warning.

**The request that was sent is shown**, under the outcome, taken from the step
in which Genesys resolves the URL template. Without it an empty result is
indistinguishable between "there is no such data" and "you asked for page 10 of
100" — a distinction that cost three false bug reports during 4.6 testing, every
one of them a mistyped page number. Both pages show it.

**Differences are marked.** When both targets ran, an output whose value differs
between Published and Draft is flagged in the Draft table. Comparing the two is
the reason for running both, and asking someone to eyeball two tables for a
changed field wastes what the page just computed.

## 5. Shared module

Seven functions in [edit.js](../js/pages/dataactions/edit.js) do this work today:
`extractSchemaProps`, `buildTestInputFields`, `collectTestInputs`,
`clearTestResults`, `formatValue`, `outputRows`, `renderTestResult`. They move to
**`js/lib/dataActionTest.js`** and both pages import them.

`extractSchemaProps` is **already duplicated** in
[copyBetweenOrgs.js](../js/pages/dataactions/copyBetweenOrgs.js); that copy goes
too, leaving one definition for three callers.

This is not tidiness. The template-inlining logic once lived only in
`copyBetweenOrgs.js` while the Edit page and the Onboarding runner silently
corrupted templates for months — the same shape of duplication, and it cost a
release to find. The rule this time: **the Test page adds no copy of anything.**

The module stays DOM-free where it can — functions that take data and return
HTML strings, plus two that read a container element. Output values continue to
be escaped: a result is third-party response data going into `innerHTML`.

## 6. Deliberately not on this page

- **No Save, Validate or Publish.** The page must be safe to hand to someone
  with execute rights only; a write control that 403s is worse than no control.
- **No editable fields.** Name, category and config are shown read-only, so the
  tester can see what they are testing without being able to change it.
- **No contract editing**, even for draft-only actions.
- **No contract section at all.** The input fields and the Outputs table already
  name every field with its type, so it would only repeat itself. Edit is where
  the contract is worth reading.
- **No org picker** — the header one, as everywhere else.

## 7. Risks

**Testing executes the action for real.** A `POST` action creates a record; a
`DELETE` action deletes one. Genesys's own Test tab behaves the same way, but
this page will be given to people who cannot otherwise write anything, so it
states it: a standing note by Run Test naming the HTTP method, and the Both
warning from §4.

**A customer entitlement of `data-actions.*` grants this page**, and with it the
ability to execute any action in their own org. That is arguably correct — they
own the org — but it is a wider grant than it looks, since a data action can
call any Genesys API the integration is credentialed for.

**Extraction touches a page that was just verified.** The seven functions moving
out of `edit.js` are covered by sections D and H of the 4.6 test pass. They move
unchanged — no behaviour edits in the same commit — and D1, D2, D3 and H4 get
re-run against the Edit page afterwards to prove the move was inert.

## 8. Activity Log

**Tests are not logged, on either page.** Decided 2026-08-28.

Testing is iterative by nature: the same action is run repeatedly while inputs
are adjusted, and on this page that is the entire purpose rather than an
incident within an edit session. A log filled with those entries is a log nobody
reads, which costs more than the entries are worth. The Activity Log stays a
record of **changes to configuration** — saves, publishes, copies, deploys.

> The consequence, recorded so it is a known trade rather than an oversight: a
> test **executes** the action, so a POST creates a record and a DELETE deletes
> one, and none of that is captured. It matters most for the execute-only user
> this page exists to serve — they can cause writes and leave no trace, having
> no other logged activity to sit alongside. Accepted on the basis that the
> grant goes to trusted operators. **Revisit if an execute-only grant is ever
> made to someone outside the team**, or if a customer entitlement grants
> `data-actions.*` (§7).
