# Dashboards › Quality — three evaluation dashboards — Design

Status: **Proposal** — not started
Author: Genesys Admin App
Last updated: 2026-08-31

## 1. Purpose

A new top-level **Dashboards** section, whose first module is **Quality**: three
read-only pages over Genesys Cloud agent evaluations.

The app has no `quality:` surface at all today. Everything it knows about
conversations comes from the analytics conversation domain — volumes, media,
direction. Nothing reads what a QM programme actually produces: who was
evaluated, by whom, against which form, scoring what.

Three pages rather than one page with tabs, for two reasons that are not taste:

**The access model rewards the split.** Every gate in this app is per-nav-leaf.
Split three ways, Coverage can be granted to an operations admin and Scores to a
QM supervisor through `GROUP_ACCESS` without either seeing the other. As one key
it is all-or-nothing, and the page would need in-page sub-action gating to work
around it — the shape `roles.search` already had to adopt with its `wem`
sub-action, and which §2 of that design records as a workaround rather than a
pattern to copy.

**They do not share a backing query.** Coverage is answered entirely by the
analytics aggregate domain. AI Scoring is answered almost entirely by
`quality/evaluations/search`, whose aggregation vocabulary the analytics domain
does not have at all. Scores straddles both. One page would carry all three
query builders and fire all of them on every load.

## 2. Confirmed decisions

- **Nav is `Dashboards › Quality › <page>`** (§3). A new top-level section, so
  that later dashboards over other domains have somewhere to go that is not
  "Export". Access keys are `dashboards.quality.*`, which the existing
  `section.group.page` matcher handles with no change.
- **Three pages: Coverage, Scores, AI Scoring** (§6, §7, §8). Each answers one
  question for one audience, and each is independently grantable.
- **No group filter.** Dropped deliberately. No evaluation endpoint that can
  back a dashboard carries a group dimension — only `quality/agents/activity`
  does — so a group filter would have to be expanded client-side into member
  user IDs and would filter some bands of a page but not others. Every filter
  that survives is native on both backing endpoints, so one filter object
  serialises to both query shapes with no divergence. This is the decision that
  keeps §5.1 small.
- **Filters: date range, agents, work teams, divisions, forms, media type.**
  No queue filter - see 9a; evaluations carry no queue to filter on. Selections
  persist for the session across all three pages, and the bar now SAYS how many
  are set: persistence is what makes the shared scope useful, and it is also how
  a filter chosen on another page five minutes ago silently narrows this one. Built once as a shared component (§5.2), persisted in `sessionStorage`
  so moving between the three pages keeps your scope.
- **Short ranges are offered, and days are LOCAL** (§5.4). Today, Yesterday and
  This week sit alongside the calendar-complete presets, and the default range
  is **Yesterday**. This forces the dashboards out of UTC: at UTC+2 a UTC
  "today" starts at 02:00 local, which is invisible across a month and wrong
  across a day. Days are cut in the viewer's own timezone.
- **Charts run long; only the row-level detail table is capped** (§9). The
  3-month ceiling on `evaluations/search` is a per-request limit, not a data
  limit, and aggregation results recombine across consecutive windows *exactly*
  (§9.2). So the AI Scoring page is **not** structurally limited to a quarter,
  which an earlier reading of this had wrong. What genuinely cannot be chunked
  is the paged, sorted detail table on Scores.
- **QM and AI-scored evaluations only.** Calibrations, customer surveys and
  gamification are out of scope for v1 (§11), each for its own reason.
- **Read-only, so no write map entry** (§3.2). `FEATURE_READ_PERMISSIONS` only.
- **Available in customer mode.** Single-org, no cross-org reach, no mutation —
  it does not meet any of the criteria in `CUSTOMER_EXCLUDED_KEYS`.
- **No Activity Log entries.** `logAction` is for mutations; these pages mutate
  nothing. If an export button is added later (§11), that export logs — reading
  a dashboard does not.

## 3. Access

### 3.1 Nav

```
Dashboards
  └─ Quality
       ├─ Evaluation Coverage    dashboards.quality.coverage
       ├─ Evaluation Scores      dashboards.quality.scores
       └─ AI Scoring             dashboards.quality.aiScoring
```

| | |
|---|---|
| Routes | `/dashboards/quality/coverage`, `/dashboards/quality/scores`, `/dashboards/quality/ai-scoring` |
| Nav position | Between **Data Tables** and **Divisions**, keeping the alphabetical run at the top of the sidebar intact |
| Depth | Three levels — already used by `divisions/routing/*` and `interactions/search/participant-data/*`, so `getLeafRoutes` and `getRouteLabelMap` need no change |

`dashboards.*` and `dashboards.quality.*` both work as `GROUP_ACCESS` wildcards
under the existing prefix matcher.

### 3.2 Permissions

Read-only pages, so `FEATURE_READ_PERMISSIONS` only and no
`FEATURE_WRITE_PERMISSIONS` entry.

```js
"dashboards.quality.coverage":  { view: { all: ["analytics:evaluationAggregate:view",
                                                "quality:evaluation:view"] } },
"dashboards.quality.scores":    { view: ["analytics:evaluationAggregate:view"],
                                  detail: ["quality:evaluation:searchAny"] },
"dashboards.quality.aiScoring": { view: ["quality:evaluation:searchAny"] },
```

Reasoning, against the rule stated at the top of `featurePermissionMap.js` —
ANY for alternatives on the same data, ALL for a page aggregating *distinct*
datasets:

- **Coverage** is `all:`. It aggregates two genuinely distinct datasets: the
  analytics evaluation aggregates, and the evaluator/agent activity listings
  from the `quality` domain. Neither is a substitute for the other, and under
  ANY someone holding only `quality:evaluation:view` would be handed the
  analytics aggregates too.
- **Scores** gates the page on the aggregate permission — the data the page
  exists to show — and its drill-down table separately on `searchAny`, in the
  composite-page shape §6 of the customer-facing plan describes. Someone without
  `searchAny` gets the charts and no detail table, which is a coherent page
  rather than a denial.
- **AI Scoring** needs only `searchAny`; the analytics domain cannot answer any
  question on it.

Note `quality:evaluation:searchAny` is *searchAny*, not *view* — it reads across
the org rather than the caller's own evaluations, which is what a dashboard
means. Worth stating in the permission-request note that goes to a customer.

### 3.3 The Hourly Interacting consequence

`analytics:evaluationAggregate:view` is on the Hourly Interacting disqualifying
list this app already ships in
[`js/lib/hourlyDisqualifyingPermissions.js`](../js/lib/hourlyDisqualifyingPermissions.js).
Anyone granted Coverage or Scores loses eligibility for that licence.

This is not a blocker, and it is not disclosed on the page. An earlier revision
put a line in each page description naming the permission; that was removed on
2026-09-01 at Thomas's request, along with the rest of the per-page permission
notes. The reasoning: the audience for these dashboards is a supervisor reading
numbers, not the person deciding who gets which role, and Roles › Permissions vs.
Users already surfaces this class of surprise to the person who *is* making that
decision. The fact is recorded here so whoever grants access knows it.

## 4. The APIs, and what each is actually for

Four endpoints carry this feature. Their capabilities differ in ways that decide
the page split, so they are set out in full rather than summarised.

### 4.1 `POST /api/v2/analytics/evaluations/aggregates/query`

Permission `analytics:evaluationAggregate:view`. Pre-computed, fast at any scale,
and the same request/response shape
[`export/interactions/totals.js`](../js/pages/export/interactions/totals.js)
already parses.

| | |
|---|---|
| Metrics | `nEvaluations`, `nEvaluationsDeleted`, `nEvaluationsRescored`, `oTotalScore`, `oTotalCriticalScore` |
| Dimensions | `userId` (agent), `evaluatorId`, `assigneeId`, `assigneeApplicable`, `queueId`, `divisionId`, `teamId`, `formId`, `contextId`, `evaluationContextId`, `mediaType`, `calibrationId`, `conversationId`, `evaluationId`, `released`, `rescored`, **`systemSubmitted`** |
| Time | `granularity` (`P1D`, `P1W`) for trends; `alternateTimeDimension` ∈ `conversationStart` \| `evaluationCreatedDate` \| `evaluationReleaseDate` \| `eventTime` |

The `o`-prefixed metrics return stats objects (`count`, `min`, `max`, `sum`), so
averages are derived rather than requested — and are therefore exact when
combined (§9.2).

`alternateTimeDimension` is more useful here than it first looks: it lets the
whole dashboard pivot between "evaluations *of* conversations in this period"
and "evaluations *created* in this period", which are different questions and
are routinely confused when comparing a QM report against a volume report.
Exposed as a control on Coverage (§6.4).

### 4.2 `POST /api/v2/quality/evaluations/search`

Permission `quality:evaluation:searchAny`. Returns paged rows **and**
aggregations from one call.

Query fields: `evaluationId`, `conversationId`, `contextId`, `formId`,
`evaluationStatus`, `queueId`, `agentTeamId`, `divisionId`, `agentId`,
`evaluatorId`, `assigneeId`, `totalScore`, `totalCriticalScore`,
`conversationDate`, `createdDate`, `submittedDate`, `releaseDate`, `released`,
`mediaType`, `questionGroupId`, `questionGroupMarkedNA`, `questionGroupScore`,
`criticalQuestionGroupScore`, `questionGroupScorePercentage`,
`criticalQuestionGroupScorePercentage`, `questionId`, `questionAnswerId`,
`questionScore`, `questionMarkedNA`, `failedKillQuestion`.

Criteria types: `EXACT`, `DATE_RANGE`, `GREATER_THAN(_EQUAL_TO)`,
`LESS_THAN(_EQUAL_TO)`, `RANGE`, `REQUIRED_FIELDS`, each with an `AND`/`NOT`
operator. Multiple criteria AND together; multiple values within one criterion
OR together.

Aggregation fields, by permitted type — this list is the whole reason the AI
Scoring page can exist:

| Type | Fields |
|---|---|
| `TERM` / `COUNT` | `evaluationStatus`, `aiScoringFailureType`, `questionAiAnswerFailureType` |
| `TERM` | `formId`, `formIdReleased`, `contextId`, `questionGroupId`, `questionId`, `questionAnswerId`, `released`, `questionGroupMarkedNA`, `questionMarkedNA`, `questionAiScored`, `questionEaScored` |
| `SUM` / `AVERAGE` / `STATS` / `RANGE` | `totalScore`, `totalCriticalScore`, `questionGroupScorePercentage`, `criticalQuestionGroupScorePercentage`, `questionScore` |
| `SUM` | `disputeCount`, `rescoreCount`, `eaSuggestionCount`, `eaAcceptedSuggestionCount`, `aiSuggestionCount`, `aiAcceptedSuggestionCount` |
| `DATE_HISTOGRAM` | `conversationDate`, `createdDate`, `submittedDate`, `releaseDate` |

