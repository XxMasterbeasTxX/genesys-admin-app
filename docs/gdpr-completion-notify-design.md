# GDPR — Completion notification

Status: **Implemented** 2026-09-15 — `api/lib/gdprWatchStore.js`, `api/lib/gdprNotify.js`, `api/gdpr-watches`, `js/services/gdprWatchService.js`; test cases `docs/testing/gdpr-tests.md` §13.
Author: Genesys Admin App
Last updated: 2026-09-15

## 1. Purpose

A GDPR request takes Genesys one to two business days. Today the only way to
learn it has finished is to come back to Request Status and press Load. The
person who raised the request should be able to ask for an email instead.

## 2. What was checked first

- **Genesys has no notification topic for GDPR requests.** The full
  `GET /api/v2/notifications/availabletopics` list was read on Demo on
  2026-09-15: 260 topics, none under `gdpr`. The nearest, `v2.audits…` and
  `v2.users.{id}.analytics.reporting.exports`, fire for other things. Polling
  is therefore the mechanism, not a shortcut past a better one — and the app
  has no always-on process to hold a notification socket anyway.
- **The app already polls Genesys on a timer.** A timer Function App POSTs
  `api/scheduled-runner` every five minutes with `SCHEDULE_RUNNER_KEY`; the
  runner authenticates to a customer org with **client credentials from app
  settings** (`GENESYS_<ORG>_CLIENT_ID` / `_CLIENT_SECRET`, resolved by
  `api/lib/genesysFetch.js`), mails through `api/lib/mailer.js` (Mailjet),
  and keeps its state in Table Storage (`api/lib/scheduleStore.js`).
- **`GET /api/v2/gdpr/requests` needs `gdpr:request:view`** on whatever
  client calls it. The pages use the signed-in user's token; the runner uses
  the org's client credentials, so that client must carry the permission.

## 3. Design

### Subject Request — one checkbox

On the confirmation step, beneath the subjects to be submitted:

> ☐ **Email me when Genesys completes this**
> Email address: `______________` *(shown when ticked; empty by default)*

Not prefilled. The Genesys login address is often not the one a person reads
notifications on, so guessing it would be wrong more often than helpful.
Validated with the mailer's own `EMAIL_RE` before Submit enables. One
address; the same address covers every request the submission creates.

### Storage — `GdprWatches`

Table Storage, partition `orgId`, row `requestId`:

| Field | Purpose |
|---|---|
| `email` | Where to send |
| `requestType` | Access / Rectification / Erasure, for the mail |
| `submittedBy` | Name of the person who raised it, for the mail |
| `createdAt` | Start of the 30-day watch |
| `lastStatus` | Last status the sweep saw, so a change is a change |
| `notifiedAt`, `outcome` | Set once; a watch is never mailed twice |
| `ownerOrgId` | Same scoping as the other stores (`callerContext`) |

Written by a new `POST /api/gdpr-watches` immediately after a successful
submission, one row per request id returned by Genesys. The submission
itself keeps going through the proxy exactly as now; a watch that fails to
save produces a warning on the page, not a failed submission. Read and
deleted only by the sweep.

### The sweep — inside the existing runner

`api/scheduled-runner` gains one step before the export schedules: if the
stored `lastGdprSweep` marker is more than **55 minutes** old, sweep. For
each org that has open watches, **one** paged
`GET /api/v2/gdpr/requests` (via `genesysGetAllPages`), then for each watch:

| Seen | Action |
|---|---|
| `COMPLETED` | mail *completed*; mark notified |
| `ERROR` | mail *failed*; mark notified |
| anything else, watch < 30 days old | store `lastStatus`, wait |
| anything else, watch ≥ 30 days old | mail *still not complete*; mark notified |
| request no longer listed | mail *no longer visible in Genesys*; mark notified |
| org has no credentials, or the call is refused (403) | mail *the app could not check — ask your administrator to grant `gdpr:request:view` to the app's OAuth client* ; mark notified with `outcome: unchecked` |

One request per org per hour is trivially inside the 45-second cap. Notified
rows are deleted after 7 days; nothing about the subject is ever stored.

### The email

Plain text, no attachment, no link, no personal data about the subject:

```
Subject: GDPR Access request completed — <Org name>

The GDPR Access request raised by <Submitter> on 12 Sep 2026 has completed.

Request id:   f8e044e2-d5d9-4fe3-baf7-fe7e0e417d19
Org:          <Org name>
Status:       Completed (seen 15 Sep 2026 09:00)

You can view the request under GDPR › Request Status in the Genesys Admin Tool.
For an Access request, the export archive is downloaded from there.

This is the only email you will receive about this request.
```

Same shape for *failed*, *still not complete after 30 days*, *no longer
listed*, and *could not check*, each saying plainly what happened next.

### Activity Log

`gdpr_notify_sent` — org, request id, outcome, recipient domain only
(`someone@tdc.dk` is logged as `@tdc.dk`). Written by the runner.

## 4. Consequences worth agreeing to

- **Only orgs with client credentials in app settings can be watched.** That
  is how every scheduled feature in the app works; an org without
  `GENESYS_<ORG>_CLIENT_ID` gets the *could not check* mail within the hour
  rather than silence, and the onboarding doc gains a line saying that the
  client needs `gdpr:request:view` for notifications to work.
- **Hourly, not instant.** A request that completes at 09:01 is mailed by
  10:00. Genesys takes days; an hour is fine, and it keeps the sweep to one
  call per org.
- **The email address is stored for up to 37 days** beside a request id and
  an org id. It is the operator's own address, entered for this purpose; the
  design keeps it out of the Activity Log and deletes it with the watch.
- **A watch is never mailed twice.** A completed request that is later
  re-listed, or a runner that runs twice, cannot produce a second mail.

## 5. Rejected

- **Prefilling the signed-in user's address.** See §3.
- **A link in the email.** A link to the app tempts a link to the archive,
  and the signed download URL belongs behind the app's login, never in an
  inbox. "View it under GDPR › Request Status" is enough.
- **Notification topics / websockets.** None exist for GDPR, and nothing in
  the app stays up to listen.
- **A second timer.** The five-minute runner already exists; a marker row
  makes it hourly for this step.
- **Mailing once per submission when all its requests are done.** They
  finish independently and can fail independently; one mail per request is
  the honest unit.

## 6. Decisions (2026-09-15)

1. **Retention of a completed watch: 7 days** after notification, so a
   "did it mail, and where?" question in the following week has an answer;
   then purged. The Activity Log keeps only the recipient's domain.
2. **Who may watch: anyone who can submit.** No extra permission and no
   domain restriction on the address — the mail carries a request id and an
   org name, nothing about the subject.
