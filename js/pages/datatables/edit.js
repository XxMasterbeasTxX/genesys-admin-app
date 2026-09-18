/**
 * Data Tables › Edit
 *
 * Two modes:
 *  - Schema: edit table metadata and schema columns — and, per column, the
 *    Super User rules: a lookup, Protected, Mandatory; per table, whether
 *    Super Users may add or delete rows (docs/data-table-rules-design.md
 *    §5). The rules are the app's, saved with Save Schema, enforced on
 *    Data Tables › Supervisor and by the server — never here.
 *  - Rows: edit multiple row values in a paged grid with full-table search.
 *    The rules show as hints under the column headers; this page is not
 *    bound by them.
 */
import { escapeHtml, makeStatus, makeControlBusy } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { logAction } from "../../services/activityLogService.js";
import { createSingleSelect } from "../../components/multiSelect.js";
import { getDataTableRules, setDataTableRules, LOOKUP_TYPES, lookupLabel, EMPTY_RULES } from "../../services/dataTableRulesService.js";

const LOOKUP_OPTIONS_HTML = LOOKUP_TYPES
  .map(t => `<option value="${t.id}">${t.label}</option>`)
  .join("");

const COLUMN_TYPES = [
  { label: "Boolean", type: "boolean" },
  { label: "Decimal", type: "number" },
  { label: "Integer", type: "integer" },
  { label: "String", type: "string" },
];

const TYPE_OPTIONS_HTML = COLUMN_TYPES
  .map(t => `<option value="${t.type}">${t.label}</option>`)
  .join("");

