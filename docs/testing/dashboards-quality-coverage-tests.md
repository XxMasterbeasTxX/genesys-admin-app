# Test form — Dashboards › Quality › Evaluation Coverage

Page: **Dashboards › Quality › Evaluation Coverage** (`/dashboards/quality/coverage`)
Design: [dashboards-quality-design.md](../dashboards-quality-design.md) §6
Environment: **dev**
Tester: ______________________  Date: ______________________
Build / commit: ______________________

## How to use this form

Work top to bottom. Each case says what to do and what should happen; write
**P** (pass), **F** (fail) or **N/A** in the result box and add a note when it
is not a clean pass.

Cases marked **★ UNKNOWN** are not regression checks — they answer questions the
Genesys API documentation does not, and their answers change what gets built on
the next two pages. Record the actual result even when nothing looks broken.

Pick an org with a real QM programme for §2–§6. If none of your orgs evaluates
anything, §8 is the one that matters and the rest will legitimately be empty.

---

## 1. Access and nav

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 1.1 | Log in as a Master Admin / Admin group member | **Dashboards** appears in the sidebar, between Data Tables and Divisions | ☐ | |
| 1.2 | Expand Dashboards | One child folder, **Quality** | ☐ | |
| 1.3 | Expand Quality | Three leaves: Evaluation Coverage, Evaluation Scores, AI Scoring | ☐ | |
| 1.4 | Click **Evaluation Scores** | "Coming soon" placeholder — it is not built yet | ☐ | |
| 1.5 | Click **AI Scoring** | "Coming soon" placeholder | ☐ | |
| 1.6 | Click **Evaluation Coverage** | The real page loads: heading, description, filter bar, Load button | ☐ | |
| 1.7 | Look under the description | No permission note — the page describes what it shows and nothing about permissions | ☐ | |
| 1.8 | Log in as a **Support** group member | Dashboards does **not** appear — Support was deliberately not granted it | ☐ | |

> **Decision for you after 1.8:** should Support get `dashboards.*`? They already
> have `export.*`, `audit.*` and `interactions.search.*`, so read-only
> dashboards fit the profile — but it is a grant, so it is your call, not mine.
> Answer: ______________________

---

## 2. Filter bar — shape and behaviour

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 2.1 | Look at the filter bar | Three captioned bands: **When**, **Who**, **What** | ☐ | |
| 2.2 | Check the When band | From, To, eight quick-range buttons, and a **Dates refer to** dropdown | ☐ | |
| 2.3 | Open the **Dates refer to** dropdown | Three options: Conversation date, Created, Released | ☐ | |
| 2.4 | Check the Who band | Agents, Work Teams, Divisions — **no Groups dropdown** (dropped by design) | ☐ | |
| 2.5 | Check the What band | Forms, Media types, Clear filters - **no Queues** | ☐ | |
| 2.5a | Open **Media types** | Offers **Call**, not Voice — evaluations use a different media enum from conversations, and filtering on Voice can never match | ☐ | |
| 2.6 | Try to set **To** to today | Allowed — max is **today**. The range is partial and the page marks it as such | ☐ | |
| 2.6a | Default range on first load | **Yesterday**, with that preset highlighted | ☐ | |
| 2.6b | Click **Today**, then **This week**, then **Yesterday** | Each fills the dates and highlights; This week runs Monday → today | ☐ | |
| 2.6f | On a **Monday**, click This week | Only **This week** highlights, even though the dates equal Today. Clicking Today then highlights only Today | ☐ | |
| 2.6c | With **Today** selected, load, and look at the trend | Buckets are **hourly**, not one single column | ☐ | |
| 2.6d | Same view — the final column | Drawn hatched; the axis says "last bucket still filling" | ☐ | |
| 2.6e | Around midnight local, click **Today** | The range starts at your local midnight, not 02:00 — days are cut in your own timezone, not UTC | ☐ | |
| 2.7 | Click **Last Month** | Dates fill in as the whole previous calendar month, and the button highlights | ☐ | |
| 2.8 | Click **Last 12 Months** | Dates span 12 whole months; highlight moves to that button | ☐ | |
| 2.9 | Type a From date later than To | An amber warning line appears under the bar: "The start date is after the end date." | ☐ | |
| 2.10 | With that invalid range, click **Load dashboard** | Refuses with "Fix the date range before loading." — no API call | ☐ | |
| 2.10a | **Before pressing Load**, open **Agents** | The list is already populated and opens — filter options load when the page opens, not when you press Load | ☐ | |
| 2.10b | While they are still loading | Each dropdown reads "Loading agents…" etc. and is greyed out — never a live-looking button that ignores clicks | ☐ | |
| 2.10c | Set an agent filter, then press Load | Loads with that scope, first time, without a load beforehand | ☐ | |
| 2.10d | If a list fails or is empty | That one dropdown stays disabled saying "No work teams" / "evaluation forms unavailable"; the others still work | ☐ | |
| 2.11 | Fix the dates, open **Agents** | A searchable checkbox list of active users, with Select all | ☐ | |
| 2.12 | Type in the Agents search box | List filters; "Select all matching (n)" changes accordingly | ☐ | |
| 2.13 | Select two agents, then click **Clear filters** | All dropdowns reset to their "All …" placeholders; dates are untouched | ☐ | |

