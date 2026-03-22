/**
 * Users › Roles, Queues & Skills › Configure Users
 *
 * Two-panel layout:
 *   Left:  Find users by search/group/role/reports-to/location/division.
 *          Results shown as expandable rows with checkboxes showing
 *          template tags, role/skill/language/queue counts.
 *   Right: Add/Remove mode toggle. Apply button at top.
 *          5 collapsible sections: Templates, Roles, Skills, Languages, Queues.
 *          In Add mode — adds items. In Remove mode — removes items.
 *          Removing a template cascade-removes all its properties with confirmation.
 */
import { escapeHtml } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import { createSingleSelect } from "../../../components/multiSelect.js";
import { fetchTemplates } from "../../../services/templateService.js";
import {
  fetchAssignments,
  createAssignment,
  deleteAssignmentByUserTemplate,
} from "../../../services/templateAssignmentService.js";

export default function renderConfigureUsers({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Configure Users</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  const orgId = org.id;

  el.innerHTML = `
    <h1 class="h1">Configure Users</h1>
    <hr class="hr">
    <p class="page-desc">
      Select users and assign or remove roles (with division access), skills, language skills,
      and queue memberships — individually or by applying templates.
    </p>
    <div class="cu-status" id="cuStatus"></div>
    <div class="cu-layout">
      <div class="cu-panel cu-panel--left" id="cuLeft">
        <h2 class="cu-panel-title">Select Users</h2>
        <div class="cu-mode-row">
          <label class="cu-label">Find users by</label>
          <div id="cuModePicker"></div>
        </div>
        <div id="cuSecondary" class="cu-secondary"></div>
      </div>
      <div class="cu-panel cu-panel--right" id="cuRight">
        <div class="cu-apply-bar" id="cuApplyBar">
          <button type="button" class="cu-mode-toggle" id="cuModeToggle">
            <span class="cu-mode-label cu-mode-label--add cu-mode-label--active">Add</span>
            <span class="cu-mode-label cu-mode-label--remove">Remove</span>
          </button>
          <button class="btn cu-btn-apply" id="cuBtnApply" disabled>Apply to Selected Users</button>
        </div>
        <div class="cu-sections-row">
          <div class="cu-section">
            <h3 class="cu-section-title cu-collapsible" id="cuToggleTemplates"><span class="cu-chevron">▸</span> Templates</h3>
            <div class="cu-section-body" id="cuSectionTemplates" hidden>
              <div class="cu-picker" id="cuTemplatePicker"></div>
              <div class="cu-template-list" id="cuTemplateList"></div>
            </div>
          </div>
          <div class="cu-section">
            <h3 class="cu-section-title cu-collapsible" id="cuToggleRoles"><span class="cu-chevron">▸</span> Roles</h3>
            <div class="cu-section-body" id="cuSectionRoles" hidden>
              <div class="cu-picker" id="cuRolePicker"></div>
              <div class="cu-role-list" id="cuRoleList"></div>
            </div>
          </div>
          <div class="cu-section">
            <h3 class="cu-section-title cu-collapsible" id="cuToggleSkills"><span class="cu-chevron">▸</span> Skills</h3>
            <div class="cu-section-body" id="cuSectionSkills" hidden>
              <div class="cu-picker" id="cuSkillPicker"></div>
              <div class="cu-skill-list" id="cuSkillList"></div>
            </div>
          </div>
          <div class="cu-section">
            <h3 class="cu-section-title cu-collapsible" id="cuToggleLanguages"><span class="cu-chevron">▸</span> Language Skills</h3>
            <div class="cu-section-body" id="cuSectionLanguages" hidden>
              <div class="cu-picker" id="cuLanguagePicker"></div>
              <div class="cu-language-list" id="cuLanguageList"></div>
            </div>
          </div>
          <div class="cu-section">
            <h3 class="cu-section-title cu-collapsible" id="cuToggleQueues"><span class="cu-chevron">▸</span> Queues</h3>
            <div class="cu-section-body" id="cuSectionQueues" hidden>
              <div class="cu-picker" id="cuQueuePicker"></div>
              <div class="cu-queue-list" id="cuQueueList"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="cu-user-section">
      <div class="cu-user-summary" id="cuUserSummary"></div>
      <div id="cuUserList" class="cu-user-list"></div>
      <div class="cu-pagination" id="cuPagination"></div>
    </div>
    <div class="cu-progress" id="cuProgress" hidden>>
      <div class="cu-progress-bar"><div class="cu-progress-fill" id="cuProgressFill"></div></div>
      <p class="cu-progress-text" id="cuProgressText"></p>
      <div class="cu-progress-log" id="cuProgressLog"></div>
    </div>
  `;

  const $status = el.querySelector("#cuStatus");
  const $progress = el.querySelector("#cuProgress");
  const $progressFill = el.querySelector("#cuProgressFill");
  const $progressText = el.querySelector("#cuProgressText");
  const $progressLog = el.querySelector("#cuProgressLog");
  const $btnApply = el.querySelector("#cuBtnApply");
  const $userList = el.querySelector("#cuUserList");

  // ── State ─────────────────────────────────────────────
  let allSkills = [];
  let allLanguages = [];
  let allQueues = [];
  let allRoles = [];
  let allDivisions = [];
  let allGroups = [];
  let allLocations = [];
  let templates = [];
  let allAssignments = []; // template assignment records from Azure Table

  let displayedUsers = [];      // users shown in the row list
  let checkedUserIds = new Set(); // user IDs that have their checkbox checked
  let expandedUserId = null;    // which user row is expanded (null = none)
  let userDetails = {};         // userId → { skills, languages, queues, grants, loaded }

  // Mode
  let mode = "add"; // "add" | "remove"

  // Configuration state (manual items picked in right panel)
  let selectedRoles = [];
  let selectedSkills = [];
  let selectedLanguages = [];
  let selectedQueues = [];
  let selectedTemplates = [];

  // ── Confirm modal (replaces browser confirm) ──────────
  function showConfirmModal({ title, bodyHTML, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center";
      const confirmClass = danger ? "btn btn--danger" : "btn";
      overlay.innerHTML = `
        <div style="background:var(--bg-card,#1e293b);border:1px solid var(--border,#334);border-radius:8px;padding:24px;min-width:340px;max-width:640px;width:90%">
          <h3 style="margin:0 0 16px;font-size:1.1rem">${escapeHtml(title)}</h3>
          <div style="font-size:.9rem;line-height:1.6">${bodyHTML}</div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
            <button id="cuModalCancel" class="btn btn--secondary">${escapeHtml(cancelLabel)}</button>
            <button id="cuModalConfirm" class="${confirmClass}">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector("#cuModalCancel").addEventListener("click", () => { document.body.removeChild(overlay); resolve(false); });
      overlay.querySelector("#cuModalConfirm").addEventListener("click", () => { document.body.removeChild(overlay); resolve(true); });
    });
  }

  // ── Mode toggle ───────────────────────────────────────
  const $toggle = el.querySelector("#cuModeToggle");
  $toggle.addEventListener("click", () => {
    mode = mode === "add" ? "remove" : "add";
    $toggle.querySelector(".cu-mode-label--add").classList.toggle("cu-mode-label--active", mode === "add");
    $toggle.querySelector(".cu-mode-label--remove").classList.toggle("cu-mode-label--active", mode === "remove");
    $btnApply.textContent = mode === "add" ? "Apply to Selected Users" : "Remove from Selected Users";
    $btnApply.className = mode === "add"
      ? "btn cu-btn-apply"
      : "btn cu-btn-apply cu-btn-apply--remove";
    updateApplyButton();
  });

  // ── Status helper ─────────────────────────────────────
  function setStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "cu-status" + (type ? ` cu-status--${type}` : "");
  }

  // ── Genesys data loading ──────────────────────────────
  let genesysDataLoaded = false;
  async function ensureGenesysData() {
    if (genesysDataLoaded) return;
    setStatus("Loading data from Genesys…");
    const [skills, languages, queues, roles, divisions, groups, locations, tpls, assigns] =
      await Promise.all([
        gc.fetchAllPages(api, orgId, "/api/v2/routing/skills"),
        gc.fetchAllPages(api, orgId, "/api/v2/routing/languages"),
        gc.fetchAllPages(api, orgId, "/api/v2/routing/queues"),
        gc.fetchAllPages(api, orgId, "/api/v2/authorization/roles", { query: { sortBy: "name" } }),
        gc.fetchAllPages(api, orgId, "/api/v2/authorization/divisions"),
        gc.fetchAllPages(api, orgId, "/api/v2/groups"),
        gc.fetchAllLocations(api, orgId),
        fetchTemplates(orgId),
        fetchAssignments(orgId),
      ]);
    allSkills = skills.map((s) => ({ id: s.id, name: s.name }));
    allLanguages = languages.map((l) => ({ id: l.id, name: l.name }));
    allQueues = queues.map((q) => ({ id: q.id, name: q.name }));
    allRoles = roles.map((r) => ({ id: r.id, name: r.name }));
    allDivisions = divisions.map((d) => ({ id: d.id, name: d.name }));
    allGroups = groups.map((g) => ({ id: g.id, name: g.name }));
    allLocations = locations.map((l) => ({ id: l.id, name: l.name }));
    templates = tpls;
    allAssignments = assigns;
    genesysDataLoaded = true;
    setStatus("");
  }

  // ── Initialise ────────────────────────────────────────
  init();
  async function init() {
    try {
      await ensureGenesysData();
    } catch (err) {
      setStatus(`Failed to load Genesys data: ${err.message}`, "error");
      return;
    }
    buildLeftPanel();
    buildRightPanel();
  }

  // ════════════════════════════════════════════════════════
  // LEFT PANEL — User selection
  // ════════════════════════════════════════════════════════
  function buildLeftPanel() {
    const modes = [
      { id: "search", label: "Search" },
      { id: "group", label: "By Group" },
      { id: "role", label: "By Role" },
      { id: "template", label: "By Template" },
      { id: "reports-to", label: "Reports To" },
      { id: "location", label: "Location" },
      { id: "division", label: "By Division" },
    ];
    const modeSelect = createSingleSelect({
      placeholder: "Search",
      searchable: false,
      onChange: (id) => switchMode(id || "search"),
    });
    modeSelect.setItems(modes);
    el.querySelector("#cuModePicker").append(modeSelect.el);
    switchMode("search");
  }

  let currentMode = "";

  function switchMode(mode) {
    currentMode = mode;
    const $secondary = el.querySelector("#cuSecondary");
    $secondary.innerHTML = "";

    if (mode === "search") {
      buildSearchMode($secondary);
    } else if (mode === "group") {
      buildFilterMode($secondary, "Group", allGroups, loadGroupMembers);
    } else if (mode === "role") {
      buildFilterMode($secondary, "Role", allRoles, loadRoleMembers);
    } else if (mode === "template") {
      buildFilterMode($secondary, "Template",
        templates.map((t) => ({ id: t.id, name: t.name })),
        loadTemplateUsers);
    } else if (mode === "reports-to") {
      buildReportsToMode($secondary);
    } else if (mode === "location") {
      buildFilterMode($secondary, "Location", allLocations, loadLocationUsers);
    } else if (mode === "division") {
      buildFilterMode($secondary, "Division", allDivisions, loadDivisionUsers);
    }
  }

  // ── Search mode ───────────────────────────────────────
  function buildSearchMode($secondary) {
    const searchRow = document.createElement("div");
    searchRow.className = "cu-search-row";
    searchRow.innerHTML = `
      <input type="text" class="input cu-search-input" id="cuSearchInput" placeholder="Search by name… (empty = all users)" />
      <button class="btn cu-btn-search" id="cuSearchBtn">Search</button>
    `;
    $secondary.append(searchRow);

    const $input = searchRow.querySelector("#cuSearchInput");
    const $btn = searchRow.querySelector("#cuSearchBtn");

    let lastSearchTerm = "";
    let totalPages = 1;
    let currentPage = 1;

    async function doSearch(page = 1) {
      const term = $input.value.trim();
      lastSearchTerm = term;
      currentPage = page;
      $btn.disabled = true;
      $btn.textContent = "Searching…";
      try {
        let users, total;
        if (term) {
          const results = await api.proxyGenesys(orgId, "POST", "/api/v2/users/search", {
            body: {
              pageSize: 100,
              pageNumber: page,
              query: [{ type: "QUERY_STRING", value: term, fields: ["name", "email"] }],
              expand: ["skills", "languages"],
            },
          });
          users = (results.results || []).map((u) => mapUser(u));
          total = results.total || users.length;
        } else {
          const results = await api.proxyGenesys(orgId, "GET", "/api/v2/users", {
            query: { pageSize: "100", pageNumber: String(page), expand: "skills,languages", sortOrder: "ASC" },
          });
          users = (results.entities || []).map((u) => mapUser(u));
          total = results.total || users.length;
        }
        totalPages = Math.max(1, Math.ceil(total / 100));
        setUserList(users);
        renderPagination(currentPage, totalPages, doSearch);
      } catch (err) {
        setStatus(`Search failed: ${err.message}`, "error");
      } finally {
        $btn.disabled = false;
        $btn.textContent = "Search";
      }
    }

    $btn.addEventListener("click", () => doSearch(1));
    $input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(1); });
  }

  function renderPagination(current, total, goToPage) {
    const $pag = el.querySelector("#cuPagination");
    $pag.innerHTML = "";
    if (total <= 1) return;

    const frag = document.createDocumentFragment();

    const addBtn = (label, page, disabled, active) => {
      const btn = document.createElement("button");
      btn.className = "btn btn-sm cu-page-btn" + (active ? " cu-page-btn--active" : "");
      btn.textContent = label;
      btn.disabled = disabled;
      if (!disabled && !active) btn.addEventListener("click", () => goToPage(page));
      frag.append(btn);
    };

    addBtn("«", 1, current === 1, false);
    addBtn("‹", current - 1, current === 1, false);

    // Show up to 7 page numbers around current
    let start = Math.max(1, current - 3);
    let end = Math.min(total, start + 6);
    if (end - start < 6) start = Math.max(1, end - 6);

    for (let p = start; p <= end; p++) {
      addBtn(String(p), p, false, p === current);
    }

    addBtn("›", current + 1, current === total, false);
    addBtn("»", total, current === total, false);

    $pag.append(frag);
  }

  // ── Filter mode (group, role, location, division) ─────
  function buildFilterMode($secondary, label, items, loader) {
    const filterSelect = createSingleSelect({
      placeholder: `Select ${label}…`,
      searchable: true,
      onChange: async (id) => {
        if (!id) { setUserList([]); return; }
        setStatus(`Loading ${label.toLowerCase()} members…`);
        try {
          const users = await loader(id);
          setUserList(users);
          setStatus("");
        } catch (err) {
          setStatus(`Failed to load members: ${err.message}`, "error");
        }
      },
    });
    filterSelect.setItems(items.map((i) => ({ id: i.id, label: i.name })));
    const row = document.createElement("div");
    row.className = "cu-filter-row";
    row.append(filterSelect.el);
    $secondary.append(row);
  }

  // ── Reports To mode ───────────────────────────────────
  function buildReportsToMode($secondary) {
    const searchRow = document.createElement("div");
    searchRow.className = "cu-search-row";
    searchRow.innerHTML = `
      <input type="text" class="input cu-search-input" id="cuReportsInput" placeholder="Search manager by name…" />
      <button class="btn cu-btn-search" id="cuReportsBtn">Search</button>
    `;
    $secondary.append(searchRow);

    let managerListEl = null;
    const $input = searchRow.querySelector("#cuReportsInput");
    const $btn = searchRow.querySelector("#cuReportsBtn");

    async function doSearch() {
      const term = $input.value.trim();
      if (!term) return;
      $btn.disabled = true;
      $btn.textContent = "Searching…";
      try {
        const results = await api.proxyGenesys(orgId, "POST", "/api/v2/users/search", {
          body: {
            pageSize: 25,
            pageNumber: 1,
            query: [{ type: "QUERY_STRING", value: term, fields: ["name"] }],
          },
        });
        const managers = (results.results || []).map((u) => ({ id: u.id, name: u.name }));
        showManagerList(managers);
      } catch (err) {
        setStatus(`Search failed: ${err.message}`, "error");
      } finally {
        $btn.disabled = false;
        $btn.textContent = "Search";
      }
    }

    function showManagerList(managers) {
      if (managerListEl) managerListEl.remove();
      if (!managers.length) { setStatus("No managers found.", "error"); return; }

      managerListEl = document.createElement("div");
      managerListEl.className = "cu-manager-list";
      managers.forEach((m) => {
        const btn = document.createElement("button");
        btn.className = "btn btn-sm cu-manager-btn";
        btn.textContent = m.name;
        btn.addEventListener("click", async () => {
          setStatus("Loading direct reports…");
          try {
            const resp = await api.proxyGenesys(orgId, "GET", `/api/v2/users/${m.id}/directreports`, {
              query: { expand: "skills,languages" },
            });
            const users = (resp.entities || []).map((u) => mapUser(u));
            setUserList(users);
            setStatus("");
          } catch (err) {
            setStatus(`Failed to load reports: ${err.message}`, "error");
          }
        });
        managerListEl.append(btn);
      });
      $secondary.append(managerListEl);
    }

    $btn.addEventListener("click", doSearch);
    $input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  }

  // ── User loader helpers ───────────────────────────────
  function mapUser(u) {
    return {
      id: u.id,
      name: u.name,
      email: u.email || "",
      skills: (u.skills || []).map((s) => ({
        skillId: s.id, skillName: s.name, proficiency: s.proficiency || 0,
      })),
      languages: (u.languages || []).map((l) => ({
        languageId: l.id, languageName: l.name, proficiency: l.proficiency || 0,
      })),
    };
  }

  async function loadGroupMembers(groupId) {
    const members = await gc.fetchGroupMembers(api, orgId, groupId);
    return members.map((u) => mapUser(u));
  }

  async function loadRoleMembers(roleId) {
    const members = await gc.fetchRoleUsers(api, orgId, roleId);
    return members.map((u) => mapUser(u));
  }

  async function loadLocationUsers(locationId) {
    const allUsers = await gc.fetchAllUsers(api, orgId, { expand: ["skills", "languages"] });
    return allUsers
      .filter((u) => u.locations?.some((l) => l.locationDefinition?.id === locationId))
      .map((u) => mapUser(u));
  }

  async function loadDivisionUsers(divisionId) {
    const allUsers = await gc.fetchAllUsers(api, orgId, { expand: ["skills", "languages"] });
    return allUsers
      .filter((u) => u.division?.id === divisionId)
      .map((u) => mapUser(u));
  }

  async function loadTemplateUsers(templateId) {
    const userIds = allAssignments
      .filter((a) => a.templateId === templateId)
      .map((a) => a.userId);
    if (!userIds.length) return [];
    const users = [];
    for (const uid of userIds) {
      try {
        const u = await api.proxyGenesys(orgId, "GET", `/api/v2/users/${uid}`, {
          query: { expand: "skills,languages" },
        });
        users.push(mapUser(u));
      } catch { /* user may have been deleted */ }
    }
    return users;
  }

  // ════════════════════════════════════════════════════════
  // USER ROW LIST
  // ════════════════════════════════════════════════════════

  function getTemplatesForUser(userId) {
    return allAssignments
      .filter((a) => a.userId === userId)
      .map((a) => {
        const tpl = templates.find((t) => t.id === a.templateId);
        return { templateId: a.templateId, templateName: a.templateName || tpl?.name || "Unknown" };
      });
  }

  function setUserList(users) {
    displayedUsers = users;
    // Preserve checked users that are still in the new list
    const newIds = new Set(users.map((u) => u.id));
    for (const id of checkedUserIds) {
      if (!newIds.has(id)) checkedUserIds.delete(id);
    }
    expandedUserId = null;
    userDetails = {};
    renderUserList();
    updateUserSummary();
    updateApplyButton();
  }

  function renderUserList() {
    $userList.innerHTML = "";
    if (!displayedUsers.length) {
      $userList.innerHTML = `<p class="muted">No users found.</p>`;
      return;
    }

    // Select-all row
    const selectAll = document.createElement("div");
    selectAll.className = "cu-row cu-row--header";
    const allChecked = displayedUsers.length > 0 && displayedUsers.every((u) => checkedUserIds.has(u.id));
    selectAll.innerHTML = `
      <label class="cu-row-check">
        <input type="checkbox" ${allChecked ? "checked" : ""} id="cuSelectAll" />
      </label>
      <span class="cu-row-name cu-row-name--header">Select All (${displayedUsers.length})</span>
    `;
    selectAll.querySelector("#cuSelectAll").addEventListener("change", (e) => {
      if (e.target.checked) {
        displayedUsers.forEach((u) => checkedUserIds.add(u.id));
      } else {
        displayedUsers.forEach((u) => checkedUserIds.delete(u.id));
      }
      renderUserList();
      updateUserSummary();
      updateApplyButton();
    });
    $userList.append(selectAll);

    // User rows
    for (const user of displayedUsers) {
      const isChecked = checkedUserIds.has(user.id);
      const isExpanded = expandedUserId === user.id;
      const userTemplates = getTemplatesForUser(user.id);

      const row = document.createElement("div");
      row.className = "cu-row" + (isExpanded ? " cu-row--expanded" : "");

      const skillCount = user.skills?.length || 0;
      const langCount = user.languages?.length || 0;
      const tplTags = userTemplates.map((t) =>
        `<span class="cu-tag cu-tag--template">${escapeHtml(t.templateName)}</span>`
      ).join("");

      // For grants and queues, show counts from detail cache if loaded
      const detail = userDetails[user.id];
      const grantCount = detail?.grants?.length ?? "…";
      const queueCount = detail?.queues?.length ?? "…";

      row.innerHTML = `
        <label class="cu-row-check">
          <input type="checkbox" class="cu-user-cb" data-uid="${user.id}" ${isChecked ? "checked" : ""} />
        </label>
        <div class="cu-row-main" data-uid="${user.id}">
          <div class="cu-row-top">
            <span class="cu-row-name">${escapeHtml(user.name)}</span>
            <span class="cu-row-email">${escapeHtml(user.email)}</span>
            <span class="cu-row-tags">${tplTags}</span>
          </div>
          <div class="cu-row-counts">
            <span class="cu-count-badge" title="Roles">${grantCount} roles</span>
            <span class="cu-count-badge" title="Skills">${skillCount} skills</span>
            <span class="cu-count-badge" title="Languages">${langCount} langs</span>
            <span class="cu-count-badge" title="Queues">${queueCount} queues</span>
          </div>
        </div>
        <span class="cu-row-chevron">${isExpanded ? "▾" : "▸"}</span>
      `;

      // Checkbox handler
      row.querySelector(".cu-user-cb").addEventListener("change", (e) => {
        if (e.target.checked) {
          checkedUserIds.add(user.id);
        } else {
          checkedUserIds.delete(user.id);
        }
        updateUserSummary();
        updateApplyButton();
        // Update "select all" checkbox state
        const allCb = $userList.querySelector("#cuSelectAll");
        if (allCb) allCb.checked = displayedUsers.every((u) => checkedUserIds.has(u.id));
      });

      // Click row to expand/collapse
      row.querySelector(".cu-row-main").addEventListener("click", () => toggleExpand(user));
      row.querySelector(".cu-row-chevron").addEventListener("click", () => toggleExpand(user));

      $userList.append(row);

      // Expanded detail panel
      if (isExpanded && detail?.loaded) {
        const detailEl = document.createElement("div");
        detailEl.className = "cu-detail";
        detailEl.innerHTML = buildDetailHTML(user, detail);
        wireDetailRemoveButtons(detailEl, user);
        $userList.append(detailEl);
      } else if (isExpanded && !detail?.loaded) {
        const loadingEl = document.createElement("div");
        loadingEl.className = "cu-detail cu-detail--loading";
        loadingEl.textContent = "Loading details…";
        $userList.append(loadingEl);
      }
    }
  }

  async function toggleExpand(user) {
    if (expandedUserId === user.id) {
      expandedUserId = null;
      renderUserList();
      return;
    }
    expandedUserId = user.id;

    // Lazy-load detail data if not cached
    if (!userDetails[user.id]?.loaded) {
      userDetails[user.id] = { grants: [], queues: [], loaded: false };
      renderUserList(); // show loading
      try {
        const [grants, queues] = await Promise.all([
          gc.getUserGrants(api, orgId, user.id),
          gc.getUserQueues(api, orgId, user.id),
        ]);
        userDetails[user.id] = { grants, queues, loaded: true };
      } catch (err) {
        userDetails[user.id] = { grants: [], queues: [], loaded: true, error: err.message };
      }
    }
    renderUserList();
  }

  function buildDetailHTML(user, detail) {
    const userTemplates = getTemplatesForUser(user.id);

    let html = "";

    // Templates section
    if (userTemplates.length) {
      html += `<div class="cu-detail-section">
        <h4 class="cu-detail-heading">Templates</h4>
        <div class="cu-detail-tags">${userTemplates.map((t) =>
          `<span class="cu-tag cu-tag--template">${escapeHtml(t.templateName)}</span>`
        ).join("")}</div>
      </div>`;
    }

    // Roles – group by roleId, show divisions as tags
    if (detail.grants?.length) {
      const roleMap = new Map();
      for (const g of detail.grants) {
        if (!roleMap.has(g.roleId)) roleMap.set(g.roleId, { roleName: g.roleName, roleId: g.roleId, divs: [] });
        roleMap.get(g.roleId).divs.push(g);
      }
      const uniqueRoles = [...roleMap.values()];
      html += `<div class="cu-detail-section">
        <h4 class="cu-detail-heading">Roles (${uniqueRoles.length})</h4>
        <table class="data-table cu-detail-table"><thead><tr><th>Role</th><th>Divisions</th><th></th></tr></thead><tbody>
        ${uniqueRoles.map((r) => `<tr>
          <td>${escapeHtml(r.roleName)}</td>
          <td class="cu-div-tags">${r.divs.map((d) => `<span class="cu-tag cu-tag--removable cu-tag--div">${escapeHtml(d.divisionName)}<button class="cu-tag-remove" data-action="remove-role-division" data-role-id="${r.roleId}" data-division-id="${d.divisionId}" title="Remove from this division">✕</button></span>`).join("")}</td>
          <td><button class="btn btn-sm cu-btn-inline-remove" data-action="remove-role-all" data-role-id="${r.roleId}" title="Remove role from all divisions">✕</button></td>
        </tr>`).join("")}
        </tbody></table>
      </div>`;
    }

    // Skills
    if (user.skills?.length) {
      html += `<div class="cu-detail-section">
        <h4 class="cu-detail-heading">Skills (${user.skills.length})</h4>
        <table class="data-table cu-detail-table"><thead><tr><th>Skill</th><th>Proficiency</th><th></th></tr></thead><tbody>
        ${user.skills.map((s, i) => `<tr><td>${escapeHtml(s.skillName)}</td><td>${s.proficiency}</td><td><button class="btn btn-sm cu-btn-inline-remove" data-action="remove-skill" data-idx="${i}" title="Remove this skill">✕</button></td></tr>`).join("")}
        </tbody></table>
      </div>`;
    }

    // Languages
    if (user.languages?.length) {
      html += `<div class="cu-detail-section">
        <h4 class="cu-detail-heading">Languages (${user.languages.length})</h4>
        <table class="data-table cu-detail-table"><thead><tr><th>Language</th><th>Proficiency</th><th></th></tr></thead><tbody>
        ${user.languages.map((l, i) => `<tr><td>${escapeHtml(l.languageName)}</td><td>${l.proficiency}</td><td><button class="btn btn-sm cu-btn-inline-remove" data-action="remove-language" data-idx="${i}" title="Remove this language">✕</button></td></tr>`).join("")}
        </tbody></table>
      </div>`;
    }

    // Queues
    if (detail.queues?.length) {
      html += `<div class="cu-detail-section">
        <h4 class="cu-detail-heading">Queues (${detail.queues.length})</h4>
        <div class="cu-detail-tags">${detail.queues.map((q, i) =>
          `<span class="cu-tag cu-tag--removable">${escapeHtml(q.queueName)}<button class="cu-tag-remove" data-action="remove-queue" data-idx="${i}" title="Remove from queue">✕</button></span>`
        ).join("")}</div>
      </div>`;
    }

    if (detail.error) {
      html += `<p class="cu-detail-error">Error loading details: ${escapeHtml(detail.error)}</p>`;
    }

    if (!html) html = `<p class="muted">No assignments found.</p>`;

    return html;
  }

  function wireDetailRemoveButtons(detailEl, user) {
    detailEl.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const idx = parseInt(btn.dataset.idx, 10);
        const detail = userDetails[user.id];

        btn.disabled = true;
        btn.textContent = "…";

        try {
          if (action === "remove-role-division") {
            const roleId = btn.dataset.roleId;
            const divisionId = btn.dataset.divisionId;
            await gc.deleteUserRoleGrant(api, orgId, user.id, roleId, divisionId);
            detail.grants = detail.grants.filter((g) => !(g.roleId === roleId && g.divisionId === divisionId));
          } else if (action === "remove-role-all") {
            const roleId = btn.dataset.roleId;
            const matching = detail.grants.filter((g) => g.roleId === roleId);
            for (const g of matching) {
              await gc.deleteUserRoleGrant(api, orgId, user.id, g.roleId, g.divisionId);
            }
            detail.grants = detail.grants.filter((g) => g.roleId !== roleId);
          } else if (action === "remove-skill") {
            const skill = user.skills[idx];
            if (!skill) return;
            await gc.deleteUserSkill(api, orgId, user.id, skill.skillId);
            user.skills.splice(idx, 1);
          } else if (action === "remove-language") {
            const lang = user.languages[idx];
            if (!lang) return;
            await gc.deleteUserLanguage(api, orgId, user.id, lang.languageId);
            user.languages.splice(idx, 1);
          } else if (action === "remove-queue") {
            const queue = detail.queues[idx];
            if (!queue) return;
            await gc.removeQueueMember(api, orgId, queue.queueId, user.id);
            detail.queues.splice(idx, 1);
          }
          renderUserList();
        } catch (err) {
          btn.textContent = "✕";
          btn.disabled = false;
          setStatus(`Failed to remove: ${err.message}`, "error");
        }
      });
    });
  }

  function updateUserSummary() {
    const $summary = el.querySelector("#cuUserSummary");
    $summary.textContent = checkedUserIds.size
      ? `${checkedUserIds.size} user${checkedUserIds.size > 1 ? "s" : ""} selected`
      : "";
  }

  // ════════════════════════════════════════════════════════
  // RIGHT PANEL — Configuration
  // ════════════════════════════════════════════════════════
  function buildRightPanel() {
    initToggle("cuToggleTemplates", "cuSectionTemplates");
    initToggle("cuToggleRoles", "cuSectionRoles");
    initToggle("cuToggleSkills", "cuSectionSkills");
    initToggle("cuToggleLanguages", "cuSectionLanguages");
    initToggle("cuToggleQueues", "cuSectionQueues");

    // Template multi-select
    const tplSelect = createMultiSelect({
      placeholder: "Select templates…",
      searchable: true,
      onChange: (ids) => {
        selectedTemplates = templates.filter((t) => ids.has(t.id));
        renderTemplateList();
        updateApplyButton();
      },
    });
    tplSelect.setItems(templates.map((t) => ({ id: t.id, label: t.name })));
    el.querySelector("#cuTemplatePicker").append(tplSelect.el);
    renderTemplateList();

    // Role multi-select
    const roleSelect = createMultiSelect({
      placeholder: "Select roles…",
      searchable: true,
      onChange: (ids) => {
        for (const id of ids) {
          if (!selectedRoles.find((r) => r.roleId === id)) {
            const role = allRoles.find((r) => r.id === id);
            if (role) selectedRoles.push({ roleId: id, roleName: role.name, divisions: [] });
          }
        }
        selectedRoles = selectedRoles.filter((r) => ids.has(r.roleId));
        renderRoleList();
        updateApplyButton();
      },
    });
    roleSelect.setItems(allRoles.map((r) => ({ id: r.id, label: r.name })));
    el.querySelector("#cuRolePicker").append(roleSelect.el);

    // Skill multi-select
    const skillSelect = createMultiSelect({
      placeholder: "Select skills…",
      searchable: true,
      onChange: (ids) => {
        for (const id of ids) {
          if (!selectedSkills.find((s) => s.skillId === id)) {
            const skill = allSkills.find((s) => s.id === id);
            if (skill) selectedSkills.push({ skillId: id, skillName: skill.name, proficiency: 3 });
          }
        }
        selectedSkills = selectedSkills.filter((s) => ids.has(s.skillId));
        renderSkillList();
        updateApplyButton();
      },
    });
    skillSelect.setItems(allSkills.map((s) => ({ id: s.id, label: s.name })));
    el.querySelector("#cuSkillPicker").append(skillSelect.el);

    // Language multi-select
    const langSelect = createMultiSelect({
      placeholder: "Select language skills…",
      searchable: true,
      onChange: (ids) => {
        for (const id of ids) {
          if (!selectedLanguages.find((l) => l.languageId === id)) {
            const lang = allLanguages.find((l) => l.id === id);
            if (lang) selectedLanguages.push({ languageId: id, languageName: lang.name, proficiency: 3 });
          }
        }
        selectedLanguages = selectedLanguages.filter((l) => ids.has(l.languageId));
        renderLanguageList();
        updateApplyButton();
      },
    });
    langSelect.setItems(allLanguages.map((l) => ({ id: l.id, label: l.name })));
    el.querySelector("#cuLanguagePicker").append(langSelect.el);

    // Queue multi-select
    const queueSelect = createMultiSelect({
      placeholder: "Select queues…",
      searchable: true,
      onChange: (ids) => {
        for (const id of ids) {
          if (!selectedQueues.find((q) => q.queueId === id)) {
            const queue = allQueues.find((q) => q.id === id);
            if (queue) selectedQueues.push({ queueId: id, queueName: queue.name });
          }
        }
        selectedQueues = selectedQueues.filter((q) => ids.has(q.queueId));
        renderQueueList();
        updateApplyButton();
      },
    });
    queueSelect.setItems(allQueues.map((q) => ({ id: q.id, label: q.name })));
    el.querySelector("#cuQueuePicker").append(queueSelect.el);

    // Initial render
    renderRoleList();
    renderSkillList();
    renderLanguageList();
    renderQueueList();

    // Apply button
    $btnApply.addEventListener("click", handleApply);
  }

  // ── Toggle helper ─────────────────────────────────────
  function initToggle(toggleId, sectionId) {
    const $toggle = el.querySelector(`#${toggleId}`);
    const $section = el.querySelector(`#${sectionId}`);
    $toggle.addEventListener("click", () => {
      const open = !$section.hidden;
      $section.hidden = open;
      $toggle.querySelector(".cu-chevron").textContent = open ? "▸" : "▾";
      $toggle.classList.toggle("cu-collapsible--open", !open);
    });
  }

  // ── Template list ─────────────────────────────────────
  function renderTemplateList() {
    const $list = el.querySelector("#cuTemplateList");
    if (!selectedTemplates.length) {
      $list.innerHTML = `<p class="muted">No templates selected.</p>`;
      return;
    }
    $list.innerHTML = `
      <table class="data-table cu-detail-table">
        <thead><tr><th>Template</th><th>Roles</th><th>Skills</th><th>Languages</th><th>Queues</th></tr></thead>
        <tbody>${selectedTemplates.map((t) => `
          <tr>
            <td>${escapeHtml(t.name)}</td>
            <td class="cu-cell-count">${(t.roles || []).length}</td>
            <td class="cu-cell-count">${(t.skills || []).length}</td>
            <td class="cu-cell-count">${(t.languages || []).length}</td>
            <td class="cu-cell-count">${(t.queues || []).length}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }

  // ── Role list with per-role division picker ───────────
  function renderRoleList() {
    const $list = el.querySelector("#cuRoleList");
    if (!selectedRoles.length) {
      $list.innerHTML = `<p class="muted">No roles selected.</p>`;
      return;
    }

    // In remove mode, divisions are not needed
    if (mode === "remove") {
      $list.innerHTML = `
        <table class="data-table cu-detail-table">
          <thead><tr><th>Role</th><th></th></tr></thead>
          <tbody>${selectedRoles.map((r, i) => `
            <tr>
              <td>${escapeHtml(r.roleName)}</td>
              <td><button class="btn btn-sm cu-btn-remove" data-idx="${i}" data-type="role">✕</button></td>
            </tr>`).join("")}
          </tbody>
        </table>`;
      $list.querySelectorAll('.cu-btn-remove[data-type="role"]').forEach((btn) =>
        btn.addEventListener("click", () => {
          selectedRoles.splice(parseInt(btn.dataset.idx, 10), 1);
          renderRoleList();
          updateApplyButton();
        }),
      );
      return;
    }

    $list.innerHTML = `
      <div class="cu-role-cards">
        ${selectedRoles.map((r, i) => `
          <div class="cu-role-card" data-idx="${i}">
            <div class="cu-role-header">
              <span class="cu-role-name">${escapeHtml(r.roleName)}</span>
              <button class="btn btn-sm cu-btn-remove" data-idx="${i}" data-type="role">✕</button>
            </div>
            <div class="cu-role-divs">
              <label class="cu-label">Divisions</label>
              <div class="cu-div-picker" id="cuDivPicker_${i}"></div>
              <div class="cu-div-tags" id="cuDivTags_${i}">
                ${r.divisions.length
                  ? r.divisions.map((d) => `<span class="cu-div-tag">${escapeHtml(d.divisionName)}</span>`).join("")
                  : `<span class="muted" style="font-size:12px">No divisions selected</span>`}
              </div>
            </div>
          </div>`).join("")}
      </div>`;

    selectedRoles.forEach((r, i) => {
      const divSelect = createMultiSelect({
        placeholder: "Select divisions…",
        searchable: true,
        onChange: (ids) => {
          r.divisions = Array.from(ids).map((id) => {
            const div = allDivisions.find((d) => d.id === id);
            return { divisionId: id, divisionName: div ? div.name : id };
          });
          const $tags = $list.querySelector(`#cuDivTags_${i}`);
          if ($tags) {
            $tags.innerHTML = r.divisions.length
              ? r.divisions.map((d) => `<span class="cu-div-tag">${escapeHtml(d.divisionName)}</span>`).join("")
              : `<span class="muted" style="font-size:12px">No divisions selected</span>`;
          }
        },
      });
      divSelect.setItems(allDivisions.map((d) => ({ id: d.id, label: d.name })));
      divSelect.setSelected(new Set(r.divisions.map((d) => d.divisionId)));
      const $slot = $list.querySelector(`#cuDivPicker_${i}`);
      if ($slot) $slot.append(divSelect.el);
    });

    $list.querySelectorAll('.cu-btn-remove[data-type="role"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        selectedRoles.splice(parseInt(btn.dataset.idx, 10), 1);
        renderRoleList();
        updateApplyButton();
      }),
    );
  }

  // ── Skill list with proficiency radios ────────────────
  function renderSkillList() {
    const $list = el.querySelector("#cuSkillList");
    if (!selectedSkills.length) {
      $list.innerHTML = `<p class="muted">No skills selected.</p>`;
      return;
    }

    const showProf = mode === "add";
    $list.innerHTML = `
      <table class="data-table cu-detail-table">
        <thead><tr><th>Skill</th>${showProf ? "<th>Proficiency</th>" : ""}<th></th></tr></thead>
        <tbody>${selectedSkills.map((s, i) => `
          <tr>
            <td>${escapeHtml(s.skillName)}</td>
            ${showProf ? `<td class="cu-proficiency-cell">
              ${[1, 2, 3, 4, 5].map((p) =>
                `<label class="cu-radio-label">
                  <input type="radio" name="cuProf_${i}" value="${p}" ${p === s.proficiency ? "checked" : ""} />
                  ${p}
                </label>`).join("")}
            </td>` : ""}
            <td><button class="btn btn-sm cu-btn-remove" data-idx="${i}" data-type="skill">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>`;

    if (showProf) {
      $list.querySelectorAll('input[type="radio"]').forEach((radio) =>
        radio.addEventListener("change", (e) => {
          const idx = parseInt(e.target.name.split("_")[1], 10);
          selectedSkills[idx].proficiency = parseInt(e.target.value, 10);
        }),
      );
    }
    $list.querySelectorAll('.cu-btn-remove[data-type="skill"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        selectedSkills.splice(parseInt(btn.dataset.idx, 10), 1);
        renderSkillList();
        updateApplyButton();
      }),
    );
  }

  // ── Language list with proficiency radios ──────────────
  function renderLanguageList() {
    const $list = el.querySelector("#cuLanguageList");
    if (!selectedLanguages.length) {
      $list.innerHTML = `<p class="muted">No language skills selected.</p>`;
      return;
    }

    const showProf = mode === "add";
    $list.innerHTML = `
      <table class="data-table cu-detail-table">
        <thead><tr><th>Language</th>${showProf ? "<th>Proficiency</th>" : ""}<th></th></tr></thead>
        <tbody>${selectedLanguages.map((l, i) => `
          <tr>
            <td>${escapeHtml(l.languageName)}</td>
            ${showProf ? `<td class="cu-proficiency-cell">
              ${[1, 2, 3, 4, 5].map((p) =>
                `<label class="cu-radio-label">
                  <input type="radio" name="cuLang_${i}" value="${p}" ${p === l.proficiency ? "checked" : ""} />
                  ${p}
                </label>`).join("")}
            </td>` : ""}
            <td><button class="btn btn-sm cu-btn-remove" data-idx="${i}" data-type="language">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>`;

    if (showProf) {
      $list.querySelectorAll('input[type="radio"]').forEach((radio) =>
        radio.addEventListener("change", (e) => {
          const idx = parseInt(e.target.name.split("_")[1], 10);
          selectedLanguages[idx].proficiency = parseInt(e.target.value, 10);
        }),
      );
    }
    $list.querySelectorAll('.cu-btn-remove[data-type="language"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        selectedLanguages.splice(parseInt(btn.dataset.idx, 10), 1);
        renderLanguageList();
        updateApplyButton();
      }),
    );
  }

  // ── Queue list ────────────────────────────────────────
  function renderQueueList() {
    const $list = el.querySelector("#cuQueueList");
    if (!selectedQueues.length) {
      $list.innerHTML = `<p class="muted">No queues selected.</p>`;
      return;
    }

    $list.innerHTML = `
      <table class="data-table cu-detail-table">
        <thead><tr><th>Queue</th><th></th></tr></thead>
        <tbody>${selectedQueues.map((q, i) => `
          <tr>
            <td>${escapeHtml(q.queueName)}</td>
            <td><button class="btn btn-sm cu-btn-remove" data-idx="${i}" data-type="queue">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>`;

    $list.querySelectorAll('.cu-btn-remove[data-type="queue"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        selectedQueues.splice(parseInt(btn.dataset.idx, 10), 1);
        renderQueueList();
        updateApplyButton();
      }),
    );
  }

  // ── Apply button state ────────────────────────────────
  function updateApplyButton() {
    const hasUsers = checkedUserIds.size > 0;
    const hasConfig = selectedTemplates.length > 0 ||
      selectedRoles.length > 0 ||
      selectedSkills.length > 0 ||
      selectedLanguages.length > 0 ||
      selectedQueues.length > 0;
    $btnApply.disabled = !(hasUsers && hasConfig);
  }

  // ════════════════════════════════════════════════════════
  // APPLY — execute ADD or REMOVE
  // ════════════════════════════════════════════════════════
  async function handleApply() {
    const selectedUsersArr = displayedUsers.filter((u) => checkedUserIds.has(u.id));

    if (mode === "add") {
      await handleAdd(selectedUsersArr);
    } else {
      await handleRemove(selectedUsersArr);
    }
  }

  // ── ADD ───────────────────────────────────────────────
  async function handleAdd(users) {
    // Merge template items + manual items
    const finalRoles = [...selectedRoles.map((r) => ({ ...r, divisions: [...r.divisions] }))];
    const finalSkills = [...selectedSkills.map((s) => ({ ...s }))];
    const finalLanguages = [...selectedLanguages.map((l) => ({ ...l }))];
    const finalQueueIds = new Set(selectedQueues.map((q) => q.queueId));

    for (const tpl of selectedTemplates) {
      for (const r of tpl.roles || []) {
        if (!finalRoles.find((fr) => fr.roleId === r.roleId)) {
          finalRoles.push({ ...r, divisions: [...(r.divisions || [])] });
        }
      }
      for (const s of tpl.skills || []) {
        if (!finalSkills.find((fs) => fs.skillId === s.skillId)) {
          finalSkills.push({ ...s });
        }
      }
      for (const l of tpl.languages || []) {
        if (!finalLanguages.find((fl) => fl.languageId === l.languageId)) {
          finalLanguages.push({ ...l });
        }
      }
      for (const q of tpl.queues || []) {
        finalQueueIds.add(q.queueId);
      }
    }

    const totalUsers = users.length;
    const confirmed = await showConfirmModal({
      title: "Confirm Add",
      bodyHTML: `<p>Add configuration to <strong>${totalUsers} user${totalUsers > 1 ? "s" : ""}</strong>?</p>`,
      confirmLabel: "Add",
    });
    if (!confirmed) return;

    let completed = 0;
    let errors = 0;

    $btnApply.disabled = true;
    $progress.hidden = false;
    $progressLog.innerHTML = "";

    function logLine(msg, type) {
      const line = document.createElement("div");
      line.className = "cu-log-line" + (type ? ` cu-log-line--${type}` : "");
      line.textContent = msg;
      $progressLog.append(line);
      $progressLog.scrollTop = $progressLog.scrollHeight;
    }

    for (const user of users) {
      try {
        // Roles
        if (finalRoles.length) {
          const rolePayloads = [];
          for (const r of finalRoles) {
            if (r.divisions.length) {
              for (const d of r.divisions) {
                rolePayloads.push({ roleId: r.roleId, divisionId: d.divisionId });
              }
            } else {
              rolePayloads.push({ roleId: r.roleId, divisionId: undefined });
            }
          }
          await gc.grantUserRoles(api, orgId, user.id, rolePayloads);
        }

        // Skills
        if (finalSkills.length) {
          await gc.addUserRoutingSkillsBulk(api, orgId, user.id,
            finalSkills.map((s) => ({ id: s.skillId, proficiency: s.proficiency })),
          );
        }

        // Languages
        if (finalLanguages.length) {
          await gc.addUserRoutingLanguagesBulk(api, orgId, user.id,
            finalLanguages.map((l) => ({ id: l.languageId, proficiency: l.proficiency })),
          );
        }

        // Queues
        for (const queueId of finalQueueIds) {
          await gc.addQueueMembers(api, orgId, queueId, [{ id: user.id }]);
        }

        // Record template assignments
        for (const tpl of selectedTemplates) {
          try {
            await createAssignment({
              orgId,
              userId: user.id,
              userName: user.name,
              templateId: tpl.id,
              templateName: tpl.name,
              assignedBy: me?.email || "",
            });
          } catch (assignErr) {
            logLine(`  ⚠ Template "${tpl.name}" assignment record failed: ${assignErr.message}`, "error");
          }
        }

        logLine(`✓ ${user.name}`, "success");
      } catch (err) {
        errors++;
        logLine(`✗ ${user.name}: ${err.message}`, "error");
      }
      completed++;
      const pct = Math.round((completed / totalUsers) * 100);
      $progressFill.style.width = `${pct}%`;
      $progressText.textContent = `${completed} / ${totalUsers} users processed`;
    }

    const summary = errors
      ? `Completed with ${errors} error${errors > 1 ? "s" : ""}. ${completed - errors}/${totalUsers} users configured.`
      : `Successfully configured ${totalUsers} user${totalUsers > 1 ? "s" : ""}.`;
    setStatus(summary, errors ? "error" : "success");
    $btnApply.disabled = false;

    // Refresh assignments
    try {
      allAssignments = await fetchAssignments(orgId);
    } catch (refreshErr) {
      setStatus(`Warning: could not refresh template assignments: ${refreshErr.message}`, "error");
    }
    userDetails = {};
    renderUserList();
  }

  // ── REMOVE ────────────────────────────────────────────
  async function handleRemove(users) {
    // Build the list of things to remove
    const rolesFromTemplates = [];
    const skillsFromTemplates = [];
    const langsFromTemplates = [];
    const queuesFromTemplates = new Set();

    for (const tpl of selectedTemplates) {
      for (const r of tpl.roles || []) rolesFromTemplates.push(r);
      for (const s of tpl.skills || []) skillsFromTemplates.push(s);
      for (const l of tpl.languages || []) langsFromTemplates.push(l);
      for (const q of tpl.queues || []) queuesFromTemplates.add(q.queueId);
    }

    const allRemoveRoles = [...selectedRoles, ...rolesFromTemplates];
    const allRemoveSkills = [...selectedSkills, ...skillsFromTemplates];
    const allRemoveLangs = [...selectedLanguages, ...langsFromTemplates];
    const allRemoveQueueIds = new Set([
      ...selectedQueues.map((q) => q.queueId),
      ...queuesFromTemplates,
    ]);

    // Deduplicate
    const uniqueRoleIds = [...new Set(allRemoveRoles.map((r) => r.roleId))];
    const uniqueSkillIds = [...new Set(allRemoveSkills.map((s) => s.skillId))];
    const uniqueLangIds = [...new Set(allRemoveLangs.map((l) => l.languageId))];

    // Build confirmation message
    if (selectedTemplates.length) {
      const lines = [];
      lines.push(`Templates: ${selectedTemplates.map((t) => t.name).join(", ")}`);
      if (uniqueRoleIds.length) {
        const names = uniqueRoleIds.map((id) => {
          const r = allRemoveRoles.find((r) => r.roleId === id);
          return r?.roleName || id;
        });
        lines.push(`  → Roles: ${names.join(", ")}`);
      }
      if (uniqueSkillIds.length) {
        const names = uniqueSkillIds.map((id) => {
          const s = allRemoveSkills.find((s) => s.skillId === id);
          return s?.skillName || id;
        });
        lines.push(`  → Skills: ${names.join(", ")}`);
      }
      if (uniqueLangIds.length) {
        const names = uniqueLangIds.map((id) => {
          const l = allRemoveLangs.find((l) => l.languageId === id);
          return l?.languageName || id;
        });
        lines.push(`  → Languages: ${names.join(", ")}`);
      }
      if (allRemoveQueueIds.size) {
        const names = [...allRemoveQueueIds].map((id) => {
          const q = allQueues.find((q) => q.id === id);
          return q?.name || id;
        });
        lines.push(`  → Queues: ${names.join(", ")}`);
      }

      const detailLines = lines.map((l) => escapeHtml(l)).join("<br>");
      const bodyHTML = `<p style="color:#f59e0b;font-weight:600">⚠ Removing templates will also remove all associated properties:</p>
        <div style="margin:10px 0;padding:8px 12px;background:rgba(0,0,0,.15);border-radius:4px;font-size:.85rem;line-height:1.7">${detailLines}</div>
        <p>This will affect <strong>${users.length} user${users.length > 1 ? "s" : ""}</strong>.</p>`;
      const confirmed = await showConfirmModal({ title: "Confirm Remove", bodyHTML, confirmLabel: "Remove", danger: true });
      if (!confirmed) return;
    } else {
      const confirmed = await showConfirmModal({
        title: "Confirm Remove",
        bodyHTML: `<p>Remove selected items from <strong>${users.length} user${users.length > 1 ? "s" : ""}</strong>?</p>`,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!confirmed) return;
    }

    let completed = 0;
    let errors = 0;
    const totalUsers = users.length;

    $btnApply.disabled = true;
    $progress.hidden = false;
    $progressLog.innerHTML = "";

    function logLine(msg, type) {
      const line = document.createElement("div");
      line.className = "cu-log-line" + (type ? ` cu-log-line--${type}` : "");
      line.textContent = msg;
      $progressLog.append(line);
      $progressLog.scrollTop = $progressLog.scrollHeight;
    }

    for (const user of users) {
      try {
        // Remove roles
        for (const roleId of uniqueRoleIds) {
          try {
            await gc.deleteUserRole(api, orgId, user.id, roleId);
          } catch { /* role may not be assigned */ }
        }

        // Remove skills
        for (const skillId of uniqueSkillIds) {
          try {
            await gc.deleteUserSkill(api, orgId, user.id, skillId);
          } catch { /* skill may not be assigned */ }
        }

        // Remove languages
        for (const langId of uniqueLangIds) {
          try {
            await gc.deleteUserLanguage(api, orgId, user.id, langId);
          } catch { /* language may not be assigned */ }
        }

        // Remove from queues
        for (const queueId of allRemoveQueueIds) {
          try {
            await gc.removeQueueMember(api, orgId, queueId, user.id);
          } catch { /* may not be a member */ }
        }

        // Remove template assignment records
        for (const tpl of selectedTemplates) {
          try {
            await deleteAssignmentByUserTemplate(orgId, user.id, tpl.id);
          } catch (delErr) {
            logLine(`  ⚠ Template "${tpl.name}" assignment record removal failed: ${delErr.message}`, "error");
          }
        }

        logLine(`✓ ${user.name}`, "success");
      } catch (err) {
        errors++;
        logLine(`✗ ${user.name}: ${err.message}`, "error");
      }
      completed++;
      const pct = Math.round((completed / totalUsers) * 100);
      $progressFill.style.width = `${pct}%`;
      $progressText.textContent = `${completed} / ${totalUsers} users processed`;
    }

    const summary = errors
      ? `Completed with ${errors} error${errors > 1 ? "s" : ""}. ${completed - errors}/${totalUsers} users updated.`
      : `Successfully removed items from ${totalUsers} user${totalUsers > 1 ? "s" : ""}.`;
    setStatus(summary, errors ? "error" : "success");
    $btnApply.disabled = false;

    // Refresh assignments and user list
    try {
      allAssignments = await fetchAssignments(orgId);
    } catch (refreshErr) {
      setStatus(`Warning: could not refresh template assignments: ${refreshErr.message}`, "error");
    }
    userDetails = {};
    renderUserList();
  }

  return el;
}
