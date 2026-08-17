/**
 * Deployment › Test › Test Cases
 *
 * Turns a live Architect flow into a test case document — a styled Excel
 * workbook a tester works through by hand, or imports into a test management
 * tool.
 *
 * Pipeline:
 *   1. Pick an org (header selector) + a flow.
 *   2. js/lib/flowSource.js fetches the flow's structured YAML and parses it,
 *      then the dependency closure is loaded the same way (each flow discovers
 *      its own dependencies, so common module → common module chains come in).
 *   3. js/lib/flowTestCases.js walks each flow's graph into test cases at the
 *      chosen coverage level.
 *   4. Review on screen, then export the workbook.
 *
 * Every flow in the closure gets its OWN set of cases — paths are not inlined
 * across flow boundaries. See docs/test-case-design.md §6 for why.
 *
 * Read-only: nothing is written to Genesys.
 */

import { escapeHtml, exportXlsx } from "../../utils.js";
import {
  FLOW_TYPE_LABELS,
  flowTypeOrder,
  listFlows,
  indexFlows,
  loadFlow,
  discoverDepFlowIds,
} from "../../lib/flowSource.js";
import {
  COVERAGE_MODES,
  ALL_PATHS_CAP,
  generateTestCases,
  manualChecks,
} from "../../lib/flowTestCases.js";

// Colours come from the app's theme variables, never hardcoded. styles.css is
// dark by default with a light override on prefers-color-scheme, so a page that
// hardcodes dark hex values renders dark-on-dark for anyone in light mode — the
// flow picker's names were invisible until this was fixed.
const MUTED = "var(--muted)";
const BORDER = "var(--border)";

const PRIORITY_COLOR = { High: "var(--tc-high)", Medium: "var(--tc-med)", Low: "var(--tc-low)" };

/** Guard against a runaway closure; the same ceiling Flow Overview uses. */
const MAX_CLOSURE_PASSES = 500;

function slug(s) {
  return String(s || "flow").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "flow";
}

/** A short id prefix per flow, so case ids read TC-… / CM1-… across sheets. */
function prefixFor(index) {
  return index === 0 ? "TC" : `D${index}`;
}

