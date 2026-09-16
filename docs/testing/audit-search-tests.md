# Test plan — Audit › Search

**Page:** Audit › Search (`/audit/search`)
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
- **★ marks an open question**, not a regression check. These are behaviours
  the Genesys spec leaves open and nobody has confirmed against a live tenant.
  Fill in the _Answer_ line even when nothing looks broken.
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
- [ ] **2.2** — Set From to **3 days ago**, To to today, no service
  - Expect: hint stays on the "Last 14 days" text; status counts "N of M queries done"
  - Notes: `______________________`
- [ ] **2.3** — Set From to **20 days ago** and To to **18 days ago** (a 2-day range, older than 14 days), no service
  - Expect: hint turns amber — "Older than 14 days — standard query"; the run reports "Fetching interval 1 of 1 (all services)". It must **not** report "Done — 0 results" instantly
  - Notes: `______________________`
- [ ] **2.4** — Same range as 2.3, no service
  - Expect: results across services (confirmed 2026-09-16 — the standard query accepts no `serviceName`; "Last month" returned 3105 rows). If Genesys ever starts refusing, the page shows "Genesys requires a service for this query — select one and search again"
  - Notes: `______________________`
- [ ] **2.5** — Same range as 2.3 with a service selected
  - Expect: standard query runs; results appear
  - Notes: `______________________`
- [ ] **2.6** — From within 14 days, service picked that is **not** in the realtime set (compare the Service list against `GET /audits/query/realtime/servicemapping`)
  - Expect: hint says "… is not in the realtime set — the standard query will be used"; the run polls
  - Notes: `______________________`
- [ ] **2.7** — Press **Last 3 months** with no service
  - Expect: the search runs on its own (three 30-day intervals) and returns results across all services
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
  - Expect: no more than ~6 audit requests in flight at once; no 429 responses (if a 429 does appear it is retried, not listed as a failure, unless it fails four times)
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
  - Expect: Entity Name stays the token string — there is nothing to resolve it to; Changed By is the user or client that obtained the token
  - Notes: `______________________`
- [ ] **5.3** — Find an audit on an object that has since been **deleted**
  - Expect: Entity Name is the name at the time of the change when Genesys sent one; otherwise "(deleted) <guid>"
  - Notes: `______________________`
- [ ] **5.4** — Find an audit on an object that still exists and whose Raw API response has **no** `entity.name`
  - Expect: Entity Name is resolved by lookup (the current name)
  - Notes: `______________________`
- [ ] **5.5** ★ — A change made by a **trustee user** from another org, if the test org has a trust relationship
  - Expect: Changed By shows a name; if `expand=user` does not name trustee users it falls back to the GUID
  - Answer: `______________________`

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
- [ ] **6.5** — Press **Show related audits** on a result older than 14 days
  - Expect: a "Could not load related audits: …" line; the button re-enables; the detail row stays open
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

## 8. Entity ID — history of one object

- [ ] **8.1** — Paste a queue's GUID into **Entity ID**, range **Last 7 days**, no service
  - Expect: only audits for that queue; the status line still reports the number of queries run
  - Notes: `______________________`
- [ ] **8.2** — Same GUID, From 40 days ago, service ContactCenter
  - Expect: standard query returns only that queue's audits
  - Notes: `______________________`
- [ ] **8.3** — Press **Enter** in the Entity ID field
  - Expect: the search runs
  - Notes: `______________________`
- [ ] **8.4** — Clear Entity ID and search again
  - Expect: full results return
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

## 10. Client-side filters, paging, export

- [ ] **10.1** — Pick an Entity Type, then an Action
  - Expect: Action lists only actions for that type; count line reads "N results (M shown after filters)"
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
