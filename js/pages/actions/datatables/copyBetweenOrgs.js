/**
 * Data Tables › Copy - Between Orgs
 *
 * Copies a data table structure (and optionally rows) from one
 * customer org to another.
 *
 * Flow:
 *   1. User picks source org and destination org
 *   2. Fetch data tables from source org (with schema)
 *   3. User selects a source table
 *   4. User enters new table name (validated in dest org)
 *   5. User selects target division in dest org
 *   6. Optionally copies data rows from source → new table
 *
 * Note: Division IDs are org-specific — user picks a dest division.
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
  ready:       "Select source and destination orgs to begin.",
  loadingSrc:  "Loading tables and divisions…",
  validating:  "Validating name in destination org…",
  creating:    "Creating table in destination org…",
  fetchingRows:"Fetching source rows…",
  copyingRows: (n, total) => `Copying row ${n} of ${total}…`,
  done:        (name, dest, rows) => `✓ Table "${name}" created in ${dest}${rows ? ` with ${rows} rows` : ""}.`,
  noTables:    "No data tables found in source org.",
  error:       (msg) => `Error: ${msg}`,
};

// ── Page renderer ──────────────────────────────────────────────────

export default function renderCopyBetweenOrgs({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const customers = orgContext.getCustomers();

  // Build option HTML for org dropdowns
  const orgOptions = `<option value="">Select org…</option>`
    + customers.map(c =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.region)})</option>`
    ).join("");

  el.innerHTML = `
    <h2>Data Tables — Copy between Orgs</h2>

    <div class="dt-controls">
      <!-- Source org -->
      <div class="dt-control-group">
        <label class="dt-label">Source Org</label>
        <select class="dt-select" id="dtSrcOrg">${orgOptions}</select>
      </div>

      <!-- Destination org -->
      <div class="dt-control-group">
        <label class="dt-label">Destination Org</label>
        <select class="dt-select" id="dtDestOrg">${orgOptions}</select>
      </div>

      <!-- Load tables button -->
      <div class="dt-actions" style="margin-bottom:12px">
        <button class="btn" id="dtLoadBtn" disabled>Load Source Tables</button>
      </div>

      <!-- Source table -->
      <div class="dt-control-group">
        <label class="dt-label">Source Table</label>
        <select class="dt-select" id="dtSourceSelect" disabled>
          <option value="">Select source org first…</option>
        </select>
      </div>

      <!-- Source info -->
      <div class="dt-info" id="dtSourceInfo" hidden>
        <div class="dt-info-row"><span class="dt-info-key">Division:</span> <span id="dtInfoDiv">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Columns:</span> <span id="dtInfoCols">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Schema preview:</span></div>
        <div class="dt-schema" id="dtSchemaPreview"></div>
      </div>

      <!-- New name -->
      <div class="dt-control-group">
        <label class="dt-label">New Table Name (in destination)</label>
        <input class="dt-input" id="dtNewName" type="text" placeholder="Enter new table name…" disabled />
      </div>

      <!-- Division in destination -->
      <div class="dt-control-group">
        <label class="dt-label">Division (in destination)</label>
        <select class="dt-select" id="dtDivision" disabled>
          <option value="">Load tables first…</option>
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
    <div class="dt-status" id="dtStatus">${STATUS.ready}</div>
  `;

  // ── DOM refs ─────────────────────────────────────────
  const $srcOrg       = el.querySelector("#dtSrcOrg");
  const $destOrg      = el.querySelector("#dtDestOrg");
  const $loadBtn      = el.querySelector("#dtLoadBtn");
  const $sourceSelect = el.querySelector("#dtSourceSelect");
  const $sourceInfo   = el.querySelector("#dtSourceInfo");
  const $infoDiv      = el.querySelector("#dtInfoDiv");
  const $infoCols     = el.querySelector("#dtInfoCols");
  const $schemaPreview= el.querySelector("#dtSchemaPreview");
  const $newName      = el.querySelector("#dtNewName");
  const $division     = el.querySelector("#dtDivision");
  const $copyData     = el.querySelector("#dtCopyData");
  const $copyBtn      = el.querySelector("#dtCopyBtn");
  const $progress     = el.querySelector("#dtProgress");
  const $progressBar  = el.querySelector("#dtProgressBar");
  const $status       = el.querySelector("#dtStatus");

  let tables = [];      // source tables
  let destTables = [];  // destination table names (for uniqueness check)
  let divisions = [];   // destination divisions

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

  /** Build a readable preview of the schema columns. */
  function buildSchemaPreview(schema) {
    if (!schema?.properties) return "<em>No schema</em>";
    const entries = Object.entries(schema.properties)
      .map(([key, def]) => ({
        key,
        type: def.type || "string",
        title: def.title || key,
        order: def.displayOrder ?? 999,
      }))
      .sort((a, b) => a.order - b.order);

    return `<table class="dt-schema-table">
      <thead><tr><th>#</th><th>Column</th><th>Type</th></tr></thead>
      <tbody>${entries.map((e, i) =>
        `<tr><td>${i + 1}</td><td>${escapeHtml(e.title)}</td><td>${escapeHtml(e.type)}</td></tr>`
      ).join("")}</tbody>
    </table>`;
  }

  // ── Org selection logic ──────────────────────────────
  function updateLoadBtn() {
    $loadBtn.disabled = !$srcOrg.value || !$destOrg.value || $srcOrg.value === $destOrg.value;
  }

  $srcOrg.addEventListener("change", () => {
    updateLoadBtn();
    resetTableSelection();
  });
  $destOrg.addEventListener("change", () => {
    updateLoadBtn();
  });

  function resetTableSelection() {
    tables = [];
    $sourceSelect.innerHTML = `<option value="">Select source org first…</option>`;
    $sourceSelect.disabled = true;
    $sourceInfo.hidden = true;
    $newName.disabled = true;
    $newName.value = "";
    $division.innerHTML = `<option value="">Load tables first…</option>`;
    $division.disabled = true;
    $copyData.checked = false;
    $copyData.disabled = true;
    $copyBtn.disabled = true;
  }

  // ── Load tables ──────────────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const srcOrgId = $srcOrg.value;
    const destOrgId = $destOrg.value;
    if (!srcOrgId || !destOrgId || srcOrgId === destOrgId) return;

    try {
      setStatus(STATUS.loadingSrc);
      $loadBtn.disabled = true;
      $sourceSelect.disabled = true;

      // Fetch source tables (with schema), dest table names, and dest divisions in parallel
      const [srcRaw, destRaw, divs] = await Promise.all([
        gc.fetchAllDataTables(api, srcOrgId, { query: { expand: "schema" } }),
        gc.fetchAllDataTables(api, destOrgId),
        gc.fetchAllDivisions(api, destOrgId),
      ]);

      destTables = destRaw.map(t => t.name.toLowerCase());

      divisions = (divs || []).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      $division.innerHTML = divisions.map(d =>
        `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`
      ).join("");
      $division.disabled = false;

      tables = srcRaw.map(t => {
        let rowCount = 0;
        return {
          id: t.id,
          name: t.name,
          division: t.division?.name ?? "Unknown",
          columnCount: countSchemaColumns(t.schema),
          schema: t.schema,
          rowCount,
        };
      });

      tables.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      if (!tables.length) {
        $sourceSelect.innerHTML = `<option value="">No tables found</option>`;
        setStatus(STATUS.noTables);
        $loadBtn.disabled = false;
        return;
      }

      $sourceSelect.innerHTML = `<option value="">Select a table…</option>`
        + tables.map(t =>
          `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}  (${t.columnCount} cols)</option>`
        ).join("");
      $sourceSelect.disabled = false;
      $newName.disabled = false;
      $copyData.disabled = false;
      $loadBtn.disabled = false;
      setStatus("Tables loaded. Select a source table.");
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
      $loadBtn.disabled = false;
    }
  });

  // ── Source table selection ───────────────────────────
  $sourceSelect.addEventListener("change", () => {
    const id = $sourceSelect.value;
    const t = tables.find(x => x.id === id);
    if (t) {
      $sourceInfo.hidden = false;
      $infoDiv.textContent  = t.division;
      $infoCols.textContent = t.columnCount;
      $schemaPreview.innerHTML = buildSchemaPreview(t.schema);
      $newName.value = t.name; // Pre-fill with source name
      $copyBtn.disabled = false;
    } else {
      $sourceInfo.hidden = true;
      $copyBtn.disabled = true;
    }
  });

  // ── Copy action ──────────────────────────────────────
  $copyBtn.addEventListener("click", async () => {
    const srcOrgId  = $srcOrg.value;
    const destOrgId = $destOrg.value;
    if (!srcOrgId || !destOrgId) return;

    const sourceId = $sourceSelect.value;
    const source = tables.find(x => x.id === sourceId);
    if (!source) return;

    const newName = $newName.value.trim();
    if (!newName) {
      setStatus("Please enter a new table name.", "error");
      return;
    }

    // Disable all controls
    $srcOrg.disabled = true;
    $destOrg.disabled = true;
    $loadBtn.disabled = true;
    $sourceSelect.disabled = true;
    $newName.disabled = true;
    $division.disabled = true;
    $copyData.disabled = true;
    $copyBtn.disabled = true;

    try {
      // 1. Validate name uniqueness in destination
      setStatus(STATUS.validating);
      setProgress(15);

      // Refresh dest tables to be sure
      const destRaw = await gc.fetchAllDataTables(api, destOrgId);
      const destNames = destRaw.map(t => t.name.toLowerCase());
      if (destNames.includes(newName.toLowerCase())) {
        const destName = customers.find(c => c.id === destOrgId)?.name ?? destOrgId;
        setStatus(`A table named "${newName}" already exists in ${destName}.`, "error");
        enableControls();
        return;
      }

      // 2. Prepare schema (strip server-specific fields)
      setStatus(STATUS.creating);
      setProgress(40);

      const schemaClone = JSON.parse(JSON.stringify(source.schema));
      schemaClone.additionalProperties = false;
      delete schemaClone.$id;

      const body = { name: newName, schema: schemaClone };

      // Attach selected division
      const divId = $division.value;
      if (divId) {
        body.division = { id: divId };
      }

      // 3. Create table in destination
      setProgress(50);
      const newTable = await gc.createDataTable(api, destOrgId, body);
      setProgress(60);

      // 4. Optionally copy rows
      let copiedRows = 0;
      if ($copyData.checked) {
        setStatus(STATUS.fetchingRows);
        const rows = await gc.fetchDataTableRows(api, srcOrgId, sourceId, {
          query: { showbrief: "false" },
        });
        setProgress(70);

        const total = rows.length;
        if (total > 0) {
          for (let i = 0; i < total; i++) {
            setStatus(STATUS.copyingRows(i + 1, total));
            const row = { ...rows[i] };
            delete row.selfUri;
            await gc.createDataTableRow(api, destOrgId, newTable.id, row);
            copiedRows++;
            setProgress(70 + Math.round(30 * (i + 1) / total));
          }
        }
      }

      setProgress(100);
      const destName = customers.find(c => c.id === destOrgId)?.name ?? destOrgId;
      setStatus(STATUS.done(newName, destName, copiedRows || null), "success");
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
    } finally {
      hideProgress();
      enableControls();
    }
  });

  function enableControls() {
    $srcOrg.disabled = false;
    $destOrg.disabled = false;
    updateLoadBtn();
    if (tables.length) {
      $sourceSelect.disabled = false;
      $newName.disabled = false;
      $division.disabled = false;
      $copyData.disabled = false;
    }
    $copyBtn.disabled = !$sourceSelect.value;
  }

  return el;
}