export default function renderEditDataTable({ me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <style>
      /* The Edit page's schema grid carries four rule controls after Default. */
      #dteSchemaMode .dtc-schema-cols-header,
      #dteSchemaMode .dtc-schema-row,
      #dteSchemaMode .dte-group-header {
        grid-template-columns: 24px var(--dte-name-col, 220px) 110px 120px 28px var(--dte-lookup-col, 130px) var(--dte-table-col, 150px) 76px 78px 60px 32px;
        max-width: none;
      }
      /* The line between the data table's own columns and the Super User rules. */
      .dte-rule-divider { justify-self: center; width: 1px; height: 100%; min-height: 28px; background: var(--border); }
      .dte-group-header { display: grid; gap: 8px; align-items: end; margin-bottom: 2px; }
      .dte-group-header .dte-group-label { font-size: 11px; font-weight: 700; color: var(--text); text-transform: uppercase; letter-spacing: .06em; padding: 0 2px 4px; border-bottom: 2px solid var(--border); }
      /* The table dropdown sizes to its longest name; every row shares the option
         list, so one measured width (--dte-table-col) keeps the three grids aligned. */
      #dteSchemaMode .dtc-schema-row .dtc-rule-src,
      #dteSchemaMode .dtc-schema-row .dtc-rule-table,
      #dteSchemaMode .dtc-schema-row .dtc-rule-lookup { width: max-content; max-width: none; justify-self: start; }
      /* The source cell: a Data Table lookup's table dropdown, or a List's
         "Edit list" button; the cell itself stays, so the ticks keep their headers. */
      #dteSchemaMode .dtc-schema-row .dtc-rule-src { min-height: 1px; }
      .dtc-rule-list-btn.is-empty { color: var(--warn); border-color: var(--warn); }
      /* The list editor sits under its row, on the rules side. */
      .dtc-rule-list-editor { display: grid; grid-template-columns: 1fr; gap: 6px; margin: 0 0 10px 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
      .dtc-rule-list-editor .dtc-rule-list-head { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
      .dtc-rule-list-editor .dtc-rule-list-head strong { color: var(--text); }
      .dtc-rule-list-editor .dtc-rule-list-head .dtc-spacer { flex: 1; }
      .dtc-rule-list-editor textarea { width: 100%; max-width: 520px; min-height: 120px; box-sizing: border-box; font: inherit; resize: vertical; }
      .dte-rule-tick { display: flex; align-items: center; justify-content: center; }
      .dte-rule-tick input { width: 16px; height: 16px; accent-color: var(--accent-strong); cursor: pointer; margin: 0; }
      .dte-rule-tick input:disabled { cursor: not-allowed; opacity: .4; }
      .dte-table-rules { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; margin: 4px 0 10px; font-size: 13px; }
      .dte-table-rules label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
      .dte-table-rules input { margin: 0; accent-color: var(--accent-strong); }
      .dte-orphans { margin-top: 10px; font-size: 12px; color: var(--warn); }
      .dte-orphans button { margin-left: 6px; }
      .dte-col-hint { display: block; font-size: 10px; font-weight: 500; color: var(--muted); letter-spacing: 0; text-transform: none; margin-top: 2px; }
      .dte-mode-toggle {
        display: flex;
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
        width: fit-content;
      }
      .dte-mode-btn {
        padding: 7px 22px;
        background: none;
        border: none;
        color: var(--muted);
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        font-weight: 600;
        transition: background .12s, color .12s;
      }
      .dte-mode-btn.active {
        background: color-mix(in srgb, var(--accent-strong) 22%, transparent);
        color: var(--accent);
      }
      .dte-mode-btn:not(.active):hover {
        background: color-mix(in srgb, var(--lift) 5%, transparent);
        color: var(--text);
      }

      .dte-row-grid-wrap {
        width: 100%;
        overflow-x: auto;
        /* Flip vertically so the horizontal scrollbar sits above the rows;
           the inner table is flipped back so content reads normally. */
        transform: rotateX(180deg);
      }
      .dte-row-grid-wrap > .dte-row-grid {
        transform: rotateX(180deg);
      }
      .dte-row-grid {
        width: 100%;
        min-width: 980px;
        border-collapse: collapse;
        table-layout: auto;
      }
      .dte-row-grid thead th {
        text-align: left;
        font-size: 11px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: .04em;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
        background: var(--bg, var(--panel));
        white-space: nowrap;
      }
      /* Data columns get a comfortable minimum so headers stay readable and
         inputs are usable; the wrapper scrolls horizontally when there are
         many columns instead of cramming them all into view. */
      .dte-row-grid th.dte-col,
      .dte-row-grid td.dte-col {
        min-width: 150px;
      }
      /* The key column swaps that floor for one measured from the longest key
         in the table (set as --dte-key-w when rendering). It has to be a
         min-width, not just a width: auto table layout treats width as a
         preference and, once the columns overflow the wrapper, squeezes
         whichever column is allowed to shrink — which would be this one. */
      .dte-row-grid th.dte-col-key,
      .dte-row-grid td.dte-col-key {
        min-width: var(--dte-key-w, 150px);
        width: var(--dte-key-w, 150px);
      }
      .dte-row-grid tbody td {
        padding: 8px 10px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      .dte-row-grid .dt-input {
        width: 100%;
        box-sizing: border-box;
      }
      .dte-row-grid tr.dte-row-dirty {
        background: color-mix(in srgb, var(--accent-strong) 8%, transparent);
      }
      .dte-row-status {
        font-size: 11px;
        color: var(--muted);
      }

      .dte-rows-toolbar {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }

      .dte-rows-primary,
      .dte-rows-secondary {
        display: flex;
        gap: 10px;
        align-items: flex-end;
        flex-wrap: wrap;
      }

      .dte-rows-primary {
        flex: 1 1 560px;
      }

      .dte-rows-search-group {
        min-width: 240px;
        flex: 0 1 420px;
      }

      .dte-rows-secondary {
        margin-left: auto;
      }

      .dte-pager {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        margin-top: 10px;
      }
      .dte-pager-info {
        font-size: 12px;
        color: var(--muted);
      }

      @media (max-width: 900px) {
        .dte-row-grid {
          min-width: 100%;
        }
        .dte-row-grid thead {
          display: none;
        }
        .dte-row-grid,
        .dte-row-grid tbody,
        .dte-row-grid tr,
        .dte-row-grid td {
          display: block;
          width: 100%;
        }
        .dte-row-grid tbody tr {
          border: 1px solid var(--border);
          border-radius: 8px;
          margin-bottom: 10px;
          background: var(--bg, var(--panel));
          overflow: hidden;
        }
        .dte-row-grid tbody td {
          border-bottom: 1px solid var(--border);
        }
        /* Stacked cards ignore the measured key width. */
        .dte-row-grid th.dte-col-key,
        .dte-row-grid td.dte-col-key {
          min-width: 0;
          width: 100%;
        }
        .dte-row-grid tbody td:last-child {
          border-bottom: none;
        }
        .dte-row-grid tbody td::before {
          content: attr(data-label);
          display: block;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: .04em;
          color: var(--muted);
          margin-bottom: 6px;
          font-weight: 600;
        }
      }
    </style>

    <h2>Data Tables — Edit</h2>
    <p class="page-desc">
      Edit an existing data table in the selected org.
      Use Schema mode for structure, or Rows mode for bulk value editing.
    </p>

    <div class="dt-controls" style="margin-bottom:12px">
      <div class="dt-control-group" style="flex:1;max-width:420px">
        <label class="dt-label" for="dteTableSelect">Data Table</label>
        <div id="dteTableSelectHost"></div>
      </div>
    </div>

    <div class="dt-controls" style="margin-bottom:12px">
      <div class="dt-control-group">
        <label class="dt-label">Edit Mode</label>
        <div class="dte-mode-toggle">
          <button class="dte-mode-btn active" id="dteModeSchema" type="button">Schema</button>
          <button class="dte-mode-btn" id="dteModeRows" type="button">Rows</button>
        </div>
      </div>
    </div>

    <div class="dt-actions" id="dteActions" hidden>
      <button class="btn" id="dteSchemaSaveBtn" disabled>Save Schema</button>
      <button class="btn btn-secondary" id="dteRowsUndoBtn" hidden disabled>Undo All</button>
      <button class="btn" id="dteRowsSaveBtn" hidden disabled>Save Changes</button>
    </div>

    <div class="dt-status" id="dteStatus"></div>

    <div id="dteForm" hidden>
      <hr class="hr" style="margin-bottom:18px">

      <div id="dteSchemaMode">
        <div class="dt-controls">
          <div class="dt-control-group">
            <label class="dt-label" for="dteName">Name <span style="color:var(--danger)">*</span></label>
            <input class="dt-input" id="dteName" type="text" placeholder="e.g. AgentSkillMatrix" autocomplete="off" />
          </div>
          <div class="dt-control-group">
            <label class="dt-label" for="dteDivision" id="dteDivisionLabel">Division <span style="color:var(--danger)">*</span></label>
            <select class="dt-select" id="dteDivision">
              <option value="">Loading divisions…</option>
            </select>
          </div>
          <div class="dt-control-group">
            <label class="dt-label" for="dteDescription">Description</label>
            <input class="dt-input" id="dteDescription" type="text" placeholder="Optional description" autocomplete="off" />
          </div>
          <div class="dt-control-group">
            <label class="dt-label" for="dteKey">Key</label>
            <input class="dt-input" id="dteKey" type="text" readonly style="opacity:0.6;cursor:not-allowed" />
            <span class="dt-field-hint">Primary key column — cannot be changed on an existing table.</span>
          </div>
        </div>

        <div class="dtc-schema-section">
          <div class="dtc-schema-header">
            <span class="dt-label">Schema Columns</span>
          </div>
          <div class="dte-table-rules">
            <label><input type="checkbox" id="dteVisibleToSupervisors"> Visible to Super Users</label>
            <label><input type="checkbox" id="dteMayAddRows"> Super Users may add rows</label>
          </div>
          <div class="dte-group-header">
            <span></span>
            <span class="dte-group-label" style="grid-column: 2 / 5">Data table columns</span>
            <span></span>
            <span class="dte-group-label" style="grid-column: 6 / 11">Super User rules</span>
            <span></span>
          </div>
          <div class="dtc-schema-cols-header">
            <span></span>
            <span class="dtc-col-label">Column Name</span>
            <span class="dtc-col-label">Type</span>
            <span class="dtc-col-label">Default</span>
            <span class="dte-rule-divider"></span>
            <span class="dtc-col-label">Lookup</span>
            <span class="dtc-col-label">Lookup table</span>
            <span class="dtc-col-label">Protected</span>
            <span class="dtc-col-label">Mandatory</span>
            <span class="dtc-col-label">Hidden</span>
            <span></span>
          </div>
          <div id="dteSchemaRows"></div>
          <button class="btn btn-sm dtc-add-btn" id="dteAddSchemaRow" style="margin-top:8px">+ Add column</button>
          <div id="dteOrphanRules" class="dte-orphans" hidden></div>
        </div>
      </div>

      <div id="dteRowsMode" hidden>
        <div class="dte-rows-toolbar">
          <div class="dte-rows-primary">
            <div class="dt-control-group dte-rows-search-group">
              <label class="dt-label" for="dteRowsSearch">Search all fields</label>
              <input class="dt-input" id="dteRowsSearch" type="text" placeholder="Type to filter rows (e.g. +45)" autocomplete="off" />
            </div>
            <div class="dt-control-group" style="align-self:flex-end">
              <button class="btn" id="dteRowsAddBtn" type="button" disabled>Add Row</button>
            </div>
            <div class="dt-control-group" style="align-self:flex-end">
              <button class="btn" id="dteRowsCopyBtn" type="button" disabled>Copy Row</button>
            </div>
            <div class="dt-control-group" style="align-self:flex-end">
              <button class="btn btn-secondary" id="dteRowsDeleteBtn" type="button" disabled>Delete Selected</button>
            </div>
          </div>

          <div class="dte-rows-secondary">
            <div class="dt-control-group" style="min-width:120px">
              <label class="dt-label" for="dteRowsPageSize">Rows per page</label>
              <select class="dt-select" id="dteRowsPageSize">
                <option value="50">50</option>
                <option value="100" selected>100</option>
                <option value="200">200</option>
              </select>
            </div>
            <div class="dt-control-group" style="align-self:flex-end">
              <button class="btn btn-secondary" id="dteRowsRefreshBtn" type="button" disabled>Refresh Rows</button>
            </div>
          </div>
        </div>

        <div class="dt-status" id="dteRowsSummary" style="margin-bottom:10px"></div>
        <div id="dteRowsGrid"></div>

        <div class="dte-pager">
          <button class="btn btn-secondary" id="dteRowsPrevBtn" type="button">Prev</button>
          <button class="btn btn-secondary" id="dteRowsNextBtn" type="button">Next</button>
          <span class="dte-pager-info" id="dteRowsPagerInfo"></span>
        </div>
      </div>
    </div>
  `;

  const $tableSelectHost = el.querySelector("#dteTableSelectHost");
  const tableSelect = createSingleSelect({
    placeholder: "Select a data table…",
    searchable: true,
    onChange: (id) => loadSelectedTable(id),
  });
  tableSelect.el.style.width = "100%";
  tableSelect.el.querySelector(".ms-dropdown__trigger").style.width = "100%";
  $tableSelectHost.append(tableSelect.el);
  const $modeSchemaBtn = el.querySelector("#dteModeSchema");
  const $modeRowsBtn = el.querySelector("#dteModeRows");
  const $actions = el.querySelector("#dteActions");
  const $schemaSaveBtn = el.querySelector("#dteSchemaSaveBtn");
  const $rowsUndoBtn = el.querySelector("#dteRowsUndoBtn");
  const $rowsSaveBtn = el.querySelector("#dteRowsSaveBtn");
  const $status = el.querySelector("#dteStatus");
  const $form = el.querySelector("#dteForm");
  const $schemaMode = el.querySelector("#dteSchemaMode");
  const $rowsMode = el.querySelector("#dteRowsMode");

  const $name = el.querySelector("#dteName");
  const $division = el.querySelector("#dteDivision");
  const divisionBusy = makeControlBusy(el.querySelector("#dteDivisionLabel"));
  const $description = el.querySelector("#dteDescription");
  const $key = el.querySelector("#dteKey");
  const $schemaRowsContainer = el.querySelector("#dteSchemaRows");
  const $mayAddRows     = el.querySelector("#dteMayAddRows");
  const $visibleToSup   = el.querySelector("#dteVisibleToSupervisors");
  const $orphanRules    = el.querySelector("#dteOrphanRules");

  // ── Super User rules (docs/data-table-rules-design.md §5) ─────────────
  let _rules = EMPTY_RULES;      // as loaded for the current table
  let _rulesLoadFailed = false;  // a save must not overwrite rules it never saw
  let _tablesForLookup = [];     // the org's tables, for the "Lookup table" dropdown

  /**
   * Size the three content-driven columns to their content — the column
   * name to the longest name, the two dropdowns to their longest option —
   * as one measured width each, shared by the header grids and the rows
   * (three separate grids, so max-content alone would not line up).
   */
  function sizeTableColumn() {
    const set = (name, px) => $schemaMode.style.setProperty(name, `${Math.ceil(px)}px`);
    const table = $schemaRowsContainer.querySelector(".dtc-rule-table");
    if (table) {
      const wasHidden = table.hidden;
      table.hidden = false;
      const w = table.getBoundingClientRect().width;
      table.hidden = wasHidden;
      if (w > 0) set("--dte-table-col", Math.max(150, w));
    }
    const lookup = $schemaRowsContainer.querySelector(".dtc-rule-lookup");
    if (lookup) {
      const w = lookup.getBoundingClientRect().width;
      if (w > 0) set("--dte-lookup-col", Math.max(110, w));
    }
    const nameInput = $schemaRowsContainer.querySelector(".dtc-col-name");
    if (nameInput) {
      const font = getComputedStyle(nameInput).font;
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = font;
      let longest = 0;
      $schemaRowsContainer.querySelectorAll(".dtc-col-name").forEach((i) => { longest = Math.max(longest, ctx.measureText(i.value || i.placeholder || "").width); });
      set("--dte-name-col", Math.min(440, Math.max(200, longest + 36)));   // padding + room to type
    }
  }

  function lookupTableOptions(excludeId) {
    return `<option value="">— which table —</option>` + _tablesForLookup
      .filter(t => t.id !== excludeId)
      .map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("");
  }

  /**
   * Wire a lookup dropdown to its source cell: the table dropdown for a
   * Data Table lookup, the "Edit list" button for a List. The list's values
   * live on the row (`row.__listValues`) until Save Schema stores them.
   */
  function wireLookupPair($lookup, $table, getType, $listBtn) {
    const sync = () => {
      const type = getType ? getType() : "string";
      const stringy = type === "string";
      if (!stringy && $lookup.value) $lookup.value = "";
      $lookup.disabled = !stringy;
      $lookup.title = stringy ? "" : "Lookups apply to string columns only";
      $table.hidden = $lookup.value !== "dataTable";
      if ($table.hidden) $table.value = "";
      if ($listBtn) {
        $listBtn.hidden = $lookup.value !== "list";
        if ($listBtn.hidden) closeListEditor($listBtn.closest(".dtc-schema-row"));
        refreshListButton($listBtn);
      }
    };
    $lookup.addEventListener("change", sync);
    sync();
    return sync;
  }

  /** The button says how many values the list holds; none is a warning. */
  function refreshListButton($btn) {
    const row = $btn.closest(".dtc-schema-row");
    const n = (row && row.__listValues || []).length;
    $btn.textContent = `Edit list (${n} value${n === 1 ? "" : "s"})`;
    $btn.classList.toggle("is-empty", n === 0);
    $btn.title = n ? "The values Super Users may choose from" : "No values yet — the list is not a rule until it has some";
  }

  /** Parse a textarea: one value per line, trimmed, blanks and repeats dropped, order kept. */
  function parseListText(text) {
    const out = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      const v = line.trim();
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  }

  function closeListEditor(row) {
    const ed = row && row.nextElementSibling;
    if (ed && ed.classList.contains("dtc-rule-list-editor") && ed.__row === row) ed.remove();
  }

  /** One editor open at a time, under its row. Every keystroke is kept on the row. */
  function toggleListEditor(row) {
    const open = row.nextElementSibling && row.nextElementSibling.classList.contains("dtc-rule-list-editor");
    $schemaRowsContainer.querySelectorAll(".dtc-rule-list-editor").forEach((e) => e.remove());
    if (open) return;
    const name = row.querySelector(".dtc-col-name").value.trim() || "this column";
    const ed = document.createElement("div");
    ed.className = "dtc-rule-list-editor";
    ed.__row = row;
    ed.innerHTML = `
      <div class="dtc-rule-list-head">
        <span>The values Super Users may choose for <strong>${escapeHtml(name)}</strong> — one per line, in the order the dropdown shows them. Matched exactly.</span>
        <span class="dtc-spacer"></span>
        <span class="dtc-rule-list-count"></span>
        <button type="button" class="btn btn-secondary btn-sm" data-close>Done</button>
      </div>
      <textarea class="dt-input" spellcheck="false" placeholder="One value per line"></textarea>`;
    const $ta = ed.querySelector("textarea"), $n = ed.querySelector(".dtc-rule-list-count");
    $ta.value = (row.__listValues || []).join("\n");
    const keep = () => {
      row.__listValues = parseListText($ta.value);
      $n.textContent = `${row.__listValues.length} value${row.__listValues.length === 1 ? "" : "s"}`;
      refreshListButton(row.querySelector(".dtc-rule-list-btn"));
    };
    $ta.addEventListener("input", keep);
    ed.querySelector("[data-close]").addEventListener("click", () => ed.remove());
    keep();
    row.after(ed);
    $ta.focus();
  }

  function readRule(row) {
    const type = row.querySelector(".dtc-col-type").value;
    const lookup = type === "string" ? row.querySelector(".dtc-rule-lookup").value : "";
    return {
      lookup,
      tableId: lookup === "dataTable" ? row.querySelector(".dtc-rule-table").value : "",
      values: lookup === "list" ? [...(row.__listValues || [])] : [],
      protected: row.querySelector(".dtc-rule-protected").checked,
      mandatory: row.querySelector(".dtc-rule-mandatory").checked,
      hidden:    row.querySelector(".dtc-rule-hidden").checked,
    };
  }

  /** The rules as the controls hold them. Keyed by property key, as rows are. */
  function collectRules() {
    const columns = {};
    $schemaRowsContainer.querySelectorAll(".dtc-schema-row").forEach((row) => {
      const name = row.querySelector(".dtc-col-name").value.trim();
      if (!name) return;
      const propKey = row.dataset.originalKey || name;
      const r = readRule(row);
      if (r.lookup === "dataTable" && !r.tableId) r.lookup = "";
      if (r.lookup === "list" && !r.values.length) r.lookup = "";
      if (r.lookup || r.protected || r.mandatory || r.hidden) {
        columns[propKey] = { lookup: r.lookup, ...(r.tableId ? { tableId: r.tableId } : {}), ...(r.lookup === "list" ? { values: r.values } : {}), protected: r.protected, mandatory: r.mandatory, hidden: r.hidden };
      }
    });
    // Orphaned rules (columns no longer in the schema) are kept until removed.
    for (const [name, rule] of Object.entries(_rules.columns || {})) {
      if (!(name in columns) && _orphaned.has(name)) columns[name] = rule;
    }
    return { columns, visibleToSupervisors: $visibleToSup.checked, mayAddRows: $mayAddRows.checked };
  }

  let _orphaned = new Set();
  function renderOrphans() {
    if (!_orphaned.size) { $orphanRules.hidden = true; $orphanRules.innerHTML = ""; return; }
    $orphanRules.hidden = false;
    $orphanRules.innerHTML = `Rules for columns that are no longer in the schema: ` + [..._orphaned].map((n) =>
      `<span>"${escapeHtml(n)}" (${escapeHtml(lookupLabel(_rules.columns[n].lookup))}${_rules.columns[n].lookup === "list" ? ` of ${(_rules.columns[n].values || []).length}` : ""}${_rules.columns[n].protected ? ", protected" : ""}${_rules.columns[n].mandatory ? ", mandatory" : ""}${_rules.columns[n].hidden ? ", hidden" : ""})` +
      `<button type="button" class="btn btn-sm btn-secondary" data-drop-rule="${escapeHtml(n)}">remove</button></span>`).join(" ");
    $orphanRules.querySelectorAll("[data-drop-rule]").forEach((b) => b.addEventListener("click", () => {
      _orphaned.delete(b.getAttribute("data-drop-rule"));
      renderOrphans();
    }));
  }

  /** Put loaded rules into the controls; note the orphans. */
  function applyRulesToControls(rules) {
    _rules = rules || EMPTY_RULES;
    $mayAddRows.checked = !!_rules.mayAddRows;
    $visibleToSup.checked = !!_rules.visibleToSupervisors;
    const present = new Set(["key"]);
    $schemaRowsContainer.querySelectorAll(".dtc-schema-row").forEach((row) => {
      const propKey = row.dataset.originalKey || row.querySelector(".dtc-col-name").value.trim();
      present.add(propKey);
      const rule = _rules.columns[propKey];
      const $lookup = row.querySelector(".dtc-rule-lookup"), $table = row.querySelector(".dtc-rule-table");
      $table.innerHTML = lookupTableOptions(_currentTableId);
      row.__listValues = rule && rule.lookup === "list" && Array.isArray(rule.values) ? [...rule.values] : [];
      closeListEditor(row);
      $lookup.value = rule ? rule.lookup : "";
      $lookup.dispatchEvent(new Event("change"));
      if (rule && rule.lookup === "dataTable") $table.value = rule.tableId || "";
      row.querySelector(".dtc-rule-protected").checked = !!(rule && rule.protected);
      row.querySelector(".dtc-rule-mandatory").checked = !!(rule && rule.mandatory);
      row.querySelector(".dtc-rule-hidden").checked = !!(rule && rule.hidden);
    });
    _orphaned = new Set(Object.keys(_rules.columns).filter((n) => !present.has(n)));
    renderOrphans();
    sizeTableColumn();
  }

  const $addSchemaRowBtn = el.querySelector("#dteAddSchemaRow");

  const $rowsSearch = el.querySelector("#dteRowsSearch");
  const $rowsPageSize = el.querySelector("#dteRowsPageSize");
  const $rowsRefreshBtn = el.querySelector("#dteRowsRefreshBtn");
  const $rowsAddBtn = el.querySelector("#dteRowsAddBtn");
  const $rowsCopyBtn = el.querySelector("#dteRowsCopyBtn");
  const $rowsDeleteBtn = el.querySelector("#dteRowsDeleteBtn");
  const $rowsSummary = el.querySelector("#dteRowsSummary");
  const $rowsGrid = el.querySelector("#dteRowsGrid");
  const $rowsPrevBtn = el.querySelector("#dteRowsPrevBtn");
  const $rowsNextBtn = el.querySelector("#dteRowsNextBtn");
  const $rowsPagerInfo = el.querySelector("#dteRowsPagerInfo");

  // ── Permission-based action gating (internal refinement) ──────────────
  // A user may see this page (group access) but lack specific write permissions.
  // Disable the buttons whose Genesys permission they don't hold, with a tooltip.
  const canDo = (action) => (access && access.can ? access.can("data-tables.edit", action) : true);
  const canSchemaEdit = canDo("schemaEdit");
  const canRowsAdd    = canDo("rowsAdd");
  const canRowsEdit   = canDo("rowsEdit");
  const canRowsDelete = canDo("rowsDelete");
  const canRowsSave   = canRowsAdd || canRowsEdit || canRowsDelete;
  if (!canSchemaEdit) $schemaSaveBtn.title = "Requires Genesys permission: architect:datatable:edit";
  if (!canRowsAdd)    $rowsAddBtn.title    = "Requires Genesys permission: architect:datatableRow:add";
  if (!canRowsAdd)    $rowsCopyBtn.title   = "Requires Genesys permission: architect:datatableRow:add";
  if (!canRowsDelete) $rowsDeleteBtn.title = "Requires Genesys permission: architect:datatableRow:delete";
  if (!canRowsSave)   $rowsSaveBtn.title   = "Requires a Genesys datatable row permission (add/edit/delete)";

  let divisionsLoaded = false;
  let schemaRowCounter = 0;
  let _mode = "schema";
  let _currentTableId = null;
  let _currentTable = null;
  let _isLoadingTable = false;

  let _rowsColumns = [];
  let _rowsModels = [];
  let _nextRowId = 1;
  let _rowsSearchText = "";
  let _rowsPageSizeValue = 100;
  let _rowsPage = 1;
  let _selectedRowIds = new Set();
  let _keyMeasureCtx = null;

  const setStatus = makeStatus($status, "dt-status");

  function setMode(nextMode) {
    _mode = nextMode === "rows" ? "rows" : "schema";
    const isSchema = _mode === "schema";

    $schemaMode.hidden = !isSchema;
    $rowsMode.hidden = isSchema;
    $schemaSaveBtn.hidden = !isSchema;
    $rowsUndoBtn.hidden = isSchema;
    $rowsSaveBtn.hidden = isSchema;

    $modeSchemaBtn.classList.toggle("active", isSchema);
    $modeRowsBtn.classList.toggle("active", !isSchema);

    validateSchemaSave();
    validateRowsSave();

    if (!isSchema && _currentTableId && !_rowsModels.length) {
      loadRowsList();
    }
  }

  function makeSchemaRowId() {
    return `dterow-${++schemaRowCounter}`;
  }

  function makeDefaultInput(type) {
    if (type === "boolean") {
      return `<label class="dtc-bool-wrap"><input type="checkbox" class="dtc-col-default-bool" /><span class="dtc-bool-label">false</span></label>`;
    }
    if (type === "integer") {
      return `<input class="dt-input dtc-col-default" type="number" step="1" inputmode="numeric" placeholder="0" />`;
    }
    if (type === "number") {
      return `<input class="dt-input dtc-col-default" type="number" step="any" placeholder="0.0" />`;
    }
    return `<input class="dt-input dtc-col-default" type="text" placeholder="" />`;
  }

  function wireDefaultHandlers(row) {
    const wrap = row.querySelector(".dtc-col-default-wrap");
    const type = row.querySelector(".dtc-col-type").value;

    const bool = wrap.querySelector(".dtc-col-default-bool");
    if (bool) {
      bool.addEventListener("change", () => {
        bool.nextElementSibling.textContent = bool.checked ? "true" : "false";
      });
    }

    const numInput = wrap.querySelector(".dtc-col-default");
    if (numInput && type === "integer") {
      numInput.addEventListener("input", () => {
        if (numInput.value !== "" && numInput.value.includes(".")) {
          numInput.value = Math.trunc(Number(numInput.value));
        }
      });
      numInput.addEventListener("blur", () => {
        if (numInput.value !== "") numInput.value = Math.trunc(Number(numInput.value));
      });
    }

    if (numInput && type === "number") {
      numInput.addEventListener("input", () => {
        const v = numInput.value;
        const clean = v.replace(/[^0-9.\-]/g, "").replace(/(?!^)-/g, "").replace(/(\..*)\./g, "$1");
        if (clean !== v) numInput.value = clean;
      });
    }
  }

  function addSchemaRow(prefillName = "", prefillType = "", prefillDefault = undefined, prefillKey = "") {
    const id = makeSchemaRowId();
    const row = document.createElement("div");
    row.className = "dtc-schema-row";
    row.id = id;
    if (prefillKey) row.dataset.originalKey = prefillKey;

    const initialType = prefillType || COLUMN_TYPES[0].type;
    row.innerHTML = `
      <div class="dtc-drag-handle" title="Drag to reorder">⠿</div>
      <input class="dt-input dtc-col-name" type="text" placeholder="columnName" autocomplete="off" />
      <select class="dt-select dtc-col-type">${TYPE_OPTIONS_HTML}</select>
      <div class="dtc-col-default-wrap">${makeDefaultInput(initialType)}</div>
      <span class="dte-rule-divider"></span>
      <select class="dt-select dtc-rule-lookup" title="Super Users may only choose from these values">${LOOKUP_OPTIONS_HTML}</select>
      <span class="dtc-rule-src">
        <select class="dt-select dtc-rule-table" hidden>${lookupTableOptions(_currentTableId)}</select>
        <button type="button" class="btn btn-secondary btn-sm dtc-rule-list-btn" hidden>Edit list</button>
      </span>
      <span class="dte-rule-tick"><input type="checkbox" class="dtc-rule-protected" title="Super Users cannot change this column"></span>
      <span class="dte-rule-tick"><input type="checkbox" class="dtc-rule-mandatory" title="Super Users cannot leave this column empty"></span>
      <span class="dte-rule-tick"><input type="checkbox" class="dtc-rule-hidden" title="Super Users do not see this column"></span>
      <button class="btn btn-sm dtc-del-btn" title="Remove column">×</button>
    `;

    row.querySelector(".dtc-drag-handle").addEventListener("mousedown", () => { row.draggable = true; });
    row.addEventListener("dragend", () => { row.draggable = false; });

    if (prefillName) row.querySelector(".dtc-col-name").value = prefillName;
    if (prefillType) row.querySelector(".dtc-col-type").value = prefillType;

    row.querySelector(".dtc-del-btn").addEventListener("click", () => { closeListEditor(row); row.remove(); });

    wireDefaultHandlers(row);
    if (prefillDefault !== undefined) {
      const boolInput = row.querySelector(".dtc-col-default-bool");
      const textInput = row.querySelector(".dtc-col-default");
      if (boolInput) {
        boolInput.checked = prefillDefault === true;
        boolInput.nextElementSibling.textContent = boolInput.checked ? "true" : "false";
      } else if (textInput) {
        textInput.value = String(prefillDefault);
      }
    }

    row.__listValues = [];
    const $listBtn = row.querySelector(".dtc-rule-list-btn");
    $listBtn.addEventListener("click", () => toggleListEditor(row));
    row.querySelector(".dtc-drag-handle").addEventListener("mousedown", () => closeListEditor(row));
    const syncRule = wireLookupPair(row.querySelector(".dtc-rule-lookup"), row.querySelector(".dtc-rule-table"), () => row.querySelector(".dtc-col-type").value, $listBtn);
    row.querySelector(".dtc-col-type").addEventListener("change", (e) => {
      row.querySelector(".dtc-col-default-wrap").innerHTML = makeDefaultInput(e.target.value);
      wireDefaultHandlers(row);
      syncRule();
    });

    $schemaRowsContainer.appendChild(row);
    if (!prefillName) row.querySelector(".dtc-col-name").focus();
  }

  function collectSchema(keyTitle) {
    const properties = {};
    properties.key = { title: keyTitle, type: "string" };

    let displayOrder = 0;
    $schemaRowsContainer.querySelectorAll(".dtc-schema-row").forEach((row) => {
      const name = row.querySelector(".dtc-col-name").value.trim();
      const type = row.querySelector(".dtc-col-type").value;
      if (!name) return;

      const propKey = row.dataset.originalKey || name;
      const prop = { title: name, type, displayOrder };
      displayOrder++;

      const boolInput = row.querySelector(".dtc-col-default-bool");
      const textInput = row.querySelector(".dtc-col-default");
      if (boolInput) {
        prop.default = boolInput.checked;
      } else if (textInput && textInput.value.trim() !== "") {
        const raw = textInput.value.trim();
        prop.default = (type === "integer" || type === "number") ? Number(raw) : raw;
      }

      properties[propKey] = prop;
    });

    return {
      type: "object",
      properties,
      required: ["key"],
      $schema: "http://json-schema.org/draft-04/schema#",
      additionalProperties: false,
    };
  }

  function getOrderedSchemaColumns() {
    const props = _currentTable?.schema?.properties || {};
    const cols = Object.entries(props).map(([name, def]) => ({
      name,
      title: def?.title || name,
      type: def?.type || "string",
      order: name === "key" ? -1 : (def?.displayOrder ?? 9999),
    }));
    cols.sort((a, b) => a.order - b.order);
    return cols;
  }

  function validateSchemaSave() {
    const ok = $name.value.trim() !== ""
      && $division.value !== ""
      && divisionsLoaded
      && !!_currentTableId
      && !_isLoadingTable;
    $schemaSaveBtn.disabled = !ok || !canSchemaEdit;
  }

  function getDirtyRowsCount() {
    return _rowsModels.filter(r => r.isDirty).length;
  }

  function validateRowsSave() {
    const disabled = !_currentTableId || _isLoadingTable || getDirtyRowsCount() === 0;
    $rowsSaveBtn.disabled = disabled || !canRowsSave;
    $rowsUndoBtn.disabled = disabled;
    $rowsAddBtn.disabled = !_currentTableId || _isLoadingTable || !_rowsColumns.length || !canRowsAdd;
    $rowsCopyBtn.disabled = !_currentTableId || _isLoadingTable || !_rowsColumns.length || _selectedRowIds.size !== 1 || !canRowsAdd;
    $rowsDeleteBtn.disabled = !_currentTableId || _isLoadingTable || _selectedRowIds.size === 0 || !canRowsDelete;
    $rowsDeleteBtn.textContent = _selectedRowIds.size > 0
      ? `Delete Selected (${_selectedRowIds.size})`
      : "Delete Selected";
  }

  function resetRowsModeUi() {
    _rowsColumns = [];
    _rowsModels = [];
    _nextRowId = 1;
    _rowsSearchText = "";
    _rowsPage = 1;
    _selectedRowIds = new Set();
    $rowsSearch.value = "";
    $rowsGrid.innerHTML = "";
    $rowsSummary.textContent = "";
    $rowsPagerInfo.textContent = "";
    $rowsRefreshBtn.disabled = true;
    validateRowsSave();
  }

  function buildUiValue(type, sourceValue) {
    if (type === "boolean") return sourceValue === true;
    if (type === "integer" || type === "number") {
      return sourceValue === null || sourceValue === undefined ? "" : String(sourceValue);
    }
    return sourceValue === null || sourceValue === undefined ? "" : String(sourceValue);
  }

  function buildRowUiData(row) {
    const data = {};
    for (const col of _rowsColumns) {
      data[col.name] = buildUiValue(col.type, row?.[col.name]);
    }
    if (!Object.prototype.hasOwnProperty.call(data, "key")) {
      data.key = row?.key === null || row?.key === undefined ? "" : String(row.key);
    }
    return data;
  }

  function cloneData(data) {
    return JSON.parse(JSON.stringify(data));
  }

  function isRowDirty(model) {
    for (const col of _rowsColumns) {
      const name = col.name;
      if (model.data[name] !== model.originalData[name]) return true;
    }
    return false;
  }

  function getFilteredRows() {
    if (!_rowsSearchText) return _rowsModels;
    const q = _rowsSearchText.toLowerCase();
    return _rowsModels.filter((model) => {
      for (const col of _rowsColumns) {
        const raw = model.data[col.name];
        const txt = String(raw ?? "").toLowerCase();
        if (txt.includes(q)) return true;
      }
      return false;
    });
  }

  // Size the key column to the widest key across every row in the table — not
  // just the visible page, so the column doesn't jump while paging. The keys
  // are measured in real pixels: a character count over-estimates narrow text
  // and clips wide text such as an all-caps key. The header can't be clipped
  // by a too-narrow result because thead cells are nowrap, so auto table
  // layout keeps them at their own min-content width.
  const KEY_COL_MIN_PX = 90;
  const KEY_COL_MAX_PX = 460;

  function applyKeyColumnWidth() {
    const $table = $rowsGrid.querySelector(".dte-row-grid");
    const $sample = $table?.querySelector("td.dte-col-key .dt-input");
    if (!$table || !$sample) return;

    const cs = getComputedStyle($sample);
    const cell = getComputedStyle($sample.parentElement);
    if (!_keyMeasureCtx) _keyMeasureCtx = document.createElement("canvas").getContext("2d");
    _keyMeasureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

    let widest = 0;
    for (const model of _rowsModels) {
      const w = _keyMeasureCtx.measureText(String(model.data.key ?? "")).width;
      if (w > widest) widest = w;
    }

    // The measured text sits inside the input's own padding and border, and
    // the input inside the cell's padding; 4px of slack leaves room for the
    // caret at the end of the longest value.
    const chrome =
      parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
      parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) +
      parseFloat(cell.paddingLeft) + parseFloat(cell.paddingRight) + 4;

    const width = Math.min(KEY_COL_MAX_PX, Math.max(KEY_COL_MIN_PX, Math.ceil(widest + chrome)));
    $table.style.setProperty("--dte-key-w", `${width}px`);
  }

  function updateRowsSummary(filteredCount, totalCount) {
    const dirty = getDirtyRowsCount();
    $rowsSummary.textContent = `Showing ${filteredCount} of ${totalCount} row(s). Dirty rows: ${dirty}. Selected rows: ${_selectedRowIds.size}.`;
  }

  function renderRowsGrid() {
    const all = getFilteredRows();
    const total = all.length;
    const pageCount = Math.max(1, Math.ceil(total / _rowsPageSizeValue));
    if (_rowsPage > pageCount) _rowsPage = pageCount;
    if (_rowsPage < 1) _rowsPage = 1;

    const start = (_rowsPage - 1) * _rowsPageSizeValue;
    const end = start + _rowsPageSizeValue;
    const pageRows = all.slice(start, end);

    updateRowsSummary(total, _rowsModels.length);

    if (!pageRows.length) {
      $rowsGrid.innerHTML = `<div class="dt-status">No rows match your search.</div>`;
      $rowsPagerInfo.textContent = `Page 1/1`;
      $rowsPrevBtn.disabled = true;
      $rowsNextBtn.disabled = true;
      validateRowsSave();
      return;
    }

    const ruleHint = (col) => {
      const r = _rules.columns[col.name];
      if (!r) return "";
      const bits = [];
      if (r.lookup) bits.push(lookupLabel(r.lookup) + (r.lookup === "dataTable" ? ` (${escapeHtml((_tablesForLookup.find(t => t.id === r.tableId) || {}).name || "?")})` : ""));
      if (r.protected) bits.push("Protected");
      if (r.mandatory) bits.push("Mandatory");
      if (r.hidden) bits.push("Hidden");
      return bits.length ? `<span class="dte-col-hint" title="Super User rule — not enforced on this page">${bits.join(" · ")}</span>` : "";
    };
    const header = _rowsColumns
      .map(col => `<th class="dte-col${col.name === "key" ? " dte-col-key" : ""}">${escapeHtml(col.title)}${col.name === "key" ? " *" : ""}${ruleHint(col)}</th>`)
      .join("");

    const allSelectedOnPage = pageRows.length > 0 && pageRows.every(m => _selectedRowIds.has(m.id));

    const body = pageRows.map((model) => {
      const tds = _rowsColumns.map((col, idx) => {
        const value = model.data[col.name];
        const inputId = `dte-r-${model.id}-${idx}`;
        const label = `${col.title}${col.name === "key" ? " *" : ""}`;
        const colClass = `dte-col${col.name === "key" ? " dte-col-key" : ""}`;
        if (col.type === "boolean") {
          return `
            <td class="${colClass}" data-label="${escapeHtml(label)}">
              <label class="dtc-bool-wrap" for="${inputId}">
                <input id="${inputId}" type="checkbox" data-row-id="${model.id}" data-col-name="${escapeHtml(col.name)}" data-col-type="boolean" ${value === true ? "checked" : ""} />
                <span class="dtc-bool-label">${value === true ? "true" : "false"}</span>
              </label>
            </td>
          `;
        }

        const inputType = (col.type === "integer" || col.type === "number") ? "number" : "text";
        const step = col.type === "integer" ? "step=\"1\"" : (col.type === "number" ? "step=\"any\"" : "");
        return `
          <td class="${colClass}" data-label="${escapeHtml(label)}">
            <input id="${inputId}" class="dt-input" type="${inputType}" ${step} data-row-id="${model.id}" data-col-name="${escapeHtml(col.name)}" data-col-type="${escapeHtml(col.type)}" value="${escapeHtml(String(value ?? ""))}" autocomplete="off" />
          </td>
        `;
      }).join("");

      const rowClass = model.isDirty ? "dte-row-dirty" : "";
      const statusLabel = model.status || (model.isNew ? "New row" : (model.isDirty ? "Pending changes" : "Clean"));
      const selected = _selectedRowIds.has(model.id) ? "checked" : "";

      return `
        <tr class="${rowClass}">
          <td data-label="Select">
            <input type="checkbox" data-row-select-id="${model.id}" ${selected} />
          </td>
          ${tds}
          <td data-label="Status"><span class="dte-row-status">${escapeHtml(statusLabel)}</span></td>
        </tr>
      `;
    }).join("");

    $rowsGrid.innerHTML = `
      <div class="dte-row-grid-wrap">
        <table class="dte-row-grid">
          <thead>
            <tr>
              <th><input type="checkbox" data-select-all-page="1" ${allSelectedOnPage ? "checked" : ""} /></th>
              ${header}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${body}
          </tbody>
        </table>
      </div>
    `;

    applyKeyColumnWidth();

    $rowsPagerInfo.textContent = `Page ${_rowsPage}/${pageCount}`;
    $rowsPrevBtn.disabled = _rowsPage <= 1;
    $rowsNextBtn.disabled = _rowsPage >= pageCount;
    validateRowsSave();
  }

  function getModelById(idStr) {
    const id = Number(idStr);
    return _rowsModels.find(r => r.id === id) || null;
  }

  function onRowsGridInput(evt) {
    const target = evt.target;
    if (!target || !target.dataset) return;
    if (target.dataset.rowSelectId || target.dataset.selectAllPage) return;
    if (!target.dataset.rowId || !target.dataset.colName) return;

    const model = getModelById(target.dataset.rowId);
    if (!model) return;

    const colName = target.dataset.colName;
    const colType = target.dataset.colType || "string";

    if (colType === "boolean") {
      model.data[colName] = !!target.checked;
      const label = target.closest("label")?.querySelector(".dtc-bool-label");
      if (label) label.textContent = target.checked ? "true" : "false";
    } else {
      model.data[colName] = target.value;
    }

    model.isDirty = model.isNew ? true : isRowDirty(model);
    if (model.isDirty && (!model.status || model.status === "Clean")) {
      model.status = model.isNew ? "New row" : "Pending changes";
    }
    if (!model.isDirty && !model.isNew) {
      model.status = "Clean";
    }

    updateRowsSummary(getFilteredRows().length, _rowsModels.length);
    validateRowsSave();

    const tr = target.closest("tr");
    if (tr) tr.classList.toggle("dte-row-dirty", model.isDirty);
  }

  function onRowsGridSelectionChange(evt) {
    const target = evt.target;
    if (!target || !target.dataset) return;

    if (target.dataset.rowSelectId) {
      const id = Number(target.dataset.rowSelectId);
      if (target.checked) _selectedRowIds.add(id);
      else _selectedRowIds.delete(id);
      updateRowsSummary(getFilteredRows().length, _rowsModels.length);
      validateRowsSave();
      return;
    }

    if (target.dataset.selectAllPage) {
      const all = getFilteredRows();
      const start = (_rowsPage - 1) * _rowsPageSizeValue;
      const end = start + _rowsPageSizeValue;
      const pageRows = all.slice(start, end);
      for (const model of pageRows) {
        if (target.checked) _selectedRowIds.add(model.id);
        else _selectedRowIds.delete(model.id);
      }
      renderRowsGrid();
      return;
    }
  }

  function parseRowPayload(model) {
    const payload = {};

    for (const col of _rowsColumns) {
      const raw = model.data[col.name];
      if (col.type === "boolean") {
        payload[col.name] = !!raw;
        continue;
      }

      const text = String(raw ?? "").trim();
      if (col.type === "integer") {
        if (text === "") {
          payload[col.name] = null;
        } else {
          const parsed = Number(text);
          if (!Number.isFinite(parsed)) throw new Error(`Invalid integer in column '${col.title}'.`);
          payload[col.name] = Math.trunc(parsed);
        }
        continue;
      }

      if (col.type === "number") {
        if (text === "") {
          payload[col.name] = null;
        } else {
          const parsed = Number(text);
          if (!Number.isFinite(parsed)) throw new Error(`Invalid decimal in column '${col.title}'.`);
          payload[col.name] = parsed;
        }
        continue;
      }

      payload[col.name] = String(raw ?? "");
    }

    const key = String(payload.key ?? "").trim();
    if (!key) throw new Error("Row key is required.");
    payload.key = key;

    return payload;
  }

  async function loadDivisions() {
    const orgId = orgContext.get();
    if (!orgId) {
      setStatus("Please select a customer org first.", "error");
      return false;
    }

    divisionBusy(true);
    try {
      const divs = await gc.fetchAllDivisions(api, orgId);
      const sorted = (divs || []).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      $division.innerHTML = `<option value="">Select division…</option>`
        + sorted.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join("");
      divisionsLoaded = true;
      return true;
    } catch (err) {
      setStatus(`Failed to load divisions: ${err.message}`, "error");
      return false;
    } finally {
      divisionBusy(false);
    }
  }

  async function loadTablesList() {
    const orgId = orgContext.get();
    if (!orgId) {
      setStatus("Please select a customer org first.", "error");
      return;
    }

    tableSelect.setEnabled(false);
    setStatus("Loading data tables…");
    try {
      const tables = await gc.fetchAllDataTables(api, orgId);
      const sorted = (tables || []).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      tableSelect.setItems(sorted.map(t => ({ id: t.id, label: t.name })));
      _tablesForLookup = sorted.map(t => ({ id: t.id, name: t.name }));
      tableSelect.setEnabled(true);
      setStatus(sorted.length ? "" : "No data tables found in this org.");
    } catch (err) {
      setStatus(`Failed to load data tables: ${err.message}`, "error");
      tableSelect.setItems([]);
      tableSelect.setEnabled(true);
    }
  }

  async function loadRowsList() {
    const orgId = orgContext.get();
    if (!orgId || !_currentTableId) return;

    $rowsRefreshBtn.disabled = true;
    setStatus("Loading rows…");

    try {
      const rows = await gc.fetchDataTableRows(api, orgId, _currentTableId, {
        query: { showbrief: "false" },
      });

      _rowsColumns = getOrderedSchemaColumns();
      _rowsModels = (Array.isArray(rows) ? rows : []).map((row) => {
        const data = buildRowUiData(row);
        return {
          id: _nextRowId++,
          originalKey: String(row?.key ?? ""),
          originalData: cloneData(data),
          data,
          isNew: false,
          isDirty: false,
          status: "Clean",
        };
      });

      _rowsSearchText = "";
      _rowsPage = 1;
      _selectedRowIds = new Set();
      $rowsSearch.value = "";

      renderRowsGrid();
      setStatus(`Rows loaded (${_rowsModels.length}).`, "success");
    } catch (err) {
      setStatus(`Failed to load rows: ${err.message}`, "error");
      resetRowsModeUi();
    } finally {
      $rowsRefreshBtn.disabled = !_currentTableId;
      validateRowsSave();
    }
  }

  async function loadSelectedTable(tableId) {
    const orgId = orgContext.get();
    if (!orgId) {
      setStatus("Please select a customer org first.", "error");
      return;
    }
    if (!tableId) {
      _currentTableId = null;
      _currentTable = null;
      $form.hidden = true;
      $actions.hidden = true;
      resetRowsModeUi();
      validateSchemaSave();
      return;
    }

    _isLoadingTable = true;
    validateSchemaSave();
    validateRowsSave();
    setStatus("Loading data table…");

    try {
      const [table, rules] = await Promise.all([
        gc.getDataTable(api, orgId, tableId),
        getDataTableRules(orgId, tableId).catch((err) => { setStatus(`Rules could not be loaded: ${err.message}`, "error"); return null; }),
        divisionsLoaded ? true : loadDivisions(),
      ]);

      _currentTableId = tableId;
      _currentTable = table;

      $name.value = table.name || "";
      $description.value = table.description || "";
      $key.value = table.schema?.properties?.key?.title || "key";
      if (table.division?.id) {
        $division.value = table.division.id;
      }

      $schemaRowsContainer.innerHTML = "";
      const props = table.schema?.properties || {};
      const schemaColumns = Object.entries(props)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => ({ key: k, name: v.title || k, type: v.type, default: v.default, order: v.displayOrder ?? 9999 }))
        .sort((a, b) => a.order - b.order);
      schemaColumns.forEach(col => addSchemaRow(col.name, col.type, col.default, col.key));
      applyRulesToControls(rules || EMPTY_RULES);
      _rulesLoadFailed = !rules;

      $form.hidden = false;
      $actions.hidden = false;
      sizeTableColumn();                 // measurable only once the form is shown
      $rowsRefreshBtn.disabled = false;

      if (_mode === "rows") {
        await loadRowsList();
        setStatus("Rows mode loaded.", "success");
      } else {
        setStatus("Schema mode loaded.", "success");
      }
    } catch (err) {
      setStatus(`Failed to load data table: ${err.message}`, "error");
      _currentTableId = null;
      _currentTable = null;
      $form.hidden = true;
      $actions.hidden = true;
      resetRowsModeUi();
    } finally {
      _isLoadingTable = false;
      validateSchemaSave();
      validateRowsSave();
    }
  }

  function initSchemaDragDrop() {
    let dragging = null;

    function clearIndicators() {
      $schemaRowsContainer.querySelectorAll(".dtc--drop-above, .dtc--drop-below")
        .forEach(r => r.classList.remove("dtc--drop-above", "dtc--drop-below"));
    }

    $schemaRowsContainer.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".dtc-schema-row");
      if (!row) return;
      dragging = row;
      row.classList.add("dtc--dragging");
      e.dataTransfer.effectAllowed = "move";
    });

    $schemaRowsContainer.addEventListener("dragover", (e) => {
      e.preventDefault();
      const row = e.target.closest(".dtc-schema-row");
      if (!row || row === dragging) return;
      clearIndicators();
      const rect = row.getBoundingClientRect();
      row.classList.add(e.clientY < rect.top + rect.height / 2 ? "dtc--drop-above" : "dtc--drop-below");
    });

    $schemaRowsContainer.addEventListener("dragleave", (e) => {
      if (!$schemaRowsContainer.contains(e.relatedTarget)) clearIndicators();
    });

    $schemaRowsContainer.addEventListener("drop", (e) => {
      e.preventDefault();
      const target = e.target.closest(".dtc-schema-row");
      if (!target || target === dragging) { clearIndicators(); return; }
      const above = target.classList.contains("dtc--drop-above");
      clearIndicators();
      if (above) {
        $schemaRowsContainer.insertBefore(dragging, target);
      } else {
        target.insertAdjacentElement("afterend", dragging);
      }
    });

    $schemaRowsContainer.addEventListener("dragend", () => {
      if (dragging) {
        dragging.classList.remove("dtc--dragging");
        dragging.draggable = false;
      }
      dragging = null;
      clearIndicators();
    });
  }

  $modeSchemaBtn.addEventListener("click", () => setMode("schema"));
  $modeRowsBtn.addEventListener("click", () => setMode("rows"));

  [$name, $division].forEach((input) => {
    input.addEventListener("input", validateSchemaSave);
    input.addEventListener("change", validateSchemaSave);
  });

  $addSchemaRowBtn.addEventListener("click", () => addSchemaRow());
  initSchemaDragDrop();

  $rowsRefreshBtn.addEventListener("click", async () => {
    if (!_currentTableId) return;
    await loadRowsList();
  });

  $rowsAddBtn.addEventListener("click", () => {
    if (!_currentTableId || !_rowsColumns.length) return;

    const data = {};
    for (const col of _rowsColumns) {
      data[col.name] = col.type === "boolean" ? false : "";
    }

    const newModel = {
      id: _nextRowId++,
      originalKey: "",
      originalData: cloneData(data),
      data,
      isNew: true,
      isDirty: true,
      status: "New row",
    };

    _rowsModels.unshift(newModel);
    _rowsPage = 1;
    renderRowsGrid();
    validateRowsSave();
    setStatus("New row added. Fill values and click Save Changes.");
  });

  // ── Copy Row ──────────────────────────────────────────────────────────
  // Prompt for a new key value, then create a pending copy of the selected
  // row (saved later via Save Changes, like Add Row).
  function promptForNewKey(keyTitle, onConfirm) {
    const existingKeys = new Set(
      _rowsModels.map(m => String(m.data.key ?? "").trim()).filter(Boolean)
    );

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:color-mix(in srgb, var(--backdrop) 60%, transparent);z-index:1000;display:flex;align-items:center;justify-content:center";
    overlay.innerHTML = `
      <div style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:24px;min-width:320px;max-width:440px;width:90%">
        <h3 style="margin:0 0 8px;font-size:1.1rem">Copy Row</h3>
        <p style="margin:0 0 14px;color:var(--muted);font-size:.9rem">
          Enter a new value for the key column${keyTitle ? ` (<strong>${escapeHtml(keyTitle)}</strong>)` : ""}.
          The copied row will be added as a pending row — click Save Changes to persist it.
        </p>
        <input class="dt-input" id="dteCopyKeyInput" type="text" placeholder="New key value…" autocomplete="off" style="width:100%;box-sizing:border-box" />
        <div class="dt-status dt-status--error" id="dteCopyKeyError" style="margin-top:8px;min-height:18px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
          <button id="dteCopyKeyCancel" class="btn btn-secondary" type="button">Cancel</button>
          <button id="dteCopyKeyConfirm" class="btn" type="button">Create</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const $input   = overlay.querySelector("#dteCopyKeyInput");
    const $error   = overlay.querySelector("#dteCopyKeyError");
    const $cancel  = overlay.querySelector("#dteCopyKeyCancel");
    const $confirm = overlay.querySelector("#dteCopyKeyConfirm");

    const close = () => document.body.removeChild(overlay);

    const submit = () => {
      const newKey = $input.value.trim();
      if (!newKey) {
        $error.textContent = "Key value is required.";
        return;
      }
      if (existingKeys.has(newKey)) {
        $error.textContent = `A row with key "${newKey}" already exists.`;
        return;
      }
      close();
      onConfirm(newKey);
    };

    $cancel.addEventListener("click", close);
    $confirm.addEventListener("click", submit);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    $input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
      else { $error.textContent = ""; }
    });

    $input.focus();
  }

  $rowsCopyBtn.addEventListener("click", () => {
    if (!_currentTableId || !_rowsColumns.length) return;
    if (_selectedRowIds.size !== 1) return;

    const sourceId = [..._selectedRowIds][0];
    const source = getModelById(sourceId);
    if (!source) return;

    const keyCol = _rowsColumns.find(c => c.name === "key");
    const keyTitle = keyCol ? keyCol.title : "key";

    promptForNewKey(keyTitle, (newKey) => {
      const data = cloneData(source.data);
      data.key = newKey;

      const newModel = {
        id: _nextRowId++,
        originalKey: "",
        originalData: cloneData(data),
        data,
        isNew: true,
        isDirty: true,
        status: "New row",
      };

      _rowsModels.unshift(newModel);
      _selectedRowIds.clear();
      _rowsSearchText = "";
      $rowsSearch.value = "";
      _rowsPage = 1;
      renderRowsGrid();
      validateRowsSave();
      setStatus("Row copied. Review values and click Save Changes to persist it.");
    });
  });

  $rowsSearch.addEventListener("input", () => {
    _rowsSearchText = $rowsSearch.value.trim().toLowerCase();
    _rowsPage = 1;
    renderRowsGrid();
  });

  $rowsPageSize.addEventListener("change", () => {
    const nextSize = Number($rowsPageSize.value);
    if (![50, 100, 200].includes(nextSize)) return;
    _rowsPageSizeValue = nextSize;
    _rowsPage = 1;
    renderRowsGrid();
  });

  $rowsPrevBtn.addEventListener("click", () => {
    _rowsPage = Math.max(1, _rowsPage - 1);
    renderRowsGrid();
  });

  $rowsNextBtn.addEventListener("click", () => {
    _rowsPage = _rowsPage + 1;
    renderRowsGrid();
  });

  $rowsGrid.addEventListener("input", onRowsGridInput);
  $rowsGrid.addEventListener("change", onRowsGridInput);
  $rowsGrid.addEventListener("change", onRowsGridSelectionChange);

  $rowsUndoBtn.addEventListener("click", () => {
    if (!_rowsModels.length) return;

    _rowsModels = _rowsModels
      .filter((model) => !model.isNew)
      .map((model) => {
        model.data = cloneData(model.originalData);
        model.isDirty = false;
        model.status = "Clean";
        return model;
      });

    _selectedRowIds = new Set();

    renderRowsGrid();
    validateRowsSave();
    setStatus("All unsaved row changes were reverted.");
  });

  $rowsDeleteBtn.addEventListener("click", async () => {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("No org selected.", "error"); return; }
    if (!_currentTableId) { setStatus("No table loaded.", "error"); return; }
    if (_selectedRowIds.size === 0) return;

    const selected = _rowsModels.filter(m => _selectedRowIds.has(m.id));
    if (!selected.length) return;

    const accepted = window.confirm(`Delete ${selected.length} selected row(s)?`);
    if (!accepted) return;

    $rowsDeleteBtn.disabled = true;
    setStatus(`Deleting ${selected.length} row(s)…`);

    let ok = 0;
    let fail = 0;
    const keepIds = new Set();

    for (const model of selected) {
      if (model.isNew) {
        ok++;
        continue;
      }

      try {
        const keyToDelete = String(model.originalKey || model.data.key || "").trim();
        if (!keyToDelete) throw new Error("Missing row key for delete.");
        await gc.deleteDataTableRow(api, orgId, _currentTableId, keyToDelete);
        ok++;
      } catch (err) {
        model.status = `Error: ${err.message}`;
        keepIds.add(model.id);
        fail++;
      }
    }

    _rowsModels = _rowsModels.filter((m) => {
      if (!_selectedRowIds.has(m.id)) return true;
      return keepIds.has(m.id);
    });
    _selectedRowIds = keepIds;

    if (fail === 0) {
      setStatus(`✓ Deleted ${ok} row(s).`, "success");
    } else {
      setStatus(`Deleted ${ok} row(s), ${fail} failed.`, "error");
    }

    renderRowsGrid();
    validateRowsSave();

    logAction({
      me,
      orgId,
      action: "datatable_edit",
      description: `Deleted selected rows in '${_currentTable?.name || _currentTableId}'. Success: ${ok}, Failed: ${fail}`,
      result: fail ? "failure" : "success",
      errorMessage: fail ? `${fail} row(s) failed to delete` : undefined,
    });
  });

  $schemaSaveBtn.addEventListener("click", async () => {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("No org selected.", "error"); return; }
    if (!_currentTableId) { setStatus("No table loaded.", "error"); return; }

    const name = $name.value.trim();
    const divisionId = $division.value;
    const description = $description.value.trim();
    const keyTitle = $key.value.trim();

    if (!name || !divisionId) {
      setStatus("Name and Division are required.", "error");
      return;
    }

    $schemaSaveBtn.disabled = true;
    setStatus("Saving data table schema…");

    try {
      const schema = collectSchema(keyTitle);
      const body = {
        id: _currentTableId,
        name,
        description: description || undefined,
        division: { id: divisionId },
        schema,
      };

      await gc.putDataTable(api, orgId, _currentTableId, body);
      _currentTable = { ..._currentTable, name, description, division: { id: divisionId }, schema };

      const divName = $division.options[$division.selectedIndex]?.text || divisionId;

      // Then the Super User rules — a different store, so a second call; the
      // rarer failure goes last, and says so without pretending the schema
      // did not save.
      let rulesNote = "";
      if (_rulesLoadFailed) {
        rulesNote = " Super User rules were NOT saved: they could not be loaded, and saving would have overwritten them blind. Reload the table and save again.";
      } else {
        try {
          const rules = collectRules();
          const r = await setDataTableRules(orgId, _currentTableId, rules, name);
          applyRulesToControls(r.rules || rules);
          const n = Object.keys((r.rules || rules).columns).length;
          const saved = r.rules || rules;
          rulesNote = ` Super User rules saved: ${saved.visibleToSupervisors ? "visible to Super Users" : "not visible to Super Users"}, ${n} column rule${n === 1 ? "" : "s"}${saved.mayAddRows ? ", may add rows" : ""}.`;
        } catch (err) {
          rulesNote = ` Schema saved, but the Super User rules were not: ${err.message}`;
        }
      }
      setStatus(`✓ Data table "${escapeHtml(name)}" saved successfully.${rulesNote}`, rulesNote.includes("NOT") || rulesNote.includes("were not") ? "error" : "success");
      logAction({
        me,
        orgId,
        action: "datatable_edit",
        description: `Edited data table '${name}' in division '${divName}'`,
      });
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
      logAction({
        me,
        orgId,
        action: "datatable_edit",
        description: `Failed to edit data table '${$name.value.trim()}': ${err.message}`,
        result: "failure",
        errorMessage: err.message,
      });
    } finally {
      validateSchemaSave();
    }
  });

  $rowsSaveBtn.addEventListener("click", async () => {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("No org selected.", "error"); return; }
    if (!_currentTableId) { setStatus("No table loaded.", "error"); return; }

    const dirtyRows = _rowsModels.filter(r => r.isDirty);
    if (!dirtyRows.length) {
      setStatus("No row changes to save.");
      return;
    }

    $rowsSaveBtn.disabled = true;
    setStatus(`Saving ${dirtyRows.length} row change(s)…`);

    let ok = 0;
    let fail = 0;

    for (const model of dirtyRows) {
      try {
        const payload = parseRowPayload(model);
        const oldKey = String(model.originalKey ?? "");
        const newKey = String(payload.key ?? "");
        const keyChanged = newKey !== oldKey;

        if (model.isNew) {
          await gc.createDataTableRow(api, orgId, _currentTableId, payload);
        } else if (keyChanged) {
          await gc.createDataTableRow(api, orgId, _currentTableId, payload);
          await gc.deleteDataTableRow(api, orgId, _currentTableId, oldKey);
        } else {
          try {
            await gc.putDataTableRow(api, orgId, _currentTableId, oldKey, payload);
          } catch (err) {
            if (err?.status === 404 || err?.status === 405) {
              await gc.deleteDataTableRow(api, orgId, _currentTableId, oldKey);
              await gc.createDataTableRow(api, orgId, _currentTableId, payload);
            } else {
              throw err;
            }
          }
        }

        model.originalKey = newKey;
        model.originalData = cloneData(model.data);
        model.isNew = false;
        model.isDirty = false;
        model.status = "Saved";
        ok++;
      } catch (err) {
        model.status = `Error: ${err.message}`;
        fail++;
      }
    }

    if (fail === 0) {
      setStatus(`✓ Saved ${ok} row(s) successfully.`, "success");
    } else {
      setStatus(`Saved ${ok} row(s), ${fail} failed.`, "error");
    }

    renderRowsGrid();
    validateRowsSave();

    logAction({
      me,
      orgId,
      action: "datatable_edit",
      description: `Saved data table rows for '${_currentTable?.name || _currentTableId}'. Success: ${ok}, Failed: ${fail}`,
      result: fail ? "failure" : "success",
      errorMessage: fail ? `${fail} row(s) failed to save` : undefined,
    });
  });

  loadTablesList();
  resetRowsModeUi();
  setMode("schema");

  return el;
}
