# Test plan — GDPR › Subject Request and Request Status

**Pages:** GDPR › Subject Request (`/gdpr/subject-request`), GDPR › Request Status (`/gdpr/request-status`)
**Released in:** 5.4
**Environment:** ☐ dev ☐ prod
**Tester:** `______________________`  **Date:** `______________________`
**Build / commit:** `______________________`

---

## How to use this plan

Tick the boxes as you go — `- [ ]` becomes `- [x]`. This file lives in the
repo, so progress is saved with everything else: it survives a reboot, a
browser crash or a machine swap, and committing it makes the completed run
part of the history.

- **Fail a case?** Leave the box unticked and write what happened on the
  _Notes_ line under it. An unticked box with no note reads as "not run yet",
  which is a different thing.
- **★ marks an open question**, not a regression check. Nobody has been able to
  answer these without a live tenant, and the answers change what we build
  next. Fill in the _Answer_ line even when nothing looks broken.
- Sections are independent. §9 needs a real Access request that Genesys has
  finished processing, so start §9.1 early and come back to it.

> ### ⚠ This plan writes to real customer data
>
> §5 (Erasure) and §6 (Rectification) submit genuine GDPR requests against
> whichever org is selected in the header. **Article 17 erasure cannot be
> undone and Genesys will not restore the data.** Use a disposable test org, or
> a test subject you created for the purpose.
>
> Do not run erasure against an active agent or admin — Genesys needs an
> employee's personal data to function, and redacting a working user can break
> their account.

---

## 1. Access and permissions

Searching and submitting are separate Genesys permissions. The subject lookup
returns a named individual's records across the whole tenant, so it is gated on
`gdpr:subject:view` in its own right, not on the permission to submit.

- [ ] **1.1** — Log in holding `gdpr:subject:view` and `gdpr:request:add`
  - Expect: both GDPR leaves appear in the sidebar
  - Notes: `______________________`
- [ ] **1.2** — Log in holding `gdpr:request:view` but **not** `gdpr:subject:view`
  - Expect: Subject Request appears **greyed out**, with a tooltip naming `gdpr:subject:view`. Request Status is usable.
  - Notes: `______________________`
- [ ] **1.3** — Log in holding neither permission
  - Expect: both leaves appear **greyed out** with tooltips
  - Notes: `______________________`
  - The leaf greys rather than disappearing because the app *group* still grants the GDPR module — that is the `denied-no-permission` state. A leaf only vanishes when the group or entitlement does not grant the module at all, which is what 1.3a checks.
- [ ] **1.3a** — Log in as a group with no `gdpr.*` entitlement
  - Expect: the GDPR folder is **absent** from the sidebar entirely
  - Notes: `______________________`
- [ ] **1.4** — With the module entitlement but no GDPR permission, open `#/gdpr/subject-request` directly
  - Expect: denied — not the page with a failing search behind it
  - Notes: `______________________`

---

## 2. Step gating and identifier handling

- [ ] **2.1** — Load Subject Request fresh
  - Expect: steps 2–4 greyed out; step 1 active
  - Notes: `______________________`
- [ ] **2.2** — Press **Tab** repeatedly from the top without choosing a type
  - Expect: focus never lands inside steps 2–4 (they are `inert`, not merely faded)
  - Notes: `______________________`
- [ ] **2.3** — Choose a request type
  - Expect: step 2 becomes active; **Search stays disabled** until an identifier is typed
  - Notes: `______________________`
- [ ] **2.4** — Read the panel that appears under the type cards
  - Expect: "What *&lt;type&gt;* actually does" — Erasure says it redacts rather than deletes; Access says ZIP archive, no recordings, undocumented contents
  - Notes: `______________________`
- [ ] **2.5** — Type an identifier, then switch to a different request type
  - Expect: steps 3–4 collapse back to greyed; the identifiers you typed are kept
  - Notes: `______________________`
- [ ] **2.6** — Search, then edit any identifier afterwards
  - Expect: steps 3–4 grey out again and an amber line says "Identifiers changed — search again"
  - Notes: `______________________`
- [ ] **2.7** — Confirm all ten identifier fields are present
  - Expect: Name, Email, Phone, Address, External ID, Twitter, Instagram, Facebook, Apple Messages, **WhatsApp**
  - Notes: `______________________`
- [ ] **2.8** — Navigate away and back **within the same org**
  - Expect: identifiers are still filled (retyping ten fields per visit is the thing being avoided)
  - Notes: `______________________`
- [ ] **2.9** — Switch to a **different customer org** in the header
  - Expect: identifier fields are **empty** — one individual's data must not follow you into another tenant
  - Notes: `______________________`
