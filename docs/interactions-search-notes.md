# Interactions › Search — findings, for discussion

Status: **§1 resolved — negative result.** Server-side participant-data
filtering was built, tested and reverted; see §1. The rest is still notes.
Author: Genesys Admin App
Last updated: 2026-08-22

Recorded after the Disconnect work of 2026-08-21, several of whose lessons apply
directly here. See [disconnect-email-filter-design.md](disconnect-email-filter-design.md)
and [disconnect-empty-queue-design.md](disconnect-empty-queue-design.md).

## 1. Participant data CANNOT be filtered server-side — tried, wrong

This section originally claimed the opposite. It was built (`b4a066e`), tested
against a real attribute, and reverted (`4074bff`). Recorded in full because the
wrong answer looked well-evidenced at every step.

### 1.1 What happened

A `property` predicate on `segmentFilters`:

```json
{ "type": "property", "propertyType": "string", "property": "UD_Language", "value": "DK" }
```

Genesys returned **nothing at all** — "No conversations found for the selected
date range", meaning zero *fetched*, not zero matched — where the client-side
filter on the same attribute finds six of seven. The server was the stricter of
the two, dropping rows `filterByPD` would have kept. That is the one outcome
this could not have, so it came straight back out.

### 1.2 Why: attributes are not on a segment

`AnalyticsParticipant.attributes` exists. `AnalyticsSession.attributes` and
`AnalyticsConversationSegment.attributes` do **not**. And the query offers
`conversationFilters`, `segmentFilters`, `evaluationFilters`, `surveyFilters`
and `resolutionFilters` — **there is no participant-level filter at all**.

So participant attributes sit on the one object the query cannot filter on. A
`property` predicate under `segmentFilters` addresses some segment property,
whatever that is; it does not reach participant data. The whole premise of this
section was wrong, and it explains why `search.js` has always filtered
client-side and why the forum carries threads asking how to do this.

### 1.3 Three wrong answers, and what each was based on

Worth listing, because each looked sound:

1. **"It can't be done server-side"** — right conclusion, wrong reason. Argued
   from `ConversationDetailQueryPredicate` having no attribute dimension, having
   not noticed the `property` kind at all.
2. **"It can, via a property predicate"** — the `property` predicate is real, and
   the reasoning about separate `segmentFilters` entries was sound. The premise
   that it addresses participant attributes was not, and nothing in the spec
   says otherwise either way.
3. **"It's case sensitivity"** — from reading `UD_LANGUAGE` off the results
   table. But `.is-expand-key` carries `text-transform: uppercase`, so that
   display says nothing about the stored casing. The Genesys UI shows the real
   key is `UD_Language`, which had already been tried exactly. Casing was never
   involved.

The documentation could not settle any of it (§1.4), so each step needed a live
test, and two of the three tests only ruled something out rather than pointing
at the answer.

### 1.4 The documentation cannot be consulted on this

Checked on 2026-08-22, not assumed. Every Genesys developer surface returns an
SPA shell to a fetch — `developer.genesys.cloud` (docs and forum, including the
Discourse `/raw/` and `.json` routes) and `developer.dev-genesys.cloud`.
`help.genesys.cloud` renders, but it is the end-user Resource Center and says
nothing about predicates; its one useful fact is that **participant data has a
60-day TTL**, after which it is reachable only via export — relevant to a page
offering a six-month range. No public GitHub repository carries the
developer-center content.

### 1.5 The one server-side route that exists

```
POST /api/v2/conversations/participants/attributes/search
```

Permission `conversation:participant:attributesview`. Takes a `query` array of
criteria with `fields`, `value`/`values`, `type: EXACT | DATE_RANGE` and
`operator: AND | OR | NOT`, cursor-paged.

Genesys documents that for this endpoint **only AND is supported — OR and NOT
are not**, and `type` is `EXACT` or `DATE_RANGE`, so neither exclude mode nor
"key present, any value" is any better served than by the client filter. Being a
search rather than an analytics endpoint, it does not compose with the interval,
queue, direction, media and division filters this page already sends: it would
be a second query whose conversation ids had to be intersected with the
analytics results.

That is a different feature, not an optimisation of this one. Recorded as an
option; not recommended without a concrete need.

### 1.5a The two capabilities that must survive any attempt

Stated as a requirement on 2026-08-22, and it disqualifies the endpoint above:

1. **The scope filters** — date range, queue, direction, media type, division —
   applied together with the participant-data filter, in one search.
2. **Key-only search** — "this attribute is present, whatever its value".

`/conversations/participants/attributes/search` fails both: `type` is `EXACT` or
`DATE_RANGE` so it cannot express key-only, and being a search rather than an
analytics endpoint it does not carry the scope filters, so results would have to
be intersected with a second query.

