# Onboarding Deployment — Design

Status: **Design** (no code yet)
Author: Genesys Admin App
Last updated: 2026-07-22

## 1. Purpose

Provide a single "Deployment › Onboarding" workflow that copies a curated set of
Architect assets from the **demo org** (the source of truth for templates) into a
**customer org**, in one guided operation, while automatically rewriting all the
internal references so the deployed flows work immediately.

Today this is done by hand: export each flow, import it into the customer org,
then re-point every reference to common modules, data tables, data actions and
the in-queue flow. This design automates that.

## 2. Confirmed constraints (from investigation)

- **Source is the live demo org.** The user selects assets live; nothing is
  pre-baked. (Rules out storing static template YAML.)
- **Each customer has its own org and its own private copy** of every asset.
  Nothing is shared between customers.
- **Only rename rule:** strip the leading `Template - ` from every object name
  and every reference. `Template - CM - Scheduled Phrases` → `CM - Scheduled
  Phrases`, `Template - In Queue` → `In Queue`, `Template - Services` →
  `Services`, etc.
- **All Architect references are by name, never GUID** (verified against a real
  `Template - Inbound Voice` export). References that appear:
  - `callCommonModule` → common module name (`ver_latestPublished`)
  - `dataTableLookup` → data table name
  - `callData` → integration category `Genesys Cloud Public API Integration` +
    data action name
  - `overrideInQueueFlow` → in-queue flow name
  - Internal jumps use local `refId`s (self-contained — no rewrite)
  - Queues/skills/groups resolved at runtime via `FindQueue()`, `FindSkill()`,
    `FindScheduleGroup()`, `FindGroup()`, `FindUserPrompt()` (no authoring IDs)
- The user must be able to **select the target division** in the customer org.

## 3. User experience

Route: `/deployment/onboarding` (access key `deployment.onboarding`).

Layout (single card, top-to-bottom):

1. **Target customer** — dropdown of configured customer orgs (demo org excluded).
2. **Target division** — dropdown, populated live from the selected customer org
   (`GET /api/v2/authorization/divisions`). Applied to data tables and flows.
3. **Callflows from demo org** — a single multi-select list of callflows (all
   inbound types: inboundcall / inboundchat / inboundemail / inboundshortmessage,
   plus workflows), loaded live from the demo org. **This is the only thing the
   operator picks.**
4. **Auto-resolved dependency tree** — as soon as callflows are selected, the app
   exports their YAML and resolves the full transitive set of dependencies
   (common modules, in-queue flows, data tables, data actions) and shows them as a
   read-only tree, so the operator can see exactly what will be deployed and in
   what order. The operator does **not** hand-pick tables/actions/modules.
5. **Deploy** → confirmation dialog listing the full ordered plan with the
   before/after names (e.g. `Template - Services` → `Services`) and the target
   division → starts a background job.
6. **Live progress** — a results panel polls the job and shows each item as
   ✓/✗ with detail, grouped by phase (Data tables → Data actions → Common modules
   → In-queue → Callflows).

## 4. Architecture

```
Browser (js/pages/deployment/onboarding.js)
   │  1. GET demo assets (via existing genesys-proxy, internal mode)
   │  2. GET customer divisions (via proxy)
   │  3. POST /api/onboarding-deploy  → { jobId }
   │  4. GET  /api/onboarding-deploy?jobId=…  (poll status)
   ▼
Azure Function: onboarding-deploy (HTTP, starts job + status)
   │
   ├─ writes job state to Table Storage (like scheduleStore/activityLogStore)
   ▼
Azure Function: onboarding-runner (background/durable worker)
   │  uses client-credentials for BOTH demo (read) and customer (write)
   │  — credentials already exist per org: GENESYS_<id>_CLIENT_ID/SECRET
   │
   ├─ Phase A: data tables      → plain REST
   ├─ Phase B: data actions     → plain REST
   ├─ Phase C: common modules   → flow engine
   ├─ Phase D: in-queue flows   → flow engine
   └─ Phase E: main callflows   → flow engine
```

