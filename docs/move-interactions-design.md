# Interactions › Move — layout and safety — Design

Status: **Built and released as 4.3, awaiting a test on dev.** All of §10. The probe
ran twice (§6.3, §6.4) and has been removed, replaced by the accounting it
existed to specify. The orphan case is still unseen in a sample — the page now
reports it in production if it turns up.
Author: Genesys Admin App
Last updated: 2026-08-23

Mockup: [mockups/move-interactions-redesign.html](mockups/move-interactions-redesign.html)
— static, uses the app's real `styles.css`, open it directly in a browser.

Move is the third page in this family, after
[Disconnect](disconnect-email-filter-design.md) and
[Search](interactions-search-redesign.md). It was written before either was
worked on, and it carries most of the defects both of those fixed. Where a
lesson has already been paid for elsewhere, this document cites it rather than
re-arguing it.

## 1. Why this page needs looking at

Two separate things arrived together, and they turn out to overlap.

**The layout.** The queue pickers take two stacked controls each — a search box
and a native `<select>` — and `.mi-queue-group { flex: 1 }` stretches each pair
across half the page for names like "Sales - DK". Nothing below them uses the
width they claim.

**The safety.** Move performs a blind transfer, tells the operator it cannot be
undone, and has none of the guard-rails Disconnect grew: no warning banner, no
preview gate, and a previewed set that survives a change of filter.

They overlap because two of the layout fixes *are* safety fixes. Adopting the
app's queue dropdown brings the `onChange` hook that invalidates a stale
preview; greying Move until a preview has run is both the visual hierarchy and
the failsafe.

## 2. Confirmed decisions

- **One searchable control per queue**, not a search box plus a select. Stated
  directly: *"it should only have one searchable filter for each queue."*
- **Layout and safety in one document**, because §1 says they are not separable.
- **The layout is approved as mocked up.** The gap between the queues and the
  media types was mockup scaffolding, not a proposal (§4.5), and a dropdown
  panel overlaying the media types when open is fine: *"once a queue is selected
  its fine again."*
- **Order by what avoids duplicated work, not by urgency.** Nothing reaches
  production until Move is finished, so there is no argument for landing the
  safety fixes first — see §10.

## 3. What is already right, and should not be touched

Recorded so it is not "tidied" away:

- **The three `.mi-controls` containers.** Move already splits its controls into
  route / media / dates, which is the thing
  [interactions-search-redesign.md](interactions-search-redesign.md) §6.3 found
  actually matters — one container holding everything is what makes a page read
  as soup, not `flex-wrap`. Move does not have Search's problem.
- **The date filter semantics.** `Older than D` keeps conversations that started
  before D, and the comparisons are identical to Disconnect's, UTC parsing
  included. Consistent across both pages; leave them.
- **The 31-day analytics windows.** Like Disconnect and unlike Search, every
  query here is filtered by `queueId` and `conversationEnd notExists`, so result
  sets are small by construction. See
  [interactions-search-notes.md](interactions-search-notes.md) §5 for why the
  chunk size differs between pages and why it is not a free lever.
- **The red `mi-btn-move` styling** and the confirmation dialog's wording.

## 4. Layout

### 4.1 Two dropdowns replace four controls

`createSingleSelect` — the searchable dropdown with the search box *inside* the
panel — is used on twelve pages, Disconnect's own queue picker among them. Move
is the only page in the app still hand-rolling a search input plus a native
`select`.

| | Move today | Every other page |
|---|---|---|
| Controls per queue | 2 stacked | 1 |
| Width | `flex: 1` — half the page each | sizes to content |
| Search | a separate box, always visible | inside the panel, on open |
| A filter that excludes the selection | silently clears it | cannot happen |

Deleted with it: `populateQueueSelect` (whose `$search` parameter was never
read), `.mi-queue-search`, `.mi-queue-select`, and the `flex: 1` on
`.mi-queue-group`.

### 4.2 The direction is shown, not implied

Source and destination are two identically sized blocks separated by 400px of
nothing, distinguished only by a 12px grey label. On an irreversible transfer,
reversing them is the expensive mistake, and the layout currently does nothing
to prevent it.

