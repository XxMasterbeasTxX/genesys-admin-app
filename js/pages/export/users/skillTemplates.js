/**
 * Export › Users — Skill/Role/Queue Templates
 *
 * Exports selected templates to a multi-sheet Excel workbook:
 *   1. Overview — template name, counts per category, user/group/team counts
 *   2. Roles — template × role × divisions
 *   3. Skills — template × skill × proficiency
 *   4. Languages — template × language × proficiency
 *   5. Queues — template × queue
 *   6. Members — template × type (User/Group/Work Team) × name × assignedBy
 *
 * Flow:
 *   1. Load Templates → fetch all templates + assignments for the selected org
 *   2. User picks one or more templates via checkboxes (Select All / None)
 *   3. Export → build 6-sheet workbook, preview, download
 */
import { escapeHtml, timestampedFilename } from "../../../utils.js";
import { sendEmail } from "../../../services/emailService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { buildStyledWorkbook, addStyledSheet } from "../../../utils/excelStyles.js";
import { logAction } from "../../../services/activityLogService.js";
import { fetchTemplates } from "../../../services/templateService.js";
import { fetchAssignments } from "../../../services/templateAssignmentService.js";

// ── Automation ──────────────────────────────────────────
const AUTOMATION_ENABLED = true;
const AUTOMATION_EXPORT_TYPE = "skillTemplates";
const AUTOMATION_EXPORT_LABEL = "Skill/Role/Queue Templates";

// ── Page renderer ───────────────────────────────────────

