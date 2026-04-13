/**
 * Roles > Compare
 *
 * Three modes selectable via a top toggle:
 *
 *   "roles"  — Compare permission policies across 2–10 roles side by side.
 *              Fetches GET /api/v2/authorization/roles/{id} for each role.
 *
 *   "users"  — Compare effective permissions of exactly 2 users.
 *              Fetches GET /api/v2/authorization/subjects/{id} to get each
 *              user's role assignments, then fetches each unique role's full
 *              permissionPolicies. Permissions are unioned per user; each cell
 *              shows which role(s) grant the permission. Missing permissions
 *              show which role the other user gets them from.
 *
 *   "hourly" — Check all or selected roles for CX Cloud readiness.
 *              Roles whose permission policies contain any disqualifying
 *              permission are classified as "Full CX"; all others are
 *              "CX Cloud Ready". Disqualifying permissions are scraped live
 *              from Genesys help docs with a static fallback.
 *
 * Wildcard permissions (* entity or * action) are expanded against the full
 * Genesys permission catalog (GET /api/v2/authorization/permissions).
 *
 * Column alignment: every domain table uses table-layout:fixed with an
 * identical <colgroup> so columns line up across all domain groups.
 */
import { escapeHtml, exportXlsx, timestampedFilename } from "../../utils.js";
import { createMultiSelect } from "../../components/multiSelect.js";
import { fetchAllAuthorizationRoles } from "../../services/genesysApi.js";
import {
  HOURLY_DISQUALIFYING_PERMISSIONS,
} from "../../lib/hourlyDisqualifyingPermissions.js";

// ── Disqualifying-permission helpers (for Hourly Interacting mode) ────────────

const SCRAPE_ENDPOINT = "/api/scrape-disqualifying-permissions";

async function fetchDisqualifyingPermissions() {
  try {
    const resp = await fetch(SCRAPE_ENDPOINT);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (Array.isArray(data) && data.length > 0) return data;
  } catch { /* fall through to static list */ }
  return [...HOURLY_DISQUALIFYING_PERMISSIONS];
}

function buildDisqualifyingIndex(permArr) {
  const byDomain = {};
  for (const p of permArr) {
    const [domain, entity, action] = p.split(":");
    if (!byDomain[domain]) byDomain[domain] = {};
    if (!byDomain[domain][entity]) byDomain[domain][entity] = new Set();
    byDomain[domain][entity].add(action);
  }
  return byDomain;
}

function getDisqualifyingFromRole(role, byDomain) {
  const found = [];
  for (const p of role.permissionPolicies || []) {
    const domains =
      p.domain === "*" ? Object.keys(byDomain)
        : byDomain[p.domain] ? [p.domain] : [];
    for (const domain of domains) {
      const domainEntry = byDomain[domain];
      const entities =
        p.entityName === "*" ? Object.keys(domainEntry)
          : domainEntry[p.entityName] ? [p.entityName] : [];
      for (const entity of entities) {
        const entityActions = domainEntry[entity];
        if (!entityActions) continue;
        const actions = (p.actionSet || []).includes("*")
          ? [...entityActions]
          : (p.actionSet || []).filter((a) => entityActions.has(a));
        for (const action of actions) found.push(`${domain}:${entity}:${action}`);
      }
    }
  }
  return [...new Set(found)];
}

const ENTITY_COL_W = 220; // px — entity column fixed width

// ── Permission catalog & wildcard expansion ───────────────────────────────────

async function fetchPermissionCatalog(api, orgId) {
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
      for (const [entityName, actionList] of Object.entries(p.permissionMap)) {
        // actionList is an array of { domain, entityType, action, label, ... }
        catalog[p.domain][entityName] = actionList.map(a => a.action).sort();
      }
    }
    page++;
  } while (page <= pageCount);
  return catalog;
}

function expandPolicies(policies, catalog) {
  const expanded = [];
  for (const p of policies) {
    const domainCatalog = catalog[p.domain] || {};
    const entityIsWild = p.entityName === "*";
    const actionIsWild = (p.actionSet || []).includes("*");
    if (!entityIsWild && !actionIsWild) { expanded.push(p); continue; }
    const entities = entityIsWild ? Object.keys(domainCatalog) : [p.entityName];
    for (const entityName of entities) {
      const catalogActions = domainCatalog[entityName] || [];
      const actions = actionIsWild ? catalogActions : [...(p.actionSet || [])].sort();
      expanded.push({ domain: p.domain, entityName, actionSet: actions });
    }
  }
  // Merge duplicate (domain, entityName) pairs — union of actions
  const merged = {};
  for (const p of expanded) {
    const key = `${p.domain}::${p.entityName}`;
    if (!merged[key]) merged[key] = { domain: p.domain, entityName: p.entityName, actions: new Set() };
    for (const a of p.actionSet) merged[key].actions.add(a);
  }
  return Object.values(merged).map(p => ({
    domain: p.domain,
    entityName: p.entityName,
    actionSet: [...p.actions].sort(),
  }));
}

// ── Page renderer ─────────────────────────────────────────────────────────────

