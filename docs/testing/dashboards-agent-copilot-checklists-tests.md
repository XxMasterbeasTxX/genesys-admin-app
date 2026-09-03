# Test pass — Dashboards › Agent Copilot › Checklists & Summaries

The interactions that ran with an Agent Copilot checklist, whether it was
completed, and the AI summary written afterwards.

**Two ticks, not one.** Every checklist item carries a state from the agent and
a state from the model. An item the model ticked and the agent never touched is
still *complete* — but it says something quite different about whether the agent
was engaged. Most of what is worth testing here lives in that distinction.

**A checklist with no items is undetermined, not failed.** It belongs to neither
bar and reads "No items". Anything that counts it as incomplete is a bug.

**It costs money to run.** Enrichment is three to four calls per conversation
and there is no aggregate to fall back on, so nothing loads on arrival but the
copilot list: choose scope, press **Count interactions** to see the cost, then
**Load checklists**.

Design: `docs/dashboards-agent-copilot-design.md`.

Ticks marked ★ are the ones that would matter most if they broke.

Tick **Result** as ✅ / ❌ and put anything odd in **Notes**.

---

## 1. Getting there

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 1.1 | Open **Dashboards › Agent Copilot › Checklists & Summaries** | Page loads, no console errors | | |
| 1.2 | Dashboards now has two folders | Quality (four leaves) and Agent Copilot (one) | | |
| 1.3 | Before choosing an org | Message asks for a customer org; nothing loads | | |
| 1.4 | ★ Pick an org, watch the network tab | **Only the assistants call fires.** No queues, no conversations, no wrap-up codes | | |
| 1.5 | An org with no copilot-enabled assistants | Says so plainly and names the condition (copilot enabled, or live on a queue) rather than showing an empty dropdown | | |
| 1.6 | Only short quick-ranges are offered | Today, Yesterday, This week, Last week. Nothing longer, because the enrichment cost makes a long range a walk nobody should start by accident | | |

## 2. The cascade ★

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 2.1 | Select one copilot | Queue picker fills with that copilot's queues; a hint says how many | | |
| 2.2 | Select a second copilot | Queues from both, de-duplicated | | |
| 2.3 | Select queues | Agent picker fills with those queues' members | | |
| 2.4 | ★ A copilot that covers **no queues** | Hint says so, and says the search still works because the copilot itself is the filter. **Count and Load are NOT blocked** | | |
| 2.5 | ★ Leave queues and agents empty entirely | Search runs on the copilot alone. This is the intended path, not a degraded one | | |
| 2.6 | Deselect every copilot | Queue and agent pickers empty and disable | | |
| 2.7 | Re-select a copilot already loaded once | No repeat network call — the queue set is cached per assistant | | |

## 3. Counting before spending ★

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 3.1 | Press **Count interactions** | The count, the period, and an estimate of how many requests loading will take | | |
| 3.2 | **Load checklists** is disabled until you have counted | Yes | | |
| 3.3 | Change any filter after counting | Load disables again — the count was of the old scope | | |
| 3.4 | A range with no interactions | Says so; Load stays disabled | | |
| 3.5 | No copilot selected | Refuses and says to pick one | | |
| 3.6 | From after To | Refuses with a clear message | | |
| 3.7 | ★ A custom range of **32 days or more** | Refused *before any request*, naming the 31-day limit. Genesys would reject it anyway; this fails fast instead | | |
| 3.8 | A custom range of exactly **31 days** | Accepted and runs. 31 is allowed on a filtered query — see api-reference §2.1 | | |

## 4. The table

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 4.1 | Press **Load checklists** | Rows appear immediately from the analytics data — before any checklist arrives | | |
| 4.2 | ★ Watch the Checklist and Status columns | They start as "…" and fill in progressively as enrichment lands. The page stays usable throughout | | |
| 4.3 | ★ The **Copilot** column | Names the assistant, read off the interaction. Check one against Genesys: on a queue served by more than one assistant it must show the one that actually ran | | |
| 4.4 | A transferred interaction | The Agent column lists every agent, comma-separated — and each person appears **once**, however many times they were transferred back and forth | | |
| 4.5 | Sort by any column | Sorts; Duration sorts numerically, not as text | | |
| 4.6 | Filter **Time** and **Duration** | Both offer a FROM/TO range rather than a list of checkboxes | | |
| 4.7 | Right-click a row | Conversation ID copied, confirmed in the status line | | |
| 4.8 | More than 500 matching rows | First 500 shown, with a note saying so and what to do | | |

