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
          <span class="dt-field-hint">The unique lookup key for each row (always stored as string).</span>
        </div>
      </div>

      <!-- Schema columns -->
      <div class="dtc-schema-section">
        <div class="dtc-schema-header">
          <span class="dt-label">Schema Columns</span>
        </div>
        <div class="dtc-schema-cols-header">
          <span class="dtc-col-label">Column Name</span>
          <span class="dtc-col-label">Type</span>
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

  let divisionsLoaded = false;
  let rowCounter = 0;

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

  function addSchemaRow() {
    const id = makeRowId();
    const row = document.createElement("div");
    row.className = "dtc-schema-row";
    row.id = id;
    row.innerHTML = `
      <input class="dt-input dtc-col-name" type="text" placeholder="columnName" autocomplete="off" />
      <select class="dt-select dtc-col-type">${TYPE_OPTIONS_HTML}</select>
      <button class="btn btn-sm dtc-del-btn" title="Remove column">×</button>
    `;
    row.querySelector(".dtc-del-btn").addEventListener("click", () => row.remove());
    $rowsContainer.appendChild(row);
    row.querySelector(".dtc-col-name").focus();
  }

  function collectSchema(keyName) {
    const properties = {};
    const required = [keyName];

    // Key column (always string, always first)
    properties[keyName] = { title: keyName, type: "string" };

    // Extra columns
    $rowsContainer.querySelectorAll(".dtc-schema-row").forEach(row => {
      const name = row.querySelector(".dtc-col-name").value.trim();
      const type = row.querySelector(".dtc-col-type").value;
      if (name) {
        properties[name] = { title: name, type };
      }
    });

    return {
      type: "object",
      properties,
      required,
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

  // ── Create button ──────────────────────────────────────────────
  $createBtn.addEventListener("click", async () => {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("Please select a customer org first.", "error"); return; }

    resetForm();
    setStatus("Loading divisions…");
    $form.hidden = false;

    const ok = await loadDivisions();
    if (ok) setStatus("Fill in the required fields and click Save.");
  });

  // ── Live validation ────────────────────────────────────────────
  [$name, $division, $key].forEach(el => {
    el.addEventListener("input",  validateSave);
    el.addEventListener("change", validateSave);
  });

  // ── Add column button ──────────────────────────────────────────
  $addRowBtn.addEventListener("click", addSchemaRow);

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

  return el;
}
