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

This is not a blocker, but it must be said on the page rather than discovered on
an invoice — Roles › Permissions vs. Users exists partly to surface exactly this
class of surprise. One line in each page description, naming the permission.

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

**The consequence is stated on screen** rather than hidden: the band's sub-line
names the form and says "current published version only". Evaluations scored on
an earlier version are not in it. That is the trade the context id exists to
avoid everywhere else, and the band is the one place it cannot be avoided.

**A related fix the same screenshot forced.** The detail table showed a GUID in
its Form column, because the lookup was keyed on context ids while an evaluation
record names its form by VERSION id. The lookup now answers to both — the two
point at the same name, and a row showing a GUID for a form the filter bar is
displaying by name is a lookup this page declined to do.

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

## 8. Page 3 — AI Scoring

**Question:** is AI scoring working, and is anyone accepting what it suggests?

**Audience:** whoever owns the AI scoring rollout. Narrow, but this data has no
good home in the standard Genesys views, which is the argument for the page.

**Backed by:** `evaluations/search` aggregations almost entirely, run over
chunked windows (§9.2) so the page is **not** limited to a quarter.

### 8.1 Bands

```
┌──────────────────────────────────────────────────────────────────┐
│  [ filter bar — §5.2 ]                                           │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                     │
│  │ AI     │ │ Accept │ │ Failure│ │ Dispute│                     │
│  │ share  │ │ rate   │ │ rate   │ │ rate   │                     │
│  └────────┘ └────────┘ └────────┘ └────────┘                     │
├──────────────────────────────────────────────────────────────────┤
│  AI vs human evaluations over time      (DATE_HISTOGRAM)         │
├───────────────────────────┬──────────────────────────────────────┤
│  Failure types            │  AI vs EA suggestions                │
│  (aiScoringFailureType)   │  (suggested / accepted, both)        │
├───────────────────────────┴──────────────────────────────────────┤
│  Score comparison — AI-scored vs human-scored (STATS on both)    │
├──────────────────────────────────────────────────────────────────┤
│  Rescores and disputes on AI-scored evaluations                  │
└──────────────────────────────────────────────────────────────────┘
```

### 8.2 Aggregations used

| Band | Field | Type |
|---|---|---|
| AI share | `systemSubmitted` request flag, two calls | `COUNT` |
| Acceptance | `aiSuggestionCount`, `aiAcceptedSuggestionCount`, `eaSuggestionCount`, `eaAcceptedSuggestionCount` | `SUM` |
| Failure types | `aiScoringFailureType`, `questionAiAnswerFailureType` | `TERM` |
| Trend | `submittedDate` | `DATE_HISTOGRAM` |
| Score comparison | `totalScore` | `STATS` |
| Rescores / disputes | `rescoreCount`, `disputeCount` | `SUM` |
| AI-scored questions | `questionAiScored`, `questionEaScored` | `TERM` |

Every one recombines exactly across windows (§9.2), and every `TERM` field here
is a low-cardinality enum or boolean, so the 100-bucket cap cannot bite.

The failure-type enum is worth labelling properly rather than echoing:
`QuotaReached`, `ParsingError`, `ServiceError`, `InvalidRequest`,
`DuplicateFormSameAgent`, `Unauthorized`, `DuplicateAutomatedFormWithCopiedScore`.
`QuotaReached` in particular is a commercial fact, not a bug, and should read as
one.

### 8.3 The one thing that may not be possible

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
  customer, disclosed on the page.

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
