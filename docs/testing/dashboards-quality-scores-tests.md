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
| 1.1a | Open it with **no customer selected** | Says to select a customer, Load is disabled, dropdowns read "Select a customer to load …" | | |
| 1.1b | Select a customer | Message clears, Load enables, dropdowns fill | | |
| 1.2 | Read the permission note | Names `analytics:evaluationAggregate:view` and the Hourly Interacting warning | | |
| 1.3 | Look at the filter bar | Same bar as Coverage, but **no "Dates refer to"** — that is set on Coverage and inherited | | |
| 1.3a | If any filter is set | The bar reads "n filters active" and **Clear filters** is highlighted — selections persist across pages for the session, so this is how you spot one you set earlier | | |
| 1.3b | Click **Clear filters** | The count and the highlight both go | | |
| 1.4 | Set a scope on Coverage, then come here | The same scope is already applied | | |
| 1.5 | Panel order | Average score over time, Score distribution, By form + By media type, Agent average scores, Weakest question groups, Evaluations | | |
| 1.5a | **By media type** | Average score per media type, lowest first, named (Call, Callback, Email) not raw ids. **Call, never Voice** — evaluations use a different enum from conversations | | |
| 1.5b | There is **no** separate Critical scores panel | It is the Total/Critical toggle inside Agent average scores | | |
| 1.6 | **Evaluations** and **Critical scores** | Both start **folded** — they grow with the size of the programme | | |
| 1.7 | Their summaries while folded | Carry a count: "16 in this period", "12 agent(s)" — or "needs a range of 3 months or less" | | |
| 1.8 | Open **Agent average scores** | Content is already there — it costs no extra request | | |
| 1.8a | Default order | **Lowest first** | | |
| 1.8b | **Order** → Highest first | Reverses; the same agents, other end first | | |
| 1.8c | **Score** → Critical | Redraws with critical scores; order may differ from Total | | |
| 1.8d | **Agents** picker | A multi-select: search, tick several, "n selected". No selection means all | | |
| 1.8d1 | Tick two agents | Only those two bars; count says "2 of 2 matching — n in total" | | |
| 1.8d2 | Untick them | All agents return | | |
| 1.8e | **Score between** From/To | Only agents in that band remain | | |
| 1.8f | A combination matching nobody | "No agent matches these filters" | | |
| 1.8g | **Agents shown** | 25 / 50 / 100 / 200 | | |
| 1.8h | Network tab while using any of these | **No new requests** — all of it redraws from data already fetched | | |
| 1.8i | With 200+ agents | The fold keeps the page short; the count says how many of how many | | |
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
| 10.2b | **Score** and **Critical** headings | Right-aligned, sitting directly over their own numbers — not over the next column | | |
| 10.3 | An AI-scored row | Evaluator reads **Virtual Supervisor** | | |
| 10.4 | **Scored by** — switch between "A person" and "AI" | Both the question-group band AND this table change; page resets to 1 | | |
| 10.4a | Where the control lives | Above the question-group band, not inside this table — it governs both | | |
| 10.4b | On first load | It opens on whichever side has the data, and a line reads "n scored by a person · n scored by AI" | | |
| 10.4c | Switch to the side with nothing | Both bands say the other side has the data and to switch back — never a bare empty | | |
| 10.4d | Reload and switch manually | Your choice sticks; the page stops picking for you | | |
| 10.5 | **The open question.** Compare the two counts against the AI-scored tile | Does "A person" + "AI" equal the total, or does one of them already include both? | | Answer: ______ |
| 10.6 | **Sort by** — change it | Rows re-sort; page resets to 1 | | |
| 10.7 | **Next** / **Previous** | Paging works; Previous disabled on page 1; Next disabled on a short last page | | |
| 10.11 | Open the fold on a busy range | It loads every evaluation in the range, showing "Loading… n so far" as it goes | | |
| 10.12 | Column headers | Each column is named **once**, with a small caret beside it — no second row repeating the names | | |
| 10.13 | Click a header's **text** | Sorts by that column; again reverses; an arrow marks it | | |
| 10.14 | Sort **Score** and **Critical** | Sorted as numbers — 100% must not land between 10% and 20% | | |
| 10.15 | Click a header's **caret** | Opens the value list; it does **not** also sort the table | | |
| 10.16 | Check the values offered for Agent | **Every** agent in the range, not just those on the visible page | | |
| 10.17 | **None**, then tick one agent | Only that agent's rows remain, across the whole range; the count and page total both update | | |
| 10.18 | **Previous** / **Next** at the bottom | Pages through the filtered rows; reads "Page 2 of 4"; no new requests fire | | |
| 10.19 | **Rows per page** | 25 / 50 / 100 / 200; re-pages instantly with no new requests | | |
| 10.20 | **Fetch order** at the top | Decides the order rows are fetched in; column sorting works on top of it | | |
| 10.21 | A very busy range (over 2,500) | The count says the list is the first 2,500 and to narrow the dates | | |
| 10.21a | Network tab while it loads | Requests go out five at a time at pageSize 100 — never 200, which the endpoint refuses | | |
| 10.22 | Open the **Score** or **Critical** filter | A **From / To** range, not a hundred checkboxes. Placeholders show the actual lowest and highest | | |
| 10.23 | Type a From value | Filters live; rows with no score drop out, which the panel says | | |
| 10.24 | Set both From and To | Only rows inside the range remain | | |
| 10.25 | Click **Clear** in that panel | Every row returns — the total goes back to the full count, not the page size | | |
| 10.26 | With a filter active, sort a column | The total in the footer does **not** shrink to one page | | |
| 10.27 | Click inside a filter panel | It does not sort the table behind it | | |
| 10.28 | The filter control in each header | A real button beside the name, big enough to hit — not a hairline caret | | |
| 10.29 | Open **Conversation** or **Submitted** | A **date** From/To pair, with the actual first and last date as a hint | | |
| 10.30 | Pick the same date for From and To | That whole day is included, not just its midnight | | |
| 10.31 | Sort **Conversation** | Sorted by real date — April must not come before August | | |
| 10.32 | Click **None** on any column | The table stays put and reads "No rows match these filters." | | |
| 10.33 | Then tick a value back on | The rows return. **The dropdown must stay reachable throughout** | | |

