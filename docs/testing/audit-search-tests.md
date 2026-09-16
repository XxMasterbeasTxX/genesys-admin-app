# Test plan — Audit › Search

**Page:** Audit › Search (`/audit/search`)
**Released in:** 5.8
**Environment:** ☐ dev ☐ prod
**Tester:** `______________________`  **Date:** `______________________`
**Build / commit:** `______________________`

---

## How to use this plan

Tick the boxes as you go — `- [ ]` becomes `- [x]`. This file lives in the
repo, so progress is saved with everything else; committing it makes the
completed run part of the history.

- **Fail a case?** Leave the box unticked and write what happened on the
  _Notes_ line under it. An unticked box with no note reads as "not run yet",
  which is a different thing.
- **★ marks an open question**, not a regression check. Both questions this
  plan opened with were answered on live tenants on 2026-09-16 (§2.4, §5.5)
  and are now ordinary checks.
- This page only reads. Nothing here writes to Genesys.

Several cases need a **busy day** — a day on which one service wrote more than
25 audits. Running a bulk operation from this app (a template run, a bulk
skill change) on a test org the day before is the easiest way to arrange one.

---

## 1. Access

- [ ] **1.1** — Log in holding `audits:audit:view`
  - Expect: Audit › Search appears and loads the service list
  - Notes: `______________________`
- [ ] **1.2** — Log in without `audits:audit:view`
  - Expect: leaf greyed out with a tooltip naming the permission
  - Notes: `______________________`

---

## 2. Routing — realtime vs standard query

The realtime endpoint holds only the **last 14 days**. The page decides by
how old the *start* of the range is, not by how long the range is.

- [ ] **2.1** — Open the page
  - Expect: **Today** is highlighted and a search runs on its own across all services; the hint under Service reads "Last 14 days — all supported services shown"
  - Notes: `______________________`
- [ ] **2.1a** — Press **Yesterday**
  - Expect: From and To both become yesterday's date, 00:00–23:59, and the preset highlights — but **no search runs** until Search is pressed; only the page's first load searches on its own. The buttons read Today · Yesterday · Last 7 days · Last 30 days · Last 3 months
  - Notes: `______________________`
- [ ] **2.2** — Set From to **3 days ago**, To to today, no service
  - Expect: hint stays on the "Last 14 days" text; status counts "N of M queries done"
  - Notes: `______________________`
- [ ] **2.3** — Set From to **20 days ago** and To to **18 days ago** (a 2-day range, older than 14 days), no service
  - Expect: hint turns amber — "Older than 14 days — standard query"; the run reports "Fetching interval 1 of 1 (all services)". It must **not** report "Done — 0 results" instantly
  - Notes: `______________________`
- [ ] **2.4** — Same range as 2.3, no service
  - Expect: results across services (confirmed 2026-09-16 — the standard query accepts no `serviceName`; "Last 30 days" returned 3105 rows). If Genesys ever starts refusing, the page shows "Genesys requires a service for this query — select one and search again"
  - Notes: `______________________`
- [ ] **2.5** — Same range as 2.3 with a service selected
  - Expect: standard query runs; results appear
  - Notes: `______________________`
- [ ] **2.6** — From within 14 days, service picked that is **not** in the realtime set (compare the Service list against `GET /audits/query/realtime/servicemapping`)
  - Expect: hint says "… is not in the realtime set — the standard query will be used"; the run polls
  - Notes: `______________________`
- [ ] **2.7** — Press **Last 3 months** with no service, then **Search**
  - Expect: three 30-day intervals, results across all services
  - Notes: `______________________`

---

## 3. Completeness — pagination

Both endpoints previously returned only their first page. These cases prove
every page is read.

- [ ] **3.1** — Pick a busy day (see intro) and the service that was busy, range = that day only
  - Expect: result count **exceeds 25** and matches what the Genesys Audit Log Viewer shows for the same day and service
  - Notes: `______________________`
- [ ] **3.2** — Same day, no service (all services)
  - Expect: at least as many results as 3.1
  - Notes: `______________________`
