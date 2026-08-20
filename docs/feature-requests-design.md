# Feature Requests — Design

Status: **Built and shipped in v3.8**
Author: Genesys Admin App
Last updated: 2026-08-20

## 1. Purpose

Give the people who use this app a way to ask for something inside the app
itself: a new feature, a change to one that exists, or a report that one behaves
wrongly.

Today those requests arrive by chat and mail, one conversation at a time. That
loses three things worth keeping. The request itself is not written down
anywhere it can be found again. The same request arrives from three people and
looks like three requests. And the person who asked never learns what happened
to it — so they stop asking, and the next one goes to a colleague instead of to
the app.

A shared board fixes all three, and it costs one table, one endpoint and one
page.

**Nothing is written to Genesys.** This feature reads the caller's identity and
writes to the app's own store.

## 2. Confirmed decisions

- **Shared board with voting.** Everyone in an org sees that org's requests and
  can upvote. Duplicates become votes instead of records, and the vote count is
  a priority signal that no amount of triage produces on its own.
- **Header button**, next to Activity Log — not a nav leaf. The point is §4:
  the button is reachable from the page being complained about, and captures it.
- **Email in both directions** (§7): on submission, on every status change, and
  on every thread message to whichever party did not write it.
- **Customers from day one** (§6). This is the decision with the widest reach,
  and §6 is where its consequences are stated rather than assumed.
- **Not a sellable module.** No entitlement, no package, no access key. Asking
  for a feature is not a feature you buy.
- **Two boards, one table** (§6.1). Requests are submitted **private** to their
  own org. The admin promotes selected ones to a **shared** board every org can
  see. Nothing crosses a tenant boundary unread.
- **The submitter is named to their own org; their address is not** (§6.6). On
  the shared board they appear as `Thomas V.`, with no org name, and may opt out
  of being named at all.
- **Replies are unattributed** (§6.6). There is no admin name on either board.
- **No open comments. A two-party thread instead** (§3a): the submitter and
  the superuser can talk on a request, to settle what is actually wanted.
  Colleagues read it; nobody else writes in it.
- **Open to everyone, changeable by one** (§5a). No access key, no entitlement:
  every authenticated session can submit, read and vote. Status, replies,
  promotion and deletion are superuser-only, verified server-side against a
  `SUPERUSER_IDS` app setting and the caller's token-derived user id.
- **Prerequisite cleanup** (§11 step 0): the admin email address is removed from
  the client bundle before this ships, so the board is not the fifth copy.

## 3. Data model

New Azure Table `featurerequests`, following
[`scheduleStore.js`](../api/lib/scheduleStore.js) rather than
[`activityLogStore.js`](../api/lib/activityLogStore.js): PartitionKey
`"request"`, RowKey a UUID. The activity log's inverted-timestamp RowKey exists
to make the newest entry sort first in a store that is only ever appended to.
These records are updated in place — status, note, votes — and a RowKey cannot
change, so ordering is done on read.

| Field | Notes |
|---|---|
| `ownerOrgId` | `internal` or the customer slug. The isolation boundary (§6). |
| `type` | `feature` · `change` · `bug` · `question` |
| `title` | one line, capped at 120 chars |
| `description` | free text, capped at 4000 chars (§8) |
| `route`, `pageLabel` | captured context — `/export/users/trustee`, `Export › Users › Trustee` |
| `orgId`, `orgName` | the org selected in the header when it was submitted |
| `appVersion` | `APP_VERSION` at submission — which build the complaint is about |
| `userId`, `userEmail`, `userName` | submitter, taken from the session, never from the body |
| `createdAt`, `updatedAt` | ISO strings |
| `status` | `new` → `triaged` → `awaiting-submitter` → `planned` → `in-progress` → `shipped` / `declined` / `duplicate` |
| `adminNote` | the **published** response — curated, superuser-written, the one line that may appear on a shared card (§6.3). Distinct from the thread (§3a). |
| `shippedVersion` | e.g. `"3.8"` — links to that release-notes entry, subject to §6.4 |
| `duplicateOf` | id of the surviving request |
| `votes` | JSON array of Genesys user ids; the count is derived, never stored separately |
| `visibility` | `private` (default) or `shared` — see §6.1 |
| `sharedTitle`, `sharedDescription` | the admin's published wording, used **only** on the shared board |
| `publishAnonymously` | submitter's choice at submit time; suppresses the name if promoted |