They become one row — `Source queue → Destination queue` — with the arrow
between them. This is the one layout change argued on safety grounds rather than
on tidiness.

### 4.3 Preview leads, Move is greyed until it has run

Preview takes `btn--primary`, as Search's Search button did. Move keeps its red
styling and is disabled until a preview exists — which is §5.2, arriving as part
of the visual hierarchy rather than bolted on separately.

### 4.4 A warning banner, in Disconnect's words

Disconnect opens with an orange *"Force Disconnect — Emergency Use Only"* panel.
Move has nothing, for an action its own dialog calls irreversible. The same
`.di-warning` treatment, saying what is actually true of a blind transfer:

> **⚠ WARNING: Move is a blind transfer and cannot be undone**
>
> Each matching interaction is transferred to the destination queue and re-queued
> there. It cannot be moved back automatically, and its wait time in the
> destination queue starts again.

The re-queuing consequence is worth stating because it is the part an operator
is least likely to have thought about, and it is not undone by moving them back.

### 4.5 What was verified

Measured in the mockup at 1440px and 1100px, in both themes:

| Check | Result |
|---|---|
| Source, arrow and destination on one line | ✅ at both widths |
| Queue controls the same width as each other | ✅ 240px, not `flex: 1` |
| Media checkboxes on one row | ✅ |
| Date fields on one row | ✅ |
| Horizontal page scroll | ✅ none |
| Move disabled before preview | ✅ |
| Even spacing down the page | ✅ 12px between every row, no gap anywhere |

**Not verified: how it looks.** Open the mockup and judge that yourself — the
measurements say the structure holds, not that the result is attractive.

**One correction to an earlier mockup.** It held the destination dropdown open
*inside* the layout and pushed the filters down 150px to clear the panel, which
read as a proposed gap between the queues and the media types. There is no such
gap: the panel is `position: absolute`, so it floats over what is beneath it and
the spacing is the standard 12px `.mi-controls` margin, as everywhere else on
the page. The open state now has its own section in the mockup so the layout
section shows the real spacing.

## 5. Safety — the three that can move the wrong interactions

Each of these has a matching, already-shipped fix on Disconnect.

### 5.1 A preview does not stick to the filters that produced it

Nothing clears `candidates` when a control changes — there is no `change`
listener on either queue select. So:

> Preview with source **A** → change source to **B** → press Move.
> `candidates.length` is non-zero, so the scan is skipped. The dialog reads
> *"Move 40 interactions from **B** to X"*, and it moves the **A** interactions.
> To X, because `params.dstId` *is* read fresh.

Release 4.1 fixed exactly this on Disconnect: *"Changing any filter after a
preview now clears it."* Here it also mislabels itself in the confirmation,
which is worse than acting on a stale set silently.

**Fix:** `invalidateCandidates()` on every control — both dropdowns' `onChange`,
the media checkboxes, and the two date pairs. Adopting `createSingleSelect`
(§4.1) supplies the hook for the queues.

### 5.2 Move runs without a preview

`$moveBtn` is enabled the moment queues load. Press it first and it scans and
transfers in one pass, so the whole set can be moved without ever being shown —
on an action that cannot be undone.

This is the failsafe requested on Disconnect on 2026-08-21: *"The Disconnect
should be greyed out until a preview occurred. Its too risky to disconnect
without preview."* The argument does not weaken for a transfer.

**Fix:** Move stays disabled until `candidates` exists, and the branch in the
Move handler that scans when there are none is deleted rather than left
unreachable.

### 5.3 A cancelled preview leaves a partial set armed

`scanConversations` breaks out of the inspection loop on cancel and returns what
it had. The handler assigns that to `candidates`, prints "Preview cancelled" and
never renders the table — so the operator is holding a set they were never
shown, at a count that looks authoritative.

Same hazard as a partly-loaded filter set on Recent Search, and the same answer:
a partial result is not a result.

**Fix:** cancelling a preview clears `candidates`.

Built with two things the section had not called for. `candidates` is now
assigned in exactly one place, `setCandidates`, so the button state cannot drift
from the set — the same funnel Disconnect uses. And the preview handler clears
before it starts, so an error mid-scan cannot leave the previous set armed
either; that path was not in §5.1 or §5.3 and is the same failure wearing a
third hat.

