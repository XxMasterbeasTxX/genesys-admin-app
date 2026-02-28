/**
 * Data Actions › Edit
 *
 * Open an existing data action, view/edit its properties, and test it.
 *
 * Flow:
 *   1. Pick an org → Load all published + draft actions and integrations
 *   2. Filters: text search, category, integration, status (Published/Draft)
 *   3. Select an action → show detail (info + contract preview)
 *   4. Edit name, category, contract fields
 *   5. Test (published or draft), Save Draft, Validate, Publish
 *
 * API endpoints:
 *   GET   /api/v2/integrations/actions                      — list published actions
 *   GET   /api/v2/integrations/actions/drafts                — list draft actions
 *   GET   /api/v2/integrations                               — list integrations
 *   GET   /api/v2/integrations/actions/{id}                  — get published action
 *   GET   /api/v2/integrations/actions/{id}/draft             — get action draft
 *   POST  /api/v2/integrations/actions/{id}/draft             — create draft from published
 *   PATCH /api/v2/integrations/actions/{id}/draft             — update draft
 *   GET   /api/v2/integrations/actions/{id}/draft/validation  — validate draft
 *   POST  /api/v2/integrations/actions/{id}/draft/publish     — publish draft
 *   POST  /api/v2/integrations/actions/{id}/test              — test published action
 *   POST  /api/v2/integrations/actions/{id}/draft/test        — test draft action
 */
import { escapeHtml } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";

// ── Status helpers ──────────────────────────────────────────────────
const STATUS = {
  ready:       "Select an org and load actions.",
  loading:     "Loading actions and integrations…",
  fetching:    "Fetching full action detail…",
  saving:      "Saving draft…",
  validating:  "Validating draft…",
  publishing:  "Publishing draft…",
  testing:     "Running test…",
  noActions:   "No data actions found.",
  error:       (msg) => `Error: ${msg}`,
};

