/**
 * Users › Roles & Skills › Create Template
 *
 * Create, edit, and delete skill/queue templates stored in Azure Table Storage.
 * Templates bundle a set of skills (with proficiency levels 1–5) and queues
 * that can later be applied to users in bulk.
 *
 * API endpoints (internal):
 *   GET/POST/PUT/DELETE  /api/templates
 *
 * Genesys endpoints (via proxy):
 *   GET /api/v2/routing/skills  — list available skills
 *   GET /api/v2/routing/queues  — list available queues
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

export default function renderCreateTemplate({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Skill & Queue Templates</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  const orgId = org.id;

  el.innerHTML = `
    <h1 class="h1">Skill & Queue Templates</h1>
    <hr class="hr">
    <p class="page-desc">
      Create templates consisting of skills (with proficiency) and queues.
      Templates can be applied to users to assign skills and queue memberships in bulk.
    </p>
    <div class="st-status" id="stStatus"></div>
    <div class="st-body" id="stBody">
      <p class="muted">Loading…</p>
    </div>
    <div class="st-editor" id="stEditor" hidden></div>
  `;

  const $body = el.querySelector("#stBody");
  const $editor = el.querySelector("#stEditor");
  const $status = el.querySelector("#stStatus");

  let templates = [];
  let allSkills = [];  // [{ id, name }]
  let allQueues = [];  // [{ id, name }]
  let editingId = null; // null = creating new, string = editing existing

  // Editor state
  let selectedSkills = []; // [{ skillId, skillName, proficiency }]
  let selectedQueues = []; // [{ queueId, queueName }]

  // ── Status helper ─────────────────────────────────────
  function setStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "st-status" + (type ? ` st-status--${type}` : "");
  }

  // ── Load Genesys data (skills + queues) ───────────────
  let genesysDataLoaded = false;
  async function ensureGenesysData() {
    if (genesysDataLoaded) return;
    const [skills, queues] = await Promise.all([
      gc.fetchAllPages(api, orgId, "/api/v2/routing/skills"),
      gc.fetchAllPages(api, orgId, "/api/v2/routing/queues"),
    ]);
    allSkills = skills.map((s) => ({ id: s.id, name: s.name }));
    allQueues = queues.map((q) => ({ id: q.id, name: q.name }));
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
        return `<tr>
          <td class="st-cell-name">${escapeHtml(t.name)}</td>
          <td class="st-cell-count">${(t.skills || []).length}</td>
          <td class="st-cell-count">${(t.queues || []).length}</td>
          <td class="st-cell-owner">${escapeHtml(t.createdByName || t.createdBy)}</td>
          <td class="st-cell-actions">${
            editable
              ? `<button class="btn btn-sm st-btn-edit" data-id="${t.id}">Edit</button>
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
            <th>Skills</th>
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

    $editor.hidden = false;
    $editor.innerHTML = `<p class="muted">Loading skills & queues from Genesys…</p>`;

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
        <h3 class="st-section-title">Skills</h3>
        <div class="st-picker" id="stSkillPicker"></div>
        <div class="st-skill-list" id="stSkillList"></div>
      </div>
      <div class="st-section">
        <h3 class="st-section-title">Queues</h3>
        <div class="st-picker" id="stQueuePicker"></div>
        <div class="st-queue-list" id="stQueueList"></div>
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

    // ── Skill multi-select ────────────────────────────
    const skillSelect = createMultiSelect({
      placeholder: "Add skills…",
      searchable: true,
      onChange: (ids) => {
        // Add newly selected skills (skip already present)
        for (const id of ids) {
          if (!selectedSkills.find((s) => s.skillId === id)) {
            const skill = allSkills.find((s) => s.id === id);
            if (skill) {
              selectedSkills.push({ skillId: id, skillName: skill.name, proficiency: 3 });
            }
          }
        }
        // Remove deselected skills
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

    renderSkillList();
    renderQueueList();

    // ── Buttons ───────────────────────────────────────
    $editor.querySelector("#stBtnCancel").addEventListener("click", closeEditor);
    $editor.querySelector("#stBtnSave").addEventListener("click", handleSave);
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

    // Proficiency change
    $list.querySelectorAll('input[type="radio"]').forEach((radio) =>
      radio.addEventListener("change", (e) => {
        const idx = parseInt(e.target.name.split("_")[1], 10);
        selectedSkills[idx].proficiency = parseInt(e.target.value, 10);
      }),
    );

    // Remove skill
    $list.querySelectorAll('.st-btn-remove[data-type="skill"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        selectedSkills.splice(parseInt(btn.dataset.idx, 10), 1);
        // Re-sync the multi-select dropdown
        const picker = $editor.querySelector("#stSkillPicker .ms-dropdown");
        if (picker?.__msInstance) {
          picker.__msInstance.setSelected(new Set(selectedSkills.map((s) => s.skillId)));
        }
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
        const picker = $editor.querySelector("#stQueuePicker .ms-dropdown");
        if (picker?.__msInstance) {
          picker.__msInstance.setSelected(new Set(selectedQueues.map((q) => q.queueId)));
        }
        renderQueueList();
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
    if (!selectedSkills.length && !selectedQueues.length) {
      setStatus("Add at least one skill or queue.", "error");
      return;
    }

    const $saveBtn = $editor.querySelector("#stBtnSave");
    $saveBtn.disabled = true;

    try {
      if (editingId) {
        await updateTemplate(editingId, {
          orgId,
          name,
          skills: selectedSkills,
          queues: selectedQueues,
          userEmail: me.email,
        });
        setStatus("Template updated.", "success");
      } else {
        await createTemplate({
          orgId,
          name,
          skills: selectedSkills,
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
      templates = await fetchTemplates(orgId);
      renderTable();
    } catch (err) {
      $body.innerHTML = `<p class="st-status--error">Failed to load templates: ${escapeHtml(err.message)}</p>`;
    }
  }

  loadTemplates();
  return el;
}
