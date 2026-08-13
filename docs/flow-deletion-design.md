# Flow Deletion — Design

Status: **Live** — deletion verified end-to-end on a real org
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
- **Callflow objects** — data tables, data actions, scripts, survey forms,
  user prompts, dependency flows. Ticked by default when orphaned.
- **Org-level objects** — queues, skills, wrap-up codes, schedules, schedule
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

The split is about the **type of object**, not who created it. An earlier
labelling ("created by onboarding" / "shared org objects") was wrong in exactly
the orgs this tool is for: most flows and their data tables are built by hand,
so the label asserted a provenance it had no way to know. A data table serves
flows however it was made; a queue does not.

**Tier A — callflow objects (default: ticked when orphaned)**

data tables · data actions · scripts · survey forms · user prompts ·
dependency flows (common modules, in-queue, transfer/bot/post-interaction targets)

**Tier B — org-level objects (default: unticked)**

queues · skills · wrap-up codes · schedules · schedule groups · emergency groups ·
flow milestones · flow outcomes · anything else the flow authors a reference to

The set in tier A happens to match what Deployment › Onboarding creates — that
is where the rule came from — but the rule stands on its own without it.

### 6.1 Provenance

Every row reports **who made the object**, which is the information the old tier
label was gesturing at without being able to know it. A data table a person built
last month is a different deletion risk from one a deploy tool produced.

Read from the object's own detail payload — `createdBy` and friends, falling back
to `modifiedBy` — and resolved by id: user first, then OAuth client. Three honest
states, and no fourth:

| State | Shown as |
|---|---|
| A person | *Created by **Name** on <date>.* |
| An API client | *Created via API — OAuth client **Name**.* |
| Nothing recorded | *Creator not recorded for this object type.* |

Two deliberate refusals to guess:

- **"Created" and "last modified" are kept distinct.** Several types expose only
  the latter, and on a flow `createdBy` often reflects whoever last saved a
  version rather than the original author. Presenting that as authorship would
  be a guess dressed as a fact.
- **An id resolving to neither a user nor a client is reported as exactly that** —
  a deleted user *or* an unreadable client — rather than assumed to be one.

**Confirmed against a live org (2026-08-13)** — which types answer, and how:

| Type | Field | Result |
|---|---|---|
| All flow types | `publishedVersion.createdBy` | ✅ a real name |
| Flows (fallback) | `currentOperation.user` / `.client` | ✅ last change, and the clearest signal an *integration* did it |
| `DATATABLE` | — | ❌ payload is `{id,name,division,description,selfUri}` |
| `DATAACTION` | — | ❌ payload is `{id,name,integrationId,category,contract,version,secure,selfUri}` |
| `USERPROMPT` | — | ❌ payload is `{id,name,description,resources,selfUri}` |

Those three carry **no provenance field at any depth**. This is not a gap in the
lookup — it is what the endpoints return. The object API cannot answer it, so the
row says the API returns no creator rather than implying nobody knows.

The **Audit API** is the only remaining route for them. It was left out of the
analysis deliberately: `/api/v2/audits/query` is an async job per query, far too
slow to run for 20+ objects and silently empty beyond its retention window. The
right shape if the blanks matter is an **on-demand per-row lookup** — the
operator asks about one object, one query runs — trying the synchronous
`audits/query/realtime` first and falling back to the async job.

The Findings panel reports the field each type carried *and dumps the actual
payload field names*, so the blanks are an evidenced map rather than a mystery.
That dump is what proved these three are genuinely empty, after a first
implementation wrongly reported every type as having nothing.

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

**Confirmed on a live org (2026-08-13), and the two probes behave differently:**

- **Queue assignments ARE indexed by Dependency Tracking.** Setting a queue's
  in-queue flow made the queue appear as a consuming resource *and* as a probe
  hit — the same fact twice, under two labels. Probe hits are therefore
  de-duplicated against the index by the attaching object's real id. The probe
  stays as a second source, but it is belt-and-braces here.
- **Web/messaging deployments are NOT indexed.** This probe is the only thing
  standing between a deployed flow and a report saying it is free to delete.

