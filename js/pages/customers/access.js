/**
 * Customers › Access to Admin Tool
 *
 * Who, in the selected customer's org, may use this app. Customers pay per
 * named user and the list on this page IS the contract — there is no seat
 * count to keep in step with it (docs/customer-user-licensing-design.md).
 *
 *   - Add users: search by name or e-mail, tick the users you mean, press
 *     "Add users", confirm against the list of who. Three deliberate steps,
 *     because adding a name starts a charge — a single click on a search
 *     result is not enough of a decision.
 *   - Users with access: the current list, with Remove (also confirmed).
 *
 * The org is the header selector's, like every other internal page. Search
 * runs through the proxy on the selected customer (POST /users/search);
 * add and remove go to /api/licenses, which checks Master Admin membership
 * again server-side and logs every change with the caller's verified identity.
 *
 * Remove is a revocation, not a deletion: the row stays as billing history.
 * Nothing on this page shows that history, and nothing here mentions money.
 */
import { escapeHtml, makeStatus } from "../../utils.js";
import { listLicensedUsers, assignLicense, revokeLicense } from "../../services/licenseService.js";

const SEARCH_DEBOUNCE_MS = 250;

export default function renderCustomerAccess({ me, api, orgContext }) {
  const el = document.createElement("div");
  el.innerHTML = `
    <style>
      .ca-wrap { max-width: 900px; }
      .ca-org { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
      .ca-org .em-label { margin:0; }
      .ca-count { color:var(--muted); font-size:13px; }
      .ca-add { position:relative; max-width:520px; margin-bottom:18px; }
      .ca-add-row { display:flex; gap:8px; align-items:center; }
      .ca-input { flex:1; padding:8px 12px; background:var(--panel); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:13px; }
      .ca-input:focus { border-color:#3b82f6; outline:none; }
      .ca-input::placeholder { color:var(--muted); }
      .ca-dropdown { position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:200; background:var(--panel); border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.4); max-height:260px; overflow-y:auto; display:none; }
      .ca-dropdown.open { display:block; }
      .ca-option { display:flex; align-items:center; gap:10px; padding:8px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border); margin:0; }
      .ca-option:last-child { border-bottom:none; }
      .ca-option:hover { background:rgba(59,130,246,.15); }
      .ca-option.is-added { cursor:default; opacity:.6; }
      .ca-option.is-added:hover { background:transparent; }
      .ca-option input[type=checkbox] { margin:0; flex:none; }
      .ca-option-text { flex:1; min-width:0; }
      .ca-option-name { font-weight:500; color:var(--text); }
      .ca-option-email { font-size:11px; color:var(--muted); margin-top:1px; }
      .ca-option-tag { font-size:11px; color:var(--muted); white-space:nowrap; }
      .ca-selected { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .ca-selected:empty { display:none; }
      .ca-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 8px; background:rgba(30,58,95,.8); border:1px solid #3b82f6; border-radius:8px; font-size:12px; color:#93c5fd; }
      .ca-chip-x { cursor:pointer; color:var(--muted); font-size:14px; line-height:1; }
      .ca-chip-x:hover { color:#f87171; }
      .ca-hint { color:var(--muted); font-style:italic; padding:10px 12px; cursor:default; font-size:13px; }
      .ca-table td.ca-actions { text-align:right; white-space:nowrap; }
      .ca-muted { color:var(--muted); }
      .ca-empty { color:var(--muted); padding:14px 0; }
    </style>
    <div class="ca-wrap">
      <h1 class="h1">Customers — Access to Admin Tool</h1>
      <hr class="hr">
      <p class="page-desc">
        The users in the selected customer's organisation who may use this app. Only the people
        listed here can sign in; everyone else in the org sees a message asking them to contact
        their administrator. Adding a name is what the customer is billed for.
      </p>

      <div class="ca-org">
        <span class="em-label">Organization:</span>
        <span id="caOrgName" class="em-hint">Select a customer org in the header.</span>
        <span id="caCount" class="ca-count"></span>
      </div>

      <div class="ca-add" id="caAdd" hidden>
        <div class="ca-add-row">
          <input id="caSearch" class="ca-input" type="text" autocomplete="off"
                 placeholder="Search users by name or e-mail, then tick the ones to add…">
          <button type="button" class="btn" id="caAddBtn" disabled>Add users</button>
        </div>
        <div id="caDropdown" class="ca-dropdown"></div>
        <div id="caSelected" class="ca-selected"></div>
      </div>

      <div id="caStatus" class="cs-status"></div>

      <div id="caList"></div>
    </div>
  `;

  const $orgName  = el.querySelector("#caOrgName");
  const $count    = el.querySelector("#caCount");
  const $add      = el.querySelector("#caAdd");
  const $search   = el.querySelector("#caSearch");
  const $dropdown = el.querySelector("#caDropdown");
  const $addBtn   = el.querySelector("#caAddBtn");
  const $selected = el.querySelector("#caSelected");
  const $status   = el.querySelector("#caStatus");
  const $list     = el.querySelector("#caList");
  const setStatus = makeStatus($status, "cs-status");

  let currentOrg = null;
  let licensed   = [];          // active rows for currentOrg
  let searchTimer = null;
  let searchSeq   = 0;          // drop stale responses
  const selected  = new Map();  // userId → { id, name, email } ticked but not yet added
  let lastResults = [];         // the dropdown's current rows, so a re-render keeps them

  // ── The list ─────────────────────────────────────────────────────────

  function renderList() {
    $count.textContent = currentOrg
      ? `${licensed.length} ${licensed.length === 1 ? "user has" : "users have"} access`
      : "";

    if (!currentOrg) { $list.innerHTML = ""; return; }
    if (!licensed.length) {
      $list.innerHTML = `<div class="ca-empty">Nobody in ${escapeHtml(currentOrg.name)} has access yet. Add a user above.</div>`;
      return;
    }
    $list.innerHTML = `
      <table class="data-table ca-table">
        <thead><tr><th>Name</th><th>E-mail</th><th>Added by</th><th>Added on</th><th></th></tr></thead>
        <tbody>
          ${licensed.map((u) => `
            <tr data-user="${escapeHtml(u.userId)}">
              <td>${escapeHtml(u.name || u.userId)}</td>
              <td class="ca-muted">${escapeHtml(u.email || "")}</td>
              <td class="ca-muted">${escapeHtml(u.assignedByEmail || u.assignedBy || "")}</td>
              <td class="ca-muted">${escapeHtml(fmtDate(u.assignedAt))}</td>
              <td class="ca-actions"><button type="button" class="btn btn-secondary btn-sm" data-remove="${escapeHtml(u.userId)}">Remove</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;

    $list.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => remove(btn.getAttribute("data-remove")));
    });
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toISOString().slice(0, 10);
  }

  async function loadList() {
    if (!currentOrg) return;
    setStatus(`Loading who has access for ${currentOrg.name}…`);
    try {
      licensed = await listLicensedUsers(currentOrg.id);
      renderList();
      setStatus("");
    } catch (err) {
      licensed = [];
      renderList();
      setStatus(err.message || String(err), "error");
    }
  }

  // ── Add ──────────────────────────────────────────────────────────────

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
    $addBtn.disabled = n === 0;
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
   * confirmation, with the org and what adding means; only on OK does
   * anything reach the server. Each user is added in turn so one failure
   * does not hide the others' results.
   */
  async function addSelected() {
    if (!currentOrg || selected.size === 0) return;
    const users = [...selected.values()];
    const lines = users.map((u) => `  • ${u.name || u.id}${u.email ? ` (${u.email})` : ""}`).join("\n");
    const ok = window.confirm(
      `Give access to the Admin Tool for ${currentOrg.name} to:\n\n${lines}\n\n` +
      `Adding a name is what the customer is billed for. Continue?`
    );
    if (!ok) return;

    closeDropdown();
    $search.value = "";
    $addBtn.disabled = true;
    setStatus(`Adding ${users.length === 1 ? "1 user" : users.length + " users"}…`);

    const added = [], already = [], failed = [];
    for (const u of users) {
      try {
        const r = await assignLicense(currentOrg.id, { id: u.id, email: u.email, name: u.name });
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
    setStatus(parts.join(" "), failed.length ? "error" : "ok");
  }

  // ── Remove ───────────────────────────────────────────────────────────

  async function remove(userId) {
    if (!currentOrg) return;
    const u = licensed.find((l) => l.userId === userId);
    const label = u ? (u.name || u.email || userId) : userId;
    const ok = window.confirm(
      `Remove ${label}'s access to the Admin Tool for ${currentOrg.name}?\n\n` +
      `They will be signed out within five minutes and see a message to contact their administrator.`
    );
    if (!ok) return;

    setStatus(`Removing ${label}'s access…`);
    try {
      await revokeLicense(currentOrg.id, userId);
      licensed = licensed.filter((l) => l.userId !== userId);
      renderList();
      setStatus(`${label} no longer has access.`, "ok");
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
  // Close on a click anywhere outside the add box.
  const onDocClick = (e) => { if (!$add.contains(e.target)) closeDropdown(); };
  document.addEventListener("click", onDocClick);
  $addBtn.addEventListener("click", addSelected);

  /**
   * Only an org that can sign in as a customer has a list. The internal org's
   * users are granted by group and never meet the licence gate; an org without
   * a registry entry cannot sign in as a customer at all. The server refuses
   * both; this just says so instead of offering a box that would fail.
   */
  function notLicensable(org) {
    if (!org) return null;
    if (org.internal === true || org.registered === false) {
      return org.internal
        ? `${org.name} is the internal organisation. Its users are granted access by group, not by licence — there is nothing to name here.`
        : `${org.name} is not set up as a customer yet: it has no registry entry, so nobody can sign in to it as a customer. Add the registry entry first (see the onboarding runbook), then name its users here.`;
    }
    return null;
  }

  function setOrg(org) {
    currentOrg = org || null;
    closeDropdown();
    $search.value = "";
    selected.clear();
    renderSelected();
    licensed = [];
    if (!currentOrg) {
      $orgName.textContent = "Select a customer org in the header.";
      $add.hidden = true;
      renderList();
      setStatus("");
      return;
    }
    $orgName.textContent = currentOrg.name;
    const why = notLicensable(currentOrg);
    if (why) {
      $add.hidden = true;
      $count.textContent = "";
      $list.innerHTML = "";
      setStatus(why, "warn");
      return;
    }
    $add.hidden = false;
    loadList();
  }

  setOrg(orgContext?.getDetails?.() || null);
  const unsubscribe = orgContext?.onChange?.(() => setOrg(orgContext?.getDetails?.() || null));
  el.__destroy = () => { unsubscribe?.(); clearTimeout(searchTimer); document.removeEventListener("click", onDocClick); };

  return el;
}