### 4.1 Why a background runner

Publishing Architect flows is slow (export + validate + check-in + publish per
flow). Consumption Functions cap HTTP at ~230s. The repo already uses background
+ Table Storage patterns (`scheduled-runner`, `template-runner`,
`timer-functions/template-schedule-orchestrator`). Onboarding reuses that pattern:
POST returns a `jobId` immediately; the runner processes phases and updates status;
the page polls.

### 4.2 Flow engine choice (the one real technical decision)

Data tables and data actions are plain REST (the app already copies these between
orgs). **Flows cannot be created via plain REST** — the only name-based,
re-importable representation is the Archy YAML. `latestconfiguration` is
GUID-based and not re-importable. So Phases C–E need an engine that can (a) export
an existing demo flow to name-based YAML and (b) publish YAML into the customer
org.

**Chosen engine: the Genesys Flow Scripting SDK**
(`purecloud-flow-scripting-api-sdk-javascript`) — an npm package (Node 20+), the
same engine Archy is built on. **No CLI, no binary, no container.** Confirmed
capabilities (introspected from the installed package, see `poc/onboarding/sdk-spike`):

- `archSession.startWithClientIdAndSecret(location, cb, clientId, clientSecret, endCb, true)`
  — client-credentials auth per org.
- `archFactoryFlows.loadFlowByFlowNameAsync(name, type)` — read a live flow from
  the demo org (also `checkoutAndLoadFlowByFlowNameAsync`, `getFlowInfoByFlowNameAsync`).
- `flow.exportToObjectAsync(cb, 'yaml')` → `{ content, fileName }` (YAML in memory)
  or `flow.exportToDirAsync(dir, cb, 'yaml')` → file.
- Create empty flow of matching type (`createFlowInboundCallAsync`, `…InQueueCall…`,
  `…CommonModule…`, `…Workflow…`) then `flow.importFromContentAsync(text)` /
  `flow.importFromFileAsync(path)` to load the transformed YAML.
- `flow.validateAsync()` then `flow.publishAsync()` — publish to the customer org.
- `archEnums.FLOW_TYPES` (e.g. `inboundCall→'inboundcall'`), `FLOW_FORMAT_TYPES.yaml`,
  and `LOCATIONS` (e.g. `prod_eu_west_1`) all confirmed present.

**Session model:** a Scripting session authenticates to ONE org, so export (demo)
and publish (customer) run as **separate processes/steps**. This maps cleanly to
the background runner (spawn export → transform → spawn publish) and sidesteps any
single-session-per-process constraint.

**Caveat:** the SDK is published as **Alpha**. Pin the version and re-validate on
upgrades. Archy (CLI) remains a fallback engine if a blocker appears — the POC
keeps an Archy harness too — but the SDK is the target because it is npm-only and
fits the Functions host.

## 5. Deployment pipeline

Order matters — every phase must complete before the next, because later assets
reference earlier ones by name.

1. **Resolve rename map.** For every selected asset build `oldName → newName`
   where `newName = oldName.replace(/^Template - /, "")`. (Also used to rewrite
   references inside flow YAML.)
2. **Phase A — Data tables.** For each selected table: read full schema from demo
   (`GET /api/v2/flows/datatables/{id}?expand=schema`), create in customer with
   `name = newName`, `division = { id: selectedDivisionId }`, then **copy all rows**
   from the demo table into the new customer table
   (`GET …/rows` → `POST …/rows` per row, see §9).
3. **Phase B — Data actions.** For each: read full action from demo, create in
   customer with `name = newName`, mapping the integration by name/type
   (reuse `dataactions/copyBetweenOrgs.js` logic). Fail with a clear message if
   the target integration (`Genesys Cloud Public API Integration`) is missing.
