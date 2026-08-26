# Data Actions — Edit UI Rework — Design

Status: **Live** — shipped in 4.6. Layout reviewed on dev; the save path has
**not** been re-exercised since the rework (see §6).
Author: Genesys Admin App
Last updated: 2026-08-26

## 1. Purpose

Rework the layout of **Data Actions › Edit** ([js/pages/dataactions/edit.js](../js/pages/dataactions/edit.js)).
The page's behaviour is correct as of 4.5 and verified against live orgs; what
follows changes **how it is presented**, not what it writes.

Two reference points shape the design. The first is the rest of this app: the
page predates the global org picker and the searchable dropdown component, and
is now an outlier against its own siblings. The second is the **Genesys Cloud
action editor**, which our users have open in another tab. Where Genesys has
already made a structural choice — Contracts before Configuration, Test as a
peer, actions in a persistent bar — matching it costs nothing and saves
re-learning.

## 2. What is wrong today

| # | Problem | Evidence |
|---|---|---|
| 1 | Page renders its own org dropdown | Global picker exists ([index.html:32](../index.html), [app.js:274](../js/app.js)); 18 pages read `orgContext.get()`. The 12 that don't nearly all need **two** orgs — this one needs one. |
| 2 | Action picker is a `<select size="8">` with a separate filter row | `createSingleSelect` ([multiSelect.js:255](../js/components/multiSelect.js)) has inline search and is used by 12 pages, including `dataactions/copyBetweenOrgs.js` in the same folder. |
| 3 | Contract is always-open and last; Request/Response are collapsed and first | [edit.js:654](../js/pages/dataactions/edit.js). The least editable thing is the most prominent, and the order is the reverse of Genesys's own `Contracts → Configuration → Test`. |
| 4 | Test is a `<details>` at the very bottom | Genesys makes Test a peer of Contracts and Configuration. |
| 5 | Save / Validate / Publish sit mid-page | Expand a long request template and the three controls that matter scroll away. |
| 6 | Unsaved changes are invisible until Publish | `isDirty` exists (4.5) but drives only the publish prompt. |
| 7 | Test result is a raw `TestExecutionResult` dump | We hold `contract.output.successSchema` and don't use it. |
| 8 | `timeoutSeconds` is preserved but never shown | Genesys exposes it as **Execution Timeout**, 1–60s. Setting one currently requires leaving the app. |
| 9 | Info panel is five label:value rows | Status drives which controls work; it deserves to read at a glance. |
| 10 | 28 inline `style=` attributes | Against 20 in `datatables/edit.js`, 8 in `interactions/move.js` — and an `.ed-*` block already exists in [styles.css](../css/styles.css). |
| 11 | **Category is offered as editable and sent on every save** | [edit.js:776](../js/pages/dataactions/edit.js) puts `category` in the patch body. Genesys's own Summary screen exposes only **Action Name** — category and integration are fixed at creation. |

## 3. Layout

```
┌─────────────────────────────────────────────────────────────┐
│  [ searchable action dropdown            ▾ ]   [ Refresh ]  │  ← 1, 2
│  [ category ▾ ] [ integration ▾ ] [ status ▾ ]              │  ← filters, secondary
├─────────────────────────────────────────────────────────────┤
│  [ Save Draft ] [ Validate ] [ Publish ]    ● unsaved       │  ← 5, 6
│  status line / progress                                     │
├─────────────────────────────────────────────────────────────┤
│  ⬤ Published + Draft   v3 · PureCloud Data Actions · open   │  ← 9
│  Name [_______________]     Category: Genesys Cloud Public  │  ← 11, read-only
│                                                             │
│  ▸ Contract                                                 │  ← 3
│  ▸ Configuration                                            │
│  ▸ Test                                                     │  ← 4
└─────────────────────────────────────────────────────────────┘
```

The action bar sits **below the picker and above the identity box**, per the
agreed placement. It is near the top and so needs no sticky positioning — the
picker is the first thing on the page, and the buttons ride directly under it.
The status line moves up to join them, so a message appears next to the control
that produced it rather than a screen away.

The three sections are an **accordion, all collapsed on load**. Tabs were
considered and rejected: a tab bar always has one panel open, and the page
should open showing its structure rather than pre-committing to a section. This
also keeps **Test one click from the top** — the problem that started this —
instead of below everything else.