### 2a. Filter persistence across pages

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 2.14 | Set a distinctive scope (e.g. one agent + one form + Today) | — | ☐ | |
| 2.15 | Navigate to **Evaluation Scores**, then back to Coverage | Every selection is still there, dates included | ☐ | |
| 2.16 | Navigate to a page in another section (e.g. Audit › Search) and back | Selections still there | ☐ | |
| 2.17 | Open the app in a **new browser tab** and go to Coverage | Selections are **not** carried over — this is sessionStorage, and that is intended | ☐ | |

---

## 3. Loading and the org selector

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 3.0 | Open the page with **no customer selected** | It says "Please select a customer org from the dropdown above to get started.", Load is disabled, and each dropdown reads "Select a customer to load agents" — never a permanent "Loading…" | ☐ | |
| 3.0a | Now select a customer | The message clears, Load enables, and the dropdowns fill | ☐ | |
| 3.0b | Clear the customer again | The prompt comes back and the previous customer’s names go | ☐ | |
| 3.1 | With **no org selected**, click Load dashboard | Red status: "Please select a customer org from the dropdown above." | ☐ | |
| 3.2 | Select an org, click Load dashboard | Status progresses: filter options → aggregates → which agents can be evaluated → evaluator activity | ☐ | |
| 3.3 | While loading | Load button disabled, all filter controls greyed out | ☐ | |
| 3.4 | After loading | Controls re-enable; results appear below | ☐ | |
| 3.5 | Change org in the header dropdown | Results hide themselves rather than showing the previous customer's numbers | ☐ | |
| 3.6 | Click Load dashboard for the new org | Dropdowns repopulate with **the new org's** queues/forms/agents — not the previous one's | ☐ | |
| 3.7 | Reload the page (F5) and click Load twice in a row | Second load is noticeably faster — option lists are not re-fetched for the same org | ☐ | |

---

## 4. The results — tiles

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 4.1 | Look at the range line above the tiles | Reads like "1 Jul 2026 — 31 Jul 2026 · 1,284 evaluations" | ☐ | |
| 4.2 | Count the tiles | Six: Evaluations, Agents evaluated, Not evaluated, Evaluations per agent, Released, AI-scored | ☐ | |
| 4.3 | **Evaluations** tile | A count, with a sub-line naming the time basis in use | ☐ | |
| 4.4 | **Agents evaluated** tile | A count, and a sub-line stating the denominator — e.g. "39% of 210 who can be evaluated" | ☐ | |
| 4.5 | **Evaluations per agent** | A one-decimal number, sub-line "among agents who were evaluated" | ☐ | |
| 4.6 | **Released** | A percentage plus "n of m" underneath | ☐ | |
| 4.7 | **AI-scored** | A percentage plus "n AI · m human" underneath | ☐ | |
| 4.8 | Cross-check: does Released "n of m" match the Evaluations tile's m? | Yes — same total | ☐ | |
| 4.9 | Cross-check: does AI + human equal the Evaluations total? | Should match. **If it does not, note both numbers** — it means `systemSubmitted` does not partition the way the design assumes | ☐ | |

### ★ UNKNOWN 4.10 — does the coverage denominator work?

