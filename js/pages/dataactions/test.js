/**
 * Data Actions › Test
 *
 * Run a data action and read what came back. Nothing on this page writes
 * configuration — no save, no publish, no editable field.
 *
 * It exists because `data-actions.edit` bundles write access with execute
 * access, so there was no way to let someone test an action without also
 * letting them rewrite and publish it. This page maps to `data-actions.test`,
 * which carries `integrations:action:execute` alone.
 *
 * Published and Draft can be run together and their outputs compared, which is
 * usually the reason for testing a draft at all.
 *
 * Design: docs/data-actions-test-design.md
 *
 * API endpoints:
 *   GET  /api/v2/integrations/actions              — list published actions
 *   GET  /api/v2/integrations/actions/drafts        — list draft actions
 *   GET  /api/v2/integrations                       — list integrations
 *   GET  /api/v2/integrations/actions/{id}          — get published action
 *   GET  /api/v2/integrations/actions/{id}/draft     — get action draft
 *   POST /api/v2/integrations/actions/{id}/test      — test published action
 *   POST /api/v2/integrations/actions/{id}/draft/test — test draft action
 */
import { escapeHtml, makeStatus } from "../../utils.js";
import { createSingleSelect } from "../../components/multiSelect.js";
import * as gc from "../../services/genesysApi.js";
import {
  inputFieldsHtml, collectInputs, outcomeOf,
  outputsTableHtml, stepsTableHtml, resolvedRequestOf,
} from "../../lib/dataActionTest.js";

const STATUS = {
  ready:     "Loading…",
  loading:   "Loading actions and integrations…",
  fetching:  "Fetching action detail…",
  testing:   "Running test…",
  noActions: "No data actions found.",
  noOrg:     "Select an organisation in the header to load its data actions.",
  error:     (msg) => `Error: ${msg}`,
};