export default function renderTestCases({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card tc-page";

  el.innerHTML = `
    <style>
      /* Dark is the app's default; the light values override it, matching how
         css/styles.css is organised. Everything else uses --text/--muted/--border
         so both themes are handled without a second set of rules. */
      .tc-page { --tc-high:#4ade80; --tc-med:#fbbf24; --tc-low:var(--muted); --tc-hover:rgba(255,255,255,.07); }
      @media (prefers-color-scheme: light) {
        .tc-page { --tc-high:#15803d; --tc-med:#b45309; --tc-hover:rgba(0,0,0,.05); }
      }

      @keyframes tc-spin { to { transform: rotate(360deg); } }
      .tc-spin { display:inline-block; width:14px; height:14px; border:2px solid var(--border);
                 border-top-color:var(--text); border-radius:50%; animation:tc-spin .8s linear infinite;
                 vertical-align:-2px; }
      .tc-wip { display:inline-block; margin-left:10px; padding:2px 9px; border-radius:999px;
                font-size:11.5px; font-weight:600; letter-spacing:.02em; vertical-align:middle;
                color:var(--tc-med); border:1px solid var(--tc-med); background:rgba(251,191,36,.10); }
      .tc-flow-combo { position:relative; }
      .tc-flow-menu { position:absolute; z-index:40; top:100%; left:0; right:0; margin-top:2px; max-height:300px;
                      overflow-y:auto; overflow-x:hidden; background:var(--panel); color:var(--text);
                      border:1px solid var(--border); border-radius:8px; box-shadow:var(--shadow); display:none; }
      .tc-flow-menu.open { display:block; }
      .tc-flow-item { padding:6px 10px; font-size:13px; cursor:pointer; color:var(--text);
                      display:flex; justify-content:space-between; gap:14px; align-items:baseline; }
      .tc-flow-item:hover, .tc-flow-item.is-active { background:var(--tc-hover); }
      /* A long flow name truncates rather than forcing the menu to scroll sideways. */
      .tc-flow-item .tc-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .tc-flow-item .tc-meta { color:var(--muted); font-size:11px; flex:none; white-space:nowrap; }
      .tc-mode { display:flex; gap:6px; }
      .tc-mode .btn.is-active { background:rgba(240,180,41,.18); border-color:rgba(240,180,41,.5); color:var(--tc-med); }
      .tc-summary { display:flex; gap:18px; flex-wrap:wrap; margin:14px 0 6px; font-size:12.5px; }
      .tc-stat { border:1px solid var(--border); border-radius:8px; padding:8px 12px; min-width:110px; }
      .tc-stat b { display:block; font-size:19px; font-weight:600; margin-bottom:2px; }
      .tc-stat span { color:var(--muted); font-size:11px; }
      .tc-findings { margin:10px 0; padding:9px 12px; border-radius:8px; font-size:12.5px; line-height:1.55;
                     border:1px solid rgba(251,191,36,.45); background:rgba(251,191,36,.10); }
      .tc-findings ul { margin:4px 0 0; padding-left:18px; }
      .tc-flowsec { margin-top:16px; border:1px solid var(--border); border-radius:8px; overflow:hidden; }
      .tc-flowhead { padding:8px 12px; background:var(--panel-2); border-bottom:1px solid var(--border);
                     display:flex; align-items:center; gap:10px; font-size:13px; }
      .tc-flowhead .tc-meta { color:var(--muted); font-size:11.5px; }
      .tc-table { width:100%; border-collapse:collapse; font-size:12.5px; }
      .tc-table th { text-align:left; padding:6px 10px; color:var(--muted); font-weight:600; font-size:11px;
                     border-bottom:1px solid var(--border); }
      .tc-table td { padding:6px 10px; border-bottom:1px solid var(--border); vertical-align:top; }
      .tc-table tr:last-child td { border-bottom:none; }
      .tc-prio { font-weight:600; }
      .tc-steps { color:var(--muted); font-size:11.5px; }
      .tc-empty { color:var(--muted); padding:18px; text-align:center; font-size:13px; }
    </style>

    <h2>Deployment — Test Cases <span class="tc-wip">Still Work in Progress</span></h2>
    <p class="page-desc">
      Generate a test case document from a live Architect flow. The org comes from
      the selector at the top of the page — pick a flow and a coverage level, and
      every path through it becomes a test case with its conditions, steps and
      expected result. Dependency flows (common modules, in-queue flows, bots) are
      found automatically and each gets its own set of cases. Export the result as
      an Excel workbook to work through by hand or import into a test tool.
      Nothing is written to Genesys.
    </p>
    <details class="page-desc" style="margin:-4px 0 14px">
      <summary style="cursor:pointer;user-select:none">How the cases are built</summary>
      <ul style="margin:8px 0 0;padding-left:18px;line-height:1.6">
        <li>A test case is one <strong>path</strong> from the flow's start to a transfer,
            a disconnect or an end. Each branch it takes — a menu choice, a Yes/No, a
            switch case, a data action's Success or Failure — becomes a condition the
            tester has to set up.</li>
        <li><strong>Conditions are stated, not solved.</strong> The document says
            <em>Flow.CustomerType == "Gold" must be true</em> rather than inventing a
            value, because Architect expressions are arbitrary.</li>
        <li><strong>Loops run once.</strong> A case that goes round a loop twice tests
            nothing the once-through case does not.</li>
        <li><strong>Branches nothing can reach</strong> are reported rather than
            skipped — usually an output wired to nothing, or a task nothing jumps to.</li>
        <li>Queues, prompts and schedules the flow resolves <strong>at run time</strong>
            by expression cannot be listed by name, so they are collected on their own
            sheet for checking by hand.</li>
      </ul>
    </details>

    <div class="dt-controls">
      <div class="dt-control-group" style="flex-direction:row;align-items:flex-end;gap:12px">
        <div style="display:flex;flex-direction:column;gap:4px">
          <label class="dt-label">Flow</label>
          <div class="tc-flow-combo" style="width:300px">
            <input class="dt-input" id="tcFlowInput" type="text" placeholder="Search a flow…" autocomplete="off" disabled style="width:300px" />
            <div class="tc-flow-menu" id="tcFlowMenu"></div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label class="dt-label">Flow type</label>
          <select class="dt-select" id="tcTypeFilter" style="width:200px" title="Filter the flow list by type" disabled>
            <option value="">All types</option>
          </select>
        </div>
      </div>
      <div class="dt-control-group">
        <label class="dt-label">Coverage</label>
        <div class="tc-mode" id="tcModes"></div>
      </div>
      <div class="dt-control-group">
        <label class="dt-label">Scope</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;font-size:12.5px"
               title="Also generate cases for every flow this one depends on, transitively">
          <input type="checkbox" id="tcIncludeDeps" checked> <span>Include dependency flows</span>
        </label>
      </div>
    </div>

    <div class="dt-actions" style="margin:0 0 6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <button class="btn" id="tcGenerate" disabled>Generate</button>
      <button class="btn btn--secondary btn-sm" id="tcExport" disabled
              title="Every generated case as a styled Excel workbook">Export Workbook</button>
      <span id="tcStatus" style="font-size:12px;color:${MUTED}"></span>
    </div>

    <div id="tcHint" style="font-size:11.5px;color:${MUTED};margin-bottom:4px"></div>
    <div id="tcResults"></div>
  `;

  const $ = (sel) => el.querySelector(sel);
  const flowInput = $("#tcFlowInput");
  const flowMenu = $("#tcFlowMenu");
  const typeFilter = $("#tcTypeFilter");
  const modesEl = $("#tcModes");
  const includeDeps = $("#tcIncludeDeps");
  const generateBtn = $("#tcGenerate");
  const exportBtn = $("#tcExport");
  const statusEl = $("#tcStatus");
  const hintEl = $("#tcHint");
  const resultsEl = $("#tcResults");

  const state = {
    orgId: "",
    flows: [],
    flowById: null,
    flowByName: null,
    flowId: "",
    mode: "branch",
    cache: new Map(),   // flowId → { data, varIndex, depIndex, actionIndex }
    reports: [],        // [{ flowId, isMain, result, data }]
    failed: [],         // flows that could not be exported, reported in the document
    busy: false,
  };

  // ── Coverage mode buttons ───────────────────────────────────────────────────
  modesEl.innerHTML = Object.values(COVERAGE_MODES)
    .map((m) => `<button class="btn btn-sm" data-mode="${escapeHtml(m.key)}" title="${escapeHtml(m.hint)}">${escapeHtml(m.label)}</button>`)
    .join("");
  const modeBtns = [...modesEl.querySelectorAll(".btn")];
  function syncModes() {
    modeBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.mode === state.mode));
    hintEl.textContent = COVERAGE_MODES[state.mode].hint
      + (state.mode === "all" ? ` Capped at ${ALL_PATHS_CAP} cases per flow.` : "");
  }
  modeBtns.forEach((b) =>
    b.addEventListener("click", () => {
      if (state.mode === b.dataset.mode) return;
      state.mode = b.dataset.mode;
      syncModes();
    })
  );
  syncModes();

  // ── Flow combobox ───────────────────────────────────────────────────────────
  let comboActive = -1;
  const openMenu = () => flowMenu.classList.add("open");
  const closeMenu = () => { flowMenu.classList.remove("open"); comboActive = -1; };

  function visibleFlows() {
    const q = (flowInput.value || "").trim().toLowerCase();
    const t = typeFilter.value;
    return state.flows.filter((f) =>
      (!t || f.type === t) &&
      (!q || f.name.toLowerCase().includes(q) || f.type.includes(q))
    );
  }

  function populateTypeFilter() {
    const types = [...new Set(state.flows.map((f) => f.type).filter(Boolean))]
      .sort((a, b) => (FLOW_TYPE_LABELS[a] || a).localeCompare(FLOW_TYPE_LABELS[b] || b));
    const cur = typeFilter.value;
    typeFilter.innerHTML = `<option value="">All types</option>`
      + types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(FLOW_TYPE_LABELS[t] || t)}</option>`).join("");
    typeFilter.value = types.includes(cur) ? cur : "";
  }

  function updatePlaceholder() {
    const t = typeFilter.value;
    const n = t ? state.flows.filter((f) => f.type === t).length : state.flows.length;
    flowInput.placeholder = `Search ${n} flow${n === 1 ? "" : "s"}…`;
  }

  function renderMenu() {
    const list = visibleFlows().slice(0, 60);
    if (!list.length) {
      flowMenu.innerHTML = `<div class="tc-flow-item" style="cursor:default;color:${MUTED}">No matching flows</div>`;
      openMenu();
      return;
    }
    flowMenu.innerHTML = list
      .map((f, i) => `<div class="tc-flow-item${i === comboActive ? " is-active" : ""}" data-id="${escapeHtml(f.id)}" title="${escapeHtml(f.name)}"><span class="tc-name">${escapeHtml(f.name)}</span><span class="tc-meta">${escapeHtml(FLOW_TYPE_LABELS[f.type] || f.type || "")}</span></div>`)
      .join("");
    flowMenu.querySelectorAll(".tc-flow-item[data-id]").forEach((it) =>
      it.addEventListener("mousedown", (e) => { e.preventDefault(); pickFlow(it.dataset.id); })
    );
    openMenu();
  }

  function pickFlow(id) {
    const f = state.flows.find((x) => x.id === id);
    if (!f) return;
    state.flowId = id;
    flowInput.value = f.name;
    closeMenu();
    generateBtn.disabled = false;
    setStatus(false, `“${f.name}” selected. Choose a coverage level and generate.`);
  }

  flowInput.addEventListener("focus", () => { if (state.flows.length) renderMenu(); });
  flowInput.addEventListener("input", () => { comboActive = -1; renderMenu(); });
  flowInput.addEventListener("keydown", (e) => {
    const items = [...flowMenu.querySelectorAll(".tc-flow-item[data-id]")];
    if (e.key === "ArrowDown") { e.preventDefault(); comboActive = Math.min(items.length - 1, comboActive + 1); renderMenu(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); comboActive = Math.max(0, comboActive - 1); renderMenu(); }
    else if (e.key === "Enter") { e.preventDefault(); const it = items[comboActive] || items[0]; if (it) pickFlow(it.dataset.id); }
    else if (e.key === "Escape") { closeMenu(); }
  });
  flowInput.addEventListener("blur", () => setTimeout(closeMenu, 150));
  typeFilter.addEventListener("change", () => {
    updatePlaceholder();
    if (flowMenu.classList.contains("open")) { comboActive = -1; renderMenu(); }
  });

  function setStatus(busy, msg) {
    statusEl.innerHTML = busy ? `<span class="tc-spin"></span> ${escapeHtml(msg || "")}` : escapeHtml(msg || "");
  }

  // ── Load + generate ─────────────────────────────────────────────────────────

  /** Fetch + parse a flow, cached. */
  async function ensureLoaded(id) {
    if (state.cache.has(id)) return state.cache.get(id);
    const entry = await loadFlow(api, state.orgId, state.flowById.get(id) || {});
    state.cache.set(id, entry);
    return entry;
  }

  /**
   * The root flow plus, optionally, every flow it depends on — transitively.
   * The work list grows as each flow is parsed, because a common module has its
   * own dependencies. A flow that cannot be exported is reported and skipped
   * rather than failing the run: a partial document that says what is missing is
   * more use than none.
   */
  async function loadClosure(rootId) {
    const order = [{ id: rootId, isMain: true }];
    const seen = new Set([rootId]);
    const failed = [];

    for (let pass = 0; pass < MAX_CLOSURE_PASSES; pass++) {
      const pending = order.filter((t) => !state.cache.has(t.id) && !failed.some((f) => f.id === t.id));
      if (!pending.length) break;
      for (const t of pending) {
        const meta = state.flowById.get(t.id) || {};
        setStatus(true, `Loading “${meta.name || t.id}”…`);
        let entry;
        try {
          entry = await ensureLoaded(t.id);
        } catch (err) {
          failed.push({ id: t.id, name: meta.name || t.id, error: err.message || String(err) });
          continue;
        }
        if (!includeDeps.checked) continue;
        for (const depId of discoverDepFlowIds(entry.data, state.flowByName, t.id)) {
          if (seen.has(depId)) continue;
          seen.add(depId);
          order.push({ id: depId, isMain: false });
        }
      }
    }

    // Root first, then supporting flows in the order a dependency list reads.
    const loaded = order.filter((t) => state.cache.has(t.id));
    loaded.sort((a, b) => {
      if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
      const fa = state.flowById.get(a.id) || {}, fb = state.flowById.get(b.id) || {};
      const ta = flowTypeOrder(fa.type), tb = flowTypeOrder(fb.type);
      if (ta !== tb) return ta - tb;
      return String(fa.name || "").localeCompare(String(fb.name || ""));
    });
    return { loaded, failed };
  }

  async function generate() {
    if (state.busy || !state.flowId) return;
    state.busy = true;
    generateBtn.disabled = true;
    exportBtn.disabled = true;
    resultsEl.innerHTML = "";
    state.reports = [];
    state.failed = [];   // a previous run's failures must not leak into this one

    try {
      const { loaded, failed } = await loadClosure(state.flowId);
      setStatus(true, "Generating test cases…");

      state.reports = loaded.map((t, i) => {
        const entry = state.cache.get(t.id);
        return {
          flowId: t.id,
          isMain: t.isMain,
          data: entry.data,
          result: generateTestCases(entry.data, { mode: state.mode, idPrefix: prefixFor(i) }),
        };
      });
      state.failed = failed;

      renderReports();
      const total = state.reports.reduce((n, r) => n + r.result.cases.length, 0);
      exportBtn.disabled = total === 0;
      setStatus(false, `${total} test case${total === 1 ? "" : "s"} across ${state.reports.length} flow${state.reports.length === 1 ? "" : "s"}.`);
    } catch (err) {
      setStatus(false, `Generation failed: ${err.message || err}`);
    } finally {
      state.busy = false;
      generateBtn.disabled = false;
    }
  }

  generateBtn.addEventListener("click", generate);

  // ── Render ──────────────────────────────────────────────────────────────────

  function renderReports() {
    const totals = state.reports.reduce(
      (acc, r) => {
        acc.cases += r.result.cases.length;
        acc.branches += r.result.coverage.branchesTotal;
        acc.covered += r.result.coverage.branchesCovered;
        acc.unreachable += r.result.coverage.uncovered.length;
        return acc;
      },
      { cases: 0, branches: 0, covered: 0, unreachable: 0 }
    );
    const pct = totals.branches ? Math.round((totals.covered / totals.branches) * 100) : 100;

    const findings = [];
    for (const r of state.reports) findings.push(...r.result.findings);
    for (const f of state.failed || []) {
      findings.push(`“${f.name}” could not be exported and has no cases: ${f.error}`);
    }

    const parts = [];
    parts.push(`
      <div class="tc-summary">
        <div class="tc-stat"><b>${totals.cases}</b><span>test cases</span></div>
        <div class="tc-stat"><b>${state.reports.length}</b><span>flows covered</span></div>
        <div class="tc-stat"><b>${pct}%</b><span>${totals.covered} of ${totals.branches} branches</span></div>
        <div class="tc-stat"><b>${totals.unreachable}</b><span>branches unreachable</span></div>
      </div>
    `);

    if (findings.length) {
      parts.push(`<div class="tc-findings"><strong>Worth a look</strong><ul>${
        findings.map((f) => `<li>${escapeHtml(f)}</li>`).join("")
      }</ul></div>`);
    }

    for (const r of state.reports) {
      const c = r.result.coverage;
      const rows = r.result.cases.map((tc) => {
        // A first-true switch contributes one condition per preceding case, so a
        // deep case can carry a dozen. The screen shows enough to recognise the
        // case; the workbook carries every one of them.
        const shown = tc.testData.slice(0, 3).join(" · ");
        const rest = tc.testData.length - 3;
        const data = tc.testData.length
          ? ` · ${escapeHtml(shown)}${rest > 0 ? ` <em>+${rest} more</em>` : ""}`
          : "";
        return `
        <tr>
          <td style="white-space:nowrap">${escapeHtml(tc.id)}</td>
          <td class="tc-prio" style="color:${PRIORITY_COLOR[tc.priority] || MUTED}">${escapeHtml(tc.priority)}</td>
          <td>${escapeHtml(tc.title)}<div class="tc-steps">${tc.steps.length} step${tc.steps.length === 1 ? "" : "s"}${data}</div></td>
          <td>${escapeHtml(tc.expected)}</td>
        </tr>`;
      }).join("");

      parts.push(`
        <div class="tc-flowsec">
          <div class="tc-flowhead">
            <strong>${escapeHtml(r.result.flow.name)}</strong>
            <span class="tc-meta">${escapeHtml(FLOW_TYPE_LABELS[r.result.flow.type] || r.result.flow.type || "")}${r.isMain ? " · main" : ""}</span>
            <span style="flex:1"></span>
            <span class="tc-meta">${r.result.cases.length} case(s) · ${c.branchesCovered}/${c.branchesTotal} branches (${c.percent}%)</span>
          </div>
          ${rows
            ? `<table class="tc-table"><thead><tr><th>ID</th><th>Priority</th><th>Scenario</th><th>Expected result</th></tr></thead><tbody>${rows}</tbody></table>`
            : `<div class="tc-empty">No cases generated for this flow.</div>`}
        </div>
      `);
    }

    resultsEl.innerHTML = parts.join("");
  }

  // ── Workbook ────────────────────────────────────────────────────────────────

  /**
   * "Nemlig_" — the selected customer, for the front of a download name. Case is
   * kept (unlike slug()) so it reads as the customer's own name, and it comes
   * out empty when no customer is resolvable rather than inventing a prefix.
   */
  function orgPrefix() {
    const details = orgContext.getDetails && orgContext.getDetails();
    const safe = String((details && details.name) || "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
    return safe ? safe + "_" : "";
  }

  exportBtn.addEventListener("click", () => {
    if (!state.reports.length) return;
    try {
      exportWorkbook();
    } catch (err) {
      setStatus(false, `Export failed: ${err.message || err}`);
    }
  });

  function exportWorkbook() {
    const rootName = state.reports[0].result.flow.name;
    const mode = COVERAGE_MODES[state.mode];

    const totals = state.reports.reduce(
      (acc, r) => {
        acc.cases += r.result.cases.length;
        acc.branches += r.result.coverage.branchesTotal;
        acc.covered += r.result.coverage.branchesCovered;
        return acc;
      },
      { cases: 0, branches: 0, covered: 0 }
    );

    // ── Summary: what this document is, and what it does NOT claim ───────────
    const summary = [
      { field: "Organisation", value: (orgContext.getDetails && orgContext.getDetails().name) || state.orgId },
      { field: "Root flow", value: rootName },
      { field: "Flow type", value: FLOW_TYPE_LABELS[state.reports[0].result.flow.type] || state.reports[0].result.flow.type },
      { field: "Flows covered", value: String(state.reports.length) },
      { field: "Coverage level", value: `${mode.label} — ${mode.hint}` },
      { field: "Test cases", value: String(totals.cases) },
      { field: "Branch coverage", value: `${totals.covered} of ${totals.branches} (${totals.branches ? Math.round((totals.covered / totals.branches) * 100) : 100}%)` },
      { field: "Generated", value: new Date().toISOString() },
      { field: "Generated by", value: (me && me.name) || "" },
      { field: "", value: "" },
      { field: "How to read this", value: "One row per test case on the Test Cases sheet; its numbered steps are on the Steps sheet. Result, Tester, Date and Notes are left empty to fill in as you go." },
      { field: "Conditions", value: "Conditions are stated, not solved. Where a case says a condition must hold, set the data up so that it does — the generator does not invent variable values." },
      { field: "Loops", value: "A path that returns to a step it has already taken is recorded as looping back and stops there. Going round twice tests nothing the once-through case does not." },
      { field: "Called tasks", value: "A Call Task with named outputs (Failure, Timeout, …) is covered as an alternative outcome. Architect does not record which of the called task's endings maps to which output, so that correlation is not claimed here." },
      { field: "Dependency flows", value: "Each flow is covered in its own right; paths are not followed across flow boundaries. A step that calls a common module names it, and that module has its own cases in this workbook." },
      { field: "Manual checks", value: "See the Manual checks sheet: queues, prompts and schedules the flow resolves at run time cannot be listed by name and need confirming by hand." },
    ];
    for (const r of state.reports) {
      for (const f of r.result.findings) summary.push({ field: "Finding", value: f });
    }
    for (const f of state.failed || []) {
      summary.push({ field: "Not covered", value: `“${f.name}” could not be exported: ${f.error}` });
    }

    // ── Cases, steps, coverage, manual checks ────────────────────────────────
    const cases = [];
    const steps = [];
    const coverage = [];
    const manual = [];

    for (const r of state.reports) {
      const flowName = r.result.flow.name;
      for (const tc of r.result.cases) {
        cases.push({
          id: tc.id,
          flow: flowName,
          priority: tc.priority,
          title: tc.title,
          entryPoint: tc.entryPoint,
          preconditions: tc.preconditions.join("\n"),
          testData: tc.testData.join("\n"),
          stepCount: tc.steps.length,
          expected: tc.expected,
          result: "",
          tester: "",
          date: "",
          notes: "",
        });
        for (const s of tc.steps) {
          steps.push({
            id: tc.id,
            flow: flowName,
            step: s.index,
            task: s.task,
            action: s.action,
            actionType: s.actionType,
            branch: s.branch,
            detail: s.detail,
          });
        }
      }
      for (const b of r.result.coverage.byBranch) {
        coverage.push({
          flow: flowName,
          branch: b.label,
          from: b.from,
          to: b.to,
          condition: b.detail,
          covered: b.cases.length ? "Yes" : "NOT REACHED",
          cases: b.cases.join(", "),
        });
      }
      for (const m of manualChecks(r.data)) manual.push(m);
    }

    exportXlsx([
      {
        name: "Summary", rows: summary,
        columns: [
          { key: "field", label: "Field", wch: 22 },
          { key: "value", label: "Value", wch: 120 },
        ],
      },
      {
        name: "Test Cases", rows: cases,
        columns: [
          { key: "id", label: "ID", wch: 10 },
          { key: "flow", label: "Flow", wch: 28 },
          { key: "priority", label: "Priority", wch: 9 },
          { key: "title", label: "Scenario", wch: 60 },
          { key: "entryPoint", label: "Entry point", wch: 20 },
          { key: "preconditions", label: "Preconditions", wch: 42 },
          { key: "testData", label: "Test data / conditions", wch: 52 },
          { key: "stepCount", label: "Steps", wch: 7 },
          { key: "expected", label: "Expected result", wch: 42 },
          { key: "result", label: "Result", wch: 12 },
          { key: "tester", label: "Tester", wch: 16 },
          { key: "date", label: "Date", wch: 12 },
          { key: "notes", label: "Notes", wch: 30 },
        ],
      },
      {
        name: "Steps", rows: steps,
        columns: [
          { key: "id", label: "Case ID", wch: 10 },
          { key: "flow", label: "Flow", wch: 28 },
          { key: "step", label: "Step", wch: 6 },
          { key: "task", label: "Task", wch: 24 },
          { key: "action", label: "Action", wch: 60 },
          { key: "actionType", label: "Action type", wch: 20 },
          { key: "branch", label: "Branch taken", wch: 22 },
          { key: "detail", label: "Condition / detail", wch: 50 },
        ],
      },
      {
        name: "Coverage", rows: coverage,
        columns: [
          { key: "flow", label: "Flow", wch: 28 },
          { key: "branch", label: "Branch", wch: 22 },
          { key: "from", label: "From", wch: 40 },
          { key: "to", label: "To", wch: 40 },
          { key: "condition", label: "Condition", wch: 50 },
          { key: "covered", label: "Covered", wch: 12 },
          { key: "cases", label: "By case(s)", wch: 30 },
        ],
      },
      {
        name: "Manual checks", rows: manual,
        columns: [
          { key: "flow", label: "Flow", wch: 28 },
          { key: "kind", label: "Kind", wch: 18 },
          { key: "expression", label: "Resolved at run time by", wch: 55 },
          { key: "task", label: "Task", wch: 24 },
          { key: "action", label: "Action", wch: 30 },
        ],
      },
    ], `${orgPrefix()}${slug(rootName)}-test-cases.xlsx`);

    setStatus(false, `Exported ${totals.cases} test case(s) across ${state.reports.length} flow(s).`);
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  async function init() {
    state.orgId = orgContext.get();
    if (!state.orgId) {
      resultsEl.innerHTML = `<div class="tc-empty">Select an organisation in the selector at the top of the page.</div>`;
      return;
    }
    setStatus(true, "Loading flow list…");
    try {
      const flows = await listFlows(api, state.orgId);
      const { byId, byName } = indexFlows(flows);
      state.flows = flows;
      state.flowById = byId;
      state.flowByName = byName;
      flowInput.disabled = false;
      typeFilter.disabled = false;
      populateTypeFilter();
      updatePlaceholder();
      setStatus(false, "Pick a flow to generate test cases for.");
    } catch (err) {
      setStatus(false, `Error loading flows: ${err.message || err}`);
    }
  }

  init();

  return el;
}
