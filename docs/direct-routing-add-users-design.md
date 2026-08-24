# Users — Direct Routing — Add user(s) — Design

Status: **Built** — all six steps shipped to dev (2026-08-23). The backup half
was verified against a live org first (§2.1, §2.1.1, §2.4). The Primary column
is read-only permanently, by policy rather than pending a test (§4).
Author: Genesys Admin App
Last updated: 2026-08-23

Covers the page at [`js/pages/users/directRouting/addUsers.js`](../js/pages/users/directRouting/addUsers.js),
its style block at [`css/styles.css:4294`](../css/styles.css), and the four API
helpers it leans on in [`js/services/genesysApi.js`](../js/services/genesysApi.js).

## 0. What is wrong, and why this is a design and not a patch

The page has two halves. The address half — tagging a phone or an email with
`directrouting` — works, and matches what Genesys documents. The backup half
does not work at all, and has never worked, because it was written against a
model the API does not have.

`AgentDirectRoutingBackupSettings`, from the live spec:

```
queueId          string   "ID of queue to be used as backup. If queueId and userId
                           are both specified, queue behaves as secondary backup."
userId           string   "ID of user to be used as backup. If queueId and userId
                           are both specified, user behaves as primary backup."
waitForAgent     boolean
agentWaitSeconds int32    "Valid range [60, 864000]."
backedUpUsers    string[] readOnly
```

There is no `type`. There is no `user` object and no `queue` object. The page
reads `backup?.type`, `backup?.user?.id` and `backup?.queue?.id`, all three of
which are permanently `undefined`, so **every existing backup renders as
"None"** — the page cannot show an administrator what is currently configured.
It then writes `{ type, user: { id }, queue: { id } }`, which carries none of
the fields the API reads. Only `waitForAgent` and `agentWaitSeconds` survive the
round trip, and they are bounded wrong at both ends.

That is not a field-rename. The model says a user and a queue are *both*
allowed at once, with a defined precedence — primary and secondary backup — and
a three-way radio group cannot express that. The control has to change shape, so
the change detection, the save path and the delete path change with it.

Alongside that sits a defect that can damage data the page was not asked to
touch, and a Primary column that the spec says cannot work. Those are §3 and §4.

## 1. Confirmed decisions

- **The backup section is rebuilt around `userId` / `queueId`**, as two
  independent, clearable pickers rather than a radio group (§2). "No backup" is
  the state where both are empty.
- **Applying a change never clears an integration tag this app did not set**
  (§3). Today it blanks every one it finds.
- **The Primary column is read-only and stays that way** (§4). The API will not
  accept the write, and Genesys advises against direct routing on the primary
  phone regardless — so there is nothing to reinstate later.
- **Email gets the same one-of-N control phones have** (§5), because Genesys
  documents one `directrouting` tag per media type and checkboxes cannot hold
  that line.
- **Tagging requires the target to be verifiably routable** — an email on a
  configured inbound domain (§5.1), a phone in a DID pool (§5.2). A lookup that
  failed blocks tagging and says why; it does not fall through to allowing it.
- **Addresses opens expanded; only Backup Settings stays collapsed** (§7.1).
  This reverses an earlier deliberate choice — see that section.
- **SMS stays out of scope** and is recorded as a known gap (§11).

## 2. The backup contract

### 2.1 Step zero: confirmed against a live org — 2026-08-23

**Done. The spec holds.** A `PUT` carrying a flat `userId` succeeded, and the
`GET` that followed returned:

```json
{
  "userId": "54d4d4f0-d37e-4778-9caa-abea740fadfc",
  "waitForAgent": true,
  "agentWaitSeconds": 120,
  "backedUpUsers": []
}
```

No `type`. No `user` object, no `queue` object. `waitForAgent` and
`agentWaitSeconds` round-trip unchanged. Everything below stands as written.

Two details the spec did not make obvious, both of which the code has to handle:

- **`queueId` is absent, not null**, when no queue backup is set. The read path
  is `backup?.queueId || null` and the change-detection tuple must normalise
  absent and empty to the same value, or every load will report a phantom
  change.
- **`backedUpUsers` comes back on the read** and is `readOnly`. It must be
  stripped before any `PUT` — the body is built from the four writable fields,
  never by spreading the object that was read. This is the same trap as
  `display` on `Contact` in §3.

Merge-vs-replace was settled on the same trip and is recorded in §2.4: `PUT`
replaces.

