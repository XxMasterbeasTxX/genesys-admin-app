/**
 * Export › Roles — Single Org
 *
 * Exports all authorization roles for the selected org.
 * Columns: Name, Description, Members (accurate — active org users only).
 * One row per role, sorted alphabetically by name.
 *
 * Member count method (matches Python GUI_tab_roles.py):
 *   1. Fetch all active users → build a Set of their IDs
 *   2. Per role: fetch assigned users via GET /api/v2/authorization/roles/{id}/users
 *   3. Count only those present in the active user set (excludes deleted/external-org users)
 *
 * Sheet name: "Roles"
 * Filename prefix: Roles_{OrgName}_
 */
import { escapeHtml, timestampedFilename } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { sendEmail } from "../../../services/emailService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { buildStyledWorkbook } from "../../../utils/excelStyles.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";

// ── Automation ──────────────────────────────────────────
const AUTOMATION_ENABLED = true;
const AUTOMATION_EXPORT_TYPE = "rolesSingleOrg";
const AUTOMATION_EXPORT_LABEL = "Roles — Single Org";

const HEADERS = ["Name", "Description", "Members"];

// ── Helpers ─────────────────────────────────────────────

/**
 * Compute accurate member counts per role.
 * Active org users fetched once; role users fetched per role and intersected.
 * @param {Function} onProgress  (roleIndex, totalRoles, roleName) => void
 */
async function computeMemberCounts(api, orgId, roles, onProgress) {
  const activeUsers = await gc.fetchAllUsers(api, orgId, {});
  const activeIds = new Set(activeUsers.map(u => u.id));

  onProgress?.(0, roles.length, "");
  const roleUserResults = await Promise.allSettled(
    roles.map(role => gc.fetchRoleUsers(api, orgId, role.id))
  );
  onProgress?.(roles.length, roles.length, "");

  const counts = {};
  roles.forEach((role, i) => {
    const r = roleUserResults[i];
    const users = r.status === "fulfilled" ? r.value : [];
    counts[role.id] = users.filter(u => activeIds.has(u.id)).length;
  });
  return counts;
}

function buildRows(roles, counts) {
  return [...roles]
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }))
    .map(r => ({ name: r.name || "Unnamed", description: r.description || "", members: counts[r.id] ?? 0 }));
}

function buildWorkbook(rows) {
  const wsData = [HEADERS, ...rows.map(r => [r.name, r.description, r.members])];
  return buildStyledWorkbook(wsData, "Roles");
}

// ── Page renderer ────────────────────────────────────────

