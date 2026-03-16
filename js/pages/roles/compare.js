/**
 * Roles > Compare
 *
 * Compares permission policies across 2–10 roles side by side.
 * Fetches GET /api/v2/authorization/roles/{id} for each selected role in parallel.
 *
 * Column alignment: every domain table uses table-layout:fixed with an identical
 * <colgroup> (entity col = fixed 220 px, role cols = equal share of remainder).
 * Because all tables are the same total width, columns align perfectly across groups.
 */
import { escapeHtml, exportXlsx, timestampedFilename } from "../../utils.js";
import { createMultiSelect } from "../../components/multiSelect.js";
import { fetchAllAuthorizationRoles, fetchAllPages } from "../../services/genesysApi.js";

const ENTITY_COL_W = 220; // px — entity column fixed width

// ── Permission catalog & wildcard expansion ───────────────────────────────────

/**
 * Fetch the full Genesys permission catalog.
 * Returns { domain: { entityName: string[] } } — all known (domain, entity, actions).
 */
async function fetchPermissionCatalog(api, orgId) {
  // Each entity in the response is a DomainPermissionCollection:
  // { domain: string, permissionMap: { [entityName]: { entityType, actionSet } } }
  const perms = await fetchAllPages(api, orgId, "/api/v2/authorization/permissions", { pageSize: 200 });
  const catalog = {};
  for (const p of perms) {
    if (!p.domain || !p.permissionMap) continue;
    if (!catalog[p.domain]) catalog[p.domain] = {};
    for (const [entityName, actionList] of Object.entries(p.permissionMap)) {
      // actionList is an array of { domain, entityType, action, label, ... }
      catalog[p.domain][entityName] = actionList.map(a => a.action).sort();
    }
  }
  return catalog;
}

