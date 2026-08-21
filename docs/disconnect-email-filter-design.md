# Disconnect — Sender / Recipient Email Filters — Design

Status: **Built and confirmed** — all eight steps shipped to dev (release 4.1),
including the server-side predicates, verified against live data (§6.1).
Author: Genesys Admin App
Last updated: 2026-08-21

## 1. Purpose

Add two optional address filters to **Interactions › Disconnect**, shown when
the Email media type is selected: **Sender Email** and **Recipient Email**. Each
accepts several addresses, entered as a vertical stack of rows rather than a
comma-separated line. They narrow a disconnect run to the named addresses only.

The driving case is an org where one mailbox has produced a batch of stuck email
interactions and the rest of the queue must be left alone. Today the only way to
do that is to preview the whole queue, read off the conversation IDs by hand,
and paste them back in as Multiple IDs.

Force-disconnect is irreversible. Every rule below is written so that a filter
which cannot be evaluated **excludes** an interaction rather than passing it
through.

This design also folds in five defects found while reading the page (§8). They
are included because the largest of them — a previewed candidate set that
survives a filter change — becomes materially more dangerous the moment a
narrowing filter exists.

## 2. Confirmed decisions

- **Addresses imply email-only.** If any address is entered, the run matches
  Email interactions and nothing else, whatever else is ticked under Media
  Types. The page says so inline rather than silently reinterpreting the tick
  boxes. Chosen because "extra filter on the email media type" has no sensible
  reading for a voice call, and the alternative — a mixed result set where the
  filter applies to some rows and not others — is the shape most likely to
  disconnect something unintended.
- **Exact match, case-insensitive.** `Support@Acme.com` matches
  `support@acme.com`. No substring, no domain wildcard. This is also the only
  thing the Genesys server-side `matches` operator can do, so client and server
  filtering stay defined identically (§6).
- **Multiple addresses in one field are OR'd; the two fields are AND'd.** Sender
  in {a, b} **and** recipient in {c}. A field left empty imposes nothing.
- **`addressFrom` / `addressTo` are the source of truth** (§4), not
  `addressSelf` / `addressOther`. They are direction-literal, they map onto the
  two field names exactly, and they are the only two of the four that Genesys
  can filter server-side.
- **An interaction with no address on record is excluded** whenever an address
  filter is active, and is reported with that reason. Absence is never treated
  as a match.
- **Client-side filtering first; server-side predicates second** (§6), after the
  `matches` operator's case behaviour has been confirmed against dev. A wrong
  guess there returns zero rows and looks exactly like "nothing matched".
- **ID modes gain a dependency on the analytics read permission** when — and
  only when — an address filter is set (§5.3).
- **Single/Multiple ID mode is realigned with queue mode** (§8.3). This widens
  what ID mode will disconnect; see the consequence stated there.

## 3. User experience

A new block sits directly beneath **Media Types**, visible only while the Email
checkbox is ticked (which it is by default, since "All" starts checked).

```
Sender Email                      Recipient Email
┌──────────────────────────┐ ✕    ┌──────────────────────────┐ ✕
│ noreply@customer.com     │      │ support@acme.com         │
└──────────────────────────┘      └──────────────────────────┘
┌──────────────────────────┐ ✕
│ billing@customer.com     │
└──────────────────────────┘
+ Add                             + Add
```

- Each field is a **vertical stack of single-address rows**. One empty row to
  start; `+ Add` appends another; `✕` removes one. Never two addresses on a
  line — a comma typed into a row is a validation error, not a separator.
- Blank rows are ignored. Duplicates are folded together silently.
- A row is validated on blur against a plain address shape and, if it fails, is
  marked inline and blocks Preview/Disconnect with a named reason. A malformed
  address must never quietly widen a run by being dropped.
- Input is normalised before use: trimmed, lowercased, `mailto:` prefix
  stripped, and `Display Name <a@b.com>` reduced to `a@b.com`.
- While any address is present, an inline note reads: *"Address filters are set —
  only Email interactions will be matched."* Media Type ticks other than Email
  are shown struck through rather than silently ignored.
- Unticking Email hides the block and its contents stop applying. The rows are
  kept, so re-ticking restores them.
- Any edit to a row invalidates the previewed candidate set (§8.1).

The existing tag/pill idiom in `interactions/search.js` was considered and
rejected: pills wrap horizontally, which is the layout this feature explicitly
does not want. The page's own one-per-line textarea (`#diConvIds`) was rejected
because it cannot mark a single bad row.