Sections are **not mutually exclusive**: opening Configuration does not close
Test. Forcing exclusivity would be surprising when comparing a response mapping
against a test result, and the scrolling that results is then the reader's own
choice rather than the layout's.

## 4. Changes in detail

### 4.1 Org selection — remove the page dropdown

Read `orgContext.get()`. Drop `#edOrg` and `orgContext.getCustomers()`.

`orgContext.onChange(() => router.render())` ([app.js:379](../js/app.js)) already
re-renders the whole page on an org change, so there is no subscription to
write. It also means **in-flight edits are discarded when the org changes** —
the same behaviour as every other page, and acceptable.

With no org selected, the page shows an empty state naming the header picker
rather than a dead dropdown.

### 4.2 Action picker — `createSingleSelect`

Replaces the listbox *and* the free-text name filter, which the component
provides inline.

The **category / integration / status** filters survive as a compact row that
appears only once actions are loaded. Text search alone is not enough at 100+
actions per org, and status in particular is a different axis from name.
Filtering narrows what `setItems` is given, so the two compose.

### 4.3 Load → Refresh

The button stays, relabelled **Refresh**, moved beside the picker.

`datatables/edit.js` auto-loads ([line 1472](../js/pages/datatables/edit.js)) and
that is the house pattern, but it fetches **one** list. This page fetches
**three** — published actions, drafts, and integrations, each paginated — so
auto-loading on every navigation is materially more expensive. The page loads
once on arrival when an org is already selected; Refresh re-fetches on demand.

### 4.4 Sections — Contract · Configuration · Test

Three peer sections, ordered as Genesys orders them, **all collapsed on load**.
Built on `<details>`, which the page already uses — the change is that Contract
joins them and nothing starts open.

- **Contract** — the input/output tables that are the contract preview today,
  presented as Genesys presents them (*Available Inputs* / *Available Outputs*
  with field name and type). Read-only for published actions; see §4.7.
- **Configuration** — Request and Response, both expanded within the section,
  with no second level of `<details>`; the section header is the only
  disclosure. Gains **Execution Timeout** (§4.6).
- **Test** — §4.5.

**Nothing is open by default.** Genesys opens on Summary — a landing view, not a
working one — and the equivalent here is the identity line plus three closed
headers. The alternative considered was defaulting Configuration open, on the
grounds that it is where the work happens; rejected because it reintroduces the
scroll depth that made Test hard to reach, and because a page that opens showing
its whole structure is easier to orient in than one that opens mid-task.

### 4.5 Test results — read the contract

Today: `$testResult.textContent = JSON.stringify(result, null, 2)`.

`TestExecutionResult` carries `success`, `finalResult`, `error`, and
`operations[]` (each with `step`, `name`, `success`, `result`, `error`). Rendered
as:

1. **Outcome** — succeeded / failed, with the failure reason. Already correct as
   of 4.5; it moves into the panel rather than only the status line.
2. **Outputs** — one row per `contract.output.successSchema` property: field,
   type, and the value from `finalResult`. This is the part anyone actually
   wants, and it is the same derivation as the Contract tab.
3. **Steps** — `operations[]`, collapsed. The reason a failing test is currently
   hard to read: the failing stage is buried in the dump.
4. **Raw response** — collapsed, kept for when the mapping itself is suspect.

### 4.6 Execution Timeout

New field in Configuration → Request, bounded 1–60 with Genesys's own wording.

4.5 already preserves `config.timeoutSeconds` across a save; this makes it
editable rather than merely undamaged. An empty box means "not set" and omits
the key, which is distinct from `0`.

### 4.7 Contract stays read-only on published actions — and says so

Genesys does not allow contract changes on a published action even after
toggling to draft; configuration becomes editable, contracts do not. We match
that.

The change is that the page **states it**. Today a published action shows a
read-only table with no explanation, which reads as a missing feature. It will
carry a short note: the contract is fixed once published because flows
referencing the action depend on it, and a new action is the way to change it.

Draft-only actions keep their editable schema JSON, unchanged.

> `UpdateDraftInput` does include `contract`, so the API permits this and we are
> choosing not to. Recorded so the constraint is not mistaken for an oversight.

### 4.8 Category becomes read-only

