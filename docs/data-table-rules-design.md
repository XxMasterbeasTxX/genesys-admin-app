# Data Table Rules — guided editing for Supervisors — Design

Status: **Built** — agreed and built 2026-09-17; per-Supervisor tables (§11) added 2026-09-18. Test pass: [`docs/testing/data-table-rules-tests.md`](testing/data-table-rules-tests.md)
Author: Genesys Admin App
Last updated: 2026-09-18

## 0. The requirement

In the user's words: "An administrator should be able to add restrictions
to data tables. Meaning, when a supervisor edits the values in a data table,
it should be guided in such a way that he cannot make any mistakes. Now he
can spell wrongly, add a space, can edit everything or nothing."

Per column, an Administrator sets a **lookup type** (Data Table, Queue,
Skill, Schedule Group, Schedule, Group) and two ticks, **Protected** and
**Mandatory**. A Supervisor edits rows on a new page, **Data Tables ›
Supervisor**, where a lookup column is a dropdown of the allowed values, a
Protected column cannot be changed, and a Mandatory column cannot be left
empty. The Administrator's own Edit page is unchanged and unbound by the
rules; the rules live in the app, per table, per org.

## 1. Confirmed decisions

- **Only the Supervisor page enforces the rules.** Data Tables › Edit stays
  free-form; it is where the rules are *set*.
- **Rules are app data, per org per table**, stored beside the Supervisor
  scope in `orgsettings`. Genesys has nowhere to keep them, and a table's
  schema in Genesys is untouched by them.
- **The Supervisor page is one page in the scope** (`data-tables.supervisor`,
  customer and internal), ticked for the Supervisors who should have it
  like any other.

## 2. The rules

Per column of a table:

```
lookup      "" | "dataTable" | "queue" | "skill" | "scheduleGroup" | "schedule" | "group"
tableId     the referenced table's id, when lookup is "dataTable"
protected   true → a Supervisor cannot change the value
mandatory   true → a Supervisor cannot save the row with it empty
hidden      true → a Supervisor does not see the column at all (added during the
            build, at the user's request); it rides along unchanged on a row
            save, and a new row takes the table's default for it
```

