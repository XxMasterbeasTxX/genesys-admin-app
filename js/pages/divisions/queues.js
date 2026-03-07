/**
 * Divisions › Queues
 *
 * Reassign one or more routing queues to a different division.
 *
 * Flow:
 *   1. Load all queues for the selected org
 *   2. Filter visible rows client-side by source division and name search
 *   3. Multi-select queues across any combination of source divisions
 *   4. Pick a target division and apply
 *
 * API endpoints:
 *   GET   /api/v2/routing/queues              — list queues
 *   GET   /api/v2/authorization/divisions     — list divisions
 *   PATCH /api/v2/routing/queues/{id}         — update queue division
 */
import * as gc from "../../services/genesysApi.js";
import { escapeHtml } from "../../utils.js";

export default function renderDivisionQueues({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h2>Divisions — Queues</h2>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ────────────────────────────────────────────
  let allQueues   = [];
  let divisions   = [];
  let selectedIds = new Set();
  let isRunning   = false;

  // ── Render shell ─────────────────────────────────────
  el.innerHTML = `
    <h2>Divisions — Queues</h2>
    <p class="page-desc">
      Reassign one or more routing queues to a different division. Load queues,
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

  function getVisibleQueues() {
    const srcFilter = $srcDiv.value;
    const searchVal = $search.value.trim().toLowerCase();
    return allQueues.filter(q => {
      if (srcFilter && q.division?.id !== srcFilter) return false;
      if (searchVal && !(q.name || "").toLowerCase().includes(searchVal)) return false;
      return true;
    });
  }

  function updateApplyBtn() {
    $applyBtn.disabled = isRunning || selectedIds.size === 0 || !$targetDiv.value;
  }

  function updateSelectAllCheckbox() {
    const visible = getVisibleQueues();
    const visibleSelected = visible.filter(q => selectedIds.has(q.id));
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
    const visible = getVisibleQueues();
    $selectAllText.textContent = `Select visible (${visible.length})`;

    if (!visible.length) {
      $tbody.innerHTML = `<tr><td colspan="3" class="dv-empty">No queues match the current filter.</td></tr>`;
      updateSelectAllCheckbox();
      updateApplyBtn();
      return;
    }

    $tbody.innerHTML = visible.map(q => {
      const checked = selectedIds.has(q.id) ? "checked" : "";
      return `<tr class="${selectedIds.has(q.id) ? "dv-row-selected" : ""}">
        <td class="dv-col-cb"><input type="checkbox" class="dv-cb" data-id="${escapeHtml(q.id)}" ${checked}></td>
        <td>${escapeHtml(q.name || "—")}</td>
        <td>${escapeHtml(q.division?.name || "—")}</td>
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

  // ── Load queues ───────────────────────────────────────
  async function loadQueues() {
    if (isRunning) return;
    isRunning = true;
    selectedIds.clear();
    $tableSection.style.display = "none";
    $resultsSection.style.display = "none";
    hideProgress();
    setStatus("Loading queues…");
    $loadBtn.disabled = true;

    try {
      allQueues = await gc.fetchAllQueues(api, org.id, {
        onProgress: (p) => setStatus(`Loading queues… ${Math.round(p)}%`),
      });

      if (!allQueues.length) {
        setStatus("No queues found.", "error");
        isRunning = false;
        $loadBtn.disabled = false;
        return;
      }

      // Rebuild source division dropdown from actual data (may differ from org-level list)
      const divMap = new Map();
      for (const q of allQueues) {
        if (q.division?.id) divMap.set(q.division.id, q.division.name || q.division.id);
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
      setStatus(`Loaded ${allQueues.length} queue${allQueues.length !== 1 ? "s" : ""}.`);
    } catch (err) {
      setStatus(`Error loading queues: ${err.message}`, "error");
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
    if (selectedIds.size === 0) { setStatus("No queues selected.", "error"); return; }

    const toMove = allQueues.filter(q => selectedIds.has(q.id));
    if (!toMove.length) return;

    isRunning = true;
    $applyBtn.disabled = true;
    $loadBtn.disabled  = true;
    $resultsSection.style.display = "none";

    setStatus(`Moving ${toMove.length} queue${toMove.length !== 1 ? "s" : ""}…`);
    showProgress(30);

    try {
      // Batch move — single API call for all selected queues
      await gc.moveToDivision(api, org.id, targetId,
        toMove.map(q => ({ id: q.id, type: "QUEUE" })));

      showProgress(100);

      // Update local state
      toMove.forEach(q => {
        q.division = { id: targetId, name: targetName };
        selectedIds.delete(q.id);
      });

      setStatus(`Done. Moved ${toMove.length} queue${toMove.length !== 1 ? "s" : ""} to ${targetName}.`, "success");

      $resultsTbody.innerHTML = toMove.map((q, idx) => `<tr>
        <td>${idx + 1}</td>
        <td>${escapeHtml(q.name || q.id)}</td>
        <td class="dv-ok">✓ Moved</td>
        <td>→ ${escapeHtml(targetName)}</td>
      </tr>`).join("");

    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");

      $resultsTbody.innerHTML = toMove.map((q, idx) => `<tr>
        <td>${idx + 1}</td>
        <td>${escapeHtml(q.name || q.id)}</td>
        <td class="dv-fail">✗ Failed</td>
        <td>${escapeHtml(err.message)}</td>
      </tr>`).join("");
    }

    $resultsSection.style.display = "";
    hideProgress();
    renderTable();
    isRunning = false;
    $loadBtn.disabled = false;
    updateApplyBtn();
  }

  // ── Event listeners ───────────────────────────────────
  $loadBtn.addEventListener("click", loadQueues);
  $search.addEventListener("input", () => renderTable());
  $srcDiv.addEventListener("change", () => renderTable());

  $selectAll.addEventListener("change", () => {
    const visible = getVisibleQueues();
    visible.forEach(q => {
      if ($selectAll.checked) selectedIds.add(q.id);
      else                    selectedIds.delete(q.id);
    });
    renderTable();
  });

  $targetDiv.addEventListener("change", () => updateApplyBtn());
  $applyBtn.addEventListener("click", applyMove);

  return el;
}