New CSS under the `di-` prefix (`.di-email-filters`, `.di-email-stack`,
`.di-email-row`, `.di-email-remove`, `.di-email-add`, `.di-email-note`), reusing
`.di-control-group` and `.di-label` for the frame.

## 4. Where the addresses come from

Confirmed against the Genesys OpenAPI spec (`api.mypurecloud.com/api/v2/docs/swagger`):

| Field | Carrier | Notes |
|---|---|---|
| `addressFrom` | `AnalyticsSession` | "The address that initiated an action" → **Sender** |
| `addressTo` | `AnalyticsSession` | "The address receiving an action" → **Recipient** |
| `addressSelf` / `addressOther` | `AnalyticsSession` | Per-side; **not** filterable server-side |
| `cc` / `bcc` | `AnalyticsSession` | Present, out of scope (§9) |

Both live on the session, so they are read as
`conversation.participants[].sessions[].addressFrom` — deduped across
participants, since the same pair repeats on each side of the conversation.

**The live conversation object does not carry them.** `GET /api/v2/conversations/{id}`
returns `Participant.address`, documented as *"For a phone call this will be the
ANI"*, and the `Email` media object holds no addresses at all. This is the whole
reason §5.3 exists.

## 5. Filtering, per scan path

A single `matchesAddressFilters(analyticsConversation, filters)` helper is used
by all three paths, so the three cannot drift apart. It returns
`{ pass, reason }`; `reason` feeds the skip reporting in §8.2.

### 5.1 Queue mode — recent sync phase

`queryConversationDetails` already returns participant sessions. The address
filter is applied to that response **before** the per-conversation
`getConversation` call, so this path issues *fewer* API calls with the filter
set than without it.

### 5.2 Queue mode — historical async phase

`searchConversations` returns the same analytics shape. Filter applied directly
to the job results. No new calls.

### 5.3 Single / Multiple ID modes

These call only `getConversation`, which has no addresses. When at least one
address filter is active, each ID additionally resolves
`GET /api/v2/analytics/conversations/{conversationId}/details`, which returns
the same `AnalyticsConversationWithoutAttributes` shape for one conversation.

New service function: `gc.getConversationAnalytics(api, orgId, conversationId)`.

- Permission: `analytics:conversationDetail:view` (or
  `analytics:agentConversationDetail:view`) — already required by queue mode,
  but **new to the ID modes**, which until now needed only
  `conversation:communication:view`. An operator without it sees the ID skipped
  with "analytics permission required to read sender/recipient", never a crash
  and never a pass-through.
- The call is skipped entirely when no address filter is set, so the existing
  permission profile is unchanged for existing use.
- **Analytics ingestion lag** is the known hole here: a very fresh interaction
  may not be in analytics yet, and will be skipped with "sender/recipient not
  yet available in analytics". See §10 for the fallback held in reserve.

## 6. Server-side predicates — phase two

`addressFrom` and `addressTo` are both in the `SegmentDetailQueryPredicate`
dimension enum, so both scan queries can push the filter to Genesys:

```js
segmentFilters: [
  { type: "and", predicates: [{ dimension: "queueId",     value: queueId }] },
  { type: "or",  predicates: senders.map(v    => ({ dimension: "addressFrom", value: v })) },
  { type: "or",  predicates: recipients.map(v => ({ dimension: "addressTo",   value: v })) },
]
```

Kept as **separate entries** in `segmentFilters` deliberately: entries are ANDed
across the conversation and may each be satisfied by a different segment, where
predicates inside one clause must be satisfied together. `queueId` lives on the
ACD segment; the addresses come from the session.

The client-side filter of §5 stays in place permanently regardless. The
predicates are an optimisation for the historical scan's volume, never the
correctness boundary.

### 6.1 Confirmed (2026-08-21)

Two things about the `matches` operator were unknown when this was written, both
of which fail silently as "no results" if guessed wrong: whether it is
case-sensitive on an address value, and whether addresses are stored bare or
decorated. Both are platform behaviour, not per-org, so one observation settles
them for good. **Both are now answered against the dev org.**

**`matches` is case-insensitive.** Genesys stores `addressFrom` with the
sender's own casing — the live value was `THVA@tdc.nuuway.dk` — while the
predicate goes out normalised to `thva@tdc.nuuway.dk`. The server filtered
correctly regardless: with the sender filter set the scan saw 4 conversations
where the unfiltered queue returned 5.