- [ ] **2.10** — Switch back to the first org
  - Expect: still empty; the previous values are not restored
  - Notes: `______________________`

---

## 3. Subject search

- [ ] **3.1** — Search on one identifier that matches a real person
  - Expect: step 3 lists the matches; the count line is green
  - Notes: `______________________`
- [ ] **3.2** — Search on two identifiers that match the same person
  - Expect: **one** row, with "Matched by" naming both identifiers
  - Notes: `______________________`
- [ ] **3.3** — Search for something that matches nothing
  - Expect: "No matching subjects found"; Proceed stays disabled
  - Notes: `______________________`
- [ ] **3.4** — Search with one identifier deliberately malformed (e.g. Phone = `abc`)
  - Expect: **"No matching subjects found"** — Genesys treats an unparseable value as a miss, not an error, so this does *not* trigger the partial-failure warning
  - Notes: `______________________`
- [ ] **3.5 ★** — Induce a genuine per-identifier failure and watch for the amber partial-result line
  - The warning fires when one identifier's search returns an HTTP error while others succeed. A malformed value will not do it (3.4). Rate limiting (429) under a burst of identifiers is the most likely real cause.
  - Answer — did you ever see it fire, and what caused it? `______________________`
  - This path is verified in a stubbed harness but has never been observed against a live tenant. If it turns out to be unreachable in practice, say so and it can be simplified away.
- [ ] **3.6** — Untick every subject in step 3
  - Expect: Proceed becomes disabled
  - Notes: `______________________`
- [ ] **3.7** — Open Admin › Activity Log after a search
  - Expect: a **GDPR Subject Search** row listing the identifier *types* searched and the match count, and **no identifier values**
  - Notes: `______________________`
  - ⚠ If you can see an email address or phone number in that row, that is a **fail**. The values are the data subject's own personal data and are deliberately not logged.
- [ ] **3.8 ★** — Search something very broad (a common surname)
  - Expect: if Genesys reports more matches than it returns, an amber line says so. The endpoint takes no paging parameters, so there is no second page to fetch.
  - Answer — does this ever fire, and at what count? `______________________`

---

## 4. Confirmation step

- [ ] **4.1** — Reach step 4 for any request type
  - Expect: the summary names the **customer org** and lists every selected subject by name, type and id
  - Notes: `______________________`
- [ ] **4.2** — Check that org name against the header dropdown
  - Expect: they match
  - Notes: `______________________`
- [ ] **4.3** — Go back, untick a subject, Proceed again
  - Expect: the list in step 4 shrinks to match
  - Notes: `______________________`
- [ ] **4.4** — Look below the subject list
  - Expect: the same "What *&lt;type&gt;* actually does" panel is repeated here, at the point of commitment
  - Notes: `______________________`

---

## 5. Erasure — Article 17 ⚠ destructive

What Genesys actually does: **redacts personal data, does not delete history.**
Conversations and interaction records survive; names, phone numbers,
participant data and recording content are removed or anonymised. Call
recordings *are* in scope here, unlike the Access export. Takes up to 14 days,
and redaction has been reported to land days after the status reads Completed.

- [ ] **5.1** — Reach step 4 for Erasure
  - Expect: Submit is **disabled**; a consent tick is present
  - Notes: `______________________`
- [ ] **5.2** — Tick the confirmation
  - Expect: Submit enables
  - Notes: `______________________`
- [ ] **5.3** — Submit against a test subject
  - Expect: success panel, one Request ID per subject, each with a working Copy button
  - Notes: `______________________`
- [ ] **5.4** — Click **→ View Request Status**
  - Expect: lands on Request Status with the new requests visible
  - Notes: `______________________`
- [ ] **5.5** — Check the Activity Log
  - Expect: a **GDPR Request** row naming the count and the org
  - Notes: `______________________`
- [ ] **5.6** — Erase a subject who has a **name but no id** (found by Name only)
  - Expect: submits cleanly — no "Cannot read properties of undefined"
  - Notes: `______________________`
- [ ] **5.7 ★** — Once the request reads Completed, check the subject's conversations in Genesys
  - Expect: interaction records still present, PII redacted
  - Answer — how long after Completed did redaction actually land? `______________________`

---

## 6. Rectification — Article 16 ⚠ destructive

**6.3 and 6.4 are the most important cases in this plan.** A rectification that
corrects a different field from the one shown on screen is worse than one that
fails outright, because nobody finds out.

- [ ] **6.1** — Reach step 4 for Rectification
  - Expect: Submit is **disabled** until at least one replacement value is typed
  - Notes: `______________________`
