# Test pass — Dashboards › Quality › AI Scoring

Rebuilt page. The first version reported facts about "AI" as one thing; this one
runs as **two lanes** because Genesys has two features:

- **Auto-evaluation** — AI scores and *submits* the evaluation itself (Virtual
  Supervisor). Fails by producing nothing. You trust it less when people dispute
  or rescore it.
- **Evaluation Assistance** — AI *suggests* answers to a human evaluator, who
  accepts or overrides. Fails by producing something nobody takes. You trust it
  more when the acceptance rate rises.

Nothing is ever added across the two lanes. Everything comes from
`POST /api/v2/quality/evaluations/search`, so the page needs one permission,
`quality:evaluation:searchAny`, and there is no half that degrades on its own.

Design: `docs/dashboards-quality-design.md` §8.

Tick **Result** as ✅ / ❌ and put anything odd in **Notes**.

---

## 1. Getting there

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 1.1 | Open **Dashboards › Quality › AI Scoring** | Page loads, no console errors | | |
| 1.2 | Look under the description | No permission note — the page describes what it shows and nothing about permissions | | |
| 1.3 | Before choosing an org | Filters disabled, message asks you to pick a customer org | | |
| 1.4 | Pick an org | Dropdowns fill; Load becomes available | | |
| 1.5 | Two lanes are visible | **Auto-evaluation** and **Evaluation Assistance**, each with its own heading, its own one-line explanation and its own tiles | | |
| 1.6 | Panels under Auto-evaluation | Did it run? · Did it stick? · Which questions it answered | | |
| 1.7 | Panels under Evaluation Assistance | Are the suggestions taken? · Which questions it answered | | |
| 1.8 | Nothing compares AI to humans anywhere on the page | No score comparison, no AI-vs-human trend, no "AI share" | | |

## 2. Filters

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 2.1 | Change the date range and Load | Both lanes reload; the range line above them matches | | |
| 2.2 | Pick an agent | Both lanes narrow to that agent | | |
| 2.3 | Pick a form | Both "Which questions it answered" bands become available | | |
| 2.4 | Switch the time basis (Conversation / Created / Released) | Both trends re-bucket on that field — the chart should describe the same period the filter bar names | | |
| 2.5 | Navigate away and back | Filters are remembered | | |

## 3. Auto-evaluation — tiles

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 3.1 | Read the tiles | Auto-evaluated · Scoring failures · Disputed · Rescored | | |
| 3.2 | **Auto-evaluated** ★ | The count of evaluations Virtual Supervisor submitted. **Cross-check against Evaluation Scores for the same filters and period — they must agree.** This tile read 0 against a real 18 until 2026-09-01 | | |
| 3.3 | **Scoring failures** | A count *and* a share of auto-evaluations | | |
| 3.4 | A period where AI ran cleanly | Failures reads 0 with "none in this period", not "—" | | |
| 3.5 | A period with **no** auto-evaluations | A note explains the whole lane is zero by definition rather than by failure | | |

## 4. Auto-evaluation — Did it run?

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 4.1 | Read the panel | One bar per failure cause, largest first | | |
| 4.2 | Causes are in plain English ★ | "Quota reached" and "Service error" — never the raw `serviceerror`. The live API lower-cases these, which defeated the label lookup until 2026-09-01 | | |
| 4.3 | Quota reached is present | The sub-line frames it as a commercial limit, not a fault | | |
| 4.4 | No failures in the period | "No AI scoring failures in this period." | | |

## 5. Auto-evaluation — Did it stick? ★

This is one of the two bands the rebuild exists for.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 5.1 | Read the panel | Columns over time, faint gridlines every 25%, axis text underneath | | |
| 5.2 | Read the unit | Counted **per 100 auto-evaluations**, not as a percentage. These are events and one evaluation can be disputed twice, so the figure can legitimately exceed 100 — a percentage would read as a bug | | |
| 5.3 | Hover a column | Date, the rate, and "n of m auto-evaluations" | | |
| 5.4 | A period containing a day with **no** auto-evaluations | That day is a flat neutral tick, **not** a zero-height bar, and its tooltip says so. "Nothing happened" and "0%" must not look the same | | |
| 5.5 | Compare two different periods | The bars are comparable — the axis is fixed 0–100%, it does not rescale to the data | | |
| 5.6 | A range ending today | The last column is hatched and the axis says it is still filling | | |
| 5.7 | Nothing disputed or rescored at all | A note says so under the chart | | |
| 5.8 | Sanity | The axis figure should agree with the Disputed and Rescored tiles, and its denominator with the Auto-evaluated tile | | |

