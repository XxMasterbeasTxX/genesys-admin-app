/**
 * Data Tables › Edit
 *
 * Edits an existing data table in the currently-selected customer org.
 *
 * Flow:
 *   1. User selects an org (via orgContext)
 *   2. Picks a data table from the dropdown → clicks "Load"
 *   3. Form populates with Name, Division, Description, Key (read-only),
 *      and schema columns (draggable)
 *   4. "Save" is enabled once Name + Division are non-empty
 *   5. On save: PUT /api/v2/flows/datatables/{tableId}
 *
 * API endpoints:
 *   GET  /api/v2/flows/datatables                 — list tables for picker
 *   GET  /api/v2/flows/datatables/{id}?expand=schema — fetch single table
 *   GET  /api/v2/authorization/divisions           — list divisions for dropdown
 *   PUT  /api/v2/flows/datatables/{id}             — update table
 */
import { escapeHtml } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { logAction } from "../../services/activityLogService.js";

// Column type options (alphabetical) → { label, jsonType }
const COLUMN_TYPES = [
  { label: "Boolean", type: "boolean" },
  { label: "Decimal", type: "number"  },
  { label: "Integer", type: "integer" },
  { label: "String",  type: "string"  },
];

const TYPE_OPTIONS_HTML = COLUMN_TYPES
  .map(t => `<option value="${t.type}">${t.label}</option>`)
  .join("");

// ── Page renderer ──────────────────────────────────────────────────

