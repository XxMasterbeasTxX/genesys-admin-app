/**
 * Users › Roles, Queues & Skills › Template Schedules
 *
 * Overview page showing all template schedules across all templates
 * for the selected org. Allows viewing, enabling/disabling, and deleting.
 */
import { escapeHtml } from "../../../utils.js";
import {
  fetchTemplateSchedules,
  updateTemplateSchedule,
  deleteTemplateSchedule,
} from "../../../services/templateScheduleService.js";

const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ADMIN_EMAIL = "thva@tdc.dk";

export default function renderTemplateSchedules({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Template Schedules</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  const orgId = org.id;

  el.innerHTML = `
    <h1 class="h1">Template Schedules</h1>
    <hr class="hr">
    <p class="page-desc">
      Overview of all scheduled template operations for this organisation.
      Schedules are created from the <strong>Create/Edit Template</strong> page.
    </p>
    <div class="st-status" id="tsStatus"></div>
    <div class="cu-loading" id="tsLoading">
      <div class="cu-loading-spinner"></div>
      <p class="muted">Loading schedules…</p>
    </div>
    <div id="tsBody" hidden></div>
  `;

  const $status  = el.querySelector("#tsStatus");
  const $loading = el.querySelector("#tsLoading");
  const $body    = el.querySelector("#tsBody");

  let schedules = [];

  function setStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "st-status" + (type ? ` st-status--${type}` : "");
  }

  function canEditSchedule(s) {
    if (!me?.email) return false;
    const lower = me.email.toLowerCase();
    return lower === s.createdBy.toLowerCase() || lower === ADMIN_EMAIL;
  }

  function describeSchedule(s) {
    const time = s.scheduleTime || "??:??";
    if (s.scheduleType === "once") return `One-time on ${s.scheduleDate || "?"} at ${time}`;
    if (s.scheduleType === "daily") return `Daily at ${time}`;
    if (s.scheduleType === "weekly") {
      const day = DAYS_OF_WEEK[s.scheduleDayOfWeek] || "?";
      return `Every ${day} at ${time}`;
    }
    if (s.scheduleType === "monthly") {
      const d = s.scheduleDayOfMonth;
      const suf = d === 1 || d === 21 || d === 31 ? "st" : d === 2 || d === 22 ? "nd" : d === 3 || d === 23 ? "rd" : "th";
      return `${d}${suf} of every month at ${time}`;
    }
    return s.scheduleType;
  }

  async function load() {
    try {
      schedules = await fetchTemplateSchedules(orgId);
      $loading.hidden = true;
      $body.hidden = false;
      render();
    } catch (err) {
      $loading.hidden = true;
      setStatus(`Failed to load schedules: ${err.message}`, "error");
    }
  }

  function render() {
    if (!schedules.length) {
      $body.innerHTML = `<p class="muted">No template schedules created yet. Create one from the Create/Edit Template page.</p>`;
      return;
    }

    const rows = schedules
      .sort((a, b) => (a.templateName || "").localeCompare(b.templateName || ""))
      .map((s) => {
        const editable = canEditSchedule(s);
        const statusClass = s.lastStatus === "success" ? "cu-log-line--success"
          : s.lastStatus === "error" ? "cu-log-line--error"
          : s.lastStatus === "partial" ? "cu-log-line--error" : "";
        return `<tr>
          <td>${escapeHtml(s.templateName || s.templateId)}</td>
          <td><span class="ts-mode ts-mode--${s.mode}">${escapeHtml(s.mode)}</span></td>
          <td>${escapeHtml(describeSchedule(s))}</td>
          <td>${s.enabled
            ? `<span style="color:var(--success, #22c55e)">✓ Enabled</span>`
            : `<span class="muted">✗ Disabled</span>`}</td>
          <td>${s.lastRun ? new Date(s.lastRun).toLocaleString() : "—"}</td>
          <td class="${statusClass}">${escapeHtml(s.lastStatus || "—")}</td>
          <td>${escapeHtml(s.createdByName || s.createdBy || "—")}</td>
          <td>${editable ? `
            <button class="btn btn-sm ts-btn-toggle" data-sid="${s.id}" data-enabled="${s.enabled}">${s.enabled ? "Disable" : "Enable"}</button>
            <button class="btn btn-sm st-btn-delete ts-btn-delete" data-sid="${s.id}">Delete</button>` : ""}
          </td>
        </tr>`;
      }).join("");

    $body.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Template</th>
            <th>Mode</th>
            <th>Schedule</th>
            <th>Status</th>
            <th>Last Run</th>
            <th>Result</th>
            <th>Created By</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

    // Toggle enable/disable
    $body.querySelectorAll(".ts-btn-toggle").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const sid = btn.dataset.sid;
        const currentlyEnabled = btn.dataset.enabled === "true";
        try {
          await updateTemplateSchedule(sid, {
            enabled: !currentlyEnabled,
            userEmail: me.email,
          });
          setStatus(currentlyEnabled ? "Schedule disabled." : "Schedule enabled.", "success");
          await load();
        } catch (err) {
          setStatus(err.message, "error");
        }
      }),
    );

    // Delete
    $body.querySelectorAll(".ts-btn-delete").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this schedule?")) return;
        try {
          await deleteTemplateSchedule(btn.dataset.sid, me.email);
          setStatus("Schedule deleted.", "success");
          await load();
        } catch (err) {
          setStatus(err.message, "error");
        }
      }),
    );
  }

  load();
  return el;
}