/**
 * Expand wildcard policies in a single role using the catalog.
 * Handles three wildcard forms:
 *   entityName="*", actionSet=["*"]  → all entities × all actions for that domain
 *   entityName="*", actionSet=["v"]  → all entities × specific actions for that domain
 *   entityName="flow", actionSet=["*"] → specific entity × all catalog actions
 * After expansion, entries for the same (domain, entityName) are merged (union of actions).
 */
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
  // Merge duplicate (domain, entityName) pairs — take union of all actions
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

  // ── Internal state ──────────────────────────────────────
  let comparedRoles   = []; // role names in selected order
  let comparedDomains = []; // [{ name, rows:[{entity, perms:{roleName:string[]}}], hasDiff }]
  let viewMode        = "all"; // "all" | "diff"
  let filterText      = "";
  let rolesLoaded     = false;

  // ── HTML skeleton ───────────────────────────────────────
  el.innerHTML = `
    <style>
      .rc-controls { display:flex; flex-wrap:wrap; gap:16px; align-items:flex-end; margin-bottom:16px; }
      .rc-control-group { display:flex; flex-direction:column; gap:4px; }
      .rc-label { font-size:12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
      .rc-note  { font-size:11px; color:var(--muted); margin-top:3px; }
      .rc-status-bar {
        display:flex; align-items:center; gap:14px; flex-wrap:wrap;
        padding:9px 12px; background:var(--panel-2,rgba(255,255,255,.03));
        border:1px solid var(--border); border-radius:8px; margin-bottom:12px;
        font-size:13px; color:var(--muted);
      }
      .rc-status-bar strong { color:var(--text); }
      .rc-badge { border-radius:10px; padding:2px 9px; font-size:12px; font-weight:600; }
      .rc-badge--diff  { background:rgba(217,119,6,.18);  color:#fbbf24; }
      .rc-badge--match { background:rgba(22,163,74,.15);  color:#86efac; }
      .rc-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
      .rc-toggle { display:flex; border:1px solid var(--border); border-radius:8px; overflow:hidden; }
      .rc-toggle-btn {
        padding:5px 14px; background:none; border:none; color:var(--muted);
        cursor:pointer; font:inherit; font-size:13px; transition:background .12s,color .12s;
      }
      .rc-toggle-btn.active { background:rgba(59,130,246,.22); color:#60a5fa; }
      .rc-toggle-btn:not(.active):hover { background:rgba(255,255,255,.05); color:var(--text); }
      .rc-filter-input {
        padding:5px 10px; border:1px solid var(--border); border-radius:8px;
        background:var(--bg,var(--panel)); color:var(--text); font:inherit; font-size:13px;
        width:200px; outline:none;
      }
      .rc-filter-input:focus { border-color:#3b82f6; }
      .rc-filter-input::placeholder { color:var(--muted); }
      .rc-ml-auto { margin-left:auto; }
      /* Domain accordions */
      .rc-domain { margin-bottom:3px; }
      .rc-domain-hdr {
        display:flex; align-items:center; gap:10px; padding:7px 12px;
        background:var(--panel-2,rgba(255,255,255,.03));
        border:1px solid var(--border); border-radius:8px;
        cursor:pointer; user-select:none;
      }
      .rc-domain-hdr:hover { background:rgba(255,255,255,.05); }
      .rc-chevron { font-size:10px; color:var(--muted); transition:transform .15s; width:12px; display:inline-block; }
      .rc-domain.open .rc-chevron { transform:rotate(90deg); }
      .rc-domain-name { flex:1; font-weight:600; font-size:13px; color:#93c5fd; }
      .rc-domain-stats { font-size:12px; color:var(--muted); }
      .rc-diffs-badge { border-radius:10px; padding:1px 8px; font-size:11px; font-weight:600; background:rgba(217,119,6,.18); color:#fbbf24; }
      .rc-match-badge { border-radius:10px; padding:1px 8px; font-size:11px; background:rgba(22,163,74,.12); color:#86efac; }
      .rc-domain-body { display:none; margin-top:2px; margin-bottom:6px; }
      .rc-domain.open .rc-domain-body { display:block; }
      /* Permission table — table-layout:fixed keeps columns aligned across all domain groups */
      .rc-table { width:100%; border-collapse:collapse; font-size:13px; table-layout:fixed; }
      .rc-table thead th {
        padding:6px 10px; text-align:left; font-weight:600; font-size:11px;
        color:var(--muted); background:var(--bg,var(--panel));
        text-transform:uppercase; letter-spacing:.04em;
        border-bottom:1px solid var(--border); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .rc-table thead th.rc-th-role { color:#93c5fd; }
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
      .rc-action-tag {
        display:inline-block; background:rgba(30,58,95,.8); color:#93c5fd;
        border-radius:3px; padding:1px 5px; font-size:11px; margin:1px 2px 1px 0; white-space:nowrap;
      }
      .rc-empty { padding:48px 24px; text-align:center; color:var(--muted); }
      .rc-empty-icon { font-size:2.2rem; margin-bottom:10px; }
      .rc-results-wrap { max-height:calc(100vh - 300px); overflow-y:auto; }
    </style>

    <h1 class="h1">Roles — Compare</h1>
    <hr class="hr">
    <p class="page-desc">
      Select 2 or more roles from the same org to compare their permission policies side by side.
      Permissions are fetched individually per role and grouped by domain.
      Wildcard permissions (&#42;) are automatically expanded against the full permission
      catalog so every concrete permission is visible in the comparison.
    </p>

    <div class="rc-controls">
      <div class="rc-control-group">
        <span class="rc-label">Roles to compare</span>
        <div id="rcRolePicker"></div>
        <span class="rc-note">Select 2–10 roles. Permissions are fetched for each role after you click Compare.</span>
      </div>
      <div class="rc-control-group" style="justify-content:flex-end">
        <span class="rc-label">&nbsp;</span>
        <button class="btn" id="rcCompareBtn" disabled>Compare</button>
      </div>
    </div>

    <div class="rc-status-bar" id="rcStatusBar" style="display:none">
      <span>Roles: <strong id="rcStatRoles">—</strong></span>
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
        <button class="btn btn-sm" id="rcExportBtn">Export to Excel</button>
      </div>
    </div>

    <div id="rcStatus" class="te-status"></div>

    <div id="rcResults">
      <div class="rc-empty">
        <div class="rc-empty-icon">⚖️</div>
        <p>Select two or more roles and click <strong>Compare</strong>.</p>
      </div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────────
  const $rolePicker  = el.querySelector("#rcRolePicker");
  const $compareBtn  = el.querySelector("#rcCompareBtn");
  const $statusBar   = el.querySelector("#rcStatusBar");
  const $toolbar     = el.querySelector("#rcToolbar");
  const $status      = el.querySelector("#rcStatus");
  const $results     = el.querySelector("#rcResults");
  const $statRoles   = el.querySelector("#rcStatRoles");
  const $statTotal   = el.querySelector("#rcStatTotal");
  const $badgeDiff   = el.querySelector("#rcBadgeDiff");
  const $badgeMatch  = el.querySelector("#rcBadgeMatch");
  const $btnAll      = el.querySelector("#rcBtnAll");
  const $btnDiff     = el.querySelector("#rcBtnDiff");
  const $filter      = el.querySelector("#rcFilter");
  const $expandAll   = el.querySelector("#rcExpandAll");
  const $collapseAll = el.querySelector("#rcCollapseAll");
  const $exportBtn   = el.querySelector("#rcExportBtn");

  function setStatus(msg, cls = "") {
    $status.textContent = msg;
    $status.className = "te-status" + (cls ? ` te-status--${cls}` : "");
  }

  // ── Role multi-select ────────────────────────────────────
  const roleSelect = createMultiSelect({
    placeholder: "Select roles…",
    searchable: true,
    onChange: (sel) => {
      $compareBtn.disabled = sel.size < 2;
    },
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

  // ── Compare ───────────────────────────────────────────────
  $compareBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    const selectedIds = [...roleSelect.getSelected()];
    if (selectedIds.length < 2) return;

    setStatus(`Fetching permissions for ${selectedIds.length} roles…`);
    $compareBtn.disabled = true;
    $toolbar.style.display = "none";
    $statusBar.style.display = "none";

    try {
      // Fetch each role's full detail (including permissionPolicies) in parallel
      let roleDetails = await Promise.all(
        selectedIds.map(id =>
          api.proxyGenesys(org.id, "GET", `/api/v2/authorization/roles/${id}`)
        )
      );

      // Detect wildcards — expand before building the matrix so all concrete
      // permissions are visible and differences are correctly identified
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
      buildComparison(roleDetails);
      viewMode   = "all";
      filterText = "";
      $filter.value = "";
      $btnAll.classList.add("active");
      $btnDiff.classList.remove("active");
      $toolbar.style.display = "";
      renderResults();
    } catch (err) {
      setStatus(`Error fetching permissions: ${err.message}`, "error");
    } finally {
      $compareBtn.disabled = false;
    }
  });

  // ── Build internal data model ─────────────────────────────
  function buildComparison(roleDetails) {
    comparedRoles = roleDetails.map(r => r.name || r.id);

    // Index: "domain::entityName" → { domain, entity, perms: { roleName: string[] } }
    const index = {};
    for (const role of roleDetails) {
      const roleName = role.name || role.id;
      for (const p of (role.permissionPolicies || [])) {
        const key = `${p.domain}::${p.entityName}`;
        if (!index[key]) {
          index[key] = { domain: p.domain, entity: p.entityName, perms: {} };
          comparedRoles.forEach(r => { index[key].perms[r] = []; });
        }
        index[key].perms[roleName] = [...(p.actionSet || [])].sort();
      }
    }

    // Group by domain, sort domains and entities alphabetically
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

    // Status bar counts
    const totalRows = Object.keys(index).length;
    const diffRows  = Object.values(index).filter(r => !isMatch(r.perms)).length;
    const matchRows = totalRows - diffRows;

    $statRoles.textContent  = comparedRoles.join(", ");
    $statTotal.textContent  = totalRows;
    $badgeDiff.textContent  = `${diffRows} difference${diffRows !== 1 ? "s" : ""}`;
    $badgeMatch.textContent = `${matchRows} identical`;
    $statusBar.style.display = "";
  }

  function isMatch(perms) {
    const sets = Object.values(perms).map(a => [...a].sort().join(","));
    return sets.every(s => s === sets[0]);
  }

  // ── Render results ────────────────────────────────────────
  function renderResults() {
    if (!comparedRoles.length) return;

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
        <p>No differences found. All selected roles have identical permissions.</p>
      </div>`;
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "rc-results-wrap";

    // Fixed colgroup — identical on every table so columns align across all domain groups.
    // With table-layout:fixed and an explicit width on the entity col, the browser divides
    // the remaining space equally among all unsized role columns.
    const colgroupHtml = `<colgroup>
      <col style="width:${ENTITY_COL_W}px">
      ${comparedRoles.map(() => `<col>`).join("")}
    </colgroup>`;

    const headerRowHtml = `<tr>
      <th>Entity</th>
      ${comparedRoles.map(r => `<th class="rc-th-role">${escapeHtml(r)}</th>`).join("")}
    </tr>`;

    filteredDomains.forEach((domain, di) => {
      const diffCount = domain.rows.filter(r => !isMatch(r.perms)).length;
      const domEl = document.createElement("div");
      domEl.className = "rc-domain";

      const bodyRows = domain.rows.map(row => {
        const diff = !isMatch(row.perms);
        const cells = comparedRoles.map(r => {
          const actions = row.perms[r] || [];
          if (!actions.length) return `<td class="rc-td-actions none">—</td>`;
          const tags = actions.map(a => `<span class="rc-action-tag">${escapeHtml(a)}</span>`).join("");
          return `<td class="rc-td-actions has">${tags}</td>`;
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

  // ── Toolbar events ────────────────────────────────────────
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

  // ── Export to Excel ───────────────────────────────────────
  $exportBtn.addEventListener("click", () => {
    if (!comparedRoles.length) return;
    const org = orgContext?.getDetails?.();

    // Flatten visible rows (respects current viewMode + filter)
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
        for (const roleName of comparedRoles) {
          entry[roleName] = (row.perms[roleName] || []).join(", ");
        }
        rows.push(entry);
      }
    }

    const columns = [
      { key: "domain", label: "Domain", wch: 24 },
      { key: "entity", label: "Entity", wch: 24 },
      ...comparedRoles.map(r => ({ key: r, label: r, wch: 28 })),
    ];

    const orgSlug = (org?.name || "").replace(/\s+/g, "_") || "org";
    const filename = timestampedFilename(`Roles_Compare_${orgSlug}`, "xlsx");

    try {
      exportXlsx([{ name: "Permissions", rows, columns }], filename);
    } catch (err) {
      setStatus(err.message, "error");
    }
  });

  return el;
}
