/**
 * Roles › Copy — Between Orgs
 *
 * Copies an authorization role from one customer org to another, with a full
 * permission builder to review and edit before creating.
 *
 * Flow:
 *   1. Pick source org + target org
 *   2. "Load Source Roles" — pulls roles from source, and permission catalogs
 *      from both orgs
 *   3. Pick source role — pre-fills the builder; permissions absent from the
 *      target org's catalog are flagged with ⚠ but kept (user can remove)
 *   4. Edit name ("Copy of …"), description, and permissions as needed
 *   5. "Create in Target Org" — POST to target org
 *
 * API endpoints:
 *   GET  /api/v2/authorization/roles               — list all roles
 *   GET  /api/v2/authorization/roles/{id}          — full role detail
 *   GET  /api/v2/authorization/permissions         — permission catalog
 *   GET  /api/v2/routing/queues                    — queues  (lazy, condition values)
 *   GET  /api/v2/routing/skills                    — skills  (lazy, condition values)
 *   GET  /api/v2/authorization/divisions           — divisions (lazy, condition values)
 *   POST /api/v2/authorization/roles               — create role in target org
 */

import { escapeHtml } from "../../../utils.js";
import {
  fetchAllAuthorizationRoles,
  getAuthorizationRole,
  createAuthorizationRole,
} from "../../../services/genesysApi.js";
import { HOURLY_DISQUALIFYING_PERMISSIONS } from "../../../lib/hourlyDisqualifyingPermissions.js";

// ── Permission catalog ─────────────────────────────────────────────────────────
async function loadCatalog(api, orgId) {
  const catalog = {};
  let page = 1, pageCount = null;
  do {
    const resp = await api.proxyGenesys(orgId, "GET", "/api/v2/authorization/permissions", {
      query: { pageSize: "100", pageNumber: String(page) },
    });
    pageCount = resp.pageCount ?? 1;
    for (const p of (resp.entities || [])) {
      if (!p.domain || !p.permissionMap) continue;
      if (!catalog[p.domain]) catalog[p.domain] = {};
      for (const [entity, actionList] of Object.entries(p.permissionMap)) {
        const actions = actionList.map(a => a.action).sort();
        const condActions = new Set(actionList.filter(a => a.allowConditions).map(a => a.action));
        catalog[p.domain][entity] = { actions, condActions };
      }
    }
    page++;
  } while (page <= pageCount);
  return catalog;
}

