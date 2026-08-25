/**
 * Data Actions › Edit
 *
 * Open an existing data action, view/edit its properties, and test it.
 *
 * Flow:
 *   1. Org comes from the header picker; the page loads that org's published
 *      actions, drafts and integrations once on arrival (Refresh re-fetches).
 *   2. Searchable action picker, narrowed further by category / integration /
 *      status.
 *   3. Select an action → identity line, then three collapsed sections:
 *      Contract, Configuration, Test — the order the Genesys editor uses.
 *   4. Editable: name, request/response config, execution timeout, and the
 *      contract of a draft-only action.
 *      Fixed: category, integration, and the contract of a published action —
 *      Genesys does not allow those to change, so neither do we.
 *   5. Save Draft, Validate, Publish from the action bar; Test in its section.
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
import { createSingleSelect } from "../../components/multiSelect.js";
import * as gc from "../../services/genesysApi.js";
import { logAction } from "../../services/activityLogService.js";
import { stripOrgSpecificUris } from "../../lib/dataActions.js";

// ── Status helpers ──────────────────────────────────────────────────
const STATUS = {
  ready:       "Loading…",
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
  badTimeout:  "Execution Timeout must be a whole number of seconds between 1 and 60, "
    + "or blank to leave it unset.",
  noOrg:       "Select an organisation in the header to load its data actions.",
};

// ── Page renderer ───────────────────────────────────────────────────
export default function renderEditDataAction({ route, me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";

  const orgId = orgContext.get();

  el.innerHTML = `
    <h2>Data Actions — Edit</h2>

    <p class="page-desc">
      View, edit and test the data actions in the selected org. Name and
      configuration are editable; category, integration and contract are fixed
      once an action exists, matching what Genesys allows.
    </p>

    <!-- No org chosen: the header picker is the only place to fix that -->
    <div class="ed-empty" id="edNoOrg" hidden>
      Select an organisation in the header to load its data actions.
    </div>

    <div id="edMain" hidden>
      <!-- Picker + refresh -->
      <div class="ed-picker-row">
        <div class="ed-picker-mount" id="edActionMount"></div>
        <button class="btn" id="edRefreshBtn">Refresh</button>
      </div>

      <!-- Secondary filters, only once actions are loaded -->
      <div class="ed-filter-row" id="edFilters" hidden>
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

      <!-- Action bar: the three writes, the dirty marker, then messages -->
      <div class="ed-actionbar" id="edActionBar" hidden>
        <button class="btn" id="edSaveBtn" disabled>Save Draft</button>
        <button class="btn" id="edValidateBtn" disabled>Validate Draft</button>
        <button class="btn" id="edPublishBtn" disabled>Publish</button>
        <span class="ed-dirty" id="edDirty" hidden>&#9679; unsaved changes</span>
      </div>

      <div class="dt-progress-wrap" id="edProgress" hidden>
        <div class="dt-progress-bar" id="edProgressBar"></div>
      </div>

      <div class="dt-status" id="edStatus">${STATUS.ready}</div>

      <!-- Detail -->
      <div id="edDetail" hidden>
        <hr class="ed-divider" />

        <!-- Identity: status badge first, everything else on one line -->
        <div class="ed-identity">
          <span class="ed-badge" id="edInfoStatus">—</span>
          <span class="ed-identity-meta">
            <span id="edInfoVersion">—</span>
            <span class="ed-sep">·</span>
            <span id="edInfoInteg" title="">—</span>
            <span class="ed-sep">·</span>
            <span id="edInfoSecure">—</span>
          </span>
        </div>

        <div class="ed-identity-fields">
          <div class="dt-control-group ed-field">
            <label class="dt-label" for="edName">Name</label>
            <input class="dt-input" id="edName" type="text" />
          </div>
          <div class="dt-control-group ed-field">
            <label class="dt-label">Category</label>
            <div class="ed-readonly" id="edCategory"
                 title="Fixed when the action is created — Genesys does not allow it to change">—</div>
          </div>
        </div>

        <!-- Contract -->
        <details class="ed-section" id="edSecContract">
          <summary class="ed-section-summary">Contract</summary>
          <div class="ed-section-body">
            <div id="edContractPreviewWrap">
              <p class="ed-note">
                The contract is fixed once an action is published — flows referencing it
                depend on these fields, and Genesys does not allow it to change either.
                Create a new action to use a different contract.
              </p>
              <div class="dt-schema" id="edContractPreview"></div>
            </div>

            <div id="edContractEditWrap" hidden>
              <p class="ed-note">This action exists only as a draft, so its contract can still be changed.</p>
              <div class="dt-control-group ed-field--wide">
                <label class="dt-label" for="edInputSchema">Input Schema (JSON)</label>
                <textarea class="dt-input ed-code" id="edInputSchema" rows="12"></textarea>
              </div>
              <div class="dt-control-group ed-field--wide">
                <label class="dt-label" for="edOutputSchema">Output Success Schema (JSON)</label>
                <textarea class="dt-input ed-code" id="edOutputSchema" rows="12"></textarea>
              </div>
            </div>
          </div>
        </details>

        <!-- Configuration -->
        <details class="ed-section" id="edSecConfig">
          <summary class="ed-section-summary">Configuration</summary>
          <div class="ed-section-body">
            <h4 class="ed-subhead">Request</h4>
            <div class="dt-control-group ed-field--narrow">
              <label class="dt-label" for="edReqType">HTTP Method</label>
              <select class="dt-select" id="edReqType">
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>
            <div class="dt-control-group ed-field--wide">
              <label class="dt-label" for="edReqUrl">Request URL Template</label>
              <input class="dt-input" id="edReqUrl" type="text" />
            </div>
            <div class="dt-control-group ed-field--narrow">
              <label class="dt-label" for="edReqTimeout">Execution Timeout</label>
              <input class="dt-input" id="edReqTimeout" type="number" min="1" max="60" placeholder="not set" />
              <span class="ed-hint">Seconds, 1–60. Blank leaves it unset.</span>
            </div>
            <div class="dt-control-group ed-field--wide">
              <label class="dt-label" for="edReqTemplate">Request Body Template</label>
              <textarea class="dt-input ed-code" id="edReqTemplate" rows="8"></textarea>
            </div>
            <div class="dt-control-group ed-field--wide">
              <label class="dt-label" for="edReqHeaders">Headers (JSON)</label>
              <textarea class="dt-input ed-code" id="edReqHeaders" rows="4"></textarea>
            </div>

            <h4 class="ed-subhead">Response</h4>
            <div class="dt-control-group ed-field--wide">
              <label class="dt-label" for="edRespTransMap">Translation Map (JSON)</label>
              <textarea class="dt-input ed-code" id="edRespTransMap" rows="6"></textarea>
            </div>
            <div class="dt-control-group ed-field--wide">
              <label class="dt-label" for="edRespTransMapDefaults">Translation Map Defaults (JSON)</label>
              <textarea class="dt-input ed-code" id="edRespTransMapDefaults" rows="4"></textarea>
            </div>
            <div class="dt-control-group ed-field--wide">
              <label class="dt-label" for="edRespSuccessTemplate">Success Template</label>
              <textarea class="dt-input ed-code" id="edRespSuccessTemplate" rows="6"></textarea>
            </div>
          </div>
        </details>

        <!-- Test -->
        <details class="ed-section" id="edSecTest">
          <summary class="ed-section-summary">Test</summary>
          <div class="ed-section-body">
            <div class="dt-control-group ed-field--narrow">
              <label class="dt-label" for="edTestTarget">Test target</label>
              <select class="dt-select" id="edTestTarget">
                <option value="published">Published</option>
                <option value="draft">Draft</option>
              </select>
            </div>

            <div id="edTestInputs" class="ed-test-inputs"></div>

            <div class="dt-actions">
              <button class="btn ed-btn-test" id="edTestBtn" disabled>Run Test</button>
            </div>

            <div id="edTestOutcome" class="ed-test-outcome" hidden></div>

            <div id="edTestOutputsWrap" hidden>
              <h4 class="ed-subhead">Outputs</h4>
              <div class="dt-schema" id="edTestOutputs"></div>
            </div>

            <details class="ed-subsection" id="edTestStepsWrap" hidden>
              <summary class="ed-subsection-summary">Steps</summary>
              <div class="dt-schema" id="edTestSteps"></div>
            </details>

            <details class="ed-subsection" id="edTestRawWrap" hidden>
              <summary class="ed-subsection-summary">Raw response</summary>
              <pre class="ed-test-result" id="edTestResult"></pre>
            </details>
          </div>
        </details>
      </div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────
  const $noOrg         = el.querySelector("#edNoOrg");
  const $main          = el.querySelector("#edMain");
  const $actionMount   = el.querySelector("#edActionMount");
  const $refreshBtn    = el.querySelector("#edRefreshBtn");
  const $actionBar     = el.querySelector("#edActionBar");
  const $dirtyMark     = el.querySelector("#edDirty");
  const $filters       = el.querySelector("#edFilters");
  const $filterCat     = el.querySelector("#edFilterCat");
  const $filterInteg   = el.querySelector("#edFilterInteg");
  const $filterStatus  = el.querySelector("#edFilterStatus");
  const $detail        = el.querySelector("#edDetail");
  const $infoStatus    = el.querySelector("#edInfoStatus");
  const $infoInteg     = el.querySelector("#edInfoInteg");
  const $infoSecure    = el.querySelector("#edInfoSecure");
  const $infoVersion   = el.querySelector("#edInfoVersion");
  const $name          = el.querySelector("#edName");
  const $category      = el.querySelector("#edCategory");
  const $reqTimeout    = el.querySelector("#edReqTimeout");
  const $secContract   = el.querySelector("#edSecContract");
  const $secConfig     = el.querySelector("#edSecConfig");
  const $secTest       = el.querySelector("#edSecTest");
  const $testOutcome   = el.querySelector("#edTestOutcome");
  const $testOutputs   = el.querySelector("#edTestOutputs");
  const $testOutputsWrap = el.querySelector("#edTestOutputsWrap");
  const $testSteps     = el.querySelector("#edTestSteps");
  const $testStepsWrap = el.querySelector("#edTestStepsWrap");
  const $testRawWrap   = el.querySelector("#edTestRawWrap");
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

  // Searchable action picker. Replaces the old listbox plus its separate
  // name filter — the component carries the search inline.
  const actionCtl = createSingleSelect({
    placeholder: "Select an action…",
    searchable:  true,
    onChange:    (id) => handleActionChange(id),
  });
  actionCtl.setEnabled(false);
  $actionMount.append(actionCtl.el);

  let allActions = [];        // merged published + draft-only
  let integrations = [];      // org integrations
  let selectedFull = null;    // full detail of selected action
  let hasDraft = false;       // whether selected action has a draft
  let templateFailure = null; // template fields that could not be read
  let isDirty = false;        // form edited since the action was loaded/saved
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

  /** Set the unsaved-changes flag and its marker in the action bar together. */
  function setDirty(next) {
    isDirty = next;
    $dirtyMark.hidden = !next;
  }

  /** The selected action's own name, for status text and the activity log. */
  function actionName(id) {
    return allActions.find(a => a.id === id)?.name || id;
  }

  /**
   * Paint the status badge. The three states are visually distinct because
   * status decides which controls do anything: a draft can be published, a
   * published action with no draft cannot.
   */
  function setStatusBadge(text) {
    $infoStatus.textContent = text;
    $infoStatus.className = "ed-badge "
      + (text === "Published" ? "is-published"
         : text === "Draft only" ? "is-draft" : "is-both");
  }

  /**
   * Every field whose value goes into the draft.
   *
   * Editing any of them makes the on-screen form differ from what Genesys
   * holds, which is what Publish needs to know about — see the prompt in the
   * Publish handler.
   */
  const EDITABLE = [
    $name, $reqType, $reqUrl, $reqTimeout, $reqTemplate, $reqHeaders,
    $respTransMap, $respTransMapDef, $respSuccessTempl, $inputSchema, $outputSchema,
  ];
  EDITABLE.forEach(($f) => {
    $f.addEventListener("input", () => setDirty(true));
    $f.addEventListener("change", () => setDirty(true));
  });

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

  function resetAll() {
    allActions = [];
    integrations = [];
    actionCtl.setItems([]);
    actionCtl.setEnabled(false);
    $filters.hidden = true;
    $actionBar.hidden = true;
    $detail.hidden = true;
    selectedFull = null;
    hasDraft = false;
    templateFailure = null;
    setDirty(false);
    selectionSeq++;   // abandon any detail fetch still in flight
  }

  // ── Load actions ──────────────────────────────────────

  /**
   * Fetch the org's actions, drafts and integrations.
   *
   * Deliberately not run on every render, unlike `datatables/edit`: this is
   * three paginated walks rather than one, so it runs once on arrival and then
   * only when Refresh is pressed.
   */
  async function loadActions() {
    if (!orgId) return;

    try {
      setStatus(STATUS.loading);
      $refreshBtn.disabled = true;
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
        $refreshBtn.disabled = false;
        return;
      }

      // Populate filter dropdowns
      populateFilterDropdowns();
      $filters.hidden = false;
      applyFilters();

      actionCtl.setEnabled(true);
      $refreshBtn.disabled = false;
      setStatus(`Loaded ${allActions.length} action(s). Select one to view or edit.`);
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
      $refreshBtn.disabled = false;
    }
  }

  $refreshBtn.addEventListener("click", loadActions);

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
    // Name is no longer filtered here — the picker searches its own items.
    const catQ  = $filterCat.value;
    const integQ = $filterInteg.value;
    const statusQ = $filterStatus.value;

    return allActions.filter(a => {
      if (catQ && a.category !== catQ) return false;
      if (integQ && a.integrationId !== integQ) return false;
      if (statusQ && a.status !== statusQ) return false;
      return true;
    });
  }

  /** Feed the picker the actions matching the current filters. */
  function applyFilters() {
    const filtered = getFilteredActions();
    actionCtl.setItems(filtered.map(a => ({
      id:    a.id,
      label: `${a.name}${a.category ? `  (${a.category})` : ""}${a.status === "Draft" ? "  [Draft]" : ""}`,
    })));
    // setItems clears the selection, so nothing is on screen to describe.
    $actionBar.hidden = true;
    $detail.hidden = true;
  }

  $filterCat.addEventListener("change", applyFilters);
  $filterInteg.addEventListener("change", applyFilters);
  $filterStatus.addEventListener("change", applyFilters);

  // ── Select action ─────────────────────────────────────
  async function handleActionChange(id) {
    const seq = ++selectionSeq;
    if (!id) { $actionBar.hidden = true; $detail.hidden = true; return; }

    const item = allActions.find(a => a.id === id);
    if (!item) return;

    try {
      setStatus(STATUS.fetching);
      setProgress(30);

      // Try to get draft; if 404 means no draft exists
      let draftData = null;
      try {
        draftData = await gc.getDataActionDraft(api, orgId, id);
      } catch { /* no draft */ }

      // Get published detail (for published actions)
      let pubData = null;
      if (item.status === "Published") {
        pubData = await gc.getDataAction(api, orgId, id);
      }
      if (seq !== selectionSeq) return;   // superseded by a newer selection

      hasDraft = !!draftData;
      const detail = draftData || pubData;
      // A draft-only action whose draft GET failed leaves nothing to show.
      // Say so rather than failing on a null dereference further down.
      if (!detail) throw new Error("Could not load this action's configuration.");
      selectedFull = detail;

      setProgress(80);

      // Identity: badge plus one line of context
      const statusText = hasDraft
        ? (item.status === "Published" ? "Published + Draft" : "Draft only")
        : "Published";
      setStatusBadge(statusText);
      $infoInteg.textContent = integName(item.integrationId);
      // Integration type is diagnostic, not something read every visit.
      $infoInteg.title = `Integration type: ${integType(item.integrationId)}`;
      $infoSecure.textContent = detail.secure ? "secure" : "not secure";
      $infoVersion.textContent = detail.version != null ? `v${detail.version}` : "—";

      // Name is editable; category is fixed at creation, so it is shown only.
      $name.value = detail.name || "";
      $category.textContent = detail.category || "—";

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
      // Blank means "not set", which is distinct from 0.
      $reqTimeout.value  = detail.config?.timeoutSeconds != null
        ? detail.config.timeoutSeconds : "";

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

      // A previous action's results must not linger under a new selection.
      clearTestResults();

      refreshActionButtons();
      // The form now mirrors Genesys, so nothing is unsaved. (Assigning .value
      // fires no input event, so filling the fields above did not set this.)
      setDirty(false);

      $actionBar.hidden = false;
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
  }

  // ── Save Draft ────────────────────────────────────────

  /**
   * Write the form back as a draft.
   *
   * Extracted from the button handler so Publish can call it too: publishing
   * with unsaved edits on screen would otherwise promote the STORED draft and
   * silently discard what the user is looking at.
   *
   * @returns {Promise<boolean>} true only if a draft was actually written.
   */
  async function performSave() {
    const id = actionCtl.getValue();
    if (!id || !selectedFull) return false;

    // A template we could not read must never be written back as "".
    if (templateFailure) {
      setStatus(STATUS.tplFailed(templateFailure), "error");
      return false;
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
      return false;
    }

    // Execution Timeout: blank is "not set"; anything else must be 1–60, the
    // range Genesys accepts. Sending an out-of-range value is a 400 the user
    // would have to decode from the API's own wording.
    const timeoutRaw = $reqTimeout.value.trim();
    let timeoutSeconds = null;
    if (timeoutRaw) {
      const n = Number(timeoutRaw);
      if (!Number.isInteger(n) || n < 1 || n > 60) {
        markInvalid($reqTimeout, true);
        setStatus(STATUS.badTimeout, "error");
        return false;
      }
      timeoutSeconds = n;
    }
    markInvalid($reqTimeout, false);

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
        const created = await gc.createDraftFromAction(api, orgId, id);
        hasDraft = true;
        if (created?.version != null) draftVersion = created.version;
      }

      // `config` is replaced wholesale, so anything omitted here is dropped.
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
      // A blank timeout box means "not set", so the key is omitted rather than
      // sent as 0. Anything present is carried through; before this field
      // existed, omitting it silently cleared the action's timeout.
      if (timeoutSeconds != null) config.timeoutSeconds = timeoutSeconds;

      // `category` is deliberately absent: Genesys fixes it at creation and its
      // own UI offers no way to change it, so the page shows it read-only and
      // never writes it. `integrationId` is not part of UpdateDraftInput at all.
      const patchBody = {
        name: $name.value.trim(),
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

      const updated = await gc.patchDataActionDraft(api, orgId, id, patchBody);
      selectedFull = updated;

      setProgress(100);
      $infoStatus.textContent = isDraftOnly ? "Draft only" : "Published + Draft";
      $infoVersion.textContent = updated.version != null ? updated.version : "—";

      // Update test target to include draft option
      if (!$testTarget.querySelector('option[value="draft"]')) {
        $testTarget.append(new Option("Draft", "draft"));
      }

      setDirty(false);
      setStatus("✓ Draft saved.", "success");
      logAction({ me, orgId, action: "dataaction_save",
        description: `Saved draft for data action '${actionName(id)}'` });
      return true;
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
      return false;
    } finally {
      hideProgress();
      enableActions();
    }
  }

  $saveBtn.addEventListener("click", () => { performSave(); });

  // ── Validate Draft ────────────────────────────────────
  $validateBtn.addEventListener("click", async () => {
    const id = actionCtl.getValue();
    if (!id) return;

    try {
      setStatus(STATUS.validating);
      setProgress(50);
      disableActions();

      const result = await gc.validateDataActionDraft(api, orgId, id);
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
    const id = actionCtl.getValue();
    if (!id) return;

    // Publishing promotes the STORED draft. With edits still on screen that
    // means quietly discarding them while reporting success — the same class of
    // silent-success bug this page was fixed for. Ask instead.
    if (isDirty) {
      const proceed = window.confirm(
        "You have unsaved changes.\n\n" +
        "Publishing promotes the saved draft, so these edits would be left " +
        "behind. Save them first, then publish?");
      if (!proceed) return;
      const saved = await performSave();
      if (!saved) return;   // performSave has already explained why
    }

    try {
      setStatus(STATUS.publishing);
      setProgress(40);
      disableActions();

      const published = await gc.publishDataActionDraft(api, orgId, id, {
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
      if (item) item.status = "Published";
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
      logAction({ me, orgId, action: "dataaction_publish",
        description: `Published data action '${actionName(id)}'` });
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
    } finally {
      hideProgress();
      enableActions();
    }
  });

  // ── Test ──────────────────────────────────────────────

  /** Hide every result pane — used when switching action or starting a run. */
  function clearTestResults() {
    $testOutcome.hidden = true;
    $testOutcome.textContent = "";
    $testOutputsWrap.hidden = true;
    $testStepsWrap.hidden = true;
    $testRawWrap.hidden = true;
    $testResult.textContent = "";
  }

  /** Format one output value for display, without hiding its shape. */
  function formatValue(v) {
    if (v === undefined) return "—";
    if (v === null) return "null";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  /**
   * Render a TestExecutionResult against the action's own output contract.
   *
   * The raw envelope told you almost nothing without reading JSON. The action
   * declares what it returns, so the values are shown by name and type, the
   * per-step breakdown becomes readable, and the dump is kept but demoted.
   */
  function renderTestResult(result, target) {
    const failed = result?.success === false;

    const detail = failed
      ? (result.error?.message
         || (result.operations || []).filter(o => o.success === false)
              .map(o => `${o.name}: ${o.error?.message || "failed"}`).join(" | "))
      : "";

    $testOutcome.hidden = false;
    $testOutcome.className = `ed-test-outcome ${failed ? "is-fail" : "is-ok"}`;
    $testOutcome.textContent = failed
      ? `Test failed (${target})${detail ? ` — ${detail}` : ""}`
      : `Test succeeded (${target})`;

    // Outputs, named from contract.output.successSchema
    const outProps = extractSchemaProps(selectedFull?.contract?.output?.successSchema);
    const finalResult = result?.finalResult;
    if (outProps && finalResult && typeof finalResult === "object") {
      const rows = Object.entries(outProps).map(([key, def]) => `
        <tr>
          <td>${escapeHtml(def.title || key)}</td>
          <td>${escapeHtml(def.type || "string")}</td>
          <td>${escapeHtml(formatValue(finalResult[key]))}</td>
        </tr>`).join("");
      $testOutputs.innerHTML = `
        <table class="dt-schema-table">
          <thead><tr><th>Output</th><th>Type</th><th>Value</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      $testOutputsWrap.hidden = false;
    } else {
      $testOutputsWrap.hidden = true;
    }

    // Steps — the reason a failing test used to be hard to read
    const ops = result?.operations || [];
    if (ops.length) {
      const rows = ops.map(o => `
        <tr>
          <td>${escapeHtml(String(o.step ?? ""))}</td>
          <td>${escapeHtml(o.name || "—")}</td>
          <td>${o.success === false
                ? '<span class="ed-step-fail">failed</span>'
                : '<span class="ed-step-ok">ok</span>'}</td>
          <td>${escapeHtml(o.error?.message || "")}</td>
        </tr>`).join("");
      $testSteps.innerHTML = `
        <table class="dt-schema-table">
          <thead><tr><th>#</th><th>Step</th><th>Result</th><th>Error</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      $testStepsWrap.hidden = false;
      // A failure is the one time the steps are worth opening unprompted.
      $testStepsWrap.open = failed;
    } else {
      $testStepsWrap.hidden = true;
    }

    $testResult.textContent = JSON.stringify(result, null, 2);
    $testRawWrap.hidden = false;
  }

  $testBtn.addEventListener("click", async () => {
    const id = actionCtl.getValue();
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
      clearTestResults();

      let result;
      if (target === "draft") {
        result = await gc.testDataActionDraft(api, orgId, id, inputs);
      } else {
        result = await gc.testDataAction(api, orgId, id, inputs);
      }

      setProgress(100);
      renderTestResult(result, target);

      // TestExecutionResult carries its own `success` flag: an action that runs
      // and fails still returns HTTP 200. Reporting that as a green success
      // contradicted the failure sitting in the result pane right below.
      if (result?.success === false) {
        setStatus(`Test failed (${target}) — see Outputs and Steps below.`, "error");
      } else {
        setStatus(`✓ Test succeeded (${target}).`, "success");
      }
    } catch (err) {
      clearTestResults();
      $testRawWrap.hidden = false;
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
    const item = allActions.find(a => a.id === actionCtl.getValue());
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
    $refreshBtn.disabled = true;
  }

  function enableActions() {
    $refreshBtn.disabled = false;
    if (actionCtl.getValue() && selectedFull) refreshActionButtons();
  }

  // ── Boot ──────────────────────────────────────────────
  // The org comes from the header picker. Changing it re-renders this whole
  // page (app.js wires orgContext.onChange to router.render), so there is no
  // subscription here and no stale state to clear.
  if (!orgId) {
    $noOrg.hidden = false;
    setStatus(STATUS.noOrg);
  } else {
    $main.hidden = false;
    loadActions();
  }

  return el;
}
