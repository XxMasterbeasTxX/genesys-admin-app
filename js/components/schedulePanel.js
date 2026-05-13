/**
 * Schedule Panel — reusable automation UI for export pages.
 *
 * Usage:
 *   import { createSchedulePanel } from '../../components/schedulePanel.js';
 *   const panel = createSchedulePanel({
 *     exportType: 'trustee',
 *     exportLabel: 'Trustee Access Matrix',
 *     me: { email: '…', name: '…' },
 *   });
 *   el.appendChild(panel);
 *
 * Also exports helpers used by the Scheduled Exports overview page.
 */
import { escapeHtml } from "../utils.js";
import {
  fetchSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} from "../services/scheduleService.js";
import { orgContext } from "../services/orgContext.js";
import { logAction } from "../services/activityLogService.js";

// ── Constants ───────────────────────────────────────────
export const ADMIN_EMAIL = "thva@tdc.dk";

const DAYS_OF_WEEK = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday",
];

// ── Helpers (exported for overview page) ────────────────

/** Human-readable schedule description. */
export function describeSchedule(s) {
  if (s.scheduleType === "daily") return `Daily at ${s.scheduleTime}`;
  if (s.scheduleType === "weekly") {
    const day = DAYS_OF_WEEK[s.scheduleDayOfWeek] || "?";
    return `Every ${day} at ${s.scheduleTime}`;
  }
  if (s.scheduleType === "monthly") {
    const d = s.scheduleDayOfMonth;
    const suf =
      d === 1 || d === 21 || d === 31 ? "st"
      : d === 2 || d === 22 ? "nd"
      : d === 3 || d === 23 ? "rd"
      : "th";
    return `${d}${suf} of every month at ${s.scheduleTime}`;
  }
  return s.scheduleType;
}

/** Check if the current user can edit/delete a schedule. */
export function canEditSchedule(schedule, me) {
  if (!me?.email) return false;
  const lower = me.email.toLowerCase();
  return (
    lower === schedule.createdBy.toLowerCase() || lower === ADMIN_EMAIL
  );
}

// ── Form builder (shared between panel & overview) ──────

/**
 * Build a schedule form DOM element.
 * @param {Object}  opts
 * @param {Object}  [opts.existing]       Existing schedule to edit (null = new)
 * @param {Function} opts.onSave         (formData) => void
 * @param {Function} opts.onCancel       () => void
 * @param {Function} [opts.onDelete]     (id) => void — shown only when editing
 * @param {boolean} [opts.canDelete]     Whether to show the delete button
 * @param {boolean} [opts.requiresOrg]   Show org selector in form
 * @param {Array}   [opts.extraConfigFields] Extra fields to add to exportConfig
 * @returns {HTMLElement}
 */
