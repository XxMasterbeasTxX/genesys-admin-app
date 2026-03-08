/**
 * Export › Documentation — Create
 *
 * Triggers a server-side documentation export for the selected org.
 * Calls POST /api/doc-export with { orgId }, waits for the result,
 * then lets the user download the produced XLSX or ZIP file.
 *
 * The server-side handler (api/lib/exports/documentation.js) fetches
 * all major Genesys Cloud configuration objects and builds a multi-sheet
 * workbook that mirrors the Python Export_All.py output exactly:
 *   - 42 configuration sheets (alphabetically sorted)
 *   - "Index" cover sheet with table of contents and clickable hyperlinks
 *   - Optional second workbook with DataTable contents (bundled as ZIP when present)
 *
 * Note: This export can take up to 5–10 minutes for large organisations.
 *       A loading spinner is shown while the request is in progress.
 */
import { sendEmail } from "../../../services/emailService.js";
import { logAction } from "../../../services/activityLogService.js";

export default function renderDocumentationCreate({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  // ── State ──────────────────────────────────────────────────────────────
  let isRunning   = false;
  let lastResult  = null; // { filename, base64, mimeType, summary }

  // ── HTML ───────────────────────────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Export — Documentation — Create</h1>
    <hr class="hr">
    <p class="page-desc">
      Generates a full Genesys Cloud configuration export for the selected org.
      The output Excel workbook contains sheets covering all major
      configuration objects — queues, users, flows, schedules, outbound, OAuth
      clients and more. 
      A second workbook with DataTable contents is included as a ZIP when present.
    </p>
    <p class="page-desc" style="color:#f59e0b;margin-top:4px">
      ⏱ This export may take a while for large organisations.
      Please keep this tab open while it runs.
    </p>

    <div style="margin-bottom:8px">
      <span class="te-user-count" id="docOrgLabel">
        Select an org from the header dropdown above, then click Generate.
      </span>
    </div>

    <div class="te-actions">
      <button class="btn te-btn-export" id="docGenBtn">Generate Documentation</button>
    </div>

    <div class="te-status" id="docStatus"></div>

    <div id="docSpinnerWrap" style="display:none">
      <div class="te-progress-wrap">
        <div class="te-progress-bar" id="docProgressBar"></div>
      </div>
      <p style="font-size:0.85rem;color:#888;margin-top:6px">
        Fetching configuration data from Genesys in parallel — please wait…
      </p>
    </div>

    <div class="wc-summary" id="docSummary" style="display:none"></div>

    <div id="docDownload" style="display:none;margin-top:12px">
      <button class="btn te-btn-export" id="docDownloadBtn">⬇ Download</button>
      <span class="te-user-count" id="docFileLabel" style="margin-left:10px"></span>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="docEmailChk">
        <span>Send email with export</span>
      </label>

      <div class="em-fields" id="docEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="docEmailTo">Recipients</label>
          <input type="text" class="em-input" id="docEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="docEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="docEmailBody" rows="3"
                    placeholder="Leave empty for default message"></textarea>
        </div>
      </div>
    </div>
  `;

  // ── References ─────────────────────────────────────────────────────────
  const $orgLabel    = el.querySelector("#docOrgLabel");
  const $genBtn      = el.querySelector("#docGenBtn");
  const $status      = el.querySelector("#docStatus");
  const $spinner     = el.querySelector("#docSpinnerWrap");
  const $progBar     = el.querySelector("#docProgressBar");
  const $summary     = el.querySelector("#docSummary");
  const $dlWrap      = el.querySelector("#docDownload");
  const $dlBtn       = el.querySelector("#docDownloadBtn");
  const $fileLabel   = el.querySelector("#docFileLabel");
  const $emailChk    = el.querySelector("#docEmailChk");
  const $emailFields = el.querySelector("#docEmailFields");
  const $emailTo     = el.querySelector("#docEmailTo");
  const $emailBody   = el.querySelector("#docEmailBody");

  // Toggle email fields
  $emailChk.addEventListener("change", () => {
    $emailFields.style.display = $emailChk.checked ? "" : "none";
  });

  // ── Helpers ────────────────────────────────────────────────────────────
  function setStatus(msg, cls) {
    $status.textContent = msg;
    $status.className   = "te-status" + (cls ? ` te-status--${cls}` : "");
  }

  function showSpinner(visible) {
    $spinner.style.display = visible ? "" : "none";
    if (visible) {
      // Animated "running" look: fill to ~80 % then hold
      $progBar.style.transition = "width 8s ease-out";
      $progBar.style.width = "80%";
    } else {
      $progBar.style.transition = "width 0.3s ease";
      $progBar.style.width = "0%";
    }
  }

  // Keep the org label in sync with whatever is selected in the header
  function refreshOrgLabel() {
    const org = orgContext?.getDetails?.();
    if (org) {
      $orgLabel.textContent = `Selected org: ${org.name}`;
    } else {
      $orgLabel.textContent = "Select an org from the header dropdown above, then click Generate.";
    }
  }

  // Refresh when the component is first rendered
  refreshOrgLabel();

  // ── Generate ───────────────────────────────────────────────────────────
  $genBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) {
      setStatus("Please select a customer org from the header dropdown first.", "error");
      return;
    }

    if (isRunning) return;
    isRunning  = true;
    lastResult = null;

    // Reset UI
    $genBtn.disabled           = true;
    $dlWrap.style.display      = "none";
    $summary.style.display     = "none";
    setStatus(`Starting documentation export for ${org.name}…`);
    showSpinner(true);

    const startTs = Date.now();

    try {
      const resp = await fetch("/api/doc-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: org.id, includeDataTables: true }),
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `Server returned ${resp.status}`);
      }

      const result = await resp.json();

      if (!result.success) {
        throw new Error(result.error || "Export failed");
      }

      const elapsed = Math.round((Date.now() - startTs) / 1000);
      lastResult = result;

      const isZip  = result.mimeType === "application/zip";
      const extStr = isZip ? "ZIP (XLSX + DataTables XLSX)" : "XLSX";

      $summary.textContent   = `${result.summary}`;
      $summary.style.display = "";

      $dlBtn.textContent    = `⬇ Download ${extStr}`;
      $fileLabel.textContent = result.filename;
      $dlWrap.style.display  = "";
      logAction({ me, orgId: org?.id || "", orgName: org?.name || "", action: "export_run",
        description: `Exported Documentation for '${org?.name || ""}'` });

      // ── Send email if enabled ──────────────────────────────────────────
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const emailResult = await sendEmail(api, {
            recipients: $emailTo.value,
            subject: `Documentation Export — ${org.name} — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
            body: $emailBody.value,
            attachment: {
              filename: result.filename,
              base64:   result.base64,
              mimeType: result.mimeType,
            },
          });

          if (emailResult.success) {
            setStatus(`Export complete — ${extStr} ready — ${elapsed}s elapsed. Email sent to: ${$emailTo.value.trim()}`, "success");
          } else {
            setStatus(`Export complete but email failed: ${emailResult.error}`, "error");
          }
        } catch (emailErr) {
          setStatus(`Export complete but email failed: ${emailErr.message}`, "error");
        }
      } else {
        setStatus(
          `Export complete — ${extStr} ready — ${elapsed}s elapsed`,
          "success"
        );
      }
    } catch (err) {
      setStatus(`Export failed: ${err.message}`, "error");
    } finally {
      isRunning        = false;
      $genBtn.disabled = false;
      showSpinner(false);
    }
  });

  // ── Download ───────────────────────────────────────────────────────────
  $dlBtn.addEventListener("click", () => {
    if (!lastResult) return;

    const { filename, base64 } = lastResult;
    const helperUrl = new URL("download.html", document.baseURI);
    helperUrl.hash  = encodeURIComponent(filename) + "|" + base64;

    const popup = window.open(helperUrl.href, "_blank");
    if (!popup) {
      setStatus(
        "Pop-up blocked. Please allow pop-ups for this site and try again.",
        "error"
      );
    }
  });

  return el;
}