### 2.1.1 The not-found body — confirmed

A `GET` after a `DELETE` returns `404` with a Genesys error body:

```json
{
  "message": "AgentDirectRoutingBackupSettings {id} does not exist.",
  "code": "resource.not.found",
  "status": 404,
  ...
}
```

That is enough to fix the swallow. `getDirectRoutingBackup` currently collapses
*every* failure into `null`, so a 403 from a missing
`routing:directRoutingBackup:view` is indistinguishable from "no backup set" and
both render as "None" — an administrator without view permission is shown an
empty form that will cheerfully overwrite whatever is really there.

`proxyGenesys` already attaches `err.status` and `err.body`, and
`genesys-proxy/index.js:73` passes the upstream status through untouched, so
nothing new is needed in the transport. The helper returns a tagged result
rather than a bare value:

- `err.status === 404` **and** `err.body?.code === "resource.not.found"` →
  `null`, meaning confirmed: no backup configured.
- `err.status === 403` → a `denied` marker. The section renders read-only with
  the missing permission named; it never presents an editable form.
- Anything else rethrows. A swallowed 500 is how this defect started.

**The `code` check is not belt-and-braces.** The proxy raises 403s of its own
for app-level authorization gates (`genesys-proxy/index.js:153`, `:195`, `:204`),
so a 403 does not by itself mean Genesys refused. Genesys error bodies always
carry `code`; the proxy's own do not. Key on the body, not the status alone.

The DELETE itself returned success on an account holding
`routing:directRoutingBackup:delete`, so the §6 permission split is a real
distinction the API enforces, not a documentation artefact.

### 2.2 The control

Two rows, each independently clearable, replacing the `NONE / USER / QUEUE`
radios:

```
Backup user   (primary)    [ search box              ]  [x]
Backup queue  (secondary)  [ queue dropdown          ]  [x]

[ ] Send to backup immediately
Wait for agent:  [   70 ] seconds        (60 – 864000)
```

The `(primary)` / `(secondary)` hints only render when both are filled, since
that is the only state in which the precedence means anything. When just one is
set it is simply *the* backup, and labelling it "primary" invites the reader to
go looking for a secondary that does not exist.

This gains a capability the page never had: user-then-queue fallback, which the
API has always supported.

### 2.3 Wait options

`waitForAgent` reads inverted in the current UI. The spec describes it as a flag
for whether interactions *wait for the agent* or *go immediately to the backup*,
and the Genesys queue-level UI surfaces the same idea as an **Assign to backup
immediately** checkbox. "Wait for Agent" next to a seconds field reads as if
ticking it is what enables the wait, which is backwards from how an
administrator who has seen the Genesys screen will parse it.

- Label it **Send to backup immediately**, checked when `waitForAgent` is false.
- When it is checked, the seconds field is disabled and greyed — the value is
  not consulted.
- Seconds is `min=60 max=864000`, seeded at 70 for a backup being created.
- Validate before Apply and refuse with an inline message. A 400 from Genesys
  after a partially-applied batch is a worse outcome than a refusal up front.

### 2.4 Change detection and save

The comparison tuple becomes `{ backupUserId, backupQueueId, waitForAgent,
agentWaitSeconds }` — no `backupType`.

| Original | Current | Action |
|---|---|---|
| no backup | both empty | nothing |
| no backup | either set | `PUT` |
| backup | both empty | `DELETE` |
| backup | either set, anything differs | `PUT` |

The `PUT` body carries only the fields that are set:

```js
const body = { waitForAgent, agentWaitSeconds };
if (backupUserId)  body.userId  = backupUserId;
if (backupQueueId) body.queueId = backupQueueId;
```

Sending `userId: null` to clear one side is not something the spec describes,
and it does not need to be. **Confirmed 2026-08-23: `PUT` replaces, it does not
merge.** A write carrying both `userId` and `queueId`, followed by a write
carrying only `userId`, leaves `queueId` gone.

So clearing one side while keeping the other is simply a `PUT` carrying just the
survivor, and clearing both is a `DELETE`. The table above is complete — no
delete-then-write dance, and no null sentinels. The save path stays four cases.

The flip side of replace semantics: **a `PUT` must always carry every field the
administrator still wants set.** A partial write silently drops whatever it
omits. This is the same hazard as the `addresses` array in §3 and it is worth
stating twice, because the natural way to write a "just update the seconds"
handler is exactly the one that wipes the backup target.

