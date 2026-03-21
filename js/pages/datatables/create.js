/**
 * Data Tables › Create
 *
 * Creates a new data table in the currently-selected customer org.
 *
 * Flow:
 *   1. User selects an org (via orgContext)
 *   2. Clicks "Create" → form expands
 *   3. Fills Name (req), Division (req), Description, Key (req) and
 *      optional schema columns (Name + Type pairs)
 *   4. "Save" is enabled once Name + Division + Key are non-empty
 *   5. On save: POST /api/v2/flows/datatables
 *
 * API endpoints:
 *   GET  /api/v2/authorization/divisions  — list divisions for dropdown
 *   POST /api/v2/flows/datatables         — create data table
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

export default function renderCreateDataTable({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h2>Data Tables — Create</h2>
    <p class="page-desc">
      Create a new data table in the selected org.
      Name, Division, and Key are required. Schema columns are optional.
    </p>

    <!-- Top action buttons -->
    <div class="dt-actions">
      <button class="btn" id="dtcCreateBtn">Create</button>
      <button class="btn" id="dtcSaveBtn" disabled>Save</button>
      <button class="btn dtc-import-btn" id="dtcImportBtn" style="margin-left:auto">Import from Excel</button>
      <input type="file" id="dtcFileInput" accept=".xlsx,.xls" style="display:none" />
      <button class="btn" id="dtcTemplateBtn">Download Template</button>
    </div>

    <!-- Sheet picker (shown after a file is chosen) -->
    <div id="dtcSheetPicker" class="dtc-sheet-picker" hidden>
      <span class="dtc-sheet-label">Sheet:</span>
      <select class="dt-select dtc-sheet-select" id="dtcSheetSelect"></select>
      <button class="btn btn-sm" id="dtcSheetLoad">Load</button>
      <button class="btn btn-sm dtc-sheet-cancel" id="dtcSheetCancel">Cancel</button>
    </div>

    <!-- Status -->
    <div class="dt-status" id="dtcStatus"></div>

    <!-- Expandable form -->
    <div id="dtcForm" hidden>
      <hr class="hr" style="margin-bottom:18px">

      <!-- Core fields -->
      <div class="dt-controls">
        <div class="dt-control-group">
          <label class="dt-label" for="dtcName">Name <span style="color:#f87171">*</span></label>
          <input class="dt-input" id="dtcName" type="text" placeholder="e.g. AgentSkillMatrix" autocomplete="off" />
        </div>
        <div class="dt-control-group">
          <label class="dt-label" for="dtcDivision">Division <span style="color:#f87171">*</span></label>
          <select class="dt-select" id="dtcDivision">
            <option value="">Loading divisions…</option>
          </select>
        </div>
        <div class="dt-control-group">
          <label class="dt-label" for="dtcDescription">Description</label>
          <input class="dt-input" id="dtcDescription" type="text" placeholder="Optional description" autocomplete="off" />
        </div>
        <div class="dt-control-group">
          <label class="dt-label" for="dtcKey">Key <span style="color:#f87171">*</span></label>
          <input class="dt-input" id="dtcKey" type="text" placeholder="e.g. userId" autocomplete="off" />
          <span class="dt-field-hint">Display name of the primary key column (e.g. "userId"). Always stored as string.</span>
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
        <div id="dtcRows"></div>
        <button class="btn btn-sm dtc-add-btn" id="dtcAddRow" style="margin-top:8px">+ Add column</button>
      </div>
    </div>
  `;

  // ── Refs ───────────────────────────────────────────────────────
  const $createBtn    = el.querySelector("#dtcCreateBtn");
  const $saveBtn      = el.querySelector("#dtcSaveBtn");
  const $status       = el.querySelector("#dtcStatus");
  const $form         = el.querySelector("#dtcForm");
  const $name         = el.querySelector("#dtcName");
  const $division     = el.querySelector("#dtcDivision");
  const $description  = el.querySelector("#dtcDescription");
  const $key          = el.querySelector("#dtcKey");
  const $rowsContainer= el.querySelector("#dtcRows");
  const $addRowBtn    = el.querySelector("#dtcAddRow");
  const $importBtn    = el.querySelector("#dtcImportBtn");
  const $fileInput    = el.querySelector("#dtcFileInput");
  const $templateBtn  = el.querySelector("#dtcTemplateBtn");
  const $sheetPicker  = el.querySelector("#dtcSheetPicker");
  const $sheetSelect  = el.querySelector("#dtcSheetSelect");
  const $sheetLoad    = el.querySelector("#dtcSheetLoad");
  const $sheetCancel  = el.querySelector("#dtcSheetCancel");

  let divisionsLoaded = false;
  let rowCounter = 0;
  let _importWorkbook = null;

  // ── Helpers ────────────────────────────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "dt-status" + (type ? ` dt-status--${type}` : "");
  }

  function validateSave() {
    const ok = $name.value.trim() !== ""
      && $division.value !== ""
      && $key.value.trim() !== ""
      && divisionsLoaded;
    $saveBtn.disabled = !ok;
  }

  function makeRowId() {
    return `dtcrow-${++rowCounter}`;
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

  /** Wire event listeners for the default input inside a row after (re-)rendering it. */
  function wireDefaultHandlers(row) {
    const wrap = row.querySelector(".dtc-col-default-wrap");
    const type = row.querySelector(".dtc-col-type").value;

    // Boolean: keep label in sync with checkbox
    const bool = wrap.querySelector(".dtc-col-default-bool");
    if (bool) {
      bool.addEventListener("change", () => {
        bool.nextElementSibling.textContent = bool.checked ? "true" : "false";
      });
    }

    // Integer: strip any decimal part on input
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

    // Decimal: reject non-numeric characters (allow - and .)
    if (numInput && type === "number") {
      numInput.addEventListener("input", () => {
        const v = numInput.value;
        // Remove anything that isn't a digit, dot, or leading minus
        const clean = v.replace(/[^0-9.\-]/g, "").replace(/(?!^)-/g, "").replace(/(\..*)\./g, "$1");
        if (clean !== v) numInput.value = clean;
      });
    }
  }

  function parseDefaultValue(raw, type) {
    if (type === "boolean") {
      const l = raw.toLowerCase();
      return l === "true" ? true : l === "false" ? false : undefined;
    }
    if (type === "integer") {
      const n = Number(raw);
      return (!isNaN(n) && n === Math.trunc(n)) ? Math.trunc(n) : undefined;
    }
    if (type === "number") {
      const n = Number(raw);
      return !isNaN(n) ? n : undefined;
    }
    return raw; // string — any non-empty value is valid
  }

  function addSchemaRow(prefillName = "", prefillType = "", prefillDefault = undefined) {
    const id = makeRowId();
    const row = document.createElement("div");
    row.className = "dtc-schema-row";
    row.id = id;
    // Use the first type in the sorted list (Boolean) as the initial default
    const initialType = prefillType || COLUMN_TYPES[0].type;
    row.innerHTML = `
      <div class="dtc-drag-handle" title="Drag to reorder">⠿</div>
      <input class="dt-input dtc-col-name" type="text" placeholder="columnName" autocomplete="off" />
      <select class="dt-select dtc-col-type">${TYPE_OPTIONS_HTML}</select>
      <div class="dtc-col-default-wrap">${makeDefaultInput(initialType)}</div>
      <button class="btn btn-sm dtc-del-btn" title="Remove column">×</button>
    `;
    // Enable dragging only when the handle is grabbed (prevents accidental drags from inputs)
    row.querySelector(".dtc-drag-handle").addEventListener("mousedown", () => { row.draggable = true; });
    row.addEventListener("dragend", () => { row.draggable = false; });
    if (prefillName) row.querySelector(".dtc-col-name").value = prefillName;
    if (prefillType) row.querySelector(".dtc-col-type").value = prefillType;
    row.querySelector(".dtc-del-btn").addEventListener("click", () => row.remove());
    // Wire handlers for the initial state
    wireDefaultHandlers(row);
    // Pre-fill default value from Excel import if provided
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
    // Swap default input and re-wire when type changes
    row.querySelector(".dtc-col-type").addEventListener("change", (e) => {
      row.querySelector(".dtc-col-default-wrap").innerHTML = makeDefaultInput(e.target.value);
      wireDefaultHandlers(row);
    });
    $rowsContainer.appendChild(row);
    // Only focus the name field when adding manually (not during bulk import)
    if (!prefillName) row.querySelector(".dtc-col-name").focus();
  }

  function collectSchema(keyTitle) {
    const properties = {};

    // Key column: property name must always be "key" in Genesys schema;
    // the user's chosen label goes in the title field.
    properties["key"] = { title: keyTitle, type: "string" };

    // Extra columns
    $rowsContainer.querySelectorAll(".dtc-schema-row").forEach(row => {
      const name = row.querySelector(".dtc-col-name").value.trim();
      const type = row.querySelector(".dtc-col-type").value;
      if (!name) return;
      const prop = { title: name, type };
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

  // ── Reset form ──────────────────────────────────────────────────
  function resetForm() {
    $name.value        = "";
    $description.value = "";
    $key.value         = "";
    $division.innerHTML = `<option value="">Loading divisions…</option>`;
    $rowsContainer.innerHTML = "";
    divisionsLoaded = false;
    $saveBtn.disabled = true;
  }

  // ── Import from Excel ──────────────────────────────────────────
  const TYPE_MAP = {
    boolean: "boolean",
    string:  "string",
    integer: "integer",
    decimal: "number",
    number:  "number",
  };

  $importBtn.addEventListener("click", () => $fileInput.click());

  $fileInput.addEventListener("change", () => {
    const file = $fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        _importWorkbook = XLSX.read(e.target.result, { type: "array" });
        $sheetSelect.innerHTML = _importWorkbook.SheetNames
          .map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
          .join("");
        $sheetPicker.hidden = false;
        setStatus("Select the sheet to import, then click Load.");
      } catch (err) {
        setStatus(`Could not read file: ${err.message}`, "error");
      }
    };
    reader.readAsArrayBuffer(file);
    // Reset so the same file can be re-selected later
    $fileInput.value = "";
  });

  $sheetCancel.addEventListener("click", () => {
    $sheetPicker.hidden = true;
    _importWorkbook = null;
    setStatus("");
  });

  $sheetLoad.addEventListener("click", async () => {
    if (!_importWorkbook) return;
    const sheetName = $sheetSelect.value;
    const ws = _importWorkbook.Sheets[sheetName];
    // Parse as array-of-arrays; defval ensures empty cells are empty strings
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    if (!rows.length) {
      setStatus("The selected sheet appears to be empty.", "error");
      return;
    }

    // Row 0: ["Name",        <data table name>]
    // Row 1: ["key",         <key display name>]
    // Row 2: ["division",    <division name>]
    // Row 3: ["description", <description text>]
    // Row 4+: [<column name>, <type>, <default value (optional)>]
    const tableName   = String(rows[0]?.[1] || "").trim();
    const keyName     = String(rows[1]?.[1] || "").trim();
    const divisionVal = String(rows[2]?.[1] || "").trim();
    const description = String(rows[3]?.[1] || "").trim();
    const schemaRows  = rows.slice(4).filter(r => String(r[0] || "").trim() !== "");

    // Ensure form is open and divisions are loaded
    if ($form.hidden) {
      const orgId = orgContext.get();
      if (!orgId) { setStatus("Please select a customer org first.", "error"); return; }
      resetForm();
      $form.hidden = false;
      setStatus("Loading divisions…");
      const ok = await loadDivisions();
      if (!ok) return;
    }

    // Pre-fill Name from the Name row inside the sheet
    $name.value = tableName;

    // Pre-fill Key
    $key.value = keyName;

    // Pre-fill Description
    $description.value = description;

    // Pre-fill Division — case-insensitive match against loaded options
    if (divisionVal) {
      const lower = divisionVal.toLowerCase();
      const match = Array.from($division.options)
        .find(o => o.textContent.trim().toLowerCase() === lower);
      if (match) $division.value = match.value;
    }

    // Clear existing schema rows and populate from Excel
    $rowsContainer.innerHTML = "";
    schemaRows.forEach(([colName, colType, colDefault]) => {
      const name = String(colName).trim();
      const rawType = String(colType).trim().toLowerCase();
      const type = TYPE_MAP[rawType] || "string";
      const rawDef = String(colDefault ?? "").trim();
      const parsedDefault = rawDef !== "" ? parseDefaultValue(rawDef, type) : undefined;
      addSchemaRow(name, type, parsedDefault);
    });

    $sheetPicker.hidden = true;
    // Keep _importWorkbook so the user can load another tab via Create
    validateSave();
    const skippedDiv = divisionVal && !$division.value ? ` Division "${divisionVal}" not found — please select manually.` : "";
    setStatus(`Imported ${schemaRows.length} column(s) from "${sheetName}".${skippedDiv}`);
  });

  // ── Create button ──────────────────────────────────────────────
  $createBtn.addEventListener("click", async () => {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("Please select a customer org first.", "error"); return; }

    resetForm();
    setStatus("Loading divisions…");
    $form.hidden = false;

    const ok = await loadDivisions();
    if (ok) {
      // If a workbook is still loaded, surface the picker so the user can pick the next tab
      if (_importWorkbook) {
        $sheetPicker.hidden = false;
        setStatus("Select a sheet to import, or fill in the fields manually.");
      } else {
        setStatus("Fill in the required fields and click Save.");
      }
    }
  });

  // ── Live validation ────────────────────────────────────────────
  [$name, $division, $key].forEach(el => {
    el.addEventListener("input",  validateSave);
    el.addEventListener("change", validateSave);
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

    const name        = $name.value.trim();
    const divisionId  = $division.value;
    const description = $description.value.trim();
    const key         = $key.value.trim();

    if (!name || !divisionId || !key) {
      setStatus("Name, Division, and Key are required.", "error");
      return;
    }

    $saveBtn.disabled = true;
    $createBtn.disabled = true;
    setStatus("Creating data table…");

    try {
      const schema = collectSchema(key);

      const body = {
        name,
        description: description || undefined,
        division: { id: divisionId },
        schema,
      };

      const result = await gc.createDataTable(api, orgId, body);

      const divName = $division.options[$division.selectedIndex]?.text || divisionId;
      setStatus(`✓ Data table "${escapeHtml(name)}" created successfully.`, "success");
      logAction({ me, orgId, action: "datatable_create",
        description: `Created data table '${name}' in division '${divName}'` });

      // Reset form to allow creating another
      $form.hidden = true;
      $name.value = "";
      $description.value = "";
      $key.value = "";
      $division.innerHTML = `<option value="">Select division…</option>`;
      $rowsContainer.innerHTML = "";
      divisionsLoaded = false;
      // If a workbook is still loaded, re-show the picker for the next tab
      if (_importWorkbook) $sheetPicker.hidden = false;
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
      logAction({ me, orgId, action: "datatable_create",
        description: `Failed to create data table '${name}': ${err.message}`,
        result: "failure", errorMessage: err.message });
    } finally {
      $createBtn.disabled = false;
      validateSave();
    }
  });

  async function downloadTemplate() {
    const base = new URL("docs/Templates/Deployment/Data Tables/", document.baseURI).href;
    let manifest;
    try {
      const res = await fetch(base + "manifest.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      setStatus(`Could not load template list: ${err.message}`, "error");
      return;
    }
    const files = (manifest.files || []).filter(Boolean);
    if (!files.length) { setStatus("No template files found.", "error"); return; }

    if (files.length === 1) {
      try {
        const res = await fetch(base + files[0]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);
        const key = "xlsx_" + Date.now() + "_" + Math.random().toString(36).slice(2);
        window._xlsxDownload = window._xlsxDownload || {};
        window._xlsxDownload[key] = { filename: files[0], b64 };
        const helperUrl = new URL("download.html", document.baseURI);
        helperUrl.hash = key;
        const popup = window.open(helperUrl.href, "_blank");
        if (!popup) { delete window._xlsxDownload[key]; setStatus("Pop-up blocked. Please allow pop-ups for this site.", "error"); }
      } catch (err) {
        setStatus(`Could not download template: ${err.message}`, "error");
      }
    } else {
      if (typeof JSZip === "undefined") { setStatus("JSZip library not loaded. Please reload the page.", "error"); return; }
      try {
        const zip = new JSZip();
        await Promise.all(files.map(async (f) => {
          const res = await fetch(base + f);
          if (!res.ok) throw new Error(`Could not fetch ${f}: HTTP ${res.status}`);
          zip.file(f, await res.arrayBuffer());
        }));
        const b64 = await zip.generateAsync({ type: "base64" });
        const key = "xlsx_" + Date.now() + "_" + Math.random().toString(36).slice(2);
        window._xlsxDownload = window._xlsxDownload || {};
        window._xlsxDownload[key] = { filename: "DataTables_Templates.zip", b64 };
        const helperUrl = new URL("download.html", document.baseURI);
        helperUrl.hash = key;
        const popup = window.open(helperUrl.href, "_blank");
        if (!popup) { delete window._xlsxDownload[key]; setStatus("Pop-up blocked. Please allow pop-ups for this site.", "error"); }
      } catch (err) {
        setStatus(`Could not create template archive: ${err.message}`, "error");
      }
    }
  }

  $templateBtn.addEventListener("click", downloadTemplate);

  return el;
}
