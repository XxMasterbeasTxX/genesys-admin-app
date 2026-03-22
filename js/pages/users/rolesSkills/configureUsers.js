/**
 * Users › Roles, Queues & Skills › Configure Users
 *
 * Select users (by search, group, role, reports-to, location, or division)
 * and assign roles (with divisions), skills (with proficiency),
 * language skills (with proficiency), and queues — either individually
 * or by selecting one or more templates.
 *
 * Genesys endpoints (via proxy):
 *   GET  /api/v2/users                           — paginated user list
 *   POST /api/v2/users/search                    — user search
 *   GET  /api/v2/groups                          — list groups
 *   GET  /api/v2/groups/{id}/members             — group members
 *   GET  /api/v2/authorization/roles             — list roles
 *   GET  /api/v2/authorization/roles/{id}/users  — role members
 *   GET  /api/v2/users/{id}/directreports        — direct reports
 *   GET  /api/v2/locations                        — list locations
 *   GET  /api/v2/authorization/divisions          — list divisions
 *   GET  /api/v2/routing/skills                   — list skills
 *   GET  /api/v2/routing/languages                — list languages
 *   GET  /api/v2/routing/queues                   — list queues
 *
 *   POST  /api/v2/authorization/roles/{roleId}               — grant role
 *   PATCH /api/v2/users/{userId}/routingskills/bulk           — assign skills
 *   PATCH /api/v2/users/{userId}/routinglanguages/bulk        — assign languages
 *   POST  /api/v2/routing/queues/{queueId}/members            — add queue members
 *
 * Internal API:
 *   GET /api/templates?orgId=…  — fetch templates
 */