### 2.5 Re-rendering must stop discarding input

`renderBackupTarget` rebuilds from `currentBackup` on every type change, so
switching away and back throws away a queue the administrator just picked.
With two always-present rows the switch disappears, and with it the bug. The
queue list is fetched once into `queuesCache` and shared; it should stay that
way.

## 3. Applying a change must not strip foreign integration tags

Today:

```js
clone.integration = curr.drPhoneType === addr.type ? "directrouting" : "";
```

Every address that is not the chosen one has its `integration` blanked. The
example value the spec itself gives for that field is `microsoftteams`. So
tagging a user for direct routing silently unhooks their Teams number, on an
address the administrator never selected and cannot see was affected — the
Addresses section does not display the integration column at all.

The rule is that this page owns the value `directrouting` and nothing else:

```js
const isChosen = curr.drPhoneType === addr.type;
if (isChosen)                                  clone.integration = "directrouting";
else if (addr.integration === "directrouting") clone.integration = "";
// any other value is left exactly as found
```

Two consequences worth taking on deliberately:

- **A foreign tag on the address being chosen is a conflict.** An address cannot
  hold two integration tags. Overwriting `microsoftteams` with `directrouting`
  is a real change with real effect, so the Addresses table gains an
  **Integration** column showing the current value, and choosing an address that
  already carries a foreign tag asks for confirmation naming the tag being
  replaced.
- **The table now tells the truth about what is there.** That column is the
  cheapest fix in this document and it is the one that would have made the
  defect visible.

`display` is `readOnly` on `Contact` and is currently echoed back in the PATCH
body. Genesys tolerates it, so this is not urgent, but the body should be built
from the writable fields rather than by spreading the whole address.

## 4. The Primary column

`primaryContactInfo` is marked `readOnly` on both `User` and `UpdateUser`, and
documented as *"Auto populated from addresses."* The page writes it anyway:

```js
body.primaryContactInfo = [...otherPrimary, { address, display, mediaType, type }];
```

At best this is ignored, at worst it draws `invalid.property`. Either way the
radio does not do what its column heading promises, and a control that silently
fails is worse than no control — an administrator ticks it, sees no error, and
believes the primary was changed.

`Contact.type` carries a `PRIMARY` enum value, which is the plausible real
mechanism: primary is expressed *in* the addresses array rather than beside it.
That is a guess, and the community threads on this are contradictory enough that
it should not be built on.

**Decision: the column is read-only, permanently.** It displays which address
Genesys currently reports as primary — a tick or a dash, no input — so the
information stays on screen and the promise disappears.

An earlier revision of this section left the door open: run one PATCH with an
address typed `PRIMARY`, see whether `primaryContactInfo` follows, and reinstate
editing if it did. That test was never run and no longer matters, because the
API constraint is not the only reason. **Genesys advises against using the
primary phone for direct routing at all.** A control that made it easy to set
would be steering administrators toward the arrangement the vendor tells them to
avoid, and whether the API happens to permit the write does not change that.

So there is nothing pending here. The column shows the current primary because
knowing it is useful when choosing which number to tag — and it goes no further.

Dropping the write also removes the deselect-on-click behaviour from the primary
radios, which existed only to express "no primary phone".

## 5. What can actually be tagged

Genesys documents **one `directrouting` tag per media type**. Phones enforce
this with a radio group and a None row. Emails use checkboxes, so two can be
ticked and applied, and the resulting user is in a state the documentation says
is not supported.

Emails get the phone treatment: the same one-of-N control, in the same exclusion
group. Most users have a single email address in `addresses`, so in practice
this is a group of one — but the constraint should be expressed by the control,
not left to how many rows happen to exist.

**Revised 2026-08-23: the control is a switch, not a radio.** Radios expressed
the constraint correctly but cannot be un-ticked, so clearing a tag needed a
"None" row per media type per user — two extra table rows on most cards, whose
only real job was to be a click target. Switches turn themselves off, so the
one-per-media-type rule is kept by switching the rest of the group off when one
comes on, and the None rows are gone. `makeDeselectable` — the click-the-checked-
radio-to-clear trick that nobody would have guessed at — went with them.

A switch is shown **only where it can be used**: an address type the user does
not have shows a dash, not a dead control. The single exception is an email
already tagged on a domain that cannot be verified, which keeps a switch that
turns off but refuses to turn back on — hiding it would hide a live tag and let
the row read as untagged.

