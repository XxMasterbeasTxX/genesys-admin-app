# Test form — GDPR › Subject Request and Request Status

Pages: **GDPR › Subject Request** (`/gdpr/subject-request`), **GDPR › Request Status** (`/gdpr/request-status`)
Environment: **dev**
Tester: ______________________  Date: ______________________
Build / commit: ______________________

## How to use this form

Work top to bottom. Each case says what to do and what should happen; write
**P** (pass), **F** (fail) or **N/A** in the result box and add a note when it
is not a clean pass.

**These pages write to customer data and some of it cannot be undone.** §5
(Erasure) and §6 (Rectification) submit real requests against whichever org is
selected. Use a disposable test org, or a test subject you have created for the
purpose — an Article 17 erasure is not reversible and Genesys will not put the
data back.

Cases marked **★ UNKNOWN** are not regression checks. They answer questions the
Genesys documentation does not, and nobody has been able to answer them without
a live tenant. Record the actual result even when nothing looks broken.

---

## 1. Access and permissions

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 1.1 | Log in holding `gdpr:subject:view` and `gdpr:request:add` | Both GDPR leaves appear in the sidebar | ☐ | |
| 1.2 | Log in holding `gdpr:request:view` but **not** `gdpr:subject:view` | Request Status appears; **Subject Request does not** | ☐ | |
| 1.3 | Log in holding neither | Neither leaf appears | ☐ | |
| 1.4 | With the module entitlement but no GDPR permission at all, hit `#/gdpr/subject-request` directly | Denied — not the page with a failing search | ☐ | |

> 1.2 matters because searching and submitting are separate Genesys
> permissions. The lookup returns a named individual's records across the
> tenant, so it is gated on `gdpr:subject:view` in its own right rather than on
> the permission to submit a request.

---

## 2. Step gating

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 2.1 | Load the page fresh | Steps 2–4 greyed; step 1 active | ☐ | |
| 2.2 | Press **Tab** repeatedly from the top without choosing a type | Focus never lands inside steps 2–4 | ☐ | |
| 2.3 | Choose a request type | Step 2 becomes active; Search stays disabled until an identifier is typed | ☐ | |
| 2.3a | Read the panel that appears under the type cards | "What <type> actually does" — erasure says it redacts rather than deletes; Access says ZIP archive, no recordings, undocumented contents | ☐ | |
| 2.4 | Type an identifier, then switch request type | Steps 3–4 collapse back to greyed; identifiers are kept | ☐ | |
| 2.5 | Search, then edit any identifier | Steps 3–4 grey out again and an amber line says "Identifiers changed — search again" | ☐ | |
| 2.6 | Navigate away and back **within the same org** | Identifiers are still filled | ☐ | |
| 2.7 | Switch to a **different customer org** in the header | Identifier fields are **empty** | ☐ | |
| 2.8 | Switch back to the first org | Still empty — the values are not restored | ☐ | |

> 2.6-2.8 are the balance being struck: retyping nine identifiers on every
> visit is hostile, but one individual's name, email and phone must not follow
> you into a tenant they have nothing to do with. Kept per org, dropped on
> switch.

---

## 3. Search

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 3.1 | Search on one identifier that matches a real person | Step 3 lists the matches; count in green | ☐ | |
| 3.2 | Search on two identifiers matching the same person | One row, "Matched by" naming both | ☐ | |
| 3.3 | Search on something that matches nothing | "No matching subjects found"; Proceed stays disabled | ☐ | |
| 3.4 | Search with one identifier deliberately malformed (e.g. `PHONE` = `abc`) | Amber line **naming Phone**, saying results cover the other identifiers only; matches still listed | ☐ | |
| 3.5 | Read the amber line's colour | Amber, clearly not the same as an ordinary grey progress line | ☐ | |
| 3.6 | Untick every subject | Proceed becomes disabled | ☐ | |
| 3.7 | Open Admin › Activity Log | A **GDPR Subject Search** row, with the identifier *types* searched and the match count — and **no identifier values** | ☐ | |
| 3.8 | ★ **UNKNOWN** — search something very broad (a common surname) | If Genesys reports more matches than it returns, an amber line says so. The endpoint takes no paging parameters, so record whether this ever fires: ______________________ | ☐ | |