4. **Phase C — Common modules.** SDK: `loadFlowByFlowNameAsync` from demo →
   `exportToObjectAsync('yaml')` → apply transform (§6) → create matching flow +
   `importFromContentAsync` → `publishAsync` to customer (division = selected).
5. **Phase D — In-queue flows.** Same as C.
6. **Phase E — Main callflows.** Same as C. References now resolve by name to the
   assets deployed in A–D.

## 6. Reference-rewriting spec

Applied to each exported flow YAML (common module, in-queue, callflow) before
publish:

- **Primary transform (targeted):** for each `(oldName, newName)` in the rename
  map, replace exact occurrences of `oldName` with `newName`. Targeted (exact
  known names) rather than a blanket string strip, to avoid touching unrelated
  literals (e.g. a TTS prompt that happens to contain the text "Template - ").
- **Flow's own name/description:** strip the `Template - ` prefix.
- **Division:** set the top-level `division:` to the selected customer division
  name.
- The transform is a pure string/AST pass on YAML; because all references are
  names in the rename map, no GUID handling is required.

## 7. Division handling

- The customer-org division list is fetched live and the user picks one.
- **The chosen division is applied to everything that has a division:** data
  tables (`division.id` on create) and all flows — common modules, in-queue
  flows and callflows (`division:` in YAML). Data actions are org-level in
  Genesys and have no division, so they are unaffected.
- The division always exists (it is chosen from the live customer-org list), so no
  fallback is required.

## 8. Dependency detection (auto-discovery)

The operator selects **only callflows**; the app discovers everything else by
parsing YAML. Proven by `poc/onboarding/deps.js` (`resolveDeps(yaml)`), which on
the real `Template - Inbound Voice` export found 4 common modules, 1 in-queue
flow, 6 data tables and 1 data action from the single flow.

Reference markers scanned (all name-based):
- `callCommonModule` → `commonModule: <ModuleName>` (a flow — **recurse**)
- `overrideInQueueFlow` → `name: <FlowName>` (a flow — **recurse**)
- `transferToFlow` / `transferToFlowSecure` → `targetFlow: name: <FlowName>`
  (a flow — **recurse**)
- `dataTableLookup` → `dataTable: <TableName>` (leaf)
- `callData` → `category: <Integration>` / `dataAction: <ActionName>` (leaf)

**Transitive closure:** a callflow's YAML lists only its *direct* references.
Common modules and in-queue/transfer flows are themselves flows that can
reference further modules/tables/actions, so the resolver **exports each
discovered flow and re-runs on it**, merging results until no new flows appear.
Data tables and data actions are leaves (no recursion). Each demo asset is
exported at most once and cached for the job.

The merged set drives both the read-only dependency tree in the UI and the
leaves-first deploy order (data tables → data actions → common modules → in-queue
flows → callflows).

## 9. Row copy, literals, prompts, runtime refs

- **Data table rows — copied.** After creating each table's schema, all rows from
  the demo table are copied into the customer table (`GET
  /api/v2/flows/datatables/{id}/rows` paginated → `POST …/rows` per row). Row
  values are copied verbatim (the `Template - ` prefix rule applies to object
  *names*, not row data). Note: row values that reference other object names
  (e.g. a `Queue` column holding `TDCerhverv_test`) are demo-specific and copied
  as-is — surfaced in the post-run warning report (see literals below).
- **Hardcoded literals:** the flow contains demo-specific literals not covered by
  the prefix rule, e.g. fallback queue `lit: TDCerhverv_test`. v1 leaves them and
  surfaces a warning listing detected literals; a future version can add an
  optional literal-substitution map.
- **User prompts — NOT auto-created.** Flows use `FindUserPrompt(...)`. v1 detects
  referenced prompt names and, if missing in the customer org, lists them in the
  warning report. Prompts (and their audio) are created separately by the user;
  the tool never creates prompts.
