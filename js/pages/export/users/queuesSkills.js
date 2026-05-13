/**
 * Export › Users — Queues/Skills
 *
 * Phase 1:
 * - Manual export flow (no scheduling yet)
 * - Separate multi-select filters for User, Group, Work Team, Queue, Skill, Language Skill
 * - At least one filter is required before loading results
 * - Preview + Excel with columns: Name, Queue, Skill, Language Skill
 * - One row per user assignment combination (blank values when a dimension has no assignments)
 */
import { escapeHtml, timestampedFilename } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import { buildStyledWorkbook } from "../../../utils/excelStyles.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";
import { logAction } from "../../../services/activityLogService.js";

const HEADERS = ["Name", "Queue", "Skill", "Language Skill"];

function hasAnyFilter(sel) {
  return (
    sel.users.size > 0 ||
    sel.groups.size > 0 ||
    sel.teams.size > 0 ||
    sel.queues.size > 0 ||
    sel.skills.size > 0 ||
    sel.languages.size > 0
  );
}

function toNameArray(items, nameKeys = ["name"]) {
  return (items || [])
    .map((x) => {
      for (const k of nameKeys) {
        if (x?.[k]) return String(x[k]);
      }
      return "";
    })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function buildRows(users, queueMap) {
  const rows = [];

  for (const user of users) {
    const name = user.name || "N/A";

    const queueNames = (queueMap.get(user.id) || [])
      .map((q) => q.queueName || "")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    const skillNames = toNameArray(user.skills, ["name", "skillName"]);
    const languageNames = toNameArray(user.languages, ["name", "languageName"]);

    const qVals = queueNames.length ? queueNames : [""];
    const sVals = skillNames.length ? skillNames : [""];
    const lVals = languageNames.length ? languageNames : [""];

    for (const q of qVals) {
      for (const s of sVals) {
        for (const l of lVals) {
          rows.push({ name, queue: q, skill: s, languageSkill: l });
        }
      }
    }
  }

  return rows;
}

function buildWorkbook(rows) {
  const wsData = [HEADERS];
  for (const r of rows) {
    wsData.push([r.name, r.queue, r.skill, r.languageSkill]);
  }
  return buildStyledWorkbook(wsData, "Users Queues Skills Export");
}

function userMatchesNonQueueFilters(user, sel) {
  if (sel.users.size > 0 && !sel.users.has(user.id)) return false;

  if (sel.groups.size > 0) {
    const groupIds = new Set((user.groups || []).map((g) => g.id).filter(Boolean));
    const hasGroup = [...sel.groups].some((id) => groupIds.has(id));
    if (!hasGroup) return false;
  }

  if (sel.teams.size > 0) {
    const teamId = user.team?.id || "";
    if (!teamId || !sel.teams.has(teamId)) return false;
  }

  if (sel.skills.size > 0) {
    const skillIds = new Set((user.skills || []).map((s) => s.id).filter(Boolean));
    const hasSkill = [...sel.skills].some((id) => skillIds.has(id));
    if (!hasSkill) return false;
  }

  if (sel.languages.size > 0) {
    const langIds = new Set((user.languages || []).map((l) => l.id).filter(Boolean));
    const hasLang = [...sel.languages].some((id) => langIds.has(id));
    if (!hasLang) return false;
  }

  return true;
}

async function fetchQueuesForUsers(api, orgId, users, onProgress) {
  const queueMap = new Map();
  const concurrency = 8;
  let idx = 0;
  let done = 0;

  async function worker() {
    while (idx < users.length) {
      const i = idx++;
      const u = users[i];
      try {
        const queues = await gc.getUserQueues(api, orgId, u.id);
        queueMap.set(u.id, queues || []);
      } catch {
        queueMap.set(u.id, []);
      }
      done++;
      onProgress?.(done, users.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, users.length)) }, () => worker());
  await Promise.all(workers);
  return queueMap;
}

