/**
 * Deployment › Onboarding
 *
 * One-shot onboarding of a curated template set from a SOURCE (demo) org into a
 * TARGET customer org. The operator selects only callflows; the backend resolves
 * their dependencies (common modules, in-queue flows, data tables, data actions),
 * strips the "Template - " prefix, and publishes everything into the target org
 * under the chosen division.
 *
 * This module is the UI. The heavy lifting (flow export/transform/publish via the
 * Flow Scripting SDK + data table/action REST) runs in the backend job started by
 * POST /api/onboarding-deploy and polled via GET /api/onboarding-deploy?jobId=…
 * (see docs/onboarding-deployment-design.md).
 */
import { escapeHtml } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";

// Architect flow types the operator can pick as roots (dependencies are resolved
// automatically server-side). Covers inbound flows, supporting flows, and
// post-interaction flows — everything the Flow Scripting SDK can create.
// NB: "outboundcall" is intentionally excluded — onboarding does not support
// outbound call flows (they require a contact list, which has no meaningful
// template equivalent). This is surfaced to the user in the UI.
const ROOT_FLOW_TYPES = new Set([
  // Inbound
  "inboundcall",
  "inboundchat",
  "inboundemail",
  "inboundshortmessage",
  // Supporting
  "bot",
  "digitalbot",
  "commonmodule",
  "inqueuecall",
  "inqueueemail",
  "inqueueshortmessage",
  "securecall",
  "voicemail",
  "workflow",
  "workitem",
  // Post interaction
  "voicesurvey",
  "surveyinvite",
]);

// Human-readable labels for the callflow type filter.
const FLOW_TYPE_LABELS = {
  inboundcall: "Inbound Call",
  inboundchat: "Inbound Chat",
  inboundemail: "Inbound Email",
  inboundshortmessage: "Inbound Message",
  bot: "Bot Flow",
  digitalbot: "Digital Bot Flow",
  commonmodule: "Common Module",
  inqueuecall: "In-Queue Call",
  inqueueemail: "In-Queue Email",
  inqueueshortmessage: "In-Queue Message",
  securecall: "Secure Call",
  voicemail: "Voicemail",
  workflow: "Workflow",
  workitem: "Workitem Flow",
  voicesurvey: "Voice Survey",
  surveyinvite: "Web Survey Invite",
};

// Canonical deploy phases (in the order the runner emits them) for the progress
// stepper. Some phases (Scripts, Survey forms) only appear when relevant.
const CANON_PHASES = [
  { name: "Export & discover", short: "Export" },
  { name: "Data tables", short: "Data tables" },
  { name: "Data actions", short: "Data actions" },
  { name: "Scripts", short: "Scripts" },
  { name: "Survey forms", short: "Survey forms" },
  { name: "Flows", short: "Flows" },
];

// Item status → glyph + colour. `none` is the informational "nothing to do" row
// the runner records for a phase with no items; unknown statuses read as errors.
const ITEM_ICON  = { ok: "✓", skipped: "↷", error: "✗", none: "–" };
const ITEM_COLOR = { ok: "#4ade80", skipped: "#fbbf24", error: "#f87171", none: "var(--muted)" };

// Derive a phase's display state from the polled job.
function stepStateFor(job, name) {
  const phases = job.phases || [];
  const running = job.status === "running" || job.status === "queued";
  const idx = phases.findIndex(p => p.phase === name);
  if (idx === -1) {
    // Jobs that ran before phases were recorded unconditionally can still be
    // missing one entirely — keep treating that as passed over.
    const canonIdx = CANON_PHASES.findIndex(p => p.name === name);
    const laterPresent = phases.some(p => CANON_PHASES.findIndex(c => c.name === p.phase) > canonIdx);
    if (laterPresent) return "skipped";        // passed over (not applicable)
    return running ? "pending" : "skipped";
  }
  const p = phases[idx];
  const items = p.items || [];
  const hasError = items.some(i => i.status === "error");
  const isLast = idx === phases.length - 1;
  if (job.status === "running" && isLast) return "running";
  if (hasError) return "error";
  // Ran, but there was nothing to do — shown, not dimmed, so the phase reads as
  // "completed with nothing to deploy" rather than disappearing.
  if (items.length && items.every(i => i.status === "none")) return "empty";
  return "done";
}