export default function renderEditDataTable({ route, me, api, orgContext }) {
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
        min-width: 900px;
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
      Use Schema mode for table structure, or Rows mode for row values.
    </p>

    <!-- Table picker -->
    <div class="dt-controls" style="margin-bottom:12px">
      <div class="dt-control-group" style="flex:1;max-width:400px">
        <label class="dt-label" for="dteTableSelect">Data Table</label>
        <select class="dt-select" id="dteTableSelect">
          <option value="">Select a data table…</option>
        </select>
      </div>
      <div class="dt-control-group" style="align-self:flex-end">
        <button class="btn" id="dteLoadBtn" disabled>Load</button>
      </div>
    </div>

    <!-- Mode switch -->
    <div class="dt-controls" style="margin-bottom:12px">
      <div class="dt-control-group">
        <label class="dt-label">Edit Mode</label>
        <div class="dte-mode-toggle">
          <button class="dte-mode-btn active" id="dteModeSchema" type="button">Schema</button>
          <button class="dte-mode-btn" id="dteModeRows" type="button">Rows</button>
        </div>
      </div>
    </div>

    <!-- Top action buttons -->
    <div class="dt-actions" id="dteActions" hidden>
      <button class="btn" id="dteSchemaSaveBtn" disabled>Save Schema</button>
      <button class="btn" id="dteRowSaveBtn" hidden disabled>Save Row</button>
    </div>

    <!-- Status -->
    <div class="dt-status" id="dteStatus"></div>

    <!-- Expandable form -->
    <div id="dteForm" hidden>
      <hr class="hr" style="margin-bottom:18px">

      <!-- Schema mode -->
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

      <!-- Rows mode -->
      <div id="dteRowsMode" hidden>
        <div class="dt-controls" style="margin-bottom:12px">
          <div class="dt-control-group" style="flex:1;max-width:420px">
            <label class="dt-label" for="dteRowSelect">Row</label>
            <select class="dt-select" id="dteRowSelect">
              <option value="">Load a table first…</option>
            </select>
          </div>
          <div class="dt-control-group" style="align-self:flex-end">
            <button class="btn btn-secondary" id="dteRowsRefreshBtn" type="button" disabled>Refresh Rows</button>
          </div>
        </div>

        <div id="dteRowEditor" hidden>
          <div class="dtc-schema-section">
            <div class="dtc-schema-header">
              <span class="dt-label">Row Values</span>
            </div>
            <div class="dt-status" id="dteRowHint" style="margin-bottom:8px">
              Edit any value. If key changes, save performs create new row + delete old row.
            </div>
            <div id="dteRowFields"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  const $tableSelect = el.querySelector("#dteTableSelect");
  const $loadBtn = el.querySelector("#dteLoadBtn");
  const $modeSchemaBtn = el.querySelector("#dteModeSchema");
  const $modeRowsBtn = el.querySelector("#dteModeRows");
  const $actions = el.querySelector("#dteActions");
  const $schemaSaveBtn = el.querySelector("#dteSchemaSaveBtn");
  const $rowSaveBtn = el.querySelector("#dteRowSaveBtn");
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

  const $rowSelect = el.querySelector("#dteRowSelect");
  const $rowsRefreshBtn = el.querySelector("#dteRowsRefreshBtn");
  const $rowEditor = el.querySelector("#dteRowEditor");
  const $rowFields = el.querySelector("#dteRowFields");

  let divisionsLoaded = false;
  let schemaRowCounter = 0;
  let _mode = "schema";
  let _currentTableId = null;
  let _currentTable = null;
  let _rows = [];
  let _currentRowOriginalKey = "";

  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "dt-status" + (type ? ` dt-status--${type}` : "");
  }

  function getSafeRowKey(row) {
    return String(row?.key ?? "");
  }

  function setMode(nextMode) {
    _mode = nextMode === "rows" ? "rows" : "schema";

    const isSchema = _mode === "schema";
    $schemaMode.hidden = !isSchema;
    $rowsMode.hidden = isSchema;
    $schemaSaveBtn.hidden = !isSchema;
    $rowSaveBtn.hidden = isSchema;

    $modeSchemaBtn.classList.toggle("active", isSchema);
    $modeRowsBtn.classList.toggle("active", !isSchema);

    validateSchemaSave();
    validateRowSave();

    if (!isSchema && _currentTableId && !_rows.length) {
      loadRowsList();
    }
  }

  function validateSchemaSave() {
    const ok = $name.value.trim() !== ""
      && $division.value !== ""
      && divisionsLoaded
      && _currentTableId;
    $schemaSaveBtn.disabled = !ok;
  }

  function validateRowSave() {
    if (_mode !== "rows") {
      $rowSaveBtn.disabled = true;
      return;
    }
    const keyInput = $rowFields.querySelector('[data-row-col="key"]');
    $rowSaveBtn.disabled = !(_currentTableId && keyInput && keyInput.value.trim() !== "");
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
    $schemaRowsContainer.querySelectorAll(".dtc-schema-row").forEach(row => {
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

  function renderRowEditor(row) {
    const columns = getOrderedSchemaColumns();
    if (!columns.length) {
      $rowEditor.hidden = true;
      return;
    }

    const headerRow = columns.map((col) => {
      const required = col.name === "key" ? " *" : "";
      return `<th>${escapeHtml(col.title + required)}</th>`;
    }).join("");

    const valueRow = columns.map((col, idx) => {
      const isBool = col.type === "boolean";
      const isInt = col.type === "integer";
      const isNum = col.type === "number";
      const inputHtml = isBool
        ? `<label class="dtc-bool-wrap"><input type="checkbox" data-row-col="${escapeHtml(col.name)}" data-row-type="boolean" /><span class="dtc-bool-label">false</span></label>`
        : `<input class="dt-input" type="${isInt || isNum ? "number" : "text"}" ${isInt ? "step=\"1\"" : ""} ${isNum ? "step=\"any\"" : ""} data-row-col="${escapeHtml(col.name)}" data-row-type="${escapeHtml(col.type)}" autocomplete="off" />`;
      const mobileLabel = `${escapeHtml(col.title)}${col.name === "key" ? " *" : ""}`;
      return `<td data-label="${mobileLabel}"><div id="dte-row-${idx}">${inputHtml}</div></td>`;
    }).join("");

    $rowFields.innerHTML = `
      <div class="dte-row-grid-wrap">
        <table class="dte-row-grid">
          <thead>
            <tr>${headerRow}</tr>
          </thead>
          <tbody>
            <tr>${valueRow}</tr>
          </tbody>
        </table>
      </div>
    `;

    columns.forEach((col) => {
      const input = $rowFields.querySelector(`[data-row-col="${CSS.escape(col.name)}"]`);
      if (!input) return;
      const currentValue = row?.[col.name];
      if (col.type === "boolean") {
        input.checked = currentValue === true;
        if (input.nextElementSibling) {
          input.nextElementSibling.textContent = input.checked ? "true" : "false";
        }
        input.addEventListener("change", () => {
          if (input.nextElementSibling) {
            input.nextElementSibling.textContent = input.checked ? "true" : "false";
          }
          validateRowSave();
        });
      } else {
        input.value = currentValue === undefined || currentValue === null ? "" : String(currentValue);
        input.addEventListener("input", validateRowSave);
      }
    });

    $rowEditor.hidden = false;
    validateRowSave();
  }

  function parseInputValue(type, input) {
    if (type === "boolean") return !!input.checked;

    const raw = input.value.trim();
    if (type === "integer") {
      if (raw === "") return null;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new Error("Integer field contains an invalid number.");
      return Math.trunc(parsed);
    }

    if (type === "number") {
      if (raw === "") return null;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new Error("Decimal field contains an invalid number.");
      return parsed;
    }

    return raw;
  }

  function collectRowPayload() {
    const payload = {};
    const inputs = $rowFields.querySelectorAll("[data-row-col]");
    inputs.forEach((input) => {
      const col = input.dataset.rowCol;
      const type = input.dataset.rowType || "string";
      payload[col] = parseInputValue(type, input);
    });

    if (!payload.key || String(payload.key).trim() === "") {
      throw new Error("Key is required for a row.");
    }
    payload.key = String(payload.key).trim();
    return payload;
  }

  function resetRowsModeUi() {
    _rows = [];
    _currentRowOriginalKey = "";
    $rowSelect.innerHTML = `<option value="">Load a table first…</option>`;
    $rowEditor.hidden = true;
    $rowFields.innerHTML = "";
    $rowsRefreshBtn.disabled = true;
    validateRowSave();
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
        + sorted.map(d =>
          `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`
        ).join("");
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
    $loadBtn.disabled = true;
    try {
      const tables = await gc.fetchAllDataTables(api, orgId);
      const sorted = (tables || []).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      $tableSelect.innerHTML = `<option value="">Select a data table…</option>`
        + sorted.map(t =>
          `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`
        ).join("");
      setStatus(sorted.length ? "" : "No data tables found in this org.");
    } catch (err) {
      setStatus(`Failed to load data tables: ${err.message}`, "error");
      $tableSelect.innerHTML = `<option value="">Select a data table…</option>`;
    }
  }

  async function loadRowsList(preferredKey = "") {
    const orgId = orgContext.get();
    if (!orgId || !_currentTableId) return;

    $rowsRefreshBtn.disabled = true;
    $rowSaveBtn.disabled = true;
    setStatus("Loading rows…");

    try {
      const rows = await gc.fetchDataTableRows(api, orgId, _currentTableId, {
        query: { showbrief: "false" },
      });
      _rows = Array.isArray(rows) ? rows.slice() : [];
      _rows.sort((a, b) => getSafeRowKey(a).localeCompare(getSafeRowKey(b), undefined, { sensitivity: "base" }));

      if (!_rows.length) {
        $rowSelect.innerHTML = `<option value="">No rows found in this table</option>`;
        $rowEditor.hidden = true;
        $rowFields.innerHTML = "";
        _currentRowOriginalKey = "";
        setStatus("This table has no rows yet.");
        return;
      }

      $rowSelect.innerHTML = `<option value="">Select a row by key…</option>`
        + _rows.map((row) => {
          const keyVal = getSafeRowKey(row);
          return `<option value="${escapeHtml(keyVal)}">${escapeHtml(keyVal)}</option>`;
        }).join("");

      const nextKey = preferredKey && _rows.some(r => getSafeRowKey(r) === preferredKey)
        ? preferredKey
        : getSafeRowKey(_rows[0]);

      $rowSelect.value = nextKey;
      const active = _rows.find(r => getSafeRowKey(r) === nextKey) || _rows[0];
      _currentRowOriginalKey = getSafeRowKey(active);
      renderRowEditor(active);
      setStatus(`Loaded ${_rows.length} row(s).`, "success");
    } catch (err) {
      setStatus(`Failed to load rows: ${err.message}`, "error");
      $rowSelect.innerHTML = `<option value="">Failed to load rows</option>`;
      $rowEditor.hidden = true;
      $rowFields.innerHTML = "";
      _currentRowOriginalKey = "";
    } finally {
      $rowsRefreshBtn.disabled = !_currentTableId;
      validateRowSave();
    }
  }

  $tableSelect.addEventListener("change", () => {
    $loadBtn.disabled = !$tableSelect.value;
  });

  $modeSchemaBtn.addEventListener("click", () => setMode("schema"));
  $modeRowsBtn.addEventListener("click", () => setMode("rows"));

  $loadBtn.addEventListener("click", async () => {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("Please select a customer org first.", "error"); return; }
    const tableId = $tableSelect.value;
    if (!tableId) return;

    $loadBtn.disabled = true;
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
      validateSchemaSave();

      if (_mode === "rows") {
        await loadRowsList();
        setStatus("Rows mode loaded. Edit values and click Save Row.");
      } else {
        setStatus("Schema mode loaded. Edit fields and click Save Schema.");
      }
    } catch (err) {
      setStatus(`Failed to load data table: ${err.message}`, "error");
      _currentTableId = null;
      _currentTable = null;
      resetRowsModeUi();
    } finally {
      $loadBtn.disabled = !$tableSelect.value;
      validateSchemaSave();
      validateRowSave();
    }
  });

  [$name, $division].forEach(input => {
    input.addEventListener("input", validateSchemaSave);
    input.addEventListener("change", validateSchemaSave);
  });

  function initDragDrop() {
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

  $addSchemaRowBtn.addEventListener("click", () => addSchemaRow());
  initDragDrop();

  $rowsRefreshBtn.addEventListener("click", async () => {
    if (!_currentTableId) return;
    const keep = $rowSelect.value;
    await loadRowsList(keep);
  });

  $rowSelect.addEventListener("change", () => {
    const keyVal = $rowSelect.value;
    if (!keyVal) {
      $rowEditor.hidden = true;
      $rowFields.innerHTML = "";
      _currentRowOriginalKey = "";
      validateRowSave();
      return;
    }
    const row = _rows.find(r => getSafeRowKey(r) === keyVal);
    if (!row) {
      setStatus("Selected row could not be found.", "error");
      return;
    }
    _currentRowOriginalKey = getSafeRowKey(row);
    renderRowEditor(row);
    setStatus(`Editing row with key "${escapeHtml(_currentRowOriginalKey)}".`);
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
    $loadBtn.disabled = true;
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
      $loadBtn.disabled = !$tableSelect.value;
      validateSchemaSave();
    }
  });

  $rowSaveBtn.addEventListener("click", async () => {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("No org selected.", "error"); return; }
    if (!_currentTableId) { setStatus("No table loaded.", "error"); return; }
    if (!_currentRowOriginalKey) { setStatus("No row selected.", "error"); return; }

    let payload;
    try {
      payload = collectRowPayload();
    } catch (err) {
      setStatus(err.message, "error");
      return;
    }

    const oldKey = _currentRowOriginalKey;
    const newKey = String(payload.key);
    const keyChanged = newKey !== oldKey;

    if (keyChanged) {
      const accepted = window.confirm(
        `Key will change from "${oldKey}" to "${newKey}". This will create a new row and delete the old row. Continue?`
      );
      if (!accepted) return;
    }

    $rowSaveBtn.disabled = true;
    $loadBtn.disabled = true;
    $rowsRefreshBtn.disabled = true;
    setStatus("Saving row…");

    try {
      if (keyChanged) {
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

      await loadRowsList(newKey);
      setStatus(`✓ Row saved successfully (key: "${escapeHtml(newKey)}").`, "success");
      logAction({
        me,
        orgId,
        action: "datatable_edit",
        description: keyChanged
          ? `Edited data table row key from '${oldKey}' to '${newKey}' in table '${_currentTable?.name || _currentTableId}'`
          : `Edited data table row '${newKey}' in table '${_currentTable?.name || _currentTableId}'`,
      });
    } catch (err) {
      setStatus(`Failed to save row: ${err.message}`, "error");
      logAction({
        me,
        orgId,
        action: "datatable_edit",
        description: `Failed to edit data table row '${oldKey}': ${err.message}`,
        result: "failure",
        errorMessage: err.message,
      });
    } finally {
      $loadBtn.disabled = !$tableSelect.value;
      $rowsRefreshBtn.disabled = !_currentTableId;
      validateRowSave();
    }
  });

  loadTablesList();
  resetRowsModeUi();
  setMode("schema");

  return el;
}
