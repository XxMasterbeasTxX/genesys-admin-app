# Flow Deletion — Design

Status: **Phase 1 built** (discovery only — nothing is deleted yet)
Author: Genesys Admin App
Last updated: 2026-08-13

## 1. Purpose

Provide a "Flows › Delete Flow" workflow that removes **one callflow and the
objects it depends on** from a customer org, in one reviewed operation — the
inverse of [Deployment › Onboarding](onboarding-deployment-design.md), which
creates exactly this set.

Today an onboarded callflow can only be unpicked by hand: find the flow, find
every common module, in-queue flow, data table, data action, script, survey form
and prompt it pulled in, work out one at a time whether anything *else* still
uses them, and delete in an order Genesys will accept. This design automates the
discovery and the ordering, and makes the decision explicit for every object.

**Deletion is irreversible.** Every rule below exists to make sure nothing is
removed that something else still needs, and that the operator sees the full
picture before anything is written.

## 2. Confirmed decisions

- **One callflow at a time.** Two flows sharing a common module resolve
  naturally: delete the first (the module survives — the second still uses it),
  then the second (the module is now orphaned and offered).
- **Discovery via Architect Dependency Tracking**, not SDK export. It answers
  both questions this feature needs — what a flow uses, and what uses an object —
  over plain REST.
- **Transitive through flows, leaves everywhere else.** `Callflow → Common Module
  → Data Table` finds the data table, because we look inside the common module.
  We never look inside the data table.
- **No scanning of data-table content.** A schedule group named in a table cell
  is not a discovered dependency and does not count as a consumer. See §11.
- **Always report, always review.** There is no unattended path. The operator
  sees every finding, including everything that will be *kept*.
- **A blocked root locks the whole tree** (§7).
- **Consumers are re-verified at execute time** (§8).
- **Every authored dependency is listed**; the object type decides only the
  default tick state (§6). A checkbox is offered **only** when the object is
  orphaned relative to the current selection (§5).
- **SUPERUSER only** (§12).

## 3. User experience

Route: `/flows/delete` (access key `flows.delete`).

**Step 1 — Pick.** Org dropdown, then a searchable callflow combobox (same
pattern as Flow Overview). One flow.

**Step 2 — Analyse.** The page resolves the dependency closure and the consumer
graph (§4), then renders the review. Nothing has been written.

**Step 3 — Review.** A single scrollable report:

- **The callflow** — name, type, division, and its status:
  - *Deletable* — nothing outside the tree holds it.
  - *Blocked* — one or more attachments prevent deletion. Each is listed by type
    and name (call route `+45 …`, IVR configuration `Main`, queue `Support`
    in-queue flow, campaign `…`, checked out by `user@…`). The user clears these
    in Genesys and re-scans; the flow is always deletable once detached.
- **Created by onboarding** — data tables, data actions, scripts, survey forms,
  user prompts, dependency flows. Ticked by default when orphaned.
- **Shared org objects** — queues, skills, wrap-up codes, schedules, schedule
  groups, emergency groups, flow milestones/outcomes, and anything else the flow
  references. Listed, **unticked**, in a visually distinct section.
- Every row shows what it is, and either a checkbox (orphaned) or the reason it
  is locked, naming the objects that still use it. Data table rows carry their
  **row count**; queues carry their **member count** — so the cost of a tick is
  visible before it is made.

**Step 4 — Confirm.** A summary dialog: N objects to delete, M kept, listed by
type. Deletion is irreversible and the dialog says so plainly.

**Step 5 — Execute.** Per-object results stream into a phase list reusing the
onboarding results/stepper components (`ok` / `skipped` / `error` / `none`).
One Activity Log entry is written at the end (§10).

## 4. Architecture

```
Browser (js/pages/flows/deleteFlow.js)
   │  1. GET dependency-tracking build status      (via genesys-proxy)
   │  2. GET consumedresources  (recursive, flows only)   → the closure
   │  3. GET consumingresources (per object in the closure) → the consumer graph
   │  4. review + confirm  (no writes)
   │  5. re-check consumingresources, then DELETE per object, in order
   │  6. POST /api/activity-log
   ▼
genesys-proxy (existing) → Genesys Cloud REST
```

