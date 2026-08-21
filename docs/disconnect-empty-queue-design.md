# Disconnect — Empty Queue — Design

Status: **Revised — awaiting go-ahead on §2**
Author: Genesys Admin App
Last updated: 2026-08-21

Companion to [disconnect-email-filter-design.md](disconnect-email-filter-design.md),
which covers the address filters and the defects fixed alongside them.

## 0. What changed, and why

An earlier revision of this document had Empty Queue source its candidates from
real-time queue observations: one request, no analytics, and the queue's live
contents by definition. It was built and is currently deployed.

It fails on the only thing that matters in a preview. **The observation detail
list is capped at 100** — and a capped list is not the first 100, it is the
oldest half plus the newest half with the middle missing. There is no way round
it: `QueueObservationQuery` has no paging, its filter accepts only `queueId` and
`mediaType`, so a queue cannot be sliced into under-cap chunks, and it cannot
filter on address at all. Re-querying returns the same rows.

So on a queue of 3,091 the preview could only ever say "4 of the 100 we happened
to receive match your filter", which answers nothing. Emptying such a queue
meant thirty-odd manual passes.

Complete counts have to come from analytics, which pages properly, has no cap,
and takes the address predicates server-side. This revision goes back to
analytics for enumeration and keeps observations for what they are genuinely
good at: the exact depth, the age of the oldest wait, and whether anything is
live right now.

## 1. Confirmed decisions

- **Analytics enumerates the candidates.** Conversations in the queue with no
  `conversationEnd` — the original population. Conversations that are unended
  but no longer queued are therefore in scope again, including the two on
  `Intervare - Email - Fejl`.
- **Observations supply context, not candidates.** `oWaiting` for the depth,
  `oLongestWaiting` for the age, `oInteracting` for whether anything is live.
  No `detailMetrics`, so the 100-row cap stops mattering at all.
- **The recent phase stops calling `getConversation` per result.** It fetches
  one conversation per row purely to read the media type, which the analytics
  response already carries on its sessions along with `addressFrom` and
  `addressTo`. On 3,091 rows that is 3,091 round-trips that never needed to
  happen. The historical phase dropped them in `b52b0be`; the recent phase
  never followed.
- **The scan window stays the full six months.** Sizing it by the queue's oldest
  wait was tried and reverted (§4 of the companion design): the age describes
  the waiting population and this scan's population is the unended one, which
  `Intervare` proved are different sets.
- **Preview reports complete counts.** `47 match · 3.091 waiting in queue ·
  3.044 sender does not match` — every figure describing the whole queue, not a
  sample of it.

## 2. The live-agent question, reopened

Sourcing from `oWaiting` had excluded live interactions by construction: an
interaction an agent is handling is `oInteracting` and simply was not in the
set. Enumerating from analytics loses that, and the guard becomes a real
decision again — the one left unresolved earlier in the session.

Recall the shape of it: `hasActiveAgentSegment` was removed in `549dbc3`
because an orphan's segments are often left unclosed for the same reason
`conversationEnd` was never written, so the guard skipped exactly the
interactions the page exists for.

**Proposal, using the count we now fetch anyway:**

- **`oInteracting` is 0** — nothing in the queue is live, so any unclosed
  `interact` segment is stale. Nothing is excluded, and orphans are all found.
  This is the normal case: it was true of `Intervare`, and of `Nemlig`.
- **`oInteracting` is greater than 0** — exclude candidates carrying an open
  `interact` or `alert` segment, and say so: `3.087 match · 4 excluded, agent
  connected`.

The error then only ever falls one way. When live interactions exist we may
over-exclude and skip a few orphans, which is recoverable by re-running once the
agents are done. We never disconnect something a customer is talking to, which
is not recoverable.

It does not cover an interaction going live between preview and Disconnect.
Closing that means re-checking at execution time, which is a larger change;
recorded here as a known gap rather than assumed away.

**This is the one item needing a decision before build.**

## 3. Where each number comes from

| | Source |
|---|---|
| Candidates, and every match/skip count | Analytics — sync for the recent 48h, async jobs beyond |
| Queue depth (`3.091 waiting in queue`) | `oWaiting` |
| Age (`oldest waiting 23h`) | `oLongestWaiting` — an epoch timestamp, not a duration (§6.1 companion) |
| Live interactions | `oInteracting` |

One observations request, stats only:

```json
{ "filter": { "type": "and", "clauses": [ … ] },
  "metrics": ["oWaiting", "oInteracting", "oLongestWaiting"] }
```

## 4. Filters

All four filters return to their original meanings, since analytics carries
`conversationStart` again:

| Filter | Source |
|---|---|
| Media Types | `session.mediaType` |
| Sender / Recipient | `session.addressFrom` / `addressTo`, **plus server-side predicates** |
| Older / Newer than | `conversationStart` — labels revert to "Older than" / "Newer than" |

The mode-aware date labels added for the observation source come back out. The
address predicates stay: they are confirmed working, and on a filtered preview
they are the difference between Genesys returning 4 rows and returning 3,091.

## 5. Speed

A filtered preview is a handful of requests, because the predicates do the
narrowing server-side. An unfiltered one on 3,091 is about 31 pages of 100 in
the recent phase plus the historical jobs.

The six async jobs remain the floor on an unfiltered scan. One idea, untested
and not part of this change: with predicates cutting the result size, the
**synchronous** query may now suffice for the historical intervals too, which
would remove the submit-poll-fetch cycle entirely. It 502s past ~8,000
conversations (`b52b0be`), which a filtered query will not approach — so it
could be used when filters are set and the async path kept when they are not.

## 6. Build order

1. **Observations back to stats only** — add `oInteracting`, drop
   `detailMetrics`. Truncation handling goes with it.
2. **Analytics enumerates again** — restore the two-phase scan, *without* the
   per-conversation `getConversation` calls, with the address predicates.
   Date filters and labels revert with it.
3. **Live-agent handling** — per §2, once decided.
4. **Cleanup** — whatever is unreachable after 1–3, deleted rather than left.
5. **Release note** — folded into 4.1, and the page description reviewed.

Steps 1 and 2 are the functional change and can be tested on `Nemlig`
immediately; the filtered count is the thing to check.
