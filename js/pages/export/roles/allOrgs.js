/**
 * Export › Roles — All Orgs
 *
 * Exports authorization roles for every customer org in a single workbook.
 * One sheet per org (sheet name = org name, max 31 chars, special chars sanitized).
 * Columns: Name, Description, Members (accurate — active org users only).
 * Rows sorted alphabetically per org.
 *
 * Member counts come from one paginated users call per org, not one call per
 * role: GET /api/v2/users?expand=authorization embeds each user's roles, which
 * are then tallied locally. Only active users are counted, so deleted and
 * external-org holders are excluded — matching Python GUI_tab_roles.py.
 *
 * No schedule panel — run on-demand only.
 * Filename prefix: Roles_AllOrgs_
 */
import { escapeHtml, timestampedFilename, downloadWorkbook, makeStatus } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { sendEmail } from "../../../services/emailService.js";
import { addStyledSheet } from "../../../utils/excelStyles.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";
import { orgContext } from "../../../services/orgContext.js";
import { logAction } from "../../../services/activityLogService.js";

const HEADERS = ["Name", "Description", "Members"];

/** Sanitise org name into a valid Excel sheet name (max 31 chars, no special chars). */
function sanitizeSheetName(name) {
  return name.replace(/[\/\\\?\*\[\]:]/g, "-").slice(0, 31);
}

// ── Page renderer ────────────────────────────────────────