> 3.7: the values are the subject's own personal data and are deliberately not
> logged. If you can see an email address in that row, that is a fail.

---

## 4. Confirmation step

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 4.1 | Reach step 4 for any type | The line names the **customer org** and lists every selected subject by name, type and id | ☐ | |
| 4.2 | Check the org name against the header dropdown | They match | ☐ | |
| 4.3 | Go back, untick a subject, Proceed again | The list in step 4 shrinks to match | ☐ | |
| 4.4 | Look below the subject list | The same "What <type> actually does" panel is repeated here, at the point of commitment | ☐ | |

---

## 5. Erasure (Article 17) — **destructive**

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 5.1 | Reach step 4 for Erasure | Submit is **disabled**; a confirmation tick is present | ☐ | |
| 5.2 | Tick the confirmation | Submit enables | ☐ | |
| 5.3 | Submit against a test subject | Success panel, one Request ID per subject, each with a working Copy button | ☐ | |
| 5.4 | Click **→ View Request Status** | Lands on Request Status with the new requests visible | ☐ | |
| 5.5 | Check the Activity Log | A **GDPR Request** row naming the count and the org | ☐ | |
| 5.6 | Erase a subject who has a **name but no id** (e.g. found by Name only) | Submits cleanly — no "Cannot read properties of undefined" | ☐ | |

---

## 6. Rectification (Article 16) — **destructive**

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 6.1 | Reach step 4 for Rectification | Submit is **disabled** until a replacement value is typed | ☐ | |
| 6.2 | Check the Type column | Friendly labels ("Email", "Apple Messages"), not raw enum | ☐ | |
| 6.3 | Search on Email **and** Phone, proceed, type a new value against **Email only**, submit | Genesys receives `type: EMAIL` with the old email as `existingValue` — **not** the phone number | ☐ | |
| 6.4 | Repeat 6.3 but clear the Email box in step 2 before submitting | Steps 3–4 grey out and nothing is submitted at all | ☐ | |
| 6.5 | Confirm the result in Genesys admin | The corrected field is the one you meant | ☐ | |

> 6.3 and 6.4 are the cases that matter most on this page. A rectification that
> corrects a different field from the one shown on screen is worse than one that
> fails, because nobody finds out. 6.5 is what actually proves it — the request
> body being right is necessary, not sufficient.

---

## 7. Social and external-id subjects

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 7.1 | Search by **Twitter**, **Instagram**, **Facebook** or **Apple Messages** | Matches list with the network as the Subject Type | ☐ | |
| 7.2 | Submit an erasure for one | Accepted by Genesys — the handle is carried in the request | ☐ | |
| 7.3 | Search by **External ID** and submit | Accepted | ☐ | |
| 7.4 | ★ **UNKNOWN** — does the Subjects API ever return `journeyCustomer`? | Record what came back, and whether the row rendered sensibly | ☐ | |
| 7.5 | Search by **WhatsApp** | Offered in the form and accepted by Genesys | ☐ | |

---

## 8. Request Status

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 8.1 | Open the page with an org selected | It loads by itself — no need to press Load / Refresh first | ☐ | |
| 8.2 | Open it with **no** org selected | "Please select a customer org first" | ☐ | |
| 8.3 | Use an org with **more than 100** GDPR requests | All of them are listed; the footer count matches | ☐ | |
| 8.4 | Read the Status column | English — Initiated, Searching…, Updating…, Deleting…, Finalizing…, Completed, Error. No raw `IN_PROGRESS`-style text | ☐ | |
| 8.5 | Find a request with no subject name | The id is shown in mono, truncated, on **one** line — not bold body text over two | ☐ | |
| 8.6 | Check the Submitted by column | Names the person who raised the request | ☐ | |
| 8.7 | Filter by type, then by status, then reset | Counts update; footer says how many are hidden | ☐ | |
| 8.8 | Switch org in the header | The table reloads for the new org — no rows from the previous one | ☐ | |
| 8.9 | Find a completed Rectification | Details reads "N fields updated: EMAIL, PHONE" | ☐ | |

---

## 9. Article 15 export download