export default function renderRolesSingleOrg({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning = false;
  let cancelled = false;
  let lastWorkbook = null;
  let lastFilename = null;

  el.innerHTML = `
    <h1 class="h1">Export — Roles — Single Org</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports all authorization roles for the selected org with accurate member counts.
      Members are counted against active org users only — deleted and external-org
      users are excluded. Roles are sorted alphabetically.
    </p>

    <div class="te-actions">
      <button class="btn te-btn-export" id="rsExportBtn">Export Roles</button>
      <button class="btn te-btn-cancel" id="rsCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="rsStatus"></div>

    <div class="te-progress-wrap" id="rsProgressWrap" style="display:none">
      <div class="te-progress-bar" id="rsProgressBar"></div>
    </div>

    <div id="rsTableWrap" style="display:none"></div>

    <div class="wc-summary" id="rsSummary" style="display:none"></div>

    <div id="rsDownload" style="display:none">
      <button class="btn te-btn-export" id="rsDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="rsEmailChk">
        <span>Send email with export</span>
      </label>
      <div class="em-fields" id="rsEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="rsEmailTo">Recipients</label>
          <input type="text" class="em-input" id="rsEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="rsEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="rsEmailBody" rows="3"
                    placeholder="Leave empty for default message"></textarea>
        </div>
      </div>
    </div>
  `;

  // ── Automation panel ──────────────────────────────────
  if (AUTOMATION_ENABLED) {
    const schedulePanel = createSchedulePanel({
      exportType: AUTOMATION_EXPORT_TYPE,
      exportLabel: AUTOMATION_EXPORT_LABEL,
      me,
      requiresOrg: true,
      configSummary: (cfg) => cfg.orgName || "—",
    });
    el.appendChild(schedulePanel);
  }

  // ── References ────────────────────────────────────────
  const $exportBtn = el.querySelector("#rsExportBtn");
  const $cancelBtn = el.querySelector("#rsCancelBtn");
  const $status    = el.querySelector("#rsStatus");
  const $progWrap  = el.querySelector("#rsProgressWrap");
  const $progBar   = el.querySelector("#rsProgressBar");
  const $tableWrap = el.querySelector("#rsTableWrap");
  const $summary   = el.querySelector("#rsSummary");
  const $dlWrap    = el.querySelector("#rsDownload");
  const $dlBtn     = el.querySelector("#rsDownloadBtn");
  const $emailChk  = el.querySelector("#rsEmailChk");
  const $emailFld  = el.querySelector("#rsEmailFields");
  const $emailTo   = el.querySelector("#rsEmailTo");
  const $emailBody = el.querySelector("#rsEmailBody");

  function setStatus(msg, cls) {
    $status.textContent = msg;
    $status.className = "te-status" + (cls ? ` te-status--${cls}` : "");
  }

  function setProgress(pct) {
    $progWrap.style.display = "";
    $progBar.style.width = `${pct}%`;
  }

  // ── Export ────────────────────────────────────────────
  $exportBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    isRunning = true;
    cancelled = false;
    $exportBtn.style.display = "none";
    $cancelBtn.style.display = "";
    $tableWrap.style.display = "none";
    $dlWrap.style.display = "none";
    $summary.style.display = "none";
    setStatus("Fetching roles…");
    setProgress(0);

    try {
      const roles = await gc.fetchAllAuthorizationRoles(api, org.id);
      if (cancelled) return;
      setProgress(10);

      // Progress 10% → 90% across all per-role member count calls
      const counts = await computeMemberCounts(api, org.id, roles, (i, total, roleName) => {
        if (!cancelled) {
          setProgress(10 + Math.round((i / total) * 80));
          setStatus(`Computing members: role ${i} of ${total} — ${roleName}`);
        }
      });
      if (cancelled) return;
      setProgress(92);

      setStatus("Building Excel…");
      const rows = buildRows(roles, counts);
      const wb = buildWorkbook(rows);
      setProgress(97);

      const fname = timestampedFilename(`Roles_${org.name.replace(/\s+/g, "_")}`, "xlsx");
      lastWorkbook = wb;
      lastFilename = fname;

      renderPreviewTable(rows);
      $tableWrap.style.display = "";
      $summary.textContent = `${rows.length} roles — ${org.name}`;
      $summary.style.display = "";
      $dlWrap.style.display = "";
      setProgress(100);

      // Email
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const XLSX = window.XLSX;
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
          const result = await sendEmail(api, {
            recipients: $emailTo.value,
            subject: `Roles Export — ${org.name} — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
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
        setStatus(`Export complete — ${rows.length} roles`, "success");
      }
    } catch (err) {
      if (!cancelled) setStatus(`Error: ${err.message}`, "error");
    } finally {
      isRunning = false;
      $exportBtn.style.display = "";
      $cancelBtn.style.display = "none";
    }
  });

  // ── Cancel ────────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => {
    cancelled = true;
    isRunning = false;
    setStatus("Cancelled.", "error");
    $exportBtn.style.display = "";
    $cancelBtn.style.display = "none";
  });

  // ── Download ──────────────────────────────────────────
  $dlBtn.addEventListener("click", () => {
    if (!lastWorkbook) return;
    const XLSX = window.XLSX;
    const b64 = XLSX.write(lastWorkbook, { bookType: "xlsx", type: "base64" });
    const helperUrl = new URL("download.html", document.baseURI);
    helperUrl.hash = encodeURIComponent(lastFilename) + "|" + b64;
    const popup = window.open(helperUrl.href, "_blank");
    if (!popup) setStatus("Pop-up blocked. Please allow pop-ups for this site.", "error");
  });

  // ── Email toggle ──────────────────────────────────────
  $emailChk.addEventListener("change", () => {
    $emailFld.style.display = $emailChk.checked ? "" : "none";
  });

  // ── Preview table with dropdown column filters ──────────
  function renderPreviewTable(rows) {
    let html = `<details class="te-details">`;
    html += `<summary class="te-sheet-title">Preview <span class="te-user-count">${rows.length} roles</span></summary>`;
    html += `<div class="te-table-scroll"><table class="data-table ll-preview-table"><thead>`;
    html += `<tr>${HEADERS.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
    html += `<tr class="ll-filter-row">${HEADERS.map(() => `<th></th>`).join("")}</tr>`;
    html += `</thead><tbody>`;
    for (const r of rows) {
      html += `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.description)}</td>
        <td style="text-align:right">${r.members}</td>
      </tr>`;
    }
    html += `</tbody></table></div></details>`;
    $tableWrap.innerHTML = html;

    attachColumnFilters($tableWrap, {
      filterCols: [0, 1, 2],
      countEl: $tableWrap.querySelector(".te-user-count"),
      totalLabel: "roles",
    });
  }

  return el;
}
