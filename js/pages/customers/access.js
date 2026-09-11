/**
 * Customers › Access to Admin Tool
 *
 * Who, in the selected customer's org, may use this app. Customers pay per
 * named user and the list on this page IS the contract — there is no seat
 * count to keep in step with it (docs/customer-user-licensing-design.md).
 *
 *   - Add a user: type a name or e-mail, pick from the dropdown, Add.
 *   - Users with access: the current list, with Remove.
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
      .ca-option { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border); }
      .ca-option:last-child { border-bottom:none; }
      .ca-option:hover { background:rgba(59,130,246,.15); }
      .ca-option.is-added { cursor:default; opacity:.6; }
      .ca-option.is-added:hover { background:transparent; }
      .ca-option-name { font-weight:500; color:var(--text); }
      .ca-option-email { font-size:11px; color:var(--muted); margin-top:1px; }
      .ca-option-tag { font-size:11px; color:var(--muted); white-space:nowrap; }
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
                 placeholder="Type a name or e-mail to add a user…">
        </div>
        <div id="caDropdown" class="ca-dropdown"></div>
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
  const $status   = el.querySelector("#caStatus");
  const $list     = el.querySelector("#caList");
  const setStatus = makeStatus($status, "cs-status");

  let currentOrg = null;
  let licensed   = [];          // active rows for currentOrg
  let searchTimer = null;
  let searchSeq   = 0;          // drop stale responses

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
    if (!users.length) { showHint("No users found"); return; }
    $dropdown.innerHTML = "";
    for (const u of users) {
      const already = licensed.some((l) => l.userId === u.id);
      const opt = document.createElement("div");
      opt.className = "ca-option" + (already ? " is-added" : "");
      opt.innerHTML = `
        <div>
          <div class="ca-option-name">${escapeHtml(u.name || u.id)}</div>
          <div class="ca-option-email">${escapeHtml(u.email || "")}</div>
        </div>
        <span class="ca-option-tag">${already ? "Has access" : "Add"}</span>`;
      if (!already) {
        opt.addEventListener("mousedown", (e) => { e.preventDefault(); add(u); });
      }
      $dropdown.appendChild(opt);
    }
    $dropdown.classList.add("open");
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

  async function add(user) {
    if (!currentOrg) return;
    closeDropdown();
    $search.value = "";
    setStatus(`Giving ${user.name || user.email || user.id} access…`);
    try {
      const r = await assignLicense(currentOrg.id, { id: user.id, email: user.email || "", name: user.name || "" });
      if (r.created) {
        licensed.push(r.user);
        licensed.sort((a, b) => String(a.assignedAt).localeCompare(String(b.assignedAt)));
        renderList();
        setStatus(`${user.name || user.email || user.id} now has access.`, "ok");
      } else {
        setStatus(`${user.name || user.email || user.id} already has access.`);
      }
    } catch (err) {
      setStatus(err.message || String(err), "error");
    }
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
  $search.addEventListener("blur", () => setTimeout(closeDropdown, 150));
  $search.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDropdown(); });

  function setOrg(org) {
    currentOrg = org || null;
    closeDropdown();
    $search.value = "";
    licensed = [];
    if (!currentOrg) {
      $orgName.textContent = "Select a customer org in the header.";
      $add.hidden = true;
      renderList();
      setStatus("");
      return;
    }
    $orgName.textContent = currentOrg.name;
    $add.hidden = false;
    loadList();
  }

  setOrg(orgContext?.getDetails?.() || null);
  const unsubscribe = orgContext?.onChange?.(() => setOrg(orgContext?.getDetails?.() || null));
  el.__destroy = () => { unsubscribe?.(); clearTimeout(searchTimer); };

  return el;
}
