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
 *   action     gate name in FEATURE_READ_PERMISSIONS["utilities.getLists"].
 *              Each list is gated on its own permission and simply does not
 *              appear in the picker without it, so lacking one list never costs
 *              access to the others. A list with no `action` is ungated.
 *   label      what the picker shows
 *   desc       one line under the heading, HTML
 *   filePrefix leading part of the exported filename
 *   sheetName  worksheet name in the workbook
 *   unit       what a row is, for the "N rows" count
 *   columns    [{ key, label, wch }] — drives the table AND the workbook.
 *              Omit it when the columns are not known until the data is:
 *              `fetch` may return `{ rows, columns }` instead of a bare array,
 *              and those columns win. Permissions vs. Licenses needs this —
 *              it has one column per licence the org holds.
 *   fetch      async (api, orgId) => row objects keyed by column.key,
 *              or { rows, columns } when the shape is data-dependent
 */
import { escapeHtml, exportXlsx, timestampedFilename, makeStatus } from "../../utils.js";
import {
  fetchAllWrapupCodes, fetchAllDivisions,
  fetchLicenseDefinitions, fetchLicenseDefinition,
} from "../../services/genesysApi.js";
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

// ── Wrap-up codes ─────────────────────────────────────────────────────
/**
 * GET /api/v2/routing/wrapupcodes
 *
 * Paginated, so it goes through the shared fetchAllWrapupCodes walker rather
 * than a single call.
 *
 * Each code carries a `division` reference. The schema says that reference has
 * a name, but Genesys division references routinely come back as id + selfUri
 * with the name left off, which would give a column of blanks. The divisions
 * are fetched alongside and used to fill in any name the reference did not
 * carry — one extra call, in parallel, and the embedded name still wins when
 * it is there.
 */
async function fetchWrapupCodes(api, orgId) {
  const [codes, divisions] = await Promise.all([
    fetchAllWrapupCodes(api, orgId),
    fetchAllDivisions(api, orgId).catch((err) => {
      console.warn("[getLists] divisions unavailable, falling back to embedded names:", err);
      return [];
    }),
  ]);

  const divisionNames = new Map(divisions.map((d) => [d.id, d.name]));

  const rows = codes.map((c) => ({
    name: c.name || "",
    id: c.id || "",
    description: c.description || "",
    divisionName: c.division?.name || divisionNames.get(c.division?.id) || "",
  }));

  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return rows;
}

// ── Permissions vs. Licenses ──────────────────────────────────────────
/**
 * Every permission in the org's catalog against every licence that grants it.
 *
 *   GET /api/v2/authorization/permissions   the catalog (paginated).
 *                                           Declares no required permission.
 *   GET /api/v2/license/definitions         per licence, `permissions.ids`
 *
 * Invert the second, join onto the first. No per-permission calls: the
 * definitions already carry the mapping, so this costs one catalog walk plus
 * one definitions call (and a by-id re-fetch for any definition that arrives
 * without its permissions, which the list endpoint sometimes does).
 *
 * Reading it: because a licence's permission set appears to be cumulative, a
 * permission shows against every tier that includes it. That is the point, not
 * noise — `quality:evaluation:add` ticked for cloudCX2, cloudCX3 and
 * gc1WEMupgrade reads as "bundled from CX 2 up; on CX 1 it needs the add-on".
 *
 * Only what the API says. No help-article cross-referencing and no billing
 * interpretation: what a licence GRANTS and what TRIGGERS a charge are
 * different questions, and this answers the first.
 */
