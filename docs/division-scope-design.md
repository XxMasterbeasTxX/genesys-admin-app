# Division Scope — internal users see only their divisions — Design

Status: **Built** — agreed in conversation 2026-09-17 and built the same day
Author: Genesys Admin App
Last updated: 2026-09-17

## 0. The requirement

In the user's words: "In Genesys, if a data table is in division X and the
user only has permissions to view division Y, the data table is not visible
to him. […] In all orgs, including internal, users may have all access to
certain divisions, but not all. This app makes it possible for them to
access objects they shouldn't. Not only data tables."

## 1. Where the gap is, and where it is not

A Genesys grant is a **role in a division**. Holding `routing:queue:edit`
in division Y means editing queues in Y, not in X.

- **Customer sessions: no gap.** Every call goes out on the user's own
  token; Genesys applies the whole grant, division included, on every list
  and every write.
- **Internal users on customer orgs: unchanged by decision.** Those calls
  run on the OAuth client created in the customer org — the trustee client
  — and the customer sees the client, not the person. The user: "That
  should remain unchanged."
- **Internal users in the internal org: the gap, closed here.** Those calls
  run on the internal org's own OAuth client too, so a colleague with
  grants in Y alone saw and could change everything the client could. The
  page greying checked the permission but not the division: "the app
  checks the permission, Genesys would have checked the permission in the
  division."

## 2. Confirmed decisions

- **Scope:** internal sessions, on the internal org only. Nothing changes
  for customer sessions or for internal users on customer orgs.
- **The rule:** a permission counts for an object only if the user holds
  it in that object's division. A grant in "all divisions" (`*`) counts
  everywhere. A user whose grants are all in "all divisions" notices
  nothing.
- **Lists** show only objects in divisions where the user holds the
  permission the call needs. The divisions dropdowns show only divisions
  where the user holds any grant.
- **Writes** are refused when the object's division is outside the user's
  grant for that permission, with the division named — the same shape as
  the permission check and the same sentence a customer gets from Genesys.
- **No report mode.** It ships enforced ("No report is needed"). The user
  handles the production side at merge time.
- **Superusers bypass**, as they bypass every check.
- **An object with no division** in the response is treated as Genesys
  treats it: the Home division.

## 3. Where the grants come from

`GET /authorization/subjects/me` on the user's own token, in the internal
org: `grants[]`, each `{ division: { id, name }, role: { policies: [{
domain, entityName, actions }] } }`. Every policy flattens to
`domain:entityName:action` permission strings (wildcards preserved, as the
permission reader already does), filed under the grant's division id — or
under "everywhere" when the division is `*`. Cached per token for five
minutes, like the permission set and the licence verdict.

`divisionsFor(required)` is then: everywhere, if any required permission is
held in `*`; otherwise the set of division ids where one is held.

## 4. What is enforced, and how — the proxy, internal org only

The check sits in `api/genesys-proxy` beside the permission check, for a
non-superuser internal session whose `customerId` is the internal slug.
The permission the call needs comes from the existing table
(`proxyPermissions.requiredFor`); a call the table marks as needing no
permission is not division-checked either.

**Reads.** After the call, the response is filtered: in `entities[]` /
`results[]`, every item carrying `division.id` (or a conversation's
`divisions[].division.id`) outside `divisionsFor(required)` is removed.
`pageCount` and `total` are left as Genesys returned them, so paging still
walks every page; totals may overstate. A single-object GET whose object is
outside is refused 403. Items with no division field are kept (they are
not divisioned — roles, integrations, prompts…). `/authorization/divisions`
is filtered to divisions where the user holds any grant.

**Writes.** Before the call:

| Call | The object's division |
|---|---|
| a create — POST to a collection, no id in the path | `body.division.id`, else Home |
| a write on an existing object — PUT/PATCH/DELETE/POST on `…/{id}…` | one GET of the object (the path up to its id); no division on it → not divisioned, allowed |
| the bulk move — `POST /authorization/divisions/{div}/objects/{TYPE}` | the target `{div}` must be allowed for the type's edit permission, and each object id in the body is read and its current division checked |

Refused: 403 `division_required` with `division` (name where known) and
`required`. The client's existing division-refusal explanation
(`js/lib/genesysErrors.js`) already turns Genesys's own version of this
into plain words; the app's refusal carries the same sentence.

**Cost.** One extra read per write on an existing object; none for lists.
Same as the data table rules check, for the same reason.

**Paging.** `fetchAllPages` stopped on a short page (`items < pageSize`)
before checking `pageCount`; a filtered page is short by design, so it now
stops on `pageCount` when Genesys sends one and on a short page only when
it does not. The hand-rolled loops in the pages already use `pageCount`.

## 5. What is deliberately not covered

- Analytics and audit queries: division is a filter inside the query body,
  not a field on the response items. Left as they are.
- Groups, roles, OAuth clients, integrations, data actions, prompts,
  languages, stations, GDPR, quality forms, triggers: not divisioned in
  Genesys (no `division` on the object) — nothing to scope.
- The client's greying (`accessService`) still checks the permission in
  any division. The lists it operates on arrive filtered, so a page can
  only offer what the user may touch; a greyed control still means "no
  permission at all".

## 6. A fix found on the way

`proxyPermissions.js` named four division-move object types by the wrong
enum value (`DATATABLE`, `EMERGENCYGROUP`, `SCHEDULE`, `SCHEDULEGROUP`;
Genesys says `DATATABLES`, `EMERGENCYGROUPS`, `ROUTINGSCHEDULES`,
`ROUTINGSCHEDULEGROUPS`), so those moves fell back to
`authorization:division:edit`. Both spellings are now accepted.

## 7. Test pass

`docs/testing/division-scope-tests.md`.
