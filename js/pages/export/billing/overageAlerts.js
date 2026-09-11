/**
 * Export › Billing › Overage Alerts
 *
 * Be told when a licence goes into overage in the CURRENT billing period.
 * Pick what to watch from what the period actually contains, daily or
 * weekly at midnight, and the scheduled runner mails only when something is
 * over (docs/billing-overage-alerts-design.md).
 *
 * This is a schedule type, not its own machinery: an alert is a row in the
 * same store the exports use, with exportType "billingOverageAlert", and it
 * appears in Export › Scheduled Exports like any other. This page is the
 * form that knows what a billing period looks like, and the list of this
 * org's alerts.
 *
 * The org is the header's, like every billing page — locked for a customer.
 * Time is fixed at 00:00 and not offered; nor is the custom-message field,
 * because the runner lets it REPLACE the handler's body and for an alert the
 * body is the information.
 */
import { escapeHtml, makeStatus } from "../../../utils.js";
import { fetchBillingOverview, isPermanentBillingState } from "../../../services/billingService.js";
import { processBillingOverview } from "../../../utils/billingProcessor.js";
import { isTrusteeOrg } from "../../../utils/billingTrustees.js";
import { fetchSchedules, createSchedule, deleteSchedule } from "../../../services/scheduleService.js";
import { canEditSchedule, formatLastRun, formatLastStatus } from "../../../components/schedulePanel.js";
import { logAction } from "../../../services/activityLogService.js";

