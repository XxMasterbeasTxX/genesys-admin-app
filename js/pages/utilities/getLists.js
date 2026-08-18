/**
 * Utilities — Get Lists
 *
 * One page for the small reference lists an org keeps in Genesys: pick a list,
 * see it, filter it, export it. Read-only — nothing is written back.
 *
 * Adding a list means adding one entry to LIST_DEFS below. Everything else
 * (fetching, table, column filters, sorting, Excel export) is generic and
 * already written, so a new list is a fetch function plus its columns.
 *
 * Each definition supplies:
 *   key        id used by the picker
 *   label      what the picker shows
 *   desc       one line under the heading, HTML
 *   filePrefix leading part of the exported filename
 *   sheetName  worksheet name in the workbook
 *   unit       what a row is, for the "N rows" count
 *   columns    [{ key, label, wch }] — drives the table AND the workbook
 *   fetch      async (api, orgId) => row objects keyed by column.key
 */
import { escapeHtml, exportXlsx, timestampedFilename } from "../../utils.js";
import { orgContext } from "../../services/orgContext.js";

// ── Presence definitions ──────────────────────────────────────────────
/**
 * GET /api/v2/presence/definitions
 *
 * Not paginated — the response is { total, entities } in one go.
 *
 * `languageLabels` is a locale → label map, so a definition holding 12
 * translations becomes 12 rows. That is deliberate: one row per language keeps
 * every cell a plain string, which is what the column filters and Excel both
 * want. `localeCode=ALL` is what makes the full map come back rather than a
 * single locale.
 *
 * The `deactivated` parameter is a filter, and the API does not document what
 * the unfiltered call returns, so the deactivated ones are fetched separately
 * and merged by id. Merging by id keeps it correct either way: if the plain
 * call already includes them, the second pass adds nothing. It is best-effort —
 * a failure there still leaves the main list intact.
 */
async function fetchPresenceDefinitions(api, orgId) {
  const query = { localeCode: "ALL" };
  const byId = new Map();

  const collect = (resp) => {
    for (const e of resp?.entities || []) {
      if (e?.id) byId.set(e.id, e);
    }
  };

  collect(await api.proxyGenesys(orgId, "GET", "/api/v2/presence/definitions", { query }));

  try {
    collect(await api.proxyGenesys(orgId, "GET", "/api/v2/presence/definitions", {
      query: { ...query, deactivated: "TRUE" },
    }));
  } catch (err) {
    console.warn("[getLists] deactivated presence definitions unavailable:", err);
  }

  const rows = [];
  for (const e of byId.values()) {
    const base = {
      systemPresence: e.systemPresence || "",
      type: e.type || "",
      deactivated: e.deactivated ? "Yes" : "No",
      id: e.id || "",
      divisionId: e.divisionId || "",
    };
    const labels = e.languageLabels || {};
    const locales = Object.keys(labels).sort();
    if (!locales.length) {
      rows.push({ ...base, language: "", label: "" });
      continue;
    }
    for (const loc of locales) {
      rows.push({ ...base, language: loc, label: labels[loc] ?? "" });
    }
  }

  rows.sort((a, b) =>
    a.systemPresence.localeCompare(b.systemPresence) ||
    a.language.localeCompare(b.language)
  );
  return rows;
}

// ── The registry ──────────────────────────────────────────────────────
const LIST_DEFS = [
  {
    key: "presence-definitions",
    label: "Presence Definitions",
    desc: `Every presence definition in the org with all of its language labels —
           one row per language. Source: <code>GET /api/v2/presence/definitions</code>.`,
    filePrefix: "Presence_Definitions",
    sheetName: "Presence Definitions",
    unit: "rows",
    columns: [
      { key: "systemPresence", label: "System Presence", wch: 18 },
      { key: "language",       label: "Language",        wch: 12 },
      { key: "label",          label: "Label",           wch: 32 },
      { key: "type",           label: "Type",            wch: 10 },
      { key: "deactivated",    label: "Deactivated",     wch: 13 },
      { key: "id",             label: "ID",              wch: 38 },
      { key: "divisionId",     label: "Division ID",     wch: 38 },
    ],
    fetch: fetchPresenceDefinitions,
  },
];