`votes` as a list of ids rather than a number is what makes a vote idempotent
and revocable without a second table. A request keeps its votes when promoted —
the in-org votes it already had are votes on the same thing.

`sharedTitle`/`sharedDescription` exist so that promoting never overwrites what
someone wrote. The submitter keeps seeing their own words on their own board;
the shared board shows yours. Editing in place would mean a customer opening
their request and finding it silently reworded, which is the kind of small
betrayal that stops people filing the next one.

## 3a. The discussion thread

A request is a first attempt at describing a need, and the first attempt is
usually a proposed solution rather than the problem underneath it. Settling what
is actually wanted takes a conversation. That conversation happens on the
request, between exactly two parties: **the person who submitted it, and a
superuser.**

**Nobody else writes in it.** A colleague who wants the same thing votes; a
colleague who wants something adjacent files their own request. Open commenting
was considered and rejected — see §10 — because a discussion feature is a real
build (a table, an endpoint, a notification path, deletion rules, a moderation
surface) resting on a guess that people will discuss requests at all, and
because everything it would carry is better expressed as a vote or a separate
request.

**Everyone in the owning org reads it.** The thread is not private between the
two parties. §1's complaint was that the person who asked never learns what
happened; a thread that only its two participants can see reproduces that for
everyone standing behind them. Colleagues seeing the exchange is also what stops
the same question arriving a second time. The superuser writes accordingly —
this is §6.3's standard, applied to every message rather than one.

*(If you would rather the thread were visible only to its two participants, that
is the single line to change here — it is a filter on the read, not a different
design.)*

### 3a.1 Storage

A second table `featurerequestthread`, PartitionKey = the request's id, RowKey =
inverted timestamp + uuid. One partition query returns a whole thread in order,
which is the shape Table Storage is actually good at.

Deliberately **not** a JSON array on the request row. Messages accumulate, and a
single property caps at 32 K: a handful of detailed exchanges gets close enough
that the design would eventually need the progressive-shrinking ladder that
`activityLogStore.serializeDetails` had to grow. Separate rows have no ceiling
and cost one extra query.

| Field | Notes |
|---|---|
| `requestId` | PartitionKey |
| `authorId`, `authorName` | from the token, never the body |
| `authorRole` | `submitter` or `superuser` — drives how the message is labelled, and which messages get anonymised for a customer (§3a.2) |
| `body` | capped at 4000 chars |
| `createdAt` | ISO string |

### 3a.2 Rules

- **Write:** the request's submitter, or any superuser. Checked against
  `caller.userId` (§5a), not against a body field.
- **Delete:** the author deletes their own; a superuser deletes any.
- **No editing.** A thread whose messages silently change afterwards is worse
  than one with a visible gap.
- **Who answered is hidden from customers.** §6.6 decided that replies carry no
  personal name, and that reasoning — a named individual invites follow-up
  outside the board and quietly turns one person into the support SLA — applies
  harder to a back-and-forth than to the one-line response it was written about.
  So on a **customer-owned** request, superuser messages are attributed to
  "Support". Internal threads keep real names, because the demo org knows who is
  answering and anonymising a conversation between colleagues would be strange;
  and a superuser always sees real names, including when reading a customer's
  thread, so triage never loses track of who said what. Applied as a server-side
  projection, not a page rule: a name the browser was sent and chose not to draw
  has still been sent.