The current keying is `emailAddr.type || "WORK"`, which collides if a user holds
two EMAIL addresses of the same type. Key on array index instead, and carry the
address string for the confirmation text.

### 5.1 Email: the domain check has a silent failure mode

`loadEmailDomains` calls `/api/v2/routing/email/domains` and swallows every
error into an empty `Set`. That endpoint requires `routing:email:manage`, which
is not implied by `directory:user:edit` — the permission this page is gated on.
An administrator holding exactly the documented permission therefore sees the
orange *"Domain X is not configured as an inbound email domain in Genesys"* on
**every** email row, and gets no tagging control at all, with nothing on screen
suggesting the check itself was the thing that failed.

It also does not page. Default `pageSize` is 25 and the call passes no
override, so an org with more inbound domains than that gets false warnings for
the ones past the first page.

Three states, not two:

| Lookup | Domain | Shown |
|---|---|---|
| succeeded | present | control enabled, no warning |
| succeeded | absent | no control, warning: the domain is not configured |
| failed | unknown | no control, warning: the domain could not be verified |

**This fails closed, and the first revision of this section had it wrong.** It
argued that a missing *view* permission should not remove a *write* the
administrator holds, and that the check was merely advisory. It is not. Direct
routing to an email address only works when its domain is configured for inbound
email in Genesys, so a tag applied to an unverified address does nothing — while
looking exactly like a tag that works. An administrator would leave believing
direct routing was live for that user.

Being told the check could not run is a worse experience and a better outcome.
The warning names the missing permission so the gap is fixable rather than
mysterious.

An address that is *already* tagged keeps a disabled control in both blocked
cases, so an existing tag stays visible and can still be removed. Removal is
always safe; it is only adding one that needs the domain proven.

Page the call through `fetchAllPages`, as the rest of the app does.

### 5.2 Phone: the number has to be in a DID pool

Added 2026-08-23, and the exact counterpart of §5.1. Direct routing on a phone
works by a call route pointing at the number, so the number has to be one the
org actually owns. A `directrouting` tag on anything else is inert — it looks
identical to a working one and routes nothing, which is the failure §5.1 exists
to prevent, arriving through the other channel.

`GET /api/v2/telephony/providers/edges/didpools` returns pools as **ranges** —
`startPhoneNumber` to `endPhoneNumber`, both E.164. That matters for cost:
membership is a numeric comparison against a handful of pools, fetched once and
cached for the page. The alternative, `GET .../edges/dids?phoneNumber=`, is one
request per number — 150 of them on fifty users with three phones each.

Matching is on digits only, so `+45 76 77 65 57` and `+4576776557` compare
equal; the address list holds both forms. A pool whose bounds do not parse is
dropped rather than matched loosely, because a wrong "yes" enables a tag that
cannot route.

**An extension is not enough.** `Contact.extension` is mutually exclusive with
`address`, and an internal extension is not a DID, so a phone row carrying only
an extension is not taggable and does not make a user worth loading.

**This gates the whole page on `telephony:plugin:all`**, which
`directory:user:edit` does not imply. An administrator without it can tag
nothing, and the rows say why. That is a real cost, taken deliberately and on
the same reasoning as §5.1: being told the check could not run is a worse
experience and a better outcome than tagging a number that silently does not
route. If it proves too blunt in practice, the lever is here and it is one
condition.

As with email, an address already tagged keeps a switch that turns off but not
on, so an existing tag stays visible and removable.

## 6. Permissions

[`featurePermissionMap.js:104`](../js/featurePermissionMap.js) maps the backup
action to `routing:directRoutingBackup:edit` alone. Genesys splits it three
ways, and the Resource Center article lists all three:

| Operation | Permission |
|---|---|
| GET | `routing:directRoutingBackup:view` |
| PUT | `routing:directRoutingBackup:edit` |
| DELETE | `routing:directRoutingBackup:delete` |

Clearing a backup issues a DELETE. An administrator with edit but not delete can
reach the control, clear both fields, press Apply and collect a 403 nobody
warned them about.

Split the action in two — `backup` for edit, `backupDelete` for delete — and
when only the first is held, keep the section live but disable clearing with a
title naming the missing permission. The `:view` case is the §2.2 read: without
it the GET 403s, and the section should say so rather than presenting an empty
form that will overwrite whatever is really there.

## 7. Layout

### 7.1 Addresses opens expanded