The denominator is now the set of users holding `quality:evaluation:participate`
— the permission that makes an agent evaluatable at all. The permission string
is the one thing here that no machine-readable source confirms, so this case
also verifies the string itself.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 4.10 | Look at the **Agents evaluated** sub-line | One of: **(a)** "39% of 210 who can be evaluated", **(b)** "no role grants evaluation participate", **(c)** "coverage % needs authorization:role:view", **(d)** "eligible agents unavailable" | ☐ | Which? ______ |
| 4.11 | Look at the **Not evaluated** tile | A count of agents who can be evaluated but have nothing in this period | ☐ | |
| 4.12 | Sanity-check that count against the org | Plausible — not zero in an org that evaluates a sample, not the whole headcount | ☐ | |

**(a)** is the good case. **(c)** is correct behaviour — the page is reporting a
permission it deliberately does not require, and degrades rather than fails.

**(b) is the one to report.** It means either the org grants the permission to
nobody, or `quality:evaluation:participate` is not the right string. Check in
Genesys under Roles whether any role has Quality › Evaluation › Participate
ticked; if one does and the app still says (b), the string is wrong and I need
the real one.

## 5. The results — charts and bands

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 5.1 | **Evaluations over time** panel | A column chart, one column per day for short ranges | ☐ | |
| 5.2 | Sub-line under that title | Says "Daily buckets · <range>" for a range under ~2 months | ☐ | |
| 5.3 | Set the range to Last 12 Months and reload | Sub-line now says "**Weekly** buckets"; columns are readable, not hairlines | ☐ | |
| 5.4 | Hover a column | Tooltip shows the date and the count | ☐ | |
| 5.5 | Read the axis line under the chart | Start date on the left, "peak n" in the middle, end date on the right | ☐ | |
| 5.7 | **By form** panel | Bars labelled with real form names — not GUIDs | ☐ | |
| 5.8 | **By agent** panel | Bars labelled with real user names; sub-line says "the top 25 of n" | ☐ | |
| 5.9 | **By evaluator** panel | Real user names, and the bars are a different colour from the agent panel | ☐ | |
| 5.10 | If any band has more than 25 rows | A line underneath reads "…and n more." | ☐ | |
| 5.11 | Any bar labelled "Unknown user (abc12345…)" or "Unknown form (…)"? | Possible and not a bug — deactivated users and deleted forms do this. **Note how many** | ☐ | Count: ______ |
| 5.13 | Add up the By agent bars (top 25 plus "…and n more") | Row count should equal the **Agents evaluated** tile | ☐ | |

---

## 5a. No queue anywhere, and the AI evaluator

Queue filtering was removed - evaluations carry no queue, and the queue the
Genesys Interactions view shows belongs to the conversation. See design 9a.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 5.14 | Look at the filter bar | **No Queues dropdown.** Agents, Work Teams, Divisions, Forms, Media types only | | |
| 5.15 | Look at the panels | **No By queue panel.** By form runs full width | | |
| 5.16 | On an AI-scored period, check **By evaluator** | Reads **Virtual Supervisor (AI scoring)** - never "Unknown user", never "No evaluator" | | |
| 5.17 | On a period with human evaluations | Real evaluator names appear | | |
| 5.18 | Set a filter that matches nothing, load | Tiles show 0 and a note says how many evaluations exist and to clear filters one at a time | | |
| 5.19 | Same load, check the network tab | Exactly one extra aggregate call - the unfiltered check. On a normal load there is none | | |
| 5.20 | Anywhere on the page | **No** "Show the queries this page sent" panel - the diagnostics were removed once they had done their job | | |

## 6. Evaluator workload table

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 6.1 | Scroll to **Evaluator workload** | A table: Evaluator, Assigned, Started, Completed, Outstanding, Calibrations assigned, Calibrations completed | ☐ | |
| 6.2 | Check the Outstanding column | Equals Assigned − Completed, never negative | ☐ | |
| 6.3 | Check sort order | Highest Assigned first | ☐ | |
| 6.4 | Are evaluators with zero activity shown? | No — they are filtered out | ☐ | |
| 6.5 | Do the calibration columns have any non-zero values? | **Note the answer** — it tells us whether calibrations are worth a page later | ☐ | |
| 6.6 | Select **two** Work Teams in the filter and reload | An amber note under the table says it is org-wide because the endpoint accepts only one team | ☐ | |
| 6.7 | Select **one** Work Team and reload | No such note; the table is filtered to that team | ☐ | |
| 6.8 | Is there a note about evaluations not visible to you? | Only if the OAuth client cannot see some — if it appears, **note the number** | ☐ | |

---

## 7. Time basis — the control that changes the answer