export default function renderOnboarding({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const customers = orgContext.getCustomers();
  const orgOptions = `<option value="">Select org…</option>`
    + customers.map(c =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.region)})</option>`
    ).join("");

  el.innerHTML = `
    <style>
      @keyframes ob-spin { to { transform: rotate(360deg); } }
      .ob-spin { animation: ob-spin .8s linear infinite; }
    </style>
    <h2>Deployment — Onboarding</h2>
    <p class="page-desc">
      Deploy a template set from a demo org into a customer org. Pick the source
      (demo) org, the target customer and division, then choose the callflows to
      deploy. Their dependencies — common modules, in-queue flows, data tables and
      data actions — are found automatically, renamed (dropping the
      <code>Template -&nbsp;</code> prefix) and deployed in the right order.
    </p>

    <div class="dt-controls">
      <div class="dt-control-group">
        <label class="dt-label">Source Org (demo)</label>
        <div style="display:flex;align-items:center;gap:10px">
          <select class="dt-select" id="obSrcOrg" disabled>${orgOptions}</select>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap" title="Unlock to pick a source org other than the Demo template org">
            <input type="checkbox" id="obOtherOrgs"> <span>Other orgs</span>
          </label>
        </div>
      </div>

      <div class="dt-control-group">
        <label class="dt-label">Target Customer Org</label>
        <select class="dt-select" id="obDestOrg">${orgOptions}</select>
      </div>

      <div class="dt-control-group">
        <label class="dt-label">Target Division</label>
        <div style="display:flex;align-items:center;gap:10px">
          <select class="dt-select" id="obDivision" disabled>
            <option value="">Select target org first…</option>
          </select>
          <button class="btn btn--secondary" id="obNewDivBtn" disabled title="Create a new division in the target org">Create New</button>
        </div>
      </div>

      <div class="dt-actions" style="margin-bottom:12px">
        <button class="btn" id="obLoadBtn" disabled>Load Callflows from Source</button>
      </div>
    </div>

    <div class="dt-actions" style="margin:0 0 12px;display:flex;align-items:center;gap:10px">
      <button class="btn" id="obDeployBtn" disabled>Deploy…</button>
      <input class="dt-input" id="obPrefix" type="text" placeholder="Name prefix (optional)" style="max-width:220px" title="Created objects will be named “prefix - Original name”" />
    </div>

    <details class="dt-control-group" id="obFlowsWrap" hidden open>
      <summary class="dt-label" style="cursor:pointer;user-select:none">Callflows to deploy</summary>
      <div class="ob-select-bar" style="display:flex;align-items:center;gap:12px;margin:6px 0">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="obSelectAll"> <span>Select all</span>
        </label>
        <input class="dt-input" id="obFilter" type="text" placeholder="Filter by name…" style="max-width:260px" />
        <select class="dt-select" id="obTypeFilter" style="max-width:200px" title="Filter by callflow type">
          <option value="">All types</option>
        </select>
        <span id="obSelCount" style="color:var(--muted);font-size:.85rem;margin-left:auto"></span>
      </div>
      <p style="margin:2px 0 8px;color:var(--muted);font-size:.82rem">
        Outbound call flows aren’t supported by onboarding and are excluded from this list.
      </p>
      <ul id="obFlowList" style="list-style:none;padding:0;margin:0;max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:6px"></ul>
    </details>

    <div class="ob-steps" id="obSteps" hidden style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0 4px"></div>

    <div class="dt-status" id="obStatus">Select a source and target org to begin.</div>

    <ul id="obResults" style="list-style:none;padding:0;margin-top:12px;max-height:420px;overflow-y:auto"></ul>
  `;

  // ── DOM refs ──────────────────────────────────────────
  const $srcOrg   = el.querySelector("#obSrcOrg");
  const $otherOrgs = el.querySelector("#obOtherOrgs");
  const $destOrg  = el.querySelector("#obDestOrg");
  const $division = el.querySelector("#obDivision");
  const $newDivBtn = el.querySelector("#obNewDivBtn");
  const $loadBtn  = el.querySelector("#obLoadBtn");
  const $flowsWrap = el.querySelector("#obFlowsWrap");
  const $selectAll = el.querySelector("#obSelectAll");
  const $filter   = el.querySelector("#obFilter");
  const $selCount = el.querySelector("#obSelCount");
  const $typeFilter = el.querySelector("#obTypeFilter");
  const $flowList = el.querySelector("#obFlowList");
  const $deployBtn = el.querySelector("#obDeployBtn");
  const $prefix   = el.querySelector("#obPrefix");
  const $status   = el.querySelector("#obStatus");
  const $results  = el.querySelector("#obResults");
  const $steps    = el.querySelector("#obSteps");

  // ── State ─────────────────────────────────────────────
  let flows = [];                 // root callflows loaded from source
  const selected = new Set();     // selected flow ids

  // ── Helpers ───────────────────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "dt-status" + (type ? ` dt-status--${type}` : "");
  }

  function orgName(id) {
    const c = customers.find(c => c.id === id);
    return c ? c.name : id;
  }

  function updateLoadBtn() {
    $loadBtn.disabled =
      !$srcOrg.value || !$destOrg.value || $srcOrg.value === $destOrg.value;
  }

  function updateDeployBtn() {
    $deployBtn.disabled =
      !$destOrg.value || !$division.value || selected.size === 0;
  }

  function updateSelCount() {
    $selCount.textContent = selected.size
      ? `${selected.size} callflow${selected.size !== 1 ? "s" : ""} selected`
      : "";
  }

  function visibleFlows() {
    const q = $filter.value.trim().toLowerCase();
    const t = $typeFilter.value;
    return flows.filter(f =>
      (!q || (f.name || "").toLowerCase().includes(q)) &&
      (!t || (f.type || "").toLowerCase() === t)
    );
  }

  // Populate the type filter with the distinct callflow types actually loaded,
  // sorted alphabetically by their displayed label.
  function populateTypeFilter() {
    const types = [...new Set(flows.map(f => (f.type || "").toLowerCase()).filter(Boolean))]
      .sort((a, b) => (FLOW_TYPE_LABELS[a] || a).localeCompare(FLOW_TYPE_LABELS[b] || b));
    const cur = $typeFilter.value;
    $typeFilter.innerHTML = `<option value="">All types</option>`
      + types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(FLOW_TYPE_LABELS[t] || t)}</option>`).join("");
    $typeFilter.value = types.includes(cur) ? cur : "";
  }

  function renderFlowList() {
    const list = visibleFlows();
    $flowList.innerHTML = "";
    if (!list.length) {
      const li = document.createElement("li");
      li.style.cssText = "padding:10px;color:var(--muted)";
      li.textContent = "No callflows match.";
      $flowList.appendChild(li);
      return;
    }
    for (const f of list) {
      const li = document.createElement("li");
      li.style.cssText = "padding:6px 10px;border-bottom:1px solid var(--border)";
      li.innerHTML = `
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" data-id="${escapeHtml(f.id)}" ${selected.has(f.id) ? "checked" : ""}>
          <span>${escapeHtml(f.name || "(unnamed)")}</span>
          <span style="color:var(--muted);font-size:.8rem;margin-left:auto">${escapeHtml(f.type || "")}</span>
        </label>`;
      $flowList.appendChild(li);
    }
  }

  // ── Load target divisions ─────────────────────────────
  async function loadDivisions(orgId) {
    $division.disabled = true;
    $division.innerHTML = `<option value="">Loading divisions…</option>`;
    try {
      const divisions = await gc.fetchAllDivisions(api, orgId);
      const opts = (divisions || [])
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
        .map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`)
        .join("");
      $division.innerHTML = `<option value="">Select division…</option>` + opts;
      $division.disabled = false;
    } catch (err) {
      $division.innerHTML = `<option value="">Failed to load divisions</option>`;
      setStatus(`Could not load divisions: ${err.message}`, "error");
    }
  }

  // ── Load source callflows ─────────────────────────────
  async function loadFlows() {
    const srcOrgId = $srcOrg.value;
    if (!srcOrgId) return;
    $loadBtn.disabled = true;
    setStatus("Loading callflows from source org…");
    $results.innerHTML = "";
    try {
      const all = await gc.fetchAllFlows(api, srcOrgId);
      flows = (all || [])
        .filter(f => ROOT_FLOW_TYPES.has((f.type || "").toLowerCase()))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      selected.clear();
      $steps.hidden = true;
      populateTypeFilter();
      renderFlowList();
      $flowsWrap.hidden = flows.length === 0;
      updateSelCount();
      updateDeployBtn();
      setStatus(
        flows.length
          ? `Loaded ${flows.length} callflow${flows.length !== 1 ? "s" : ""} from ${orgName(srcOrgId)}.`
          : `No callflows found in ${orgName(srcOrgId)}.`,
        flows.length ? "success" : ""
      );
    } catch (err) {
      setStatus(`Failed to load callflows: ${err.message}`, "error");
    } finally {
      updateLoadBtn();
    }
  }

  // ── Deploy ────────────────────────────────────────────
  function buildPlan() {
    return {
      sourceOrgId: $srcOrg.value,
      targetOrgId: $destOrg.value,
      divisionId: $division.value,
      divisionName: $division.selectedOptions[0]?.textContent || "",
      namePrefix: $prefix.value.trim(),
      // Who to attribute the deploy to. The job runs later, in the runner app,
      // long after this session is gone — so the operator's identity travels
      // with the job and the runner writes the activity-log entry as them.
      startedBy: me?.email || "",
      startedByName: me?.name || "",
      startedById: me?.id || "",
      flows: flows
        .filter(f => selected.has(f.id))
        .map(f => ({ id: f.id, name: f.name, type: (f.type || "").toLowerCase() })),
    };
  }

  async function startDeploy(plan) {
    setStatus("Starting deployment…");
    $deployBtn.disabled = true;
    try {
      const { jobId } = await api.appRequest("/api/onboarding-deploy", { method: "POST", body: plan });
      setStatus(`Deployment job created (${jobId}).`);
      renderPlanPreview(plan);
      $steps.hidden = false;
      renderSteps({ status: "queued", phases: [] });
      pollJob(jobId, 0);
    } catch (err) {
      const detail = Array.isArray(err.body?.details) ? err.body.details.join("; ") : err.message;
      setStatus(`Could not start deployment: ${detail}`, "error");
      updateDeployBtn();
    }
  }

  async function pollJob(jobId, attempt) {
    let job;
    try {
      job = await api.appRequest("/api/onboarding-deploy", { query: { jobId } });
    } catch (err) {
      setStatus(`Lost track of job ${jobId}: ${err.message}`, "error");
      updateDeployBtn();
      return;
    }
    renderJob(job);
    renderSteps(job);

    const terminal = ["succeeded", "partial", "failed"].includes(job.status);
    if (terminal) {
      setStatus(
        job.status === "succeeded" ? "Deployment complete." :
        job.status === "partial" ? "Deployment finished with some issues — see results." :
        `Deployment failed${job.error ? `: ${job.error}` : ""}.`,
        job.status === "succeeded" ? "success" : job.status === "failed" ? "error" : ""
      );
      updateDeployBtn();
      return;
    }

    // Non-terminal: reflect the current phase in the status text.
    if (job.status === "running") {
      const cur = (job.phases || []).slice(-1)[0];
      const n = cur ? (cur.items || []).length : 0;
      setStatus(cur ? `Deploying… ${cur.phase}${n ? ` — ${n} processed` : ""}` : "Deploying…");
    } else if (job.status === "queued") {
      setStatus("Queued — waiting for the deploy runner to start the job…");
    }

    // Still queued/running. The runner picks up queued jobs on a ~1-minute timer,
    // so keep polling for a couple of minutes before concluding it isn't active.
    if (job.status === "queued" && attempt >= 45) {
      setStatus(
        `Job ${jobId} is still queued after a while. The deploy runner may not be ` +
        "active in this environment yet — it will pick this job up once running.",
        ""
      );
      updateDeployBtn();
      return;
    }
    setTimeout(() => pollJob(jobId, attempt + 1), 3000);
  }

  // ── Phase progress stepper ────────────────────────────
  function renderSteps(job) {
    const glyph = { done: "✓", pending: "○", error: "✗", skipped: "–", empty: "–" };
    const color = { done: "#4ade80", running: "var(--accent,#60a5fa)", pending: "var(--muted)", error: "#f87171", skipped: "var(--muted)", empty: "var(--muted)" };
    $steps.innerHTML = CANON_PHASES.map(ph => {
      const st = stepStateFor(job, ph.name);
      const dim = (st === "skipped" || st === "pending") ? "opacity:.5;" : "";
      const bd = st === "running" ? "border-color:var(--accent,#60a5fa);" : "";
      const icon = st === "running"
        ? `<span class="ob-spin" style="width:11px;height:11px;border:2px solid var(--accent,#60a5fa);border-top-color:transparent;border-radius:50%;display:inline-block"></span>`
        : `<span style="color:${color[st]};font-weight:700">${glyph[st]}</span>`;
      return `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border:1px solid var(--border);border-radius:999px;font-size:.8rem;${bd}${dim}">${icon}<span>${escapeHtml(ph.short)}</span></span>`;
    }).join("");
  }

  function renderJob(job) {
    if (!Array.isArray(job.phases) || !job.phases.length) return;
    $results.innerHTML = "";
    for (const phase of job.phases) {
      const head = document.createElement("li");
      head.style.cssText = "padding:6px 0 2px;font-weight:600;color:var(--accent,#60a5fa)";
      head.textContent = phase.phase;
      $results.appendChild(head);
      for (const item of phase.items || []) {
        const li = document.createElement("li");
        li.style.cssText = "padding:4px 0;border-bottom:1px solid var(--border)";
        const st = ITEM_ICON[item.status] ? item.status : "error";
        const icon = ITEM_ICON[st];
        const color = ITEM_COLOR[st];
        const label = item.new || item.old || "";
        li.innerHTML = `<span style="color:${color}">${icon}</span> ${escapeHtml(label)}` +
          (item.detail ? ` <span style="color:var(--muted);font-size:.82em">${escapeHtml(item.detail)}</span>` : "");
        $results.appendChild(li);
      }
    }
    for (const w of job.warnings || []) {
      const li = document.createElement("li");
      li.style.cssText = "padding:6px 0;color:#fbbf24;font-size:.85rem";
      li.textContent = "⚠ " + w;
      $results.appendChild(li);
    }
  }

  function renderPlanPreview(plan) {
    $results.innerHTML = "";
    const head = document.createElement("li");
    head.style.cssText = "padding:6px 0;font-weight:600;color:var(--accent,#60a5fa)";
    head.textContent = `Planned deploy → ${orgName(plan.targetOrgId)} · division ${plan.divisionName}`;
    $results.appendChild(head);
    for (const f of plan.flows) {
      const li = document.createElement("li");
      li.style.cssText = "padding:4px 0;border-bottom:1px solid var(--border)";
      li.innerHTML = `<span>${escapeHtml(f.name)}</span> <span style="color:var(--muted);font-size:.8rem">${escapeHtml(f.type)}</span>`;
      $results.appendChild(li);
    }
    const note = document.createElement("li");
    note.style.cssText = "padding:8px 0;color:var(--muted);font-size:.85rem";
    note.textContent = "Dependencies (common modules, in-queue flows, data tables, data actions) are discovered and deployed automatically by the backend engine.";
    $results.appendChild(note);
  }

  function showConfirm(plan) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center";
    overlay.innerHTML = `
      <div style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:24px;min-width:360px;max-width:640px;width:90%">
        <h3 style="margin:0 0 16px;font-size:1.1rem">Confirm Onboarding Deploy</h3>
        <table style="width:100%;border-collapse:collapse;font-size:.9rem">
          <tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Source (demo)</td><td><strong>${escapeHtml(orgName(plan.sourceOrgId))}</strong></td></tr>
          <tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Target</td><td><strong>${escapeHtml(orgName(plan.targetOrgId))}</strong></td></tr>
          <tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Division</td><td><strong>${escapeHtml(plan.divisionName)}</strong></td></tr>
          ${plan.namePrefix ? `<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Name prefix</td><td><strong>${escapeHtml(plan.namePrefix)} - …</strong></td></tr>` : ""}
          <tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Callflows</td><td><strong>${plan.flows.length}</strong></td></tr>
        </table>
        <ul style="margin:12px 0 0;padding-left:18px;max-height:200px;overflow-y:auto;font-size:.9rem">
          ${plan.flows.map(f => `<li>${escapeHtml(f.name)} <span style="color:var(--muted)">(${escapeHtml(f.type)})</span></li>`).join("")}
        </ul>
        <p style="margin:12px 0 0;color:var(--muted);font-size:.85rem">
          Dependencies are found and deployed automatically. Objects that already
          exist in the target (matched by their stripped name) are skipped.
        </p>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
          <button id="obCancel" class="btn btn--secondary">Cancel</button>
          <button id="obConfirm" class="btn">Deploy</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#obCancel").addEventListener("click", () => document.body.removeChild(overlay));
    overlay.querySelector("#obConfirm").addEventListener("click", () => {
      document.body.removeChild(overlay);
      startDeploy(plan);
    });
  }

  // ── Create a new division in the target org ───────────
  function showCreateDivision() {
    const targetId = $destOrg.value;
    if (!targetId) return;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center";
    overlay.innerHTML = `
      <div style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:24px;min-width:340px;max-width:460px;width:90%">
        <h3 style="margin:0 0 14px;font-size:1.1rem">Create Division in ${escapeHtml(orgName(targetId))}</h3>
        <label class="dt-label" for="obNewDivName">Division name</label>
        <input class="dt-input" id="obNewDivName" type="text" placeholder="New division name" style="width:100%;margin-top:4px" />
        <div id="obNewDivErr" style="color:#f87171;font-size:.85rem;margin-top:8px;min-height:1em"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
          <button id="obNewDivCancel" class="btn btn--secondary">Cancel</button>
          <button id="obNewDivCreate" class="btn">Create</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const $name = overlay.querySelector("#obNewDivName");
    const $err = overlay.querySelector("#obNewDivErr");
    const $cancel = overlay.querySelector("#obNewDivCancel");
    const $create = overlay.querySelector("#obNewDivCreate");
    const close = () => { if (overlay.parentNode) document.body.removeChild(overlay); };
    $name.focus();
    $cancel.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    $name.addEventListener("keydown", (e) => { if (e.key === "Enter") $create.click(); });
    $create.addEventListener("click", async () => {
      const name = $name.value.trim();
      if (!name) { $err.textContent = "Please enter a division name."; return; }
      $create.disabled = true; $cancel.disabled = true; $err.textContent = "Creating…";
      try {
        const created = await gc.createDivision(api, targetId, { name });
        close();
        await loadDivisions(targetId);
        if (created && created.id) { $division.value = created.id; }
        updateDeployBtn();
        setStatus(`Created division “${name}” in ${orgName(targetId)}.`, "success");
      } catch (err) {
        $create.disabled = false; $cancel.disabled = false;
        $err.textContent = `Could not create division: ${err.message || err}`;
      }
    });
  }

  // ── Events ────────────────────────────────────────────
  $srcOrg.addEventListener("change", () => { updateLoadBtn(); });
  $destOrg.addEventListener("change", () => {
    updateLoadBtn();
    $newDivBtn.disabled = !$destOrg.value;
    if ($destOrg.value) loadDivisions($destOrg.value);
    else { $division.innerHTML = `<option value="">Select target org first…</option>`; $division.disabled = true; }
    updateDeployBtn();
  });
  $division.addEventListener("change", updateDeployBtn);
  $newDivBtn.addEventListener("click", showCreateDivision);
  $loadBtn.addEventListener("click", loadFlows);
  $filter.addEventListener("input", renderFlowList);
  $typeFilter.addEventListener("change", renderFlowList);

  $selectAll.addEventListener("change", () => {
    const list = visibleFlows();
    if ($selectAll.checked) list.forEach(f => selected.add(f.id));
    else list.forEach(f => selected.delete(f.id));
    renderFlowList();
    updateSelCount();
    updateDeployBtn();
  });

  $flowList.addEventListener("change", (e) => {
    const cb = e.target.closest("input[type=checkbox][data-id]");
    if (!cb) return;
    if (cb.checked) selected.add(cb.dataset.id);
    else selected.delete(cb.dataset.id);
    updateSelCount();
    updateDeployBtn();
  });

  $deployBtn.addEventListener("click", () => {
    const plan = buildPlan();
    if (!plan.flows.length) return;
    $flowsWrap.open = false; // collapse the callflows list when deploying
    showConfirm(plan);
  });

  // ── Init: default the source org to the "Demo" template org and lock the
  //    field. The "Other orgs" checkbox unlocks it for selecting a different source.
  const demoOrg = customers.find(c => (c.name || "").trim().toLowerCase() === "demo")
    || customers.find(c => (c.name || "").toLowerCase().includes("demo"));
  if (demoOrg) $srcOrg.value = demoOrg.id;
  $srcOrg.disabled = true;
  updateLoadBtn();

  $otherOrgs.addEventListener("change", () => {
    $srcOrg.disabled = !$otherOrgs.checked;
    if (!$otherOrgs.checked && demoOrg) $srcOrg.value = demoOrg.id;
    updateLoadBtn();
  });

  return el;
}
