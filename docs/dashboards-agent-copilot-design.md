# Dashboards › Agent Copilot — design

Status: **design, awaiting go-ahead**. Nothing built yet.

This feature is a port. It already exists as a whole standalone app,
`genesys-copilot-app`, and lands here as one page under a new
**Dashboards › Agent Copilot** menu.

---

## 1. What this is

Agent Copilot runs a **checklist** alongside an agent during an interaction, and
can write an **AI summary** afterwards. Items on that checklist get ticked two
ways: by the agent, and by the model. This page shows the interactions that used
a copilot, whether their checklists were completed, and what the AI wrote.

The question it answers is *did the copilot's checklist actually get finished,
and by whom* — the agent working through it, or the model marking it off.

---

## 2. What is being ported, and what is not

The source app has two nav entries. Only one is real:

| Source | Size | State |
| --- | --- | --- |
| Checklists & Summaries | 1,711 lines + 177 config + 7 BFF endpoints | Live — this is the port |
| Performance | 21 lines | `enabled: false`, a placeholder heading. No logic exists |

So there is exactly one feature here. "Performance" is an empty stub; a real
second page is possible and is designed separately — see §10.

### 2.1 The architecture does not come with it

The source app puts its orchestration in an Azure Functions **BFF** with
purpose-built endpoints (`/api/copilots`, `/api/conversations/enrich`, …) and a
per-org throttle. This app has a generic `/api/genesys-proxy` and a **45-second
cap per call**, so the equivalent here is browser-side fan-out — exactly what the
Quality pages do.

**No new Azure Functions.** Everything moves into the page and
`js/services/genesysApi.js`.

---

## 3. The chain — what has to be true for a checklist to exist

Read top to bottom. Each step is a place the data can be absent for a reason
that is not a fault:

1. An **assistant** exists with copilot enabled (`Assistant.copilot`).
2. The assistant is **assigned to the queue** the interaction went through.
3. The interaction ran through that queue, with an agent.
4. Copilot **started a checklist** on the agent's communication.
5. The checklist has **items** — one with none is undetermined, not failed.
6. Items get ticked, by agent (`stateFromAgent`) or model (`stateFromModel`).
7. Separately, a **summary** may be generated at the end.

Nothing in this chain is inferred. Every step is read.

---

## 4. Data sources

All verified against the cached OpenAPI spec — response schemas and permissions
read from each endpoint's own definition, not from the source app's docs.

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| GET | `/api/v2/assistants?expand=copilot` | Copilot-enabled assistants. Cursor-paged (`nextUri`) → `fetchAllCursor`. | `assistants:assistant:view` |
| GET | `/api/v2/assistants/{id}/queues` | Queues assigned to an assistant. Cursor-paged. | `assistants:queue:view` |
| POST | `/api/v2/analytics/conversations/details/query` | The interactions. `agentAssistantId` is a **segment** dimension. | `analytics:conversationDetail:view` |
| GET | `/api/v2/conversations/{id}` | Participants → the agent communication ids. | `conversation:communication:view` |
| GET | `/api/v2/conversations/{id}/communications/{commId}/agentchecklists` | The checklists. | `conversation:agentchecklist:view` |
| GET | `/api/v2/conversations/{id}/summaries` | AI summaries. | `conversation:summary:view` |
| GET | `/api/v2/conversations/{id}/recordings` | Recording stubs (metadata only). | `recording:recording:view` (ANY of 4) |
| GET | `/api/v2/conversations/{id}/recordings/{recId}` | One recording + presigned playback URL. | same |

Queue names, agent names and wrap-up codes come from helpers this app already
has (`fetchAllQueues`, `fetchAllUsers`, `fetchAllWrapupCodes`).

### 4.1 The row already knows which copilot

`AnalyticsSession.agentAssistantId` is on the analytics row.

This matters more than it sounds. The source app **requires** a queue selection
and derives the Copilot column from a cached queue→copilot map, which is wrong
whenever one queue is served by more than one assistant or the assignment has
changed since the interaction. Reading `agentAssistantId` off the session:

- **Queue and agent become optional** narrowing filters, not requirements.
- The Copilot column is read from the interaction, not reconstructed.

### 4.2 Shapes worth writing down

`AgentChecklistResponse` carries `checklistItems[]`, plus `agentId`,
`participantId`, `queueId`, `assistantId`, `mediaType`, `evaluationStartDate`
and `evaluationFinalizedDate` — enough to attribute a checklist and show its
metadata without a second call.

