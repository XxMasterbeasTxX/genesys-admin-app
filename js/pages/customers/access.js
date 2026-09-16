/**
 * Customers › Access to Admin Tool — the internal org's own list — and, for
 * a customer Administrator, Administrator › Users.
 *
 * Who, in the selected org, may use this app. For a customer the list IS the
 * contract — they pay per named user, and there is no seat count to keep in
 * step with it (docs/customer-user-licensing-design.md). For the internal
 * org it is the same list with no money behind it: a colleague nobody has
 * named cannot use the app (docs/internal-user-access-design.md).
 *
 *   - Add users: search by name or e-mail, tick the users you mean, press
 *     "Add users", confirm against the list of who. Three deliberate steps,
 *     because adding a customer name starts a charge — a single click on a
 *     search result is not enough of a decision.
 *   - On a customer org, adding also decides the role: Administrator
 *     (everything the app offers customers) or Supervisor (a chosen subset of
 *     the org's Supervisor scope, ticked here). Both are required
 *     (docs/customer-roles-design.md §4, §8). An empty scope refuses a
 *     Supervisor and says where to set it.
 *   - Users with access: the current list, with Remove (also confirmed), and
 *     on a customer org the role per row and an Edit that changes it — promote,
 *     demote, re-tick — through /api/licenses/role.
 *   - On the internal org only, for superusers only: "Manages customer
 *     access", one tick per row. It is the right to name users for customer
 *     orgs — to start charges — and it is granted here, by a superuser,
 *     logged, never derived from a Genesys group.
 *
 * Administrator › Users is this page in customer mode: the org is the
 * session's, the add box and Remove are absent — a customer never names
 * anyone — and Edit is the whole of it. The server refuses add and remove
 * from any customer session regardless; the page shows what is true.
 *
 * Who may change which list is decided by the server, from the caller's own
 * row: the internal org's list by superusers only; a customer's by superusers
 * and colleagues who manage customer access; a customer's roles also by its
 * own Administrators. This page reads the same answer off `access` and does
 * not offer what the server would refuse.
 *
 * Remove is a revocation, not a deletion: the row stays as history.
 */
import { escapeHtml, makeStatus, withBusy } from "../../utils.js";
import {
  listLicensedUsers, assignLicense, revokeLicense, setLicenseRole, getSupervisorScope,
} from "../../services/licenseService.js";
import { customerPageTree, pruneTree } from "../../services/customerPageTree.js";
import { createPageTree, describePages, ensurePageTreeStyles } from "../../components/pageTree.js";

const SEARCH_DEBOUNCE_MS = 250;

