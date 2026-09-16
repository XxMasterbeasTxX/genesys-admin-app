/**
 * Supervisor Access — the org's Supervisor scope.
 *
 * Two routes, one module (docs/customer-roles-design.md §8):
 *
 *   Customers › Supervisor Access       internal — superusers and customer-
 *                                       managers, for the org in the header;
 *                                       with the internal org selected, its
 *                                       own scope, superusers only
 *                                       (docs/internal-roles-design.md §4)
 *   Administrator › Supervisor Access   a customer Administrator, for their
 *                                       own org; the server ignores any other
 *
 * The scope is what a Supervisor in the org may have AT ALL: every page the
 * org offers — a customer's pages, or every internal page bar the
 * superuser-only and Customers ones — drawn as the sidebar draws them, one
 * box per page and a box per section. A Supervisor's own pages are a subset of it, chosen when
 * they are added or edited on the users list; their effective pages are the
 * two intersected at sign-in, so a change here reaches every Supervisor
 * within the gate's five-minute cache, with nobody editing rows.
 *
 * Save overwrites. The server validates every key against the pages a
 * customer may hold and says what it dropped; nothing here is trusted alone.
 */
import { makeStatus, withBusy } from "../../utils.js";
import { getSupervisorScope, setSupervisorScope } from "../../services/licenseService.js";
import { pageTreeFor } from "../../services/customerPageTree.js";
import { createPageTree, ensurePageTreeStyles } from "../../components/pageTree.js";

export default function renderSupervisorAccess({ orgContext, access }) {
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
    </style>
    <div class="sa-wrap">
      <h1 class="h1">${customerMode ? "Administrator — Supervisor Access" : "Customers — Supervisor Access"}</h1>
      <hr class="hr">
      <p class="page-desc">
        The pages a Supervisor in this organisation may be given. Tick a section to include every page
        under it. When a Supervisor is added or edited, only the pages ticked here can be chosen for
        them; unticking a page here takes it from every Supervisor who had it. Administrators always
        see everything the organisation offers.
      </p>

      <div class="sa-org" ${customerMode ? "hidden" : ""}>
        <span class="em-label">Organization:</span>
        <span id="saOrgName" class="em-hint">Select a customer org in the header.</span>
      </div>

      <div id="saBody" hidden>
        <div class="sa-tools">
          <span id="saCount" class="sa-count"></span>
          <span class="sa-spacer"></span>
          <button type="button" class="btn btn-secondary btn-sm" id="saAll">Tick all</button>
          <button type="button" class="btn btn-secondary btn-sm" id="saNone">Untick all</button>
          <button type="button" class="btn" id="saSave" disabled>Save</button>
        </div>
        <div class="sa-panel" id="saTree"></div>
        <div class="sa-note">A saved change reaches signed-in Supervisors within five minutes, or on their next sign-in.</div>
      </div>

      <div id="saStatus" class="cs-status"></div>
    </div>
  `;

  const $orgName = el.querySelector("#saOrgName");
  const $body    = el.querySelector("#saBody");
  const $count   = el.querySelector("#saCount");
  const $all     = el.querySelector("#saAll");
  const $none    = el.querySelector("#saNone");
  const $save    = el.querySelector("#saSave");
  const $treeBox = el.querySelector("#saTree");
  const $status  = el.querySelector("#saStatus");
  const setStatus = makeStatus($status, "cs-status");

  let currentOrg = null;
  let saved = [];           // what the server holds, sorted
  let loadSeq = 0;
  let tree = null;          // built per org: the internal org's pages differ from a customer's
  let treeKind = null;

  /** The tree for this org's kind — rebuilt only when the kind changes. */
  function ensureTree(internal) {
    const kind = internal ? "internal" : "customer";
    if (tree && treeKind === kind) return;
    treeKind = kind;
    // Collapsed: ~80 pages under 13 sections is a wall; the section counts
    // say where the ticks are, and a section opens on its chevron.
    tree = createPageTree({ tree: pageTreeFor(internal), onChange: onEdit, open: false });
    $treeBox.replaceChildren(tree.el);
  }

  function onEdit(keys) {
    $count.textContent = `${keys.length} of ${tree.size} pages in the scope`;
    const dirty = JSON.stringify([...keys].sort()) !== JSON.stringify(saved);
    $save.disabled = !dirty;
  }

  async function load() {
    const seq = ++loadSeq;
    tree.setEnabled(false);
    setStatus(`Loading the Supervisor scope for ${currentOrg.name}…`);
    try {
      const features = await getSupervisorScope(currentOrg.id);
      if (seq !== loadSeq) return;
      saved = [...features].sort();
      tree.setSelected(saved);
      tree.setEnabled(true);
      onEdit(tree.getSelected());
      setStatus(saved.length ? "" : "Nothing is in the scope yet — no Supervisor can be added until something is.", saved.length ? "" : "warn");
    } catch (err) {
      if (seq !== loadSeq) return;
      setStatus(err.message || String(err), "error");
    }
  }

  async function save() {
    const keys = tree.getSelected();
    if (!keys.length) {
      const ok = window.confirm(
        `Save an empty Supervisor scope for ${currentOrg.name}?\n\n` +
        `Every Supervisor in the organisation will lose every page within five minutes, and no Supervisor can be added until something is ticked.`
      );
      if (!ok) return;
    }
    setStatus(`Saving the Supervisor scope for ${currentOrg.name}…`);
    try {
      const r = await withBusy($save, () => setSupervisorScope(currentOrg.id, keys));
      saved = [...(r.features || [])].sort();
      tree.setSelected(saved);
      onEdit(tree.getSelected());
      const dropped = Array.isArray(r.dropped) && r.dropped.length ? ` ${r.dropped.length} unknown page${r.dropped.length === 1 ? " was" : "s were"} dropped.` : "";
      setStatus(`Saved: ${saved.length} page${saved.length === 1 ? "" : "s"} in the scope. Supervisors see the change within five minutes.${dropped}`, "success");
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
    if (!customerMode && orgContext.isInternalOrg(org.id) && !isSuperuser) {
      return `${org.name} is the internal organisation. Only a superuser can set what its Supervisors may see.`;
    }
    if (org.registered === false) {
      return `${org.name} is not set up as a customer yet: it has no registry entry. Add the registry entry first (see the onboarding runbook), then set its Supervisor scope here.`;
    }
    return null;
  }

  function setOrg(org) {
    currentOrg = org || null;
    loadSeq++;
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
    ensureTree(!customerMode && orgContext.isInternalOrg(currentOrg.id));
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
