# Test pass — Dashboards › Quality › Evaluation Gaps

The individual interactions that should have been evaluated and were not, one
row per agent who was on the interaction, with the reason.

**Everything is read, nothing is inferred.** Whether an interaction was
evaluated comes from the conversation row itself; recording comes from the
session; duration from the segments; who the rule would score from segment
order; transcript status from a grouped transcript aggregate. The only
configuration in play — programs, rules, queue transcription, permissions —
comes from the same places STA Configuration reads.

**It costs money to run**, in the sense that it pages conversation rows. So
nothing loads on arrival: you choose a range and queues, press **Count
interactions** to see the cost, and only then **Find gaps**.

Design: `docs/dashboards-quality-design.md` §14.

Tick **Result** as ✅ / ❌ and put anything odd in **Notes**.

---

## 1. Getting there

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 1.1 | Open **Dashboards › Quality › Evaluation Gaps** | Page loads, no console errors | | |
| 1.2 | Quality has four leaves | Evaluation Coverage, Evaluation Scores, Evaluation Gaps, STA Configuration | | |
| 1.3 | Before choosing an org | Buttons disabled, message asks for a customer org | | |
| 1.4 | ★ Pick an org | **Only the program list loads** — one request. Nothing else, so an org with many programs opens instantly | | |
| 1.5 | ★ Pick a program | A line under the picker says how many queues that program covers. The queues are a consequence of the program, not a separate choice | | |
| 1.5† | ★ Pick a program mapped to **flows** and no queues | The line reports the flow count and says interactions through those flows count whatever queue answered them. It is NOT treated as empty | | |
| 1.5‡ | ★ Find gaps on a flow-only program | Rows appear for agents who answered on queues the program does not map — a flow is not tied to a queue. The Queue column shows the queue that actually answered | | |
| 1.5a | ★ Pick a program that covers **no queues and no flows** | It says so by name and points at where to map them. Pressing Count says the same rather than running an empty query | | |
| 1.5b | Pick several programs, none covering a queue | Same message, worded for several | | |
| 1.6 | Watch the network tab on open | One call: the programs. Mappings follow when you pick a program; everything else waits for Find gaps | | |
| 1.7 | Only short quick-ranges are offered | Today, Yesterday, This week, Last Week. No 12-month button, because that is a walk nobody should start by accident | | |

## 2. Counting before spending ★

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 2.1 | Press **Count interactions** | The count and the period, nothing else | | |
| 2.2 | **Find gaps** is disabled until you have counted | Yes | | |
| 2.3 | Change any filter after counting | Find gaps disables again — the count was of the old scope | | |
| 2.4 | A range with no interactions | Says so; Find gaps stays disabled | | |
| 2.5 | A range over 4,000 interactions | Warns that only the first 4,000 will be read and suggests narrowing | | |
| 2.6 | From after To | Refuses with a clear message | | |

## 3. The reasons ★

The heart of the page. Each interaction gets the **first** broken link in the
chain, not all of them — a call that was never recorded is not also "not
transcribed" in any useful sense.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 3.1 | Read the bars | One row per reason that occurred, largest first | | |
| 3.2 | Hover a reason | An explanation of what it means | | |
| 3.3 | **Agent lacks Participate** | Agents without `quality:evaluation:participate` | | |
| 3.4 | ~~No program covers the queue~~ | Gone. Scope is chosen by program now, so every queue in view is covered by construction. A queue no program covers is a configuration question — STA Configuration answers it | | |
| 3.5 | **No live scoring rule** | The covering program has no enabled *and* published rule | | |
| 3.6 | **Queue transcription off** | Only when the org is on Enabled Queue Flow | | |
| 3.7 | ★ **Recording not kept** | Started and then discarded. Cross-check: Genesys should say “There is no recording for this interaction” | | |
| 3.7a | ★ **Recording never started** | No recording was started at all — a different problem from the above, fixed in a different place | | |
| 3.7b | The Recording column | Yes / Not kept / Never started / Not checked. “Not checked” is honest rather than a failure: the page only asks where the answer changes something, and stops at a cap | | |
| 3.7c | ★ A row with **Recording: Not kept** and **Transcribed: Yes** | Legitimate — a recording can be deleted after it has been transcribed. Its reason must NOT be “recording not kept”: the transcript proves the audio did its job, so the failure is downstream | | |
| 3.8 | ★ **Shorter than the threshold** | Genesys does not evaluate below the threshold, so this is checked BEFORE recording and transcript: a short call is not evaluated however well it was recorded. Change the threshold and reload; rows should move | | |
| 3.9 | **Not transcribed** | Recorded, long enough, and no transcript | | |
| 3.10 | **Another agent was the one scored** | Only on multi-agent conversations, and only when the rule scores First or Last. This is *working as configured*, not a fault | | |
| 3.11 | ★ **Unexplained** | Everything checked was in order. **These are the ones to investigate** — tell me what you find, because they are what the page exists for | | |

