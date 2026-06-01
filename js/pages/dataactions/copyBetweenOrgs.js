/**
 * Data Actions › Copy - Between Orgs
 *
 * Copies a data action (contract + config) from one customer org
 * to another.
 *
 * Flow:
 *   1. User picks source org and destination org
 *   2. Fetch data actions from source org + integrations from dest org
 *   3. User selects a source action → shows contract/config preview
 *   4. User enters new name
 *   5. User selects target integration in dest org (matched by type)
 *   6. Create action in destination org
 *
 * Note: Integration IDs are org-specific — user picks a dest integration.
 * Credentials on the target integration must be configured separately.
 *
 * API endpoints:
 *   GET  /api/v2/integrations/actions            — list data actions
 *   GET  /api/v2/integrations/actions/{id}        — get full action detail
 *   GET  /api/v2/integrations                     — list integrations
 *   POST /api/v2/integrations/actions             — create published action
 *   POST /api/v2/integrations/actions/drafts      — create action as draft
 */
import { escapeHtml } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { logAction } from "../../services/activityLogService.js";
import { createSingleSelect } from "../../components/multiSelect.js";

// ── Status messages ────────────────────────────────────────────────
const STATUS = {
  ready:       "Select source and destination orgs to begin.",
  loading:     "Loading actions and integrations…",
  fetching:    "Fetching full action config…",
  validating:  "Validating name in destination org…",
  creating:    "Creating action in destination org…",
  done:        (name, dest, published) => `✓ Action "${name}" created in ${dest} as ${published ? "published" : "draft"}.`,
  noActions:   "No data actions found in source org.",
  noInteg:     "No compatible integration found in destination org.",
  error:       (msg) => `Error: ${msg}`,
};

// ── Page renderer ──────────────────────────────────────────────────

