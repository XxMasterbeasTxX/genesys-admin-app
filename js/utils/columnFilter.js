/**
 * Dropdown multi-select column filters for preview tables.
 *
 * Usage:
 *   After rendering a <table> with a `<tr class="ll-filter-row">` in the thead,
 *   call attachColumnFilters(wrapperEl, opts) to wire up dropdown filters.
 *
 * The <tr class="ll-filter-row"> must contain one <th> per column (matching the
 * header row). Each filterable <th> gets a button + floating dropdown injected.
 *
 * @param {HTMLElement} tableWrap  - The element containing the <table>
 * @param {object}      [opts]
 * @param {number[]}    [opts.filterCols]  - Explicit list of col indices to filter.
 *                                           If omitted, all columns are filterable.
 * @param {number[]}    [opts.skipCols]    - Col indices to skip (used when filterCols absent).
 * @param {HTMLElement} [opts.countEl]     - Span to rewrite with visible/total count.
 * @param {string}      [opts.totalLabel]  - Label appended to count, e.g. "rows" or "roles".
 * @returns {Function} cleanup — removes global listeners; call when table is destroyed.
 */
export function attachColumnFilters(tableWrap, opts = {}) {
  const table = tableWrap.querySelector("table");
  if (!table) return () => {};

  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  if (!thead || !tbody) return () => {};

  const headerRow = thead.querySelector("tr:first-child");
  const filterRow = thead.querySelector("tr.ll-filter-row");
  if (!headerRow || !filterRow) return () => {};

  const headerCells = Array.from(headerRow.querySelectorAll("th"));
  const filterCells = Array.from(filterRow.querySelectorAll("th"));
  const totalCols   = headerCells.length;

  // Determine which columns get filters
  let colsToFilter;
  if (opts.filterCols) {
    colsToFilter = new Set(opts.filterCols);
  } else {
    const skip = new Set(opts.skipCols || []);
    colsToFilter = new Set([...Array(totalCols).keys()].filter(i => !skip.has(i)));
  }

  // Resolve count display element
  const countEl    = opts.countEl ?? tableWrap.querySelector(".te-user-count");
  const totalLabel = opts.totalLabel ?? "rows";

  // Collect all data rows
  const allDataRows = Array.from(tbody.querySelectorAll("tr"));
  const totalCount  = allDataRows.length;

  // Build sorted unique value lists per filterable column
  /** @type {Record<number, string[]>} */
  const colValues = {};
  for (const colIdx of colsToFilter) {
    const vals = new Set();
    for (const tr of allDataRows) {
      const td = tr.querySelectorAll("td")[colIdx];
      if (td) vals.add(td.textContent.trim());
    }
    colValues[colIdx] = [...vals].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
  }

  // Active filter state: colIdx → Set of selected values (undefined = all selected)
  /** @type {Record<number, Set<string> | undefined>} */
  const activeFilters = {};

  let openDropdown = null;

  /** @type {Record<number, HTMLButtonElement>} */
  const btnMap = {};

  // ── Inject a button + dropdown panel into each filterable <th> ─────────────
  for (const colIdx of colsToFilter) {
    const th = filterCells[colIdx];
    if (!th) continue;

    th.classList.add("cf-th");

    const values = colValues[colIdx];
    const label  = (headerCells[colIdx]?.textContent || "").trim();

    // Toggle button shown in the filter row cell
    const btn = document.createElement("button");
    btn.type      = "button";
    btn.className = "cf-btn";
    btn.title     = label;
    btn.innerHTML =
      `<span class="cf-btn-label">${label || "▼"}</span>` +
      `<span class="cf-caret">▼</span>`;

    // Floating dropdown panel
    const panel = document.createElement("div");
    panel.className = "cf-dropdown";
    panel.innerHTML = `
      <input class="cf-search" type="text" placeholder="Search values…" />
      <div class="cf-actions">
        <button type="button" class="cf-action-btn cf-all">All</button>
        <button type="button" class="cf-action-btn cf-none">None</button>
      </div>
      <div class="cf-list"></div>`;

    const searchInput = panel.querySelector(".cf-search");
    const listEl      = panel.querySelector(".cf-list");

    /** Rebuild the checkbox list, optionally filtered by search term. */
    function rebuildList(panelColIdx, searchTerm = "") {
      const panelValues    = colValues[panelColIdx];
      const panelListEl    = panel.querySelector(".cf-list");
      const panelActiveSet = activeFilters[panelColIdx];
      const term           = searchTerm.toLowerCase();

      panelListEl.innerHTML = "";

      for (const val of panelValues) {
        if (term && !val.toLowerCase().includes(term)) continue;

        const selected = panelActiveSet == null || panelActiveSet.has(val);

        const item = document.createElement("label");
        item.className = "cf-item";

        const cb  = document.createElement("input");
        cb.type   = "checkbox";
        cb.value  = val;
        cb.checked = selected;

        cb.addEventListener("change", () => {
          // On first change, materialise the Set from all values
          if (activeFilters[panelColIdx] == null) {
            activeFilters[panelColIdx] = new Set(colValues[panelColIdx]);
          }
          if (cb.checked) activeFilters[panelColIdx].add(val);
          else             activeFilters[panelColIdx].delete(val);

          // If full set selected → treat as "no filter"
          if (activeFilters[panelColIdx].size === colValues[panelColIdx].length) {
            delete activeFilters[panelColIdx];
          }

          applyFilters();
          syncButton(panelColIdx);
        });

        const span       = document.createElement("span");
        span.className   = "cf-item-label";
        span.textContent = val || "(empty)";

        item.append(cb, span);
        panelListEl.appendChild(item);
      }
    }

    // Close-over colIdx for each dropdown's listeners
    ;(function(ci) {
      rebuildList(ci);

      searchInput.addEventListener("input", () => rebuildList(ci, searchInput.value));

      panel.querySelector(".cf-all").addEventListener("click", () => {
        delete activeFilters[ci];
        applyFilters();
        syncButton(ci);
        rebuildList(ci, searchInput.value);
      });

      panel.querySelector(".cf-none").addEventListener("click", () => {
        activeFilters[ci] = new Set();
        applyFilters();
        syncButton(ci);
        rebuildList(ci, searchInput.value);
      });

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (openDropdown && openDropdown !== panel) {
          openDropdown.classList.remove("open");
        }
        panel.classList.toggle("open");
        openDropdown = panel.classList.contains("open") ? panel : null;
        if (panel.classList.contains("open")) {
          searchInput.value = "";
          rebuildList(ci);
          searchInput.focus();
        }
      });
    }(colIdx));

    th.append(btn, panel);
    btnMap[colIdx] = btn;
  }

  // ── Filter application ──────────────────────────────────────────────────────
  function applyFilters() {
    const activeEntries = Object.entries(activeFilters);
    let visible = 0;

    for (const tr of allDataRows) {
      const cells = Array.from(tr.querySelectorAll("td"));
      let match = true;

      for (const [idxStr, selected] of activeEntries) {
        const cellVal = (cells[+idxStr]?.textContent || "").trim();
        if (!selected.has(cellVal)) { match = false; break; }
      }

      tr.style.display = match ? "" : "none";
      if (match) visible++;
    }

    if (countEl) {
      const hasFilter = activeEntries.some(([, s]) => s.size > 0 || s.size === 0);
      const filtered  = Object.keys(activeFilters).length > 0;
      countEl.textContent = filtered
        ? `${visible} / ${totalCount} ${totalLabel}`
        : `${totalCount} ${totalLabel}`;
    }
  }

  function syncButton(colIdx) {
    const btn      = btnMap[colIdx];
    const isActive = activeFilters[colIdx] != null;
    btn?.classList.toggle("cf-btn--active", isActive);
  }

  // ── Close dropdown on outside click ────────────────────────────────────────
  function onDocClick(e) {
    if (!openDropdown) return;
    if (openDropdown.contains(e.target)) return;
    if (e.target.closest(".cf-btn")) return;
    openDropdown.classList.remove("open");
    openDropdown = null;
  }
  document.addEventListener("click", onDocClick);

  return () => document.removeEventListener("click", onDocClick);
}
