# GDPR — Article 15 - Export Reader

Status: **Implemented** — go-ahead 2026-09-14; built the same day. `js/pages/gdpr/exportReader.js`; test cases in `docs/testing/gdpr-tests.md` §12.
Author: Genesys Admin App
Last updated: 2026-09-14

## 1. Purpose

Turn a GDPR Access export archive into something a person can read and hand
on, without the archive or its contents ever leaving the browser.

What Genesys delivers for an Article 15 request is a ZIP of flat
`service!identifier` files with no folders, no index and, for most of them, no
extension.

Five real exports were opened on 2026-09-13/14: three for **external
contacts** (246, 12 and 6,727 files) and two for **Genesys users** with call
history (37,194 and 17,390 files; 30 and 42 MB unpacked). The two kinds of
subject produce two different archives, and the reader has to handle both.

### 1.1 Common to every export

| Prefix | What it is | Readable? |
|---|---|---|
| `analytics!<uuid>` | ~600-byte **acknowledgement receipts** — one per analytics topic that processed the request. 96–99% of every archive. In the user exports, 36,931 of them across 25 topics (`ConversationEvent` 16,042, `UserActivityEvents` 10,269, `ProviderCallEventSubmitted` 5,276, `PresenceEvents`, `TranscriptsEvent`, `GamificationPerformancePointsEvents`, …). Topic, `externalId` (for conversation topics, the **conversation id**), event timestamp, an S3 acknowledgement URL. **No content** — but the ids are usable: see the Calls sheet. | Nothing to read; ids joinable |
| `recording!…_Rec_….zip` | A **per-recording bundle**: one transcript JSON plus its attachments. `MessageTranscript_*.json` (chat/messaging: timestamp, from, to, text, status; some rows carry `events` — Presence join/leave, CoBrowse — instead of text) or `EmailTranscript_*.json` (from, to, cc, subject, time, text body, HTML body, attachment list) **with the inline images and attachments as separate files** in the same zip | **Yes — the real content** |
| `recording!…_Rec_….opus` | **Call audio**, Ogg Opus. Loose in the archive, one file per recording, no transcript and no metadata beyond the conversation and recording ids in the filename. 225 in one user export (30 MB), 8 in the other. Some are **27-byte empty Ogg headers** — 4 of 225, and 10 of 45 in the large contact export — a recording that holds nothing | Listed with duration, not transcribed |
| `recording!…_Rec_….json` | A third transcript shape: the **legacy ACD chat** format (2020), a flat list of `member-join` / `standard` / `member-leave` rows with `body`, `from`, `utc`. Two seen | Yes |
| `journey-session-store!<id>.json` | Web/messaging **journey sessions**: subject, direction, channels, duration, outcome, queue, event count | Yes |
| `billing-service!<uuid>` | "Invoice Copies": invoice **ids** and a note that invoices *may* contain PII | Pointers only |
| `quality!Survey_*.json` | Survey responses, when any | Yes |

### 1.2 Only in an external-contact export

| Prefix | What it is |
|---|---|
| `contacts-service!externalContact.json` | The subject's external-contact record: name, channels, dates, merge history |
| `contacts-service!externalContact-notes.json` | Empty in all three |

### 1.3 Only in a Genesys-user export

