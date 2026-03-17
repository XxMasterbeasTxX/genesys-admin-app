/**
 * Roles > Create / Edit
 *
 * Shared module for creating a new role or editing an existing one.
 * Invoked with { mode: "create" } or { mode: "edit" } from pageRegistry.
 *
 * Flow:
 *  - Create mode: blank form → POST /api/v2/authorization/roles (PUT to / creates)
 *  - Edit mode  : role picker → GET /api/v2/authorization/roles/{id} to pre-fill
 *                 → PUT /api/v2/authorization/roles/{id} on save
 *
 * Permission picker:
 *  1. Load catalog from GET /api/v2/authorization/permissions (cached once).
 *     Catalog is extended to track allowConditions per (domain, entity, action).
 *  2. Domain combobox → Entity combobox → Action checkboxes.
 *  3. "Add Permission" appends a policy row; duplicate (domain+entity) rows are
 *     merged (union of actions) with a warning.
 *  4. For permissions where any selected action carries allowConditions=true, an
 *     optional "Conditions" panel expands inline under the row.
 *     Supported condition variables:
 *       QUEUE_ID      → multi-select queues    (lazy-loaded)
 *       MEDIA_TYPE    → checkbox group (static)
 *       SKILL_ID      → multi-select skills    (lazy-loaded)
 *       DIVISION_ID   → multi-select divisions (lazy-loaded)
 *     Operator: INCLUDES (any of) or EQUALS (each separately)
 */

import { escapeHtml } from "../../utils.js";
import {
  fetchAllAuthorizationRoles,
  getAuthorizationRole,
  createAuthorizationRole,
  updateAuthorizationRole,
} from "../../services/genesysApi.js";

// ── Permission catalog ────────────────────────────────────────────────────────

async function loadCatalog(api, orgId) {
  // Returns { [domain]: { [entity]: { actions: string[], allowConditions: Set<action> } } }
  const catalog = {};
  let page = 1;
  let pageCount = null;
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
        const condActions = new Set(
          actionList.filter(a => a.allowConditions).map(a => a.action)
        );
        catalog[p.domain][entity] = { actions, condActions };
      }
    }
    page++;
  } while (page <= pageCount);
  return catalog;
}

// ── Condition resource loaders (lazy) ─────────────────────────────────────────

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

const MEDIA_TYPES = ["voice", "chat", "email", "screen", "videoComm", "callback"];

// ── Condition variable → label mapping ───────────────────────────────────────
const COND_VAR_LABELS = {
  QUEUE_ID:    "Queue(s)",
  MEDIA_TYPE:  "Media Type(s)",
  SKILL_ID:    "Skill(s)",
  DIVISION_ID: "Division(s)",
};

// ── Build resourceConditionNode from condition state ─────────────────────────
function buildConditionNode(condVar, values, operator) {
  if (!values || values.length === 0) return null;
  if (condVar === "MEDIA_TYPE") {
    // Media type values are scalar strings
    return {
      variableName: condVar,
      operator: operator || "INCLUDES",
      operands: values.map(v => ({ type: "SCALAR", value: v })),
    };
  }
  return {
    variableName: condVar,
    operator: operator || "INCLUDES",
    operands: values.map(v => ({ type: "SCALAR", value: v })),
  };
}

