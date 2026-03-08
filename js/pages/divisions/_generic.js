/**
 * Divisions — Generic reassignment page.
 *
 * Shared template used by every object-type page under Divisions.
 * Each wrapper file passes a small config object; this module
 * handles all rendering, filtering, selection, moving, and results.
 *
 * @param {{ route, me, api, orgContext }} ctx   Standard page context.
 * @param {{
 *   objectType         : string,                        e.g. "FLOW"
 *   label              : string,                        Display name, e.g. "FLOW"
 *   fetchFn            : (api, orgId, opts) => Promise<Object[]>,
 *   columns            : { header: string, get: (item: Object) => string }[],
 *   searchFn?          : (item: Object, query: string) => boolean,
 *   extraFilters?      : string,   HTML injected after the Search control (left column)
 *   onExtraFilterSetup?: (el: HTMLElement) => void,  called once after render
 *   extraFilterFn?     : (item: Object) => boolean,  additional client-side filter predicate
 *   onItemsLoaded?     : (items: Object[]) => void,  called after allItems is populated
 *   getDivision?       : (item: Object) => {id?: string, name?: string} | null,
 *   setDivision?       : (item: Object, d: {id: string, name: string}) => void,
 * }} cfg
 */
import * as gc from "../../services/genesysApi.js";
import { escapeHtml, sleep } from "../../utils.js";
import { logAction } from "../../services/activityLogService.js";

