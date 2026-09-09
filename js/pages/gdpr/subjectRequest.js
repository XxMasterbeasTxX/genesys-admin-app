/**
 * GDPR — Subject Request
 *
 * Handles all three GDPR data subject request types for a selected customer org:
 *   • GDPR_DELETE  — Article 17 (Right to Erasure / Right to be Forgotten)
 *   • GDPR_EXPORT  — Article 15 (Right of Access / Data Portability)
 *   • GDPR_UPDATE  — Article 16 (Right to Rectification)
 *
 * Flow:
 *   Step 1. Choose request type
 *   Step 2. Enter subject identifiers (name, email, phone)
 *   Step 3. Review matching subjects returned by the GDPR Subjects API
 *   Step 4. Confirm replacement values (Update only) + submit
 *   History. View previously submitted GDPR requests for the org
 */
import * as gc from "../../services/genesysApi.js";
import { escapeHtml, makeStatus } from "../../utils.js";
import { logAction } from "../../services/activityLogService.js";

// ── Request type definitions ──────────────────────────────────────────
//
// `expect` is what Genesys actually does, as distinct from what the article
// entitles the individual to. The two are not the same, and the gap is not
// small: an erasure request does not erase. Sources, since Genesys does not
// document most of this in one place:
//
//   • Erasure redacts PII and leaves the interaction record standing —
//     "GDPR requests redact PII. You cannot erase history." (Genesys staff,
//     community.genesys.com/discussion/will-gdpr-delete-api-delete-full-interaction-data),
//     where users also report redaction landing days after the status reads
//     COMPLETED.
//   • Access returns a ZIP archive whose contents Genesys has repeatedly
//     declined to document (community.genesys.com/discussion/use-of-gdpr-apis,
//     open from 2023 to 2025), and which excludes call recordings even though
//     erasure covers them.
//   • Timeframes are from help.genesys.cloud/articles/genesys-cloud-and-gdpr-compliance.
//
// This is the page where someone acts on a legal obligation on a real
// person's behalf. Leaving them to discover the gap afterwards is the one
// outcome worth engineering against.
const REQUEST_TYPES = {
  GDPR_DELETE: {
    label:        "Erasure",
    article:      "Article 17",
    articleLabel: "Right to Erasure",
    articleUrl:   "https://gdpr-info.eu/art-17-gdpr/",
    description:  "Redact or anonymise the personal data Genesys Cloud holds on this individual.",
    badgeClass:   "gdpr-badge--delete",
    expect: [
      "Genesys <strong>redacts personal data — it does not delete history</strong>. Conversations, "
        + "interaction records and their metrics survive; the name, phone number, participant data "
        + "and recording content attached to them are removed or anonymised.",
      "Call recordings <strong>are</strong> in scope, unlike the Access export.",
      "Takes <strong>up to 14 days</strong>. Redaction has been reported to land days after the "
        + "status here reads Completed, so treat Completed as “Genesys accepted it”, not “it is done”.",
      "Irreversible. There is no undo, and Genesys will not restore the data.",
    ],
    expectWarn:   "Do not run this against an active agent or admin. Genesys needs an employee's "
                + "personal data to function, and redacting a working user can break their account.",
    confirmRequired: true,
    confirmText:  "I confirm this is a valid erasure (right to be forgotten) request and I consent to the deletion proceeding.",
    submitLabel:  "Submit Erasure Request(s)",
    note:         null,
    needsReplacement: false,
  },
  GDPR_EXPORT: {
    label:        "Access",
    article:      "Article 15",
    articleLabel: "Right of Access",
    articleUrl:   "https://gdpr-info.eu/art-15-gdpr/",
    description:  "Compile a copy of the personal data Genesys Cloud holds on this individual.",
    badgeClass:   "gdpr-badge--export",
    expect: [
      "You get a <strong>ZIP archive</strong>, downloadable from Request Status once the request "
        + "reads Completed — usually <strong>1–2 business days</strong>. Large exports may arrive as "
        + "several archives.",
      "Inside are raw platform exports — reported to include analytics, billing and journey session "
        + "data, as HTML and CSV. <strong>Genesys does not document the contents</strong>, and it is "
        + "not a document you can hand to the data subject as-is. Expect to interpret it yourself.",
      "<strong>Call recordings are not included</strong>, even though erasure covers them.",
      "Nothing is changed. This request only reads.",
    ],
    expectWarn:   null,
    confirmRequired: false,
    submitLabel:  "Submit Access Request(s)",
    note:         null,
    needsReplacement: false,
  },
  GDPR_UPDATE: {
    label:        "Rectification",
    article:      "Article 16",
    articleLabel: "Right to Rectification",
    articleUrl:   "https://gdpr-info.eu/art-16-gdpr/",
    description:  "Replace inaccurate personal data (e.g. an old name or phone number) across records.",
    badgeClass:   "gdpr-badge--update",
    expect: [
      "Genesys finds the <strong>old value</strong> you searched with and writes the <strong>new "
        + "value</strong> over it wherever it appears.",
      "It corrects the identifiers themselves — name, address, phone, email, external ID and social "
        + "handles. It does not rewrite free text, notes or recording content that happens to mention "
        + "the old value.",
      "Every selected subject gets the same replacements, so only tick subjects the correction "
        + "genuinely applies to.",
      "Irreversible in the same way as erasure: the old value is gone, not archived.",
    ],
    expectWarn:   null,
    confirmRequired: false,
    submitLabel:  "Submit Rectification Request(s)",
    note:         null,
    needsReplacement: true,
  },
};