Both sections currently start collapsed. That was a deliberate choice, made to
keep a long multi-user list scannable, and it is being reversed on the strength
of how the page is actually used: the addresses *are* the task. Two clicks per
user before anything can be read is the wrong trade, and it makes the bulk
"Auto-tag phone type for all" control appear to do nothing at all — it flips
radios inside collapsed sections, with no visible result anywhere on screen.

- **Addresses**: expanded on render.
- **Backup Settings**: collapsed, as now. It is the section most users will not
  touch, and it is the taller of the two.

The bulk control additionally gets a confirmation line under it — *"Work Phone 2
selected for 14 of 17 users; 3 have no Work Phone 2"* — so it reports what it
did even for cards scrolled off screen.

### 7.2 Contrast

The light-mode block at [`styles.css:4439`](../css/styles.css) overrides three
DR colours and misses two:

- `.dr-backup-toggle` is a hardcoded `#60a5fa`, roughly 2.6:1 on white. It is
  the control that opens the section, so it is the one thing on the card that
  has to be findable.
- `.dr-email-warn` is `#fb923c`, and it is the page's only warning text.

Both move to tokens with a light-mode value that clears 4.5:1.

### 7.3 The address column truncates what it exists to show

`.dr-addr-table` is `table-layout: fixed` at 20/40/15/25%, the address cell is
`nowrap` with an ellipsis, and `tdAddr` sets `textContent` with no `title`. A
long address is unreadable and unrecoverable, on a page whose whole job is
confirming that address is the right one.

Give the cell a `title`, and rebalance the columns — the two radio columns are
40% of the table between them for two glyphs. With the Integration column from
§3 arriving, the row becomes Type / Address / Integration / Primary / Direct
Routing, weighted toward Address.

### 7.4 Keyboard

Both toggles are bare `<div>`s with click handlers: no `role="button"`, no
`tabindex`, no Enter or Space. Nothing on the card can be reached without a
mouse. They become real `<button>`s with `aria-expanded`, which also gets the
arrow glyph state for free.

## 8. A group filter beside the user picker

Requested 2026-08-23. The page currently offers one control: a multi-select of
every active user in the org. On a large org that is a long list to hunt
through, and direct routing is usually rolled out to a team at a time.

**The pattern already exists in `createWebRtc`** and this follows it rather than
inventing a second one. `configureUsers` also filters by group, but as a *mode
switcher* — "By Group" is picked *instead of* "Search". That is the wrong shape
here and is not the precedent being copied.

What `createWebRtc` already settles, and this adopts unchanged:

- **Side-by-side control groups in a `.cs-controls` flex row**, one `label` +
  slot per filter, exactly as `wc-controls` holds Groups and Division.
- **Placeholder `"All groups"`**, which states "empty means no filter" in the
  control itself rather than in prose next to it.
- **Union within a filter, AND across filters.** Selecting two groups offers
  everyone in either (`memberLists.flat()`). If a division filter is ever added
  beside it, a user must satisfy *both* — the rule is already written down in
  `applyUserFilters` and should not be re-decided per page.
- **The filter never gates the page.** `createWebRtc` boots its filters through
  `Promise.allSettled` and comments the rule plainly: sites gate the page, the
  filters do not. A failed `fetchAllGroups` here leaves the user picker fully
  working and simply hides the filter.
- **A pure, exported, DOM-free filter function**, mirroring `applyUserFilters`,
  so the selection logic is testable without a page. If it ends up identical,
  it moves to a shared module rather than being imported page-to-page.
- **`describeFilters`-style phrasing** for anything the status line says about
  scope: `group 'Support'` for one, `3 groups` for several.

### 8.1 The one genuine divergence

`createWebRtc` has **no user picker**. Its filters scope a batch operation, so
membership is fetched once, when Analyse runs, and `applyUserFilters` narrows a
list the operator never sees as a list.

This page does have a picker, and the whole point of the request is to make that
picker shorter. So the filter has to narrow it **live, on change** — you cannot
select from a list that has not been filtered yet. Member fetching therefore
moves from run-time to filter-change-time, with the results memoised in a `Map`
keyed by group ID for the life of the page, so re-picking a group already seen
costs nothing.

That is the only place this departs from the WebRTC pattern, and it is forced by
the presence of the picker rather than chosen.

### 8.2 The filter narrows what is offered, never what is already held

This problem does not arise in `createWebRtc` — nothing is selected there before
the filter runs — so it is new, and the obvious implementation gets it wrong.