- [ ] **6.2** — Check the Type column in the replacement table
  - Expect: friendly labels ("Email", "Apple Messages"), not raw enum text
  - Notes: `______________________`
- [ ] **6.3** — Search on Email **and** Phone, proceed, type a new value against **Email only**, submit
  - Expect: Genesys receives `type: EMAIL` with the old email as `existingValue` — **not** the phone number
  - Notes: `______________________`
- [ ] **6.4** — Repeat 6.3, but clear the Email box in step 2 before submitting
  - Expect: steps 3–4 grey out and **nothing is submitted at all**
  - Notes: `______________________`
- [ ] **6.5** — Confirm the result in Genesys admin, **after the request reads Completed**
  - Expect: the corrected field is the one you meant
  - Notes: `______________________`
  - ⚠ This is the case that actually proves 6.3. The request body being right is necessary, not sufficient.
  - **Seeing the old value is expected at first.** Rectification is asynchronous: the request moves INITIATED → SEARCHING → UPDATING → COMPLETED, and records have been reported to catch up for some time after that. Check Request Status first; only treat an unchanged value as a failure once the request has read Completed for a while.

---

## 7. Social handle and external-id subjects

- [ ] **7.1** — Search by **Twitter**, **Instagram**, **Facebook** or **Apple Messages**
  - Expect: matches list with the network as the Subject Type
  - Notes: `______________________`
- [ ] **7.2** — Submit an erasure for one of them
  - Expect: accepted by Genesys — the handle is carried in the request body
  - Notes: `______________________`
- [ ] **7.3** — Search by **External ID** and submit
  - Expect: accepted
  - Notes: `______________________`
- [ ] **7.4** — Search by **WhatsApp**
  - Expect: offered in the form and accepted by Genesys
  - Notes: `______________________`
- [ ] **7.5 ★** — Does the Subjects API ever return a `journeyCustomer` subject?
  - Expect: if it does, the row renders sensibly rather than as "Unknown"
  - Answer: `______________________`

---

## 8. Request Status

- [ ] **8.1** — Open the page with an org selected
  - Expect: it loads by itself — no need to press Load / Refresh first
  - Notes: `______________________`
- [ ] **8.2** — Open it with **no** org selected
  - Expect: "Please select a customer org first"
  - Notes: `______________________`
- [ ] **8.3** — Use an org with **more than 100** GDPR requests
  - Expect: all of them list; the footer count matches
  - Notes: `______________________`
- [ ] **8.4** — Read the Status column
  - Expect: English — Initiated, Searching…, Updating…, Deleting…, Finalizing…, Completed, Error. No raw `IN_PROGRESS`-style shouting
  - Notes: `______________________`
- [ ] **8.5** — Look at the Subject column
  - Expect: a person's **name**. Genesys often omits `subject.name` on the listing, so the page resolves the subject's user or external-contact id to a name; only a dialer contact, or an id Genesys will not return, falls back to a truncated mono id on one line.
  - Notes: `______________________`
- [ ] **8.6** — Submit a request, then check the Submitted by column for it
  - Expect: **your own name**, with a small `·app` marker. Hover it: the tooltip names your email and says the app recorded it.
  - Notes: `______________________`
  - The app authenticates with the org's OAuth client credentials, so Genesys attributes its requests to the integration, not a person. Since 5.4 the submit path writes the Genesys request ids into the Activity Log entry, and this page reads them back.
- [ ] **8.6a** — Check Submitted by on a request submitted **before 5.4** (any of the nine in Demo)
  - Expect: **“API client”**, italic. Not retroactive by design — those entries were logged without their request ids.
  - Notes: `______________________`
- [ ] **8.6b** — If you can, raise a GDPR request **directly in Genesys admin**, then reload this page
  - Expect: the Genesys user's **name**, plain, with no `·app` marker — that one Genesys can attribute itself
  - Notes: `______________________`
- [ ] **8.6c** — Submit a request while signed in as a **different** app user, then compare rows
  - Expect: each row names whoever actually submitted it, not whoever is looking
  - Notes: `______________________`
- [ ] **8.12** — Find a request whose subject is a user who has since been deactivated or deleted
  - Expect: their **name** still shows. The users lookup asks for `state=any`; the endpoint defaults to `active` and would otherwise drop them silently, leaving a GUID.
  - Notes: `______________________`
- [ ] **8.11** — Load an org with a good number of requests and watch DevTools → Network
  - Expect: **one** `/api/v2/users` call for the whole table, however many rows share a submitter — not one call per row
  - Notes: `______________________`
- [ ] **8.7** — Filter by type, then by status, then reset
  - Expect: counts update; the footer says how many are hidden
  - Notes: `______________________`