// ── Parse resourceConditionNode back into { condVar, values, operator } ──────
function parseConditionNode(node) {
  if (!node) return null;
  return {
    condVar:  node.variableName || "QUEUE_ID",
    values:   (node.operands || []).map(o => o.value).filter(Boolean),
    operator: node.operator || "INCLUDES",
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function renderRolesCreate({ me, api, orgContext, mode = "create" }) {
  const isEdit   = mode === "edit";
  const pageTitle = isEdit ? "Roles — Edit" : "Roles — Create";

  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <style>
      /* ── Layout ── */
      .rc-page { max-width: 860px; }
      .rc-section { margin-bottom: 24px; }
      .rc-label { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; display: block; }
      .rc-input { width: 100%; padding: 7px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg, var(--panel)); color: var(--text); font: inherit; font-size: 13px; outline: none; box-sizing: border-box; }
      .rc-input:focus { border-color: #3b82f6; }
      .rc-input:disabled { opacity: .5; }
      textarea.rc-input { resize: vertical; min-height: 60px; }

      /* ── Role picker (edit mode) ── */
      .rc-role-pick { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 24px; }
      .rc-role-pick .rc-combo { flex: 1; min-width: 260px; }

      /* ── Combobox ── */
      .rc-combo { position: relative; }
      .rc-combo-input { width: 100%; padding: 7px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg, var(--panel)); color: var(--text); font: inherit; font-size: 13px; outline: none; box-sizing: border-box; }
      .rc-combo-input:focus { border-color: #3b82f6; }
      .rc-combo-input:disabled { opacity: .5; cursor: not-allowed; }
      .rc-combo-list { display: none; position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 400; max-height: 240px; overflow-y: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
      .rc-combo-list.open { display: block; }
      .rc-combo-option { padding: 7px 12px; cursor: pointer; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,.04); }
      .rc-combo-option:last-child { border-bottom: none; }
      .rc-combo-option:hover { background: rgba(59,130,246,.15); color: #93c5fd; }
      .rc-combo-noresult { padding: 10px 12px; font-size: 12px; color: var(--muted); text-align: center; }

      /* ── Permission picker row ── */
      .rc-picker { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; padding: 14px; background: rgba(255,255,255,.03); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 16px; }
      .rc-picker-group { display: flex; flex-direction: column; gap: 4px; }
      .rc-picker-group--domain { min-width: 180px; }
      .rc-picker-group--entity { min-width: 200px; }
      .rc-picker-group--actions { flex: 1; min-width: 220px; }
      .rc-actions-wrap { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }
      .rc-chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 20px; font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; transition: background .1s, color .1s, border-color .1s; }
      .rc-chip input { display: none; }
      .rc-chip.checked { background: rgba(59,130,246,.18); border-color: #3b82f6; color: #93c5fd; }
      .rc-chip:hover { border-color: #6b7280; color: var(--text); }
      .rc-add-btn { padding: 7px 20px; background: #3b82f6; color: #fff; border: none; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: background .15s; height: 34px; }
      .rc-add-btn:hover:not(:disabled) { background: #2563eb; }
      .rc-add-btn:disabled { opacity: .45; cursor: not-allowed; }

      /* ── Policy list ── */
      .rc-policies-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .rc-policies-title { font-size: 13px; font-weight: 600; color: var(--text); }
      .rc-policies-count { font-size: 12px; color: var(--muted); }
      .rc-policy-list { display: flex; flex-direction: column; gap: 6px; }
      .rc-policy-row { background: rgba(255,255,255,.03); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
      .rc-policy-main { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex-wrap: wrap; }
      .rc-policy-domain { font-size: 12px; color: var(--muted); min-width: 130px; }
      .rc-policy-entity { font-size: 13px; font-weight: 600; color: #93c5fd; flex: 1; }
      .rc-policy-actions { display: flex; gap: 5px; flex-wrap: wrap; }
      .rc-action-tag { padding: 2px 8px; background: rgba(59,130,246,.15); border: 1px solid #3b82f6; border-radius: 12px; font-size: 11px; color: #93c5fd; font-weight: 600; }
      .rc-policy-btns { display: flex; gap: 6px; margin-left: auto; }
      .rc-cond-toggle { padding: 3px 10px; background: transparent; border: 1px solid var(--border); border-radius: 6px; font: inherit; font-size: 11px; color: var(--muted); cursor: pointer; white-space: nowrap; transition: border-color .12s, color .12s; }
      .rc-cond-toggle:hover { border-color: #6b7280; color: var(--text); }
      .rc-cond-toggle.active { border-color: #f59e0b; color: #fbbf24; }
      .rc-remove-btn { padding: 3px 9px; background: transparent; border: 1px solid var(--border); border-radius: 6px; font: inherit; font-size: 12px; color: var(--muted); cursor: pointer; transition: border-color .12s, color .12s; }
      .rc-remove-btn:hover { border-color: #ef4444; color: #f87171; }

      /* ── Domain accordion ── */
      .rc-domain { margin-bottom: 3px; }
      .rc-domain-hdr { display:flex; align-items:center; gap:10px; padding:7px 12px; background:rgba(255,255,255,.03); border:1px solid var(--border); border-radius:8px; cursor:pointer; user-select:none; }
      .rc-domain-hdr:hover { background:rgba(255,255,255,.05); }
      .rc-chevron { font-size:10px; color:var(--muted); transition:transform .15s; width:12px; display:inline-block; }
      .rc-domain.open .rc-chevron { transform:rotate(90deg); }
      .rc-domain-name { font-weight:600; font-size:13px; color:#fbbf24; flex:1; }
      .rc-domain-stats { font-size:12px; color:var(--muted); }
      .rc-domain-body { display:none; padding:4px 0 2px; }
      .rc-domain.open .rc-domain-body { display:block; }

      /* ── Conditions panel ── */
      .rc-cond-panel { border-top: 1px solid var(--border); padding: 12px 14px; background: rgba(0,0,0,.18); display: none; }
      .rc-cond-panel.open { display: block; }
      .rc-cond-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
      .rc-cond-group { display: flex; flex-direction: column; gap: 4px; }
      .rc-cond-group--var { min-width: 150px; }
      .rc-cond-group--op { min-width: 130px; }
      .rc-cond-group--vals { flex: 1; min-width: 240px; }
      .rc-cond-select { padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg, var(--panel)); color: var(--text); font: inherit; font-size: 13px; outline: none; }
      .rc-cond-select:focus { border-color: #3b82f6; }

      /* ── Multi-select chips for conditions ── */
      .rc-ms-wrap { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; min-height: 34px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg, var(--panel)); cursor: text; }
      .rc-ms-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: rgba(59,130,246,.18); border: 1px solid #3b82f6; border-radius: 12px; font-size: 11px; color: #93c5fd; white-space: nowrap; }
      .rc-ms-chip-remove { cursor: pointer; opacity: .7; font-size: 13px; line-height: 1; }
      .rc-ms-chip-remove:hover { opacity: 1; color: #f87171; }
      .rc-ms-input { border: none; background: transparent; color: var(--text); font: inherit; font-size: 12px; outline: none; min-width: 80px; flex: 1; }
      .rc-ms-dropdown { display: none; position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 500; max-height: 200px; overflow-y: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
      .rc-ms-dropdown.open { display: block; }
      .rc-ms-option { padding: 7px 12px; cursor: pointer; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,.04); }
      .rc-ms-option:last-child { border-bottom: none; }
      .rc-ms-option:hover { background: rgba(59,130,246,.15); color: #93c5fd; }
      .rc-ms-option.selected { color: #93c5fd; }
      .rc-ms-noresult { padding: 10px 12px; font-size: 12px; color: var(--muted); text-align: center; }
      .rc-media-wrap { display: flex; flex-wrap: wrap; gap: 6px; }

      /* ── Status ── */
      .rc-status { font-size: 13px; color: var(--muted); min-height: 20px; margin-bottom: 10px; }
      .rc-status--error   { color: #f87171; }
      .rc-status--success { color: #34d399; }

      /* ── Footer ── */
      .rc-footer { display: flex; justify-content: flex-end; gap: 10px; padding-top: 8px; border-top: 1px solid var(--border); margin-top: 24px; }
      .rc-cancel-btn { padding: 8px 22px; background: transparent; color: var(--muted); border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 13px; cursor: pointer; transition: color .12s, border-color .12s; }
      .rc-cancel-btn:hover { border-color: #6b7280; color: var(--text); }
      .rc-save-btn { padding: 8px 28px; background: #3b82f6; color: #fff; border: none; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .15s; }
      .rc-save-btn:hover:not(:disabled) { background: #2563eb; }
      .rc-save-btn:disabled { opacity: .45; cursor: not-allowed; }

      /* ── Empty policy list ── */
      .rc-no-policies { text-align: center; padding: 32px 16px; color: var(--muted); font-size: 13px; border: 1px dashed var(--border); border-radius: 10px; }
    </style>

    <div class="rc-page">
      <h2 style="margin:0 0 20px">${escapeHtml(pageTitle)}</h2>

      ${isEdit ? `
      <div class="rc-section">
        <span class="rc-label">Select Role to Edit</span>
        <div class="rc-role-pick">
          <div class="rc-combo" id="rcRoleCombo" style="flex:1;min-width:260px">
            <input class="rc-combo-input" id="rcRoleInput" placeholder="Loading roles…" autocomplete="off" disabled>
            <div class="rc-combo-list" id="rcRoleList"></div>
          </div>
        </div>
      </div>
      ` : ""}

      <div class="rc-section">
        <label class="rc-label" for="rcName">Role Name *</label>
        <input class="rc-input" id="rcName" placeholder="Enter role name" maxlength="200" ${isEdit ? "disabled" : ""}>
      </div>
      <div class="rc-section">
        <label class="rc-label" for="rcDesc">Description</label>
        <textarea class="rc-input" id="rcDesc" placeholder="Optional description" maxlength="500" rows="2" ${isEdit ? "disabled" : ""}></textarea>
      </div>

      <div class="rc-section">
        <span class="rc-label">Add Permission</span>
        <div class="rc-picker">
          <div class="rc-picker-group rc-picker-group--domain">
            <span class="rc-label">Domain</span>
            <div class="rc-combo" id="rcDomainCombo">
              <input class="rc-combo-input" id="rcDomainInput" placeholder="Loading…" autocomplete="off" disabled>
              <div class="rc-combo-list" id="rcDomainList"></div>
            </div>
          </div>
          <div class="rc-picker-group rc-picker-group--entity">
            <span class="rc-label">Entity</span>
            <div class="rc-combo" id="rcEntityCombo">
              <input class="rc-combo-input" id="rcEntityInput" placeholder="Select domain first" autocomplete="off" disabled>
              <div class="rc-combo-list" id="rcEntityList"></div>
            </div>
          </div>
          <div class="rc-picker-group rc-picker-group--actions">
            <span class="rc-label">Actions</span>
            <div class="rc-actions-wrap" id="rcPickerActions">
              <span style="font-size:12px;color:var(--muted)">Select entity first</span>
            </div>
          </div>
          <button class="rc-add-btn" id="rcAddBtn" disabled>Add</button>
        </div>
      </div>

      <div class="rc-section">
        <div class="rc-policies-header">
          <span class="rc-policies-title">Permissions</span>
          <span class="rc-policies-count" id="rcPoliciesCount"></span>
          <div style="display:flex;gap:6px;margin-left:auto">
            <button class="rc-cond-toggle" id="rcExpandAll">Expand All</button>
            <button class="rc-cond-toggle" id="rcCollapseAll">Collapse All</button>
          </div>
        </div>
        <div class="rc-policy-list" id="rcPolicyList">
          <div class="rc-no-policies">No permissions added yet.</div>
        </div>
      </div>

      <div class="rc-status" id="rcStatus"></div>

      <div class="rc-footer">
        <button class="rc-cancel-btn" id="rcCancelBtn">Cancel</button>
        <button class="rc-save-btn" id="rcSaveBtn" disabled>${isEdit ? "Save Changes" : "Create Role"}</button>
      </div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const $name       = el.querySelector("#rcName");
  const $desc       = el.querySelector("#rcDesc");
  const $domainIn   = el.querySelector("#rcDomainInput");
  const $domainList = el.querySelector("#rcDomainList");
  const $entityIn   = el.querySelector("#rcEntityInput");
  const $entityList = el.querySelector("#rcEntityList");
  const $pickerActions = el.querySelector("#rcPickerActions");
  const $addBtn     = el.querySelector("#rcAddBtn");
  const $policyList = el.querySelector("#rcPolicyList");
  const $polCount   = el.querySelector("#rcPoliciesCount");
  const $status     = el.querySelector("#rcStatus");
  const $saveBtn    = el.querySelector("#rcSaveBtn");
  const $cancelBtn  = el.querySelector("#rcCancelBtn");
  const $expandAll  = el.querySelector("#rcExpandAll");
  const $collapseAll = el.querySelector("#rcCollapseAll");

  $expandAll?.addEventListener("click", () =>
    $policyList.querySelectorAll(".rc-domain").forEach(d => d.classList.add("open")));
  $collapseAll?.addEventListener("click", () =>
    $policyList.querySelectorAll(".rc-domain").forEach(d => d.classList.remove("open")));

  // ── State ─────────────────────────────────────────────────────────────────
  let catalog       = null;          // { domain: { entity: { actions, condActions } } }
  let allRoles      = [];            // edit mode: list of all roles
  let editRoleId    = null;          // edit mode: currently selected role id
  let policies      = [];            // [{ domain, entity, actions:Set, condVar, condValues:[], condOp, rowEl }]
  let pickerDomain  = "";
  let pickerEntity  = "";

  // Lazy-loaded condition resources
  let queuesCache   = null;
  let skillsCache   = null;
  let divisionsCache = null;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setStatus(msg, cls = "") {
    $status.textContent = msg;
    $status.className = "rc-status" + (cls ? ` rc-status--${cls}` : "");
  }

  function updateSaveBtn() {
    const hasName = $name.value.trim().length > 0;
    $saveBtn.disabled = !hasName || policies.length === 0;
  }

  $name.addEventListener("input", updateSaveBtn);

  // ── Combobox factory ──────────────────────────────────────────────────────
  function makeCombobox(inputEl, listEl, onSelect) {
    let items   = [];
    let current = "";

    function renderList(filter) {
      const q = (filter ?? "").toLowerCase();
      const matched = q ? items.filter(v => v.toLowerCase().includes(q)) : items;
      listEl.innerHTML = matched.length
        ? matched.map(v => `<div class="rc-combo-option" data-value="${escapeHtml(v)}">${escapeHtml(v)}</div>`).join("")
        : `<div class="rc-combo-noresult">No results</div>`;
      listEl.classList.add("open");
    }

    function close() {
      listEl.classList.remove("open");
      inputEl.value = current;
    }

    function select(value) {
      current = value;
      inputEl.value = value;
      listEl.classList.remove("open");
      onSelect(value);
    }

    inputEl.addEventListener("focus", () => { if (!inputEl.disabled) { inputEl.select(); renderList(""); } });
    inputEl.addEventListener("input", () => renderList(inputEl.value));
    inputEl.addEventListener("blur",  () => setTimeout(close, 150));
    listEl.addEventListener("mousedown", e => {
      const opt = e.target.closest(".rc-combo-option");
      if (opt) select(opt.dataset.value);
    });

    return {
      setItems(newItems) {
        items = newItems;
        inputEl.disabled = false;
        if (!current) inputEl.placeholder = "Type to search…";
      },
      setValue(v) { current = v; inputEl.value = v; },
      clear() { current = ""; inputEl.value = ""; inputEl.placeholder = "Select domain first"; inputEl.disabled = true; },
      get value() { return current; },
    };
  }

  const domainCombo = makeCombobox($domainIn, $domainList, onDomainSelect);
  const entityCombo = makeCombobox($entityIn, $entityList, onEntitySelect);

  function onDomainSelect(domain) {
    pickerDomain = domain;
    pickerEntity = "";
    entityCombo.clear();
    $pickerActions.innerHTML = `<span style="font-size:12px;color:var(--muted)">Select entity first</span>`;
    $addBtn.disabled = true;
    if (domain && catalog[domain]) {
      const entities = Object.keys(catalog[domain]).sort();
      entityCombo.setItems(entities);
      entityCombo.setValue("");
      $entityIn.placeholder = "Type or select…";
      $entityIn.disabled = false;
    }
  }

  function onEntitySelect(entity) {
    pickerEntity = entity;
    $addBtn.disabled = true;
    if (!pickerDomain || !entity || !catalog[pickerDomain]?.[entity]) {
      $pickerActions.innerHTML = `<span style="font-size:12px;color:var(--muted)">Select entity first</span>`;
      return;
    }
    const { actions } = catalog[pickerDomain][entity];
    $pickerActions.innerHTML = actions.map(a => `
      <label class="rc-chip">
        <input type="checkbox" value="${escapeHtml(a)}" checked>
        ${escapeHtml(a)}
      </label>
    `).join("");
    $pickerActions.querySelectorAll(".rc-chip input").forEach(cb => {
      cb.addEventListener("change", () => {
        const anyChecked = [...$pickerActions.querySelectorAll(".rc-chip input")].some(c => c.checked);
        $addBtn.disabled = !anyChecked;
        updateChipStyle(cb.closest(".rc-chip"), cb.checked);
      });
      updateChipStyle(cb.closest(".rc-chip"), cb.checked);
    });
    $addBtn.disabled = false;
  }

  function updateChipStyle(chip, checked) {
    chip.classList.toggle("checked", checked);
  }

  // ── Policy list ───────────────────────────────────────────────────────────
  function renderPolicyList() {
    if (policies.length === 0) {
      $policyList.innerHTML = `<div class="rc-no-policies">No permissions added yet.</div>`;
      $polCount.textContent = "";
      return;
    }
    $polCount.textContent = `${policies.length} permission${policies.length !== 1 ? "s" : ""}`;

    // Remember which domains were open before re-render
    const prevOpen = new Set();
    $policyList.querySelectorAll(".rc-domain.open").forEach(d => prevOpen.add(d.dataset.domain));
    const isFirstRender = $policyList.querySelector(".rc-domain") === null
      && $policyList.querySelector(".rc-no-policies") === null;

    // Group by domain, sorted alphabetically
    const byDomain = new Map();
    for (const pol of policies) {
      if (!byDomain.has(pol.domain)) byDomain.set(pol.domain, []);
      byDomain.get(pol.domain).push(pol);
    }
    const sortedDomains = [...byDomain.keys()].sort();

    $policyList.innerHTML = "";

    for (const domain of sortedDomains) {
      const domPolicies = byDomain.get(domain);
      // Edit mode: pre-collapsed; Create mode: open by default (or restore previous state)
      const startOpen = isEdit
        ? prevOpen.has(domain)  // only open if it was explicitly opened by the user
        : (prevOpen.size === 0 || prevOpen.has(domain));

      const domEl = document.createElement("div");
      domEl.className = "rc-domain" + (startOpen ? " open" : "");
      domEl.dataset.domain = domain;
      domEl.innerHTML = `
        <div class="rc-domain-hdr">
          <span class="rc-chevron">&#9654;</span>
          <span class="rc-domain-name">${escapeHtml(domain)}</span>
          <span class="rc-domain-stats">${domPolicies.length} entit${domPolicies.length !== 1 ? "ies" : "y"}</span>
        </div>
        <div class="rc-domain-body"></div>
      `;
      domEl.querySelector(".rc-domain-hdr").addEventListener("click", () => {
        domEl.classList.toggle("open");
      });

      const $body = domEl.querySelector(".rc-domain-body");

      for (const pol of domPolicies) {
        const condCapable = policySupportsConds(pol);
        const hasCondition = condCapable && pol.condVar && pol.condValues.length > 0;

        const row = document.createElement("div");
        row.className = "rc-policy-row";
        row.innerHTML = `
          <div class="rc-policy-main">
            <span class="rc-policy-entity">${escapeHtml(pol.entity)}</span>
            <div class="rc-policy-actions">
              ${[...pol.actions].sort().map(a => `<span class="rc-action-tag">${escapeHtml(a)}</span>`).join("")}
            </div>
            <div class="rc-policy-btns">
              ${condCapable ? `<button class="rc-cond-toggle${hasCondition ? " active" : ""}" title="Configure conditions">&#9881; Conditions${hasCondition ? " ●" : ""}</button>` : ""}
              <button class="rc-remove-btn" title="Remove permission">&#10005;</button>
            </div>
          </div>
          <div class="rc-cond-panel${pol.condOpen ? " open" : ""}"></div>
        `;
        pol.rowEl = row;

        const $condPanel = row.querySelector(".rc-cond-panel");
        const $condToggle = row.querySelector(".rc-cond-toggle");
        const $removeBtn  = row.querySelector(".rc-remove-btn");

        if ($condToggle) {
          $condToggle.addEventListener("click", () => {
            pol.condOpen = !pol.condOpen;
            $condPanel.classList.toggle("open", pol.condOpen);
            if (pol.condOpen && !$condPanel.dataset.built) {
              buildCondPanel($condPanel, pol, $condToggle);
            }
          });
          if (pol.condOpen) buildCondPanel($condPanel, pol, $condToggle);
        }

        $removeBtn.addEventListener("click", () => {
          policies = policies.filter(p => p !== pol);
          renderPolicyList();
          updateSaveBtn();
        });

        $body.appendChild(row);
      }

      $policyList.appendChild(domEl);
    }
  }

  function policySupportsConds(pol) {
    if (!catalog) return false;
    const entityData = catalog[pol.domain]?.[pol.entity];
    if (!entityData) return false;
    return [...pol.actions].some(a => entityData.condActions.has(a));
  }

  // ── Condition panel builder ───────────────────────────────────────────────
  async function buildCondPanel($panel, pol, $toggle) {
    $panel.dataset.built = "1";
    $panel.innerHTML = `<span style="font-size:12px;color:var(--muted)">Loading…</span>`;

    const condVarOptions = detectCondVars(pol);

    $panel.innerHTML = `
      <div class="rc-cond-row">
        <div class="rc-cond-group rc-cond-group--var">
          <span class="rc-label">Condition Variable</span>
          <select class="rc-cond-select" id="condVar">
            <option value="">— None (unrestricted) —</option>
            ${condVarOptions.map(v => `<option value="${v}"${pol.condVar === v ? " selected" : ""}>${escapeHtml(COND_VAR_LABELS[v] || v)}</option>`).join("")}
          </select>
        </div>
        <div class="rc-cond-group rc-cond-group--op" id="condOpGroup" style="display:none">
          <span class="rc-label">Operator</span>
          <select class="rc-cond-select" id="condOp">
            <option value="INCLUDES"${(pol.condOp || "INCLUDES") === "INCLUDES" ? " selected" : ""}>Any of</option>
            <option value="EQUALS"${pol.condOp === "EQUALS" ? " selected" : ""}>Equals (each)</option>
          </select>
        </div>
        <div class="rc-cond-group rc-cond-group--vals" id="condValsGroup" style="display:none">
          <span class="rc-label" id="condValsLabel">Values</span>
          <div id="condValsContainer"></div>
        </div>
      </div>
    `;

    const $condVar  = $panel.querySelector("#condVar");
    const $condOp   = $panel.querySelector("#condOp");
    const $opGroup  = $panel.querySelector("#condOpGroup");
    const $valsGroup = $panel.querySelector("#condValsGroup");
    const $valsLabel = $panel.querySelector("#condValsLabel");
    const $valsCont = $panel.querySelector("#condValsContainer");

    async function showCondVar(variable) {
      pol.condVar = variable || "";
      if (!variable) {
        pol.condValues = [];
        $opGroup.style.display  = "none";
        $valsGroup.style.display = "none";
        updateToggleStyle($toggle, false);
        return;
      }
      $opGroup.style.display  = "";
      $valsGroup.style.display = "";
      $valsLabel.textContent = COND_VAR_LABELS[variable] || variable;
      updateToggleStyle($toggle, pol.condValues.length > 0);
      await renderValuesPicker($valsCont, variable, pol);
    }

    $condVar.addEventListener("change", () => showCondVar($condVar.value));
    $condOp.addEventListener("change", () => { pol.condOp = $condOp.value; });

    if (pol.condVar) await showCondVar(pol.condVar);
  }

  function detectCondVars(pol) {
    // Most permissions only support QUEUE_ID. Return a sensible default set
    // based on domain conventions. Genesys doesn't expose this cleanly via API,
    // so we use a known mapping for common domains.
    const domain = pol.domain;
    if (domain === "analytics" || domain === "speechAndTextAnalytics") {
      return ["QUEUE_ID", "MEDIA_TYPE", "SKILL_ID"];
    }
    if (domain === "quality") return ["QUEUE_ID", "MEDIA_TYPE"];
    return ["QUEUE_ID", "MEDIA_TYPE", "SKILL_ID", "DIVISION_ID"];
  }

  function updateToggleStyle($toggle, hasValues) {
    if (!$toggle) return;
    $toggle.classList.toggle("active", hasValues);
    $toggle.textContent = `⚙ Conditions${hasValues ? " ●" : ""}`;
  }

  async function renderValuesPicker($container, variable, pol) {
    if (variable === "MEDIA_TYPE") {
      $container.innerHTML = `
        <div class="rc-media-wrap">
          ${MEDIA_TYPES.map(mt => `
            <label class="rc-chip${pol.condValues.includes(mt) ? " checked" : ""}">
              <input type="checkbox" value="${mt}"${pol.condValues.includes(mt) ? " checked" : ""}>
              ${mt}
            </label>
          `).join("")}
        </div>
      `;
      $container.querySelectorAll(".rc-chip input").forEach(cb => {
        cb.addEventListener("change", () => {
          const checked = [...$container.querySelectorAll(".rc-chip input:checked")].map(c => c.value);
          pol.condValues = checked;
          updateChipStyle(cb.closest(".rc-chip"), cb.checked);
          updateToggleStyle(pol.rowEl?.querySelector(".rc-cond-toggle"), checked.length > 0);
        });
        updateChipStyle(cb.closest(".rc-chip"), cb.checked);
      });
      return;
    }

    // Resource multi-select (queues / skills / divisions)
    $container.innerHTML = `<span style="font-size:12px;color:var(--muted)">Loading…</span>`;
    let allItems = [];
    try {
      if (variable === "QUEUE_ID") {
        if (!queuesCache) queuesCache = await loadQueues(api, orgContext.getDetails().id);
        allItems = queuesCache;
      } else if (variable === "SKILL_ID") {
        if (!skillsCache) skillsCache = await loadSkills(api, orgContext.getDetails().id);
        allItems = skillsCache;
      } else if (variable === "DIVISION_ID") {
        if (!divisionsCache) divisionsCache = await loadDivisions(api, orgContext.getDetails().id);
        allItems = divisionsCache;
      }
    } catch {
      $container.innerHTML = `<span style="font-size:12px;color:#f87171">Failed to load options.</span>`;
      return;
    }

    buildMultiSelect($container, allItems, pol, variable);
  }

  function buildMultiSelect($container, allItems, pol, variable) {
    const wrapId  = `ms-${variable}-${Date.now()}`;
    const dropId  = `msd-${variable}-${Date.now()}`;
    const inputId = `msi-${variable}-${Date.now()}`;

    $container.innerHTML = `
      <div style="position:relative">
        <div class="rc-ms-wrap" id="${wrapId}">
          ${pol.condValues.map(v => {
            const item = allItems.find(i => i.id === v);
            const name = item ? item.name : v;
            return `<span class="rc-ms-chip" data-id="${escapeHtml(v)}">
              ${escapeHtml(name)}<span class="rc-ms-chip-remove" data-id="${escapeHtml(v)}">×</span>
            </span>`;
          }).join("")}
          <input class="rc-ms-input" id="${inputId}" placeholder="Start typing to search…" autocomplete="off">
        </div>
        <div class="rc-ms-dropdown" id="${dropId}"></div>
      </div>
    `;

    const $wrap  = $container.querySelector(`#${wrapId}`);
    const $drop  = $container.querySelector(`#${dropId}`);
    const $input = $container.querySelector(`#${inputId}`);

    function renderDrop(filter) {
      const q = (filter || "").toLowerCase();
      const selectedIds = new Set(pol.condValues);
      const visible = allItems.filter(i => {
        if (selectedIds.has(i.id)) return false;
        return !q || i.name.toLowerCase().includes(q);
      }).slice(0, 50);
      $drop.innerHTML = visible.length
        ? visible.map(i => `<div class="rc-ms-option" data-id="${escapeHtml(i.id)}" data-name="${escapeHtml(i.name)}">${escapeHtml(i.name)}</div>`).join("")
        : `<div class="rc-ms-noresult">No results</div>`;
      $drop.classList.add("open");
    }

    function addChip(id, name) {
      if (pol.condValues.includes(id)) return;
      pol.condValues.push(id);
      const chip = document.createElement("span");
      chip.className = "rc-ms-chip";
      chip.dataset.id = id;
      chip.innerHTML = `${escapeHtml(name)}<span class="rc-ms-chip-remove" data-id="${escapeHtml(id)}">×</span>`;
      $wrap.insertBefore(chip, $input);
      $input.value = "";
      $drop.classList.remove("open");
      updateToggleStyle(pol.rowEl?.querySelector(".rc-cond-toggle"), pol.condValues.length > 0);
    }

    function removeChip(id) {
      pol.condValues = pol.condValues.filter(v => v !== id);
      $wrap.querySelectorAll(`.rc-ms-chip[data-id="${CSS.escape(id)}"]`).forEach(c => c.remove());
      updateToggleStyle(pol.rowEl?.querySelector(".rc-cond-toggle"), pol.condValues.length > 0);
    }

    $input.addEventListener("focus",  () => renderDrop(""));
    $input.addEventListener("input",  () => renderDrop($input.value));
    $input.addEventListener("blur",   () => setTimeout(() => $drop.classList.remove("open"), 160));
    $drop.addEventListener("mousedown", e => {
      const opt = e.target.closest(".rc-ms-option");
      if (opt) addChip(opt.dataset.id, opt.dataset.name);
    });
    $wrap.addEventListener("click", e => {
      const x = e.target.closest(".rc-ms-chip-remove");
      if (x) removeChip(x.dataset.id);
      else $input.focus();
    });
  }

  // ── Add permission ────────────────────────────────────────────────────────
  $addBtn.addEventListener("click", () => {
    if (!pickerDomain || !pickerEntity) return;
    const checkedActions = new Set(
      [...$pickerActions.querySelectorAll(".rc-chip input:checked")].map(c => c.value)
    );
    if (checkedActions.size === 0) return;

    // Merge into existing policy for same (domain, entity)
    const existing = policies.find(p => p.domain === pickerDomain && p.entity === pickerEntity);
    if (existing) {
      for (const a of checkedActions) existing.actions.add(a);
    } else {
      policies.push({
        domain: pickerDomain,
        entity: pickerEntity,
        actions: checkedActions,
        condVar: "",
        condValues: [],
        condOp: "INCLUDES",
        condOpen: false,
        rowEl: null,
      });
    }

    renderPolicyList();
    updateSaveBtn();

    // Reset picker
    pickerEntity = "";
    entityCombo.clear();
    $pickerActions.innerHTML = `<span style="font-size:12px;color:var(--muted)">Select entity first</span>`;
    $addBtn.disabled = true;
  });

  // ── Cancel ────────────────────────────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => {
    $name.value = "";
    $desc.value = "";
    policies = [];
    renderPolicyList();
    updateSaveBtn();
    setStatus("");
    if (isEdit) {
      editRoleId = null;
      roleCombo?.setValue?.("");
      $name.disabled = true;
      $desc.disabled = true;
    }
  });

  // ── Build permissionPolicies for API ─────────────────────────────────────
  function buildPermissionPolicies() {
    return policies.map(pol => {
      const p = {
        domain:     pol.domain,
        entityName: pol.entity,
        actionSet:  [...pol.actions].sort(),
      };
      if (pol.condVar && pol.condValues.length > 0) {
        p.allowConditions = true;
        p.resourceConditionNode = buildConditionNode(pol.condVar, pol.condValues, pol.condOp);
      } else {
        p.allowConditions = false;
      }
      return p;
    });
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  $saveBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    $saveBtn.disabled = true;
    setStatus(isEdit ? "Saving changes…" : "Creating role…");

    const body = {
      name:               $name.value.trim(),
      description:        $desc.value.trim(),
      permissionPolicies: buildPermissionPolicies(),
    };

    try {
      if (isEdit) {
        await updateAuthorizationRole(api, org.id, editRoleId, body);
        setStatus("Role updated successfully.", "success");
      } else {
        await createAuthorizationRole(api, org.id, body);
        setStatus("Role created successfully.", "success");
        // Reset form
        $name.value = "";
        $desc.value = "";
        policies = [];
        renderPolicyList();
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      updateSaveBtn();
    }
  });

  // ── Edit mode: role picker ────────────────────────────────────────────────
  let roleCombo = null;
  if (isEdit) {
    const $roleIn   = el.querySelector("#rcRoleInput");
    const $roleList = el.querySelector("#rcRoleList");
    roleCombo = makeCombobox($roleIn, $roleList, onRoleSelect);
    $name.disabled = true;
    $desc.disabled = true;
  }

  async function onRoleSelect(roleName) {
    const role = allRoles.find(r => r.name === roleName);
    if (!role) return;
    editRoleId = role.id;
    setStatus("Loading role details…");
    try {
      const detail = await getAuthorizationRole(api, orgContext.getDetails().id, role.id);
      $name.value = detail.name || "";
      $desc.value = detail.description || "";
      $name.disabled = false;
      $desc.disabled = false;

      // Build policies from existing permissionPolicies, expanding any wildcards
      // against the catalog so "*" never appears as a raw action tag.
      policies = [];
      for (const p of (detail.permissionPolicies || [])) {
        const cond         = parseConditionNode(p.resourceConditionNode);
        const domainCat    = catalog[p.domain] || {};
        const entityIsWild = p.entityName === "*";
        const actionIsWild = (p.actionSet || []).includes("*");

        const entities = entityIsWild ? Object.keys(domainCat) : [p.entityName];
        for (const entity of entities) {
          const catalogActions = (domainCat[entity]?.actions) || [];
          const actions = actionIsWild
            ? new Set(catalogActions)
            : new Set((p.actionSet || []).filter(a => a !== "*"));

          // Merge into existing policy for same (domain, entity) if already present
          const existing = policies.find(q => q.domain === p.domain && q.entity === entity);
          if (existing) {
            for (const a of actions) existing.actions.add(a);
          } else {
            policies.push({
              domain:     p.domain,
              entity,
              actions,
              condVar:    cond?.condVar || "",
              condValues: cond?.values  || [],
              condOp:     cond?.operator || "INCLUDES",
              condOpen:   false,
              rowEl:      null,
            });
          }
        }
      }
      renderPolicyList();
      updateSaveBtn();
      setStatus("");
    } catch (err) {
      setStatus(`Failed to load role: ${err.message}`, "error");
    }
  }

  // ── Initialise: load catalog + (edit) roles ───────────────────────────────
  async function init() {
    const org = orgContext?.getDetails?.();
    if (!org) {
      setStatus("Please select a customer org first.", "error");
      return;
    }
    setStatus("Loading permission catalog…");
    try {
      const requests = [loadCatalog(api, org.id)];
      if (isEdit) requests.push(fetchAllAuthorizationRoles(api, org.id));
      const [cat, roles] = await Promise.all(requests);
      catalog = cat;

      const domains = Object.keys(catalog).sort();
      domainCombo.setItems(domains);
      $domainIn.placeholder = "Type or select…";
      $domainIn.disabled = false;

      if (isEdit && roles) {
        allRoles = roles.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        roleCombo.setItems(allRoles.map(r => r.name));
        el.querySelector("#rcRoleInput").placeholder = "Type to search roles…";
      }

      setStatus("");
    } catch (err) {
      setStatus(`Failed to load catalog: ${err.message}`, "error");
    }
  }

  // Re-init if org changes
  orgContext?.onChange?.(() => init());
  init();

  return el;
}
