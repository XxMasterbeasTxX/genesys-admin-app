/**
 * Divisions › Data Tables
 *
 * Reassign one or more data tables to a different division.
 *
 * Flow:
 *   1. Load all data tables for the selected org
 *   2. Filter visible rows client-side by source division and name search
 *   3. Multi-select data tables across any combination of source divisions
 *   4. Pick a target division and apply
 *
 * Note: Genesys requires a full PUT (not PATCH) to update a data table, so each
 * update first fetches the table's complete schema, then PUTs the full object
 * with the new division.
 *
 * API endpoints:
 *   GET  /api/v2/flows/datatables           — list data tables
 *   GET  /api/v2/flows/datatables/{id}      — fetch full table (with schema)
 *   GET  /api/v2/authorization/divisions    — list divisions
 *   PUT  /api/v2/flows/datatables/{id}      — update table (with new division)
 */
import * as gc from "../../services/genesysApi.js";
import { escapeHtml, sleep } from "../../utils.js";

export default function renderDivisionDataTables({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h2>Divisions — Data Tables</h2>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ────────────────────────────────────────────
  let allTables   = [];
  let divisions   = [];
  let selectedIds = new Set();
  let isRunning   = false;

  // ── Render shell ─────────────────────────────────────
  el.innerHTML = `
    <h2>Divisions — Data Tables</h2>
    <p class="page-desc">
      Reassign one or more data tables to a different division. Load data tables,
      optionally filter by source division or search by name, select the ones
      to move, then choose a target division and apply.
    </p>

    <div class="di-controls">
      <div class="di-control-group">
        <label class="di-label">Source Division</label>
        <select class="input dv-filter-select" id="dvSrcDiv">
          <option value="">(All)</option>
        </select>
      </div>
      <div class="di-control-group dv-search-group">
        <label class="di-label">Search</label>
        <input type="text" class="input" id="dvSearch" placeholder="Filter by name…">
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
              <th>Description</th>
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
  const $srcDiv         = el.querySelector("#dvSrcDiv");
  const $search         = el.querySelector("#dvSearch");
  const $loadBtn        = el.querySelector("#dvLoadBtn");
  const $statusMsg      = el.querySelector("#dvStatusMsg");
  const $tableSection   = el.querySelector("#dvTableSection");
  const $selectAll      = el.querySelector("#dvSelectAll");
  const $selectAllText  = el.querySelector("#dvSelectAllText");
  const $selectedCount  = el.querySelector("#dvSelectedCount");
  const $tbody          = el.querySelector("#dvTbody");
  const $targetDiv      = el.querySelector("#dvTargetDiv");
  const $applyBtn       = el.querySelector("#dvApplyBtn");
  const $progressWrap   = el.querySelector("#dvProgressWrap");
  const $progressBar    = el.querySelector("#dvProgressBar");
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

  function getVisibleTables() {
    const srcFilter = $srcDiv.value;
    const searchVal = $search.value.trim().toLowerCase();
    return allTables.filter(t => {
      if (srcFilter && t.division?.id !== srcFilter) return false;
      if (searchVal && !(t.name || "").toLowerCase().includes(searchVal)) return false;
      return true;
    });
  }

  function updateApplyBtn() {
    $applyBtn.disabled = isRunning || selectedIds.size === 0 || !$targetDiv.value;
  }

  function updateSelectAllCheckbox() {
    const visible = getVisibleTables();
    const visibleSelected = visible.filter(t => selectedIds.has(t.id));
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
    const visible = getVisibleTables();
    $selectAllText.textContent = `Select visible (${visible.length})`;

    if (!visible.length) {
      $tbody.innerHTML = `<tr><td colspan="4" class="dv-empty">No data tables match the current filter.</td></tr>`;
      updateSelectAllCheckbox();
      updateApplyBtn();
      return;
    }

    $tbody.innerHTML = visible.map(t => {
      const checked = selectedIds.has(t.id) ? "checked" : "";
      return `<tr class="${selectedIds.has(t.id) ? "dv-row-selected" : ""}">
        <td class="dv-col-cb"><input type="checkbox" class="dv-cb" data-id="${escapeHtml(t.id)}" ${checked}></td>
        <td>${escapeHtml(t.name || "—")}</td>
        <td class="dv-description">${escapeHtml(t.description || "—")}</td>
        <td>${escapeHtml(t.division?.name || "—")}</td>
      </tr>`;
    }).join("");

    $tbody.querySelectorAll(".dv-cb").forEach(cb => {
      cb.addEventListener("change", () => {
        if (cb.checked) selectedIds.add(cb.dataset.id);
        else            selectedIds.delete(cb.dataset.id);
        cb.closest("tr").classList.toggle("dv-row-selected", cb.checked);
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
    $selectedCount.textContent = selectedIds.size > 0 ? `${selectedIds.size} selected` : "";
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

  // ── Load data tables ──────────────────────────────────
  async function loadTables() {
    if (isRunning) return;
    isRunning = true;
    selectedIds.clear();
    $tableSection.style.display = "none";
    $resultsSection.style.display = "none";
    hideProgress();
    setStatus("Loading data tables…");
    $loadBtn.disabled = true;

    try {
      allTables = await gc.fetchAllDataTables(api, org.id, {
        onProgress: (p) => setStatus(`Loading data tables… ${Math.round(p)}%`),
      });

      if (!allTables.length) {
        setStatus("No data tables found.", "error");
        isRunning = false;
        $loadBtn.disabled = false;
        return;
      }

      // Rebuild source division dropdown from actual data
      const divMap = new Map();
      for (const t of allTables) {
        if (t.division?.id) divMap.set(t.division.id, t.division.name || t.division.id);
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
      setStatus(`Loaded ${allTables.length} data table${allTables.length !== 1 ? "s" : ""}.`);
    } catch (err) {
      setStatus(`Error loading data tables: ${err.message}`, "error");
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
    if (selectedIds.size === 0) { setStatus("No data tables selected.", "error"); return; }

    const toMove = allTables.filter(t => selectedIds.has(t.id));
    if (!toMove.length) return;

    isRunning = true;
    $applyBtn.disabled = true;
    $loadBtn.disabled  = true;
    $resultsSection.style.display = "none";

    const results = [];
    let ok = 0, fail = 0;

    for (let i = 0; i < toMove.length; i++) {
      const tbl = toMove[i];
      showProgress(((i + 1) / toMove.length) * 100);
      setStatus(`Moving ${i + 1} of ${toMove.length}: ${tbl.name || tbl.id}…`);

      try {
        // Data tables require a full PUT — fetch current schema first, then update division
        const full = await gc.getDataTable(api, org.id, tbl.id);
        const body = {
          name:     full.name,
          schema:   full.schema,
          division: { id: targetId },
        };
        if (full.description) body.description = full.description;

        await gc.putDataTable(api, org.id, tbl.id, body);
        tbl.division = { id: targetId, name: targetName };
        selectedIds.delete(tbl.id);
        results.push({ tbl, ok: true, detail: `→ ${targetName}` });
        ok++;
      } catch (err) {
        results.push({ tbl, ok: false, detail: err.message });
        fail++;
      }

      if (i < toMove.length - 1) await sleep(200);
    }

    hideProgress();
    setStatus(
      `Done. Moved: ${ok}${fail ? `, Failed: ${fail}` : ""}.`,
      fail ? "error" : "success"
    );

    $resultsTbody.innerHTML = results.map((r, idx) => `<tr>
      <td>${idx + 1}</td>
      <td>${escapeHtml(r.tbl.name || r.tbl.id)}</td>
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
  $loadBtn.addEventListener("click", loadTables);
  $search.addEventListener("input", () => renderTable());
  $srcDiv.addEventListener("change", () => renderTable());

  $selectAll.addEventListener("change", () => {
    const visible = getVisibleTables();
    visible.forEach(t => {
      if ($selectAll.checked) selectedIds.add(t.id);
      else                    selectedIds.delete(t.id);
    });
    renderTable();
  });

  $targetDiv.addEventListener("change", () => updateApplyBtn());
  $applyBtn.addEventListener("click", applyMove);

  return el;
}