| Prefix | What it is | Readable? |
|---|---|---|
| `venue!<uuid>` | The **user profile**: name, main email, chat JID, department, skills, mobile number | Yes — this is the Subject sheet |
| `auth-api!<uuid>` | The login email address, plain text, one line | Yes |
| `edge-config-user!<uuid>` / `!callForwardingByUserId` | Station assignment (default / last station ids, logged in) and call-forwarding settings | Yes, small |
| `REALTIME!messages` | The user's **internal Genesys chat** (colleague-to-colleague), plain text: `created: <ISO>, message: <text>` per line, blank-line separated | Yes |
| `postino-service!<conversationId>` | **Email conversation records**: per-communication routing (direction, addresses, queue, timestamps) and per-message **headers** (from, to, cc, subject, time). Bodies are *not* included — the `emailElements` URIs are null | Headers only |
| `sta-transcript-outliner!<conversationId>_<communicationId>.json` | Speech & Text Analytics **conversation outlines**: an AI-written list of segments, each a header, a one-sentence description and start/end times. Five seen, each for a conversation that also has a recording and a journey session | Yes — the nearest thing to a call transcript the archive holds |
| `gamification-service!<uuid>` | Performance points: per workday, per metric, points and value; personal bests; timezone per day | Yes, tabular |
| `squonk-service!<uuid>` | Web Messenger **deployment configurations** the user last modified — 163 KB of i18n labels and snippets. Not the user's data; the user id appears as `lastModifiedUserId` | Names only |
| `PUSH!`, `adjustments-service!`, `alternative-shifts!`, `wem-coaching!`, `wem-recognition-service!`, `wfm-self-scheduling!`, `workforce-management-adherence-explanations!` | WEM containers: push tokens, time-off adjustments, shift trades, coaching appointments, recognitions, activity moves, adherence explanations. **All empty** in both exports, but the shapes are known and would carry rows for a scheduled agent | Yes when present |

**In every export, the files that matter are under 4%.** Emails, chat
transcripts, calls, journey sessions and the subject record are scattered
across extensionless JSON, zips inside the zip, and audio. That is the thing
to fix.

## 2. Design

A new page, **GDPR › Article 15 - Export Reader** (`/gdpr/export-reader`),
the third leaf under GDPR beside Subject Request and Request Status. The label
names the article, since the page only makes sense for an Access export.
Reading an archive is a distinct task from tracking requests — it starts from
a file, not from an org — and it gets a page of its own rather than a panel at
the foot of a table.

Wiring, following the two existing GDPR pages:

| File | Change |
|---|---|
| `js/navConfig.js` | Third leaf under GDPR: `Article 15 - Export Reader`, path `export-reader`, access `gdpr.exportReader` |
| `js/pageRegistry.js` | `/gdpr/export-reader` → `js/pages/gdpr/exportReader.js` |
| `js/accessConfig.js` | Document `gdpr.exportReader` |
| `js/featurePermissionMap.js` | **No entry.** The page calls no Genesys endpoint — it parses a file on the user's machine — so there is no Genesys permission to require. It is gated by the `gdpr.*` entitlement alone, which `api/lib/packages.js` already grants. |
| `js/pages/gdpr/exportReader.js` | The page |
| `css/styles.css` | Drop zone and results panel, `gdpr-` prefixed like the rest |

**Input.** A file picker and drop zone accepting `.zip`, front and centre. The
archive is already on the user's machine; that is the only place it needs to
be. The page does not need an org selected — the archive says which subject it
is about.

**Parsing, entirely client-side.** `JSZip` is already loaded by `index.html`.
Entries are classified by their `service!` prefix; nested `recording!….zip`
files are opened in turn. Call audio is not decoded: the duration comes from
the granule position in the last Ogg page (the container is read, not the
codec), and the bytes are released once it is known. Measured: 17,390 files
in 3.6 s, 37,194 files in 11.6 s, with a running counter.
Nothing is uploaded, proxied or logged — the Activity Log records that an
export was read and the request id from the filename, not what was in it.

**Output: one styled Excel workbook**, through the existing `downloadWorkbook`
→ `download.html` path. That path uses the native Save As dialog, so it works
inside the Genesys iframe with no sandbox flag — and it is the Save As the
tester asked for, on the readable version of the file.

Sheets, in this order; a sheet with nothing to show is omitted and the
Summary says so:

1. **Summary** — who the subject is (**external contact** or **Genesys
   user**, decided by whether `contacts-service!` or `venue!` is present),
   their name and ids, export request id and timestamp (from the archive
   filename), a count per category, the categories that were present but
   empty (so "no coaching appointments" is a statement, not an omission), and
   a plain statement of what the archive does and does not contain.
2. **Subject** — external contact: the record flattened (name, each channel,
   created/modified, merge history). Genesys user: the `venue!` profile plus
   the login email, station and call-forwarding settings.