Plus a top-level `systemSubmitted` boolean on the request, which **defaults to
false** — automated evaluations are excluded unless asked for. That default is
a trap worth naming: a page that forgets it silently reports only human work.

Constraints: time range required and **capped at 3 months per request** (§9);
`TERM` aggregations cap at 100 buckets, with the remainder reported in
`sumOtherDocumentCount`; question-level aggregations require the query to also
constrain a `questionId`, `questionGroupId`, or a single `formId`.

### 4.3 `GET /api/v2/quality/agents/activity`

Permission `quality:evaluation:view`. A ready-made per-agent scorecard:
`numEvaluations`, `averageEvaluationScore`, `numCriticalEvaluations`,
`averageCriticalScore`, `highestEvaluationScore`, `lowestEvaluationScore`,
`highestCriticalScore`, `lowestCriticalScore`, and a per-evaluator breakdown.

Filters: date range, `agentUserId[]`, `evaluatorUserId`, `agentTeamId`,
`formContextId`, `name`, `userState`. Paged. **No queue filter** — the one gap
that keeps it from replacing the aggregate query outright.

It also returns `numEvaluationsWithoutViewPermission`, which is worth surfacing
rather than dropping: a non-zero value means the numbers on screen are a subset,
and a dashboard that quietly under-reports is worse than one that says so.

### 4.4 `GET /api/v2/quality/evaluators/activity`

Permission `quality:evaluation:view`. The evaluator side:
`numEvaluationsAssigned` / `Started` / `Completed`, and
`numCalibrationsAssigned` / `Started` / `Completed`.

This is also the only practical route to calibration coverage.
`GET /quality/calibrations` requires a `calibratorId`, so listing calibrations
org-wide would mean enumerating every possible calibrator and fanning out — the
reason calibrations are out of scope in §11 rather than a fourth page.

### 4.5 Rejected: `GET /api/v2/quality/evaluations/query`

The obvious-looking endpoint. It requires one of `conversationId`,
`evaluatorUserId`, `agentUserId` or `assigneeUserId`; a `queueId` alone is
rejected. It also silently omits "Never Release" evaluations when querying by
agent. Not usable as a dashboard source, and listed here so it is not
rediscovered and reconsidered.

## 5. Shared modules

Three pages, one query vocabulary. Both modules land before any page (§12).

### 5.1 `js/lib/evaluationQuery.js`

Owns the filter → request translation and the response → rows parsing, so no
page builds a request body by hand.

```js
// One filter object, two serialisations.
toAggregateQuery(filters, { groupBy, metrics, granularity, alternateTimeDimension })
toSearchRequest(filters, { aggregations, pageSize, pageNumber, sortBy, sortOrder, systemSubmitted })

// Response parsing
parseGroupedAggregate(resp, dimension)   // → Map<key, { count, sum, min, max }>
parseSearchAggregations(resp)            // → normalised bucket lists

// Windowing (§9.2)
splitInterval(from, to, months = 3)      // → [[from,to], …]
mergeAggregations(results)               // exact recombination
```

Because §2 dropped the group filter, `toAggregateQuery` and `toSearchRequest`
accept the *same* filter object with no lossy fields — every filter is a native
dimension on both sides. That equivalence is the module's whole justification
and is worth a test if any test scaffolding exists by then.

The parse step is close enough to `parseGrouped` in `totals.js` that the two
should be reconciled rather than duplicated; the analytics aggregate response
envelope is identical.

### 5.2 `js/components/evaluationFilters.js`

The filter bar, in the shape of
[`multiSelect.js`](../js/components/multiSelect.js) — a factory returning
`{ el, getFilters, setFilters, onChange, setEnabled }`.

| Control | Source | Dimension |
|---|---|---|
| Date range + presets | — | `interval` |
| Agents | `fetchAllUsers` | `userId` / `agentId` |
| Work Teams | `fetchAllTeams` | `teamId` / `agentTeamId` |
| Divisions | `fetchAllDivisions` | `divisionId` |
| Forms | `GET /quality/publishedforms/evaluations` | `formId` / `contextId` |
| Media type | static list | `mediaType` |

All seven already exist as fetchers in
[`genesysApi.js`](../js/services/genesysApi.js) bar the forms one, which is a
three-line `fetchAllPages` addition.

Date presets follow the ones `totals.js` already defines (Last Week, Last Month,
Last 3 Months, Last Year) — same calendar-aligned helpers, extracted rather than
copied.

**Persistence.** Selections are written to `sessionStorage` under one key and
re-read on mount, so Coverage → Scores keeps your scope. The router destroys
each page on navigation, so nothing carries over without this. Precedent:
`audit/search.js:367` does the same for its sticky service field, one field
rather than a bar.

**Forms filter caveat.** A form has a `formId` per *version* and a `contextId`
shared across versions. Filtering by `formId` silently excludes evaluations
scored on other versions of the same form, which is almost never what someone
picking "Sales QA v3" from a dropdown means. The dropdown lists forms by
context and filters on `contextId`; version-level filtering is not offered.

### 5.4 Dates: short ranges, local days, partial buckets

Presets, in order: **Today**, **Yesterday**, **This week**, Last Week, Last
Month, Last 3 Months, Last 12 Months, Last Year. Default **Yesterday** — the
last complete day is the question someone opening a QM dashboard usually has,
and it is the only short range that is not still filling.

An earlier revision capped the date picker at *yesterday*, borrowed from
`totals.js` where a partial day silently corrupts a monthly billing total.
That is the right rule there and the wrong one here: "what happened today" is
a legitimate question of a dashboard. Three consequences follow, and all three
are the price of the short presets rather than optional polish.

**Local days, not UTC.** `EvaluationAggregationQuery` takes a `timeZone`
(IANA names, default UTC), but the spec is explicit that *the interval's own
offset is used even when `timeZone` is specified*. So a `Z`-suffixed interval
asks for a UTC day whatever zone is named beside it. `toInterval` therefore
emits the viewer's offset at each end — read per date, so a range spanning a
DST change gets `+02:00` at one end and `+01:00` at the other — and
`timeZone` is sent as well, which is what aligns the granularity buckets.
`quality/evaluations/search` documents its format as
`yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`, so it gets the same local boundary converted
to UTC instead: `2026-08-30T22:00:00.000Z` for a Danish midnight.

**Hourly granularity.** Thresholds are about column width: `PT1H` at two days
or under, `P1D` to about two months, `P1W` beyond. "Today" at `P1D` is one
column, which is not a chart.

**Partial buckets are marked.** A range ending today is incomplete by
construction, so its last bucket is drawn hatched and the axis says "last
bucket still filling". Unmarked, a trailing dip reads as evaluation activity
collapsing this morning — the one wrong conclusion the chart could invite.

**What is deliberately NOT done: switching the time basis for short ranges.**
An earlier draft of this section assumed a conversation-basis "Today" would
always be empty, because a call is evaluated days after it happens. That is
true only of *human* evaluation. **AI scoring evaluates a conversation almost
immediately**, so wherever it is enabled a conversation-basis "Today" is
populated and meaningful — and on the AI Scoring page (§8) it is the natural
operational view. The page therefore never overrides the basis the user set.
It explains itself only when a short conversation-basis range actually comes
back empty, driven by the result rather than by which preset was clicked.

### 5.3 Styling

One `.dq-` prefix across the three pages. The bar chart in `totals.js`
(`.it-bar-*`, `styles.css:4881–4937`) is generalised into a `.dq-bar-*` renderer
that both it and these pages use, rather than a fourth copy. Stat tiles are new.

## 6. Page 1 — Evaluation Coverage

**Question:** are we evaluating enough, evenly, and are evaluators keeping up?

**Audience:** operations / QM admin. This is the page that fits this app's
existing audience most directly.

**Backed by:** analytics aggregates (§4.1) + evaluators activity (§4.4) + agents
activity (§4.3). No range limit.

### 6.1 Bands