`multiSelect` exposes `setItems` (clears the selection) and
`setItemsKeepSelection` (drops selected IDs no longer in the list). Both are
wrong here. An administrator who selects three people and *then* reaches for the
group filter would have the two outside that group silently unticked —
discovered, if ever, after Apply.

The option list is therefore:

```
(members of the selected groups  ∩  the loaded user list)  ∪  already-selected users
```

Users kept only because they are already selected stay ticked and stay visible,
marked so the reason is legible — a trailing "(not in filter)" on the label is
enough. Clearing the filter restores the full list; nothing about the selection
ever changes as a side effect of filtering.

### 8.3 Intersect with the loaded users, do not replace them

`fetchAllUsers` is called without `state`, so the page holds **active users
only**. `/api/v2/groups/{id}/members` has no such default and returns members
whatever their state, including inactive and deleted ones.

Feeding member IDs straight into the picker would offer users the page cannot
meaningfully configure, and `getUser` on a deleted user is a wasted round trip
at best. Intersect against the user map already in memory; drop anything absent
from it; and when the drop is non-empty say so quietly beside the filter —
*"Support (14) — 2 members are not active users"* — rather than presenting a
group of 14 that silently yields 12.

`createWebRtc` states the companion principle and it applies here too:
**filtered-out users are not "skipped"**. They were never in scope. Burying them
in the skip count hides the users who *were* considered and rejected for a
reason worth reading — which is exactly the miscount §10 already has to fix in
the load summary.

### 8.4 Loading and disabling

Groups load at mount alongside the existing `fetchAllUsers`, through
`Promise.allSettled` so neither failure takes the other down. Filter to
`state === "active"` and label each option with its `memberCount`
("Support (14)"), so an empty group is obvious before it is picked.

Neither `/api/v2/groups` nor `/api/v2/groups/{id}/members` declares a required
permission in the spec, so there is no §5.1-style gating problem to design
around.

The filter is disabled during a load or an apply, alongside the other controls
in `setRunning` — `createWebRtc` does the same through `groupSelect.setEnabled`.

## 9. The Call Routing column

Requested 2026-08-24, and the piece that makes the page finish its job rather
than half of it. A number can sit in a DID pool, carry a `directrouting` tag,
and still route nothing — because no call route points at it. The page can
produce exactly that state today and says nothing about it.

### 9.1 What it maps to

"Call Routing" in the Genesys admin UI is an Architect IVR:
`/api/v2/architect/ivrs`, gated by `routing:callRoute:view` and
`routing:callRoute:edit`. The relevant field is `dnis`, a string array, and the
spec is explicit about the constraint that shapes everything below:

> Each phone number must be unique and not in use by another.

The read model is already proven in this codebase — `documentation.js:494`
walks the same endpoint and pulls `dnis` for the export — and the frontend
helper `fetchAllCallRoutes` exists. **Nothing writes an IVR yet.** The Divisions
page moves call routes through the bulk division endpoint, not a `PUT`, so this
is the app's first `PUT /api/v2/architect/ivrs/{id}`.

### 9.2 Reading: one fetch, one index

Fetch every call route once per page and build `dnis → route` from it. Both
halves of the column come out of that index: what the dropdown offers, and
which route a number is already on. The `dnis` query parameter on the list
endpoint would allow a lookup per number instead; on fifty users with three
phones each that is 150 requests to answer a question one paged fetch already
answers.

Matching uses the same digits-only comparison as the DID pool check (§5.2) —
`dnis` entries and address values are not reliably in the same format.

### 9.3 What the cell does — decided 2026-08-24

- **The route is shown whenever the number is on one, and is editable only
  while that number's Direct Routing switch is on.** Revised 2026-08-24: the
  first version left the picker editable regardless, on the argument that
  hiding it would conceal configuration and mean enabling direct routing just
  to clear a stale assignment. Showing it does both jobs on its own — the route
  name stays visible when the toggle is off, greyed rather than gone — and a
  route assignment is only meaningful for a number that carries the tag, so a
  live picker beside a switched-off toggle invited a change that means nothing.

  Greying also **reverts the picker to the value it loaded with**. Turning the
  toggle off after choosing a route would otherwise leave a pending change that
  is invisible, unreachable and still queued for Apply. Off means out of play,
  in both directions. The cost is the one named above: clearing a stale
  assignment means switching the tag on first.