Genesys fixes an action's **category** and its **integration** at creation; its
Summary screen exposes only Action Name. Our page offers an editable Category
input and puts it in every patch body ([edit.js:776](../js/pages/dataactions/edit.js)),
which either does nothing or does something the vendor's own UI forbids.

Category moves to the identity line as a read-only value. **Name stays
editable** — Genesys allows that.

> Two open points, both cheap to settle and worth settling before shipping:
> `UpdateDraftInput` does accept `category`, so it is unclear whether Genesys
> honours it, ignores it, or rejects it. And since the field has been editable
> and transmitted, an action's category may already have been changed through
> this page. **Check one action's category against Architect before removing the
> field**, so we know whether anything needs putting back.

### 4.9 Identity line

The five-row info panel collapses to a **status badge** plus one line: version,
integration name, and secure/not. Integration *type* moves to a tooltip — it is
diagnostic, not something read every visit.

### 4.10 Unsaved-changes indicator

`isDirty` (4.5) gains a visible marker in the action bar. Set on edit, cleared
on load and on successful save — the wiring already exists.

### 4.11 Inline styles

Fold into `.ed-*` while the markup is being rewritten. Most of the 28 are
`max-width:550px`, `max-width:700px` and `margin-top:*`; three or four utility
classes absorb nearly all of them. Not worth a standalone commit; wasteful to
skip while rewriting anyway.

## 5. Explicitly not in scope

- **Deleting a data action.** Genesys offers it and `DELETE
  /integrations/actions/{id}` exists, but deletion needs its own consumer
  checks — a separate feature, not a layout change.
- **Genesys's Simple | JSON toggle** for the response config. Our JSON textareas
  stay as they are.
- **Credential Types.** Read-only, rarely consulted; can join the identity line
  later if it proves useful.
- **Any change to what is written to Genesys.** The 4.5 save/publish/copy
  behaviour is verified and must come through untouched.

## 6. Risks

**The 4.5 test pass is partly invalidated.** Every test that names a control —
most of sections A through D — is written against the current layout. The
*behaviour* is unchanged, so the assertions hold, but the click paths do not.
The test plan needs updating alongside, and a re-run of at least A1–A3, C4 and
D1 afterwards.

**Regression risk concentrates in the save path.** §4.6 adds a field to the
patch body and §4.2 changes how the selected action is resolved. Those touch the
code that 4.5 exists to make safe. The JSON-validation guards, template
handling and dirty-tracking must be carried over intact, not rewritten.

**Tab state versus selection.** Switching action while on the Test tab should
keep the tab and reload its contents, not silently reset to Configuration.

## 7. Decisions taken during the build

1. **Name placement** — kept on the identity line, always visible, rather than
   moved inside Configuration. Renaming is common enough not to cost a click.
2. **Filter row persistence** — the category / integration / status filters
   **survive a Refresh**. Refresh re-fetches the org's actions; it is not a
   "start again" button, and losing a filter on every refresh would be tiresome
   on an org with 100+ actions.
3. **One column width.** Not foreseen in the design, but it emerged as soon as
   the page was on screen: the picker sized itself to its label
   (`.ms-dropdown` is `inline-block`) and the Name input collapsed to its
   browser default (`.dt-input` sets `max-width` and no `width`), so the layout
   stepped in and out at three different widths. All of it now hangs off a
   single `--ed-col` token (920px) scoped to `.ed-page`, shared by the picker
   row, the identity fields and the three sections.
4. **Disclosure arrows are CSS escapes,** `"\25B8 "` rather than a literal `▸`.
   `styles.css` carries no BOM and no `@charset`, so a literal rendered as
   `â–¸`. `@charset "UTF-8"` is now declared as well. A pre-existing `▶` on
   `.te-sheet-title` had the same fault and was fixed with it.

## 8. Still open

1. **Does Genesys honour a `category` change over the API?** `UpdateDraftInput`
   accepts the field with no `readOnly` marker, but the Genesys UI offers no way
   to set it, so it is unclear whether the service applies it, ignores it, or
   rejects it. We match the vendor either way (§4.8) — this only decides whether
   the old editable field was doing anything.
2. **Has any category already drifted?** The field was editable and transmitted
   on every save up to 4.5. If the answer to (1) is "honoured", one check against
   Architect says whether anything needs putting back.
