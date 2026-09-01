# Test form — Dashboards › Quality › AI Scoring

Page: **Dashboards › Quality › AI Scoring** (`/dashboards/quality/ai-scoring`)
Design: [dashboards-quality-design.md](../dashboards-quality-design.md) §8
Environment: **dev**
Tester: ______________________  Date: ______________________

## What this page is

Everything here is about **AI-scored** evaluations. In an org where nothing is
AI-scored it is legitimately all zero, and the page says so rather than looking
broken — that is a pass, not a failure.

It draws on two sources. The AI-specific figures (failures, suggestions,
disputes, rescores, which questions the model answered) come from the evaluation
search and are chunked across 3-month windows, so **there is no date-range
limit**. The plain counts, the trend and the score comparison come from the
aggregate domain, which needs a permission this page does not require — those
bands degrade on their own.

---

## 1. Access and shape

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 1.1 | Open **Dashboards › Quality › AI Scoring** | The real page, not "Coming soon" | | |
| 1.3 | Open with **no customer selected** | Prompts you to select one; Load disabled; dropdowns say "Select a customer to load …" | | |
| 1.4 | Filter bar | Same shared bar, no "Dates refer to" — that is set on Coverage | | |
| 1.5 | Panels | AI and human evaluations over time; Why AI scoring failed; Suggestions offered and accepted; AI-scored against human-scored; Which questions the model answered; After the model answered | | |
| 1.6 | No permission note anywhere on the page | The page describes what it shows and nothing about permissions | | |

## 2. Tiles

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 2.1 | Load a period with AI scoring | Six tiles: AI-scored, AI share, Suggestions accepted, Scoring failures, Disputed, Rescored | | |
| 2.2 | **AI share** | A percentage, with the human count underneath | | |
| 2.3 | Cross-check AI share against the **Coverage** page's AI-scored tile | Same split for the same period | | Coverage: ______ / here: ______ |
| 2.4 | **Suggestions accepted** | A percentage, with "n of m offered" underneath | | |
| 2.5 | **Scoring failures** | A count; "none in this period" when zero | | |
| 2.6 | Range line | Reads "n AI-scored of m" | | |

## 3. The trend

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 3.1 | Look at the chart | Stacked columns — AI on top of human, one column per bucket | | |
| 3.2 | Hover a column | "n AI · m human" for that bucket | | |
| 3.3 | The axis | A colour key and the totals for both | | |
| 3.4 | Load a single day | Hourly buckets | | |
| 3.5 | Load Last 12 Months | Weekly buckets, and it still works — no 3-month limit | | |
| 3.6 | A range ending **today** | The last column is dimmed and the axis says it is still filling | | |

## 4. Why AI scoring failed

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 4.1 | Look at the panel | One bar per failure cause, largest first | | |
| 4.2 | Labels | Readable English — "Quota reached", "Service error" — never raw enum values like `QuotaReached` | | |
| 4.3 | If **Quota reached** appears | **Worth knowing.** It means the org has scored as much as it bought, not that anything is broken | | Count: ______ |
| 4.4 | An org with no failures | "No AI scoring failures in this period." | | |

## 5. Suggestions

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 5.1 | Look at the panel | Four bars: AI suggested / accepted, Assistance suggested / accepted | | |
| 5.2 | Accepted bars | Green, and never larger than their suggested bar | | |
| 5.3 | AI scoring and Evaluation Assistance | Kept apart, not added together — an org may run one, both or neither | | |
| 5.4 | Over a range longer than three months | Sub-line says how many windows it combined | | |
| 5.5 | Compare a 6-month load with two 3-month loads | The totals should add up | | |

## 6. AI-scored against human-scored

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 6.1 | Look at the panel | Two bars, average score each, with the evaluation count beside | | |
| 6.2 | Bar widths | Track the **average**, not the count — a 90% bar is nearly full regardless of volume | | |
| 6.3 | A period with only AI scoring | One bar, and a note saying there is nothing to compare with | | |
| 6.4 | Cross-check against **Evaluation Scores** | The averages should agree for the same period and filters | | |

## 7. Which questions the model answered, and what happened after

Question-level fields can only be aggregated against a single form, so this band
needs exactly one form selected. See design §8.2a.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 7.1 | Load with **no** form selected | The questions panel asks for one form; **every other panel still loads** | | |
| 7.2 | Load with **two or more** forms selected | Same, saying how many are selected | | |
| 7.3 | Select **one** form and load | A bar per question, named, reading "n of m", least-often-answered first | | |
| 7.4 | Read the sub-line | Names the form and says current published version only | | |
| 7.5 | Sanity | The "of m" figures should be the same for every question on the form | | |
| 7.6 | A form AI has never scored | An empty state, not an error | | |
| 7.7 | "After the model answered" panel | Disputes raised, Rescored by a person | | |
| 7.8 | Sanity | Disputes and rescores should match the tiles, and **should not both be zero** if the tiles are non-zero | | |

## 8. Degrading and empty states

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 8.1 | Without `analytics:evaluationAggregate:view` | AI-scored and AI share tiles show "—"; the trend and the comparison say which permission is missing; **failures, suggestions, questions and "after" still work** | | |
| 8.2 | Without `quality:evaluation:searchAny` | The page says it needs that permission | | |
| 8.3 | A period with evaluations but **none AI-scored** | A note explains everything is zero by definition, not by failure | | |
| 8.4 | A period with nothing at all | Clean empty states, no errors | | |
| 8.5 | Filters that match nothing | Same | | |

## 9. Cost and hygiene

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 9.1 | DevTools → Console | No errors, no unhandled rejections | | |
| 9.2 | Network, one load of a 1-month range | One search call plus four aggregate calls | | Count: ______ |
| 9.3 | Network, one load of a 12-month range | Four search calls (one per window) plus four aggregate calls | | Count: ______ |
| 9.4 | Every search request body | Carries `systemSubmitted: true` — this page is only ever about AI | | |
| 9.5 | Time a 12-month load on your biggest org | Well under 45 seconds | | ______ s |
| 9.6 | Light mode | Stack colours and bar colours still readable | | |

## 10. ★ Open question — by agent

The design (§8.3) flagged that `agentId` appears in the search aggregation field
enum but is missing from that endpoint's own "allowed fields by aggregation
type" list. No by-agent band was built because of it.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 10.1 | Would a per-agent view of AI scoring be useful to you? | — | | Answer: ______ |

If yes, I will test whether `agentId` is aggregatable before designing it.

## 11. Overall

Anything wrong or worth changing:

```


```

Ready to call Dashboards › Quality finished?   Yes / Not yet
