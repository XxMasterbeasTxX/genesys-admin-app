/**
 * Export › Users — All Roles
 *
 * Exports all users (active, inactive, and deleted) with their role
 * assignments for the selected org. One row per (user, role, source)
 * combination. Users with no roles are excluded entirely.
 *
 * Flow:
 *   1. Fetch all users with expand=authorization,dateLastLogin (state=any)
 *   2b. Fetch group memberships for users that have at least one role
 *   3. Resolve group role grants + display names for all unique groups
 *   4. Build rows with Assigned / Assigned by attribution
 *   5. Display as collapsible HTML table + downloadable Excel
 *
 * Assigned:    "Manually assigned" | "Inherited"
 * Assigned by: "User"              | <group display name>
 *
 * Note: attribution is group-based. If a role is covered by one or more
 * groups it is marked Inherited (one row per group). If it is not covered
 * by any group it is marked Manually assigned. In the rare edge-case where
 * a role is both directly assigned AND inherited via a group, only the
 * Inherited rows are shown (matching the Roles › Permissions vs. Users page
 * behaviour).
 */
import { escapeHtml, timestampedFilename } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { sendEmail } from "../../../services/emailService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { buildStyledWorkbook } from "../../../utils/excelStyles.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";
import { logAction } from "../../../services/activityLogService.js";

// ── Automation ──────────────────────────────────────────
const AUTOMATION_ENABLED = true;
const AUTOMATION_EXPORT_TYPE = "allRoles";
const AUTOMATION_EXPORT_LABEL = "Users All Roles";

// ── Columns ─────────────────────────────────────────────
const HEADERS = ["Index", "Name", "Email", "Division", "Active", "Date Last Login", "Role", "Assigned", "Assigned by"];

/** Format a dateLastLogin value to Danish locale. */
function formatLastLogin(dateStr) {
  if (!dateStr) return "Never";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "Never";
    return d.toLocaleString("da-DK", {
      timeZone: "Europe/Copenhagen",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return "Never"; }
}

/** Run async tasks with bounded concurrency. */
async function runBatched(tasks, concurrency = 10) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) await tasks[idx++]();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

/**
 * Build rows: one row per (user, role, source) combination.
 * - Users with no roles are excluded entirely.
 * - If a role is not covered by any group → 1 row: Manually assigned / User.
 * - If a role is covered by N groups → N rows: Inherited / <group name> each.
 */
function buildRowsWithAttribution(users, userGroupMap, groupGrantsCache, groupNameCache) {
  const rows = [];
  let userIndex = 1;

  for (const user of users) {
    const roles = user.authorization?.roles || [];
    if (roles.length === 0) continue;

    const name       = user.name || "N/A";
    const email      = user.email || "N/A";
    const division   = user.division?.name || "N/A";
    const active     = user.state || "N/A";
    const lastLogin  = formatLastLogin(user.dateLastLogin);
    const userGroups = userGroupMap.get(user.id) || [];

    // Collect all role IDs that any of this user's groups grant
    const groupRoleIds = new Set();
    for (const g of userGroups) {
      for (const grant of (groupGrantsCache.get(g.id) || [])) {
        if (grant.role?.id) groupRoleIds.add(grant.role.id);
      }
    }

    for (const roleObj of roles) {
      const roleId   = roleObj.id || roleObj.roleId;
      const roleName = roleObj.name || roleId || "";
      if (!roleName) continue;

      const sources = [];

      // Not in any group → directly assigned
      if (!groupRoleIds.has(roleId)) {
        sources.push({ assigned: "Manually assigned", assignedBy: "User" });
      }

      // One row per group that grants this role
      for (const g of userGroups) {
        if ((groupGrantsCache.get(g.id) || []).some(gr => gr.role?.id === roleId)) {
          sources.push({ assigned: "Inherited", assignedBy: groupNameCache.get(g.id) || g.name || g.id });
        }
      }

      // Fallback — should not occur
      if (sources.length === 0) {
        sources.push({ assigned: "Manually assigned", assignedBy: "User" });
      }

      for (const src of sources) {
        rows.push({ index: userIndex, name, email, division, active, lastLogin,
                    role: roleName, assigned: src.assigned, assignedBy: src.assignedBy });
      }
    }

    userIndex++;
  }

  return rows;
}

/**
 * Build styled Excel workbook matching Python formatting.
 * Sheet name: "Users Roles Export"
 */
