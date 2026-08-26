# Gating read-only features on the user's own permissions — Design

Status: **Proposed** — awaiting go-ahead, no code written
Author: Genesys Admin App
Last updated: 2026-08-26

Supersedes the **"Read-only exemption (agreed)"** in
[customer-facing-plan.md §6](customer-facing-plan.md).

## 1. What is wrong

Confirmed live on 2026-08-26 with a test user whose demo-org role holds exactly
three permissions — `directory:user:edit`, `routing:language:assign`,
`routing:skill:assign`.

Write features greyed out correctly: the refinement layer works. But **every
read-only feature was fully usable** — Export, Audit, Flows, Interactions
Search, Roles Compare and Permissions vs. Users included.

That is the documented exemption behaving as specified. The specification is
wrong, and the reason is the client-credentials path: an internal user's reads
do not run as them. They run as the org's OAuth client, against **any**
configured customer org. So a user who cannot read licences in their own org
can read every customer's licence consumption through this app. Seeing the page
is not the problem; being handed the data is.

The rule the app should follow, in the customer's words: *if the user himself
does not have access to licence information, he should not be able to use this
app to retrieve licence information.*

## 2. The principle: gate on exactly what Genesys gates

Not every read is an escalation. `GET /api/v2/users`, `GET /api/v2/groups` and
`GET /api/v2/license/users` declare **no required permission** in the OpenAPI
spec — Genesys lets any authenticated user read them. Requiring a permission
there would be this app inventing policy Genesys does not have, and would deny
people data they can already fetch from any Genesys client.

So:

> A read-only feature requires the permission **Genesys itself requires** for
> the endpoints it reads. Where Genesys requires none, the app requires none —
> there is nothing to escalate.

This satisfies §1's rule exactly: if Genesys grants everyone access to X, the
user *does* have access to X.

## 3. The map is derived, not guessed

Every operation in `https://api.mypurecloud.com/api/v2/docs/swagger` carries an
`x-inin-requires-permissions` block. The map is read out of it rather than
written from memory — the same source that settled the licence endpoints in
[wem-license-permissions-design.md](wem-license-permissions-design.md).

Spot-checked already:

| Endpoint | Declared |
| --- | --- |
| `POST /audits/query` | ALL: `audits:audit:view` |
| `GET /authorization/roles` | ANY: `authorization:role:view` |
| `GET /license/definitions` | ANY: `authorization:grant:add`, `authorization:license:view` |
| `POST /analytics/conversations/details/query` | ANY: `analytics:conversationDetail:view`, `analytics:agentConversationDetail:view` |
| `GET /recording/jobs` | ALL: `recording:job:view` |
| `GET /flows` | ANY: `architect:flow:view` |
| `GET /users`, `GET /groups`, `GET /license/users` | **none** |

Note `ANY` vs `ALL` — the existing `getRequiredPermissions` already treats its
list as ANY, which matches the common case; the few `ALL` operations need the
distinction carried through rather than flattened.

## 4. Scope: 33 keys

Of 86 nav access keys, 53 are already write-gated and **33 are read-only**:
19 Export, 4 Interactions, 3 Utilities, 2 Flows, 2 Roles, and one each of
Audit, Deployment and GDPR.

Three need no gate at all and should be marked so explicitly, not left to
silence: `utilities.ipRanges` (reads no Genesys data), `export.scheduled` and
the Activity Log (app-owned storage, no Genesys permission exists).

## 5. Sub-page granularity is required, not optional

`roles.search` is one access key covering three tabs. Permission Search and
Hourly Interacting need `authorization:role:view`; the **WEM tab additionally
needs `authorization:license:view`**. Gating the whole page on the union would
deny the first two to someone entitled to them; gating on the intersection
would hand out the third.

The existing map shape already solves this — it is keyed by logical action:

```js
"roles.search": {
  view: ["authorization:role:view"],
  wem:  ["authorization:license:view"],
},
```

`accessState()` gains an optional action argument so a tab can ask about itself,
exactly as in-page buttons already do for writes.

## 6. Rollout: audit mode before enforcement

Fail-closed on day one will lock internal staff out of features they use today,
because nobody has ever needed these read permissions in the demo org. §6 of the
customer-facing plan already prescribes the sequence, and it applies unchanged:

1. Build the map (§3).
2. **Audit mode** — a third flag setting that evaluates every gate and logs what
   *would* be denied, denying nothing. Run it across the staff who use the app.
3. Remediate demo-org roles so nobody loses legitimate capability.
4. Flip to enforcing.

Audit mode is the part worth insisting on. Without it the coverage report is
guesswork, and the first day of enforcement is a support queue.

## 7. Files

| File | Change |
| --- | --- |
| `js/featurePermissionMap.js` | Add `FEATURE_READ_PERMISSIONS` beside the write map; export `getReadPermissions`, and carry ANY/ALL. |
| `js/services/accessService.js` | `accessState(key, action?)` consults the read map when the key is not write-gated; add the audit-mode flag. |
| `js/nav.js` | Hide or disable read-only leaves per §7 of the plan (hide the section, disable the leaf). |
| `docs/customer-facing-plan.md` | Replace the read-only exemption in §6 with a pointer here. |

## 8. Separate, and still open

`accessService.js` fails **open** on the group lookup: if
`GET /users/me?expand=groups` returns non-OK, `groupsFailed` is set and
`hasAccess()` returns true for every key. The permission gate twelve lines below
is explicitly fail-closed, so the two halves of one function disagree on which
way to fail.

It did not cause §1 — the test user's group lookup plainly succeeded, since the
permission-driven greying was correct. It is a latent hole all the same, and it
would nullify everything above the moment it fired. Recommended fix: fail closed,
and render an explicit "could not verify your access" state so the failure is
visible rather than either silently permissive or silently empty.