// ── Scoped styles ─────────────────────────────────────────────────────
const PAGE_STYLES = `
.gl-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.gl-picker { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 12px; align-items: flex-end; }
.gl-status { font-size: 13px; color: var(--muted); margin: 12px 0; }
.gl-status--error { color: #f87171; }
.gl-desc { font-size: 13px; color: var(--muted); margin: 8px 0 12px; }
.gl-actions-row { display: flex; gap: 8px; margin: 8px 0 12px; flex-wrap: wrap; align-items: center; }
.gl-empty { padding: 20px; text-align: center; color: var(--muted); font-size: 13px; }

/* Capped height rather than the shared .te-table-scroll, which only scrolls
   horizontally: one presence definition per language runs to a few hundred
   rows, and the header has to stay reachable while you scroll them.
   One header row only — the sort label and the filter button share the cell,
   so there is no second band under it. --panel rather than a literal colour,
   so the sticky header follows the light/dark theme like everything else. */
.gl-table-wrap { max-height: 62vh; overflow: auto; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 16px; }
.gl-table { width: 100%; }
.gl-table thead th {
  position: sticky; top: 0; z-index: 2;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.gl-th-inner { display: flex; align-items: center; gap: 6px; }
.gl-th-label { cursor: pointer; user-select: none; white-space: nowrap; }
.gl-th-label:hover { color: var(--text); }
.gl-arrow { font-size: 9px; opacity: 0.7; }
.gl-filter-btn { margin-left: auto; padding: 1px 5px; }

/* "Only" narrows to a single value in one click. Ticking 24 languages off by
   hand to see one of them is the thing this exists to avoid. */
.gl-item { display: flex; align-items: center; gap: 6px; }
.gl-item .cf-item-label { flex: 1; }
.gl-only {
  border: none; background: transparent; color: var(--muted);
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
  cursor: pointer; padding: 1px 4px; border-radius: 3px; opacity: 0.45;
}
.gl-item:hover .gl-only { opacity: 1; }
.gl-only:hover { color: #60a5fa; background: rgba(59,130,246,0.12); }
.gl-filter-empty { padding: 8px 4px; font-size: 12px; color: var(--muted); }
`;

// ── Per-column dropdown filters ───────────────────────────────────────
/**
 * Filters built into the header cells themselves.
 *
 * The shared `attachColumnFilters` needs a second `<tr>` to put its buttons in,
 * which gives every table two header bands. Here the sort label and the filter
 * button share one cell, so the header stays a single line.
 *
 * Rows are hidden with `style.display`, which is what lets sorting reorder the
 * row nodes without disturbing the filter (see applySort).
 *
 * Reuses the app's `cf-*` dropdown styles so it looks like the filters on the
 * export previews, and adds an "Only" action per value: narrowing to one or two
 * of twenty-odd languages is the common case, and unticking the other twenty by
 * hand is not a reasonable way to get there.
 *
 * @param {HTMLElement} wrap      element containing the table
 * @param {Function}    onChange  (visible, total, isFiltered) after every change
 * @returns {Function}  cleanup — detaches the document listener
 */