**Addresses are stored bare.** No display name, no `mailto:` prefix:
`demo_support@netdesignde.mypurecloud.de` exactly.

That first finding makes the lowercase fold in `normaliseAddress` load-bearing
rather than cosmetic. A sender filter typed in lowercase — which is how anyone
would type it — matches nothing on the client side without it, because the
stored value is not lowercase.

The same probe settled §4 with evidence rather than the spec's wording:
`addressFrom` and `addressTo` are **identical across all three sessions** of an
inbound email (`external`, `workflow`, `acd`), while `addressSelf` and
`addressOther` swap sides per participant. The pair this design chose is the
stable one; the pair it rejected is the one that depends on which participant
you happen to read.

One thing stayed unexplained. An earlier run of the recipient filter reported
"5 recipient does not match" against the very address the probe later showed in
`addressTo`. The field holds the right value and the same code matches it now,
so there is no field-selection fault; the likely cause is that the input on that
run differed, the input being visually truncated at that width. Recorded rather
than resolved.

Shipping the client-side filter first is what made that observation cheap. A
real sender filter on dev returned the correct number of interactions, which
established a baseline; **the match count is the invariant**. Re-running that
same scan with the predicates in place must produce the same match count. The
`scanned` count should fall sharply — that is the whole benefit — but a match
count that drops, and especially one that drops to zero, means the predicates
are excluding rows the client filter never gets to see, and the commit comes
back out.

The emitted body was verified in a browser first:

```json
"segmentFilters": [
  { "type": "and", "predicates": [{ "dimension": "queueId",    "value": "q1" }] },
  { "type": "or",  "predicates": [{ "dimension": "addressFrom", "value": "thva@tdc.nuuway.dk" },
                                  { "dimension": "addressFrom", "value": "billing@customer.com" }] },
  { "type": "or",  "predicates": [{ "dimension": "addressTo",   "value": "support@acme.com" }] }
]
```

Values go out normalised — lowercased, display name stripped — identically in
the sync query and the async job body.

## 7. Validation

`validateFilters()` gains:

- Reject a row containing `,` or `;` — "One address per row."
- Reject a row that is not a plausible address.
- If any address is set, force `mediaTypes` to `["email"]` and record that the
  narrowing happened, so the status line can say so.
- The existing "at least one media type" check is unreachable in that branch and
  is ordered after it.

## 8. Defects folded into this change

### 8.1 The previewed candidate set survives a filter change

`candidates` is cached by Preview and cleared only by a **mode** change. Change
a conversation ID, a date, or a media tick after previewing, press Disconnect,
and the old set is disconnected without a rescan.

Fix: one `invalidateCandidates()` wired to every control that feeds a filter —
mode radios, both ID inputs, the media checkboxes, the date enables and date
values, and every address row. Status returns to Ready so the operator can see
the preview is gone. Required, not optional: a narrowing filter that can be
edited *after* the set it was meant to narrow has been computed is the exact
shape of an accidental mass disconnect.

### 8.2 Skip reasons are computed and thrown away

`scanIds` returns `{ matched, skipped }` with a per-ID reason on every skip.
Both call sites destructure only `matched`. Ten IDs in, seven filtered, and the
page says "Preview: 3 conversations" with no account of the other seven. With an
address filter added, "0 results" becomes ambiguous between "nothing matched"
and "you mistyped the address" — which is the case this feature will hit most.

Fix, in two halves, so the earlier decision to remove the results table
(`e382ca3`) is respected where it was actually about performance:

- **ID modes** — restore a compact preview table listing every ID with its
  status and reason. The CSS is still present (`.di-table-wrap`, `.di-table`,
  `.di-mono`, `.di-ok`, `.di-fail`, `.di-skip`). Bounded by definition: the
  operator typed the list.
- **Queue mode** — no per-row table. Skips are counted by reason and summarised
  in the status line (`"1,204 scanned · 3 match · 1,190 sender mismatch · 11 not
  email"`). Unbounded row counts were the original problem.
- **The disconnect execution loop stays summary-only**, exactly as it is now.

This makes `escapeHtml` — currently imported and unused — used again.

### 8.3 ID mode and queue mode disagree on what is disconnectable

