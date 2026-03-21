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
    <h2>Data Tables — Edit</h2>
    <p class="page-desc">
      Edit an existing data table in the selected org.
      Select a table, then modify Name, Division, Description, or schema columns.
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

    <!-- Top action buttons -->
    <div class="dt-actions" id="dteActions" hidden>
      <button class="btn" id="dteSaveBtn" disabled>Save</button>
    </div>

    <!-- Status -->
    <div class="dt-status" id="dteStatus"></div>

    <!-- Expandable form -->
    <div id="dteForm" hidden>
      <hr class="hr" style="margin-bottom:18px">

      <!-- Core fields -->
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

      <!-- Schema columns -->
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
        <div id="dteRows"></div>
        <button class="btn btn-sm dtc-add-btn" id="dteAddRow" style="margin-top:8px">+ Add column</button>
      </div>
    </div>
  `;

  // ── Refs ───────────────────────────────────────────────────────
  const $tableSelect  = el.querySelector("#dteTableSelect");
  const $loadBtn      = el.querySelector("#dteLoadBtn");
  const $actions      = el.querySelector("#dteActions");
  const $saveBtn      = el.querySelector("#dteSaveBtn");
  const $status       = el.querySelector("#dteStatus");
  const $form         = el.querySelector("#dteForm");
  const $name         = el.querySelector("#dteName");
  const $division     = el.querySelector("#dteDivision");
  const $description  = el.querySelector("#dteDescription");
  const $key          = el.querySelector("#dteKey");
  const $rowsContainer= el.querySelector("#dteRows");
  const $addRowBtn    = el.querySelector("#dteAddRow");

  let divisionsLoaded = false;
  let rowCounter = 0;
  let _currentTableId = null;
  let _currentTable   = null;

  // ── Helpers ────────────────────────────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "dt-status" + (type ? ` dt-status--${type}` : "");
  }

  function validateSave() {
    const ok = $name.value.trim() !== ""
      && $division.value !== ""
      && divisionsLoaded
      && _currentTableId;
    $saveBtn.disabled = !ok;
  }

  function makeRowId() {
    return `dterow-${++rowCounter}`;
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
    const id = makeRowId();
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
    $rowsContainer.appendChild(row);
    if (!prefillName) row.querySelector(".dtc-col-name").focus();
  }

  function collectSchema(keyTitle) {
    const properties = {};

    properties["key"] = { title: keyTitle, type: "string" };

    let displayOrder = 0;
    $rowsContainer.querySelectorAll(".dtc-schema-row").forEach(row => {
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

  // ── Load divisions ─────────────────────────────────────────────
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

  // ── Load tables list ───────────────────────────────────────────
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

  // ── Table picker events ────────────────────────────────────────
  $tableSelect.addEventListener("change", () => {
    $loadBtn.disabled = !$tableSelect.value;
  });

  $loadBtn.addEventListener("click", async () => {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("Please select a customer org first.", "error"); return; }
    const tableId = $tableSelect.value;
    if (!tableId) return;

    $loadBtn.disabled = true;
    setStatus("Loading data table…");

    try {
      // Fetch table + divisions in parallel
      const [table, divsOk] = await Promise.all([
        gc.getDataTable(api, orgId, tableId),
        divisionsLoaded ? true : loadDivisions(),
      ]);

      _currentTableId = tableId;
      _currentTable   = table;

      // Populate form
      $name.value        = table.name || "";
      $description.value = table.description || "";
      $key.value         = table.schema?.properties?.key?.title || "key";

      // Select division
      if (table.division?.id) {
        $division.value = table.division.id;
      }

      // Populate schema columns (skip "key")
      $rowsContainer.innerHTML = "";
      const props = table.schema?.properties || {};
      const columns = Object.entries(props)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => ({ name: v.title || k, type: v.type, default: v.default, order: v.displayOrder ?? 9999 }))
        .sort((a, b) => a.order - b.order);

      columns.forEach(col => {
        addSchemaRow(col.name, col.type, col.default);
      });

      $form.hidden    = false;
      $actions.hidden = false;
      validateSave();
      setStatus("Edit the fields below and click Save.");
    } catch (err) {
      setStatus(`Failed to load data table: ${err.message}`, "error");
      _currentTableId = null;
      _currentTable   = null;
    } finally {
      $loadBtn.disabled = !$tableSelect.value;
    }
  });

  // ── Live validation ────────────────────────────────────────────
  [$name, $division].forEach(input => {
    input.addEventListener("input",  validateSave);
    input.addEventListener("change", validateSave);
  });

  // ── Drag-to-reorder ────────────────────────────────────────────
  function initDragDrop() {
    let dragging = null;

    function clearIndicators() {
      $rowsContainer.querySelectorAll(".dtc--drop-above, .dtc--drop-below")
        .forEach(r => r.classList.remove("dtc--drop-above", "dtc--drop-below"));
    }

    $rowsContainer.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".dtc-schema-row");
      if (!row) return;
      dragging = row;
      row.classList.add("dtc--dragging");
      e.dataTransfer.effectAllowed = "move";
    });

    $rowsContainer.addEventListener("dragover", (e) => {
      e.preventDefault();
      const row = e.target.closest(".dtc-schema-row");
      if (!row || row === dragging) return;
      clearIndicators();
      const rect = row.getBoundingClientRect();
      row.classList.add(e.clientY < rect.top + rect.height / 2 ? "dtc--drop-above" : "dtc--drop-below");
    });

    $rowsContainer.addEventListener("dragleave", (e) => {
      if (!$rowsContainer.contains(e.relatedTarget)) clearIndicators();
    });

    $rowsContainer.addEventListener("drop", (e) => {
      e.preventDefault();
      const target = e.target.closest(".dtc-schema-row");
      if (!target || target === dragging) { clearIndicators(); return; }
      const above = target.classList.contains("dtc--drop-above");
      clearIndicators();
      if (above) {
        $rowsContainer.insertBefore(dragging, target);
      } else {
        target.insertAdjacentElement("afterend", dragging);
      }
    });

    $rowsContainer.addEventListener("dragend", () => {
      if (dragging) { dragging.classList.remove("dtc--dragging"); dragging.draggable = false; }
      dragging = null;
      clearIndicators();
    });
  }

  // ── Add column button ──────────────────────────────────────────
  $addRowBtn.addEventListener("click", () => addSchemaRow());
  initDragDrop();

  // ── Save button ────────────────────────────────────────────────
  $saveBtn.addEventListener("click", async () => {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("No org selected.", "error"); return; }
    if (!_currentTableId) { setStatus("No table loaded.", "error"); return; }

    const name        = $name.value.trim();
    const divisionId  = $division.value;
    const description = $description.value.trim();
    const keyTitle    = $key.value.trim();

    if (!name || !divisionId) {
      setStatus("Name and Division are required.", "error");
      return;
    }

    $saveBtn.disabled = true;
    $loadBtn.disabled = true;
    setStatus("Saving data table…");

    try {
      const schema = collectSchema(keyTitle);

      const body = {
        id:   _currentTableId,
        name,
        description: description || undefined,
        division: { id: divisionId },
        schema,
      };

      await gc.putDataTable(api, orgId, _currentTableId, body);

      const divName = $division.options[$division.selectedIndex]?.text || divisionId;
      setStatus(`✓ Data table "${escapeHtml(name)}" saved successfully.`, "success");
      logAction({ me, orgId, action: "datatable_edit",
        description: `Edited data table '${name}' in division '${divName}'` });
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
      logAction({ me, orgId, action: "datatable_edit",
        description: `Failed to edit data table '${$name.value.trim()}': ${err.message}`,
        result: "failure", errorMessage: err.message });
    } finally {
      $loadBtn.disabled = !$tableSelect.value;
      validateSave();
    }
  });

  // ── Init: load table list on mount ─────────────────────────────
  loadTablesList();

  return el;
}
