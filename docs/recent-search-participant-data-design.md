# Recent Search — participant data that actually filters — Design

Status: **Built, awaiting a test on dev.** All eight build-order steps are in,
plus §8 — the Value Distribution chart, which turned out to be the half of
Multi-value that made the checkbox look dead. The speed trade in §5 is accepted:
it is the only route to the last 48 hours.
Author: Genesys Admin App
Last updated: 2026-08-22

Companion to [interactions-search-notes.md](interactions-search-notes.md), which
covers the same subject on Historical Search and records why server-side
participant-data filtering is not available anywhere.

## 1. What is wrong today

Three things, all from one cause.

1. **The Participant Data filters do not filter.** They choose which attributes
   an expanded row displays. With none set, expanding shows every attribute;
   with some set, it shows those keys and `(not found)` for the rest.
2. **The Value box is dead input.** Every use of a filter's `value` in
   `searchRecent.js` is the chip label. The row expansion reads only `f.key`.
   Typing `UD_Language = DK` produces a chip saying so and a row showing
   whatever value the interaction actually has, `SE` included.
3. **The Conversation Detail pane shows no participant data at all.**
   `showDetailPane` prints purpose, name and disconnect type. The object it is
   handed carries `attributes`; it never looks at them. Historical's detail pane
   does.

## 2. The cause

Recent Search runs the **synchronous** analytics query, which returns
`AnalyticsConversationWithoutAttributes` — **participant data is not in the
results**. It is not a design choice; it is the shape of the response.

Attributes are only reachable through `GET /api/v2/conversations/{id}`, one call
per conversation. The page already does this lazily, when a row is expanded,
caching into `realtimeCache`.

So the hint — *"PD filters apply when clicking a row, not during search"* — is
the page being honest about not having the data. It cannot filter on what it has
not fetched.

**Why not the async job path**, which returns attributes for free and is what
Historical uses? Because ingestion lag on the last 48 hours is the entire reason
Recent Search exists. Using it here would reintroduce the problem the page was
built to avoid.

## 3. Confirmed decisions

- **Filtering happens after the results load**, not during the search. Accepted
  explicitly: the data cannot exist any earlier.
- **Attributes are fetched only when a participant-data filter is set.** With no
  filter the page behaves exactly as it does now — same speed, same lazy
  per-row fetch. Nobody pays for a feature they are not using.
- **A confirmation above a threshold** (§5), because the cost is proportional to
  the result count and the operator should learn that before waiting, not
  during.
- **Matching is conversation-level**, the same rule Historical now uses: every
  filter satisfied by *some* participant, not all by the same one. See
  [interactions-search-notes.md](interactions-search-notes.md) §2 for why.

## 4. How it works

When a search completes and at least one participant-data filter is set:

1. Fetch `getConversation` for every result, **ten concurrent**, into
   `realtimeCache` — the batching already proven on Disconnect's `scanIds`.
   Progress bar and a working Cancel throughout.
2. Apply the shared filter to the fetched data.
3. Render only the matching rows, with a status line mirroring Historical's:
   `Found 42 of 1.240 conversations matching filters.`

What falls out of having the data loaded:

- **Multi-value works on top**, as asked — the same comma-splitting into pills,
  now over a filtered set.
- **Expanding a row is instant.** The fetch it does today has already happened.
- **The detail pane can show participant data** (§1.3), because the attributes
  are finally there.
- **The Value box starts working**, since a real filter now consumes it.

`realtimeCache` is already cleared on each new search, so the prefetch needs no
new invalidation.

## 5. The confirmation

Above **250 results**, before fetching anything:

> 1.240 interactions matched your search. Loading participant data for all of
> them takes about 25 seconds. Continue?

250 is chosen so it rarely fires: a Recent search narrowed by queue or media
usually returns well under it, and 250 is roughly four seconds' work. The
estimate comes from the count and the batch size, not from a guess about the
network — it will be wrong sometimes and is a guide, not a promise.

Cancel stops between batches, as on Disconnect, and reports what was reached.

Rough cost, ten concurrent at typical latency:

| Results | Time |
|---|---|
| 50 | 1–2s |
| 250 | ~5s |
| 1.000 | ~20s |
| 3.000 | ~60s |

**Worth stating plainly:** this makes Recent's participant-data filter *slower*
than Historical's, which is the opposite of what the names suggest. Historical
gets attributes free from the async job; Recent cannot use that path at all.

## 6. Shared code

`filterByPD` and `attrValue` currently live in `search.js`. Both pages need
them, and a copy in each is exactly how the same-participant bug came to exist
in one place and not the other — that bug survived because there was only ever
one implementation to inspect.

