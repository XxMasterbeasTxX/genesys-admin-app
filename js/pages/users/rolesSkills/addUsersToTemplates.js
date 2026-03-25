/**
 * Users › Roles, Queues & Skills › Add Users To Templates
 *
 * Two-panel layout:
 *   Left:  Browse & filter templates. Click to select.
 *          Read-only view of template setup (roles, skills, languages, queues).
 *   Right: Shows assigned users (with remove) and a user search (with add).
 *          Confirmation modal + granular progress bar for both operations.
 */
import { escapeHtml } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createSingleSelect } from "../../../components/multiSelect.js";
import { fetchTemplates } from "../../../services/templateService.js";
import {
  fetchAssignments,
  createAssignment,
  deleteAssignmentByUserTemplate,
  deleteAssignmentByGroupTemplate,
  deleteAssignmentByWorkteamTemplate,
} from "../../../services/templateAssignmentService.js";

export default function renderAddUsersToTemplates({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Add Users To Templates</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  const orgId = org.id;

  el.innerHTML = `
    <h1 class="h1">Add Users To Templates</h1>
    <hr class="hr">
    <p class="page-desc">
      Browse templates, view their setup, and assign or remove users.
    </p>
    <div class="cu-status" id="autStatus"></div>
    <div class="cu-loading" id="autLoading">
      <div class="cu-loading-spinner"></div>
      <p class="muted">Loading templates…</p>
    </div>
    <div class="cu-layout" id="autLayout" hidden>
      <div class="cu-panel cu-panel--left" id="autLeft">
        <h2 class="cu-panel-title">Templates</h2>
        <input type="text" class="input" id="autFilter" placeholder="Filter templates…" style="margin-bottom:10px" />
        <div id="autTemplateList" class="cu-user-list"></div>
      </div>
      <div class="cu-panel cu-panel--right" id="autRight">
        <div id="autDetail"></div>
      </div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────
  const $status   = el.querySelector("#autStatus");
  const $loading  = el.querySelector("#autLoading");
  const $layout   = el.querySelector("#autLayout");
  const $filter   = el.querySelector("#autFilter");
  const $tplList  = el.querySelector("#autTemplateList");
  const $detail   = el.querySelector("#autDetail");

  // ── State ─────────────────────────────────────────────
  let templates = [];
  let allAssignments = [];
  let selectedTemplate = null; // currently active template object
  let allGroups = [];
  let allDivisions = [];
  let allTeams = [];

  // ── Status helper ─────────────────────────────────────
  function setStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "cu-status" + (type ? ` cu-status--${type}` : "");
  }

  // ── Confirm modal ─────────────────────────────────────
  function showConfirmModal({ title, bodyHTML, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center";
      const confirmClass = danger ? "btn btn--danger" : "btn";
      overlay.innerHTML = `
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;min-width:340px;max-width:640px;width:90%;box-shadow:var(--shadow);color:var(--text)">
          <h3 style="margin:0 0 16px;font-size:1.1rem">${escapeHtml(title)}</h3>
          <div style="font-size:.9rem;line-height:1.6">${bodyHTML}</div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
            <button id="autModalCancel" class="btn btn--secondary">${escapeHtml(cancelLabel)}</button>
            <button id="autModalConfirm" class="${confirmClass}">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector("#autModalCancel").addEventListener("click", () => { document.body.removeChild(overlay); resolve(false); });
      overlay.querySelector("#autModalConfirm").addEventListener("click", () => { document.body.removeChild(overlay); resolve(true); });
    });
  }

  // ── Initialise ────────────────────────────────────────
  init();
  async function init() {
    try {
      const [tpls, assigns, groups, divisions, teams] = await Promise.all([
        fetchTemplates(orgId),
        fetchAssignments(orgId),
        gc.fetchAllPages(api, orgId, "/api/v2/groups"),
        gc.fetchAllPages(api, orgId, "/api/v2/authorization/divisions"),
        gc.fetchAllTeams(api, orgId),
      ]);
      templates = tpls.sort((a, b) => a.name.localeCompare(b.name));
      allAssignments = assigns;
      allGroups = groups.map((g) => ({ id: g.id, name: g.name }));
      allDivisions = divisions.map((d) => ({ id: d.id, name: d.name }));
      allTeams = teams.map((t) => ({ id: t.id, name: t.name }));
      $loading.hidden = true;
      $layout.hidden = false;
      renderTemplateList();
      $detail.innerHTML = `<p class="muted">Select a template from the left to view details.</p>`;
    } catch (err) {
      $loading.hidden = true;
      setStatus(`Failed to load: ${err.message}`, "error");
    }
  }

  // ═══════════════════════════════════════════════════════
  // LEFT PANEL — Template list
  // ═══════════════════════════════════════════════════════
  $filter.addEventListener("input", renderTemplateList);

  function renderTemplateList() {
    const term = $filter.value.trim().toLowerCase();
    const filtered = term
      ? templates.filter((t) => t.name.toLowerCase().includes(term))
      : templates;

    if (!filtered.length) {
      $tplList.innerHTML = `<p class="muted">${term ? "No templates match the filter." : "No templates created yet."}</p>`;
      return;
    }

    $tplList.innerHTML = filtered.map((t) => {
      const active = selectedTemplate && selectedTemplate.id === t.id;
      const tplAssigns = allAssignments.filter((a) => a.templateId === t.id);
      const userCount = tplAssigns.filter((a) => !a.type || a.type === "user").length;
      const groupCount = tplAssigns.filter((a) => a.type === "group").length;
      const teamCount = tplAssigns.filter((a) => a.type === "workteam").length;
      const parts = [];
      if (userCount) parts.push(`${userCount} user${userCount !== 1 ? "s" : ""}`);
      if (groupCount) parts.push(`${groupCount} group${groupCount !== 1 ? "s" : ""}`);
      if (teamCount) parts.push(`${teamCount} team${teamCount !== 1 ? "s" : ""}`);
      const assignedLabel = parts.length ? parts.join(" · ") : "0 users";
      return `
        <div class="cu-user-row${active ? " cu-user-row--checked" : ""}" data-id="${t.id}" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border)">
          <div style="flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="cu-user-name" style="font-weight:600">${escapeHtml(t.name)}</span>
            <span class="cu-user-email" style="color:var(--muted);font-size:13px">${(t.roles || []).length} roles · ${(t.skills || []).length} skills · ${(t.languages || []).length} langs · ${(t.queues || []).length} queues</span>
          </div>
          <span class="cu-user-email" style="white-space:nowrap;color:var(--muted);font-size:13px">${assignedLabel}</span>
        </div>`;
    }).join("");

    $tplList.querySelectorAll(".cu-user-row").forEach((row) => {
      row.addEventListener("click", () => {
        const t = templates.find((x) => x.id === row.dataset.id);
        if (t) selectTemplate(t);
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  // RIGHT PANEL — Template detail + assigned users + add
  // ═══════════════════════════════════════════════════════
  function selectTemplate(t) {
    selectedTemplate = t;
    renderTemplateList(); // refresh highlight
    renderDetail();
  }

  function renderDetail() {
    const t = selectedTemplate;
    if (!t) {
      $detail.innerHTML = `<p class="muted">Select a template from the left to view details.</p>`;
      return;
    }

    $detail.innerHTML = `
      <h2 class="cu-panel-title" style="margin-bottom:4px">${escapeHtml(t.name)}</h2>
      <p class="muted" style="margin:0 0 16px;font-size:12px">Created by: ${escapeHtml(t.createdByName || t.createdBy || "—")}</p>

      <!-- Read-only template setup (horizontal) -->
      <div id="autSetup" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:16px"></div>

      <!-- Assigned: 3 columns -->
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <!-- Assigned Users -->
          <div style="flex:1;min-width:220px">
            <h3 class="cu-panel-title" style="font-size:14px;margin-bottom:10px" id="autAssignedTitle">Assigned Users</h3>
            <div id="autAssignedList"></div>
            <button class="btn btn--danger btn-sm" id="autBtnRemove" hidden style="margin-top:6px">Remove Selected</button>
          </div>
          <!-- Assigned Groups -->
          <div style="flex:1;min-width:220px">
            <h3 class="cu-panel-title" style="font-size:14px;margin-bottom:10px" id="autAssignedGroupsTitle">Assigned Groups</h3>
            <div id="autAssignedGroupsList"></div>
            <button class="btn btn--danger btn-sm" id="autBtnRemoveGroups" hidden style="margin-top:6px">Remove Selected</button>
          </div>
          <!-- Assigned Work Teams -->
          <div style="flex:1;min-width:220px">
            <h3 class="cu-panel-title" style="font-size:14px;margin-bottom:10px" id="autAssignedTeamsTitle">Assigned Work Teams</h3>
            <div id="autAssignedTeamsList"></div>
            <button class="btn btn--danger btn-sm" id="autBtnRemoveTeams" hidden style="margin-top:6px">Remove Selected</button>
          </div>
        </div>
      </div>

      <!-- Add: 3 columns -->
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <!-- Add Users -->
          <div style="flex:1 1 0;min-width:220px">
            <h3 class="cu-panel-title" style="font-size:14px;margin-bottom:10px">Add Users</h3>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
              <div id="autModePicker"></div>
              <button class="btn btn-sm" id="autBtnAdd" hidden>Assign Selected to Template</button>
            </div>
            <div id="autSecondary"></div>
            <div id="autSearchResults"></div>
            <div class="cu-pagination" id="autPagination"></div>
          </div>
          <!-- Add Group -->
          <div style="flex:1 1 0;min-width:220px">
            <h3 class="cu-panel-title" style="font-size:14px;margin-bottom:10px">Add Group</h3>
            <div id="autAddGroupPicker"></div>
          </div>
          <!-- Add Work Team -->
          <div style="flex:1 1 0;min-width:220px">
            <h3 class="cu-panel-title" style="font-size:14px;margin-bottom:10px">Add Work Team</h3>
            <div id="autAddTeamPicker"></div>
          </div>
        </div>
      </div>

      <!-- Progress (shared) -->
      <div class="cu-progress" id="autProgress" hidden>
        <div class="cu-progress-bar"><div class="cu-progress-fill" id="autProgressFill"></div></div>
        <p class="cu-progress-text" id="autProgressText"></p>
        <div class="cu-progress-log" id="autProgressLog"></div>
      </div>
    `;

    renderSetup(t);
    renderAssignedUsers();
    renderAssignedGroups();
    renderAssignedTeams();
    wireSearch();
    wireGroupDropdown();
    wireTeamDropdown();
  }

  // ── Template setup (read-only, collapsible) ───────────
  function renderSetup(t) {
    const $setup = $detail.querySelector("#autSetup");
    const sections = [];

    // Roles
    const roleLines = (t.roles || []).map((r) => {
      const divs = (r.divisions || []).map((d) => escapeHtml(d.divisionName)).join(", ");
      return `<tr><td>${escapeHtml(r.roleName)}</td><td class="muted">${divs || "—"}</td></tr>`;
    }).join("");
    sections.push(buildSection("Roles", `(${(t.roles || []).length})`, roleLines
      ? `<table class="data-table cu-detail-table"><thead><tr><th>Role</th><th>Divisions</th></tr></thead><tbody>${roleLines}</tbody></table>`
      : `<p class="muted">None</p>`));

    // Skills
    const skillLines = (t.skills || []).map((s) =>
      `<tr><td>${escapeHtml(s.skillName)}</td><td>${s.proficiency || "—"}</td></tr>`
    ).join("");
    sections.push(buildSection("Skills", `(${(t.skills || []).length})`, skillLines
      ? `<table class="data-table cu-detail-table"><thead><tr><th>Skill</th><th>Prof.</th></tr></thead><tbody>${skillLines}</tbody></table>`
      : `<p class="muted">None</p>`));

    // Languages
    const langLines = (t.languages || []).map((l) =>
      `<tr><td>${escapeHtml(l.languageName)}</td><td>${l.proficiency || "—"}</td></tr>`
    ).join("");
    sections.push(buildSection("Languages", `(${(t.languages || []).length})`, langLines
      ? `<table class="data-table cu-detail-table"><thead><tr><th>Language</th><th>Prof.</th></tr></thead><tbody>${langLines}</tbody></table>`
      : `<p class="muted">None</p>`));

    // Queues (single-column — skip cu-detail-table to avoid 40px width constraint)
    const queueLines = (t.queues || []).map((q) =>
      `<tr><td>${escapeHtml(q.queueName)}</td></tr>`
    ).join("");
    sections.push(buildSection("Queues", `(${(t.queues || []).length})`, queueLines
      ? `<table class="data-table"><thead><tr><th>Queue</th></tr></thead><tbody>${queueLines}</tbody></table>`
      : `<p class="muted">None</p>`));

    $setup.innerHTML = sections.join("");

    // Wire toggles
    $setup.querySelectorAll(".cu-section-title.cu-collapsible").forEach(($toggle) => {
      const $body = $toggle.nextElementSibling;
      $toggle.addEventListener("click", () => {
        const open = !$body.hidden;
        $body.hidden = open;
        $toggle.querySelector(".cu-chevron").textContent = open ? "▸" : "▾";
      });
    });
  }

  function buildSection(label, countLabel, contentHTML) {
    return `
      <div class="cu-section" style="flex:1;min-width:160px">
        <h3 class="cu-section-title cu-collapsible"><span class="cu-chevron">▸</span> ${escapeHtml(label)} ${escapeHtml(countLabel)}</h3>
        <div class="cu-section-body" hidden>${contentHTML}</div>
      </div>`;
  }

  // ── Assigned users list ───────────────────────────────
  let assignedChecked = new Set();
  let assignedGroupsChecked = new Set();
  let assignedTeamsChecked = new Set();

  function renderAssignedUsers() {
    const t = selectedTemplate;
    if (!t) return;
    const assigned = allAssignments.filter((a) => a.templateId === t.id && (!a.type || a.type === "user"));
    const $list = $detail.querySelector("#autAssignedList");
    const $btnRemove = $detail.querySelector("#autBtnRemove");
    const $title = $detail.querySelector("#autAssignedTitle");
    $title.textContent = `Assigned Users (${assigned.length})`;
    assignedChecked = new Set();

    if (!assigned.length) {
      $list.innerHTML = `<p class="muted">No users assigned.</p>`;
      $btnRemove.hidden = true;
      return;
    }

    $list.innerHTML = assigned
      .sort((a, b) => (a.userName || "").localeCompare(b.userName || ""))
      .map((a) => `
        <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);cursor:pointer">
          <input type="checkbox" class="aut-assigned-cb" data-uid="${a.userId}" />
          <span>${escapeHtml(a.userName || a.userId)}</span>
        </label>`).join("");

    $list.querySelectorAll(".aut-assigned-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) assignedChecked.add(cb.dataset.uid);
        else assignedChecked.delete(cb.dataset.uid);
        $btnRemove.hidden = assignedChecked.size === 0;
      });
    });

    $btnRemove.hidden = true;
    $btnRemove.onclick = () => handleRemove();
  }

  function renderAssignedGroups() {
    const t = selectedTemplate;
    if (!t) return;
    const assigned = allAssignments.filter((a) => a.templateId === t.id && a.type === "group");
    const $list = $detail.querySelector("#autAssignedGroupsList");
    const $btnRemove = $detail.querySelector("#autBtnRemoveGroups");
    const $title = $detail.querySelector("#autAssignedGroupsTitle");
    $title.textContent = `Assigned Groups (${assigned.length})`;
    assignedGroupsChecked = new Set();

    if (!assigned.length) {
      $list.innerHTML = `<p class="muted">No groups assigned.</p>`;
      $btnRemove.hidden = true;
      return;
    }

    $list.innerHTML = assigned
      .sort((a, b) => (a.groupName || "").localeCompare(b.groupName || ""))
      .map((a) => `
        <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);cursor:pointer">
          <input type="checkbox" class="aut-assigned-group-cb" data-gid="${a.groupId}" />
          <span>${escapeHtml(a.groupName || a.groupId)}</span>
        </label>`).join("");

    $list.querySelectorAll(".aut-assigned-group-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) assignedGroupsChecked.add(cb.dataset.gid);
        else assignedGroupsChecked.delete(cb.dataset.gid);
        $btnRemove.hidden = assignedGroupsChecked.size === 0;
      });
    });

    $btnRemove.hidden = true;
    $btnRemove.onclick = () => handleRemoveGroups();
  }

  function renderAssignedTeams() {
    const t = selectedTemplate;
    if (!t) return;
    const assigned = allAssignments.filter((a) => a.templateId === t.id && a.type === "workteam");
    const $list = $detail.querySelector("#autAssignedTeamsList");
    const $btnRemove = $detail.querySelector("#autBtnRemoveTeams");
    const $title = $detail.querySelector("#autAssignedTeamsTitle");
    $title.textContent = `Assigned Work Teams (${assigned.length})`;
    assignedTeamsChecked = new Set();

    if (!assigned.length) {
      $list.innerHTML = `<p class="muted">No work teams assigned.</p>`;
      $btnRemove.hidden = true;
      return;
    }

    $list.innerHTML = assigned
      .sort((a, b) => (a.workteamName || "").localeCompare(b.workteamName || ""))
      .map((a) => `
        <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);cursor:pointer">
          <input type="checkbox" class="aut-assigned-team-cb" data-tid="${a.workteamId}" />
          <span>${escapeHtml(a.workteamName || a.workteamId)}</span>
        </label>`).join("");

    $list.querySelectorAll(".aut-assigned-team-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) assignedTeamsChecked.add(cb.dataset.tid);
        else assignedTeamsChecked.delete(cb.dataset.tid);
        $btnRemove.hidden = assignedTeamsChecked.size === 0;
      });
    });

    $btnRemove.hidden = true;
    $btnRemove.onclick = () => handleRemoveTeams();
  }

  // ── User search (Add Users) ───────────────────────────
  let searchResults = [];
  let searchChecked = new Set();
  let searchPage = 1;
  let searchTotalPages = 1;

  let currentAddMode = "";

  function wireSearch() {
    // Build mode picker
    const modes = [
      { id: "search", label: "Search" },
      { id: "group", label: "By Group" },
      { id: "division", label: "By Division" },
    ];
    const modeSelect = createSingleSelect({
      placeholder: "Search",
      searchable: false,
      onChange: (id) => switchAddMode(id || "search"),
    });
    modeSelect.setItems(modes);
    $detail.querySelector("#autModePicker").append(modeSelect.el);
    switchAddMode("search");
  }

  function switchAddMode(mode) {
    currentAddMode = mode;
    const $secondary = $detail.querySelector("#autSecondary");
    $secondary.innerHTML = "";
    searchResults = [];
    searchChecked = new Set();
    renderSearchResults();

    if (mode === "search") {
      buildAddSearchMode($secondary);
    } else if (mode === "group") {
      buildAddFilterMode($secondary, "Group", allGroups, loadGroupUsers);
    } else if (mode === "division") {
      buildAddFilterMode($secondary, "Division", allDivisions, loadDivisionUsers);
    }
  }

  function buildAddSearchMode($secondary) {
    const searchRow = document.createElement("div");
    searchRow.className = "cu-search-row";
    searchRow.innerHTML = `
      <input type="text" class="input cu-search-input" id="autSearchInput" placeholder="Search by name…" style="max-width:260px" />
      <button class="btn cu-btn-search" id="autSearchBtn">Search</button>
    `;
    $secondary.append(searchRow);

    const $input = searchRow.querySelector("#autSearchInput");
    const $btn   = searchRow.querySelector("#autSearchBtn");

    async function doSearch(page = 1) {
      const term = $input.value.trim();
      searchPage = page;
      $btn.disabled = true;
      $btn.textContent = "Searching…";
      try {
        let users, total;
        if (term) {
          const resp = await api.proxyGenesys(orgId, "POST", "/api/v2/users/search", {
            body: {
              pageSize: 100,
              pageNumber: page,
              query: [{ type: "QUERY_STRING", value: term, fields: ["name", "email"] }],
            },
          });
          users = (resp.results || []).map((u) => ({ id: u.id, name: u.name, email: u.email || "" }));
          total = resp.total || users.length;
        } else {
          const resp = await api.proxyGenesys(orgId, "GET", "/api/v2/users", {
            query: { pageSize: "100", pageNumber: String(page), sortOrder: "ASC" },
          });
          users = (resp.entities || []).map((u) => ({ id: u.id, name: u.name, email: u.email || "" }));
          total = resp.total || users.length;
        }
        searchResults = users;
        searchTotalPages = Math.max(1, Math.ceil(total / 100));
        searchChecked = new Set();
        renderSearchResults();
      } catch (err) {
        setStatus(`Search failed: ${err.message}`, "error");
      } finally {
        $btn.disabled = false;
        $btn.textContent = "Search";
      }
    }

    $btn.addEventListener("click", () => doSearch());
    $input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
    $detail._doSearch = doSearch;
  }

  function buildAddFilterMode($secondary, label, items, loader) {
    const filterSelect = createSingleSelect({
      placeholder: `Select ${label}…`,
      searchable: true,
      onChange: async (id) => {
        if (!id) {
          searchResults = [];
          searchChecked = new Set();
          renderSearchResults();
          return;
        }
        setStatus(`Loading ${label.toLowerCase()} members…`);
        try {
          const users = await loader(id);
          searchResults = users;
          searchTotalPages = 1;
          searchChecked = new Set();
          renderSearchResults();
          setStatus("");
        } catch (err) {
          setStatus(`Failed to load members: ${err.message}`, "error");
        }
      },
    });
    filterSelect.setItems(
      items.map((i) => ({ id: i.id, label: i.name })).sort((a, b) => a.label.localeCompare(b.label))
    );
    const row = document.createElement("div");
    row.className = "cu-filter-row";
    row.append(filterSelect.el);
    $secondary.append(row);
  }

  async function loadGroupUsers(groupId) {
    const members = await gc.fetchGroupMembers(api, orgId, groupId);
    return members.map((u) => ({ id: u.id, name: u.name, email: u.email || "" }));
  }

  async function loadDivisionUsers(divisionId) {
    const allUsers = await gc.fetchAllUsers(api, orgId);
    return allUsers
      .filter((u) => u.division?.id === divisionId)
      .map((u) => ({ id: u.id, name: u.name, email: u.email || "" }));
  }

  function renderSearchResults() {
    const $results = $detail.querySelector("#autSearchResults");
    const $btnAdd  = $detail.querySelector("#autBtnAdd");

    if (!searchResults.length) {
      $results.innerHTML = `<p class="muted">No results.</p>`;
      $btnAdd.hidden = true;
      renderSearchPagination();
      return;
    }

    // Filter out already-assigned users
    const assignedIds = new Set(
      allAssignments.filter((a) => a.templateId === selectedTemplate.id && (!a.type || a.type === "user")).map((a) => a.userId)
    );

    $results.innerHTML = searchResults.map((u) => {
      const already = assignedIds.has(u.id);
      return `
        <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);cursor:${already ? "default" : "pointer"}">
          <input type="checkbox" class="aut-search-cb" data-uid="${u.id}" ${already ? "disabled" : ""} />
          <span>${escapeHtml(u.name)}${already ? ' <span class="muted" style="font-size:11px">(already assigned)</span>' : ""}</span>
          <span class="muted" style="margin-left:auto;font-size:12px">${escapeHtml(u.email)}</span>
        </label>`;
    }).join("");

    $results.querySelectorAll(".aut-search-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) searchChecked.add(cb.dataset.uid);
        else searchChecked.delete(cb.dataset.uid);
        $btnAdd.hidden = searchChecked.size === 0;
      });
    });

    $btnAdd.hidden = true;
    $btnAdd.onclick = () => handleAdd();
    renderSearchPagination();
  }

  function renderSearchPagination() {
    const $pag = $detail.querySelector("#autPagination");
    if (searchTotalPages <= 1) { $pag.innerHTML = ""; return; }
    $pag.innerHTML = `
      <button class="btn btn-sm" id="autPrev" ${searchPage <= 1 ? "disabled" : ""}>◀ Prev</button>
      <span class="cu-page-info">${searchPage} / ${searchTotalPages}</span>
      <button class="btn btn-sm" id="autNext" ${searchPage >= searchTotalPages ? "disabled" : ""}>Next ▶</button>`;
    $pag.querySelector("#autPrev")?.addEventListener("click", () => $detail._doSearch(searchPage - 1));
    $pag.querySelector("#autNext")?.addEventListener("click", () => $detail._doSearch(searchPage + 1));
  }

  // ── Group & Work Team dropdowns ────────────────────────
  function wireGroupDropdown() {
    const $picker = $detail.querySelector("#autAddGroupPicker");
    const alreadyAssigned = new Set(
      allAssignments.filter((a) => a.templateId === selectedTemplate.id && a.type === "group").map((a) => a.groupId)
    );
    const available = allGroups.filter((g) => !alreadyAssigned.has(g.id));
    const dd = createSingleSelect({
      placeholder: "Select a group…",
      searchable: true,
      onChange: (id) => { if (id) handleAddGroup(id); },
    });
    dd.setItems(available.map((g) => ({ id: g.id, label: g.name })).sort((a, b) => a.label.localeCompare(b.label)));
    $picker.innerHTML = "";
    $picker.append(dd.el);
  }

  function wireTeamDropdown() {
    const $picker = $detail.querySelector("#autAddTeamPicker");
    const alreadyAssigned = new Set(
      allAssignments.filter((a) => a.templateId === selectedTemplate.id && a.type === "workteam").map((a) => a.workteamId)
    );
    const available = allTeams.filter((t) => !alreadyAssigned.has(t.id));
    const dd = createSingleSelect({
      placeholder: "Select a work team…",
      searchable: true,
      onChange: (id) => { if (id) handleAddWorkteam(id); },
    });
    dd.setItems(available.map((t) => ({ id: t.id, label: t.name })).sort((a, b) => a.label.localeCompare(b.label)));
    $picker.innerHTML = "";
    $picker.append(dd.el);
  }

  // ── Add Group ─────────────────────────────────────────
  async function handleAddGroup(groupId) {
    const t = selectedTemplate;
    if (!t) return;
    const group = allGroups.find((g) => g.id === groupId);
    if (!group) return;

    setStatus(`Loading members of group "${group.name}"…`);
    let members;
    try {
      members = await gc.fetchGroupMembers(api, orgId, groupId);
    } catch (err) {
      setStatus(`Failed to load group members: ${err.message}`, "error");
      return;
    }

    const confirmed = await showConfirmModal({
      title: "Assign Group to Template",
      bodyHTML: `
        <table style="width:100%;border-collapse:collapse;font-size:.9rem">
          <tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Template</td><td><strong>${escapeHtml(t.name)}</strong></td></tr>
          <tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Group</td><td><strong>${escapeHtml(group.name)}</strong></td></tr>
          <tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Members</td><td><strong>${members.length}</strong></td></tr>
        </table>
        <p style="margin-top:10px;font-size:.85rem;color:var(--muted)">All ${members.length} members will receive the template's roles, skills, languages, and queue memberships.</p>`,
      confirmLabel: "Assign Group",
    });
    if (!confirmed) { setStatus(""); return; }

    await applyTemplateToUsers(t, members.map((u) => ({ id: u.id, name: u.name, email: u.email || "" })));

    // Record group assignment
    try {
      await createAssignment({
        orgId,
        type: "group",
        groupId: group.id,
        groupName: group.name,
        templateId: t.id,
        templateName: t.name,
        assignedBy: me?.email || "",
      });
    } catch (err) {
      setStatus(`Group recorded but assignment record failed: ${err.message}`, "error");
    }

    // Refresh
    try { allAssignments = await fetchAssignments(orgId); } catch (_) {}
    renderTemplateList();
    renderAssignedUsers();
    renderAssignedGroups();
    renderAssignedTeams();
    wireGroupDropdown();
    wireTeamDropdown();
  }

  // ── Add Work Team ─────────────────────────────────────
  async function handleAddWorkteam(teamId) {
    const t = selectedTemplate;
    if (!t) return;
    const team = allTeams.find((wt) => wt.id === teamId);
    if (!team) return;

    setStatus(`Loading members of work team "${team.name}"…`);
    let members;
    try {
      members = await gc.fetchTeamMembers(api, orgId, teamId);
    } catch (err) {
      setStatus(`Failed to load work team members: ${err.message}`, "error");
      return;
    }

    const confirmed = await showConfirmModal({
      title: "Assign Work Team to Template",
      bodyHTML: `
        <table style="width:100%;border-collapse:collapse;font-size:.9rem">
          <tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Template</td><td><strong>${escapeHtml(t.name)}</strong></td></tr>
          <tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Work Team</td><td><strong>${escapeHtml(team.name)}</strong></td></tr>
          <tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Members</td><td><strong>${members.length}</strong></td></tr>
        </table>
        <p style="margin-top:10px;font-size:.85rem;color:var(--muted)">All ${members.length} members will receive the template's roles, skills, languages, and queue memberships.</p>`,
      confirmLabel: "Assign Work Team",
    });
    if (!confirmed) { setStatus(""); return; }

    await applyTemplateToUsers(t, members.map((u) => ({ id: u.id, name: u.name, email: u.email || "" })));

    // Record work team assignment
    try {
      await createAssignment({
        orgId,
        type: "workteam",
        workteamId: team.id,
        workteamName: team.name,
        templateId: t.id,
        templateName: t.name,
        assignedBy: me?.email || "",
      });
    } catch (err) {
      setStatus(`Team recorded but assignment record failed: ${err.message}`, "error");
    }

    // Refresh
    try { allAssignments = await fetchAssignments(orgId); } catch (_) {}
    renderTemplateList();
    renderAssignedUsers();
    renderAssignedGroups();
    renderAssignedTeams();
    wireGroupDropdown();
    wireTeamDropdown();
  }

  // ── Remove Groups ─────────────────────────────────────
  async function handleRemoveGroups() {
    const t = selectedTemplate;
    if (!t) return;
    const groupIds = [...assignedGroupsChecked];
    const assigned = allAssignments.filter((a) => a.templateId === t.id && a.type === "group");
    const toRemove = assigned.filter((a) => groupIds.includes(a.groupId));
    if (!toRemove.length) return;

    // Fetch members for all selected groups
    const confirmed = await showConfirmModal({
      title: "Remove Groups from Template",
      bodyHTML: `
        <p style="color:#f59e0b;font-weight:600">⚠ This will remove all template properties from members of ${toRemove.length} group${toRemove.length > 1 ? "s" : ""}.</p>
        <p style="margin-top:8px"><strong>Groups:</strong> ${toRemove.map((a) => escapeHtml(a.groupName || a.groupId)).join(", ")}</p>`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!confirmed) return;

    const $progress = $detail.querySelector("#autProgress");
    const $fill = $detail.querySelector("#autProgressFill");
    const $text = $detail.querySelector("#autProgressText");
    const $log  = $detail.querySelector("#autProgressLog");
    $progress.hidden = false;
    $fill.style.width = "0%";
    $text.textContent = "Loading group members…";
    $log.innerHTML = "";
    let errors = 0;

    function logLine(msg, type) {
      const line = document.createElement("div");
      line.className = "cu-log-line" + (type ? ` cu-log-line--${type}` : "");
      line.textContent = msg;
      $log.append(line);
      $log.scrollTop = $log.scrollHeight;
    }

    for (const assignment of toRemove) {
      try {
        const members = await gc.fetchGroupMembers(api, orgId, assignment.groupId);
        $text.textContent = `Removing template from ${members.length} members of "${assignment.groupName}"…`;
        await removeTemplateFromUsers(t, members);
        await deleteAssignmentByGroupTemplate(orgId, assignment.groupId, t.id);
        logLine(`✓ Group "${assignment.groupName}" removed`, "success");
      } catch (err) {
        errors++;
        logLine(`✗ Group "${assignment.groupName}": ${err.message}`, "error");
      }
    }

    $fill.style.width = "100%";
    const summary = errors
      ? `Completed with ${errors} error${errors > 1 ? "s" : ""}.`
      : `Removed ${toRemove.length} group${toRemove.length > 1 ? "s" : ""} from "${t.name}".`;
    $text.textContent = summary;
    logLine(summary, errors ? "error" : "success");
    setStatus(summary, errors ? "error" : "success");

    try { allAssignments = await fetchAssignments(orgId); } catch (_) {}
    renderTemplateList();
    renderAssignedUsers();
    renderAssignedGroups();
    renderAssignedTeams();
    wireGroupDropdown();
    wireTeamDropdown();
  }

  // ── Remove Work Teams ─────────────────────────────────
  async function handleRemoveTeams() {
    const t = selectedTemplate;
    if (!t) return;
    const teamIds = [...assignedTeamsChecked];
    const assigned = allAssignments.filter((a) => a.templateId === t.id && a.type === "workteam");
    const toRemove = assigned.filter((a) => teamIds.includes(a.workteamId));
    if (!toRemove.length) return;

    const confirmed = await showConfirmModal({
      title: "Remove Work Teams from Template",
      bodyHTML: `
        <p style="color:#f59e0b;font-weight:600">⚠ This will remove all template properties from members of ${toRemove.length} work team${toRemove.length > 1 ? "s" : ""}.</p>
        <p style="margin-top:8px"><strong>Work Teams:</strong> ${toRemove.map((a) => escapeHtml(a.workteamName || a.workteamId)).join(", ")}</p>`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!confirmed) return;

    const $progress = $detail.querySelector("#autProgress");
    const $fill = $detail.querySelector("#autProgressFill");
    const $text = $detail.querySelector("#autProgressText");
    const $log  = $detail.querySelector("#autProgressLog");
    $progress.hidden = false;
    $fill.style.width = "0%";
    $text.textContent = "Loading work team members…";
    $log.innerHTML = "";
    let errors = 0;

    function logLine(msg, type) {
      const line = document.createElement("div");
      line.className = "cu-log-line" + (type ? ` cu-log-line--${type}` : "");
      line.textContent = msg;
      $log.append(line);
      $log.scrollTop = $log.scrollHeight;
    }

    for (const assignment of toRemove) {
      try {
        const members = await gc.fetchTeamMembers(api, orgId, assignment.workteamId);
        $text.textContent = `Removing template from ${members.length} members of "${assignment.workteamName}"…`;
        await removeTemplateFromUsers(t, members);
        await deleteAssignmentByWorkteamTemplate(orgId, assignment.workteamId, t.id);
        logLine(`✓ Work Team "${assignment.workteamName}" removed`, "success");
      } catch (err) {
        errors++;
        logLine(`✗ Work Team "${assignment.workteamName}": ${err.message}`, "error");
      }
    }

    $fill.style.width = "100%";
    const summary = errors
      ? `Completed with ${errors} error${errors > 1 ? "s" : ""}.`
      : `Removed ${toRemove.length} work team${toRemove.length > 1 ? "s" : ""} from "${t.name}".`;
    $text.textContent = summary;
    logLine(summary, errors ? "error" : "success");
    setStatus(summary, errors ? "error" : "success");

    try { allAssignments = await fetchAssignments(orgId); } catch (_) {}
    renderTemplateList();
    renderAssignedUsers();
    renderAssignedGroups();
    renderAssignedTeams();
    wireGroupDropdown();
    wireTeamDropdown();
  }

  // ═══════════════════════════════════════════════════════
  // Shared: Apply / Remove template to/from user list
  // ═══════════════════════════════════════════════════════
  async function applyTemplateToUsers(t, users) {
    const $progress = $detail.querySelector("#autProgress");
    const $fill = $detail.querySelector("#autProgressFill");
    const $text = $detail.querySelector("#autProgressText");
    const $log  = $detail.querySelector("#autProgressLog");

    const rolesStep = (t.roles || []).length > 0 ? 1 : 0;
    const skillsStep = (t.skills || []).length > 0 ? 1 : 0;
    const langsStep = (t.languages || []).length > 0 ? 1 : 0;
    const queueSteps = (t.queues || []).length;
    const stepsPerUser = rolesStep + skillsStep + langsStep + queueSteps;
    const totalSteps = users.length * stepsPerUser;
    let currentStep = 0;
    let errors = 0;

    $progress.hidden = false;
    $fill.style.width = "0%";
    $text.textContent = "Starting…";
    $log.innerHTML = "";

    function advance(label) {
      currentStep++;
      const pct = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
      $fill.style.width = `${pct}%`;
      $text.textContent = `${label} (${currentStep}/${totalSteps})`;
    }
    function logLine(msg, type) {
      const line = document.createElement("div");
      line.className = "cu-log-line" + (type ? ` cu-log-line--${type}` : "");
      line.textContent = msg;
      $log.append(line);
      $log.scrollTop = $log.scrollHeight;
    }

    for (const user of users) {
      try {
        if ((t.roles || []).length) {
          advance(`Assigning roles to ${user.name}`);
          const rolePayloads = [];
          for (const r of t.roles) {
            if (r.divisions?.length) {
              for (const d of r.divisions) rolePayloads.push({ roleId: r.roleId, divisionId: d.divisionId });
            } else {
              rolePayloads.push({ roleId: r.roleId });
            }
          }
          await gc.grantUserRoles(api, orgId, user.id, rolePayloads);
        }
        if ((t.skills || []).length) {
          advance(`Adding skills to ${user.name}`);
          await gc.addUserRoutingSkillsBulk(api, orgId, user.id,
            t.skills.map((s) => ({ id: s.skillId, proficiency: s.proficiency || 0 })),
          );
        }
        if ((t.languages || []).length) {
          advance(`Adding languages to ${user.name}`);
          await gc.addUserRoutingLanguagesBulk(api, orgId, user.id,
            t.languages.map((l) => ({ id: l.languageId, proficiency: l.proficiency || 0 })),
          );
        }
        for (const q of t.queues || []) {
          advance(`Adding ${user.name} to queue ${q.queueName}`);
          await gc.addQueueMembers(api, orgId, q.queueId, [{ id: user.id }]);
        }
        logLine(`✓ ${user.name} — template applied`, "success");
      } catch (err) {
        errors++;
        logLine(`✗ ${user.name}: ${err.message}`, "error");
      }
    }

    $fill.style.width = "100%";
    $text.textContent = `${users.length} / ${users.length} users processed`;
    const summary = errors
      ? `Completed with ${errors} error${errors > 1 ? "s" : ""}.`
      : `Successfully applied template to ${users.length} user${users.length > 1 ? "s" : ""}.`;
    logLine(summary, errors ? "error" : "success");
    setStatus(summary, errors ? "error" : "success");
  }

  async function removeTemplateFromUsers(t, members) {
    const uniqueRoleIds = [...new Set((t.roles || []).map((r) => r.roleId))];
    const uniqueSkillIds = [...new Set((t.skills || []).map((s) => s.skillId))];
    const uniqueLangIds = [...new Set((t.languages || []).map((l) => l.languageId))];
    const uniqueQueueIds = [...new Set((t.queues || []).map((q) => q.queueId))];

    for (const member of members) {
      const userName = member.name || member.id;
      try {
        for (const roleId of uniqueRoleIds) {
          try { await gc.deleteUserRole(api, orgId, member.id, roleId); } catch (_) {}
        }
        for (const skillId of uniqueSkillIds) {
          try { await gc.deleteUserSkill(api, orgId, member.id, skillId); } catch (_) {}
        }
        for (const langId of uniqueLangIds) {
          try { await gc.deleteUserLanguage(api, orgId, member.id, langId); } catch (_) {}
        }
        for (const queueId of uniqueQueueIds) {
          try { await gc.removeQueueMember(api, orgId, queueId, member.id); } catch (_) {}
        }
      } catch (_) {}
    }
  }

  // ═══════════════════════════════════════════════════════
  // ADD — Assign selected search users to the template
  // ═══════════════════════════════════════════════════════
  async function handleAdd() {
    const t = selectedTemplate;
    const userIds = [...searchChecked];
    const users = searchResults.filter((u) => userIds.includes(u.id));
    if (!users.length || !t) return;

    // Build confirmation
    const rows = [];
    rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Template</td><td style="padding:3px 0"><strong>${escapeHtml(t.name)}</strong></td></tr>`);
    rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Users</td><td style="padding:3px 0"><strong>${users.length}</strong> — ${users.map((u) => escapeHtml(u.name)).slice(0, 5).join(", ")}${users.length > 5 ? ` + ${users.length - 5} more` : ""}</td></tr>`);
    if ((t.roles || []).length) rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Roles</td><td style="padding:3px 0">${(t.roles || []).map((r) => escapeHtml(r.roleName)).join(", ")}</td></tr>`);
    if ((t.skills || []).length) rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Skills</td><td style="padding:3px 0">${(t.skills || []).map((s) => escapeHtml(s.skillName)).join(", ")}</td></tr>`);
    if ((t.languages || []).length) rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Languages</td><td style="padding:3px 0">${(t.languages || []).map((l) => escapeHtml(l.languageName)).join(", ")}</td></tr>`);
    if ((t.queues || []).length) rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Queues</td><td style="padding:3px 0">${(t.queues || []).map((q) => escapeHtml(q.queueName)).join(", ")}</td></tr>`);

    const confirmed = await showConfirmModal({
      title: "Confirm Assignment",
      bodyHTML: `<table style="width:100%;border-collapse:collapse;font-size:.9rem">${rows.join("")}</table>`,
      confirmLabel: "Assign",
    });
    if (!confirmed) return;

    // Apply template to users
    await applyTemplateToUsers(t, users);

    // Record individual user assignment records
    for (const user of users) {
      try {
        await createAssignment({
          orgId,
          type: "user",
          userId: user.id,
          userName: user.name,
          templateId: t.id,
          templateName: t.name,
          assignedBy: me?.email || "",
        });
      } catch (_) {}
    }

    // Refresh
    try { allAssignments = await fetchAssignments(orgId); } catch (_) {}
    renderTemplateList();
    renderAssignedUsers();
    renderAssignedGroups();
    renderAssignedTeams();
    renderSearchResults();
  }

  // ═══════════════════════════════════════════════════════
  // REMOVE — Remove checked assigned users from template
  // ═══════════════════════════════════════════════════════
  async function handleRemove() {
    const t = selectedTemplate;
    if (!t) return;
    const userIds = [...assignedChecked];
    const assigned = allAssignments.filter((a) => a.templateId === t.id && (!a.type || a.type === "user"));
    const toRemove = assigned.filter((a) => userIds.includes(a.userId));
    if (!toRemove.length) return;

    const userNames = toRemove.map((a) => a.userName || a.userId);

    // Build confirmation
    const rows = [];
    rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Template</td><td style="padding:3px 0"><strong>${escapeHtml(t.name)}</strong></td></tr>`);
    rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Users</td><td style="padding:3px 0"><strong>${toRemove.length}</strong> — ${userNames.slice(0, 5).map((n) => escapeHtml(n)).join(", ")}${userNames.length > 5 ? ` + ${userNames.length - 5} more` : ""}</td></tr>`);
    if ((t.roles || []).length) rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Roles to remove</td><td style="padding:3px 0">${(t.roles || []).map((r) => escapeHtml(r.roleName)).join(", ")}</td></tr>`);
    if ((t.skills || []).length) rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Skills to remove</td><td style="padding:3px 0">${(t.skills || []).map((s) => escapeHtml(s.skillName)).join(", ")}</td></tr>`);
    if ((t.languages || []).length) rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Languages to remove</td><td style="padding:3px 0">${(t.languages || []).map((l) => escapeHtml(l.languageName)).join(", ")}</td></tr>`);
    if ((t.queues || []).length) rows.push(`<tr><td style="padding:3px 10px 3px 0;color:var(--muted)">Queues to remove</td><td style="padding:3px 0">${(t.queues || []).map((q) => escapeHtml(q.queueName)).join(", ")}</td></tr>`);

    const confirmed = await showConfirmModal({
      title: "Confirm Removal",
      bodyHTML: `<p style="color:#f59e0b;font-weight:600">⚠ This will remove all template properties from these users.</p>
        <table style="width:100%;border-collapse:collapse;font-size:.9rem;margin-top:10px">${rows.join("")}</table>`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!confirmed) return;

    // Calculate steps
    const uniqueRoleIds = [...new Set((t.roles || []).map((r) => r.roleId))];
    const uniqueSkillIds = [...new Set((t.skills || []).map((s) => s.skillId))];
    const uniqueLangIds = [...new Set((t.languages || []).map((l) => l.languageId))];
    const uniqueQueueIds = [...new Set((t.queues || []).map((q) => q.queueId))];
    const stepsPerUser = uniqueRoleIds.length + uniqueSkillIds.length + uniqueLangIds.length + uniqueQueueIds.length + 1; // +1 for assignment record
    const totalSteps = toRemove.length * stepsPerUser;
    let currentStep = 0;
    let errors = 0;

    const $progress = $detail.querySelector("#autProgress");
    const $fill = $detail.querySelector("#autProgressFill");
    const $text = $detail.querySelector("#autProgressText");
    const $log  = $detail.querySelector("#autProgressLog");
    $progress.hidden = false;
    $fill.style.width = "0%";
    $text.textContent = "Starting…";
    $log.innerHTML = "";

    function advance(label) {
      currentStep++;
      const pct = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
      $fill.style.width = `${pct}%`;
      $text.textContent = `${label} (${currentStep}/${totalSteps})`;
    }
    function logLine(msg, type) {
      const line = document.createElement("div");
      line.className = "cu-log-line" + (type ? ` cu-log-line--${type}` : "");
      line.textContent = msg;
      $log.append(line);
      $log.scrollTop = $log.scrollHeight;
    }

    for (const assignment of toRemove) {
      const userName = assignment.userName || assignment.userId;
      try {
        // Remove roles
        for (const roleId of uniqueRoleIds) {
          const roleName = (t.roles || []).find((r) => r.roleId === roleId)?.roleName || roleId;
          advance(`Removing role ${roleName} from ${userName}`);
          try { await gc.deleteUserRole(api, orgId, assignment.userId, roleId); } catch (_) {}
        }

        // Remove skills
        for (const skillId of uniqueSkillIds) {
          const skillName = (t.skills || []).find((s) => s.skillId === skillId)?.skillName || skillId;
          advance(`Removing skill ${skillName} from ${userName}`);
          try { await gc.deleteUserSkill(api, orgId, assignment.userId, skillId); } catch (_) {}
        }

        // Remove languages
        for (const langId of uniqueLangIds) {
          const langName = (t.languages || []).find((l) => l.languageId === langId)?.languageName || langId;
          advance(`Removing language ${langName} from ${userName}`);
          try { await gc.deleteUserLanguage(api, orgId, assignment.userId, langId); } catch (_) {}
        }

        // Remove from queues
        for (const queueId of uniqueQueueIds) {
          const queueName = (t.queues || []).find((q) => q.queueId === queueId)?.queueName || queueId;
          advance(`Removing ${userName} from queue ${queueName}`);
          try { await gc.removeQueueMember(api, orgId, queueId, assignment.userId); } catch (_) {}
        }

        // Remove assignment record
        advance(`Removing assignment record for ${userName}`);
        await deleteAssignmentByUserTemplate(orgId, assignment.userId, t.id);

        logLine(`✓ ${userName} — removed from ${t.name}`, "success");
      } catch (err) {
        errors++;
        logLine(`✗ ${userName}: ${err.message}`, "error");
      }
    }

    $fill.style.width = "100%";
    $text.textContent = `${toRemove.length} / ${toRemove.length} users processed`;
    const summary = errors
      ? `Completed with ${errors} error${errors > 1 ? "s" : ""}.`
      : `Successfully removed ${toRemove.length} user${toRemove.length > 1 ? "s" : ""} from "${t.name}".`;
    logLine(summary, errors ? "error" : "success");
    setStatus(summary, errors ? "error" : "success");

    // Refresh
    try { allAssignments = await fetchAssignments(orgId); } catch (_) {}
    renderTemplateList();
    renderAssignedUsers();
    renderAssignedGroups();
    renderAssignedTeams();
    renderSearchResults();
  }

  return el;
}