**No background runner, no Table Storage, no job model.** Onboarding needs those
because publishing flows through the Flow Scripting SDK takes minutes and exceeds
the Consumption HTTP cap. Deletion is discovery + `DELETE` calls — seconds — and
runs entirely through the existing proxy while the page is open.

What is reused is the *shape*, not the machinery: the phase/item result model,
the stepper and results list, and the review-then-confirm discipline from
[onboarding-runner/lib/processor.js](../onboarding-runner/lib/processor.js).

### 4.1 Dependency Tracking

Endpoints (**exact response shapes to be confirmed against a live org — see §13**):

| Call | Purpose |
|---|---|
| `GET /api/v2/architect/dependencytracking/build` | Index build status |
| `GET /api/v2/architect/dependencytracking/consumedresources` | What this object uses → the closure |
| `GET /api/v2/architect/dependencytracking/consumingresources` | What uses this object → the orphan test |

The index is built **asynchronously**. A stale or in-progress build produces
wrong answers, and wrong answers here delete things. The page therefore checks
build status first and **refuses to proceed** unless the index is usable, rather
than silently trusting it.

**Confirmed against a live org (2026-08-13)** — §13 item 3 is answered:

```json
{ "user": {…}, "buildId": "…", "dateStarted": "2026-08-02T09:17:55.731Z",
  "dateCompleted": "2026-08-02T09:18:23.440Z", "status": "OPERATIONAL",
  "failedObjects": [], "selfUri": "…" }
```

Three things follow, all of them corrections to the original guesswork:

- **`OPERATIONAL` is the ready state.** The first implementation tested the
  status against a fuzzy "looks finished" pattern and rejected `OPERATIONAL`,
  blocking a perfectly healthy org. The check is now an explicit allowlist, with
  known not-ready states (`BUILDING`, `NOTBUILT`, `FAILED`, `UNKNOWN`) named in
  the message and any *unrecognised* value still refused — the safe direction,
  but now clearly labelled as unrecognised rather than as staleness.
- **`dateCompleted` is the last FULL rebuild and is routinely weeks old.**
  Publishing updates the index incrementally, so an old date is *not* a
  staleness signal and must never be treated as one. It is shown in the report
  for the operator to judge.
- **`failedObjects` is a safety input, not decoration.** An object the index
  could not process has incomplete dependency data by the index's own admission
  — exactly the false-orphan case. Any such object appearing in the closure is
  forced to UNKNOWN and cannot be selected.

### 4.2 Building the two graphs

```
closure   = {root} ∪ transitive consumedresources, recursing ONLY into flow types
consumers = { object → consumingresources(object) } for every object in closure
```

Both are fetched once, during Analyse. Everything the review does afterwards is
computed from them — no further calls until execute.

Recursion is cycle-safe (flows can reference each other in loops); reuse the
`topoSort` approach from [processor.js:121](../onboarding-runner/lib/processor.js:121).

## 5. The orphan rule

> An object may be deleted only if nothing outside the deletion set uses it.

The critical word is **outside**. Orphan status is *relative to the current
selection*, not absolute:

```
Callflow A  →  Common Module CM  →  Data Table DT
```

`DT`'s only consumer is `CM`. So `DT` is orphaned **only while `CM` is ticked**.
Untick `CM` and `DT` immediately re-locks — it has a live consumer again. Re-tick
`CM` and `DT` unlocks.

Formally, for each object `o` in the closure:

```
orphaned(o)  ⟺  consumers(o) \ (selection ∪ {root})  =  ∅
```

Recomputed on every checkbox toggle, client-side, from the graph already
fetched. Unticking a flow cascades down its whole subtree.

Locked rows are never silently hidden: they show the surviving consumers by
name, which is the report the operator needs in order to decide whether to go
and detach them.

## 6. Object types

Both tiers are discovered, consumer-checked and listed identically. The tier
decides **only the default tick state**.

**Tier A — created by onboarding (default: ticked when orphaned)**

data tables · data actions · scripts · survey forms · user prompts ·
dependency flows (common modules, in-queue, transfer/bot/post-interaction targets)

