# Disconnect — Empty Queue from live queue state — Design

Status: **Proposed** — awaiting go-ahead
Author: Genesys Admin App
Last updated: 2026-08-21

Companion to [disconnect-email-filter-design.md](disconnect-email-filter-design.md),
which covers the address filters and the defects fixed alongside them. This one
changes what **Empty Queue** means.

## 1. Purpose

Empty Queue currently reconstructs the queue's contents from analytics history:
a synchronous scan of the last 48 hours with a `getConversation` per result,
then six async jobs covering six months, matching every conversation with no
`conversationEnd`. On a queue of 3,000 that is minutes of submitting, polling
and fetching.

It should instead ask the queue what it is holding. One request to real-time
queue observations returns every waiting interaction with the identifiers and
addresses this page needs.

The change is not primarily about speed. It is that **the page has been
answering a different question from the one the operator is asking.** "Empty
this queue" means the interactions sitting in it now. "Every conversation in
this queue that never got an end written" is a different set, and the gap
between them is where this session's problems have lived: whether orphans are
visible to observations, how far back to scan, whether a live interaction might
be swept up. Asking the queue directly dissolves all three rather than solving
them.

## 2. Confirmed decisions

- **Empty Queue targets what is on the queue now**, not every unended
  conversation. A conversation that is unended but no longer queued is out of
  scope for this mode — and out of scope explicitly, rather than by an
  assumption about what `oWaiting` happens to see.
- **Waiting only, not interacting.** `oWaiting` counts interactions sitting
  unassigned. Anything an agent is handling is `oInteracting` and is therefore
  not in the set at all. This is what makes the live-agent guard discussed at
  length unnecessary: the dangerous population is excluded by the query rather
  than filtered out afterwards.
- **The date filters become "waiting since"** (§5). The observation knows when
  an interaction started waiting, not when the conversation began. Relabelled
  rather than quietly repurposed.
- **Truncation is reported, never hidden** (§6).
- **Single and Multiple ID modes are untouched.** They keep `getConversation`
  plus the analytics detail lookup, and remain the way to reach a conversation
  that is not on the queue.

## 3. What the operator sees

Queue mode gains nothing new on screen and loses nothing, except that the two
date fields read **Waiting longer than** / **Waiting less than**.

The status line keeps its present shape:

```
4 match · 3.091 waiting in queue · oldest 23h
```

`oldest` now comes from the data itself — observations are returned sorted by
timestamp ascending, so the first is the oldest — replacing the
`oLongestWaiting` metric and its epoch-versus-duration ambiguity.

A preview that returns quickly is the point, so nothing needs to explain itself
the way the sized scan did.

## 4. Where the data comes from

```
POST /api/v2/analytics/queues/observations/query
{
  "filter": { "type": "and", "clauses": [
      { "type": "or", "predicates": [{ "dimension": "queueId",   "value": "…" }] },
      { "type": "or", "predicates": [{ "dimension": "mediaType", "value": "email" }] } ] },
  "metrics":       ["oWaiting"],
  "detailMetrics": ["oWaiting"]
}
```

`metrics` gives the exact depth; `detailMetrics` gives one `ObservationValue`
per waiting interaction, carrying `conversationId`, `addressFrom`, `addressTo`,
`observationDate`, `direction`, `ani`, `dnis` and `participantName`.

Requires `analytics:queueObservation:view` — already needed for the queue depth
shipped in the companion design, so no new permission.

Neither of the reasons the two-phase scan exists carries over. The async phase
exists because the synchronous analytics query *"502s at 8000+ conversations via
Azure SWA proxy timeout"* (`b52b0be`); the recent phase exists because of
*"async analytics ingestion lag for today's interactions"* (`38adad9`). Both are
properties of querying analytics history. An observation is live queue state:
nothing to ingest, no window to page through.

## 5. Filters

| Filter | Today | After |
|---|---|---|
| Media Types | client-side on session `mediaType` | server-side predicate on the query |
| Sender / Recipient | `session.addressFrom` / `addressTo` | `ObservationValue.addressFrom` / `addressTo` |
| Older / Newer than | `conversationStart` | `observationDate` — **relabelled "waiting longer/less than"** |

All four keep working. The address filters arguably improve: the values come off
live queue state, so the analytics ingestion lag that makes an ID-mode lookup
report "not yet available" cannot apply.

The date change is the only real shift. For an email that arrived and sat, time
waiting and time since the conversation started are the same. They diverge only
when an interaction was requeued after an agent had it — and for emptying a
queue, "waiting more than 7 days" is the more apt question anyway.

`conversationStart` is lost, but costs nothing visible: Start Time is only shown
in the ID-mode results table, which is not changing.

## 6. Truncation

`ObservationMetricData.truncated` flags a capped list, and the cap's value is
not documented. The behaviour when it trips is documented and matters:

> If truncated, the first half of the list of observations will contain the
> oldest observations and the second half the newest observations.

So a capped result is **not** the first N — it is the oldest half plus the
newest half, with the middle missing.

Handling:

- The **depth is always exact.** It comes from `metrics`, which truncation does
  not affect. `3.091 waiting in queue` stays true however few rows come back.
- When truncated, the status says so — `3.091 waiting in queue · 1.000 shown` —
  and the confirmation names the same figure. The operator never believes they
  are acting on the whole queue when they are not.
- **Re-running drains it.** Each pass removes interactions from both ends, so
  the hidden middle shrinks and a second pass reaches it. Emptying a large queue
  becomes a small number of passes rather than one long scan. This is worth
  saying out loud in the status rather than leaving to be discovered.

## 7. What this gives up

**Conversations that are unended but no longer on the queue.** Concretely, the
two found on `Intervare - Email - Fejl` against a depth of 0 waiting. Under this
design Empty Queue would report that queue as empty and offer nothing.

That is the intended remit change, not a regression — but it is the one thing to
be sure about, because the page's own description still says "stuck or orphaned
conversations" and that wording will need to change with it. Those conversations
remain reachable through Single and Multiple ID mode, which is where a
conversation identified by other means has always belonged.

## 8. What stays

The preview gate, the confirmation naming the address filters, the Activity Log
entry, the batching at ten concurrent, Cancel between batches, and both ID
modes. This changes where queue-mode candidates come from, and nothing else.

## 9. Unknowns

| Unknown | Handling |
|---|---|
| The truncation cap | Reported when it trips (§6); never silently absorbed |
| Whether `observationDate` is queue-entry time or sample time | Verify against a queue with a known-age interaction before the relabel is trusted |
| Whether email-to-case interactions carry `addressFrom` here | Expected empty, as in analytics. The sender filter will not help for those either way — this design does not change that, and does not pretend to |

## 10. Build order

Each step a separate commit, with a pause to test on dev.

1. **`getQueueWaitingDetails`** in `genesysApi.js` — the observation call with
   both metric kinds, returning `{ waiting, truncated, observations }`. No
   caller yet.
2. **Queue mode reads it** instead of `scanQueue`, with the existing address and
   media filters applied to the returned observations. Date filters left alone
   for the moment.
3. **Date filters relabelled** and repointed at `observationDate`.
4. **Truncation reporting** in the status and confirmation.
5. **Remove what is now dead** — `scanQueue`, and any of `queryConversationDetails`
   / `searchConversations` / the interval constants no longer reachable from this
   page. Per §8.5 of the companion design: deleted, not left unreachable.
6. **Page description and release note** — the "stuck or orphaned" wording, and
   one entry folded into 4.1.

Step 1 and 2 together are the whole functional change and can be tested on the
Nemlig queue immediately; 3 through 6 are refinement.