## 5. Status — the part most likely to be subtly wrong ★

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 5.1 | ★ An interaction with **no checklist at all** | "No checklist" — **not** "Incomplete" | | |
| 5.2 | ★ A checklist carrying **no items** | "No items". Counted in neither bar, and not by the Incomplete filter | | |
| 5.3 | ★ Every item ticked by the **agent** | Complete | | |
| 5.4 | ★ Every item ticked **only by the model**, none by the agent | **Complete.** A model tick is a tick | | |
| 5.5 | One item unticked by both | Incomplete | | |
| 5.6 | Two checklists, one finished and one not | Incomplete — completion is across all of them | | |
| 5.7 | An interaction whose enrichment failed | Red "Error"; hovering shows why. Other rows keep working | | |

## 6. Filters

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 6.1 | **Complete** / **Incomplete** | Only those; "No items" rows appear under neither | | |
| 6.2 | **Has summary** | Only interactions with an AI summary | | |
| 6.3 | ★ **Agent checked** on its own | Only interactions where the agent ticked at least one item personally. An interaction the model completed alone must NOT appear | | |
| 6.4 | ★ **Agent checked** combined with **Incomplete** | Both applied together — the toggle is independent of the status buttons, not a fifth option | | |
| 6.5 | Change a filter | Chart and table update together | | |
| 6.6 | A filter matching nothing | Says so rather than showing an empty table | | |

## 7. Completion bars

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 7.1 | Read the bars | Complete (green) and Incomplete (amber), widths relative to the larger | | |
| 7.2 | Before enrichment finishes | Says nothing has been judged yet rather than drawing empty bars | | |
| 7.3 | ★ Bars agree with the table | Same population, same numbers, one definition behind both | | |

## 8. Drill-down — checklists and summaries

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 8.1 | Click a row | The results table **collapses** and the detail opens, with the conversation ID. The row stays marked | | |
| 8.1a | Click the same row again | Detail closes and the table comes back | | |
| 8.1b | Press the **Search results** chevron | Table folds and unfolds on its own | | |
| 8.2 | ★ Each item shows an overall ✅/❌, then `Agent: ✓/✗` and `AI: ✓/✗` beside it | Three readings, never merged into one tick | | |
| 8.3 | An item flagged important | Marked as such | | |
| 8.4 | An item with a description | Shown under the item name | | |
| 8.5 | ★ A **transferred** interaction where two agents ran the **same** checklist template | **Both** checklists appear, each titled with its own agent. Neither is de-duplicated away | | |
| 8.6 | Checklist metadata | Status and the start / finalised timestamps | | |
| 8.7 | An interaction with a summary | Headline, Reason, Resolution, Follow-up as present | | |
| 8.8 | ★ A summary an agent **edited** | Edited text shown, marked as edited, with the original struck through beneath | | |
| 8.9 | A conversation with several summaries | Labelled "Summary 1 of N", each attributed to its agent | | |
| 8.10 | A single-session conversation | **One** summary, not the same text twice — the conversation-level and session-level copies are de-duplicated | | |
| 8.11 | A summary with predicted wrap-up codes | Listed at the end, by name where known | | |
| 8.12 | Close the panel | Closes; the table is untouched | | |

## 9. Recordings ★

