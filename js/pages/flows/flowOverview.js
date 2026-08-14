/**
 * Flows › Flow Overview
 *
 * Read-only graphical overview of a Genesys Architect flow and all its
 * dependencies, with three detail levels and a variable / dependency cross-
 * reference search that can jump straight to the node that uses a value.
 *
 * Pipeline:
 *   1. Pick an org + a flow.
 *   2. GET /api/v2/flows/{id}/latestconfiguration  → full flow config JSON.
 *   3. js/lib/flowModel.js normalizes it into nodes/edges + variable and
 *      dependency indexes (renderer-agnostic).
 *   4. js/lib/flowLayout.js lays it out with ELK (layered, hierarchical).
 *   5. This module draws interactive SVG (pan / zoom / click) and a side panel,
 *      and exports the diagram (SVG / PNG / HTML / JSON).
 *
 * Detail levels:
 *   High — every task (as a container) with every action and all branches.
 *   Mid  — one node per task + one per dependency; task jumps + dependency use.
 *   Low  — the flow + its direct dependencies.
 */

import { escapeHtml } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import {
  parseFlowYaml,
  buildModel,
  buildVariableIndex,
  buildDependencyIndex,
  buildActionIndex,
  ACTION_KINDS,
} from "../../lib/flowYaml.js";
import { layoutModel } from "../../lib/flowLayout.js";

const SVGNS = "http://www.w3.org/2000/svg";

// Visual palette (explicit colours so exported standalone SVG renders anywhere).
const CANVAS_BG = "#0d1117";
const NODE_FILL = "#161b22";
const NODE_STROKE = "#30363d";
const NODE_TEXT = "#c9d1d9";
const NODE_SUBTEXT = "#8b949e";
const CONTAINER_STROKE = "#3d444d";
const CONTAINER_HEADER = "#21262d";
const EDGE_COLOR = "#6e7681";
const EDGE_LABEL = "#8b949e";
const JUMP_COLOR = "#8957e5";
const DEP_COLOR = "#2c8a9a";
const SELECT_COLOR = "#f0b429";
const START_STROKE = "#2ea043";

// Canvas colour themes (neutrals only; the accent hues jump/dep/select/start read
// on any background). Switchable at runtime and used by exports so diagrams print
// cleanly on white.
const THEMES = {
  dark:  { bg: "#0d1117", nodeFill: "#161b22", nodeStroke: "#30363d", text: "#c9d1d9", subText: "#8b949e", containerStroke: "#3d444d", containerHeader: "#21262d", edge: "#6e7681", edgeLabel: "#8b949e" },
  light: { bg: "#f6f8fa", nodeFill: "#ffffff", nodeStroke: "#d0d7de", text: "#1f2328", subText: "#57606a", containerStroke: "#aeb6bf", containerHeader: "#eaeef2", edge: "#6e7681", edgeLabel: "#57606a" },
  white: { bg: "#ffffff", nodeFill: "#ffffff", nodeStroke: "#c2c9d1", text: "#1f2328", subText: "#57606a", containerStroke: "#c2c9d1", containerHeader: "#eef1f4", edge: "#5a636d", edgeLabel: "#57606a" },
};

