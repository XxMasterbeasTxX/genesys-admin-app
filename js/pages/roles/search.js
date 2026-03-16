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
import { escapeHtml, exportXlsx, timestampedFilename } from "../../utils.js";
import { fetchAllAuthorizationRoles, fetchAllUsers } from "../../services/genesysApi.js";

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

// ── Client-side role filter by permissionPolicies ───────────────────────────

/**
 * Returns true if the role's permissionPolicies grant any of the
 * checkedActions for the given domain+entity (wildcard-aware).
 */
function roleMatchesPermission(role, domain, entity, checkedActions) {
  for (const p of (role.permissionPolicies || [])) {
    const domainMatch  = p.domain     === domain || p.domain     === "*";
    const entityMatch  = p.entityName === entity || p.entityName === "*";
    if (!domainMatch || !entityMatch) continue;
    const actionSet = p.actionSet || [];
    if (actionSet.includes("*")) return true;
    if (checkedActions.some(a => actionSet.includes(a))) return true;
  }
  return false;
}

// ── Source attribution (uses pre-fetched group cache) ────────────────────────

function buildSourceLabel(roleId, userGroups, groupGrantsCache, groupNameCache) {
  const groupRoleIds = new Set();
  for (const g of userGroups) {
    for (const grant of (groupGrantsCache.get(g.id) || [])) {
      if (grant.role?.id) groupRoleIds.add(grant.role.id);
    }
  }
  const sources = [];
  if (!groupRoleIds.has(roleId)) sources.push("Assigned manually");
  for (const g of userGroups) {
    if ((groupGrantsCache.get(g.id) || []).some(gr => gr.role?.id === roleId)) {
      sources.push(`Inherited from Group: ${groupNameCache.get(g.id) || g.name || g.id}`);
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
      /* ── Export btn ── */
      .rs-export-btn { margin-left:auto; padding:5px 16px; background:transparent; color:#93c5fd; border:1px solid #3b82f6; border-radius:8px; font:inherit; font-size:12px; font-weight:600; cursor:pointer; transition:background .15s,color .15s; white-space:nowrap; }
      .rs-export-btn:hover:not(:disabled) { background:rgba(59,130,246,.18); }
      .rs-export-btn:disabled { opacity:.4; cursor:not-allowed; }
      /* ── Role name ── */
      .rs-role-cell { color:#93c5fd; font-size:12px; }
      .rs-div-cell  { color:var(--muted); font-size:12px; }
      /* ── Searchable combobox ── */
      .rs-combo { position:relative; min-width:200px; }
      .rs-combo-input { width:100%; padding:6px 10px; border:1px solid var(--border); border-radius:8px; background:var(--bg,var(--panel)); color:var(--text); font:inherit; font-size:13px; outline:none; box-sizing:border-box; }
      .rs-combo-input:focus { border-color:#3b82f6; }
      .rs-combo-input:disabled { opacity:.5; cursor:not-allowed; }
      .rs-combo-list { display:none; position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:300; max-height:220px; overflow-y:auto; background:var(--panel); border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.4); }
      .rs-combo-list.open { display:block; }
      .rs-combo-option { padding:7px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid rgba(255,255,255,.04); }
      .rs-combo-option:last-child { border-bottom:none; }
      .rs-combo-option:hover { background:rgba(59,130,246,.15); color:#93c5fd; }
      .rs-combo-noresult { padding:10px 12px; font-size:12px; color:var(--muted); text-align:center; }
    </style>

    <h2 style="margin:0 0 18px">Roles — Search</h2>

    <div class="rs-controls" id="rsControls">
      <div class="rs-control-group">
        <span class="rs-label">Domain</span>
        <div class="rs-combo">
          <input class="rs-combo-input" id="rsDomainInput" placeholder="Loading…" autocomplete="off" disabled>
          <div class="rs-combo-list" id="rsDomainList"></div>
        </div>
      </div>
      <div class="rs-control-group">
        <span class="rs-label">Entity</span>
        <div class="rs-combo">
          <input class="rs-combo-input" id="rsEntityInput" placeholder="Select domain first" autocomplete="off" disabled>
          <div class="rs-combo-list" id="rsEntityList"></div>
        </div>
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
  const $actions   = el.querySelector("#rsActions");
  const $searchBtn = el.querySelector("#rsSearchBtn");
  const $status    = el.querySelector("#rsStatus");
  const $results   = el.querySelector("#rsResults");

  // ── State ─────────────────────────────────────────────────
  let catalog        = null;
  let searching      = false;
  let filterText     = "";
  let selectedDomain = "";
  let selectedEntity = "";

  // ── Status helper ─────────────────────────────────────────
  function setStatus(msg, cls = "") {
    $status.textContent = msg;
    $status.className = "rs-status" + (cls ? ` rs-status--${cls}` : "");
  }

  // ── Combobox factory ──────────────────────────────────────
  function createCombobox(inputId, listId, onSelect) {
    const input = el.querySelector(`#${inputId}`);
    const list  = el.querySelector(`#${listId}`);
    let items   = [];
    let current = "";

    function renderList(filter) {
      const q       = (filter ?? "").toLowerCase();
      const matched = q ? items.filter(v => v.toLowerCase().includes(q)) : items;
      list.innerHTML = matched.length
        ? matched.map(v => `<div class="rs-combo-option" data-value="${escapeHtml(v)}">${escapeHtml(v)}</div>`).join("")
        : `<div class="rs-combo-noresult">No results</div>`;
      list.classList.add("open");
    }

    function close() {
      list.classList.remove("open");
      input.value = current;
    }

    function select(value) {
      current = value; input.value = value;
      list.classList.remove("open");
      onSelect(value);
    }

    input.addEventListener("focus",  () => { if (!input.disabled) { input.select(); renderList(""); } });
    input.addEventListener("input",  () => renderList(input.value));
    input.addEventListener("blur",   () => setTimeout(close, 150));
    list.addEventListener("mousedown", e => {
      const opt = e.target.closest(".rs-combo-option");
      if (opt) select(opt.dataset.value);
    });

    return {
      setItems(newItems) {
        items = newItems; current = "";
        input.value = ""; input.disabled = false; input.placeholder = "Search…";
      },
      getValue() { return current; },
      reset(placeholder = "") {
        items = []; current = "";
        input.value = ""; input.disabled = true; input.placeholder = placeholder;
        list.classList.remove("open");
      },
    };
  }

  // ── Combobox wiring ───────────────────────────────────────
  const domainCombo = createCombobox("rsDomainInput", "rsDomainList", value => {
    selectedDomain = value;
    selectedEntity = "";
    $actions.innerHTML = `<span style="font-size:12px;color:var(--muted)">Select entity first</span>`;
    $searchBtn.disabled = true;
    if (value && catalog?.[value]) {
      entityCombo.setItems(Object.keys(catalog[value]).sort());
    } else {
      entityCombo.reset("Select domain first");
    }
  });

  const entityCombo = createCombobox("rsEntityInput", "rsEntityList", value => {
    selectedEntity = value;
    $searchBtn.disabled = true;
    if (!value || !catalog?.[selectedDomain]?.[value]) {
      $actions.innerHTML = `<span style="font-size:12px;color:var(--muted)">Select entity first</span>`;
      return;
    }
    const actions = catalog[selectedDomain][value];
    $actions.innerHTML = actions.map(a => `
      <label class="rs-action-chip checked">
        <input type="checkbox" value="${escapeHtml(a)}" checked>
        ${escapeHtml(a)}
      </label>
    `).join("");
    $actions.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.addEventListener("change", () => {
        cb.parentElement.classList.toggle("checked", cb.checked);
        updateSearchBtn();
      });
    });
    updateSearchBtn();
  });

  // ── Catalog loading ───────────────────────────────────────
  async function loadCatalog() {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }
    setStatus("Loading permission catalog…");
    try {
      catalog = await fetchPermissionCatalog(api, org.id);
      domainCombo.setItems(Object.keys(catalog).sort());
      setStatus("");
    } catch (err) {
      setStatus(`Failed to load catalog: ${err.message}`, "error");
    }
  }

  loadCatalog();

  function getCheckedActions() {
    return [...$actions.querySelectorAll("input[type=checkbox]:checked")].map(c => c.value);
  }

  function updateSearchBtn() {
    $searchBtn.disabled = searching || !selectedDomain || !selectedEntity || getCheckedActions().length === 0;
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
      <button class="rs-export-btn" id="rsExportBtn" disabled>Export to Excel</button>
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
  function appendRow({ userName, email, roleName, division, source, rowId }) {
    const $tbody = el.querySelector("#rsTbody");
    if (!$tbody) return;
    const tr = document.createElement("tr");
    tr.id = rowId;
    tr.dataset.name  = userName;
    tr.dataset.email = email;
    tr.innerHTML = `
      <td>${escapeHtml(userName)}</td>
      <td>${escapeHtml(email)}</td>
      <td class="rs-role-cell">${escapeHtml(roleName)}</td>
      <td class="rs-div-cell">${escapeHtml(division || "")}</td>
      <td>${sourceBadge(source)}</td>
    `;
    $tbody.appendChild(tr);
  }

  // ── Main search ───────────────────────────────────────────
  $searchBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) { setStatus("Please select a customer org first.", "error"); return; }

    const domain  = selectedDomain;
    const entity  = selectedEntity;
    const actions = getCheckedActions();
    if (!domain || !entity || actions.length === 0) return;

    searching = true;
    filterText = "";
    updateSearchBtn();
    setStatus("Fetching roles and users…");
    $results.innerHTML = "";

    try {
      // ── Step 1: fetch all roles + all active org users in parallel ──
      // fetchAllUsers returns only users in THIS org — trustee org users are
      // automatically excluded because they are not in the local directory.
      const [allRoles, allUsers] = await Promise.all([
        fetchAllAuthorizationRoles(api, org.id),
        fetchAllUsers(api, org.id, { expand: ["authorization", "groups"] }),
      ]);

      const matchingRoleIds = new Set(
        allRoles
          .filter(r => roleMatchesPermission(r, domain, entity, actions))
          .map(r => r.id)
      );
      const roleNameMap = new Map(allRoles.map(r => [r.id, r.name || r.id]));

      if (matchingRoleIds.size === 0) {
        setStatus("");
        $results.innerHTML = `<div class="rs-empty"><div class="rs-empty-icon">🔍</div>
          <p>No roles found with permission <strong>${escapeHtml(domain)}:${escapeHtml(entity)}</strong>.</p></div>`;
        return;
      }

      // ── Step 2: filter local users who have a matching role ──
      // user.authorization.roles[] may have .id or .roleId
      const matchedUsers = [];
      for (const user of allUsers) {
        for (const ur of (user.authorization?.roles || [])) {
          const rid = ur.id || ur.roleId;
          if (rid && matchingRoleIds.has(rid)) {
            matchedUsers.push({
              userId:   user.id,
              userName: user.name || user.username || user.id,
              email:    user.email || "",
              roleId:   rid,
              roleName: roleNameMap.get(rid) || rid,
              groups:   user.groups || [],
            });
          }
        }
      }

      if (matchedUsers.length === 0) {
        setStatus("");
        $results.innerHTML = `<div class="rs-empty"><div class="rs-empty-icon">👥</div>
          <p>No users in this org have permission <strong>${escapeHtml(domain)}:${escapeHtml(entity)}</strong>.</p></div>`;
        return;
      }

      // Sort alphabetically by name
      matchedUsers.sort((a, b) =>
        a.userName.localeCompare(b.userName, undefined, { sensitivity: "base" })
      );

      // ── Step 3: fetch group subjects for all unique groups (batched) ──
      setStatus(`Found ${matchedUsers.length} assignment${matchedUsers.length !== 1 ? "s" : ""} — resolving sources…`);

      const allGroupIds      = new Set(matchedUsers.flatMap(u => u.groups.map(g => g.id)));
      const groupGrantsCache = new Map(); // groupId → grants[]
      const groupNameCache   = new Map(); // groupId → name

      await runBatched(
        [...allGroupIds].map(groupId => async () => {
          try {
            const [gs, gd] = await Promise.all([
              api.proxyGenesys(org.id, "GET", `/api/v2/authorization/subjects/${groupId}`),
              api.proxyGenesys(org.id, "GET", `/api/v2/groups/${groupId}`),
            ]);
            groupGrantsCache.set(groupId, gs.grants || []);
            groupNameCache.set(groupId, gd.name || groupId);
          } catch {
            groupGrantsCache.set(groupId, []);
          }
        }),
        10
      );

      // ── Step 4: render table (names + sources already known, sorted) ──
      $results.appendChild(buildResultsTable());
      el.querySelector("#rsFilter").addEventListener("input", e => {
        filterText = e.target.value;
        applyFilter();
      });

      for (const u of matchedUsers) {
        const rowId  = `rs-row-${u.roleId}-${u.userId}`;
        const source = buildSourceLabel(u.roleId, u.groups, groupGrantsCache, groupNameCache);
        appendRow({ userName: u.userName, email: u.email, roleName: u.roleName, division: "", source, rowId });
      }

      applyFilter();
      updateSummary();
      setStatus(`Done — ${matchedUsers.length} assignment${matchedUsers.length !== 1 ? "s" : ""}.`);

      // Enable export
      const $exportBtn = el.querySelector("#rsExportBtn");
      if ($exportBtn) {
        $exportBtn.disabled = false;
        $exportBtn.onclick = () => {
          const org     = orgContext?.getDetails?.();
          const orgSlug = (org?.name || "").replace(/\s+/g, "_") || "org";
          const filename = timestampedFilename(`Roles_Search_${orgSlug}`, "xlsx");
          const columns = [
            { key: "user",   label: "User",   wch: 30 },
            { key: "email",  label: "Email",  wch: 36 },
            { key: "role",   label: "Role",   wch: 40 },
            { key: "source", label: "Source", wch: 50 },
          ];
          // Export all rows (not filtered-out) from the table
          const rows = [];
          el.querySelectorAll("#rsTbody tr").forEach(tr => {
            const cells = tr.querySelectorAll("td");
            rows.push({
              user:   cells[0]?.textContent?.trim() || "",
              email:  cells[1]?.textContent?.trim() || "",
              role:   cells[2]?.textContent?.trim() || "",
              source: cells[4]?.textContent?.trim() || "",
            });
          });
          try {
            exportXlsx([{ name: "Roles Search", rows, columns }], filename);
          } catch (err) {
            setStatus(err.message, "error");
          }
        };
      }

    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      searching = false;
      updateSearchBtn();
    }
  });

  return el;
}