One thing turned up while testing: `renderResults` hid the table but left the
discarded preview's rows in the DOM. Invisible today, and exactly the stale
state this commit exists to stop keeping, so the body is emptied rather than
hidden.

## 6. Zero means five things, and the page says one

### 6.1 The accounting

`if (!acd) continue` is a hard gate with no accounting, and the `catch` around
`getConversation` is a `console.warn`. So *"No active interactions found
matching the criteria"* currently covers all of:

1. the queue is empty
2. everything was filtered by media type
3. everything was filtered by date
4. the ACD leg is gone — not movable
5. the call failed (403, 404, network)

That ambiguity is what cost four rounds on Disconnect, and the accounting line
was built to remove it:
`1,204 scanned · 0 match · 1,204 media type not selected`.

**Fix:** the preview table gains rows for what was set aside and why, as
Disconnect's does — `Filtered` and `Not movable` alongside `Pending` — and the
status line reports the queue's own depth from `getQueueStats`, which already
exists and already takes media types. A filter that matched nothing must not
look like a queue that was already empty.

The categories are no longer a guess: §6.3's probe names them.

| Row status | Cause | Probe counter | Seen live |
|---|---|---|---|
| `Pending` | movable — waiting in the queue | `wouldMatch` | ✅ 32 of 34 |
| `Being handled` | an agent has it (§6.4) | `byMediaState`, `purposes.agent` | ✅ 2 of 34 |
| `Not movable` | no ACD leg for this queue | `acdLegGone` | not yet |
| `Filtered` | media type not selected | — | — |
| `Filtered` | outside the date range | — | — |
| `Failed` | could not be inspected | `fetchFailed` | not yet |

`Being handled` is its own status rather than a flavour of `Not movable`,
because the two mean opposite things to an operator: one is an interaction doing
fine that Move is deliberately leaving alone, the other is an interaction that
may need attention. Read it per conversation — does it carry an `agent`
participant with live media — rather than inferring from `queueInteracting`,
which is a queue-wide number and cannot attribute itself to rows.

A status line of `0 match · 412 waiting · 412 no active queue leg` is also what
turns §6.3's unanswered half into something production reports on its own.

**Built**, and the line reads:

```
Preview: 2 to move · 4 scanned · 1.204 waiting in queue · oldest waiting 3d
       · 1 no active queue leg · 1 being handled by an agent
```

Each reason appears only when it happened, ordered by how many, and `scanned` is
left out entirely when it equals the number to move — a line reporting that
everything worked should not read like an audit.

Two things came with it. `formatWait` moved to `js/utils.js`, because Move now
wants the same phrasing beside the same queue-depth figure Disconnect prints,
and two copies of a formatter is how two pages come to describe one number
differently. And `detectMediaType` stops being dead code here: a row that cannot
be moved still has a media type worth showing, and `findAcdParticipant` reports
one only for a live leg — the same division of labour Disconnect settled on.

### 6.2 The gate had never met live data — probe first

*(Resolved by §6.4: the gate is right, and for a better reason than expected.
Kept as written because the reasoning that led to the probe is the part worth
reusing.)*

`findAcdParticipant` is byte-identical to Disconnect's, and Disconnect's own
comment records what was measured about it:

> `findAcdParticipant` is kept for the media type it reports on a live ACD leg;
> `detectMediaType` covers the orphans, where that leg is gone.

Disconnect **stopped gating on it**, because on stuck interactions the live ACD
leg is frequently gone. Move gates on it *and* on
`state === "connected" || "alerting"`, and neither has been tested as a
*movability* predicate.

The honest caveat: Move genuinely needs a `participantId` to call
`/participants/{id}/replace`, so a conversation with no live ACD leg may truly
be un-movable. The defect may be entirely in the silence rather than in the
gate. Which it is cannot be reasoned out — every Genesys semantic assumed from
the spec or from existing code on 2026-08-21 turned out wrong, and each was
settled in one round by a probe.

**The probe**, on a real queue with interactions known to be waiting:

```
[move-probe] {
  total,                       // conversations returned by the analytics scan
  withAcdInQueue,              // purpose === "acd" && queue matches
  byMediaState: {…},           // every `state` seen on those legs, counted
  acdLegGone,                  // no acd participant for this queue at all
  wouldMatch                   // what findAcdParticipant returns today
}
```

Cross-checked against `getQueueStats`, exactly as the Disconnect probe was: if
the queue says 169 waiting and `wouldMatch` says 0, the gate is wrong. If
`byMediaState` shows states other than `connected`/`alerting` on legs that are
plainly waiting, that names the fix.

**Shipped.** It adds no API calls to the inspection — it reads the same `conv`
the loop already fetched — and one request for the queue-observation
cross-check, tolerated if the permission is missing. Behaviour is unchanged;
it only logs.

Verified against eight fixtures covering each way a conversation can be dropped
today: an `acd` leg in another queue, no `acd` leg at all, a leg whose media is
`disconnected`, a leg with no media collections, a media item with no `state`,
and a failed fetch. Every counter matched, and the preview returned the same
rows and the same status text as before the probe existed.

### 6.3 What the probe returned — half an answer

Run 2026-08-23 against a live queue of waiting emails:

```
total 6 · inspected 6 · fetchFailed 0
acdAnywhere 6 · acdInQueue 6 · acdLegGone 0 · acdNoMedia 0
wouldMatch 6 · matchedAfterFilters 6
byMediaState { "emails:connected": 6 }
purposes { customer: 6, workflow: 6, acd: 6 }
queueWaiting 6 · queueInteracting 0
```

**Confirmed — and previously only assumed.** A waiting email on an ACD leg
reports `state: "connected"`. That was the load-bearing guess inside
`findAcdParticipant`, inherited from Disconnect and never tested here.

**Confirmed.** The gate agrees exactly with the queue's own observation:
`wouldMatch` 6 against `queueWaiting` 6. No systematic mismatch. And
`acdAnywhere === acdInQueue`, so nothing had passed through this queue and moved
on — the analytics scan returned the waiting set and nothing else.

**Not answered — say so plainly.** `acdLegGone` and `fetchFailed` are both 0,
so this queue held no orphans and the gate was never asked to reject anything.
Every counter that would have signalled a fault reads zero because the
population contained no faults. That is an absence of evidence, not evidence of
absence.

**Incidental.** Every conversation carries a `workflow` participant alongside
customer and acd, consistent with email arriving through a flow. Nothing depends
on it today; recorded because this is the kind of detail that turns out to
matter later.

**And nothing about cost.** Six conversations across six months says nothing
about §7 — that queue is quiet, and the loop was never under load.

### 6.4 The second sample — the gate is precisely right, and load-bearing

A customer queue, 2026-08-23:

```
total 34 · inspected 34 · fetchFailed 0
acdAnywhere 34 · acdInQueue 34 · acdLegGone 0 · acdNoMedia 0
wouldMatch 32 · matchedAfterFilters 32
byMediaState { "emails:connected": 32, "emails:disconnected": 2 }
purposes { customer: 34, workflow: 34, acd: 34, agent: 2 }
queueWaiting 32 · queueInteracting 2
```

The arithmetic closes three independent ways: `wouldMatch` 32 = `queueWaiting`
32; rejected 2 = `queueInteracting` 2 = the number of `agent` participants;
34 = 32 + 2.

**`disconnected` on an ACD leg means an agent took it — not that it is dead.**
The email leaves the queue when it is answered, and the ACD participant's media
ends at that moment. The word says the opposite of what is happening, which is
exactly the class of thing that has cost this work before: `interact` did not
mean agent-held, and `wait` did not exist as a segment type. Measured now, not
guessed.

**The gate is doing safety work nobody had credited it with.** Two rejections
were not near-misses to be recovered — they were interactions an agent was
working, and rejecting them stops Move blind-transferring an interaction out
from under whoever is handling it.

This reverses the working assumption of §6.2, which treated a rejection as a
possible defect. `findAcdParticipant` is **not** merely locating a usable
`participantId`; requiring live media on the ACD leg *is* the "not currently
being handled" test. That must be recorded as intentional, because a later
change to "find any transferable participant" would look like a tidy-up and
would introduce a real defect.