**Tier B — shared org objects (default: unticked)**

queues · skills · wrap-up codes · schedules · schedule groups · emergency groups ·
flow milestones · flow outcomes · anything else the flow authors a reference to

Tier B is defaulted off and sectioned separately for two independent reasons:

1. **Blast radius.** A queue is not an onboarding artifact — it has members,
   memberships, routing configuration and history far beyond this callflow.
2. **False-orphan probability is concentrated here.** Queues, skills and schedule
   groups are precisely the types Architect commonly resolves *by name at
   runtime* (`FindQueue()`, `FindSkill()`, `FindScheduleGroup()`) — see §11.
   A tier B object is materially more likely to read as unused while something
   still reaches it.

Tier B rows carry that caveat inline, not only in the page header.

**Types with no DELETE endpoint** are listed and locked with "no delete API for
this type" instead of a checkbox — the requirement to *report* everything is
still met, and the tree never offers an action that would fail on execute. Which
types these are is a §13 validation item; flow outcomes are the likely case.

## 7. Blockers

> **Dependency Tracking is not a complete source of blockers.** Proven on a live
> org (2026-08-13): a messaging flow attached to a **web/messaging deployment**
> returned **zero consuming resources** and read as fully deletable. The index
> knows what references a flow *within Architect*; it does not know where the
> flow is attached to the platform. The same hole made an in-queue flow — almost
> certainly assigned to a queue — read as "nothing else uses this".
>
> Attachments are therefore **probed directly** (§7.1) and merged in as synthetic
> consumers, so the ordinary §5 rule treats them as hard blockers.

A blocker is an attachment that prevents deletion outright, as opposed to a
consumer inside the closure. Known categories:

- **Call route / DID** pointing at the flow
- **IVR configuration** referencing it
- **Queue** using it as an in-queue flow
- **Campaign** referencing it
- **Checked out** in Architect by another user (report who holds the lock)

Blockers are reported with type and name so the operator can act. They are never
cleared automatically — detaching a live call route is a production change and
belongs in Genesys, made deliberately, not as a side effect of a cleanup tool.

**A blocked root locks the entire tree.** If the callflow cannot be deleted, it
still exists and still uses everything below it, so nothing in the closure is
orphaned. Every checkbox is disabled and the review becomes a to-do list. The
operator clears the blockers and re-scans.

Tier B objects have their own type-specific blockers (a queue with members, a
schedule belonging to a group, a script attached to a queue). Same treatment:
report, don't force.

### 7.1 Attachment probes

Run for **every flow in the closure**, not just the root — a dependency flow can
be independently attached, and that must block it alone rather than the tree.

| Probe | Endpoint | Fields |
|---|---|---|
| Web/messaging deployments | `GET /api/v2/webdeployments/deployments` | `flow.id` |
| Queue assignments | `GET /api/v2/routing/queues` | `queueFlow`, `messageInQueueFlow`, `emailInQueueFlow` |
| Call routes | `GET /api/v2/architect/ivrs` | `openHoursFlow`, `closedHoursFlow`, `holidayHoursFlow` |

Each hit becomes a synthetic consumer with a key deliberately outside the
closure, so it is a hard blocker under the existing rule with no change to
[flowDeleteGraph.js](../js/lib/flowDeleteGraph.js).

**This list is not proven complete.** Outbound campaigns, email routes, SMS/
Open Messaging integrations and Bring-Your-Own-Channel routing may attach flows
too. A probe that fails to run is reported prominently — a blocker list that is
not exhaustive must say so rather than present a flow as free.

**Phase 2 open question:** should a *failed* probe block deletion outright? For a
report-only phase a prominent warning is right; once deletion is real, "we could
not check whether this flow is attached" is arguably the same as "do not delete".
Erring toward blocking is consistent with the rest of the safety model, but it
would also mean an org lacking one of these features cannot delete anything if
the endpoint 404s — so the check must distinguish "not applicable" from "failed".

## 8. Execution

Order is the reverse of onboarding's creation order — Genesys refuses to delete
anything still referenced:

1. **Flows** — root first, then dependency flows in reverse topological order
2. **Prompts**
3. **Survey forms**
4. **Scripts**
5. **Data actions**
6. **Data tables**
7. **Shared org objects** — schedule groups before schedules, then the rest

**Re-verify before each delete.** Immediately before deleting object `o`, re-run
`consumingresources(o)` and re-apply the §5 rule against what remains. If `o`
gained a consumer since the review, it is **skipped and reported**, not deleted.
This is the main place this design departs from onboarding, which deploys the
cached snapshot it was approved against. Creating a duplicate is recoverable;
deleting something that just acquired a consumer is not.

**Fail-forward.** A failure on one object does not abort the run; it is recorded
and the sequence continues where safe. Anything whose prerequisite failed is
skipped with the reason. The final report distinguishes deleted / kept / skipped
/ failed.

### 8.1 Delete endpoints

All **to be verified** (§13); `forceDelete`-style parameters are deliberately not
used — a refusal is information the operator should see, not something to
override.

| Type | Endpoint |
|---|---|
| Flow | `DELETE /api/v2/flows/{flowId}` |
| Data table | `DELETE /api/v2/flows/datatables/{datatableId}` |
| Data action | `DELETE /api/v2/integrations/actions/{actionId}` |
| Script | `DELETE /api/v2/scripts/{scriptId}` |
| Survey form | `DELETE /api/v2/quality/forms/surveys/{formId}` |
| User prompt | `DELETE /api/v2/architect/prompts/{promptId}` |
| Queue | `DELETE /api/v2/routing/queues/{queueId}` |
| Schedule | `DELETE /api/v2/architect/schedules/{scheduleId}` |
| Schedule group | `DELETE /api/v2/architect/schedulegroups/{scheduleGroupId}` |
| Emergency group | `DELETE /api/v2/architect/emergencygroups/{emergencyGroupId}` |
| Flow milestone | `DELETE /api/v2/flows/milestones/{milestoneId}` |
| Flow outcome | *believed to have none — verify* |

### 8.2 Querying Dependency Tracking (confirmed 2026-08-13)

- **`version` is required** on both `consumedresources` and `consumingresources`,
  and it is the version *of the object being asked about*. Omitting it returns
  "Query parameter 'version' is missing or empty".
- **`LATEST` is not accepted.** Every attempt returned "Could not find the
  dependency object with specified ID and version".
- **Each flow has its own version.** A real run had the root callflow at `8.0`
  and its common modules at `3.0`. Reusing one version across the closure failed
  on every module and dropped three of them out of the tree — leaving the report
  quietly incomplete. Each flow's version is now read from the flow itself.
- A flow whose dependencies cannot be read is reported **at the top of the
  report**, not only in diagnostics: anything used solely by that flow is missing
  from the list, and an incomplete tree must not look like a clean one.
- **One entry per reference, not per object.** A flow published four times
  appears four times in `consumingresources`. Both lookups now collapse to
  distinct `type::id`, since "which versions reference this" is not a question
  this feature asks — and left raw it inflated every "and N more" tally and made
  one consumer read as four.
- **Consumers appear to be transitive** (to confirm). A data action referenced
  only by a common module also listed the in-queue flow that calls that module.
  If so the orphan test is *more* conservative than strictly required, which is
  the safe direction: the intermediate is itself blocked by the same outside
  consumer, so nothing that should be deletable is wrongly held.

### 8.3 Platform vocabulary is excluded

Dependency Tracking reports everything a flow consumes, including the building
blocks it is written in: `FLOWACTION` (PlayAudioAction, DecisionAction…),
`FLOWDATATYPE` (str, int, que…), `LANGUAGE`, `SYSTEMPROMPT`, `TTSENGINE`,
`TTSVOICE`, `STTENGINE`. A single real callflow pulled in **~59 of these against
20 genuine artifacts**.

They exist in every org, are never created or deleted, and listing them buries
the real findings. They are excluded from the tree entirely and counted in the
Findings panel instead. Onboarding draws the same line from the other side —
`resolveDeps` excludes `SystemPrompt.` references for the same reason.

## 9. Idempotency and re-runs