- **Turning the Direct Routing switch off never touches the route.** One
  control, one effect. The alternative — cleaning up the route assignment on
  untag — means a switch quietly writing to a shared object that other users'
  numbers also live on, which is a surprising amount of blast radius for
  clicking a toggle.

The consequence is that the two can disagree: a number can be on a route with
no tag, or tagged with no route. That is a real state in Genesys and the column
shows it rather than papering over it.

### 9.4 Writing: batched per route, not per user

This is the part that does not look like the rest of the page. Everything else
here writes to **one user** — their addresses, their backup. A call route is a
**shared object**, and the apply loop is per user.

Three users whose numbers all go to "Main Inbound" would mean three
`GET`→`PUT` cycles against the same object, each one invalidating the next
one's `version`. At best the later writes 409; at worst they silently drop the
earlier additions.

So the apply path grows a third phase:

1. Addresses, per user (unchanged).
2. Backup, per user (unchanged).
3. **Call routes, per route.** Collect every `dnis` addition and removal across
   the whole batch, group them by route id, then do one `GET` → modify `dnis`
   → `PUT` per affected route.

The `PUT` is a whole-object write with a `version`, so the same discipline as
the addresses array applies: read fresh, change only `dnis`, send everything
else back exactly as found.

### 9.5 Moving a number is two writes

`dnis` uniqueness is enforced org-wide, so moving a number from route A to
route B cannot be a single write. Removing from A must land before adding to B,
or Genesys rejects the addition as in use.

Both routes are in the phase-3 grouping already, so the ordering is a matter of
sequencing removals before additions within that phase. If a removal succeeds
and the matching addition fails, the number ends up on neither route — the
failure is reported against the user by name, and re-running Apply completes
the move. That is preferable to the reverse ordering, which fails cleanly but
leaves the operator believing nothing happened.

### 9.6 Permissions

| Operation | Permission |
|---|---|
| list / read | `routing:callRoute:view` |
| write `dnis` | `routing:callRoute:edit` |

Gated like §6: the column renders read-only with the permission named when
edit is missing, and a failed list read disables the column outright rather
than presenting an empty dropdown that would look like "no routes exist".

`featurePermissionMap` gains a `callRoute` action alongside `addresses`,
`backup` and `backupDelete`.

### 9.7 What this cannot check

The column can say which route a number is on. It cannot say whether that
route's flow actually performs a direct routing lookup — `openHoursFlow` is a
flow reference, and what the flow does is not inspectable from here.

So a number can be in a pool, tagged, and attached to a route, and still not
direct-route, because the flow behind the route does not implement it. This
column removes three of the four ways to get it wrong and is honest about the
fourth.

## 10. Defects swept up alongside

- **Cancel is invisible during Load Details.** The handler calls
  `setRunning(true)` — which un-hides `$cancelBtn` — and *then* sets
  `$applyWrap.style.display = "none"`, and the button lives inside that wrapper.
  It is unreachable for the whole load. Same shape as the one fixed in `6af4b46`;
  move the button out of the apply wrapper.
- **A `document`-level `pointerdown` listener leaks** on every
  `renderBackupTarget` call, per card, and survives navigation away from the
  page. §2.5 removes most of the re-renders; the listener still needs unbinding
  when the page unmounts.
- **`escapeHtml(data.user.name)` is passed to `setStatus`**, which writes
  through `text.nodeValue`. A name containing `&` renders as `&amp;`. Drop the
  escape — the status line is text nodes by construction, which is the whole
  point of `makeStatus`.
- **`takeSnapshot` is dead.** Its result is overwritten by
  `readCurrentState(uid)` immediately after render, on the only path that
  reaches Apply. Delete it.
- **Dead `const skipped`** in the success branch, unused.
- **The "No user details could be loaded." fallback is unreachable** — the
  `skipped` it branches on is always truthy there. Worse, users whose GET
  *failed* are counted into "without addresses skipped", so a run of 403s
  reports as a run of users with nothing to configure. Count the two separately
  and say which is which.

## 11. Known gaps

**SMS.** The Resource Center lists SMS as a direct routing channel, tagged on a
work phone number, and `Contact.mediaType` has an `SMS` value. The page ignores
it entirely. The current PATCH loop leaves SMS addresses untouched, so nothing
is damaged — it is simply not offered. Out of scope here; it wants its own row
group and its own one-of-N constraint, since the per-media-type rule means the
SMS tag is independent of the call tag.

**A backup on a user with no routable address is not reachable here.** Users
without a phone number and without an email on a verified inbound domain are
dropped before rendering, because every control on their card would be dead.
If such a user also has an agent backup configured, this page will not show it.

