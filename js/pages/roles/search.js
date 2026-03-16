/**
 * Roles > Search
 *
 * Search for a permission (domain → entity → action) and see which users in
 * the org currently possess it, from which role, and how they got it
 * (assigned manually or inherited via a group).
 *
 * Flow:
 *  1. User selects domain → entity from the permission catalog; action
 *     checkboxes cascade from the catalog selection.
 *  2. On "Search": for each checked action we call
 *       GET /api/v2/authorization/roles?permission={domain}:{entity}:{action}
 *     to find roles that carry the permission.
 *  3. For every discovered role we fetch
 *       GET /api/v2/authorization/roles/{roleId}/users  (paginated)
 *     and stream rows into the results table immediately.
 *  4. Source attribution resolves asynchronously (batches of 10 concurrent
 *     users):
 *       GET /api/v2/authorization/subjects/{userId}
 *       GET /api/v2/users/{userId}?expand=groups
 *       → per-group: GET /api/v2/authorization/subjects/{groupId}
 *                    GET /api/v2/groups/{groupId}
 *     While pending the Source cell shows "Resolving…".
 *  5. Action-filter checkboxes can narrow the visible rows client-side after
 *     results have loaded.
 */
import { escapeHtml } from "../../utils.js";

// ── Permission catalog ────────────────────────────────────────────────────────

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
        catalog[p.domain][entityName] = actionList.map(a => a.action).sort();
      }
    }
    page++;
  } while (page <= pageCount);
  return catalog;
}

// ── Roles-by-permission lookup ────────────────────────────────────────────────

async function fetchRolesForPermission(api, orgId, domain, entity, action) {
  const permission = `${domain}:${entity}:${action}`;
  const roles = [];
  let page = 1;
  let pageCount = null;
  do {
    const resp = await api.proxyGenesys(
      orgId, "GET", "/api/v2/authorization/roles",
      { query: { permission, pageSize: "100", pageNumber: String(page) } }
    );
    pageCount = resp.pageCount ?? 1;
    for (const r of (resp.entities || [])) {
      roles.push({ id: r.id, name: r.name || r.id });
    }
    page++;
  } while (page <= pageCount);
  return roles;
}

// ── Users-in-role lookup ──────────────────────────────────────────────────────

async function fetchUsersForRole(api, orgId, roleId) {
  const users = [];
  let page = 1;
  let pageCount = null;
  do {
    const resp = await api.proxyGenesys(
      orgId, "GET", `/api/v2/authorization/roles/${roleId}/users`,
      { query: { pageSize: "100", pageNumber: String(page) } }
    );
    pageCount = resp.pageCount ?? 1;
    for (const u of (resp.entities || [])) {
      users.push({
        id: u.id,
        name: u.name || u.id,
        email: u.email || "",
      });
    }
    page++;
  } while (page <= pageCount);
  return users;
}

// ── Source attribution ────────────────────────────────────────────────────────

async function resolveUserSource(api, orgId, userId, roleId) {
  const [subjects, userDetail] = await Promise.all([
    api.proxyGenesys(orgId, "GET", `/api/v2/authorization/subjects/${userId}`),
    api.proxyGenesys(orgId, "GET", `/api/v2/users/${userId}`, { query: { expand: "groups" } }),
  ]);

  const userGroups = userDetail.groups || [];

  // Fetch every group's grants + name in parallel
  const groupSubjectMap = {}; // groupId → grants[]
  const groupNameMap = {};    // groupId → name
  await Promise.all(
    userGroups.map(async g => {
      const [gs, groupDetail] = await Promise.all([
        api.proxyGenesys(orgId, "GET", `/api/v2/authorization/subjects/${g.id}`),
        api.proxyGenesys(orgId, "GET", `/api/v2/groups/${g.id}`),
      ]);
      groupSubjectMap[g.id] = gs.grants || [];
      groupNameMap[g.id] = groupDetail.name || g.name || g.id;
    })
  );

  // Collect which roleIds this user gets via groups
  const groupRoleIds = new Set();
  for (const g of userGroups) {
    for (const grant of (groupSubjectMap[g.id] || [])) {
      if (grant.role?.id) groupRoleIds.add(grant.role.id);
    }
  }

  // Build source label(s) for the requested roleId
  const sources = [];

  // Manual assignment: role appears in user's direct grants AND not only via group
  const hasDirectGrant = (subjects.grants || []).some(gr => gr.role?.id === roleId);
  if (hasDirectGrant && !groupRoleIds.has(roleId)) {
    sources.push("Assigned manually");
  }

  // Group-inherited
  for (const g of userGroups) {
    const hasGroupGrant = (groupSubjectMap[g.id] || []).some(gr => gr.role?.id === roleId);
    if (hasGroupGrant) {
      sources.push(`Inherited from Group: ${groupNameMap[g.id]}`);
    }
  }

  return sources.length ? sources.join("; ") : "Assigned manually";
}