A partially completed deletion is safe to re-run: objects already gone drop out
of the closure, and the remaining ones are re-analysed from scratch. There is no
cached plan to go stale, because the plan is rebuilt on every Analyse.

## 10. Activity log

One entry per deletion run, written client-side via `logAction()`
([activityLogService.js](../js/services/activityLogService.js)) — the same path
every other Deployment page uses. Onboarding is the exception, not the model: its
job is detached and finishes minutes later in the runner, so only the runner can
log it. Here the page is present for the whole operation.

```
action:      "flow_delete"
orgId:       target org
result:      success | partial | failure
count:       objects deleted
description: [Flow Delete] Deleted callflow 'X' (inboundcall) from <Org> —
             7 objects deleted, 3 kept, 1 failed
errorMessage: inline names of the failures, as onboarding does
details: {
  summary: { flowName, flowType, orgId, orgName, deleted, kept, skipped,
             failed, blocked, startedAt, finishedAt },
  phases:  [ { phase: "Flows", items: [ { old, new, status, detail } ] }, … ],
  warnings: [ … ]
}
```

`details` uses the existing expandable-row shape, so the Activity Log page
renders it with no changes. Kept objects are recorded with `status: "skipped"`
and the reason — *what was deliberately not deleted, and why* is the most
valuable line in the record when someone asks later.

Two wiring changes, both one-liners:
- `ACTION_LABELS` in [activityLog.js:18](../js/pages/admin/activityLog.js:18) →
  `flow_delete: "Flow Delete"`, or the filter shows the raw key.
- The action-constant list in the
  [activityLogService.js](../js/services/activityLogService.js) header comment.

**An abandoned review writes nothing.** Nothing was created server-side and
nothing was deleted, so there is no state to reconcile — unlike onboarding, whose
cancelled previews leave a parked job that must be closed out. If an audit trail
of *considered* deletions is wanted, this is the decision to revisit.

**Known gap:** if the page is closed mid-run the entry is lost. Deletes take
seconds, so the window is small, but it is a real difference from onboarding's
runner-written record.

## 10.1 Investigated and dismissed — "version-scoped consumers"

Two analyses of the same data action appeared to return **disjoint** consumer
sets, which looked like `consumingresources` answering only for the version
asked about. That would have made the orphan test unsound, so it was recorded as
blocking. **It was not an API defect.** Two ordinary causes, compounding:

1. **The org changed between runs.** The `Demo -` flows were deliberately
   re-pointed away from the Template objects, so they genuinely stopped being
   consumers.
2. **The two rows were rendered by different branches.** A "Kept" row listed
   only *hard* blockers — consumers outside the tree — so the in-tree consumers
   were never shown. The blocked-root row listed *all* consumers. The same
   object legitimately produced two different lists.

Kept rows now show both — outside consumers and in-tree ones — because a row
that displays half the picture reads as the whole of it. That asymmetry, not the
API, is what made a deliberate change look like a defect.

**Positively confirmed, not merely explained away.** The version-free endpoint
(`dependencytracking?name=…&consumingResources=true`, which takes no version)
was run against the same data table and returned the *same distinct consumers*
as the version-scoped call. Two independent routes agree, so `consumingresources`
is not under-reporting. The experiment has been removed now that it has answered.

Worth keeping as a caution: **an apparent API anomaly is more likely to be our
own display logic or a real change in the org.** The per-object consumer lookups
remain in the Findings panel — cheap, and they were what made the live graph
reproducible offline when the next question came up.

## 11. Known limitations (accepted)

**Only authored references are visible.** Dependency Tracking indexes what the
flow author wired up. References built at runtime are invisible to it:

- `FindUserPrompt(<variable>)` — prompt name from a variable
- `FindQueue()` / `FindSkill()` / `FindScheduleGroup()` by computed name
- Data-table cells holding queue, flow or prompt names

**Narrowed by observation (2026-08-13):** a queue picked in the Architect
designer *does* appear as a consumed resource (`QUEUE`), so the blind spot is
specifically **runtime name lookups**, not queue references in general. That is a
smaller hole than §11 originally assumed — but it is still a hole, and it is
still concentrated in tier B.