async function fetchPermissionsVsLicenses(api, orgId) {
  // Catalog → flat permission strings, keeping the metadata worth showing.
  const perms = [];
  let page = 1, pageCount = null;
  do {
    const resp = await api.proxyGenesys(orgId, "GET", "/api/v2/authorization/permissions", {
      query: { pageSize: "100", pageNumber: String(page) },
    });
    pageCount = resp.pageCount ?? 1;
    for (const entry of resp.entities || []) {
      if (!entry.domain || !entry.permissionMap) continue;
      for (const [entity, actions] of Object.entries(entry.permissionMap)) {
        for (const a of actions || []) {
          if (!a.action) continue;
          perms.push({
            permission: `${entry.domain}:${entity}:${a.action}`,
            domain: entry.domain,
            entity,
            action: a.action,
            label: a.label || "",
            divisionAware: a.divisionAware ? "Yes" : "",
            conditions: a.allowsConditions ? "Yes" : "",
          });
        }
      }
    }
    page++;
  } while (page <= pageCount);

  // Licence definitions → permission → Set(licence ids).
  const defs = await fetchLicenseDefinitions(api, orgId);
  const byPermission = new Map();
  const licenceIds = [];

  for (const listed of defs) {
    if (!listed?.id) continue;
    let def = listed;
    if (!def.permissions?.ids?.length) {
      try {
        def = await fetchLicenseDefinition(api, orgId, listed.id);
      } catch {
        def = listed; // a licence we cannot read is simply an empty column
      }
    }
    licenceIds.push(listed.id);
    for (const pid of def.permissions?.ids || []) {
      if (!byPermission.has(pid)) byPermission.set(pid, new Set());
      byPermission.get(pid).add(listed.id);
    }
  }
  licenceIds.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  // One row per permission-LICENCE pair, not one per permission. A column per
  // licence was a wall of mostly-empty ticks that scrolled off the screen, and
  // collapsing them into one comma-separated cell would have made the licence
  // filter list combinations rather than licences — so picking one licence
  // would mean ticking every combination containing it.
  //
  // Long format sidesteps both: the Licence column holds a single value, so the
  // existing per-column filter works untouched and "only gc2WEMupgrade" gives
  // exactly the permissions that licence grants. Few permissions carry more
  // than one licence, so the row count grows modestly — and `# Licences` still
  // says how many a permission has in total, so a repeated row is legible
  // rather than looking like a duplicate.
  //
  // A permission in no licence keeps one row with an empty Licence, because
  // "nothing licence-gates this" is an answer worth being able to filter for.
  const rows = [];
  for (const p of perms.sort((a, b) =>
    a.permission.localeCompare(b.permission, undefined, { sensitivity: "base" }))) {
    const held = byPermission.get(p.permission);
    const list = held ? licenceIds.filter((id) => held.has(id)) : [];
    if (!list.length) {
      rows.push({ ...p, licenceCount: 0, licence: "" });
    } else {
      for (const id of list) rows.push({ ...p, licenceCount: list.length, licence: id });
    }
  }

  const columns = [
    { key: "permission",    label: "Permission",     wch: 46 },
    { key: "licence",       label: "Licence",        wch: 30 },
    { key: "label",         label: "Label",          wch: 34 },
    { key: "domain",        label: "Domain",         wch: 22 },
    { key: "entity",        label: "Entity",         wch: 26 },
    { key: "action",        label: "Action",         wch: 16 },
    { key: "divisionAware", label: "Division Aware", wch: 14 },
    { key: "conditions",    label: "Conditions",     wch: 12 },
    { key: "licenceCount",  label: "# Licences",     wch: 11 },
  ];

  return { rows, columns };
}

