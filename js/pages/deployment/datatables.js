/**
 * Deployment › Data Tables
 *
 * Bulk-creates data tables from every sheet in an Excel workbook.
 *
 * Excel format (same as Data Tables › Create):
 *   Row 1:  ["Name",        <data table name>]
 *   Row 2:  ["key",         <key display name>]
 *   Row 3:  ["division",    <division name>]
 *   Row 4:  ["description", <description text>]
 *   Row 5+: [<column name>, <type: boolean|string|integer|decimal|number>]
 *   All sheets in the workbook are processed in order.
 *
 * Flow:
 *   1. Click "Select Excel Sheet" → file picker opens
 *   2. On file selected → load divisions, iterate every sheet, create each table
 *   3. Results shown inline (✓ success / ✗ failure per sheet)
 */
import * as gc from "../../services/genesysApi.js";
import { logAction } from "../../services/activityLogService.js";
import { escapeHtml } from "../../utils.js";

const TYPE_MAP = {
  boolean: "boolean",
  string:  "string",
  integer: "integer",
  decimal: "number",
  number:  "number",
};

export default function renderDeploymentDataTables({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h2>Deployment — Data Tables</h2>
    <p class="page-desc">
      Select an Excel workbook to bulk-create data tables. Each sheet becomes one
      data table using the same format as Data Tables&nbsp;›&nbsp;Create.
    </p>

    <div class="dt-actions">
      <button class="btn" id="ddtSelectBtn">Select Excel Sheet</button>
      <input type="file" id="ddtFileInput" accept=".xlsx,.xls" style="display:none" />
    </div>

    <div class="dt-status" id="ddtStatus"></div>

    <ul class="ddt-results" id="ddtResults" style="list-style:none;padding:0;margin-top:12px"></ul>
  `;

  const $selectBtn  = el.querySelector("#ddtSelectBtn");
  const $fileInput  = el.querySelector("#ddtFileInput");
  const $status     = el.querySelector("#ddtStatus");
  const $results    = el.querySelector("#ddtResults");

  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "dt-status" + (type ? ` dt-status--${type}` : "");
  }

  function addResult(sheetName, ok, detail) {
    const li = document.createElement("li");
    li.style.cssText = "padding:4px 0;border-bottom:1px solid var(--border,#334)";
    li.innerHTML = ok
      ? `<span style="color:#4ade80">✓</span> <strong>${escapeHtml(sheetName)}</strong>`
      : `<span style="color:#f87171">✗</span> <strong>${escapeHtml(sheetName)}</strong> — ${escapeHtml(detail)}`;
    $results.appendChild(li);
  }

  function buildSchema(keyTitle, schemaRows) {
    const properties = {};
    properties["key"] = { title: keyTitle, type: "string" };

    for (const row of schemaRows) {
      const name = String(row[0] || "").trim();
      const rawType = String(row[1] || "").trim().toLowerCase();
      if (!name) continue;
      const type = TYPE_MAP[rawType] || "string";
      properties[name] = { title: name, type };
    }

    return {
      type: "object",
      properties,
      required: ["key"],
      $schema: "http://json-schema.org/draft-04/schema#",
      additionalProperties: false,
    };
  }

  async function processWorkbook(workbook) {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("Please select a customer org first.", "error"); return; }

    $results.innerHTML = "";
    $selectBtn.disabled = true;
    setStatus("Loading divisions…");

    let divisions;
    try {
      divisions = await gc.fetchAllDivisions(api, orgId);
    } catch (err) {
      setStatus(`Failed to load divisions: ${err.message}`, "error");
      $selectBtn.disabled = false;
      return;
    }

    const divisionsByName = new Map(
      (divisions || []).map(d => [d.name.toLowerCase(), d])
    );

    const sheets = workbook.SheetNames;
    setStatus(`Processing ${sheets.length} sheet(s)…`);

    let created = 0;
    let failed  = 0;

    for (const sheetName of sheets) {
      const ws = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

      if (!rows.length) {
        addResult(sheetName, false, "Sheet is empty — skipped");
        failed++;
        continue;
      }

      const tableName   = String(rows[0]?.[1] || "").trim();
      const keyName     = String(rows[1]?.[1] || "").trim();
      const divisionVal = String(rows[2]?.[1] || "").trim();
      const description = String(rows[3]?.[1] || "").trim();
      const schemaRows  = rows.slice(4).filter(r => String(r[0] || "").trim() !== "");

      if (!tableName) {
        addResult(sheetName, false, "Missing table name in row 1 — skipped");
        failed++;
        continue;
      }

      if (!keyName) {
        addResult(tableName, false, "Missing key name in row 2 — skipped");
        failed++;
        continue;
      }

      const division = divisionsByName.get(divisionVal.toLowerCase());
      if (!division) {
        addResult(tableName, false, `Division "${divisionVal}" not found — skipped`);
        failed++;
        continue;
      }

      const schema = buildSchema(keyName, schemaRows);
      const body = {
        name: tableName,
        description: description || undefined,
        division: { id: division.id },
        schema,
      };

      try {
        await gc.createDataTable(api, orgId, body);
        addResult(tableName, true);
        logAction({
          me, orgId,
          action: "datatable_create",
          description: `[Deployment] Created data table '${tableName}' in division '${division.name}'`,
        });
        created++;
      } catch (err) {
        addResult(tableName, false, err.message);
        logAction({
          me, orgId,
          action: "datatable_create",
          description: `[Deployment] Failed to create data table '${tableName}': ${err.message}`,
          result: "failure",
          errorMessage: err.message,
        });
        failed++;
      }
    }

    const summary = `Done — ${created} created, ${failed} failed.`;
    setStatus(summary, failed === 0 ? "success" : (created === 0 ? "error" : ""));
    $selectBtn.disabled = false;
  }

  $selectBtn.addEventListener("click", () => $fileInput.click());

  $fileInput.addEventListener("change", () => {
    const file = $fileInput.files[0];
    if (!file) return;
    $fileInput.value = "";

    const reader = new FileReader();
    reader.onload = (e) => {
      let workbook;
      try {
        workbook = XLSX.read(e.target.result, { type: "array" });
      } catch (err) {
        setStatus(`Could not read file: ${err.message}`, "error");
        return;
      }
      processWorkbook(workbook);
    };
    reader.readAsArrayBuffer(file);
  });

  return el;
}
