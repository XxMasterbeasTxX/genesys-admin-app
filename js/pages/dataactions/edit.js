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
 *                                                                (returns { valid, errors[] })
 *   POST  /api/v2/integrations/actions/{id}/draft/publish     — publish draft
 *   POST  /api/v2/integrations/actions/{id}/test              — test published action
 *   POST  /api/v2/integrations/actions/{id}/draft/test        — test draft action
 */
import { escapeHtml, makeStatus } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { logAction } from "../../services/activityLogService.js";
import { stripOrgSpecificUris } from "../../lib/dataActions.js";

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
  badJson:     (fields) =>
    `Not valid JSON: ${fields.join(", ")}. Fix the highlighted field(s) — `
    + "saving now would overwrite the stored value with an empty object.",
  tplFailed:   (fields) =>
    `Could not read the ${fields.join(" and ")} for this action. `
    + "Editing is disabled: saving would replace the stored template with a "
    + "blank one. Reload the action to try again.",
};

// ── Page renderer ───────────────────────────────────────────────────
export default function renderEditDataAction({ route, me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";

  const customers = orgContext.getCustomers();
  const orgOptions = `<option value="">Select org…</option>`
    + customers.map(c =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.region)})</option>`
    ).join("");

  el.innerHTML = `
    <h2>Data Actions — Edit</h2>

    <p class="page-desc">
      View, edit, and test existing data actions. Filter by name, category,
      integration, or status. Edit contract fields, save drafts, validate,
      publish, and run inline tests with custom input parameters.
    </p>

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

      <!-- Config: Request -->
      <details class="ed-config-section" style="max-width:700px;margin-top:14px">
        <summary class="ed-config-summary">Request Config</summary>
        <div class="dt-controls" style="margin-top:10px">
          <div class="dt-control-group">
            <label class="dt-label">Request Type</label>
            <select class="dt-select" id="edReqType" style="max-width:200px">
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
          </div>
          <div class="dt-control-group">
            <label class="dt-label">URL Template</label>
            <input class="dt-input" id="edReqUrl" type="text" style="max-width:700px" />
          </div>
          <div class="dt-control-group">
            <label class="dt-label">Request Body Template</label>
            <textarea class="dt-input" id="edReqTemplate" rows="8" style="max-width:700px;width:100%;font-family:monospace;font-size:12px;resize:vertical"></textarea>
          </div>
          <div class="dt-control-group">
            <label class="dt-label">Headers (JSON)</label>
            <textarea class="dt-input" id="edReqHeaders" rows="4" style="max-width:700px;width:100%;font-family:monospace;font-size:12px;resize:vertical"></textarea>
          </div>
        </div>
      </details>

      <!-- Config: Response -->
      <details class="ed-config-section" style="max-width:700px;margin-top:8px">
        <summary class="ed-config-summary">Response Config</summary>
        <div class="dt-controls" style="margin-top:10px">
          <div class="dt-control-group">
            <label class="dt-label">Translation Map (JSON)</label>
            <textarea class="dt-input" id="edRespTransMap" rows="6" style="max-width:700px;width:100%;font-family:monospace;font-size:12px;resize:vertical"></textarea>
          </div>
          <div class="dt-control-group">
            <label class="dt-label">Translation Map Defaults (JSON)</label>
            <textarea class="dt-input" id="edRespTransMapDefaults" rows="4" style="max-width:700px;width:100%;font-family:monospace;font-size:12px;resize:vertical"></textarea>
          </div>
          <div class="dt-control-group">
            <label class="dt-label">Success Template</label>
            <textarea class="dt-input" id="edRespSuccessTemplate" rows="6" style="max-width:700px;width:100%;font-family:monospace;font-size:12px;resize:vertical"></textarea>
          </div>
        </div>
      </details>

      <!-- Contract: read-only preview for published; editable JSON for draft-only -->
      <div id="edContractPreviewWrap" style="max-width:700px;margin-top:14px">
        <div class="dt-info-row"><span class="dt-info-key">Contract:</span></div>
        <div class="dt-schema" id="edContractPreview"></div>
      </div>

      <div id="edContractEditWrap" hidden style="max-width:700px;margin-top:14px">
        <div class="dt-info-row" style="margin-bottom:6px"><span class="dt-info-key">Contract (editable — draft only):</span></div>
        <div class="dt-control-group">
          <label class="dt-label">Input Schema (JSON)</label>
          <textarea class="dt-input" id="edInputSchema" rows="12" style="max-width:700px;width:100%;font-family:monospace;font-size:12px;resize:vertical"></textarea>
        </div>
        <div class="dt-control-group" style="margin-top:8px">
          <label class="dt-label">Output Success Schema (JSON)</label>
          <textarea class="dt-input" id="edOutputSchema" rows="12" style="max-width:700px;width:100%;font-family:monospace;font-size:12px;resize:vertical"></textarea>
        </div>
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
  const $contractPrev      = el.querySelector("#edContractPreview");
  const $contractPrevWrap  = el.querySelector("#edContractPreviewWrap");
  const $contractEditWrap  = el.querySelector("#edContractEditWrap");
  const $reqType           = el.querySelector("#edReqType");
  const $reqUrl            = el.querySelector("#edReqUrl");
  const $reqTemplate       = el.querySelector("#edReqTemplate");
  const $reqHeaders        = el.querySelector("#edReqHeaders");
  const $respTransMap      = el.querySelector("#edRespTransMap");
  const $respTransMapDef   = el.querySelector("#edRespTransMapDefaults");
  const $respSuccessTempl  = el.querySelector("#edRespSuccessTemplate");
  const $inputSchema       = el.querySelector("#edInputSchema");
  const $outputSchema      = el.querySelector("#edOutputSchema");
  const $saveBtn           = el.querySelector("#edSaveBtn");
  const $validateBtn   = el.querySelector("#edValidateBtn");
  const $publishBtn    = el.querySelector("#edPublishBtn");
  const $testTarget    = el.querySelector("#edTestTarget");
  const $testInputs    = el.querySelector("#edTestInputs");
  const $testBtn       = el.querySelector("#edTestBtn");
  const $testResult    = el.querySelector("#edTestResult");
  const $progress      = el.querySelector("#edProgress");
  const $progressBar   = el.querySelector("#edProgressBar");
  const $status        = el.querySelector("#edStatus");

  // ── Permission-based action gating (internal refinement) ──────────────
  const canEdit    = access && access.can ? access.can("data-actions.edit", "edit") : true;
  const canExecute = access && access.can ? access.can("data-actions.edit", "execute") : true;
  if (!canEdit) {
    $saveBtn.title = $validateBtn.title = $publishBtn.title = "Requires Genesys permission: integrations:action:edit";
  }
  if (!canExecute) $testBtn.title = "Requires Genesys permission: integrations:action:execute";

  let allActions = [];        // merged published + draft-only
  let integrations = [];      // org integrations
  let selectedFull = null;    // full detail of selected action
  let hasDraft = false;       // whether selected action has a draft
  let templateFailure = null; // template fields that could not be read
  // Monotonic token: a slow detail fetch for an action the user has already
  // moved off must not paint over the newer selection.
  let selectionSeq = 0;

  // ── Helpers ───────────────────────────────────────────
  const setStatus = makeStatus($status, "dt-status");

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

  /**
   * Parse a JSON textarea, collecting failures rather than hiding them.
   *
   * The old version returned `{}` on a parse error, so one stray comma in the
   * Input Schema box silently PATCHed an empty contract over a real one and
   * still reported "Draft saved". Invalid input now names the field in
   * `errors`, and the caller aborts the save.
   *
   * An empty box legitimately means "no value" and yields `fallback`.
   */
  function parseJsonField(val, label, errors, fallback = {}) {
    const trimmed = (val || "").trim();
    if (!trimmed) return fallback;
    try {
      return JSON.parse(trimmed);
    } catch {
      errors.push(label);
      return fallback;
    }
  }

  /** Mark a textarea as holding invalid JSON (or clear the mark). */
  function markInvalid($field, bad) {
    $field.classList.toggle("ed-invalid", !!bad);
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

  /**
   * Collect test input values into an object.
   *
   * Returns `{ inputs, errors }`. A numeric field holding something that is not
   * a number used to be sent as `NaN`, which serialises to `null` and makes the
   * action fail for a reason the result pane never explains — it is reported
   * here instead. Empty fields are omitted, as an unset parameter.
   */
  function collectTestInputs() {
    const inputs = {};
    const errors = [];
    $testInputs.querySelectorAll(".ed-test-field").forEach(field => {
      const key = field.dataset.key;
      const type = field.dataset.type;
      const raw = field.value.trim();
      markInvalid(field, false);
      if (!raw) return; // unset parameter

      if (type === "integer" || type === "number") {
        const num = Number(raw);
        if (!Number.isFinite(num)) {
          errors.push(key);
          markInvalid(field, true);
          return;
        }
        inputs[key] = type === "integer" ? Math.trunc(num) : num;
      } else if (type === "boolean") {
        inputs[key] = raw.toLowerCase() === "true";
      } else {
        inputs[key] = raw;
      }
    });
    return { inputs, errors };
  }

  // ── Org selection ─────────────────────────────────────
  $org.addEventListener("change", () => {
    $loadBtn.disabled = !$org.value;
    resetAll();
  });

  function resetAll() {
    allActions = [];
    integrations = [];
    $actionSelect.innerHTML = `<option value="">Load actions first…</option>`;
    $actionSelect.disabled = true;
    $filters.hidden = true;
    $detail.hidden = true;
    selectedFull = null;
    hasDraft = false;
    templateFailure = null;
    selectionSeq++;   // abandon any detail fetch still in flight
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
    const seq = ++selectionSeq;
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
      if (seq !== selectionSeq) return;   // superseded by a newer selection

      hasDraft = !!draftData;
      const detail = draftData || pubData;
      // A draft-only action whose draft GET failed leaves nothing to show.
      // Say so rather than failing on a null dereference further down.
      if (!detail) throw new Error("Could not load this action's configuration.");
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

      // `getDataAction`/`getDataActionDraft` resolve .vm template references
      // into real strings. When one could not be read, the textarea below would
      // show an empty template that Save Draft would then write back over the
      // real one — so editing is blocked instead.
      templateFailure = detail.templateFetchFailures || null;

      // Config: request
      const req = detail.config?.request || {};
      $reqType.value     = req.requestType || "GET";
      $reqUrl.value      = req.requestUrlTemplate || "";
      $reqTemplate.value = req.requestTemplate || "";
      $reqHeaders.value  = req.headers && Object.keys(req.headers).length
        ? JSON.stringify(req.headers, null, 2) : "";

      // Config: response
      const resp = detail.config?.response || {};
      $respTransMap.value    = resp.translationMap && Object.keys(resp.translationMap).length
        ? JSON.stringify(resp.translationMap, null, 2) : "";
      $respTransMapDef.value = resp.translationMapDefaults && Object.keys(resp.translationMapDefaults).length
        ? JSON.stringify(resp.translationMapDefaults, null, 2) : "";
      $respSuccessTempl.value = resp.successTemplate || "";

      // Contract: editable JSON for draft-only; read-only preview for published
      const isDraftOnly = item.status === "Draft";
      $contractPrevWrap.hidden = isDraftOnly;
      $contractEditWrap.hidden = !isDraftOnly;
      if (isDraftOnly) {
        $inputSchema.value  = detail.contract?.input?.inputSchema
          ? JSON.stringify(detail.contract.input.inputSchema, null, 2) : "";
        $outputSchema.value = detail.contract?.output?.successSchema
          ? JSON.stringify(detail.contract.output.successSchema, null, 2) : "";
      } else {
        $contractPrev.innerHTML = buildContractPreview(detail.contract);
      }

      // Test inputs from input contract
      buildTestInputFields(detail.contract);

      // Test target options
      const targets = [];
      if (item.status === "Published") targets.push(`<option value="published">Published</option>`);
      if (draftExists()) targets.push(`<option value="draft">Draft</option>`);
      $testTarget.innerHTML = targets.join("");

      refreshActionButtons();

      $detail.hidden = false;
      hideProgress();
      setStatus(templateFailure
        ? STATUS.tplFailed(templateFailure)
        : "Action loaded. Edit fields, test, or publish.",
        templateFailure ? "error" : "");
    } catch (err) {
      if (seq !== selectionSeq) return;
      hideProgress();
      setStatus(STATUS.error(err.message), "error");
    }
  });

  // ── Save Draft ────────────────────────────────────────
  $saveBtn.addEventListener("click", async () => {
    const id = $actionSelect.value;
    if (!id || !selectedFull) return;

    // A template we could not read must never be written back as "".
    if (templateFailure) {
      setStatus(STATUS.tplFailed(templateFailure), "error");
      return;
    }

    const actionItem = allActions.find(a => a.id === id);
    const isDraftOnly = actionItem?.status === "Draft";

    // ── Parse every JSON field FIRST. Nothing is sent unless all of them are
    //    valid, so a syntax error can no longer blank a stored value.
    const jsonErrors = [];
    const headers        = parseJsonField($reqHeaders.value, "Headers", jsonErrors);
    const translationMap = parseJsonField($respTransMap.value, "Translation Map", jsonErrors);
    const transMapDefs   = parseJsonField($respTransMapDef.value, "Translation Map Defaults", jsonErrors);
    const inputSchema    = isDraftOnly
      ? parseJsonField($inputSchema.value, "Input Schema", jsonErrors, null) : null;
    const outputSchema   = isDraftOnly
      ? parseJsonField($outputSchema.value, "Output Success Schema", jsonErrors, null) : null;

    markInvalid($reqHeaders,       jsonErrors.includes("Headers"));
    markInvalid($respTransMap,     jsonErrors.includes("Translation Map"));
    markInvalid($respTransMapDef,  jsonErrors.includes("Translation Map Defaults"));
    markInvalid($inputSchema,      jsonErrors.includes("Input Schema"));
    markInvalid($outputSchema,     jsonErrors.includes("Output Success Schema"));

    if (jsonErrors.length) {
      setStatus(STATUS.badJson(jsonErrors), "error");
      return;
    }

    try {
      setStatus(STATUS.saving);
      setProgress(40);
      disableActions();

      // If no draft exists for a published action, create one first. The new
      // draft carries its OWN version, which is what UpdateDraftInput.version
      // is checked against — the published action's version is not necessarily
      // the same number, so use what the create returned.
      let draftVersion = selectedFull.version;
      if (!hasDraft) {
        const created = await gc.createDraftFromAction(api, $org.value, id);
        hasDraft = true;
        if (created?.version != null) draftVersion = created.version;
      }

      // `config` is replaced wholesale, so anything omitted here is dropped.
      // timeoutSeconds is not editable on this page but is part of the stored
      // config, and leaving it out silently cleared the action's timeout.
      const config = {
        request: {
          requestType:        $reqType.value,
          requestUrlTemplate: $reqUrl.value.trim(),
          requestTemplate:    $reqTemplate.value,
          headers,
        },
        response: {
          translationMap,
          translationMapDefaults: transMapDefs,
          successTemplate:        $respSuccessTempl.value,
        },
      };
      if (selectedFull.config?.timeoutSeconds != null) {
        config.timeoutSeconds = selectedFull.config.timeoutSeconds;
      }

      const patchBody = {
        name: $name.value.trim(),
        category: $category.value.trim(),
        version: draftVersion != null ? draftVersion : 1,
        config,
      };

      // Include contract only for draft-only actions. Start from the stored
      // contract so fields this page has no editor for — errorSchema in
      // particular — survive the round trip instead of being dropped, and drop
      // the derived *Uri / *Flattened variants, which are readOnly output.
      //
      // An empty textarea falls back to the stored schema rather than sending
      // null: `inputSchema` and `successSchema` are required by the contract,
      // so "cleared" is not a state the action can legally be left in.
      if (isDraftOnly) {
        const stored = stripOrgSpecificUris(selectedFull.contract || {});
        patchBody.contract = {
          ...stored,
          input: {
            ...stored.input,
            inputSchema: inputSchema != null ? inputSchema : stored.input?.inputSchema,
          },
          output: {
            ...stored.output,
            successSchema: outputSchema != null ? outputSchema : stored.output?.successSchema,
          },
        };
      }

      const updated = await gc.patchDataActionDraft(api, $org.value, id, patchBody);
      selectedFull = updated;

      setProgress(100);
      $infoStatus.textContent = isDraftOnly ? "Draft only" : "Published + Draft";
      $infoVersion.textContent = updated.version != null ? updated.version : "—";

      // Update test target to include draft option
      if (!$testTarget.querySelector('option[value="draft"]')) {
        $testTarget.append(new Option("Draft", "draft"));
      }

      setStatus("✓ Draft saved.", "success");
      logAction({ me, orgId: $org.value, action: "dataaction_save",
        description: `Saved draft for data action '${$actionSelect.options[$actionSelect.selectedIndex]?.text || $actionSelect.value}'` });
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
        // DraftValidationResult is { valid, errors: ErrorBody[] }. The previous
        // code walked a `results` array that this endpoint has never returned,
        // so every validation failure rendered as an empty message on the one
        // screen whose whole job is saying what is wrong.
        const errors = (result.errors || [])
          .map(e => e.message || e.code || e.messageWithParams)
          .filter(Boolean);
        setStatus(
          errors.length
            ? `Validation failed: ${errors.join(" | ")}`
            : "Validation failed, but Genesys returned no detail.",
          "error");
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
        version: selectedFull.version != null ? selectedFull.version : 1,
      });
      selectedFull = published;
      hasDraft = false;

      setProgress(100);
      $infoStatus.textContent = "Published";
      $infoVersion.textContent = published.version != null ? published.version : "—";

      // Update list item status, and the option text with it — the list would
      // otherwise keep the "[Draft]" badge on an action that is now published.
      const item = allActions.find(a => a.id === id);
      if (item) {
        item.status = "Published";
        const opt = $actionSelect.options[$actionSelect.selectedIndex];
        if (opt) opt.text = opt.text.replace(/ \[Draft\]$/, "");
      }
      // Publishing consumes the draft and creates the published action, so the
      // test targets swap over. A draft-only action had no "published" option
      // to begin with — without adding it the dropdown would be left empty.
      if (!$testTarget.querySelector('option[value="published"]')) {
        $testTarget.append(new Option("Published", "published"));
      }
      const draftOpt = $testTarget.querySelector('option[value="draft"]');
      if (draftOpt) draftOpt.remove();
      $testTarget.value = "published";

      setStatus("✓ Action published.", "success");
      logAction({ me, orgId: $org.value, action: "dataaction_publish",
        description: `Published data action '${$actionSelect.options[$actionSelect.selectedIndex]?.text || $actionSelect.value}'` });
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
    const { inputs, errors: inputErrors } = collectTestInputs();
    if (inputErrors.length) {
      setStatus(`Not a number: ${inputErrors.join(", ")}.`, "error");
      return;
    }

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

      // TestExecutionResult carries its own `success` flag: an action that runs
      // and fails still returns HTTP 200. Reporting that as a green success
      // contradicted the failure sitting in the result pane right below.
      if (result?.success === false) {
        const detail = result.error?.message
          || (result.operations || []).filter(o => o.success === false)
               .map(o => `${o.name}: ${o.error?.message || "failed"}`).join(" | ");
        setStatus(`Test failed (${target})${detail ? `: ${detail}` : "."}`, "error");
      } else {
        setStatus(`✓ Test succeeded (${target}).`, "success");
      }
    } catch (err) {
      $testResult.textContent = `Error: ${err.message}`;
      setStatus(STATUS.error(err.message), "error");
    } finally {
      hideProgress();
      enableActions();
    }
  });

  // ── Enable/disable helpers ────────────────────────────

  /**
   * Whether the selected action has something publishable.
   *
   * A draft-only action always does. `hasDraft` alone used to be the condition
   * in one place and `hasDraft || status === "Draft"` in another; the two
   * agreed only by accident, so both now go through here.
   */
  function draftExists() {
    const item = allActions.find(a => a.id === $actionSelect.value);
    return hasDraft || item?.status === "Draft";
  }

  /**
   * Single source of truth for the four action buttons.
   *
   * Save/Validate/Publish need the edit permission; Test needs execute. On top
   * of that, an action whose stored templates could not be read is not safe to
   * write back at all, so the three write buttons stay off — testing it is
   * still fine, since a test does not persist anything.
   */
  function refreshActionButtons() {
    const write = canEdit && !templateFailure;
    $saveBtn.disabled     = !write;
    $validateBtn.disabled = !write || !draftExists();
    $publishBtn.disabled  = !write || !draftExists();
    $testBtn.disabled     = !canExecute;
  }

  function disableActions() {
    $saveBtn.disabled = true;
    $validateBtn.disabled = true;
    $publishBtn.disabled = true;
    $testBtn.disabled = true;
    $loadBtn.disabled = true;
  }

  function enableActions() {
    $loadBtn.disabled = !$org.value;
    if ($actionSelect.value && selectedFull) refreshActionButtons();
  }

  return el;
}
