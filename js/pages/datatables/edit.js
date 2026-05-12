/**
 * Data Tables › Edit
 *
 * Two modes:
 *  - Schema: edit table metadata and schema columns
 *  - Rows: edit multiple row values in a paged grid with full-table search
 */
import { escapeHtml } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { logAction } from "../../services/activityLogService.js";

const COLUMN_TYPES = [
  { label: "Boolean", type: "boolean" },
  { label: "Decimal", type: "number" },
  { label: "Integer", type: "integer" },
  { label: "String", type: "string" },
];

const TYPE_OPTIONS_HTML = COLUMN_TYPES
  .map(t => `<option value="${t.type}">${t.label}</option>`)
  .join("");

export default function renderEditDataTable({ me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <style>
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
        background: rgba(59,130,246,.22);
        color: #60a5fa;
      }
      .dte-mode-btn:not(.active):hover {
        background: rgba(255,255,255,.05);
        color: var(--text);
      }

      .dte-row-grid-wrap {
        width: 100%;
        overflow-x: auto;
      }
      .dte-row-grid {
        width: 100%;
        min-width: 980px;
        border-collapse: collapse;
        table-layout: fixed;
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
        background: rgba(59,130,246,.08);
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
        <select class="dt-select" id="dteTableSelect">
          <option value="">Select a data table…</option>
        </select>
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
            <label class="dt-label" for="dteName">Name <span style="color:#f87171">*</span></label>
            <input class="dt-input" id="dteName" type="text" placeholder="e.g. AgentSkillMatrix" autocomplete="off" />
          </div>
          <div class="dt-control-group">
            <label class="dt-label" for="dteDivision">Division <span style="color:#f87171">*</span></label>
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
          <div class="dtc-schema-cols-header">
            <span></span>
            <span class="dtc-col-label">Column Name</span>
            <span class="dtc-col-label">Type</span>
            <span class="dtc-col-label">Default</span>
            <span></span>
          </div>
          <div id="dteSchemaRows"></div>
          <button class="btn btn-sm dtc-add-btn" id="dteAddSchemaRow" style="margin-top:8px">+ Add column</button>
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

  const $tableSelect = el.querySelector("#dteTableSelect");
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
  const $description = el.querySelector("#dteDescription");
  const $key = el.querySelector("#dteKey");
  const $schemaRowsContainer = el.querySelector("#dteSchemaRows");
  const $addSchemaRowBtn = el.querySelector("#dteAddSchemaRow");

  const $rowsSearch = el.querySelector("#dteRowsSearch");
  const $rowsPageSize = el.querySelector("#dteRowsPageSize");
  const $rowsRefreshBtn = el.querySelector("#dteRowsRefreshBtn");
  const $rowsAddBtn = el.querySelector("#dteRowsAddBtn");
  const $rowsDeleteBtn = el.querySelector("#dteRowsDeleteBtn");
  const $rowsSummary = el.querySelector("#dteRowsSummary");
  const $rowsGrid = el.querySelector("#dteRowsGrid");
  const $rowsPrevBtn = el.querySelector("#dteRowsPrevBtn");
  const $rowsNextBtn = el.querySelector("#dteRowsNextBtn");
  const $rowsPagerInfo = el.querySelector("#dteRowsPagerInfo");

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

  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "dt-status" + (type ? ` dt-status--${type}` : "");
  }

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

  function addSchemaRow(prefillName = "", prefillType = "", prefillDefault = undefined) {
    const id = makeSchemaRowId();
    const row = document.createElement("div");
    row.className = "dtc-schema-row";
    row.id = id;

    const initialType = prefillType || COLUMN_TYPES[0].type;
    row.innerHTML = `
      <div class="dtc-drag-handle" title="Drag to reorder">⠿</div>
      <input class="dt-input dtc-col-name" type="text" placeholder="columnName" autocomplete="off" />
      <select class="dt-select dtc-col-type">${TYPE_OPTIONS_HTML}</select>
      <div class="dtc-col-default-wrap">${makeDefaultInput(initialType)}</div>
      <button class="btn btn-sm dtc-del-btn" title="Remove column">×</button>
    `;

    row.querySelector(".dtc-drag-handle").addEventListener("mousedown", () => { row.draggable = true; });
    row.addEventListener("dragend", () => { row.draggable = false; });

    if (prefillName) row.querySelector(".dtc-col-name").value = prefillName;
    if (prefillType) row.querySelector(".dtc-col-type").value = prefillType;

    row.querySelector(".dtc-del-btn").addEventListener("click", () => row.remove());

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

    row.querySelector(".dtc-col-type").addEventListener("change", (e) => {
      row.querySelector(".dtc-col-default-wrap").innerHTML = makeDefaultInput(e.target.value);
      wireDefaultHandlers(row);
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

      properties[name] = prop;
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
    $schemaSaveBtn.disabled = !ok;
  }

  function getDirtyRowsCount() {
    return _rowsModels.filter(r => r.isDirty).length;
  }

  function validateRowsSave() {
    const disabled = !_currentTableId || _isLoadingTable || getDirtyRowsCount() === 0;
    $rowsSaveBtn.disabled = disabled;
    $rowsUndoBtn.disabled = disabled;
    $rowsAddBtn.disabled = !_currentTableId || _isLoadingTable || !_rowsColumns.length;
    $rowsDeleteBtn.disabled = !_currentTableId || _isLoadingTable || _selectedRowIds.size === 0;
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

    const header = _rowsColumns
      .map(col => `<th>${escapeHtml(col.title)}${col.name === "key" ? " *" : ""}</th>`)
      .join("");

    const allSelectedOnPage = pageRows.length > 0 && pageRows.every(m => _selectedRowIds.has(m.id));

    const body = pageRows.map((model) => {
      const tds = _rowsColumns.map((col, idx) => {
        const value = model.data[col.name];
        const inputId = `dte-r-${model.id}-${idx}`;
        const label = `${col.title}${col.name === "key" ? " *" : ""}`;
        if (col.type === "boolean") {
          return `
            <td data-label="${escapeHtml(label)}">
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
          <td data-label="${escapeHtml(label)}">
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
    }
  }

  async function loadTablesList() {
    const orgId = orgContext.get();
    if (!orgId) {
      setStatus("Please select a customer org first.", "error");
      return;
    }

    $tableSelect.innerHTML = `<option value="">Loading…</option>`;
    try {
      const tables = await gc.fetchAllDataTables(api, orgId);
      const sorted = (tables || []).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      $tableSelect.innerHTML = `<option value="">Select a data table…</option>`
        + sorted.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("");
      setStatus(sorted.length ? "" : "No data tables found in this org.");
    } catch (err) {
      setStatus(`Failed to load data tables: ${err.message}`, "error");
      $tableSelect.innerHTML = `<option value="">Select a data table…</option>`;
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
      const [table] = await Promise.all([
        gc.getDataTable(api, orgId, tableId),
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
        .map(([k, v]) => ({ name: v.title || k, type: v.type, default: v.default, order: v.displayOrder ?? 9999 }))
        .sort((a, b) => a.order - b.order);
      schemaColumns.forEach(col => addSchemaRow(col.name, col.type, col.default));

      $form.hidden = false;
      $actions.hidden = false;
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

  $tableSelect.addEventListener("change", () => {
    loadSelectedTable($tableSelect.value);
  });

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

      const divName = $division.options[$division.selectedIndex]?.text || divisionId;
      setStatus(`✓ Data table "${escapeHtml(name)}" saved successfully.`, "success");
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
