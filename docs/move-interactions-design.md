# Interactions › Move — layout and safety — Design

Status: **Proposal.** Nothing built. §2 records what has been decided; the rest
needs a go-ahead, and §6.2 needs a live probe before it is designed further.
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

### 6.2 The gate itself has never met live data — probe first

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

Nothing in §6.2 is designed further until that has been seen.

## 7. Cost — after §6, not before

Recorded now, deliberately not scheduled: how much of this is worth doing
depends on what the probe says about how many conversations reach step 2 at all.

- **Step 2 is serial** — one `getConversation` per conversation. Disconnect's
  `REQUEST_BATCH = 10` gave roughly an eight-fold speedup on this exact loop.
- **Media type is decided after the fetch.** Filter for Email only and every
  voice call in the queue is still fetched, one at a time. Both search pages
  push `mediaType` into the analytics query; Disconnect reads it from the
  analytics sessions. Either avoids the call entirely.
- **Always six 31-day windows**, never sized to need — the thing release 4.1
  fixed for Empty Queue. And `maxPages: 200` truncates at 20,000 per window
  without saying so.

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

1. **The queue dropdowns** (§4.1) with `invalidateCandidates` wired to both,
   plus the media and date controls (§5.1). Layout and the first safety fix in
   one commit, because the hook arrives with the component.
2. **Preview leads, Move greyed until previewed** (§4.3, §5.2), and a cancelled
   preview clears (§5.3). The three guard-rails together.
3. **The warning banner** (§4.4). Independent, one block of markup.
4. **The probe** (§6.2), against a real queue. No page changes.
5. **The accounting** (§6.1), designed once the probe has said what the
   categories actually are.
6. **Cost** (§7), if the probe says it is worth it.
7. **Release note** — one entry; `interactions.move` is not on
   `CUSTOMER_EXCLUDED_KEYS`, so this is customer-visible.

Steps 1–3 are the whole visible change and can be reviewed together. Step 4 is
the gate on everything after it: §6.1's categories are exactly what the probe
returns, so designing them first would be guessing twice.