- **A count and a waiting marker on the board.** A card shows "Discussion (3)"
  and, for the two people who can reply, a marker when the newest message came
  from the other side. Derived from three denormalised fields on the request
  (count, last message time, last author role), recomputed from the messages
  that exist rather than incremented, so the count cannot drift. This means
  neither party has to open a request to find out whether it is waiting on them,
  which was the gap the first live test found.
- **Never on the shared board.** The thread contains submitter text that no one
  curated, so it is absent from the §6.7 projection entirely. What crosses to
  other tenants is `adminNote` — the one curated, published response — and
  nothing else.
- **`awaiting-submitter`** joins the status list. It says the ball is in the
  submitter's court, which is the state an async two-party discussion spends
  most of its time in and which no other status expresses.

### 3a.3 Notification is what makes it work

Both directions, via §7: the submitter posts, the superusers are mailed; a
superuser posts, the submitter is mailed. An asynchronous conversation between
two people who are not looking at the same screen only functions if each turn
announces itself. This is the one place in the design where email is load-
bearing rather than a courtesy.

## 4. Context capture

The header button writes the current route to `sessionStorage` and navigates to
`#/requests`. The form reads it back and pre-fills the page context, which the
submitter can clear if the request is not about that page.

It is done this way because the route *is* the hash — see
[`router.js`](../js/router.js) `getRouteFromHash` — so `#/requests?from=…`
would be a route the registry does not know. `sessionStorage` needs no router
change at all.

The pay-off is disproportionate to the effort. "The export is missing a column"
is a message that costs a round-trip to act on. The same words arriving tagged
`Export › Users › Trustee`, org `acme`, build `3.7` are actionable as they
stand.

## 5. API

`/api/feature-requests`, modelled closely on
[`api/schedules/index.js`](../api/schedules/index.js):

| Method | Behaviour |
|---|---|
| `GET ?board=mine` | The caller's own org's requests, full records, scoped by `ownerOrgId`. |
| `GET ?board=shared` | Every `visibility: "shared"` request, as the redacted projection of §6.7. Any authenticated caller. |
| `GET ?board=all` | Admin only — every request from every org, unredacted. The triage queue. |
| `POST` | Create. Identity and `ownerOrgId` come from `getCallerContext`, never from the body. |
| `PUT {id}` | Submitter may edit their own **while status is `new`**; admin may set `status`, `adminNote`, `shippedVersion`, `duplicateOf`, `visibility`, `sharedTitle`, `sharedDescription` at any time. |
| `POST {id}/vote` | Toggle the caller's id in `votes`. Permitted on any request the caller can see on either board. |
| `GET {id}/thread` | The discussion thread (§3a). Visible to the request's own org and to superusers; never on the shared board. |
| `POST {id}/thread` | Post a message. **Only** the request's submitter and superusers. |
| `DELETE {id}` | Admin only. |

Promotion is `PUT` setting `visibility: "shared"` together with the published
wording. The endpoint should refuse to promote a request with no `sharedTitle` —
publishing raw submitted text across tenants is exactly the failure mode the
manual step exists to prevent, and it should not be reachable by forgetting a
field.

"Admin only" above means **superuser**, verified server-side — see §5a. It is
not `ADMIN_EMAIL`, and it is not a claim the browser makes.

Every write re-derives the caller from
[`callerContext.js`](../api/lib/callerContext.js). A body-supplied `userEmail`
is accepted for display only and never for authorization — the schedules
endpoint's `lockTargetOrg` comment explains why that distinction earns its
keep.

## 5a. Who is privileged, and how the server knows

**Everyone may use the board. One role may change it.** Submitting, reading your
own org's board, reading the shared board and voting are open to every
authenticated session. Status, `adminNote`, `duplicateOf`, promotion to the
shared board, deletion, and the cross-org triage read are **superuser only** —
one role, not a tier per action. A submitter keeps exactly two powers over their
own record: edit it, or withdraw it, while its status is still `new`.

### 5a.1 The gap this closes