Do this with a range where you know evaluations exist.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 7.1 | Set **Dates refer to = Conversation date**, load, note the Evaluations total | — | ☐ | Total: ______ |
| 7.2 | Switch to **Created**, reload | The total **changes** (usually higher for a recent range — evaluations of older calls) | ☐ | Total: ______ |
| 7.3 | Switch to **Released**, reload | Changes again, usually the lowest of the three | ☐ | Total: ______ |
| 7.4 | Does the Evaluations tile sub-line follow the control? | It names the basis in use | ☐ | |

If all three totals are **identical**, that is suspicious — note it. It would
mean `alternateTimeDimension` is not being applied.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 7.5 | Click **Today**, set basis to **Conversation date**, load | In an org with AI scoring on, this is **populated** — AI scores a conversation almost immediately | ☐ | |
| 7.6 | If it comes back empty | Reads simply "Nothing here yet." | ☐ | |
| 7.7 | Switch that same Today view to **Created** | Shows the evaluation work actually done today, of conversations from any date | ☐ | |

---

## 8. Empty and edge cases

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 8.1 | Pick an org with **no QM programme** and load | Page loads cleanly; tiles show "—"; every band says "No evaluations in this period." — no blank panels, no errors | ☐ | |
| 8.2 | Pick a date range far in the past with no data | Same — clean empty states | ☐ | |
| 8.3 | Set From and To to the **same single day** | Loads; one column in the trend | ☐ | |
| 8.4 | Set a range over two years long | An amber note warns it is a very long range; it still loads | ☐ | |
| 8.5 | Filter to an agent with no evaluations | Empty states everywhere, no error | ☐ | |
| 8.6 | Filter to a queue **and** a form that never co-occur | Empty states, no error | ☐ | |
| 8.7 | Resize the browser to ~1100px wide | The three filter bands stay intact — controls do not regroup themselves across bands | ☐ | |
| 8.8 | Resize to a narrow window | Panels stack; the workload table scrolls horizontally inside its own box, the page does not | ☐ | |
| 8.9 | Switch OS/browser to light mode | Readable: bar tracks visible, amber notes legible, table hover works | ☐ | |

---

## 9. ★ UNKNOWN — the two questions that change the next pages

These are the §10 unknowns from the design. They are the reason this test pass
happens before Scores and AI Scoring are built.

### 9.1 Is there an undocumented interval ceiling on evaluation aggregates?

The spec states none, but the *conversation* aggregate domain enforces one in
practice. If evaluation aggregates do too, Coverage and Scores need the same
window-chunking the AI page was going to use.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 9.1a | Set the range to **Last 12 Months**, load | Loads without error | ☐ | |
| 9.1b | Set From to **2 years ago**, To to yesterday, load | Loads without error | ☐ | |
| 9.1c | Set From to **3 years ago**, load | Loads, or fails | ☐ | |

If any of these fails, copy the **exact error message** here — the wording tells
us the ceiling:

```
```

### 9.2 How slow does it get?

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 9.2a | Time a **Last Month** load on your biggest org | Seconds | ☐ | ______ s |
| 9.2b | Time a **Last 12 Months** load on the same org | Seconds — well under 45, which is where `/api` calls die | ☐ | ______ s |
| 9.2c | Open DevTools → Network, filter to `genesys-proxy`, and load | Around 10 calls, fired in parallel rather than one after another | ☐ | Count: ______ |

If 9.2b is anywhere near 45 seconds, say so — it changes how the next two pages
fetch.

---

## 10. Console and network hygiene

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 10.1 | Open DevTools → Console, load the page | No red errors, no unhandled promise rejections | ☐ | |
| 10.2 | Navigate away from Coverage to another page | No errors; nothing keeps running in the background | ☐ | |
| 10.3 | Network tab — check one aggregates call's request body | `interval`, `metrics`, `groupBy`, `alternateTimeDimension`, and a `filter` with `or` clauses when filters are set | ☐ | |
| 10.4 | Set two queues in the filter and check the body again | One `or` clause containing both queue predicates | ☐ | |
| 10.5 | Set two queues **and** one agent | Two `or` clauses, ANDed at the top level | ☐ | |

---

## 11. Overall

Anything that felt wrong, confusing, or worth changing before Scores gets built:

```




```

Is the page answering the question it claims to answer — *are we evaluating
enough, evenly, and are evaluators keeping up?*  Yes / No / Partly:

```


```

Ready to proceed to **Evaluation Scores**?  ☐ Yes  ☐ Not until the above is fixed