const SEARCH_TYPES = [
  { value: "NAME",           label: "Name"           },
  { value: "EMAIL",          label: "Email"          },
  { value: "PHONE",          label: "Phone"          },
  { value: "ADDRESS",        label: "Address"        },
  { value: "EXTERNAL_ID",    label: "External ID"    },
  { value: "TWITTER",        label: "Twitter"        },
  { value: "INSTAGRAM",      label: "Instagram"      },
  { value: "FACEBOOK",       label: "Facebook"       },
  { value: "APPLE_MESSAGES", label: "Apple Messages" },
  // WHATSAPP is in the spec's searchType and ReplacementTerm enums and was
  // simply missing here, so WhatsApp identifiers could not be searched at all.
  { value: "WHATSAPP",       label: "WhatsApp"       },
];

// ── Persist identifier values across re-renders, WITHIN one org ───────
//
// Re-renders are frequent (any nav back to the page), and retyping nine
// identifiers each time is its own kind of hostile. But `app.js` re-renders the
// router on org change too, so a single shared object carried one data
// subject's name, email and phone into the next customer's tenant — pre-filled
// and ready to search. The values are that person's own personal data; they do
// not belong to the org you switched to. Keyed by org id, and the previous
// org's entry is dropped rather than kept around.
let _savedOrgId = null;
let _savedValues = {};

function savedValuesFor(orgId) {
  if (orgId !== _savedOrgId) {
    _savedOrgId = orgId;
    _savedValues = {};
  }
  return _savedValues;
}