// ── Page renderer ───────────────────────────────────────────────────
export default function renderEditDataAction({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const customers = orgContext.getCustomers();
  const orgOptions = `<option value="">Select org…</option>`
    + customers.map(c =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.region)})</option>`
    ).join("");

  el.innerHTML = `
    <h2>Data Actions — Edit</h2>

    <div class="dt-controls">
      <!-- Org picker -->
      <div class="dt-control-group">
        <label class="dt-label">Organisation</label>
        <select class="dt-select" id="edOrg">${orgOptions}</select>
      </div>

      <div class="dt-actions" style="margin-bottom:4px">
        <button class="btn" id="edLoadBtn" disabled>Load Actions</button>
      </div>

      <!-- Filters -->
      <div class="ed-filter-row" id="edFilters" hidden>
        <input class="dt-input ed-filter-input" id="edFilterName" type="text" placeholder="Search name…" />
        <select class="dt-select ed-filter-select" id="edFilterCat">
          <option value="">All categories</option>
        </select>
        <select class="dt-select ed-filter-select" id="edFilterInteg">
          <option value="">All integrations</option>
        </select>
        <select class="dt-select ed-filter-select" id="edFilterStatus">
          <option value="">All statuses</option>
          <option value="Published">Published</option>
          <option value="Draft">Draft only</option>
        </select>
      </div>

      <!-- Action list -->
      <div class="dt-control-group">
        <label class="dt-label">Action</label>
        <select class="dt-select" id="edActionSelect" disabled size="8" style="max-width:550px">
          <option value="">Load actions first…</option>
        </select>
      </div>
    </div>

    <!-- Detail panel -->
    <div id="edDetail" hidden>
      <hr class="ed-divider" />

      <div class="dt-info" id="edInfo" style="max-width:550px">
        <div class="dt-info-row"><span class="dt-info-key">Status:</span> <span id="edInfoStatus">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Integration:</span> <span id="edInfoInteg">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Integration Type:</span> <span id="edInfoType">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Secure:</span> <span id="edInfoSecure">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Version:</span> <span id="edInfoVersion">—</span></div>
      </div>

      <!-- Editable fields -->
      <div class="dt-controls" style="margin-top:14px">
        <div class="dt-control-group">
          <label class="dt-label">Name</label>
          <input class="dt-input" id="edName" type="text" style="max-width:550px" />
        </div>
        <div class="dt-control-group">
          <label class="dt-label">Category</label>
          <input class="dt-input" id="edCategory" type="text" style="max-width:550px" />
        </div>
      </div>

      <!-- Contract preview -->
      <div class="dt-info" style="max-width:550px;margin-top:8px">
        <div class="dt-info-row"><span class="dt-info-key">Contract:</span></div>
        <div class="dt-schema" id="edContractPreview"></div>
      </div>

      <!-- Action buttons -->
      <div class="dt-actions" style="margin-top:14px">
        <button class="btn" id="edSaveBtn" disabled>Save Draft</button>
        <button class="btn" id="edValidateBtn" disabled>Validate Draft</button>
        <button class="btn" id="edPublishBtn" disabled>Publish</button>
      </div>

      <!-- Test section -->
      <details class="ed-test-section" id="edTestSection">
        <summary class="ed-test-summary">Test Action</summary>

        <div class="dt-controls" style="margin-top:10px">
          <div class="dt-control-group">
            <label class="dt-label">Test target</label>
            <select class="dt-select" id="edTestTarget" style="max-width:250px">
              <option value="published">Published</option>
              <option value="draft">Draft</option>
            </select>
          </div>

          <div id="edTestInputs" class="ed-test-inputs"></div>

          <div class="dt-actions">
            <button class="btn ed-btn-test" id="edTestBtn" disabled>Run Test</button>
          </div>

          <div class="dt-control-group">
            <label class="dt-label">Result</label>
            <pre class="ed-test-result" id="edTestResult"></pre>
          </div>
        </div>
      </details>
    </div>

    <!-- Progress -->
    <div class="dt-progress-wrap" id="edProgress" hidden>
      <div class="dt-progress-bar" id="edProgressBar"></div>
    </div>

    <!-- Status -->
    <div class="dt-status" id="edStatus">${STATUS.ready}</div>
  `;

  // ── DOM refs ──────────────────────────────────────────
  const $org           = el.querySelector("#edOrg");
  const $loadBtn       = el.querySelector("#edLoadBtn");
  const $filters       = el.querySelector("#edFilters");
  const $filterName    = el.querySelector("#edFilterName");
  const $filterCat     = el.querySelector("#edFilterCat");
  const $filterInteg   = el.querySelector("#edFilterInteg");
  const $filterStatus  = el.querySelector("#edFilterStatus");
  const $actionSelect  = el.querySelector("#edActionSelect");
  const $detail        = el.querySelector("#edDetail");
  const $infoStatus    = el.querySelector("#edInfoStatus");
  const $infoInteg     = el.querySelector("#edInfoInteg");
  const $infoType      = el.querySelector("#edInfoType");
  const $infoSecure    = el.querySelector("#edInfoSecure");
  const $infoVersion   = el.querySelector("#edInfoVersion");
  const $name          = el.querySelector("#edName");
  const $category      = el.querySelector("#edCategory");
  const $contractPrev  = el.querySelector("#edContractPreview");
  const $saveBtn       = el.querySelector("#edSaveBtn");
  const $validateBtn   = el.querySelector("#edValidateBtn");
  const $publishBtn    = el.querySelector("#edPublishBtn");
  const $testTarget    = el.querySelector("#edTestTarget");
  const $testInputs    = el.querySelector("#edTestInputs");
  const $testBtn       = el.querySelector("#edTestBtn");
  const $testResult    = el.querySelector("#edTestResult");
  const $progress      = el.querySelector("#edProgress");
  const $progressBar   = el.querySelector("#edProgressBar");
  const $status        = el.querySelector("#edStatus");

  let allActions = [];        // merged published + draft-only
  let integrations = [];      // org integrations
  let selectedFull = null;    // full detail of selected action
  let hasDraft = false;       // whether selected action has a draft

  // ── Helpers ───────────────────────────────────────────
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

  function integName(id) {
    const integ = integrations.find(i => i.id === id);
    return integ?.name || id;
  }

  function integType(id) {
    const integ = integrations.find(i => i.id === id);
    return integ?.integrationType?.id || "unknown";
  }

  /** Extract properties from a JSON schema, handling nested structures. */
  function extractSchemaProps(schema) {
    if (!schema) return null;
    if (schema.properties && Object.keys(schema.properties).length) return schema.properties;
    if (schema.items?.properties && Object.keys(schema.items.properties).length) return schema.items.properties;
    return null;
  }

  /** Build HTML table preview of input/output contract schemas. */
  function buildContractPreview(contract) {
    if (!contract) return "<em>No contract</em>";
    const sections = [];

    const inputProps = extractSchemaProps(contract.input?.inputSchema);
    if (inputProps) {
      const rows = Object.entries(inputProps).map(([key, def], i) =>
        `<tr><td>${i + 1}</td><td>${escapeHtml(def.title || key)}</td><td>${escapeHtml(def.type || "string")}</td></tr>`
      ).join("");
      sections.push(`<strong>Input</strong>
        <table class="dt-schema-table">
          <thead><tr><th>#</th><th>Field</th><th>Type</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`);
    }

    const outputProps = extractSchemaProps(contract.output?.successSchema);
    if (outputProps) {
      const rows = Object.entries(outputProps).map(([key, def], i) =>
        `<tr><td>${i + 1}</td><td>${escapeHtml(def.title || key)}</td><td>${escapeHtml(def.type || "string")}</td></tr>`
      ).join("");
      sections.push(`<strong>Output (success)</strong>
        <table class="dt-schema-table">
          <thead><tr><th>#</th><th>Field</th><th>Type</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`);
    }

    return sections.length ? sections.join("") : "<em>Empty contract</em>";
  }

  /** Build test input fields from the input contract schema. */
  function buildTestInputFields(contract) {
    const props = extractSchemaProps(contract?.input?.inputSchema);
    if (!props || !Object.keys(props).length) {
      $testInputs.innerHTML = "<em style='font-size:12px;color:var(--muted)'>No input parameters required.</em>";
      return;
    }
    $testInputs.innerHTML = Object.entries(props).map(([key, def]) => {
      const label = def.title || key;
      const type = def.type || "string";
      return `
        <div class="dt-control-group">
          <label class="dt-label">${escapeHtml(label)} <span style="opacity:0.5">(${escapeHtml(type)})</span></label>
          <input class="dt-input ed-test-field" data-key="${escapeHtml(key)}" data-type="${escapeHtml(type)}"
                 type="text" placeholder="${escapeHtml(key)}" style="max-width:450px" />
        </div>`;
    }).join("");
  }

  /** Collect test input values into an object. */
  function collectTestInputs() {
    const inputs = {};
    $testInputs.querySelectorAll(".ed-test-field").forEach(field => {
      const key = field.dataset.key;
      const type = field.dataset.type;
      let val = field.value.trim();
      if (!val) return; // skip empty
      if (type === "integer" || type === "number") val = Number(val);
      else if (type === "boolean") val = val === "true";
      inputs[key] = val;
    });
    return inputs;
  }

  // ── Org selection ─────────────────────────────────────
  $org.addEventListener("change", () => {
    $loadBtn.disabled = !$org.value;
    resetAll();
  });

  function resetAll() {
    allActions = [];
    $actionSelect.innerHTML = `<option value="">Load actions first…</option>`;
    $actionSelect.disabled = true;
    $filters.hidden = true;
    $detail.hidden = true;
    selectedFull = null;
    hasDraft = false;
  }

  // ── Load actions ──────────────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const orgId = $org.value;
    if (!orgId) return;

    try {
      setStatus(STATUS.loading);
      $loadBtn.disabled = true;
      resetAll();

      const [published, drafts, integs] = await Promise.all([
        gc.fetchAllDataActions(api, orgId, { query: { includeAuthActions: "false" } }),
        gc.fetchAllDataActionDrafts(api, orgId, { query: { includeAuthActions: "false" } }),
        gc.fetchAllIntegrations(api, orgId, { pageSize: 200 }),
      ]);

      integrations = integs;

      // Build merged list: published actions tagged, then draft-only actions
      const publishedIds = new Set(published.map(a => a.id));
      const draftOnlyIds = new Set(drafts.map(d => d.id).filter(id => !publishedIds.has(id)));

      allActions = [
        ...published.map(a => ({
          id:            a.id,
          name:          a.name,
          category:      a.category || "",
          integrationId: a.integrationId || "",
          secure:        a.secure || false,
          status:        "Published",
        })),
        ...drafts.filter(d => draftOnlyIds.has(d.id)).map(a => ({
          id:            a.id,
          name:          a.name,
          category:      a.category || "",
          integrationId: a.integrationId || "",
          secure:        a.secure || false,
          status:        "Draft",
        })),
      ];

      allActions.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      if (!allActions.length) {
        setStatus(STATUS.noActions);
        $loadBtn.disabled = false;
        return;
      }

      // Populate filter dropdowns
      populateFilterDropdowns();
      $filters.hidden = false;
      applyFilters();

      $actionSelect.disabled = false;
      $loadBtn.disabled = false;
      setStatus(`Loaded ${allActions.length} action(s). Select one to view/edit.`);
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
      $loadBtn.disabled = false;
    }
  });

  // ── Filters ───────────────────────────────────────────
  function populateFilterDropdowns() {
    const cats = [...new Set(allActions.map(a => a.category).filter(Boolean))].sort();
    $filterCat.innerHTML = `<option value="">All categories</option>`
      + cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

    const integIds = [...new Set(allActions.map(a => a.integrationId).filter(Boolean))];
    $filterInteg.innerHTML = `<option value="">All integrations</option>`
      + integIds.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(integName(id))}</option>`).join("");
  }

  function getFilteredActions() {
    const nameQ = $filterName.value.trim().toLowerCase();
    const catQ  = $filterCat.value;
    const integQ = $filterInteg.value;
    const statusQ = $filterStatus.value;

    return allActions.filter(a => {
      if (nameQ && !a.name.toLowerCase().includes(nameQ)) return false;
      if (catQ && a.category !== catQ) return false;
      if (integQ && a.integrationId !== integQ) return false;
      if (statusQ && a.status !== statusQ) return false;
      return true;
    });
  }

  function applyFilters() {
    const filtered = getFilteredActions();
    $actionSelect.innerHTML = filtered.length
      ? filtered.map(a => {
          const badge = a.status === "Draft" ? " [Draft]" : "";
          const cat = a.category ? `  (${a.category})` : "";
          return `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}${cat}${badge}</option>`;
        }).join("")
      : `<option value="">No matching actions</option>`;
    $detail.hidden = true;
  }

  $filterName.addEventListener("input", applyFilters);
  $filterCat.addEventListener("change", applyFilters);
  $filterInteg.addEventListener("change", applyFilters);
  $filterStatus.addEventListener("change", applyFilters);

  // ── Select action ─────────────────────────────────────
  $actionSelect.addEventListener("change", async () => {
    const id = $actionSelect.value;
    if (!id) { $detail.hidden = true; return; }

    const item = allActions.find(a => a.id === id);
    if (!item) return;

    try {
      setStatus(STATUS.fetching);
      setProgress(30);

      // Try to get draft; if 404 means no draft exists
      let draftData = null;
      try {
        draftData = await gc.getDataActionDraft(api, $org.value, id);
      } catch { /* no draft */ }

      // Get published detail (for published actions)
      let pubData = null;
      if (item.status === "Published") {
        pubData = await gc.getDataAction(api, $org.value, id);
      }

      hasDraft = !!draftData;
      const detail = draftData || pubData;
      selectedFull = detail;

      setProgress(80);

      // Populate info panel
      $infoStatus.textContent = hasDraft ? (item.status === "Published" ? "Published + Draft" : "Draft only") : "Published";
      $infoInteg.textContent = integName(item.integrationId);
      $infoType.textContent = integType(item.integrationId);
      $infoSecure.textContent = detail.secure ? "Yes" : "No";
      $infoVersion.textContent = detail.version != null ? detail.version : "—";

      // Editable fields
      $name.value = detail.name || "";
      $category.value = detail.category || "";

      // Contract preview
      $contractPrev.innerHTML = buildContractPreview(detail.contract);

      // Test inputs from input contract
      buildTestInputFields(detail.contract);

      // Test target options
      $testTarget.innerHTML = "";
      if (item.status === "Published") {
        $testTarget.innerHTML += `<option value="published">Published</option>`;
      }
      if (hasDraft || item.status === "Draft") {
        $testTarget.innerHTML += `<option value="draft">Draft</option>`;
      }

      // Enable buttons
      $saveBtn.disabled = false;
      $validateBtn.disabled = !(hasDraft || item.status === "Draft");
      $publishBtn.disabled = !(hasDraft || item.status === "Draft");
      $testBtn.disabled = false;

      $detail.hidden = false;
      hideProgress();
      setStatus("Action loaded. Edit fields, test, or publish.");
    } catch (err) {
      hideProgress();
      setStatus(STATUS.error(err.message), "error");
    }
  });

  // ── Save Draft ────────────────────────────────────────
  $saveBtn.addEventListener("click", async () => {
    const id = $actionSelect.value;
    if (!id || !selectedFull) return;

    try {
      setStatus(STATUS.saving);
      setProgress(40);
      disableActions();

      // If no draft exists for a published action, create one first
      if (!hasDraft) {
        await gc.createDraftFromAction(api, $org.value, id);
        hasDraft = true;
      }

      // Patch the draft
      const patchBody = {
        name: $name.value.trim(),
        category: $category.value.trim(),
        version: selectedFull.version || 1,
      };

      const updated = await gc.patchDataActionDraft(api, $org.value, id, patchBody);
      selectedFull = updated;

      setProgress(100);
      $infoStatus.textContent = "Published + Draft";
      $infoVersion.textContent = updated.version != null ? updated.version : "—";
      $validateBtn.disabled = false;
      $publishBtn.disabled = false;

      // Update test target to include draft option
      if (!$testTarget.querySelector('option[value="draft"]')) {
        $testTarget.innerHTML += `<option value="draft">Draft</option>`;
      }

      setStatus("✓ Draft saved.", "success");
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
    } finally {
      hideProgress();
      enableActions();
    }
  });

  // ── Validate Draft ────────────────────────────────────
  $validateBtn.addEventListener("click", async () => {
    const id = $actionSelect.value;
    if (!id) return;

    try {
      setStatus(STATUS.validating);
      setProgress(50);
      disableActions();

      const result = await gc.validateDataActionDraft(api, $org.value, id);
      setProgress(100);

      if (result.valid) {
        setStatus("✓ Draft is valid.", "success");
      } else {
        const errors = (result.results || [])
          .filter(r => !r.valid)
          .map(r => r.errors?.map(e => e.message).join("; ") || "Unknown error")
          .join(" | ");
        setStatus(`Validation issues: ${errors}`, "error");
      }
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
    } finally {
      hideProgress();
      enableActions();
    }
  });

  // ── Publish ───────────────────────────────────────────
  $publishBtn.addEventListener("click", async () => {
    const id = $actionSelect.value;
    if (!id) return;

    try {
      setStatus(STATUS.publishing);
      setProgress(40);
      disableActions();

      const published = await gc.publishDataActionDraft(api, $org.value, id, {
        version: selectedFull.version || 1,
      });
      selectedFull = published;
      hasDraft = false;

      setProgress(100);
      $infoStatus.textContent = "Published";
      $infoVersion.textContent = published.version != null ? published.version : "—";

      // Update list item status
      const item = allActions.find(a => a.id === id);
      if (item) item.status = "Published";

      setStatus("✓ Action published.", "success");
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
    } finally {
      hideProgress();
      enableActions();
    }
  });

  // ── Test ──────────────────────────────────────────────
  $testBtn.addEventListener("click", async () => {
    const id = $actionSelect.value;
    if (!id) return;

    const target = $testTarget.value;
    const inputs = collectTestInputs();

    try {
      setStatus(STATUS.testing);
      setProgress(50);
      disableActions();
      $testResult.textContent = "Running…";

      let result;
      if (target === "draft") {
        result = await gc.testDataActionDraft(api, $org.value, id, inputs);
      } else {
        result = await gc.testDataAction(api, $org.value, id, inputs);
      }

      setProgress(100);
      $testResult.textContent = JSON.stringify(result, null, 2);
      setStatus(`✓ Test completed (${target}).`, "success");
    } catch (err) {
      $testResult.textContent = `Error: ${err.message}`;
      setStatus(STATUS.error(err.message), "error");
    } finally {
      hideProgress();
      enableActions();
    }
  });

  // ── Enable/disable helpers ────────────────────────────
  function disableActions() {
    $saveBtn.disabled = true;
    $validateBtn.disabled = true;
    $publishBtn.disabled = true;
    $testBtn.disabled = true;
    $loadBtn.disabled = true;
  }

  function enableActions() {
    $loadBtn.disabled = !$org.value;
    if ($actionSelect.value && selectedFull) {
      $saveBtn.disabled = false;
      $validateBtn.disabled = !hasDraft;
      $publishBtn.disabled = !hasDraft;
      $testBtn.disabled = false;
    }
  }

  return el;
}