New to this app — there was no media player anywhere in it before.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 9.1 | Open a drill-down | **Nothing is fetched.** A "Load recordings" button waits | | |
| 9.2 | Press Load recordings | Stubs fetched; a button per recording | | |
| 9.3 | A transferred call with several recordings | "Part 1", "Part 2"… | | |
| 9.4 | A single recording | One button, "Play recording" | | |
| 9.5 | Press play | Audio player appears and plays | | |
| 9.6 | Press the same button again | Player hides. Again — reappears **without re-fetching** | | |
| 9.7 | ★ A **screen** recording | Renders as `<video>`, not audio. Detection is on `mediaSubtype`, so a recording whose free-text `media` field says something else must still be caught | | |
| 9.8 | ★ An **ARCHIVED** recording | "Archived — not directly playable". No dead player | | |
| 9.9 | ★ A long recording still transcoding | Retries five times, three seconds apart. If it never arrives, a plain message — never a broken player | | |
| 9.10 | An interaction with no recording | "No recording for this interaction." | | |
| 9.11 | A deleted recording | Not offered at all | | |
| 9.12 | ★★ A recording with a future **Delete Date** in Genesys (a retention policy sets one on nearly all of them) | **Offered and plays.** This shipped broken: filtering on `deleteDate` hid every recording in the org. Only `fileState` may be filtered on — design §5.2 | | |

## 10. Export ★

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 10.1 | Export appears only once something has a checklist | Yes | | |
| 10.2 | Press Export to Excel | Three sheets: Summary, Interactions, Checklist Items | | |
| 10.3 | ★ Apply a filter, then export | The file contains **exactly the filtered rows** — the download can never disagree with the screen | | |
| 10.4 | Summary sheet | One row per agent / queue / copilot / checklist, with totals and completion % | | |
| 10.5 | Checklist Items sheet | One row per item, with the agent tick and AI tick in separate columns | | |
| 10.6 | Headers | Styled, frozen, auto-filtered | | |
| 10.7 | Export with a filter matching nothing | Says so rather than writing an empty workbook | | |

## 11. Permissions

Remove one at a time. The page must lose that band and no more.

| # | Remove | Expect | Result | Notes |
|---|---|---|---|---|
| 11.1 | `assistants:assistant:view` | Page is denied — without it there is no scope to choose | | |
| 11.2 | `analytics:conversationDetail:view` | Page is denied — without it there are no interactions | | |
| 11.3 | ★ `assistants:queue:view` | Cascade unavailable and says so; **searching by copilot alone still works** | | |
| 11.4 | ★ `conversation:agentchecklist:view` | Checklists unavailable; rows, summaries and recordings still show. This is its **own** permission — holding `conversation:communication:view` is not enough | | |
| 11.5 | `conversation:communication:view` | No agent communications, so no checklists; the rest of the row survives | | |
| 11.6 | `conversation:summary:view` | Summary section says so; checklists unaffected | | |
| 11.7 | `recording:recording:view` | Recording section says so; the rest is unaffected | | |
| 11.8 | `routing:wrapupCode:view` | Wrap-up column falls back to ids rather than blanking | | |
| 11.9 | ★ Any of the above | A missing value is never reported as a zero | | |

## 12. Cost, cancellation and teardown ★

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 12.1 | ★ Load, then start a **second load** before the first finishes | No stale rows. Checklists from the old run must not appear against the new one, including for conversations both runs share | | |
| 12.2 | ★ Load, then navigate away mid-enrichment | Requests **stop**. Watch the network tab — nothing keeps firing after the page has gone | | |
| 12.3 | Load, then switch customer org | Run aborts; the page resets to needing a count | | |
| 12.4 | A range with more than 400 interactions | Checklists fetched for the first 400; the status line says the rest were not fetched. Remaining rows read "…", **never** "No checklist" | | |
| 12.5 | More than 4,000 interactions | Reads the first 4,000 and says the set is partial | | |
| 12.6 | Watch request pacing during enrichment | A few at a time, not a flood — no 429s | | |

## 13. Cross-checks against Genesys ★

The numbers have to survive being checked by hand.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 13.1 | Take one interaction; open it in Genesys | Agent, queue, wrap-up and duration match the row | | |
| 13.2 | ★ Compare its checklist item by item | Same items, same agent ticks, same AI ticks | | |
| 13.3 | ★ Compare its summary | Same text; if edited in Genesys, this page shows the edit **and** the original | | |
| 13.4 | Count interactions for a period, then run the same query in Genesys | Same total | | |