```
┌──────────────────────────────────────────────────────────────────┐
│  [ filter bar — §5.2 ]                    [ Time basis ▾ ]       │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐          │
│  │ Evals  │ │ Agents │ │ Evals  │ │ %      │ │ AI vs  │          │
│  │ 1,284  │ │ cover'd│ │ /agent │ │released│ │ human  │          │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘          │
├──────────────────────────────────────────────────────────────────┤
│  Evaluations over time            (granularity P1D / P1W)        │
├───────────────────────────┬──────────────────────────────────────┤
│  By queue                 │  By form                             │
├───────────────────────────┼──────────────────────────────────────┤
│  By agent  (coverage)     │  By evaluator                        │
├───────────────────────────┴──────────────────────────────────────┤
│  Evaluator workload — assigned / started / completed             │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 Calls

One `Promise.all` of parallel `proxyGenesys` calls from the browser, in the
`totals.js` shape — not one server call assembling everything, which would sit
against the 45-second `/api` cap.

| Band | Call |
|---|---|
| Tiles | aggregates, `metrics: ["nEvaluations"]`, no `groupBy` + one `groupBy: ["released"]` + one `groupBy: ["systemSubmitted"]` |
| Trend | aggregates, `granularity: "P1D"` |
| By queue / form / agent / evaluator | aggregates, `groupBy: ["queueId"]` etc., four calls |
| Evaluator workload | `GET /quality/evaluators/activity` |

Seven calls, all parallel, all cheap — these are pre-computed aggregates.

### 6.3 The coverage denominator: who can be evaluated at all

The tile that matters most is *what share of agents were evaluated*.
`nEvaluations` grouped by `userId` gives the numerator. The denominator is the
population that could have been evaluated — and that is not a judgement call:

**An agent can only be the subject of an evaluation if they hold
`quality:evaluation:participate`.** So the users who hold that permission ARE
the eligible population, exactly.

This replaces two proxies an earlier revision of this document proposed, both
of which were worse and one of which was expensive:

| Proxy | Why it is wrong |
|---|---|
| Active users in the org | Counts everyone who was never evaluatable — inflated by every supervisor, admin and back-office account |
| Agents who handled an interaction | Misses evaluatable agents who were quiet in the period, and needs `analytics:conversationDetail:view`, a permission this page does not otherwise require |

**How it is resolved.** The same way Roles › Permissions vs. Users already
answers this question: `GET /api/v2/authorization/roles?permission=…` for the
roles that carry it, then the union of their members via
`GET /api/v2/authorization/roles/{roleId}/users`. Union rather than sum — a
user can reach the permission through more than one role. Costs
`authorization:role:view`; the role-members call declares no permission at all.

`authorization:role:view` is **not** added to the page's gate. The denominator
is not what the page exists to show, so per §6 of the customer-facing plan a
403 degrades the tile to a bare count and says why, rather than failing the
page.

**The payoff, which the proxies could not give.** Because the eligible set is a
real population and not an estimate, `eligible − evaluated` is meaningful: a
**Not evaluated** tile counts agents who can be evaluated but have nothing
recorded against them in the period. That is the actionable half of a coverage
figure — the number a QM manager can do something about.

**One caveat, recorded because no machine-readable source settles it.**
`quality:evaluation:participate` does not appear in the Genesys OpenAPI spec.
That is expected rather than suspicious: the spec lists permissions that gate
API *operations*, and this one gates none — it is a capability flag the
permission catalog carries. `GET /api/v2/authorization/permissions` is the
authority. It is held as a named constant in the page for that reason, and if
no role in an org carries it the tile says so plainly instead of reporting 0%
coverage, which would be a lie whichever way the truth fell.

### 6.4 Time basis control

`alternateTimeDimension` (§4.1) as a small segmented control: **Conversation
date** / **Created** / **Released**. Default **conversation date**, because that
is what makes a coverage number comparable with an interaction-volume number
from anywhere else in this app.

## 7. Page 2 — Evaluation Scores

**Question:** how are people scoring, and where are the failures concentrated?

**Audience:** QM supervisor.

**Backed by:** analytics aggregates for the headline and trend at any range;
`evaluations/search` for the question-level breakdown and the row-level table,
capped at 3 months (§9.1).

**Build status: complete.** Tiles, trend, distribution and the agent/form
breakdowns come from the aggregate domain with no date-range limit; the
question-group band (§7.3) and the detail table (§7.4) come from
`quality/evaluations/search`.

Those last two split apart on the 3-month cap, and the split is the useful
finding. **The question band chunks; the detail table cannot.** Its aggregation
is a `TERM` on `questionGroupId` with a `STATS` child, and both recombine across
consecutive windows exactly (§9.2) — `questionGroupId` is also far below the
100-bucket TERM limit that makes chunking unsafe for high-cardinality fields. So
a 12-month question-group breakdown becomes four requests rather than a refusal,
and the band says how many windows it combined. The detail table is the only
part of this whole feature that genuinely cannot be stitched, because merging
paged, sorted rows across windows means either fetching every row to sort them
or paging that jumps between windows. It hides itself beyond three months and
says why.

Chunking the question band required one fix to the shared module:
`mergeAggregations` folded bucket counts but not their NESTED aggregations, so a
windowed TERM-with-STATS would have reported the first window's per-group score
against every window's count — right for January, wrong for the year.

Two things changed against the sketch below, both consequences of §9a. There is
no "Score by queue" band, because there is no queue on an evaluation. And the
**score distribution comes from aggregate `views`** — `function: "rangeBound"`
against `oTotalScore`, computed server-side — rather than from the search
endpoint's RANGE aggregation. That was worth finding: it means the distribution
works at any range, where a search-backed one would have been capped at three
months like the rest of §7.4.

Score bars are drawn as a share of **100%**, not of the largest value in the
set. A percentage rescaled to its own maximum makes a group averaging 88% fill
the track whenever nobody beat it, reading as excellent when it is only the best
of a poor field. The trend uses a fixed 0–100 axis for the same reason: an
average-score chart that rescales itself hides the decline it exists to show.

### 7.0a Layout: shape at the top, browsing below

Settled 2026-09-01, after "Lowest-scoring agents" turned out to have no answer
for an org with 400 agents — it drew the worst 25 and printed "…and 375 more",
with no way to reach them and no way to look anyone up.

The page now separates two different jobs:

```
tiles · trend · distribution        the shape — everyone, never truncated
By form  |  By media type           small breakdowns, always visible
▸ Agent average scores              fold: every agent, filterable
▸ Evaluations                       fold: the rows
```

**Agent average scores** replaces both "Lowest-scoring agents" and the separate
"Critical scores" panel. Those were the same agents drawn twice with a different
metric, so they are one fold with a **Total / Critical** toggle instead — the
page loses a panel while gaining one. It carries an order toggle, a name filter
and a score range, and every one of those redraws from the by-agent aggregate
already fetched, so none of them costs a request.

Default order stays **lowest first**: the bottom of a score distribution is the
end anyone can act on. It is one click to reverse.

**By media type** fills the slot beside By form — average score per media type,
which nothing else on either page answers. A conversation carrying more than one
media type counts under each, which the panel says.

*By evaluator* — average score GIVEN, as a read on evaluator severity — was the
other candidate for that slot and was not taken. It remains the most obvious
unanswered question in this feature if a calibration view is ever wanted.

### 7.0b An evaluation's media type is not a conversation's

Found 2026-09-01, when the new By media type band drew back a bar labelled
"Unknown media (call)".

The conversation domain enumerates `voice`; **`Evaluation.mediaType` enumerates
`CALL`** — along with CALLBACK, CHAT, COBROWSE, EMAIL, MESSAGE, INTERNAL_MESSAGE,
SCREEN_MONITORING, SOCIAL_EXPRESSION, VIDEO, SCREENSHARE. Two different
vocabularies for the same idea, one word apart.

So the shared filter bar had been offering **Voice**, and filtering evaluations
by `voice` matches nothing at all. Silently — an empty dashboard looks the same
whether nothing happened or the query asked for a value that cannot exist. It
survived unnoticed until a band drew the real value out of the data.

`MEDIA_TYPES` now carries the evaluation domain's own values. The three
underscored ones are deliberately left out of the dropdown: how the aggregate
serialises them is unverified, and offering a filter that might silently match
nothing is precisely the fault being fixed. `mediaLabel` still names them if
they appear in data, tidying any unrecognised value rather than calling it
unknown — a word this app has not seen is still Genesys' word for something.

**The general lesson, for the AI Scoring page and anything after it:** a
dimension shared by name between two Genesys domains is not necessarily shared
by value. Draw the values out with a groupBy before offering them as a filter.

### 7.5 The evaluation detail drawer

A **Show details** button opens a right-hand drawer holding the transcript and
the scored form side by side.

**Second column, and inert.** The table scrolls horizontally at nine columns, so
a trailing action column would be the first thing pushed out of reach; column
two keeps it always visible and reads naturally — find the person, then act. Its
header carries no filter caret, no sort class, no tab stop and no arrow: a
filter listing "Show details" two hundred times helps nobody, and a sort on a
column of identical values reorders nothing while clearing the sort you had.
`columnFilter` gained `noSortCols` for this; `skipCols` already covered the
filter half.

Adding that column shifted every other index by one, which is a silent failure
mode rather than a loud one — get it wrong and Score quietly renders a
hundred-value checkbox list where a range belongs. The current mapping is
`dateCols: [4, 5]`, `numericCols`/`rangeCols`: `[6, 7]`, `skipCols`/`noSortCols`:
`[1]`, and the test pass asserts the Score filter is a range so it cannot
regress unnoticed.

**A drawer, not a modal or an inline expansion.** Two panes want width, and an
inline expansion inside a fold inside a long page would shove everything below
it down. The table stays visible behind, so a reviewer works down the rows
without losing their place. Escape and the scrim both close it.

**The two halves fail separately.** The form needs `quality:evaluation:view`;
the transcript needs `recording:recording:view` AND
`speechAndTextAnalytics:data:view`. Neither is this page's own gate, so a
reviewer entitled to one and not the other still gets that one — each pane
reports its own missing permission rather than the drawer failing whole. Not
every evaluation has a transcript either (no recording retained, no speech and
text analytics, or an interaction with nothing to transcribe), and that is a
stated absence rather than a spinner.

The scored form is rendered from `answers` joined to the expanded
`evaluationForm`, so it shows question text and the chosen answer's text rather
than ids — with the critical and kill flags, failed kill questions marked, per
question comments, and, where AI scored it, the model's answer whenever it
differs from the recorded one.

### 7.6 Direction: the one place it can be shown

§9a records that an evaluation carries no queue. It carries no **direction**
either — not as an aggregate dimension, not as a search field, not as a property
on the record or its conversation reference. The conversation domain has both
`direction` and `originatingDirection`; the evaluation domain inherits neither.

Filtering or grouping by direction would therefore mean resolving evaluations to
their conversations and asking the other domain — thousands of predicates in one
body, a permission this page does not hold, and only within the row cap. Not
taken.

**But the drawer fetches the conversation anyway**, for the transcript's
communication id — so direction is free exactly there, and is shown in the
drawer's sub-line.

### 7.5a The evaluation lifecycle is four timestamps, and the table shows all four

Conversation, Created, Submitted, Released — each a date column with a date
range filter, in that order. Released was a Yes/No; it is the release date now,
blank when unreleased, which reads the same way and says more.

The gaps are the point. For a human evaluation they spread out, and the distance
from call to scored, and from scored to released to the agent, is a QM health
signal nothing else in the app surfaces. For an AI-scored evaluation all four sit
within minutes of each other, which is itself the evidence that AI scored it
immediately.

`createdDate` and `releaseDate` were already in every search response and simply
unused, so this cost no extra request.

### 7.6a Direction as a column, and why the table was NOT rebuilt on it

`POST /api/v2/analytics/conversations/details/query` takes an
**`evaluationFilters`** array, and returns `AnalyticsConversation` carrying both
`originatingDirection` and its own `evaluations[]`. So direction is obtainable
in bulk, one paged query, rather than per row.

That opened a real question: `AnalyticsEvaluation` carries `userId`,
`evaluatorId`, **`formName`** (a name, not an id), `oTotalScore`,
`oTotalCriticalScore`, `evaluationStatus`, `released`, `rescored` and
`systemSubmitted` — nearly every column the Evaluations table shows, plus
direction natively, plus form names with no lookup. It could have replaced
`quality/evaluations/search` as the table's source outright.

**It was not, for one decisive reason.** That endpoint anchors on
*conversation start* — "results will only include conversations that started on
a day touched by the interval" — and it can order only by
`conversationStart` / `conversationEnd` / `segmentStart` / `segmentEnd`. The
page's **Dates refer to** control (§6.4) offers conversation date, created and
released, and the search endpoint honours all three. Rebuilding the table on the
conversation domain would have silently redefined what the date range means for
two of those three settings — the numbers would still look plausible, which is
what makes it dangerous.

So the table keeps its source, and direction is **joined on** as a column with
an ordinary value-list filter.

**The interval for that join comes from the rows, not the filter bar.** Whenever
the basis is Created or Released the rows are chosen by evaluation date, and
their conversations can have started well outside the range the user picked;
the earliest and latest `conversationDate` actually present are exact where a
padded guess would not be. The end is pushed one second past the latest, because
a Genesys interval is half-open and would otherwise drop the newest row on every
page.

It needs `analytics:conversationDetail:view`, which is not this page's gate, so
a refusal leaves the column as em-dashes with a note rather than failing the
table.

**The query MUST restrict itself to evaluated conversations.** The first
implementation asked only for an interval, which returns every conversation in
the period, oldest first — on a real org that is thousands of unevaluated calls,
and the hundred-odd the table is showing are nowhere in the first pages. Every
row showed an em-dash, on dev, twice, before anyone could see why. An
`evaluationFilters` clause of `evaluationId exists` narrows the volume to
roughly the number of evaluations, which is the point of that filter existing.

It shipped twice because the test stub returned exactly the conversations it was
asked about regardless of the query — so the code passed by asking the wrong
question of an obliging fake. The stub now holds 4,000 unevaluated conversations
that sort earlier than the evaluated ones, and fails the old code.

### 7.1 Bands

```
┌──────────────────────────────────────────────────────────────────┐
│  [ filter bar — §5.2 ]                                           │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                     │
│  │ Avg    │ │ Avg    │ │ Score  │ │ Failed │                     │
│  │ score  │ │critical│ │ spread │ │ kill Q │                     │
│  └────────┘ └────────┘ └────────┘ └────────┘                     │
├──────────────────────────────────────────────────────────────────┤
│  Average score over time                                          │
├───────────────────────────┬──────────────────────────────────────┤
│  Score by queue           │  Score by form                       │
├───────────────────────────┴──────────────────────────────────────┤
│  Score distribution  (RANGE buckets: <60, 60–79, 80–89, 90+)     │
├──────────────────────────────────────────────────────────────────┤
│  Weakest question groups            ← needs a single form        │
├──────────────────────────────────────────────────────────────────┤
│  Detail table                       ← ≤ 3 months, §9.1           │
└──────────────────────────────────────────────────────────────────┘
```

### 7.2 Averages are derived, not requested

`oTotalScore` returns a stats object, so the page computes `sum / count` itself.
This matters for correctness rather than convenience: averaging the per-queue
averages to get an org average is wrong whenever queues have unequal evaluation
counts, and it is the mistake this shape invites. `evaluationQuery.js` returns
`{ count, sum }` and never a bare average, so the wrong thing is awkward to
write.

### 7.3a Question groups need a form VERSION, not a form context

**Settled on dev, 2026-09-01.** The endpoint says exactly what it wants:

> Aggregating against question group level fields require either a single top
> level Term aggregation for questionGroupId and querying by either a single
> formId or a list of questionGroupIds, OR querying by a single questionGroupId
> or questionId

A form **context** id is rejected. Everywhere else in this feature the context
is the right key — §5.1 keys forms on it precisely so that filtering by a form
does not silently exclude evaluations scored on its other versions. This one
band cannot have that, so it resolves the context to the id of its latest
published version and scopes the query to that.

**Corrected 2026-09-01: it takes the other branch instead.** Scoping to a single
`formId` scopes to a single form VERSION, and every evaluation scored on an
earlier revision falls out. That showed up on dev as this band reporting **one**
evaluation per question group while every other band on the page reported
**eight** — a discrepancy visible on screen, which is the only reason it was
caught.

The rule allows "a single formID **or list of questionGroupIds**", so the band
now fetches every revision of the form, puts every question group id across all
of them into the query, and merges the buckets back together on the group's
`contextId` — the one identifier a question group keeps across versions. Counts
and sums add; the average is recomputed once over the whole population rather
than averaged from per-version averages, which would be wrong wherever versions
carry unequal numbers of evaluations. The sub-line says how many versions it
covered.

**The versions endpoint does not return `questionGroups`.** The form-list family
documents that omission ("the detailed information about evaluation form, is
not returned") and the versions listing behaves the same way, so the first
attempt at this collected ids from version objects that had no groups on them
and reported "this form has no question groups" for every form. The version list
is now used only for its IDS, and each revision is fetched in full by id — at
most the 20 most recent, one request each.

If the versions call fails the band falls back to the published version alone —
fewer evaluations, but still an answer.

**A related fix the same screenshot forced.** The detail table showed a GUID in
its Form column, because the lookup was keyed on context ids while an evaluation
record names its form by VERSION id. The lookup now answers to both — the two
point at the same name, and a row showing a GUID for a form the filter bar is
displaying by name is a lookup this page declined to do.

### 7.3b Weakest questions: the drill-down under the groups

**Added 2026-09-02**, when the AI Scoring page was folded away (section 8.4).

Weakest question groups names the group dragging a score down and then stops.
This table goes one level further: every question on the form, weakest first,
with its average, the answer chosen most often, and - under Scored by = AI - how
often AI answered it at all.

| Question | Group | Evaluations | Average | Most common answer | AI answered |

**Three measures, one parent term.** `STATS questionScore`,
`TERM questionAnswerId` and `TERM questionAiScored` all hang off a single
`TERM questionId`, scoped by a list of question ids across every form version -
the same shape and the same version-merging as the groups band (7.3a), for the
same reason.

**With a fallback.** Several children under one parent is what the schema
describes, but this endpoint has refused several things its schema permits
(sections 8.2a, 8.2c), and a refusal would cost the whole table. So it asks once
for all three and, if refused, once per measure, folding the parts back together
and saying in a note that it did so.

**The AI column is meaningless without the form's AI settings** - see section
8.2e, which is kept in the historical section because that is where it was
learnt. Summary: `EvaluationForm.aiScoring` carries a per-question `enabled`
flag, the column reads "off" where AI is not configured, and flags only the case
where AI is enabled and still answered under half the time.

**The 100-bucket cap can bite here** where it cannot on question groups. A form
with many questions across many versions can exceed 100 question ids, and the
band surfaces `sumOtherDocumentCount` as a note rather than under-reporting
silently.

### 7.3c A criterion takes at most 50 values

**Found on dev, 2026-09-02.** Undocumented, and it lands exactly where this
feature is most exposed:

> Search criteria values exceeded limit of 50.

Both question bands query by a LIST of ids gathered across every revision of a
form (7.3a), and that list passes 50 easily - eleven questions and five versions
is already 55. The search refuses the whole request rather than truncating, so
the band showed nothing at all.

Both bands now chunk their id list at 50 and merge the results. The chunks are
disjoint by construction, so their buckets are disjoint and the merge is exact -
the same reasoning that makes the 3-month window walk safe (9.2).

**The two parallelisms multiply.** Each chunk fans out over its own date
windows, so a 30-question form across 12 versions on a 12-month range is 8
chunks x 4 windows = 32 simultaneous proxy calls. Chunks therefore run four at a
time, keeping the fan-out near the five-at-a-time shape the documentation export
settled on.

This limit applies to any criterion, not just these two. Anything built later
that filters on a long id list needs `chunkCriteriaValues` or the same refusal
will arrive.

### 7.3 The question-level band needs a single form

Per §4.2, question-group aggregations require the query to constrain a
`questionId`, `questionGroupId` or a single `formId`. Question groups are not
comparable across different forms anyway — "Compliance" on two forms is two
different sets of questions.

So the band renders only when exactly one form is selected in the filter bar,
and otherwise shows a prompt to pick one. Stated as a condition of the band, not
an error.

### 7.4 Detail table

`evaluations/search` with `pageSize`, `pageNumber`, `sortBy` ∈ `conversationDate`
\| `createdDate` \| `submittedDate` \| `releaseDate`, `sortOrder`.

Columns: agent, evaluator, form, queue, media, conversation date, submitted,
total score, critical score, status, released, and a marker for AI-scored.

Rows carry `redacted: true` when the caller may not see that evaluation — shown
as a redacted row rather than dropped, for the same reason as
`numEvaluationsWithoutViewPermission` in §4.3.

`systemSubmitted: true` must be set explicitly to include AI evaluations
(§4.2) — the table has a three-way toggle: All / Human / AI, defaulting to All.

## 8. Page 3 — AI Scoring (REMOVED — folded into Coverage and Scores)

> **This page no longer exists.** It was built, rebuilt, and then folded into
> the other two pages on 2026-09-02. Everything below is kept because the API
> knowledge in it is expensive and still correct, and because if AI scoring ever
> becomes a programme rather than a POC the page can be re-cut from it. Section
> 8.4 records why it went.

### 8.4 Why the page was folded away

Three rounds of rebuilding kept arriving at the same problem: almost everything
the page reported was already reported better somewhere else.

- **Evaluation Scores already has a "Scored by: AI / human" toggle**, and it
  scopes the question-group band and the evaluations table. So "how does AI
  score" was answered there, by a page people were already on.
- **Evaluation Coverage already has an AI-scored tile.** So "how much is AI
  doing" was answered there.

Strip those away and exactly three things existed only on this page:

| What | Where it went |
|---|---|
| `aiScoringFailureType` — scoring failures by cause | **Coverage**, as a tile plus a cause breakdown. A failed AI scoring attempt is a coverage failure: work that should have been evaluated and was not. |
| `questionAiScored` — which questions AI answered | **Scores**, as the per-question table under Weakest question groups, where it gains an "AI answered" column under Scored by = AI. |
| `ea*` — Evaluation Assistance suggestion acceptance | **Nowhere, for now.** Parked rather than moved: it is unverified whether the org uses Assistance at all, and §8.0 records how to build it if so. |

Two further findings killed the auto lane's own trust story outright:

- **You cannot rescore an auto-evaluation.** Genesys does not permit it, so
  `rescoreCount` against `systemSubmitted: true` is structurally zero and the
  "Did it stick?" band had no data behind it. Disputes alone were not enough to
  keep a band, let alone a page.
- The remaining figure, per-question abstention, is **only readable next to the
  form's AI settings** (§8.2e) — and once it needs the form definition anyway,
  it belongs beside the other per-question data on Scores rather than on its own.

The honest summary: the page was one good band and one small operational one.
That is a section, not a page.

### 8.2e The per-question band needs the form's AI settings

`EvaluationForm.aiScoring` carries `questionGroupSettings[].questionSettings[]`,
each with a per-question `enabled` flag keyed by question **contextId**. Without
it, "AI answered this question 5 times out of 11" is unreadable, because three
completely different situations produce a low number:

1. AI scoring is not enabled for that question — nothing to act on.
2. It is a `freeTextQuestion` — AI cannot answer it. `EvaluationQuestion.type`
   says so.
3. It is enabled and AI still could not answer it — **the finding**.

Only the third is worth anyone's time, so the table separates them rather than
showing one bare count. Note there is **no GET** for these settings: the only
endpoint is `PUT /quality/forms/evaluations/{formId}/aiscoring/settings`, so
they are read off the form definition, which the band fetches anyway. Where a
form carries none, the table says so instead of guessing.

---

## 8 (historical). The AI Scoring page

**Question:** is AI doing the work, is it succeeding, and is anyone letting it
stand?

**Audience:** whoever owns the AI scoring rollout. Narrow, but this data has no
good home in the standard Genesys views, which is the argument for the page.

**Build status: rebuilt.** The first build shipped and was rejected on the only
grounds that matter -- "I am not sure what I get from this dashboard." It was
right to reject. The page was organised around a *mechanism* (here are facts
about AI) rather than a *decision*, which makes it a status page. Coverage asks
"are we evaluating enough"; Scores asks "where are failures concentrated"; this
one asked nothing. Section 8.0 is the rebuild.

### 8.0 Two lanes, because there are two products

The single biggest fault in the first build: it averaged two unrelated features
into one word, "AI".

| | Auto-evaluation | Evaluation Assistance |
|---|---|---|
| What it does | Scores **and submits** the whole evaluation itself | **Suggests** answers to a human evaluator, who accepts or overrides |
| Who submits | Virtual Supervisor | A person |
| `systemSubmitted` | `true` | `false` |
| Fields | `aiScoringFailureType`, `aiSuggestionCount`, `aiAcceptedSuggestionCount`, `questionAiScored` | `eaSuggestionCount`, `eaAcceptedSuggestionCount`, `questionEaScored` |
| Fails by | Not producing a score at all | Producing one nobody takes |
| Trust signal | Disputes and rescores -- a person overturning it | Acceptance rate -- a person taking it |

They are configured differently, they fail differently, and they are trusted
differently. One "AI acceptance" number spanning both answers nothing about
either. The page therefore runs as two labelled lanes, top to bottom, and never
adds them together.

**This also fixes a live bug.** The first build issued ONE search request with
`systemSubmitted: true` and asked it for `eaSuggestionCount` and
`eaAcceptedSuggestionCount`. Evaluation Assistance suggestions are attached to
evaluations a *person* submitted, so that request asks for assistance figures
from the population that by definition has none. The "Assistance suggested /
Assistance accepted" bars could only ever have been under-reported, and are most
likely structurally zero. Confirm against a live org with assistance enabled;
either way the lane split removes the possibility.

### 8.0a What was removed, and why

- **AI-scored against human-scored.** The two are not scoring the same sample of
  work, so the gap is not evidence of anything. The band carried a sub-line
  saying so, which is the tell: a number needing that much hedging is not a
  finding. Removed outright rather than caveated harder.
- **AI and human evaluations over time.** Volume vanity outside a rollout. The
  AI/human split is already on Scores as a "Scored by" band, which is where a
  comparison belongs.
- **The AI share tile.** A share *of human work* is a comparison by definition.
  This page is about AI on its own terms.
- **`questionAiAnswerFailureType`.** Answer-level failure causes are already
  visible in aggregate as the evaluation-level `aiScoringFailureType`, and
  keeping it would cost a third question-level request under the one-form
  constraint of section 8.2a.
- **`aiSuggestionCount` / `aiAcceptedSuggestionCount`.** Decided during the
  build rather than the design. On an auto-submitted evaluation the model's own
  answers *are* the evaluation, so "suggested versus accepted" has no stable
  meaning there and any figure would have needed the kind of hedging that got
  the score comparison deleted. The acceptance question belongs to the
  Assistance lane, where a person is genuinely choosing. If a Genesys behaviour
  turns up that gives these a clear meaning on auto-evaluations, they are one
  SUM each to add back.

Removing the whole comparison half has a consequence worth stating plainly: the
analytics aggregate domain was only ever there to carry the counts and the
comparison. Both are gone, so **the page is now backed by `evaluations/search`
alone** -- one permission, `quality:evaluation:searchAny`, and no half that
degrades separately. `EvaluationSearchResponse.total` supplies the lane counts.

### 8.1 Bands

```
+------------------------------------------------------------------+
|  [ filter bar -- section 5.2 ]                                   |
+------------------------------------------------------------------+
|  AUTO-EVALUATION            (systemSubmitted: true)              |
|  +--------+ +--------+ +--------+ +--------+                     |
|  | Scored | | Failed | |Disputed| |Rescored|                     |
|  +--------+ +--------+ +--------+ +--------+                     |
|                                                                  |
|  A1  Did it run?      Why AI scoring failed + failures over time |
|  A2  Did it stick?    Dispute / rescore rate over time           |
|  A3  Where does it    Per question, least-answered first         |
|      abstain?         (needs ONE form -- section 8.2a)           |
+------------------------------------------------------------------+
|  EVALUATION ASSISTANCE      (systemSubmitted: false)             |
|  +--------+ +--------+ +--------+                                |
|  |Offered | |Accepted| | Accept |                                |
|  |        | |        | |  rate  |                                |
|  +--------+ +--------+ +--------+                                |
|                                                                  |
|  B1  Is it trusted?   Acceptance rate over time  <- the headline |
|  B2  Where does it    Per question (needs ONE form)              |
|      abstain?                                                    |
+------------------------------------------------------------------+
```

**A2 and B1 are the point of the page.** Both are *rates over time*, not counts.
A count says what happened; a rate over time says whether it is getting better
or worse, which is the only version of this a person can act on. A rescore rate
climbing month over month means trust in auto-evaluation is falling. An
acceptance rate climbing means assistance is being tuned well.

### 8.1a One honest limitation in the Assistance lane

There is no way to count *assisted evaluations*. `eaSuggestionCount` is not in
`EvaluationSearchCriteriaDTO`'s field enum, so a query cannot say "human
evaluations where assistance offered something", and the response `total` for
`systemSubmitted: false` is every human evaluation whether assisted or not.

The lane therefore reports suggestion volumes, the acceptance rate and
per-question coverage -- never an "n evaluations assisted" figure. The tiles say
"suggestions", not "evaluations", so nothing on the page implies a number it
does not have.

### 8.2 Aggregations used

Six requests, each of which fails alone.

| # | Lane | `systemSubmitted` | Aggregations |
|---|---|---|---|
| R1 | Auto, totals | `true` | `TERM aiScoringFailureType`; `SUM disputeCount`, `SUM rescoreCount` |
| R1b | Auto, trend | `true` | `DATE_HISTOGRAM` on the time basis field, with `SUM disputeCount` + `SUM rescoreCount` sub-aggregations |
| R2 | Assistance, totals | `false` | `SUM eaSuggestionCount`, `SUM eaAcceptedSuggestionCount` |
| R2b | Assistance, trend | `false` | `DATE_HISTOGRAM` on the time basis field, with both as sub-aggregations |
| R3 | Auto, per question | `true` | `TERM questionId` -> `TERM questionAiScored` (one form, section 8.2a) |
| R4 | Assistance, per question | `false` | `TERM questionId` -> `TERM questionEaScored` (one form, section 8.2a) |

### 8.2c Sub-aggregations forbid company

Each lane is two requests rather than one because of a rule that appears
nowhere in the schema and only surfaces at runtime:

> When using sub-aggregations, only one top-level aggregation is allowed

A histogram carrying `SUM` sub-aggregations is the only way to express a rate
per bucket, and it therefore has to travel alone. The first build of the rebuild
put the histogram alongside the lane's flat aggregations and was refused
outright, taking the lane's tiles down with the chart.

Splitting them is not merely a workaround. It means a lane's totals survive its
trend being refused and the other way round, which is the same failure
philosophy as R3/R4 (section 8.2a). Note the two rules interact: R3 and R4
already satisfy this one, since a lone `TERM questionId` with a nested `TERM`
is exactly one top-level aggregation.

`EvaluationSearchSubAggregationDTO` permits the full type set including `SUM`
under a `DATE_HISTOGRAM` parent, which is what makes the rate bands possible at
all. Sums inside date buckets recombine across 3-month windows exactly -- buckets
merge on their key and the sums add (section 9.2) -- so `mergeSub` already
covers it.

The histogram buckets on the SAME field the range was filtered on, via
`searchDateField(timeBasis)`. Bucketing on a fixed field while filtering on a
chosen one would let the chart describe a different period from the one the
filter bar names, silently.

Counts do NOT come from `EvaluationSearchResponse.total`. That field looks like
the obvious source and is wrong here: `toSearchRequest` sends every aggregation
request with `pageSize: 0`, and the endpoint then reports `total: 0` however
many evaluations matched. The first build of the rebuild read it, and the
Auto-evaluated tile showed 0 for a period Evaluation Scores reported 18 for --
while the lane's own trend, which counts documents per bucket, showed all 18.

The lane count is therefore a summed `TERM evaluationStatus`, which rides in the
same request as the rest of the tiles and needs no extra round trip.
`aggregateAcrossWindows` deliberately does not expose `total` at all, so the
trap cannot be walked into again.

### 8.2b Two honesty rules the rate bands follow

**A zero denominator is not a zero rate.** A bucket where nothing was offered
and a bucket where everything offered was rejected are opposite facts, and a
zero-height column states the second one. A bucket with no denominator draws as
a flat neutral tick instead, and its tooltip says "no suggestions".

**The axis is fixed at 0-100% and drawn.** The entire point of a rate is that
two periods can be compared; an axis that rescales to the sample destroys that.
Gridlines every 25% make the scale visible, because an undrawn axis is an
invisible one and a 14% column then reads as arbitrary.

**Only one of the two ratios is bounded, so they carry different units.**
Assistance acceptance cannot exceed 100%: every accepted suggestion was first an
offered one. Disputes and rescores can, because they are EVENT counts against an
evaluation count and one evaluation can be disputed twice. Rendered as a
percentage that produces "116.7% overturned", which reads as a bug rather than
as the true fact it is -- so the auto lane counts **per 100 auto-evaluations**
and the assistance lane stays a percentage.

### 8.2d Enum values come back lower-cased

The schema enumerates `QuotaReached`, `ServiceError` and the rest in PascalCase.
The live API returns `quotareached`, `serviceerror`. An exact-key lookup against
the label map therefore misses every time and the raw value reaches the screen,
which is what "serviceerror" appearing as a bar label was. Labels are matched
case-folded now. Assume the same of any other enum this endpoint returns.

The failure-type enum is worth labelling properly rather than echoing:
`QuotaReached`, `ParsingError`, `ServiceError`, `InvalidRequest`,
`DuplicateFormSameAgent`, `Unauthorized`, `DuplicateAutomatedFormWithCopiedScore`.
`QuotaReached` in particular is a commercial fact, not a bug, and should read as
one.

### 8.2a Question-level fields cannot share a request

Anything named `question*` is a QUESTION-level field, legal only when the
request carries a single top-level `TERM` on `questionId` **and** is scoped to
one `formId`, one `questionGroupId` or a list of `questionIds`. Mixing a
question-level field with an evaluation-level one is not degraded -- it is
rejected outright:

> Aggregating against question level fields require either a single top level
> Term aggregation for questionId and querying by either a single formId, a
> single questionGroupId or list of questionIds OR querying by a single
> questionId

Because every aggregation originally rode in one request, three question-level
fields took the whole page down with them. Hence R3 and R4 above, each its own
request, each failing alone.

The user-facing consequence is the constraint Weakest question groups already
lives under (section 7.3a): the abstention bands need **exactly one form**
selected, and say so when they do not have one. Questions are not comparable
across forms anyway, so this is a real constraint rather than only a technical
one.

Both bands read least-often-answered first. A model that answers most questions
but never touches three of them is saying something about those three -- usually
that they are badly worded, or need a human.

Question text is a sentence, not a word. The default bar-label column
ellipsises every question on a real form to the same prefix ("Oplyste
agenten ..."), which is worse than no label; these bands use the wide two-line
label variant.

### 8.3 The one thing that may not be possible (still open)

The spec lists `agentId` and `evaluatorId` in the aggregation field enum but
**omits them from its own "allowed fields by aggregation type" breakdown**.
Either the breakdown is incomplete or those fields are not aggregatable.

This decides whether "AI scoring by agent" and "by evaluator" can exist on this
page at all. It is the first thing to test against a live org (§10), before the
page layout is fixed.

## 9. Dates and the 3-month ceiling

### 9.1 Where the ceiling genuinely binds

`evaluations/search` requires a time range and rejects one longer than 3 months.
That is a **per-request** limit.

It binds absolutely on exactly one thing: the **paged, sorted detail table** on
Scores (§7.4). Merging sorted pages across windows means either fetching every
row from every window to sort them, or paging that jumps between windows — both
worse than the honest cap. So: charts run at any range, and the detail table
renders only when the selected range is ≤ 3 months, with a line saying why.

### 9.2 Where it does not — aggregation windows recombine exactly

Every aggregation bucket returns `documentCount`, `count`, `sum`, `minimum`,
`maximum` **alongside** `average`. Having both count and sum is what makes
recombination exact rather than approximate:

| Type | Recombination | Exact? |
|---|---|---|
| `TERM` / `COUNT` | Sum `documentCount` per key | Yes |
| `SUM` | Add | Yes |
| `STATS` | Σcount, Σsum, avg = Σsum/Σcount; min of mins, max of maxes | Yes |
| `DATE_HISTOGRAM` | Buckets are disjoint — concatenate | Yes |
| `RANGE` | Bucket counts add | Yes |
| bare `AVERAGE` | No count returned — **cannot** recombine | No |

Bare `AVERAGE` is therefore never used. `STATS` is a strict superset of it and
returns the same average, so nothing is lost. `evaluationQuery.js` does not
expose `AVERAGE` at all, which makes the unrecombinable option unavailable
rather than merely discouraged.

A 12-month range is four windows — four parallel calls in one `Promise.all`,
each its own `proxyGenesys` request, so the 45-second `/api` cap is per call and
not a concern.

**The one caveat.** `TERM` aggregations cap at 100 buckets. For a
low-cardinality field (`aiScoringFailureType`, `evaluationStatus`, booleans)
this cannot bite. For a high-cardinality one (`agentId`, `formId` in a large
org) a key can make the top 100 in one window and not the next, so the stitched
total under-counts it. Rule: **chunk low-cardinality `TERM` fields freely; for
high-cardinality breakdowns take the number from the analytics aggregates
instead** (which have no such cap), or do not chunk. `sumOtherDocumentCount` is
checked on every stitched `TERM` result and a truncation warning shown if it is
non-zero, so the case is visible rather than silent.

### 9.3 Range presets

Shared with `totals.js` (§5.2). Ranges longer than 3 months are allowed
everywhere; the Scores detail table hides itself with an explanation, and the AI
page chunks. Nothing is refused.

## 9a. There is no queue filter, and no By queue band

**Decision: both removed.** Settled on dev against 3C Retail, 2026-09-01.

**What the evidence showed.** With the queue filter cleared, the By queue band
rendered a single row - **No queue, 16** - and the `group` object of the
grouped-by-`queueId` response carried no `queueId` at all. An evaluation
aggregate does not have a queue.

**Why the Genesys UI appears to contradict that.** The Interactions view can
filter on *Has Evaluation* and shows a Queue column beside it, which looks like
proof that evaluations know their queue. They do not. That view lists
**conversations** which have an evaluation, and the Queue column is the
**conversation's** - several rows in the sample carry two or three queues
(`Leasy_salg, Omstilling Kredit, Omstilling_Salg`). No single evaluation owns
one of them, so there is nothing there to filter an evaluation by.

**Why not route it through `quality/evaluations/search` instead.** That endpoint
does take `queueId` and does return a `queue` per item, so it was a live option.
It was dropped rather than pursued: it would make queue filtering the one
feature on this page requiring `quality:evaluation:searchAny`, cap it at three
months while every other filter runs unbounded, and give a Coverage page two
different backing queries whose numbers could disagree. A filter that works
differently from every other filter on the same bar is worse than no filter.

**So the bar offers no Queues control and the page has no By queue band.** A
control that can only ever return nothing is not worth explaining to every user
who tries it.

**Consequences already implemented elsewhere.** `parseGroupedAggregate` keeps
rows whose group lacks the dimension - a real bug found on the way here, and one
that still matters for `evaluatorId` (see below). The empty-state note still
distinguishes a zero caused by filters from one caused by the period; it just no
longer has a queue-specific branch.

**The diagnostics that found this are gone.** A "Show the queries this page
sent" panel and six isolation probes were built to answer this question, and
answered it. They were then removed: the probes fired six extra requests to
settle a question nobody will ask again, and the panel was a developer tool on a
page that ships to customers, exposing query structure to people with no use for
it. Recoverable from commit `85882f4` if Scores or AI Scoring need the same
treatment - the technique is worth repeating, the residue is not.

What survives is the part that was never diagnostics: when a filtered result is
zero, ONE unfiltered query runs and the note reports how many evaluations
actually exist. That is UX, and it costs one request only on the empty path.

### 9a.1 The AI evaluator is Virtual Supervisor

An AI-scored evaluation carries no `evaluatorId`, because no person scored it.
Genesys attributes it to **Virtual Supervisor**, which is what the
conversation's Quality Summary shows.

The band names it as such - but only when the AI count accounts for the whole
absent-evaluator bucket. An `evaluatorId` can also be missing because the
evaluator was deleted, and labelling that "Virtual Supervisor" would be the same
class of error as the one it replaced: an earlier revision labelled these 16
"Unknown user", which reads as *a person was involved and this app lost their
name*. When the counts do not match, the bucket falls back to **No evaluator
recorded**.

## 10. Risks and unknowns

**To test against a live org before the layout is fixed:**

1. **Are `agentId` / `evaluatorId` aggregatable in `evaluations/search`?** (§8.3)
   Decides two bands on the AI page.
2. **Is there an undocumented interval ceiling on the analytics evaluation
   aggregates?** The spec states none, but the conversation aggregate domain
   enforces one in practice. If there is, Coverage and Scores chunk exactly as
   the AI page does — the machinery from §9.2 is already there, so this changes
   effort, not design.
3. **Does `systemSubmitted` on the analytics aggregates mean the same thing as
   the request flag on search?** The two pages must agree on what "AI" counts
   as, or Coverage and AI Scoring will show different splits for the same
   period, which is the sort of discrepancy that costs more trust than the
   feature earns.

**Accepted risks:**

- **Empty dashboards in orgs with no QM programme.** Most likely first
  impression for a fair share of orgs. Each band needs a real empty state saying
  "no evaluations in this period" rather than a zero-height chart — the failure
  mode `totals.js` already handles with `.it-bar-empty`.
- **Permission-filtered under-reporting.** Both `numEvaluationsWithoutViewPermission`
  (§4.3) and `redacted` rows (§7.4) are surfaced rather than dropped.
- **The Hourly Interacting licence consequence** (§3.3) is a real cost to the
  customer. It is recorded here and visible in Roles › Permissions vs. Users
  rather than on the dashboards themselves.

## 11. Not in scope

- **Calibrations.** `GET /quality/calibrations` requires a `calibratorId`, so an
  org-wide view means enumerating calibrators and fanning out (§4.4). The
  aggregate counts from `evaluators/activity` appear on Coverage; a calibration
  *comparison* view — several evaluators' scores on one conversation, which is
  the genuinely useful thing — is its own page and its own design.
- **Customer surveys / NPS.** `POST /analytics/surveys/aggregates/query`
  (`analytics:surveyAggregate:view`) has its own metric vocabulary —
  `nSurveyNpsPromoters` / `Detractors`, `nSurveyResponses`, `oSurveyTotalScore`,
  grouped by `userId`, `queueId`, `teamId`, `surveyFormId`, `surveyType`. A good
  fourth page under Dashboards › Quality later; not a band bolted onto these.
- **Gamification scorecards.** Points and objectives are a different concept
  from evaluation scoring, and mixing them dilutes all three pages.
- **Export and scheduling.** No download button and no `schedulePanel` in v1.
  If added later, the export logs to the Activity Log even though the dashboards
  themselves do not (§2).
- **Writing anything.** No assigning, no rescoring, no releasing. These pages
  read.

## 12. Build order

Each step is its own commit, pushed and testable on dev before the next.

1. **`js/lib/evaluationQuery.js`** — filter serialisation both ways, response
   parsing, `splitInterval` / `mergeAggregations`. Pure functions, no UI, no
   page depends on it yet. Verifiable in isolation, which is the point of
   putting it first.
2. **Live-org spike against the §10 unknowns.** One throwaway script through the
   proxy answering all three questions. Cheap, and two of the three can change
   the layout of a page — so it happens before, not after.
3. **`js/components/evaluationFilters.js`** + the `fetchAllEvaluationForms`
   addition to `genesysApi.js` + `sessionStorage` persistence. Mountable on a
   scratch page and clickable before any dashboard consumes it.
4. **Nav and access scaffolding** — `Dashboards › Quality` in `navConfig.js`,
   three `pageRegistry.js` entries, three `FEATURE_READ_PERMISSIONS` entries,
   the `accessConfig.js` key-list comment block, three placeholder pages. Lands
   as pure addition; nothing else in the app changes behaviour.
5. **`.dq-bar-*` extraction** — generalise the `totals.js` bar renderer and
   repoint `totals.js` at it. Done here rather than later, so the first
   dashboard consumes the shared version and a fourth copy never exists. This
   step touches a shipped page, so it is verified against Export › Interactions
   › Totals before moving on.
6. **Coverage** (§6) — tiles, trend, four grouped bands, evaluator workload.
   Deliberately first: it is the page whose audience matches this app's
   existing one, and it needs nothing from §9.2.
7. **The coverage denominator** (§6.3) — the conversation-aggregate call, with
   graceful degradation when `analytics:conversationDetail:view` is absent. Its
   own step because it reaches into a different analytics domain and has a
   permission path that must be tested both ways.
8. **Scores** (§7) — charts and distribution first, then §7.3's question band,
   then §7.4's detail table with its 3-month gate. The table is last because it
   is the only part that can be cut without leaving a hole.
9. **AI Scoring** (§8) — including window chunking through
   `mergeAggregations`, and the `sumOtherDocumentCount` truncation warning.
   Last because §10.1 may still remove two of its bands.
10. **Release note.** One entry covering Dashboards › Quality as a whole — three
    pages shipped over several commits are one feature to a reader, and
    iterations fold into that entry rather than cutting a version per page.

## 13. Page 3 (second attempt) - Evaluation Gaps

**Status: step one built and shipped to dev, 2026-09-02**, as
**Dashboards > Quality > Evaluation Setup**
(`js/pages/dashboards/quality/evaluationSetup.js`). The per-agent half (13.0a)
is designed but not built - it waits on the three questions in 13.5.

The page was called Evaluation Gaps for a few hours and renamed the same day;
13.7 records why.

**Question:** which agents should have been evaluated and were not, and why?

**Audience:** whoever owns the quality automation. The person who reads Coverage
asks "are we evaluating enough"; this answers "and here is what is stopping us",
which is a different job on the same subject.

### 13.0 The unit is the AGENT; interactions are the evidence

Agents are what the reader cares about and what the answer is delivered in.
Interactions are how an agent becomes eligible and where every cause actually
attaches - a queue with transcription off, a conversation in no program.

Getting this backwards in either direction breaks the page:

- **Agents alone** cannot be attributed. "This agent has no evaluations" has no
  cause attached to it; the causes live on their interactions.
- **Interactions alone** answer the wrong question. Most interactions are not
  supposed to be evaluated - sampling sees to that - so a count of unevaluated
  interactions is a large, alarming and meaningless number.

So: walk the interactions to find the causes, then report per agent.

### 13.0a "Missed" is an expectation, not an absence

This is the design's centre and it falls out of the previous section.

An agent with 50 qualifying interactions under a 5% sampling rule who received
two evaluations is **correctly handled**. An agent with 50 qualifying
interactions and zero is not. The difference is not whether interactions went
unevaluated - almost all of them did, by design - but whether the agent received
what the configuration implies.

    expected(agent) = qualifying interactions x samplingPercentage
                      (x 1 for agentToScore Each; an upper bound for First/Last)

    missed(agent)   = expected >= 1 and actual = 0

This converts sampling from an un-attributable caveat into the most useful
number on the page. It also means the page must not flag an agent whose expected
count is 0.4 - absence there is unremarkable, and saying otherwise would be the
cry-wolf failure again.

For `agentToScore: First` or `Last`, only one agent per conversation is
scoreable, so `expected` is an upper bound rather than a figure - which the
column has to say, not imply.

### 13.1 Why this is a page when AI Scoring was not

The same four questions that folded AI Scoring away (8.4), asked again:

| | AI Scoring | Evaluation Gaps |
|---|---|---|
| Does anything else answer it? | Yes - Scores and Coverage both | **No.** Nothing in the app reads STA programs, scoring rules or transcription settings |
| Distinct audience? | No - the same supervisor | **Yes** - whoever configures the automation |
| Fills a screen? | One good band | **Yes** - agents, causes, and the configuration behind them |
| Different cadence? | No | **Yes** - read after a change, or when something looks wrong |

AI Scoring failed three of the four. The difference is overlap, not enthusiasm
for a new page: its content already existed elsewhere and this content exists
nowhere.

### 13.2 The chain an interaction must pass for its agent to be evaluated

Established from the spec, 2026-09-02. Every step is a place an interaction
silently drops out, and therefore a reason an agent goes unevaluated.

| # | Requirement | Source | Certain? |
|---|---|---|---|
| 0 | **The interaction was recorded** | Measured: `conversations/details/query` with a `recording` segment filter (13.2a) | Yes, measured |
| 1 | Org transcription not `Disabled` | `GET /routing/settings/transcription` | Yes |
| 2 | If mode is `EnabledQueueFlow`, the queue has `enableTranscription` | `Queue.enableTranscription`, already on the queue list | Yes |
| 3 | The conversation's queue **or flow** is mapped to a program | `GET /speechandtextanalytics/programs/mappings` (all programs, one call) | Yes |
| 4 | The program is published | `GET /speechandtextanalytics/programs/unpublished` | Yes |
| 5 | An Agent Scoring Rule on it is `enabled` and `published` | `GET /quality/programs/{programId}/agentscoringrules` | Yes |
| 6 | Sampling picks the interaction | `samplingType` / `samplingPercentage` | **Expectation, not fact** |
| 7 | `agentToScore` selects this agent | `First` / `Last` / `Each` | **Expectation, not fact** |
| 8 | The agent holds `quality:evaluation:participate` | Roles, as Coverage already resolves | Yes |
| 9 | AI scoring does not fail | `aiScoringFailureType` - already on Coverage | Yes |

### 13.2a Recording is measured, never derived from policies

Added 2026-09-02, on Thomas's point that a missing transcript may be caused by
a missing recording. Without audio there is nothing to transcribe, so this sits
before transcription in the chain rather than inside it.

`GET /api/v2/recording/mediaretentionpolicies` (`recording:retentionPolicy:view`)
returns policies split per media - `callPolicy`, `chatPolicy`, `emailPolicy`,
`messagePolicy` - each with `actions.retainRecording` and conditions on
`forQueues`, `forUsers`, `teams`, `directions`, `wrapupCodes`, `languages`,
`duration` and `timeAllowed`.

**Deriving "will this interaction be recorded" from those is refused.** Policies
carry an order, their conditions overlap, and any one of them can match; working
out which wins is simulating Genesys's own policy engine, and this page has
already been wrong twice from reasoning ahead of the data. What the
configuration section reports instead is narrower and true: which enabled
policies retain recordings, whether any of them name the program's queues, and
whether any policy is in error - the list endpoint offers a `hasErrors` filter
and `Policy.policyErrors` carries the messages, which is a cheap exact finding
on its own.

**Whether an interaction WAS recorded is measured exactly.**
`SegmentDetailQueryPredicate` carries a `recording` dimension alongside
`queueId`, `flowId`, `userId` and `purpose`, so one `conversations/details/query`
asks "interactions in program scope, on the agent segment, not recorded",
faceted by agent. Recording therefore becomes a row in the cause list like any
other, rather than an inference.

Note `Queue.suppressInQueueCallRecording` exists but governs in-queue recording,
not the agent segment, and must not be read as "this queue is not recorded".

**Auto-evaluation comes only from a program.** A media retention policy's
`assignEvaluations` cannot do it: policy conditions carry `forQueues` and no
flows, and the rule governing automated submission
(`AgentScoringRule.submissionType: Automated`) hangs off a program. Confirmed
against the spec after getting it wrong once.

Steps 1-5, 8 and 9 are faults with a named fix. Steps 6 and 7 are the
configuration working as intended, and feed `expected` (13.0a) rather than the
fault list.

### 13.3 What can be counted, and how

Each figure is a difference between two cheap queries rather than a walk over
conversations.

| Figure | How | Cost |
|---|---|---|
| Who is a member of a covered queue | `GET /routing/queues/{id}/members` (`routing:queue:view`, already needed) | one per covered queue |
| Interactions handled in scope, per agent | Conversation aggregates, `queueId` filter with `userId` grouping - **queue-mapped programs** | one call |
| ...for flow-mapped programs | `conversations/details/query`, `segmentFilters` on `flowId`, faceted on `userId` - conversation aggregates carry no `flowId` (9a) | one call |
| Not recorded | Same detail query with a `recording` segment filter (13.2a) | one call |
| Not transcribed | `nSpeechTextAnalyzedConversations` from `analytics/transcripts/aggregates/query` over the same scope | one call |
| Evaluations received, per agent | `analytics/evaluations/aggregates/query`, `nEvaluations` grouped by `userId` - already what Coverage does | one call |
| Agent lacks Participate | Roles, as Coverage resolves today | two calls |
| AI tried and failed | `aiScoringFailureType`, already on Coverage | one call |
| **expected / missed** | Derived per 13.0a from the rule's sampling and the qualifying count | free |

**Queue membership cannot stand alone.** An agent who belongs to a covered queue
and handled nothing has not been missed, so membership establishes scope and the
handled count establishes eligibility. Reporting on membership alone would flag
every idle member as a fault.

### 13.3a Three groups, not one list

The output separates three populations that a single "not evaluated" list would
blur into a false alarm:

| Group | Meaning | What the reader does |
|---|---|---|
| **Missed** | Handled work in scope, every setting in order, no evaluation | Investigate. This is the list. |
| **Explained** | No Participate, queue transcription off, not recorded, no live rule, sampled out, or another agent was the one scored | Fix the named cause, or accept it |
| **In scope but idle** | A member of a covered queue who handled nothing | Nothing. Must never be counted as missed |

Thomas's org makes the first group unusually clean: the live rule on the AI
Scoring program samples **All**, so there is no sampling ambiguity - every
qualifying interaction should produce an evaluation. `agentToScore: Last` is the
only remaining softness, and only on conversations with more than one agent.

`SegmentDetailQueryPredicate` carries `queueId`, `flowId`, `userId`, `purpose`
and `teamId` together, which is what makes the queue-mapped and flow-mapped
cases one query instead of two incompatible ones. The conversation AGGREGATE
domain cannot do this - it has no `flowId` at all (9a) - so the detail domain is
the right instrument here despite being the heavier one.

### 13.4 Bands

```
+------------------------------------------------------------------+
|  [ filter bar - section 5.2, plus a Program selector ]           |
+------------------------------------------------------------------+
|  Agents handling | Should have been | Were | MISSED | Unexplained |
+------------------------------------------------------------------+
|  AGENTS NOT EVALUATED            <- the page, one row per agent   |
|    Agent | Interactions | In a program | Expected | Got | Why     |
|                                                                   |
|    Sorted by expected-but-absent, largest first: the agent the    |
|    configuration most clearly implies should have been evaluated  |
|    and was not, at the top.                                       |
+------------------------------------------------------------------+
|  WHY, ACROSS ALL AGENTS                     (bars, largest first) |
|    No program covers the queue or flow            certain        |
|    Transcription off (org, or that queue)         certain        |
|    Scoring rule disabled or unpublished           certain        |
|    Agent lacks Participate                        certain        |
|    AI tried and could not score                   certain        |
|    - - - - - - - - - - - - - - - - - - - - - - - - - - - - -     |
|    Unexplained                          <- the one that matters  |
+------------------------------------------------------------------+
|  THE CONFIGURATION BEHIND IT                                      |
|    Org transcription mode                                         |
|    Per program: published, queues, flows, rules (sampling,        |
|    agentToScore, form, enabled/published)                         |
|    Mapped queues with transcription switched off                  |
+------------------------------------------------------------------+
```

The agent table leads because agents are the subject. The cause breakdown is the
same population summarised the other way, for someone who wants to know what to
fix rather than who to chase.

**Unexplained is the figure that justifies the page.** Everything above it is
either a fault with a named fix or expected behaviour with a named reason. What
is left - agents the configuration says should have been evaluated, whose
interactions passed every check, with no evaluation - is the only number here
that needs investigating, and nothing in the app surfaces it today.

The configuration band is evidence, not a separate audit: a reader who sees
"transcription off" needs to know which queues, on the same screen.

### 13.4a The mappings response is not the mappings request

**Found on dev, 2026-09-02**, with a program showing 0 queues against nine in
the Genesys UI.

| Direction | Shape |
|---|---|
| `PUT /speechandtextanalytics/programs/{id}/mappings` | `ProgramMappingsRequest`: `{queueIds, flowIds}` — id strings |
| `GET /speechandtextanalytics/programs/mappings` | `TopicsDefinitionsProgramMappings`: `{program, queues, flows}` — entity refs |

The first build read the request definition and assumed the response matched.
The harness stub was written to the same assumption, so it passed locally and
failed on the first real org. Shape a fixture from the endpoint's own
`responses[200]` schema — never from its request body, and never from what the
calling code happens to read.

The listing is also paged by **`nextPage` / `nextUri`**, which is a third paging
style in this API: `fetchAllPages` walks `pageNumber`, `fetchAllCursor` walks
`cursor`, and neither fits. `fetchProgramMappings` follows `nextUri` itself,
lifting the token out rather than reconstructing a format that is not
documented, and stopping if the same token comes back twice.

Note that `AddressableEntityRef` carries only an id and a `selfUri` — no name —
so queue names still have to come from the queue list.

### 13.5 Honest limits

- **Sampling is an expectation.** `expected` is a projection, so `missed` is a
  residue after an estimate and has to say so rather than implying precision it
  lacks. An agent whose expected count is below 1 must not be flagged.
- **`agentToScore: First`/`Last` makes `expected` an upper bound**, because
  knowing a rule scores the first agent does not say which agent that was
  without reading each conversation's participants.
- **Three things to verify against a live org before trusting the numbers**
  (none block the configuration band):
  1. Whether a `termFrequency` facet on `userId` counts conversations or
     segments - an agent with three segments on one conversation must not count
     three times.
  2. Whether the facet needs `purpose = agent` to exclude customer and IVR
     participants.
  3. How common `agentToScore: Each` is in practice - if every rule uses it,
     the upper-bound caveat is noise and can be de-emphasised.
- **Recording is measured, not predicted.** The page can say an interaction was
  not recorded; it cannot say in advance that a queue's interactions will not
  be. See 13.2a.
- **Volume.** Only facet counts are needed, not rows, so requests stay small -
  but this is the heaviest of the three pages and the build should confirm that
  before committing to the layout.

### 13.5a The inverse question, and where it would live

`EvaluationSearchItemResponse.evaluationSource` is `{id, name, type}` with type
`Policy | User | Unknown | Program`, so for an evaluation that DOES exist the
API can name what caused it. It is a row-level field - not filterable, not
aggregatable - so it is a column on the Evaluation Scores table rather than
anything countable here.

Not built: asked about on 2026-09-02 and confirmed to be a slip for "aren't
evaluated". Recorded because it is cheap, it is the exact inverse of this page,
and `type: Unknown` is what the Genesys interactions view shows when it cannot
attribute an evaluation.
- **Permissions.** Adds `speechAndTextAnalytics:program:view`,
  `quality:scoringRule:view`, `routing:transcriptionSettings:view`,
  `analytics:speechAndTextAnalyticsAggregates:view` and
  `analytics:conversationDetail:view`. Each band degrades on its own and names
  what it wants, as elsewhere.

### 13.7 Why the page is called STA Configuration

Two renames in a day, both from Thomas and both right.

It shipped as **Evaluation Gaps**. He observed it "has turned more into an
overview of the configuration settings" - and the name was writing a cheque the
page had not cashed. Everything on it is settings; "Gaps" promised a list of
missed agents, and a page named for a question it does not answer sends the
reader looking for a table that is not there. So: **Evaluation Setup**.

Then: "Its not only about evaluations." Also right. Transcription, AI summary
and insights, agent empathy, transcription engines and program mappings are
Speech and Text Analytics configuration, and evaluations are one consequence of
it rather than its subject. So: **STA Configuration**, named for what it holds.

That freed the name **Evaluation Gaps** for the page that earns it - the
per-interaction list, now section 14. The split settled the question this
section used to leave open: two pages, because the configuration is instant at
any org size and the interaction walk scales with volume, and pairing them would
make the cheap half wait for the expensive one.

### 13.6 What changes on Coverage

Coverage's **Not evaluated** tile starts from agents who *hold*
`quality:evaluation:participate`. Thomas asked that a missing permission appear
as a reason rather than a gate, so the two pages divide as:

- **Coverage** keeps the tile and gains a one-line cause summary plus a link
  here. The symptom stays where people already look.
- **Evaluation Gaps** carries the full attribution.

Splitting a symptom from its diagnosis across two pages is the mistake 8.4
records; the guard against repeating it is that Coverage must always say enough
to be useful alone.


## 14. Page 4 - Evaluation Gaps

**Status: design only. Not built.**

**Question:** which individual interactions should have been evaluated and were
not, and why each one was missed?

Page 3 (STA Configuration, section 13) answers "is anything switched off". This
answers "and which interactions did that cost me". They are separate pages
because they are separate costs: section 13 reads configuration and is instant
at any org size, while this walks conversation rows and scales with volume.
Putting them together would make the cheap half wait for the expensive one.

### 14.1 Everything is read, nothing is inferred

The design went through three rounds of me claiming a figure was unobtainable
and Thomas pointing out it was not. The corrections, because each was a case of
checking one level of the response and stopping:

| I claimed | Actually |
|---|---|
| Recording is filterable but not readable | `AnalyticsSession.recording` is a boolean on the SESSION. I had looked at `AnalyticsConversationSegment`, which has no such field. |
| Evaluations carry no usable queue, so per-queue attribution is impossible | `AnalyticsConversation.evaluations[]` carries `AnalyticsEvaluation` with `userId`, `queueId`, `systemSubmitted`, `formName`, `evaluationStatus` and the scores - on the conversation row itself |
| `agentToScore: Last` cannot be resolved without reading rows | We ARE reading rows. `session.segments[]` carries `segmentStart`/`segmentEnd`, so segment order says who was last |
| Transcript status is not available per conversation | `analytics/transcripts/aggregates/query` takes `conversationId` as a documented dimension, so one grouped call returns the analysed set to diff against |

The lesson, which is the same one as section 13.4a and the stub memory: a "not
available" conclusion drawn from one definition is a guess about the others.

### 14.2 The eight reasons, and where each is read from

| Reason | Source | Kind |
|---|---|---|
| The agent lacks `quality:evaluation:participate` | Roles, as Coverage resolves | Config |
| Not recorded | `session.recording === false` | Read off the row |
| Too short | `segmentEnd - segmentStart` on the agent segment | Read off the row |
| Not transcribed | Transcript aggregate grouped by `conversationId`, diffed | Read, in bulk |
| The queue has transcription off | Queue config (section 13) | Config |
| No program covers the queue or flow | Program mappings (section 13) | Config |
| No live scoring rule, or the program is unpublished | Scoring rules (section 13) | Config |
| Another agent was the one the rule scores | Segment order vs `agentToScore` | Read off the row |
| **Unexplained** | Everything above ruled out | The residue |

Whether an interaction WAS evaluated is read from `conversation.evaluations[]`,
matched on the agent's `userId` - not reconciled against a separate count. That
is what makes a per-interaction verdict possible at all.

### 14.2a The duration threshold is shown, never assumed

Thomas reported that Genesys does not transcribe interactions under 30 seconds.
**That could not be verified.** The Resource Center page that exists to list
these - *Limitations with speech and text analytics* - names ACD agent consult
recordings, consult segments in acoustic analysis, a BYOC 10-hour cap and
dual-channel requirement, and in-queue flow language changes. It does not
mention a minimum. Voicemail over 5 minutes is excluded and AI outlines need 30
minutes, but neither is this. The AI scoring best-practices page states no
minimum either, and the developer centre is an SPA that returns an empty shell
to a fetch.

So the threshold is a **visible, adjustable number on the page**, defaulting to
30 seconds and labelled as a threshold rather than a rule. Interactions below it
are grouped under "shorter than the threshold", and the distribution is shown
alongside. If the rule is real it becomes obvious in the data; if it is not,
nothing false has been asserted. Hard-coding an unverifiable constant into a
page whose whole purpose is explaining absences would be the same fault as the
quota-reached line on Coverage, at larger scale.

### 14.3 Cost, and telling the user before spending it

This pages conversation rows, so it scales with interactions where nothing else
in this feature does.

- `AnalyticsConversationQueryResponse.totalHits` gives the count up front, so
  the page reports "n interactions in scope, roughly m requests" and waits.
- Nothing loads on arrival. A date range and the covered queues are chosen, then
  an explicit action starts the walk.
- `/analytics/conversations/details/jobs` (submit, poll, fetch) exists for large
  pulls, the same shape as the documentation export. Worth using above some
  threshold rather than paging synchronously.
- The 45-second `/api` cap applies as everywhere: fan out from the browser, do
  not assemble server-side.

### 14.4 Bands

```
+------------------------------------------------------------------+
|  [ dates, queues (defaulted to the program's), agents, threshold ]|
+------------------------------------------------------------------+
|  n interactions in scope . m evaluated . k missing   [ Find gaps ]|
+------------------------------------------------------------------+
|  WHY, ACROSS THE PERIOD                     (bars, largest first) |
|    one row per reason from 14.2, Unexplained last                 |
+------------------------------------------------------------------+
|  THE INTERACTIONS                                                 |
|   Date | Queue | Agent | Duration | Recorded | Transcribed | Why  |
|                                                                   |
|   Filterable by reason. A row links to the interaction in Genesys |
|   and, for one row at a time, can check transcripturls directly.  |
+------------------------------------------------------------------+
```

### 14.5 Still to confirm against a live org

Neither blocks the design, both change the implementation:

1. **Transcript group cardinality.** Grouping the transcript aggregate by
   `conversationId` over a busy month may exceed whatever cap that endpoint
   applies. Chunking by day is the fallback and the page already walks windows.
2. **Whether `speechandtextanalytics/transcripts/search` is cheaper.** Its
   criteria are generic `fields`/`values` and the response is an untyped
   `ArrayNode`; the spec does not enumerate the field names and the developer
   centre cannot be fetched. It may be the better route - it is not designed on
   until someone has seen it answer.
3. **Page size on `conversations/details/query`.** `PagingSpec` documents no
   maximum; the practical cap is discovered, not read.

### 14.6 What this page is not

- **Not a policy simulator.** Media retention policies decide recording, but
  which policy wins for a given interaction is Genesys's own evaluation order
  and is not reimplemented here (13.2a). The page reports what happened, not
  what should have.
- **Not a second configuration page.** Where a cause is a setting, it names the
  setting and links to STA Configuration rather than restating it.
