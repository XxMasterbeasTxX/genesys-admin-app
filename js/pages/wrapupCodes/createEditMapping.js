import { escapeHtml } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { logAction } from "../../services/activityLogService.js";

const FLAG = {
  CONTACT_UNCALLABLE: "CONTACT_UNCALLABLE",
  NUMBER_UNCALLABLE: "NUMBER_UNCALLABLE",
  RIGHT_PARTY_CONTACT: "RIGHT_PARTY_CONTACT",
  BUSINESS_FAILURE: "BUSINESS_FAILURE",
  BUSINESS_NEUTRAL: "BUSINESS_NEUTRAL",
  BUSINESS_SUCCESS: "BUSINESS_SUCCESS",
};

const BUSINESS_FLAGS = [FLAG.BUSINESS_FAILURE, FLAG.BUSINESS_NEUTRAL, FLAG.BUSINESS_SUCCESS];

export default function renderWrapupCodesCreateEditMapping({ me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h2>Wrapup Codes - Create/Edit/Mapping</h2>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  let wrapups = [];
  let divisionsById = new Map();
  let mappingDoc = null;
  let rowDrafts = new Map();
  let expandedRowId = null;

  let canViewMapping = true;
  let canEditMapping = true;
  let loading = false;

  let searchQuery = "";

  const modalState = {
    open: false,
    mode: "create",
    item: null,
    saving: false,
  };

  el.innerHTML = `
    <style>
      .wcm-toolbar { display:flex; gap:10px; align-items:flex-end; justify-content:space-between; flex-wrap:wrap; margin-bottom:12px; }
      .wcm-toolbar-left { display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; flex:1; }
      .wcm-search-group { min-width:260px; max-width:460px; flex:1; }

      .wcm-status { margin:8px 0 12px; font-size:13px; min-height:18px; color:var(--muted); }
      .wcm-status--error { color:#f87171; }
      .wcm-status--success { color:#34d399; }

      .wcm-table-wrap { overflow:auto; border:1px solid var(--border); border-radius:10px; }
      .wcm-table { width:100%; border-collapse:collapse; min-width:980px; }
      .wcm-table th, .wcm-table td { border-bottom:1px solid var(--border); padding:8px 10px; text-align:left; vertical-align:top; }
      .wcm-table th { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
      .wcm-table tbody tr:hover { background:rgba(255,255,255,.02); }
      .wcm-empty { text-align:center; color:var(--muted); padding:16px 8px; }
      .wcm-row-expand { width:34px; text-align:center; }
      .wcm-row-expand button { border:1px solid var(--border); background:transparent; color:var(--text); border-radius:6px; width:24px; height:24px; cursor:pointer; }
      .wcm-row-expand button:disabled { opacity:.45; cursor:not-allowed; }

      .wcm-chip-wrap { display:flex; flex-wrap:wrap; gap:4px; }
      .wcm-chip { border:1px solid var(--border); border-radius:999px; padding:2px 8px; font-size:11px; color:var(--muted); }
      .wcm-chip--default { color:#fbbf24; border-color:#f59e0b; }

      .wcm-editor-row td { background:rgba(255,255,255,.02); }
      .wcm-editor { border:1px solid var(--border); border-radius:10px; padding:12px; background:rgba(0,0,0,.14); }
      .wcm-editor-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; margin-bottom:10px; }
      .wcm-toggle { display:flex; align-items:center; justify-content:space-between; gap:8px; border:1px solid var(--border); border-radius:8px; padding:8px 10px; }
      .wcm-toggle input { width:18px; height:18px; }
      .wcm-seg { display:flex; border:1px solid var(--border); border-radius:9px; overflow:hidden; width:fit-content; }
      .wcm-seg button { border:none; border-right:1px solid var(--border); padding:7px 12px; background:transparent; color:var(--muted); cursor:pointer; }
      .wcm-seg button:last-child { border-right:none; }
      .wcm-seg button.active { background:rgba(59,130,246,.2); color:#93c5fd; }
      .wcm-editor-actions { display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
      .wcm-editor-msg { min-height:18px; font-size:12px; margin:4px 0 8px; }
      .wcm-editor-msg.error { color:#f87171; }
      .wcm-editor-msg.success { color:#34d399; }

      .wcm-modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:5000; display:none; align-items:center; justify-content:center; }
      .wcm-modal-backdrop.open { display:flex; }
      .wcm-modal { width:min(640px, calc(100vw - 24px)); background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:14px; }
      .wcm-modal h3 { margin:0 0 10px; }
      .wcm-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      .wcm-form-grid .full { grid-column:1 / -1; }
      .wcm-modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }
      .wcm-muted { color:var(--muted); font-size:12px; }

      @media (max-width: 720px) {
        .wcm-form-grid { grid-template-columns:1fr; }
      }
    </style>

    <h2>Wrapup Codes - Create/Edit/Mapping</h2>
    <p class="page-desc">
      Create and edit wrapup codes, and maintain outbound mapping flags per wrapup code.
      Mapping rows use the org-wide outbound default set when no explicit mapping exists.
    </p>

    <div class="wcm-toolbar">
      <div class="wcm-toolbar-left">
        <div class="dt-control-group wcm-search-group">
          <label class="dt-label" for="wcmSearch">Search</label>
          <input class="dt-input" id="wcmSearch" type="text" placeholder="Search by name, id, description, division..." autocomplete="off">
        </div>
      </div>
      <div class="dt-actions" style="margin:0">
        <button class="btn" id="wcmCreateBtn">+ Create Wrapup Code</button>
      </div>
    </div>

    <div class="wcm-status" id="wcmStatus">Loading wrapup codes...</div>

    <div class="wcm-table-wrap">
      <table class="wcm-table">
        <thead>
          <tr>
            <th style="width:40px"></th>
            <th>Name</th>
            <th>Id</th>
            <th>Description</th>
            <th>Division</th>
            <th>Mapping</th>
            <th style="width:90px"></th>
          </tr>
        </thead>
        <tbody id="wcmTbody">
          <tr><td class="wcm-empty" colspan="7">Loading...</td></tr>
        </tbody>
      </table>
    </div>

    <div class="wcm-modal-backdrop" id="wcmModalBackdrop" aria-hidden="true">
      <div class="wcm-modal">
        <h3 id="wcmModalTitle">Create Wrapup Code</h3>
        <div class="wcm-form-grid">
          <div class="dt-control-group full">
            <label class="dt-label" for="wcmName">Name <span style="color:#f87171">*</span></label>
            <input class="dt-input" id="wcmName" type="text" autocomplete="off">
          </div>
          <div class="dt-control-group full">
            <label class="dt-label" for="wcmDescription">Description</label>
            <input class="dt-input" id="wcmDescription" type="text" autocomplete="off">
          </div>
          <div class="dt-control-group full">
            <label class="dt-label" for="wcmDivision">Division</label>
            <select class="dt-select" id="wcmDivision"></select>
            <span class="wcm-muted">Optional. Leave blank to keep it unassigned.</span>
          </div>
        </div>
        <div class="wcm-editor-msg" id="wcmModalMsg"></div>
        <div class="wcm-modal-actions">
          <button class="btn btn-secondary" id="wcmCancelBtn">Cancel</button>
          <button class="btn" id="wcmSaveBtn">Save</button>
        </div>
      </div>
    </div>
  `;

  const $search = el.querySelector("#wcmSearch");
  const $createBtn = el.querySelector("#wcmCreateBtn");
  const $tbody = el.querySelector("#wcmTbody");
  const $status = el.querySelector("#wcmStatus");

  const $modalBackdrop = el.querySelector("#wcmModalBackdrop");
  const $modalTitle = el.querySelector("#wcmModalTitle");
  const $modalName = el.querySelector("#wcmName");
  const $modalDescription = el.querySelector("#wcmDescription");
  const $modalDivision = el.querySelector("#wcmDivision");
  const $modalMsg = el.querySelector("#wcmModalMsg");
  const $modalCancel = el.querySelector("#wcmCancelBtn");
  const $modalSave = el.querySelector("#wcmSaveBtn");

  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "wcm-status" + (type ? ` wcm-status--${type}` : "");
  }

  function setModalMsg(msg, type = "") {
    $modalMsg.textContent = msg || "";
    $modalMsg.className = "wcm-editor-msg" + (type ? ` ${type}` : "");
  }

  function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }

  function currentBusinessCategory(flags) {
    if (flags.has(FLAG.BUSINESS_FAILURE)) return "failure";
    if (flags.has(FLAG.BUSINESS_NEUTRAL)) return "neutral";
    if (flags.has(FLAG.BUSINESS_SUCCESS)) return "success";
    return "none";
  }

  function validateFlags(flags) {
    const errors = [];
    const selectedBusiness = BUSINESS_FLAGS.filter((f) => flags.has(f));
    if (selectedBusiness.length > 1) {
      errors.push("Business categories are mutually exclusive.");
    }
    if (selectedBusiness.length > 0 && !flags.has(FLAG.RIGHT_PARTY_CONTACT)) {
      errors.push("Business category requires Right Party Contact.");
    }
    return errors;
  }

  function normalizeFlags(flags) {
    return Array.from(new Set(flags || [])).sort();
  }

  function normalizeId(id) {
    return String(id || "").trim().toLowerCase();
  }

  function findMappingKeyForWrapup(wrapupId) {
    const mapping = mappingDoc?.mapping;
    if (!mapping) return null;

    const target = normalizeId(wrapupId);
    if (!target) return null;

    for (const key of Object.keys(mapping)) {
      if (normalizeId(key) === target) return key;
    }
    return null;
  }

  function getDivisionName(w) {
    const divisionObj = w.division;
    if (divisionObj?.name) return divisionObj.name;
    if (divisionObj?.id && divisionsById.has(divisionObj.id)) return divisionsById.get(divisionObj.id).name;
    return "—";
  }

  function getEffectiveFlags(wrapupId) {
    if (!mappingDoc) return new Set();
    const mappingKey = findMappingKeyForWrapup(wrapupId);
    if (mappingKey) return new Set(normalizeFlags(mappingDoc.mapping[mappingKey]));
    return new Set(normalizeFlags(mappingDoc.defaultSet || []));
  }

  function isExplicitMapping(wrapupId) {
    return Boolean(findMappingKeyForWrapup(wrapupId));
  }

  function createDraft(wrapupId) {
    const effective = getEffectiveFlags(wrapupId);
    return {
      wrapupId,
      source: isExplicitMapping(wrapupId) ? "explicit" : "default",
      initialFlags: new Set(effective),
      localFlags: new Set(effective),
      dirty: false,
      saving: false,
      errors: [],
      error: null,
      success: null,
      useDefaultPending: false,
    };
  }

  function ensureDraft(wrapupId) {
    if (!rowDrafts.has(wrapupId)) {
      rowDrafts.set(wrapupId, createDraft(wrapupId));
    }
    return rowDrafts.get(wrapupId);
  }

  function recalcDraftState(draft) {
    draft.errors = validateFlags(draft.localFlags);
    const baseDirty = !setsEqual(draft.localFlags, draft.initialFlags);
    draft.dirty = draft.useDefaultPending ? draft.source === "explicit" : baseDirty;
  }

  function mappingSummaryHtml(wrapupId) {
    if (!canViewMapping) return `<span class="wcm-muted">No access</span>`;
    if (!mappingDoc) return `<span class="wcm-muted">Unavailable</span>`;

    const flags = getEffectiveFlags(wrapupId);
    const chips = [];
    if (flags.has(FLAG.CONTACT_UNCALLABLE)) chips.push('<span class="wcm-chip">CU</span>');
    if (flags.has(FLAG.NUMBER_UNCALLABLE)) chips.push('<span class="wcm-chip">NU</span>');
    if (flags.has(FLAG.RIGHT_PARTY_CONTACT)) chips.push('<span class="wcm-chip">RPC</span>');

    const category = currentBusinessCategory(flags);
    if (category !== "none") {
      chips.push(`<span class="wcm-chip">BC: ${escapeHtml(category.charAt(0).toUpperCase() + category.slice(1))}</span>`);
    }

    if (chips.length === 0) chips.push('<span class="wcm-chip">None</span>');
    if (!isExplicitMapping(wrapupId)) chips.push('<span class="wcm-chip wcm-chip--default">Default</span>');

    return `<div class="wcm-chip-wrap">${chips.join("")}</div>`;
  }

  function getFilteredRows() {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return wrapups;

    return wrapups.filter((w) => {
      const divName = getDivisionName(w).toLowerCase();
      return [
        w.name || "",
        w.id || "",
        w.description || "",
        divName,
      ].some((v) => String(v).toLowerCase().includes(q));
    });
  }

  function editorHtml(wrapupId) {
    if (!canViewMapping) {
      return `<div class="wcm-editor-msg error">You do not have access to view outbound wrapup mapping.</div>`;
    }
    if (!mappingDoc) {
      return `<div class="wcm-editor-msg error">Mapping document is unavailable.</div>`;
    }

    const draft = ensureDraft(wrapupId);
    const readOnly = !canEditMapping;
    const category = currentBusinessCategory(draft.localFlags);
    const errorMsg = draft.error || draft.errors[0] || "";

    return `
      <div class="wcm-editor">
        <div class="wcm-editor-grid">
          <label class="wcm-toggle">
            <span>Contact Uncallable</span>
            <input type="checkbox" data-action="toggle-flag" data-wrapup-id="${escapeHtml(wrapupId)}" data-flag="${FLAG.CONTACT_UNCALLABLE}" ${draft.localFlags.has(FLAG.CONTACT_UNCALLABLE) ? "checked" : ""} ${readOnly ? "disabled" : ""}>
          </label>

          <label class="wcm-toggle">
            <span>Number Uncallable</span>
            <input type="checkbox" data-action="toggle-flag" data-wrapup-id="${escapeHtml(wrapupId)}" data-flag="${FLAG.NUMBER_UNCALLABLE}" ${draft.localFlags.has(FLAG.NUMBER_UNCALLABLE) ? "checked" : ""} ${readOnly ? "disabled" : ""}>
          </label>

          <label class="wcm-toggle">
            <span>Right Party Contact</span>
            <input type="checkbox" data-action="toggle-flag" data-wrapup-id="${escapeHtml(wrapupId)}" data-flag="${FLAG.RIGHT_PARTY_CONTACT}" ${draft.localFlags.has(FLAG.RIGHT_PARTY_CONTACT) ? "checked" : ""} ${readOnly ? "disabled" : ""}>
          </label>

          <div>
            <div class="dt-label" style="margin-bottom:4px">Business Category</div>
            <div class="wcm-seg">
              <button type="button" data-action="set-category" data-wrapup-id="${escapeHtml(wrapupId)}" data-category="none" class="${category === "none" ? "active" : ""}" ${readOnly ? "disabled" : ""}>None</button>
              <button type="button" data-action="set-category" data-wrapup-id="${escapeHtml(wrapupId)}" data-category="failure" class="${category === "failure" ? "active" : ""}" ${readOnly ? "disabled" : ""}>Failure</button>
              <button type="button" data-action="set-category" data-wrapup-id="${escapeHtml(wrapupId)}" data-category="neutral" class="${category === "neutral" ? "active" : ""}" ${readOnly ? "disabled" : ""}>Neutral</button>
              <button type="button" data-action="set-category" data-wrapup-id="${escapeHtml(wrapupId)}" data-category="success" class="${category === "success" ? "active" : ""}" ${readOnly ? "disabled" : ""}>Success</button>
            </div>
          </div>
        </div>

        <div class="wcm-editor-msg ${errorMsg ? "error" : draft.success ? "success" : ""}">
          ${escapeHtml(errorMsg || draft.success || "")}
        </div>

        <div class="wcm-editor-actions">
          <button class="btn btn-secondary" data-action="use-default" data-wrapup-id="${escapeHtml(wrapupId)}" ${readOnly || draft.saving ? "disabled" : ""}>Use Default</button>
          <button class="btn btn-secondary" data-action="cancel-row" data-wrapup-id="${escapeHtml(wrapupId)}" ${draft.saving ? "disabled" : ""}>Cancel</button>
          <button class="btn" data-action="save-row" data-wrapup-id="${escapeHtml(wrapupId)}" ${readOnly || draft.saving || !draft.dirty || draft.errors.length > 0 ? "disabled" : ""}>${draft.saving ? "Saving..." : "Save Mapping"}</button>
        </div>
      </div>
    `;
  }

  function renderTable() {
    const rows = getFilteredRows();
    if (!rows.length) {
      $tbody.innerHTML = `<tr><td class="wcm-empty" colspan="7">No wrapup codes found for the current filter.</td></tr>`;
      return;
    }

    $tbody.innerHTML = rows.map((w) => {
      const isExpanded = expandedRowId === w.id;
      const expandBtn = canViewMapping
        ? `<button type="button" data-action="toggle-expand" data-wrapup-id="${escapeHtml(w.id)}">${isExpanded ? "-" : "+"}</button>`
        : `<button type="button" disabled title="No mapping access">-</button>`;

      const editorRow = isExpanded
        ? `<tr class="wcm-editor-row"><td colspan="7">${editorHtml(w.id)}</td></tr>`
        : "";

      return `
        <tr>
          <td class="wcm-row-expand">${expandBtn}</td>
          <td>${escapeHtml(w.name || "—")}</td>
          <td>${escapeHtml(w.id || "—")}</td>
          <td>${escapeHtml(w.description || "—")}</td>
          <td>${escapeHtml(getDivisionName(w))}</td>
          <td>${mappingSummaryHtml(w.id)}</td>
          <td><button class="btn btn-secondary btn-sm" data-action="edit-wrapup" data-wrapup-id="${escapeHtml(w.id)}">Edit</button></td>
        </tr>
        ${editorRow}
      `;
    }).join("");
  }

  function populateDivisionSelect() {
    const options = [...divisionsById.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`)
      .join("");
    $modalDivision.innerHTML = `<option value="">(No division)</option>${options}`;
  }

  function openModal(mode, item = null) {
    modalState.open = true;
    modalState.mode = mode;
    modalState.item = item;
    modalState.saving = false;

    $modalTitle.textContent = mode === "create" ? "Create Wrapup Code" : "Edit Wrapup Code";
    $modalName.value = item?.name || "";
    $modalDescription.value = item?.description || "";
    $modalDivision.value = item?.division?.id || "";
    setModalMsg("");

    $modalBackdrop.classList.add("open");
  }

  function closeModal() {
    modalState.open = false;
    modalState.mode = "create";
    modalState.item = null;
    modalState.saving = false;
    $modalBackdrop.classList.remove("open");
  }

  async function loadWrapupsAndDivisions() {
    const [loadedWrapups, loadedDivisions] = await Promise.all([
      gc.fetchAllWrapupCodes(api, org.id),
      gc.fetchAllDivisions(api, org.id),
    ]);

    wrapups = loadedWrapups
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    divisionsById = new Map(loadedDivisions.map((d) => [d.id, d]));
  }

  async function loadMappingDocument() {
    try {
      mappingDoc = await gc.getOutboundWrapupCodeMappings(api, org.id);
      canViewMapping = true;
      canEditMapping = true;
    } catch (err) {
      if (err.status === 403) {
        canViewMapping = false;
        canEditMapping = false;
        mappingDoc = null;
      } else {
        canViewMapping = true;
        canEditMapping = false;
        mappingDoc = null;
      }
    }
  }

  async function loadInitial() {
    if (loading) return;
    loading = true;
    setStatus("Loading wrapup codes and mappings...");

    try {
      await Promise.all([
        loadWrapupsAndDivisions(),
        loadMappingDocument(),
      ]);

      rowDrafts = new Map();
      populateDivisionSelect();
      renderTable();

      if (!canViewMapping) {
        setStatus(`Loaded ${wrapups.length} wrapup codes. Mapping is hidden due to missing outbound mapping view permission.`, "error");
      } else if (!mappingDoc) {
        setStatus(`Loaded ${wrapups.length} wrapup codes. Mapping is unavailable right now.`, "error");
      } else {
        setStatus(`Loaded ${wrapups.length} wrapup codes.`, "success");
      }
    } catch (err) {
      $tbody.innerHTML = `<tr><td class="wcm-empty" colspan="7">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
      setStatus(`Failed to load data: ${err.message}`, "error");
    } finally {
      loading = false;
    }
  }

  function setBusinessCategory(draft, category) {
    BUSINESS_FLAGS.forEach((f) => draft.localFlags.delete(f));
    if (category === "failure") draft.localFlags.add(FLAG.BUSINESS_FAILURE);
    if (category === "neutral") draft.localFlags.add(FLAG.BUSINESS_NEUTRAL);
    if (category === "success") draft.localFlags.add(FLAG.BUSINESS_SUCCESS);
  }

  function buildPayloadFromDraft(baseDoc, wrapupId, draft) {
    const payload = {
      ...baseDoc,
      mapping: { ...(baseDoc.mapping || {}) },
    };

    // Ensure we only keep one canonical mapping entry per wrapup id.
    const target = normalizeId(wrapupId);
    Object.keys(payload.mapping).forEach((key) => {
      if (normalizeId(key) === target) {
        delete payload.mapping[key];
      }
    });

    if (draft.useDefaultPending) {
      // No explicit key should remain; defaultSet will apply.
    } else {
      payload.mapping[wrapupId] = normalizeFlags([...draft.localFlags]);
    }

    return payload;
  }

  async function saveRowMapping(wrapupId) {
    const draft = ensureDraft(wrapupId);
    if (!mappingDoc || !canEditMapping) return;

    recalcDraftState(draft);
    if (!draft.dirty) return;
    if (draft.errors.length > 0) {
      draft.error = draft.errors[0];
      renderTable();
      return;
    }

    draft.saving = true;
    draft.error = null;
    draft.success = null;
    renderTable();

    const attemptSave = async (baseDoc) => {
      const payload = buildPayloadFromDraft(baseDoc, wrapupId, draft);
      return gc.putOutboundWrapupCodeMappings(api, org.id, payload);
    };

    try {
      let saved;
      try {
        saved = await attemptSave(mappingDoc);
      } catch (err) {
        if (err.status !== 409) throw err;

        const latest = await gc.getOutboundWrapupCodeMappings(api, org.id);
        saved = await attemptSave(latest);
      }

      mappingDoc = saved;
      const fresh = createDraft(wrapupId);
      fresh.success = draft.useDefaultPending
        ? "Mapping reset to default set."
        : "Mapping saved.";
      rowDrafts.set(wrapupId, fresh);

      setStatus("Mapping saved.", "success");
      logAction({
        me,
        orgId: org.id,
        orgName: org.name,
        action: "wrapup_mapping_update",
        description: `[Wrapup Mapping] Updated mapping for wrapup '${wrapupId}'`,
      });
    } catch (err) {
      draft.error = err.message || "Failed to save mapping.";
      if (err.status === 403) {
        canEditMapping = false;
      }
      setStatus(`Failed to save mapping: ${draft.error}`, "error");
    } finally {
      draft.saving = false;
      renderTable();
    }
  }

  async function saveModal() {
    const name = $modalName.value.trim();
    const description = $modalDescription.value.trim();
    const divisionId = $modalDivision.value || "";

    if (!name) {
      setModalMsg("Name is required.", "error");
      return;
    }

    modalState.saving = true;
    $modalSave.disabled = true;
    $modalCancel.disabled = true;
    setModalMsg(modalState.mode === "create" ? "Creating wrapup code..." : "Updating wrapup code...");

    const body = {
      name,
      ...(description ? { description } : {}),
      ...(divisionId ? { division: { id: divisionId } } : {}),
    };

    try {
      if (modalState.mode === "create") {
        await gc.createWrapupCode(api, org.id, body);
        logAction({
          me,
          orgId: org.id,
          orgName: org.name,
          action: "wrapup_create",
          description: `[Wrapup] Created wrapup code '${name}'`,
        });
      } else {
        const current = wrapups.find((w) => w.id === modalState.item?.id);
        if (!current?.id) throw new Error("Wrapup code no longer exists in the loaded list.");
        await gc.putWrapupCode(api, org.id, current.id, { ...body, version: current.version });
        logAction({
          me,
          orgId: org.id,
          orgName: org.name,
          action: "wrapup_edit",
          description: `[Wrapup] Updated wrapup code '${name}'`,
        });
      }

      await loadWrapupsAndDivisions();
      populateDivisionSelect();
      renderTable();
      closeModal();
      setStatus(modalState.mode === "create" ? "Wrapup code created." : "Wrapup code updated.", "success");
    } catch (err) {
      setModalMsg(err.message || "Save failed.", "error");
    } finally {
      modalState.saving = false;
      $modalSave.disabled = false;
      $modalCancel.disabled = false;
    }
  }

  $search.addEventListener("input", () => {
    searchQuery = $search.value;
    const visibleIds = new Set(getFilteredRows().map((r) => r.id));
    if (expandedRowId && !visibleIds.has(expandedRowId)) {
      expandedRowId = null;
    }
    renderTable();
  });

  $createBtn.addEventListener("click", () => openModal("create"));

  $modalCancel.addEventListener("click", closeModal);
  $modalBackdrop.addEventListener("click", (e) => {
    if (e.target === $modalBackdrop && !modalState.saving) closeModal();
  });
  $modalSave.addEventListener("click", saveModal);

  $tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const action = btn.dataset.action;
    const wrapupId = btn.dataset.wrapupId;

    if (action === "toggle-expand") {
      expandedRowId = expandedRowId === wrapupId ? null : wrapupId;
      if (expandedRowId) {
        const draft = ensureDraft(expandedRowId);
        recalcDraftState(draft);
      }
      renderTable();
      return;
    }

    if (action === "edit-wrapup") {
      const item = wrapups.find((w) => w.id === wrapupId);
      if (!item) return;
      openModal("edit", item);
      return;
    }

    if (!wrapupId) return;
    const draft = ensureDraft(wrapupId);

    if (action === "set-category") {
      if (!canEditMapping) return;
      setBusinessCategory(draft, btn.dataset.category || "none");
      draft.useDefaultPending = false;
      draft.error = null;
      draft.success = null;
      recalcDraftState(draft);
      renderTable();
      return;
    }

    if (action === "use-default") {
      if (!canEditMapping) return;
      draft.useDefaultPending = true;
      draft.localFlags = new Set(normalizeFlags(mappingDoc?.defaultSet || []));
      draft.error = null;
      draft.success = "Will use default set after save.";
      recalcDraftState(draft);
      renderTable();
      return;
    }

    if (action === "cancel-row") {
      rowDrafts.set(wrapupId, createDraft(wrapupId));
      renderTable();
      return;
    }

    if (action === "save-row") {
      await saveRowMapping(wrapupId);
    }
  });

  $tbody.addEventListener("change", (e) => {
    const input = e.target.closest("input[data-action='toggle-flag']");
    if (!input) return;
    if (!canEditMapping) return;

    const wrapupId = input.dataset.wrapupId;
    const flag = input.dataset.flag;
    if (!wrapupId || !flag) return;

    const draft = ensureDraft(wrapupId);
    if (input.checked) draft.localFlags.add(flag);
    else draft.localFlags.delete(flag);

    draft.useDefaultPending = false;
    draft.error = null;
    draft.success = null;
    recalcDraftState(draft);
    renderTable();
  });

  loadInitial();
  return el;
}