Per table, **visible to Supervisors** — no table is until an Administrator
ticks it; the Supervisor page lists only ticked tables and the server
refuses any write to an unticked one — and one switch for what a
Supervisor may do beyond editing values: **may add rows**, off by default — "edit the values" is the use case, and
adding a row means inventing a key. **Supervisors never delete rows**
(the user, after seeing the first build: "He should never be allowed to
delete"). A new row's key is typed; the key column carries no lookup — a
"lookup for new rows' keys" was built and removed the same day as
unnecessary.

Where the allowed values come from:

| Lookup | Values | Genesys call |
|---|---|---|
| Data Table | the **keys** of the referenced table — the values of its key column | `GET /flows/datatables/{id}/rows` with `showbrief=true` (the default): every row's key and nothing else, 100 per page |
| Queue | queue names | `GET /routing/queues` (all pages) |
| Skill | skill names | `GET /routing/skills` |
| Schedule Group | schedule group names | `GET /architect/schedulegroups` |
| Schedule | schedule names | `GET /architect/schedules` |
| Group | group names | `GET /groups` |

**Names, not ids.** A data table cell holds whatever the flow reads, and
flows read queue *names* from data tables (that is what "Queue" in a
Services table is). The stored value is the name; the dropdown shows the
name; the value written is exactly the name Genesys holds — no typing, so
no space and no misspelling.

### The Data Table keys question

The user flagged this one. `showbrief=true` is what makes it cheap: the
response carries one field per row, the key, so even a 7,000-row table is
70 small pages. The documentation export already fetches datatable pages
several at a time (`docs/…` — the 47 s → 13 s change in 3.6); the same
batched fetch here brings 7,000 keys in well under the 45-second budget,
and the Supervisor page needs them only when the column's dropdown is
built, once per table load, cached for the session. Ordinary tables (tens
to hundreds of rows) are one or two calls.

The values list is built at the moment the Supervisor loads the table, so
it is current — a queue renamed this morning is in the list this afternoon.

## 3. Who may set rules

The rules are an Administrator's decision about content, not about access,
so they follow the Edit page's own gate plus the role:

| | Sets rules (Data Tables › Edit, Schema mode) |
|---|---|
| Customer Administrator | own org |
| Customer Supervisor | never — they cannot have the Edit page |
| Internal superuser / Administrator | any org in the header selector, the internal org included |
| Internal Supervisor | any org — **if their pages include Data Tables › Edit** (the user's decision: "internal supervisors (with the right permissions)") |

Server-side that is: a customer session with `role === "administrator"`
(own org, the sent `customerId` ignored); an internal session whose
`features` is null (Administrator, superuser) or includes
`data-tables.edit`. Reading needs either data-table page.

## 4. The endpoints

**`/api/datatable-rules`**

```
GET  ?customerId=&tableId=      → { customerId, tableId, rules }
PUT  { customerId, tableId, rules }
```

`rules` is `{ columns: { "<column name>": { lookup, tableId?, protected,
mandatory } }, mayAddRows, mayDeleteRows }`. A column absent from `columns`
has no rule. Stored in `orgsettings` under `partitionKey = org slug`,
`rowKey = "dataTableRules|<tableId>"`, with `setBy`/`setByEmail`/`setAt`.
Every PUT is logged to the Activity Log as `dataTableRules.set` with the
before and after. Reading is open to any session that may reach the
Supervisor page or the Edit page for the org; writing per §3.

A rule names a column by name. If the Administrator renames or removes a
column in the schema, its rule is orphaned; the Edit page shows orphaned
rules under the columns list ("Rule for a column that no longer exists:
… — remove?") rather than silently dropping them, and the Supervisor page
ignores them.

## 5. The Administrator's controls — Data Tables › Edit, Schema mode

Each schema column row (the screenshot's grid: drag handle, name, type,
default, ×) gains, to the right of Default:

- **Lookup** — a dropdown: *(none)*, Data Table, Queue, Skill, Schedule
  Group, Schedule, Group. Choosing *Data Table* reveals a second dropdown
  beside it listing the org's other tables (never the table itself).
- **Protected** — a tick.
- **Mandatory** — a tick.

Lookups are offered on **string** columns only: a boolean, integer or
decimal column cannot hold a queue name. Protected and Mandatory apply to
any type.

Above the grid, two ticks: **Supervisors may add rows**, **Supervisors may
delete rows**.

Rules are saved with **Save Schema** — one button, one save — and the
status line says both ("Schema saved. Rules saved: 3 columns."). If the
schema save fails the rules are not written; if the rules save fails the
status says so and the schema has still saved (the two are different
stores and cannot be one transaction; the order puts the rarer failure
last).

Rules are shown on the Edit page's Rows mode too, as read-only hints
(a small tag under the column header: "Queue", "Protected", "Mandatory") —
the Administrator sees what a Supervisor will meet, but is not bound.

## 6. The Supervisor's page — Data Tables › Supervisor

One control at the top: the table picker (the same `createSingleSelect`
the Edit page uses). Picking a table loads its schema, its rows (full,
`showbrief=false`, as the Edit page does), its rules, and the values for
every lookup column — all at once, with the status line counting. Then the
rows grid, which is the Edit page's Rows grid with the rules applied:

- A **lookup** column renders as a `<select>` of the allowed values, with
  an empty option only when the column is not Mandatory. The current
  value is pre-selected. A current value that is **not in the list** —
  a queue since deleted, a name typed with a space by someone before the
  rule existed — is shown as an extra option marked "(current value, not
  in the list)", so the row can be left alone; but the moment the
  Supervisor changes that cell they can only choose a listed value, and
  the marked option is gone.
- A **Protected** column renders as plain text, not an input.
- A **Mandatory** column is marked with the same `*` the key column has.
  A row with a Mandatory cell empty cannot be saved: the row's status
  reads "Mandatory: <column>" and the Save button counts it as invalid.
- The **key** column is Protected on existing rows regardless of any rule
  (renaming a key is delete-and-create in Genesys; the Edit page has a
  prompt for it, this page does not offer it).
- **Add row** appears only when the table's rule says so. There is no
  Delete. Search, paging and the per-row dirty/status handling are the
  Edit page's, unchanged.
- No Schema mode. No table metadata. Nothing else on the page.

*As built:* the Supervisor page has its own grid
([`js/pages/dataTables/supervisor.js`](../js/pages/dataTables/supervisor.js)),
written to the Edit page's patterns but not shared with it. Extracting the
Edit page's 1,400-line grid into a shared module the day before a
production merge was the wrong risk; the Edit page is untouched except for
the rule controls and the hints. Consolidating the two grids is a follow-up
([[port-faithfully-first]] applies: the Edit page's behaviour is the
reference).

## 7. Enforcement — browser and server

The browser does the guiding (§6). The server holds the line for a
Supervisor who calls the proxy directly, in the same place the proxy
already checks a Supervisor's pages: on `POST/PUT/DELETE
/api/v2/flows/datatables/{id}/rows[/{key}]` from a session whose licence
carries `features` (a Supervisor, customer or internal), it loads the
table's rules (cached per org+table for five minutes, like the scope) and
refuses with a named reason:

| Rule | Check | Cost |
|---|---|---|
| visible to Supervisors | any write to a table not ticked is refused | none |
| may add rows / never delete | POST against the table's switch; DELETE always refused | none |
| Protected | the current row is read (`GET …/rows/{key}?showbrief=false`) and each protected column compared | one read per write |
| Mandatory | the written value is non-empty | none |
| Lookup: Data Table | `GET /flows/datatables/{tableId}/rows/{value}` — 200 means the key exists | one read per lookup cell |
| Lookup: Queue | `GET /routing/queues?name=<value>` and an exact-name match in the result | one read per lookup cell |
| Lookup: Skill | `GET /routing/skills?name=<value>` (starts-with filter; exact match applied) | same |
| Lookup: Schedule Group / Schedule | `GET /architect/schedulegroups?name=` / `…/schedules?name=` | same |
| Lookup: Group | `GET /groups` has no name filter; `POST /groups/search` by name | same |
| Hidden | as Protected on an existing row; on a new row a value for it is refused (the page omits the column, so Genesys applies the default) | none |

Only cells that **changed** are checked (the current row is read anyway
for Protected), so a row edit with one lookup change costs two reads.
Refusals are 403 with `error: "datatable_rule"` and a `detail` naming the
column and the rule, which the page shows in the row's status. An
Administrator's session is never checked: the rules are theirs.

This is the difference from the page-scope layer, which is a menu
restriction held only by a coarse allowlist: here the server enforces the
rules exactly, because the cost is one or two reads per write and the
rule is precise.

The check runs on customer sessions (the user's own token — the reads use
it, so a Supervisor who cannot read queues cannot write queue names, which
is correct) and on internal Supervisors (client credentials).

## 8. Rollout

No flag. A table with no rules row behaves on the Supervisor page as
plain row editing with add and delete off — the safe default. Nothing
changes for Administrators until they set a rule. `data-tables.supervisor`
joins the pages list (`scripts/build-pages.mjs` regenerates `pages.json`;
94 internal, 77 customer) and must be ticked into a scope and onto a
Supervisor's row before anyone sees it.

## 9. Questions

Answered by the recommendation unless the user says otherwise.

1. **Add rows** — one table-level switch, **off** by default; deleting is
   never allowed (revised from two switches after the first build). (§2, §6)
2. **A current value outside the list** — leave-able, not editable to
   anything but a listed value. A Supervisor should not be forced to fix
   history to save an unrelated change in the same row. (§6)
3. **The key column** — Protected on existing rows always; typed on a new
   row, no lookup. (§6)
4. **Server-side enforcement** — yes, exact, per §7. Cost is one or two
   reads per row write. The alternative — browser only — would make the
   rules advisory for anyone with the proxy URL and their own token.
5. **Names, not ids** in the cells. (§2)
6. **Who sets rules** — customer Administrators for their org; internal
   superusers and Administrators for any org; never a Supervisor. (§3)

## 10. Out of scope

- Rules on the Edit page's own editing (decided: no).
- Lookups from other sources (users, divisions, wrap-up codes, flows) —
  the six named. Adding one later is a row in the table in §2 and one
  fetcher; the shape does not change.
- Per-Supervisor rules. One set per table. (Which tables a Supervisor may
  open *is* per Supervisor — §11.)
- Validating existing rows against new rules when they are saved
  ("3 rows currently violate this") — useful, later.

## 11. Which tables each Supervisor may open (added 2026-09-18)

In the user's words: "When providing pages to a supervisor (the individual
user) and when ticking the page Data Tables › Supervisor, the available
data tables should be there to be selected as well. In that way I can
provide supervisor x access to 2 data tables and supervisor y access to 5
data tables."

The same shape as pages. The org's Supervisor scope says which pages a
Supervisor *may* have and each row says which they *do* have; the two are
intersected at sign-in. For tables:

- **The org's table scope** is the "Visible to Supervisors" switch on Data
  Tables › Edit (§2). Nothing new.
- **Each Supervisor's row** carries `dataTables`: the ids of the tables
  they were given, a column beside `features` in the licence table. Set
  through the same `/api/licenses/role` and `/assign` calls, so it is
  stamped as a role change and shows in Modified by / on, and logged with
  the pages.
- **Effective tables** at sign-in = the row's list ∩ the tables visible
  to Supervisors *now* (`licenseGate.js`), only when their effective pages
  include Data Tables › Supervisor. An Administrator closing a table takes
  it from every Supervisor within five minutes, as unticking a page in the
  scope does. Without the page there is no list (`null`): nothing bounded.

**The control.** In the per-user page tree (add box and Edit), directly
under the *Data Tables › Supervisor* leaf, indented behind a rule: the
tables currently visible to Supervisors, one box each, sorted by name,
with Tick all / Untick all and a count. Shown only while that page is
ticked (`createPageTree`'s `extras`). On Edit, where the tree starts
collapsed, the Data Tables section is opened when the row already has the
page, so the tables are in view. The role cell reads "Supervisor · 5 pages
· 2 data tables" with the names on hover; the add-confirmation names them.
Customer Administrators get the same control on their own users; the
internal org too.

**Rules, as agreed.**

1. Page ticked ⇒ at least one table ticked. The server refuses a
   Supervisor with the page and no table (`tables_required`), as it
   refuses one with no pages. If no table is visible to Supervisors yet,
   the box says so and the page cannot be kept ticked.
2. The server keeps only ids of tables *currently* visible to
   Supervisors, read from the org's rules — never from the page — and the
   reply says how many were dropped (`droppedTables`), as unknown pages
   are dropped from a scope.
3. **Server-side, for a Supervisor with a list** (`checkTableAccess` in
   `dataTableRules.js`, run by the proxy's `guardDataTableWrite` on both
   paths): a call on one table — `…/flows/datatables/{id}` or its rows —
   is refused 403 `table_not_assigned` for a table outside the list, reads
   and writes alike, with one exception: a `GET` on a table that is a
   *Data Table lookup target* of one of their tables, since the dropdown
   values are read from there. Reading only. Administrators and superusers
   are untouched.
4. **The list bounds only what the Supervisor page uses.** The table
   listing itself (`GET /flows/datatables`) is not filtered on the server —
   other pages a Supervisor may hold (Divisions › Data Tables, an export)
   use it and give what they give; the Supervisor page narrows it
   client-side to the list. "Why can't everything else be as normal?" — it
   can, and is. A Supervisor without the Supervisor page is unchanged
   entirely.
5. No migration. A row with the page ticked and no list (dev only, from
   the first day's testing) counts as no tables until edited; the users
   list says "0 data tables" with "edit to choose" on hover.
6. Folded into release note 6.1.

**Test pass:** `docs/testing/data-table-rules-tests.md` §D.
