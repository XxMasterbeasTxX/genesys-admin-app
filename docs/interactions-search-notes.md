# Interactions › Search — findings, for discussion

Status: **Notes only** — nothing built, nothing decided
Author: Genesys Admin App
Last updated: 2026-08-21

Recorded after the Disconnect work of 2026-08-21, several of whose lessons apply
directly here. See [disconnect-email-filter-design.md](disconnect-email-filter-design.md)
and [disconnect-empty-queue-design.md](disconnect-empty-queue-design.md).

## 1. Participant data can be filtered server-side

`filterByPD` runs in the browser, after every conversation in the range has been
fetched. The page chunks the range into **7-day async jobs**, so a six-month
search is ~26 submit-poll-fetch cycles pulling *every* conversation, to discard
almost all of them locally.

`SegmentDetailQueryPredicate` supports a `property` predicate — participant data:

```json
{ "type": "property", "propertyType": "string", "property": "<key>", "value": "<value>" }
```

The page already builds `jobBody.segmentFilters` for queue, direction and media.
Property predicates go in beside them. A key-only filter maps cleanly too:
`operator: "exists"`, which is what `if (f.value === "") return true` does today.

**Note the correction:** an earlier read of this said participant data could not
be pushed server-side, on the grounds that `ConversationDetailQueryPredicate`
has no attribute dimension. That is true but irrelevant — it is the *segment*
predicate that carries `property`, and `ConversationDetailQueryPredicate` does
not even have the field. Conversation-level property predicates are not
available; segment-level ones are.

### 1.1 They must go in separate `segmentFilters` entries

Predicates inside one clause must be satisfied by the **same segment**; separate
entries are ANDed across the conversation and may each be satisfied by a
different one. `queueId` is on the ACD segment; a participant attribute is
wherever it was set. Folding them into the existing single `and` clause would
likely match nothing — and would fail silently, looking exactly like "no
results". This is the shape that cost several rounds on Disconnect.

### 1.2 Exclude mode cannot go server-side

Operators are `matches`, `exists`, `notExists`. There is no "does not match".
`notExists` covers "key absent" but not "key present with a different value",
which is what exclude means today. Exclude stays client-side, and the two paths
have to behave identically or the mode quietly changes meaning.

## 2. `filterByPD` requires every filter on one participant

```js
conv.participants.some((p) => filters.every((f) => …))
```

Deliberate — the docstring says so — but sharp: attributes are commonly split
across legs, so filtering on a flow-set attribute *and* an agent-set attribute
can never match. Also likely to differ from server-side behaviour, which is a
reason to keep the client pass authoritative rather than assume parity.

## 3. A null attribute value kills the whole search

```js
return attrs[matchedKey].toLowerCase() === f.value.toLowerCase();
```

The spec types attributes as `additionalProperties: {type: string}`, so this is
spec-safe, but a `null` in real data throws — and it throws inside the filter for
the entire result set, not for one row.

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

- **Chunk size is 7 days here, 31 on Disconnect**, both against the same async
  API. The comment cites SWA proxy timeouts, but async jobs are the path without
  a per-request timeout. If 31 is safe there, 7 here is ~4× the job cycles — and
  server-side filtering would allow wider still.
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