export default function renderRolesAllOrgs({ route, me, api }) {
  const el = document.createElement("section");
  el.className = "card";

  let cancelled = false;
  let lastWorkbook = null;
  let lastFilename = null;

  // One filter set per org block. Blocks accumulate as the run progresses and
  // are cleared when a new run starts, so their document listeners go with them.
  let filterDisposers = [];
  const releaseFilters = () => {
    for (const dispose of filterDisposers) dispose();
    filterDisposers = [];
  };

  el.innerHTML = `
    <h1 class="h1">Export — Roles — All Orgs</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports all authorization roles for every customer org in a single workbook,
      one sheet per org. Member counts reflect active org users only
      (deleted and external-org users are excluded). Roles are sorted alphabetically.
    </p>

    <div class="te-actions">
      <button class="btn te-btn-export" id="raExportBtn">Export All Orgs</button>
      <button class="btn te-btn-cancel" id="raCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="raStatus"></div>

    <div class="te-progress-wrap" id="raProgressWrap" style="display:none">
      <div class="te-progress-bar" id="raProgressBar"></div>
    </div>

    <div id="raTableWrap"></div>

    <div class="wc-summary" id="raSummary" style="display:none"></div>

    <div id="raDownload" style="display:none">
      <button class="btn te-btn-export" id="raDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="raEmailChk">
        <span>Send email with export</span>
      </label>
      <div class="em-fields" id="raEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="raEmailTo">Recipients</label>
          <input type="text" class="em-input" id="raEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="raEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="raEmailBody" rows="3"
                    placeholder="Leave empty for default message"></textarea>
        </div>
      </div>
    </div>
  `;

  // ── References ────────────────────────────────────────
  const $exportBtn = el.querySelector("#raExportBtn");
  const $cancelBtn = el.querySelector("#raCancelBtn");
  const $status    = el.querySelector("#raStatus");
  const $progWrap  = el.querySelector("#raProgressWrap");
  const $progBar   = el.querySelector("#raProgressBar");
  const $tableWrap = el.querySelector("#raTableWrap");
  const $summary   = el.querySelector("#raSummary");
  const $dlWrap    = el.querySelector("#raDownload");
  const $dlBtn     = el.querySelector("#raDownloadBtn");
  const $emailChk  = el.querySelector("#raEmailChk");
  const $emailFld  = el.querySelector("#raEmailFields");
  const $emailTo   = el.querySelector("#raEmailTo");
  const $emailBody = el.querySelector("#raEmailBody");

  const setStatus = makeStatus($status, "te-status");

  function setProgress(pct) {
    $progWrap.style.display = "";
    $progBar.style.width = `${pct}%`;
    // 0 % means "started, nothing measurable yet" — an empty bar reads as
    // stalled, so it travels instead until a real figure arrives.
    $progBar.classList.toggle("progress-bar--indeterminate", !(pct > 0));
  }

  // ── Export ────────────────────────────────────────────
  $exportBtn.addEventListener("click", async () => {
    const customers = orgContext.getCustomers();
    if (!customers.length) { setStatus("No customer orgs available.", "error"); return; }

    cancelled = false;
    $exportBtn.style.display = "none";
    $cancelBtn.style.display = "";
    releaseFilters();
    $tableWrap.innerHTML = "";
    $dlWrap.style.display = "none";
    $summary.style.display = "none";
    setStatus("Starting export…");
    setProgress(0);

    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();
    let totalRoles = 0;
    let successOrgs = 0;

    try {
      for (let orgIdx = 0; orgIdx < customers.length; orgIdx++) {
        if (cancelled) break;

        const org = customers[orgIdx];
        const orgBasePct = Math.round((orgIdx / customers.length) * 100);
        setStatus(`Org ${orgIdx + 1}/${customers.length}: ${org.name} — fetching roles…`);
        setProgress(orgBasePct);

        try {
          // Fetch roles and users (with roles embedded) in parallel — 2 calls total, no per-role calls
          setStatus(`Org ${orgIdx + 1}/${customers.length}: ${org.name} — fetching roles and users…`);
          const [roles, activeUsers] = await Promise.all([
            gc.fetchAllAuthorizationRoles(api, org.id),
            gc.fetchAllUsers(api, org.id, { expand: ["authorization"] }),
          ]);
          if (cancelled) break;

          // Count role members locally from embedded authorization data
          const counts = {};
          for (const role of roles) counts[role.id] = 0;
          for (const user of activeUsers) {
            for (const r of (user.authorization?.roles || [])) {
              const rid = r.id || r.roleId;
              if (rid && counts[rid] !== undefined) counts[rid]++;
            }
          }

          // Build sorted rows
          const rows = [...roles]
            .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }))
            .map(r => [r.name || "Unnamed", r.description || "", counts[r.id] ?? 0]);

          // Add styled sheet to workbook
          const sheetName = sanitizeSheetName(org.name);
          addStyledSheet(wb, [HEADERS, ...rows], sheetName);

          totalRoles += rows.length;
          successOrgs++;

          // Append pre-collapsed preview block
          appendPreviewBlock(org, rows);

        } catch (orgErr) {
          appendErrorBlock(org, orgErr.message);
        }
      }

      if (!cancelled) {
        setProgress(100);
        const fname = timestampedFilename("Roles_AllOrgs", "xlsx");
        lastWorkbook = wb;
        lastFilename = fname;
        $dlWrap.style.display = "";
        $summary.textContent = `${successOrgs} orgs exported — ${totalRoles} total roles`;
        $summary.style.display = "";
        logAction({ me, action: "export_run",
          description: `Exported Roles — All Orgs — ${successOrgs} orgs, ${totalRoles} roles`, count: successOrgs });

        if ($emailChk.checked && $emailTo.value.trim()) {
          setStatus("Sending email…");
          try {
            const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
            const result = await sendEmail(api, {
              recipients: $emailTo.value,
              subject: `Roles Export — All Orgs — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
              body: $emailBody.value,
              attachment: {
                filename: fname,
                base64: xlsxB64,
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              },
            });
            if (result.success) {
              setStatus(`Done. Email sent to: ${$emailTo.value.trim()}`, "success");
            } else {
              setStatus(`Export complete but email failed: ${result.error}`, "error");
            }
          } catch (emailErr) {
            setStatus(`Export complete but email failed: ${emailErr.message}`, "error");
          }
        } else {
          setStatus(`Export complete — ${successOrgs} orgs, ${totalRoles} total roles`, "success");
        }
      } else {
        setStatus("Cancelled.", "error");
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $exportBtn.style.display = "";
      $cancelBtn.style.display = "none";
    }
  });

  // ── Cancel ────────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => {
    cancelled = true;
    setStatus("Cancelling…", "error");
    $exportBtn.style.display = "";
    $cancelBtn.style.display = "none";
  });

  // ── Download ──────────────────────────────────────────
  $dlBtn.addEventListener("click", () => {
    if (!lastWorkbook || !lastFilename) return;
    try {
      downloadWorkbook(lastWorkbook, lastFilename);
    } catch (err) {
      setStatus(err.message, "error");
    }
  });

  // ── Email toggle ──────────────────────────────────────
  $emailChk.addEventListener("change", () => {
    $emailFld.style.display = $emailChk.checked ? "" : "none";
  });

  // ── Per-org preview blocks (pre-collapsed) ────────────
  function appendPreviewBlock(org, rows) {
    const block = document.createElement("div");
    block.innerHTML = `
      <details class="te-details">
        <summary class="te-sheet-title">
          ${escapeHtml(org.name)}
          <span class="te-user-count">${rows.length} roles</span>
        </summary>
        <div class="te-table-scroll">
          <table class="data-table ll-preview-table">
            <thead>
              <tr>${HEADERS.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>
              <tr class="ll-filter-row">${HEADERS.map(() => `<th></th>`).join("")}</tr>
            </thead>
            <tbody>
              ${rows.map(row => `
                <tr>
                  <td>${escapeHtml(String(row[0]))}</td>
                  <td>${escapeHtml(String(row[1]))}</td>
                  <td style="text-align:right">${row[2]}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </details>`;
    $tableWrap.appendChild(block);

    const countEl = block.querySelector(".te-user-count");
    filterDisposers.push(attachColumnFilters(block, {
      filterCols: [0, 1, 2],
      countEl,
      totalLabel: "roles",
    }));
  }

  function appendErrorBlock(org, errMsg) {
    const block = document.createElement("p");
    block.className = "te-status te-status--error";
    block.style.marginTop = "6px";
    block.textContent = `${org.name}: ${errMsg}`;
    $tableWrap.appendChild(block);
  }

  el.__destroy = releaseFilters;

  return el;
}