**Still unseen:** `acdLegGone` is 0 in both samples, so the orphan case remains
untested. §6.5 stands — though note it has now been contradicted in the useful
direction: a second sample arrived without anyone hunting for one, and answered
more than the first. Samples that turn up in the course of normal use are worth
reading; it is only *going looking* for an orphan queue that is not worth the
hours.

**Incidental, for §7.** `total` 34 equals the queue's current contents exactly,
so five of the six 31-day windows returned nothing. That is an argument for
sizing the scan to need, and it also means no per-conversation fetch was spent
on historical noise.

### 6.5 Why there is no hunt for an orphan queue

Testing the orphan case properly needs a queue full of stuck interactions, and
inspecting one of those serially — one `getConversation` at a time — is hours.
That is exactly the batching in §7, which was itself meant to be justified by
probe data. Waiting for one to justify the other gets nowhere.

The way out is §6.1: **keep the gate, and make every rejection visible.** The
gate is correct everywhere it has been measured, and unlike a disconnect a
transfer genuinely needs a live participant to replace, so rejecting a
conversation with no ACD leg is probably right rather than merely convenient.
What was never acceptable is doing it in silence.

With the accounting in place, the first queue with orphans in it reports
`0 match · 412 waiting · 412 no active queue leg` instead of "No active
interactions found". Production answers the question, at no cost, and the
operator is not misled in the meantime.

This also unblocks §6.1, which needed the probe for its *categories* rather than
for a verdict — and those it has.

## 7. Cost — after §6, not before

Recorded after §6 rather than guessed before it. Two of the three were built;
the third was declined, and the reason is worth keeping.

### 7.1 Built: the inspection is batched

**Was:** one `getConversation` at a time, so a queue of three thousand meant
three thousand round-trips end to end. **Now:** ten at a time, `REQUEST_BATCH`,
the pacing Disconnect already runs at — the change behind release 4.1's *"A list
of three thousand was a coffee break."*

Batches are awaited in order and their verdicts appended in order, so the table
still reads in scan order and `rowIdx` still points where it should. Verified
across batch boundaries with interleaved verdicts: 23 conversations, 14 movable,
every Pending row became Moved and no other row was touched.

### 7.2 Built: only the windows that hold something are paged

**Was:** six 31-day windows, always, each paged in full. **Now:** each window is
asked whether it holds anything first — one request with a page size of 1, since
the response carries `totalHits` — and only the non-empty ones are paged. This
is what release 4.1 did for Empty Queue.

A queue's unended interactions are usually recent, so most windows are empty.
Measured 2026-08-23: a queue of 34 had every one of them in the newest window,
and the other five were paged for nothing.

**A failed count scans that window anyway.** Reading an error as "empty" would
silently narrow the run, which is the one outcome this page has just been
cleaned of.

### 7.3 Declined: deciding media type before the fetch

Filter for Email only and every voice call in the queue is still fetched, one at
a time, to be thrown away. Both search pages push `mediaType` into the analytics
query; Disconnect reads it from the analytics sessions.

Not taken. The saving needs `getSessionMediaType` on the analytics shape to
agree with `detectMediaType` on the live conversation object, and those read
different structures — a disagreement drops movable interactions silently, which
is the exact failure this page has just spent four commits removing. The gain
only materialises when someone filters by media on a mixed queue, and neither
probe sample was one. §7.1 already removes most of the cost that made it look
attractive.

Worth revisiting only with a measurement showing the fetches actually hurt, and
then behind a check that the two media readings agree.

### 7.4 Built: the inspection asks before it spends

Above **250 conversations**, before inspecting any of them:

> 12.400 unended interactions were found in this queue.
>
> Previewing them means reading each one — about 5m.
>
> Continue?

The same question Recent Search asks before loading participant data, at the
same threshold and with the same arithmetic — one request per conversation, ten
at a time, roughly a quarter-second a batch. A queue of ordinary size never sees
it.

**Asked after the scan, not before it.** The window counts from §7.2 arrive
earlier and would allow the question sooner, but they are a sum over windows and
the analytics interval matches on *activity*, so a long-running conversation
appears in several of them. On a page about interactions stuck for weeks that
overstates badly. `rawConvIds` is deduplicated and exact, and the paging it
costs is bounded and cheap now that empty windows are skipped.

