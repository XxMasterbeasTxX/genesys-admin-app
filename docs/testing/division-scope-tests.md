# Division Scope — Test Pass

Design: [`docs/division-scope-design.md`](../division-scope-design.md).
Written with the change; the automated part ran green before the first
commit. No flag: enforced from the first deploy, for non-superuser internal
sessions on the internal org only.

## A. Automated — `api/lib/divisionScope.js`, 34 checks

Grants stubbed as `GET /authorization/subjects/me` returns them; reads
stubbed per path.

- **Grants:** an "all divisions" (`*`) grant lands in `everywhere`; a
  division grant under its id; `divisionsFor` gives `{Y}` for a permission
  held in Y, `ALL` for one held everywhere, empty for one not held; a
  wildcard role (`*:*:*`) everywhere covers everything; `anyDivisions`
  lists every division with a grant.
- **Reads:** a queue list loses the queue in X, keeps the one in Y and an
  undivisioned entry, and keeps `pageCount`/`total` untouched; a list under
  an everywhere permission loses nothing; `POST /users/search` results are
  filtered; a single object in X is refused naming X, in Y allowed; the
  divisions list shows only divisions with a grant (all, for an everywhere
  grant); a conversation touching Y is allowed; undivisioned objects (roles)
  pass untouched.
- **Writes:** PATCH a queue in X → refused naming X, in Y → ok with **one**
  read of the queue; queue members → the path is read up to the queue id;
  a create in X → refused, in Y → ok, with no division → Home, refused when
  Home is not held; a search POST is a read; a role write needs no read; an
  everywhere permission needs no read; a data-table row write reads the
  table; the bulk move refuses on the target division and on an object's
  current division and allows Y→Y; `DATATABLES` resolves to the datatable
  permission (the enum fix); publishing a script reads the script; a
  missing object is left to Genesys; an admin with a wildcard grant is
  never refused.

Plus every earlier harness re-run green (proxy permissions, data table
rules, roles, access).

## B. By hand — in dev, then prod

Needs: an internal colleague (not a superuser) whose role is granted in
**one** division (Y) only; objects of a few kinds in Y and in another
division (X); the same colleague with an "all divisions" grant for the
last case.

| # | Case | Steps | Expect | Result |
|---|---|---|---|---|
| 1 | Lists | Sign in as the colleague on the internal org; open Divisions › Queues, Data Tables › Edit's picker, Users › Configure Users search | Only objects in Y appear; the counts say so | |
| 2 | Divisions dropdowns | Divisions › Queues: Source and Target | Only Y (and any other division with a grant) | |
| 3 | Write in Y | Move a Y queue to Y, edit a Y data table | Works as before | |
| 4 | Write in X, direct | `PATCH /routing/queues/{an X queue}` from the colleague's session via the proxy | 403 `division_required`; the message names X and the permission | |
| 5 | Create | Create a queue with no division | Refused unless the colleague's grant covers Home | |
| 6 | Read one in X | `GET /routing/queues/{an X queue}` via the proxy | 403 naming X | |
| 7 | Bulk move | Move a Y queue into X | Refused on the target division, X named | |
| 8 | Superuser | Sign in as a superuser | Everything, every division, as before | |
| 9 | All divisions | Give the colleague their role in "all divisions" | Everything visible again; no reads added (the everywhere path) | |
| 10 | Customer org | The same colleague, a customer selected in the header | Unchanged: the OAuth client's view of the customer | |
| 11 | Paging | A Y-only colleague on a list with more than 100 objects across divisions | Every page is walked (`pageCount`), not stopped at the first short page | |
| 12 | Grants unreadable | Simulate `subjects/me` failing | 403 `divisions_unverified` — fail closed, not open | |