export default function renderCopyDataActionBetweenOrgs({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const customers = orgContext.getCustomers();

  const orgOptions = `<option value="">Select org…</option>`
    + customers.map(c =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.region)})</option>`
    ).join("");

  el.innerHTML = `
    <h2>Data Actions — Copy between Orgs</h2>

    <p class="page-desc">
      Copy a data action (contract + configuration) from one customer org
      to another. Select a target integration in the destination org.
      The action can be created as published or as a draft.
    </p>

    <div class="dt-controls">
      <!-- Source org -->
      <div class="dt-control-group">
        <label class="dt-label">Source Org</label>
        <select class="dt-select" id="daSrcOrg">${orgOptions}</select>
      </div>

      <!-- Destination org -->
      <div class="dt-control-group">
        <label class="dt-label">Destination Org</label>
        <select class="dt-select" id="daDestOrg">${orgOptions}</select>
      </div>

      <!-- Load button -->
      <div class="dt-actions" style="margin-bottom:12px">
        <button class="btn" id="daLoadBtn" disabled>Load Source Actions</button>
      </div>

      <!-- Source action -->
      <div class="dt-control-group">
        <label class="dt-label">Source Action</label>
        <div id="daSourceSelectMount"></div>
      </div>

      <!-- Source info -->
      <div class="dt-info" id="daSourceInfo" hidden>
        <div class="dt-info-row"><span class="dt-info-key">Category:</span> <span id="daInfoCat">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Integration:</span> <span id="daInfoInteg">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Integration Type:</span> <span id="daInfoType">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Secure:</span> <span id="daInfoSecure">—</span></div>
        <div class="dt-info-row"><span class="dt-info-key">Contract preview:</span></div>
        <div class="dt-schema" id="daContractPreview"></div>
      </div>

      <!-- New name -->
      <div class="dt-control-group">
        <label class="dt-label">New Action Name (in destination)</label>
        <input class="dt-input" id="daNewName" type="text" placeholder="Enter new action name…" disabled />
      </div>

      <!-- Category -->
      <div class="dt-control-group">
        <label class="dt-label">Category</label>
        <input class="dt-input" id="daCategory" type="text" placeholder="Category…" disabled />
      </div>

      <!-- Target integration -->
      <div class="dt-control-group">
        <label class="dt-label">Integration (in destination)</label>
        <select class="dt-select" id="daIntegration" disabled>
          <option value="">Load actions first…</option>
        </select>
      </div>

      <!-- Publish toggle -->
      <div class="dt-control-group dt-toggle-row">
        <label class="dt-label">Publish immediately</label>
        <label class="dt-toggle">
          <input type="checkbox" id="daPublish" disabled />
          <span class="dt-toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- Actions -->
    <div class="dt-actions">
      <button class="btn" id="daCopyBtn" disabled>Copy Action</button>
    </div>

    <!-- Progress -->
    <div class="dt-progress-wrap" id="daProgress" hidden>
      <div class="dt-progress-bar" id="daProgressBar"></div>
    </div>

    <!-- Status -->
    <div class="dt-status" id="daStatus">${STATUS.ready}</div>
  `;

  // ── DOM refs ─────────────────────────────────────────
  const $srcOrg        = el.querySelector("#daSrcOrg");
  const $destOrg       = el.querySelector("#daDestOrg");
  const $loadBtn       = el.querySelector("#daLoadBtn");
  const $sourceSelectMount = el.querySelector("#daSourceSelectMount");
  const $sourceInfo    = el.querySelector("#daSourceInfo");

  // Searchable single-select for source action
  const sourceCtl = createSingleSelect({
    placeholder: "Select an action…",
    searchable:  true,
    onChange:    (id) => handleSourceChange(id),
  });
  sourceCtl.setEnabled(false);
  $sourceSelectMount.append(sourceCtl.el);
  const $infoCat       = el.querySelector("#daInfoCat");
  const $infoInteg     = el.querySelector("#daInfoInteg");
  const $infoType      = el.querySelector("#daInfoType");
  const $infoSecure    = el.querySelector("#daInfoSecure");
  const $contractPrev  = el.querySelector("#daContractPreview");
  const $newName       = el.querySelector("#daNewName");
  const $category      = el.querySelector("#daCategory");
  const $integration   = el.querySelector("#daIntegration");
  const $publish       = el.querySelector("#daPublish");
  const $copyBtn       = el.querySelector("#daCopyBtn");
  const $progress      = el.querySelector("#daProgress");
  const $progressBar   = el.querySelector("#daProgressBar");
  const $status        = el.querySelector("#daStatus");

  let actions = [];         // source actions (summary)
  let destActions = [];     // dest action names (uniqueness)
  let destIntegrations = []; // dest integrations
  let srcIntegrations = [];  // source integrations (to resolve names/types)

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

  /** Extract properties from a JSON schema, handling nested structures. */
  function extractSchemaProps(schema) {
    if (!schema) return null;
    // Direct properties
    if (schema.properties && Object.keys(schema.properties).length) {
      return schema.properties;
    }
    // Nested under items (array wrapper)
    if (schema.items?.properties && Object.keys(schema.items.properties).length) {
      return schema.items.properties;
    }
    return null;
  }

  /** Build a table preview of input/output contract schemas. */
  function buildContractPreview(contract) {
    if (!contract) return "<em>No contract</em>";
    const sections = [];

    // Input schema
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

    // Output (success) schema
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

  /** Find integration name by ID in a list. */
  function integName(list, id) {
    const integ = list.find(i => i.id === id);
    return integ?.name || id;
  }

  /** Find integration type by ID in a list. */
  function integType(list, id) {
    const integ = list.find(i => i.id === id);
    return integ?.integrationType?.id || "unknown";
  }

  // ── Org selection logic ──────────────────────────────
  function updateLoadBtn() {
    $loadBtn.disabled = !$srcOrg.value || !$destOrg.value || $srcOrg.value === $destOrg.value;
  }

  $srcOrg.addEventListener("change", () => {
    updateLoadBtn();
    resetSelection();
  });
  $destOrg.addEventListener("change", () => {
    updateLoadBtn();
  });

  function resetSelection() {
    actions = [];
    sourceCtl.setItems([]);
    sourceCtl.setEnabled(false);
    $sourceInfo.hidden = true;
    $newName.disabled = true;
    $newName.value = "";
    $category.disabled = true;
    $category.value = "";
    $integration.innerHTML = `<option value="">Load actions first…</option>`;
    $integration.disabled = true;
    $publish.checked = false;
    $publish.disabled = true;
    $copyBtn.disabled = true;
  }

  // ── Load actions ─────────────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const srcOrgId = $srcOrg.value;
    const destOrgId = $destOrg.value;
    if (!srcOrgId || !destOrgId || srcOrgId === destOrgId) return;

    try {
      setStatus(STATUS.loading);
      $loadBtn.disabled = true;
      sourceCtl.setEnabled(false);

      // Fetch source actions, source integrations, dest actions, dest integrations in parallel
      const [srcActions, srcIntegs, destActs, destIntegs] = await Promise.all([
        gc.fetchAllDataActions(api, srcOrgId, { query: { includeAuthActions: "false" } }),
        gc.fetchAllIntegrations(api, srcOrgId, { pageSize: 200 }),
        gc.fetchAllDataActions(api, destOrgId, { query: { includeAuthActions: "false" } }),
        gc.fetchAllIntegrations(api, destOrgId, { pageSize: 200 }),
      ]);

      srcIntegrations = srcIntegs;
      destIntegrations = destIntegs;
      destActions = destActs.map(a => a.name.toLowerCase());

      actions = srcActions.map(a => ({
        id: a.id,
        name: a.name,
        category: a.category || "",
        integrationId: a.integrationId || "",
        secure: a.secure || false,
      }));

      actions.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      if (!actions.length) {
        sourceCtl.setItems([]);
        sourceCtl.setEnabled(false);
        setStatus(STATUS.noActions);
        $loadBtn.disabled = false;
        return;
      }

      sourceCtl.setItems(actions.map(a => ({
        id:    a.id,
        label: a.name + (a.category ? `  [${a.category}]` : ""),
      })));
      sourceCtl.setEnabled(true);
      $newName.disabled = false;
      $category.disabled = false;
      $publish.disabled = false;
      $loadBtn.disabled = false;
      setStatus("Actions loaded. Select a source action.");
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
      $loadBtn.disabled = false;
    }
  });

  // ── Source action selection ──────────────────────────
  async function handleSourceChange(id) {
    const a = actions.find(x => x.id === id);
    if (!a) {
      $sourceInfo.hidden = true;
      $copyBtn.disabled = true;
      $integration.innerHTML = `<option value="">Select an action first…</option>`;
      $integration.disabled = true;
      return;
    }

    // Show basic info immediately
    const srcType = integType(srcIntegrations, a.integrationId);
    $infoCat.textContent = a.category || "—";
    $infoInteg.textContent = integName(srcIntegrations, a.integrationId);
    $infoType.textContent = srcType;
    $infoSecure.textContent = a.secure ? "Yes" : "No";
    $newName.value = a.name;
    $category.value = a.category;
    $sourceInfo.hidden = false;

    // Populate target integration dropdown — filter dest integrations to matching type
    const compatible = destIntegrations.filter(i =>
      (i.integrationType?.id || "") === srcType
    );

    if (!compatible.length) {
      $integration.innerHTML = `<option value="">No compatible integration (${escapeHtml(srcType)})</option>`;
      $integration.disabled = true;
      $contractPrev.innerHTML = "";
      setStatus(STATUS.noInteg, "error");
      $copyBtn.disabled = true;
      return;
    }

    $integration.innerHTML = compatible.map(i =>
      `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`
    ).join("");
    $integration.disabled = false;

    // Fetch full action detail (contract + config)
    try {
      setStatus(STATUS.fetching);
      const full = await gc.getDataAction(api, $srcOrg.value, id);
      // Genesys returns templates as file references (requestTemplateUri /
      // successTemplateUri) rather than inline strings. Fetch the actual
      // template content from those URIs and inline them so the copy
      // posts real templates instead of Genesys defaulting to
      // "${input.rawRequest}" / "${rawResult}".
      await inlineActionTemplates(api, $srcOrg.value, full);
      // Store the full detail on the action object for later use
      a._full = full;
      $contractPrev.innerHTML = buildContractPreview(full.contract);
      $copyBtn.disabled = false;
      setStatus("Action loaded. Configure and copy.");
    } catch (err) {
      $contractPrev.innerHTML = `<em>Failed to load contract: ${escapeHtml(err.message)}</em>`;
      setStatus(STATUS.error(err.message), "error");
      $copyBtn.disabled = true;
    }
  }

  /**
   * For data actions whose templates are stored as .vm files, the
   * action GET returns only a {requestTemplate,successTemplate}Uri.
   * Resolve those URIs to their actual content and write it back as
   * the inline template string, removing the URI so POST doesn't see
   * a stale reference to the source org's template file.
   */
  async function inlineActionTemplates(api, orgId, full) {
    const req  = full?.config?.request;
    const resp = full?.config?.response;

    async function fetchTemplate(uri) {
      if (!uri) return null;
      try {
        const r = await api.proxyGenesys(orgId, "GET", uri);
        // Templates are .vm text; the proxy wraps non-JSON as { raw }.
        if (typeof r === "string") return r;
        if (r && typeof r.raw === "string") return r.raw;
        return null;
      } catch (e) {
        console.warn("[copyBetweenOrgs] failed to fetch template", uri, e);
        return null;
      }
    }

    if (req?.requestTemplateUri && !req.requestTemplate) {
      const content = await fetchTemplate(req.requestTemplateUri);
      if (content !== null) req.requestTemplate = content;
      delete req.requestTemplateUri;
    }
    if (resp?.successTemplateUri && !resp.successTemplate) {
      const content = await fetchTemplate(resp.successTemplateUri);
      if (content !== null) resp.successTemplate = content;
      delete resp.successTemplateUri;
    }
  }

  // ── Copy action ──────────────────────────────────────
  $copyBtn.addEventListener("click", async () => {
    const srcOrgId  = $srcOrg.value;
    const destOrgId = $destOrg.value;
    if (!srcOrgId || !destOrgId) return;

    const sourceId = sourceCtl.getValue();
    const source = actions.find(x => x.id === sourceId);
    if (!source || !source._full) return;

    const newName = $newName.value.trim();
    if (!newName) {
      setStatus("Please enter a new action name.", "error");
      return;
    }

    const targetIntegId = $integration.value;
    if (!targetIntegId) {
      setStatus("Please select a target integration.", "error");
      return;
    }

    const categoryVal = $category.value.trim();

    // Disable all controls
    $srcOrg.disabled = true;
    $destOrg.disabled = true;
    $loadBtn.disabled = true;
    sourceCtl.setEnabled(false);
    $newName.disabled = true;
    $category.disabled = true;
    $integration.disabled = true;
    $publish.disabled = true;
    $copyBtn.disabled = true;

    try {
      // 1. Validate name uniqueness in destination
      setStatus(STATUS.validating);
      setProgress(15);

      const destRaw = await gc.fetchAllDataActions(api, destOrgId, {
        query: { includeAuthActions: "false" },
      });
      const destNames = destRaw.map(a => a.name.toLowerCase());
      if (destNames.includes(newName.toLowerCase())) {
        const destName = customers.find(c => c.id === destOrgId)?.name ?? destOrgId;
        setStatus(`An action named "${newName}" already exists in ${destName}.`, "error");
        enableControls();
        return;
      }

      // 2. Build the create body from the full source action.
      //    Pass full.config through unchanged so every nested field
      //    (requestTemplate, headers, translationMap, successTemplate,
      //    successTemplateUri, etc.) is preserved exactly as returned
      //    by the source GET.
      setStatus(STATUS.creating);
      setProgress(40);

      const full = source._full;
      const body = {
        name: newName,
        category: categoryVal || full.category || "",
        integrationId: targetIntegId,
        secure: full.secure || false,
        contract: full.contract,
        config: full.config,
      };

      // 3. Create action in destination (draft or published)
      setProgress(70);
      const usePublish = $publish.checked;
      if (usePublish) {
        await gc.createDataAction(api, destOrgId, body);
      } else {
        // Genesys quirk: POST /integrations/actions/drafts does not
        // persist config.request.requestTemplate (and sometimes other
        // config/response fields) on creation — it falls back to the
        // default "${input.rawRequest}". Follow up with a PATCH on the
        // draft including ALL required UpdateDraftInput fields
        // (name, category, integrationId, version, contract, config)
        // so the full configuration is written.
        const created = await gc.createDataActionDraft(api, destOrgId, body);
        if (created?.id) {
          // Re-fetch to get the authoritative version.
          let currentVersion = created.version || 1;
          try {
            const draft = await gc.getDataActionDraft(api, destOrgId, created.id);
            if (draft?.version) currentVersion = draft.version;
          } catch (_) { /* fall back to created.version */ }

          try {
            const patchBody = {
              name:          body.name,
              category:      body.category,
              integrationId: body.integrationId,
              secure:        body.secure,
              version:       currentVersion,
              contract:      body.contract,
              config:        body.config,
            };
            await gc.patchDataActionDraft(api, destOrgId, created.id, patchBody);
          } catch (patchErr) {
            // Surface, but don't undo the draft creation
            setStatus(STATUS.error(`Draft created but config update failed: ${patchErr.message}`), "error");
            return;
          }
        }
      }
      setProgress(100);

      const destName = customers.find(c => c.id === destOrgId)?.name ?? destOrgId;
      setStatus(STATUS.done(newName, destName, usePublish), "success");
      logAction({
        me,
        orgId:       $srcOrg.value,
        action:      "dataaction_copy",
        description: `Copied data action '${source.name}' to '${newName}' in ${destName} (${usePublish ? "published" : "draft"})`,
      });
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
    if (actions.length) {
      sourceCtl.setEnabled(true);
      $newName.disabled = false;
      $category.disabled = false;
      $publish.disabled = false;
    }
    if ($integration.querySelector("option[value]")?.value) {
      $integration.disabled = false;
    }
    $copyBtn.disabled = !sourceCtl.getValue();
  }

  return el;
}