export default function renderDivisionPage(ctx, cfg) {
  const { api, orgContext, me } = ctx;
  const { objectType, label, fetchFn, columns, searchFn, extraFilters, onExtraFilterSetup,
          extraFilterFn, onItemsLoaded,
          getDivision: _getDivision, setDivision: _setDivision } = cfg;
  const getDivision = _getDivision || (i => i.division);
  const setDivision = _setDivision || ((i, d) => { i.division = d; });

  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h2>Divisions — ${escapeHtml(label)}</h2>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ─────────────────────────────────────────────
  let allItems      = [];
  let divisions     = [];
  let divisionById  = new Map();
  let selectedIds   = new Set();
  let isRunning     = false;
  let tableExpanded = true;

  const colCount = columns.length + 2; // checkbox col + user cols + division col

  // ── Render shell ──────────────────────────────────────
  el.innerHTML = `
    <h2>Divisions — ${escapeHtml(label)}</h2>
    <p class="page-desc">
      Reassign one or more <strong>${escapeHtml(label)}</strong> objects to a different
      division. Load, optionally filter by source division or search by name,
      select the objects to move, then choose a target division and apply.
    </p>

    <div class="dv-top-bar">
      <div class="dv-top-left">
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
          ${extraFilters || ""}
          <div class="di-control-group dv-load-group">
            <label class="di-label">&nbsp;</label>
            <button class="btn" id="dvLoadBtn">Load</button>
          </div>
        </div>
      </div>
      <div class="dv-top-right">
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

    <div class="di-status" id="dvStatusMsg">Select options and click Load.</div>

    <div id="dvTableSection" style="display:none">
      <button class="dv-section-toggle" id="dvToggleBtn" type="button">
        <span class="dv-toggle-icon">▼</span>
        <span id="dvToggleLabel">${escapeHtml(label)}</span>
      </button>
      <div id="dvTableInner">
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
                ${columns.map(c => `<th>${escapeHtml(c.header)}</th>`).join("")}
                <th>Current Division</th>
              </tr>
            </thead>
            <tbody id="dvTbody"></tbody>
          </table>
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
  const $toggleBtn      = el.querySelector("#dvToggleBtn");
  const $toggleLabel    = el.querySelector("#dvToggleLabel");
  const $tableInner     = el.querySelector("#dvTableInner");
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
  function setTableExpanded(expanded) {
    tableExpanded = expanded;
    $tableInner.style.display = expanded ? "" : "none";
    $toggleBtn.querySelector(".dv-toggle-icon").textContent = expanded ? "▼" : "►";
  }

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

  function divName(item) {
    const d = getDivision(item);
    if (!d) return "—";
    return d.name || divisionById.get(d.id)?.name || "—";
  }

  function getVisibleItems() {
    const srcFilter = $srcDiv.value;
    const searchVal = $search.value.trim().toLowerCase();
    return allItems.filter(item => {
      if (srcFilter && getDivision(item)?.id !== srcFilter) return false;
      if (searchVal) {
        const match = searchFn
          ? searchFn(item, searchVal)
          : (item.name || "").toLowerCase().includes(searchVal);
        if (!match) return false;
      }
      if (extraFilterFn && !extraFilterFn(item)) return false;
      return true;
    });
  }

  function updateApplyBtn() {
    $applyBtn.disabled = isRunning || selectedIds.size === 0 || !$targetDiv.value;
  }

  function updateSelectAllCheckbox() {
    const visible = getVisibleItems();
    const visibleSelected = visible.filter(i => selectedIds.has(i.id));
    if (visibleSelected.length === 0) {
      $selectAll.checked = false;
      $selectAll.indeterminate = false;
    } else if (visibleSelected.length === visible.length) {
      $selectAll.checked = true;
      $selectAll.indeterminate = false;
    } else {
      $selectAll.checked = false;
      $selectAll.indeterminate = true;
    }
  }

  function renderTable() {
    const visible = getVisibleItems();
    $selectAllText.textContent = `Select visible (${visible.length})`;

    if (!visible.length) {
      $tbody.innerHTML = `<tr><td colspan="${colCount}" class="dv-empty">No items match the current filter.</td></tr>`;
      updateSelectAllCheckbox();
      updateApplyBtn();
      return;
    }

    $tbody.innerHTML = visible.map(item => {
      const checked = selectedIds.has(item.id) ? "checked" : "";
      return `<tr class="${selectedIds.has(item.id) ? "dv-row-selected" : ""}">
        <td class="dv-col-cb"><input type="checkbox" class="dv-cb" data-id="${escapeHtml(item.id)}" ${checked}></td>
        ${columns.map(c => `<td>${escapeHtml(String(c.get(item) ?? "—"))}</td>`).join("")}
        <td>${escapeHtml(divName(item))}</td>
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

  // ── Extra filter setup hook ─────────────────────────
  if (onExtraFilterSetup) onExtraFilterSetup(el);

  // ── Initial load: divisions ───────────────────────────
  (async () => {
    try {
      divisions = await gc.fetchAllDivisions(api, org.id);
      divisionById = new Map(divisions.map(d => [d.id, d]));
      populateDivisionDropdowns();
    } catch (err) {
      setStatus(`Failed to load divisions: ${err.message}`, "error");
    }
  })();

  // ── Load items ────────────────────────────────────────
  async function loadItems() {
    if (isRunning) return;
    isRunning = true;
    selectedIds.clear();
    $tableSection.style.display = "none";
    $resultsSection.style.display = "none";
    hideProgress();
    setStatus(`Loading ${label}…`);
    $loadBtn.disabled = true;

    try {
      allItems = await fetchFn(api, org.id, {
        onProgress: (n, total) => {
          const info = total ? `${Math.round((n / total) * 100)}%` : `${n} loaded`;
          setStatus(`Loading ${label}… ${info}`);
        },
      });

      allItems.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

      if (!allItems.length) {
        setStatus(`No ${label} found.`, "error");
        isRunning = false;
        $loadBtn.disabled = false;
        return;
      }

      // Rebuild source division dropdown to only show divisions present in the data
      const divMap = new Map();
      for (const item of allItems) {
        const d = getDivision(item);
        if (d?.id) {
          divMap.set(d.id, d.name || divisionById.get(d.id)?.name || d.id);
        }
      }
      const previousSrc = $srcDiv.value;
      const srcOpts = [...divMap.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`)
        .join("");
      $srcDiv.innerHTML = `<option value="">(All)</option>` + srcOpts;
      if (previousSrc && divMap.has(previousSrc)) $srcDiv.value = previousSrc;

      if (onItemsLoaded) onItemsLoaded(allItems);

      $tableSection.style.display = "";
      $toggleLabel.textContent = `${label} (${allItems.length})`;
      setTableExpanded(true);
      renderTable();
      setStatus(`Loaded ${allItems.length} ${label} object${allItems.length !== 1 ? "s" : ""}.`);
    } catch (err) {
      setStatus(`Error loading ${label}: ${err.message}`, "error");
    } finally {
      isRunning = false;
      $loadBtn.disabled = false;
    }
  }

  // ── Apply ─────────────────────────────────────────────
  async function applyMove() {
    const targetId   = $targetDiv.value;
    const targetName = $targetDiv.options[$targetDiv.selectedIndex]?.text || targetId;
    if (!targetId)          { setStatus("Please select a target division.", "error"); return; }
    if (selectedIds.size === 0) { setStatus("No items selected.", "error"); return; }

    const toMove = allItems.filter(i => selectedIds.has(i.id));
    if (!toMove.length) return;

    isRunning = true;
    $applyBtn.disabled = true;
    $loadBtn.disabled  = true;
    $resultsSection.style.display = "none";

    const results = [];
    let ok = 0, fail = 0;

    for (let i = 0; i < toMove.length; i++) {
      const item = toMove[i];
      showProgress(((i + 1) / toMove.length) * 100);
      setStatus(`Moving ${i + 1} of ${toMove.length}: ${item.name || item.id}…`);

      try {
        await gc.moveToDivision(api, org.id, targetId, objectType, [item.id]);
        setDivision(item, { id: targetId, name: targetName });
        selectedIds.delete(item.id);
        results.push({ item, ok: true, detail: `→ ${targetName}` });
        ok++;
      } catch (err) {
        results.push({ item, ok: false, detail: err.message });
        fail++;
      }

      if (i < toMove.length - 1) await sleep(100);
    }

    hideProgress();
    setStatus(
      `Done. Moved: ${ok}${fail ? `, Failed: ${fail}` : ""}.`,
      fail ? "error" : "success"
    );

    const srcDivName = $srcDiv.options[$srcDiv.selectedIndex]?.text || "All";
    logAction({
      me,
      orgId:       org.id,
      orgName:     org.name,
      action:      "division_move",
      description: `Moved ${ok} ${label} from '${srcDivName}' to '${targetName}'${fail ? ` (${fail} failed)` : ""}`,
      result:      ok === 0 ? "failure" : fail > 0 ? "partial" : "success",
      count:       ok + fail,
    });

    $resultsTbody.innerHTML = results.map((r, idx) => `<tr>
      <td>${idx + 1}</td>
      <td>${escapeHtml(r.item.name || r.item.id)}</td>
      <td class="${r.ok ? "dv-ok" : "dv-fail"}">${r.ok ? "✓ Moved" : "✗ Failed"}</td>
      <td>${escapeHtml(r.detail)}</td>
    </tr>`).join("");
    $resultsSection.style.display = "";
    setTableExpanded(false);

    renderTable();
    isRunning = false;
    $loadBtn.disabled = false;
    updateApplyBtn();
  }

  // ── Event listeners ───────────────────────────────────
  $loadBtn.addEventListener("click", loadItems);
  $toggleBtn.addEventListener("click", () => setTableExpanded(!tableExpanded));
  $search.addEventListener("input", () => renderTable());
  $srcDiv.addEventListener("change", () => renderTable());

  $selectAll.addEventListener("change", () => {
    const visible = getVisibleItems();
    visible.forEach(i => {
      if ($selectAll.checked) selectedIds.add(i.id);
      else                    selectedIds.delete(i.id);
    });
    renderTable();
  });

  $targetDiv.addEventListener("change", () => updateApplyBtn());
  $applyBtn.addEventListener("click", applyMove);

  return el;
}
