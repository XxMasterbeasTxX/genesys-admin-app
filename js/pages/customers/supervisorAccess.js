/**
 * Super User Access — the org's Super User scope, and its Super User templates.
 *
 * Two routes, one module (docs/customer-roles-design.md §8):
 *
 *   Customers › Super User Access       internal — superusers and customer-
 *                                       managers, for the org in the header;
 *                                       with the internal org selected, its
 *                                       own scope, superusers only
 *                                       (docs/internal-roles-design.md §4)
 *   Master Admin › Super User Access   a customer Master Admin, for their
 *                                       own org; the server ignores any other
 *
 * The dropdown above the tree says what is being edited:
 *
 *   Default — the Super User scope      what a Super User in the org may have
 *                                       AT ALL: every page the org offers,
 *                                       drawn as the sidebar draws them, and
 *                                       under Data Tables › Super User the
 *                                       tables open to Super Users — a list,
 *                                       read-only: the switch is "Visible to
 *                                       Super Users" on Data Tables › Edit
 *   a template                          a named subset of the scope, plus the
 *                                       data tables under Data Tables ›
 *                                       Super User, that a Super User can be
 *                                       put on (docs/supervisor-templates-design.md)
 *
 * A Super User's effective pages are the scope ∩ (their template ∪ their own
 * ticks), computed at sign-in, so a change here reaches every Super User
 * within the gate's five-minute cache, with nobody editing rows.
 *
 * Save overwrites. The server validates every key against the pages a
 * customer may hold (and a template's against the scope) and says what it
 * dropped; nothing here is trusted alone.
 */
import { escapeHtml, makeStatus, withBusy } from "../../utils.js";
import {
  getSupervisorScope, setSupervisorScope,
  listSupervisorTemplates, saveSupervisorTemplate, deleteSupervisorTemplate,
} from "../../services/licenseService.js";
import { listDataTableRules } from "../../services/dataTableRulesService.js";
import * as gc from "../../services/genesysApi.js";
import { pageTreeFor, pruneTree } from "../../services/customerPageTree.js";
import { createPageTree, ensurePageTreeStyles } from "../../components/pageTree.js";
import { createTablesPicker } from "../../components/tablesPicker.js";

const SUPERVISOR_TABLES_PAGE = "data-tables.supervisor";
const NEW_TEMPLATE = "__new__";

