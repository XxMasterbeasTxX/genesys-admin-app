/**
 * Users › Roles, Queues & Skills › Create Template
 *
 * Create, edit, and delete templates stored in Azure Table Storage.
 * Templates bundle a set of roles (with division assignments),
 * skills (with proficiency levels 1–5), language skills (with
 * proficiency levels 1–5), and queues
 * that can later be applied to users in bulk.
 *
 * API endpoints (internal):
 *   GET/POST/PUT/DELETE  /api/templates
 *
 * Genesys endpoints (via proxy):
 *   GET /api/v2/authorization/roles      — list available roles
 *   GET /api/v2/authorization/divisions  — list available divisions
 *   GET /api/v2/routing/skills           — list available skills
 *   GET /api/v2/routing/languages        — list available language skills
 *   GET /api/v2/routing/queues           — list available queues
 */
import { escapeHtml } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import {
  fetchTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from "../../../services/templateService.js";
import {
  fetchTemplateSchedules,
  createTemplateSchedule,
  updateTemplateSchedule,
  deleteTemplateSchedule,
} from "../../../services/templateScheduleService.js";

export default function renderCreateTemplate({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Role, Queue & Skill Templates</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  const orgId = org.id;

  el.innerHTML = `
    <h1 class="h1">Role, Queue & Skill Templates</h1>
    <hr class="hr">
    <p class="page-desc">
      Create templates consisting of roles (with division access), skills (with proficiency),
      language skills (with proficiency) and queues.
      Templates can be applied to users to assign roles, skills, languages and queue memberships in bulk.
    </p>
    <div class="st-status" id="stStatus"></div>
    <div class="st-body" id="stBody">
      <div class="cu-loading" id="stLoading"><div class="cu-loading-spinner"></div><p class="muted">Loading templates…</p></div>
    </div>
    <div class="st-schedule-panel" id="stSchedulePanel" hidden></div>
    <div class="st-editor" id="stEditor" hidden></div>
  `;

  const $body = el.querySelector("#stBody");
  const $editor = el.querySelector("#stEditor");
  const $schedulePanel = el.querySelector("#stSchedulePanel");
  const $status = el.querySelector("#stStatus");

  let templates = [];
  let templateSchedules = [];
  let allSkills = [];     // [{ id, name }]
  let allLanguages = [];  // [{ id, name }]
  let allQueues = [];     // [{ id, name }]
  let allRoles = [];      // [{ id, name }]
  let allDivisions = [];  // [{ id, name }]
  let editingId = null;

  // Editor state
  let selectedSkills = []; // [{ skillId, skillName, proficiency }]
  let selectedLanguages = []; // [{ languageId, languageName, proficiency }]
  let selectedQueues = []; // [{ queueId, queueName }]
  let selectedRoles = [];  // [{ roleId, roleName, divisions: [{ divisionId, divisionName }] }]

  // ── Status helper ─────────────────────────────────────
  function setStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "st-status" + (type ? ` st-status--${type}` : "");
  }

  // ── Load Genesys data ─────────────────────────────────
  let genesysDataLoaded = false;
  async function ensureGenesysData() {
    if (genesysDataLoaded) return;
    const [skills, languages, queues, roles, divisions] = await Promise.all([
      gc.fetchAllPages(api, orgId, "/api/v2/routing/skills"),
      gc.fetchAllPages(api, orgId, "/api/v2/routing/languages"),
      gc.fetchAllPages(api, orgId, "/api/v2/routing/queues"),
      gc.fetchAllPages(api, orgId, "/api/v2/authorization/roles", { query: { sortBy: "name" } }),
      gc.fetchAllPages(api, orgId, "/api/v2/authorization/divisions"),
    ]);
    allSkills = skills.map((s) => ({ id: s.id, name: s.name }));
    allLanguages = languages.map((l) => ({ id: l.id, name: l.name }));
    allQueues = queues.map((q) => ({ id: q.id, name: q.name }));
    allRoles = roles.map((r) => ({ id: r.id, name: r.name }));
    allDivisions = divisions.map((d) => ({ id: d.id, name: d.name }));
    genesysDataLoaded = true;
  }

  // ── Render template table ─────────────────────────────
  function renderTable() {
    if (!templates.length) {
      $body.innerHTML = `
        <p class="muted">No templates created yet.</p>
        <button class="btn st-btn-new" id="stBtnNew">+ New Template</button>`;
      el.querySelector("#stBtnNew").addEventListener("click", () => openEditor(null));
      return;
    }

    const rows = templates
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        const editable = canEdit(t);
        const schedCount = templateSchedules.filter((s) => s.templateId === t.id).length;
        return `<tr>
          <td class="st-cell-name">${escapeHtml(t.name)}</td>
          <td class="st-cell-count">${(t.roles || []).length}</td>
          <td class="st-cell-count">${(t.skills || []).length}</td>
          <td class="st-cell-count">${(t.languages || []).length}</td>
          <td class="st-cell-count">${(t.queues || []).length}</td>
          <td class="st-cell-owner">${escapeHtml(t.createdByName || t.createdBy)}</td>
          <td class="st-cell-actions">
            <button class="btn btn-sm st-btn-schedule" data-id="${t.id}" title="Schedule">🕐${schedCount ? ` (${schedCount})` : ""}</button>${
            editable
              ? ` <button class="btn btn-sm st-btn-edit" data-id="${t.id}">Edit</button>
                 <button class="btn btn-sm st-btn-delete" data-id="${t.id}">Delete</button>`
              : ""
          }</td>
        </tr>`;
      })
      .join("");

    $body.innerHTML = `
      <table class="data-table st-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Roles</th>
            <th>Skills</th>
            <th>Languages</th>
            <th>Queues</th>
            <th>Created By</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <button class="btn st-btn-new" id="stBtnNew">+ New Template</button>`;

    el.querySelector("#stBtnNew").addEventListener("click", () => openEditor(null));

    $body.querySelectorAll(".st-btn-edit").forEach((btn) =>
      btn.addEventListener("click", () => {
        const t = templates.find((x) => x.id === btn.dataset.id);
        if (t) openEditor(t);
      }),
    );

    $body.querySelectorAll(".st-btn-delete").forEach((btn) =>
      btn.addEventListener("click", () => handleDelete(btn.dataset.id)),
    );

    $body.querySelectorAll(".st-btn-schedule").forEach((btn) =>
      btn.addEventListener("click", () => {
        const t = templates.find((x) => x.id === btn.dataset.id);
        if (t) openSchedulePanel(t);
      }),
    );
  }

  function canEdit(template) {
    if (!me?.email) return false;
    const lower = me.email.toLowerCase();
    return lower === template.createdBy.toLowerCase() || lower === "thva@tdc.dk";
  }

  // ── Delete handler ────────────────────────────────────
  async function handleDelete(id) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if (!confirm(`Delete template "${t.name}"?`)) return;

    try {
      setStatus("Deleting…", null);
      await deleteTemplate(id, orgId, me.email);
      setStatus("Template deleted.", "success");
      await loadTemplates();
    } catch (err) {
      setStatus(err.message, "error");
    }
  }

  // ── Editor ────────────────────────────────────────────
  async function openEditor(existing) {
    editingId = existing ? existing.id : null;
    selectedSkills = existing
      ? (existing.skills || []).map((s) => ({ ...s }))
      : [];
    selectedQueues = existing
      ? (existing.queues || []).map((q) => ({ ...q }))
      : [];
    selectedLanguages = existing
      ? (existing.languages || []).map((l) => ({ ...l }))
      : [];
    selectedRoles = existing
      ? (existing.roles || []).map((r) => ({ ...r, divisions: (r.divisions || []).map((d) => ({ ...d })) }))
      : [];

    $editor.hidden = false;
    $editor.innerHTML = `<div class="cu-loading"><div class="cu-loading-spinner"></div><p class="muted">Loading data from Genesys…</p></div>`;

    try {
      await ensureGenesysData();
    } catch (err) {
      $editor.innerHTML = `<p class="st-status--error">Failed to load Genesys data: ${escapeHtml(err.message)}</p>`;
      return;
    }

    renderEditor();
  }

  function renderEditor() {
    $editor.innerHTML = `
      <h2 class="st-editor-title">${editingId ? "Edit Template" : "New Template"}</h2>
      <div class="st-field">
        <label class="st-label" for="stName">Template Name</label>
        <input class="input st-input-name" id="stName" type="text" placeholder="e.g. L1 Support Agent" />
      </div>
      <div class="st-section">
        <h3 class="st-section-title st-collapsible" id="stToggleRoles"><span class="st-chevron">▸</span> Roles</h3>
        <div class="st-section-body" id="stSectionRoles" hidden>
          <div class="st-picker" id="stRolePicker"></div>
          <div class="st-role-list" id="stRoleList"></div>
        </div>
      </div>
      <div class="st-section">
        <h3 class="st-section-title st-collapsible" id="stToggleSkills"><span class="st-chevron">▸</span> Skills</h3>
        <div class="st-section-body" id="stSectionSkills" hidden>
          <div class="st-picker" id="stSkillPicker"></div>
          <div class="st-skill-list" id="stSkillList"></div>
        </div>
      </div>
      <div class="st-section">
        <h3 class="st-section-title st-collapsible" id="stToggleLanguages"><span class="st-chevron">▸</span> Language Skills</h3>
        <div class="st-section-body" id="stSectionLanguages" hidden>
          <div class="st-picker" id="stLanguagePicker"></div>
          <div class="st-language-list" id="stLanguageList"></div>
        </div>
      </div>
      <div class="st-section">
        <h3 class="st-section-title st-collapsible" id="stToggleQueues"><span class="st-chevron">▸</span> Queues</h3>
        <div class="st-section-body" id="stSectionQueues" hidden>
          <div class="st-picker" id="stQueuePicker"></div>
          <div class="st-queue-list" id="stQueueList"></div>
        </div>
      </div>
      <div class="st-editor-actions">
        <button class="btn st-btn-cancel" id="stBtnCancel">Cancel</button>
        <button class="btn st-btn-save" id="stBtnSave">Save Template</button>
      </div>
    `;

    // Name field
    const $name = $editor.querySelector("#stName");
    if (editingId) {
      const t = templates.find((x) => x.id === editingId);
      if (t) $name.value = t.name;
    }

    // ── Collapsible section toggles ───────────────────
    function initToggle(toggleId, sectionId) {
      const $toggle = $editor.querySelector(`#${toggleId}`);
      const $section = $editor.querySelector(`#${sectionId}`);
      $toggle.addEventListener("click", () => {
        const open = !$section.hidden;
        $section.hidden = open;
        $toggle.querySelector(".st-chevron").textContent = open ? "▸" : "▾";
        $toggle.classList.toggle("st-collapsible--open", !open);
      });
    }
    initToggle("stToggleRoles", "stSectionRoles");
    initToggle("stToggleSkills", "stSectionSkills");
    initToggle("stToggleLanguages", "stSectionLanguages");
    initToggle("stToggleQueues", "stSectionQueues");

    // ── Role multi-select ─────────────────────────────
    const roleSelect = createMultiSelect({
      placeholder: "Add roles…",
      searchable: true,
      onChange: (ids) => {
        for (const id of ids) {
          if (!selectedRoles.find((r) => r.roleId === id)) {
            const role = allRoles.find((r) => r.id === id);
            if (role) {
              selectedRoles.push({ roleId: id, roleName: role.name, divisions: [] });
            }
          }
        }
        selectedRoles = selectedRoles.filter((r) => ids.has(r.roleId));
        renderRoleList();
      },
    });
    roleSelect.setItems(allRoles.map((r) => ({ id: r.id, label: r.name })));
    roleSelect.setSelected(new Set(selectedRoles.map((r) => r.roleId)));
    $editor.querySelector("#stRolePicker").append(roleSelect.el);

    // ── Skill multi-select ────────────────────────────
    const skillSelect = createMultiSelect({
      placeholder: "Add skills…",
      searchable: true,
      onChange: (ids) => {
        for (const id of ids) {
          if (!selectedSkills.find((s) => s.skillId === id)) {
            const skill = allSkills.find((s) => s.id === id);
            if (skill) {
              selectedSkills.push({ skillId: id, skillName: skill.name, proficiency: 3 });
            }
          }
        }
        selectedSkills = selectedSkills.filter((s) => ids.has(s.skillId));
        renderSkillList();
      },
    });
    skillSelect.setItems(allSkills.map((s) => ({ id: s.id, label: s.name })));
    skillSelect.setSelected(new Set(selectedSkills.map((s) => s.skillId)));
    $editor.querySelector("#stSkillPicker").append(skillSelect.el);

    // ── Queue multi-select ────────────────────────────
    const queueSelect = createMultiSelect({
      placeholder: "Add queues…",
      searchable: true,
      onChange: (ids) => {
        for (const id of ids) {
          if (!selectedQueues.find((q) => q.queueId === id)) {
            const queue = allQueues.find((q) => q.id === id);
            if (queue) {
              selectedQueues.push({ queueId: id, queueName: queue.name });
            }
          }
        }
        selectedQueues = selectedQueues.filter((q) => ids.has(q.queueId));
        renderQueueList();
      },
    });
    queueSelect.setItems(allQueues.map((q) => ({ id: q.id, label: q.name })));
    queueSelect.setSelected(new Set(selectedQueues.map((q) => q.queueId)));
    $editor.querySelector("#stQueuePicker").append(queueSelect.el);

    // ── Language multi-select ──────────────────────────
    const langSelect = createMultiSelect({
      placeholder: "Add language skills…",
      searchable: true,
      onChange: (ids) => {
        for (const id of ids) {
          if (!selectedLanguages.find((l) => l.languageId === id)) {
            const lang = allLanguages.find((l) => l.id === id);
            if (lang) {
              selectedLanguages.push({ languageId: id, languageName: lang.name, proficiency: 3 });
            }
          }
        }
        selectedLanguages = selectedLanguages.filter((l) => ids.has(l.languageId));
        renderLanguageList();
      },
    });
    langSelect.setItems(allLanguages.map((l) => ({ id: l.id, label: l.name })));
    langSelect.setSelected(new Set(selectedLanguages.map((l) => l.languageId)));
    $editor.querySelector("#stLanguagePicker").append(langSelect.el);

    renderRoleList();
    renderSkillList();
    renderLanguageList();
    renderQueueList();

    // ── Buttons ───────────────────────────────────────
    $editor.querySelector("#stBtnCancel").addEventListener("click", closeEditor);
    $editor.querySelector("#stBtnSave").addEventListener("click", handleSave);
  }

  // ── Role list with per-role division picker ───────────
  function renderRoleList() {
    const $list = $editor.querySelector("#stRoleList");
    if (!selectedRoles.length) {
      $list.innerHTML = `<p class="muted">No roles added yet.</p>`;
      return;
    }

    $list.innerHTML = `
      <div class="st-role-cards">
        ${selectedRoles.map((r, i) => `
          <div class="st-role-card" data-idx="${i}">
            <div class="st-role-header">
              <span class="st-role-name">${escapeHtml(r.roleName)}</span>
              <button class="btn btn-sm st-btn-remove" data-idx="${i}" data-type="role">✕</button>
            </div>
            <div class="st-role-divs">
              <label class="st-label">Divisions</label>
              <div class="st-div-picker" id="stDivPicker_${i}"></div>
              <div class="st-div-tags" id="stDivTags_${i}">
                ${r.divisions.length
                  ? r.divisions.map((d) => `<span class="st-div-tag">${escapeHtml(d.divisionName)}</span>`).join("")
                  : `<span class="muted" style="font-size:12px">No divisions selected</span>`}
              </div>
            </div>
          </div>`).join("")}
      </div>`;

    // Attach a division multi-select to each role card
    selectedRoles.forEach((r, i) => {
      const divSelect = createMultiSelect({
        placeholder: "Select divisions…",
        searchable: true,
        onChange: (ids) => {
          r.divisions = Array.from(ids).map((id) => {
            const div = allDivisions.find((d) => d.id === id);
            return { divisionId: id, divisionName: div ? div.name : id };
          });
          // Update tags inline
          const $tags = $list.querySelector(`#stDivTags_${i}`);
          if ($tags) {
            $tags.innerHTML = r.divisions.length
              ? r.divisions.map((d) => `<span class="st-div-tag">${escapeHtml(d.divisionName)}</span>`).join("")
              : `<span class="muted" style="font-size:12px">No divisions selected</span>`;
          }
        },
      });
      divSelect.setItems(allDivisions.map((d) => ({ id: d.id, label: d.name })));
      divSelect.setSelected(new Set(r.divisions.map((d) => d.divisionId)));
      const $pickerSlot = $list.querySelector(`#stDivPicker_${i}`);
      if ($pickerSlot) $pickerSlot.append(divSelect.el);
    });

    // Remove role
    $list.querySelectorAll('.st-btn-remove[data-type="role"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        selectedRoles.splice(parseInt(btn.dataset.idx, 10), 1);
        renderRoleList();
      }),
    );
  }

  // ── Skill list with proficiency radios ────────────────
  function renderSkillList() {
    const $list = $editor.querySelector("#stSkillList");
    if (!selectedSkills.length) {
      $list.innerHTML = `<p class="muted">No skills added yet.</p>`;
      return;
    }

    $list.innerHTML = `
      <table class="data-table st-detail-table">
        <thead><tr><th>Skill</th><th>Proficiency</th><th></th></tr></thead>
        <tbody>${selectedSkills.map((s, i) => `
          <tr>
            <td>${escapeHtml(s.skillName)}</td>
            <td class="st-proficiency-cell">
              ${[1, 2, 3, 4, 5]
                .map(
                  (p) =>
                    `<label class="st-radio-label">
                      <input type="radio" name="prof_${i}" value="${p}" ${p === s.proficiency ? "checked" : ""} />
                      ${p}
                    </label>`,
                )
                .join("")}
            </td>
            <td><button class="btn btn-sm st-btn-remove" data-idx="${i}" data-type="skill">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>`;

    $list.querySelectorAll('input[type="radio"]').forEach((radio) =>
      radio.addEventListener("change", (e) => {
        const idx = parseInt(e.target.name.split("_")[1], 10);
        selectedSkills[idx].proficiency = parseInt(e.target.value, 10);
      }),
    );

    $list.querySelectorAll('.st-btn-remove[data-type="skill"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        selectedSkills.splice(parseInt(btn.dataset.idx, 10), 1);
        renderSkillList();
      }),
    );
  }

  // ── Queue list ────────────────────────────────────────
  function renderQueueList() {
    const $list = $editor.querySelector("#stQueueList");
    if (!selectedQueues.length) {
      $list.innerHTML = `<p class="muted">No queues added yet.</p>`;
      return;
    }

    $list.innerHTML = `
      <table class="data-table st-detail-table">
        <thead><tr><th>Queue</th><th></th></tr></thead>
        <tbody>${selectedQueues.map((q, i) => `
          <tr>
            <td>${escapeHtml(q.queueName)}</td>
            <td><button class="btn btn-sm st-btn-remove" data-idx="${i}" data-type="queue">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>`;

    $list.querySelectorAll('.st-btn-remove[data-type="queue"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        selectedQueues.splice(parseInt(btn.dataset.idx, 10), 1);
        renderQueueList();
      }),
    );
  }

  // ── Language skill list with proficiency radios ────────
  function renderLanguageList() {
    const $list = $editor.querySelector("#stLanguageList");
    if (!selectedLanguages.length) {
      $list.innerHTML = `<p class="muted">No language skills added yet.</p>`;
      return;
    }

    $list.innerHTML = `
      <table class="data-table st-detail-table">
        <thead><tr><th>Language</th><th>Proficiency</th><th></th></tr></thead>
        <tbody>${selectedLanguages.map((l, i) => `
          <tr>
            <td>${escapeHtml(l.languageName)}</td>
            <td class="st-proficiency-cell">
              ${[1, 2, 3, 4, 5]
                .map(
                  (p) =>
                    `<label class="st-radio-label">
                      <input type="radio" name="lang_${i}" value="${p}" ${p === l.proficiency ? "checked" : ""} />
                      ${p}
                    </label>`,
                )
                .join("")}
            </td>
            <td><button class="btn btn-sm st-btn-remove" data-idx="${i}" data-type="language">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>`;

    $list.querySelectorAll('input[type="radio"]').forEach((radio) =>
      radio.addEventListener("change", (e) => {
        const idx = parseInt(e.target.name.split("_")[1], 10);
        selectedLanguages[idx].proficiency = parseInt(e.target.value, 10);
      }),
    );

    $list.querySelectorAll('.st-btn-remove[data-type="language"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        selectedLanguages.splice(parseInt(btn.dataset.idx, 10), 1);
        renderLanguageList();
      }),
    );
  }

  function closeEditor() {
    editingId = null;
    $editor.hidden = true;
    $editor.innerHTML = "";
  }

  // ── Save handler ──────────────────────────────────────
  async function handleSave() {
    const name = $editor.querySelector("#stName")?.value.trim();
    if (!name) {
      setStatus("Please enter a template name.", "error");
      return;
    }
    if (!selectedRoles.length && !selectedSkills.length && !selectedLanguages.length && !selectedQueues.length) {
      setStatus("Add at least one role, skill, language or queue.", "error");
      return;
    }

    const $saveBtn = $editor.querySelector("#stBtnSave");
    $saveBtn.disabled = true;

    try {
      if (editingId) {
        await updateTemplate(editingId, {
          orgId,
          name,
          roles: selectedRoles,
          skills: selectedSkills,
          languages: selectedLanguages,
          queues: selectedQueues,
          userEmail: me.email,
        });
        setStatus("Template updated.", "success");
      } else {
        await createTemplate({
          orgId,
          name,
          roles: selectedRoles,
          skills: selectedSkills,
          languages: selectedLanguages,
          queues: selectedQueues,
          userEmail: me.email,
          userName: me.name || me.email,
        });
        setStatus("Template created.", "success");
      }
      closeEditor();
      await loadTemplates();
    } catch (err) {
      setStatus(err.message, "error");
      $saveBtn.disabled = false;
    }
  }

  // ── Initial load ──────────────────────────────────────
  async function loadTemplates() {
    try {
      const [tpls, scheds] = await Promise.all([
        fetchTemplates(orgId),
        fetchTemplateSchedules(orgId),
      ]);
      templates = tpls;
      templateSchedules = scheds;
      renderTable();
    } catch (err) {
      $body.innerHTML = `<p class="st-status--error">Failed to load templates: ${escapeHtml(err.message)}</p>`;
    }
  }

  // ── Schedule panel ────────────────────────────────────

  const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function openSchedulePanel(template) {
    closeEditor();
    $schedulePanel.hidden = false;

    const existing = templateSchedules.filter((s) => s.templateId === template.id);

    $schedulePanel.innerHTML = `
      <h3 style="margin:0 0 12px">Schedules for "${escapeHtml(template.name)}"</h3>
      ${existing.length ? `
        <table class="data-table" style="margin-bottom:16px">
          <thead>
            <tr>
              <th>Mode</th>
              <th>Type</th>
              <th>Time</th>
              <th>Day</th>
              <th>Date</th>
              <th>Enabled</th>
              <th>Last Run</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${existing.map((s) => {
              const canDel = canEdit(template);
              const dayLabel = s.scheduleType === "weekly" ? (DAYS_OF_WEEK[s.scheduleDayOfWeek] || "—") :
                               s.scheduleType === "monthly" ? (s.scheduleDayOfMonth || "—") : "—";
              return `<tr>
                <td>${escapeHtml(s.mode)}</td>
                <td>${escapeHtml(s.scheduleType)}</td>
                <td>${escapeHtml(s.scheduleTime || "—")}</td>
                <td>${escapeHtml(String(dayLabel))}</td>
                <td>${s.scheduleDate ? escapeHtml(s.scheduleDate) : "—"}</td>
                <td>${s.enabled ? "✓" : "✗"}</td>
                <td>${s.lastRun ? new Date(s.lastRun).toLocaleString() : "—"}</td>
                <td>${escapeHtml(s.lastStatus || "—")}</td>
                <td>${canDel ? `<button class="btn btn-sm st-btn-del-sched" data-sid="${s.id}">Delete</button>` : ""}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>` : `<p class="muted" style="margin-bottom:12px">No schedules yet.</p>`}

      <h4 style="margin:0 0 10px">New Schedule</h4>
      <div class="sp-form-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:12px">
        <div>
          <label class="sp-form-label" for="stSchedMode">Mode</label>
          <select class="sp-form-select" id="stSchedMode">
            <option value="reset">Reset</option>
            <option value="add">Add</option>
          </select>
        </div>
        <div>
          <label class="sp-form-label" for="stSchedType">Schedule Type</label>
          <select class="sp-form-select" id="stSchedType">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="once">One-time</option>
          </select>
        </div>
        <div>
          <label class="sp-form-label" for="stSchedTime">Time (Danish)</label>
          <input class="sp-form-input" id="stSchedTime" type="time" value="08:00">
        </div>
        <div id="stSchedDayWeekGrp" style="display:none">
          <label class="sp-form-label" for="stSchedDayWeek">Day of week</label>
          <select class="sp-form-select" id="stSchedDayWeek">
            ${DAYS_OF_WEEK.map((d, i) => `<option value="${i}"${i === 1 ? " selected" : ""}>${d}</option>`).join("")}
          </select>
        </div>
        <div id="stSchedDayMonthGrp" style="display:none">
          <label class="sp-form-label" for="stSchedDayMonth">Day of month</label>
          <select class="sp-form-select" id="stSchedDayMonth">
            ${Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `<option value="${d}">${d}</option>`).join("")}
          </select>
        </div>
        <div id="stSchedDateGrp" style="display:none">
          <label class="sp-form-label" for="stSchedDate">Date</label>
          <input class="sp-form-input" id="stSchedDate" type="date">
        </div>
      </div>

      <div id="stSchedResetWarning" class="st-status st-status--warning" style="margin-bottom:12px;display:none">
        ⚠ <strong>Reset mode</strong> will remove ALL skills, languages, and queue memberships from every assigned user, then re-apply only this template's properties. Roles are not touched. If users are assigned to multiple templates, only this template's properties will remain.
      </div>

      <div style="display:flex;gap:8px">
        <button class="btn" id="stSchedBtnCreate">Create Schedule</button>
        <button class="btn st-btn-cancel" id="stSchedBtnClose">Close</button>
      </div>
      <div class="st-status" id="stSchedStatus" style="margin-top:8px"></div>
    `;

    // Wire schedule type toggle
    const $type = $schedulePanel.querySelector("#stSchedType");
    const $mode = $schedulePanel.querySelector("#stSchedMode");
    const $warning = $schedulePanel.querySelector("#stSchedResetWarning");

    function toggleFields() {
      const t = $type.value;
      $schedulePanel.querySelector("#stSchedDayWeekGrp").style.display = t === "weekly" ? "" : "none";
      $schedulePanel.querySelector("#stSchedDayMonthGrp").style.display = t === "monthly" ? "" : "none";
      $schedulePanel.querySelector("#stSchedDateGrp").style.display = t === "once" ? "" : "none";
    }
    $type.addEventListener("change", toggleFields);

    function toggleWarning() {
      $warning.style.display = $mode.value === "reset" ? "" : "none";
    }
    $mode.addEventListener("change", toggleWarning);
    toggleWarning();

    // Delete existing schedule
    $schedulePanel.querySelectorAll(".st-btn-del-sched").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this schedule?")) return;
        try {
          await deleteTemplateSchedule(btn.dataset.sid, me.email);
          setStatus("Schedule deleted.", "success");
          await loadTemplates();
          openSchedulePanel(template);
        } catch (err) {
          setStatus(err.message, "error");
        }
      }),
    );

    // Create schedule
    $schedulePanel.querySelector("#stSchedBtnCreate").addEventListener("click", async () => {
      const $schedStatus = $schedulePanel.querySelector("#stSchedStatus");
      const schedType = $type.value;
      const schedMode = $mode.value;
      const schedTime = $schedulePanel.querySelector("#stSchedTime").value;

      if (!schedTime) {
        $schedStatus.textContent = "Please set a time.";
        $schedStatus.className = "st-status st-status--error";
        return;
      }

      if (schedType === "once") {
        const date = $schedulePanel.querySelector("#stSchedDate").value;
        if (!date) {
          $schedStatus.textContent = "Please select a date for one-time schedule.";
          $schedStatus.className = "st-status st-status--error";
          return;
        }
      }

      try {
        await createTemplateSchedule({
          templateId: template.id,
          templateName: template.name,
          orgId,
          mode: schedMode,
          scheduleType: schedType,
          scheduleTime: schedTime,
          scheduleDayOfWeek: schedType === "weekly" ? parseInt($schedulePanel.querySelector("#stSchedDayWeek").value, 10) : null,
          scheduleDayOfMonth: schedType === "monthly" ? parseInt($schedulePanel.querySelector("#stSchedDayMonth").value, 10) : null,
          scheduleDate: schedType === "once" ? $schedulePanel.querySelector("#stSchedDate").value : null,
          userEmail: me.email,
          userName: me.name || me.email,
        });
        setStatus("Schedule created.", "success");
        await loadTemplates();
        openSchedulePanel(template);
      } catch (err) {
        $schedStatus.textContent = err.message;
        $schedStatus.className = "st-status st-status--error";
      }
    });

    // Close
    $schedulePanel.querySelector("#stSchedBtnClose").addEventListener("click", () => {
      $schedulePanel.hidden = true;
      $schedulePanel.innerHTML = "";
    });
  }

  loadTemplates();
  return el;
}