Neither half of that sentence is enforceable with what the API has today.

`getCallerContext` resolves the caller's **organisation**, never the caller.
`classifyCaller` calls `fetchOrganizationMe`, which answers *which org this
token belongs to*; the user behind it is never fetched. Every ownership check in
the app therefore works off a `userEmail` in the request body — a claim the
browser makes, made survivable only by the fact that an org-verified session is
needed to reach the endpoint at all.

That is adequate for "may I edit my own schedule". It is not adequate for "only
this person may publish text to a board every tenant reads".

And `SUPERUSER_IDS` today lives in [`accessConfig.js`](../js/accessConfig.js),
read solely by [`accessService.js`](../js/services/accessService.js) for nav
gating. It is client-side. The API has never heard of it, and it could not
safely trust it if it had — a constant in a file the browser downloads is a
claim, not proof.

### 5a.2 What gets added

1. **A verified user identity on the caller context.** Fetch
   `/api/v2/users/me` with the caller's own token and cache it on the token key,
   beside the classification cache that already exists there. `caller.userId`
   then derives from the token rather than from the body. One extra Genesys call
   per token per cache window.
2. **`api/lib/superusers.js`, reading a `SUPERUSER_IDS` app setting** —
   comma-separated Genesys user ids. An app setting rather than a checked-in
   constant for two reasons: the queue gains or loses a triager without a
   deploy, and the list never enters the client bundle, which is the same
   reasoning as §11 step 0.

**Ids, not email addresses.** [`creatorAuth.js`](../api/lib/creatorAuth.js)
already argues this for schedules, and the 3.6 release notes record the concrete
failure: Genesys releases a deleted user's address for reuse. An email-keyed
privilege check quietly transfers to whoever inherits the address. An id does
not.

### 5a.3 Two things this leaves open

This creates a second notion of privilege beside `ADMIN_EMAIL`. That is
deliberate direction rather than duplication — server-verified, id-based and
config-driven beats an email literal compiled into four client files — but
schedules, templates and the activity log are **not** refactored in this pass.
The rule for now is narrower: do not add a fifth `ADMIN_EMAIL`.

And one superuser is a single point of triage: while that person is away, no
status moves, no request is answered and nothing is promoted. `SUPERUSER_IDS`
holds a list precisely so a second name is a config change, not a code change.

## 6. Customers

Opening this to customers on day one is the decision that touches the most
code, so its consequences are set out rather than left implicit.

### 6.1 Two boards, one table

**My board** is per-org, scoped by `ownerOrgId` exactly as schedules and the
activity log are scoped today. **The shared board** is every request the admin
has promoted to `visibility: "shared"`, and every org sees the same one.

| Viewer | My board | Shared board |
|---|---|---|
| Customer user | Their own org's requests, incl. colleagues' | All promoted requests, redacted (§6.7) |
| Internal user | Internal requests | The same promoted requests |
| Admin | Every org's requests (§6.2) | The same, plus the promote controls |

Sharing *within* an org is not new. `GET /api/schedules` filters on owner alone,
so every user in an org already sees every schedule that org created, carrying
its `createdByName`; customer sessions of the Activity Log likewise get the
whole org's entries with no per-user filter. A board shared among an org's own
staff is the established contract.

Sharing *across* orgs is new, and is why promotion is manual.

**Why not raw global visibility.** A board where every submission is instantly
visible to every tenant was considered and rejected on four counts:

1. **Request text identifies its author even when the org name is hidden.**
   "Bulk deactivation before our Q4 restructuring" names the customer to anyone
   who knows the market.
2. **Tenants may compete.** Publishing one customer's operational gaps to
   another is a decision taken on their behalf, without asking them.
3. **Bug reports are the sharp case.** "The trustee export is showing me another
   org's data" is a private report on a per-org board and a public vulnerability
   disclosure on a global one.