function attachHeaderFilters(wrap, onChange) {
  const table = wrap.querySelector("table");
  const tbody = table?.querySelector("tbody");
  if (!table || !tbody) return () => {};

  const headerCells = Array.from(table.querySelectorAll("thead th"));
  const dataRows = Array.from(tbody.querySelectorAll("tr"));
  const cellText = (tr, i) => (tr.children[i]?.textContent || "").trim();

  // Distinct values per column, collected once from the rendered rows.
  const colValues = headerCells.map((_, i) => {
    const vals = new Set();
    for (const tr of dataRows) vals.add(cellText(tr, i));
    return [...vals].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );
  });

  // colIdx → Set of kept values. Absent means "no filter on this column",
  // which is not the same as a full Set: it keeps the button un-highlighted.
  const active = {};
  let openPanel = null;
  let openTh = null;

  function apply() {
    const entries = Object.entries(active);
    let visible = 0;
    for (const tr of dataRows) {
      let match = true;
      for (const [idx, kept] of entries) {
        if (!kept.has(cellText(tr, +idx))) { match = false; break; }
      }
      tr.style.display = match ? "" : "none";
      if (match) visible++;
    }
    onChange?.(visible, dataRows.length, entries.length > 0);
  }

  function closePanel() {
    if (!openPanel) return;
    openPanel.classList.remove("open");
    // Raised while open so the panel is never covered by a later sticky cell.
    if (openTh) openTh.style.zIndex = "";
    openPanel = null;
    openTh = null;
  }

  headerCells.forEach((th, colIdx) => {
    th.classList.add("cf-th");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cf-btn gl-filter-btn";
    btn.title = "Filter this column";
    btn.innerHTML = `<span class="cf-caret">▼</span>`;

    const panel = document.createElement("div");
    panel.className = "cf-dropdown";
    panel.innerHTML = `
      <input class="cf-search" type="text" placeholder="Search values…">
      <div class="cf-actions">
        <button type="button" class="cf-action-btn cf-all">All</button>
        <button type="button" class="cf-action-btn cf-none">None</button>
      </div>
      <div class="cf-list"></div>`;

    const search = panel.querySelector(".cf-search");
    const list = panel.querySelector(".cf-list");

    function syncButton() {
      const on = active[colIdx] != null;
      btn.classList.toggle("cf-btn--active", on);
      btn.title = on
        ? `Filtered to ${active[colIdx].size} of ${colValues[colIdx].length} values`
        : "Filter this column";
    }

    /** Set the filter to exactly `set`, collapsing "everything" back to no filter. */
    function setKept(set) {
      if (set && set.size === colValues[colIdx].length) delete active[colIdx];
      else active[colIdx] = set;
      apply();
      syncButton();
    }

    function rebuild() {
      const term = search.value.trim().toLowerCase();
      const kept = active[colIdx];
      const shown = colValues[colIdx].filter((v) => !term || v.toLowerCase().includes(term));
      list.innerHTML = "";

      if (!shown.length) {
        list.innerHTML = `<div class="gl-filter-empty">No matching values.</div>`;
        return;
      }

      for (const val of shown) {
        const item = document.createElement("label");
        item.className = "cf-item gl-item";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = kept == null || kept.has(val);
        cb.addEventListener("change", () => {
          // Materialise from the full value list on the first tick, so
          // unticking one value keeps the other twenty.
          const next = new Set(active[colIdx] ?? colValues[colIdx]);
          if (cb.checked) next.add(val); else next.delete(val);
          setKept(next);
        });

        const label = document.createElement("span");
        label.className = "cf-item-label";
        label.textContent = val || "(empty)";

        const only = document.createElement("button");
        only.type = "button";
        only.className = "gl-only";
        only.textContent = "only";
        only.title = `Show only ${val || "(empty)"}`;
        only.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          setKept(new Set([val]));
          rebuild();
        });

        item.append(cb, label, only);
        list.appendChild(item);
      }
    }

    panel.querySelector(".cf-all").addEventListener("click", () => {
      delete active[colIdx];
      apply();
      syncButton();
      rebuild();
    });

    panel.querySelector(".cf-none").addEventListener("click", () => {
      active[colIdx] = new Set();
      apply();
      syncButton();
      rebuild();
    });

    search.addEventListener("input", rebuild);

    // The cell itself sorts, so nothing inside the filter may reach it.
    panel.addEventListener("click", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = panel.classList.contains("open");
      closePanel();
      if (wasOpen) return;
      search.value = "";
      rebuild();
      panel.classList.add("open");
      th.style.zIndex = "400";
      openPanel = panel;
      openTh = th;
      search.focus();
    });

    th.querySelector(".gl-th-inner").append(btn);
    th.appendChild(panel);
    syncButton();
  });

  function onDocClick(e) {
    if (!openPanel || openPanel.contains(e.target) || e.target.closest(".gl-filter-btn")) return;
    closePanel();
  }
  function onKey(e) { if (e.key === "Escape") closePanel(); }
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);

  apply();
  return () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };
}