const EXPORT_TYPE  = "billingOverageAlert";
const EXPORT_LABEL = "Billing — Overage Alert";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function renderBillingOverageAlerts({ me, api, orgContext }) {
  const el = document.createElement("div");
  el.innerHTML = `
    <style>
      .oa-wrap { max-width: 900px; }
      .oa-org { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
      .oa-org .em-label { margin:0; }
      .oa-card { border:1px solid var(--border); border-radius:8px; padding:14px 16px; margin-bottom:18px; background:var(--panel); }
      .oa-card h2 { font-size:15px; margin:0 0 10px; }
      .oa-items { display:flex; flex-direction:column; gap:6px; margin:6px 0 14px; }
      .oa-item { display:flex; align-items:center; gap:10px; font-size:13px; }
      .oa-item input[type=checkbox] { margin:0; }
      .oa-item .oa-over { font-size:11px; color:#fbbf24; }
      .oa-item .oa-thr { display:inline-flex; align-items:center; gap:6px; margin-left:6px; color:var(--muted); }
      .oa-item .oa-thr input { width:64px; padding:3px 6px; background:var(--panel-2,rgba(255,255,255,.04)); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; }
      .oa-row { display:flex; gap:14px; flex-wrap:wrap; align-items:flex-end; margin-bottom:12px; }
      .oa-field { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
      .oa-field select, .oa-field input[type=text] { padding:6px 10px; background:var(--panel-2,rgba(255,255,255,.04)); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; }
      .oa-field input[type=text] { min-width:320px; }
      .oa-mode { display:flex; flex-direction:column; gap:6px; font-size:13px; margin-bottom:12px; }
      .oa-mode label { display:flex; gap:8px; align-items:flex-start; }
      .oa-mode small { color:var(--muted); display:block; }
      .oa-muted { color:var(--muted); }
      .oa-table td.oa-actions { text-align:right; white-space:nowrap; }
      .oa-empty { color:var(--muted); padding:10px 0; }
    </style>
    <div class="oa-wrap">
      <h1 class="h1">Export — Billing — Overage Alerts</h1>
      <hr class="hr">
      <p class="page-desc">
        Be told by e-mail when a licence goes into overage in the <strong>current</strong> billing
        period. Choose what to watch from what the period contains, daily or weekly at midnight; a
        mail is sent only when something is over.
      </p>

      <div class="oa-org">
        <span class="em-label">Organization:</span>
        <span id="oaOrgName" class="em-hint">Select a customer org in the header.</span>
      </div>

      <div id="oaStatus" class="cs-status"></div>

      <div class="oa-card" id="oaCreate" hidden>
        <h2>Create an alert</h2>
        <div class="oa-muted" style="font-size:12px;margin-bottom:6px">Watch</div>
        <div class="oa-items" id="oaItems"></div>

        <div class="oa-row">
          <label class="oa-field">Frequency
            <select id="oaFreq">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <label class="oa-field" id="oaDayWrap" hidden>Day
            <select id="oaDay">
              ${DAYS.map((d, i) => `<option value="${i}"${i === 1 ? " selected" : ""}>${d}</option>`).join("")}
            </select>
          </label>
          <span class="oa-muted" style="font-size:12px;padding-bottom:8px">Runs at 00:00 (Copenhagen).</span>
        </div>

        <div class="oa-muted" style="font-size:12px;margin-bottom:4px">Notify</div>
        <div class="oa-mode">
          <label><input type="radio" name="oaMode" value="always" checked>
            <span>Every run while an item is in overage <small>A daily alert is a daily reminder until the overage clears.</small></span></label>
          <label><input type="radio" name="oaMode" value="onChange">
            <span>Only when an item enters overage <small>Silent while it stays over. A mail that was lost is not repeated in this mode.</small></span></label>
        </div>

        <div class="oa-row">
          <label class="oa-field">Recipients (comma-separated)
            <input type="text" id="oaRecipients" placeholder="name@company.com, other@company.com">
          </label>
        </div>

        <button type="button" class="btn" id="oaCreateBtn" disabled>Create alert</button>
      </div>

      <div class="oa-card" id="oaListCard" hidden>
        <h2>Alerts for <span id="oaListOrg"></span></h2>
        <div id="oaList"></div>
      </div>
    </div>
  `;

  const $ = (id) => el.querySelector("#" + id);
  const $orgName = $("oaOrgName"), $status = $("oaStatus"), $create = $("oaCreate"), $items = $("oaItems");
  const $freq = $("oaFreq"), $dayWrap = $("oaDayWrap"), $day = $("oaDay"), $recipients = $("oaRecipients");
  const $createBtn = $("oaCreateBtn"), $listCard = $("oaListCard"), $listOrg = $("oaListOrg"), $list = $("oaList");
  const setStatus = makeStatus($status, "cs-status");

  let currentOrg = null;
  let candidates = [];   // { kind, name, label, over, current }
  let alerts     = [];

  $freq.addEventListener("change", () => { $dayWrap.hidden = $freq.value !== "weekly"; });

  // ── What can be watched: whatever the current period contains ─────────

  function renderItems() {
    $items.innerHTML = "";
    for (const c of candidates) {
      const row = document.createElement("label");
      row.className = "oa-item";
      const key = c.kind === "licence" ? "licence:" + c.name : c.kind;
      row.innerHTML = `
        <input type="checkbox" data-key="${escapeHtml(key)}">
        <span>${escapeHtml(c.label)}</span>
        ${c.over ? `<span class="oa-over">currently over</span>` : ""}
        ${c.kind === "adminTool" ? `<span class="oa-thr">when more than <input type="number" min="0" step="1" id="oaThreshold" value="${Number.isFinite(c.current) ? c.current : 0}"> users are named</span>` : ""}`;
      row.querySelector("input[type=checkbox]").addEventListener("change", updateCreateBtn);
      $items.appendChild(row);
    }
    if (!candidates.length) $items.innerHTML = `<div class="oa-empty">Nothing in the current period to watch.</div>`;
    updateCreateBtn();
  }

  function selectedItems() {
    const out = [];
    for (const cb of $items.querySelectorAll("input[type=checkbox]:checked")) {
      const key = cb.getAttribute("data-key");
      if (key.startsWith("licence:")) out.push({ kind: "licence", name: key.slice(8) });
      else if (key === "aiTokens") out.push({ kind: "aiTokens" });
      else if (key === "adminTool") {
        const t = Number(el.querySelector("#oaThreshold")?.value);
        out.push({ kind: "adminTool", threshold: Number.isFinite(t) && t >= 0 ? Math.floor(t) : 0 });
      }
    }
    return out;
  }

  function updateCreateBtn() {
    const n = selectedItems().length;
    $createBtn.disabled = n === 0;
    $createBtn.textContent = n === 0 ? "Create alert" : `Create alert (${n} item${n === 1 ? "" : "s"})`;
  }

  async function loadCandidates(org) {
    setStatus(`Reading the current billing period for ${org.name}…`);
    try {
      const overview  = await fetchBillingOverview(api, org.id, 0);
      const processed = processBillingOverview(overview);
      candidates = processed.regularRows.map((r) => ({
        kind: "licence", name: r.name, label: r.name,
        over: typeof r.onDemand === "number" && r.onDemand > 0,
      }));
      if (processed.summary.hasAi) {
        candidates.push({ kind: "aiTokens", label: "AI Tokens", over: processed.summary.aiBillable > 0 });
      }
      const n = processed.summary.adminToolUsers;
      candidates.push({ kind: "adminTool", label: "Admin Tool", over: false, current: typeof n === "number" ? n : 0 });
      renderItems();
      $create.hidden = false;
      const simNote = overview && overview.simulated ? "Simulated billing data — the Genesys figures are not real; the Admin Tool count is. " : "";
      setStatus(`${simNote}Current period: ${processed.summary.startDate} to ${processed.summary.endDate}.`, simNote ? "warn" : "");
    } catch (err) {
      candidates = [];
      $create.hidden = true;
      setStatus(isPermanentBillingState(err) ? err.message : `Could not read the current billing period: ${err.message || err}`, isPermanentBillingState(err) ? "warn" : "error");
    }
  }

  // ── Existing alerts for this org ───────────────────────────────────────

  function describeItems(items) {
    return (items || []).map((i) =>
      i.kind === "licence" ? i.name : i.kind === "aiTokens" ? "AI Tokens" : `Admin Tool > ${i.threshold ?? 0}`
    ).join(", ");
  }

  function describeWhen(s) {
    return s.scheduleType === "weekly" ? `Weekly, ${DAYS[s.scheduleDayOfWeek] || "?"} 00:00` : "Daily 00:00";
  }

  function renderList() {
    $listOrg.textContent = currentOrg ? currentOrg.name : "";
    if (!alerts.length) { $list.innerHTML = `<div class="oa-empty">No alerts yet for this organisation.</div>`; return; }
    $list.innerHTML = `
      <table class="data-table oa-table">
        <thead><tr><th>Watching</th><th>When</th><th>Notify</th><th>Recipients</th><th>Last run</th><th></th></tr></thead>
        <tbody>
          ${alerts.map((s) => `
            <tr>
              <td>${escapeHtml(describeItems(s.exportConfig?.items))}</td>
              <td>${escapeHtml(describeWhen(s))}</td>
              <td>${s.exportConfig?.mode === "onChange" ? "On change" : "Every run"}</td>
              <td class="oa-muted">${escapeHtml(s.emailRecipients || "")}</td>
              <td class="oa-muted">${escapeHtml(formatLastRun(s))} ${escapeHtml(formatLastStatus(s))}</td>
              <td class="oa-actions">${canEditSchedule(s, me) ? `<button type="button" class="btn btn-secondary btn-sm" data-del="${escapeHtml(s.id)}">Delete</button>` : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    $list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => remove(b.getAttribute("data-del"))));
  }

  async function loadAlerts() {
    try {
      const all = await fetchSchedules();
      alerts = (all || []).filter((s) => s.exportType === EXPORT_TYPE && s.exportConfig?.orgId === currentOrg.id);
      renderList();
      $listCard.hidden = false;
    } catch (err) {
      alerts = []; renderList(); $listCard.hidden = false;
      setStatus(`Could not load alerts: ${err.message || err}`, "error");
    }
  }

  // ── Create / delete ────────────────────────────────────────────────────

  $createBtn.addEventListener("click", async () => {
    if (!currentOrg) return;
    const items = selectedItems();
    if (!items.length) return;
    const freq = $freq.value === "weekly" ? "weekly" : "daily";
    const day  = Number($day.value);
    const mode = el.querySelector("input[name=oaMode]:checked")?.value === "onChange" ? "onChange" : "always";
    const recipients = $recipients.value.trim();
    if (!recipients) { setStatus("Add at least one recipient.", "error"); return; }

    const ok = window.confirm(
      `Create an overage alert for ${currentOrg.name}?\n\n` +
      `Watching: ${describeItems(items)}\n` +
      `When: ${freq === "weekly" ? `every ${DAYS[day]} at 00:00` : "daily at 00:00"}\n` +
      `Notify: ${mode === "onChange" ? "only when an item enters overage" : "every run while an item is in overage"}\n` +
      `Recipients: ${recipients}\n\n` +
      `A mail is sent only when something is over.`
    );
    if (!ok) return;

    setStatus("Creating alert…");
    try {
      await createSchedule({
        exportType: EXPORT_TYPE,
        exportLabel: EXPORT_LABEL,
        scheduleType: freq,
        scheduleTime: "00:00",
        scheduleDayOfWeek: freq === "weekly" ? day : null,
        enabled: true,
        emailRecipients: recipients,
        emailMessage: "",
        exportConfig: { orgId: currentOrg.id, orgName: currentOrg.name, items, mode },
        userEmail: me?.email || "", userName: me?.name || "", userId: me?.id || "",
      });
      logAction({ me, orgId: currentOrg.id, orgName: currentOrg.name, action: "billing.overageAlert.create",
        description: `Created overage alert for '${currentOrg.name}': ${describeItems(items)} (${freq}, ${mode})` });
      setStatus("Alert created.", "ok");
      for (const cb of $items.querySelectorAll("input[type=checkbox]")) cb.checked = false;
      updateCreateBtn();
      await loadAlerts();
    } catch (err) {
      setStatus(`Could not create the alert: ${err.message || err}`, "error");
    }
  });

  async function remove(id) {
    const s = alerts.find((a) => a.id === id);
    if (!s) return;
    if (!window.confirm(`Delete this alert?\n\nWatching: ${describeItems(s.exportConfig?.items)}\n${describeWhen(s)}`)) return;
    try {
      await deleteSchedule(id, me?.email || "");
      logAction({ me, orgId: currentOrg.id, orgName: currentOrg.name, action: "billing.overageAlert.delete",
        description: `Deleted overage alert for '${currentOrg.name}': ${describeItems(s.exportConfig?.items)}` });
      await loadAlerts();
      setStatus("Alert deleted.", "ok");
    } catch (err) {
      setStatus(`Could not delete the alert: ${err.message || err}`, "error");
    }
  }

  // ── Org wiring ─────────────────────────────────────────────────────────

  function setOrg(org) {
    currentOrg = org || null;
    candidates = []; alerts = [];
    if (!currentOrg) {
      $orgName.textContent = "Select a customer org in the header.";
      $create.hidden = true; $listCard.hidden = true; setStatus("");
      return;
    }
    $orgName.textContent = currentOrg.name;
    if (!orgContext.isCustomer() && isTrusteeOrg(currentOrg.id)) {
      $create.hidden = true; $listCard.hidden = true;
      setStatus(`${currentOrg.name} is a trustee organisation and has no billing to watch.`, "warn");
      return;
    }
    loadCandidates(currentOrg);
    loadAlerts();
  }

  setOrg(orgContext?.getDetails?.() || null);
  const unsubscribe = orgContext?.onChange?.(() => setOrg(orgContext?.getDetails?.() || null));
  el.__destroy = () => unsubscribe?.();
  return el;
}