// ── Lazy resource loaders ──────────────────────────────────────────────────────
async function loadQueues(api, orgId) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await api.proxyGenesys(orgId, "GET", "/api/v2/routing/queues", {
      query: { pageSize: "100", pageNumber: String(page) },
    });
    all.push(...(r.entities || []));
    if (all.length >= (r.total ?? 0) || (r.entities || []).length < 100) break;
    page++;
  }
  return all.map(q => ({ id: q.id, name: q.name })).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadSkills(api, orgId) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await api.proxyGenesys(orgId, "GET", "/api/v2/routing/skills", {
      query: { pageSize: "100", pageNumber: String(page) },
    });
    all.push(...(r.entities || []));
    if (all.length >= (r.total ?? 0) || (r.entities || []).length < 100) break;
    page++;
  }
  return all.map(s => ({ id: s.id, name: s.name })).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadDivisions(api, orgId) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await api.proxyGenesys(orgId, "GET", "/api/v2/authorization/divisions", {
      query: { pageSize: "100", pageNumber: String(page) },
    });
    all.push(...(r.entities || []));
    if (all.length >= (r.total ?? 0) || (r.entities || []).length < 100) break;
    page++;
  }
  return all.map(d => ({ id: d.id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Condition helpers ──────────────────────────────────────────────────────────
const MEDIA_TYPES = ["voice", "chat", "email", "screen", "videoComm", "callback"];
const COND_VAR_LABELS = {
  QUEUE_ID:    "Queue(s)",
  MEDIA_TYPE:  "Media Type(s)",
  SKILL_ID:    "Skill(s)",
  DIVISION_ID: "Division(s)",
};

function buildConditionNode(condVar, values, operator) {
  if (!values || values.length === 0) return null;
  return {
    variableName: condVar,
    operator:     operator || "INCLUDES",
    operands:     values.map(v => ({ type: "SCALAR", value: v })),
  };
}

function parseConditionNode(node) {
  if (!node) return null;
  return {
    condVar:  node.variableName || "QUEUE_ID",
    values:   (node.operands || []).map(o => o.value).filter(Boolean),
    operator: node.operator || "INCLUDES",
  };
}

// ── Page renderer ──────────────────────────────────────────────────────────────
export default function renderRolesCopyBetweenOrgs({ me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const customers = orgContext.getCustomers?.() || [];
  const orgOptions =
    `<option value="">Select org…</option>` +
    customers.map(c =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.region)})</option>`
    ).join("");

  el.innerHTML = `
    <style>
      .rcb-page { max-width: 860px; }
      .rcb-section { margin-bottom: 24px; }
      .rcb-label { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; display: block; }
      .rcb-input { width: 100%; padding: 7px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg, var(--panel)); color: var(--text); font: inherit; font-size: 13px; outline: none; box-sizing: border-box; }
      .rcb-input:focus { border-color: #3b82f6; }
      .rcb-input:disabled { opacity: .5; }
      textarea.rcb-input { resize: vertical; min-height: 60px; }
      .rcb-org-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
      .rcb-org-group { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 200px; }
      .rcb-org-select { width: 100%; padding: 7px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg, var(--panel)); color: var(--text); font: inherit; font-size: 13px; outline: none; }
      .rcb-org-select:focus { border-color: #3b82f6; }
      .rcb-combo { position: relative; }
      .rcb-combo-input { width: 100%; padding: 7px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg, var(--panel)); color: var(--text); font: inherit; font-size: 13px; outline: none; box-sizing: border-box; }
      .rcb-combo-input:focus { border-color: #3b82f6; }
      .rcb-combo-input:disabled { opacity: .5; cursor: not-allowed; }
      .rcb-combo-list { display: none; position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 400; max-height: 240px; overflow-y: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
      .rcb-combo-list.open { display: block; }
      .rcb-combo-option { padding: 7px 12px; cursor: pointer; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,.04); }
      .rcb-combo-option:last-child { border-bottom: none; }
      .rcb-combo-option:hover { background: rgba(59,130,246,.15); color: #93c5fd; }
      .rcb-combo-noresult { padding: 10px 12px; font-size: 12px; color: var(--muted); text-align: center; }
      .rcb-picker { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; padding: 14px; background: rgba(255,255,255,.03); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 16px; }
      .rcb-picker-group { display: flex; flex-direction: column; gap: 4px; }
      .rcb-picker-group--domain { min-width: 180px; }
      .rcb-picker-group--entity { min-width: 200px; }
      .rcb-picker-group--actions { flex: 1; min-width: 220px; }
      .rcb-actions-wrap { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }
      .rcb-chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 20px; font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; transition: background .1s, color .1s, border-color .1s; }
      .rcb-chip input { display: none; }
      .rcb-chip.checked { background: rgba(59,130,246,.18); border-color: #3b82f6; color: #93c5fd; }
      .rcb-chip:hover { border-color: #6b7280; color: var(--text); }
      .rcb-add-btn { padding: 7px 20px; background: #3b82f6; color: #fff; border: none; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: background .15s; height: 34px; }
      .rcb-add-btn:hover:not(:disabled) { background: #2563eb; }
      .rcb-add-btn:disabled { opacity: .45; cursor: not-allowed; }
      .rcb-add-all-btn { padding: 7px 16px; background: #1e3a5f; color: #93c5fd; border: 1px solid #3b82f6; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s; height: 34px; }
      .rcb-add-all-btn:hover:not(:disabled) { background: #1d4ed8; color: #fff; }
      .rcb-add-all-btn:disabled { opacity: .45; cursor: not-allowed; }
      .rcb-policies-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
      .rcb-policies-title { font-size: 13px; font-weight: 600; color: var(--text); }
      .rcb-policies-count { font-size: 12px; color: var(--muted); }
      .rcb-policy-list { display: flex; flex-direction: column; gap: 6px; }
      .rcb-policy-row { background: rgba(255,255,255,.03); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
      .rcb-policy-main { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex-wrap: wrap; }
      .rcb-policy-entity { font-size: 13px; font-weight: 600; color: #93c5fd; flex: 1; }
      .rcb-policy-actions { display: flex; gap: 5px; flex-wrap: wrap; }
      .rcb-action-tag { padding: 2px 8px; background: rgba(59,130,246,.15); border: 1px solid #3b82f6; border-radius: 12px; font-size: 11px; color: #93c5fd; font-weight: 600; }
      .rcb-policy-btns { display: flex; gap: 6px; margin-left: auto; }
      .rcb-cond-toggle { padding: 3px 10px; background: transparent; border: 1px solid var(--border); border-radius: 6px; font: inherit; font-size: 11px; color: var(--muted); cursor: pointer; white-space: nowrap; transition: border-color .12s, color .12s; }
      .rcb-cond-toggle:hover { border-color: #6b7280; color: var(--text); }
      .rcb-cond-toggle.active { border-color: #f59e0b; color: #fbbf24; }
      .rcb-remove-btn { padding: 3px 9px; background: transparent; border: 1px solid var(--border); border-radius: 6px; font: inherit; font-size: 12px; color: var(--muted); cursor: pointer; transition: border-color .12s, color .12s; }
      .rcb-remove-btn:hover { border-color: #ef4444; color: #f87171; }
      .rcb-edit-btn { padding: 3px 9px; background: transparent; border: 1px solid var(--border); border-radius: 6px; font: inherit; font-size: 12px; color: var(--muted); cursor: pointer; transition: border-color .12s, color .12s; }
      .rcb-edit-btn:hover { border-color: #6b7280; color: var(--text); }
      .rcb-edit-btn.active { border-color: #3b82f6; color: #93c5fd; }
      .rcb-incompat { font-size: 10px; color: #fbbf24; margin-left: 6px; }
      .rcb-domain { margin-bottom: 3px; }
      .rcb-domain-hdr { display: flex; align-items: center; gap: 10px; padding: 7px 12px; background: rgba(255,255,255,.03); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; user-select: none; }
      .rcb-domain-hdr:hover { background: rgba(255,255,255,.05); }
      .rcb-chevron { font-size: 10px; color: var(--muted); transition: transform .15s; width: 12px; display: inline-block; }
      .rcb-domain.open .rcb-chevron { transform: rotate(90deg); }
      .rcb-domain-name { font-weight: 600; font-size: 13px; color: #fbbf24; flex: 1; }
      .rcb-domain-stats { font-size: 12px; color: var(--muted); }
      .rcb-domain-body { display: none; padding: 4px 0 2px; }
      .rcb-domain.open .rcb-domain-body { display: block; }
      .rcb-cond-panel { border-top: 1px solid var(--border); padding: 12px 14px; background: rgba(0,0,0,.18); display: none; }
      .rcb-cond-panel.open { display: block; }
      .rcb-cond-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
      .rcb-cond-group { display: flex; flex-direction: column; gap: 4px; }
      .rcb-cond-group--var { min-width: 150px; }
      .rcb-cond-group--op { min-width: 130px; }
      .rcb-cond-group--vals { flex: 1; min-width: 240px; }
      .rcb-cond-select { padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg, var(--panel)); color: var(--text); font: inherit; font-size: 13px; outline: none; }
      .rcb-cond-select:focus { border-color: #3b82f6; }
      .rcb-ms-wrap { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; min-height: 34px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg, var(--panel)); cursor: text; }
      .rcb-ms-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: rgba(59,130,246,.18); border: 1px solid #3b82f6; border-radius: 12px; font-size: 11px; color: #93c5fd; white-space: nowrap; }
      .rcb-ms-chip-remove { cursor: pointer; opacity: .7; font-size: 13px; line-height: 1; }
      .rcb-ms-chip-remove:hover { opacity: 1; color: #f87171; }
      .rcb-ms-input { border: none; background: transparent; color: var(--text); font: inherit; font-size: 12px; outline: none; min-width: 80px; flex: 1; }
      .rcb-ms-dropdown { display: none; position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 500; max-height: 200px; overflow-y: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
      .rcb-ms-dropdown.open { display: block; }
      .rcb-ms-option { padding: 7px 12px; cursor: pointer; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,.04); }
      .rcb-ms-option:last-child { border-bottom: none; }
      .rcb-ms-option:hover { background: rgba(59,130,246,.15); color: #93c5fd; }
      .rcb-media-wrap { display: flex; flex-wrap: wrap; gap: 6px; }
      .rcb-edit-panel { border-top: 1px solid var(--border); padding: 10px 14px; background: rgba(0,0,0,.12); display: none; }
      .rcb-edit-panel.open { display: block; }
      .rcb-status { font-size: 13px; color: var(--muted); min-height: 20px; margin-bottom: 10px; }
      .rcb-status--error   { color: #f87171; }
      .rcb-status--success { color: #34d399; }
      .rcb-footer { display: flex; justify-content: flex-end; gap: 10px; padding-top: 8px; border-top: 1px solid var(--border); margin-top: 24px; }
      .rcb-cancel-btn { padding: 8px 22px; background: transparent; color: var(--muted); border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 13px; cursor: pointer; }
      .rcb-cancel-btn:hover { border-color: #6b7280; color: var(--text); }
      .rcb-save-btn { padding: 8px 28px; background: #3b82f6; color: #fff; border: none; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .rcb-save-btn:hover:not(:disabled) { background: #2563eb; }
      .rcb-save-btn:disabled { opacity: .45; cursor: not-allowed; }
      .rcb-no-policies { text-align: center; padding: 32px 16px; color: var(--muted); font-size: 13px; border: 1px dashed var(--border); border-radius: 10px; }
    </style>

    <div class="rcb-page">
      <h2 style="margin:0 0 8px">Roles — Copy between Orgs</h2>
      <p style="font-size:13px;color:var(--muted);margin:0 0 24px">
        Copy an authorization role from one org to another.
        Review and edit permissions before creating.
        Permissions absent from the target org's catalog are flagged with ⚠ — keep or remove them as needed.
      </p>

      <div class="rcb-section">
        <span class="rcb-label">Orgs</span>
        <div class="rcb-org-row">
          <div class="rcb-org-group">
            <span class="rcb-label" style="margin-bottom:4px">Source Org</span>
            <select class="rcb-org-select" id="rcbSrcOrg">${orgOptions}</select>
          </div>
          <div class="rcb-org-group">
            <span class="rcb-label" style="margin-bottom:4px">Target Org</span>
            <select class="rcb-org-select" id="rcbTgtOrg">${orgOptions}</select>
          </div>
        </div>
        <button class="rcb-add-btn" id="rcbLoadBtn" disabled>Load Source Roles</button>
      </div>

      <div class="rcb-section" id="rcbRoleSection" style="display:none">
        <span class="rcb-label">Source Role</span>
        <div class="rcb-combo" id="rcbRoleCombo">
          <input class="rcb-combo-input" id="rcbRoleInput" placeholder="Type to search roles…" autocomplete="off" disabled>
          <div class="rcb-combo-list" id="rcbRoleList"></div>
        </div>
      </div>

      <div id="rcbBuilderSection" style="display:none">
        <div class="rcb-section">
          <label class="rcb-label" for="rcbName">Role Name (in target org) *</label>
          <input class="rcb-input" id="rcbName" placeholder="Enter role name" maxlength="200">
        </div>
        <div class="rcb-section">
          <label class="rcb-label" for="rcbDesc">Description</label>
          <textarea class="rcb-input" id="rcbDesc" placeholder="Optional description" maxlength="500" rows="2"></textarea>
        </div>

        <div class="rcb-section">
          <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text)">
            <input type="checkbox" id="rcbHourlyCheck">
            Make Hourly Interacting
          </label>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">
            Remove disqualifying permissions and add <code>billing:user:hourlyInteracting</code>.
          </div>
        </div>

        <div class="rcb-section">
          <span class="rcb-label">Add Permission</span>
          <div class="rcb-picker">
            <div class="rcb-picker-group rcb-picker-group--domain">
              <span class="rcb-label">Domain</span>
              <div class="rcb-combo" id="rcbDomainCombo">
                <input class="rcb-combo-input" id="rcbDomainInput" placeholder="Type or select…" autocomplete="off" disabled>
                <div class="rcb-combo-list" id="rcbDomainList"></div>
              </div>
            </div>
            <div class="rcb-picker-group rcb-picker-group--entity">
              <span class="rcb-label">Entity</span>
              <div class="rcb-combo" id="rcbEntityCombo">
                <input class="rcb-combo-input" id="rcbEntityInput" placeholder="Select domain first" autocomplete="off" disabled>
                <div class="rcb-combo-list" id="rcbEntityList"></div>
              </div>
            </div>
            <div class="rcb-picker-group rcb-picker-group--actions">
              <span class="rcb-label">Actions</span>
              <div class="rcb-actions-wrap" id="rcbPickerActions">
                <span style="font-size:12px;color:var(--muted)">Select entity first</span>
              </div>
            </div>
            <button class="rcb-add-btn" id="rcbAddBtn" disabled>Add</button>
            <button class="rcb-add-all-btn" id="rcbAddAllBtn" disabled title="Add all entities for the selected domain">Add All Entities</button>
          </div>
        </div>

        <div class="rcb-section">
          <div class="rcb-policies-header">
            <span class="rcb-policies-title">Permissions</span>
            <span class="rcb-policies-count" id="rcbPoliciesCount"></span>
            <span id="rcbIncompatWarn" style="display:none;font-size:12px;color:#fbbf24">⚠ Some permissions may not exist in the target org</span>
            <div style="display:flex;gap:6px;margin-left:auto">
              <button class="rcb-cond-toggle" id="rcbExpandAll">Expand All</button>
              <button class="rcb-cond-toggle" id="rcbCollapseAll">Collapse All</button>
            </div>
          </div>
          <div class="rcb-policy-list" id="rcbPolicyList">
            <div class="rcb-no-policies">No permissions added yet.</div>
          </div>
        </div>
      </div>

      <div class="rcb-status" id="rcbStatus"></div>
      <div class="rcb-footer">
        <button class="rcb-cancel-btn" id="rcbCancelBtn">Cancel</button>
        <button class="rcb-save-btn"   id="rcbSaveBtn" disabled>Create in Target Org</button>
      </div>
    </div>
  `;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $srcOrg        = el.querySelector("#rcbSrcOrg");
  const $tgtOrg        = el.querySelector("#rcbTgtOrg");
  const $loadBtn       = el.querySelector("#rcbLoadBtn");
  const $roleSection   = el.querySelector("#rcbRoleSection");
  const $roleIn        = el.querySelector("#rcbRoleInput");
  const $roleList      = el.querySelector("#rcbRoleList");
  const $builderSection = el.querySelector("#rcbBuilderSection");
  const $name          = el.querySelector("#rcbName");
  const $desc          = el.querySelector("#rcbDesc");
  const $domainIn      = el.querySelector("#rcbDomainInput");
  const $domainList    = el.querySelector("#rcbDomainList");
  const $entityIn      = el.querySelector("#rcbEntityInput");
  const $entityList    = el.querySelector("#rcbEntityList");
  const $pickerActions = el.querySelector("#rcbPickerActions");
  const $addBtn        = el.querySelector("#rcbAddBtn");
  const $addAllBtn     = el.querySelector("#rcbAddAllBtn");
  const $policyList    = el.querySelector("#rcbPolicyList");
  const $polCount      = el.querySelector("#rcbPoliciesCount");
  const $incompatWarn  = el.querySelector("#rcbIncompatWarn");
  const $status        = el.querySelector("#rcbStatus");
  const $saveBtn       = el.querySelector("#rcbSaveBtn");
  const $cancelBtn     = el.querySelector("#rcbCancelBtn");
  const $expandAll     = el.querySelector("#rcbExpandAll");
  const $collapseAll   = el.querySelector("#rcbCollapseAll");
  const $hourlyCheck   = el.querySelector("#rcbHourlyCheck");

  $expandAll.addEventListener("click", () =>
    $policyList.querySelectorAll(".rcb-domain").forEach(d => d.classList.add("open")));
  $collapseAll.addEventListener("click", () =>
    $policyList.querySelectorAll(".rcb-domain").forEach(d => d.classList.remove("open")));

  // ── State ──────────────────────────────────────────────────────────────────
  let srcCatalog    = null;   // source org catalog (wildcard expansion)
  let tgtCatalog    = null;   // target org catalog (permission builder)
  let allRoles      = [];
  let policies      = [];     // [{ domain, entity, actions:Set, condVar, condValues, condOp, condOpen, rowEl, incompat }]
  let pickerDomain  = "";
  let pickerEntity  = "";
  let queuesCache   = null;
  let skillsCache   = null;
  let divisionsCache = null;

  function setStatus(msg, cls = "") {
    $status.textContent = msg;
    $status.className = "rcb-status" + (cls ? ` rcb-status--${cls}` : "");
  }

  function updateSaveBtn() {
    $saveBtn.disabled = !$name.value.trim() || policies.length === 0;
  }

  $name.addEventListener("input", updateSaveBtn);

  // ── Enable Load button when both orgs are selected ─────────────────────────
  function checkLoadEnabled() {
    $loadBtn.disabled = !$srcOrg.value || !$tgtOrg.value;
  }
  $srcOrg.addEventListener("change", checkLoadEnabled);
  $tgtOrg.addEventListener("change", checkLoadEnabled);

  // ── Combobox factory ───────────────────────────────────────────────────────
  function makeCombobox(inputEl, listEl, onSelect) {
    let items = [], current = "";

    function renderList(filter) {
      const q = (filter ?? "").toLowerCase();
      const matched = q ? items.filter(v => v.toLowerCase().includes(q)) : items;
      listEl.innerHTML = matched.length
        ? matched.map(v => `<div class="rcb-combo-option" data-value="${escapeHtml(v)}">${escapeHtml(v)}</div>`).join("")
        : `<div class="rcb-combo-noresult">No results</div>`;
      listEl.classList.add("open");
    }
    function close() { listEl.classList.remove("open"); inputEl.value = current; }
    function select(value) { current = value; inputEl.value = value; listEl.classList.remove("open"); onSelect(value); }

    inputEl.addEventListener("focus", () => { if (!inputEl.disabled) { inputEl.select(); renderList(""); } });
    inputEl.addEventListener("input", () => renderList(inputEl.value));
    inputEl.addEventListener("blur",  () => setTimeout(close, 150));
    listEl.addEventListener("mousedown", e => {
      const opt = e.target.closest(".rcb-combo-option");
      if (opt) select(opt.dataset.value);
    });

    return {
      setItems(newItems) { items = newItems; inputEl.disabled = false; },
      setValue(v) { current = v; inputEl.value = v; },
      clear() { current = ""; inputEl.value = ""; inputEl.placeholder = "Select domain first"; inputEl.disabled = true; },
      get value() { return current; },
    };
  }

  const domainCombo = makeCombobox($domainIn, $domainList, onDomainSelect);
  const entityCombo = makeCombobox($entityIn, $entityList, onEntitySelect);
  const roleCombo   = makeCombobox($roleIn, $roleList, onRoleSelect);

  function onDomainSelect(domain) {
    pickerDomain = domain;
    pickerEntity = "";
    entityCombo.clear();
    $pickerActions.innerHTML = `<span style="font-size:12px;color:var(--muted)">Select entity first</span>`;
    $addBtn.disabled = true;
    $addAllBtn.disabled = !domain;
    if (domain && tgtCatalog?.[domain]) {
      entityCombo.setItems(Object.keys(tgtCatalog[domain]).sort());
      $entityIn.placeholder = "Type or select…";
      $entityIn.disabled    = false;
    }
  }

  function onEntitySelect(entity) {
    pickerEntity = entity;
    $addBtn.disabled = true;
    if (!pickerDomain || !entity || !tgtCatalog?.[pickerDomain]?.[entity]) {
      $pickerActions.innerHTML = `<span style="font-size:12px;color:var(--muted)">Select entity first</span>`;
      return;
    }
    const { actions } = tgtCatalog[pickerDomain][entity];
    $pickerActions.innerHTML = actions.map(a => `
      <label class="rcb-chip">
        <input type="checkbox" value="${escapeHtml(a)}" checked>
        ${escapeHtml(a)}
      </label>
    `).join("");
    $pickerActions.querySelectorAll(".rcb-chip input").forEach(cb => {
      cb.addEventListener("change", () => {
        const anyChecked = [...$pickerActions.querySelectorAll(".rcb-chip input")].some(c => c.checked);
        $addBtn.disabled = !anyChecked;
        cb.closest(".rcb-chip").classList.toggle("checked", cb.checked);
      });
      cb.closest(".rcb-chip").classList.toggle("checked", cb.checked);
    });
    $addBtn.disabled = false;
  }

  // ── Load Source Roles ──────────────────────────────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const srcId = $srcOrg.value;
    const tgtId = $tgtOrg.value;
    if (!srcId || !tgtId) return;

    $loadBtn.disabled = true;
    setStatus("Loading roles and permission catalogs…");

    // Reset prior state
    policies = [];
    renderPolicyList();
    updateSaveBtn();
    $builderSection.style.display = "none";
    queuesCache = skillsCache = divisionsCache = null;
    tgtCatalog  = srcCatalog = null;

    try {
      const [roles, srcCat, tgtCat] = await Promise.all([
        fetchAllAuthorizationRoles(api, srcId),
        loadCatalog(api, srcId),
        loadCatalog(api, tgtId),
      ]);
      srcCatalog = srcCat;
      tgtCatalog = tgtCat;
      allRoles   = roles.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

      roleCombo.setItems(allRoles.map(r => r.name));
      $roleIn.placeholder = "Type to search roles…";
      $roleSection.style.display = "";

      // Prime the domain combobox using the TARGET catalog
      domainCombo.setItems(Object.keys(tgtCatalog).sort());
      $domainIn.placeholder = "Type or select…";
      $domainIn.disabled    = false;

      setStatus("");
    } catch (err) {
      setStatus(`Failed to load: ${err.message}`, "error");
    } finally {
      checkLoadEnabled();
    }
  });

  // ── Source role selected ───────────────────────────────────────────────────
  async function onRoleSelect(roleName) {
    const role = allRoles.find(r => r.name === roleName);
    if (!role) return;
    setStatus("Loading role details…");
    try {
      const srcId  = $srcOrg.value;
      const detail = await getAuthorizationRole(api, srcId, role.id);
      $name.value  = `Copy of ${detail.name || roleName}`;
      $desc.value  = detail.description || "";

      // Expand policies from source using the SOURCE catalog for wildcard resolution;
      // then mark each policy as incompatible if domain/entity is absent from the TARGET catalog.
      policies = [];
      let hasIncompat = false;

      for (const p of (detail.permissionPolicies || [])) {
        const cond        = parseConditionNode(p.resourceConditionNode);
        const srcDomainCat = srcCatalog?.[p.domain] || {};
        const entities    = p.entityName === "*" ? Object.keys(srcDomainCat) : [p.entityName];

        for (const entity of entities) {
          const srcEntityData = srcDomainCat[entity];
          const srcActions    = srcEntityData?.actions || [];
          const actions       = (p.actionSet || []).includes("*")
            ? new Set(srcActions)
            : new Set((p.actionSet || []).filter(a => a !== "*"));

          const incompat = !tgtCatalog?.[p.domain]?.[entity];
          if (incompat) hasIncompat = true;

          const existing = policies.find(q => q.domain === p.domain && q.entity === entity);
          if (existing) {
            for (const a of actions) existing.actions.add(a);
          } else {
            policies.push({
              domain: p.domain, entity, actions,
              condVar: cond?.condVar || "", condValues: cond?.values || [],
              condOp: cond?.operator || "INCLUDES", condOpen: false, rowEl: null,
              incompat,
            });
          }
        }
      }

      $incompatWarn.style.display = hasIncompat ? "" : "none";
      $builderSection.style.display = "";
      renderPolicyList();
      updateSaveBtn();
      setStatus(hasIncompat ? "⚠ Some permissions flagged — see policy list below." : "");
    } catch (err) {
      setStatus(`Failed to load role: ${err.message}`, "error");
    }
  }

  // ── Policy list ────────────────────────────────────────────────────────────
  function renderPolicyList() {
    if (policies.length === 0) {
      $policyList.innerHTML = `<div class="rcb-no-policies">No permissions added yet.</div>`;
      $polCount.textContent = "";
      return;
    }
    $polCount.textContent = `${policies.length} permission${policies.length !== 1 ? "s" : ""}`;

    // Remember which domain accordions were open before re-render
    const prevOpen = new Set();
    $policyList.querySelectorAll(".rcb-domain.open").forEach(d => prevOpen.add(d.dataset.domain));

    const byDomain = new Map();
    for (const pol of policies) {
      if (!byDomain.has(pol.domain)) byDomain.set(pol.domain, []);
      byDomain.get(pol.domain).push(pol);
    }

    $policyList.innerHTML = "";
    for (const domain of [...byDomain.keys()].sort()) {
      const domPolicies = byDomain.get(domain);
      const startOpen   = prevOpen.size === 0 || prevOpen.has(domain);
      const domIncompat = domPolicies.some(p => p.incompat);

      const domEl = document.createElement("div");
      domEl.className  = "rcb-domain" + (startOpen ? " open" : "");
      domEl.dataset.domain = domain;
      domEl.innerHTML = `
        <div class="rcb-domain-hdr">
          <span class="rcb-chevron">&#9654;</span>
          <span class="rcb-domain-name">${escapeHtml(domain)}</span>
          ${domIncompat ? `<span style="color:#fbbf24;font-size:11px">⚠</span>` : ""}
          <span class="rcb-domain-stats">${domPolicies.length} entit${domPolicies.length !== 1 ? "ies" : "y"}</span>
        </div>
        <div class="rcb-domain-body"></div>
      `;
      domEl.querySelector(".rcb-domain-hdr").addEventListener("click", () =>
        domEl.classList.toggle("open"));

      const $body = domEl.querySelector(".rcb-domain-body");
      for (const pol of domPolicies) {
        const condCapable = policySupportsConds(pol);
        const hasCondition = condCapable && pol.condVar && pol.condValues.length > 0;

        const row = document.createElement("div");
        row.className = "rcb-policy-row";
        row.innerHTML = `
          <div class="rcb-policy-main">
            <span class="rcb-policy-entity">
              ${escapeHtml(pol.entity)}${pol.incompat ? `<span class="rcb-incompat" title="This permission may not exist in the target org">⚠</span>` : ""}
            </span>
            <div class="rcb-policy-actions" data-actions>
              ${[...pol.actions].sort().map(a => `<span class="rcb-action-tag">${escapeHtml(a)}</span>`).join("")}
            </div>
            <div class="rcb-policy-btns">
              <button class="rcb-edit-btn" title="Edit actions">&#9998;</button>
              ${condCapable ? `<button class="rcb-cond-toggle${hasCondition ? " active" : ""}" title="Configure conditions">&#9881; Conditions${hasCondition ? " &#9679;" : ""}</button>` : ""}
              <button class="rcb-remove-btn" title="Remove permission">&#10005;</button>
            </div>
          </div>
          <div class="rcb-edit-panel"></div>
          <div class="rcb-cond-panel${pol.condOpen ? " open" : ""}"></div>
        `;
        pol.rowEl = row;

        const $editPanel  = row.querySelector(".rcb-edit-panel");
        const $condPanel  = row.querySelector(".rcb-cond-panel");
        const $editBtn    = row.querySelector(".rcb-edit-btn");
        const $actionsDiv = row.querySelector("[data-actions]");
        const $condToggle = row.querySelector(".rcb-cond-toggle");
        const $removeBtn  = row.querySelector(".rcb-remove-btn");

        $editBtn.addEventListener("click", () => {
          const isOpen = $editPanel.classList.toggle("open");
          $editBtn.classList.toggle("active", isOpen);
          if (isOpen && !$editPanel.dataset.built) buildEditPanel($editPanel, pol, $actionsDiv);
        });

        if ($condToggle) {
          $condToggle.addEventListener("click", () => {
            pol.condOpen = !pol.condOpen;
            $condPanel.classList.toggle("open", pol.condOpen);
            if (pol.condOpen && !$condPanel.dataset.built) buildCondPanel($condPanel, pol, $condToggle);
          });
          if (pol.condOpen) buildCondPanel($condPanel, pol, $condToggle);
        }

        $removeBtn.addEventListener("click", () => {
          policies = policies.filter(p => p !== pol);
          $incompatWarn.style.display = policies.some(p => p.incompat) ? "" : "none";
          renderPolicyList();
          updateSaveBtn();
        });

        $body.appendChild(row);
      }
      $policyList.appendChild(domEl);
    }
  }

  function policySupportsConds(pol) {
    if (!tgtCatalog) return false;
    const entityData = tgtCatalog[pol.domain]?.[pol.entity];
    if (!entityData) return false;
    return [...pol.actions].some(a => entityData.condActions.has(a));
  }

  // ── Inline action editor ───────────────────────────────────────────────────
  function buildEditPanel($panel, pol, $actionsDiv) {
    $panel.dataset.built = "1";
    const entityData = tgtCatalog?.[pol.domain]?.[pol.entity];
    // For incompatible entities we still show whatever actions exist on the policy
    const availableActions = entityData ? entityData.actions : [...pol.actions];

    $panel.innerHTML = `
      <div class="rcb-actions-wrap" style="align-items:center">
        ${availableActions.map(a => `
          <label class="rcb-chip${pol.actions.has(a) ? " checked" : ""}">
            <input type="checkbox" value="${escapeHtml(a)}"${pol.actions.has(a) ? " checked" : ""}>
            ${escapeHtml(a)}
          </label>
        `).join("")}
        <button class="rcb-cond-toggle" style="margin-left:auto;padding:3px 14px">Done</button>
      </div>
    `;
    $panel.querySelectorAll(".rcb-chip input").forEach(cb => {
      cb.closest(".rcb-chip").classList.toggle("checked", cb.checked);
      cb.addEventListener("change", () => {
        if (cb.checked) pol.actions.add(cb.value);
        else            pol.actions.delete(cb.value);
        cb.closest(".rcb-chip").classList.toggle("checked", cb.checked);
        $actionsDiv.innerHTML = [...pol.actions].sort()
          .map(a => `<span class="rcb-action-tag">${escapeHtml(a)}</span>`).join("");
        updateSaveBtn();
      });
    });
    $panel.querySelector(".rcb-cond-toggle").addEventListener("click", () => {
      $panel.classList.remove("open");
      $panel.closest(".rcb-policy-row")?.querySelector(".rcb-edit-btn")?.classList.remove("active");
      if (pol.actions.size === 0) {
        policies = policies.filter(p => p !== pol);
        renderPolicyList();
        updateSaveBtn();
      }
    });
  }

  // ── Condition panel builder ────────────────────────────────────────────────
  function detectCondVars(pol) {
    const d = pol.domain;
    if (d === "analytics" || d === "speechAndTextAnalytics") return ["QUEUE_ID", "MEDIA_TYPE", "SKILL_ID"];
    if (d === "quality") return ["QUEUE_ID", "MEDIA_TYPE"];
    return ["QUEUE_ID", "MEDIA_TYPE", "SKILL_ID", "DIVISION_ID"];
  }

  function updateToggleStyle($toggle, hasValues) {
    if (!$toggle) return;
    $toggle.classList.toggle("active", hasValues);
    $toggle.textContent = `⚙ Conditions${hasValues ? " ●" : ""}`;
  }

  async function buildCondPanel($panel, pol, $toggle) {
    $panel.dataset.built = "1";
    const condVarOptions = detectCondVars(pol);
    $panel.innerHTML = `
      <div class="rcb-cond-row">
        <div class="rcb-cond-group rcb-cond-group--var">
          <span class="rcb-label">Condition Variable</span>
          <select class="rcb-cond-select" id="rcbCondVar">
            <option value="">— None (unrestricted) —</option>
            ${condVarOptions.map(v => `<option value="${v}"${pol.condVar === v ? " selected" : ""}>${escapeHtml(COND_VAR_LABELS[v] || v)}</option>`).join("")}
          </select>
        </div>
        <div class="rcb-cond-group rcb-cond-group--op" id="rcbCondOpGroup" style="display:none">
          <span class="rcb-label">Operator</span>
          <select class="rcb-cond-select" id="rcbCondOp">
            <option value="INCLUDES"${(pol.condOp || "INCLUDES") === "INCLUDES" ? " selected" : ""}>Any of</option>
            <option value="EQUALS"${pol.condOp === "EQUALS" ? " selected" : ""}>Equals (each)</option>
          </select>
        </div>
        <div class="rcb-cond-group rcb-cond-group--vals" id="rcbCondValsGroup" style="display:none">
          <span class="rcb-label" id="rcbCondValsLabel">Values</span>
          <div id="rcbCondValsContainer"></div>
        </div>
      </div>
    `;
    const $condVar   = $panel.querySelector("#rcbCondVar");
    const $condOp    = $panel.querySelector("#rcbCondOp");
    const $opGroup   = $panel.querySelector("#rcbCondOpGroup");
    const $valsGroup = $panel.querySelector("#rcbCondValsGroup");
    const $valsLabel = $panel.querySelector("#rcbCondValsLabel");
    const $valsCont  = $panel.querySelector("#rcbCondValsContainer");

    async function showCondVar(variable) {
      pol.condVar = variable || "";
      if (!variable) {
        pol.condValues = [];
        $opGroup.style.display   = "none";
        $valsGroup.style.display = "none";
        updateToggleStyle($toggle, false);
        return;
      }
      $opGroup.style.display   = "";
      $valsGroup.style.display = "";
      $valsLabel.textContent   = COND_VAR_LABELS[variable] || variable;
      updateToggleStyle($toggle, pol.condValues.length > 0);
      await renderValuesPicker($valsCont, variable, pol);
    }

    $condVar.addEventListener("change", () => showCondVar($condVar.value));
    $condOp.addEventListener("change",  () => { pol.condOp = $condOp.value; });
    if (pol.condVar) await showCondVar(pol.condVar);
  }

  async function renderValuesPicker($container, variable, pol) {
    if (variable === "MEDIA_TYPE") {
      $container.innerHTML = `
        <div class="rcb-media-wrap">
          ${MEDIA_TYPES.map(mt => `
            <label class="rcb-chip${pol.condValues.includes(mt) ? " checked" : ""}">
              <input type="checkbox" value="${mt}"${pol.condValues.includes(mt) ? " checked" : ""}>${mt}
            </label>
          `).join("")}
        </div>
      `;
      $container.querySelectorAll(".rcb-chip input").forEach(cb => {
        cb.addEventListener("change", () => {
          const checked = [...$container.querySelectorAll(".rcb-chip input:checked")].map(c => c.value);
          pol.condValues = checked;
          cb.closest(".rcb-chip").classList.toggle("checked", cb.checked);
          updateToggleStyle(pol.rowEl?.querySelector(".rcb-cond-toggle"), checked.length > 0);
        });
        cb.closest(".rcb-chip").classList.toggle("checked", cb.checked);
      });
      return;
    }

    $container.innerHTML = `<span style="font-size:12px;color:var(--muted)">Loading…</span>`;
    const tgtId = $tgtOrg.value;
    let allItems = [];
    try {
      if (variable === "QUEUE_ID") {
        if (!queuesCache) queuesCache = await loadQueues(api, tgtId);
        allItems = queuesCache;
      } else if (variable === "SKILL_ID") {
        if (!skillsCache) skillsCache = await loadSkills(api, tgtId);
        allItems = skillsCache;
      } else if (variable === "DIVISION_ID") {
        if (!divisionsCache) divisionsCache = await loadDivisions(api, tgtId);
        allItems = divisionsCache;
      }
    } catch {
      $container.innerHTML = `<span style="font-size:12px;color:#f87171">Failed to load options.</span>`;
      return;
    }
    buildMultiSelect($container, allItems, pol, variable);
  }

  function buildMultiSelect($container, allItems, pol, variable) {
    const uid    = `${variable}-${Date.now()}`;
    const wrapId = `rcbms-${uid}`;
    const dropId = `rcbmsd-${uid}`;
    const inpId  = `rcbmsi-${uid}`;

    $container.innerHTML = `
      <div style="position:relative">
        <div class="rcb-ms-wrap" id="${wrapId}">
          ${pol.condValues.map(v => {
            const item = allItems.find(i => i.id === v);
            const name = item ? item.name : v;
            return `<span class="rcb-ms-chip" data-id="${escapeHtml(v)}">${escapeHtml(name)}<span class="rcb-ms-chip-remove" data-id="${escapeHtml(v)}">×</span></span>`;
          }).join("")}
          <input class="rcb-ms-input" id="${inpId}" placeholder="Start typing to search…" autocomplete="off">
        </div>
        <div class="rcb-ms-dropdown" id="${dropId}"></div>
      </div>
    `;
    const $wrap  = $container.querySelector(`#${wrapId}`);
    const $drop  = $container.querySelector(`#${dropId}`);
    const $input = $container.querySelector(`#${inpId}`);

    function renderDrop(filter) {
      const q = (filter || "").toLowerCase();
      const selectedIds = new Set(pol.condValues);
      const visible = allItems
        .filter(i => !selectedIds.has(i.id) && (!q || i.name.toLowerCase().includes(q)))
        .slice(0, 50);
      $drop.innerHTML = visible.length
        ? visible.map(i => `<div class="rcb-ms-option" data-id="${escapeHtml(i.id)}" data-name="${escapeHtml(i.name)}">${escapeHtml(i.name)}</div>`).join("")
        : `<div class="rcb-ms-option" style="color:var(--muted)">No results</div>`;
      $drop.classList.add("open");
    }
    function addChip(id, name) {
      if (pol.condValues.includes(id)) return;
      pol.condValues.push(id);
      const chip = document.createElement("span");
      chip.className   = "rcb-ms-chip";
      chip.dataset.id  = id;
      chip.innerHTML   = `${escapeHtml(name)}<span class="rcb-ms-chip-remove" data-id="${escapeHtml(id)}">×</span>`;
      $wrap.insertBefore(chip, $input);
      $input.value = "";
      $drop.classList.remove("open");
      updateToggleStyle(pol.rowEl?.querySelector(".rcb-cond-toggle"), pol.condValues.length > 0);
    }
    function removeChip(id) {
      pol.condValues = pol.condValues.filter(v => v !== id);
      $wrap.querySelectorAll(`.rcb-ms-chip[data-id="${CSS.escape(id)}"]`).forEach(c => c.remove());
      updateToggleStyle(pol.rowEl?.querySelector(".rcb-cond-toggle"), pol.condValues.length > 0);
    }

    $input.addEventListener("focus", () => renderDrop(""));
    $input.addEventListener("input", () => renderDrop($input.value));
    $input.addEventListener("blur",  () => setTimeout(() => $drop.classList.remove("open"), 160));
    $drop.addEventListener("mousedown", e => {
      const opt = e.target.closest(".rcb-ms-option");
      if (opt && opt.dataset.id) addChip(opt.dataset.id, opt.dataset.name);
    });
    $wrap.addEventListener("click", e => {
      const x = e.target.closest(".rcb-ms-chip-remove");
      if (x) removeChip(x.dataset.id);
      else   $input.focus();
    });
  }

  // ── Add permission ─────────────────────────────────────────────────────────
  $addBtn.addEventListener("click", () => {
    if (!pickerDomain || !pickerEntity) return;
    const checkedActions = new Set(
      [...$pickerActions.querySelectorAll(".rcb-chip input:checked")].map(c => c.value)
    );
    if (checkedActions.size === 0) return;
    const existing = policies.find(p => p.domain === pickerDomain && p.entity === pickerEntity);
    if (existing) {
      for (const a of checkedActions) existing.actions.add(a);
    } else {
      policies.push({
        domain: pickerDomain, entity: pickerEntity, actions: checkedActions,
        condVar: "", condValues: [], condOp: "INCLUDES", condOpen: false, rowEl: null, incompat: false,
      });
    }
    renderPolicyList();
    updateSaveBtn();
    onDomainSelect(pickerDomain);  // keep domain selected, reset entity
  });

  $addAllBtn.addEventListener("click", () => {
    if (!pickerDomain || !tgtCatalog?.[pickerDomain]) return;
    for (const entity of Object.keys(tgtCatalog[pickerDomain]).sort()) {
      const { actions } = tgtCatalog[pickerDomain][entity];
      const allActions  = new Set(actions);
      const existing    = policies.find(p => p.domain === pickerDomain && p.entity === entity);
      if (existing) {
        for (const a of allActions) existing.actions.add(a);
      } else {
        policies.push({
          domain: pickerDomain, entity, actions: allActions,
          condVar: "", condValues: [], condOp: "INCLUDES", condOpen: false, rowEl: null, incompat: false,
        });
      }
    }
    renderPolicyList();
    updateSaveBtn();
    onDomainSelect(pickerDomain);
  });

  // ── Cancel ─────────────────────────────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => {
    $name.value = "";
    $desc.value = "";
    policies    = [];
    renderPolicyList();
    updateSaveBtn();
    setStatus("");
    roleCombo.setValue("");
    $builderSection.style.display  = "none";
    $incompatWarn.style.display    = "none";
  });

  // ── Serialize permissionPolicies ───────────────────────────────────────────
  function buildPermissionPolicies() {
    return policies.map(pol => {
      const p = {
        domain:     pol.domain,
        entityName: pol.entity,
        actionSet:  [...pol.actions].sort(),
      };
      if (pol.condVar && pol.condValues.length > 0) {
        p.allowConditions       = true;
        p.resourceConditionNode = buildConditionNode(pol.condVar, pol.condValues, pol.condOp);
      } else {
        p.allowConditions = false;
      }
      return p;
    });
  }

  // ── Hourly Interacting helpers ───────────────────────────────────────────
  function buildDisqualifyingIndex() {
    const idx = {};
    for (const p of HOURLY_DISQUALIFYING_PERMISSIONS) {
      const [domain, entity, action] = p.split(":");
      if (!idx[domain]) idx[domain] = {};
      if (!idx[domain][entity]) idx[domain][entity] = new Set();
      idx[domain][entity].add(action);
    }
    return idx;
  }

  function applyHourlyFilter(permPolicies) {
    const byDomain = buildDisqualifyingIndex();
    const removed = [];
    const kept = [];
    for (const p of permPolicies) {
      const domainEntry = byDomain[p.domain];
      if (!domainEntry) { kept.push(p); continue; }
      const entityActions = domainEntry[p.entityName];
      if (!entityActions) { kept.push(p); continue; }
      const badActions = p.actionSet.filter(a => entityActions.has(a) || entityActions.has("*"));
      if (badActions.length === 0) { kept.push(p); continue; }
      const goodActions = p.actionSet.filter(a => !entityActions.has(a) && !entityActions.has("*"));
      for (const a of badActions) removed.push(`${p.domain}:${p.entityName}:${a}`);
      if (goodActions.length > 0) kept.push({ ...p, actionSet: goodActions });
    }
    const hasBilling = kept.some(p => p.domain === "billing" && p.entityName === "user" && p.actionSet.includes("hourlyInteracting"));
    if (!hasBilling) kept.push({ domain: "billing", entityName: "user", actionSet: ["hourlyInteracting"], allowConditions: false });
    return { filtered: kept, removed: removed.sort() };
  }

  function renderHourlySummary(roleName, orgName, totalCount, removed) {
    const removedHtml = removed.map(p => `<div style="font-size:12px;color:var(--muted);padding:2px 0 2px 12px">${escapeHtml(p)}</div>`).join("");
    $status.innerHTML = `
      <div style="color:#34d399;margin-bottom:8px">✅ Role "${escapeHtml(roleName)}" created in ${escapeHtml(orgName)} with ${totalCount} permission${totalCount !== 1 ? "s" : ""}.</div>
      <details style="margin-bottom:4px">
        <summary style="cursor:pointer;font-size:13px;color:var(--text)">${removed.length} disqualifying permission${removed.length !== 1 ? "s" : ""} removed</summary>
        ${removedHtml}
      </details>
      <details>
        <summary style="cursor:pointer;font-size:13px;color:var(--text)">1 permission added</summary>
        <div style="font-size:12px;color:var(--muted);padding:2px 0 2px 12px">billing:user:hourlyInteracting</div>
      </details>
    `;
    $status.className = "rcb-status";
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  $saveBtn.addEventListener("click", async () => {
    const tgtId = $tgtOrg.value;
    if (!tgtId) { setStatus("Please select a target org.", "error"); return; }

    $saveBtn.disabled = true;
    setStatus("Creating role in target org…");

    let permPolicies = buildPermissionPolicies();
    let removed = [];
    const hourlyMode = $hourlyCheck?.checked;
    if (hourlyMode) {
      const result = applyHourlyFilter(permPolicies);
      permPolicies = result.filtered;
      removed = result.removed;
    }

    const body = {
      name:               $name.value.trim(),
      description:        $desc.value.trim(),
      permissionPolicies: permPolicies,
    };

    try {
      const tgtCustomer = customers.find(c => c.id === tgtId);
      await createAuthorizationRole(api, tgtId, body);
      if (hourlyMode && removed.length > 0) {
        renderHourlySummary(body.name, tgtCustomer?.name || "target org", permPolicies.length, removed);
      } else {
        setStatus(`✓ Role "${body.name}" created in ${tgtCustomer?.name || "target org"}.`, "success");
      }
      // Reset form for next copy
      $name.value = "";
      $desc.value = "";
      policies    = [];
      renderPolicyList();
      roleCombo.setValue("");
      $builderSection.style.display = "none";
      $incompatWarn.style.display   = "none";
      if ($hourlyCheck) $hourlyCheck.checked = false;
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      updateSaveBtn();
    }
  });

  return el;
}
