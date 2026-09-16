# Audit › Search — searching for one object

Status: **Agreed 2026-09-16**, built the same day
Author: Genesys Admin App

## 1. Why

The most common audit question is not "what happened last week" but "what
happened to *this* queue". Genesys's own filter for that, `EntityId`, turned
out to be unusable on its own: the server answers
`IllegalQueryException [When supplying an entityId you must also supply entityType]`,
and nobody with a GUID in hand knows which of ~60 entity types it is. Worse,
one object is audited under several types (a user is `Directory/User`,
`PeoplePermissions/AuthUser`, `Presence/UserPresence`,
`ContactCenter/AgentRoutingInfo`), and it also appears *inside* other
objects' audits — as the member added to a role, as a value in a queue's
member list — where the entity is the role or the queue, not the user.

## 2. Confirmed decisions

- **Pick, don't paste.** The query zone gets an **Object** kind picker
  (Queue, User, Flow, Role, Data table, …, in plain words) and, once a kind is
  chosen, a searchable **Which one** list of that kind's existing objects,
  loaded on demand and cached per org. Choosing an object is all the user
  has to do.
- **An id can still be pasted**, behind a small "…or paste an id" link, for
  objects that no longer exist — the picker can only list what is there
  today. The results name the object from its own audits.
- **Always deep.** Searching for an object never uses `EntityId`. It runs the
  normal pull for the range (service optional, as before) and keeps every
  entry in which the id appears anywhere except the actor fields: as the
  entity, inside a composite name such as a role grant, in old/new values,
  entity changes, context or message. That is the only way to get *all*
  audits for an object, and it costs exactly what the plain search over the
  same range already costs. There is no tick-box for a shallower mode.
- **"History of this object"** in an expanded row runs the same search for
  that row's entity, so a change seen in a wide search can be followed
  without retyping anything.
- **Post-filters are labelled.** The section under the status line is
  headed *Filter these results* and holds Entity Type, Action, Changed By,
  Status and Export, populated from the values present in the results. The
  query zone above holds only what goes to Genesys.
- **Standard-query rate limits** get the same treatment as realtime ones:
  longer back-off on submission, and a second pass over rate-limited chunks
  after a pause.

## 3. Not in scope

- Kinds without a list endpoint (recordings, evaluations, access tokens)
  are not in the picker; the pasted-id route still covers them.
- Actions *performed by* a user are not "audits of" that user; the Changed By
  post-filter covers that.
