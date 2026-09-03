# Test pass — Dashboards › Quality › STA Configuration

**Step one of two.** This is the configuration half: it reads the chain an
interaction must pass for its agent to be evaluated, and reports every link that
is broken. It needs no conversation data, so it costs a handful of requests
whatever the org's volume, and every answer is a fact rather than an estimate.

The per-agent half — how many evaluations each agent *should* have had given
sampling, and who fell short — comes second, once three questions are settled
against your live org (§9 below).

The chain, in order (design §13.2):

1. Org transcription is not `Disabled`
2. If the mode is per-queue, the queue has transcription on
3. The conversation's queue **or flow** is mapped to a program
4. The program is published
5. A scoring rule on it is enabled **and** published
6. Sampling picks the interaction — *expected behaviour, not a fault*
7. `agentToScore` selects that agent — *expected behaviour, not a fault*
8. The agent holds `quality:evaluation:participate`
9. AI scoring does not fail — already on Coverage

Design: `docs/dashboards-quality-design.md` §13.

Tick **Result** as ✅ / ❌ and put anything odd in **Notes**.

---

## 1. Getting there

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 1.1 | Open **Dashboards › Quality › STA Configuration** | Page loads, no console errors | | |
| 1.2 | Quality has three leaves | Evaluation Coverage, Evaluation Scores, STA Configuration | | |
| 1.3 | Before choosing an org | The button is disabled and it asks you to pick a customer org | | |
| 1.4 | Pick an org, press **Check configuration** | A spinner, then tiles and four panels | | |
| 1.5 | There is no date filter | Correct — this reads current configuration, not a period | | |
| 1.6a | There is no findings or blockers panel | Correct — this page describes the setup. Diagnosing missed evaluations is Evaluation Gaps | | |
| 1.6 | Switch org | Results clear; a fresh check runs against the new org | | |

## 2. The tiles

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 2.1 | Read the tiles | Programs · Queues covered · Flows covered · Scoring rules · Transcription off | | |
| 2.2 | The tiles describe, they do not judge | Counts of what is configured. Nothing here says an evaluation was missed — that is Evaluation Gaps | | |
| 2.4 | **Scoring rules** | Rules that are both enabled and published, across all programs | | |

## 3. Speech and Text Analytics

Four values that apply to every program.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 3.1 | Read the panel, titled **Speech and Text Analytics** | Transcription · Text Analytics on Digital Interactions · Agent Empathy Analysis · Customer Sentiment Analysis · Default program | | |
| 3.2 | Cross-check against Admin | Labels and values should match the Genesys Speech and Text Analytics settings screen | | |
| 3.3 | ★ **Customer Sentiment Analysis** | Reads em-dash, with a line saying Genesys has the setting but the API does not expose it. Confirmed absent from the settings resource on GET, PUT and PATCH, and from every other endpoint | | |
| 3.4 | **Default program** | The program's name. Its ref carries only an id, so the name is resolved from the program list or fetched by id | | |
| 3.5 | No default program set | Reads **None** | | |
| 3.6 | With the settings call refused | Every value reads em-dash with the reason — **never “No” or “None”**. Not knowing is not the same as knowing it is off | | |
| 3.7 | The tiles no longer carry Transcription | It lives in this panel now, with the rest of its family | | |

## 4. Programs and their scoring rules

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 4.1 | Read the Programs table | Program, Published, Queues, Flows, Transcription engines, AI summary and insights, Scoring rules | | |
| 4.1a | **Transcription engines** | The engine and its dialects, e.g. “Extended Voice Transcription Services (da-DK)” | | |
| 4.1b | **AI summary and insights** | Yes/No per program | | |
| 4.1c | Read the **Agent scoring rules** table | One row per rule: Program, State, Selects, Agents scored, Submission, Form, Evaluator | | |
| 4.1d | A program with two rules | Two rows, not one summarised row | | |
| 4.1e | **Form** | The form name, not a GUID | | |
| 4.1f | **Submission** | Automated or Manual | | |
| 4.2 | Cross-check against Genesys | Queue and flow counts should match the program's mappings in Admin | | |
| 4.3 | **Sampling** | The rule's own setting — `All`, or a percentage | | |
| 4.4 | **Scores** | `Each`, `First` or `Last` | | |
| 4.5 | ★ If any rule is `First` or `Last` | Tell me — it makes the per-agent half an upper bound rather than a figure, and changes step two's design | | |
| 4.6 | ★ If any rule samples a percentage | Tell me the value. It decides how many agents can legitimately have no evaluation | | |

## 5. Transcription

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 5.1 | Org on **Enabled Queue Flow** | A row per program-covered queue; ones with it off listed first | | |
| 5.2 | Org on **Enabled Globally** | The panel says there is nothing to check per queue | | |
| 5.3 | Org **Disabled** | A blocking finding covering the whole org, and the per-queue table is skipped entirely — the per-queue flag gates nothing when the org is off | | |
| 5.4 | Cross-check one queue | Its Voice Transcription setting in Admin should match | | |

## 6. Permissions and degrading ★

Each call degrades on its own. The gate is `speechAndTextAnalytics:program:view`.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 6.1 | Without `speechAndTextAnalytics:program:view` | The page is not offered | | |
| 6.2 | Without `quality:scoringRule:view` | The Scoring rules column reads "—" and a note names the permission. **No program is reported as having no scoring rule** — not knowing is not the same as none | | |
| 6.3 | Without `routing:queue:view` | The transcription table says why it is empty; everything else still works | | |
| 6.4 | Without `routing:transcriptionSettings:view` | The Transcription tile shows "—"; the program panel is unaffected | | |
| 6.5 | Any failure at all | A line at the top lists what could not be read and says the rest is still accurate | | |

## 7. Cost

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 7.1 | Network tab | Six requests, plus one per program for its scoring rules | | |
| 7.2 | The count does not grow with interaction volume | This page reads configuration only | | |
| 7.3 | Nothing appears in the Activity Log | Read-only page | | |

## 8. Judgement

| # | Question | Your answer |
|---|---|---|
| 8.1 | Does this explain any of the agents you know are being missed? | |
| 8.2 | Is anything flagged that you know is deliberate? | |
| 8.3 | Is anything you expected to be flagged missing? | |

## 9. ★ What step two needs from this pass

The per-agent half cannot be trusted until these are settled. Answers from §4
above mostly cover it.

| # | Question | Your answer |
|---|---|---|
| 9.1 | Are your rules `Each`, or `First`/`Last`? (§4.5) | |
| 9.2 | What sampling percentages are in use? (§4.6) | |
| 9.3 | Are your programs mapped mostly by queue, by flow, or both? | |
