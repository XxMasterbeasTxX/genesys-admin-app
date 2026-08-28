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
import { escapeHtml, makeStatus } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { logAction } from "../../services/activityLogService.js";
import { createSingleSelect } from "../../components/multiSelect.js";
import { stripOrgSpecificUris } from "../../lib/dataActions.js";
import { contractPreviewHtml } from "../../lib/dataActionTest.js";

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
  tplFailed:   (fields) =>
    `Could not read the ${fields.join(" and ")} from the source org. `
    + "Copying now would leave the destination action with the Genesys default "
    + "template instead of the real one — reload the action before copying.",
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

  let actions = [];          // source actions (summary)
  let destIntegrations = [];  // dest integrations
  let srcIntegrations = [];   // source integrations (to resolve names/types)
  // Monotonic token so a slow detail fetch for an action the user has already
  // navigated away from cannot overwrite the newer selection.
  let selectionSeq = 0;

  // ── Helpers ──────────────────────────────────────────
  const setStatus = makeStatus($status, "dt-status");

  function setProgress(pct) {
    $progress.hidden = false;
    $progressBar.style.width = `${pct}%`;
  }

  function hideProgress() {
    $progress.hidden = true;
    $progressBar.style.width = "0%";
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
  // Both org pickers reset the selection. The destination matters as much as
  // the source: the integration dropdown is populated from the destination org's
  // integrations, and an id from the previously selected org would be posted to
  // an org that has never heard of it.
  $destOrg.addEventListener("change", () => {
    updateLoadBtn();
    if (actions.length) {
      resetSelection();
      setStatus("Destination changed — load the source actions again.");
    } else {
      resetSelection();
    }
  });

  function resetSelection() {
    selectionSeq++;   // abandon any detail fetch still in flight
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

      // Source actions plus both integration lists. The destination action list
      // is deliberately not fetched here — the uniqueness check runs against a
      // fresh list at copy time, so a load-time copy would be a second full
      // paginated walk of the destination org that nothing could trust anyway.
      const [srcActions, srcIntegs, destIntegs] = await Promise.all([
        gc.fetchAllDataActions(api, srcOrgId, { query: { includeAuthActions: "false" } }),
        gc.fetchAllIntegrations(api, srcOrgId, { pageSize: 200 }),
        gc.fetchAllIntegrations(api, destOrgId, { pageSize: 200 }),
      ]);

      srcIntegrations = srcIntegs;
      destIntegrations = destIntegs;

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
    const seq = ++selectionSeq;
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

    // Fetch full action detail (contract + config). `getDataAction` resolves
    // any .vm template references to their text, so `full` always carries the
    // real templates rather than a URI the destination org cannot follow.
    try {
      setStatus(STATUS.fetching);
      const full = await gc.getDataAction(api, $srcOrg.value, id);
      if (seq !== selectionSeq) return;   // superseded by a newer selection

      // Store the full detail on the action object for later use
      a._full = full;
      $contractPrev.innerHTML = contractPreviewHtml(full.contract);

      // A template that could not be read is a silent-corruption risk: copying
      // would hand the destination Genesys's default "${input.rawRequest}"
      // while reporting success. Block the copy and say so.
      if (full.templateFetchFailures) {
        $copyBtn.disabled = true;
        setStatus(STATUS.tplFailed(full.templateFetchFailures), "error");
        return;
      }

      $copyBtn.disabled = false;
      setStatus("Action loaded. Configure and copy.");
    } catch (err) {
      if (seq !== selectionSeq) return;
      $contractPrev.innerHTML = `<em>Failed to load contract: ${escapeHtml(err.message)}</em>`;
      setStatus(STATUS.error(err.message), "error");
      $copyBtn.disabled = true;
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
    if (source._full.templateFetchFailures) {
      setStatus(STATUS.tplFailed(source._full.templateFetchFailures), "error");
      return;
    }

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
      //    Every nested field (requestTemplate, headers, translationMap,
      //    successTemplate, timeoutSeconds) is preserved as returned by the
      //    source GET, minus the *Uri / *Flattened fields: those name files
      //    belonging to the SOURCE action in the SOURCE org and mean nothing
      //    in the destination.
      setStatus(STATUS.creating);
      setProgress(40);

      const full = source._full;
      const body = {
        name: newName,
        category: categoryVal || full.category || "",
        integrationId: targetIntegId,
        secure: full.secure || false,
        contract: stripOrgSpecificUris(full.contract),
        config: stripOrgSpecificUris(full.config),
      };

      // 3. Create action in destination (draft or published)
      setProgress(70);
      const usePublish = $publish.checked;
      if (usePublish) {
        try {
          await gc.createDataAction(api, destOrgId, body);
        } catch (pubErr) {
          // POST /integrations/actions is explicitly unsupported for Function
          // Integration actions — those must be created as a draft so the ZIP
          // package can be uploaded before publishing. Genesys's own message
          // does not say what to do about it, so say it here.
          throw new Error(
            `${pubErr.message} — if this is a Function Integration action, turn `
            + `"Publish immediately" off: those can only be created as drafts.`
          );
        }
      } else {
        // Genesys quirk: POST /integrations/actions/drafts does not
        // persist config.request.requestTemplate (and sometimes other
        // config/response fields) on creation — it falls back to the
        // default "${input.rawRequest}". Follow up with a PATCH on the
        // draft that restates the whole configuration.
        //
        // UpdateDraftInput accepts name, category, secure, contract, config
        // and version, and requires only `version`. It has no integrationId —
        // a draft cannot be moved between integrations — so the integration is
        // fixed by the POST above and not repeated here.
        const created = await gc.createDataActionDraft(api, destOrgId, body);
        if (created?.id) {
          // Re-fetch to get the authoritative version.
          let currentVersion = created.version || 1;
          try {
            const draft = await gc.getDataActionDraft(api, destOrgId, created.id,
              { inlineTemplates: false });
            if (draft?.version) currentVersion = draft.version;
          } catch (_) { /* fall back to created.version */ }

          try {
            const patchBody = {
              name:     body.name,
              category: body.category,
              secure:   body.secure,
              version:  currentVersion,
              contract: body.contract,
              config:   body.config,
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
