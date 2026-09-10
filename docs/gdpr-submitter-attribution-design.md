# GDPR — Submitter attribution

Status: **Implemented** (5.4)
Author: Genesys Admin App
Last updated: 2026-09-10

## 1. Purpose

Make **GDPR › Request Status › Submitted by** name the person who raised a
request, instead of the integration that carried it.

Today the column shows `API client` for everything raised through this app.
That is honest but not useful: the app authenticates with the org's OAuth
client credentials, so Genesys records the client as `createdBy` — the same id
on every row. Confirmed from a live payload:

```
createdBy → {"id":"4bd17c79-…","selfUri":"/api/v2/users/4bd17c79-…"}
```

Genesys calls it a user, but neither the directory listing nor the single user
get will name it. There is no id in the Genesys response that identifies a
person, because no person reaches Genesys — the integration does.

The app already knows who it was. `logAction` records the real user on every
submit. It just does not record *which requests* that submit produced, so the
two cannot be joined.

**"Who erased this person's data?" is the question this column exists to
answer.** Under a compliance review it is the first thing asked, and right now
the answer is one page away in the Activity Log rather than on the page that
poses the question.

## 2. Confirmed by inspection

- `logAction` already accepts a **`details`** field, serialized to JSON by
  [`api/lib/activityLogStore.js`](../api/lib/activityLogStore.js) and parsed
  back on read. **No schema change and no backend change are required.**
- Storage is Azure Table Storage, single partition, capped at 30 000
  characters per `details` value and 12 months' retention.
- `GET /api/activity-log` returns the caller's whole organisation's entries,
  newest first, `limit` default 500 and max 1000. There is no server-side
  filter by action or by request id.
- The submit path already collects `submittedIds` for the success panel — the
  ids are in hand at the moment the log entry is written.

## 3. Design

**Write.** On a successful submit, `subjectRequest.js` adds the Genesys request
ids to the existing `details` payload:

```js
details: { gdprRequestIds: ["fe83434d-…", "b7c3b440-…"] }
```

Both the all-succeeded and part-succeeded paths write it, so a partial submit
is attributable too.

**Read.** On load, `requestStatus.js` fetches the activity log once, keeps
entries where `action === "gdpr_request"` and `orgId` matches the selected
customer org, and builds `requestId → { userName, userEmail }` from each
entry's `details.gdprRequestIds`.

**Render.** `Submitted by` resolves in this order:

1. A name from the activity-log join — the person.
2. A name resolved from Genesys `createdBy` — a request raised outside this
   app, directly in Genesys admin.
3. `API client` with the existing tooltip — raised through some integration,
   with no matching log entry.

The person's name carries a small marker distinguishing "we know this from our
own records" from "Genesys told us", because those are different strengths of
evidence and an audit reader should not have to guess which they are looking
at.

## 4. Consequences worth accepting before starting

- **Not retroactive.** The nine requests already in the Demo org were logged
  without their ids and will keep reading `API client` forever. Only requests
  submitted after this ships are attributable.
- **Bounded by retention.** Attribution disappears when the log entry ages out
  at 12 months, and an org that writes more than `limit` entries in that window
  loses the oldest first. The column degrades to `API client`; it never shows a
  wrong name.
- **One extra request per page load**, to the app's own API, not Genesys.
- **Not proof.** This says which app user pressed the button. Someone with
  direct API access to the customer org can raise a GDPR request without
  touching this app at all, and that request will correctly show whatever
  Genesys recorded.

## 5. Rejected

- **A dedicated Table Storage column for the request id.** `details` already
  exists, is already serialized and parsed, and a request maps to many ids —
  which would need a second table or a delimited string either way.
- **Server-side filtering by request id.** Volume is low (single partition,
  low hundreds of entries) and the page already loads a list; a query parameter
  is work with no user-visible gain.
- **Matching on timestamp and count instead of ids.** It would attribute the
  nine existing requests — an entry reading "Submitted 7 GDPR Access requests"
  at 14:09 against seven Access requests created 14:09:16 is a near-certain
  match. Rejected anyway: a *probable* name in an audit column is worse than an
  honest blank, because nothing downstream can tell the two apart.

## 6. Settled at go-ahead

The join is **not read-gated**. The activity log is already readable by anyone
in the org, so this exposes nothing new, and the same names sit one click away
under Admin › Activity Log. A gate here would only make the column silently
empty for some readers, which is the failure this whole change exists to
remove.