export function buildScheduleForm(opts) {
  const s = opts.existing;
  const isEdit = !!s;
  const requiresOrg = opts.requiresOrg || false;
  const extraConfigFields = opts.extraConfigFields || [];
  const dynamicOrgFields = opts.dynamicOrgFields || null;

  // Get org list and existing config
  const customers = requiresOrg ? orgContext.getCustomers() : [];
  const existingConfig = s?.exportConfig || {};

  const form = document.createElement("div");
  form.className = "sp-form";

  // Build org selector HTML if needed
  const orgSelectorHtml = requiresOrg ? `
      <div class="sp-form-group sp-form-wide">
        <label class="sp-form-label" for="spOrgSelect">Organisation</label>
        <select class="sp-form-select" id="spOrgSelect">
          <option value="">— Select org —</option>
          ${customers.map(c =>
            `<option value="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}"${existingConfig.orgId === c.id ? " selected" : ""}>${escapeHtml(c.name)}</option>`
          ).join("")}
        </select>
      </div>` : "";

  // Dynamic fields slot — populated asynchronously based on org selection
  const dynamicFieldsSlotHtml = dynamicOrgFields ? `
      <div class="sp-form-group sp-form-wide" id="spDynamicFieldsSlot" style="display:none"></div>` : "";

  // Build extra config fields HTML
  const extraFieldsHtml = extraConfigFields.map(f => {
    const currentVal = String(existingConfig[f.key] ?? f.default ?? "");
    let fieldHtml;
    if (f.type === "select" && f.options) {
      const optionsHtml = f.options.map(o =>
        `<option value="${escapeHtml(String(o.value))}"${String(o.value) === currentVal ? " selected" : ""}>${escapeHtml(o.label)}</option>`
      ).join("");
      fieldHtml = `<select class="sp-form-select" id="spExtra_${f.key}">${optionsHtml}</select>`;
    } else {
      fieldHtml = `<input class="sp-form-input" id="spExtra_${f.key}" type="${f.type || "number"}"
               value="${escapeHtml(currentVal)}"
               ${f.min != null ? `min="${f.min}"` : ""} ${f.max != null ? `max="${f.max}"` : ""}
               placeholder="${escapeHtml(f.placeholder || "")}">`;
    }
    return `
      <div class="sp-form-group">
        <label class="sp-form-label" for="spExtra_${f.key}">${escapeHtml(f.label)}</label>
        ${fieldHtml}
        ${f.hint ? `<span class="sp-form-hint">${escapeHtml(f.hint)}</span>` : ""}
      </div>`;
  }).join("");

  form.innerHTML = `
    <h4 class="sp-form-title">${isEdit ? "Edit Schedule" : "New Schedule"}</h4>
    <div class="sp-form-grid">
      ${orgSelectorHtml}
      ${dynamicFieldsSlotHtml}
      ${extraFieldsHtml}
      <div class="sp-form-group">
        <label class="sp-form-label" for="spSchedType">Schedule</label>
        <select class="sp-form-select" id="spSchedType">
          <option value="daily"${s?.scheduleType === "daily" ? " selected" : ""}>Daily</option>
          <option value="weekly"${s?.scheduleType === "weekly" ? " selected" : ""}>Weekly</option>
          <option value="monthly"${s?.scheduleType === "monthly" ? " selected" : ""}>Monthly</option>
        </select>
      </div>

      <div class="sp-form-group">
        <label class="sp-form-label" for="spTime">Time (Danish time)</label>
        <input  class="sp-form-input" id="spTime" type="time"
                value="${s?.scheduleTime || "08:00"}">
      </div>

      <div class="sp-form-group sp-day-week" id="spDayWeekGrp"
           style="display:${s?.scheduleType === "weekly" ? "" : "none"}">
        <label class="sp-form-label" for="spDayWeek">Day of week</label>
        <select class="sp-form-select" id="spDayWeek">
          ${DAYS_OF_WEEK.map((d, i) =>
            `<option value="${i}"${(s?.scheduleDayOfWeek ?? 1) === i ? " selected" : ""}>${d}</option>`
          ).join("")}
        </select>
      </div>

      <div class="sp-form-group sp-day-month" id="spDayMonthGrp"
           style="display:${s?.scheduleType === "monthly" ? "" : "none"}">
        <label class="sp-form-label" for="spDayMonth">Day of month</label>
        <select class="sp-form-select" id="spDayMonth">
          ${Array.from({ length: 31 }, (_, i) => i + 1).map(d =>
            `<option value="${d}"${(s?.scheduleDayOfMonth ?? 1) === d ? " selected" : ""}>${d}</option>`
          ).join("")}
        </select>
      </div>

      <div class="sp-form-group sp-form-wide">
        <label class="sp-form-label" for="spRecipients">Email recipients</label>
        <input  class="sp-form-input" id="spRecipients" type="text"
                placeholder="user@example.com, user2@example.com"
                value="${escapeHtml(s?.emailRecipients || "")}">
        <span class="sp-form-hint">Separate with , or ; — export will be emailed to these addresses</span>
      </div>

      <div class="sp-form-group sp-form-wide">
        <label class="sp-form-label" for="spMessage">Message (optional)</label>
        <textarea class="sp-form-textarea" id="spMessage" rows="2"
                  placeholder="Leave empty for default message">${escapeHtml(s?.emailMessage || "")}</textarea>
      </div>

      <div class="sp-form-group sp-form-toggle-row">
        <label class="sp-form-label">Enabled</label>
        <label class="sp-toggle">
          <input type="checkbox" id="spEnabled" ${(s?.enabled !== false) ? "checked" : ""}>
          <span class="sp-toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="sp-form-status" id="spFormStatus"></div>

    <div class="sp-form-actions">
      <button class="btn sp-btn-save" id="spBtnSave">${isEdit ? "Update" : "Create"}</button>
      <button class="btn sp-btn-cancel" id="spBtnCancel">Cancel</button>
      ${isEdit && opts.canDelete
        ? `<button class="btn sp-btn-del" id="spBtnDel">Delete</button>`
        : ""}
    </div>
  `;

  // ── Conditional day fields ────────────────────────────
  const $type = form.querySelector("#spSchedType");
  const $dayWeekGrp = form.querySelector("#spDayWeekGrp");
  const $dayMonthGrp = form.querySelector("#spDayMonthGrp");

  $type.addEventListener("change", () => {
    $dayWeekGrp.style.display = $type.value === "weekly" ? "" : "none";
    $dayMonthGrp.style.display = $type.value === "monthly" ? "" : "none";
  });

  // ── Dynamic org fields (e.g. role multi-select) ─────────────────────
  const $dofSlot = dynamicOrgFields ? form.querySelector("#spDynamicFieldsSlot") : null;
  let dynamicLoading = false;
  let dynamicLoaded = false;

  function normalizeOption(option) {
    if (option && typeof option === "object") {
      return {
        value: String(option.value ?? ""),
        label: String(option.label ?? option.value ?? ""),
      };
    }
    const str = String(option ?? "");
    return { value: str, label: str };
  }

  async function loadDynamicFields(orgId, existingValues = {}) {
    if (!dynamicOrgFields || !orgId || !$dofSlot) return;
    $dofSlot.style.display = "";
    $dofSlot.innerHTML = `<span class="sp-form-hint">Loading options…</span>`;
    dynamicLoading = true;
    dynamicLoaded = false;
    try {
      const fieldDefs = await dynamicOrgFields(orgId);
      dynamicLoading = false;
      dynamicLoaded = true;
      $dofSlot.innerHTML = fieldDefs.map(f => {
        const required = f.required !== false;
        if (f.singleSelect) {
          // Single-select: render a <select> dropdown
          const prevVal = Array.isArray(existingValues[f.key])
            ? (existingValues[f.key][0] || "")
            : (existingValues[f.key] || "");
          const optHtml = (f.options || []).map((o) => {
            const opt = normalizeOption(o);
            return `<option value="${escapeHtml(opt.value)}"${prevVal === opt.value ? " selected" : ""}>${escapeHtml(opt.label)}</option>`;
          }).join("");
          return `
            <div class="sp-dynamic-field">
              <label class="sp-form-label">${escapeHtml(f.label)}</label>
              <select class="sp-form-select" data-dof-key="${escapeHtml(f.key)}" data-dof-required="${required ? "1" : "0"}">${optHtml}</select>
            </div>`;
        }
        // Multi-select: render checkboxes (default)
        const prevVals = existingValues[f.key] || [];
        const boxes = (f.options || []).map((o) => {
          const opt = normalizeOption(o);
          return `<label class="sp-checkbox-item"><input type="checkbox" data-dof-key="${escapeHtml(f.key)}" data-dof-required="${required ? "1" : "0"}" data-dof-label="${escapeHtml(opt.label)}" value="${escapeHtml(opt.value)}"${prevVals.includes(opt.value) ? " checked" : ""}> ${escapeHtml(opt.label)}</label>`;
        }).join("");
        return `
          <div class="sp-dynamic-field">
            <label class="sp-form-label">${escapeHtml(f.label)}</label>
            <div class="sp-checkbox-controls">
              <button type="button" class="btn btn-sm sp-chk-all" data-dof-key="${escapeHtml(f.key)}">All</button>
              <button type="button" class="btn btn-sm sp-chk-none" data-dof-key="${escapeHtml(f.key)}">None</button>
            </div>
            <div class="sp-checkbox-scroll">${boxes}</div>
          </div>`;
      }).join("");
      $dofSlot.querySelectorAll(".sp-chk-all").forEach(btn => {
        btn.addEventListener("click", () =>
          $dofSlot.querySelectorAll(`input[data-dof-key="${btn.dataset.dofKey}"]`)
            .forEach(cb => { cb.checked = true; }));
      });
      $dofSlot.querySelectorAll(".sp-chk-none").forEach(btn => {
        btn.addEventListener("click", () =>
          $dofSlot.querySelectorAll(`input[data-dof-key="${btn.dataset.dofKey}"]`)
            .forEach(cb => { cb.checked = false; }));
      });
    } catch (err) {
      dynamicLoading = false;
      $dofSlot.innerHTML = `<span class="sp-form-hint sp-form-hint--error">Failed to load: ${escapeHtml(err.message)}</span>`;
    }
  }

  if (dynamicOrgFields && requiresOrg) {
    const $orgSelDyn = form.querySelector("#spOrgSelect");
    if ($orgSelDyn) {
      $orgSelDyn.addEventListener("change", () => loadDynamicFields($orgSelDyn.value, {}));
      // Auto-load in edit mode with pre-checked saved values
      if (isEdit && existingConfig.orgId) {
        loadDynamicFields(existingConfig.orgId, existingConfig);
      }
    }
  }

  // ── Status helper ─────────────────────────────────────
  const $status = form.querySelector("#spFormStatus");
  function setFormStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "sp-form-status" + (type ? ` sp-form-status--${type}` : "");
  }

  // ── Collect form data ─────────────────────────────────
  function getFormData() {
    const data = {
      scheduleType: $type.value,
      scheduleTime: form.querySelector("#spTime").value,
      scheduleDayOfWeek: $type.value === "weekly"
        ? Number(form.querySelector("#spDayWeek").value) : null,
      scheduleDayOfMonth: $type.value === "monthly"
        ? Number(form.querySelector("#spDayMonth").value) : null,
      emailRecipients: form.querySelector("#spRecipients").value.trim(),
      emailMessage: form.querySelector("#spMessage").value.trim(),
      enabled: form.querySelector("#spEnabled").checked,
    };

    // Build exportConfig if org selector or extra fields are present
    if (requiresOrg || extraConfigFields.length > 0) {
      const config = {};
      if (requiresOrg) {
        const $orgSel = form.querySelector("#spOrgSelect");
        config.orgId = $orgSel.value;
        config.orgName = $orgSel.selectedOptions[0]?.dataset?.name || "";
      }
      for (const f of extraConfigFields) {
        const val = form.querySelector(`#spExtra_${f.key}`).value;
        config[f.key] = f.type === "number" ? (parseInt(val, 10) || f.default || 0) : val;
      }
      data.exportConfig = config;
    }
      // Collect dynamic org field checkboxes (e.g. roles multi-select)
      if ($dofSlot) {
        const checkedByKey = {};
        const checkedLabelsByKey = {};
        $dofSlot.querySelectorAll('input[type="checkbox"][data-dof-key]').forEach(cb => {
          const k = cb.dataset.dofKey;
          if (!checkedByKey[k]) checkedByKey[k] = [];
          if (!checkedLabelsByKey[k]) checkedLabelsByKey[k] = [];
          if (cb.checked) checkedByKey[k].push(cb.value);
          if (cb.checked) checkedLabelsByKey[k].push(cb.dataset.dofLabel || cb.value);
        });
        if (Object.keys(checkedByKey).length > 0) {
          if (!data.exportConfig) data.exportConfig = {};
          Object.assign(data.exportConfig, checkedByKey);
          for (const [k, labels] of Object.entries(checkedLabelsByKey)) {
            data.exportConfig[`${k}Labels`] = labels;
          }
        }
        // Collect dynamic org field single-select dropdowns
        $dofSlot.querySelectorAll('select[data-dof-key]').forEach(sel => {
          if (!data.exportConfig) data.exportConfig = {};
          data.exportConfig[sel.dataset.dofKey] = sel.value;
          data.exportConfig[`${sel.dataset.dofKey}Label`] = sel.selectedOptions[0]?.textContent || sel.value;
        });
      }
    return data;
  }

  // ── Validation ────────────────────────────────────────
  function validate(data) {
    if (requiresOrg && (!data.exportConfig || !data.exportConfig.orgId)) {
      return "Please select an organisation";
    }
    if (dynamicOrgFields) {
      if (dynamicLoading) return "Options are still loading, please wait";
      if (dynamicLoaded) {
        const requiredCheckboxes = [...($dofSlot.querySelectorAll('input[type="checkbox"][data-dof-key][data-dof-required="1"]'))];
        const requiredKeys = [...new Set(requiredCheckboxes.map((cb) => cb.dataset.dofKey))];
        for (const key of requiredKeys) {
          const keyBoxes = requiredCheckboxes.filter((cb) => cb.dataset.dofKey === key);
          const keyHasSelection = keyBoxes.some((cb) => cb.checked);
          if (!keyHasSelection) return "Please select at least one option";
        }

        const requiredSelects = [...($dofSlot.querySelectorAll('select[data-dof-key][data-dof-required="1"]'))];
        if (requiredSelects.length > 0) {
          const allFilled = requiredSelects.every(sel => sel.value !== "");
          if (!allFilled) return "Please select an option";
        }
      }
    }
    if (!data.scheduleTime) return "Time is required";
    if (!data.emailRecipients) return "At least one email recipient is required";
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const addrs = data.emailRecipients.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    for (const addr of addrs) {
      if (!emailRe.test(addr)) return `Invalid email: ${addr}`;
    }
    return null;
  }

  // ── Save ──────────────────────────────────────────────
  form.querySelector("#spBtnSave").addEventListener("click", async () => {
    const data = getFormData();
    const err = validate(data);
    if (err) { setFormStatus(err, "error"); return; }

    setFormStatus("Saving…");
    try {
      await opts.onSave(data);
      setFormStatus("Saved", "success");
    } catch (e) {
      setFormStatus(e.message, "error");
    }
  });

  // ── Cancel ────────────────────────────────────────────
  form.querySelector("#spBtnCancel").addEventListener("click", () => {
    opts.onCancel();
  });

  // ── Delete ────────────────────────────────────────────
  const $del = form.querySelector("#spBtnDel");
  if ($del && opts.onDelete) {
    $del.addEventListener("click", async () => {
      if (!confirm("Delete this schedule?")) return;
      setFormStatus("Deleting…");
      try {
        await opts.onDelete(s.id);
      } catch (e) {
        setFormStatus(e.message, "error");
      }
    });
  }

  return form;
}