// ── Concurrency helper ────────────────────────────────────────────────────────

async function runBatched(tasks, concurrency = 10) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function renderRolesSearch({ me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <style>
      /* ── Controls ── */
      .rs-controls { display:flex; flex-wrap:wrap; gap:14px; align-items:flex-end; margin-bottom:18px; }
      .rs-control-group { display:flex; flex-direction:column; gap:4px; min-width:180px; }
      .rs-label { font-size:12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
      .rs-select { padding:6px 10px; border:1px solid var(--border); border-radius:8px; background:var(--bg,var(--panel)); color:var(--text); font:inherit; font-size:13px; outline:none; min-width:200px; }
      .rs-select:focus { border-color:#3b82f6; }
      .rs-select:disabled { opacity:.5; cursor:not-allowed; }
      /* ── Action checkboxes ── */
      .rs-actions-wrap { display:flex; flex-wrap:wrap; gap:8px; max-width:600px; }
      .rs-action-chip { display:inline-flex; align-items:center; gap:5px; padding:4px 10px; border:1px solid var(--border); border-radius:20px; font-size:12px; color:var(--muted); cursor:pointer; user-select:none; transition:background .1s,color .1s,border-color .1s; }
      .rs-action-chip input { display:none; }
      .rs-action-chip.checked { background:rgba(59,130,246,.18); border-color:#3b82f6; color:#93c5fd; }
      .rs-action-chip:hover { border-color:#6b7280; color:var(--text); }
      /* ── Status ── */
      .rs-status { font-size:13px; color:var(--muted); min-height:20px; margin-bottom:10px; }
      .rs-status--error { color:#f87171; }
      /* ── Table ── */
      .rs-table-wrap { overflow-x:auto; margin-top:4px; }
      .rs-table { width:100%; border-collapse:collapse; font-size:13px; }
      .rs-table th { text-align:left; padding:8px 12px; border-bottom:2px solid var(--border); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); white-space:nowrap; }
      .rs-table td { padding:8px 12px; border-bottom:1px solid var(--border); vertical-align:top; }
      .rs-table tr:last-child td { border-bottom:none; }
      .rs-table tr:hover td { background:rgba(255,255,255,.03); }
      /* ── Source badges ── */
      .rs-badge { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600; white-space:nowrap; }
      .rs-badge--manual { background:rgba(59,130,246,.18); color:#93c5fd; border:1px solid #3b82f6; }
      .rs-badge--group  { background:rgba(16,185,129,.15); color:#6ee7b7; border:1px solid #10b981; }
      .rs-badge--pending { background:rgba(107,114,128,.15); color:var(--muted); border:1px solid var(--border); }
      /* ── Empty / summary ── */
      .rs-empty { text-align:center; padding:56px 24px; color:var(--muted); }
      .rs-empty-icon { font-size:40px; margin-bottom:12px; }
      .rs-summary { font-size:12px; color:var(--muted); margin-bottom:12px; }
      /* ── Search btn ── */
      .rs-search-btn { padding:7px 22px; background:#3b82f6; color:#fff; border:none; border-radius:8px; font:inherit; font-size:13px; font-weight:600; cursor:pointer; transition:background .15s; height:34px; }
      .rs-search-btn:hover:not(:disabled) { background:#2563eb; }
      .rs-search-btn:disabled { opacity:.5; cursor:not-allowed; }
      /* ── Filter row ── */
      .rs-filter-row { display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
      .rs-filter-input { padding:5px 10px; border:1px solid var(--border); border-radius:8px; background:var(--bg,var(--panel)); color:var(--text); font:inherit; font-size:13px; outline:none; min-width:220px; }
      .rs-filter-input:focus { border-color:#3b82f6; }
      /* ── Role name ── */
      .rs-role-cell { color:#93c5fd; font-size:12px; }
      .rs-div-cell  { color:var(--muted); font-size:12px; }
    </style>

    <h2 style="margin:0 0 18px">Roles — Search</h2>

    <div class="rs-controls" id="rsControls">
      <div class="rs-control-group">
        <span class="rs-label">Domain</span>
        <select class="rs-select" id="rsDomain" disabled>
          <option value="">Loading catalog…</option>
        </select>
      </div>
      <div class="rs-control-group">
        <span class="rs-label">Entity</span>
        <select class="rs-select" id="rsEntity" disabled>
          <option value="">Select domain first</option>
        </select>
      </div>
      <div class="rs-control-group">
        <span class="rs-label">Actions</span>
        <div class="rs-actions-wrap" id="rsActions">
          <span style="font-size:12px;color:var(--muted)">Select entity first</span>
        </div>
      </div>
      <div class="rs-control-group" style="justify-content:flex-end">
        <button class="rs-search-btn" id="rsSearchBtn" disabled>Search</button>
      </div>
    </div>

    <div class="rs-status" id="rsStatus"></div>

    <div id="rsResults">
      <div class="rs-empty">
        <div class="rs-empty-icon">🔍</div>
        <p>Select a domain and entity, then click <strong>Search</strong> to find who has the permission.</p>
      </div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────────
  const $domain    = el.querySelector("#rsDomain");
  const $entity    = el.querySelector("#rsEntity");
  const $actions   = el.querySelector("#rsActions");
  const $searchBtn = el.querySelector("#rsSearchBtn");
  const $status    = el.querySelector("#rsStatus");
  const $results   = el.querySelector("#rsResults");

  // ── State ─────────────────────────────────────────────────
  let catalog   = null;  // { domain: { entity: [action] } }
  let searching = false;
  let rowData   = [];    // all rendered rows: { userId, userName, email, roleId, roleName, division, checkedActions }
  let filterText = "";

  // ── Status helper ─────────────────────────────────────────
  function setStatus(msg, cls = "") {
    $status.textContent = msg;
    $status.className = "rs-status" + (cls ? ` rs-status--${cls}` : "");
  }

  // ── Catalog loading ───────────────────────────────────────
  async function loadCatalog() {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }
    setStatus("Loading permission catalog…");
    try {
      catalog = await fetchPermissionCatalog(api, org.id);
      const domains = Object.keys(catalog).sort();
      $domain.innerHTML = `<option value="">Select domain…</option>` +
        domains.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
      $domain.disabled = false;
      setStatus("");
    } catch (err) {
      setStatus(`Failed to load catalog: ${err.message}`, "error");
    }
  }

  loadCatalog();

  // ── Domain → Entity cascade ───────────────────────────────
  $domain.addEventListener("change", () => {
    const domain = $domain.value;
    $entity.innerHTML = "";
    $actions.innerHTML = `<span style="font-size:12px;color:var(--muted)">Select entity first</span>`;
    $searchBtn.disabled = true;

    if (!domain || !catalog?.[domain]) {
      $entity.innerHTML = `<option value="">Select domain first</option>`;
      $entity.disabled = true;
      return;
    }

    const entities = Object.keys(catalog[domain]).sort();
    $entity.innerHTML = `<option value="">Select entity…</option>` +
      entities.map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join("");
    $entity.disabled = false;
  });

  // ── Entity → Action checkboxes ────────────────────────────
  $entity.addEventListener("change", () => {
    const domain = $domain.value;
    const entity = $entity.value;
    $searchBtn.disabled = true;

    if (!entity || !catalog?.[domain]?.[entity]) {
      $actions.innerHTML = `<span style="font-size:12px;color:var(--muted)">Select entity first</span>`;
      return;
    }

    const actions = catalog[domain][entity];
    $actions.innerHTML = actions.map(a => `
      <label class="rs-action-chip checked">
        <input type="checkbox" value="${escapeHtml(a)}" checked>
        ${escapeHtml(a)}
      </label>
    `).join("");

    // Toggle chip style on change
    $actions.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.addEventListener("change", () => {
        cb.parentElement.classList.toggle("checked", cb.checked);
        updateSearchBtn();
      });
    });

    updateSearchBtn();
  });

  function getCheckedActions() {
    return [...$actions.querySelectorAll("input[type=checkbox]:checked")].map(c => c.value);
  }

  function updateSearchBtn() {
    $searchBtn.disabled = searching || !$domain.value || !$entity.value || getCheckedActions().length === 0;
  }

  // ── Source badge renderer ─────────────────────────────────
  function sourceBadge(source) {
    if (!source || source === "Resolving…") {
      return `<span class="rs-badge rs-badge--pending">Resolving…</span>`;
    }
    return source.split(";").map(s => {
      s = s.trim();
      if (s === "Assigned manually") return `<span class="rs-badge rs-badge--manual">Assigned manually</span>`;
      return `<span class="rs-badge rs-badge--group">${escapeHtml(s)}</span>`;
    }).join(" ");
  }

  // ── Table renderer ────────────────────────────────────────
  function buildResultsTable() {
    const wrap = document.createElement("div");

    const filterRow = document.createElement("div");
    filterRow.className = "rs-filter-row";
    filterRow.innerHTML = `
      <input class="rs-filter-input" id="rsFilter" placeholder="Filter by name or email…" value="${escapeHtml(filterText)}">
      <span class="rs-summary" id="rsSummary"></span>
    `;
    wrap.appendChild(filterRow);

    const tableWrap = document.createElement("div");
    tableWrap.className = "rs-table-wrap";
    tableWrap.innerHTML = `
      <table class="rs-table" id="rsTable">
        <thead>
          <tr>
            <th>User</th>
            <th>Email</th>
            <th>Role</th>
            <th>Division</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody id="rsTbody"></tbody>
      </table>
    `;
    wrap.appendChild(tableWrap);
    return wrap;
  }

  function updateSummary() {
    const $summary = el.querySelector("#rsSummary");
    const $tbody = el.querySelector("#rsTbody");
    if (!$summary || !$tbody) return;
    const visible = $tbody.querySelectorAll("tr:not([hidden])").length;
    const total   = $tbody.querySelectorAll("tr").length;
    $summary.textContent = visible === total
      ? `${total} result${total !== 1 ? "s" : ""}`
      : `${visible} of ${total} results`;
  }

  function applyFilter() {
    const $tbody = el.querySelector("#rsTbody");
    if (!$tbody) return;
    const q = filterText.toLowerCase();
    for (const tr of $tbody.querySelectorAll("tr")) {
      const name  = (tr.dataset.name  || "").toLowerCase();
      const email = (tr.dataset.email || "").toLowerCase();
      tr.hidden = q.length > 0 && !name.includes(q) && !email.includes(q);
    }
    updateSummary();
  }

  // ── Append a single user row ──────────────────────────────
  function appendRow({ userId, userName, email, roleId, roleName, division, rowId }) {
    const $tbody = el.querySelector("#rsTbody");
    if (!$tbody) return;
    const tr = document.createElement("tr");
    tr.id = rowId;
    tr.dataset.name  = userName;
    tr.dataset.email = email;
    tr.dataset.roleId = roleId;
    tr.innerHTML = `
      <td>${escapeHtml(userName)}</td>
      <td>${escapeHtml(email)}</td>
      <td class="rs-role-cell">${escapeHtml(roleName)}</td>
      <td class="rs-div-cell">${escapeHtml(division || "")}</td>
      <td class="rs-source-cell">${sourceBadge(null)}</td>
    `;
    $tbody.appendChild(tr);
    applyFilter();
  }

  function updateRowSource(rowId, source) {
    const tr = el.querySelector(`#${CSS.escape(rowId)}`);
    if (!tr) return;
    const cell = tr.querySelector(".rs-source-cell");
    if (cell) cell.innerHTML = sourceBadge(source);
  }

  // ── Main search ───────────────────────────────────────────
  $searchBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    const domain  = $domain.value;
    const entity  = $entity.value;
    const actions = getCheckedActions();
    if (!domain || !entity || actions.length === 0) return;

    searching = true;
    rowData = [];
    filterText = "";
    updateSearchBtn();
    setStatus(`Searching for roles with permission ${domain}:${entity}…`);

    // Render the table skeleton immediately
    $results.innerHTML = "";
    $results.appendChild(buildResultsTable());

    el.querySelector("#rsFilter").addEventListener("input", e => {
      filterText = e.target.value;
      applyFilter();
    });

    try {
      // ── Step 1: find matching roles (one request per action, deduplicated) ──
      const roleMap = new Map(); // roleId → roleName
      const rolesByAction = {}; // action → Set<roleId>

      const roleResults = await Promise.all(
        actions.map(action =>
          fetchRolesForPermission(api, org.id, domain, entity, action)
            .then(roles => ({ action, roles }))
        )
      );

      for (const { action, roles } of roleResults) {
        rolesByAction[action] = new Set(roles.map(r => r.id));
        for (const r of roles) {
          if (!roleMap.has(r.id)) roleMap.set(r.id, r.name);
        }
      }

      if (roleMap.size === 0) {
        setStatus("");
        $results.innerHTML = `<div class="rs-empty"><div class="rs-empty-icon">🔍</div>
          <p>No roles found with permission <strong>${escapeHtml(domain)}:${escapeHtml(entity)}</strong>.</p></div>`;
        return;
      }

      setStatus(`Found ${roleMap.size} role${roleMap.size !== 1 ? "s" : ""} — loading users…`);

      // ── Step 2: for each role, load its users and stream rows ──
      let totalUsers = 0;
      const attributionTasks = []; // deferred source-resolution tasks

      await Promise.all(
        [...roleMap.entries()].map(async ([roleId, roleName]) => {
          let users;
          try {
            users = await fetchUsersForRole(api, org.id, roleId);
          } catch {
            return; // skip role on error
          }

          for (const u of users) {
            totalUsers++;
            const rowId = `rs-row-${roleId}-${u.id}`;
            appendRow({
              userId:    u.id,
              userName:  u.name,
              email:     u.email,
              roleId,
              roleName,
              division:  u.division?.name || "",
              rowId,
            });
            attributionTasks.push({ userId: u.id, roleId, rowId });
          }
        })
      );

      if (totalUsers === 0) {
        setStatus("");
        $results.innerHTML = `<div class="rs-empty"><div class="rs-empty-icon">👥</div>
          <p>No users are currently assigned roles with permission <strong>${escapeHtml(domain)}:${escapeHtml(entity)}</strong>.</p></div>`;
        return;
      }

      updateSummary();
      setStatus(`Found ${totalUsers} user assignment${totalUsers !== 1 ? "s" : ""} — resolving sources…`);

      // ── Step 3: resolve source attribution in batches of 10 ──
      await runBatched(
        attributionTasks.map(({ userId, roleId, rowId }) => async () => {
          try {
            const source = await resolveUserSource(api, org.id, userId, roleId);
            updateRowSource(rowId, source);
          } catch {
            updateRowSource(rowId, "Unknown");
          }
        }),
        10
      );

      setStatus(`Done — ${totalUsers} user assignment${totalUsers !== 1 ? "s" : ""}.`);

    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      searching = false;
      updateSearchBtn();
    }
  });

  return el;
}