- [ ] **3.3** — Standard query over a busy month (From 40 days ago, To 10 days ago, busy service)
  - Expect: the count is **not exactly 500** or a multiple of 500, and matches the Audit Log Viewer
  - Notes: `______________________`
- [ ] **3.4** — Open Raw API response on any realtime result
  - Expect: `user.name` is present (the `expand=user` parameter is honoured)
  - Notes: `______________________`

---

## 4. Failures are visible

- [ ] **4.1** — Run **Last 7 days**, all services, in an org where the token lacks a permission some service needs (or watch the network tab for any 4xx during the run)
  - Expect: if any query failed, the status line is **amber**: "Done — N results found, but results are incomplete: X of M queries failed (…)", and a collapsed "X queries returned nothing — show which" line lists each service+day and its reason
  - Notes: `______________________`
- [ ] **4.2** — Run with no failures
  - Expect: green "Done — N results found." and **no** failures line
  - Notes: `______________________`
- [ ] **4.3** — Watch the network tab during **Last 7 days**, all services
  - Expect: no more than 3 audit requests in flight at once. A 429 is retried in place; if it still fails, the status says "Rate limited on N queries — pausing, then retrying them one at a time…" and only what fails that second pass is listed. (An 8-day, 46-service run at 6 in flight lost 27 of 368 queries on 2026-09-16.)
  - Notes: `______________________`
- [ ] **4.4** — Run **Last 3 months** with no service (standard query, 3+ intervals) and watch for 429s
  - Expect: submission backs off 3 s doubling up to six attempts; intervals still rate-limited get a second pass after a pause ("Rate limited on N intervals — pausing, then retrying…"). (A 9-interval run on 2026-09-16 lost 4 to 429s with the old 1/2/4 s back-off.)
  - Notes: `______________________`

---

## 5. Names — who and what

- [ ] **5.1** — Change something yourself in the Genesys UI, then search Today
  - Expect: **Changed By** shows your name; the detail row shows **Client** as the Genesys web client id or name and **Application** if Genesys sent one
  - Notes: `______________________`
- [ ] **5.2** — Make a change through this app (any write page), then search Today
  - Expect: Changed By shows the app's OAuth client **name**, not a GUID. Genesys puts the client id in `user.id` for client-credentials actions, so the lookup tries the user first and the OAuth client second
  - Notes: `______________________`
- [ ] **5.2a** — Find a Presence › UserPresence row (agents changing status)
  - Expect: Entity Name is the **agent's name** (the entity id is the user); Changed By is the agent, or "Genesys (system)" for a SYSTEM-level audit
  - Notes: `______________________`
- [ ] **5.2b** — Find a PeoplePermissions › AccessToken row
  - Expect: Entity Name is the token's identifier (Genesys's fingerprint of the issued OAuth token — not the token, and not resolvable); Changed By is the user or client that obtained it, which is the useful part
  - Notes: `______________________`
- [ ] **5.3** — Find an audit on an object that has since been **deleted** (e.g. the Row audits of a datatable deleted the same afternoon)
  - Expect: Entity Name is "(deleted) <name>" when any audit in the result set carries the object's `name` in its property changes (the Delete or Create audit normally does); "(deleted) <guid>" only when none does
  - Notes: `______________________`
- [ ] **5.3b** — Find a Directory › User **Delete** row, or any audit on a user deleted since
  - Expect: "(deleted) <user's name>" — Genesys still returns deleted users with `state=deleted`
  - Notes: `______________________`
- [ ] **5.3c** — Find a Telephony › DID row for a user's own number and a ContactCenter › AgentRoutingInfo row
  - Expect: DID reads "+4540153795 (phone_cell)" rather than the org-id-prefixed internal name; AgentRoutingInfo reads "Agent <user's name>"
  - Notes: `______________________`
- [ ] **5.3d** — Find a Quality › Evaluation row and a Quality › Recording row (both carry `conversationId` in context)
  - Expect: "Evaluation: <form> · agent <name> · by <evaluator> · <status>" and "Recording (<media> <subtype>) of conversation <id>"; needs `quality:evaluation:view` / `recording:recording:view`, otherwise the id stays
  - Notes: `______________________`