// ── Main component ──────────────────────────────────────

/**
 * Create a self-contained schedule panel for an export page.
 *
 * @param {Object} opts
 * @param {string} opts.exportType       e.g. "trustee"
 * @param {string} opts.exportLabel      e.g. "Trustee Access Matrix"
 * @param {Object} opts.me               Genesys user { email, name }
 * @param {boolean} [opts.requiresOrg]   Show org selector when creating schedule
 * @param {Array}   [opts.extraConfigFields] Extra config fields for the form
 * @returns {HTMLElement}
 */
export function createSchedulePanel({ exportType, exportLabel, me, requiresOrg, extraConfigFields, dynamicOrgFields, configSummary }) {
  const el = document.createElement("div");
  el.className = "sp-section";

  el.innerHTML = `
    <div class="sp-header">
      <span class="sp-title">Automation</span>
      <button class="btn btn-sm sp-btn-new" id="spNewBtn">+ New Schedule</button>
    </div>
    <div class="sp-status" id="spStatus"></div>
    <div class="sp-body" id="spBody">
      <p class="sp-empty">Loading schedules…</p>
    </div>
    <div class="sp-form-container" id="spFormContainer"></div>
  `;

  const $body = el.querySelector("#spBody");
  const $formContainer = el.querySelector("#spFormContainer");
  const $status = el.querySelector("#spStatus");

  let schedules = [];

  function setStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "sp-status" + (type ? ` sp-status--${type}` : "");
  }

  // ── Render schedule list ──────────────────────────────
  function renderList() {
    const filtered = schedules.filter((s) => s.exportType === exportType);

    if (!filtered.length) {
      $body.innerHTML = `<p class="sp-empty">No scheduled exports yet. Click "+ New Schedule" to create one.</p>`;
      return;
    }

    const hasOrg = filtered.some(s => s.exportConfig?.orgName);
    const hasConfig = !!configSummary && filtered.some(s => s.exportConfig);

    let html = `<table class="data-table sp-table">
      <thead><tr>
        <th>Schedule</th>
        ${hasOrg ? "<th>Organisation</th>" : ""}
        ${hasConfig ? "<th>Config</th>" : ""}
        <th>Recipients</th>
        <th>Enabled</th>
        <th>Created by</th>
        <th></th>
      </tr></thead><tbody>`;

    for (const s of filtered) {
      const editable = canEditSchedule(s, me);
      html += `<tr>
        <td>${escapeHtml(describeSchedule(s))}</td>
        ${hasOrg ? `<td>${escapeHtml(s.exportConfig?.orgName || "—")}</td>` : ""}
        ${hasConfig ? `<td>${escapeHtml(configSummary(s.exportConfig || {}) || "—")}</td>` : ""}
        <td class="sp-cell-email">${escapeHtml(s.emailRecipients)}</td>
        <td>${s.enabled
          ? `<span class="sp-badge sp-badge--on">On</span>`
          : `<span class="sp-badge sp-badge--off">Off</span>`}</td>
        <td>${escapeHtml(s.createdByName || s.createdBy)}</td>
        <td>${editable
          ? `<button class="btn btn-sm sp-btn-edit" data-id="${s.id}">Edit</button>`
          : ""}</td>
      </tr>`;
    }

    html += `</tbody></table>`;
    $body.innerHTML = html;

    // Attach edit handlers
    $body.querySelectorAll(".sp-btn-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sched = schedules.find((s) => s.id === btn.dataset.id);
        if (sched) showForm(sched);
      });
    });
  }

  // ── Show form (create / edit) ─────────────────────────
  function showForm(existing) {
    $formContainer.innerHTML = "";
    const form = buildScheduleForm({
      existing,
      canDelete: existing ? canEditSchedule(existing, me) : false,
      requiresOrg,
      extraConfigFields,
      dynamicOrgFields,
      onSave: async (formData) => {
        if (existing) {
          await updateSchedule(existing.id, {
            ...formData,
            userEmail: me.email,
          });
          logAction({
            me,
            action:      "schedule_update",
            description: `Updated schedule for '${exportLabel}'`,
          });
        } else {
          await createSchedule({
            ...formData,
            exportType,
            exportLabel,
            userEmail: me.email,
            userName: me.name,
          });
          logAction({
            me,
            action:      "schedule_create",
            description: `Created ${formData.scheduleType} schedule for '${exportLabel}' at ${formData.scheduleTime}`,
          });
        }
        hideForm();
        await loadSchedules();
      },
      onCancel: () => hideForm(),
      onDelete: async (id) => {
        await deleteSchedule(id, me.email);
        logAction({
          me,
          action:      "schedule_delete",
          description: `Deleted schedule for '${exportLabel}'`,
        });
        hideForm();
        await loadSchedules();
      },
    });
    $formContainer.appendChild(form);
  }

  function hideForm() {
    $formContainer.innerHTML = "";
  }

  // ── Load data ─────────────────────────────────────────
  async function loadSchedules() {
    try {
      schedules = await fetchSchedules();
      renderList();
    } catch (err) {
      setStatus(`Failed to load schedules: ${err.message}`, "error");
      $body.innerHTML = `<p class="sp-empty">Could not load schedules.</p>`;
    }
  }

  // ── New button ────────────────────────────────────────
  el.querySelector("#spNewBtn").addEventListener("click", () => showForm(null));

  // ── Init ──────────────────────────────────────────────
  loadSchedules();

  return el;
}