Declining is neither an error nor an empty queue, and the status says which:

> Preview not run — 12.400 interactions to inspect. Narrow the media types or
> the date range, or run Preview again to read them all.

### 7.5 Built: the 20,000 cap is gone

`maxPages: 200` truncated at 20,000 conversations per window — `pageSize` is
100 — and the pager could not distinguish "that was everything" from "that was
the first 20,000". The query runs newest-first, so a truncated window dropped
the **oldest**: exactly the interactions this page exists to shift.

A warning about it was proposed first and rejected in favour of the better fix —
*"I dont want the limit of 20000"* — which is right. A scan that quietly answers
a different question than the one asked is the fault the rest of this document
is about; announcing it would have been managing the symptom.

`maxPages: Infinity`, and the pager gains `shouldStop`, checked between pages.
Unbounded without an exit would be a trap: Cancel previously took effect only
between windows, so a single large window could not be interrupted at all. It
now stops at the next page boundary.

The scan also counts out loud — `Scanning interval 1 of 2 — 4.200 found…` —
because a window with tens of thousands in it pages for a while, and a status
line that does not move reads as a page that has died.

**The confirmation in §7.4 is unaffected and still the gate that matters.**
Paging costs one request per *hundred* conversations; the inspection costs one
per conversation. Removing the cap makes the cheaper half complete rather than
truncated — 25,000 interactions is 250 pages, against 25,000 reads if you say
yes. That is why the question is still asked where it is, after the exact count
is known, rather than moved ahead of the paging.

**Disconnect has the identical cap** at
[disconnect.js:1051](../js/pages/interactions/disconnect.js), still unaddressed.
Its queue mode does not fetch per conversation, so a truncated scan there is
cheaper to fix and differently shaped; worth its own look rather than a copied
change.

## 8. Smaller

- `detectMediaType` is dead here — a copy of Disconnect's, which does use it.
- `populateQueueSelect`'s `$search` parameter is never read. Both disappear with
  §4.1.
- `logAction` fires even when the move was cancelled before the first transfer:
  "Moved 0 interactions", count 0, result `partial`.
- `findAcdParticipant`, `detectMediaType` and `MEDIA_TYPES` are duplicated
  between Move and Disconnect. The same argument that produced
  `js/lib/participantData.js` applies, and the same caution: extract only once
  §6.2 has settled whether the two pages still want the *same* function.

## 9. Not in scope

- The results table's columns, and the pacing of the move loop.
- Anything about the destination queue's suitability — Genesys errors per
  interaction and the Failed rows already carry the reason.

## 10. Build order

Ordered to avoid doing work twice, not by urgency — nothing reaches production
until Move is finished, so there is no case for landing the safety fixes early.

1. **The probe** (§6.2). ✅ First, because it is the only step that needs a real
   org and someone else's time, and because its answer decides step 5's
   categories. Preview-only; nothing is transferred.
2. **Layout, the warning banner, and the Move gate** (§4, §5.2). ✅ §5.2 and
   §4.3 are the same edit to the same actions row, so splitting them would mean
   touching that row and reviewing that button twice.
3. **The remaining guard-rails** (§5.1, §5.3), wired to the controls that will
   actually exist. ✅ This is the real reason not to do safety first: attaching
   `invalidateCandidates` to the native selects and deleting that wiring one
   commit later means writing and testing the same behaviour twice.
4. **The accounting** (§6.1), designed on what the probe returned. ✅ The probe
   comes out in the same commit: it existed to name these categories, and the
   page reports them properly now.
5. **Cost** (§7). ✅ 7.1, 7.2, 7.4 and 7.5 built; 7.3 declined with the reason
   recorded.
6. **Release note** — one entry; `interactions.move` is not on
   `CUSTOMER_EXCLUDED_KEYS`, so this is customer-visible. ✅ Shipped as 4.3,
   with the throbber alignment across the four interaction pages folded in.

An earlier version of this list put the probe fourth and split the layout from
the guard-rails. Both were wrong for the same reason: they ordered by how the
findings were written up rather than by what each step depends on.
