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
import { attachColumnFilters } from "../../utils/columnFilter.js";
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
   rows, and the filter row has to stay reachable while you scroll them.
   Both header rows stick; the filter row is offset by an explicit header
   height so the two never overlap. */
.gl-table-wrap { max-height: 62vh; overflow: auto; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 16px; }
.gl-table { width: 100%; }
.gl-table thead th { position: sticky; z-index: 2; background: var(--card, #1a1a1a); }
.gl-table thead tr:first-child th { top: 0; height: 34px; box-sizing: border-box; }
.gl-table thead tr.ll-filter-row th { top: 34px; }
.gl-table th[data-sort] { cursor: pointer; user-select: none; white-space: nowrap; }
.gl-table th[data-sort]:hover { color: #fff; }
`;

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
   * attachColumnFilters hides rows by setting style.display on the nodes it
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

    $results.innerHTML = `
      <div class="gl-table-wrap">
        <table class="data-table ll-preview-table gl-table">
          <thead>
            <tr>
              ${cols.map((c) => `<th data-sort="${escapeHtml(c.key)}">${escapeHtml(c.label)}<span class="gl-arrow"></span></th>`).join("")}
            </tr>
            <tr class="ll-filter-row">${cols.map(() => `<th></th>`).join("")}</tr>
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

    detachFilters = attachColumnFilters($results, {
      filterCols: cols.map((_, i) => i),
      countEl: $count,
      totalLabel: currentDef.unit || "rows",
    });
    $count.textContent = `${allRows.length} ${currentDef.unit || "rows"}`;

    $results.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
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