export default function renderCustomerAccess({ api, orgContext, access }) {
  ensurePageTreeStyles();
  const isSuperuser  = !!(access && access.isSuperuser);
  const customerMode = !!(orgContext && orgContext.isCustomer && orgContext.isCustomer());
  const scopeRoute   = customerMode ? "#/administrator/supervisor-access" : "#/customers/supervisor-access";
  const fullTree     = customerPageTree();

  const el = document.createElement("div");
  el.innerHTML = `
    <style>
      .ca-wrap { max-width: 900px; }
      .ca-org { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
      .ca-org .em-label { margin:0; }
      .ca-count { color:var(--muted); font-size:13px; }
      .ca-add { position:relative; max-width:620px; margin-bottom:18px; }
      .ca-add-row { display:flex; gap:8px; align-items:center; }
      .ca-input { flex:1; padding:8px 12px; background:var(--panel); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:13px; }
      .ca-input:focus { border-color:var(--accent-strong); outline:none; }
      .ca-input::placeholder { color:var(--muted); }
      .ca-dropdown { position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:200; background:var(--panel); border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 24px color-mix(in srgb, var(--backdrop) 40%, transparent); max-height:260px; overflow-y:auto; display:none; }
      .ca-search { position:relative; }
      .ca-dropdown.open { display:block; }
      .ca-option { display:flex; align-items:center; gap:10px; padding:8px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border); margin:0; }
      .ca-option:last-child { border-bottom:none; }
      .ca-option:hover { background:color-mix(in srgb, var(--accent-strong) 15%, transparent); }
      .ca-option.is-added { cursor:default; opacity:.6; }
      .ca-option.is-added:hover { background:transparent; }
      .ca-option input[type=checkbox] { margin:0; flex:none; }
      .ca-option-text { flex:1; min-width:0; }
      .ca-option-name { font-weight:500; color:var(--text); }
      .ca-option-email { font-size:11px; color:var(--muted); margin-top:1px; }
      .ca-option-tag { font-size:11px; color:var(--muted); white-space:nowrap; }
      .ca-selected { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .ca-selected:empty { display:none; }
      .ca-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 8px; background:color-mix(in srgb, var(--accent-strong) 30%, var(--panel)); border:1px solid var(--accent-strong); border-radius:8px; font-size:12px; color:var(--accent-quiet); }
      .ca-chip-x { cursor:pointer; color:var(--muted); font-size:14px; line-height:1; }
      .ca-chip-x:hover { color:var(--danger); }
      .ca-hint { color:var(--muted); font-style:italic; padding:10px 12px; cursor:default; font-size:13px; }
      .ca-table td.ca-actions { text-align:right; white-space:nowrap; }
      .ca-table td.ca-actions .btn + .btn { margin-left:6px; }
      .ca-muted { color:var(--muted); }
      .ca-empty { color:var(--muted); padding:14px 0; }
      /* The role control — shared by the add box and the per-row edit. */
      .ca-role { margin-top:10px; background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:10px 14px; font-size:13px; }
      .ca-role-choice { display:flex; gap:18px; flex-wrap:wrap; align-items:center; }
      .ca-role-choice label { display:inline-flex; align-items:center; gap:6px; cursor:pointer; color:var(--text); }
      .ca-role-choice label.is-disabled { color:var(--muted); cursor:default; }
      .ca-role-choice input { margin:0; }
      .ca-role-desc { color:var(--muted); font-size:12px; margin-top:4px; }
      .ca-role-desc a { color:var(--accent); }
      .ca-role-pages { margin-top:10px; padding-top:10px; border-top:1px solid var(--border); }
      .ca-role-pages-head { display:flex; align-items:center; gap:8px; margin-bottom:6px; color:var(--muted); font-size:12px; }
      .ca-role-pages-head .ca-spacer { flex:1; }
      .ca-edit-row td { background:color-mix(in srgb, var(--lift) 3%, transparent); }
      .ca-edit-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:10px; }
    </style>
    <div class="ca-wrap">
      <h1 class="h1">${customerMode ? "Administrator — Users" : "Customers — Access to Admin Tool"}</h1>
      <hr class="hr">
      <p class="page-desc" id="caIntro">
        The users in the selected customer's organisation who may use this app. Only the people
        listed here can sign in; everyone else in the org sees a message asking them to contact
        their administrator. Adding a name is what the customer is billed for.
      </p>

      <div class="ca-org">
        <span class="em-label" ${customerMode ? "hidden" : ""}>Organization:</span>
        <span id="caOrgName" class="em-hint" ${customerMode ? "hidden" : ""}>Select a customer org in the header.</span>
        <span id="caCount" class="ca-count"></span>
      </div>

      <div class="ca-add" id="caAdd" hidden>
        <div class="ca-search">
          <div class="ca-add-row">
            <input id="caSearch" class="ca-input" type="text" autocomplete="off"
                   placeholder="Search users by name or e-mail, then tick the ones to add…">
            <button type="button" class="btn" id="caAddBtn" disabled>Add users</button>
          </div>
          <div id="caDropdown" class="ca-dropdown"></div>
        </div>
        <div id="caSelected" class="ca-selected"></div>
        <div id="caRole"></div>
      </div>

      <div id="caStatus" class="cs-status"></div>

      <div id="caList"></div>
    </div>
  `;

  const $intro    = el.querySelector("#caIntro");
  const $orgName  = el.querySelector("#caOrgName");
  const $count    = el.querySelector("#caCount");
  const $add      = el.querySelector("#caAdd");
  const $search   = el.querySelector("#caSearch");
  const $dropdown = el.querySelector("#caDropdown");
  const $addBtn   = el.querySelector("#caAddBtn");
  const $selected = el.querySelector("#caSelected");
  const $roleBox  = el.querySelector("#caRole");
  const $status   = el.querySelector("#caStatus");
  const $list     = el.querySelector("#caList");
  const setStatus = makeStatus($status, "cs-status");

  let currentOrg = null;
  let licensed   = [];          // active rows for currentOrg
  let scope      = null;        // the org's Supervisor scope (customer orgs); null = not loaded
  let searchTimer = null;
  let searchSeq   = 0;          // drop stale responses
  let loadSeq     = 0;
  const selected  = new Map();  // userId → { id, name, email } ticked but not yet added
  let lastResults = [];         // the dropdown's current rows, so a re-render keeps them
  let addRole     = null;       // the add box's role control (customer orgs)
  let editing     = null;       // { userId, control, tr } — the open per-row edit

  function isInternal() {
    return !!(currentOrg && orgContext.isInternalOrg(currentOrg.id));
  }

  // ── The role control ─────────────────────────────────────────────────

  /**
   * Administrator or Supervisor, and for a Supervisor the pages — the scope's
   * pages, drawn as the sidebar draws them. One builder for the add box and
   * the per-row edit, so the two cannot drift.
   *
   * @param {{ role?: string, features?: string[] }} initial
   * @param {Function} onChange  Called after every change.
   * @param {{ open?: boolean }} [opts]  Whether the page tree starts expanded.
   *        Expanded on add (the pages are the decision being made), collapsed
   *        on edit (the row already has its pages; the counts say where).
   */
  function createRoleControl(initial, onChange, { open = true } = {}) {
    const box = document.createElement("div");
    box.className = "ca-role";
    const scopeEmpty = !scope || !scope.length;
    const uid = `car${Math.random().toString(36).slice(2, 8)}`;
    box.innerHTML = `
      <div class="ca-role-choice">
        <span class="em-label" style="margin:0">Role:</span>
        <label><input type="radio" name="${uid}" value="administrator"> Administrator</label>
        <label class="${scopeEmpty ? "is-disabled" : ""}"><input type="radio" name="${uid}" value="supervisor" ${scopeEmpty ? "disabled" : ""}> Supervisor</label>
      </div>
      <div class="ca-role-desc"></div>
      <div class="ca-role-pages" hidden>
        <div class="ca-role-pages-head">
          <span class="ca-role-pages-count"></span>
          <span class="ca-spacer"></span>
          <button type="button" class="btn btn-secondary btn-sm" data-all>Tick all</button>
          <button type="button" class="btn btn-secondary btn-sm" data-none>Untick all</button>
        </div>
        <div class="ca-role-tree"></div>
      </div>`;
    const $desc  = box.querySelector(".ca-role-desc");
    const $pages = box.querySelector(".ca-role-pages");
    const $pagesCount = box.querySelector(".ca-role-pages-count");
    const radios = [...box.querySelectorAll("input[type=radio]")];
    const tree = createPageTree({ tree: pruneTree(fullTree, scope || []), onChange: () => refresh(), open });
    box.querySelector(".ca-role-tree").append(tree.el);
    box.querySelector("[data-all]").addEventListener("click", () => tree.selectAll(true));
    box.querySelector("[data-none]").addEventListener("click", () => tree.selectAll(false));

    function role() { const r = radios.find((x) => x.checked); return r ? r.value : ""; }

    function refresh() {
      const r = role();
      $pages.hidden = r !== "supervisor";
      if (r === "administrator") {
        $desc.textContent = "Everything the app offers customers, narrowed by their own Genesys permissions. Administrators also set the Supervisor scope and edit users' roles here.";
      } else if (r === "supervisor") {
        const n = tree.getSelected().length;
        $desc.textContent = "Only the pages ticked below, narrowed by their own Genesys permissions. Nothing else appears in their menu.";
        $pagesCount.textContent = `${n} of ${tree.size} pages in the Supervisor scope ticked`;
      } else {
        $desc.innerHTML = scopeEmpty
          ? `Nothing is in the Supervisor scope for this organisation yet, so only an Administrator can be added. <a href="${scopeRoute}">Set the Supervisor scope first</a> to add Supervisors.`
          : "Choose a role.";
      }
      onChange();
    }
    radios.forEach((r) => r.addEventListener("change", refresh));

    if (initial.role === "administrator" || (initial.role === "supervisor" && !scopeEmpty)) {
      radios.find((x) => x.value === initial.role).checked = true;
    }
    tree.setSelected(initial.features || []);
    refresh();

    return {
      el: box,
      value() { const r = role(); return { role: r, features: r === "supervisor" ? tree.getSelected() : [] }; },
      valid() { const r = role(); return r === "administrator" || (r === "supervisor" && tree.getSelected().length > 0); },
      setEnabled(on) { radios.forEach((r) => { r.disabled = !on || (r.value === "supervisor" && scopeEmpty); }); tree.setEnabled(on); },
    };
  }

  /** The sentence for a confirm step: the role, and a Supervisor's pages. */
  function describeRole({ role, features }) {
    if (role === "administrator") return "as Administrator (everything the app offers customers)";
    const lines = describePages(fullTree, features);
    return `as Supervisor with ${lines.length} page${lines.length === 1 ? "" : "s"}:\n${lines.map((l) => `    – ${l}`).join("\n")}`;
  }

  // ── The list ─────────────────────────────────────────────────────────

  function roleCell(u) {
    if (u.role === "administrator") return "Administrator";
    if (u.role === "supervisor") {
      const n = Array.isArray(u.features) ? u.features.length : 0;
      return `Supervisor · ${n} page${n === 1 ? "" : "s"}`;
    }
    return `<span class="ca-muted" title="A row from before roles existed; treated as Administrator until edited">Administrator (unset)</span>`;
  }

  function renderList() {
    $count.textContent = currentOrg
      ? `${licensed.length} ${licensed.length === 1 ? "user has" : "users have"} access`
      : "";
    editing = null;

    if (!currentOrg) { $list.innerHTML = ""; return; }
    if (!licensed.length) {
      $list.innerHTML = `<div class="ca-empty">Nobody in ${escapeHtml(currentOrg.name)} has access yet.${customerMode ? "" : " Add a user above."}</div>`;
      return;
    }
    // The "manages" column exists on the internal org's list only, and only
    // a superuser sees it: it is the right to start charges to customers.
    // The role column exists on a customer's list.
    const manageCol = isInternal() && isSuperuser;
    const roleCol   = !isInternal();
    $list.innerHTML = `
      <table class="data-table ca-table">
        <thead><tr><th>Name</th><th>E-mail</th>${roleCol ? "<th>Role</th>" : ""}<th>Added by</th><th>Added on</th><th>Modified by</th><th>Modified on</th>${manageCol ? "<th>Manages customer access</th>" : ""}<th></th></tr></thead>
        <tbody>
          ${licensed.map((u) => `
            <tr data-user="${escapeHtml(u.userId)}">
              <td>${escapeHtml(u.name || u.userId)}</td>
              <td class="ca-muted">${escapeHtml(u.email || "")}</td>
              ${roleCol ? `<td data-role-cell>${roleCell(u)}</td>` : ""}
              <td class="ca-muted">${escapeHtml(u.assignedByName || u.assignedByEmail || "")}</td>
              <td class="ca-muted">${escapeHtml(fmtDate(u.assignedAt))}</td>
              <td class="ca-muted">${escapeHtml(u.modifiedByName || u.modifiedByEmail || "")}</td>
              <td class="ca-muted">${escapeHtml(fmtDate(u.modifiedAt))}</td>
              ${manageCol ? `<td><input type="checkbox" data-manage="${escapeHtml(u.userId)}" ${u.role === "customer-manager" ? "checked" : ""} title="May add and remove users for customer organisations"></td>` : ""}
              <td class="ca-actions">
                ${roleCol ? `<button type="button" class="btn btn-secondary btn-sm" data-edit="${escapeHtml(u.userId)}">Edit</button>` : ""}
                ${customerMode ? "" : `<button type="button" class="btn btn-secondary btn-sm" data-remove="${escapeHtml(u.userId)}">Remove</button>`}
              </td>
            </tr>`).join("")}
        </tbody>
      </table>`;

    $list.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => remove(btn.getAttribute("data-remove")));
    });
    $list.querySelectorAll("[data-manage]").forEach((box) => {
      box.addEventListener("change", () => setManages(box.getAttribute("data-manage"), box.checked, box));
    });
    $list.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openEdit(btn.getAttribute("data-edit")));
    });
  }

  /** Grant or withdraw the right to manage customer access. Superusers only; the server checks again. */
  async function setManages(userId, on, box) {
    const row   = licensed.find((l) => l.userId === userId);
    const label = row ? (row.name || row.email || userId) : userId;
    const role  = on ? "customer-manager" : "";
    const ok = window.confirm(on
      ? `Let ${label} add and remove users for customer organisations?\n\nAdding a customer user starts a charge to that customer.`
      : `Withdraw ${label}'s right to manage customer access?`);
    if (!ok) { box.checked = !on; return; }
    box.disabled = true;
    setStatus(on ? `Letting ${label} manage customer access…` : `Withdrawing ${label}'s right to manage customer access…`);
    try {
      const r = await setLicenseRole(currentOrg.id, userId, role);
      if (row) Object.assign(row, r.user || {}, { role });
      renderList();
      setStatus(on ? `${label} can now manage customer access.` : `${label} no longer manages customer access.`, "success");
    } catch (err) {
      box.checked = !on;
      setStatus(err.message || String(err), "error");
    } finally {
      box.disabled = false;
    }
  }

  // ── Edit a customer user's role and pages ────────────────────────────

  function closeEdit() {
    if (!editing) return;
    editing.tr.remove();
    editing = null;
  }

  function openEdit(userId) {
    const row = licensed.find((l) => l.userId === userId);
    const anchor = $list.querySelector(`tr[data-user="${CSS.escape(userId)}"]`);
    if (!row || !anchor) return;
    if (editing && editing.userId === userId) { closeEdit(); return; }
    closeEdit();

    const tr = document.createElement("tr");
    tr.className = "ca-edit-row";
    const td = document.createElement("td");
    td.colSpan = anchor.children.length;
    let $save = null;      // assigned below; the control fires onChange while it is built
    const control = createRoleControl({ role: row.role, features: row.features }, () => {
      if ($save) $save.disabled = !control.valid();
    }, { open: false });
    const actions = document.createElement("div");
    actions.className = "ca-edit-actions";
    actions.innerHTML = `<button type="button" class="btn btn-secondary btn-sm" data-cancel>Cancel</button><button type="button" class="btn btn-sm" data-save>Save</button>`;
    $save = actions.querySelector("[data-save]");
    $save.disabled = !control.valid();
    actions.querySelector("[data-cancel]").addEventListener("click", closeEdit);
    $save.addEventListener("click", () => saveEdit(row, control, $save));
    td.append(control.el, actions);
    tr.append(td);
    anchor.after(tr);
    editing = { userId, control, tr };
  }

  async function saveEdit(row, control, $save) {
    const value = control.value();
    const label = row.name || row.email || row.userId;
    setStatus(`Saving ${label}'s role…`);
    control.setEnabled(false);
    try {
      const r = await withBusy($save, () => setLicenseRole(currentOrg.id, row.userId, value.role, value.features));
      if (r.user) Object.assign(row, r.user);   // role, pages and the modified stamp
      renderList();
      const n = value.features.length;
      const what = value.role === "administrator" ? "an Administrator" : `a Supervisor with ${n} page${n === 1 ? "" : "s"}`;
      setStatus(r.changed ? `${label} is now ${what}. Takes effect within five minutes.` : `${label}'s role is unchanged.`, "success");
    } catch (err) {
      control.setEnabled(true);
      setStatus(err.message || String(err), "error");
    }
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toISOString().slice(0, 10);
  }

  async function loadList() {
    if (!currentOrg) return;
    const seq = ++loadSeq;
    setStatus(`Loading who has access for ${currentOrg.name}…`);
    try {
      const [rows, scopeKeys] = await Promise.all([
        listLicensedUsers(currentOrg.id),
        isInternal() ? Promise.resolve(null) : getSupervisorScope(currentOrg.id),
      ]);
      if (seq !== loadSeq) return;
      licensed = rows;
      scope = scopeKeys;
      renderList();
      renderAddRole();
      setStatus("");
    } catch (err) {
      if (seq !== loadSeq) return;
      licensed = [];
      scope = null;
      renderList();
      renderAddRole();
      setStatus(err.message || String(err), "error");
    }
  }

  // ── Add ──────────────────────────────────────────────────────────────

  /** The add box's role control: present on a customer org, absent on the internal one. */
  function renderAddRole() {
    $roleBox.innerHTML = "";
    addRole = null;
    if (customerMode || !currentOrg || isInternal()) { renderSelected(); return; }
    addRole = createRoleControl({}, renderSelected);
    $roleBox.append(addRole.el);
    renderSelected();
  }

  function closeDropdown() { $dropdown.classList.remove("open"); $dropdown.innerHTML = ""; }

  function showHint(text) {
    $dropdown.innerHTML = `<div class="ca-hint">${escapeHtml(text)}</div>`;
    $dropdown.classList.add("open");
  }

  function showResults(users) {
    lastResults = users;
    if (!users.length) { showHint("No users found"); return; }
    $dropdown.innerHTML = "";
    for (const u of users) {
      const already = licensed.some((l) => l.userId === u.id);
      const row = document.createElement("label");
      row.className = "ca-option" + (already ? " is-added" : "");
      row.innerHTML = `
        <input type="checkbox" ${already ? "disabled" : ""} ${selected.has(u.id) ? "checked" : ""}>
        <span class="ca-option-text">
          <div class="ca-option-name">${escapeHtml(u.name || u.id)}</div>
          <div class="ca-option-email">${escapeHtml(u.email || "")}</div>
        </span>
        <span class="ca-option-tag">${already ? "Has access" : ""}</span>`;
      if (!already) {
        row.querySelector("input").addEventListener("change", (e) => {
          if (e.target.checked) selected.set(u.id, { id: u.id, name: u.name || "", email: u.email || "" });
          else selected.delete(u.id);
          renderSelected();
        });
      }
      $dropdown.appendChild(row);
    }
    $dropdown.classList.add("open");
  }

  // Ticked users, shown as chips under the search so the choice is visible
  // even after the dropdown closes or the search changes.
  function renderSelected() {
    $selected.innerHTML = "";
    for (const u of selected.values()) {
      const chip = document.createElement("span");
      chip.className = "ca-chip";
      chip.innerHTML = `${escapeHtml(u.name || u.email || u.id)} <span class="ca-chip-x" title="Untick">×</span>`;
      chip.querySelector(".ca-chip-x").addEventListener("click", () => {
        selected.delete(u.id);
        renderSelected();
        // keep the open dropdown in step
        if ($dropdown.classList.contains("open")) showResults(lastResults);
      });
      $selected.appendChild(chip);
    }
    const n = selected.size;
    // On a customer org the role (and a Supervisor's pages) must be chosen too.
    $addBtn.disabled = n === 0 || (addRole ? !addRole.valid() : false);
    $addBtn.textContent = n === 0 ? "Add users" : n === 1 ? "Add 1 user" : `Add ${n} users`;
  }

  async function search(q) {
    const term = q.trim();
    if (!term || !currentOrg) { closeDropdown(); return; }
    const seq = ++searchSeq;
    showHint("Searching…");
    try {
      const resp = await api.proxyGenesys(currentOrg.id, "POST", "/api/v2/users/search", {
        body: {
          pageSize: 25,
          pageNumber: 1,
          query: [{ type: "CONTAINS", fields: ["name", "email"], value: term }],
          sortOrder: "ASC",
          sortBy: "name",
        },
      });
      if (seq !== searchSeq) return;             // a newer search superseded this one
      showResults(resp.results || []);
    } catch (err) {
      if (seq !== searchSeq) return;
      showHint(`Search failed: ${err.message || err}`);
    }
  }

  /**
   * The decision. Everyone ticked is listed by name and e-mail in a
   * confirmation, with the org, the role and what adding means; only on OK
   * does anything reach the server. Each user is added in turn so one
   * failure does not hide the others' results.
   */
  async function addSelected() {
    if (!currentOrg || selected.size === 0) return;
    if (addRole && !addRole.valid()) return;
    const users = [...selected.values()];
    const rolePages = addRole ? addRole.value() : { role: "", features: [] };
    const lines = users.map((u) => `  • ${u.name || u.id}${u.email ? ` (${u.email})` : ""}`).join("\n");
    const ok = window.confirm(
      `Give access to the Admin Tool for ${currentOrg.name} to:\n\n${lines}\n\n` +
      (addRole ? `${describeRole(rolePages)}\n\n` : "") +
      (isInternal() ? `Continue?` : `Adding a name is what the customer is billed for. Continue?`)
    );
    if (!ok) return;

    closeDropdown();
    $search.value = "";
    $addBtn.disabled = true;
    setStatus(`Adding ${users.length === 1 ? "1 user" : users.length + " users"}…`);

    const added = [], already = [], failed = [];
    for (const u of users) {
      try {
        const r = await assignLicense(currentOrg.id, { id: u.id, email: u.email, name: u.name }, rolePages);
        if (r.created) { licensed.push(r.user); added.push(u); } else { already.push(u); }
        selected.delete(u.id);
      } catch (err) {
        failed.push({ u, err });
      }
    }
    licensed.sort((a, b) => String(a.assignedAt).localeCompare(String(b.assignedAt)));
    renderList();
    renderSelected();

    const name = (u) => u.name || u.email || u.id;
    const parts = [];
    if (added.length)   parts.push(`Added: ${added.map(name).join(", ")}.`);
    if (already.length) parts.push(`Already had access: ${already.map(name).join(", ")}.`);
    if (failed.length)  parts.push(`Failed: ${failed.map((f) => `${name(f.u)} (${f.err.message || f.err})`).join("; ")}.`);
    setStatus(parts.join(" "), failed.length ? "error" : "success");
  }

  // ── Remove ───────────────────────────────────────────────────────────

  async function remove(userId) {
    if (!currentOrg) return;
    const u = licensed.find((l) => l.userId === userId);
    const label = u ? (u.name || u.email || userId) : userId;
    const ok = window.confirm(
      `Remove ${label}'s access to the Admin Tool for ${currentOrg.name}?\n\n` +
      (isInternal()
        ? `They will be signed out within five minutes and see a message to ask a superuser.`
        : `They will be signed out within five minutes and see a message to contact their administrator.`)
    );
    if (!ok) return;

    setStatus(`Removing ${label}'s access…`);
    try {
      await revokeLicense(currentOrg.id, userId);
      licensed = licensed.filter((l) => l.userId !== userId);
      renderList();
      setStatus(`${label} no longer has access.`, "success");
    } catch (err) {
      setStatus(err.message || String(err), "error");
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────

  $search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search($search.value), SEARCH_DEBOUNCE_MS);
  });
  $search.addEventListener("focus", () => { if ($search.value.trim()) search($search.value); });
  $search.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDropdown(); });
  // Ticking a row must not close the list: swallowing mousedown keeps focus
  // on the input (the checkbox still toggles on click).
  $dropdown.addEventListener("mousedown", (e) => e.preventDefault());
  // Close on a click anywhere outside the search box.
  const onDocClick = (e) => { if (!$add.contains(e.target)) closeDropdown(); };
  document.addEventListener("click", onDocClick);
  $addBtn.addEventListener("click", addSelected);

  /**
   * An org has a list if it can sign in as a customer, or if it is the
   * internal org. One without a registry entry cannot sign in as a customer
   * at all. The internal org's list may be changed by superusers only; the
   * server refuses anyone else, and this says so instead of offering a box
   * that would fail.
   */
  function notLicensable(org) {
    if (!org) return null;
    if (org.registered === false && !orgContext.isInternalOrg(org.id)) {
      return `${org.name} is not set up as a customer yet: it has no registry entry, so nobody can sign in to it as a customer. Add the registry entry first (see the onboarding runbook), then name its users here.`;
    }
    if (orgContext.isInternalOrg(org.id) && !isSuperuser) {
      return `${org.name} is the internal organisation. Only a superuser can change who has access to it.`;
    }
    return null;
  }

  /** The intro says which kind of list this is. */
  function renderIntro() {
    if (customerMode) {
      $intro.textContent = "The users in your organisation who may use this app, and what each may see. "
        + "Edit a user to make them an Administrator or a Supervisor, and to choose a Supervisor's pages "
        + "from the Supervisor scope. Adding and removing users is done by Netdesign — contact them to "
        + "change who is on the list.";
      return;
    }
    $intro.textContent = isInternal()
      ? "The colleagues in the internal organisation who may use this app. Only the people listed "
        + "here can sign in; everyone else in the org sees a message asking them to contact a "
        + "superuser. Nothing here is billed. Tick \"Manages customer access\" to let a colleague add "
        + "and remove users for customer organisations."
      : "The users in the selected customer's organisation who may use this app. Only the people "
        + "listed here can sign in; everyone else in the org sees a message asking them to contact "
        + "their administrator. Adding a name is what the customer is billed for. Every user is an "
        + "Administrator (everything) or a Supervisor (chosen pages from the org's Supervisor scope).";
  }

  function setOrg(org) {
    currentOrg = org || null;
    closeDropdown();
    $search.value = "";
    selected.clear();
    licensed = [];
    scope = null;
    renderAddRole();
    if (!currentOrg) {
      $orgName.textContent = "Select a customer org in the header.";
      $add.hidden = true;
      renderList();
      setStatus("");
      return;
    }
    $orgName.textContent = currentOrg.name;
    renderIntro();
    const why = customerMode ? null : notLicensable(currentOrg);
    if (why) {
      $add.hidden = true;
      $count.textContent = "";
      $list.innerHTML = "";
      setStatus(why, "warn");
      return;
    }
    $add.hidden = customerMode;      // a customer never names anyone
    loadList();
  }

  if (customerMode) {
    setOrg(orgContext.getDetails() || (orgContext.getCustomers() || [])[0] || null);
    el.__destroy = () => { clearTimeout(searchTimer); document.removeEventListener("click", onDocClick); };
  } else {
    setOrg(orgContext?.getDetails?.() || null);
    const unsubscribe = orgContext?.onChange?.(() => setOrg(orgContext?.getDetails?.() || null));
    el.__destroy = () => { unsubscribe?.(); clearTimeout(searchTimer); document.removeEventListener("click", onDocClick); };
  }

  return el;
}
