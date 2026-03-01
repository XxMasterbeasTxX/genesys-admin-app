/**
 * Export › Scheduled Exports — Overview of all scheduled export tasks.
 *
 * Shows a table listing every schedule, regardless of export type.
 * Only the creator (or admin) can edit/delete a schedule.
 */
import { escapeHtml } from "../../utils.js";
import {
  fetchSchedules,
  updateSchedule,
  deleteSchedule,
} from "../../services/scheduleService.js";
import {
  describeSchedule,
  canEditSchedule,
  buildScheduleForm,
} from "../../components/schedulePanel.js";

export default function renderScheduledExports({ route, me }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h1 class="h1">All Scheduled Exports</h1>
    <hr class="hr">
    <p class="page-desc">
      Overview of every scheduled export across all export types.
      You can only edit or delete schedules you created${me?.email ? "" : ""}.
    </p>
    <div class="se-status" id="seStatus"></div>
    <div class="se-body" id="seBody">
      <p class="sp-empty">Loading…</p>
    </div>
    <div class="se-form-container" id="seFormContainer"></div>
  `;

  const $body = el.querySelector("#seBody");
  const $formContainer = el.querySelector("#seFormContainer");
  const $status = el.querySelector("#seStatus");

  let schedules = [];

  function setStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "se-status" + (type ? ` se-status--${type}` : "");
  }

  // ── Render table ──────────────────────────────────────
  function renderTable() {
    if (!schedules.length) {
      $body.innerHTML = `<p class="sp-empty">No scheduled exports found. Create schedules from individual export pages.</p>`;
      return;
    }

    // Sort: enabled first, then by export label, then by created date
    const sorted = [...schedules].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      const labelCmp = (a.exportLabel || "").localeCompare(b.exportLabel || "");
      if (labelCmp !== 0) return labelCmp;
      return (a.createdAt || "").localeCompare(b.createdAt || "");
    });

    let html = `
      <div class="se-table-wrap">
        <table class="data-table se-table">
          <thead><tr>
            <th>Export</th>
            <th>Schedule</th>
            <th>Recipients</th>
            <th>Enabled</th>
            <th>Created by</th>
            <th>Last run</th>
            <th></th>
          </tr></thead>
          <tbody>`;

    for (const s of sorted) {
      const editable = canEditSchedule(s, me);
      html += `<tr data-id="${s.id}">
        <td>${escapeHtml(s.exportLabel || s.exportType)}</td>
        <td>${escapeHtml(describeSchedule(s))}</td>
        <td class="se-cell-email">${escapeHtml(s.emailRecipients)}</td>
        <td>${s.enabled
          ? `<span class="sp-badge sp-badge--on">On</span>`
          : `<span class="sp-badge sp-badge--off">Off</span>`}</td>
        <td>${escapeHtml(s.createdByName || s.createdBy)}</td>
        <td>${s.lastRun
          ? `<span class="${s.lastStatus === "success" ? "se-ok" : "se-fail"}">${escapeHtml(new Date(s.lastRun).toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }))}</span>`
          : `<span class="se-none">Never</span>`}</td>
        <td>${editable
          ? `<button class="btn btn-sm sp-btn-edit" data-id="${s.id}">Edit</button>`
          : ""}</td>
      </tr>`;
    }

    html += `</tbody></table></div>`;
    $body.innerHTML = html;

    // Attach edit handlers
    $body.querySelectorAll(".sp-btn-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sched = schedules.find((s) => s.id === btn.dataset.id);
        if (sched) showForm(sched);
      });
    });
  }

  // ── Show edit form ────────────────────────────────────
  function showForm(existing) {
    $formContainer.innerHTML = "";
    const form = buildScheduleForm({
      existing,
      canDelete: canEditSchedule(existing, me),
      onSave: async (formData) => {
        await updateSchedule(existing.id, {
          ...formData,
          userEmail: me.email,
        });
        hideForm();
        await loadData();
      },
      onCancel: () => hideForm(),
      onDelete: async (id) => {
        await deleteSchedule(id, me.email);
        hideForm();
        await loadData();
      },
    });
    $formContainer.appendChild(form);
  }

  function hideForm() {
    $formContainer.innerHTML = "";
  }

  // ── Load data ─────────────────────────────────────────
  async function loadData() {
    try {
      schedules = await fetchSchedules();
      renderTable();
      setStatus("");
    } catch (err) {
      setStatus(`Failed to load schedules: ${err.message}`, "error");
      $body.innerHTML = `<p class="sp-empty">Could not load schedules.</p>`;
    }
  }

  loadData();
  return el;
}
