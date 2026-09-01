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
 * @param {boolean}     [opts.sortable]    - Click a header to sort by that column.
 *                                           OFF by default, so the eight pages that
 *                                           already use this keep the behaviour they shipped with.
 * @param {number[]}    [opts.numericCols] - Columns to compare as numbers when sorting.
 *                                           Only meaningful with `sortable`.
 * @param {boolean}     [opts.compact]     - Put the filter control IN the header cell
 *                                           instead of a second row, so the column is
 *                                           named once. Needs no `ll-filter-row`.
 * @param {Function}    [opts.onChange]    - Called with the rows still visible after every
 *                                           filter or sort. Lets a caller layer its own
 *                                           paging on top without duplicating the state.
 * @param {number[]}    [opts.rangeCols]   - Columns filtered by a numeric FROM/TO range
 *                                           instead of a list of values. For a measured
 *                                           quantity - a score, a duration, a count - the
 *                                           distinct values are nearly as many as the rows,
 *                                           and a hundred checkboxes is not a control.
 * @returns {Function} cleanup — removes global listeners; call when table is destroyed.
 */
export function attachColumnFilters(tableWrap, opts = {}) {
  const table = tableWrap.querySelector("table");
  if (!table) return () => {};

  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  if (!thead || !tbody) return () => {};

  const headerRow = thead.querySelector("tr:first-child");
  // In compact mode the header row IS the filter row: the control goes inside
  // the cell that already names the column, so the name is not printed twice.
  const filterRow = opts.compact ? headerRow : thead.querySelector("tr.ll-filter-row");
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

  const rangeCols = new Set(opts.rangeCols || []);

  /** A cell's numeric value, or null when it holds no number. */
  function cellNumber(tr, colIdx) {
    const raw = (tr.querySelectorAll("td")[colIdx]?.textContent || "").trim();
    if (!raw) return null;
    const n = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
    return Number.isNaN(n) ? null : n;
  }

  // Build sorted unique value lists per filterable column
  /** @type {Record<number, string[]>} */
  const colValues = {};
  for (const colIdx of colsToFilter) {
    if (rangeCols.has(colIdx)) { colValues[colIdx] = []; continue; }
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
    const label  = (headerCells[colIdx]?.dataset.label
      || headerCells[colIdx]?.textContent || "").trim();

    // Toggle button shown in the filter row cell
    const btn = document.createElement("button");
    btn.type      = "button";
    btn.className = opts.compact ? "cf-btn cf-btn--compact" : "cf-btn";
    btn.title     = `Filter ${label}`;
    btn.innerHTML = opts.compact
      ? `<span class="cf-caret">▼</span>`
      : `<span class="cf-btn-label">${label || "▼"}</span>` +
        `<span class="cf-caret">▼</span>`;
    // In compact mode the cell is also the sort target, so the filter must not
    // sort the table on its way to opening the dropdown.
    if (opts.compact) btn.addEventListener("click", (e) => e.stopPropagation());

    // Floating dropdown panel
    const panel = document.createElement("div");
    panel.className = "cf-dropdown";

    if (rangeCols.has(colIdx)) {
      if (opts.compact) panel.addEventListener("click", (e) => e.stopPropagation());
      const nums = allDataRows.map((tr) => cellNumber(tr, colIdx)).filter((n) => n != null);
      const lo = nums.length ? Math.min(...nums) : 0;
      const hi = nums.length ? Math.max(...nums) : 0;
      panel.classList.add("cf-dropdown--range");
      panel.innerHTML = `
        <div class="cf-range">
          <label>From <input class="cf-range-min" type="number" placeholder="${lo}"></label>
          <label>To <input class="cf-range-max" type="number" placeholder="${hi}"></label>
        </div>
        <div class="cf-actions">
          <button type="button" class="cf-action-btn cf-range-clear">Clear</button>
        </div>
        <div class="cf-range-hint">Rows with no value are hidden while a range is set.</div>`;

      const minEl = panel.querySelector(".cf-range-min");
      const maxEl = panel.querySelector(".cf-range-max");

      const applyRange = ((ci) => () => {
        const min = minEl.value === "" ? null : Number(minEl.value);
        const max = maxEl.value === "" ? null : Number(maxEl.value);
        activeFilters[ci] = (min == null && max == null) ? undefined : { min, max };
        if (activeFilters[ci] === undefined) delete activeFilters[ci];
        syncButton(ci);
        applyFilters();
      })(colIdx);

      minEl.addEventListener("input", applyRange);
      maxEl.addEventListener("input", applyRange);
      for (const el of [minEl, maxEl]) el.addEventListener("click", (e) => e.stopPropagation());
      panel.querySelector(".cf-range-clear").addEventListener("click", (e) => {
        // The panel lives inside the header cell, which sorts on click.
        e.stopPropagation();
        minEl.value = "";
        maxEl.value = "";
        applyRange();
      });

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasOpen = panel.classList.contains("open");
        if (openDropdown && openDropdown !== panel) openDropdown.classList.remove("open");
        panel.classList.toggle("open", !wasOpen);
        openDropdown = wasOpen ? null : panel;
        if (!wasOpen) requestAnimationFrame(() => minEl.focus());
      });

      th.append(btn, panel);
      btnMap[colIdx] = btn;
      continue;
    }

    panel.innerHTML = `
      <input class="cf-search" type="text" placeholder="Search values…" />
      <div class="cf-actions">
        <button type="button" class="cf-action-btn cf-all">All</button>
        <button type="button" class="cf-action-btn cf-none">None</button>
      </div>
      <div class="cf-list"></div>`;

    if (opts.compact) panel.addEventListener("click", (e) => e.stopPropagation());

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

      for (const [idxStr, sel] of activeEntries) {
        const colIdx = +idxStr;
        if (sel instanceof Set) {
          const cellVal = (cells[colIdx]?.textContent || "").trim();
          if (!sel.has(cellVal)) { match = false; break; }
        } else {
          // A range. A row with no number in that column cannot satisfy a
          // numeric bound, so it drops out — said in the panel rather than
          // left for the reader to deduce from a shorter table.
          const n = cellNumber(tr, colIdx);
          if (n == null) { match = false; break; }
          if (sel.min != null && n < sel.min) { match = false; break; }
          if (sel.max != null && n > sel.max) { match = false; break; }
        }
      }

      tr.style.display = match ? "" : "none";
      if (match) visible++;
    }

    if (countEl) {
      const filtered = Object.keys(activeFilters).length > 0;
      countEl.textContent = filtered
        ? `${visible} / ${totalCount} ${totalLabel}`
        : `${totalCount} ${totalLabel}`;
    }

    opts.onChange?.(allDataRows.filter((tr) => tr.style.display !== "none"));
  }

  function syncButton(colIdx) {
    const btn      = btnMap[colIdx];
    const isActive = activeFilters[colIdx] != null;
    btn?.classList.toggle("cf-btn--active", isActive);
  }

  // ── Sorting (opt-in) ────────────────────────────────────────────────────────
  //
  // Sorts the rows the table is HOLDING, which for a server-paged table is one
  // page. That is the same scope the filters above work at, and the two staying
  // consistent is what makes the count line honest — a header that silently
  // reordered only a quarter of the matches would be worse than no header.
  if (opts.sortable) {
    const numeric = new Set(opts.numericCols || []);
    let sortCol = null;
    let sortAsc = true;

    /** Text of a cell, as a number when the column is numeric. */
    function cellKey(tr, colIdx) {
      const raw = (tr.querySelectorAll("td")[colIdx]?.textContent || "").trim();
      if (!numeric.has(colIdx)) return raw.toLowerCase();
      // Strip anything that is not part of a number — "50.0%" and
      // "1,284 eval(s)" both have a number in them worth sorting by.
      const n = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
      return Number.isNaN(n) ? -Infinity : n;
    }

    function applySort() {
      if (sortCol == null) return;
      const rows = Array.from(tbody.querySelectorAll("tr"));
      rows.sort((a, b) => {
        const ka = cellKey(a, sortCol);
        const kb = cellKey(b, sortCol);
        if (ka < kb) return sortAsc ? -1 : 1;
        if (ka > kb) return sortAsc ? 1 : -1;
        return 0;
      });
      for (const tr of rows) tbody.append(tr);
      // Re-run the filters rather than reporting whatever is on screen. A
      // caller that pages the rows has hidden most of them, and handing back
      // only the visible ones would shrink its idea of the match to a single
      // page every time a column was sorted.
      applyFilters();
    }

    headerCells.forEach((th, colIdx) => {
      th.classList.add("cf-sortable");
      if (!th.dataset.label) th.dataset.label = (th.textContent || "").trim();
      th.tabIndex = 0;
      th.setAttribute("role", "button");
      const mark = document.createElement("span");
      mark.className = "cf-sort-mark";
      th.append(mark);

      const toggle = () => {
        if (sortCol === colIdx) sortAsc = !sortAsc;
        else { sortCol = colIdx; sortAsc = true; }
        for (const other of headerCells) {
          const m = other.querySelector(".cf-sort-mark");
          if (m) m.textContent = "";
          other.classList.remove("cf-sorted");
        }
        mark.textContent = sortAsc ? " ▲" : " ▼";
        th.classList.add("cf-sorted");
        applySort();
      };

      th.addEventListener("click", toggle);
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });
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