export default function renderSupervisorAccess({ api, orgContext, access }) {
  ensurePageTreeStyles();
  const customerMode = !!(orgContext && orgContext.isCustomer && orgContext.isCustomer());
  const isSuperuser  = !!(access && access.isSuperuser);

  const el = document.createElement("div");
  el.innerHTML = `
    <style>
      .sa-wrap { max-width: 900px; }
      .sa-org { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
      .sa-org .em-label { margin:0; }
      .sa-count { color:var(--muted); font-size:13px; }
      .sa-tools { display:flex; gap:8px; align-items:center; margin: 0 0 10px; flex-wrap:wrap; }
      .sa-tools .sa-spacer { flex:1; }
      .sa-panel { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:10px 14px; margin-bottom:12px; }
      .sa-note { color:var(--muted); font-size:12px; margin-top:8px; }
      /* What is being edited: the scope, or a template. */
      .sa-editing { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin: 0 0 10px; }
      .sa-editing .em-label { margin:0; }
      .sa-editing select { min-width: 260px; }
      .sa-editing-hint { color:var(--muted); font-size:12px; flex-basis:100%; }
    </style>
    <div class="sa-wrap">
      <h1 class="h1">${customerMode ? "Master Admin — Super User Access" : "Customers — Super User Access"}</h1>
      <hr class="hr">
      <p class="page-desc">
        The pages a Super User in this organisation may be given. Tick a section to include every page
        under it. When a Super User is added or edited, only the pages ticked here can be chosen for
        them; unticking a page here takes it from every Super User who had it. Master Admins always
        see everything the organisation offers. A <strong>template</strong> is a named set of pages and
        data tables from the scope that a Super User can be put on: change the template and every
        Super User on it follows, their own extra pages untouched.
      </p>

      <div class="sa-org" ${customerMode ? "hidden" : ""}>
        <span class="em-label">Organization:</span>
        <span id="saOrgName" class="em-hint">Select a customer org in the header.</span>
      </div>

      <div id="saBody" hidden>
        <div class="sa-editing">
          <span class="em-label">Editing:</span>
          <select class="dt-select" id="saEditing"></select>
          <button type="button" class="btn btn-secondary btn-sm" id="saRename" hidden>Rename</button>
          <button type="button" class="btn btn-secondary btn-sm" id="saDelete" hidden>Delete</button>
          <span class="sa-editing-hint" id="saEditingHint"></span>
        </div>
        <div class="sa-tools">
          <span id="saCount" class="sa-count"></span>
          <span class="sa-spacer"></span>
          <button type="button" class="btn btn-secondary btn-sm" id="saAll">Tick all</button>
          <button type="button" class="btn btn-secondary btn-sm" id="saNone">Untick all</button>
          <button type="button" class="btn" id="saSave" disabled>Save</button>
        </div>
        <div class="sa-panel" id="saTree"></div>
        <div class="sa-note">A saved change reaches signed-in Super Users within five minutes, or on their next sign-in.</div>
      </div>

      <div id="saStatus" class="cs-status"></div>
    </div>
  `;

  const $orgName = el.querySelector("#saOrgName");
  const $body    = el.querySelector("#saBody");
  const $editing = el.querySelector("#saEditing");
  const $rename  = el.querySelector("#saRename");
  const $delete  = el.querySelector("#saDelete");
  const $hint    = el.querySelector("#saEditingHint");
  const $count   = el.querySelector("#saCount");
  const $all     = el.querySelector("#saAll");
  const $none    = el.querySelector("#saNone");
  const $save    = el.querySelector("#saSave");
  const $treeBox = el.querySelector("#saTree");
  const $status  = el.querySelector("#saStatus");
  const setStatus = makeStatus($status, "cs-status");

  let currentOrg = null;
  let scope = [];            // the org's scope as the server holds it, sorted
  let templates = [];        // the org's templates, by name
  let tables = [];           // [{ id, name }] visible to Super Users, by name
  let tablesError = "";
  let current = null;        // null = the scope; else the template being edited
  let loadSeq = 0;
  let tree = null;
  let picker = null;         // the tables picker under the Super User page (templates only)
  let treeMode = null;       // "scope:<kind>" or "template" — rebuilt when it changes

  const internal = () => !customerMode && orgContext.isInternalOrg(currentOrg.id);

  // ── The tree: the org's pages for the scope; the scope's pages for a template ──
  function buildTree() {
    const mode = current ? "template" : `scope:${internal() ? "internal" : "customer"}`;
    // A template's tree is pruned to the scope, so it must be rebuilt when
    // the scope changes; the scope's tree only when the org's kind does.
    if (tree && treeMode === mode && mode !== "template") return;
    treeMode = mode;
    picker = null;
    const extras = {};
    if (current) {
      picker = createTablesPicker({ tables, error: tablesError, onChange: onEdit, emptyNote: "No data table has been made visible to Super Users yet: this page carries no tables until one is (Data Tables › Edit, \"Visible to Super Users\")." });
    } else {
      // Under the scope: the tables open to Super Users, shown, not chosen —
      // the switch is on Data Tables › Edit.
      picker = createTablesPicker({
        tables, error: tablesError, readOnly: true,
        emptyNote: "No data table has been made visible to Super Users yet. A Master Admin opens one with \"Visible to Super Users\" on Data Tables › Edit.",
        countText: (n) => `${n} data table${n === 1 ? "" : "s"} visible to Super Users — set with \"Visible to Super Users\" on Data Tables › Edit`,
      });
    }
    extras[SUPERVISOR_TABLES_PAGE] = picker.el;
    // Collapsed: ~80 pages under 13 sections is a wall; the section counts
    // say where the ticks are, and a section opens on its chevron.
    tree = createPageTree({ tree: current ? pruneTree(pageTreeFor(internal()), scope) : pageTreeFor(internal()), onChange: onEdit, open: false, extras });
    $treeBox.replaceChildren(tree.el);
  }

  /** What the controls hold now, and what the server holds, for dirtiness. */
  function held() {
    const features = tree.getSelected();
    const dataTables = current && picker && features.includes(SUPERVISOR_TABLES_PAGE) ? picker.getSelected() : [];
    return { features: [...features].sort(), dataTables: [...dataTables].sort() };
  }
  function saved() {
    return current ? { features: [...current.features].sort(), dataTables: [...current.dataTables].sort() } : { features: scope, dataTables: [] };
  }

  function onEdit() {
    const h = held();
    $count.textContent = current
      ? `${h.features.length} of ${tree.size} pages in the template${h.features.includes(SUPERVISOR_TABLES_PAGE) ? `, ${h.dataTables.length} data table${h.dataTables.length === 1 ? "" : "s"}` : ""}`
      : `${h.features.length} of ${tree.size} pages in the scope`;
    $save.disabled = JSON.stringify(h) === JSON.stringify(saved());
  }

  // ── The dropdown ──────────────────────────────────────────────────────
  function renderEditing() {
    const opts = [`<option value="">Default — the Super User scope</option>`]
      .concat(templates.map((t) => `<option value="${escapeHtml(t.id)}">Template: ${escapeHtml(t.name)}</option>`))
      .concat([`<option value="${NEW_TEMPLATE}">+ New template…</option>`]);
    $editing.innerHTML = opts.join("");
    $editing.value = current ? current.id : "";
    $rename.hidden = $delete.hidden = !current;
    $hint.textContent = current
      ? (scope.length
        ? `The template's pages, chosen from the scope. A Super User on "${current.name}" has these plus any extra pages ticked for them; change the template and they all follow.`
        : `The scope is empty, so a template has nothing to choose from yet. Save the scope first.`)
      : (templates.length
        ? `Every page a Super User may have at all; under Data Tables › Super User, the tables open to them. ${templates.length} template${templates.length === 1 ? "" : "s"} draw from it: unticking a page here takes it from them too.`
        : "Every page a Super User may have at all; under Data Tables › Super User, the tables open to them.");
  }

  function show(what) {
    current = what || null;
    buildTree();
    tree.setSelected(current ? current.features : scope);
    if (picker && current) picker.setSelected(current.dataTables);
    tree.setEnabled(true);
    renderEditing();
    onEdit();
  }

  $editing.addEventListener("change", async () => {
    const v = $editing.value;
    if (!$save.disabled && !window.confirm("Discard the unsaved changes here?")) { $editing.value = current ? current.id : ""; return; }
    if (v === NEW_TEMPLATE) { $editing.value = current ? current.id : ""; await newTemplate(); return; }
    show(v ? templates.find((t) => t.id === v) : null);
  });

  async function newTemplate() {
    const name = (window.prompt("Name for the new template:") || "").trim();
    if (!name) return;
    setStatus(`Creating the template "${name}"…`);
    try {
      const r = await saveSupervisorTemplate(currentOrg.id, { name, features: [], dataTables: [] });
      templates = [...templates, r.template].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      show(r.template);
      setStatus(`Template "${r.template.name}" created. Tick its pages and save.`, "success");
    } catch (err) {
      setStatus(err.message || String(err), "error");
    }
  }

  $rename.addEventListener("click", async () => {
    if (!current) return;
    const name = (window.prompt("New name for the template:", current.name) || "").trim();
    if (!name || name === current.name) return;
    setStatus(`Renaming "${current.name}"…`);
    try {
      // Renaming saves the template as it is held, ticks included.
      const h = held();
      const r = await saveSupervisorTemplate(currentOrg.id, { id: current.id, name, features: h.features, dataTables: h.dataTables });
      templates = templates.map((t) => (t.id === r.template.id ? r.template : t)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      show(r.template);
      setStatus(`Renamed to "${r.template.name}" and saved.`, "success");
    } catch (err) {
      setStatus(err.message || String(err), "error");
    }
  });

  $delete.addEventListener("click", async () => {
    if (!current) return;
    if (!window.confirm(`Delete the template "${current.name}"?\n\nOnly possible when no Super User is on it.`)) return;
    setStatus(`Deleting "${current.name}"…`);
    try {
      await deleteSupervisorTemplate(currentOrg.id, current.id);
      templates = templates.filter((t) => t.id !== current.id);
      const name = current.name;
      show(null);
      setStatus(`Template "${name}" deleted.`, "success");
    } catch (err) {
      const who = Array.isArray(err.names) && err.names.length ? ` (${err.names.join(", ")})` : "";
      setStatus(err.code === "template_in_use"
        ? `"${current.name}" is used by ${err.users} Super User${err.users === 1 ? "" : "s"}${who}. Move them to another template first.`
        : (err.message || String(err)), "error");
    }
  });

  // ── Load and save ─────────────────────────────────────────────────────
  async function load() {
    const seq = ++loadSeq;
    if (tree) tree.setEnabled(false);
    setStatus(`Loading the Super User scope for ${currentOrg.name}…`);
    try {
      const [features, tpls] = await Promise.all([getSupervisorScope(currentOrg.id), listSupervisorTemplates(currentOrg.id)]);
      if (seq !== loadSeq) return;
      scope = [...features].sort();
      templates = tpls;
      // The tables a template may carry. Read whether or not the Super User
      // page is in the scope yet: it can be ticked in and saved, and a
      // template made, in the same visit.
      tables = []; tablesError = "";
      try {
        const [all, allRules] = await Promise.all([gc.fetchAllDataTables(api, currentOrg.id), listDataTableRules(currentOrg.id)]);
        if (seq !== loadSeq) return;
        tables = (all || []).filter((t) => allRules[t.id] && allRules[t.id].visibleToSupervisors)
          .map((t) => ({ id: t.id, name: t.name }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      } catch (err) {
        if (seq !== loadSeq) return;
        tables = null; tablesError = err.message || String(err);
      }
      treeMode = null;              // the scope may have changed: rebuild
      show(null);
      setStatus(scope.length ? "" : "Nothing is in the scope yet — no Super User can be added until something is.", scope.length ? "" : "warn");
    } catch (err) {
      if (seq !== loadSeq) return;
      setStatus(err.message || String(err), "error");
    }
  }

  async function save() {
    const h = held();
    if (current) return saveTemplate(h);
    if (!h.features.length) {
      const ok = window.confirm(
        `Save an empty Super User scope for ${currentOrg.name}?\n\n` +
        `Every Super User in the organisation will lose every page within five minutes, and no Super User can be added until something is ticked.`
      );
      if (!ok) return;
    }
    setStatus(`Saving the Super User scope for ${currentOrg.name}…`);
    try {
      const r = await withBusy($save, () => setSupervisorScope(currentOrg.id, h.features));
      scope = [...(r.features || [])].sort();
      show(null);
      const dropped = Array.isArray(r.dropped) && r.dropped.length ? ` ${r.dropped.length} unknown page${r.dropped.length === 1 ? " was" : "s were"} dropped.` : "";
      setStatus(`Saved: ${scope.length} page${scope.length === 1 ? "" : "s"} in the scope. Super Users see the change within five minutes.${dropped}`, "success");
    } catch (err) {
      setStatus(err.message || String(err), "error");
    }
  }

  async function saveTemplate(h) {
    setStatus(`Saving the template "${current.name}"…`);
    try {
      const r = await withBusy($save, () => saveSupervisorTemplate(currentOrg.id, { id: current.id, name: current.name, features: h.features, dataTables: h.dataTables }));
      templates = templates.map((t) => (t.id === r.template.id ? r.template : t));
      show(r.template);
      const n = r.template.features.length, t = r.template.dataTables.length;
      const dropped = (r.dropped ? ` ${r.dropped} page${r.dropped === 1 ? " was" : "s were"} outside the scope and dropped.` : "")
        + (r.droppedTables ? ` ${r.droppedTables} table${r.droppedTables === 1 ? " was" : "s were"} not visible to Super Users and dropped.` : "");
      setStatus(`Saved "${r.template.name}": ${n} page${n === 1 ? "" : "s"}${t ? `, ${t} data table${t === 1 ? "" : "s"}` : ""}. Every Super User on it follows within five minutes.${dropped}`, "success");
    } catch (err) {
      setStatus(err.message || String(err), "error");
    }
  }

  $all.addEventListener("click", () => tree && tree.selectAll(true));
  $none.addEventListener("click", () => tree && tree.selectAll(false));
  $save.addEventListener("click", save);

  /** Why this org's scope cannot be edited here, or null. */
  function notScopable(org) {
    if (!org) return null;
    if (!customerMode && orgContext.isInternalOrg(org.id)) {
      // The internal org has no registry entry and needs none: its scope is
      // its own, superusers only.
      return isSuperuser ? null
        : `${org.name} is the internal organisation. Only a Super Master Admin can set what its Super Users may see.`;
    }
    if (org.registered === false) {
      return `${org.name} is not set up as a customer yet: it has no registry entry. Add the registry entry first (see the onboarding runbook), then set its Super User scope here.`;
    }
    return null;
  }

  function setOrg(org) {
    currentOrg = org || null;
    loadSeq++;
    current = null;
    if (!currentOrg) {
      $orgName.textContent = "Select a customer org in the header.";
      $body.hidden = true;
      setStatus("");
      return;
    }
    $orgName.textContent = currentOrg.name;
    const why = notScopable(currentOrg);
    if (why) {
      $body.hidden = true;
      setStatus(why, "warn");
      return;
    }
    $body.hidden = false;
    load();
  }

  if (customerMode) {
    // The org is the session's; the header selector is fixed to it.
    setOrg(orgContext.getDetails() || (orgContext.getCustomers() || [])[0] || null);
  } else {
    setOrg(orgContext?.getDetails?.() || null);
    const unsubscribe = orgContext?.onChange?.(() => setOrg(orgContext?.getDetails?.() || null));
    el.__destroy = () => { unsubscribe?.(); };
  }

  return el;
}