import { escapeHtml } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import { createSingleSelect } from "../../../components/multiSelect.js";
import { fetchTemplates } from "../../../services/templateService.js";

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
      Select users and assign roles (with division access), skills, language skills, and queue
      memberships — individually or by applying templates.
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
        <div id="cuUserPicker" class="cu-user-picker"></div>
        <div class="cu-user-summary" id="cuUserSummary"></div>
      </div>
      <div class="cu-panel cu-panel--right" id="cuRight">
        <div class="cu-apply-bar" id="cuApplyBar">
          <button class="btn cu-btn-apply" id="cuBtnApply" disabled>Apply to Selected Users</button>
        </div>
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
    <div class="cu-progress" id="cuProgress" hidden>
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

  // ── State ─────────────────────────────────────────────
  let allSkills = [];
  let allLanguages = [];
  let allQueues = [];
  let allRoles = [];
  let allDivisions = [];
  let allGroups = [];
  let allLocations = [];
  let templates = [];

  let selectedUsers = [];      // [{ id, name, email }]

  // Configuration state (manual items)
  let selectedRoles = [];      // [{ roleId, roleName, divisions: [{ divisionId, divisionName }] }]
  let selectedSkills = [];     // [{ skillId, skillName, proficiency }]
  let selectedLanguages = [];  // [{ languageId, languageName, proficiency }]
  let selectedQueues = [];     // [{ queueId, queueName }]
  let selectedTemplates = [];  // full template objects

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
    const [skills, languages, queues, roles, divisions, groups, locations, tpls] =
      await Promise.all([
        gc.fetchAllPages(api, orgId, "/api/v2/routing/skills"),
        gc.fetchAllPages(api, orgId, "/api/v2/routing/languages"),
        gc.fetchAllPages(api, orgId, "/api/v2/routing/queues"),
        gc.fetchAllPages(api, orgId, "/api/v2/authorization/roles", { query: { sortBy: "name" } }),
        gc.fetchAllPages(api, orgId, "/api/v2/authorization/divisions"),
        gc.fetchAllPages(api, orgId, "/api/v2/groups"),
        gc.fetchAllLocations(api, orgId),
        fetchTemplates(orgId),
      ]);
    allSkills = skills.map((s) => ({ id: s.id, name: s.name }));
    allLanguages = languages.map((l) => ({ id: l.id, name: l.name }));
    allQueues = queues.map((q) => ({ id: q.id, name: q.name }));
    allRoles = roles.map((r) => ({ id: r.id, name: r.name }));
    allDivisions = divisions.map((d) => ({ id: d.id, name: d.name }));
    allGroups = groups.map((g) => ({ id: g.id, name: g.name }));
    allLocations = locations.map((l) => ({ id: l.id, name: l.name }));
    templates = tpls;
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
    // Mode picker
    const modes = [
      { id: "search", label: "Search" },
      { id: "group", label: "By Group" },
      { id: "role", label: "By Role" },
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

    // Start in "search" mode
    switchMode("search");
  }

  let currentMode = "";
  let userMultiSelect = null;

  function switchMode(mode) {
    currentMode = mode;
    const $secondary = el.querySelector("#cuSecondary");
    const $userPicker = el.querySelector("#cuUserPicker");
    $secondary.innerHTML = "";
    $userPicker.innerHTML = "";

    if (mode === "search") {
      buildSearchMode($secondary, $userPicker);
    } else if (mode === "group") {
      buildFilterMode($secondary, $userPicker, "Group", allGroups, loadGroupMembers);
    } else if (mode === "role") {
      buildFilterMode($secondary, $userPicker, "Role", allRoles, loadRoleMembers);
    } else if (mode === "reports-to") {
      buildReportsToMode($secondary, $userPicker);
    } else if (mode === "location") {
      buildFilterMode($secondary, $userPicker, "Location", allLocations, loadLocationUsers);
    } else if (mode === "division") {
      buildFilterMode($secondary, $userPicker, "Division", allDivisions, loadDivisionUsers);
    }
  }

  // ── Search mode ───────────────────────────────────────
  function buildSearchMode($secondary, $userPicker) {
    const searchRow = document.createElement("div");
    searchRow.className = "cu-search-row";
    searchRow.innerHTML = `
      <input type="text" class="input cu-search-input" id="cuSearchInput" placeholder="Search by name…" />
      <button class="btn cu-btn-search" id="cuSearchBtn">Search</button>
    `;
    $secondary.append(searchRow);

    const $input = searchRow.querySelector("#cuSearchInput");
    const $btn = searchRow.querySelector("#cuSearchBtn");

    async function doSearch() {
      const term = $input.value.trim();
      if (!term) return;
      $btn.disabled = true;
      $btn.textContent = "Searching…";
      try {
        const results = await api.proxyGenesys(orgId, "POST", "/api/v2/users/search", {
          body: {
            pageSize: 100,
            pageNumber: 1,
            query: [{ type: "QUERY_STRING", value: term, fields: ["name", "email"] }],
          },
        });
        const users = (results.results || []).map((u) => ({ id: u.id, name: u.name, email: u.email }));
        showUserPicker($userPicker, users);
      } catch (err) {
        setStatus(`Search failed: ${err.message}`, "error");
      } finally {
        $btn.disabled = false;
        $btn.textContent = "Search";
      }
    }

    $btn.addEventListener("click", doSearch);
    $input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  }

  // ── Filter mode (group, role, location, division) ─────
  function buildFilterMode($secondary, $userPicker, label, items, loader) {
    const filterSelect = createSingleSelect({
      placeholder: `Select ${label}…`,
      searchable: true,
      onChange: async (id) => {
        if (!id) { showUserPicker($userPicker, []); return; }
        setStatus(`Loading ${label.toLowerCase()} members…`);
        try {
          const users = await loader(id);
          showUserPicker($userPicker, users);
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
  function buildReportsToMode($secondary, $userPicker) {
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
        showManagerList(managers, $userPicker);
      } catch (err) {
        setStatus(`Search failed: ${err.message}`, "error");
      } finally {
        $btn.disabled = false;
        $btn.textContent = "Search";
      }
    }

    function showManagerList(managers, $userPicker) {
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
            const resp = await api.proxyGenesys(orgId, "GET", `/api/v2/users/${m.id}/directreports`);
            const users = (resp.entities || []).map((u) => ({ id: u.id, name: u.name, email: u.email }));
            showUserPicker($userPicker, users);
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
  async function loadGroupMembers(groupId) {
    const members = await gc.fetchGroupMembers(api, orgId, groupId);
    return members.map((u) => ({ id: u.id, name: u.name, email: u.email }));
  }

  async function loadRoleMembers(roleId) {
    const members = await gc.fetchRoleUsers(api, orgId, roleId);
    return members.map((u) => ({ id: u.id, name: u.name, email: u.email }));
  }

  async function loadLocationUsers(locationId) {
    const allUsers = await gc.fetchAllUsers(api, orgId);
    return allUsers
      .filter((u) => u.locations?.some((l) => l.locationDefinition?.id === locationId))
      .map((u) => ({ id: u.id, name: u.name, email: u.email }));
  }

  async function loadDivisionUsers(divisionId) {
    const allUsers = await gc.fetchAllUsers(api, orgId);
    return allUsers
      .filter((u) => u.division?.id === divisionId)
      .map((u) => ({ id: u.id, name: u.name, email: u.email }));
  }

  // ── User multi-select ─────────────────────────────────
  function showUserPicker($container, users) {
    $container.innerHTML = "";
    if (!users.length) {
      $container.innerHTML = `<p class="muted">No users found.</p>`;
      updateUserSummary();
      return;
    }

    userMultiSelect = createMultiSelect({
      placeholder: `${users.length} users available — select…`,
      searchable: true,
      onChange: (ids) => {
        selectedUsers = users.filter((u) => ids.has(u.id));
        updateUserSummary();
        updateApplyButton();
      },
    });
    userMultiSelect.setItems(users.map((u) => ({ id: u.id, label: `${u.name}${u.email ? ` (${u.email})` : ""}` })));
    // Preserve previously selected users that appear in this list
    const prevIds = new Set(selectedUsers.map((u) => u.id));
    const intersection = new Set(users.filter((u) => prevIds.has(u.id)).map((u) => u.id));
    if (intersection.size) userMultiSelect.setSelected(intersection);
    $container.append(userMultiSelect.el);
    updateUserSummary();
  }

  function updateUserSummary() {
    const $summary = el.querySelector("#cuUserSummary");
    $summary.textContent = selectedUsers.length
      ? `${selectedUsers.length} user${selectedUsers.length > 1 ? "s" : ""} selected`
      : "";
  }

  // ════════════════════════════════════════════════════════
  // RIGHT PANEL — Configuration
  // ════════════════════════════════════════════════════════
  function buildRightPanel() {
    // ── Collapsible toggles ─────────────────────────────
    initToggle("cuToggleTemplates", "cuSectionTemplates");
    initToggle("cuToggleRoles", "cuSectionRoles");
    initToggle("cuToggleSkills", "cuSectionSkills");
    initToggle("cuToggleLanguages", "cuSectionLanguages");
    initToggle("cuToggleQueues", "cuSectionQueues");

    // ── Template multi-select ───────────────────────────
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

    // ── Role multi-select ───────────────────────────────
    const roleSelect = createMultiSelect({
      placeholder: "Add roles…",
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

    // ── Skill multi-select ──────────────────────────────
    const skillSelect = createMultiSelect({
      placeholder: "Add skills…",
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

    // ── Language multi-select ───────────────────────────
    const langSelect = createMultiSelect({
      placeholder: "Add language skills…",
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

    // ── Queue multi-select ──────────────────────────────
    const queueSelect = createMultiSelect({
      placeholder: "Add queues…",
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

    // ── Apply button ────────────────────────────────────
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
      $list.innerHTML = `<p class="muted">No roles added yet.</p>`;
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
      $list.innerHTML = `<p class="muted">No skills added yet.</p>`;
      return;
    }

    $list.innerHTML = `
      <table class="data-table cu-detail-table">
        <thead><tr><th>Skill</th><th>Proficiency</th><th></th></tr></thead>
        <tbody>${selectedSkills.map((s, i) => `
          <tr>
            <td>${escapeHtml(s.skillName)}</td>
            <td class="cu-proficiency-cell">
              ${[1, 2, 3, 4, 5].map((p) =>
                `<label class="cu-radio-label">
                  <input type="radio" name="cuProf_${i}" value="${p}" ${p === s.proficiency ? "checked" : ""} />
                  ${p}
                </label>`).join("")}
            </td>
            <td><button class="btn btn-sm cu-btn-remove" data-idx="${i}" data-type="skill">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>`;

    $list.querySelectorAll('input[type="radio"]').forEach((radio) =>
      radio.addEventListener("change", (e) => {
        const idx = parseInt(e.target.name.split("_")[1], 10);
        selectedSkills[idx].proficiency = parseInt(e.target.value, 10);
      }),
    );
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
      $list.innerHTML = `<p class="muted">No language skills added yet.</p>`;
      return;
    }

    $list.innerHTML = `
      <table class="data-table cu-detail-table">
        <thead><tr><th>Language</th><th>Proficiency</th><th></th></tr></thead>
        <tbody>${selectedLanguages.map((l, i) => `
          <tr>
            <td>${escapeHtml(l.languageName)}</td>
            <td class="cu-proficiency-cell">
              ${[1, 2, 3, 4, 5].map((p) =>
                `<label class="cu-radio-label">
                  <input type="radio" name="cuLang_${i}" value="${p}" ${p === l.proficiency ? "checked" : ""} />
                  ${p}
                </label>`).join("")}
            </td>
            <td><button class="btn btn-sm cu-btn-remove" data-idx="${i}" data-type="language">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>`;

    $list.querySelectorAll('input[type="radio"]').forEach((radio) =>
      radio.addEventListener("change", (e) => {
        const idx = parseInt(e.target.name.split("_")[1], 10);
        selectedLanguages[idx].proficiency = parseInt(e.target.value, 10);
      }),
    );
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
      $list.innerHTML = `<p class="muted">No queues added yet.</p>`;
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
    const hasUsers = selectedUsers.length > 0;
    const hasConfig = selectedTemplates.length > 0 ||
      selectedRoles.length > 0 ||
      selectedSkills.length > 0 ||
      selectedLanguages.length > 0 ||
      selectedQueues.length > 0;
    $btnApply.disabled = !(hasUsers && hasConfig);
  }

  // ════════════════════════════════════════════════════════
  // APPLY — execute the assignments
  // ════════════════════════════════════════════════════════
  async function handleApply() {
    // Merge template items + manual items into final assignment sets
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

    const totalUsers = selectedUsers.length;
    const totalOps = totalUsers; // one "unit" per user
    let completed = 0;
    let errors = 0;

    if (!confirm(`Apply configuration to ${totalUsers} user${totalUsers > 1 ? "s" : ""}?`)) return;

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

    function updateProgress() {
      completed++;
      const pct = Math.round((completed / totalOps) * 100);
      $progressFill.style.width = `${pct}%`;
      $progressText.textContent = `${completed} / ${totalOps} users processed`;
    }

    for (const user of selectedUsers) {
      try {
        // Roles — one call per role
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

        // Queues — add user to each queue
        for (const queueId of finalQueueIds) {
          await gc.addQueueMembers(api, orgId, queueId, [{ id: user.id }]);
        }

        logLine(`✓ ${user.name}`, "success");
      } catch (err) {
        errors++;
        logLine(`✗ ${user.name}: ${err.message}`, "error");
      }
      updateProgress();
    }

    const summary = errors
      ? `Completed with ${errors} error${errors > 1 ? "s" : ""}. ${completed - errors}/${totalUsers} users configured.`
      : `Successfully configured ${totalUsers} user${totalUsers > 1 ? "s" : ""}.`;
    setStatus(summary, errors ? "error" : "success");
    $btnApply.disabled = false;
  }

  return el;
}