`ChecklistItem` carries `name`, `description`, `important`, and the two tick
states, each `Ticked` or `Unticked`.

`ConversationSummariesGetResponse` is `{conversation, summary, sessionSummaries[]}`.
For a single-session conversation `summary` and the one session summary are the
same record, so they are de-duplicated by `id` and only fall back to a
count-based rule when ids are absent.

`Recording.mediaUris` is a **map** of format to `{mediaUri, waveformData}`, not a
flat field.

---

## 5. Corrections to the source

Four things the source gets wrong or leaves out, fixed in the port:

1. **The checklist permission is its own.** The source's user manual tells users
   that a missing checklist means a missing `conversation:communication:view`.
   The spec says `agentchecklists` requires **`conversation:agentchecklist:view`**
   (type ALL). Someone can hold the conversation permission and still get
   nothing. Gated and reported separately here.

2. **`deletedDate` does not exist — and that typo is load-bearing.** The source
   filters recording stubs with `!r.deletedDate`. No such field exists; the
   schema calls it `deleteDate`. So the test never excludes anything and the
   source is effectively filtering on `fileState` alone.

   I "corrected" the spelling, and it hid every recording in the org.
   `deleteDate` is the **scheduled** deletion date, which a retention policy
   sets on essentially every recording — so the corrected filter rejected
   recordings that plainly exist and were downloadable in Genesys. **Filter on
   `fileState` alone.** This is the entry that most needs to survive: it looks
   exactly like a bug worth fixing, and fixing it breaks the page.

3. **Screen recordings have their own field.** The source detects a screen
   recording with `media`/`mediaType` lowercased, but the spec's enum lives on
   **`mediaSubtype`** (`Trunk|Station|Consult|Screen|Snippet`). The port tests
   `mediaSubtype === "Screen"` and keeps the old test as a fallback.

4. **`AgentChecklistResponseList` has a `nextUri` the source never pages.** A
   conversation with more checklists than one page silently loses the rest. The
   port pages it.

---

## 6. The page

Route `/dashboards/agent-copilot/checklists`, file
`js/pages/dashboards/agent-copilot/checklists.js`, access key
`dashboards.agentCopilot.checklists`, label **Checklists & Summaries** under a
new **Agent Copilot** folder in `Dashboards`.

### 6.1 Filters

A copilot multi-select, then queue and agent multi-selects that cascade from it,
then a date range. Selecting copilots loads their queues; selecting queues loads
their members.

**Only the copilot selection is required** (§4.1). Queue and agent narrow the
search. If `assistants:queue:view` is missing the cascade cannot run, and the
page says so and searches by copilot alone rather than refusing.

Date range uses this app's `RANGE_PRESETS`, restricted to the short ones —
Today, Yesterday, This week, Last week — exactly as Evaluation Gaps does, and
for the same reason: this walks conversation rows, so offering "Last 12 Months"
offers a walk nobody should start by accident. Custom dates are allowed and
guarded at 31 days.

#### The 31-day cap is real, and it is conditional — measured 2026-09-03

The source inherits this number without a source, and the spec documents no
maximum on `interval`. It was measured against a live org instead, varying only
the interval at `pageSize: 1`:

| Query | Maximum interval |
| --- | --- |
| No filters | **7 days** |
| Any `segmentFilters` present | **31 days** |

Genesys changes the number in its own error message depending on the query. The
first probe sent no filters, reported a 7-day rule, and was misleading: this page
always filters by copilot, so **31 days is the number that binds**, and the
source's guard is correct for its usage after all.

Recorded in `docs/api-reference.md` §2.1, because it applies to every page here
that queries conversation detail, not only this one.

The cap is not what limits this page, though. On the org measured, a single
unfiltered week was 58,774 interactions and 31 days of voice alone was 124,077.
At 3–4 enrichment calls each (§7), the interval runs out of usefulness long
before it runs out of days — which is why the presets stay short and the cost
gate in §6.2, not the guard, does the real limiting. The guard exists so a custom
range fails fast with a clear message instead of a raw 400.

### 6.2 Nothing loads on arrival, and the cost is stated first

Same gate as Evaluation Gaps §14.3, for the same reason — this is the expensive
page in the section.

On open, only the copilot list loads. After filters and a range are chosen, a
**Count** step calls the analytics query with `pageSize: 1` and reports
`totalHits` — one small request. The page then says how many interactions are in
scope and roughly how many requests enriching them will take, and waits for an
explicit **Load** before spending anything.

### 6.3 The table

One row per interaction:

| Column | Source |
| --- | --- |
| Time | `conversationStart` |
| Agent | all agent participants, comma-separated (transfers show every agent) |
| Queue | queue on the agent segment |
| Copilot | `session.agentAssistantId` → assistant name (§4.1) |
| Media | media type |
| Duration | summed `tHandle` across agents |
| Checklist | checklist name(s), once enriched |
| Wrap-up | wrap-up code names |
| Status | Complete · Incomplete · No items · No checklist · Error |

Sorting and filtering come from `attachColumnFilters` with `sortable`,
`compact`, `rangeCols` on Duration and `dateCols` on Time — which replaces the
source's bespoke filter row wholesale.

The source's four status buttons (All / Completed / Incomplete / Summaries) plus
the independent "Agent Checked" toggle stay as buttons, because they filter on
enrichment results rather than on cell text and the column filters cannot
express them.

Right-click a row copies the Conversation ID, as on Evaluation Gaps.

### 6.4 Completion band

The source draws a Chart.js bar chart of Complete vs Incomplete. This app has no
chart library and does not need one: the same two bars, drawn vertically in CSS
under the title "Checklist Completion", carry the same information. **No new
dependency** — this app vendors its libraries, and a chart of two bars does not
earn one.

Undetermined records (`completion === null` — a checklist carrying no items)
belong to neither bar and are counted separately. An empty checklist is not a
failed one, and the source is careful about this; the port keeps that care.

### 6.5 Drill-down

Click a row, three collapsible sections open beside the table.

**Recordings.** This is the only part with no precedent in this app — there is no
audio or video player anywhere in it today (`interactions/recordings/` is bulk
*export jobs*). Nothing is fetched until asked:

1. **Load Recordings** fetches the stubs, retrying twice at 3s if Genesys has
   not indexed them yet.
2. One button per recording — "Play Recording", or "Part 1…n" across transfers.
3. First click requests the recording with `formatId` MP3, or WEBM for a screen
   recording, and retries while transcoding finishes — **five attempts, three
   seconds apart**, as the source does. An earlier revision paced this on the
   server's own `estimatedTranscodeTimeMs`, which is arguably better and was
   nobody's request; the port follows the source.
4. The presigned `mediaUri` goes to an `<audio>` (or `<video>` for screen)
   element. Playback streams from Genesys straight to the browser; the proxy
   carries only the JSON. This app sets no CSP, so nothing blocks the media
   origin.
5. `ARCHIVED` says "Archived — not directly playable" instead of a dead player.

**Checklists.** Every checklist item with its two tick states shown separately —
agent and AI — plus the important flag and the item description. On a transferred
conversation, every agent's checklist appears, each titled with its owning agent,
because a conversation can carry several checklists including the *same template*
run by different agents. De-duplication is on `id + agentId + participantId`, so
each agent's copy survives.

**Summaries.** Headline, Reason, Resolution, Followup. Where an agent edited a
field, the edited text shows with the original struck through beneath it.
Multiple summaries (one per leg) are labelled and attributed. Predicted wrap-up
codes appear at the end.

### 6.6 Export

Three sheets — Summary (a pivot by agent/queue/copilot/checklist), Interactions,
Checklist Items — built with this app's bundled `xlsx.bundle.js` and
`excelStyles.js` (`buildStyledWorkbook` / `addStyledSheet`), replacing the
source's CDN SheetJS and its own header styling.

The export takes **the rows the filters currently show**, so the download can
never disagree with the screen. The source is disciplined about this — one
`passesFilters()` decides both — and the port keeps a single predicate.

---

## 7. Cost

The expensive part is enrichment, and it does not aggregate: there is **no
checklist metric anywhere in the Genesys API** (§10). Completion is only knowable
per conversation.

Per conversation:

| Call | Count |
| --- | --- |
| `GET /conversations/{id}` | 1 |
| `GET /conversations/{id}/summaries` | 1 |
| `GET …/communications/{commId}/agentchecklists` | 1 per agent communication |

Roughly **3–4 proxy calls per conversation**. 500 interactions is ~1,500–2,000
calls, which at Genesys's rate limit is **5–7 minutes**.

Handling:

- The count and the estimate are shown **before** anything is spent (§6.2).
- The table renders from the analytics rows immediately; enrichment fills the
  Checklist and Status columns progressively, so the page is usable throughout.
- Bounded concurrency, following `RECORDING_CONCURRENCY` on Evaluation Gaps.
- A hard cap on conversations enriched per run; past it the page says the rest
  were not enriched rather than inventing a verdict.