That is deliberate. A backup only takes effect when a direct routing
interaction reaches the agent, which requires a routable address — so an
orphaned backup changes nothing, and surfacing it would mean a card whose only
live control governs behaviour that cannot occur. Clearing one, if it ever
matters, is a `DELETE` in the API Explorer.

**Queue-level direct routing settings.** Agent backup is only half the picture —
`DirectRouting` on the queue carries `backupQueueId`, `waitForAgent` and
`agentWaitSeconds` as the org-wide default for agents with nothing configured.
The app has no page for it. Worth noting when this one says "no backup", because
the interaction still has somewhere to go.

## 12. Build order

All six steps are built and pushed to dev. What follows is the order they were
built in and why, kept because the reasoning outlived the work.

**The whole change lands as one merge**, tested on dev, and nothing reaches
production part-built. An earlier revision of this section ordered the work by
risk — integration-tag preservation first, because it stops active data loss.
That rationale only holds when pieces ship incrementally. They do not, so the
order below optimises for something else: **write each part once, against the
contract it will actually keep, and touch each region of the file once.**

The verification step is done (§2.1, §2.1.1, §2.4). Only §4's Primary question
is outstanding, and it gates nothing.

1. **The helpers** — `getDirectRoutingBackup` returning the tagged
   `null` / `denied` / throw result (§2.1.1), the `PUT` body built from the four
   writable fields (§2.4), email domains paged through `fetchAllPages` (§5.1).

   First because everything else calls them. Build the UI first and it gets
   written against the old contract and then rewritten — the page code should
   only ever see the shape it is keeping.

2. **The group filter** — §8 in full.

   Genuinely independent: it sits above the cards and touches only the picker
   and the boot sequence. It is placed here for a practical reason rather than a
   structural one — every manual test of steps 3 to 6 means selecting users on a
   real org, and having the filter already working makes each of those tests
   faster. A minor gain, but it costs nothing to take.

3. **The address table** — §3 integration preservation and the Integration
   column, §4 Primary demoted to read-only, §5 email as a radio group.

   One pass, not three. All three change the same render function, the same
   table markup and the same PATCH body builder. Touching that table on three
   separate occasions is three times the churn and three chances to leave the
   body builder half-migrated.

4. **The backup section** — §2.2 through §2.5.

   The largest single piece, self-contained below the address table, and
   dependent on step 1. This is also the first point at which the page can be
   tested end-to-end against the API Explorer results already in hand.

5. **Permissions** — §6, the three-way split and the `denied` rendering.

   After §2, because the delete path it gates has to exist before it can be
   gated, and after step 1, because it renders the `denied` marker that step
   produces. Cheap here; awkward anywhere earlier.

6. **Layout and the remaining defects** — §7, plus whatever of §10 has not
   already folded in.

   Last because steps 3 and 4 rewrite the markup §7 restyles. Doing the CSS
   first means doing it twice. The collapse defaults (§7.1), the toggles becoming
   real buttons (§7.4), the contrast tokens (§7.2) and the Cancel button moving
   out of the apply wrapper (§10) are all edits to markup that does not settle
   until step 4 is done.

§10 is not really a step. Most of it folds into whichever step touches the same
lines: `takeSnapshot` dies when the change-detection tuple changes in step 4,
the `escapeHtml` double-escape is in the apply loop, the skip-count miscount
belongs with §8.3's "filtered-out is not skipped". Only the Cancel button and
the listener unbind are structural enough to want their own moment, and both sit
naturally in step 6.

**Release note:** one entry, covering the backup rebuild and the group filter —
the two things that change what the page can do. Everything else is a correction
to behaviour that was already documented as working, and should not read as a
new feature.

## 13. Sources

- [Set up direct routing](https://help.genesys.cloud/articles/setting-up-direct-routing/) — the `directrouting` tag, supported address types, one tag per media type
- [Set up backup options for a direct routing agent](https://help.genesys.cloud/articles/set-up-backup-options-for-a-direct-routing-agent/) — the endpoint and the three permissions
- [Direct routing overview](https://help.genesys.cloud/articles/direct-routing-overview/)
- `AgentDirectRoutingBackupSettings`, `Contact`, `UpdateUser`, `DirectRouting` — Genesys Cloud OpenAPI spec, `https://api.mypurecloud.com/api/v2/docs/swagger`