`scanIds` requires `findAcdParticipant` to find an ACD participant that is
`connected` or `alerting`. An orphaned conversation whose ACD segment Genesys
has already closed therefore fails ID mode with "Not waiting in queue" — and
that is precisely the conversation queue mode was rewritten to catch (`7bc0904`,
`be600f7`). The same interaction is found by one mode and refused by the other.

Fix: ID mode adopts the queue-mode definition — an unended conversation is
disconnectable. `findAcdParticipant` is kept only for the media type it reports,
falling back to `detectMediaType`.

**Consequence, stated plainly:** ID mode will then also disconnect a
conversation an agent is actively handling, which is already true of queue mode
today. Alignment cannot be had in only the permissive direction. The confirm
dialog and the preview table (§8.2) become the whole of the guard. If that trade
is unwanted, the alternative is to align the other way — reinstate a live-agent
guard on **both** modes — which reverses `549dbc3` and would stop queue mode
catching some orphans.

### 8.4 A comment promises a safety guard that no longer runs

`disconnect.js:114-119` states *"Live-agent protection is handled by
hasActiveAgentSegment"*. That function has not been called since `549dbc3`. The
queue scan matches every conversation in the queue with `conversationEnd
notExists`, agent attached or not. The comment is rewritten to describe what the
code does.

### 8.5 Dead code

Removed: `passesFilters`, `getQueueWaitInfo`, `hasActiveAgentSegment` — all
defined, none called — and the unused `route` parameter. `escapeHtml` is
retained because §8.2 restores its use.

## 8a. Queue depth beside the match count

Pushing the address filters to Genesys (§6) took something away: the scan never
sees the conversations the server excluded, so a count derived from the scan
reports the size of the filtered result and nothing else. A mistyped address
came back as "no conversations found", which is what an empty queue says too —
the exact ambiguity §8.2 existed to remove, reintroduced one section later.

The queue mode status line therefore reads **`4 match · 5 waiting in queue`**.
The second number is not counted from the scan. It comes from real-time queue
observations:

```
POST /api/v2/analytics/queues/observations/query
{ "filter": { "type": "and", "clauses": [
    { "type": "or", "predicates": [{ "dimension": "queueId",   "value": "…" }] },
    { "type": "or", "predicates": [{ "dimension": "mediaType", "value": "email" }] }
  ] },
  "metrics": ["oWaiting"] }
```

One request, answered from live queue state rather than reconstructed from
analytics, and filtered to the media types in play — so when an address narrows
the run to email, the depth is the email depth. `oWaiting` counts interactions
sitting in the queue unassigned.

An analytics reconstruction was built first and abandoned: `totalHits` on the
sync query would have needed one request per interval across the whole scan
window, cut on UTC midnight to stop a conversation on a boundary day being
counted twice, and it would still only have described a six-month window rather
than the queue as it stands.

Requires `analytics:queueObservation:view`. A failure resolves to `null`, not 0,
and the phrase is left off the line entirely — a depth that silently reads 0
beside a non-zero match count reads as a fault. Losing the number never fails a
scan that otherwise worked.

The two numbers answer different questions and both are worth having:
`0 match · 2,847 waiting in queue` is plainly a filter that is too tight.

### 8a.1 The oldest wait, and the fast path it might open

The same request also asks for `oLongestWaiting`, so the line reads
`4 match · 5 waiting in queue (oldest 3h)`. Taken as milliseconds, the Genesys
convention for observation duration metrics — not yet read against a queue
holding a genuinely old interaction, though a wrong unit would be visibly
wrong rather than subtly so.

It is there to answer a question worth more than the display: **how far back
does this queue actually reach?** The historical phase is six async jobs, each
submitted, polled and fetched, and it is the bulk of a scan's runtime. A queue
whose oldest waiting interaction is three hours old never needed it.

Two shortcuts follow, neither built:

1. **Skip the historical phase** when the queue's oldest wait falls inside the
   48-hour recent window, saying so in the status line rather than silently.
2. **Replace the scan outright.** `detailMetrics: ["oWaiting"]` returns
   `ObservationValue` objects carrying `conversationId`, `addressFrom`,
   `addressTo` and `observationDate` — everything the scan reconstructs, in one
   request. `ObservationMetricData.truncated` flags when the result is capped,
   so falling back to the full scan can be automatic rather than guessed.

**Both rest on one untested assumption:** that an orphaned interaction — ACD
segment closed internally, `conversationEnd` never written — still registers as
waiting. If it does not, either shortcut skips exactly the conversations this
page exists to find. The failure is silent and in the "finds nothing" direction:
safe in blast radius, useless in purpose.