- [ ] **5.3a** — Find a PeoplePermissions › Role **MemberAdd** or **MemberRemove** row
  - Expect: "Role name → Member name (division)" — Genesys puts the grant triple `subjectId--roleId--divisionId` in `entity.name`, `*` reads "all divisions"; a group member resolves to the group name
  - Notes: `______________________`
- [ ] **5.4** — Find an audit on an object that still exists and whose Raw API response has **no** `entity.name`
  - Expect: Entity Name is resolved by lookup (the current name)
  - Notes: `______________________`
- [ ] **5.5** — A change made by a **trustee user** from another org (log into the customer org through the trust and add a datatable row)
  - Expect: Changed By shows the trustee's name (confirmed 2026-09-16 on Nuuday: a row added by a trustee showed "Thomas Valhøj")
  - Notes: `______________________`

---

## 6. Detail row

- [ ] **6.1** — Expand a row that changed properties (e.g. a queue rename)
  - Expect: metadata table with Service, Entity Type, Entity ID, Action, **Status**, **Message** (Genesys's own sentence), Changed By, Client, Level, Date, Remote IP; then **Changed Properties** with old/new
  - Notes: `______________________`
- [ ] **6.2** — Expand an audit for adding or removing a **queue member**
  - Expect: a **Changed Entities** table (type, entity, old, new) — not only the raw JSON
  - Notes: `______________________`
- [ ] **6.3** — Expand an audit with neither property nor entity changes (e.g. a login, a read)
  - Expect: "Genesys recorded no property changes for this audit." in italics
  - Notes: `______________________`
- [ ] **6.4** — Press **Show related audits** on a realtime result
  - Expect: a table of the other audits written by the same action, oldest first, or "No other audits were written by this action."
  - Notes: `______________________`
- [ ] **6.5** — Expand a result older than 14 days
  - Expect: no button — "Related audits are only available for the last 14 days." in its place
  - Notes: `______________________`
- [ ] **6.6** — Click inside the detail row (select text, press the button)
  - Expect: the row does **not** collapse
  - Notes: `______________________`
- [ ] **6.7** — Collapse and re-expand a row
  - Expect: the related-audits table you loaded is still there (the detail is built once)
  - Notes: `______________________`
- [ ] **6.8** — Expand an audit whose old/new values are GUIDs (a queue's members, a user's division or skills, a flow's division)
  - Expect: the GUIDs turn into names a moment after the row opens (hover shows the raw GUID); a deleted object reads "(deleted) <guid>"
  - Notes: `______________________`
- [ ] **6.8a** — Expand a ContactCenter › Queue **MemberUpdate** row
  - Expect: the property "QueueMember/<queueId>:<userId>:joined" reads "QueueMember/<queue name>:<user name>:joined" — GUIDs inside a property name resolve too, not only whole values
  - Notes: `______________________`
- [ ] **6.8b** — In an object search for a queue, find an Assistants › AssistantQueue row
  - Expect: Entity Name is the queue's name — taken from the Queue rows in the same results, which name it, without a lookup
  - Notes: `______________________`
- [ ] **6.9** — Expand an audit whose property name gives no hint of what its GUID values are
  - Expect: the GUIDs stay as they are — no lookup is guessed
  - Notes: `______________________`

---

## 7. Status badge and filter

- [ ] **7.1** — Cause a failed action that Genesys audits (e.g. try to create a queue with a duplicate name via the API) and search Today
  - Expect: the row shows a red **FAILURE** badge next to the action; the **Status** dropdown lists FAILURE and filters to it
  - Notes: `______________________`
- [ ] **7.2** — A SUCCESS row
  - Expect: **no** badge
  - Notes: `______________________`

---

## 8. Searching for one object

Design: [audit-object-search-design.md](../audit-object-search-design.md).
The search is always "deep": the normal pull for the range, kept only where
the id appears anywhere in the audit except the actor fields.

- [ ] **8.1** — Choose **Object › Queue**
  - Expect: a **Which one** list appears, says "Loading Queue list…" then "N to choose from", searchable by name
  - Notes: `______________________`
- [ ] **8.2** — Pick a queue that had members added or removed in the range; press **Search** (Last 7 days, no service)
  - Expect: status reads "Done — N audits mention “<queue>”"; the rows include the queue's own Update/MemberUpdate audits **and** anything else that carries its id
  - Notes: `______________________`
- [ ] **8.3** — Choose **Object › User** and pick a user who was added to a role in the range
  - Expect: the results include the user's own Directory/Presence/AuthUser audits **and** the Role MemberAdd row where they are the member — the id sits in the role audit's entity name, not its entity id
  - Notes: `______________________`
- [ ] **8.4** — Same user, From 40 days ago, no service
  - Expect: standard query, all services, then the same kind of match; no "entityType" error from Genesys
  - Notes: `______________________`
- [ ] **8.5** — Change the Object kind back to "— Any object —" and search
  - Expect: the Which one list hides; full results return
  - Notes: `______________________`
- [ ] **8.6** — Press **…or paste an id**, paste the GUID of a datatable deleted in the range, search
  - Expect: the field unfolds; results are that table's Row/Schema audits; the hint next to the field fills in "= (deleted) <name>" once the results name it
  - Notes: `______________________`
- [ ] **8.7** — With a pasted id, then pick an object from a list
  - Expect: the pasted id clears — the picked object wins
  - Notes: `______________________`
- [ ] **8.8** — Expand any row and press **History of this object**
  - Expect: page scrolls to the top, the id field shows the row's entity id with "= <name>", and the search runs for it
  - Notes: `______________________`
- [ ] **8.9** — Choose a kind whose list the token cannot read (e.g. OAuth client without `oauth:client:view`)
  - Expect: "Could not load OAuth client list: Permission denied" in amber; the rest of the page still works
  - Notes: `______________________`

---

## 9. Time handling

- [ ] **9.1** — Make a change at a known local time (note the clock), then search Today with From/To times bracketing it by a few minutes
  - Expect: the row appears and the table time matches the clock — the inputs and the table are both **local** time
  - Notes: `______________________`
- [ ] **9.2** — Search Today 00:00–00:30 local, having made a change at 00:15 local
  - Expect: the row appears (previously the inputs were read as UTC)
  - Notes: `______________________`
- [ ] **9.3** — From later than To on the same day
  - Expect: red "Date/time From must be before Date/time To."
  - Notes: `______________________`

---

## 10. Post-filters, paging, export

- [ ] **10.0** — Look at the block between the status line and the table
  - Expect: it is headed **Filter these results**; Entity Type, Action, Changed By and Status list only values present in the results (not the whole service mapping)
  - Notes: `______________________`
- [ ] **10.1** — Pick an Entity Type, then an Action
  - Expect: Action lists only the actions seen for that type; count line reads "N results (M shown after filters)"
  - Notes: `______________________`
- [ ] **10.2** — Pick a Changed By
  - Expect: only that actor's rows; the dropdown lists names, not GUIDs, wherever a name was found
  - Notes: `______________________`
- [ ] **10.3** — Change rows per page to 200 and page through
  - Expect: "Page x of y" updates; Prev/Next disable at the ends
  - Notes: `______________________`
- [ ] **10.4** — Export to Excel with filters applied
  - Expect: the status line first says "Resolving names for N rows…"; one row per property change **and** per entity change; GUIDs in old/new values are names where the property name hints the type; columns include Entity ID, Status, Client, Application, Message; only the filtered rows are exported
  - Notes: `______________________`

---

## Sign-off

**Sections completed:** ☐ 1 ☐ 2 ☐ 3 ☐ 4 ☐ 5 ☐ 6 ☐ 7 ☐ 8 ☐ 9 ☐ 10

**Blocking failures** — must fix before this goes to customers:

```
______________________________________________________________
______________________________________________________________
______________________________________________________________
```

**Non-blocking issues** — worth a follow-up:

```
______________________________________________________________
______________________________________________________________
______________________________________________________________
```

**★ answers to carry back into the design:**

```
______________________________________________________________
______________________________________________________________
```
