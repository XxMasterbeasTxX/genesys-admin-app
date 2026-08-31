# Test form — Dashboards › Quality › Evaluation Scores

Page: **Dashboards › Quality › Evaluation Scores** (`/dashboards/quality/scores`)
Design: [dashboards-quality-design.md](../dashboards-quality-design.md) §7
Environment: **dev**
Tester: ______________________  Date: ______________________

## What is in this build, and what is not

This is the aggregate-backed half of the page: tiles, trend, distribution, and
the agent/form breakdowns. It has **no date-range limit**.

Two bands from §7 are deliberately **not here yet**, because both need
`quality/evaluations/search` and its 3-month cap:

- the question-group breakdown (§7.3), which needs a single form selected
- the row-level detail table (§7.4)

Don't raise those as failures. The filter bar itself was covered by the
Coverage pass, so this form only checks what is new.

---

## 1. Access and shape

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 1.1 | Open **Dashboards › Quality › Evaluation Scores** | The real page, not "Coming soon" | | |
| 1.2 | Read the permission note | Names `analytics:evaluationAggregate:view` and the Hourly Interacting warning | | |
| 1.3 | Look at the filter bar | Same bar as Coverage, but **no "Dates refer to"** — that is set on Coverage and inherited | | |
| 1.4 | Set a scope on Coverage, then come here | The same scope is already applied | | |
| 1.5 | Count the panels | Average score over time, Score distribution, Lowest-scoring agents, By form, Critical scores | | |

## 2. Tiles

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 2.1 | Load a period you know has scored evaluations | Six tiles: Evaluations, Average score, Average critical, Lowest, Highest, Rescored | | |
| 2.2 | **Average score** | A percentage to one decimal | | |
| 2.3 | **Lowest** / **Highest** | Single-evaluation extremes, not averages — Lowest may legitimately be 0.0% | | |
| 2.4 | Cross-check the range line | It repeats the same average as the tile | | |
| 2.5 | **Rescored** | A count of evaluations scored more than once (often 0) | | |
| 2.6 | Compare Average score against Genesys' own QM view for the same period | **The number that matters.** Should agree | | Genesys: ______ / App: ______ |

## 3. The averaging rule

An average must be computed once over the whole population, never by averaging
per-agent averages — those differ whenever agents have unequal evaluation
counts. This is the one arithmetic error the data shape invites.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 3.1 | Note each agent's average and evaluation count in **Lowest-scoring agents** | — | | |
| 3.2 | Work out the plain mean of those agent averages | It should **differ** from the Average score tile whenever counts are unequal | | Mean: ______ vs tile: ______ |
| 3.3 | Work out the weighted mean (each average × its count, ÷ total count) | This **should** match the tile | | |

## 4. Trend

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 4.1 | Load a single day | Hourly buckets | | |
| 4.2 | Load Last 12 Months | Weekly buckets | | |
| 4.3 | Hover a column | Shows the average and how many evaluations it is over | | |
| 4.4 | Read the axis | Says "axis 0–100%" — bar height is the score itself, not a share of the best bucket | | |
| 4.5 | Load a range ending **today** | Final column hatched; axis says "last bucket still filling" | | |
| 4.6 | A bucket with no evaluations | Renders flat, and the tooltip says "no evaluations" | | |

## 5. Score distribution

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 5.1 | Look at the panel | Four fixed bands: Under 60%, 60–79%, 80–89%, 90% and above | | |
| 5.2 | Each row | A count and a share of the total | | |
| 5.3 | Add the four counts | Should equal the number of **scored** evaluations | | Sum: ______ |
| 5.4 | Colours | Under 60% red, 60–79% amber, the top two green | | |
| 5.5 | Load a 12-month range | Still works — the distribution is computed server-side and has no 3-month limit | | |

## 6. Agents and forms

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 6.1 | **Lowest-scoring agents** | Sorted **lowest first** — the actionable end | | |
| 6.2 | Bar widths | A share of 100%, not of the best score in the set. A 90% agent fills most of the track; a 40% agent fills under half | | |
| 6.3 | Each row | Shows the average and the evaluation count behind it | | |
| 6.4 | **By form** | Real form names, lowest first | | |
| 6.5 | **Critical scores** | Per agent, lowest first — may differ in order from the total-score panel | | |
| 6.6 | An agent with no name resolved | Reads "Unknown user (abc12345…)", never a bare GUID | | |
| 6.7 | An AI-scored-only period | Agents still appear — the agent is on the evaluation regardless of who scored it | | |

## 7. Empty and awkward states

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 7.1 | A period with no evaluations at all | Tiles show "—", every band says "No scored evaluations in this period." | | |
| 7.2 | A period with evaluations that are **not yet scored** | Counts are real, score tiles show "—", and a note says they carry no score yet | | |
| 7.3 | A filter that matches nothing | A note says how many evaluations exist and to clear filters one at a time | | |
| 7.4 | Short range on Conversation date with nothing back | The note explains the conversation-date lag and suggests Created/Released | | |
| 7.5 | Switch org mid-page | Results hide; reloading uses the new org's agents and forms | | |

## 8. Console and cost

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 8.1 | DevTools → Console | No errors, no unhandled rejections | | |
| 8.2 | Network, filter `genesys-proxy`, load once | Six aggregate calls, fired in parallel | | Count: ______ |
| 8.3 | Time a 12-month load on your biggest org | Well under 45 seconds | | ______ s |
| 8.4 | Light mode | Band colours still readable; bar tracks visible | | |

## 9. Overall

Anything wrong or worth changing before the question-level band and the detail
table are added:

```


```

Ready for §7.3 and §7.4?   Yes / Not yet