- [ ] **8.8** — Switch org in the header
  - Expect: the table reloads for the new org — no rows carried over
  - Notes: `______________________`
- [ ] **8.9** — Find a completed Rectification
  - Expect: Details reads **“Requested: EMAIL, PHONE”** — the terms the request carried, not a claim about what changed. Genesys never reports which records it rewrote.
  - Notes: `______________________`
- [ ] **8.9a ★** — For a Completed rectification, check a **conversation** the subject took part in, not their user profile
  - Expect: unknown. If the conversation shows the new value the rectification worked; if it shows the old one, `existingValue` did not match what Genesys held and nothing was replaced — which still completes.
  - Answer — which was it? `______________________`
- [ ] **8.10** — Read the "Reading this page" panel at the top
  - Expect: explains that Completed ≠ fully caught up, and that Access downloads are ZIP archives without recordings
  - Notes: `______________________`

---

## 9. Article 15 export download

**The section that matters most.** This flow has never run in production, so
treat every line as a first run rather than a regression check.

What "correct" looks like, established on 2026-09-12 from a live click: the
export is a **ZIP archive**, and `resultsUrl` is **not** a link to it. It is
`https://apps.mypurecloud.de/platform/api/v2/downloads/<id>` — a Genesys API
endpoint that "issues a redirect to a signed secure download URL" and needs a
bearer token. Opened bare it renders a blank tab, which is what the first
release did.

The app now does it in two steps: it calls that endpoint through the proxy
with `issueRedirect=false`, which returns the signed URL as JSON rather than a
302, then points a new tab at the signed URL so the browser downloads the
archive. The proxy never touches the zip — it would read it as text and
corrupt it — and the tab is opened *before* the network call so pop-up
blockers do not refuse it.

- [ ] **9.1** — Submit an Access request and wait for Genesys to complete it (1–2 business days)
  - Expect: status reaches **Completed** and a **Download** link appears
  - Notes: `______________________`
- [ ] **9.2** — Inspect `resultsUrl` on the completed request (dev tools → Network)
  - Expect: `…/api/v2/downloads/<id>` on the apps host — an API endpoint, not signed storage. Confirmed 2026-09-12.
  - Notes: `______________________`
- [ ] **9.3** — Left-click **Download**
  - Expect: a new tab opens and the browser saves a **.zip** (to the default folder, or via a Save As prompt if the browser is set to ask). **Requires `allow-downloads` in the Client Application's Iframe Sandbox Options** — see customer-onboarding.md Step 6.
  - Notes: `______________________`
  - Root cause, settled 2026-09-13: the app runs in a sandboxed Genesys iframe and every tab it opens inherits the sandbox, which forbids browser downloads. Not a code problem — four different click shapes all failed identically until the flag was added. Fetching the bytes into `download.html` for a Save As dialog was tried and refused (`api-downloads.<region>` does not allow cross-origin fetch), so that route is closed.
- [ ] **9.3a** — Watch DevTools → Network while the page **loads**
  - Expect: one `genesys-proxy` call per completed export targeting `/api/v2/downloads/<id>` with `issueRedirect=false`, each returning a small JSON `{ url }`. Nothing at click time — the click is a plain navigation the browser handles.
  - Notes: `______________________`
- [ ] **9.3b** — Leave the page open a long while, then click Download
  - Expect: either it still works, or the new tab shows Genesys's own error for a stale signed link. Press **Load / Refresh** and click again — fresh links are minted on every load.
  - Answer — how long did the link stay good? `______________________`
- [ ] **9.3c** — On an install **without** `allow-downloads`, left-click Download
  - Expect: a blank tab. Right-click → "Open link in new tab" still downloads. This is the symptom that means the sandbox flag is missing.
  - Notes: `______________________`
- [ ] **9.4** — Open the archive
  - Expect: **flat files, no folders**, named `service!identifier` — `analytics!<uuid>` (one per conversation, JSON with no extension), `recording!Recording_Conv_…_Rec_….opus`, `contacts-service!externalContact-*.json`, `quality!Survey_Conv_….json`, `billing-service!<uuid>`. Confirmed 2026-09-13 from a real export: 2,002 files.
  - Notes: `______________________`
- [ ] **9.5** — Look for call recordings inside the archive
  - Expect: **present**, as `.opus` audio under the `recording!` prefix. An earlier version of this plan said absent — that was wrong, and came from documentation for a different Genesys product.
  - Notes: `______________________`