- A new search aborts in-flight enrichment through an `AbortSignal`, and a batch
  already in flight checks `signal.aborted` **before writing** — otherwise it
  lands in the next search's state and shows stale checklists for any
  conversation the two have in common. The source gets this right and the note
  is worth carrying over.

---

## 8. Permissions

Gate: `assistants:assistant:view` **and** `analytics:conversationDetail:view`
(type `all`). Without the first there is no scope to choose; without the second
there are no interactions. Neither substitutes for the other.

Everything else degrades band by band and names what it wants:

| Missing | Effect |
| --- | --- |
| `assistants:queue:view` | No queue/agent cascade; search by copilot alone |
| `conversation:communication:view` | No agent communications, so no checklists; status reads "not checked" |
| `conversation:agentchecklist:view` | Checklists unavailable; the rest of the row still shows |
| `conversation:summary:view` | Summaries section says so; checklists unaffected |
| `recording:recording:view` | Recording section says so |
| `routing:wrapupCode:view` | Wrap-up column falls back to ids |

A blank is never reported as a zero.

---

## 9. What is reused rather than rewritten

| Need | Comes from |
| --- | --- |
| Genesys calls | `api.proxyGenesys`, `fetchAllCursor`, `getConversation` (already exists) |
| Multi-selects | `js/components/multiSelect.js` (this app's, not the source's) |
| Date range | `js/utils/dateRanges.js` |
| Sortable/filterable table | `js/utils/columnFilter.js` |
| Excel | `js/lib/xlsx.bundle.js` + `js/utils/excelStyles.js` |
| Bars | CSS, in the shape the source drew with Chart.js |
| Queues / users / wrap-ups | existing `fetchAll*` helpers |
| Status line | `makeStatus` (which owns its own throbber — pass plain text) |
| Multi-org | org context, free |

New in `genesysApi.js`: `fetchCopilotAssistants`, `fetchAssistantQueues`,
`fetchAgentChecklists`, `fetchConversationSummaries`, `fetchConversationRecordings`,
`fetchConversationRecording`.

New page-level logic: the enrichment walk (ported from the BFF's
`checklistEnrich.js`), and the media player.

---

## 10. Deferred — the adoption page

There is **no aggregate path for checklist completion**. Checked across every
analytics aggregate endpoint in the spec: `analytics/agentcopilots/aggregates/query`
exists but its metrics are entirely about *suggestions*
(`nCannedResponseSuggestions`, `nKnowledgeAnswerSuggestions`, `nScriptSuggestions`,
`nDistinctConversations`), and no checklist dimension or metric appears anywhere.

That is why this ships as **one** page. Splitting it the way Quality splits —
cheap aggregate page, expensive per-interaction page — would produce two pages
paying the identical per-conversation cost to show the same numbers twice.

What the aggregates *do* support is a genuinely different second page, agreed as
follow-up work:

- `analytics/summaries/aggregates/query` (`analytics:summaryAggregate:view`)
  groups by queue, agent, media type, and by `editedField`, `copied`,
  `presented`, `summaryRating`, `wrapupCodesGenerated`. That answers whether
  agents actually *use* the AI summaries and trust them enough not to edit them
  — which the ported page cannot tell you at all.
- `analytics/agentcopilots/aggregates/query` covers what copilot suggested and
  whether it was taken.

Both are aggregate-only: seconds, not minutes, and no enrichment. Designed
separately once this page is in production.

---

## 11. Test plan

A test document accompanies the page, as with each Quality page:
`docs/testing/dashboards-agent-copilot-checklists-tests.md`.

Cases that must be covered, because each is a place the source or the port can
be quietly wrong:

1. A conversation with **no checklist** → "No checklist", not "Incomplete".
2. A checklist with **no items** → "No items" (undetermined), counted in neither
   bar.
3. A **transferred** conversation where two agents ran the *same* template → both
   appear, each attributed to its own agent, neither de-duplicated away.
4. A conversation where an item is ticked **only by the model** → Complete.
5. **Agent Checked** toggle combined with Incomplete.
6. A **screen** recording → `<video>`, via `mediaSubtype`.
7. An **ARCHIVED** recording → message, no player.
8. A recording still **transcoding** → retries, then a plain message.
9. A new search **while enrichment is running** → no stale rows from the old set.
10. Export **matches the filtered view**, not the full set.
11. Each permission in §8 removed individually → the named band degrades, the
    page survives.
12. A copilot with **no queues** → searchable anyway (§4.1).