This cuts both ways, and the second way is the one that matters:

- An object the flow uses may never appear in the tree. Harmless — we only delete
  what we can see.
- An object may read as **orphaned while another flow reaches it at runtime**.
  Not harmless.

Scanning data-table content was considered and **rejected**: it would mean
reading every table in the org on every run, and would still miss anything
computed from a variable — a large cost for a guarantee it cannot deliver.

The boundary is therefore stated in the page itself, not buried here:

> Dependencies are read from flow authoring. References built at runtime from
> variables or data-table values are not visible and are not checked.

Onboarding documents the same gap from the other side
([onboarding-deployment-design.md §9](onboarding-deployment-design.md)).

### 11.1 The server-side backstop, and what it does not cover

Genesys refuses to delete objects that its own dependency data shows to be in
use — a queue referenced by another flow, for instance. Combined with
fail-forward (§8), the resulting failure is a *useful* one: the run continues and
the report reads "Queue X could not be deleted: in use by flow Y", which is
exactly the finding the operator needs.

That refusal is a real second line of defence, but it is important to be precise
about **what it defends against**: it is computed from the same Dependency
Tracking index this feature queries. So it catches the cases where our answer was
*stale* — the index moved, or a reference appeared between Analyse and execute —
and it does not catch the cases in §11, where the reference was never indexed at
all. A `FindQueue()` built from a variable is invisible to the server-side check
for the same reason it is invisible to ours.

In short: the backstop covers **staleness**, not **invisibility**. Accepted, on
the basis that an authored reference — the overwhelmingly common case — fails
loudly and safely.

## 12. Access control & wiring

- `navConfig.js` — leaf under **Flows**: `{ label: "Delete Flow", path: "delete",
  access: "flows.delete" }`
- `pageRegistry.js` — `/flows/delete` → `pages/flows/deleteFlow.js`
- `accessConfig.js` — register `flows.delete` in the key documentation block.

**The `flows.*` wildcard must be broken.** `ADMIN_ALL_EXCEPT_ONBOARDING`
currently grants `"flows.*"` ([accessConfig.js:155](../js/accessConfig.js:155)),
so a new `flows.delete` key would be handed to *Master Admin* and *Admin*
automatically. Enumerate the leaves instead — `"flows.flowoverview",
"flows.journey"` — exactly as Deployment already does to keep
`deployment.onboarding` superuser-only. Superusers bypass the map entirely.

`featurePermissionMap.js` — **no entry in Phase 1.** That file gates *write*
actions only; its own rules state that read-only features carry no entry and are
gated by app group alone ([featurePermissionMap.js:10](../js/featurePermissionMap.js:10)).
Phase 1 performs no writes, so an entry would misrepresent it. The entry lands
with the delete path in Phase 2:

```js
"flows.delete": {
  delete: ["architect:flow:delete", "architect:datatable:delete",
           "architect:userPrompt:delete", "integrations:action:delete",
           "scripter:script:delete", "quality:form:delete"],
}
```

Exact permission strings are a §13 validation item. The read permission
Dependency Tracking needs (`architect:dependencyTracking:view` or similar) is not
listed there for the same reason — reads are not gated by this map — but the
operator's own account still needs it, so a missing-permission failure must
produce a clear message rather than an empty dependency list.

## 13. To validate before building

Live-org checks, in order. Each one can change the design.

1. ~~**Dependency Tracking response shapes**~~ — **ANSWERED 2026-08-13.** The
   full `objectType` enum was returned by the API; there is **no generic
   `FLOW`**, scripts are `COMPOSERSCRIPT`, prompts `USERPROMPT`/`SYSTEMPROMPT`,
   workitem flows `WORKITEMFLOW`. `version` is **required** and must be the
   version *of the object being asked about* — `LATEST` is rejected, and each
   flow has its own (a root at 8.0 with common modules at 3.0). See §8.2.