// ── Page renderer ─────────────────────────────────────────────────────
export default function renderSubjectRequest({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h2>GDPR — Subject Request</h2>
    <p class="page-desc">
      Submit a GDPR data subject request on behalf of an individual for the selected customer org.
      Enter all known identifiers, review who will be affected, then confirm and submit.
      Processing is asynchronous — Genesys handles the request in the background (up to 14 days for deletions).
    </p>

    <!-- ── Step 1: Request type ─────────────────────────────── -->
    <div class="gdpr-section" id="gdprStep1">
      <h3 class="gdpr-step-title"><span class="gdpr-step-num">1</span>Choose Request Type</h3>
      <div class="gdpr-type-grid" id="gdprTypeGrid">
        ${Object.entries(REQUEST_TYPES).map(([key, t]) => `
          <label class="gdpr-type-card" data-type="${key}">
            <input type="radio" name="gdprRequestType" value="${key}" class="gdpr-type-radio" />
            <div class="gdpr-type-card-inner">
              <div class="gdpr-type-card-top">
                <span class="gdpr-type-label">${t.label}</span>
                <a class="gdpr-article-link" href="${t.articleUrl}" target="_blank" rel="noopener noreferrer"
                   onclick="event.stopPropagation()">
                  ${t.article} — ${t.articleLabel} ↗
                </a>
              </div>
              <p class="gdpr-type-desc">${t.description}</p>
            </div>
          </label>
        `).join("")}
      </div>
      <div id="gdprTypeHelp"></div>
    </div>

    <!-- ── Step 2: Identifiers ───────────────────────────────── -->
    <div class="gdpr-section gdpr-section--locked" id="gdprStep2">
      <h3 class="gdpr-step-title"><span class="gdpr-step-num">2</span>Enter Subject Identifiers</h3>
      <p class="gdpr-step-desc">
        Fill in any identifiers you know for this individual. Genesys will search using all
        non-empty values — more identifiers means a more thorough search.
      </p>
      <div class="gdpr-id-grid" id="gdprIdentifierGrid">
        ${SEARCH_TYPES.map(t => `
          <div class="gdpr-id-field">
            <label class="gdpr-id-label">${t.label}</label>
            <input class="gdpr-id-input" data-type="${t.value}" type="text" placeholder="${t.label}\u2026" />
          </div>
        `).join("")}
      </div>
      <div class="te-actions" style="margin-top:14px">
        <button class="btn te-btn-export" id="gdprSearchBtn" disabled>Search Subjects</button>
      </div>
    </div>

    <!-- ── Progress / Status ─────────────────────────────────── -->
    <div id="gdprProgressWrap" hidden>
      <div class="te-progress-wrap">
        <div class="te-progress-bar" id="gdprProgressBar" style="width:0%"></div>
      </div>
    </div>
    <div class="te-status" id="gdprStatus"></div>

    <!-- ── Step 3: Review subjects ───────────────────────────── -->
    <div class="gdpr-section gdpr-section--locked" id="gdprStep3">
      <h3 class="gdpr-step-title"><span class="gdpr-step-num">3</span>Review Matching Subjects</h3>
      <p class="gdpr-step-desc">
        Uncheck any subjects that do <strong>not</strong> correspond to the requesting individual
        before proceeding.
      </p>
      <div id="gdprSubjectsWrap"></div>
      <div class="te-actions" style="margin-top:12px">
        <button class="btn" id="gdprProceedBtn" disabled>Proceed to Confirmation →</button>
      </div>
    </div>

    <!-- ── Step 4: Confirm & Submit ──────────────────────────── -->
    <div class="gdpr-section gdpr-section--locked" id="gdprStep4">
      <h3 class="gdpr-step-title"><span class="gdpr-step-num">4</span>Confirm &amp; Submit</h3>
      <div id="gdprConfirmContent"></div>
      <div class="te-actions" style="margin-top:14px">
        <button class="btn te-btn-export" id="gdprSubmitBtn" disabled></button>
      </div>
      <div class="te-status" id="gdprSubmitStatus" style="margin-top:8px"></div>
    </div>

  `;

  // ── DOM refs ───────────────────────────────────────────────────────
  const $typeGrid       = el.querySelector("#gdprTypeGrid");
  const $typeHelp       = el.querySelector("#gdprTypeHelp");
  const $step2          = el.querySelector("#gdprStep2");
  const $step3          = el.querySelector("#gdprStep3");
  const $step4          = el.querySelector("#gdprStep4");
  const $idGrid         = el.querySelector("#gdprIdentifierGrid");
  const $searchBtn      = el.querySelector("#gdprSearchBtn");
  const $progressWrap   = el.querySelector("#gdprProgressWrap");
  const $progressBar    = el.querySelector("#gdprProgressBar");
  const $status         = el.querySelector("#gdprStatus");
  const $subjectsWrap   = el.querySelector("#gdprSubjectsWrap");
  const $proceedBtn     = el.querySelector("#gdprProceedBtn");
  const $confirmContent = el.querySelector("#gdprConfirmContent");
  const $submitBtn      = el.querySelector("#gdprSubmitBtn");
  const $submitStatus   = el.querySelector("#gdprSubmitStatus");

  // ── State ──────────────────────────────────────────────────────────
  let requestType   = null;
  let foundMatches  = []; // [{ subject, matchedByList: [{type, value}] }]
  let selectedKeys  = new Set();
  let isRunning     = false;
  // The identifiers the CURRENT results were searched with. Step 4 is built
  // from this, never from the live inputs: step 2 stays editable after a
  // search, and a rectification keyed to a since-edited field rewrites the
  // wrong one. Cleared whenever the results are invalidated.
  let searchedIdentifiers = [];

  // ── Utility ────────────────────────────────────────────────────────
  // This page defaults the level to "info" rather than to no modifier at all;
  // te-status--info is unstyled today, so the wrapper only keeps that intent.
  const applyStatus = makeStatus($status, "te-status");
  function setStatus(msg, level = "info") {
    applyStatus(msg, level);
  }
  function setProgress(pct) { $progressBar.style.width = `${pct}%`; }
  function showProgress() { $progressWrap.hidden = false; }
  function hideProgress() { $progressWrap.hidden = true; setProgress(0); }

  // `gdpr-section--locked` is opacity + pointer-events, which a keyboard never
  // sees: Tab reached a locked step's inputs and its controls still fired. The
  // class carries the look, `inert` carries the meaning.
  function unlock(el) { el.classList.remove("gdpr-section--locked"); el.inert = false; }
  function lock(el)   { el.classList.add("gdpr-section--locked");    el.inert = true;  }

  // Steps 2–4 open locked; the markup only carries the class.
  [$step2, $step3, $step4].forEach(s => { s.inert = true; });

  // GDPRSubject carries no `id`; the identity is whichever of these is set.
  // journeyCustomer / socialHandle / externalId are what the Twitter, Instagram,
  // Facebook, Apple Messages and External ID searches come back as — the page
  // offers all five, so all five have to be addressable here and in the body.
  function matchKey(subject) {
    return subject.userId
      ?? subject.externalContactId
      ?? subject.dialerContactId?.id
      ?? subject.journeyCustomer?.id
      ?? (subject.socialHandle ? `${subject.socialHandle.type}:${subject.socialHandle.value}` : null)
      ?? subject.externalId
      ?? null;
  }

  /** The id fields a GDPR request body may carry, in the order they identify a subject. */
  function subjectIdFields(s) {
    const out = {};
    if (s.userId)            out.userId            = s.userId;
    if (s.externalContactId) out.externalContactId = s.externalContactId;
    if (s.dialerContactId)   out.dialerContactId   = s.dialerContactId;
    if (s.journeyCustomer)   out.journeyCustomer   = s.journeyCustomer;
    if (s.socialHandle)      out.socialHandle      = s.socialHandle;
    if (s.externalId)        out.externalId        = s.externalId;
    return out;
  }

  function subjectTypeLabel(s) {
    if (s.userId)            return "User";
    if (s.externalContactId) return "External Contact";
    if (s.dialerContactId)   return "Dialer Contact";
    if (s.journeyCustomer)   return "Journey Customer";
    if (s.socialHandle)      return searchTypeLabel(s.socialHandle.type);
    if (s.externalId)        return "External ID";
    return "Unknown";
  }

  function subjectDisplayId(s) {
    return s.userId
        ?? s.externalContactId
        ?? s.dialerContactId?.id
        ?? s.journeyCustomer?.id
        ?? (s.socialHandle ? `${s.socialHandle.type}: ${s.socialHandle.value}` : null)
        ?? s.externalId
        ?? "—";
  }

  /** "APPLE_MESSAGES" → "Apple Messages", using the same labels as the form. */
  function searchTypeLabel(type) {
    return SEARCH_TYPES.find(t => t.value === type)?.label ?? type;
  }

  function getIdentifiers() {
    return [...$idGrid.querySelectorAll(".gdpr-id-input")]
      .filter(i => i.value.trim())
      .map(i => ({
        type:  i.dataset.type,
        value: i.value.trim(),
      }));
  }

  function updateSearchBtn() {
    // requestType matters: without it, Proceed reads REQUEST_TYPES[null] and
    // throws. Step 2 being locked used to be the only thing stopping that, and
    // a locked section is not a guard.
    $searchBtn.disabled = !requestType || getIdentifiers().length === 0 || isRunning;
  }

  /**
   * Drop the current results and everything built on them.
   *
   * Step 2 stays editable after a search, so results can outlive the values
   * that produced them. Leaving steps 3–4 on screen invites acting on a review
   * list and a rectification table that no longer describe what was searched.
   */
  function invalidateResults() {
    [$step3, $step4].forEach(lock);
    $subjectsWrap.innerHTML = "";
    $confirmContent.innerHTML = "";
    $proceedBtn.disabled = true;
    $submitBtn.disabled = true;
    $submitStatus.textContent = "";
    $submitStatus.className = "te-status";
    foundMatches = [];
    searchedIdentifiers = [];
    selectedKeys.clear();
  }

  // ── Init grid inputs: pre-populate from saved state, persist on change ──
  const saved = savedValuesFor(orgContext?.get?.() ?? null);
  $idGrid.querySelectorAll(".gdpr-id-input").forEach(input => {
    if (saved[input.dataset.type]) {
      input.value = saved[input.dataset.type];
    }
    input.addEventListener("input", () => {
      saved[input.dataset.type] = input.value;
      if (foundMatches.length || searchedIdentifiers.length) {
        invalidateResults();
        setStatus("Identifiers changed — search again to refresh the results.", "warn");
      }
      updateSearchBtn();
    });
  });
  updateSearchBtn();

  /**
   * "What this actually does" for the chosen request type.
   *
   * Shown on selection rather than tucked behind a link, because the mismatch
   * it describes — erasure that redacts, an export nobody can read — is the
   * thing you need before you commit, not after.
   */
  function helpPanelHtml(t) {
    if (!t?.expect?.length) return "";
    return `
      <div class="gdpr-expect">
        <p class="gdpr-expect-title">What ${escapeHtml(t.label)} actually does</p>
        <ul class="gdpr-expect-list">
          ${t.expect.map(line => `<li>${line}</li>`).join("")}
        </ul>
        ${t.expectWarn ? `<p class="gdpr-expect-warn">${t.expectWarn}</p>` : ""}
      </div>
    `;
  }

  // ── Step 1: Type selection ────────────────────────────────────────
  $typeGrid.addEventListener("change", e => {
    if (!e.target.matches("input[type=radio]")) return;
    requestType = e.target.value;

    $typeGrid.querySelectorAll(".gdpr-type-card").forEach(c =>
      c.classList.toggle("gdpr-type-card--selected", c.dataset.type === requestType)
    );
    $typeHelp.innerHTML = helpPanelHtml(REQUEST_TYPES[requestType]);

    // Reset downstream steps
    invalidateResults();
    setStatus("");

    unlock($step2);
    updateSearchBtn();
  });

  // ── Search ────────────────────────────────────────────────────────
  $searchBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org from the header dropdown.", "error"); return; }

    const identifiers = getIdentifiers();
    if (!identifiers.length) { setStatus("Enter at least one identifier.", "error"); return; }

    isRunning = true;
    $searchBtn.disabled = true;
    invalidateResults();
    searchedIdentifiers = identifiers;
    setStatus("Searching\u2026");
    showProgress();
    setProgress(10);

    try {
      const results = await Promise.allSettled(
        identifiers.map(id =>
          gc.gdprSearchSubjects(api, org.id, id.type, id.value)
            .then(({ subjects, total }) => ({ identifier: id, subjects, total }))
        )
      );
      setProgress(90);

      // allSettled preserves order, so a rejection can be named. "1 error(s)"
      // does not tell you that the PHONE leg returned nothing, and on a page
      // about erasing everything, an unnamed gap reads as no gap.
      const errors = [];
      const allMatches = [];
      const truncated = [];   // Genesys said there were more than it returned
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          for (const s of r.value.subjects) {
            allMatches.push({ subject: s, matchedBy: r.value.identifier });
          }
          if (r.value.total != null && r.value.total > r.value.subjects.length) {
            truncated.push({
              type:      identifiers[i].type,
              returned:  r.value.subjects.length,
              total:     r.value.total,
            });
          }
        } else {
          errors.push({
            type:    identifiers[i].type,
            message: r.reason?.message ?? "Unknown error",
          });
        }
      });

      // Deduplicate: if the same subject was returned by multiple identifier searches,
      // collapse them into one row and show all matched-by identifiers together.
      const byId = new Map();
      for (const m of allMatches) {
        const key = matchKey(m.subject) ?? `unknown-${Math.random()}`;
        if (byId.has(key)) {
          byId.get(key).matchedByList.push(m.matchedBy);
        } else {
          byId.set(key, { subject: m.subject, matchedByList: [m.matchedBy] });
        }
      }
      foundMatches = [...byId.values()];
      setProgress(100);

      const failedTypes = errors.map(e => searchTypeLabel(e.type)).join(", ");

      if (errors.length && !foundMatches.length) {
        setStatus(`Search failed: ${errors[0].message}`, "error");
      } else if (errors.length) {
        setStatus(
          `${failedTypes} could not be searched (${errors[0].message}). `
          + `The results below cover the other identifiers only — anyone matching `
          + `${failedTypes} alone is missing from this list.`,
          "warn",
        );
        renderSubjectsTable(foundMatches);
        unlock($step3);
        $proceedBtn.disabled = foundMatches.length === 0;
      } else if (!foundMatches.length) {
        setStatus("No matching subjects found. No GDPR request will be required.", "info");
        $subjectsWrap.innerHTML = `<p class="gdpr-empty">No subjects found for the provided identifiers.</p>`;
        unlock($step3);
        $proceedBtn.disabled = true;
      } else if (truncated.length) {
        // Genesys reported a higher total than it returned, and the endpoint
        // takes no paging parameters, so there is no second page to ask for.
        // Say so rather than presenting a partial list as the whole answer.
        const t0 = truncated[0];
        setStatus(
          `Genesys reports ${t0.total} matches for ${searchTypeLabel(t0.type)} but returned `
          + `${t0.returned}. The list below is incomplete — narrow the identifier, or treat this `
          + `as a partial result.`,
          "warn",
        );
        renderSubjectsTable(foundMatches);
        unlock($step3);
        $proceedBtn.disabled = false;
      } else {
        setStatus(`Found ${foundMatches.length} unique subject${foundMatches.length !== 1 ? "s" : ""}. Review and deselect any false positives.`, "success");
        renderSubjectsTable(foundMatches);
        unlock($step3);
        $proceedBtn.disabled = false;
      }

      // Looking a named individual up across a customer tenant is the read most
      // worth a trail. Values are deliberately not logged — the identifiers are
      // the subject's own personal data.
      logAction({ me, orgId: org?.id || "", orgName: org?.name || "",
        action: "gdpr_subject_search",
        description: `Searched GDPR subjects by ${identifiers.map(i => searchTypeLabel(i.type)).join(", ")}`
          + ` — ${foundMatches.length} match${foundMatches.length !== 1 ? "es" : ""}`,
        result: errors.length ? "partial" : "success",
        errorMessage: errors.length ? `${failedTypes} failed: ${errors[0].message}` : null,
        count: foundMatches.length });
    } catch (err) {
      setStatus(`Search failed: ${err.message}`, "error");
    } finally {
      isRunning = false;
      hideProgress();
      $searchBtn.disabled = false;
      updateSearchBtn();
    }
  });

  // ── Step 3: Subjects table ────────────────────────────────────────
  function renderSubjectsTable(matches) {
    const rows = matches.map((m, i) => {
      const type  = escapeHtml(subjectTypeLabel(m.subject));
      const rawId = subjectDisplayId(m.subject);
      const id    = escapeHtml(rawId);
      const name  = escapeHtml(m.subject.name ?? "\u2014");
      const matchedByHtml = m.matchedByList
        .map(t => `${escapeHtml(t.type)}: <em>${escapeHtml(t.value)}</em>`)
        .join(", ");
      const key   = escapeHtml(matchKey(m.subject) ?? `unknown-${i}`);
      return `
        <tr>
          <td style="text-align:center">
            <input type="checkbox" class="gdpr-subject-chk" data-index="${i}" data-key="${key}" checked />
          </td>
          <td>${name}</td>
          <td><span class="gdpr-type-pill">${type}</span></td>
          <td class="gdpr-mono" title="${id}">${id.length > 24 ? id.substring(0, 24) + "\u2026" : id}</td>
          <td>${matchedByHtml}</td>
        </tr>
      `;
    });

    $subjectsWrap.innerHTML = `
      <div class="gdpr-table-wrap">
        <table class="gdpr-table">
          <thead>
            <tr>
              <th style="width:32px"></th>
              <th>Name</th>
              <th>Subject Type</th>
              <th>Subject ID</th>
              <th>Matched by</th>
            </tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    `;

    // Init selected set (all checked by default)
    selectedKeys = new Set(matches.map((m, i) => matchKey(m.subject) ?? `unknown-${i}`));

    $subjectsWrap.querySelectorAll(".gdpr-subject-chk").forEach(chk => {
      chk.addEventListener("change", () => {
        if (chk.checked) selectedKeys.add(chk.dataset.key);
        else             selectedKeys.delete(chk.dataset.key);
        $proceedBtn.disabled = selectedKeys.size === 0;
      });
    });
  }

  // ── Step 3 → Proceed ──────────────────────────────────────────────
  $proceedBtn.addEventListener("click", () => {
    unlock($step4);
    renderConfirmation();
    $step4.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  /** The found matches still ticked in step 3, in table order. */
  function selectedMatches() {
    return foundMatches.filter((m, i) =>
      selectedKeys.has(matchKey(m.subject) ?? `unknown-${i}`)
    );
  }

  /** Replacement terms as currently typed, keyed by identifier type. */
  function collectReplacementTerms() {
    return [...$confirmContent.querySelectorAll(".gdpr-replacement-input")]
      .filter(input => input.value.trim())
      .map(input => ({
        type:          input.dataset.type,
        existingValue: input.dataset.existing,
        updatedValue:  input.value.trim(),
      }));
  }

  // ── Step 4: Confirmation ──────────────────────────────────────────
  function renderConfirmation() {
    const t     = REQUEST_TYPES[requestType];
    const count = selectedKeys.size;
    $submitBtn.textContent = t.submitLabel;
    // Erasure waits on the confirm tick; rectification waits on at least one
    // replacement value. Neither offers a button that only fails on click.
    $submitBtn.disabled = t.confirmRequired || t.needsReplacement;
    $submitStatus.textContent = "";
    $submitStatus.className = "te-status";

    let html = `
      <div class="gdpr-confirm-header">
        <span class="gdpr-badge ${t.badgeClass}">${t.label}</span>
        <strong>${t.article} — ${t.articleLabel}</strong>
        <a href="${t.articleUrl}" target="_blank" rel="noopener noreferrer" class="gdpr-article-link-sm">
          View article ↗
        </a>
      </div>
      <p class="gdpr-confirm-count">
        <strong>${count}</strong> request${count !== 1 ? "s" : ""} will be submitted
        (one per unique subject) in
        <strong class="gdpr-confirm-org">${escapeHtml(orgContext?.getDetails?.()?.name ?? "no org selected")}</strong>.
      </p>
      <ul class="gdpr-confirm-subjects">
        ${selectedMatches().map(m => `
          <li>
            <span class="gdpr-subject-name">${escapeHtml(m.subject.name ?? "—")}</span>
            <span class="gdpr-type-pill">${escapeHtml(subjectTypeLabel(m.subject))}</span>
            <span class="gdpr-mono">${escapeHtml(subjectDisplayId(m.subject))}</span>
          </li>
        `).join("")}
      </ul>
    `;

    if (t.needsReplacement) {
      html += `
        <p class="gdpr-step-desc">Enter the corrected value for each identifier:</p>
        <table class="gdpr-table gdpr-replace-table">
          <thead>
            <tr><th>Type</th><th>Current value</th><th>Replace with</th></tr>
          </thead>
          <tbody>
            ${searchedIdentifiers.map(id => `
              <tr>
                <td>${escapeHtml(searchTypeLabel(id.type))}</td>
                <td><em>${escapeHtml(id.value)}</em></td>
                <td>
                  <input class="gdpr-id-value gdpr-replacement-input"
                         data-type="${escapeHtml(id.type)}"
                         data-existing="${escapeHtml(id.value)}"
                         type="text"
                         placeholder="New value\u2026" />
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    }

    // Repeated here deliberately. Step 1 may have been chosen several minutes
    // and one search ago, and this is the click that cannot be taken back.
    html += helpPanelHtml(t);

    if (t.note) {
      html += `<p class="gdpr-note">\u2139\ufe0f ${t.note}</p>`;
    }

    if (t.confirmRequired) {
      html += `
        <label class="gdpr-confirm-label">
          <input type="checkbox" id="gdprConfirmChk" />
          <span>${t.confirmText}</span>
        </label>
      `;
    }

    $confirmContent.innerHTML = html;

    if (t.confirmRequired) {
      $confirmContent.querySelector("#gdprConfirmChk").addEventListener("change", e => {
        $submitBtn.disabled = !e.target.checked;
      });
    }

    if (t.needsReplacement) {
      $confirmContent.querySelectorAll(".gdpr-replacement-input").forEach(input => {
        input.addEventListener("input", () => {
          $submitBtn.disabled = collectReplacementTerms().length === 0;
        });
      });
    }
  }

  // ── Submit ─────────────────────────────────────────────────────────
  $submitBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { $submitStatus.textContent = "No org selected."; return; }

    const t = REQUEST_TYPES[requestType];
    const chosen = selectedMatches();
    if (!chosen.length) {
      $submitStatus.textContent = "No subjects selected.";
      return;
    }

    // Collect replacement terms for GDPR_UPDATE
    const replacementTerms = requestType === "GDPR_UPDATE" ? collectReplacementTerms() : [];
    if (requestType === "GDPR_UPDATE" && !replacementTerms.length) {
      $submitStatus.textContent = "Please enter at least one replacement value.";
      $submitStatus.className = "te-status te-status--error";
      return;
    }

    isRunning = true;
    $submitBtn.disabled = true;
    updateSearchBtn();   // a search mid-submit would swap foundMatches under it
    $submitStatus.textContent = `Submitting ${chosen.length} request(s)\u2026`;
    $submitStatus.className = "te-status";

    try {
      const deleteConfirmed = requestType === "GDPR_DELETE";
      const results = await Promise.allSettled(
        chosen.map(m => {
          const ids = subjectIdFields(m.subject);
          const body = {
            requestType,
            subject: {
              // Genesys rejects name when an id field is present. With no id at
              // all, fall back to the value that matched \u2014 matchedByList, since
              // dedup collapses matches and there is no singular `matchedBy`.
              ...(Object.keys(ids).length === 0
                && { name: m.subject.name ?? m.matchedByList[0]?.value }),
              ...ids,
            },
          };
          if (requestType === "GDPR_UPDATE" && replacementTerms.length) {
            body.replacementTerms = replacementTerms;
          }
          return gc.gdprSubmitRequest(api, org.id, body, deleteConfirmed);
        })
      );

      const succeeded = results.filter(r => r.status === "fulfilled").length;
      const failed    = results.filter(r => r.status === "rejected");

      if (!failed.length) {
        const submittedIds = results
          .filter(r => r.status === "fulfilled")
          .map(r => r.value?.id)
          .filter(Boolean);

        const idRows = submittedIds.map(id => `
          <div class="gdpr-submit-id-row">
            <span class="gdpr-submit-id-label">Request ID</span>
            <span class="gdpr-mono gdpr-submit-id-value">${escapeHtml(id)}</span>
            <button class="btn btn-sm gdpr-copy-btn" data-copy="${escapeHtml(id)}" title="Copy ID">Copy</button>
          </div>
        `).join("");

        $submitStatus.innerHTML = `
          <div class="gdpr-submit-success">
            <span class="gdpr-submit-check">✓</span>
            ${succeeded} request${succeeded !== 1 ? "s" : ""} submitted successfully.
            Genesys is processing them asynchronously.
          </div>
          ${idRows}
          <a href="#/gdpr/request-status" class="gdpr-status-page-link">→ View Request Status</a>
        `;
        $submitStatus.className = "te-status te-status--success";
        logAction({ me, orgId: org?.id || "", orgName: org?.name || "",
          action: "gdpr_request",
          description: `Submitted ${succeeded} GDPR ${REQUEST_TYPES[requestType]?.label || requestType} request${succeeded !== 1 ? "s" : ""}`,
          count: succeeded });

        $submitStatus.querySelectorAll(".gdpr-copy-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            const text = btn.dataset.copy;
            const finish = (ok) => {
              btn.textContent = ok ? "Copied!" : "Failed";
              setTimeout(() => { btn.textContent = "Copy"; }, 2000);
            };
            function fallback() {
              const ta = document.createElement("textarea");
              ta.value = text;
              ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
              document.body.appendChild(ta);
              ta.select();
              document.execCommand("copy");
              document.body.removeChild(ta);
              finish(true);
            }
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(text).then(() => finish(true)).catch(() => fallback());
            } else {
              fallback();
            }
          });
        });
      } else {
        $submitStatus.textContent =
          `${succeeded} submitted, ${failed.length} failed: ${failed[0].reason?.message ?? "Unknown error"}`;
        $submitStatus.className = "te-status te-status--error";
        $submitBtn.disabled = false;
        // A part-succeeded erasure is the case most worth a record, and it used
        // to be the one case that logged nothing.
        logAction({ me, orgId: org?.id || "", orgName: org?.name || "",
          action: "gdpr_request",
          description: `Submitted ${succeeded} of ${chosen.length} GDPR `
            + `${t.label} request${chosen.length !== 1 ? "s" : ""}`,
          result: succeeded ? "partial" : "failure",
          errorMessage: failed[0].reason?.message ?? "Unknown error",
          count: succeeded });
      }
    } catch (err) {
      $submitStatus.textContent = `Error: ${err.message}`;
      $submitStatus.className = "te-status te-status--error";
      $submitBtn.disabled = false;
      logAction({ me, orgId: org?.id || "", orgName: org?.name || "",
        action: "gdpr_request",
        description: `GDPR ${t.label} submission failed`,
        result: "failure",
        errorMessage: err.message });
    } finally {
      isRunning = false;
      updateSearchBtn();
    }
  });

  // ── Request history has moved to the dedicated Request Status page ──

  return el;
}
