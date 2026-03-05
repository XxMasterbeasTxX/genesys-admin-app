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
import { escapeHtml } from "../../utils.js";

// ── Request type definitions ──────────────────────────────────────────
const REQUEST_TYPES = {
  GDPR_DELETE: {
    label:        "Erasure",
    article:      "Article 17",
    articleLabel: "Right to Erasure",
    articleUrl:   "https://gdpr-info.eu/art-17-gdpr/",
    description:  "Permanently delete or anonymize all personal data Genesys Cloud holds on this individual.",
    badgeClass:   "gdpr-badge--delete",
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
    description:  "Compile and export a copy of all personal data Genesys Cloud holds on this individual.",
    badgeClass:   "gdpr-badge--export",
    confirmRequired: false,
    submitLabel:  "Submit Access Request(s)",
    note:         "Genesys will process and make the data available within 1–2 business days. Check Request History below once ready.",
    needsReplacement: false,
  },
  GDPR_UPDATE: {
    label:        "Rectification",
    article:      "Article 16",
    articleLabel: "Right to Rectification",
    articleUrl:   "https://gdpr-info.eu/art-16-gdpr/",
    description:  "Replace inaccurate personal data (e.g. old name or phone number) across all records.",
    badgeClass:   "gdpr-badge--update",
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
];

// ── Persist identifier values across re-renders (e.g. org change) ──────
const _savedValues = {};

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

    <!-- ── Request History ───────────────────────────────────── -->
    <div class="gdpr-section gdpr-history-section">
      <h3 class="gdpr-step-title gdpr-history-toggle" id="gdprHistoryToggle">
        <span class="gdpr-step-num">↓</span>Request History
        <span class="gdpr-history-chevron" style="margin-left:auto">▼</span>
      </h3>
      <div id="gdprHistoryContent" hidden>
        <p class="gdpr-step-desc" style="margin-top:0">
          All GDPR requests previously submitted for the selected org.
        </p>
        <div class="te-actions">
          <button class="btn" id="gdprHistoryRefresh">Load / Refresh</button>
        </div>
        <div id="gdprHistoryWrap"></div>
      </div>
    </div>
  `;

  // ── DOM refs ───────────────────────────────────────────────────────
  const $typeGrid       = el.querySelector("#gdprTypeGrid");
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
  const $historyToggle  = el.querySelector("#gdprHistoryToggle");
  const $historyContent = el.querySelector("#gdprHistoryContent");
  const $historyRefresh = el.querySelector("#gdprHistoryRefresh");
  const $historyWrap    = el.querySelector("#gdprHistoryWrap");

  // ── State ──────────────────────────────────────────────────────────
  let requestType   = null;
  let foundMatches  = []; // [{ subject, matchedBy: {type, value} }]
  let selectedKeys  = new Set();
  let isRunning     = false;

  // ── Utility ────────────────────────────────────────────────────────
  function setStatus(msg, level = "info") {
    $status.textContent = msg;
    $status.className = `te-status te-status--${level}`;
  }
  function setProgress(pct) { $progressBar.style.width = `${pct}%`; }
  function showProgress() { $progressWrap.hidden = false; }
  function hideProgress() { $progressWrap.hidden = true; setProgress(0); }
  function unlock(el) { el.classList.remove("gdpr-section--locked"); }

  function matchKey(subject) {
    return subject.userId
      ?? subject.externalContactId
      ?? subject.dialerContactId?.id
      ?? subject.id
      ?? null;
  }

  function subjectTypeLabel(s) {
    if (s.userId)            return "User";
    if (s.externalContactId) return "External Contact";
    if (s.dialerContactId)   return "Dialer Contact";
    return "Unknown";
  }

  function subjectDisplayId(s) {
    return s.userId ?? s.externalContactId ?? s.dialerContactId?.id ?? s.id ?? "—";
  }

  function getIdentifiers() {
    return [...$idGrid.querySelectorAll(".gdpr-id-input")]
      .filter(i => i.value.trim())
      .map(i => ({
        type:        i.dataset.type,
        value:       i.value.trim(),
        replacement: "",
      }));
  }

  function updateSearchBtn() {
    $searchBtn.disabled = getIdentifiers().length === 0 || isRunning;
  }

  // ── Init grid inputs: pre-populate from saved state, persist on change ──
  $idGrid.querySelectorAll(".gdpr-id-input").forEach(input => {
    if (_savedValues[input.dataset.type]) {
      input.value = _savedValues[input.dataset.type];
    }
    input.addEventListener("input", () => {
      _savedValues[input.dataset.type] = input.value;
      updateSearchBtn();
    });
  });
  updateSearchBtn();

  // ── Step 1: Type selection ────────────────────────────────────────
  $typeGrid.addEventListener("change", e => {
    if (!e.target.matches("input[type=radio]")) return;
    requestType = e.target.value;

    $typeGrid.querySelectorAll(".gdpr-type-card").forEach(c =>
      c.classList.toggle("gdpr-type-card--selected", c.dataset.type === requestType)
    );

    // Reset downstream steps
    [$step3, $step4].forEach(s => s.classList.add("gdpr-section--locked"));
    $subjectsWrap.innerHTML = "";
    $confirmContent.innerHTML = "";
    $proceedBtn.disabled = true;
    foundMatches = [];
    selectedKeys.clear();
    setStatus("");

    unlock($step2);
  });

  // ── Search ────────────────────────────────────────────────────────
  $searchBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org from the header dropdown.", "error"); return; }

    const identifiers = getIdentifiers();
    if (!identifiers.length) { setStatus("Enter at least one identifier.", "error"); return; }

    isRunning = true;
    $searchBtn.disabled = true;
    [$step3, $step4].forEach(s => s.classList.add("gdpr-section--locked"));
    foundMatches = [];
    selectedKeys.clear();
    setStatus("Searching\u2026");
    showProgress();
    setProgress(10);

    try {
      const results = await Promise.allSettled(
        identifiers.map(id =>
          gc.gdprSearchSubjects(api, org.id, id.type, id.value)
            .then(subjects => ({ identifier: id, subjects }))
        )
      );
      setProgress(90);

      const errors = [];
      const allMatches = [];
      for (const r of results) {
        if (r.status === "fulfilled") {
          for (const s of r.value.subjects) {
            allMatches.push({ subject: s, matchedBy: r.value.identifier });
          }
        } else {
          errors.push(r.reason?.message ?? "Unknown error");
        }
      }

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

      if (errors.length && !foundMatches.length) {
        setStatus(`Search failed: ${errors[0]}`, "error");
      } else if (errors.length) {
        setStatus(`Search completed with ${errors.length} error(s). Showing partial results.`, "warn");
        renderSubjectsTable(foundMatches);
        unlock($step3);
        $proceedBtn.disabled = foundMatches.length === 0;
      } else if (!foundMatches.length) {
        setStatus("No matching subjects found. No GDPR request will be required.", "info");
        $subjectsWrap.innerHTML = `<p class="gdpr-empty">No subjects found for the provided identifiers.</p>`;
        unlock($step3);
        $proceedBtn.disabled = true;
      } else {
        setStatus(`Found ${foundMatches.length} unique subject${foundMatches.length !== 1 ? "s" : ""}. Review and deselect any false positives.`, "success");
        renderSubjectsTable(foundMatches);
        unlock($step3);
        $proceedBtn.disabled = false;
      }
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

  // ── Step 4: Confirmation ──────────────────────────────────────────
  function renderConfirmation() {
    const t     = REQUEST_TYPES[requestType];
    const count = selectedKeys.size;
    $submitBtn.textContent = t.submitLabel;
    $submitBtn.disabled = t.confirmRequired; // enabled immediately unless confirm required
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
        (one per unique subject).
      </p>
    `;

    if (t.needsReplacement) {
      const identifiers = getIdentifiers();
      html += `
        <p class="gdpr-step-desc">Enter the corrected value for each identifier:</p>
        <table class="gdpr-table gdpr-replace-table">
          <thead>
            <tr><th>Type</th><th>Current value</th><th>Replace with</th></tr>
          </thead>
          <tbody>
            ${identifiers.map((id, i) => `
              <tr>
                <td>${escapeHtml(id.type)}</td>
                <td><em>${escapeHtml(id.value)}</em></td>
                <td>
                  <input class="gdpr-id-value gdpr-replacement-input"
                         data-index="${i}"
                         type="text"
                         placeholder="New value\u2026"
                         value="${escapeHtml(id.replacement)}" />
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    }

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
  }

  // ── Submit ─────────────────────────────────────────────────────────
  $submitBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { $submitStatus.textContent = "No org selected."; return; }

    const t = REQUEST_TYPES[requestType];
    const selectedMatches = foundMatches.filter((m, i) =>
      selectedKeys.has(matchKey(m.subject) ?? `unknown-${i}`)
    );
    if (!selectedMatches.length) {
      $submitStatus.textContent = "No subjects selected.";
      return;
    }

    // Collect replacement terms for GDPR_UPDATE
    let replacementTerms = [];
    if (requestType === "GDPR_UPDATE") {
      $confirmContent.querySelectorAll(".gdpr-replacement-input").forEach(input => {
        const idx = parseInt(input.dataset.index, 10);
        const identifiers = getIdentifiers();
        if (identifiers[idx] && input.value.trim()) {
          replacementTerms.push({
            type:          identifiers[idx].type,
            existingValue: identifiers[idx].value,
            updatedValue:  input.value.trim(),
          });
        }
      });
      if (!replacementTerms.length) {
        $submitStatus.textContent = "Please enter at least one replacement value.";
        $submitStatus.className = "te-status te-status--error";
        return;
      }
    }

    isRunning = true;
    $submitBtn.disabled = true;
    $submitStatus.textContent = `Submitting ${selectedMatches.length} request(s)\u2026`;
    $submitStatus.className = "te-status";

    try {
      const deleteConfirmed = requestType === "GDPR_DELETE";
      const results = await Promise.allSettled(
        selectedMatches.map(m => {
          const hasId = m.subject.userId || m.subject.externalContactId || m.subject.dialerContactId;
          const body = {
            requestType,
            subject: {
              // Genesys rejects name when an id field is present
              ...(!hasId && { name: m.subject.name ?? m.matchedBy.value }),
              ...(m.subject.userId            && { userId:            m.subject.userId }),
              ...(m.subject.externalContactId && { externalContactId: m.subject.externalContactId }),
              ...(m.subject.dialerContactId   && { dialerContactId:   m.subject.dialerContactId }),
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
        `;
        $submitStatus.className = "te-status te-status--success";

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
      }
    } catch (err) {
      $submitStatus.textContent = `Error: ${err.message}`;
      $submitStatus.className = "te-status te-status--error";
      $submitBtn.disabled = false;
    } finally {
      isRunning = false;
    }
  });

  // ── History toggle ─────────────────────────────────────────────────
  $historyToggle.addEventListener("click", () => {
    $historyContent.hidden = !$historyContent.hidden;
    $historyToggle.querySelector(".gdpr-history-chevron").textContent =
      $historyContent.hidden ? "\u25bc" : "\u25b2";
  });

  // ── History load ───────────────────────────────────────────────────
  $historyRefresh.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) {
      $historyWrap.innerHTML = `<p class="gdpr-empty">Please select a customer org first.</p>`;
      return;
    }

    $historyRefresh.disabled = true;
    $historyWrap.innerHTML = `<p class="gdpr-loading">Loading\u2026</p>`;

    try {
      const requests = await gc.gdprGetRequests(api, org.id);

      if (!requests.length) {
        $historyWrap.innerHTML = `<p class="gdpr-empty">No GDPR requests found for ${escapeHtml(org.name)}.</p>`;
        return;
      }

      // Re-resolve removed: contacts may already be deleted (e.g. after erasure).
      // Fall back to name stored in response, then raw ID.

      const TYPE_LABELS  = { GDPR_DELETE: "Erasure", GDPR_EXPORT: "Access", GDPR_UPDATE: "Rectification" };
      const TYPE_CLASSES = { GDPR_DELETE: "gdpr-badge--delete", GDPR_EXPORT: "gdpr-badge--export", GDPR_UPDATE: "gdpr-badge--update" };
      const STATUS_LABEL = {
        INITIATED:   "Initiated",
        DELETING:    "Deleting\u2026",
        IN_PROGRESS: "In Progress",
        FULFILLED:   "Fulfilled",
        COMPLETE:    "Fulfilled",
        COMPLETED:   "Fulfilled",
        FAILED:      "Failed",
        REJECTED:    "Rejected",
        ERROR:       "Error",
      };
      const STATUS_CLASS = {
        INITIATED:   "inprogress",
        DELETING:    "inprogress",
        IN_PROGRESS: "inprogress",
        FULFILLED:   "completed",
        COMPLETE:    "completed",
        COMPLETED:   "completed",
        FAILED:      "failed",
        REJECTED:    "failed",
        ERROR:       "failed",
      };

      const rows = requests.map((r) => {
        const date        = r.createdDate ? new Date(r.createdDate).toLocaleString() : "\u2014";
        const type        = r.requestType ?? "\u2014";
        const typeLabel   = TYPE_LABELS[type] ?? type;
        const badgeClass  = TYPE_CLASSES[type] ?? "";
        const rawStatus   = r.status ?? "\u2014";
        const statusLabel = STATUS_LABEL[rawStatus] ?? rawStatus;
        const statusClass = STATUS_CLASS[rawStatus] ?? "inprogress";

        const rawId = r.subject?.userId ?? r.subject?.externalContactId ?? r.subject?.dialerContactId?.id ?? null;
        const nameDisplay = escapeHtml(r.subject?.name ?? rawId ?? "\u2014");

        const subjectType = r.subject?.userId            ? "User"
                          : r.subject?.externalContactId ? "Ext. Contact"
                          : r.subject?.dialerContactId   ? "Dialer Contact"
                          : "\u2014";

        const reqId = escapeHtml(r.id ?? "\u2014");

        // Completed date (resolutionDate is set when the request finishes)
        const completedDate = r.resolutionDate ? new Date(r.resolutionDate).toLocaleString() : "\u2014";

        // Details column — contextual per request type
        let detailsHtml = "\u2014";
        if (type === "GDPR_EXPORT" && r.resultsUrl?.length) {
          // Article 15 Access: signed download URLs available when fulfilled
          detailsHtml = r.resultsUrl.map((url, i) =>
            `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="gdpr-download-link">Download${r.resultsUrl.length > 1 ? ` (${i + 1})` : ""}</a>`
          ).join("<br>");
        } else if (type === "GDPR_UPDATE" && r.replacements?.length) {
          // Article 16 Rectification: show which fields were updated
          const fieldList = r.replacements.map(rep => escapeHtml(rep.fieldName ?? "?")).join(", ");
          detailsHtml = `<span class="gdpr-replacements-summary" title="${fieldList}">${r.replacements.length} field${r.replacements.length !== 1 ? "s" : ""} updated: ${fieldList}</span>`;
        }

        return `
          <tr>
            <td>${escapeHtml(date)}</td>
            <td><span class="gdpr-badge ${badgeClass}">${typeLabel}</span></td>
            <td><span class="gdpr-subject-name">${nameDisplay}</span></td>
            <td><span class="gdpr-subject-type-badge">${escapeHtml(subjectType)}</span></td>
            <td><span class="gdpr-status-dot gdpr-status-dot--${statusClass}">${escapeHtml(statusLabel)}</span></td>
            <td>${escapeHtml(completedDate)}</td>
            <td class="gdpr-details-cell">${detailsHtml}</td>
            <td class="gdpr-mono" title="${reqId}">${reqId.length > 24 ? reqId.substring(0, 24) + "\u2026" : reqId}</td>
          </tr>
        `;
      });

      $historyWrap.innerHTML = `
        <div class="gdpr-table-wrap" style="margin-top:12px">
          <table class="gdpr-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Subject</th>
                <th>Subject Type</th>
                <th>Status</th>
                <th>Completed</th>
                <th>Details</th>
                <th>Request ID</th>
              </tr>
            </thead>
            <tbody>${rows.join("")}</tbody>
          </table>
        </div>
      `;
    } catch (err) {
      $historyWrap.innerHTML = `<p class="gdpr-empty gdpr-empty--error">Error loading history: ${escapeHtml(err.message)}</p>`;
    } finally {
      $historyRefresh.disabled = false;
    }
  });

  return el;
}
