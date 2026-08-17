# Test Case Generation — Design

Status: **In development**
Author: Genesys Admin App
Last updated: 2026-08-17

## 1. Purpose

Provide a "Deployment › Test › Test Cases" page that turns a live Architect flow
into a **test case document** — a styled Excel workbook a tester can work
through by hand, or import into a test management tool.

Today, testing a deployed callflow means someone opening Architect, reading the
flow, and writing the cases out by hand. That is slow, and it is unreliable in
the way that matters most: the branches a human misses when reading a diagram
are exactly the branches nobody tests. A flow with a dozen decisions, a menu and
three data actions has more distinct outcomes than anyone enumerates reliably on
a Friday afternoon.

This feature enumerates them mechanically. It is the natural companion to
[Deployment › Onboarding](onboarding-deployment-design.md): Onboarding puts a
flow into a customer org, and this produces the document proving it works.

**Nothing is written to Genesys.** This feature only reads flows and produces a
file.

## 2. Confirmed decisions

- **Built on the flow YAML**, via [`js/lib/flowSource.js`](../js/lib/flowSource.js)
  → `parseFlowYaml`. The flat REST `latestconfiguration` omits the implicit
  *Default* continuation links, so a path cannot be traced through it. This is
  the same reason Flow Overview uses YAML (§2 of that page's header).
- **A test case is a path** from the flow's start to a terminal action. The
  parser already labels every branch — Yes/No, `Case N` with its condition,
  DTMF digit plus choice name, one edge per intent, Success/Failure,
  Found/Not Found — so the branch labels *are* the test conditions.
- **Three coverage modes** (§5). Branch coverage is the default.
- **The whole transitive closure, one case set per flow** (§6). Cases are
  generated for the root flow *and* for every dependency flow, each in its own
  right. Paths are **not** inlined across flow boundaries.
- **Conditions are stated, not solved** (§7). The document says which condition
  must hold; it does not invent variable values.
- **Deterministic.** No AI in the generation path. The same flow produces the
  same document, which is what makes it usable as an audit artefact.
- **Internal only** (§10).

## 3. User experience

Route: `/deployment/test/test-cases` (access key `deployment.test.testCases`).

**Step 1 — Pick.** Org selector (header), then a searchable flow combobox with a
flow-type filter — the same `flowSource` pattern as Flow Overview and Delete
Flow.

**Step 2 — Generate.** Choose a coverage mode. The page loads the picked flow,
discovers its dependency flows, and keeps loading until the closure is complete
(each load discovers its own dependencies, so common module → common module
chains are pulled in). Every flow in the closure is walked.

**Step 3 — Review.** A table of generated cases per flow, with counts, the
coverage figure, and any findings (unreachable branches, truncation, flows that
could not be exported).

**Step 4 — Export.** A styled `.xlsx`, named `<Customer>_<flow>-test-cases.xlsx`
following the `orgPrefix()` convention of the dependency export.

## 4. The walk

`js/lib/flowTestCases.js` is pure — no DOM, no network — mirroring
`flowModel.js` / `flowYaml.js`, so it can be tested against a saved parse.

The parsed graph mixes two kinds of node: **containers** (tasks, menus, states,
bots — keyed by `refId`) and **actions** (keyed `<taskId>#<n>`). Edges carry
`kind: "flow"` or `kind: "jump"`. Four things about that shape drive the walker:

### 4.1 Jump edges address containers

A `jump` edge's target is a container `refId`, not an action. Execution
continues at that container's **first** action, which the parser records as
`tasks[].entryId`. The walker hops container → `entryId`. Missing this reads as
a dead end at every jump.

### 4.2 Call Task returns; Jump To Task does not

`callTask` emits *both* a jump edge (label `call`) to the callee **and** a
fall-through edge to the next sibling. It is not a branch — it is a call. The
walker keeps a **call stack**: taking the `call` edge pushes the return
continuation, and the callee's end pops it.

`jumpToTask`, `jumpToMenu` and `changeState` hand control over for good. No
return is pushed, and anything after them in the sequence is unreachable — as it
is in Architect.

**Modelled limitation.** A `callTask` may declare named output paths (Failure,
Timeout, …). Architect does not record which of the callee's endings maps to
which named output, so the walker cannot correlate them. Named outputs are
therefore walked as *alternative* outcomes that skip the descent — one case
"the called task failed" — while the default return descends properly. This is
stated in the workbook's Summary sheet rather than hidden.

### 4.3 End of task vs. genuine terminal

An action at the end of a task sequence has no outgoing edge, because `walk()`
was called with `continuation = null`. So "no outgoing edges" means one of two
different things, told apart by the action's kind:

- kind `end` (`endTask`, `endState`, `endProgram`, `disconnect`, `exitBotFlow`)
  or `transfer` → a **genuine terminal**: the path's expected result.
- anything else → **end of task**: pop the call stack and resume. With an empty
  stack, the flow itself has run out, which is recorded as "End of flow" (worth
  a tester's attention — Architect will disconnect).

### 4.4 Loops are cycles, and are bounded

`loop` and `loopAnythingElse` are containers with a `Loop` edge into the body and
an `Exit` edge past it; the body's fall-through returns to the loop node. Jump
cycles between tasks are possible too. The walker therefore **never revisits a
node already on the current path** — it records `Loops back to <node>` and stops
that path. A test case that goes round a loop twice tests nothing the
once-through case doesn't.

## 5. Coverage modes

Path count is exponential in branch count: twenty binary decisions is a million
paths. Enumerating them all is useless to a tester and slow to produce. Three
modes, each answering a different question:

| Mode | Question it answers | Rough case count |
|---|---|---|
| **Branch** (default) | Is every branch exercised at least once? | ~ number of branch outputs |
| **Happy paths** | Does each intended outcome work? | ~ number of distinct terminals |
| **All paths** | Everything, for a small or critical flow | exponential — capped |

**Branch coverage** is the standard acceptance criterion for IVR sign-off and the
right default. Greedy construction: while any reachable edge is uncovered, walk
from the start preferring (1) an outgoing edge not yet covered, (2) an edge from
which an uncovered edge is still reachable, (3) the default. Mark the path's
edges covered, emit the case, repeat. This terminates because every iteration
covers at least one new edge.

**Happy paths** prefers the primary output at every choice — the unlabelled
default, or `Yes` / `Success` / `Found` / `Default` — giving one case per
reachable terminal. A smoke-test set.

**All paths** is a full DFS under the §4.4 revisit rule, hard-capped at **500**
cases per flow. On truncation the workbook says so loudly, on the Summary sheet
and in the page status — a silently truncated test document is worse than none.

**Uncovered branches are a finding, not a silent omission.** Any edge not
reachable from the start is listed on the Coverage sheet as unreachable. Those
are usually real defects: an output wired to nothing, or a task nobody jumps to.

## 6. Cross-flow scope

The closure is walked, but **paths are not inlined across flow boundaries**. Each
flow in the closure gets its own set of cases, tagged with its flow name; a
`callCommonModule` step names the module it calls and cross-references that
module's own cases.

Why not inline: a common module is a separate parse with its own variable scope,
and — as in §4.2 — Architect does not record which of the module's endings maps
to which of the caller's outputs. Inlining would multiply the caller's path count
by the callee's while inventing the correlation between them. Per-flow case sets
keep every branch covered, keep the document readable, and keep the counts
honest.

## 7. What each case says

Derived per path, no invention:

- **ID** — `TC-001`, stable within a run, prefixed per flow.
- **Title** — `<start> → <branch labels> → <expected result>`, truncated.
- **Preconditions** — the dependencies the path touches: data tables needing
  rows, data actions needing a live integration, schedule groups needing to
  evaluate a particular way.
- **Test data** — the conditions that must hold to force this path, taken from
  the branch labels and the source action's condition text (`edge.detail` carries
  a switch case's full expression). **Conditions are stated, not solved.**
  Architect expressions are arbitrary, so the document says
  `Flow.CustomerType == "Gold" must be true` and lets the tester set it up.
  Inventing a value that happens not to satisfy it would be worse than saying
  nothing.
- **Steps** — one per action on the path, templated per action kind
  (`playAudio` → "System plays audio: X", `transferToAcd` → "Call is transferred
  to queue X"), with the branch taken alongside.
- **Expected result** — the terminal: the queue transferred to, the disconnect,
  the bot exit, or "End of flow".
- **Priority** — High for an all-primary-output path (the happy path), Low for a
  path through a failure / timeout / no-input handler, Medium otherwise.
- **Result / Tester / Date / Notes** — left empty, for execution.

## 8. Workbook

Five sheets, via the shared `exportXlsx` helper so styling matches every other
export in the app:

| Sheet | Contents |
|---|---|
| **Summary** | Org, root flow, coverage mode, generated timestamp, case count, edges covered / total, and any truncation or modelling caveat |
| **Test Cases** | One row per case (§7), with empty execution columns |
| **Steps** | Normalized, one row per step per case — the shape a test management tool imports |
| **Coverage** | Every branch, which case covers it, and every unreachable one flagged |
| **Manual checks** | Run-time-resolved references (`dynamicRefs` — queues, prompts and schedules the flow resolves by expression), data actions, and data tables needing set-up |

The Manual checks sheet matters when a flow moves between orgs: a queue chosen by
`FindQueue(Flow.Queue)` cannot be enumerated, and the tester has to confirm it by
hand. This is the same set the dependency export flags.

## 9. Access

Access key `deployment.test.testCases`, added to `ADMIN_BASE` in
[`accessConfig.js`](../js/accessConfig.js) — so both Master Admin and Admin get
it, since Master Admin spreads `ADMIN_BASE`.

**No `featurePermissionMap.js` entry.** That map gates *write* actions only;
this feature reads flows and writes nothing, exactly like Flow Overview.

## 10. Customer visibility

Not available to customers, by three independent mechanisms:

1. `"deployment"` is on `CUSTOMER_EXCLUDED_KEYS` in
   [`accessService.js`](../js/services/accessService.js), which prefix-matches —
   so `deployment.test.testCases` is denied in customer mode even if an
   entitlement would otherwise grant it.
2. No package in [`packages.js`](../api/lib/packages.js) grants `deployment.*`;
   internal features are never packaged.
3. `POST /api/flow-yaml` answers 403 to any non-internal caller.

Any future decision to offer this to customers has to start at (3), not at the
access key.

## 11. Not in scope

- **Executing** the tests. This produces the document; a human or a test tool
  runs it.
- **Solving conditions** into concrete variable values (§7).
- **Inlining paths across flows** (§6).
- **Bot intent coverage beyond the branch.** Each intent is one branch; the
  utterances that resolve to it are a bot-training concern, not a flow path.
