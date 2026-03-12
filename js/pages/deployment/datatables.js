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

    <ul class="ddt-results" id="ddtResults" style="list-style:none;padding:0;margin-top:12px;max-height:480px;overflow-y:auto"></ul>
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

  async function processWorkbook(workbook, selectedSheets = null) {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("Please select a customer org first.", "error"); return; }

    const sheets = selectedSheets && selectedSheets.length > 0
      ? workbook.SheetNames.filter(n => selectedSheets.includes(n))
      : workbook.SheetNames;

    if (!sheets.length) {
      setStatus("No sheets selected — nothing to deploy.", "error");
      return;
    }

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

  function showConfirmDialog(fileName, workbook, onConfirm) {
    const orgDetails = orgContext.getDetails();
    const orgName    = orgDetails ? orgDetails.name : (orgContext.get() || "Unknown org");

    const tableRows = workbook.SheetNames.map(sheetName => {
      const ws   = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
      const tableName   = String(rows[0]?.[1] || "").trim() || `(${sheetName})`;
      const keyName     = String(rows[1]?.[1] || "").trim() || "—";
      const divisionVal = String(rows[2]?.[1] || "").trim() || "—";
      const schemaCols  = rows.slice(4).filter(r => String(r[0] || "").trim() !== "").length;
      const safeSheet = escapeHtml(sheetName);
      return `<tr>
        <td style="padding:3px 10px 3px 0">
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer">
            <input type="checkbox" data-sheet="${safeSheet}" checked style="cursor:pointer;width:14px;height:14px;flex-shrink:0">
            ${escapeHtml(tableName)}
          </label>
        </td>
        <td style="padding:3px 8px;color:var(--text-muted,#888);font-size:.85rem">${escapeHtml(divisionVal)}</td>
        <td style="padding:3px 8px;color:var(--text-muted,#888);font-size:.85rem">key: ${escapeHtml(keyName)}</td>
        <td style="padding:3px 0;text-align:right;font-size:.85rem;white-space:nowrap">${schemaCols} col${schemaCols !== 1 ? "s" : ""}</td>
      </tr>`;
    }).join("");

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center";

    overlay.innerHTML = `
      <div style="background:var(--bg-card,#1e293b);border:1px solid var(--border,#334);border-radius:8px;padding:24px;min-width:340px;max-width:640px;width:90%">
        <h3 style="margin:0 0 16px;font-size:1.1rem">Confirm Deployment</h3>
        <table style="width:100%;border-collapse:collapse;font-size:.9rem">
          <tr><td style="padding:3px 10px 3px 0;color:var(--text-muted,#888)">Org</td>
              <td style="padding:3px 0"><strong>${escapeHtml(orgName)}</strong></td></tr>
          <tr><td style="padding:3px 10px 3px 0;color:var(--text-muted,#888)">File</td>
              <td style="padding:3px 0">${escapeHtml(fileName)}</td></tr>
        </table>
        <hr style="border:none;border-top:1px solid var(--border,#334);margin:14px 0">
        <table style="width:100%;border-collapse:collapse;font-size:.9rem">
          ${tableRows}
        </table>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
          <button id="ddtConfirmCancel" class="btn btn--secondary">Cancel</button>
          <button id="ddtConfirmDeploy" class="btn">Deploy</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector("#ddtConfirmCancel").addEventListener("click", () => {
      document.body.removeChild(overlay);
    });
    overlay.querySelector("#ddtConfirmDeploy").addEventListener("click", () => {
      const checked = [...overlay.querySelectorAll("input[data-sheet]")]
        .filter(cb => cb.checked)
        .map(cb => cb.dataset.sheet);
      document.body.removeChild(overlay);
      onConfirm(checked);
    });
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
      showConfirmDialog(file.name, workbook, (selectedSheets) => processWorkbook(workbook, selectedSheets));
    };
    reader.readAsArrayBuffer(file);
  });

  return el;
}