4. **A bad paste stops being containable.** §8 asks people not to paste
   conversation content or personal data. Contained to one org that is a
   cleanup; visible to every tenant it is potentially a notifiable breach, and
   the existing DPAs do not cover showing one customer's submissions to another.

Promotion answers all four, at no extra cost in effort: the moderation step *is*
the triage step, which was already happening. What survives is the entire upside
— cross-org dedupe, a vote count aggregated over the whole customer base, and a
board that reads as a live roadmap rather than a suggestion box.

### 6.2 The one deliberate exception

The admin triage view **spans owners**. This departs from the rule in
[`customer-facing-plan.md`](customer-facing-plan.md) §10 that an internal
session never reads customer-owned records — the Activity Log honours that rule
by scoping even the admin read to `ownerOrgId: "internal"`.

The exception is correct here, and the reason is what the record *is*. An
activity log entry is the customer's own operational history, which the app
holds on their behalf. A feature request is a message addressed to us;
submitting it is the act of sending it. A triage queue that cannot see the
requests it is meant to triage is not a queue.

The exception is narrow and should stay narrow: one admin-gated read path, no
new cross-org write, no other store affected.

The shared board (§6.1) makes this read load-bearing rather than merely
convenient: it is the queue the promoted requests are chosen from. Without it
there is no curation step, and without curation the shared board would have to
be automatic — which §6.1 rejects.

### 6.3 The note is customer-visible

`adminNote` is shown to the submitter. When the submitter is a customer, it is
customer-facing text — the same standard as a release note, not the standard of
an internal comment. There is no private field, deliberately: a second, hidden
note field is a trap that eventually gets typed into by mistake.

### 6.4 Shipped links must respect `internalOnly`

[`renderReleaseNotesPage`](../js/pages/releaseNotes.js) filters entries flagged
`internalOnly` out of customer sessions. A request marked shipped against such
a version would link a customer to an entry they cannot see. The card shows the
version number as plain text whenever the matching entry is hidden from the
viewer, rather than linking into nothing.

### 6.5 Entry point

Ungated, like the Activity Log button in [`index.html`](../index.html): visible
to every signed-in session, internal or customer.
[`packages.js`](../api/lib/packages.js) is untouched, and no key is added to
`accessConfig.js`.

State that plainly, because it is a first: this is the only feature in the app
that ignores the access model outright. A customer whose entitlements grant them
a single page still gets the board, and an internal user in no group at all
still gets it. That is correct — the channel for telling us the product is
missing something cannot itself be something you have to be granted — but it is
a deliberate line, not an oversight, and §5a is what keeps "open to everyone"
from meaning "editable by everyone".

### 6.6 Who is named

**On their own board, the submitter is named to their own org.** It shows
`userName`; `userEmail` goes only to the admin view. The name is what makes a
shared board work — you can tell three people asking from one person asking
three times, and you know who to go back to with a question. The address adds
nothing for colleagues and is the part worth withholding; no other page in the
app shows one user's address to another.

**On the shared board, the submitter is `Thomas V.`** — given name plus the
initial of the surname, derived server-side from `userName`, with no org name
beside it. If `publishAnonymously` was ticked at submit time, the card reads
"A customer" (or "Internal" for staff requests) instead.

The opt-out is one checkbox and it removes most of the personal-data objection
outright: nobody's name reaches another tenant without that person having left
the box unticked on a form that said what it meant.

**Vote counts are shown; voter identities are not.** The response says how many
votes a request has and whether *you* voted, so the button can toggle. A voter
list is exposure with no upside.

**Replies are unattributed.** `adminNote` carries no author field, and renders
under a neutral "Response" heading. Thread messages follow the same rule where
it matters — see §3a.2, which anonymises superuser messages on a customer's
request while leaving internal threads named. Status-change mail is sent from the Mailjet
identity (`MAILJET_FROM_EMAIL` / `MAILJET_FROM_NAME`), not from a personal
address. For customers this matters more than it looks: a named individual on a
reply invites follow-up outside the board and quietly turns one person into the
support SLA.