export default function renderQueuesSkillsExport({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  let isRunning = false;
  let cancelled = false;
  let cleanupColumnFilters = null;

  let lastWorkbook = null;
  let lastFilename = null;

  el.innerHTML = `
    <h1 class="h1">Export — Users — Queues/Skills</h1>
    <hr class="hr">
    <p class="page-desc">
      Export users and their queue, skill, and language skill assignments.
      One row per assignment combination with blank values where a user has no assignments in a dimension.
    </p>

    <div class="te-actions" style="margin-bottom:10px">
      <button class="btn te-btn-export" id="qsLoadFiltersBtn">Load Filter Values</button>
    </div>

    <div id="qsFiltersWrap" style="display:none">
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start">
        <div style="min-width:200px;flex:1">
          <label class="sp-form-label">User</label>
          <div id="qsUserFilter"></div>
        </div>
        <div style="min-width:200px;flex:1">
          <label class="sp-form-label">Groups</label>
          <div id="qsGroupFilter"></div>
        </div>
        <div style="min-width:200px;flex:1">
          <label class="sp-form-label">Work Teams</label>
          <div id="qsTeamFilter"></div>
        </div>
        <div style="min-width:200px;flex:1">
          <label class="sp-form-label">Queues</label>
          <div id="qsQueueFilter"></div>
        </div>
        <div style="min-width:200px;flex:1">
          <label class="sp-form-label">Skills</label>
          <div id="qsSkillFilter"></div>
        </div>
        <div style="min-width:200px;flex:1">
          <label class="sp-form-label">Language Skills</label>
          <div id="qsLanguageFilter"></div>
        </div>
      </div>

      <div class="te-actions" style="margin-top:12px">
        <button class="btn te-btn-export" id="qsRunBtn" disabled>Load Results</button>
        <button class="btn te-btn-cancel" id="qsCancelBtn" style="display:none">Cancel</button>
      </div>
      <p class="sp-form-hint" style="margin-top:6px">Select at least one filter before loading results.</p>
    </div>

    <div class="te-status" id="qsStatus"></div>

    <div class="te-progress-wrap" id="qsProgressWrap" style="display:none">
      <div class="te-progress-bar" id="qsProgressBar"></div>
    </div>

    <div id="qsTableWrap" style="display:none"></div>

    <div class="wc-summary" id="qsSummary" style="display:none"></div>

    <div id="qsDownload" style="display:none">
      <button class="btn te-btn-export" id="qsDownloadBtn">Download Excel</button>
    </div>
  `;

  const $loadFiltersBtn = el.querySelector("#qsLoadFiltersBtn");
  const $filtersWrap = el.querySelector("#qsFiltersWrap");
  const $status = el.querySelector("#qsStatus");
  const $progWrap = el.querySelector("#qsProgressWrap");
  const $progBar = el.querySelector("#qsProgressBar");
  const $runBtn = el.querySelector("#qsRunBtn");
  const $cancelBtn = el.querySelector("#qsCancelBtn");
  const $table = el.querySelector("#qsTableWrap");
  const $summary = el.querySelector("#qsSummary");
  const $dlWrap = el.querySelector("#qsDownload");
  const $dlBtn = el.querySelector("#qsDownloadBtn");

  const userFilter = createMultiSelect({ placeholder: "Select user(s)…", searchable: true, onChange: updateRunButton });
  const groupFilter = createMultiSelect({ placeholder: "Select group(s)…", searchable: true, onChange: updateRunButton });
  const teamFilter = createMultiSelect({ placeholder: "Select work team(s)…", searchable: true, onChange: updateRunButton });
  const queueFilter = createMultiSelect({ placeholder: "Select queue(s)…", searchable: true, onChange: updateRunButton });
  const skillFilter = createMultiSelect({ placeholder: "Select skill(s)…", searchable: true, onChange: updateRunButton });
  const languageFilter = createMultiSelect({ placeholder: "Select language skill(s)…", searchable: true, onChange: updateRunButton });

  el.querySelector("#qsUserFilter").append(userFilter.el);
  el.querySelector("#qsGroupFilter").append(groupFilter.el);
  el.querySelector("#qsTeamFilter").append(teamFilter.el);
  el.querySelector("#qsQueueFilter").append(queueFilter.el);
  el.querySelector("#qsSkillFilter").append(skillFilter.el);
  el.querySelector("#qsLanguageFilter").append(languageFilter.el);

  function setStatus(msg, cls) {
    $status.textContent = msg;
    $status.className = "te-status" + (cls ? ` te-status--${cls}` : "");
  }

  function setProgress(pct) {
    $progWrap.style.display = "";
    $progBar.style.width = `${pct}%`;
  }

  function getSelection() {
    return {
      users: userFilter.getSelected(),
      groups: groupFilter.getSelected(),
      teams: teamFilter.getSelected(),
      queues: queueFilter.getSelected(),
      skills: skillFilter.getSelected(),
      languages: languageFilter.getSelected(),
    };
  }

  function updateRunButton() {
    $runBtn.disabled = !hasAnyFilter(getSelection());
  }

  async function loadFilterValues() {
    const org = orgContext?.getDetails?.();
    if (!org) {
      setStatus("Please select a customer org first.", "error");
      return;
    }

    $loadFiltersBtn.disabled = true;
    setStatus("Loading filter values…");

    try {
      const [users, groups, teams, queues, skills, languages] = await Promise.all([
        gc.fetchAllUsers(api, org.id, { state: "any" }),
        gc.fetchAllGroups(api, org.id),
        gc.fetchAllTeams(api, org.id),
        gc.fetchAllQueues(api, org.id),
        gc.fetchAllSkills(api, org.id),
        gc.fetchAllLanguages(api, org.id),
      ]);

      userFilter.setItems((users || []).map((u) => ({ id: u.id, label: u.name || u.email || u.id })));
      groupFilter.setItems((groups || []).map((g) => ({ id: g.id, label: g.name || g.id })));
      teamFilter.setItems((teams || []).map((t) => ({ id: t.id, label: t.name || t.id })));
      queueFilter.setItems((queues || []).map((q) => ({ id: q.id, label: q.name || q.id })));
      skillFilter.setItems((skills || []).map((s) => ({ id: s.id, label: s.name || s.id })));
      languageFilter.setItems((languages || []).map((l) => ({ id: l.id, label: l.name || l.id })));

      $filtersWrap.style.display = "";
      updateRunButton();
      setStatus(`Loaded filters for ${org.name}. Select at least one filter and click Load Results.`);
    } catch (err) {
      setStatus(`Failed to load filter values: ${err.message}`, "error");
    } finally {
      $loadFiltersBtn.disabled = false;
    }
  }

  $loadFiltersBtn.addEventListener("click", loadFilterValues);

  $runBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) {
      setStatus("Please select a customer org first.", "error");
      return;
    }

    const sel = getSelection();
    if (!hasAnyFilter(sel)) {
      setStatus("Please select at least one filter before loading results.", "error");
      return;
    }

    isRunning = true;
    cancelled = false;
    $runBtn.style.display = "none";
    $cancelBtn.style.display = "";
    $table.style.display = "none";
    $summary.style.display = "none";
    $dlWrap.style.display = "none";
    setStatus("Loading users…");
    setProgress(0);

    try {
      // 1) Fetch users with non-queue assignments needed for filtering + export
      const allUsers = await gc.fetchAllUsers(api, org.id, {
        state: "any",
        expand: ["groups", "team", "skills", "languages"],
        onProgress: (n) => setProgress(5 + Math.min((n / 1000) * 30, 30)),
      });
      if (cancelled) return;
      setProgress(35);

      // 2) Apply all non-queue filters
      setStatus("Applying filters…");
      let matchedUsers = allUsers.filter((u) => userMatchesNonQueueFilters(u, sel));
      if (cancelled) return;
      setProgress(45);

      // 3) Fetch queues for matched users (needed both for queue filter and output rows)
      setStatus(`Loading queue assignments for ${matchedUsers.length} user(s)…`);
      const queueMap = await fetchQueuesForUsers(api, org.id, matchedUsers, (done, total) => {
        setProgress(45 + Math.round((done / Math.max(total, 1)) * 40));
      });
      if (cancelled) return;

      // 4) Apply queue filter (if any)
      if (sel.queues.size > 0) {
        matchedUsers = matchedUsers.filter((u) => {
          const qIds = new Set((queueMap.get(u.id) || []).map((q) => q.queueId).filter(Boolean));
          return [...sel.queues].some((id) => qIds.has(id));
        });
      }
      setProgress(88);

      // 5) Build rows and workbook
      setStatus("Building preview and Excel…");
      const rows = buildRows(matchedUsers, queueMap);
      const wb = buildWorkbook(rows);
      setProgress(96);

      const fname = timestampedFilename(`QueuesSkills_${org.name.replace(/\s+/g, "_")}`, "xlsx");
      lastWorkbook = wb;
      lastFilename = fname;

      renderPreviewTable(rows);
      $table.style.display = "";

      $summary.textContent = `${matchedUsers.length} matched user(s), ${rows.length} row(s)`;
      $summary.style.display = "";
      $dlWrap.style.display = "";

      setProgress(100);
      setStatus(`Results ready — ${org.name}`, "success");

      logAction({
        me,
        orgId: org?.id || "",
        orgName: org?.name || "",
        action: "export_run",
        description: `Exported 'Users Queues/Skills' for '${org?.name || ""}'`,
      });
    } catch (err) {
      if (!cancelled) setStatus(`Error: ${err.message}`, "error");
    } finally {
      isRunning = false;
      $runBtn.style.display = "";
      $cancelBtn.style.display = "none";
    }
  });

  $cancelBtn.addEventListener("click", () => {
    cancelled = true;
    isRunning = false;
    setStatus("Cancelled.", "error");
    $runBtn.style.display = "";
    $cancelBtn.style.display = "none";
  });

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

  function renderPreviewTable(rows) {
    if (cleanupColumnFilters) {
      cleanupColumnFilters();
      cleanupColumnFilters = null;
    }

    const body = rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.queue)}</td>
        <td>${escapeHtml(r.skill)}</td>
        <td>${escapeHtml(r.languageSkill)}</td>
      </tr>
    `).join("");

    $table.innerHTML = `
      <details class="te-preview" open>
        <summary>
          <span>Preview</span>
          <span class="te-user-count">${rows.length} rows</span>
        </summary>
        <div class="te-table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>${HEADERS[0]}</th>
                <th>${HEADERS[1]}</th>
                <th>${HEADERS[2]}</th>
                <th>${HEADERS[3]}</th>
              </tr>
              <tr class="ll-filter-row">
                <th></th><th></th><th></th><th></th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </details>
    `;

    cleanupColumnFilters = attachColumnFilters($table, {
      countEl: $table.querySelector(".te-user-count"),
      totalLabel: "rows",
    });
  }

  return el;
}
