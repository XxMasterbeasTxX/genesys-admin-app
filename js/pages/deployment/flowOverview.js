/**
 * Deployment › Flow Overview
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
  buildModel,
  buildVariableIndex,
  buildDependencyIndex,
  buildActionIndex,
  ACTION_KINDS,
} from "../../lib/flowModel.js";
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

/** Base64-encode a Blob (png payload). */
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function slug(s) {
  return String(s || "flow").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "flow";
}

export default function renderFlowOverview({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const customers = orgContext.getCustomers();
  const orgOptions =
    `<option value="">Select org…</option>` +
    customers
      .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.region)})</option>`)
      .join("");

  el.innerHTML = `
    <style>
      @keyframes fo-spin { to { transform: rotate(360deg); } }
      .fo-spin { display:inline-block; width:14px; height:14px; border:2px solid rgba(255,255,255,.25);
                 border-top-color:#fff; border-radius:50%; animation:fo-spin .8s linear infinite; }
      .fo-layout { display:flex; gap:12px; align-items:stretch; }
      .fo-canvas-wrap { position:relative; flex:1; min-width:0; }
      .fo-canvas { height:720px; min-height:320px; border:1px solid ${NODE_STROKE}; border-radius:8px;
                   overflow:hidden; background:${CANVAS_BG}; position:relative; }
      .fo-canvas svg { width:100%; height:100%; display:block; }
      .fo-empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
                  color:${NODE_SUBTEXT}; font-size:14px; text-align:center; padding:20px; }
      .fo-empty[hidden] { display:none; }
      .fo-side { width:340px; flex:none; display:flex; flex-direction:column; gap:10px; }
      .fo-side-box { border:1px solid ${NODE_STROKE}; border-radius:8px; background:rgba(255,255,255,.02);
                     display:flex; flex-direction:column; min-height:0; }
      .fo-side-head { padding:8px 10px; font-weight:600; font-size:13px; border-bottom:1px solid ${NODE_STROKE};
                      display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .fo-search { flex:1 1 auto; }
      .fo-results { overflow:auto; max-height:230px; }
      .fo-detail { overflow:auto; flex:1; max-height:340px; }
      .fo-row { padding:6px 10px; border-bottom:1px solid rgba(255,255,255,.05); cursor:pointer; font-size:12.5px; }
      .fo-row:hover { background:rgba(255,255,255,.05); }
      .fo-row .fo-name { color:${NODE_TEXT}; }
      .fo-row .fo-meta { color:${NODE_SUBTEXT}; font-size:11px; }
      .fo-chip { display:inline-block; padding:1px 6px; border-radius:10px; font-size:10.5px; line-height:1.6;
                 border:1px solid ${NODE_STROKE}; color:${NODE_SUBTEXT}; }
      .fo-detail-body { padding:10px; font-size:12.5px; color:${NODE_TEXT}; }
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
    </style>

    <h2>Deployment — Flow Overview</h2>
    <p class="page-desc">
      Visualise an Architect flow and everything it depends on. Pick an org and a
      flow, choose a detail level, then explore the diagram. Use the search to find
      a variable or dependency and jump straight to the node that uses it. Save the
      overview as an image, a self-contained HTML page, or JSON.
    </p>

    <div class="dt-controls">
      <div class="dt-control-group">
        <label class="dt-label">Org</label>
        <select class="dt-select" id="foOrg">${orgOptions}</select>
      </div>
      <div class="dt-control-group">
        <label class="dt-label">Flow</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input class="dt-input" id="foFlowFilter" type="text" placeholder="Filter flows…" style="max-width:200px" disabled />
          <select class="dt-select" id="foFlow" disabled><option value="">Select org first…</option></select>
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
        <button class="btn" id="foLoad" disabled>Load Flow</button>
        <span id="foStatus" style="font-size:12px;color:${NODE_SUBTEXT}"></span>
      </div>
    </div>

    <div class="dt-actions" style="margin:0 0 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <button class="btn btn--secondary btn-sm" id="foZoomOut" disabled title="Zoom out">−</button>
      <button class="btn btn--secondary btn-sm" id="foZoomIn" disabled title="Zoom in">+</button>
      <button class="btn btn--secondary btn-sm" id="foFit" disabled>Fit</button>
      <span style="font-size:11px;color:${NODE_SUBTEXT}">Scroll to zoom · drag to pan · click a line to trace it</span>
      <span style="flex:1"></span>
      <button class="btn btn--secondary btn-sm" id="foSaveSvg" disabled>Save SVG</button>
      <button class="btn btn--secondary btn-sm" id="foSavePng" disabled>Save PNG</button>
      <button class="btn btn--secondary btn-sm" id="foSaveHtml" disabled>Save HTML</button>
      <button class="btn btn--secondary btn-sm" id="foSaveJson" disabled>Save JSON</button>
    </div>

    <div class="fo-layout">
      <div class="fo-canvas-wrap">
        <div class="fo-canvas" id="foCanvas">
          <div class="fo-empty" id="foEmpty">Pick an org and a flow, then <strong>Load Flow</strong>.</div>
        </div>
        <div class="fo-legend" id="foLegend"></div>
      </div>
      <div class="fo-side">
        <div class="fo-side-box fo-search">
          <div class="fo-side-head">Search <span id="foSearchCount" class="fo-chip">—</span></div>
          <div style="padding:8px 10px"><input class="dt-input" id="foSearchInput" type="text" placeholder="Variable or dependency…" style="width:100%" disabled /></div>
          <div class="fo-hint">Click a result, then a usage, to jump to the node.</div>
          <div class="fo-results" id="foResults"></div>
        </div>
        <div class="fo-side-box fo-detail">
          <div class="fo-side-head">Details</div>
          <div class="fo-detail-body" id="foDetail"><div class="fo-sub">Select a node, variable or dependency.</div></div>
        </div>
      </div>
    </div>
  `;

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const $ = (id) => el.querySelector(id);
  const orgSel = $("#foOrg");
  const flowSel = $("#foFlow");
  const flowFilter = $("#foFlowFilter");
  const loadBtn = $("#foLoad");
  const statusEl = $("#foStatus");
  const canvas = $("#foCanvas");
  const emptyEl = $("#foEmpty");
  const legendEl = $("#foLegend");
  const searchInput = $("#foSearchInput");
  const searchCount = $("#foSearchCount");
  const resultsEl = $("#foResults");
  const detailEl = $("#foDetail");
  const levelBtns = [...el.querySelectorAll(".fo-level .btn")];
  const exportBtns = ["#foZoomOut", "#foZoomIn", "#foFit", "#foSaveSvg", "#foSavePng", "#foSaveHtml", "#foSaveJson"].map($);

  // ── State ───────────────────────────────────────────────────────────────────
  const state = {
    orgId: "",
    flows: [],
    flowId: "",
    flowName: "",
    level: "high",
    cfg: null,
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

  // ── Org / flow pickers ──────────────────────────────────────────────────────
  orgSel.addEventListener("change", async () => {
    state.orgId = orgSel.value;
    state.flows = [];
    flowSel.innerHTML = `<option value="">Loading flows…</option>`;
    flowSel.disabled = true;
    flowFilter.disabled = true;
    loadBtn.disabled = true;
    if (!state.orgId) {
      flowSel.innerHTML = `<option value="">Select org first…</option>`;
      return;
    }
    try {
      const flows = await gc.fetchAllFlows(api, state.orgId, { query: { pageSize: "100" } });
      state.flows = (flows || [])
        .map((f) => ({ id: f.id, name: f.name, type: (f.type || "").toLowerCase() }))
        .filter((f) => f.id && f.name)
        .sort((a, b) => a.name.localeCompare(b.name));
      populateFlowSelect();
      flowSel.disabled = false;
      flowFilter.disabled = false;
      flowFilter.value = "";
    } catch (err) {
      flowSel.innerHTML = `<option value="">Failed to load flows</option>`;
      statusEl.textContent = `Error: ${err.message || err}`;
    }
  });

  function populateFlowSelect() {
    const q = (flowFilter.value || "").toLowerCase();
    const list = state.flows.filter((f) => !q || f.name.toLowerCase().includes(q) || f.type.includes(q));
    flowSel.innerHTML =
      `<option value="">Select flow… (${list.length})</option>` +
      list.map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)} — ${escapeHtml(f.type)}</option>`).join("");
  }
  flowFilter.addEventListener("input", populateFlowSelect);
  flowSel.addEventListener("change", () => {
    state.flowId = flowSel.value;
    const f = state.flows.find((x) => x.id === state.flowId);
    state.flowName = f ? f.name : "";
    loadBtn.disabled = !state.flowId;
  });

  // ── Level toggle ────────────────────────────────────────────────────────────
  levelBtns.forEach((b) =>
    b.addEventListener("click", async () => {
      if (state.level === b.dataset.level) return;
      state.level = b.dataset.level;
      levelBtns.forEach((x) => x.classList.toggle("is-active", x === b));
      if (state.cfg) await rebuild();
    })
  );

  // ── Load flow ───────────────────────────────────────────────────────────────
  loadBtn.addEventListener("click", async () => {
    if (!state.orgId || !state.flowId) return;
    setBusy(true, "Fetching flow configuration…");
    try {
      const cfg = await api.proxyGenesys(state.orgId, "GET", `/api/v2/flows/${state.flowId}/latestconfiguration`);
      state.cfg = cfg;
      state.varIndex = buildVariableIndex(cfg);
      state.depIndex = buildDependencyIndex(cfg);
      state.actionIndex = buildActionIndex(cfg);
      searchInput.disabled = false;
      renderSearch("");
      await rebuild();
      setBusy(false, `Loaded “${cfg.name}” — ${state.varIndex.size} variables, ${state.depIndex.size} dependencies.`);
    } catch (err) {
      setBusy(false, `Error: ${err.message || err}`);
      emptyEl.hidden = false;
      emptyEl.innerHTML = `Failed to load flow configuration.<br><small>${escapeHtml(String(err.message || err))}</small>`;
    }
  });

  function setBusy(busy, msg) {
    loadBtn.disabled = busy || !state.flowId;
    statusEl.innerHTML = busy ? `<span class="fo-spin"></span> ${escapeHtml(msg || "")}` : escapeHtml(msg || "");
  }

  async function rebuild() {
    statusEl.innerHTML = `<span class="fo-spin"></span> Laying out (${state.level})…`;
    try {
      state.model = buildModel(state.cfg, { level: state.level });
      state.laid = await layoutModel(state.model);
      state.selectedId = null;
      renderGraph();
      renderLegend();
      exportBtns.forEach((b) => (b.disabled = false));
      const w = state.model.warnings || [];
      statusEl.textContent = `“${state.cfg.name}” · ${state.level} · ${state.model.nodes.length} nodes, ${state.model.edges.length} edges${w.length ? " · " + w.join(" ") : ""}`;
    } catch (err) {
      statusEl.textContent = `Layout error: ${err.message || err}`;
    }
  }

  // ── Graph rendering ─────────────────────────────────────────────────────────
  function renderGraph() {
    emptyEl.hidden = true;
    canvas.querySelector("svg")?.remove();

    const W = canvas.clientWidth || 900;
    const H = canvas.clientHeight || 700;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });
    svg.style.cursor = "grab";

    const defs = svgEl("defs");
    defs.appendChild(arrowMarker("fo-arrow", EDGE_COLOR));
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
    return kind === "jump" ? JUMP_COLOR : kind === "dep" ? DEP_COLOR : EDGE_COLOR;
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
        fill: EDGE_LABEL,
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

    if (n.isContainer) {
      gg.appendChild(svgEl("rect", {
        width: n.w, height: n.h, rx: 8,
        fill: "none",
        stroke: selected ? SELECT_COLOR : (n.isStart ? START_STROKE : CONTAINER_STROKE),
        "stroke-width": selected ? 2.5 : 1.2,
        "stroke-dasharray": "2 3",
      }));
      gg.appendChild(svgEl("rect", { width: n.w, height: 26, rx: 8, fill: CONTAINER_HEADER }));
      gg.appendChild(svgEl("rect", { y: 18, width: n.w, height: 8, fill: CONTAINER_HEADER }));
      const ht = svgEl("text", { x: 10, y: 17, fill: NODE_TEXT, "font-size": "12.5", "font-weight": "600", "font-family": "system-ui, sans-serif" });
      ht.textContent = truncate((n.isStart ? "▶ " : "") + n.label, Math.max(6, Math.floor(n.w / 8)));
      gg.appendChild(ht);
    } else {
      gg.appendChild(svgEl("rect", {
        width: n.w, height: n.h, rx: 6,
        fill: NODE_FILL,
        stroke: selected ? SELECT_COLOR : (n.isStart ? START_STROKE : NODE_STROKE),
        "stroke-width": selected ? 2.5 : 1.1,
      }));
      gg.appendChild(svgEl("rect", { width: 4, height: n.h, rx: 2, fill: color }));
      const label = svgEl("text", { x: 12, y: n.sublabel ? 20 : n.h / 2 + 4, fill: NODE_TEXT, "font-size": "12", "font-family": "system-ui, sans-serif" });
      label.textContent = truncate(n.label, Math.max(6, Math.floor((n.w - 16) / 6.6)));
      gg.appendChild(label);
      if (n.sublabel) {
        const sub = svgEl("text", { x: 12, y: 37, fill: NODE_SUBTEXT, "font-size": "10.5", "font-family": "system-ui, sans-serif" });
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
    if (n.id === state.selectedId || state.hlNodes.has(n.id)) return [SELECT_COLOR, "2.5"];
    if (n.isContainer) return [n.isStart ? START_STROKE : CONTAINER_STROKE, "1.2"];
    return [n.isStart ? START_STROKE : NODE_STROKE, "1.1"];
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
    if (mn.isContainer || mn.kind === "task") return { title: mn.label, sub: "Task" };
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
    // Task container?
    const modelNode = state.model.nodes.find((n) => n.id === id);
    if (modelNode && (modelNode.isContainer || modelNode.kind === "task")) return renderTaskDetail(id, modelNode);
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

  function renderActionDetail(actionId, loc) {
    const a = loc.action;
    const tag = state.model.nodes.find((n) => n.id === actionId);
    const kind = tag ? tag.kind : "action";
    const vars = actionVarsFor(actionId);
    const inputs = Array.isArray(a.inputs) ? a.inputs : [];
    const outputs = Array.isArray(a.outputs) ? a.outputs : [];
    const expr = a.expression && a.expression.text ? a.expression.text : "";
    detailEl.innerHTML = `
      <h4>${escapeHtml(a.name || "(action)")}</h4>
      <div class="fo-sub"><span class="fo-chip" style="color:${kindColor(kind)}">${escapeHtml(kindLabel(kind))}</span> · Task: ${escapeHtml(loc.taskName)}</div>
      ${tag && tag.sublabel ? `<div class="fo-sub">Target: <code>${escapeHtml(tag.sublabel)}</code></div>` : ""}
      ${expr ? `<div style="margin:6px 0"><strong>Expression</strong><br><code>${escapeHtml(truncate(expr, 200))}</code></div>` : ""}
      ${inputs.length ? `<div style="margin:6px 0"><strong>Inputs</strong><br>${inputs.map((i) => `<code>${escapeHtml(i.name || "")}</code>`).join(" ")}</div>` : ""}
      ${outputs.length ? `<div style="margin:6px 0"><strong>Outputs</strong><br>${outputs.map((i) => `<code>${escapeHtml(i.name || "")}</code>`).join(" ")}</div>` : ""}
      <div style="margin:6px 0"><strong>Variables used (${vars.length})</strong></div>
      ${vars.length ? vars.map((v) => `<div class="fo-usage" data-var="${escapeHtml(v.id)}"><span class="fo-name">${escapeHtml(v.name)}</span> <span class="fo-meta">${escapeHtml(v.type || "")}</span></div>`).join("") : `<div class="fo-sub">None</div>`}
    `;
    detailEl.querySelectorAll("[data-var]").forEach((row) =>
      row.addEventListener("click", () => showVariable(row.getAttribute("data-var")))
    );
  }

  function renderTaskDetail(taskId, modelNode) {
    const task = (state.cfg.flowSequenceItemList || []).find((t) => t.id === taskId);
    const count = task ? (task.actionList || []).length : 0;
    detailEl.innerHTML = `
      <h4>${escapeHtml(modelNode.label)}</h4>
      <div class="fo-sub"><span class="fo-chip">Task</span>${modelNode.isStart ? ' · <span class="fo-chip" style="color:' + START_STROKE + '">Start</span>' : ""} · ${count} action(s)</div>
      <div class="fo-sub">${taskId === state.cfg.initialSequence ? "This is the flow's initial sequence." : ""}</div>
    `;
  }

  function renderDependencyDetail(dep) {
    detailEl.innerHTML = `
      <h4>${escapeHtml(dep.name)}</h4>
      <div class="fo-sub"><span class="fo-chip" style="color:${DEP_COLOR}">${escapeHtml(dep.type)}</span> · used by ${dep.usages.length} action(s)</div>
      ${dep.usages.map((u) => `<div class="fo-usage" data-action="${escapeHtml(u.actionId)}"><span class="fo-name">${escapeHtml(u.actionName)}</span><br><span class="fo-meta">${escapeHtml(u.taskName || "")}</span></div>`).join("")}
    `;
    wireUsageJumps();
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
  function buildStandaloneSvg() {
    const pad = 24;
    const w = Math.ceil((state.laid.width || 100) + pad * 2);
    const h = Math.ceil((state.laid.height || 100) + pad * 2);
    const svg = svgEl("svg", { xmlns: SVGNS, width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    svg.appendChild(svgEl("rect", { width: w, height: h, fill: CANVAS_BG }));
    const defs = svgEl("defs");
    defs.appendChild(arrowMarker("fo-arrow", EDGE_COLOR));
    defs.appendChild(arrowMarker("fo-arrow-jump", JUMP_COLOR));
    defs.appendChild(arrowMarker("fo-arrow-dep", DEP_COLOR));
    svg.appendChild(defs);
    const g = svgEl("g", { transform: `translate(${pad},${pad})` });
    svg.appendChild(g);
    drawGraph(g, state.laid, null, false);
    return { svg, w, h };
  }

  $("#foFit").addEventListener("click", () => fitToView());
  $("#foZoomIn").addEventListener("click", () => zoomBy(1.25));
  $("#foZoomOut").addEventListener("click", () => zoomBy(1 / 1.25));

  $("#foSaveSvg").addEventListener("click", () => {
    const { svg } = buildStandaloneSvg();
    const str = new XMLSerializer().serializeToString(svg);
    download(`${slug(state.cfg.name)}-${state.level}.svg`, textToB64(str), (m) => (statusEl.textContent = m));
  });

  $("#foSavePng").addEventListener("click", () => {
    const { svg, w, h } = buildStandaloneSvg();
    const str = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([str], { type: "image/svg+xml" }));
    img.onload = () => {
      const scale = 2;
      const c = document.createElement("canvas");
      c.width = w * scale;
      c.height = h * scale;
      const ctx = c.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob(async (blob) => {
        if (!blob) { statusEl.textContent = "PNG export failed."; return; }
        download(`${slug(state.cfg.name)}-${state.level}.png`, await blobToB64(blob), (m) => (statusEl.textContent = m));
      }, "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); statusEl.textContent = "PNG export failed."; };
    img.src = url;
  });

  $("#foSaveHtml").addEventListener("click", () => {
    const { svg } = buildStandaloneSvg();
    const str = new XMLSerializer().serializeToString(svg);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(state.cfg.name)} — Flow Overview (${state.level})</title>
<style>body{margin:0;background:${CANVAS_BG};color:${NODE_TEXT};font-family:system-ui,sans-serif}
header{padding:12px 16px;border-bottom:1px solid ${NODE_STROKE}}h1{font-size:16px;margin:0}
.meta{color:${NODE_SUBTEXT};font-size:12px;margin-top:4px}.wrap{padding:16px;overflow:auto}</style></head>
<body><header><h1>${escapeHtml(state.cfg.name)}</h1><div class="meta">${escapeHtml(state.model.meta.type)} · ${state.level} detail · ${state.model.nodes.length} nodes · exported ${new Date().toISOString()}</div></header>
<div class="wrap">${str}</div></body></html>`;
    download(`${slug(state.cfg.name)}-${state.level}.html`, textToB64(html), (m) => (statusEl.textContent = m));
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
    download(`${slug(state.cfg.name)}-${state.level}.json`, textToB64(JSON.stringify(payload, null, 2)), (m) => (statusEl.textContent = m));
  });

  return el;
}