export default function renderTestDataAction({ route, me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card ed-page";

  const orgId = orgContext.get();

  el.innerHTML = `
    <h2>Data Actions — Test</h2>

    <p class="page-desc">
      Run a data action and read the result against its output contract.
      Nothing here changes an action — use Data Actions › Edit for that.
    </p>

    <div class="ed-empty" id="tsNoOrg" hidden>
      Select an organisation in the header to load its data actions.
    </div>

    <div id="tsMain" hidden>
      <div class="ed-picker-row">
        <div class="ed-picker-mount" id="tsActionMount"></div>
        <button class="btn" id="tsRefreshBtn">Refresh</button>
      </div>

      <div class="ed-filter-row" id="tsFilters" hidden>
        <select class="dt-select ed-filter-select" id="tsFilterCat">
          <option value="">All categories</option>
        </select>
        <select class="dt-select ed-filter-select" id="tsFilterInteg">
          <option value="">All integrations</option>
        </select>
        <select class="dt-select ed-filter-select" id="tsFilterStatus">
          <option value="">All statuses</option>
          <option value="Published">Published</option>
          <option value="Draft">Draft only</option>
        </select>
      </div>

      <div class="dt-progress-wrap" id="tsProgress" hidden>
        <div class="dt-progress-bar" id="tsProgressBar"></div>
      </div>

      <div class="dt-status" id="tsStatus">${STATUS.ready}</div>

      <div id="tsDetail" hidden>
        <hr class="ed-divider" />

        <div class="ed-identity">
          <span class="ed-badge" id="tsInfoStatus">—</span>
          <span class="ed-identity-meta">
            <span id="tsInfoVersion">—</span>
            <span class="ed-sep">·</span>
            <span id="tsInfoInteg" title="">—</span>
            <span class="ed-sep">·</span>
            <span id="tsInfoSecure">—</span>
          </span>
        </div>

        <!-- No Contract section: the input fields and the Outputs table
             already name every field with its type, so it would only repeat
             itself. Edit is where the contract is worth reading. -->

        <!-- Inputs left, results right -->
        <div class="ts-split">
          <div class="ts-inputs">
            <h4 class="ed-subhead">Inputs</h4>

            <div class="dt-control-group ed-field">
              <label class="dt-label">Run against</label>
              <div class="ts-targets" id="tsTargets">
                <button class="ts-target" type="button" data-target="published">Published</button>
                <button class="ts-target" type="button" data-target="draft">Draft</button>
                <button class="ts-target is-on" type="button" data-target="both">Both</button>
              </div>
            </div>

            <div id="tsInputFields"></div>

            <div class="dt-actions">
              <button class="btn ed-btn-test" id="tsRunBtn" disabled>Run Test</button>
            </div>

            <p class="ed-note" id="tsSideEffects"></p>
          </div>

          <div class="ts-results">
            <h4 class="ed-subhead">Results</h4>
            <p class="ed-note" id="tsResultsEmpty">Run the action to see its output here.</p>
            <div id="tsResultBlocks"></div>
          </div>
        </div>

        <!-- Full width: too wide to live in half a column -->
        <div id="tsDetailPanes"></div>
      </div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────
  const $noOrg        = el.querySelector("#tsNoOrg");
  const $main         = el.querySelector("#tsMain");
  const $actionMount  = el.querySelector("#tsActionMount");
  const $refreshBtn   = el.querySelector("#tsRefreshBtn");
  const $filters      = el.querySelector("#tsFilters");
  const $filterCat    = el.querySelector("#tsFilterCat");
  const $filterInteg  = el.querySelector("#tsFilterInteg");
  const $filterStatus = el.querySelector("#tsFilterStatus");
  const $detail       = el.querySelector("#tsDetail");
  const $infoStatus   = el.querySelector("#tsInfoStatus");
  const $infoInteg    = el.querySelector("#tsInfoInteg");
  const $infoSecure   = el.querySelector("#tsInfoSecure");
  const $infoVersion  = el.querySelector("#tsInfoVersion");
  const $targets      = el.querySelector("#tsTargets");
  const $inputFields  = el.querySelector("#tsInputFields");
  const $runBtn       = el.querySelector("#tsRunBtn");
  const $sideEffects  = el.querySelector("#tsSideEffects");
  const $resultsEmpty = el.querySelector("#tsResultsEmpty");
  const $resultBlocks = el.querySelector("#tsResultBlocks");
  const $detailPanes  = el.querySelector("#tsDetailPanes");
  const $progress     = el.querySelector("#tsProgress");
  const $progressBar  = el.querySelector("#tsProgressBar");
  const $status       = el.querySelector("#tsStatus");

  const canExecute = access && access.can ? access.can("data-actions.test", "execute") : true;
  if (!canExecute) $runBtn.title = "Requires Genesys permission: integrations:action:execute";

  const actionCtl = createSingleSelect({
    placeholder: "Select an action…",
    searchable:  true,
    onChange:    (id) => handleActionChange(id),
  });
  actionCtl.setEnabled(false);
  $actionMount.append(actionCtl.el);

  let allActions = [];
  let integrations = [];
  let selectedFull = null;
  let hasDraft = false;
  let target = "both";
  let selectionSeq = 0;

  const setStatus = makeStatus($status, "dt-status");

  function setProgress(pct) { $progress.hidden = false; $progressBar.style.width = `${pct}%`; }
  function hideProgress() { $progress.hidden = true; $progressBar.style.width = "0%"; }

  function integName(id) { return integrations.find(i => i.id === id)?.name || id; }
  function integType(id) { return integrations.find(i => i.id === id)?.integrationType?.id || "unknown"; }
  function actionName(id) { return allActions.find(a => a.id === id)?.name || id; }

  function setStatusBadge(text) {
    $infoStatus.textContent = text;
    $infoStatus.className = "ed-badge "
      + (text === "Published" ? "is-published" : text === "Draft only" ? "is-draft" : "is-both");
  }

  // ── Load ──────────────────────────────────────────────
  async function loadActions() {
    if (!orgId) return;
    try {
      setStatus(STATUS.loading);
      $refreshBtn.disabled = true;
      reset();

      const [published, drafts, integs] = await Promise.all([
        gc.fetchAllDataActions(api, orgId, { query: { includeAuthActions: "false" } }),
        gc.fetchAllDataActionDrafts(api, orgId, { query: { includeAuthActions: "false" } }),
        gc.fetchAllIntegrations(api, orgId, { pageSize: 200 }),
      ]);
      integrations = integs;

      const publishedIds = new Set(published.map(a => a.id));
      allActions = [
        ...published.map(a => ({ id: a.id, name: a.name, category: a.category || "",
          integrationId: a.integrationId || "", status: "Published" })),
        ...drafts.filter(d => !publishedIds.has(d.id)).map(a => ({ id: a.id, name: a.name,
          category: a.category || "", integrationId: a.integrationId || "",
          status: "Draft" })),
      ].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      if (!allActions.length) {
        setStatus(STATUS.noActions);
        $refreshBtn.disabled = false;
        return;
      }

      populateFilters();
      $filters.hidden = false;
      applyFilters();
      actionCtl.setEnabled(true);
      $refreshBtn.disabled = false;
      setStatus(`Loaded ${allActions.length} action(s). Select one to test.`);
    } catch (err) {
      setStatus(STATUS.error(err.message), "error");
      $refreshBtn.disabled = false;
    }
  }

  $refreshBtn.addEventListener("click", loadActions);

  function reset() {
    allActions = [];
    integrations = [];
    actionCtl.setItems([]);
    actionCtl.setEnabled(false);
    $filters.hidden = true;
    $detail.hidden = true;
    selectedFull = null;
    hasDraft = false;
    selectionSeq++;
  }

  function populateFilters() {
    const cats = [...new Set(allActions.map(a => a.category).filter(Boolean))].sort();
    $filterCat.innerHTML = `<option value="">All categories</option>`
      + cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    const integIds = [...new Set(allActions.map(a => a.integrationId).filter(Boolean))];
    $filterInteg.innerHTML = `<option value="">All integrations</option>`
      + integIds.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(integName(id))}</option>`).join("");
  }

  function applyFilters() {
    const catQ = $filterCat.value, integQ = $filterInteg.value, statusQ = $filterStatus.value;
    const filtered = allActions.filter(a =>
      (!catQ || a.category === catQ)
      && (!integQ || a.integrationId === integQ)
      && (!statusQ || a.status === statusQ));

    actionCtl.setItems(filtered.map(a => ({
      id: a.id,
      label: `${a.name}${a.category ? `  (${a.category})` : ""}${a.status === "Draft" ? "  [Draft]" : ""}`,
    })));
    $detail.hidden = true;
  }

  $filterCat.addEventListener("change", applyFilters);
  $filterInteg.addEventListener("change", applyFilters);
  $filterStatus.addEventListener("change", applyFilters);

  // ── Target selection ──────────────────────────────────
  $targets.addEventListener("click", (e) => {
    const btn = e.target.closest(".ts-target");
    if (!btn || btn.disabled) return;
    target = btn.dataset.target;
    [...$targets.children].forEach(b => b.classList.toggle("is-on", b === btn));
    describeSideEffects();
  });

  /**
   * Say what pressing Run will actually do.
   *
   * A test executes the action for real: a POST creates a record, a DELETE
   * deletes one. Running Both does it twice. Genesys behaves the same way, but
   * this page is meant for people who cannot otherwise write anything, so it
   * says so rather than assuming they know.
   */
  function describeSideEffects() {
    const method = (selectedFull?.config?.request?.requestType || "GET").toUpperCase();
    const runs = target === "both" && hasDraft ? 2 : 1;
    if (method === "GET") {
      $sideEffects.textContent = `Runs the action for real (${method}).`
        + (runs === 2 ? " Both targets are executed." : "");
      $sideEffects.classList.remove("is-warn");
      return;
    }
    $sideEffects.textContent = `This action is a ${method} — running it changes data in the target system`
      + (runs === 2 ? ", and Both executes it twice." : ".");
    $sideEffects.classList.add("is-warn");
  }

  function syncTargetButtons(item) {
    const canPublished = item.status === "Published";
    const canDraft = hasDraft || item.status === "Draft";
    const avail = { published: canPublished, draft: canDraft, both: canPublished && canDraft };

    [...$targets.children].forEach((b) => {
      const ok = avail[b.dataset.target];
      b.disabled = !ok;
      b.title = ok ? "" : "Not available for this action";
    });

    // Fall back to whatever this action actually has.
    if (!avail[target]) target = avail.both ? "both" : avail.published ? "published" : "draft";
    [...$targets.children].forEach(b => b.classList.toggle("is-on", b.dataset.target === target));
  }

  // ── Select action ─────────────────────────────────────
  async function handleActionChange(id) {
    const seq = ++selectionSeq;
    if (!id) { $detail.hidden = true; return; }
    const item = allActions.find(a => a.id === id);
    if (!item) return;

    try {
      setStatus(STATUS.fetching);
      setProgress(35);

      let draftData = null;
      try { draftData = await gc.getDataActionDraft(api, orgId, id); } catch { /* no draft */ }
      let pubData = null;
      if (item.status === "Published") pubData = await gc.getDataAction(api, orgId, id);
      if (seq !== selectionSeq) return;

      hasDraft = !!draftData;
      const detail = draftData || pubData;
      if (!detail) throw new Error("Could not load this action's configuration.");
      selectedFull = detail;

      setStatusBadge(hasDraft
        ? (item.status === "Published" ? "Published + Draft" : "Draft only")
        : "Published");
      $infoInteg.textContent = integName(item.integrationId);
      $infoInteg.title = `Integration type: ${integType(item.integrationId)}`;
      $infoSecure.textContent = detail.secure ? "secure" : "not secure";
      $infoVersion.textContent = detail.version != null ? `v${detail.version}` : "—";

      $inputFields.innerHTML = inputFieldsHtml(detail.contract);

      syncTargetButtons(item);
      describeSideEffects();
      clearResults();

      $runBtn.disabled = !canExecute;
      $detail.hidden = false;
      hideProgress();
      setStatus("Action loaded. Fill in any inputs and run.");
    } catch (err) {
      if (seq !== selectionSeq) return;
      hideProgress();
      setStatus(STATUS.error(err.message), "error");
    }
  }

  // ── Results ───────────────────────────────────────────
  function clearResults() {
    $resultBlocks.innerHTML = "";
    $detailPanes.innerHTML = "";
    $resultsEmpty.hidden = false;
  }

  /** One outcome banner + Outputs table per target, in the right column. */
  function renderResultBlock(label, result, compareTo) {
    const { failed, detail } = outcomeOf(result);
    const outputs = outputsTableHtml(selectedFull?.contract, result?.finalResult, { compareTo });
    // What was actually sent, so an empty result is readable at a glance.
    const sent = resolvedRequestOf(result);
    return `
      <div class="ts-result">
        <div class="ed-test-outcome ${failed ? "is-fail" : "is-ok"}">
          <div>${escapeHtml(label)} — ${failed ? "failed" : "succeeded"}${
            failed && detail ? `: ${escapeHtml(detail)}` : ""}</div>
          ${sent ? `<div class="ed-req-line">${escapeHtml(sent)}</div>` : ""}
        </div>
        ${outputs || `<p class="ed-note">This action declares no outputs.</p>`}
      </div>`;
  }

  /** Steps and raw response, full width — both are too wide for half a column. */
  function renderDetailPanes(runs) {
    $detailPanes.innerHTML = runs.map(({ label, result }) => {
      const steps = stepsTableHtml(result);
      const { failed } = outcomeOf(result);
      return `
        ${steps ? `<details class="ed-subsection"${failed ? " open" : ""}>
          <summary class="ed-subsection-summary">Steps · ${escapeHtml(label)}</summary>
          <div class="dt-schema">${steps}</div>
        </details>` : ""}
        <details class="ed-subsection">
          <summary class="ed-subsection-summary">Raw response · ${escapeHtml(label)}</summary>
          <pre class="ed-test-result">${escapeHtml(JSON.stringify(result, null, 2))}</pre>
        </details>`;
    }).join("");
  }

  // ── Run ───────────────────────────────────────────────
  $runBtn.addEventListener("click", async () => {
    const id = actionCtl.getValue();
    if (!id) return;

    const { inputs, errors } = collectInputs($inputFields);
    if (errors.length) {
      setStatus(`Not a number: ${errors.join(", ")}.`, "error");
      return;
    }

    const targets = target === "both" ? ["published", "draft"] : [target];

    try {
      setStatus(STATUS.testing);
      setProgress(40);
      $runBtn.disabled = true;
      $refreshBtn.disabled = true;
      clearResults();

      const runs = [];
      for (const t of targets) {
        const result = t === "draft"
          ? await gc.testDataActionDraft(api, orgId, id, inputs)
          : await gc.testDataAction(api, orgId, id, inputs);
        runs.push({ label: t === "draft" ? "Draft" : "Published", result });
      }
      setProgress(100);

      // Each block compares against the other target when both ran, so a field
      // that changed between them is marked rather than left to be spotted.
      $resultsEmpty.hidden = true;
      $resultBlocks.innerHTML = runs.map((r, i) =>
        renderResultBlock(r.label, r.result,
          runs.length === 2 ? runs[1 - i].result?.finalResult : undefined)
      ).join("");
      renderDetailPanes(runs);

      const failedRuns = runs.filter(r => outcomeOf(r.result).failed);
      if (!failedRuns.length) {
        setStatus(`✓ ${runs.length === 2 ? "Both targets" : runs[0].label} succeeded.`, "success");
      } else if (failedRuns.length === runs.length) {
        setStatus(`Test failed — see the results.`, "error");
      } else {
        setStatus(`${failedRuns[0].label} failed; the other succeeded.`, "error");
      }
      logRun(id, runs);
    } catch (err) {
      clearResults();
      setStatus(STATUS.error(err.message), "error");
    } finally {
      hideProgress();
      $runBtn.disabled = !canExecute;
      $refreshBtn.disabled = false;
    }
  });

  /**
   * Deliberately empty.
   *
   * Tests are not written to the Activity Log — that log records changes to
   * configuration, and testing is iterative, so the entries would be noise.
   * See §8 of docs/data-actions-test-design.md, which records the cost: a test
   * executes the action, so writes it causes are uncaptured. Kept as a named
   * seam so the decision is visible here rather than looking like an omission.
   */
  function logRun(/* id, runs */) {}

  // ── Boot ──────────────────────────────────────────────
  if (!orgId) {
    $noOrg.hidden = false;
    setStatus(STATUS.noOrg);
  } else {
    $main.hidden = false;
    loadActions();
  }

  return el;
}