// ── The registry ──────────────────────────────────────────────────────
const LIST_DEFS = [
  {
    key: "presence-definitions",
    action: "presence",
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
  {
    key: "permissions-vs-licenses",
    action: "licenses",
    label: "Permissions vs. Licenses",
    desc: `Every permission in the org's catalog paired with each licence that grants it —
           one row per permission and licence, so filtering the <strong>Licence</strong> column to one
           value gives exactly the permissions it carries. A permission granted by two licences
           appears twice; <strong>#&nbsp;Licences</strong> says how many in total. Sources:
           <code>GET /api/v2/authorization/permissions</code> and
           <code>GET /api/v2/license/definitions</code>. Shows what each licence <em>grants</em>;
           that is not the same as what triggers a charge. Which licences appear differs per org,
           since Genesys returns only the ones an org can hold.`,
    filePrefix: "Permissions_vs_Licenses",
    sheetName: "Permissions vs Licenses",
    // "rows", not "permissions": a row is a permission-licence pair, so the
    // count exceeds the number of permissions and saying otherwise would lie.
    unit: "rows",
    // columns come from fetch — one per licence, not known until it runs
    fetch: fetchPermissionsVsLicenses,
  },
  {
    key: "wrapup-codes",
    action: "wrapup",
    label: "Wrap-up Codes",
    desc: `Every wrap-up code in the org with its division.
           Source: <code>GET /api/v2/routing/wrapupcodes</code>.`,
    filePrefix: "Wrapup_Codes",
    sheetName: "Wrap-up Codes",
    unit: "codes",
    columns: [
      { key: "name",         label: "Name",          wch: 40 },
      { key: "id",           label: "ID",            wch: 38 },
      { key: "description",  label: "Description",   wch: 60 },
      { key: "divisionName", label: "Division Name", wch: 28 },
    ],
    fetch: fetchWrapupCodes,
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
/* A second scrollbar above the table. With a dozen columns the real one sits
   below the fold, so reaching it means scrolling down past every row first.
   This is a bar of the same scrollWidth whose position is kept in sync both
   ways; it hides itself when there is nothing to scroll. */
.gl-scroll-top { overflow-x: auto; overflow-y: hidden; }
.gl-scroll-top .gl-scroll-spacer { height: 1px; }
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

/* Fixed, and parented to the body rather than the cell: the table scrolls
   inside a capped-height box, which clips an absolutely positioned dropdown at
   its edge. Position is set inline from the button's rect on open. */
.gl-filter-panel { position: fixed; top: 0; left: 0; z-index: 1000; }
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
  const panels = [];      // every panel this instance put in the body
  let openPanel = null;
  let positionOpen = null;

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
    openPanel = null;
    positionOpen = null;
  }

  /**
   * Put the panel under its button, in viewport coordinates.
   *
   * The panel is fixed and lives in the body rather than in the cell, because
   * the table scrolls inside a capped-height box: an absolutely positioned
   * dropdown gets clipped at that box's edge. Hiding every row (the None
   * button) collapses the box to just the header, which cut all but the first
   * row or two off the dropdown and left it looking like nothing could be
   * selected.
   */
  function place(btn, panel) {
    const r = btn.getBoundingClientRect();
    const w = panel.offsetWidth || 200;
    const h = panel.offsetHeight || 240;
    // Flip above the button when there is no room below it.
    const below = window.innerHeight - r.bottom;
    const top = below < h + 8 && r.top > h + 8 ? r.top - h - 2 : r.bottom + 2;
    panel.style.top = `${Math.max(4, top)}px`;
    panel.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 4))}px`;
  }

  headerCells.forEach((th, colIdx) => {
    th.classList.add("cf-th");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cf-btn gl-filter-btn";
    btn.title = "Filter this column";
    btn.innerHTML = `<span class="cf-caret">▼</span>`;

    const panel = document.createElement("div");
    panel.className = "cf-dropdown gl-filter-panel";
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
      place(btn, panel);
      openPanel = panel;
      positionOpen = () => place(btn, panel);
      search.focus();
    });

    th.querySelector(".gl-th-inner").append(btn);
    document.body.appendChild(panel);
    panels.push(panel);
    syncButton();
  });

  function onDocClick(e) {
    if (!openPanel || openPanel.contains(e.target) || e.target.closest(".gl-filter-btn")) return;
    closePanel();
  }
  function onKey(e) { if (e.key === "Escape") closePanel(); }
  function onReflow() { positionOpen?.(); }
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
  // Capture: the table's own scroll box does not bubble its scroll events.
  window.addEventListener("scroll", onReflow, true);
  window.addEventListener("resize", onReflow);

  apply();
  return () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onReflow, true);
    window.removeEventListener("resize", onReflow);
    // The panels live in the body, so they have to be taken out by hand.
    for (const p of panels) p.remove();
  };
}

// ── Page renderer ─────────────────────────────────────────────────────
export default async function renderGetLists(ctx = {}) {
  const { api, access } = ctx;

  // Only the lists this user may actually read. The page-level gate asks
  // whether they can see *any* of them, so reaching here means at least one.
  const visibleDefs = LIST_DEFS.filter(
    (d) => !d.action || !access?.can || access.can("utilities.getLists", d.action),
  );
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
    </div>

    <hr class="hr">

    <div class="gl-picker">
      <div class="di-control-group" style="min-width: 280px;">
        <label class="di-label" for="glListSelect">List</label>
        <select class="input" id="glListSelect">
          ${visibleDefs.map((d) => `<option value="${escapeHtml(d.key)}">${escapeHtml(d.label)}</option>`).join("")}
        </select>
      </div>
      <button class="btn" id="glLoadBtn">Load</button>
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
  const $load    = el.querySelector("#glLoadBtn");
  const $export  = el.querySelector("#glExportBtn");

  // ── State ────────────────────────────────────────────
  let currentDef = visibleDefs[0];
  let allRows = [];
  // Set when a list's fetch returns { rows, columns } instead of a bare array.
  let dynamicCols = null;
  // Live only while a table is rendered; disconnected on clear.
  let scrollObserver = null;
  let sizeScrollerRef = null;
  const colsFor = (def) => dynamicCols || def.columns || [];
  let sortKey = null;
  let sortDir = "asc";
  let detachFilters = null;

  const applyStatus = makeStatus($status, "gl-status");
  function setStatus(msg, kind) {
    applyStatus(msg, kind === "error" ? "error" : "");
    $status.style.display = msg ? "block" : "none";
  }

  function clearTable() {
    detachFilters?.();
    detachFilters = null;
    // The observer outlives innerHTML = "" otherwise, and keeps firing against
    // a detached node every time the container resizes.
    scrollObserver?.disconnect();
    scrollObserver = null;
    sizeScrollerRef = null;
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

    const cols = colsFor(currentDef);
    if (!allRows.length) {
      $results.innerHTML = `<div class="gl-empty">No rows returned for this org.</div>`;
      return;
    }

    const unit = currentDef.unit || "rows";

    $results.innerHTML = `
      <div class="gl-scroll-top" id="glScrollTop"><div class="gl-scroll-spacer"></div></div>
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

    // Keep the top scrollbar and the table in step. The spacer is given the
    // table's scroll width so the bar's thumb matches; if nothing overflows,
    // the bar hides rather than sitting there as a dead 1px strip.
    const $scrollTop = $results.querySelector("#glScrollTop");
    const $tableWrap = $results.querySelector(".gl-table-wrap");
    if ($scrollTop && $tableWrap) {
      const spacer = $scrollTop.querySelector(".gl-scroll-spacer");
      const sizeScroller = () => {
        const w = $tableWrap.scrollWidth;
        spacer.style.width = `${w}px`;
        $scrollTop.style.display = w > $tableWrap.clientWidth ? "" : "none";
      };
      sizeScrollerRef = sizeScroller;
      sizeScroller();
      // Column widths settle after layout, and again whenever the box resizes.
      requestAnimationFrame(sizeScroller);
      if (typeof ResizeObserver === "function") {
        const ro = new ResizeObserver(sizeScroller);
        ro.observe($tableWrap);
        scrollObserver = ro;
      }
      // Guard against the echo: each handler would otherwise re-fire the other.
      let syncing = false;
      const link = (from, to) => from.addEventListener("scroll", () => {
        if (syncing) return;
        syncing = true;
        to.scrollLeft = from.scrollLeft;
        syncing = false;
      });
      link($scrollTop, $tableWrap);
      link($tableWrap, $scrollTop);
    }

    detachFilters = attachHeaderFilters($results, (visible, total, filtered) => {
      $count.textContent = filtered ? `${visible} / ${total} ${unit}` : `${total} ${unit}`;
      // Hiding rows can change the table's width; keep the bar honest.
      $results.querySelector("#glScrollTop") && sizeScrollerRef?.();
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

  /**
   * Idle state for the selected list: its description, nothing fetched.
   * Changing the picker must not fire an API call, and must not leave the
   * previous list's rows on screen under a heading that now names another one.
   */
  function showIdle() {
    allRows = [];
    dynamicCols = null;
    sortKey = null;
    sortDir = "asc";
    clearTable();
    $actions.style.display = "none";
    $desc.innerHTML = currentDef.desc || "";
    setStatus(`Click Load to fetch ${currentDef.label.toLowerCase()} for the selected org.`);
  }

  async function load() {
    sortKey = null;
    sortDir = "asc";

    const org = orgContext?.getDetails?.();
    if (!org) {
      allRows = [];
    dynamicCols = null;
      clearTable();
      $actions.style.display = "none";
      setStatus("Please select a customer org first.", "error");
      return;
    }

    const what = currentDef.label.toLowerCase();
    setStatus(`Loading ${what} for ${org.name}…`);
    $actions.style.display = "none";
    clearTable();
    $load.disabled = true;
    $select.disabled = true;

    try {
      const fetched = await currentDef.fetch(api, org.id);
      if (Array.isArray(fetched)) {
        allRows = fetched;
        dynamicCols = null;
      } else {
        allRows = fetched?.rows || [];
        dynamicCols = fetched?.columns || null;
      }
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
      $load.disabled = false;
      $select.disabled = false;
    }
  }

  // ── Wiring ───────────────────────────────────────────
  $select.addEventListener("change", () => {
    currentDef = visibleDefs.find((d) => d.key === $select.value) || visibleDefs[0];
    showIdle();
  });

  // Load doubles as refresh: clicking it again re-fetches the same list.
  $load.addEventListener("click", load);

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
      columns: colsFor(currentDef),
    }];
    const prefix = `${currentDef.filePrefix}_${(org?.name || "org").replace(/[^\w]+/g, "_")}`;
    try {
      exportXlsx(sheets, timestampedFilename(prefix, "xlsx"));
    } catch (err) {
      setStatus(err?.message || "Export failed.", "error");
    }
  });

  // Nothing is fetched until Load is clicked.
  showIdle();

  return el;
}
