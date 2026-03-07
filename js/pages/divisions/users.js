/**
 * Divisions › Users
 *
 * Reassign one or more users to a different division.
 *
 * Flow:
 *   1. Load all users (filtered by status: active / inactive / both)
 *   2. Filter visible rows client-side by source division and name/email search
 *   3. Multi-select users across any combination of source divisions
 *   4. Pick a target division and apply
 *
 * API endpoints:
 *   GET   /api/v2/users                       — list users
 *   GET   /api/v2/authorization/divisions     — list divisions
 *   PATCH /api/v2/users/{id}                  — update user division
 */
import * as gc from "../../services/genesysApi.js";
import { escapeHtml, sleep } from "../../utils.js";

export default function renderDivisionUsers({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h2>Divisions — Users</h2>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ────────────────────────────────────────────
  let allUsers    = [];   // full list from API
  let divisions   = [];   // { id, name }
  let selectedIds = new Set();
  let isRunning   = false;

  // ── Render shell ─────────────────────────────────────
  el.innerHTML = `
    <h2>Divisions — Users</h2>
    <p class="page-desc">
      Reassign one or more users to a different division. Load users, optionally
      filter by source division or search by name/email, select the ones to move,
      then choose a target division and apply.
    </p>

    <div class="di-controls">
      <div class="di-control-group">
        <label class="di-label">Source Division</label>
        <select class="input dv-filter-select" id="dvSrcDiv">
          <option value="">(All)</option>
        </select>
      </div>
      <div class="di-control-group">
        <label class="di-label">Status</label>
        <select class="input dv-filter-select" id="dvUserStatus">
          <option value="active" selected>Active</option>
          <option value="inactive">Inactive</option>
          <option value="both">Both</option>
        </select>
      </div>
      <div class="di-control-group dv-search-group">
        <label class="di-label">Search</label>
        <input type="text" class="input" id="dvSearch" placeholder="Filter by name or email…">
      </div>
      <div class="di-control-group dv-load-group">
        <label class="di-label">&nbsp;</label>
        <button class="btn" id="dvLoadBtn">Load</button>
      </div>
    </div>

    <div class="di-status" id="dvStatusMsg">Select options and click Load.</div>

    <div id="dvTableSection" style="display:none">
      <div class="dv-select-bar">
        <label class="dv-select-all-label">
          <input type="checkbox" id="dvSelectAll">
          <span id="dvSelectAllText">Select visible</span>
        </label>
        <span class="dv-selected-count" id="dvSelectedCount"></span>
      </div>
      <div class="dv-table-wrap">
        <table class="data-table dv-table">
          <thead>
            <tr>
              <th class="dv-col-cb"></th>
              <th>Name</th>
              <th>Email</th>
              <th>Department</th>
              <th>Status</th>
              <th>Current Division</th>
            </tr>
          </thead>
          <tbody id="dvTbody"></tbody>
        </table>
      </div>

      <div class="di-controls dv-target-bar">
        <div class="di-control-group">
          <label class="di-label">Target Division</label>
          <select class="input dv-filter-select" id="dvTargetDiv">
            <option value="">— select target —</option>
          </select>
        </div>
        <div class="di-control-group dv-load-group">
          <label class="di-label">&nbsp;</label>
          <button class="btn dv-btn-apply" id="dvApplyBtn" disabled>Move Selected</button>
        </div>
      </div>
    </div>

    <div class="di-progress-wrap" id="dvProgressWrap" style="display:none">
      <div class="di-progress-bar" id="dvProgressBar"></div>
    </div>

    <div id="dvResultsSection" style="display:none">
      <h3 class="dv-results-title">Results</h3>
      <table class="data-table dv-table">
        <thead>
          <tr><th>#</th><th>Name</th><th>Result</th><th>Detail</th></tr>
        </thead>
        <tbody id="dvResultsTbody"></tbody>
      </table>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────
  const $srcDiv      = el.querySelector("#dvSrcDiv");
  const $userStatus  = el.querySelector("#dvUserStatus");
  const $search      = el.querySelector("#dvSearch");
  const $loadBtn     = el.querySelector("#dvLoadBtn");
  const $statusMsg   = el.querySelector("#dvStatusMsg");
  const $tableSection = el.querySelector("#dvTableSection");
  const $selectAll   = el.querySelector("#dvSelectAll");
  const $selectAllText = el.querySelector("#dvSelectAllText");
  const $selectedCount = el.querySelector("#dvSelectedCount");
  const $tbody       = el.querySelector("#dvTbody");
  const $targetDiv   = el.querySelector("#dvTargetDiv");
  const $applyBtn    = el.querySelector("#dvApplyBtn");
  const $progressWrap = el.querySelector("#dvProgressWrap");
  const $progressBar  = el.querySelector("#dvProgressBar");
  const $resultsSection = el.querySelector("#dvResultsSection");
  const $resultsTbody   = el.querySelector("#dvResultsTbody");

  // ── Helpers ───────────────────────────────────────────
  function setStatus(msg, type = "") {
    $statusMsg.textContent = msg;
    $statusMsg.className = "di-status" + (type ? ` di-status--${type}` : "");
  }

  function showProgress(pct) {
    $progressWrap.style.display = "";
    $progressBar.style.width = `${Math.min(pct, 100)}%`;
  }

  function hideProgress() {
    $progressWrap.style.display = "none";
    $progressBar.style.width = "0%";
  }

  function getVisibleUsers() {
    const srcFilter = $srcDiv.value;
    const searchVal = $search.value.trim().toLowerCase();
    return allUsers.filter(u => {
      if (srcFilter && u.division?.id !== srcFilter) return false;
      if (searchVal) {
        const nameMatch  = (u.name  || "").toLowerCase().includes(searchVal);
        const emailMatch = (u.email || "").toLowerCase().includes(searchVal);
        if (!nameMatch && !emailMatch) return false;
      }
      return true;
    });
  }

  function updateApplyBtn() {
    $applyBtn.disabled = isRunning || selectedIds.size === 0 || !$targetDiv.value;
  }

  function updateSelectAllCheckbox() {
    const visible = getVisibleUsers();
    const visibleSelected = visible.filter(u => selectedIds.has(u.id));
    if (visibleSelected.length === 0) {
      $selectAll.checked       = false;
      $selectAll.indeterminate = false;
    } else if (visibleSelected.length === visible.length) {
      $selectAll.checked       = true;
      $selectAll.indeterminate = false;
    } else {
      $selectAll.checked       = false;
      $selectAll.indeterminate = true;
    }
  }

  function renderTable() {
    const visible = getVisibleUsers();
    $selectAllText.textContent = `Select visible (${visible.length})`;

    if (!visible.length) {
      $tbody.innerHTML = `<tr><td colspan="6" class="dv-empty">No users match the current filter.</td></tr>`;
      updateSelectAllCheckbox();
      updateApplyBtn();
      return;
    }

    $tbody.innerHTML = visible.map(u => {
      const checked = selectedIds.has(u.id) ? "checked" : "";
      const statusBadge = u.state === "inactive"
        ? `<span class="dv-badge dv-badge--inactive">Inactive</span>`
        : `<span class="dv-badge dv-badge--active">Active</span>`;
      return `<tr class="${selectedIds.has(u.id) ? "dv-row-selected" : ""}">
        <td class="dv-col-cb"><input type="checkbox" class="dv-cb" data-id="${escapeHtml(u.id)}" ${checked}></td>
        <td>${escapeHtml(u.name || "—")}</td>
        <td>${escapeHtml(u.email || "—")}</td>
        <td>${escapeHtml(u.department || "—")}</td>
        <td>${statusBadge}</td>
        <td>${escapeHtml(u.division?.name || "—")}</td>
      </tr>`;
    }).join("");

    // Attach checkbox listeners
    $tbody.querySelectorAll(".dv-cb").forEach(cb => {
      cb.addEventListener("change", () => {
        if (cb.checked) selectedIds.add(cb.dataset.id);
        else            selectedIds.delete(cb.dataset.id);
        const row = cb.closest("tr");
        row.classList.toggle("dv-row-selected", cb.checked);
        updateSelectAllCheckbox();
        updateSelectionBadge();
        updateApplyBtn();
      });
    });

    updateSelectAllCheckbox();
    updateSelectionBadge();
    updateApplyBtn();
  }

  function updateSelectionBadge() {
    $selectedCount.textContent = selectedIds.size > 0
      ? `${selectedIds.size} selected`
      : "";
  }

  function populateDivisionDropdowns() {
    const opts = divisions
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`)
      .join("");

    $srcDiv.innerHTML    = `<option value="">(All)</option>` + opts;
    $targetDiv.innerHTML = `<option value="">— select target —</option>` + opts;
  }

  // ── Initial load: divisions ───────────────────────────
  (async () => {
    try {
      divisions = await gc.fetchAllDivisions(api, org.id);
      populateDivisionDropdowns();
    } catch (err) {
      setStatus(`Failed to load divisions: ${err.message}`, "error");
    }
  })();

  // ── Load users ────────────────────────────────────────
  async function loadUsers() {
    if (isRunning) return;
    isRunning = true;
    selectedIds.clear();
    $tableSection.style.display = "none";
    $resultsSection.style.display = "none";
    hideProgress();
    setStatus("Loading users…");
    $loadBtn.disabled = true;

    try {
      const statusVal = $userStatus.value;

      if (statusVal === "both") {
        setStatus("Loading active users…");
        const active = await gc.fetchAllUsers(api, org.id, {
          state: "active",
          onProgress: (p) => setStatus(`Loading active users… ${Math.round(p)}%`),
        });
        setStatus("Loading inactive users…");
        const inactive = await gc.fetchAllUsers(api, org.id, {
          state: "inactive",
          onProgress: (p) => setStatus(`Loading inactive users… ${Math.round(p)}%`),
        });
        allUsers = [...active, ...inactive];
      } else {
        allUsers = await gc.fetchAllUsers(api, org.id, {
          state: statusVal,
          onProgress: (p) => setStatus(`Loading users… ${Math.round(p)}%`),
        });
      }

      if (!allUsers.length) {
        setStatus("No users found.", "error");
        isRunning = false;
        $loadBtn.disabled = false;
        return;
      }

      // Rebuild source division dropdown from actual data
      const divMap = new Map();
      for (const u of allUsers) {
        if (u.division?.id) divMap.set(u.division.id, u.division.name || u.division.id);
      }
      const previousSrc = $srcDiv.value;
      const srcOpts = [...divMap.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`)
        .join("");
      $srcDiv.innerHTML = `<option value="">(All)</option>` + srcOpts;
      if (previousSrc && divMap.has(previousSrc)) $srcDiv.value = previousSrc;

      $tableSection.style.display = "";
      renderTable();
      setStatus(`Loaded ${allUsers.length} user${allUsers.length !== 1 ? "s" : ""}.`);
    } catch (err) {
      setStatus(`Error loading users: ${err.message}`, "error");
    } finally {
      isRunning = false;
      $loadBtn.disabled = false;
    }
  }

  // ── Apply ─────────────────────────────────────────────
  async function applyMove() {
    const targetId   = $targetDiv.value;
    const targetName = $targetDiv.options[$targetDiv.selectedIndex]?.text || targetId;
    if (!targetId) { setStatus("Please select a target division.", "error"); return; }
    if (selectedIds.size === 0) { setStatus("No users selected.", "error"); return; }

    const toMove = allUsers.filter(u => selectedIds.has(u.id));
    if (!toMove.length) return;

    isRunning = true;
    $applyBtn.disabled  = true;
    $loadBtn.disabled   = true;
    $resultsSection.style.display = "none";

    const results = [];
    let ok = 0, fail = 0;

    for (let i = 0; i < toMove.length; i++) {
      const u = toMove[i];
      showProgress(((i + 1) / toMove.length) * 100);
      setStatus(`Moving ${i + 1} of ${toMove.length}: ${u.name || u.id}…`);

      try {
        // PATCH /users/{id} requires: full version from a fresh GET + full division object (id+name+selfUri)
        const fresh = await gc.getUser(api, org.id, u.id);
        const divObj = divisions.find(d => d.id === targetId) || { id: targetId, name: targetName, selfUri: `/api/v2/authorization/divisions/${targetId}` };
        await gc.updateUserDivision(api, org.id, u.id, divObj, fresh.version);
        u.division = { id: targetId, name: targetName };
        selectedIds.delete(u.id);
        results.push({ user: u, ok: true, detail: `→ ${targetName}` });
        ok++;
      } catch (err) {
        const body = err.body ? JSON.stringify(err.body) : "";
        const msg = `${err.message}${body ? ` | ${body}` : ""}`;
        results.push({ user: u, ok: false, detail: msg });
        fail++;
      }

      if (i < toMove.length - 1) await sleep(100);
    }

    hideProgress();
    setStatus(
      `Done. Moved: ${ok}${fail ? `, Failed: ${fail}` : ""}.`,
      fail ? "error" : "success"
    );

    // Render results
    $resultsTbody.innerHTML = results.map((r, idx) => `<tr>
      <td>${idx + 1}</td>
      <td>${escapeHtml(r.user.name || r.user.id)}</td>
      <td class="${r.ok ? "dv-ok" : "dv-fail"}">${r.ok ? "✓ Moved" : "✗ Failed"}</td>
      <td>${escapeHtml(r.detail)}</td>
    </tr>`).join("");
    $resultsSection.style.display = "";

    renderTable();
    isRunning = false;
    $loadBtn.disabled = false;
    updateApplyBtn();
  }

  // ── Event listeners ───────────────────────────────────
  $loadBtn.addEventListener("click", loadUsers);

  $search.addEventListener("input", () => renderTable());
  $srcDiv.addEventListener("change", () => renderTable());

  $selectAll.addEventListener("change", () => {
    const visible = getVisibleUsers();
    visible.forEach(u => {
      if ($selectAll.checked) selectedIds.add(u.id);
      else                    selectedIds.delete(u.id);
    });
    renderTable();
  });

  $targetDiv.addEventListener("change", () => updateApplyBtn());
  $applyBtn.addEventListener("click", applyMove);

  return el;
}
