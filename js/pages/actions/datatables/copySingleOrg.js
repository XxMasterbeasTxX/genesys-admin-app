/**
 * Data Tables › Copy - Single Org
 *
 * Copies a data table (structure + optionally rows) within the
 * currently-selected customer org.
 *
 * Flow:
 *   1. Fetch all data tables in the org (with schema)
 *   2. User selects a source table
 *   3. User enters a new name and toggles "Copy data"
 *   4. Create new table with the source schema
 *   5. Optionally copy every row from source → new table
 *
 * API endpoints:
 *   GET  /api/v2/flows/datatables                — list data tables
 *   GET  /api/v2/authorization/divisions          — list divisions
 *   POST /api/v2/flows/datatables                 — create data table
 *   GET  /api/v2/flows/datatables/{id}/rows       — fetch rows
 *   POST /api/v2/flows/datatables/{id}/rows       — insert row
 */
import { escapeHtml } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";

// ── Status messages ────────────────────────────────────────────────
const STATUS = {
  ready:       "Select a source data table to begin.",
  loading:     "Loading data tables…",
  validating:  "Validating name…",
  creating:    "Creating table…",
  fetchingRows:"Fetching source rows…",
  copyingRows: (n, total) => `Copying row ${n} of ${total}…`,
  done:        (name, rows) => `✓ Table "${name}" created successfully${rows ? ` with ${rows} rows` : ""}.`,
  noTables:    "No data tables found in this org.",
  error:       (msg) => `Error: ${msg}`,
};

// ── Page renderer ──────────────────────────────────────────────────