3. **Emails** — one row per email: conversation id, time, direction, from,
   to, cc, subject, the **text body** where the archive has one (the HTML
   body is not reproduced — it is the same content with markup), and the
   attachment filenames. Sources: `EmailTranscript` bundles (with bodies) and
   `postino-service` records (headers only — the row says "body not in
   export"). This and the next sheet are what a data subject would actually
   want.
4. **Messages** — one row per message: conversation id, timestamp, channel,
   direction (`purpose`), from, to, text, status. Sources: `MessageTranscript`
   bundles, the legacy chat JSON, and `REALTIME!messages` as channel
   "Internal chat". Presence and CoBrowse event rows are collapsed to one
   line each ("joined", "left", "co-browse started") rather than dropped.
5. **Calls** — one row per audio file: conversation id, recording id,
   duration (from the Ogg granule position), size, and **"empty"** for the
   27-byte placeholders, so nobody goes looking for a call that was never
   captured. Where an STA outline exists for the conversation, its headers
   are joined in as a one-cell summary. **Transcribed** and **Summarised**
   columns say whether Genesys acknowledged a `TranscriptsEvent` /
   `ConversationSummaryEvents` for that conversation — in the export with
   transcription enabled, 83 and 88 of 140 recorded conversations — with the
   note that the text itself is not in the archive. Audio is listed, not
   transcribed.
5a. **Conversations** — the index the receipts make possible. `ConversationEvent`
   names every conversation the subject took part in (211 in the user export,
   158 in the large contact export), ~25 receipts each, and their
   `eventTimestamp`s give the first and last event. One row per conversation:
   id, first event, last event, event count, then what the archive holds for
   it — recordings, transcribed, summarised, outline segments, messages,
   emails, journey session, survey, voicemail, resolution — joined by id from
   the other sheets and from the other conversation-scoped topics. This is as
   close as the export gets to conversation detail: Genesys ships no
   participant, queue, ANI/DNIS or wrap-up record. `TranscriptsEvent` ids are
   sometimes a communication inside the conversation rather than the
   conversation (96 of 179); those are counted on the Summary as
   unattributed rather than guessed at, so "transcribed" is a floor.
6. **Conversation outlines** — one row per STA segment: conversation id,
   segment header, description, start, end. The text is Genesys's AI summary
   of the conversation, and the sheet says so. Named for conversations, not
   calls: the five sample outlines turned out to sit on web-messaging
   sessions, and STA writes them for calls and messaging alike.
7. **Journey sessions** — one row per session: subject, direction, channels,
   started, ended, duration, outcome, queue, event count.
8. **Attachments** — one row per attachment or inline image found inside a
   recording bundle: which email or conversation it belongs to, filename,
   size.
9. **Performance points** — Genesys users only, when `gamification-service`
   has workdays: one row per workday per metric — date, metric id, points,
   max points, value — and the personal bests below.
10. **WEM** — Genesys users only, when any of the WEM containers has rows:
    shift trades and offers, coaching appointments, recognitions sent and
    received, activity moves, adherence explanations, time-off adjustments;
    one block each. Absent in both samples; the shapes come from the empty
    containers.
11. **Surveys** — when `quality!` entries exist; flattened question/answer
    rows.
12. **Billing** — the invoice ids, with the source's own note.
13. **Receipts** — the `analytics!` acknowledgements collapsed to **one row
    per topic** with a count. Twenty-five rows, not 36,931, and a sentence
    saying what they are.

House styling (`addStyledSheet`): blue header, alternating rows, auto-filter,
frozen row. Same as every other export.

**Files as files.** Each non-empty `.opus` and each attachment gets a
**Save** button that hands the bytes to `download.html` as base64 — the route
that is proven to work in the sandbox. No transcription; the app has no
speech-to-text and should not pretend to. A **Save all audio** button is not
offered: 225 files through 225 Save As dialogs is worse than the original
zip, which the user still has.

## 3. Consequences worth agreeing to

- **Client-side only, by design.** A large export is parsed in the browser's
  memory: the 27 MB, 37,194-file user export is the worst seen, and JSZip
  reads entries lazily so the receipts are never all in memory at once — each
  receipt is parsed for its topic name and discarded. Audio bytes are read
  only for the last Ogg page, and again only when the user presses Save on
  one file. SheetJS handles tens of thousands of rows; a cap of 100 000 rows
  per sheet with a note on the Summary sheet keeps the worst case bounded.
  The alternative, converting on the server, would push a data subject's
  entire history through the app's backend and hit the 45-second Functions
  cap on anything real.
- **It reads what Genesys wrote, no more.** If the archive holds only
  receipts, the workbook says so rather than inventing content. The
  `analytics!` files are reported as what they are. A call is a duration and
  an audio file; the outline, where there is one, is Genesys's summary and is
  labelled as such.
- **Two archive shapes, one reader.** The classification is by prefix, and
  the Summary names the subject kind. A user export that also carries
  `contacts-service!` (a user who is also a contact) gets both blocks on the
  Subject sheet.
- **The archive filename is the only source of the request id and timestamp.**
  `results-<requestId>-<ISO timestamp>.zip` is stable across all five exports
  seen; if a customer renames the file, those two Summary fields read
  "unknown".
- **Not a legal document.** The workbook is a rendering of the export, not a
  certified copy. The Summary sheet says so.

## 4. Rejected

- **Fetching the archive straight from Request Status and reading it without
  a file picker.** `api-downloads.<region>` refuses cross-origin fetch;
  confirmed 2026-09-13. The user has to download it; the reader takes it from
  there.
- **Server-side conversion.** PII through the backend, and the Functions cap.
- **PDF.** `jsPDF` is loaded, but the content is tabular and multi-sheet;
  Excel is what the rest of the app produces and what a compliance officer can
  filter. A PDF cover sheet can follow if asked.
- **A panel on Request Status.** Proposed first; declined. Request Status is
  about the org's requests, and its table is already the busiest thing on the
  page. Reading an archive starts from a file and ends in a workbook — a
  different task, and one that should not need an org selected to begin.
- **Transcribing calls in the browser.** There is no transcript in the
  archive, and the app has no speech-to-text. This was checked deliberately
  on 2026-09-14 against the export for a user whose org has transcription
  enabled: every non-audio file and every file inside every bundle was
  searched for transcript-shaped keys (`phrases`, `utterances`,
  `transcript`, `sentiment`, `topics`); the only hits are the `text` fields
  of message transcripts. The 405 `TranscriptsEvent` receipts are
  acknowledgements — topic, conversation id, timestamp, S3 prefix — and the
  1,555 smaller ones are the same shape. The outline files are the most the
  archive offers, and they are used; the receipts' conversation ids give
  the Transcribed column.
- **Reproducing the Web Messenger deployment configs.** `squonk-service!` is
  org configuration that happens to name the user as its last editor. The
  Summary lists the deployment names; the 163 KB of labels stay in the zip.

**Unknown categories are never dropped.** Every prefix in five exports is
now catalogued in §1. Anything the reader does not recognise goes on the
Summary sheet by prefix, with a count and the top-level JSON keys of one
example, so the first archive carrying something new says what it is rather
than losing it.

## 5. Open questions for the go-ahead

1. **The counterpart's details.** Message transcripts carry the other party's
   name and phone on every message; emails carry every address in `to` and
   `cc`; for a Genesys user the counterparts are customers. For an Article 15
   response that is *the subject's own* correspondence, so including it is
   correct — but the rows then contain other individuals' details.
   Recommendation: names and email addresses yes (they are the
   correspondence), phone numbers no, and say so on the Summary sheet.
2. **HTML email bodies.** `textBody` is used. Where an email has *only* an
   HTML body, the tags are stripped to text. The original HTML is not
   reproduced in the workbook; if it is ever needed, the archive still has it.
3. **Internal chat.** `REALTIME!messages` is the user's own colleague chat —
   what they wrote, with no recipient recorded. Recommendation: include it on
   the Messages sheet as channel "Internal chat"; it is the subject's data.
4. **Performance points.** An agent's gamification scores are personal data
   about them and belong in an Article 15 response. Recommendation: include
   the sheet; metric ids are shown as ids, since the archive carries no metric
   names and the reader calls no API to look them up.

Voice is settled: calls arrive as bare audio, a **Calls** sheet lists them
with duration, whether Genesys transcribed them, and the STA outline where
one exists; nothing is transcribed by the app.

Answers 1–4 agreed 2026-09-14.
