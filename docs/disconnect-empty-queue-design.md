# Disconnect — Empty Queue — Design

Status: **Revised (2) — §§6-7 awaiting build**
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

- **Analytics enumerates the candidates**, and the candidates are the ones
  **actually waiting**: no `conversationEnd`, *and* an open `wait` segment for
  this queue (§6). Enumeration and population are separate choices, and
  conflating them is what sent this design round twice.
- **The scan window is probed, not assumed** (§7).
- **Observations supply context, not candidates.** `oWaiting` for the depth,
  `oLongestWaiting` for the age, `oInteracting` for whether anything is live.
  No `detailMetrics`, so the 100-row cap stops mattering at all.
- **The recent phase stops calling `getConversation` per result.** It fetches
  one conversation per row purely to read the media type, which the analytics
  response already carries on its sessions along with `addressFrom` and
  `addressTo`. On 3,091 rows that is 3,091 round-trips that never needed to
  happen. The historical phase dropped them in `b52b0be`; the recent phase
  never followed.
- **The scan window is no longer a fixed six months** — see §7. The earlier
  attempt keyed on the queue's oldest wait and was reverted because it measured
  a different population from the one being scanned; probing measures the same
  one.
- **Preview reports complete counts.** `47 match · 3.091 waiting in queue ·
  3.044 sender does not match` — every figure describing the whole queue, not a
  sample of it.

## 2. The live-agent guard — decided, built (`e06ccab`)

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

## 6. Restricting to what is actually waiting

`2 match · 0 waiting in queue` on `Intervare - Email - Fejl` is not a rounding
error. It is two different populations printed side by side: the match count
comes from analytics — conversations with no `conversationEnd` — and the depth
comes from observations — what is waiting. The two figures are not comparable,
which is why the line reads as broken even though both numbers are correct.

**A conversation is waiting in this queue when it has no `conversationEnd` *and*
an open `wait` segment for this queue.** Open meaning `segmentEnd` absent: the
wait has not finished. That is the definition analytics can express, and it is
the one `oWaiting` counts.

Consequences:

- `Intervare` reports **0 match**, because its two have closed segments. What
  the operator sees agrees with what the queue holds.
- **Not-waiting conversations are dropped silently, not counted as skips.** They
  were never candidates, so reporting them as exclusions would claim they were
  in scope and got filtered — a different statement, and a false one. If
  nothing is waiting, nothing is waiting. Genuine exclusions — media type,
  date range, address, agent connected — are still counted and named.
- The two figures become directly comparable. On an unfiltered preview,
  `3.091 match · 3.091 waiting in queue` should agree, and a divergence becomes
  a signal worth noticing rather than noise. Small differences are expected —
  the two calls are made moments apart against a live queue.
- Unended-but-not-waiting conversations leave Empty Queue's scope again, and are
  reachable through Multiple IDs. This is the remit as originally asked for,
  "I only want to disconnect what's on the queue", reached through analytics
  rather than observations so the counts stay complete and uncapped.

This is `getQueueWaitInfo`, removed in `be600f7` as *"remove getQueueWaitInfo
gate, match all active convos"*. It was wrong then, when the remit was finding
orphans; it is right now, when the remit is emptying a queue. One difference:
the original deliberately did **not** check `segmentEnd`, precisely so it would
still catch conversations whose segment Genesys had closed. Here that check is
the whole point.

**The discriminator is `purpose`, not `segmentType`.** This took two wrong
attempts and a probe against a live queue to establish, so the observed shape is
recorded here rather than left to be rediscovered. Every one of 169 waiting
emails looked like this:

```
{ purpose: "external", segmentType: "interact", open: true  }
{ purpose: "workflow", segmentType: "interact", open: false }
{ purpose: "acd",      segmentType: "interact", open: true, queueId: "1d59140c…" }
```

For email there is **no `delay` segment and nothing called `wait`**. The ACD
leg's segment reads `interact` for the entire time the email sits in the queue.

The two failed attempts both keyed on `segmentType`:

1. `segmentType === "wait"`, copied from `getQueueWaitInfo` without checking it.
   `AnalyticsConversationSegment.segmentType` has twenty-two values and no
   `wait` among them, so it matched nothing: `0 match · 169 waiting in queue`.
   This very likely explains `be600f7` removing that gate as "match all active
   convos" — it was broken, not too strict.
2. Treating `interact`/`alert` as agent-held. True of *every queued email*, so
   it would have excluded whole queues. This very likely explains `549dbc3`
   removing `hasActiveAgentSegment` for the same reason.

**The rule, then:** a conversation is waiting in this queue when the participant
with `purpose === "acd"` has a segment for this queue with `segmentEnd` absent.
The queue leg is still open, so the interaction has not left the queue. One that
moved on, or died, has that segment closed — which is what keeps `Intervare`'s
two out.

The live-agent guard moves to `purpose` as well: an open segment on an `agent`
or `user` participant. **Inferred, not observed** — the probe ran against a
queue with nothing live in it. It is consulted only when `oInteracting` is
non-zero, and the ACD-leg test already excludes anything that has left the
queue, so it is a second line rather than the only one.

**What caught this:** the cross-check in this section, on its first run against
a real queue. Before match and depth described the same population, a test that
matched nothing was indistinguishable from a queue with nothing in it.

## 7. Sizing the scan by probing

The window is six months because an earlier attempt to size it was reverted.
That attempt keyed on `oLongestWaiting`, which describes the waiting population
while the scan enumerated the unended one — a different set, so the age could
silently cut the scan short of real orphans.

Probing does not have that flaw, because it asks about **the same population,
with the same filters**. The synchronous query returns `totalHits`, so one
request per interval with `pageSize: 1` gives the exact number of matching
conversations in that interval:

```json
{ "interval": "…/…", "paging": { "pageSize": 1, "pageNumber": 1 },
  "segmentFilters": [ queueId, "…address predicates" ],
  "conversationFilters": [ { "conversationEnd": "notExists" } ] }
```

An interval whose probe returns 0 needs no async job. On both queues seen so far
that collapses six submit-poll-fetch cycles to one or two, and on a filtered
preview very likely to none — the address predicates narrow the probe exactly
as they narrow the scan.

Six small probes can run concurrently, so the cost is roughly one round-trip.

**A failed probe must scan, never skip.** If the probe errors or returns no
usable `totalHits`, that interval is scanned as it is today. The failure mode is
"slower than it needed to be", never "quietly searched less".

**Unknown:** whether the synchronous query will answer a 31-day interval at all.
It 502s past ~8,000 conversations (`b52b0be`), which is about response size;
`pageSize: 1` should avoid that, but `totalHits` is still computed server-side.
The fallback above covers it either way.

**Also worth checking, separately:** the recent 48 hours is cut into eight
six-hour buckets, but `queryConversationDetails` already pages internally, so
those eight requests may be doing one request's work. Introduced in `38adad9`
without a stated reason — to be understood before being changed, not assumed
redundant.

## 8. Build order

1. ~~**Observations back to stats only**~~ — done, `e06ccab`.
2. ~~**Analytics enumerates again**~~ — done, `e06ccab`.
3. ~~**Live-agent handling**~~ — done, `e06ccab`.
4. **Restrict to what is waiting** (§6). A behaviour change: `Intervare` goes to
   0, and match becomes comparable to depth. Test on both queues — the
   unfiltered Nemlig figures agreeing is the verification.
5. **Probe the intervals** (§7), with the scan-on-probe-failure fallback.
6. **Investigate the eight recent buckets** (§7), and collapse them only if the
   reason they exist turns out not to apply.
7. **Cleanup** — whatever is unreachable, deleted rather than left.
8. **Release note** — folded into 4.1, and the page description reviewed: it
   still says "stuck or orphaned conversations", which after §6 describes the
   ID modes rather than this one.

Step 4 is a behaviour change and worth its own test round. Step 5 is pure speed
and cannot change what is found, as long as the fallback holds.