export default function renderRolesCompare({ me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  // ── Internal state ───────────────────────────────────────
  let mode            = "roles"; // "roles" | "users" | "hourly"
  let comparedCols    = []; // column keys (role names or disambiguated user names)
  let comparedDomains = []; // [{ name, rows:[{entity, perms:{col:{actions,via}}}], hasDiff }]
  let viewMode        = "all";  // "all" | "diff"
  let filterText      = "";
  let rolesLoaded     = false;
  let selectedUsers   = [null, null]; // [{id,name}, {id,name}]
  let hourlyResults   = null; // { roles: [{name, ready, forbidden:[{domain,entity,actions}]}] }

  // ── HTML skeleton ────────────────────────────────────────
  el.innerHTML = `
    <style>
      /* ── Mode toggle ── */
      .rc-mode-toggle { display:flex; border:1px solid var(--border); border-radius:8px; overflow:hidden; margin-bottom:22px; width:fit-content; }
      .rc-mode-btn { padding:7px 22px; background:none; border:none; color:var(--muted); cursor:pointer; font:inherit; font-size:13px; font-weight:600; transition:background .12s,color .12s; }
      .rc-mode-btn.active { background:rgba(59,130,246,.22); color:#60a5fa; }
      .rc-mode-btn:not(.active):hover { background:rgba(255,255,255,.05); color:var(--text); }
      /* ── Controls ── */
      .rc-controls { display:flex; flex-wrap:wrap; gap:16px; align-items:flex-end; margin-bottom:16px; }
      .rc-control-group { display:flex; flex-direction:column; gap:4px; }
      .rc-label { font-size:12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
      .rc-note  { font-size:11px; color:var(--muted); margin-top:3px; }
      /* ── User autocomplete picker ── */
      .rc-user-picker { position:relative; min-width:280px; }
      .rc-user-input { width:100%; padding:6px 10px; border:1px solid var(--border); border-radius:8px; background:var(--bg,var(--panel)); color:var(--text); font:inherit; font-size:13px; outline:none; box-sizing:border-box; }
      .rc-user-input:focus { border-color:#3b82f6; }
      .rc-user-input::placeholder { color:var(--muted); }
      .rc-user-tag { display:flex; align-items:center; gap:6px; padding:5px 10px; background:rgba(30,58,95,.8); border:1px solid #3b82f6; border-radius:8px; font-size:13px; color:#93c5fd; width:100%; box-sizing:border-box; }
      .rc-user-tag-name { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .rc-user-tag-clear { cursor:pointer; color:var(--muted); font-size:16px; line-height:1; padding:0 2px; flex-shrink:0; }
      .rc-user-tag-clear:hover { color:#f87171; }
      .rc-user-dropdown { position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:200; background:var(--panel); border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.4); max-height:240px; overflow-y:auto; display:none; }
      .rc-user-dropdown.open { display:block; }
      .rc-user-option { padding:8px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border); }
      .rc-user-option:last-child { border-bottom:none; }
      .rc-user-option:hover { background:rgba(59,130,246,.15); }
      .rc-user-option-name { font-weight:500; color:var(--text); }
      .rc-user-option-email { font-size:11px; color:var(--muted); margin-top:1px; }
      .rc-user-option-hint { color:var(--muted); font-style:italic; padding:10px 12px; cursor:default; font-size:13px; }
      /* ── Status bar ── */
      .rc-status-bar { display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding:9px 12px; background:var(--panel-2,rgba(255,255,255,.03)); border:1px solid var(--border); border-radius:8px; margin-bottom:12px; font-size:13px; color:var(--muted); }
      .rc-status-bar strong { color:var(--text); }
      .rc-badge { border-radius:10px; padding:2px 9px; font-size:12px; font-weight:600; }
      .rc-badge--diff  { background:rgba(217,119,6,.18);  color:#fbbf24; }
      .rc-badge--match { background:rgba(22,163,74,.15);  color:#86efac; }
      /* ── Toolbar ── */
      .rc-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
      .rc-toggle { display:flex; border:1px solid var(--border); border-radius:8px; overflow:hidden; }
      .rc-toggle-btn { padding:5px 14px; background:none; border:none; color:var(--muted); cursor:pointer; font:inherit; font-size:13px; transition:background .12s,color .12s; }
      .rc-toggle-btn.active { background:rgba(59,130,246,.22); color:#60a5fa; }
      .rc-toggle-btn:not(.active):hover { background:rgba(255,255,255,.05); color:var(--text); }
      .rc-filter-input { padding:5px 10px; border:1px solid var(--border); border-radius:8px; background:var(--bg,var(--panel)); color:var(--text); font:inherit; font-size:13px; width:200px; outline:none; }
      .rc-filter-input:focus { border-color:#3b82f6; }
      .rc-filter-input::placeholder { color:var(--muted); }
      .rc-ml-auto { margin-left:auto; }
      /* ── Export btn (matches Permissions vs. Users style) ── */
      .rc-export-btn { margin-left:auto; padding:5px 16px; background:transparent; color:#93c5fd; border:1px solid #3b82f6; border-radius:8px; font:inherit; font-size:12px; font-weight:600; cursor:pointer; transition:background .15s,color .15s; white-space:nowrap; }
      .rc-export-btn:hover:not(:disabled) { background:rgba(59,130,246,.18); }
      .rc-export-btn:disabled { opacity:.4; cursor:not-allowed; }
      /* ── Domain accordions ── */
      .rc-domain { margin-bottom:3px; }
      .rc-domain-hdr { display:flex; align-items:center; gap:10px; padding:7px 12px; background:var(--panel-2,rgba(255,255,255,.03)); border:1px solid var(--border); border-radius:8px; cursor:pointer; user-select:none; }
      .rc-domain-hdr:hover { background:rgba(255,255,255,.05); }
      .rc-chevron { font-size:10px; color:var(--muted); transition:transform .15s; width:12px; display:inline-block; }
      .rc-domain.open .rc-chevron { transform:rotate(90deg); }
      .rc-domain-name { flex:1; font-weight:600; font-size:13px; color:#93c5fd; }
      .rc-domain-stats { font-size:12px; color:var(--muted); }
      .rc-diffs-badge { border-radius:10px; padding:1px 8px; font-size:11px; font-weight:600; background:rgba(217,119,6,.18); color:#fbbf24; }
      .rc-match-badge { border-radius:10px; padding:1px 8px; font-size:11px; background:rgba(22,163,74,.12); color:#86efac; }
      .rc-domain-body { display:none; margin-top:2px; margin-bottom:6px; }
      .rc-domain.open .rc-domain-body { display:block; }
      /* ── Permission table — table-layout:fixed keeps columns aligned ── */
      .rc-table { width:100%; border-collapse:collapse; font-size:13px; table-layout:fixed; }
      .rc-table thead th { padding:6px 10px; text-align:left; font-weight:600; font-size:11px; color:var(--muted); background:var(--bg,var(--panel)); text-transform:uppercase; letter-spacing:.04em; border-bottom:1px solid var(--border); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .rc-table thead th.rc-th-col { color:#93c5fd; }
      .rc-table tbody tr { border-bottom:1px solid var(--border); }
      .rc-table tbody tr:last-child { border-bottom:none; }
      .rc-table tr.row-diff td  { background:rgba(120,53,15,.12); }
      .rc-table tr.row-diff td:first-child { border-left:3px solid #d97706; }
      .rc-table tr.row-match td { background:rgba(20,83,45,.08); }
      .rc-table tr.row-match td:first-child { border-left:3px solid #166534; }
      .rc-table td { padding:5px 10px; vertical-align:top; overflow:hidden; }
      .rc-td-entity { font-weight:500; color:var(--text); white-space:nowrap; text-overflow:ellipsis; }
      .rc-td-actions { color:var(--muted); font-size:12px; }
      .rc-td-actions.has  { color:var(--text); }
      .rc-td-actions.none { color:rgba(255,255,255,.2); font-style:italic; }
      .rc-action-tag { display:inline-block; background:rgba(30,58,95,.8); color:#93c5fd; border-radius:3px; padding:1px 5px; font-size:11px; margin:1px 2px 1px 0; white-space:nowrap; }
      /* Attribution lines (user mode) */
      .rc-via         { font-size:10px; color:var(--muted); margin-top:3px; font-style:italic; }
      .rc-missing-via { font-size:10px; color:#fbbf24;      margin-top:2px; font-style:italic; }
      /* ── Empty state ── */
      .rc-empty { padding:48px 24px; text-align:center; color:var(--muted); }
      .rc-empty-icon { font-size:2.2rem; margin-bottom:10px; }
      .rc-results-wrap { max-height:calc(100vh - 300px); overflow-y:auto; }
      /* ── Hourly Interacting mode ── */
      .rc-hi-pills { display:flex; gap:6px; margin-bottom:16px; flex-wrap:wrap; }
      .rc-hi-pill { padding:6px 18px; border-radius:20px; border:1px solid var(--border); background:transparent;
                    color:var(--muted); cursor:pointer; font:inherit; font-size:13px; font-weight:600;
                    transition:background .12s, color .12s, border-color .12s; user-select:none; }
      .rc-hi-pill:hover:not(.active) { border-color:#6b7280; color:var(--text); }
      .rc-hi-pill.active { background:rgba(59,130,246,.22); border-color:#3b82f6; color:#60a5fa; }
      .rc-hi-pill .rc-hi-pill-count { margin-left:6px; font-size:11px; opacity:.7; }
      .rc-hi-summary { display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding:9px 12px;
                       background:var(--panel-2,rgba(255,255,255,.03)); border:1px solid var(--border);
                       border-radius:8px; margin-bottom:12px; font-size:13px; color:var(--muted); }
      .rc-hi-summary strong { color:var(--text); }
      .rc-hi-role { margin-bottom:3px; }
      .rc-hi-role-hdr { display:flex; align-items:center; gap:10px; padding:7px 12px;
                        background:var(--panel-2,rgba(255,255,255,.03)); border:1px solid var(--border);
                        border-radius:8px; user-select:none; }
      .rc-hi-role-hdr.expandable { cursor:pointer; }
      .rc-hi-role-hdr.expandable:hover { background:rgba(255,255,255,.05); }
      .rc-hi-role-name { flex:1; font-weight:600; font-size:13px; color:#93c5fd; }
      .rc-hi-ready-yes { border-radius:10px; padding:1px 8px; font-size:11px; font-weight:600;
                         background:rgba(22,163,74,.12); color:#86efac; }
      .rc-hi-ready-no  { border-radius:10px; padding:1px 8px; font-size:11px; font-weight:600;
                         background:rgba(217,119,6,.18); color:#fbbf24; }
      .rc-hi-count { font-size:12px; color:var(--muted); }
      .rc-hi-role-body { display:none; margin-top:2px; margin-bottom:6px; }
      .rc-hi-role.open .rc-hi-role-body { display:block; }
      .rc-hi-role.open .rc-chevron { transform:rotate(90deg); }
      .rc-hi-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
      .rc-hi-filter { padding:5px 10px; border:1px solid var(--border); border-radius:8px;
                      background:var(--bg,var(--panel)); color:var(--text); font:inherit; font-size:13px;
                      width:200px; outline:none; }
      .rc-hi-filter:focus { border-color:#3b82f6; }
      .rc-hi-filter::placeholder { color:var(--muted); }
      .rc-hi-progress-wrap { margin-bottom:12px; }
      .rc-hi-progress-track { height:4px; background:var(--border); border-radius:4px; overflow:hidden; }
      .rc-hi-progress-fill { height:100%; background:#3b82f6; border-radius:4px; width:0; transition:width .2s; }
      .rc-hi-progress-fill.indeterminate { width:30%; animation:rc-indeterminate 1.2s ease-in-out infinite; }
      @keyframes rc-indeterminate { 0%{margin-left:0;width:30%} 50%{margin-left:35%;width:30%} 100%{margin-left:70%;width:30%} }
      .rc-hi-progress-detail { font-size:11px; color:var(--muted); margin-top:3px; }
    </style>

    <h1 class="h1">Roles — Compare</h1>
    <hr class="hr">

    <div class="rc-mode-toggle">
      <button class="rc-mode-btn active" id="rcModeRoles">Compare Roles</button>
      <button class="rc-mode-btn"        id="rcModeUsers">Compare Users</button>
      <button class="rc-mode-btn"        id="rcModeHourly">Hourly Interacting</button>
    </div>

    <!-- ── Role mode ── -->
    <div id="rcRoleSection">
      <p class="page-desc">
        Select 2 or more roles from the same org to compare their permission policies side by side.
        Wildcard permissions (&#42;) are automatically expanded against the full permission catalog.
      </p>
      <div class="rc-controls">
        <div class="rc-control-group">
          <span class="rc-label">Roles to compare</span>
          <div id="rcRolePicker"></div>
          <span class="rc-note">Select 2–10 roles. Permissions are fetched after you click Compare.</span>
        </div>
        <div class="rc-control-group" style="justify-content:flex-end">
          <span class="rc-label">&nbsp;</span>
          <button class="btn" id="rcCompareBtn" disabled>Compare</button>
        </div>
      </div>
    </div>

    <!-- ── User mode ── -->
    <div id="rcUserSection" style="display:none">
      <p class="page-desc">
        Select two users to compare their effective permissions side by side.
        All roles assigned to each user are fetched and their permissions unioned.
        Each permission shows which role grants it; missing permissions show which role the other user gets them from.
      </p>
      <div class="rc-controls">
        <div class="rc-control-group">
          <span class="rc-label">User A</span>
          <div class="rc-user-picker" id="rcUserPickerA">
            <input type="text" class="rc-user-input" placeholder="Search by name or email…" autocomplete="off">
            <div class="rc-user-dropdown" id="rcDropdownA"></div>
          </div>
        </div>
        <div class="rc-control-group">
          <span class="rc-label">User B</span>
          <div class="rc-user-picker" id="rcUserPickerB">
            <input type="text" class="rc-user-input" placeholder="Search by name or email…" autocomplete="off">
            <div class="rc-user-dropdown" id="rcDropdownB"></div>
          </div>
        </div>
        <div class="rc-control-group" style="justify-content:flex-end">
          <span class="rc-label">&nbsp;</span>
          <button class="btn" id="rcUserCompareBtn" disabled>Compare</button>
        </div>
      </div>
    </div>

    <!-- ── Hourly Interacting mode ── -->
    <div id="rcHourlySection" style="display:none">
      <p class="page-desc">
        Check all or selected roles for CX Cloud readiness.
        Roles containing any disqualifying permission are classified as <strong>Full CX</strong>;
        all others are <strong>CX Cloud Ready</strong>.
      </p>
      <div class="rc-controls">
        <div class="rc-control-group">
          <span class="rc-label">Roles to check</span>
          <div id="rcHourlyRolePicker"></div>
          <span class="rc-note">Select specific roles, or leave empty and check "All roles".</span>
        </div>
        <div class="rc-control-group" style="justify-content:flex-end;gap:8px">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);cursor:pointer">
            <input type="checkbox" id="rcHourlyAllRoles"> All roles
          </label>
          <button class="btn" id="rcHourlySearchBtn" disabled>Search</button>
        </div>
      </div>
      <div class="rc-hi-progress-wrap" id="rcHourlyProgressWrap" style="display:none">
        <div class="rc-hi-progress-track"><div class="rc-hi-progress-fill" id="rcHourlyProgressFill"></div></div>
        <div class="rc-hi-progress-detail" id="rcHourlyProgressDetail"></div>
      </div>
    </div>

    <div class="rc-status-bar" id="rcStatusBar" style="display:none">
      <span id="rcStatPrefix">Roles:</span> <strong id="rcStatCols">—</strong>
      <span>Permission rows: <strong id="rcStatTotal">—</strong></span>
      <span class="rc-badge rc-badge--diff"  id="rcBadgeDiff">—</span>
      <span class="rc-badge rc-badge--match" id="rcBadgeMatch">—</span>
    </div>

    <div class="rc-toolbar" id="rcToolbar" style="display:none">
      <div class="rc-toggle">
        <button class="rc-toggle-btn active" id="rcBtnAll">All permissions</button>
        <button class="rc-toggle-btn"        id="rcBtnDiff">Differences only</button>
      </div>
      <input type="text" class="rc-filter-input" id="rcFilter" placeholder="Filter by domain or entity…">
      <div class="rc-ml-auto" style="display:flex;gap:8px">
        <button class="btn btn-sm" id="rcExpandAll">Expand all</button>
        <button class="btn btn-sm" id="rcCollapseAll">Collapse all</button>
      </div>
      <button class="rc-export-btn" id="rcExportBtn">Export to Excel</button>
    </div>

    <div id="rcStatus" class="te-status"></div>

    <div id="rcResults">
      <div class="rc-empty">
        <div class="rc-empty-icon">⚖️</div>
        <p>Select roles or users and click <strong>Compare</strong>.</p>
      </div>
    </div>
  `;

  // ── DOM refs ─────────────────────────────────────────────
  const $roleSection    = el.querySelector("#rcRoleSection");
  const $userSection    = el.querySelector("#rcUserSection");
  const $hourlySection  = el.querySelector("#rcHourlySection");
  const $rolePicker     = el.querySelector("#rcRolePicker");
  const $compareBtn     = el.querySelector("#rcCompareBtn");
  const $userCompareBtn = el.querySelector("#rcUserCompareBtn");
  const $statusBar      = el.querySelector("#rcStatusBar");
  const $toolbar        = el.querySelector("#rcToolbar");
  const $status         = el.querySelector("#rcStatus");
  const $results        = el.querySelector("#rcResults");
  const $statPrefix     = el.querySelector("#rcStatPrefix");
  const $statCols       = el.querySelector("#rcStatCols");
  const $statTotal      = el.querySelector("#rcStatTotal");
  const $badgeDiff      = el.querySelector("#rcBadgeDiff");
  const $badgeMatch     = el.querySelector("#rcBadgeMatch");
  const $btnAll         = el.querySelector("#rcBtnAll");
  const $btnDiff        = el.querySelector("#rcBtnDiff");
  const $filter         = el.querySelector("#rcFilter");
  const $expandAll      = el.querySelector("#rcExpandAll");
  const $collapseAll    = el.querySelector("#rcCollapseAll");
  const $exportBtn      = el.querySelector("#rcExportBtn");
  const $hourlyAllRoles   = el.querySelector("#rcHourlyAllRoles");
  const $hourlySearchBtn  = el.querySelector("#rcHourlySearchBtn");
  const $hourlyProgressWrap   = el.querySelector("#rcHourlyProgressWrap");
  const $hourlyProgressFill   = el.querySelector("#rcHourlyProgressFill");
  const $hourlyProgressDetail = el.querySelector("#rcHourlyProgressDetail");

  function setStatus(msg, cls = "") {
    $status.textContent = msg;
    $status.className = "te-status" + (cls ? ` te-status--${cls}` : "");
  }

  function resetResults() {
    comparedCols    = [];
    comparedDomains = [];
    hourlyResults   = null;
    $statusBar.style.display = "none";
    $toolbar.style.display   = "none";
    if (mode === "hourly") {
      $results.innerHTML = `<div class="rc-empty"><div class="rc-empty-icon">⚡</div>
        <p>Select roles and click <strong>Search</strong> to check CX Cloud readiness.</p></div>`;
    } else {
      $results.innerHTML = `<div class="rc-empty"><div class="rc-empty-icon">⚖️</div>
        <p>Select ${mode === "roles" ? "roles" : "two users"} and click <strong>Compare</strong>.</p></div>`;
    }
    setStatus("");
  }

  // ── Mode toggle ──────────────────────────────────────────
  function activateMode(btn) {
    el.querySelectorAll(".rc-mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  }

  el.querySelector("#rcModeRoles").addEventListener("click", () => {
    if (mode === "roles") return;
    mode = "roles";
    activateMode(el.querySelector("#rcModeRoles"));
    $roleSection.style.display    = "";
    $userSection.style.display    = "none";
    $hourlySection.style.display  = "none";
    viewMode = "all";
    $btnAll.classList.add("active");
    $btnDiff.classList.remove("active");
    $filter.value = "";
    filterText    = "";
    resetResults();
  });

  el.querySelector("#rcModeUsers").addEventListener("click", () => {
    if (mode === "users") return;
    mode = "users";
    activateMode(el.querySelector("#rcModeUsers"));
    $userSection.style.display    = "";
    $roleSection.style.display    = "none";
    $hourlySection.style.display  = "none";
    viewMode = "diff"; // finding gaps is the primary use case
    $btnDiff.classList.add("active");
    $btnAll.classList.remove("active");
    $filter.value = "";
    filterText    = "";
    resetResults();
  });

  el.querySelector("#rcModeHourly").addEventListener("click", () => {
    if (mode === "hourly") return;
    mode = "hourly";
    activateMode(el.querySelector("#rcModeHourly"));
    $hourlySection.style.display  = "";
    $roleSection.style.display    = "none";
    $userSection.style.display    = "none";
    $filter.value = "";
    filterText    = "";
    resetResults();
    loadHourlyRoles();
  });

  // ── Role multi-select ────────────────────────────────────
  const roleSelect = createMultiSelect({
    placeholder: "Select roles…",
    searchable: true,
    onChange: (sel) => { $compareBtn.disabled = sel.size < 2; },
  });
  roleSelect.el.style.minWidth = "320px";
  $rolePicker.appendChild(roleSelect.el);

  async function loadRoles() {
    const org = orgContext?.getDetails?.();
    if (!org || rolesLoaded) return;
    rolesLoaded = true;
    setStatus("Loading roles…");
    try {
      const roles = await fetchAllAuthorizationRoles(api, org.id);
      roles.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      roleSelect.setItems(roles.map(r => ({ id: r.id, label: r.name || r.id })));
      setStatus("");
    } catch (err) {
      setStatus(`Failed to load roles: ${err.message}`, "error");
      rolesLoaded = false;
    }
  }

  loadRoles();

  // ── User pickers (A and B) ───────────────────────────────
  function createUserPicker(containerId, dropdownId, index) {
    const container = el.querySelector(`#${containerId}`);
    const input     = container.querySelector("input");
    const dropdown  = el.querySelector(`#${dropdownId}`);
    let debounce    = null;

    function updateBtn() {
      $userCompareBtn.disabled = !(selectedUsers[0] && selectedUsers[1]);
    }

    function closeDropdown() {
      dropdown.classList.remove("open");
      dropdown.innerHTML = "";
    }

    function setSelected(user) {
      selectedUsers[index] = user;
      const existing = container.querySelector(".rc-user-tag");
      if (existing) existing.remove();
      if (user) {
        const tag = document.createElement("div");
        tag.className = "rc-user-tag";
        tag.innerHTML = `<span class="rc-user-tag-name">${escapeHtml(user.name)}</span>
          <span class="rc-user-tag-clear" title="Clear">×</span>`;
        tag.querySelector(".rc-user-tag-clear").addEventListener("click", () => {
          selectedUsers[index] = null;
          tag.remove();
          input.style.display = "";
          input.value = "";
          input.focus();
          updateBtn();
        });
        input.style.display = "none";
        container.insertBefore(tag, dropdown);
      } else {
        input.style.display = "";
      }
      closeDropdown();
      updateBtn();
    }

    function showResults(users, hint = null) {
      dropdown.innerHTML = "";
      if (hint) {
        dropdown.innerHTML = `<div class="rc-user-option-hint">${escapeHtml(hint)}</div>`;
        dropdown.classList.add("open");
        return;
      }
      if (!users.length) {
        dropdown.innerHTML = `<div class="rc-user-option-hint">No users found</div>`;
        dropdown.classList.add("open");
        return;
      }
      for (const u of users) {
        const opt = document.createElement("div");
        opt.className = "rc-user-option";
        opt.innerHTML = `<div class="rc-user-option-name">${escapeHtml(u.name || u.id)}</div>
          <div class="rc-user-option-email">${escapeHtml(u.email || "")}</div>`;
        opt.addEventListener("mousedown", (e) => {
          e.preventDefault();
          setSelected({ id: u.id, name: u.name || u.id });
        });
        dropdown.appendChild(opt);
      }
      dropdown.classList.add("open");
    }

    async function search(q) {
      if (!q.trim()) { closeDropdown(); return; }
      const org = orgContext?.getDetails?.();
      if (!org) return;
      showResults([], "Searching…");
      try {
        const resp = await api.proxyGenesys(org.id, "POST", "/api/v2/users/search", {
          body: {
            pageSize: 25,
            pageNumber: 1,
            query: [{ type: "CONTAINS", fields: ["name", "email"], value: q }],
            sortOrder: "ASC",
            sortBy: "name",
          },
        });
        showResults(resp.results || []);
      } catch {
        closeDropdown();
      }
    }

    input.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => search(input.value), 300);
    });

    input.addEventListener("blur", () => {
      setTimeout(closeDropdown, 150);
    });
  }

  createUserPicker("rcUserPickerA", "rcDropdownA", 0);
  createUserPicker("rcUserPickerB", "rcDropdownB", 1);

  // ── Role compare handler ─────────────────────────────────
  $compareBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    const selectedIds = [...roleSelect.getSelected()];
    if (selectedIds.length < 2) return;

    setStatus(`Fetching permissions for ${selectedIds.length} roles…`);
    $compareBtn.disabled = true;
    $toolbar.style.display   = "none";
    $statusBar.style.display = "none";

    try {
      let roleDetails = await Promise.all(
        selectedIds.map(id => api.proxyGenesys(org.id, "GET", `/api/v2/authorization/roles/${id}`))
      );

      const needsExpansion = roleDetails.some(r =>
        (r.permissionPolicies || []).some(p =>
          p.entityName === "*" || (p.actionSet || []).includes("*")
        )
      );
      if (needsExpansion) {
        setStatus("Wildcard permissions detected — fetching permission catalog…");
        const catalog = await fetchPermissionCatalog(api, org.id);
        roleDetails = roleDetails.map(r => ({
          ...r,
          permissionPolicies: expandPolicies(r.permissionPolicies || [], catalog),
        }));
      }

      setStatus("");
      buildRoleComparison(roleDetails);
      viewMode = "all";
      filterText = "";
      $filter.value = "";
      $btnAll.classList.add("active");
      $btnDiff.classList.remove("active");
      $toolbar.style.display = "";
      renderResults();
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $compareBtn.disabled = false;
    }
  });

  // ── User compare handler ─────────────────────────────────
  $userCompareBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }
    if (!selectedUsers[0] || !selectedUsers[1]) return;

    setStatus("Fetching role assignments and group memberships…");
    $userCompareBtn.disabled = true;
    $toolbar.style.display   = "none";
    $statusBar.style.display = "none";

    try {
      // 1. Fetch direct role assignments + group memberships for both users in parallel.
      //    GET /api/v2/users/{userId}?expand=groups returns the user's groups inline.
      const [[subjectsA, userA], [subjectsB, userB]] = await Promise.all(
        selectedUsers.map(u => Promise.all([
          api.proxyGenesys(org.id, "GET", `/api/v2/authorization/subjects/${u.id}`),
          api.proxyGenesys(org.id, "GET", `/api/v2/users/${u.id}`, { query: { expand: "groups" } }),
        ]))
      );
      // groups are at userX.groups (array of { id, name })
      const groupsA = { entities: userA.groups || [] };
      const groupsB = { entities: userB.groups || [] };

      // 2. Fetch role assignments for every unique group across both users in parallel.
      //    Group-inherited roles live on the group's own subject record.
      const allGroups = new Map(); // groupId → groupName
      for (const g of [...groupsA.entities, ...groupsB.entities]) {
        if (g.id) allGroups.set(g.id, g.name || g.id);
      }
      const groupSubjectMap = {}; // groupId → grants[]
      await Promise.all(
        [...allGroups.keys()].map(async groupId => {
          const [gs, groupDetail] = await Promise.all([
            api.proxyGenesys(org.id, "GET", `/api/v2/authorization/subjects/${groupId}`),
            api.proxyGenesys(org.id, "GET", `/api/v2/groups/${groupId}`),
          ]);
          groupSubjectMap[groupId] = gs.grants || [];
          if (groupDetail.name) allGroups.set(groupId, groupDetail.name);
        })
      );

      // 3. Build Map<roleId → { name, sources[] }> for each user.
      //    subjects/{userId} returns ALL effective grants (incl. group-inherited),
      //    so we must NOT label a role "Assigned manually" if it is also granted
      //    via any of the user's groups — only add manual label for roles that
      //    do not appear in any group.
      function buildRoleMap(subjects, groups) {
        const map = new Map();

        // First: collect every roleId that comes from a group for this user
        const groupRoleIds = new Set();
        for (const group of (groups?.entities || [])) {
          for (const grant of (groupSubjectMap[group.id] || [])) {
            if (grant.role?.id) groupRoleIds.add(grant.role.id);
          }
        }

        // Direct assignments — only "Assigned manually" when NOT group-inherited
        for (const grant of (subjects?.grants || [])) {
          if (!grant.role?.id) continue;
          if (groupRoleIds.has(grant.role.id)) continue; // skip — handled via group below
          if (!map.has(grant.role.id)) map.set(grant.role.id, { name: grant.role.name || grant.role.id, sources: [] });
          const entry = map.get(grant.role.id);
          if (!entry.sources.includes("Assigned manually")) entry.sources.push("Assigned manually");
        }

        // Group-inherited
        for (const group of (groups?.entities || [])) {
          const groupName = allGroups.get(group.id) || group.id;
          const label = `Inherited from Group: ${groupName}`;
          for (const grant of (groupSubjectMap[group.id] || [])) {
            if (!grant.role?.id) continue;
            if (!map.has(grant.role.id)) map.set(grant.role.id, { name: grant.role.name || grant.role.id, sources: [] });
            const entry = map.get(grant.role.id);
            if (!entry.sources.includes(label)) entry.sources.push(label);
          }
        }

        return map;
      }

      const rolesA = buildRoleMap(subjectsA, groupsA);
      const rolesB = buildRoleMap(subjectsB, groupsB);

      // 4. Fetch each unique role's permissionPolicies in parallel
      const allRoleIds = new Set([...rolesA.keys(), ...rolesB.keys()]);
      setStatus(`Fetching permissions for ${allRoleIds.size} unique role${allRoleIds.size !== 1 ? "s" : ""}…`);

      const roleDetailMap = {};
      await Promise.all(
        [...allRoleIds].map(async id => {
          roleDetailMap[id] = await api.proxyGenesys(org.id, "GET", `/api/v2/authorization/roles/${id}`);
        })
      );

      // 5. Expand wildcards if any role uses them
      const hasWildcard = Object.values(roleDetailMap).some(r =>
        (r.permissionPolicies || []).some(p =>
          p.entityName === "*" || (p.actionSet || []).includes("*")
        )
      );
      if (hasWildcard) {
        setStatus("Wildcard permissions detected — fetching permission catalog…");
        const catalog = await fetchPermissionCatalog(api, org.id);
        for (const id of Object.keys(roleDetailMap)) {
          roleDetailMap[id] = {
            ...roleDetailMap[id],
            permissionPolicies: expandPolicies(roleDetailMap[id].permissionPolicies || [], catalog),
          };
        }
      }

      setStatus("");
      buildUserComparison(selectedUsers, rolesA, rolesB, roleDetailMap);
      viewMode = "diff";
      filterText = "";
      $filter.value = "";
      $btnDiff.classList.add("active");
      $btnAll.classList.remove("active");
      $toolbar.style.display = "";
      renderResults();
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $userCompareBtn.disabled = false;
    }
  });

  // ── Build role comparison model ──────────────────────────
  // Each cell: { actions: string[], via: [] }  (via always empty in role mode)
  function buildRoleComparison(roleDetails) {
    comparedCols = roleDetails.map(r => r.name || r.id);
    const index = {};
    for (const role of roleDetails) {
      const col = role.name || role.id;
      for (const p of (role.permissionPolicies || [])) {
        const key = `${p.domain}::${p.entityName}`;
        if (!index[key]) {
          index[key] = { domain: p.domain, entity: p.entityName, perms: {} };
          comparedCols.forEach(c => { index[key].perms[c] = { actions: [], via: [] }; });
        }
        index[key].perms[col] = { actions: [...(p.actionSet || [])].sort(), via: [] };
      }
    }
    finalizeDomains(index);
    updateStatusBar();
  }

  // ── Build user comparison model ──────────────────────────
  // Each cell: { actions: string[], via: string[] }  (role names that grant the permission)
  function buildUserComparison(users, rolesA, rolesB, roleDetailMap) {
    // Disambiguate column names if both users share the same display name
    const nameA = users[0].name;
    const nameB = users[1].name;
    comparedCols = nameA !== nameB ? [nameA, nameB] : [`${nameA} (A)`, `${nameB} (B)`];

    function buildPermsForUser(roleGrants) {
      // roleGrants: Map<roleId → { name, sources: string[] }>
      const map = {}; // "domain::entity" → { domain, entity, actions: Set, via: Set<string> }
      for (const [roleId, { name: roleName, sources }] of roleGrants) {
        const detail = roleDetailMap[roleId];
        if (!detail) continue;
        // Build full attribution labels, e.g. "#SuperMaster Admin — Assigned manually"
        const viaLabels = sources.length
          ? sources.map(s => `${roleName} — ${s}`)
          : [`${roleName} — Assigned manually`];
        for (const p of (detail.permissionPolicies || [])) {
          const key = `${p.domain}::${p.entityName}`;
          if (!map[key]) map[key] = { domain: p.domain, entity: p.entityName, actions: new Set(), via: new Set() };
          for (const a of (p.actionSet || [])) map[key].actions.add(a);
          for (const label of viaLabels) map[key].via.add(label);
        }
      }
      return map;
    }

    const permsA = buildPermsForUser(rolesA);
    const permsB = buildPermsForUser(rolesB);

    const allKeys = new Set([...Object.keys(permsA), ...Object.keys(permsB)]);
    const index = {};
    for (const key of allKeys) {
      const a = permsA[key];
      const b = permsB[key];
      const ref = a || b;
      index[key] = {
        domain: ref.domain,
        entity: ref.entity,
        perms: {
          [comparedCols[0]]: a
            ? { actions: [...a.actions].sort(), via: [...a.via].sort() }
            : { actions: [], via: [] },
          [comparedCols[1]]: b
            ? { actions: [...b.actions].sort(), via: [...b.via].sort() }
            : { actions: [], via: [] },
        },
      };
    }

    finalizeDomains(index);
    updateStatusBar();
  }

  function finalizeDomains(index) {
    const domainMap = {};
    for (const row of Object.values(index)) {
      if (!domainMap[row.domain]) domainMap[row.domain] = [];
      domainMap[row.domain].push(row);
    }
    comparedDomains = Object.keys(domainMap).sort().map(d => {
      const rows = domainMap[d].sort((a, b) => a.entity.localeCompare(b.entity));
      const hasDiff = rows.some(r => !isMatch(r.perms));
      return { name: d, rows, hasDiff };
    });
  }

  function updateStatusBar() {
    const allRows  = comparedDomains.flatMap(d => d.rows);
    const total    = allRows.length;
    const diffRows = allRows.filter(r => !isMatch(r.perms)).length;
    const match    = total - diffRows;

    if (mode === "users") {
      const onlyA = allRows.filter(r =>
        r.perms[comparedCols[0]].actions.length > 0 &&
        r.perms[comparedCols[1]].actions.length === 0
      ).length;
      const onlyB = allRows.filter(r =>
        r.perms[comparedCols[1]].actions.length > 0 &&
        r.perms[comparedCols[0]].actions.length === 0
      ).length;
      $statPrefix.textContent = "Users:";
      $statCols.textContent   = comparedCols.join(" vs ");
      $statTotal.textContent  = total;
      $badgeDiff.textContent  = `only A: ${onlyA} · only B: ${onlyB}`;
      $badgeMatch.textContent = `${match} shared`;
    } else {
      $statPrefix.textContent = "Roles:";
      $statCols.textContent   = comparedCols.join(", ");
      $statTotal.textContent  = total;
      $badgeDiff.textContent  = `${diffRows} difference${diffRows !== 1 ? "s" : ""}`;
      $badgeMatch.textContent = `${match} identical`;
    }
    $statusBar.style.display = "";
  }

  function isMatch(perms) {
    const sets = Object.values(perms).map(p => (p.actions || []).join(","));
    return sets.every(s => s === sets[0]);
  }

  // ── Render results ───────────────────────────────────────
  function renderResults() {
    if (!comparedCols.length) return;
    const q = filterText.toLowerCase();

    const filteredDomains = comparedDomains
      .map(d => {
        let rows = d.rows;
        if (viewMode === "diff") rows = rows.filter(r => !isMatch(r.perms));
        if (q) rows = rows.filter(r =>
          r.entity.toLowerCase().includes(q) || d.name.toLowerCase().includes(q)
        );
        return { ...d, rows };
      })
      .filter(d => d.rows.length > 0);

    if (filteredDomains.length === 0) {
      $results.innerHTML = `<div class="rc-empty">
        <div class="rc-empty-icon">✅</div>
        <p>${viewMode === "diff"
          ? "No differences found — both subjects have identical permissions."
          : "No results match the current filter."}</p>
      </div>`;
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "rc-results-wrap";

    const colgroupHtml = `<colgroup>
      <col style="width:${ENTITY_COL_W}px">
      ${comparedCols.map(() => `<col>`).join("")}
    </colgroup>`;

    const headerRowHtml = `<tr>
      <th>Entity</th>
      ${comparedCols.map(c => `<th class="rc-th-col">${escapeHtml(c)}</th>`).join("")}
    </tr>`;

    filteredDomains.forEach(domain => {
      const diffCount = domain.rows.filter(r => !isMatch(r.perms)).length;
      const domEl = document.createElement("div");
      domEl.className = "rc-domain";

      const bodyRows = domain.rows.map(row => {
        const diff = !isMatch(row.perms);

        const cells = comparedCols.map((col, colIdx) => {
          const { actions, via } = row.perms[col] || { actions: [], via: [] };

          if (!actions.length) {
            return `<td class="rc-td-actions none">—</td>`;
          }

          const tags = actions.map(a => `<span class="rc-action-tag">${escapeHtml(a)}</span>`).join("");
          const viaHtml = (mode === "users" && via.length)
            ? `<div class="rc-via">via: ${via.map(v => escapeHtml(v)).join(", ")}</div>`
            : "";
          return `<td class="rc-td-actions has">${tags}${viaHtml}</td>`;
        }).join("");

        return `<tr class="${diff ? "row-diff" : "row-match"}">
          <td class="rc-td-entity">${escapeHtml(row.entity)}</td>
          ${cells}
        </tr>`;
      }).join("");

      domEl.innerHTML = `
        <div class="rc-domain-hdr">
          <span class="rc-chevron">▶</span>
          <span class="rc-domain-name">${escapeHtml(domain.name)}</span>
          <span class="rc-domain-stats">${domain.rows.length} entit${domain.rows.length !== 1 ? "ies" : "y"}</span>
          ${diffCount > 0
            ? `<span class="rc-diffs-badge">${diffCount} diff${diffCount !== 1 ? "s" : ""}</span>`
            : `<span class="rc-match-badge">all match</span>`}
        </div>
        <div class="rc-domain-body">
          <table class="rc-table">
            ${colgroupHtml}
            <thead>${headerRowHtml}</thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>`;

      domEl.querySelector(".rc-domain-hdr").addEventListener("click", () => {
        domEl.classList.toggle("open");
      });

      wrap.appendChild(domEl);
    });

    $results.innerHTML = "";
    $results.appendChild(wrap);
  }

  // ── Toolbar events ───────────────────────────────────────
  $btnAll.addEventListener("click", () => {
    viewMode = "all";
    $btnAll.classList.add("active");
    $btnDiff.classList.remove("active");
    renderResults();
  });

  $btnDiff.addEventListener("click", () => {
    viewMode = "diff";
    $btnDiff.classList.add("active");
    $btnAll.classList.remove("active");
    renderResults();
  });

  $filter.addEventListener("input", () => {
    filterText = $filter.value;
    renderResults();
  });

  $expandAll.addEventListener("click", () => {
    el.querySelectorAll(".rc-domain").forEach(d => d.classList.add("open"));
  });

  $collapseAll.addEventListener("click", () => {
    el.querySelectorAll(".rc-domain").forEach(d => d.classList.remove("open"));
  });

  // ── Export to Excel ──────────────────────────────────────
  $exportBtn.addEventListener("click", () => {
    if (mode === "hourly") { exportHourly(); return; }
    if (!comparedCols.length) return;
    const org = orgContext?.getDetails?.();
    const q = filterText.toLowerCase();
    const rows = [];

    for (const domain of comparedDomains) {
      let domainRows = domain.rows;
      if (viewMode === "diff") domainRows = domainRows.filter(r => !isMatch(r.perms));
      if (q) domainRows = domainRows.filter(r =>
        r.entity.toLowerCase().includes(q) || domain.name.toLowerCase().includes(q)
      );
      for (const row of domainRows) {
        const entry = { domain: domain.name, entity: row.entity };
        for (const col of comparedCols) {
          const { actions, via } = row.perms[col] || { actions: [], via: [] };
          entry[col] = actions.join(", ");
          if (mode === "users") entry[`${col} — via roles`] = via.join(", ");
        }
        rows.push(entry);
      }
    }

    const columns = [
      { key: "domain", label: "Domain", wch: 24 },
      { key: "entity", label: "Entity", wch: 24 },
      ...comparedCols.flatMap(c => mode === "users"
        ? [{ key: c, label: c, wch: 28 }, { key: `${c} — via roles`, label: `${c} — via roles`, wch: 36 }]
        : [{ key: c, label: c, wch: 28 }]
      ),
    ];

    const orgSlug  = (org?.name || "").replace(/\s+/g, "_") || "org";
    const prefix   = mode === "users" ? "Users_Permissions_Compare" : "Roles_Compare";
    const filename = timestampedFilename(`${prefix}_${orgSlug}`, "xlsx");

    try {
      exportXlsx([{ name: "Permissions", rows, columns }], filename);
    } catch (err) {
      setStatus(err.message, "error");
    }
  });

  // ── Hourly Interacting mode ──────────────────────────────

  const hourlyRoleSelect = createMultiSelect({
    placeholder: "Select roles…",
    searchable: true,
    onChange: () => updateHourlySearchBtn(),
  });
  hourlyRoleSelect.el.style.minWidth = "320px";
  el.querySelector("#rcHourlyRolePicker").appendChild(hourlyRoleSelect.el);

  let hourlyRolesLoaded = false;
  let hourlyFilter      = "all"; // "all" | "ready" | "fullcx"

  function updateHourlySearchBtn() {
    $hourlySearchBtn.disabled = !$hourlyAllRoles.checked && hourlyRoleSelect.getSelected().size === 0;
  }

  $hourlyAllRoles.addEventListener("change", () => updateHourlySearchBtn());

  async function loadHourlyRoles() {
    const org = orgContext?.getDetails?.();
    if (!org || hourlyRolesLoaded) return;
    hourlyRolesLoaded = true;
    setStatus("Loading roles…");
    try {
      const roles = await fetchAllAuthorizationRoles(api, org.id);
      roles.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      hourlyRoleSelect.setItems(roles.map(r => ({ id: r.id, label: r.name || r.id })));
      setStatus("");
    } catch (err) {
      setStatus(`Failed to load roles: ${err.message}`, "error");
      hourlyRolesLoaded = false;
    }
  }

  function showHourlyProgress(fetched, total) {
    $hourlyProgressWrap.style.display = "";
    if (total && total > 0) {
      const pct = Math.min(100, Math.round((fetched / total) * 100));
      $hourlyProgressFill.style.width = `${pct}%`;
      $hourlyProgressFill.classList.remove("indeterminate");
      $hourlyProgressDetail.textContent = `${fetched.toLocaleString()} / ${total.toLocaleString()}`;
    } else {
      $hourlyProgressFill.classList.add("indeterminate");
      $hourlyProgressFill.style.width = "";
      $hourlyProgressDetail.textContent = fetched > 0 ? `${fetched.toLocaleString()} loaded…` : "";
    }
  }

  function hideHourlyProgress() {
    $hourlyProgressWrap.style.display = "none";
    $hourlyProgressFill.style.width = "0";
    $hourlyProgressFill.classList.remove("indeterminate");
    $hourlyProgressDetail.textContent = "";
  }

  // ── Hourly search handler ────────────────────────────────
  $hourlySearchBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    $hourlySearchBtn.disabled = true;
    $statusBar.style.display  = "none";
    $toolbar.style.display    = "none";
    $results.innerHTML        = "";
    hourlyResults             = null;
    hourlyFilter              = "all";

    try {
      // Step 1: fetch disqualifying permissions + permission catalog (for wildcard expansion)
      setStatus("Fetching disqualifying permissions…");
      const [dqPerms, catalog] = await Promise.all([
        fetchDisqualifyingPermissions(),
        fetchPermissionCatalog(api, org.id),
      ]);
      const byDomain = buildDisqualifyingIndex(dqPerms);
      setStatus(`Loaded ${dqPerms.length} disqualifying permissions. Fetching roles…`);

      // Step 2: determine which roles to check
      let rolesToCheck;
      const useAll = $hourlyAllRoles.checked;
      if (useAll) {
        showHourlyProgress(0, null);
        rolesToCheck = await fetchAllAuthorizationRoles(api, org.id, {
          onProgress: (f, t) => showHourlyProgress(f, t),
        });
      } else {
        const selectedIds = [...hourlyRoleSelect.getSelected()];
        if (selectedIds.length === 0) {
          setStatus("Select at least one role or check 'All roles'.", "error");
          $hourlySearchBtn.disabled = false;
          return;
        }
        setStatus(`Fetching ${selectedIds.length} role${selectedIds.length !== 1 ? "s" : ""}…`);
        showHourlyProgress(0, selectedIds.length);
        rolesToCheck = [];
        for (let i = 0; i < selectedIds.length; i++) {
          const role = await api.proxyGenesys(org.id, "GET", `/api/v2/authorization/roles/${selectedIds[i]}`);
          rolesToCheck.push(role);
          showHourlyProgress(i + 1, selectedIds.length);
        }
      }

      hideHourlyProgress();
      setStatus("Analysing roles…");

      // Step 3: classify each role
      const results = [];
      for (const role of rolesToCheck) {
        const forbidden = getDisqualifyingFromRole(role, byDomain);
        // Group forbidden permissions by domain → entity
        const grouped = {};
        for (const perm of forbidden) {
          const [domain, entity, action] = perm.split(":");
          const key = `${domain}::${entity}`;
          if (!grouped[key]) grouped[key] = { domain, entity, actions: [] };
          grouped[key].actions.push(action);
        }
        const forbiddenRows = Object.values(grouped).sort((a, b) =>
          a.domain.localeCompare(b.domain) || a.entity.localeCompare(b.entity)
        );
        // Expand wildcard (*) actions to actual permission names from catalog
        for (const row of forbiddenRows) {
          if (row.actions.includes("*")) {
            const catalogActions = catalog[row.domain]?.[row.entity] || [];
            row.actions = catalogActions.length > 0 ? [...catalogActions].sort() : row.actions.filter(a => a !== "*");
          } else {
            row.actions.sort();
          }
        }

        const expandedCount = forbiddenRows.reduce((sum, r) => sum + r.actions.length, 0);
        results.push({
          name: role.name || role.id,
          ready: forbidden.length === 0,
          forbiddenCount: expandedCount,
          forbiddenRows,
        });
      }

      results.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      hourlyResults = { roles: results };

      setStatus("");
      renderHourlyResults();
    } catch (err) {
      hideHourlyProgress();
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $hourlySearchBtn.disabled = false;
    }
  });

  // ── Hourly results rendering ─────────────────────────────
  function renderHourlyResults() {
    if (!hourlyResults) return;
    const roles = hourlyResults.roles;
    const totalReady  = roles.filter(r => r.ready).length;
    const totalFullCx = roles.filter(r => !r.ready).length;

    const filterQ = ($results.querySelector(".rc-hi-filter")?.value || "").toLowerCase();

    let filtered = roles;
    if (hourlyFilter === "ready")  filtered = filtered.filter(r => r.ready);
    if (hourlyFilter === "fullcx") filtered = filtered.filter(r => !r.ready);
    if (filterQ) filtered = filtered.filter(r => r.name.toLowerCase().includes(filterQ));

    $results.innerHTML = "";

    // Summary bar
    const summary = document.createElement("div");
    summary.className = "rc-hi-summary";
    summary.innerHTML = `
      <span>Roles checked: <strong>${roles.length}</strong></span>
      <span class="rc-hi-ready-yes">CX Cloud Ready: ${totalReady}</span>
      <span class="rc-hi-ready-no">Full CX: ${totalFullCx}</span>
    `;
    $results.appendChild(summary);

    // Filter pills
    const pills = document.createElement("div");
    pills.className = "rc-hi-pills";
    pills.innerHTML = `
      <button class="rc-hi-pill${hourlyFilter === "all" ? " active" : ""}" data-filter="all">All<span class="rc-hi-pill-count">${roles.length}</span></button>
      <button class="rc-hi-pill${hourlyFilter === "ready" ? " active" : ""}" data-filter="ready">CX Cloud Ready<span class="rc-hi-pill-count">${totalReady}</span></button>
      <button class="rc-hi-pill${hourlyFilter === "fullcx" ? " active" : ""}" data-filter="fullcx">Full CX<span class="rc-hi-pill-count">${totalFullCx}</span></button>
    `;
    pills.querySelectorAll(".rc-hi-pill").forEach(btn => {
      btn.addEventListener("click", () => {
        hourlyFilter = btn.dataset.filter;
        renderHourlyResults();
      });
    });
    $results.appendChild(pills);

    // Toolbar: text filter + expand/collapse + export
    const toolbar = document.createElement("div");
    toolbar.className = "rc-hi-toolbar";
    toolbar.innerHTML = `
      <input type="text" class="rc-hi-filter" placeholder="Filter by role name…" value="${escapeHtml(filterQ)}">
      <div class="rc-ml-auto" style="display:flex;gap:8px">
        <button class="btn btn-sm" id="rcHiExpandAll">Expand all</button>
        <button class="btn btn-sm" id="rcHiCollapseAll">Collapse all</button>
      </div>
      <button class="rc-export-btn" id="rcHiExportBtn">Export to Excel</button>
    `;
    toolbar.querySelector(".rc-hi-filter").addEventListener("input", () => renderHourlyResults());
    toolbar.querySelector("#rcHiExpandAll").addEventListener("click", () => {
      $results.querySelectorAll(".rc-hi-role.expandable").forEach(d => d.classList.add("open"));
    });
    toolbar.querySelector("#rcHiCollapseAll").addEventListener("click", () => {
      $results.querySelectorAll(".rc-hi-role").forEach(d => d.classList.remove("open"));
    });
    toolbar.querySelector("#rcHiExportBtn").addEventListener("click", () => exportHourly());
    $results.appendChild(toolbar);

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rc-empty";
      empty.innerHTML = `<div class="rc-empty-icon">✅</div><p>No roles match the current filter.</p>`;
      $results.appendChild(empty);
      return;
    }

    // Role accordions
    const wrap = document.createElement("div");
    wrap.className = "rc-results-wrap";

    for (const role of filtered) {
      const roleEl = document.createElement("div");
      roleEl.className = role.ready ? "rc-hi-role" : "rc-hi-role expandable";

      const readyBadge = role.ready
        ? `<span class="rc-hi-ready-yes">Yes</span>`
        : `<span class="rc-hi-ready-no">No</span>`;

      const chevron = role.ready ? `<span style="width:12px;display:inline-block"></span>` : `<span class="rc-chevron">▶</span>`;
      const countLabel = role.ready ? "" : `<span class="rc-hi-count">${role.forbiddenCount} forbidden permission${role.forbiddenCount !== 1 ? "s" : ""}</span>`;

      let bodyHtml = "";
      if (!role.ready) {
        const rows = role.forbiddenRows.map(r => `
          <tr>
            <td class="rc-td-entity">${escapeHtml(r.domain)}</td>
            <td class="rc-td-entity">${escapeHtml(r.entity)}</td>
            <td class="rc-td-actions has">${r.actions.map(a => `<span class="rc-action-tag">${escapeHtml(a)}</span>`).join("")}</td>
          </tr>
        `).join("");

        bodyHtml = `
          <div class="rc-hi-role-body">
            <table class="rc-table">
              <colgroup><col style="width:180px"><col style="width:200px"><col></colgroup>
              <thead><tr>
                <th>Domain</th>
                <th>Entity</th>
                <th>Forbidden Permissions</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      }

      roleEl.innerHTML = `
        <div class="rc-hi-role-hdr${role.ready ? "" : " expandable"}">
          ${chevron}
          <span class="rc-hi-role-name">${escapeHtml(role.name)}</span>
          ${countLabel}
          ${readyBadge}
        </div>
        ${bodyHtml}`;

      if (!role.ready) {
        roleEl.querySelector(".rc-hi-role-hdr").addEventListener("click", () => {
          roleEl.classList.toggle("open");
        });
      }

      wrap.appendChild(roleEl);
    }

    $results.appendChild(wrap);
  }

  // ── Hourly Excel export ──────────────────────────────────
  function exportHourly() {
    if (!hourlyResults) return;
    const org = orgContext?.getDetails?.();
    const orgSlug = ((org?.name || "").replace(/\s+/g, "_")) || "org";
    const filename = timestampedFilename(`Hourly_Interacting_Roles_${orgSlug}`, "xlsx");

    const columns = [
      { key: "role",       label: "Role",                   wch: 40 },
      { key: "domain",     label: "Domain",                 wch: 24 },
      { key: "entity",     label: "Entity",                 wch: 24 },
      { key: "forbidden",  label: "Forbidden Permissions",  wch: 50 },
      { key: "ready",      label: "CX Cloud Ready",         wch: 16 },
    ];

    const rows = [];
    for (const role of hourlyResults.roles) {
      if (role.forbiddenRows.length > 0) {
        for (const fr of role.forbiddenRows) {
          rows.push({
            role:      role.name,
            domain:    fr.domain,
            entity:    fr.entity,
            forbidden: fr.actions.join(", "),
            ready:     "No",
          });
        }
      } else {
        rows.push({
          role:      role.name,
          domain:    "",
          entity:    "",
          forbidden: "",
          ready:     "Yes",
        });
      }
    }

    try {
      exportXlsx([{ name: "Hourly Interacting", rows, columns }], filename);
    } catch (err) {
      setStatus(err.message, "error");
    }
  }

  return el;
}