2. **Which consumer types actually surface** — **PARTLY ANSWERED, and the answer
   changed the design.** `IVRCONFIGURATION` does surface and correctly blocked a
   real flow. But a **web/messaging deployment does not** — a flow attached to
   one reported zero consumers and read as deletable. Dependency Tracking is not
   a complete blocker source; attachments are now probed directly (§7.1). Still
   unconfirmed: outbound campaigns, email routes, SMS/Open Messaging
   integrations, BYOC routing.
3. ~~**Build status semantics**~~ — **ANSWERED 2026-08-13**, see §4.1. Ready
   state is `OPERATIONAL`; `dateCompleted` tracks full rebuilds only and is
   expected to be old; `failedObjects` is now used to force affected objects to
   UNKNOWN.
4. **Which types have a DELETE endpoint** (§8.1), flow outcomes especially.
5. **Permission strings** for §12.
6. **A real end-to-end run** against a test org: onboard a flow with Deployment ›
   Onboarding, then delete it with this tool, and confirm the org is back to its
   prior state. This is the acceptance test the feature exists to pass.

## 14. Phased implementation

- **Phase 0 — validation.** §13 items 1–5 against a live org. Folded into Phase 1
  rather than run separately: the page reports what the API actually returned
  (see below), so running it *is* the validation.
- **Phase 1 — discovery, read-only. BUILT.** Page shell, flow picker, the two
  graphs, the full review tree with live orphan recomputation, blockers, and the
  "everything is reported" report. **No delete path at all** — not a disabled
  button, not a guarded branch. Independently useful: it answers "what would
  removing this flow actually touch?"
  - [js/pages/flows/deleteFlow.js](../js/pages/flows/deleteFlow.js) — page
  - [js/lib/flowDeleteGraph.js](../js/lib/flowDeleteGraph.js) — the §5 rules,
    kept pure and DOM-free so they can be read and tested on their own. This is
    the logic that decides what may be deleted; it is the one part where a bug
    removes something still in use, so it does not live inside a render closure.
  - Dependency Tracking helpers in
    [js/services/genesysApi.js](../js/services/genesysApi.js)
  - A **Findings** panel records the object types seen, which `objectType` values
    the API accepted, the raw build status, and every error — answering §13
    items 1–4 from a real org the first time it is run.
- **Phase 2 — execution.** Confirm dialog, ordered deletion with execute-time
  re-verification, per-object results, Activity Log entry, and the
  `featurePermissionMap` entry (§12).
- **Phase 3 — polish.** Re-scan without re-picking, kept/failed reasons surfaced
  more richly, §13 item 6 as a repeatable round-trip test.

Phase 1 has real standalone value and carries no risk of data loss, which makes
it the right place for the design to meet reality.

### 14.1 Behaviour under an unverified API

Every §13 unknown is handled so that a wrong guess is *reported*, never silently
absorbed:

| Unknown | Behaviour |
|---|---|
| `objectType` enum value | Specific type tried first, generic `FLOW` as fallback; both outcomes recorded in Findings |
| An unrecognised type comes back | Classified **tier B** (unticked), labelled with the raw enum value, counted in Findings |
| `consumingresources` fails for an object | Consumers recorded as `null` — **unknown, never empty** — and the object is not selectable |
| `consumedresources` fails on the **root** | Analysis **aborts**. A closure of one would render as "no dependencies found", which reads as a green light rather than a failure |
| Build status unreadable or not current | Analysis refuses to run (§4.1) |

## 15. Risks

- **False orphans** (§11) — the central risk, and **accepted**. Mitigated by tier
  B defaulting to unticked, sectioning, inline caveats, and mandatory review;
  **not eliminated**, and specifically *not* covered by the server-side refusal
  (§11.1), which reads the same index.
- **Stale Dependency Tracking index** — mitigated by refusing to run on a build
  that is not current (§4.1), by execute-time re-verification (§8), and by the
  server-side refusal (§11.1). This one is well covered.
- **Blast radius of tier B** — mitigated by defaults and presentation. A queue
  deletion is a bigger event than everything else this tool does combined.
- **Irreversibility** — no rollback exists. The review, the confirm step, the
  execute-time re-verification and the Activity Log record are the whole of the
  safety model.
- **Unverified API surface** — §13 exists precisely because this design rests on
  an API the repo has never called.