// ── Page renderer ─────────────────────────────────────────────────────
export default async function renderGetLists(ctx = {}) {
  const { api } = ctx;
  const el = document.createElement("section");
  el.className = "card";

  const styleTag = document.createElement("style");
  styleTag.textContent = PAGE_STYLES;
  el.appendChild(styleTag);

  el.insertAdjacentHTML("beforeend", `
    <div class="gl-header">
      <div>
        <h2 class="h2">Get Lists</h2>
        <p class="page-desc">
          Fetches a reference list from the selected org, shows it here and exports it
          to Excel. Read-only — nothing is changed in Genesys.
        </p>
      </div>
      <div><button class="btn" id="glRefreshBtn">Refresh</button></div>
    </div>

    <hr class="hr">

    <div class="gl-picker">
      <div class="di-control-group" style="min-width: 280px;">
        <label class="di-label" for="glListSelect">List</label>
        <select class="input" id="glListSelect">
          ${LIST_DEFS.map((d) => `<option value="${escapeHtml(d.key)}">${escapeHtml(d.label)}</option>`).join("")}
        </select>
      </div>
    </div>

    <p class="gl-desc" id="glDesc"></p>
    <p class="gl-status" id="glStatus">Loading…</p>

    <div class="gl-actions-row" id="glActionsRow" style="display:none">
      <button class="btn" id="glExportBtn">Export to Excel</button>
      <span class="te-user-count" id="glCount"></span>
    </div>

    <div id="glResults"></div>
  `);

  // ── DOM refs ─────────────────────────────────────────
  const $select  = el.querySelector("#glListSelect");
  const $desc    = el.querySelector("#glDesc");
  const $status  = el.querySelector("#glStatus");
  const $results = el.querySelector("#glResults");
  const $actions = el.querySelector("#glActionsRow");
  const $count   = el.querySelector("#glCount");
  const $refresh = el.querySelector("#glRefreshBtn");
  const $export  = el.querySelector("#glExportBtn");

  // ── State ────────────────────────────────────────────
  let currentDef = LIST_DEFS[0];
  let allRows = [];
  let sortKey = null;
  let sortDir = "asc";
  let detachFilters = null;

  function setStatus(msg, kind) {
    $status.textContent = msg;
    $status.className = "gl-status" + (kind === "error" ? " gl-status--error" : "");
    $status.style.display = msg ? "block" : "none";
  }

  function clearTable() {
    detachFilters?.();
    detachFilters = null;
    $results.innerHTML = "";
  }

  /** Rows still visible after the column filters, in the order shown. */
  function visibleRows() {
    const tbody = $results.querySelector("tbody");
    if (!tbody) return [];
    return Array.from(tbody.querySelectorAll("tr"))
      .filter((tr) => tr.style.display !== "none")
      .map((tr) => allRows[+tr.dataset.i])
      .filter(Boolean);
  }

  /**
   * Sort by reordering the existing <tr> nodes rather than re-rendering.
   * attachHeaderFilters hides rows by setting style.display on the nodes it
   * captured at attach time, so moving those same nodes keeps both the active
   * filters and the dropdowns they live in intact.
   */
  function applySort() {
    const tbody = $results.querySelector("tbody");
    if (!tbody || !sortKey) return;
    const dir = sortDir === "asc" ? 1 : -1;
    const trs = Array.from(tbody.querySelectorAll("tr"));
    trs.sort((a, b) => {
      const ra = allRows[+a.dataset.i] || {};
      const rb = allRows[+b.dataset.i] || {};
      return dir * String(ra[sortKey] ?? "").localeCompare(
        String(rb[sortKey] ?? ""), undefined, { numeric: true, sensitivity: "base" }
      );
    });
    tbody.append(...trs);
    $results.querySelectorAll("th[data-sort]").forEach((th) => {
      const arrow = th.querySelector(".gl-arrow");
      if (arrow) arrow.textContent = th.dataset.sort === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "";
    });
  }

  function render() {
    clearTable();

    const cols = currentDef.columns;
    if (!allRows.length) {
      $results.innerHTML = `<div class="gl-empty">No rows returned for this org.</div>`;
      return;
    }

    const unit = currentDef.unit || "rows";

    $results.innerHTML = `
      <div class="gl-table-wrap">
        <table class="data-table ll-preview-table gl-table">
          <thead>
            <tr>
              ${cols.map((c) => `
                <th data-sort="${escapeHtml(c.key)}">
                  <span class="gl-th-inner">
                    <span class="gl-th-label">${escapeHtml(c.label)}<span class="gl-arrow"></span></span>
                  </span>
                </th>
              `).join("")}
            </tr>
          </thead>
          <tbody>
            ${allRows.map((r, i) => `
              <tr data-i="${i}">
                ${cols.map((c) => `<td>${escapeHtml(String(r[c.key] ?? ""))}</td>`).join("")}
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    detachFilters = attachHeaderFilters($results, (visible, total, filtered) => {
      $count.textContent = filtered ? `${visible} / ${total} ${unit}` : `${total} ${unit}`;
    });

    // Only the label sorts — the filter button and its panel stop the click.
    $results.querySelectorAll("th[data-sort] .gl-th-label").forEach((label) => {
      label.addEventListener("click", () => {
        const key = label.closest("th").dataset.sort;
        if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
        else { sortKey = key; sortDir = "asc"; }
        applySort();
      });
    });

    applySort();
  }

  async function load() {
    $desc.innerHTML = currentDef.desc || "";
    sortKey = null;
    sortDir = "asc";

    const org = orgContext?.getDetails?.();
    if (!org) {
      allRows = [];
      clearTable();
      $actions.style.display = "none";
      setStatus("Please select a customer org first.", "error");
      return;
    }

    const what = currentDef.label.toLowerCase();
    setStatus(`Loading ${what} for ${org.name}…`);
    $actions.style.display = "none";
    clearTable();
    $refresh.disabled = true;
    $select.disabled = true;

    try {
      allRows = await currentDef.fetch(api, org.id);
      if (!allRows.length) {
        setStatus(`No ${what} returned for this org.`, "error");
        return;
      }
      setStatus("");
      $actions.style.display = "flex";
      render();
    } catch (err) {
      console.error("[getLists] load failed:", err);
      setStatus(`Failed to load ${what}: ${err?.message || err}`, "error");
    } finally {
      $refresh.disabled = false;
      $select.disabled = false;
    }
  }

  // ── Wiring ───────────────────────────────────────────
  $select.addEventListener("change", () => {
    currentDef = LIST_DEFS.find((d) => d.key === $select.value) || LIST_DEFS[0];
    load();
  });

  $refresh.addEventListener("click", load);

  // Exports what is on screen: the filters that are set, in the order sorted.
  $export.addEventListener("click", () => {
    const org = orgContext?.getDetails?.();
    const rows = visibleRows();
    if (!rows.length) {
      setStatus("Nothing to export — every row is filtered out.", "error");
      return;
    }
    const sheets = [{
      name: currentDef.sheetName || currentDef.label,
      rows,
      columns: currentDef.columns,
    }];
    const prefix = `${currentDef.filePrefix}_${(org?.name || "org").replace(/[^\w]+/g, "_")}`;
    try {
      exportXlsx(sheets, timestampedFilename(prefix, "xlsx"));
    } catch (err) {
      setStatus(err?.message || "Export failed.", "error");
    }
  });

  // Initial load
  load();

  return el;
}