function kindColor(kind) {
  if (kind === "task") return "#6e7681";
  return (ACTION_KINDS[kind] && ACTION_KINDS[kind].color) || "#4a6fa5";
}
function kindLabel(kind) {
  if (kind === "task") return "Task";
  return (ACTION_KINDS[kind] && ACTION_KINDS[kind].label) || kind;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function truncate(str, max) {
  str = String(str || "");
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function download(filename, b64, onError) {
  // Downloads in this app go through the shared download.html helper page (direct
  // anchor-click blob downloads are blocked in the hosting environment). The
  // helper reads base64 payloads from window._xlsxDownload and offers a native
  // Save dialog.
  const key = "flowovw_" + Date.now() + "_" + Math.random().toString(36).slice(2);
  window._xlsxDownload = window._xlsxDownload || {};
  window._xlsxDownload[key] = { filename, b64 };
  const helperUrl = new URL("download.html", document.baseURI);
  helperUrl.hash = key;
  const popup = window.open(helperUrl.href, "_blank");
  if (!popup) {
    delete window._xlsxDownload[key];
    if (onError) onError("Pop-up blocked. Please allow pop-ups for this site.");
  }
}

/** Base64-encode a UTF-8 string (svg / html / json payloads). */
function textToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function slug(s) {
  return String(s || "flow").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "flow";
}

/**
 * Pick a raster scale that keeps the export canvas within browser limits.
 * Large flow diagrams can be many thousands of px wide; at a naive 2× scale the
 * canvas exceeds the per-dimension (~16k) and total-area caps and renders as
 * corrupted stripes. Cap each side and the total area, aiming for 2× when it fits.
 */
function rasterScale(w, h) {
  const MAX_DIM = 8000;
  const MAX_AREA = 24e6;
  let s = 2;
  s = Math.min(s, MAX_DIM / w, MAX_DIM / h, Math.sqrt(MAX_AREA / (w * h)));
  return Math.max(0.25, s);
}

// Matches a Genesys/GUID identifier anywhere in a serialized config (used to
// discover dependency-flow references that the manifest doesn't enumerate).
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const FLOW_TYPE_LABELS = {
  inboundcall: "Inbound Call", inboundchat: "Inbound Chat", inboundemail: "Inbound Email",
  inboundshortmessage: "Inbound Message", bot: "Bot", digitalbot: "Digital Bot",
  commonmodule: "Common Module", inqueuecall: "In-Queue Call", inqueueemail: "In-Queue Email",
  inqueueshortmessage: "In-Queue Message", securecall: "Secure Call", voicemail: "Voicemail",
  workflow: "Workflow", workitem: "Workitem", voicesurvey: "Voice Survey",
  surveyinvite: "Survey Invite", outboundcall: "Outbound Call",
};

function flowTypeOrder(t) {
  const order = ["commonmodule", "inqueuecall", "inqueueemail", "inqueueshortmessage", "workflow",
    "bot", "digitalbot", "voicesurvey", "surveyinvite", "securecall", "voicemail", "workitem"];
  const i = order.indexOf(t);
  return i === -1 ? 99 : i;
}

export default function renderFlowOverview({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <style>
      @keyframes fo-spin { to { transform: rotate(360deg); } }
      .fo-spin { display:inline-block; width:14px; height:14px; border:2px solid rgba(255,255,255,.25);
                 border-top-color:#fff; border-radius:50%; animation:fo-spin .8s linear infinite; }
      .fo-layout { display:flex; gap:12px; align-items:stretch; height:78vh; min-height:460px; }
      .fo-layout:fullscreen { height:100vh; min-height:0; background:#0d1117; padding:10px; box-sizing:border-box; }
      .fo-layout.fo-max { position:fixed; inset:0; z-index:9999; height:auto; background:#0d1117; padding:10px; box-sizing:border-box; }
      .fo-canvas-wrap { position:relative; flex:1; min-width:0; display:flex; flex-direction:column; }
      .fo-canvas { flex:1; min-height:0; border:1px solid ${NODE_STROKE}; border-radius:8px;
                   overflow:hidden; background:${CANVAS_BG}; position:relative; }
      .fo-canvas svg { width:100%; height:100%; display:block; }
      .fo-empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
                  color:${NODE_SUBTEXT}; font-size:14px; text-align:center; padding:20px; }
      .fo-empty[hidden] { display:none; }
      .fo-tabs { display:flex; gap:4px; overflow-x:auto; padding:0 0 6px; align-items:flex-end; min-height:0; }
      .fo-tab { flex:none; display:inline-flex; align-items:center; gap:6px; padding:5px 10px; font-size:12px;
                border:1px solid ${NODE_STROKE}; border-radius:6px 6px 0 0; background:rgba(255,255,255,.02);
                color:${NODE_SUBTEXT}; cursor:pointer; white-space:nowrap; }
      .fo-tab:hover { background:rgba(255,255,255,.06); }
      .fo-tab.is-active { color:${NODE_TEXT}; background:rgba(240,180,41,.12); border-color:rgba(240,180,41,.4); }
      .fo-tab.is-main { border-bottom-color:${START_STROKE}; }
      .fo-tab[disabled] { opacity:.45; cursor:not-allowed; }
      .fo-tab-badge { font-size:9.5px; padding:1px 5px; border-radius:8px; border:1px solid ${NODE_STROKE}; color:${NODE_SUBTEXT}; }
      .fo-side { width:340px; flex:none; display:flex; flex-direction:column; gap:10px; }
      .fo-side-box { border:1px solid ${NODE_STROKE}; border-radius:8px; background:rgba(255,255,255,.02);
                     display:flex; flex-direction:column; min-height:0; }
      .fo-side-head { padding:8px 10px; font-weight:600; font-size:13px; border-bottom:1px solid ${NODE_STROKE};
                      display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .fo-search { flex:1 1 0; min-height:0; }
      .fo-results { overflow:auto; flex:1; min-height:0; }
      .fo-detail { flex:1 1 0; min-height:0; }
      .fo-row { padding:6px 10px; border-bottom:1px solid rgba(255,255,255,.05); cursor:pointer; font-size:12.5px; }
      .fo-row:hover { background:rgba(255,255,255,.05); }
      .fo-row .fo-name { color:${NODE_TEXT}; }
      .fo-row .fo-meta { color:${NODE_SUBTEXT}; font-size:11px; }
      .fo-chip { display:inline-block; padding:1px 6px; border-radius:10px; font-size:10.5px; line-height:1.6;
                 border:1px solid ${NODE_STROKE}; color:${NODE_SUBTEXT}; }
      .fo-detail-body { padding:10px; font-size:12.5px; color:${NODE_TEXT}; flex:1; overflow:auto; }
      .fo-detail-body h4 { margin:0 0 4px; font-size:13px; }
      .fo-detail-body .fo-sub { color:${NODE_SUBTEXT}; font-size:11.5px; margin-bottom:8px; }
      .fo-detail-body code { background:rgba(255,255,255,.06); padding:1px 4px; border-radius:4px; font-size:11.5px; }
      .fo-usage { padding:5px 8px; border:1px solid ${NODE_STROKE}; border-radius:6px; margin:4px 0; cursor:pointer; }
      .fo-usage:hover { background:rgba(255,255,255,.05); }
      .fo-legend { display:flex; flex-wrap:wrap; gap:6px 12px; padding:8px 10px; }
      .fo-legend span { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:${NODE_SUBTEXT}; }
      .fo-legend i { width:11px; height:11px; border-radius:3px; display:inline-block; }
      .fo-hint { color:${NODE_SUBTEXT}; font-size:11px; padding:0 10px 8px; }
      .fo-level .btn.is-active { background:rgba(240,180,41,.18); border-color:rgba(240,180,41,.4); color:#f0b429; }
      .fo-search .dt-input { max-width:none; width:100%; box-sizing:border-box; }
      .fo-flow-combo { position:relative; }
      .fo-flow-menu { position:absolute; z-index:40; top:100%; left:0; right:0; margin-top:2px; max-height:300px;
                      overflow:auto; background:#161b22; border:1px solid ${NODE_STROKE}; border-radius:8px; display:none; }
      .fo-flow-menu.open { display:block; }
      .fo-flow-item { padding:6px 10px; font-size:13px; cursor:pointer; color:${NODE_TEXT}; white-space:nowrap; }
      .fo-flow-item:hover, .fo-flow-item.is-active { background:rgba(240,180,41,.15); }
      .fo-flow-item .fo-meta { color:${NODE_SUBTEXT}; font-size:11px; }
    </style>

    <h2>Flows — Flow Overview</h2>
    <p class="page-desc">
      Visualise an Architect flow and everything it depends on. The org comes from the
      selector at the top of the page — pick a flow, choose a detail level, then
      explore the diagram. Dependency flows (common modules, in-queue, workflows,
      bots…) open in their own tabs. Use the search to find a variable or dependency
      and jump straight to the node that uses it, and save the overview as an image,
      a self-contained HTML page, or JSON.
    </p>

    <div class="dt-controls">
      <div class="dt-control-group">
        <label class="dt-label">Flow</label>
        <div class="fo-flow-combo" style="width:300px">
          <input class="dt-input" id="foFlowInput" type="text" placeholder="Search a flow…" autocomplete="off" disabled style="width:300px" />
          <div class="fo-flow-menu" id="foFlowMenu"></div>
        </div>
      </div>
      <div class="dt-control-group">
        <label class="dt-label">Detail level</label>
        <div class="fo-level" style="display:flex;gap:6px">
          <button class="btn btn-sm" data-level="high">High</button>
          <button class="btn btn-sm" data-level="mid">Mid</button>
          <button class="btn btn-sm" data-level="low">Low</button>
        </div>
      </div>
      <div class="dt-actions" style="margin-bottom:12px;display:flex;align-items:flex-end;gap:8px">
        <span id="foStatus" style="font-size:12px;color:${NODE_SUBTEXT}"></span>
      </div>
    </div>

    <div class="dt-actions" style="margin:0 0 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <button class="btn btn--secondary btn-sm" id="foZoomOut" disabled title="Zoom out">−</button>
      <button class="btn btn--secondary btn-sm" id="foZoomIn" disabled title="Zoom in">+</button>
      <button class="btn btn--secondary btn-sm" id="foFit" disabled>Fit</button>
      <button class="btn btn--secondary btn-sm" id="foFullscreen" disabled title="Fullscreen">⛶ Fullscreen</button>
      <label style="font-size:11px;color:${NODE_SUBTEXT};display:inline-flex;align-items:center;gap:4px">Background
        <select class="dt-select" id="foTheme" style="padding:3px 6px;font-size:12px">
          <option value="dark">Dark</option><option value="light">Light</option><option value="white">White</option>
        </select>
      </label>
      <span style="font-size:11px;color:${NODE_SUBTEXT}">Scroll to zoom · drag to pan · click a line to trace it</span>
      <span style="flex:1"></span>
      <button class="btn btn--secondary btn-sm" id="foSavePdf" disabled>Save PDF</button>
      <button class="btn btn--secondary btn-sm" id="foSaveHtml" disabled>Save HTML</button>
      <button class="btn btn--secondary btn-sm" id="foSaveJson" disabled>Save JSON</button>
      <span style="width:1px;height:20px;background:${NODE_STROKE};margin:0 3px"></span>
      <span style="font-size:11px;color:${NODE_SUBTEXT}">All flows:</span>
      <button class="btn btn--secondary btn-sm" id="foSaveAllPdf" disabled title="Root flow + every dependency flow (auto-loaded, transitive) as one multi-page PDF">PDF</button>
      <button class="btn btn--secondary btn-sm" id="foSaveAllHtml" disabled title="Root flow + every dependency flow (auto-loaded, transitive) as one HTML file with tabs">HTML</button>
      <button class="btn btn--secondary btn-sm" id="foSaveAllJson" disabled title="Root flow + every dependency flow (auto-loaded, transitive) bundled into one JSON file">JSON</button>
    </div>

    <div class="fo-layout">
      <div class="fo-canvas-wrap">
        <div class="fo-tabs" id="foTabs"></div>
        <div class="fo-canvas" id="foCanvas">
          <div class="fo-empty" id="foEmpty">Select a flow above to begin.</div>
        </div>
        <div class="fo-legend" id="foLegend"></div>
      </div>
      <div class="fo-side">
        <div class="fo-side-box fo-detail">
          <div class="fo-side-head">Details</div>
          <div class="fo-detail-body" id="foDetail"><div class="fo-sub">Select a node, variable or dependency.</div></div>
        </div>
        <div class="fo-side-box fo-search">
          <div class="fo-side-head">Search <span id="foSearchCount" class="fo-chip">—</span></div>
          <div style="padding:8px 10px"><input class="dt-input" id="foSearchInput" type="text" placeholder="Variable or dependency…" style="width:100%" disabled /></div>
          <div class="fo-hint">Click a result, then a usage, to jump to the node.</div>
          <div class="fo-results" id="foResults"></div>
        </div>
      </div>
    </div>
  `;

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const $ = (id) => el.querySelector(id);
  const flowInput = $("#foFlowInput");
  const flowMenu = $("#foFlowMenu");
  const statusEl = $("#foStatus");
  const canvas = $("#foCanvas");
  const layoutEl = $(".fo-layout");
  const tabsEl = $("#foTabs");
  const emptyEl = $("#foEmpty");
  const legendEl = $("#foLegend");
  const themeSel = $("#foTheme");
  const fullscreenBtn = $("#foFullscreen");
  const searchInput = $("#foSearchInput");
  const searchCount = $("#foSearchCount");
  const resultsEl = $("#foResults");
  const detailEl = $("#foDetail");
  const levelBtns = [...el.querySelectorAll(".fo-level .btn")];
  const exportBtns = ["#foZoomOut", "#foZoomIn", "#foFit", "#foFullscreen", "#foSavePdf", "#foSaveHtml", "#foSaveJson", "#foSaveAllPdf", "#foSaveAllHtml", "#foSaveAllJson"].map($);

  // ── State ───────────────────────────────────────────────────────────────────
  const state = {
    orgId: "",
    flows: [],
    flowId: "",
    flowName: "",
    level: "high",
    themeName: "dark",
    flowList: null,
    flowByName: null,
    tabs: [],
    cache: new Map(),
    activeId: null,
    data: null,
    model: null,
    varIndex: null,
    depIndex: null,
    actionIndex: null,
    laid: null,
    selectedId: null,
    selectedEdgeId: null,
    hlNodes: new Set(),
    vp: { s: 1, tx: 0, ty: 0 },
    svg: null,
    vpG: null,
    overlayG: null,
  };

  levelBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.level === state.level));

  // ── Flow combobox (searchable) ──────────────────────────────────────────────
  let comboActive = -1;
  const openMenu = () => flowMenu.classList.add("open");
  const closeMenu = () => { flowMenu.classList.remove("open"); comboActive = -1; };

  function renderMenu() {
    const q = (flowInput.value || "").trim().toLowerCase();
    const list = state.flows
      .filter((f) => !q || f.name.toLowerCase().includes(q) || f.type.includes(q))
      .slice(0, 60);
    if (!list.length) {
      flowMenu.innerHTML = `<div class="fo-flow-item" style="cursor:default;color:${NODE_SUBTEXT}">No matching flows</div>`;
      openMenu();
      return;
    }
    flowMenu.innerHTML = list
      .map((f, i) => `<div class="fo-flow-item${i === comboActive ? " is-active" : ""}" data-id="${escapeHtml(f.id)}">${escapeHtml(f.name)} <span class="fo-meta">${escapeHtml(FLOW_TYPE_LABELS[f.type] || f.type || "")}</span></div>`)
      .join("");
    flowMenu.querySelectorAll(".fo-flow-item[data-id]").forEach((it) =>
      it.addEventListener("mousedown", (e) => { e.preventDefault(); pickFlow(it.dataset.id); })
    );
    openMenu();
  }

  function pickFlow(id) {
    const f = state.flows.find((x) => x.id === id);
    if (!f) return;
    state.flowId = id;
    state.flowName = f.name;
    flowInput.value = f.name;
    closeMenu();
    loadRootFlow(id);
  }

  flowInput.addEventListener("focus", () => { if (state.flows.length) renderMenu(); });
  flowInput.addEventListener("input", () => { comboActive = -1; renderMenu(); });
  flowInput.addEventListener("keydown", (e) => {
    const items = [...flowMenu.querySelectorAll(".fo-flow-item[data-id]")];
    if (e.key === "ArrowDown") { e.preventDefault(); comboActive = Math.min(items.length - 1, comboActive + 1); renderMenu(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); comboActive = Math.max(0, comboActive - 1); renderMenu(); }
    else if (e.key === "Enter") { e.preventDefault(); const it = items[comboActive] || items[0]; if (it) pickFlow(it.dataset.id); }
    else if (e.key === "Escape") { closeMenu(); }
  });
  flowInput.addEventListener("blur", () => setTimeout(closeMenu, 150));

  // ── Level toggle ────────────────────────────────────────────────────────────
  levelBtns.forEach((b) =>
    b.addEventListener("click", async () => {
      if (state.level === b.dataset.level) return;
      state.level = b.dataset.level;
      levelBtns.forEach((x) => x.classList.toggle("is-active", x === b));
      if (state.data) await rebuild();
    })
  );

  // ── Theme (canvas background) ───────────────────────────────────────────────
  themeSel.addEventListener("change", () => {
    state.themeName = themeSel.value;
    if (state.laid) renderGraph();
  });

  // ── Fullscreen / maximize ───────────────────────────────────────────────────
  function refitSoon() {
    requestAnimationFrame(() => { if (state.svg) { updateViewBox(); fitToView(); } });
  }
  function setMaximized(on) {
    layoutEl.classList.toggle("fo-max", on);
    fullscreenBtn.textContent = on ? "⤢ Exit" : "⛶ Fullscreen";
    refitSoon();
  }
  async function enterFullscreen() {
    // Prefer true OS fullscreen; fall back to an in-app maximise overlay when the
    // Fullscreen API is unavailable or blocked (embedded webviews, policies, …).
    const req = layoutEl.requestFullscreen || layoutEl.webkitRequestFullscreen;
    if (document.fullscreenEnabled && req) {
      try { await req.call(layoutEl); return; } catch (_) { /* fall through */ }
    }
    setMaximized(true);
  }
  function exitFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
    else setMaximized(false);
  }
  fullscreenBtn.addEventListener("click", () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl === layoutEl || layoutEl.classList.contains("fo-max")) exitFullscreen();
    else enterFullscreen();
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreenBtn.textContent = document.fullscreenElement === layoutEl ? "⤢ Exit" : "⛶ Fullscreen";
    refitSoon();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && layoutEl.classList.contains("fo-max")) setMaximized(false);
  });
  const canvasRO = new ResizeObserver(() => { if (state.svg) updateViewBox(); });
  canvasRO.observe(canvas);

  function updateViewBox() {
    if (!state.svg) return;
    const W = canvas.clientWidth || 900;
    const H = canvas.clientHeight || 700;
    state.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  }

  // ── Init: org from the header selector, then load the flow list ─────────────
  async function init() {
    state.orgId = orgContext.get();
    if (!state.orgId) {
      emptyEl.hidden = false;
      emptyEl.innerHTML = `Select an organisation in the selector at the top of the page.`;
      return;
    }
    setBusy(true, "Loading flow list…");
    try {
      const flows = await gc.fetchAllFlows(api, state.orgId, { query: { pageSize: "100" } });
      const norm = (flows || [])
        .filter((f) => f.id && f.name)
        .map((f) => ({ id: f.id, name: f.name, type: (f.type || "").toLowerCase() }))
        .sort((a, b) => a.name.localeCompare(b.name));
      state.flows = norm;
      state.flowList = new Map(norm.map((f) => [f.id, f]));
      state.flowByName = new Map(norm.map((f) => [f.name, f]));
      flowInput.disabled = false;
      flowInput.placeholder = `Search ${norm.length} flows…`;
      setBusy(false, "Pick a flow to visualise.");
    } catch (err) {
      setBusy(false, `Error loading flows: ${err.message || err}`);
    }
  }

  /** Set a new root flow: reset tabs/cache, then load it + its dependencies. */
  async function loadRootFlow(flowId) {
    if (!state.flowList) return;
    state.cache = new Map();
    const rootMeta = state.flowList.get(flowId) || {};
    state.tabs = [{ id: flowId, name: rootMeta.name || state.flowName || "Flow", type: rootMeta.type || "", isMain: true, available: true }];
    state.activeId = null;
    renderTabs();
    await activateTab(flowId);
  }

  /** Fetch YAML + parse + index a flow (cached). Also merges its dependency tabs. */
  async function ensureFlowLoaded(id) {
    if (state.cache.has(id)) return state.cache.get(id);
    const meta = state.flowList.get(id) || {};
    const resp = await api.appRequest("/api/flow-yaml", {
      method: "POST",
      body: { orgId: state.orgId, flowName: meta.name, flowType: meta.type },
    });
    if (!resp || !resp.yaml) throw new Error((resp && resp.error) || "no YAML returned");
    if (!window.jsyaml) throw new Error("YAML parser not loaded (js/lib/js-yaml.min.js).");
    const root = window.jsyaml.load(resp.yaml);
    const data = parseFlowYaml(root);
    const entry = {
      data,
      varIndex: buildVariableIndex(data),
      depIndex: buildDependencyIndex(data),
      actionIndex: buildActionIndex(data),
    };
    state.cache.set(id, entry);
    mergeDeps(id, data);
    return entry;
  }

  /** Discover dependency FLOW ids from parsed YAML data (any flow-type ref). */
  function discoverDepFlowIds(data, selfId) {
    const ids = new Set();
    for (const dep of data.dependencies || []) {
      const f = state.flowByName && state.flowByName.get(dep.name);
      if (f && f.id !== selfId) ids.add(f.id);
    }
    return [...ids];
  }

  /** Add any newly discovered dependency flows as tabs (transitive closure). */
  function mergeDeps(id, data) {
    const have = new Set(state.tabs.map((t) => t.id));
    let added = false;
    for (const depId of discoverDepFlowIds(data, id)) {
      if (have.has(depId)) continue;
      const f = state.flowList.get(depId);
      state.tabs.push({ id: depId, name: f ? f.name : depId, type: f ? f.type : "", isMain: false, available: true });
      have.add(depId);
      added = true;
    }
    if (added) {
      state.tabs.sort((a, b) => {
        if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
        const ta = flowTypeOrder(a.type), tb = flowTypeOrder(b.type);
        if (ta !== tb) return ta - tb;
        return (a.name || "").localeCompare(b.name || "");
      });
      renderTabs();
    }
  }

  function renderTabs() {
    if (!state.tabs || !state.tabs.length) { tabsEl.innerHTML = ""; return; }
    tabsEl.innerHTML = state.tabs
      .map((t) => {
        const active = t.id === state.activeId ? " is-active" : "";
        const main = t.isMain ? " is-main" : "";
        const badge = t.isMain ? "Main" : (FLOW_TYPE_LABELS[t.type] || t.type || "flow");
        const spin = t.loading ? `<span class="fo-spin" style="width:10px;height:10px"></span>` : "";
        const dis = t.available === false ? " disabled" : "";
        return `<div class="fo-tab${active}${main}" data-id="${escapeHtml(t.id)}"${dis} title="${escapeHtml(t.name)}">${spin}<span>${escapeHtml(truncate(t.name, 28))}</span><span class="fo-tab-badge">${escapeHtml(badge)}</span></div>`;
      })
      .join("");
    tabsEl.querySelectorAll(".fo-tab").forEach((tb) => {
      if (tb.hasAttribute("disabled")) return;
      tb.addEventListener("click", () => { const id = tb.dataset.id; if (id !== state.activeId) activateTab(id); });
    });
  }

  /** Switch to a flow tab, lazily fetching + laying it out. */
  async function activateTab(id) {
    state.activeId = id;
    const tab = state.tabs.find((t) => t.id === id);
    if (tab) tab.loading = true;
    renderTabs();
    setBusy(true, `Loading “${tab ? tab.name : id}”…`);
    try {
      const entry = await ensureFlowLoaded(id);
      state.data = entry.data;
      state.varIndex = entry.varIndex;
      state.depIndex = entry.depIndex;
      state.actionIndex = entry.actionIndex;
      if (tab) { tab.loading = false; tab.available = true; }
      searchInput.disabled = false;
      searchInput.value = "";
      renderSearch("");
      detailEl.innerHTML = `<div class="fo-sub">Select a node, line, variable or dependency.</div>`;
      await rebuild();
      renderTabs();
      const deps = state.tabs.length - 1;
      setBusy(false, `“${entry.data.meta.name}” — ${entry.varIndex.size} variables, ${entry.depIndex.size} dependencies${deps ? ` · ${deps} dependent flow(s)` : ""}`);
    } catch (err) {
      if (tab) { tab.loading = false; tab.available = false; }
      renderTabs();
      setBusy(false, `Error loading flow: ${err.message || err}`);
    }
  }

  /** Open (or add then open) a dependency flow's tab. */
  function openFlowTab(id) {
    if (!state.flowList || !state.flowList.has(id)) return;
    if (!state.tabs.some((t) => t.id === id)) {
      const f = state.flowList.get(id);
      state.tabs.push({ id, name: f.name, type: f.type, isMain: false, available: true });
      renderTabs();
    }
    activateTab(id);
  }

  function setBusy(busy, msg) {
    statusEl.innerHTML = busy ? `<span class="fo-spin"></span> ${escapeHtml(msg || "")}` : escapeHtml(msg || "");
  }

  async function rebuild() {
    statusEl.innerHTML = `<span class="fo-spin"></span> Laying out (${state.level})…`;
    try {
      state.model = buildModel(state.data, { level: state.level });
      state.laid = await layoutModel(state.model);
      state.selectedId = null;
      state.selectedEdgeId = null;
      state.hlNodes = new Set();
      renderGraph();
      renderLegend();
      exportBtns.forEach((b) => (b.disabled = false));
      const w = state.model.warnings || [];
      statusEl.textContent = `“${state.data.meta.name}” · ${state.level} · ${state.model.nodes.length} nodes, ${state.model.edges.length} edges${w.length ? " · " + w.join(" ") : ""}`;
    } catch (err) {
      statusEl.textContent = `Layout error: ${err.message || err}`;
    }
  }

  // ── Graph rendering ─────────────────────────────────────────────────────────
  /** Active canvas colour palette. */
  function tc() { return THEMES[state.themeName] || THEMES.dark; }

  function renderGraph() {
    emptyEl.hidden = true;
    canvas.querySelector("svg")?.remove();
    const th = tc();
    canvas.style.background = th.bg;

    const W = canvas.clientWidth || 900;
    const H = canvas.clientHeight || 700;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });
    svg.style.cursor = "grab";

    const defs = svgEl("defs");
    defs.appendChild(arrowMarker("fo-arrow", th.edge));
    defs.appendChild(arrowMarker("fo-arrow-jump", JUMP_COLOR));
    defs.appendChild(arrowMarker("fo-arrow-dep", DEP_COLOR));
    defs.appendChild(arrowMarker("fo-arrow-hl", SELECT_COLOR));
    svg.appendChild(defs);

    const vpG = svgEl("g");
    svg.appendChild(vpG);
    state.svg = svg;
    state.vpG = vpG;

    drawGraph(vpG, state.laid, state.selectedId, true);
    const overlayG = svgEl("g");
    vpG.appendChild(overlayG);
    state.overlayG = overlayG;
    canvas.appendChild(svg);

    fitToView();
    attachPanZoom(svg);
  }

  function drawGraph(root, laid, selectedId, interactive) {
    const edgeG = svgEl("g");
    root.appendChild(edgeG);
    for (const e of laid.edges) drawEdge(edgeG, e, interactive);

    const nodeG = svgEl("g");
    root.appendChild(nodeG);
    // Draw containers first so action nodes sit on top.
    const containers = laid.nodes.filter((n) => n.isContainer);
    const rest = laid.nodes.filter((n) => !n.isContainer);
    for (const n of containers) drawNode(nodeG, n, selectedId, interactive);
    for (const n of rest) drawNode(nodeG, n, selectedId, interactive);
  }

  function edgeColor(kind) {
    return kind === "jump" ? JUMP_COLOR : kind === "dep" ? DEP_COLOR : tc().edge;
  }
  function edgeMarker(kind) {
    return kind === "jump" ? "fo-arrow-jump" : kind === "dep" ? "fo-arrow-dep" : "fo-arrow";
  }
  function edgePathD(pts) {
    return "M " + pts.map((p) => `${p.x} ${p.y}`).join(" L ");
  }

  function drawEdge(g, e, interactive) {
    const pts = e.points || [];
    if (pts.length < 2) return;
    const d = edgePathD(pts);
    const path = svgEl("path", {
      d,
      fill: "none",
      stroke: edgeColor(e.kind),
      "stroke-width": "1.4",
      "marker-end": `url(#${edgeMarker(e.kind)})`,
    });
    if (e.kind === "jump" || e.kind === "dep") path.setAttribute("stroke-dasharray", "5 4");
    path.setAttribute("id", `fo-edge-${cssId(e.id)}`);
    g.appendChild(path);

    if (interactive) {
      // Wide transparent hit path so the thin line is easy to click.
      const hit = svgEl("path", { d, fill: "none", stroke: "transparent", "stroke-width": "12" });
      hit.style.cursor = "pointer";
      hit.style.pointerEvents = "stroke";
      hit.addEventListener("click", (ev) => { ev.stopPropagation(); selectEdge(e); });
      const title = svgEl("title");
      title.textContent = `${nodeDisplay(e.source).title} → ${nodeDisplay(e.target).title}`;
      hit.appendChild(title);
      g.appendChild(hit);
    }

    if (e.label && e.kind === "flow") {
      const mid = pts[Math.floor(pts.length / 2)];
      const t = svgEl("text", {
        x: mid.x + 4,
        y: mid.y - 3,
        fill: tc().edgeLabel,
        "font-size": "10",
        "font-family": "system-ui, sans-serif",
      });
      t.textContent = truncate(e.label, 22);
      g.appendChild(t);
    }
  }

  function drawNode(g, n, selectedId, interactive) {
    const gg = svgEl("g", { transform: `translate(${n.x},${n.y})`, id: `fo-node-${cssId(n.id)}` });
    const selected = n.id === selectedId;
    const color = kindColor(n.kind);
    const th = tc();

    if (n.isContainer) {
      gg.appendChild(svgEl("rect", {
        width: n.w, height: n.h, rx: 8,
        fill: "none",
        stroke: selected ? SELECT_COLOR : (n.isStart ? START_STROKE : th.containerStroke),
        "stroke-width": selected ? 2.5 : 1.2,
        "stroke-dasharray": "2 3",
      }));
      gg.appendChild(svgEl("rect", { width: n.w, height: 26, rx: 8, fill: th.containerHeader }));
      gg.appendChild(svgEl("rect", { y: 18, width: n.w, height: 8, fill: th.containerHeader }));
      const ht = svgEl("text", { x: 10, y: 17, fill: th.text, "font-size": "12.5", "font-weight": "600", "font-family": "system-ui, sans-serif" });
      ht.textContent = truncate((n.isStart ? "▶ " : "") + n.label, Math.max(6, Math.floor(n.w / 8)));
      gg.appendChild(ht);
    } else {
      gg.appendChild(svgEl("rect", {
        width: n.w, height: n.h, rx: 6,
        fill: th.nodeFill,
        stroke: selected ? SELECT_COLOR : (n.isStart ? START_STROKE : th.nodeStroke),
        "stroke-width": selected ? 2.5 : 1.1,
      }));
      gg.appendChild(svgEl("rect", { width: 4, height: n.h, rx: 2, fill: color }));
      const label = svgEl("text", { x: 12, y: n.sublabel ? 20 : n.h / 2 + 4, fill: th.text, "font-size": "12", "font-family": "system-ui, sans-serif" });
      label.textContent = truncate(n.label, Math.max(6, Math.floor((n.w - 16) / 6.6)));
      gg.appendChild(label);
      if (n.sublabel) {
        const sub = svgEl("text", { x: 12, y: 37, fill: th.subText, "font-size": "10.5", "font-family": "system-ui, sans-serif" });
        sub.textContent = truncate(n.sublabel, Math.max(6, Math.floor((n.w - 16) / 5.6)));
        gg.appendChild(sub);
      }
    }

    if (interactive) {
      gg.style.cursor = "pointer";
      gg.addEventListener("click", (ev) => {
        ev.stopPropagation();
        selectNode(n.id);
      });
      const title = svgEl("title");
      title.textContent = `${kindLabel(n.kind)}: ${n.label}${n.sublabel ? " → " + n.sublabel : ""}`;
      gg.appendChild(title);
    }
    g.appendChild(gg);
  }

  function arrowMarker(id, color) {
    const m = svgEl("marker", { id, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    m.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: color }));
    return m;
  }

  function cssId(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  // ── Pan / zoom ──────────────────────────────────────────────────────────────
  function applyTransform() {
    if (state.vpG) state.vpG.setAttribute("transform", `translate(${state.vp.tx},${state.vp.ty}) scale(${state.vp.s})`);
  }
  function fitToView() {
    const W = canvas.clientWidth || 900;
    const H = canvas.clientHeight || 700;
    const gw = state.laid.width || 1;
    const gh = state.laid.height || 1;
    const s = Math.min(W / (gw + 60), H / (gh + 60), 1.4);
    state.vp.s = s > 0 ? s : 1;
    state.vp.tx = (W - gw * state.vp.s) / 2;
    state.vp.ty = (H - gh * state.vp.s) / 2;
    applyTransform();
  }
  function attachPanZoom(svg) {
    let panning = false, sx = 0, sy = 0, downX = 0, downY = 0, moved = false;
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const vbW = svg.viewBox.baseVal.width || r.width;
      const mx = (e.clientX - r.left) * (vbW / r.width);
      const my = (e.clientY - r.top) * (vbW / r.width);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const ns = Math.max(0.1, Math.min(4, state.vp.s * factor));
      state.vp.tx = mx - (mx - state.vp.tx) * (ns / state.vp.s);
      state.vp.ty = my - (my - state.vp.ty) * (ns / state.vp.s);
      state.vp.s = ns;
      applyTransform();
    }, { passive: false });
    svg.addEventListener("mousedown", (e) => { panning = true; moved = false; sx = e.clientX; sy = e.clientY; downX = e.clientX; downY = e.clientY; svg.style.cursor = "grabbing"; });
    svg.addEventListener("mousemove", (e) => {
      if (!panning) return;
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;
      const r = svg.getBoundingClientRect();
      const k = (svg.viewBox.baseVal.width || r.width) / r.width;
      state.vp.tx += (e.clientX - sx) * k;
      state.vp.ty += (e.clientY - sy) * k;
      sx = e.clientX; sy = e.clientY;
      applyTransform();
    });
    const stop = () => { panning = false; svg.style.cursor = "grab"; };
    svg.addEventListener("mouseup", stop);
    svg.addEventListener("mouseleave", stop);
    // Only a genuine (non-drag) click on the background clears the selection.
    svg.addEventListener("click", () => {
      if (moved) { moved = false; return; }
      selectNode(null);
    });
  }

  function centerOnNode(id) {
    const n = state.laid.nodes.find((x) => x.id === id);
    if (!n) return false;
    const W = canvas.clientWidth || 900;
    const H = canvas.clientHeight || 700;
    const s = Math.max(state.vp.s, 0.75);
    state.vp.s = s;
    state.vp.tx = W / 2 - (n.x + n.w / 2) * s;
    state.vp.ty = H / 2 - (n.y + n.h / 2) * s;
    applyTransform();
    return true;
  }

  function zoomBy(factor) {
    if (!state.vpG) return;
    const W = canvas.clientWidth || 900;
    const H = canvas.clientHeight || 700;
    const cx = W / 2;
    const cy = H / 2;
    const ns = Math.max(0.1, Math.min(4, state.vp.s * factor));
    state.vp.tx = cx - (cx - state.vp.tx) * (ns / state.vp.s);
    state.vp.ty = cy - (cy - state.vp.ty) * (ns / state.vp.s);
    state.vp.s = ns;
    applyTransform();
  }

  // ── Selection + detail panel ────────────────────────────────────────────────
  function nodeStrokeSpec(n) {
    const th = tc();
    if (n.id === state.selectedId || state.hlNodes.has(n.id)) return [SELECT_COLOR, "2.5"];
    if (n.isContainer) return [n.isStart ? START_STROKE : th.containerStroke, "1.2"];
    return [n.isStart ? START_STROKE : th.nodeStroke, "1.1"];
  }
  function refreshNodeStrokes() {
    if (!state.svg) return;
    for (const n of state.laid.nodes) {
      const rect = state.svg.querySelector(`#fo-node-${cssId(n.id)} rect`);
      if (!rect) continue;
      const [c, w] = nodeStrokeSpec(n);
      rect.setAttribute("stroke", c);
      rect.setAttribute("stroke-width", w);
    }
  }
  function clearOverlay() {
    if (state.overlayG) while (state.overlayG.firstChild) state.overlayG.removeChild(state.overlayG.firstChild);
  }

  function selectNode(id) {
    state.selectedId = id;
    state.selectedEdgeId = null;
    state.hlNodes = new Set();
    clearOverlay();
    refreshNodeStrokes();
    if (id) renderNodeDetail(id);
  }

  function selectEdge(e) {
    state.selectedId = null;
    state.selectedEdgeId = e.id;
    state.hlNodes = new Set([e.source, e.target]);
    clearOverlay();
    // Draw a bright copy of the edge on top so it stands out above nodes.
    if (state.overlayG && e.points && e.points.length >= 2) {
      const hl = svgEl("path", {
        d: edgePathD(e.points),
        fill: "none",
        stroke: SELECT_COLOR,
        "stroke-width": "3",
        "marker-end": "url(#fo-arrow-hl)",
      });
      if (e.kind === "jump" || e.kind === "dep") hl.setAttribute("stroke-dasharray", "6 4");
      state.overlayG.appendChild(hl);
    }
    refreshNodeStrokes();
    renderEdgeDetail(e);
  }

  /** Human title/subtitle for a node id (action, task container, or dependency). */
  function nodeDisplay(id) {
    const mn = state.model && state.model.nodes.find((n) => n.id === id);
    if (!mn) return { title: id, sub: "" };
    if (mn.kind === "task") return { title: mn.label, sub: "Task" };
    return { title: mn.label, sub: mn.taskName ? `Task: ${mn.taskName}` : (mn.sublabel || "") };
  }

  function renderEdgeDetail(e) {
    const s = nodeDisplay(e.source);
    const t = nodeDisplay(e.target);
    const kindLbl = e.kind === "jump" ? "Task jump" : e.kind === "dep" ? "Dependency" : "Flow";
    detailEl.innerHTML = `
      <h4>Connection</h4>
      <div class="fo-sub"><span class="fo-chip" style="color:${edgeColor(e.kind)}">${kindLbl}</span>${e.label ? ` · ${escapeHtml(e.label)}` : ""}</div>
      <div class="fo-usage" data-go="${escapeHtml(e.source)}"><span class="fo-meta">From</span><br><span class="fo-name">${escapeHtml(s.title)}</span>${s.sub ? `<br><span class="fo-meta">${escapeHtml(s.sub)}</span>` : ""}</div>
      <div style="text-align:center;color:${NODE_SUBTEXT};margin:2px 0">↓</div>
      <div class="fo-usage" data-go="${escapeHtml(e.target)}"><span class="fo-meta">To</span><br><span class="fo-name">${escapeHtml(t.title)}</span>${t.sub ? `<br><span class="fo-meta">${escapeHtml(t.sub)}</span>` : ""}</div>
      <div class="fo-sub" style="margin-top:6px">Click either end to centre it in view.</div>
    `;
    detailEl.querySelectorAll("[data-go]").forEach((row) =>
      row.addEventListener("click", () => centerOnNode(row.getAttribute("data-go")))
    );
  }

  function renderNodeDetail(id) {
    // Dependency node?
    if (id.startsWith("dep:")) {
      const key = id.slice(4);
      const dep = state.depIndex.get(key);
      if (dep) return renderDependencyDetail(dep);
    }
    if (id === "__flow__") return renderFlowDetail();
    // Task container? (loop containers fall through to the action detail below.)
    const modelNode = state.model.nodes.find((n) => n.id === id);
    if (modelNode && modelNode.kind === "task") return renderTaskDetail(id, modelNode);
    // Action node.
    const loc = state.actionIndex.get(id);
    if (loc) return renderActionDetail(id, loc);
    detailEl.innerHTML = `<div class="fo-sub">No details.</div>`;
  }

  function actionVarsFor(actionId) {
    const out = [];
    for (const entry of state.varIndex.values()) {
      if (entry.usages.some((u) => u.actionId === actionId)) out.push(entry.variable);
    }
    return out;
  }

  function renderActionDetail(actionId, action) {
    const kind = action.kind || "action";
    const vars = actionVarsFor(actionId);
    const sets = action.sets || [];
    const taskRef = action.targetTaskRef && state.data.tasks.find((t) => t.id === action.targetTaskRef);
    const isModule = action.depName && state.flowByName && state.flowByName.has(action.depName);
    detailEl.innerHTML = `
      <h4>${escapeHtml(action.name || "(action)")}</h4>
      <div class="fo-sub"><span class="fo-chip" style="color:${kindColor(kind)}">${escapeHtml(kindLabel(kind))}</span> · Task: ${escapeHtml(action.taskName || "")}</div>
      ${action.sublabel ? `<div class="fo-sub">Target: <code>${escapeHtml(action.sublabel)}</code></div>` : ""}
      ${sets.length ? `<div style="margin:6px 0"><strong>Sets values (${sets.length})</strong></div>${sets.map((x) => `<div class="fo-usage"${x.target ? ` data-var="${escapeHtml(x.target)}"` : ""}><span class="fo-name">${escapeHtml(x.target)}</span> <span class="fo-meta">=</span> <code>${escapeHtml(x.value === "" ? '""' : truncate(x.value, 120))}</code></div>`).join("")}` : ""}
      ${action.exprText ? `<div style="margin:6px 0"><strong>Condition / expression</strong><br><code>${escapeHtml(truncate(action.exprText, 200))}</code></div>` : ""}
      ${isModule ? `<div style="margin:6px 0"><strong>Referenced flow</strong></div><div class="fo-usage" data-openflowname="${escapeHtml(action.depName)}"><span class="fo-name">▸ ${escapeHtml(action.depName)}</span></div>` : ""}
      ${taskRef ? `<div style="margin:6px 0"><strong>${action.actionKey === "jumpToTask" ? "Jumps to task" : "Calls task"}</strong></div><div class="fo-usage" data-gotask="${escapeHtml(action.targetTaskRef)}"><span class="fo-name">▸ ${escapeHtml(taskRef.name)}</span></div>` : ""}
      <div style="margin:6px 0"><strong>Variables used (${vars.length})</strong></div>
      ${vars.length ? vars.map((v) => `<div class="fo-usage" data-var="${escapeHtml(v.id)}"><span class="fo-name">${escapeHtml(v.name)}</span> <span class="fo-meta">${escapeHtml(v.type || "")}</span></div>`).join("") : `<div class="fo-sub">None</div>`}
    `;
    detailEl.querySelectorAll("[data-openflowname]").forEach((row) =>
      row.addEventListener("click", () => openFlowByName(row.getAttribute("data-openflowname")))
    );
    detailEl.querySelectorAll("[data-gotask]").forEach((row) =>
      row.addEventListener("click", () => { const t = row.getAttribute("data-gotask"); if (centerOnNode(t)) selectNode(t); })
    );
    detailEl.querySelectorAll("[data-var]").forEach((row) =>
      row.addEventListener("click", () => showVariable(row.getAttribute("data-var")))
    );
  }

  function renderTaskDetail(taskId, modelNode) {
    const count = (state.data.nodes || []).filter((n) => n.parent === taskId).length;
    const isStart = (state.data.tasks || []).some((t) => t.id === taskId && t.isStart);
    detailEl.innerHTML = `
      <h4>${escapeHtml(modelNode.label)}</h4>
      <div class="fo-sub"><span class="fo-chip">Task</span>${modelNode.isStart ? ' · <span class="fo-chip" style="color:' + START_STROKE + '">Start</span>' : ""} · ${count} action(s)</div>
      <div class="fo-sub">${isStart ? "This is the flow's start task." : ""}</div>
    `;
  }

  function renderDependencyDetail(dep) {
    const isFlow = state.flowByName && state.flowByName.has(dep.name);
    detailEl.innerHTML = `
      <h4>${escapeHtml(dep.name)}</h4>
      <div class="fo-sub"><span class="fo-chip" style="color:${DEP_COLOR}">${escapeHtml(dep.type)}</span> · used by ${dep.usages.length} action(s)</div>
      ${isFlow ? `<div class="fo-usage" data-openflowname="${escapeHtml(dep.name)}"><span class="fo-name">▸ Open this flow in a tab</span></div>` : ""}
      ${dep.usages.map((u) => `<div class="fo-usage" data-action="${escapeHtml(u.actionId)}"><span class="fo-name">${escapeHtml(u.actionName)}</span><br><span class="fo-meta">${escapeHtml(u.taskName || "")}</span></div>`).join("")}
    `;
    detailEl.querySelectorAll("[data-openflowname]").forEach((row) =>
      row.addEventListener("click", () => openFlowByName(row.getAttribute("data-openflowname")))
    );
    wireUsageJumps();
  }

  /** Open a dependency flow's tab by its (full) name. */
  function openFlowByName(name) {
    const f = state.flowByName && state.flowByName.get(name);
    if (f) openFlowTab(f.id);
  }

  function renderFlowDetail() {
    const m = state.model.meta;
    detailEl.innerHTML = `
      <h4>${escapeHtml(m.name)}</h4>
      <div class="fo-sub"><span class="fo-chip">${escapeHtml(m.type)}</span> · ${m.taskCount} tasks · ${m.variableCount} variables</div>
      <div class="fo-sub">Default language: ${escapeHtml(m.defaultLanguage || "—")}</div>
      ${m.description ? `<div style="margin-top:6px">${escapeHtml(m.description)}</div>` : ""}
    `;
  }

  // ── Search (variables + dependencies) ───────────────────────────────────────
  searchInput.addEventListener("input", () => renderSearch(searchInput.value));

  function renderSearch(q) {
    q = (q || "").trim().toLowerCase();
    const vars = [...state.varIndex.values()]
      .filter((v) => !q || v.variable.name.toLowerCase().includes(q))
      .sort((a, b) => b.usages.length - a.usages.length);
    const deps = [...state.depIndex.values()].filter((d) => !q || d.name.toLowerCase().includes(q));
    searchCount.textContent = `${vars.length}v · ${deps.length}d`;

    const rows = [];
    for (const d of deps.slice(0, 60)) {
      rows.push(
        `<div class="fo-row" data-kind="dep" data-key="${escapeHtml(d.key)}">
           <span class="fo-name">${escapeHtml(d.name)}</span>
           <span class="fo-chip" style="color:${DEP_COLOR}">${escapeHtml(d.type)}</span>
           <div class="fo-meta">${d.usages.length} use(s)</div>
         </div>`
      );
    }
    for (const v of vars.slice(0, 200)) {
      rows.push(
        `<div class="fo-row" data-kind="var" data-key="${escapeHtml(v.variable.id)}">
           <span class="fo-name">${escapeHtml(v.variable.name)}</span>
           <span class="fo-chip">${escapeHtml(v.variable.type || "")}</span>
           <div class="fo-meta">${v.usages.length} use(s)${v.variable.isInput ? " · input" : ""}${v.variable.isOutput ? " · output" : ""}${v.variable.isSecure ? " · secure" : ""}</div>
         </div>`
      );
    }
    resultsEl.innerHTML = rows.join("") || `<div class="fo-sub" style="padding:10px">No matches.</div>`;
    resultsEl.querySelectorAll(".fo-row").forEach((row) =>
      row.addEventListener("click", () => {
        if (row.dataset.kind === "var") showVariable(row.dataset.key);
        else showDependency(row.dataset.key);
      })
    );
  }

  function showVariable(varId) {
    const entry = state.varIndex.get(varId);
    if (!entry) return;
    const v = entry.variable;
    detailEl.innerHTML = `
      <h4>${escapeHtml(v.name)}</h4>
      <div class="fo-sub">
        <span class="fo-chip">${escapeHtml(v.type || "")}</span>
        ${v.scope ? `<span class="fo-chip">${escapeHtml(v.scope)}</span>` : ""}
        ${v.isInput ? '<span class="fo-chip">input</span>' : ""}
        ${v.isOutput ? '<span class="fo-chip">output</span>' : ""}
        ${v.isSecure ? '<span class="fo-chip">secure</span>' : ""}
        ${v.isCollection ? '<span class="fo-chip">collection</span>' : ""}
      </div>
      ${v.initialText ? `<div class="fo-sub">Initial: <code>${escapeHtml(truncate(v.initialText, 80))}</code></div>` : ""}
      <div style="margin:6px 0"><strong>Used in ${entry.usages.length} place(s)</strong></div>
      ${entry.usages.length
        ? entry.usages.map((u) => `<div class="fo-usage" data-action="${escapeHtml(u.actionId)}"><span class="fo-name">${escapeHtml(u.actionName)}</span><br><span class="fo-meta">${escapeHtml(u.taskName)} · ${escapeHtml(kindLabel(u.kind))}</span>${u.exprText ? `<br><code>${escapeHtml(truncate(u.exprText, 60))}</code>` : ""}</div>`).join("")
        : `<div class="fo-sub">Declared but not referenced.</div>`}
    `;
    wireUsageJumps();
  }

  function showDependency(key) {
    const dep = state.depIndex.get(key);
    if (dep) renderDependencyDetail(dep);
  }

  function wireUsageJumps() {
    detailEl.querySelectorAll("[data-action]").forEach((row) =>
      row.addEventListener("click", () => jumpToAction(row.getAttribute("data-action")))
    );
  }

  async function jumpToAction(actionId) {
    // Action nodes only exist at the High level → switch if needed.
    if (state.level !== "high") {
      state.level = "high";
      levelBtns.forEach((x) => x.classList.toggle("is-active", x.dataset.level === "high"));
      await rebuild();
    }
    if (centerOnNode(actionId)) selectNode(actionId);
  }

  // ── Legend ──────────────────────────────────────────────────────────────────
  function renderLegend() {
    const kinds = new Set(state.model.nodes.map((n) => n.kind));
    const items = [...kinds].map((k) => `<span><i style="background:${kindColor(k)}"></i>${escapeHtml(kindLabel(k))}</span>`);
    items.push(`<span><i style="background:${JUMP_COLOR}"></i>Task jump</span>`);
    items.push(`<span><i style="background:${DEP_COLOR}"></i>Dependency</span>`);
    legendEl.innerHTML = items.join("");
  }

  // ── Export ──────────────────────────────────────────────────────────────────
  /** Build a self-contained SVG for an arbitrary laid-out flow (current theme). */
  function buildSvgForLaid(laid) {
    const pad = 24;
    const w = Math.ceil((laid.width || 100) + pad * 2);
    const h = Math.ceil((laid.height || 100) + pad * 2);
    const svg = svgEl("svg", { xmlns: SVGNS, width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    const th = tc();
    svg.appendChild(svgEl("rect", { width: w, height: h, fill: th.bg }));
    const defs = svgEl("defs");
    defs.appendChild(arrowMarker("fo-arrow", th.edge));
    defs.appendChild(arrowMarker("fo-arrow-jump", JUMP_COLOR));
    defs.appendChild(arrowMarker("fo-arrow-dep", DEP_COLOR));
    svg.appendChild(defs);
    const g = svgEl("g", { transform: `translate(${pad},${pad})` });
    svg.appendChild(g);
    drawGraph(g, laid, null, false);
    return { svg, w, h };
  }

  function buildStandaloneSvg() {
    return buildSvgForLaid(state.laid);
  }

  /** Rasterise a standalone SVG to a JPEG data URI (jsPDF-safe; theme bg). */
  function rasterizeSvgToJpeg(svg, w, h) {
    return new Promise((resolve, reject) => {
      const str = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      const url = URL.createObjectURL(new Blob([str], { type: "image/svg+xml" }));
      img.onload = () => {
        const scale = rasterScale(w, h);
        const c = document.createElement("canvas");
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        const ctx = c.getContext("2d");
        ctx.fillStyle = tc().bg;
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.92));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("raster failed")); };
      img.src = url;
    });
  }

  /**
   * Auto-load the full transitive closure: keep loading every tab that isn't
   * cached yet — each load discovers its own dependency flows and adds them as
   * tabs (so common-module → common-module chains are pulled in) — until no new
   * flows appear. Returns the cached tabs in display order (root/main first).
   */
  async function loadAllFlows(onProgress) {
    for (let guard = 0; guard < 500; guard++) {
      const pending = state.tabs.filter((t) => t.available !== false && !state.cache.has(t.id));
      if (!pending.length) break;
      for (const t of pending) {
        if (state.cache.has(t.id)) continue;
        if (onProgress) onProgress(t.name);
        t.loading = true; renderTabs();
        try { await ensureFlowLoaded(t.id); t.available = true; }
        catch (_e) { t.available = false; }
        t.loading = false; renderTabs();
      }
    }
    return state.tabs.filter((t) => state.cache.has(t.id));
  }


  $("#foFit").addEventListener("click", () => fitToView());
  $("#foZoomIn").addEventListener("click", () => zoomBy(1.25));
  $("#foZoomOut").addEventListener("click", () => zoomBy(1 / 1.25));

  $("#foSavePdf").addEventListener("click", async () => {
    if (!window.jspdf || !window.jspdf.jsPDF) { statusEl.textContent = "PDF library not loaded."; return; }
    try {
      // Rasterise the diagram then place it on a single PDF page sized to the
      // diagram (poster-style, prints/zooms cleanly). JPEG bytes are embedded
      // directly by jsPDF, avoiding its PNG decoder that corrupts large images.
      const { svg, w, h } = buildStandaloneSvg();
      const jpeg = await rasterizeSvgToJpeg(svg, w, h);
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: w >= h ? "landscape" : "portrait", unit: "px", format: [w, h], compress: true });
      doc.addImage(jpeg, "JPEG", 0, 0, w, h);
      const b64 = doc.output("datauristring").split(",")[1];
      download(`${slug(state.data.meta.name)}-${state.level}.pdf`, b64, (m) => (statusEl.textContent = m));
    } catch (err) {
      statusEl.textContent = "PDF export failed: " + (err.message || err);
    }
  });

  $("#foSaveHtml").addEventListener("click", () => {
    const { svg } = buildStandaloneSvg();
    const str = new XMLSerializer().serializeToString(svg);
    const th = tc();
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(state.data.meta.name)} — Flow Overview (${state.level})</title>
<style>body{margin:0;background:${th.bg};color:${th.text};font-family:system-ui,sans-serif}
header{padding:12px 16px;border-bottom:1px solid ${th.nodeStroke}}h1{font-size:16px;margin:0}
.meta{color:${th.subText};font-size:12px;margin-top:4px}.wrap{padding:16px;overflow:auto}</style></head>
<body><header><h1>${escapeHtml(state.data.meta.name)}</h1><div class="meta">${escapeHtml(state.model.meta.type)} · ${state.level} detail · ${state.model.nodes.length} nodes · exported ${new Date().toISOString()}</div></header>
<div class="wrap">${str}</div></body></html>`;
    download(`${slug(state.data.meta.name)}-${state.level}.html`, textToB64(html), (m) => (statusEl.textContent = m));
  });

  $("#foSaveJson").addEventListener("click", () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      org: state.orgId,
      flowId: state.flowId,
      level: state.level,
      meta: state.model.meta,
      model: { nodes: state.model.nodes, edges: state.model.edges, warnings: state.model.warnings },
      variables: [...state.varIndex.values()].map((v) => ({ ...v.variable, usages: v.usages })),
      dependencies: [...state.depIndex.values()],
    };
    download(`${slug(state.data.meta.name)}-${state.level}.json`, textToB64(JSON.stringify(payload, null, 2)), (m) => (statusEl.textContent = m));
  });

  // ── Save all (root + full transitive dependency closure) ─────────────────────
  let exportingAll = false;
  async function withExportGuard(fn) {
    if (exportingAll) return;
    exportingAll = true;
    exportBtns.forEach((b) => (b.disabled = true));
    try { await fn(); }
    catch (err) { setBusy(false, "Export failed: " + (err.message || err)); }
    finally { exportingAll = false; exportBtns.forEach((b) => (b.disabled = false)); }
  }

  /** Build the model + ELK layout for one loaded flow (does not touch state). */
  async function laidForFlow(entry) {
    const model = buildModel(entry.data, { level: state.level });
    const laid = await layoutModel(model);
    return { model, laid };
  }

  $("#foSaveAllPdf").addEventListener("click", () => withExportGuard(async () => {
    if (!window.jspdf || !window.jspdf.jsPDF) { statusEl.textContent = "PDF library not loaded."; return; }
    const rootName = state.data.meta.name;
    const flows = await loadAllFlows((name) => setBusy(true, `Loading “${name}”…`));
    const { jsPDF } = window.jspdf;
    let doc = null;
    for (let i = 0; i < flows.length; i++) {
      const entry = state.cache.get(flows[i].id);
      setBusy(true, `Rendering PDF ${i + 1}/${flows.length}: ${entry.data.meta.name}…`);
      const { laid } = await laidForFlow(entry);
      const { svg, w, h } = buildSvgForLaid(laid);
      const jpeg = await rasterizeSvgToJpeg(svg, w, h);
      const orient = w >= h ? "landscape" : "portrait";
      if (!doc) doc = new jsPDF({ orientation: orient, unit: "px", format: [w, h], compress: true });
      else doc.addPage([w, h], orient);
      doc.addImage(jpeg, "JPEG", 0, 0, w, h);
    }
    if (!doc) { setBusy(false, "Nothing to export."); return; }
    const b64 = doc.output("datauristring").split(",")[1];
    download(`${slug(rootName)}-all-${state.level}.pdf`, b64, (m) => (statusEl.textContent = m));
    setBusy(false, `Exported ${flows.length} flow(s) to PDF.`);
  }));

  $("#foSaveAllHtml").addEventListener("click", () => withExportGuard(async () => {
    const rootName = state.data.meta.name;
    const flows = await loadAllFlows((name) => setBusy(true, `Loading “${name}”…`));
    const th = tc();
    const tabsHtml = [];
    const sections = [];
    for (let i = 0; i < flows.length; i++) {
      const entry = state.cache.get(flows[i].id);
      setBusy(true, `Rendering HTML ${i + 1}/${flows.length}: ${entry.data.meta.name}…`);
      const { model, laid } = await laidForFlow(entry);
      const { svg } = buildSvgForLaid(laid);
      const str = new XMLSerializer().serializeToString(svg);
      const nm = entry.data.meta.name;
      tabsHtml.push(`<button class="ftab${i === 0 ? " active" : ""}" data-i="${i}">${escapeHtml(nm)}${flows[i].isMain ? " ★" : ""}</button>`);
      sections.push(`<section class="fsec${i === 0 ? " active" : ""}" data-i="${i}"><div class="meta">${escapeHtml(model.meta.type)} · ${state.level} detail · ${model.nodes.length} nodes, ${model.edges.length} edges</div><div class="wrap">${str}</div></section>`);
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(rootName)} — Flow Overview (all flows)</title>
<style>body{margin:0;background:${th.bg};color:${th.text};font-family:system-ui,sans-serif}
header{padding:12px 16px;border-bottom:1px solid ${th.nodeStroke}}h1{font-size:16px;margin:0}
.sub{color:${th.subText};font-size:12px;margin-top:4px}
.tabs{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px;border-bottom:1px solid ${th.nodeStroke};position:sticky;top:0;background:${th.bg};z-index:1}
.ftab{background:${th.nodeFill};color:${th.text};border:1px solid ${th.nodeStroke};border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.ftab.active{border-color:${SELECT_COLOR};color:${SELECT_COLOR}}
.fsec{display:none;padding:16px;overflow:auto}.fsec.active{display:block}
.meta{color:${th.subText};font-size:12px;margin-bottom:8px}</style></head>
<body><header><h1>${escapeHtml(rootName)} — all flows</h1><div class="sub">${flows.length} flow(s) · ${state.level} detail · exported ${new Date().toISOString()}</div></header>
<div class="tabs">${tabsHtml.join("")}</div>${sections.join("")}
<script>
var tabs=document.querySelectorAll('.ftab'),secs=document.querySelectorAll('.fsec');
for(var i=0;i<tabs.length;i++){tabs[i].addEventListener('click',function(){var k=this.getAttribute('data-i');for(var j=0;j<tabs.length;j++){tabs[j].classList.toggle('active',tabs[j].getAttribute('data-i')===k);secs[j].classList.toggle('active',secs[j].getAttribute('data-i')===k);}});}
<\/script></body></html>`;
    download(`${slug(rootName)}-all-${state.level}.html`, textToB64(html), (m) => (statusEl.textContent = m));
    setBusy(false, `Exported ${flows.length} flow(s) to HTML.`);
  }));

  $("#foSaveAllJson").addEventListener("click", () => withExportGuard(async () => {
    const rootName = state.data.meta.name;
    const flows = await loadAllFlows((name) => setBusy(true, `Loading “${name}”…`));
    const out = { exportedAt: new Date().toISOString(), org: state.orgId, rootFlowId: state.flowId, level: state.level, flowCount: flows.length, flows: [] };
    for (let i = 0; i < flows.length; i++) {
      const entry = state.cache.get(flows[i].id);
      setBusy(true, `Building JSON ${i + 1}/${flows.length}…`);
      const model = buildModel(entry.data, { level: state.level });
      out.flows.push({
        flowId: flows[i].id,
        name: entry.data.meta.name,
        type: entry.data.meta.type,
        isMain: !!flows[i].isMain,
        meta: model.meta,
        model: { nodes: model.nodes, edges: model.edges, warnings: model.warnings },
        variables: [...entry.varIndex.values()].map((v) => ({ ...v.variable, usages: v.usages })),
        dependencies: [...entry.depIndex.values()],
      });
    }
    download(`${slug(rootName)}-all-${state.level}.json`, textToB64(JSON.stringify(out, null, 2)), (m) => (statusEl.textContent = m));
    setBusy(false, `Exported ${flows.length} flow(s) to JSON.`);
  }));

  themeSel.value = state.themeName;
  init();

  return el;
}