- **Skills / queues / groups / schedule groups:** referenced at runtime by name.
  Out of scope to create here (handled by existing Deployment › Basic). v1 warns
  if a referenced schedule group / queue name is not found in the customer org.

## 10. Job & status model

Table Storage table `OnboardingJobs` (partition = customerOrgId, row = jobId):

```json
{
  "jobId": "…",
  "customerOrgId": "…",
  "divisionId": "…",
  "divisionName": "…",
  "status": "running|succeeded|partial|failed",
  "phases": [
    { "phase": "dataTables", "items": [ { "old": "Template - Services",
        "new": "Services", "status": "ok|error", "detail": "…" } ] }
  ],
  "startedAt": "…", "finishedAt": "…", "startedBy": "user@…"
}
```

HTTP endpoints:
- `POST /api/onboarding-deploy` — body `{ customerOrgId, divisionId, assets }` →
  `{ jobId }`. Internal-mode only (same guard as proxy internal path).
- `GET  /api/onboarding-deploy?jobId=…` → job document for polling.

Every item result is also written to the existing activity log
(`logAction`) for auditing.

## 11. Access control & wiring

- `navConfig.js`: add leaf under **Deployment** → `{ label: "Onboarding",
  path: "onboarding", access: "deployment.onboarding" }`.
- `pageRegistry.js`: map `/deployment/onboarding` →
  `pages/deployment/onboarding.js`.
- `js/accessConfig.js` / `featurePermissionMap.js`: register
  `deployment.onboarding` and gate it (internal users only, since it uses
  client-credentials against the demo org).

## 12. Security

- Server-decides mode: the runner uses **client-credentials** for demo (read) and
  customer (write). The customer org is never chosen from an untrusted body field
  without the internal-mode guard already in `genesys-proxy`.
- The demo org id is configured server-side (new app setting `DEMO_ORG_ID`), not
  taken from the client.
- No secrets ever returned to the browser; only job status.
- All writes audited via activity log.

## 13. Error handling, idempotency, rollback

- **Idempotent creates — skip & notify:** before creating a table/action/flow,
  check whether one with `newName` already exists in the customer org; if so,
  **skip it and record a notice** in the job report (never overwrite). This makes
  a failed job safe to re-run and never clobbers customer edits. Skipped
  dependencies are still treated as present so dependent flows can bind to them.
- **Fail-forward with report:** a failure in one asset does not abort the job; it
  is recorded and the phase continues where safe. Dependent phases are skipped for
  assets whose dependency failed.
- **No automatic rollback** (deleting published flows is destructive). The final
  report lists exactly what was created so cleanup, if needed, is manual and
  explicit.

## 14. Phased implementation plan

- **POC (de-risk the engine):** DONE (see `poc/onboarding/`). Introspected the
  Flow Scripting SDK and confirmed load/export/import/publish; built the
  transform, recursive dependency resolver, and an SDK export→transform→publish
  harness (`poc/onboarding/sdk-spike`). Remaining: one live run against a test
  customer org (needs client-credentials) to confirm references bind.
- **Phase 1 — REST assets + UI shell:** onboarding page, customer + division
  pickers, live asset lists, dependency preview; deploy **data tables + data
  actions** only (reusing existing REST helpers). Flows shown as "pending engine".
- **Phase 2 — Flow engine:** wire the SDK export/publish steps into the background
  runner; add Phases C–E; job/status model + polling; activity logging.
- **Phase 3 — Polish:** idempotency/overwrite, literal + prompt warnings, optional
  row copy, retry of failed items.

## 15. Risks

- The Flow Scripting SDK is **Alpha** — pin the version, re-validate on upgrades,
  and keep the Archy CLI as a fallback engine if a blocker appears.
- A live SDK export/import/publish round-trip is not yet run against a real org
  — do this first before building on it.
- Consumption Function time limits → background runner required (mitigated by
  established pattern).
- Demo-specific literals / prompts not covered by the prefix rule → surfaced as
  warnings, handled in later phase.
```