The test is a queue known to hold a large orphan backlog: compare `match`
against `waiting`. Agreement means observations see orphans and the fast path is
real. `3,000 match · 12 waiting` means they do not, and neither shortcut is safe
to key on. Until that is known, the age is displayed and nothing is skipped.

## 9. Not in scope

- **`cc` / `bcc` matching.** Recipient means `addressTo`. The analytics fields
  exist and can be added later without changing the UI shape.
- **Domain shorthand** (`@acme.com`) and substring matching — rejected in favour
  of exact match; revisit only with a concrete case.
- **A "not these addresses" exclude mode.** `search.js` has one for participant
  data; this page has no exclude idiom yet, and an inverted filter on an
  irreversible action deserves its own decision.
- Three further findings, left open and unfixed: the date filters compare a
  local-calendar `<input type=date>` value against UTC (`+"T00:00:00Z"`), an
  hour or two off at the boundary for a CET operator; `"unknown"` media type is
  passed by the historical path and rejected by `scanIds`; and the scan window
  is fixed at `SCAN_INTERVALS × INTERVAL_DAYS` ≈ 6 months with no UI control, so
  a "Newer than" date beyond it silently finds nothing.

## 10. Risks

- **Analytics lag in ID mode** (§5.3) — the one place where a correct address
  filter can refuse a real interaction. Mitigated by an explicit skip reason
  rather than a silent drop. Held in reserve if it bites in practice:
  `GET /api/v2/conversations/emails/{conversationId}/messages`, which returns
  `EmailMessage` objects carrying live `from` / `to` / `cc` / `bcc` and does not
  depend on analytics ingestion. Not built now — one unverified endpoint per
  feature is enough.
- ~~**Server-side `matches` semantics** (§6)~~ — **closed**, see §6.1:
  case-insensitive, addresses stored bare, verified against live data.
- **Widened ID mode** (§8.3) — a deliberate, stated trade.
- **Silent narrowing to email** — mitigated by the inline note and the struck
  through media ticks. Without that note it would be the feature's worst
  surprise.

## 11. Build order

Each step is a separate commit and push, with a pause to test on dev.

1. ~~**Cleanup** — §8.4, §8.5. No behaviour change.~~ `696b62b`
2. ~~**Candidate invalidation** — §8.1, covering today's filters.~~ `8b72c91`
3. ~~**Preview reporting** — §8.2: ID-mode table, queue-mode reason counts.~~ `6092501`
4. ~~**ID-mode alignment** — §8.3, now visible through step 3.~~ `d4bf8c9`
5. ~~**Address filter UI** — §3 and §7: stacked rows, validation, email-only
   narrowing and its note.~~ `9622100`
6. ~~**Client-side filtering** — §5: the shared matcher across all three paths,
   plus `gc.getConversationAnalytics`.~~ `d1e79ae` — feature complete here.
7. ~~**Server-side predicates** — §6.~~ `5e75391` — confirmed live, §6.1.
8. ~~**Release notes** — one entry covering the whole feature.~~ `b03ba86`,
   release 4.1, `internalOnly` because `interactions.*` reaches no customer.

Steps 1–4 stood on their own and carried no new API surface, which made them the
right place for the design to meet dev; they were tested there before 5 began.

### 11.1 What step 6 was verified against

Steps 5 and 6 were driven in a browser against stubbed API shapes before being
committed — the UI behaviours (row add/remove, last-row-emptied, invalid and
comma rows, the note, the struck-through ticks, Preview refusing a bad row) and
then the matcher end to end:

| Case | Result |
|---|---|
| `NoReply@Customer.com` vs `noreply@customer.com` | match — case folded |
| `support@acme.com` vs `Support <SUPPORT@Acme.com>` | match — display name stripped |
| Wrong sender / wrong recipient / no address | three distinct reasons |
| Analytics 403 / 404 | "needs the analytics permission" / "not yet available" |
| No address filter set | **zero** analytics calls |
| Queue scan of 4 with a sender filter | 2 matched, **2** `getConversation` calls |

The last row is the §5.1 claim holding: the filter runs before the
per-conversation call, so the two that failed it never cost a request.

What the stubs cannot answer is whether real Genesys analytics returns these
addresses bare or decorated, and how fast ingestion is in practice for §5.3.
Both need the dev org.