- [ ] **9.6** — **Run 9.3 with the app embedded in the Genesys Cloud iframe**, not standalone
  - Expect: the new tab opens and the download completes
  - Notes: `______________________`
  - ⚠ **Cannot be skipped.** The original code used a direct blob download, which works standalone and is silently inert inside the iframe — that is the entire bug. Testing outside the iframe proves nothing about it. `window.open` is the mechanism the Excel exports already use in production, so this is expected to pass; confirm it anyway.
- [ ] **9.7** — Submit an Access request for a subject with a lot of history
  - Expect: if Genesys returns several archives (`resultsUrls`), each gets its own numbered link — Download (1), Download (2)
  - Answer — how many archives? `______________________`
- [ ] **9.8 ★** — Come back days later and press Load / Refresh
  - Expect: if Genesys has dropped the export, resolving returns 404 and the link renders as **Expired** (hover for the reason) — submit a new Access request.
  - Answer — how long after completion did Genesys stop serving it? `______________________`
- [ ] **9.9** — Block pop-ups in the browser, then click Download
  - Expect: an inline error naming the pop-up blocker — not a silent no-op
  - Notes: `______________________`
- [ ] **9.10** — Check the Activity Log after 9.3
  - Expect: a **GDPR Export Download** row naming the request id
  - Notes: `______________________`
- [ ] **9.11 ★** — Judgement call, having seen a real archive
  - 2,002 flat files, most of them extensionless JSON named by conversation id, plus raw .opus audio. Is that something the business can hand to a data subject, or does it need a report built from it?
  - Answer: `______________________`

---

## 10. Error handling

- [ ] **10.1** — Search with no org selected
  - Expect: "Please select a customer org from the header dropdown"
  - Notes: `______________________`
> **How to make these fail without touching customer data.** Every Genesys call
> in this app goes through one endpoint, so you can break them all from the
> browser rather than by misusing the API:
>
> 1. Open DevTools → **Network**.
> 2. Trigger any action so a request to **`/api/genesys-proxy`** appears.
> 3. Right-click it → **Block request URL**.
> 4. Re-run the action. Every proxied call now fails.
>
> Un-tick the entry in DevTools → Network → Request blocking when you are done.
> Nothing reaches Genesys while a request is blocked, so this is safe on any org.

- [ ] **10.2** — Block `/api/genesys-proxy` (recipe above), then run a subject search
  - Expect: a red line carrying an error message — not a raw JS TypeError, and not a silent nothing
  - Notes: `______________________`
- [ ] **10.3** — With several subjects selected, block the proxy and then submit
  - Expect: "N submitted, M failed: &lt;reason&gt;"; Submit re-enables so you can retry
  - Notes: `______________________`
  - Blocking *after* the page has loaded but *before* you press Submit is what produces a genuine partial: some requests land, later ones do not.
- [ ] **10.4** — Check the Activity Log after 10.3
  - Expect: a **GDPR Request** row marked **partial** (or **failure** if none landed)
  - Notes: `______________________`
- [ ] **10.5** — Block the proxy, then press Load / Refresh on Request Status
  - Expect: an error paragraph in the panel; the page stays usable and the button re-enables
  - Notes: `______________________`
- [ ] **10.6** — Watch for `alert()` boxes anywhere in either page
  - Expect: none — every message is an inline status line
  - Notes: `______________________`

---

## 11. Appearance and accessibility

- [ ] **11.1** — View both pages in **dark** mode
  - Expect: badges, status pills and links all legible
  - Notes: `______________________`
- [ ] **11.2** — View both pages in **light** mode
  - Expect: statuses and the Download link are readable, not washed-out pale on white
  - Notes: `______________________`
- [ ] **11.3** — Read the greyed-out step headings
  - Expect: legible as text, just clearly inactive
  - Notes: `______________________`
- [ ] **11.4** — Narrow the window to roughly 900px
  - Expect: tables scroll horizontally inside their own box; the page itself does not
  - Notes: `______________________`
- [ ] **11.5** — Find a row with a long status
  - Expect: the status pill stays on one line
  - Notes: `______________________`

---

## Sign-off

**Sections completed:** ☐ 1 ☐ 2 ☐ 3 ☐ 4 ☐ 5 ☐ 6 ☐ 7 ☐ 8 ☐ 9 ☐ 10 ☐ 11

**Blocking failures** — must fix before this goes to customers:

```
______________________________________________________________
______________________________________________________________
______________________________________________________________
```

**Non-blocking issues** — worth a follow-up:

```
______________________________________________________________
______________________________________________________________
______________________________________________________________
```

**★ answers to carry back into the design:**

```
______________________________________________________________
______________________________________________________________
______________________________________________________________
```

- [ ] Ready for customer use
- [ ] Needs another pass — see blocking failures above

**Signed:** `______________________`  **Date:** `______________________`