They move to **`js/lib/participantData.js`**, alongside the other pure helpers
in that folder, and both pages import them. `REQUEST_BATCH` moves there too, or
somewhere similar: it is currently a constant private to `disconnect.js` that a
second page now wants.

## 7. Exclude — decided: yes

Recent gets an Exclude checkbox, so the page is familiar to anyone who has used
Historical. The shared filter already supports it, so the cost is one checkbox
and one argument.

Built. It sits beside Multi-value inside `.is-pd-options`, in Historical's order
and with Historical's tooltip, and the mode that produced the results is
captured as `resultsExclude` beside `resultsFilters` — the form can be edited
without re-searching, and nothing describing the results may drift from the
search that made them.

One property worth stating, because it is the same in both directions: the kept
set is built from the conversations whose participant data actually loaded, so a
conversation whose fetch failed is dropped whether Exclude is on or off. A
filter that could not be evaluated excludes rather than guesses. The count is
reported in the status line either way.

## 8. Multi-value looked dead — the chart was the missing half

Reported after step 3 shipped: *"I see it filters, but the multi value does
nothing."*

It was doing exactly one thing here — splitting a value into pills in an
expanded row — which is invisible unless a row happens to be expanded. On
Historical the same checkbox does three:

| Effect | Historical | Recent, before |
|---|---|---|
| Expanded row splits the value into pills | ✅ | ✅ — the only one |
| "Export selected participant data" splits CSV into a row per token | ✅ | ✗ (Recent exports interaction columns only) |
| **Value Distribution chart** | ✅ | ✗ — never built |

The chart is the visible half, and the decision was to match Historical.

### 8.1 What it required

The panel, the collapsible `Results (n)` toggle beside it, and the `Multi-value`
change handler that redraws both without re-searching. The rendering is
Historical's, unchanged.

**One thing could not be copied.** Historical reads attributes straight off its
results; the synchronous query this page uses does not return them. The source
here is `realtimeCache`, filled by the prefetch in §4. That makes the guard
`!multiVal || !resultsFilters.length || !conversations.length` identical *in
effect* rather than merely copied: no filters means no prefetch, so there would
be nothing to count even if the panel were shown.

Counts are per participant, as on Historical — an attribute set on two legs of
one conversation counts twice. The panel measures values seen, not
conversations, which is what makes it useful for spotting a rare value.

### 8.2 A defect the port surfaced, fixed in both pages

The collapse was keyed on the checkbox: `if ($pdMultiVal.checked && rows.length)
setResultsCollapsed(true)`. With Multi-value ticked and **no** participant-data
filter there is no chart, so the results folded away behind a toggle with
nothing in their place.

Historical has always done this. It bites harder here, because searching without
a participant-data filter is Recent's ordinary case, and Recent has no reason to
inherit the fault just because it inherited the feature. `renderDistChart` now
returns whether it drew anything and the collapse follows that, on both pages.

The visible change to Historical: with Multi-value ticked and no filter, the
results table stays open instead of collapsing to nothing. No result, count or
filter behaviour moves.

### 8.3 What was not done

**Multi-value still does not affect matching, on either page.** `filterByPD`
compares the whole stored string, so `languagepairs = en-US:de` does not match a
conversation storing `en-US:en,en-US:de` — checkbox or not. Proposed as an
alternative reading of "multi-value working on top of the filter" and not taken:
the chart was what was actually wanted. Recorded because the tooltip says values
are *"treated as comma-separated lists"*, which is true of the display and not
of the filter sitting beside it, and someone will notice that again.

**Recent still has no participant-data export.** Its Export Excel writes the
interaction columns only, so the second Historical effect above has nothing to
attach to. Separate feature.

## 9. Build order

1. **Extract the shared helpers** to `js/lib/participantData.js`, with
   `search.js` importing them. No behaviour change; the existing tests of that
   behaviour still apply.
2. **Detail pane shows participant data** (§1.3). Small, independent, useful on
   its own even before filtering works.
3. **Prefetch and filter** (§4) with progress and Cancel, no confirmation yet —
   testable on a narrow search where the count is small.
4. **The confirmation** (§5), once the timings above have been seen against real
   data rather than estimated.
5. **Exclude**, if §7 says so. ✅
6. **The hint text** — *"PD filters apply when clicking a row, not during
   search"* — becomes false at step 3 and must change with it, not after. ✅
7. **The Value Distribution chart** (§8), added after step 3 shipped and
   Multi-value was reported as doing nothing. ✅
8. **The collapse defect** (§8.2), in both pages. ✅

Step 6 is called out because it is the kind of thing that gets left behind: the
page would otherwise ship telling the operator the opposite of what it does.

Steps 1–4 shipped as `64a7ec1`, `e6f6022` and `dbd2c24`; steps 5–8 together.
