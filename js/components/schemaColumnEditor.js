/**
 * Schema Column Editor (shared component)
 *
 * A reusable data-table schema column editor: renders a list of editable
 * schema columns (Name / Type / Default) with drag-to-reorder, "add column"
 * and per-row "remove" controls. Used by the Data Tables copy pages so the
 * schema can be adjusted (columns added or removed) before the copy is saved.
 *
 * Usage:
 *   import { createSchemaColumnEditor } from "../../components/schemaColumnEditor.js";
 *   const editor = createSchemaColumnEditor();
 *   container.appendChild(editor.element);
 *   editor.loadFromSchema(sourceSchema);   // populate from a source table schema
 *   const schema = editor.collectSchema();  // build a schema for POST
 *   const keys   = editor.getIncludedKeys(); // property keys kept (incl. "key")
 *
 * The primary key column is preserved from the source schema and is not
 * editable here (matching the Create / Edit pages, where the key cannot be
 * changed after creation).
 */

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

export function createSchemaColumnEditor() {
  const element = document.createElement("div");
  element.className = "dtc-schema-section";
  element.innerHTML = `
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
    <div class="dtc-schema-rows"></div>
    <button class="btn btn-sm dtc-add-btn" type="button" style="margin-top:8px">+ Add column</button>
  `;

  const $rowsContainer = element.querySelector(".dtc-schema-rows");
  const $addBtn        = element.querySelector(".dtc-add-btn");

  let rowCounter = 0;
  let keyProp = { title: "key", type: "string" }; // preserved from source schema

  function makeRowId() {
    return `sce-row-${++rowCounter}`;
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
    const row = document.createElement("div");
    row.className = "dtc-schema-row";
    row.id = makeRowId();
    if (prefillKey) row.dataset.originalKey = prefillKey;

    const initialType = prefillType || COLUMN_TYPES[0].type;
    row.innerHTML = `
      <div class="dtc-drag-handle" title="Drag to reorder">⠿</div>
      <input class="dt-input dtc-col-name" type="text" placeholder="columnName" autocomplete="off" />
      <select class="dt-select dtc-col-type">${TYPE_OPTIONS_HTML}</select>
      <div class="dtc-col-default-wrap">${makeDefaultInput(initialType)}</div>
      <button class="btn btn-sm dtc-del-btn" type="button" title="Remove column">×</button>
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
    return row;
  }

  // ── Drag-to-reorder ──────────────────────────────────────────────
  (function initDragDrop() {
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
  })();

  $addBtn.addEventListener("click", () => addSchemaRow());

  // ── Public API ───────────────────────────────────────────────────

  /** Clear all rows. */
  function reset() {
    $rowsContainer.innerHTML = "";
    keyProp = { title: "key", type: "string" };
  }

  /** Populate the editor from a source table schema (excludes the key column). */
  function loadFromSchema(schema) {
    reset();
    const props = schema?.properties || {};
    if (props.key) {
      keyProp = { title: props.key.title || "key", type: props.key.type || "string" };
    }
    Object.entries(props)
      .filter(([k]) => k !== "key")
      .map(([k, v]) => ({
        key: k,
        name: v?.title || k,
        type: v?.type || "string",
        default: v?.default,
        order: v?.displayOrder ?? 9999,
      }))
      .sort((a, b) => a.order - b.order)
      .forEach(col => addSchemaRow(col.name, col.type, col.default, col.key));
  }

  /** Build a full JSON schema object for POST, preserving the key column. */
  function collectSchema() {
    const properties = {};
    properties.key = { title: keyProp.title, type: keyProp.type || "string" };

    let displayOrder = 0;
    $rowsContainer.querySelectorAll(".dtc-schema-row").forEach((row) => {
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

  /** Property keys included in the current schema (incl. "key"), for row filtering. */
  function getIncludedKeys() {
    const keys = ["key"];
    $rowsContainer.querySelectorAll(".dtc-schema-row").forEach((row) => {
      const name = row.querySelector(".dtc-col-name").value.trim();
      if (!name) return;
      keys.push(row.dataset.originalKey || name);
    });
    return keys;
  }

  /** Number of non-key columns currently defined. */
  function getColumnCount() {
    let count = 0;
    $rowsContainer.querySelectorAll(".dtc-schema-row").forEach((row) => {
      if (row.querySelector(".dtc-col-name").value.trim()) count++;
    });
    return count;
  }

  return { element, loadFromSchema, collectSchema, getIncludedKeys, getColumnCount, reset, addColumn: addSchemaRow };
}