That last point is undermined if the admin address is readable in the client
bundle, which is why §11 step 0 exists.

### 6.7 The shared board is a server-side projection

A shared card is **built on the server** from a different set of fields than the
record holds. The API never sends a full request object to a caller outside its
owning org and leaves the browser to hide the rest.

Sent on a shared card: `id`, `type`, `sharedTitle`, `sharedDescription`,
`status`, `shippedVersion`, `adminNote` (the curated one, never the thread),
vote count, whether the caller voted,
and the abbreviated display name. Withheld: `title`, `description` (the
submitter's original words), `userEmail`, `userId`, `userName`, `ownerOrgId`,
`orgId`, `orgName`, `appVersion`, `route`, and the `votes` array itself.

This is the difference between a redaction and a CSS rule. Filtering in the
browser means the data was already delivered — one view-source, or one look at
the network tab, and the org name you thought you had hidden is on screen. The
projection is the boundary; the page is only where it is drawn.

`route`/`pageLabel` are withheld deliberately even though they look harmless:
the page a request came from, combined with its text, narrows the author
considerably.

## 7. Email

All notifications are sent **server-side**, from the endpoint that performs the
write — not from the browser.

There are already two Mailjet implementations in this repo
([`api/send-email`](../api/send-email/index.js) and
[`api/scheduled-runner`](../api/scheduled-runner/index.js)). A third would be
the wrong answer, so this feature starts by factoring the Mailjet call into
`api/lib/mailer.js` and pointing both existing callers at it. That refactor is
small, and it is the only reason this feature touches code outside its own
files.

- **On submission** → the superusers. Subject carries type and title; body
  carries the captured context, so triage rarely needs to open the app. A
  superuser filing their own request is left off this one — they already get
  the receipt below.
- **On submission** → the person who filed it, as a receipt. The page already
  said thank you, so this is not news; it is their own words in their own
  inbox, so a request is something they can find again and forward rather than
  something they typed into a box and hoped about. It also proves the address
  we hold for them works, before the first status change depends on it.
- **On status change** → the submitter. This is the notification that decides
  whether the board gets used twice: a request that visibly moves is worth
  filing, and one that vanishes is not.
- **On a thread message** → the other party (§3a.3). Submitter posts, the
  superusers hear; a superuser posts, the submitter hears. Never an echo to the
  author of the message.

A send failure must never fail the write. The record is the record; the mail is
a courtesy — with the one exception of the thread, where a message nobody is
told about is a conversation that stalls. Even there the write stands and the
failure is logged; it is not rolled back.

Recipients are addresses the app already holds — the submitter's own, and the
`SUPERUSER_IDS` users'. Nothing here mails an address supplied in a request
body.

## 8. Limits, retention and safe rendering

Customer sessions can now write to an app-owned store, which raises three
things that internal-only volume would have let us ignore:

- **Length caps** — 120 chars of title, 4000 of description, enforced
  server-side. Azure Table Storage caps one property at 32 K and an entity at
  1 MB; staying far below both means never needing the truncation ladder
  `activityLogStore.serializeDetails` had to grow.
- **Rate limit** — a per-user daily cap on creates (20 is generous and still
  stops a loop). Votes are idempotent by construction, so they need no cap.
- **Retention** — 12 months, purged on admin read, exactly as the activity log
  does it. Requests that shipped or were declined a year ago are history, not
  backlog.
- **Escaping** — every rendered field goes through `escapeHtml`. This text now
  arrives from other tenants, so it is untrusted input in a way the activity
  log's own descriptions never were.

A short hint under the description field asks people not to paste conversation
content or personal data. It will not stop everything; combined with retention
it keeps the exposure bounded.

**Said at the point of writing, not buried.** The form states plainly that a
request may be published to the shared board that all organisations can see,
shown as given name plus surname initial and without the org name, and offers
the checkbox that suppresses the name. Consent belongs next to the text box, not
in a document nobody opens — and it is the sentence that makes §6.1's promotion
step legitimate rather than merely careful.

## 9. Closing the loop

When a request ships, its status is set to `shipped` with the version, and the
card links to that release note (§6.4). The person who asked sees their own
words end in a release. That is the whole reason to build a board rather than a
mailbox, and it is one field.

On the shared board the same field does something the private board cannot: it
shows every org that things asked for here get built. A roadmap with shipped
items on it is the difference between a board people file into and a board they
watch.

## 10. Not in scope

- **Attachments and screenshots.** They need Blob storage, not Table Storage —
  a property caps at 32 K. Worth adding once the board proves itself.
- **Open comment threads.** Colleagues cannot post on each other's requests.
  The only conversation is the two-party thread of §3a — submitter and
  superuser. A vote is how everyone else says "me too"; anything more specific
  than that is its own request.
- **Uncurated cross-org visibility.** The shared board exists (§6.1), but
  nothing reaches it without a human promoting it and writing the published
  wording. Automatic publication is not a later phase; it is the thing the
  design rejects.
- **Cross-org identity.** No org name and no address ever crosses a tenant
  boundary, promoted or not.
- **Anything written back to Genesys.**

## 11. Build order

0. **Prerequisite, shipped on its own:** remove the admin email address from the
   client bundle. It is currently a literal string in four files the browser
   downloads — [`schedulePanel.js:26`](../js/components/schedulePanel.js),
   [`activityLog.js:15`](../js/pages/admin/activityLog.js),
   [`templateSchedules.js:15`](../js/pages/users/rolesSkills/templateSchedules.js)
   and inline at [`createTemplate.js:186`](../js/pages/users/rolesSkills/createTemplate.js).

   None is a security control: `scheduleStore.canEdit` runs the same comparison
   server-side before any write, and `/api/activity-log` already returns an
   `isAdmin` flag. They decide only whether a button is drawn. But every session
   downloads them, customer sessions included, and four copies of one fact — two
   written differently — silently break the admin's own Edit buttons if the
   address ever changes, with no error, because the server would still accept
   the write.

   Activity Log is nearly free: use the `isAdmin` the GET already returns. The
   other three need their list responses to carry a per-row `canEdit` (the
   server has `store.canEdit` already) or an envelope `isAdmin`, after which the
   pages drop their constants. Three endpoints, four pages, none of which this
   feature otherwise touches — hence its own change.

1. `api/lib/mailer.js` — extract from `send-email`, repoint `scheduled-runner`.
   Verifiable on its own before anything new depends on it.
2. **Server-side identity and privilege** (§5a): `caller.userId` on the caller
   context, cached on the token key; `api/lib/superusers.js` over a
   `SUPERUSER_IDS` app setting. Nothing else in the app changes behaviour — the
   existing endpoints keep their own checks — so this lands as pure addition and
   can be verified with one endpoint before anything depends on it.
3. `api/lib/featureRequestStore.js` + `api/feature-requests/` — store and
   endpoint, including the superuser cross-owner read.
4. `js/services/featureRequestService.js` — client wrapper, in the shape of
   `scheduleService.js`.
5. `js/pages/requests.js` + registry entry + header button + context capture —
   **My board** only, plus the submit form with its consent line and anonymity
   checkbox.
6. Superuser triage controls on the same page, gated by the `isAdmin` flag the GET
   already returns: status, note, `duplicateOf`, and promotion.
7. **The discussion thread** (§3a) — `featurerequestthread` table, the two
   thread endpoints, both notification directions, and the
   `awaiting-submitter` status. Independent of the shared board, so the
   order of these two can swap.
8. **The shared board** — the §6.7 projection server-side, the second tab
   client-side, cross-org vote aggregation. Last, deliberately: it is the only
   part that crosses a tenant boundary, and by this point everything it depends
   on is already working and testable.
9. Release note for the version this ships in — not `internalOnly`, since
   customers get the feature too.