**This list is not proven complete.** Outbound campaigns, email routes, SMS/
Open Messaging integrations and Bring-Your-Own-Channel routing may attach flows
too. A probe that fails to run is reported prominently — a blocker list that is
not exhaustive must say so rather than present a flow as free.

**Resolved in Phase 2:** a failed probe **stops the run before anything is
written** — "could not check whether this flow is attached" is treated as "do not
delete". A **404 is not a failure**: it means the org does not have that feature,
so there is nothing to check. The probes are re-run immediately before deletion
begins, so a flow attached since the review aborts the run rather than being
removed from under whatever now uses it.

## 8. Execution

Order is the reverse of onboarding's creation order — Genesys refuses to delete
anything still referenced:

1. **Flows** — root first, then dependency flows in reverse topological order
2. **Prompts**
3. **Survey forms**
4. **Scripts**
5. **Data actions**
6. **Data tables**
7. **Org-level objects** — schedule groups before schedules, then the rest

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

| Type | Endpoint | Status |
|---|---|---|
| Flow (all types) | `DELETE /api/v2/flows/{flowId}` | ✅ verified — no unpublish or deactivate step needed |
| Data table | `DELETE /api/v2/flows/datatables/{datatableId}` | ✅ verified, including a table with rows |
| Data action | `DELETE /api/v2/integrations/actions/{actionId}` | ✅ verified |
| User prompt | `DELETE /api/v2/architect/prompts/{promptId}?allResources=true` | ✅ verified. `allResources` is **required** — without it: *"Cannot delete prompt … since it contains prompt resources."* Those are the prompt's own per-language resources, not another object depending on it, so it is not the kind of force flag this tool refuses |
| Script | `DELETE /api/v2/scripts/{scriptId}` | ✅ verified |
| Survey form | `DELETE /api/v2/quality/forms/surveys/{formId}` | ⚠️ **fails when the form is published** — see below |
| NLU domain | `DELETE /api/v2/languageunderstanding/domains/{id}` | ✅ verified (usually already gone with its parent flow) |

**Published survey forms cannot be deleted.** Genesys returns *"The survey with
name &lt;guid&gt; cannot be deleted because it has been already published"* — with
the form's id where its name should be. The row reports the constraint in
readable terms instead and leaves the form in place; an unpublished form deletes
normally, so the attempt is still made. No unpublish-then-delete workaround is
attempted, because none is confirmed to exist.

Verified end-to-end on a live org (2026-08-13), twice:

1. A hand-built callflow with a common module, data table (1 row), data action
   and user prompt — deleted cleanly, consumer-first: flow → module → prompt →
   table.
2. **The round trip (§13 item 6)**: an onboarding-deployed `Test Deployment - `
   set — 21 objects across flows, in-queue and voice-survey flows, common
   module, 3 scripts, 5 data tables, 8 data actions, a survey form and an NLU
   domain. **20 of 21 removed**; the survey form was the only object left, for
   the published-form reason above.

That run also confirmed three design decisions with real data:

- **A 404 counts as success.** The NLU domain reported *already removed* — it had
  gone with its parent survey flow, exactly the owned-artifact case predicted.
- **`createdByClient` resolves an OAuth client**, so objects deployed by an
  integration read as *"Created via API — OAuth client …"* rather than blank.
- **An old build date is not staleness.** That org's index was last fully rebuilt
  in **June 2023**, still `OPERATIONAL`, and every answer was correct. Treating
  the date as a staleness signal would have locked the org out of the feature
  entirely.
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

## 10.0 CONFIRMED — consumer answers ARE version-scoped

**Proven by a real deletion (2026-08-13).** A common module called by a flow
reported **zero consumers**:

```
Test - Delete [COMMONMODULEFLOW] @ 3.0 → 0
```

The module's current published version was 3.0; the flow referenced an earlier
one. `consumingresources` answers only for the version asked about, so the module
looked unconstrained. With no edge to order against, the tie-break put it ahead
of the flow that called it, Genesys refused the delete, and the data table failed
behind it for the same reason.

Nothing was wrongly deleted — Genesys refused, fail-forward reported it — but the
same asymmetry could have gone the other way: an object that *is* still used
reading as orphaned, and being deleted.

Two fixes:

1. **Consumers are unioned across every known version** — the versions recorded
   by the references that led to the object (a caller binds to a specific
   version), plus its own published, checked-in and saved versions. More
   consumers is the conservative direction; missing one is the direction that
   deletes something in use.
2. **The chosen callflow is always deleted first** among equally-ready objects.
   When an edge is missing from the index the tie-break is all that decides the
   order, and the root can never be the wrong thing to remove first.

Note this is a *different* mechanism from §10.1, which was investigated and
correctly dismissed — there the two runs differed because the org had changed and
because two display branches showed different subsets. Version scoping is real;
the earlier evidence for it simply was not.

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

**Who gets it:** **Master Admin and superusers only.**

- `GROUP_ACCESS` grants `flows.delete` to *Genesys App - Master Admin* by name.
  The ordinary *Admin* group does not get it.
- **The `flows.*` wildcard had to be broken** to make that possible. It used to
  grant `"flows.*"` to both admin groups, which would have handed out
  `flows.delete` the moment the key existed — a wildcard grants keys that do not
  exist yet. The Flows leaves are enumerated instead, exactly as Deployment
  already does for `deployment.onboarding`.
- **Customers can never reach it.** `flows.delete` is listed in
  `CUSTOMER_EXCLUDED_KEYS` ([accessService.js](../js/services/accessService.js)).
  This is load-bearing rather than belt-and-braces: Flows is a
  *customer-suitable* module, so a `flows.*` entitlement would otherwise grant
  permanent, unrollback-able deletion to a self-service tenant.
- Superusers bypass the map entirely.

Because the key is in `featurePermissionMap`, a Master Admin who lacks the
underlying Genesys delete permissions in the company org sees the page **listed
but disabled**, with the missing permission named — the standard two-factor
model for internal write features.

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
2. **Which consumer types actually surface** — **ANSWERED for the common cases,
   and the answer changed the design.** `IVRCONFIGURATION` surfaces and blocked a
   real flow. `QUEUE` surfaces, both as a flow's dependency and as a consumer
   when a queue's in-queue flow points at it. A **web/messaging deployment does
   not** — a flow attached to one reported zero consumers and read as deletable.
   Dependency Tracking is not a complete blocker source; attachments are probed
   directly (§7.1). Still unconfirmed: outbound campaigns, email routes,
   SMS/Open Messaging integrations, BYOC routing.
3. ~~**Build status semantics**~~ — **ANSWERED 2026-08-13**, see §4.1. Ready
   state is `OPERATIONAL`; `dateCompleted` tracks full rebuilds only and is
   expected to be old; `failedObjects` is now used to force affected objects to
   UNKNOWN.
4. **Which types have a DELETE endpoint** (§8.1) — **ANSWERED for the common
   path**: flows, data tables, data actions and user prompts all verified.
   Scripts, survey forms and the org-level types remain untested; they will
   surface the first time a tree contains one.
5. **Permission strings** for §12 — still unconfirmed. The entries are plausible
   rather than verified; the real enforcement is Genesys refusing the DELETE,
   which is reported per object.
6. **A real end-to-end run** — **DONE.** Both a hand-built tree and a full
   onboarding-deployed set (21 objects) were removed; 20 of 21 in the round
   trip, the exception being a published survey form (§8.1). The acceptance
   test the feature exists to pass, passes.

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
- **Phase 2 — execution. BUILT.** Confirm dialog (typed flow name), ordered
  deletion with execute-time re-verification, per-object results, Activity Log
  entry, and the `featurePermissionMap` entry (§12). Decisions taken while
  building, both recorded here because they are safety choices rather than
  implementation detail:
  - **A failed attachment probe stops the run before anything is written**, but
    a **404 does not** — that means the org lacks the feature entirely, and
    conflating "not applicable" with "could not check" would leave an org
    without web messaging permanently unable to delete anything.
  - **A 404 on delete counts as success** ("already removed"). Owned artifacts
    such as an NLU domain can disappear with their parent flow, so this is an
    expected outcome rather than a failure.
  - **Deletion order comes from the consumer graph**, not a fixed type sequence
    (§8), with the type order kept only as a tie-break. The graph is the actual
    constraint; the type sequence was only ever an approximation of it.
  - **The confirmation requires typing the flow name.** This is the one action in
    the app that cannot be undone.
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