export default function renderCopySingleOrg({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h2>Data Tables — Copy (Single Org)</h2>

    <p class="page-desc">
      Copy a data table (structure + optionally rows) within the same org.
      Choose a source table, enter a new name, select a division, and
      optionally include data rows in the copy.
    </p>

    <div class="dt-controls">
      <!-- Step 1: Source table -->
      <div class="dt-control-group">
        <label class="dt-label">Source Table</label>
        <select class="dt-select" id="dtSourceSelect" disabled>
          <option value="">Loading…</option>
        </select>
      </div>

      <!-- Source info -->
      <div class="dt-info" id="dtSourceInfo" hidden>
        <div class="dt-info-row"><span class="dt-info-key">Division:</span> <span id="dtInfoDiv">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Columns:</span> <span id="dtInfoCols">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Rows:</span>    <span id="dtInfoRows">—</span></div>
      </div>

      <!-- Step 2: New name -->
      <div class="dt-control-group">
        <label class="dt-label">New Table Name</label>
        <input class="dt-input" id="dtNewName" type="text" placeholder="Enter new table name…" disabled />
      </div>

      <!-- Division -->
      <div class="dt-control-group">
        <label class="dt-label">Division</label>
        <select class="dt-select" id="dtDivision" disabled>
          <option value="">Loading…</option>
        </select>
      </div>

      <!-- Copy data toggle -->
      <div class="dt-control-group dt-toggle-row">
        <label class="dt-label">Copy data (rows)</label>
        <label class="dt-toggle">
          <input type="checkbox" id="dtCopyData" disabled />
          <span class="dt-toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- Actions -->
    <div class="dt-actions">
      <button class="btn" id="dtCopyBtn" disabled>Copy Table</button>
    </div>

    <!-- Progress -->
    <div class="dt-progress-wrap" id="dtProgress" hidden>
      <div class="dt-progress-bar" id="dtProgressBar"></div>
    </div>

    <!-- Status -->
    <div class="dt-status" id="dtStatus">${STATUS.loading}</div>
  `;

  // ── DOM refs ─────────────────────────────────────────
  const $sourceSelect = el.querySelector("#dtSourceSelect");
  const $sourceInfo   = el.querySelector("#dtSourceInfo");
  const $infoDiv      = el.querySelector("#dtInfoDiv");
  const $infoCols     = el.querySelector("#dtInfoCols");
  const $infoRows     = el.querySelector("#dtInfoRows");
  const $newName      = el.querySelector("#dtNewName");
  const $division     = el.querySelector("#dtDivision");
  const $copyData     = el.querySelector("#dtCopyData");
  const $copyBtn      = el.querySelector("#dtCopyBtn");
  const $progress     = el.querySelector("#dtProgress");
  const $progressBar  = el.querySelector("#dtProgressBar");
  const $status       = el.querySelector("#dtStatus");

  let tables = [];     // { id, name, division, columnCount, rowCount, schema }
  let divisions = [];  // { id, name }

  // ── Helpers ──────────────────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = typeof msg === "function" ? msg() : msg;
    $status.className = `dt-status${type ? ` dt-status--${type}` : ""}`;
  }

  function setProgress(pct) {
    $progress.hidden = false;
    $progressBar.style.width = `${pct}%`;
  }

  function hideProgress() {
    $progress.hidden = true;
    $progressBar.style.width = "0%";
  }

  function countSchemaColumns(schema) {
    if (!schema?.properties) return 0;
    return Object.keys(schema.properties).length;
  }

  // ── Load tables ──────────────────────────────────────
  async function loadTables() {
    const orgId = orgContext.get();
    if (!orgId) {
      setStatus("Please select a customer org first.", "error");
      return;
    }
    try {
      setStatus(STATUS.loading);
      $sourceSelect.disabled = true;

      // Fetch tables and divisions in parallel
      const [raw, divs] = await Promise.all([
        gc.fetchAllDataTables(api, orgId, { query: { expand: "schema" } }),
        gc.fetchAllDivisions(api, orgId),
      ]);

      divisions = (divs || []).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      $division.innerHTML = divisions.map(d =>
        `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`
      ).join("");
      $division.disabled = false;

      // Enrich with row counts (quick HEAD-style fetch, 1 row per table)
      tables = [];
      for (const t of raw) {
        const cols = countSchemaColumns(t.schema);
        let rowCount = 0;
        try {
          const rowPage = await api.proxyGenesys(orgId, "GET",
            `/api/v2/flows/datatables/${t.id}/rows`, { query: { pageSize: "1" } });
          rowCount = rowPage.total ?? 0;
        } catch { /* ignore */ }
        tables.push({
          id: t.id,
          name: t.name,
          division: t.division?.name ?? "Unknown",
          columnCount: cols,
          rowCount,
          schema: t.schema,
        });
      }

      tables.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      if (!tables.length) {
        $sourceSelect.innerHTML = `<option value="">No tables found</option>`;
        setStatus(STATUS.noTables);
        return;
      }

      $sourceSelect.innerHTML = `<option value="">Select a table…</option>`
        + tables.map(t =>
          `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}  (${t.columnCount} cols, ${t.rowCount} rows)</option>`
        ).join("");
      $sourceSelect.disabled = false;
      $newName.disabled = false;
      $copyData.disabled = false;
      setStatus(STATUS.ready);
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
    }
  }

  // ── Source selection ─────────────────────────────────
  $sourceSelect.addEventListener("change", () => {
    const id = $sourceSelect.value;
    const t = tables.find(x => x.id === id);
    if (t) {
      $sourceInfo.hidden = false;
      $infoDiv.textContent  = t.division;
      $infoCols.textContent = t.columnCount;
      $infoRows.textContent = t.rowCount;
      $copyBtn.disabled = false;
    } else {
      $sourceInfo.hidden = true;
      $copyBtn.disabled = true;
    }
  });

  // ── Copy action ──────────────────────────────────────
  $copyBtn.addEventListener("click", async () => {
    const orgId = orgContext.get();
    if (!orgId) return;

    const sourceId = $sourceSelect.value;
    const source = tables.find(x => x.id === sourceId);
    if (!source) return;

    const newName = $newName.value.trim();
    if (!newName) {
      setStatus("Please enter a new table name.", "error");
      return;
    }

    // Disable controls
    $sourceSelect.disabled = true;
    $newName.disabled = true;
    $division.disabled = true;
    $copyData.disabled = true;
    $copyBtn.disabled = true;

    try {
      // 1. Validate name uniqueness
      setStatus(STATUS.validating);
      const existing = tables.find(t =>
        t.name.toLowerCase() === newName.toLowerCase());
      if (existing) {
        setStatus(`A table named "${newName}" already exists.`, "error");
        enableControls();
        return;
      }

      // 2. Prepare schema
      setStatus(STATUS.creating);
      setProgress(10);

      const schemaClone = JSON.parse(JSON.stringify(source.schema));
      schemaClone.additionalProperties = false;
      // Remove server-generated $id if present
      delete schemaClone.$id;

      const body = { name: newName, schema: schemaClone };

      // Attach selected division
      const divId = $division.value;
      if (divId) {
        body.division = { id: divId };
      }

      // 3. Create table
      setProgress(25);
      const newTable = await gc.createDataTable(api, orgId, body);
      setProgress(40);

      // 4. Optionally copy rows
      let copiedRows = 0;
      if ($copyData.checked && source.rowCount > 0) {
        setStatus(STATUS.fetchingRows);
        const rows = await gc.fetchDataTableRows(api, orgId, sourceId, {
          query: { showbrief: "false" },
        });
        setProgress(60);

        const total = rows.length;
        for (let i = 0; i < total; i++) {
          setStatus(STATUS.copyingRows(i + 1, total));
          // Remove server-generated fields before inserting
          const row = { ...rows[i] };
          delete row.selfUri;
          await gc.createDataTableRow(api, orgId, newTable.id, row);
          copiedRows++;
          setProgress(60 + Math.round(40 * (i + 1) / total));
        }
      }

      setProgress(100);
      setStatus(STATUS.done(newName, copiedRows || null), "success");

      // Refresh table list
      setTimeout(() => loadTables(), 1500);
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
      enableControls();
    } finally {
      hideProgress();
    }
  });

  function enableControls() {
    $sourceSelect.disabled = false;
    $newName.disabled = false;
    $division.disabled = false;
    $copyData.disabled = false;
    $copyBtn.disabled = !$sourceSelect.value;
  }

  // ── Init ─────────────────────────────────────────────
  loadTables();
  return el;
}