The important section. This flow has never run in production, so treat every
row here as a first run rather than a regression check.

What the investigation established, so you know what "correct" looks like:
the export is a **ZIP archive** on storage Genesys signs itself (there is no
`/results` endpoint under `/api/v2/gdpr` anywhere in the OpenAPI spec, and
`resultsUrls` is documented as "the locations ... if multiple archive files
created"). The app therefore opens the signed URL in a new tab and lets the
browser save it. It deliberately does **not** route it through
`/api/genesys-proxy`, which reads every response as text and would silently
corrupt a zip.

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 9.1 | Submit an Access request and wait for Genesys to complete it (1–2 business days) | Status reaches **Completed** and a **Download** link appears | ☐ | |
| 9.2 | ★ **UNKNOWN** — inspect `resultsUrl` on the completed request (dev tools, network tab) | Record the host and whether it carries a signature in the query string: ______________________ | ☐ | |
| 9.3 | Click **Download** | A new tab opens and the browser downloads a **.zip** | ☐ | |
| 9.4 | Open the archive | Real export content. Record the top-level folder names: ______________________ | ☐ | |
| 9.5 | ★ **UNKNOWN** — look for call recordings in the archive | Expected **absent** — recordings are excluded from Access but in scope for Erasure. Confirm: ______________________ | ☐ | |
| 9.6 | **Run 9.3 with the app embedded in the Genesys Cloud iframe**, not standalone | The new tab opens and the download completes | ☐ | |
| 9.7 | Submit an Access request for a subject with a lot of history | Record whether Genesys returns **several** archives (`resultsUrls`), and that each gets its own numbered link: ______________________ | ☐ | |
| 9.8 | ★ **UNKNOWN** — leave a completed export for a week, then click Download | Record what happens when a signed link ages: ______________________ | ☐ | |
| 9.9 | Block pop-ups, then click Download | An inline error naming the pop-up blocker — not a silent no-op | ☐ | |
| 9.10 | Check the Activity Log after 9.3 | A **GDPR Export Download** row naming the request id | ☐ | |

> **9.6 is the one that cannot be skipped.** The original code used a direct
> blob download, which works standalone and is silently inert inside the
> iframe — that is the entire bug, and testing outside the iframe proves
> nothing about it. `window.open` is the mechanism the Excel exports already
> use in production, so this is expected to pass; confirm it anyway.
>
> **9.8 has no code behind it.** Once the tab is open, the exchange is between
> the browser and Genesys — the app cannot see a 403 from signed storage, so
> an expired link shows Genesys's own error page rather than anything from us.
> The page says as much when you click. If expiry turns out to be short enough
> to bite in practice, that is worth knowing here.

---

## 10. Error handling

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 10.1 | Search with no org selected | "Please select a customer org from the header dropdown" | ☐ | |
| 10.2 | Force a search failure (revoke the permission mid-session, or use a bad org) | Red line with the Genesys message — not a raw JS TypeError | ☐ | |
| 10.3 | Submit with several subjects where one will fail | "N submitted, M failed: <reason>"; Submit re-enables | ☐ | |
| 10.4 | Check the Activity Log after 10.3 | A **GDPR Request** row marked **partial** | ☐ | |
| 10.5 | Make the Request Status load fail | Error paragraph in the panel, page still usable | ☐ | |
| 10.6 | Confirm no `alert()` boxes appear anywhere in either page | All messages are inline status lines | ☐ | |

---

## 11. Appearance

| # | Do this | Expect | Result | Notes |
|---|---|---|---|---|
| 11.1 | View both pages in **dark** mode | Badges, status pills and links all legible | ☐ | |
| 11.2 | View both pages in **light** mode | Same — statuses and the Download link are not washed-out pale on white | ☐ | |
| 11.3 | Read the greyed step headings | Legible as text, just clearly inactive | ☐ | |
| 11.4 | Narrow the window to ~900px | Tables scroll horizontally inside their own box; the page does not | ☐ | |
| 11.5 | Find a row with a long status | Status pill stays on one line | ☐ | |

---

## Sign-off

Blocking failures: ______________________

Open ★ UNKNOWN answers to carry back into the design: ______________________