export default function renderSkillTemplatesExport({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning = false;
  let cancelled = false;

  el.innerHTML = `
    <h1 class="h1">Export — Users — Skill/Role/Queue Templates</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports selected templates to a multi-sheet Excel workbook containing
      an overview, roles, skills, languages, queues and assigned members.
    </p>

    <!-- Phase 1: Load templates -->
    <div class="te-actions">
      <button class="btn te-btn-export" id="stLoadBtn">Load Templates</button>
    </div>

    <div id="stTemplatesWrap" style="display:none;margin-top:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span id="stCount" class="te-user-count"></span>
        <button class="btn btn-sm" id="stSelectAll">Select All</button>
        <button class="btn btn-sm" id="stSelectNone">Select None</button>
      </div>
      <div id="stList"
           style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;padding:6px 10px"></div>
    </div>

    <!-- Phase 2: Export -->
    <div id="stExportWrap" style="display:none;margin-top:14px">
      <div class="te-actions">
        <button class="btn te-btn-export" id="stExportBtn" disabled>Export Templates</button>
        <button class="btn te-btn-cancel" id="stCancelBtn" style="display:none">Cancel</button>
      </div>
    </div>

    <div class="te-status" id="stStatus"></div>

    <div class="te-progress-wrap" id="stProgressWrap" style="display:none">
      <div class="te-progress-bar" id="stProgressBar"></div>
    </div>

    <div id="stTableWrap" style="display:none"></div>

    <div class="wc-summary" id="stSummary" style="display:none"></div>

    <div id="stDownload" style="display:none">
      <button class="btn te-btn-export" id="stDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="stEmailChk">
        <span>Send email with export</span>
      </label>

      <div class="em-fields" id="stEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="stEmailTo">Recipients</label>
          <input type="text" class="em-input" id="stEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="stEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="stEmailBody" rows="3"
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
      dynamicOrgFields: async (orgId) => {
        const templates = await fetchTemplates(orgId);
        return [{
          key: "templates",
          label: "Templates to export",
          options: templates
            .map(t => t.name)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
        }];
      },
      configSummary: (cfg) => {
        const templates = cfg.templates || [];
        if (!templates.length) return "—";
        const shown = templates.slice(0, 2).join(", ");
        return templates.length > 2 ? `${shown} +${templates.length - 2} more` : shown;
      },
    });
    el.appendChild(schedulePanel);
  }

  // ── References ────────────────────────────────────────
  const $loadBtn      = el.querySelector("#stLoadBtn");
  const $templWrap    = el.querySelector("#stTemplatesWrap");
  const $count        = el.querySelector("#stCount");
  const $list         = el.querySelector("#stList");
  const $selectAll    = el.querySelector("#stSelectAll");
  const $selectNone   = el.querySelector("#stSelectNone");
  const $exportWrap   = el.querySelector("#stExportWrap");
  const $exportBtn    = el.querySelector("#stExportBtn");
  const $cancelBtn    = el.querySelector("#stCancelBtn");
  const $status       = el.querySelector("#stStatus");
  const $progWrap     = el.querySelector("#stProgressWrap");
  const $progBar      = el.querySelector("#stProgressBar");
  const $tableWrap    = el.querySelector("#stTableWrap");
  const $summary      = el.querySelector("#stSummary");
  const $dlWrap       = el.querySelector("#stDownload");
  const $dlBtn        = el.querySelector("#stDownloadBtn");
  const $emailChk     = el.querySelector("#stEmailChk");
  const $emailFld     = el.querySelector("#stEmailFields");
  const $emailTo      = el.querySelector("#stEmailTo");
  const $emailBody    = el.querySelector("#stEmailBody");

  let allTemplates = [];
  let allAssignments = [];
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

  function getChecked() {
    return Array.from($list.querySelectorAll(".st-chk:checked")).map(cb => cb.value);
  }

  function updateExportBtn() {
    $exportBtn.disabled = getChecked().length === 0;
  }

  // ── Phase 1: Load Templates ───────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    setStatus("Loading templates…");
    $loadBtn.disabled = true;
    $templWrap.style.display = "none";
    $exportWrap.style.display = "none";

    try {
      [allTemplates, allAssignments] = await Promise.all([
        fetchTemplates(org.id),
        fetchAssignments(org.id),
      ]);

      allTemplates.sort((a, b) =>
        (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
      );

      $list.innerHTML = allTemplates.map(t =>
        `<label style="display:block;white-space:nowrap;margin-bottom:3px">
          <input type="checkbox" class="st-chk" value="${escapeHtml(t.id)}">
          ${escapeHtml(t.name || "Unnamed")}
        </label>`
      ).join("");

      $list.querySelectorAll(".st-chk").forEach(cb =>
        cb.addEventListener("change", updateExportBtn)
      );

      $count.textContent = `${allTemplates.length} template(s)`;
      $templWrap.style.display = "";
      $exportWrap.style.display = "";
      $exportBtn.disabled = true;
      setStatus(`Loaded ${allTemplates.length} templates for ${org.name}. Select at least one and click Export.`);
    } catch (err) {
      setStatus(`Error loading templates: ${err.message}`, "error");
    } finally {
      $loadBtn.disabled = false;
    }
  });

  $selectAll.addEventListener("click", () => {
    $list.querySelectorAll(".st-chk").forEach(cb => { cb.checked = true; });
    updateExportBtn();
  });

  $selectNone.addEventListener("click", () => {
    $list.querySelectorAll(".st-chk").forEach(cb => { cb.checked = false; });
    updateExportBtn();
  });

  // ── Phase 2: Export ───────────────────────────────────
  $exportBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    const selectedIds = getChecked();
    if (!selectedIds.length) { setStatus("Select at least one template.", "error"); return; }

    const selected = new Set(selectedIds);
    const templates = allTemplates.filter(t => selected.has(t.id));

    isRunning = true;
    cancelled = false;
    $exportBtn.style.display = "none";
    $cancelBtn.style.display = "";
    $tableWrap.style.display = "none";
    $dlWrap.style.display = "none";
    $summary.style.display = "none";
    setStatus("Building export…");
    setProgress(0);

    try {
      // Build assignment lookup: templateId → [assignment]
      const assignMap = new Map();
      for (const a of allAssignments) {
        if (!selected.has(a.templateId)) continue;
        if (!assignMap.has(a.templateId)) assignMap.set(a.templateId, []);
        assignMap.get(a.templateId).push(a);
      }
      setProgress(10);
      if (cancelled) return;

      // Sheet 1: Overview
      const overviewData = [["Template", "Roles", "Skills", "Languages", "Queues", "Users", "Groups", "Teams"]];
      for (const t of templates) {
        const assigns = assignMap.get(t.id) || [];
        const users  = assigns.filter(a => !a.type || a.type === "user").length;
        const groups = assigns.filter(a => a.type === "group").length;
        const teams  = assigns.filter(a => a.type === "workteam").length;
        overviewData.push([
          t.name,
          (t.roles || []).length,
          (t.skills || []).length,
          (t.languages || []).length,
          (t.queues || []).length,
          users,
          groups,
          teams,
        ]);
      }
      setProgress(20);

      // Sheet 2: Roles (one row per role × division)
      const rolesData = [["Template", "Role", "Division"]];
      for (const t of templates) {
        for (const r of (t.roles || [])) {
          const roleName = r.roleName || r.name || String(r);
          const divs = r.divisions || [];
          if (divs.length) {
            for (const d of divs) {
              rolesData.push([t.name, roleName, d.divisionName || d.name || String(d)]);
            }
          } else {
            rolesData.push([t.name, roleName, ""]);
          }
        }
      }
      setProgress(35);

      // Sheet 3: Skills
      const skillsData = [["Template", "Skill", "Proficiency"]];
      for (const t of templates) {
        for (const s of (t.skills || [])) {
          skillsData.push([t.name, s.skillName || s.name || String(s), s.proficiency ?? ""]);
        }
      }
      setProgress(50);

      // Sheet 4: Languages
      const langsData = [["Template", "Language", "Proficiency"]];
      for (const t of templates) {
        for (const l of (t.languages || [])) {
          langsData.push([t.name, l.languageName || l.name || String(l), l.proficiency ?? ""]);
        }
      }
      setProgress(60);

      // Sheet 5: Queues
      const queuesData = [["Template", "Queue"]];
      for (const t of templates) {
        for (const q of (t.queues || [])) {
          queuesData.push([t.name, q.queueName || q.name || String(q)]);
        }
      }
      setProgress(70);

      // Sheet 6: Members
      const membersData = [["Template", "Type", "Name", "Assigned By"]];
      for (const t of templates) {
        for (const a of (assignMap.get(t.id) || [])) {
          const type = a.type || "user";
          const label = type === "group" ? "Group" : type === "workteam" ? "Work Team" : "User";
          const name  = type === "group" ? (a.groupName || a.groupId)
                      : type === "workteam" ? (a.workteamName || a.workteamId)
                      : (a.userName || a.userId);
          membersData.push([t.name, label, name, a.assignedBy || ""]);
        }
      }
      setProgress(80);
      if (cancelled) return;

      // Build multi-sheet workbook
      setStatus("Building Excel workbook…");
      const wb = buildStyledWorkbook(overviewData, "Overview");
      addStyledSheet(wb, rolesData, "Roles");
      addStyledSheet(wb, skillsData, "Skills");
      addStyledSheet(wb, langsData, "Languages");
      addStyledSheet(wb, queuesData, "Queues");
      addStyledSheet(wb, membersData, "Members");
      setProgress(95);

      const fname = timestampedFilename(`SkillTemplates_${org.name.replace(/\s+/g, "_")}`, "xlsx");
      lastWorkbook = wb;
      lastFilename = fname;

      // Preview
      renderPreview(templates, assignMap);
      $tableWrap.style.display = "";

      const allAssigns = templates.flatMap(t => assignMap.get(t.id) || []);
      const uCt = allAssigns.filter(a => !a.type || a.type === "user").length;
      const gCt = allAssigns.filter(a => a.type === "group").length;
      const tCt = allAssigns.filter(a => a.type === "workteam").length;
      $summary.textContent = `${templates.length} template(s) exported — ${uCt} user(s), ${gCt} group(s), ${tCt} team(s)`;
      $summary.style.display = "";
      $dlWrap.style.display = "";
      setProgress(100);
      logAction({ me, orgId: org?.id || "", orgName: org?.name || "", action: "export_run",
        description: `Exported '${AUTOMATION_EXPORT_LABEL}' for '${org?.name || ""}'` });

      // Email
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          const XLSX = window.XLSX;
          const xlsxB64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
          const result = await sendEmail(api, {
            recipients: $emailTo.value,
            subject: `Skill Templates Export — ${org.name} — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
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
        setStatus(`Export complete — ${org.name} — ${templates.length} template(s)`, "success");
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
    if (!lastWorkbook || !lastFilename) return;
    const XLSX = window.XLSX;
    const b64 = XLSX.write(lastWorkbook, { bookType: "xlsx", type: "base64" });
    const key = "xlsx_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    window._xlsxDownload = window._xlsxDownload || {};
    window._xlsxDownload[key] = { filename: lastFilename, b64 };
    const helperUrl = new URL("download.html", document.baseURI);
    helperUrl.hash = key;
    const popup = window.open(helperUrl.href, "_blank");
    if (!popup) { delete window._xlsxDownload[key]; setStatus("Pop-up blocked. Please allow pop-ups for this site.", "error"); }
  });

  // ── Email toggle ──────────────────────────────────────
  $emailChk.addEventListener("change", () => {
    $emailFld.style.display = $emailChk.checked ? "" : "none";
  });

  // ── Preview ───────────────────────────────────────────
  function renderPreview(templates, assignMap) {
    let html = `<details class="te-details">`;
    html += `<summary class="te-sheet-title">Preview <span class="te-user-count">${templates.length} template(s)</span></summary>`;
    html += `<div class="te-table-scroll"><table class="data-table" style="width:auto"><thead><tr>`;
    html += `<th>Template</th><th style="width:80px">Roles</th><th style="width:80px">Skills</th><th style="width:80px">Languages</th><th style="width:80px">Queues</th><th style="width:80px">Users</th><th style="width:80px">Groups</th><th style="width:80px">Teams</th>`;
    html += `</tr></thead><tbody>`;
    for (const t of templates) {
      const assigns = assignMap.get(t.id) || [];
      const uCt = assigns.filter(a => !a.type || a.type === "user").length;
      const gCt = assigns.filter(a => a.type === "group").length;
      const tCt = assigns.filter(a => a.type === "workteam").length;
      html += `<tr>
        <td>${escapeHtml(t.name)}</td>
        <td style="text-align:center">${(t.roles || []).length}</td>
        <td style="text-align:center">${(t.skills || []).length}</td>
        <td style="text-align:center">${(t.languages || []).length}</td>
        <td style="text-align:center">${(t.queues || []).length}</td>
        <td style="text-align:center">${uCt}</td>
        <td style="text-align:center">${gCt}</td>
        <td style="text-align:center">${tCt}</td>
      </tr>`;
    }
    html += `</tbody></table></div></details>`;
    $tableWrap.innerHTML = html;
  }

  return el;
}