## 4. The interactions table

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 4.1 | Read the columns | Agent, Queue, Time, Duration, Recording, Transcribed, Why — in that order | | |
| 4.1a | Sort by any column | Clicking a header sorts by it; clicking again reverses | | |
| 4.1b | ★ Sort by **Duration** | Sorts as a number, not as text: 12s before 45s before 10m. Text order would put 10m first | | |
| 4.1c | **Time** filter | A From/To date range, not a list of timestamps | | |
| 4.1d | **Duration** filter | A From/To range in seconds, not a list of durations | | |
| 4.1e | Filter Duration to 40–200 | Only rows in that band remain | | |
| 4.1§ | ★ The **Interactions** tile against the range line | The tile carries one number — interactions with an agent in scope. The range line carries the fetched count. They differ because the query returns abandoned calls and interactions answered elsewhere, which produce no rows | | |
| 4.1g | ★ Missing evaluations exceeds interactions read | Expected — one row per agent, so a conversation two agents handled counts twice. The tile says “across N interaction(s)” so the two numbers can be reconciled | | |
| 4.1h | ★ One agent on one interaction | Appears **once**, even if they were a participant several times — a transfer back or a consult. Their time is merged | | |
| 4.2 | An interaction that **was** evaluated | **No row at all.** Evaluated agents are not gaps | | |
| 4.3 | A conversation with two agents, one evaluated | Only the unevaluated agent gets a row | | |
| 4.4 | Filter by reason | The table narrows; the count in the dropdown matches | | |
| 4.5 | Hover a Time cell | The conversation id, for looking it up in Genesys | | |
| 4.5a | ★ Right-click any row | Copies the Conversation ID; a line confirms which. The browser's own menu does not appear | | |
| 4.5b | Paste it into Genesys | Finds the interaction | | |
| 4.5c | Right-click a **header** | Copies nothing — the browser menu behaves normally there | | |
| 4.5d | Sort or filter, then right-click again | Still copies. The gesture survives a redraw | | |
| 4.5e | The tip above the table | Says right-click copies the Conversation ID | | |
| 4.6 | Duration | The agent's own segment time, not the whole conversation | | |
| 4.7 | Over 500 rows | Shows the first 500 and says so | | |

## 5. Cross-checks ★

The numbers have to survive comparison with the rest of the app.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 5.1 | Pick a day and a queue you know well | The interactions read should match what Genesys shows for that queue and day | | |
| 5.2 | Compare against **Evaluation Coverage** for the same day | Coverage's evaluation count plus these missing ones should be consistent with the interaction volume | | |
| 5.3 | Take one Unexplained row to Genesys | Confirm it really has no evaluation, was recorded, and was transcribed | | |
| 5.4 | Take one "Another agent was the one scored" row | Confirm the other agent on it *was* evaluated | | |

## 6. Degrading

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 6.1 | Without `analytics:speechAndTextAnalyticsAggregates:view` | "Not transcribed" disappears as a reason, those rows fall into Unexplained, the Transcribed column reads "—", and a note explains why | | |
| 6.2 | Without the role lookup | The permission reason is not offered rather than guessed at | | |
| 6.3 | Without `analytics:conversationDetail:view` | The page is not offered at all | | |
| 6.4 | Nothing appears in the Activity Log | Read-only page | | |

## 7. ★ The judgement calls

| # | Question | Your answer |
|---|---|---|
| 7.1 | Does the Unexplained list contain the agents you know are being missed? | |
| 7.2 | Is the 30-second default right? What value makes the "too short" group match reality? | |
| 7.3 | Is one row per agent-interaction the right grain, or would one row per interaction be easier to read? | |
| 7.4 | Is 4,000 interactions a sensible cap, or do you need the async job route for bigger pulls? | |