## 10a. Show details drawer

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 10a.1 | Look at the table's second column | **Details**, holding a **Show details** button on every row | | |
| 10a.2 | Its header | Plain text — no filter caret, no arrow, no pointer cursor, not reachable by Tab | | |
| 10a.3 | Every other header | Still sortable and filterable | | |
| 10a.4 | **Open the Score filter** | A From/To **range**. If it shows a list of values, the column indices shifted wrongly | | |
| 10a.5 | Open the **Conversation** filter | Two **date** inputs | | |
| 10a.6 | Click **Show details** | A drawer opens from the right; the table stays visible behind | | |
| 10a.7 | The sub-line | Form, conversation time, score, and **Inbound / Outbound** | | |
| 10a.8 | Right pane | The scored form: question text, the answer chosen, its score, group totals | | |
| 10a.9 | A critical or kill question | Tagged; a failed kill question is flagged in red | | |
| 10a.10 | An AI-scored evaluation where a person changed an answer | Shows what the AI answered, and its explanation | | |
| 10a.11 | Left pane | The transcript, speaker-labelled | | |
| 10a.12 | An interaction with no transcript | Says so plainly — never a spinner that never resolves | | |
| 10a.13 | Without `recording:recording:view` / `speechAndTextAnalytics:data:view` | Transcript pane names the missing permission; **the form still renders** | | |
| 10a.14 | Without `quality:evaluation:view` | Form pane names it; **the transcript still renders** | | |
| 10a.15 | Press **Escape**, then click the scrim | Both close the drawer | | |
| 10a.16 | Turn the page, then open a row | Still works — the button is delegated, not re-bound per render | | |

## 11. Overall

Anything wrong or worth changing:

```


```

Ready to move on to AI Scoring?   Yes / Not yet
