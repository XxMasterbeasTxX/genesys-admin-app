# Test form — Dashboards › Quality › Evaluation Scores

Page: **Dashboards › Quality › Evaluation Scores** (`/dashboards/quality/scores`)
Design: [dashboards-quality-design.md](../dashboards-quality-design.md) §7
Environment: **dev**
Tester: ______________________  Date: ______________________

## What is in this build

The whole page. Tiles, trend, distribution and the agent/form breakdowns come
from the aggregate domain and work at **any date range**. Two bands lower down
come from the evaluation search endpoint:

- **Weakest question groups** — needs exactly one form selected. Chunks across
  3-month windows, so it works at any range too.
- **Evaluations** (the row-level table) — the one part limited to three months,
  because paged sorted rows cannot be stitched across windows.

Both also need `quality:evaluation:searchAny`, which is **not** the page's own
permission: without it the charts still work and the two bands say so.

The filter bar was covered by the Coverage pass, so this form only checks what
is new.

---

## 1. Access and shape

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 1.1 | Open **Dashboards › Quality › Evaluation Scores** | The real page, not "Coming soon" | | |
| 1.2 | Read the permission note | Names `analytics:evaluationAggregate:view` and the Hourly Interacting warning | | |
| 1.3 | Look at the filter bar | Same bar as Coverage, but **no "Dates refer to"** — that is set on Coverage and inherited | | |
| 1.3a | If any filter is set | The bar reads "n filters active" and **Clear filters** is highlighted — selections persist across pages for the session, so this is how you spot one you set earlier | | |
| 1.3b | Click **Clear filters** | The count and the highlight both go | | |
| 1.4 | Set a scope on Coverage, then come here | The same scope is already applied | | |
| 1.5 | Count the panels | Average score over time, Score distribution, Lowest-scoring agents, By form, Weakest question groups, Evaluations, Critical scores | | |
| 1.6 | **Evaluations** and **Critical scores** | Both start **folded** — they grow with the size of the programme | | |
| 1.7 | Their summaries while folded | Carry a count: "16 in this period", "12 agent(s)" — or "needs a range of 3 months or less" | | |
| 1.8 | Open **Critical scores** | Content is already there — it costs no extra request | | |
| 1.9 | Network tab: load with **Evaluations** folded | **No** row search fires; the folded table costs nothing | | |
| 1.10 | Open **Evaluations** | One row search fires then | | |
| 1.11 | Fold and unfold it again without changing anything | No further request — folding is navigation, not a new question | | |
| 1.12 | Change Scored by or Sort while it is folded, then open it | It fetches on open with the new setting | | |

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
| 7.4 | Short range on Conversation date with nothing back | Reads simply "Nothing here yet." | | |
| 7.5 | Switch org mid-page | Results hide; reloading uses the new org's agents and forms | | |

## 8. Console and cost

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 8.1 | DevTools → Console | No errors, no unhandled rejections | | |
| 8.2 | Network, filter `genesys-proxy`, load once | Six aggregate calls, fired in parallel | | Count: ______ |
| 8.3 | Time a 12-month load on your biggest org | Well under 45 seconds | | ______ s |
| 8.4 | Light mode | Band colours still readable; bar tracks visible | | |

## 9. Weakest question groups (§7.3)

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 9.1 | Load with **no** form selected | The band asks you to select exactly one form; no search runs | | |
| 9.2 | Select **two** forms | It says so, and explains groups are not comparable across forms | | |
| 9.3 | Select **one** form and load | Bars per question group, weakest first, with **real group names** not GUIDs | | |
| 9.4 | Check the order | Lowest average first | | |
| 9.5 | Set a range over three months | The sub-line says how many windows it combined, and it still returns data | | |
| 9.6 | Compare a 12-month result against four separate 3-month loads | Counts should add up and the weighted average should match | | |
| 9.7 | Read the band’s sub-line | Names the form and says "current published version only" — the endpoint rejects a form context id, so this band is scoped to one version. **Answered 2026-09-01** | | |
| 9.8 | If your org has several versions of a form | Counts here may be lower than the By form band, which spans every version. Expected, not a fault | | |

## 10. The evaluations table (§7.4)

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 10.1 | Load a range of three months or less | The table appears with rows | | |
| 10.2 | Columns | Agent, Evaluator, Form, Conversation, Submitted, Score, Critical, Status, Released | | |
| 10.2a | Agent and Form columns | **Names, never GUIDs** | | |
| 10.3 | An AI-scored row | Evaluator reads **Virtual Supervisor** | | |
| 10.4 | **Scored by** — switch between "A person" and "AI" | Both the question-group band AND this table change; page resets to 1 | | |
| 10.4a | Where the control lives | Above the question-group band, not inside this table — it governs both | | |
| 10.4b | On first load | It opens on whichever side has the data, and a line reads "n scored by a person · n scored by AI" | | |
| 10.4c | Switch to the side with nothing | Both bands say the other side has the data and to switch back — never a bare empty | | |
| 10.4d | Reload and switch manually | Your choice sticks; the page stops picking for you | | |
| 10.5 | **The open question.** Compare the two counts against the AI-scored tile | Does "A person" + "AI" equal the total, or does one of them already include both? | | Answer: ______ |
| 10.6 | **Sort by** — change it | Rows re-sort; page resets to 1 | | |
| 10.7 | **Next** / **Previous** | Paging works; Previous disabled on page 1; Next disabled on a short last page | | |
| 10.8 | Set a range over three months | The table hides and explains that only this part is capped | | |
| 10.9 | Narrow the range again | It comes back | | |
| 10.10 | Any row you lack permission for | Shows as "An evaluation you do not have permission to see", not omitted | | |

## 11. Overall

Anything wrong or worth changing:

```


```

Ready to move on to AI Scoring?   Yes / Not yet