The current client-side filter is the only approach that does both, which
settles it: it stays, and any future attempt has to clear this bar before being
worth building.

### 1.6 Where that leaves the page

Exactly where it started, and the client-side filter is no longer a stopgap but
the answer — it is the only thing that satisfies §1.5a.

If the ~26 job cycles on a long range become the complaint, see §5 before
assuming the chunk size is the lever — it is load-bearing, for a reason. A six-month search still fetches the range and filters in the
browser, and the ~26 async job cycles stay. If that becomes the problem, the
lever is the **chunk size** (§5) rather than the filtering.

## 2. `filterByPD` required every filter on one participant — fixed

The loops were the wrong way round:

```js
conv.participants.some((p) => filters.every((f) => …))   // was
filters.every((f) => participants.some((p) => …))         // now
```

With one filter the two are identical, so this only bit when a second was
added — and then silently. Attributes are routinely split across legs, so a
flow-set attribute plus an agent-set one could never match, and the result was
indistinguishable from "nothing found". Reported as a recurring "I know this
interaction has both" failure, which is what settled it.

The clinching argument was that the page **displays** attributes merged across
participants — `attrMap` in the expanded row gathers every participant's
attributes into one set — so the row could show both attributes while the filter
insisted the conversation did not have them. A merged view filtered against an
unmerged one.

**What was given up.** On transferred or conferenced interactions there can be
several external participants who are genuinely different people, and the strict
form stopped `CPR` from one combining with `UD_Language` from another. That
guard is gone. Judged the lesser problem: failing to find an interaction that
exists happens in practice, and a slightly over-broad match on a conference does
not.

## 3. A null attribute value killed the whole search — fixed

The case-insensitive lookup was written out **four times**, and three of those
went straight on to call `.toLowerCase()` or `.split(",")` on the raw value:
`filterByPD`, the selected-participant-data export, and the value distribution
chart. The expanded row was safe only by accident, because `join()` coerces.

The spec types attributes as `additionalProperties: {type: string}`, so a `null`
should never arrive — but if one did, `filterByPD` would throw for the **entire
result set** rather than one row, turning a search into an error.

All four now go through one `attrValue(attrs, keyLower)` helper that returns a
string, or `null` when the participant does not carry the attribute. A
present-but-null attribute reads as an empty string, so the key still counts as
present, which is what a key-only filter asks about. Non-string values coerce
too — a numeric attribute like `IVR.PRIORITY` is now filterable, where before it
would have thrown.

## 4. A comment that is wrong in the expensive way

```js
// (The analytics API interval matches on end time, not start time)
```

`AsyncConversationQuery.interval`: *"Results will include all conversations that
had **activity** during the interval."* Not end time, not start time.

The code is right — the client-side re-filter on `conversationStart` is
load-bearing, since a conversation that started months earlier but had activity
in the window really is returned. Only the stated reason is wrong. Recorded
because `getQueueWaitInfo`'s non-existent `"wait"` segment type cost four rounds
on Disconnect, and a confidently wrong comment is how that happens.

## 5. Smaller

- **Chunk size is 7 days here, 31 on Disconnect — and that comparison was
  wrong.** Corrected 2026-08-22. The reason is real and recorded in `c11aa90`:
  *"Reduce analytics job result pageSize from 10000 to 2000 to stay within Azure
  SWA 45s proxy timeout per request; split date ranges into 7-day chunks."* The
  45-second cap applies to anything through `/api`, async job or not — it is the
  proxy, not the API.

  Disconnect gets away with 31 days because its queries are **always** filtered,
  by `queueId` and `conversationEnd notExists`, so its result sets are small by
  construction. Search can run unfiltered across every queue, where one week
  alone can be tens of thousands of conversations. Same API, entirely different
  volume risk.

  Note also that `c11aa90` changed two things at once — the page size and the
  chunking — so which of them actually fixed the timeout is not known. Widening
  the chunks is therefore **not** a free lever: it would need testing against an
  org with a genuinely large unfiltered week, and the honest first step would be
  to establish which of the two mitigations is load-bearing.
- **"Export selected participant data" in exclude mode** — the conversations kept
  are the ones that did *not* match, and the export then collects values for
  those same keys. Worth checking what it produces: possibly empty, possibly a
  list of non-matching values presented as if selected.

## 6. How to approach it, if it is taken on

Treat it as the address filters were treated: build the client-side path as the
correctness boundary, add property predicates as an optimisation on top, and
verify with one search against a queue where an attribute's value is already
known before designing anything further.

Every Genesys semantic assumed from the spec's wording or from existing code on
2026-08-21 turned out wrong — the `wait` segment type, `oLongestWaiting` as a
duration, `interact` meaning agent-held, and the queue-observation detail cap.
Each was settled in one round by a probe. Assume nothing here until it has been
seen working.