## 6. Evaluation Assistance — tiles

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 6.1 | Read the tiles | Suggestions offered · Suggestions accepted · Acceptance rate | | |
| 6.2 | ★ **Do these show anything at all?** | On the old page these were asked of AI-submitted evaluations, which by definition have none, so they were always zero. If your org runs Assistance, they should now be non-zero | | |
| 6.3 | Every tile says "suggestions", never "evaluations" | Deliberate: there is no way to ask the API for "human evaluations where assistance offered something", so the page must not imply a count it does not have | | |
| 6.4 | Nothing offered in the period | Acceptance rate reads "—", and a note gives the two possible reasons | | |

## 7. Evaluation Assistance — Are the suggestions taken? ★

The other band the rebuild exists for.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 7.1 | Read the panel | Share of suggestions the evaluator kept, per bucket | | |
| 7.2 | Hover a column | Date, the rate, and "n of m suggestions" | | |
| 7.3 | A bucket with no suggestions offered | Flat neutral tick, not a zero bar | | |
| 7.4 | Sanity | The overall figure in the axis should agree with the Acceptance rate tile | | |
| 7.5 | Judgement call | Does this number tell you something you would act on? That is the whole reason the page was rebuilt — say so if it does not | | |

## 8. Which questions it answered — both lanes

Question-level fields can only be aggregated against a single form, so both
bands need exactly one form selected (design §8.2a).

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 8.1 | Load with **no** form selected | Both bands ask for one form; **every other panel still loads** | | |
| 8.2 | Load with **two or more** forms | Same, saying how many are selected | | |
| 8.3 | Select **one** form and load | A bar per question, named, "n of m", least-often-answered first | | |
| 8.4 | Question text has room | Full sentences readable, not all ellipsised to the same prefix | | |
| 8.5 | Compare the two lanes | The Auto band and the Assistance band should show **different** numbers — they are different populations. Identical figures would mean one of them is querying the wrong one | | |
| 8.6 | Read each sub-line | Names the form, says current published version only, and names which of AI / Assistance it is about | | |
| 8.7 | A form AI has never scored | An empty state, not an error | | |

## 9. Degrading and empty states

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 9.1 | Without `quality:evaluation:searchAny` | The page says it needs that permission | | |
| 9.2 | If one lane's totals query fails | That lane says why; **the other lane still works in full** | | |
| 9.2a | If one lane's trend query fails | Only that chart says so — the lane's tiles and its other panels are unaffected | | |
| 9.3 | If a per-question query fails | That band alone says so; its lane's other panels are unaffected | | |
| 9.4 | A period with nothing at all | Clean empty states in both lanes, no errors | | |
| 9.5 | Filters that match nothing | Same | | |
| 9.6 | Every action shows a throbber while loading | Load button disables, panels show spinners | | |

## 10. Cost and hygiene

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 10.1 | Network tab on Load | Four search requests — a totals and a trend request per lane — plus one per per-question band when a form is selected. **No call to `analytics/evaluations/aggregates/query`** | | |
| 10.2 | The lane requests differ | Two carry `systemSubmitted: true`, two `false`. This is the fix for the old page's bug | | |
| 10.3 | Why totals and trend are separate requests | The endpoint allows only one top-level aggregation when sub-aggregations are used, so the histogram must travel alone. The upside: a lane's tiles survive its trend being refused | | |
| 10.4 | A range longer than 3 months | Sub-lines say it was queried in n windows and combined; figures stay coherent | | |
| 10.5 | Nothing appears in the Activity Log | Read-only page | | |

## 11. ★ Open questions

| # | Question | Your answer |
|---|---|---|
| 11.1 | Does the page now answer something you would act on? | |
| 11.2 | Is the Assistance lane populated in your org, or is Assistance simply not in use? | |
| 11.3 | Is "per auto-evaluation" the right denominator for Did it stick?, or would you rather see raw dispute/rescore counts over time? | |
| 11.4 | Would a per-agent or per-evaluator cut of either lane be useful? (Needs checking first — the API may refuse it, design §8.3) | |