function buildWorkbook(rows) {
  const wsData = [HEADERS];
  for (const r of rows) {
    wsData.push([r.index, r.name, r.email, r.division, r.active, r.lastLogin,
                 r.role, r.assigned, r.assignedBy]);
  }
  return buildStyledWorkbook(wsData, "Users Roles Export");
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderAllRolesExport({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning = false;
  let cancelled = false;

  el.innerHTML = `
    <h1 class="h1">Export — Users — All Roles</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports all users (active, inactive, and deleted) with their role
      assignments for the selected org. One row per (user, role, source)
      combination — users with no roles are excluded. Includes
      <strong>Assigned</strong> (Manually assigned / Inherited) and
      <strong>Assigned by</strong> (User / Group name) columns.
    </p>

    <div class="te-actions">
      <button class="btn te-btn-export" id="arExportBtn">Export All Roles</button>
      <button class="btn te-btn-cancel" id="arCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="arStatus"></div>

    <div class="te-progress-wrap" id="arProgressWrap" style="display:none">
      <div class="te-progress-bar" id="arProgressBar"></div>
    </div>

    <div id="arTableWrap" style="display:none"></div>

    <div class="wc-summary" id="arSummary" style="display:none"></div>

    <div id="arDownload" style="display:none">
      <button class="btn te-btn-export" id="arDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="arEmailChk">
        <span>Send email with export</span>
      </label>

      <div class="em-fields" id="arEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="arEmailTo">Recipients</label>
          <input type="text" class="em-input" id="arEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="arEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="arEmailBody" rows="3"
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
    });
    el.appendChild(schedulePanel);
  }

  // ── References ────────────────────────────────────────
  const $btn       = el.querySelector("#arExportBtn");
  const $cancel    = el.querySelector("#arCancelBtn");
  const $status    = el.querySelector("#arStatus");
  const $progWrap  = el.querySelector("#arProgressWrap");
  const $progBar   = el.querySelector("#arProgressBar");
  const $table     = el.querySelector("#arTableWrap");
  const $summary   = el.querySelector("#arSummary");
  const $dlWrap    = el.querySelector("#arDownload");
  const $dlBtn     = el.querySelector("#arDownloadBtn");
  const $emailChk  = el.querySelector("#arEmailChk");
  const $emailFld  = el.querySelector("#arEmailFields");
  const $emailTo   = el.querySelector("#arEmailTo");
  const $emailBody = el.querySelector("#arEmailBody");

  let lastWorkbook = null;
  let lastFilename = null;

  function setStatus(msg, cls) {
    $status.textContent = msg;
    $status.className = "te-status" + (cls ? ` te-status--${cls}` : "");
  }

  function setProgress(pct) {
    $progWrap.style.display = "";
    $progBar.style.width = `${pct}%`;
  }

  // ── Export flow ───────────────────────────────────────
  $btn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    isRunning = true;
    cancelled = false;
    $btn.style.display = "none";
    $cancel.style.display = "";
    $table.style.display = "none";
    $dlWrap.style.display = "none";
    $summary.style.display = "none";
    setStatus("Starting export…");
    setProgress(0);

    try {
      // Phase 1: Fetch all users with roles + dateLastLogin (0–45%)
      setStatus("Fetching users and role assignments…");
      setProgress(5);
      const allUsers = await gc.fetchAllUsers(api, org.id, {
        expand: ["authorization", "dateLastLogin"],
        state: "any",
        onProgress: (n) => setProgress(5 + Math.min((n / 500) * 38, 38)),
      });
      if (cancelled) return;
      setProgress(45);

      // Phase 2b: Fetch group memberships for users that have at least one role (45–70%)
      const usersWithRoles = allUsers.filter(u => u.authorization?.roles?.length > 0);
      const userGroupMap = new Map();
      if (usersWithRoles.length > 0) {
        setStatus(`Fetching group memberships for ${usersWithRoles.length} users…`);
        let grpFetched = 0;
        await runBatched(
          usersWithRoles.map(user => async () => {
            if (cancelled) return;
            try {
              const detail = await api.proxyGenesys(org.id, "GET", `/api/v2/users/${user.id}`, { query: { expand: "groups" } });
              userGroupMap.set(user.id, detail.groups || []);
            } catch {
              userGroupMap.set(user.id, []);
            }
            setProgress(45 + Math.min((++grpFetched / usersWithRoles.length) * 25, 25));
          }),
          10
        );
      }
      if (cancelled) return;
      setProgress(70);

      // Phase 3: Resolve group role grants + display names (70–85%)
      const allGroupIds = new Set([...userGroupMap.values()].flatMap(gs => gs.map(g => g.id)));
      const groupGrantsCache = new Map();
      const groupNameCache   = new Map();
      if (allGroupIds.size > 0) {
        setStatus(`Resolving ${allGroupIds.size} group role grants…`);
        let gsFetched = 0;
        await runBatched(
          [...allGroupIds].map(groupId => async () => {
            if (cancelled) return;
            try {
              const [gs, gd] = await Promise.all([
                api.proxyGenesys(org.id, "GET", `/api/v2/authorization/subjects/${groupId}`),
                api.proxyGenesys(org.id, "GET", `/api/v2/groups/${groupId}`),
              ]);
              groupGrantsCache.set(groupId, gs.grants || []);
              groupNameCache.set(groupId, gd.name || groupId);
            } catch {
              groupGrantsCache.set(groupId, []);
            }
            setProgress(70 + Math.min((++gsFetched / allGroupIds.size) * 15, 15));
          }),
          10
        );
      }
      if (cancelled) return;
      setProgress(85);

      // Phase 4: Build rows with attribution (85–90%)
      setStatus("Processing role data…");
      const rows = buildRowsWithAttribution(allUsers, userGroupMap, groupGrantsCache, groupNameCache);
      setProgress(90);

      // Phase 5: Build Excel (90–95%)
      setStatus("Building Excel…");
      const wb = buildWorkbook(rows);
      setProgress(95);

      const fname = timestampedFilename(`AllRoles_${org.name.replace(/\s+/g, "_")}`, "xlsx");
      lastWorkbook = wb;
      lastFilename = fname;

      // Show preview table (collapsed by default)
      renderPreviewTable(rows);
      $table.style.display = "";

      // Summary
      const uniqueUsers = new Set(rows.map(r => r.email)).size;
      $summary.textContent = `${uniqueUsers} users, ${rows.length} rows`;
      $summary.style.display = "";

      // Download button
      $dlWrap.style.display = "";

      setProgress(100);
      logAction({ me, orgId: org?.id || "", orgName: org?.name || "", action: "export_run",
        description: `Exported '${AUTOMATION_EXPORT_LABEL}' for '${org?.name || ""}'` });

      // Send email if enabled
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const XLSX = window.XLSX;
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });

          const result = await sendEmail(api, {
            recipients: $emailTo.value,
            subject: `All Roles Export — ${org.name} — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
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
            setStatus(`Export completed but email failed: ${result.error}`, "error");
          }
        } catch (emailErr) {
          setStatus(`Export completed but email failed: ${emailErr.message}`, "error");
        }
      } else {
        setStatus(`Export complete — ${org.name}`, "success");
      }
    } catch (err) {
      if (!cancelled) setStatus(`Error: ${err.message}`, "error");
    } finally {
      isRunning = false;
      $btn.style.display = "";
      $cancel.style.display = "none";
    }
  });

  // ── Cancel ────────────────────────────────────────────
  $cancel.addEventListener("click", () => {
    cancelled = true;
    isRunning = false;
    setStatus("Cancelled.", "error");
    $btn.style.display = "";
    $cancel.style.display = "none";
  });

  // ── Download ──────────────────────────────────────────
  $dlBtn.addEventListener("click", () => {
    if (!lastWorkbook || !lastFilename) return;
    const XLSX = window.XLSX;
    const b64 = XLSX.write(lastWorkbook, { bookType: "xlsx", type: "base64" });
    const key = "xlsx_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    window._xlsxDownload = window._xlsxDownload || {};
    window._xlsxDownload[key] = { filename: lastFilename, b64 };

    const helperUrl = new URL("download.html", document.baseURI);
    helperUrl.hash = key;

    const popup = window.open(helperUrl.href, "_blank");
    if (!popup) {
      delete window._xlsxDownload[key];
      setStatus("Pop-up blocked. Please allow pop-ups for this site.", "error");
    }
  });

  // ── Email toggle ──────────────────────────────────────
  $emailChk.addEventListener("change", () => {
    $emailFld.style.display = $emailChk.checked ? "" : "none";
  });

  // ── Preview table with dropdown column filters ──────────
  function renderPreviewTable(rows) {
    let html = `<details class="te-details">`;
    html += `<summary class="te-sheet-title">Preview <span class="te-user-count">${rows.length} rows</span></summary>`;
    html += `<div class="te-table-scroll"><table class="data-table ll-preview-table"><thead><tr>`;
    for (const h of HEADERS) html += `<th>${escapeHtml(h)}</th>`;
    html += `</tr><tr class="ll-filter-row">`;
    for (let i = 0; i < HEADERS.length; i++) html += `<th></th>`;
    html += `</tr></thead><tbody>`;

    for (const r of rows) {
      html += `<tr>
        <td>${r.index}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(r.division)}</td>
        <td>${escapeHtml(r.active)}</td>
        <td>${escapeHtml(r.lastLogin)}</td>
        <td>${escapeHtml(r.role)}</td>
        <td>${escapeHtml(r.assigned)}</td>
        <td>${escapeHtml(r.assignedBy)}</td>
      </tr>`;
    }

    html += `</tbody></table></div></details>`;
    $table.innerHTML = html;

    attachColumnFilters($table, {
      skipCols: [0],
      countEl: $table.querySelector(".te-user-count"),
      totalLabel: "rows",
    });
  }

  return el;
}
