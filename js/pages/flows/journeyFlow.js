/**
 * Flows › Journey Flow
 *
 * Visualises the Genesys journey-flow path data for an Architect flow as an
 * interactive SVG diagram — close to the built-in view in Architect.
 *
 * Flow:
 *  1. Pick an org + flow from the searchable combobox.
 *  2. POST /api/v2/journey/flows/paths/query  → node tree
 *  3. GET  /api/v2/flows/milestones + /api/v2/flows/outcomes → name maps
 *  4. Build SVG: layered layout, circle size ∝ count, bezier edges ∝ count.
 *  5. Nodes are draggable; "Reset Layout" restores computed positions.
 */

import { escapeHtml } from "../../utils.js";

// ── Node type → display label helper ────────────────────────────────────────

function nodeLabel(node, milestoneNames, outcomeNames) {
  switch (node.type) {
    case "Root":         return "Start";
    case "Disconnect":   return "Disconnect";
    case "TransferToAcd":return "Transfer to ACD";
    case "Milestone": {
      const mName = node.flowMilestone?.id
        ? (milestoneNames[node.flowMilestone.id] || "Milestone")
        : "Milestone";
      return `Milestone: ${mName}`;
    }
    case "Outcome": {
      const oName = node.flowOutcome?.id
        ? (outcomeNames[node.flowOutcome.id] || "Outcome")
        : "Outcome";
      const val   = node.flowOutcomeValue === "SUCCESS"
        ? "Successful Outcome"
        : node.flowOutcomeValue === "FAILURE"
          ? "Failed Outcome"
          : "Outcome";
      return `${val}: ${oName}`;
    }
    default: return node.type;
  }
}

// ── Node type → colour ───────────────────────────────────────────────────────

function nodeColor(type, outcomeValue) {
  if (type === "Root")               return { fill: "#0e7c7b", stroke: "#0a5e5d" };
  if (type === "Disconnect")         return { fill: "#1a6b8a", stroke: "#145474" };
  if (type === "TransferToAcd")      return { fill: "#1a7f8a", stroke: "#136371" };
  if (type === "Milestone")          return { fill: "#207d7d", stroke: "#175c5c" };
  if (type === "Outcome") {
    if (outcomeValue === "SUCCESS")  return { fill: "#1d7d6a", stroke: "#155c4e" };
    if (outcomeValue === "FAILURE")  return { fill: "#7d4a1d", stroke: "#5c3615" };
  }
  return { fill: "#4a6fa5", stroke: "#375482" };
}

// ── Layout: assign depth (column) and row per column ────────────────────────

function computeLayout(elements, svgW, svgH) {
  const ids       = Object.keys(elements);
  const root      = ids.find(id => elements[id].type === "Root");
  const depthMap  = {};
  const queue     = [[root, 0]];
  const visited   = new Set();

  while (queue.length) {
    const [id, d] = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    depthMap[id] = d;
    const children = ids.filter(cid => elements[cid].parentId === id);
    // sort children by count descending to keep heaviest path near top
    children.sort((a, b) => (elements[b].count || 0) - (elements[a].count || 0));
    for (const cid of children) queue.push([cid, d + 1]);
  }

  // Group by depth
  const byDepth = {};
  for (const id of ids) {
    const d = depthMap[id] ?? 0;
    (byDepth[d] = byDepth[d] || []).push(id);
  }
  const maxDepth = Math.max(...Object.keys(byDepth).map(Number));

  const PAD_X  = 90;
  const PAD_Y  = 60;
  const colW   = (svgW - PAD_X * 2) / Math.max(maxDepth, 1);
  const positions = {};

  for (const [depthStr, colIds] of Object.entries(byDepth)) {
    const d   = Number(depthStr);
    const n   = colIds.length;
    const rowH = (svgH - PAD_Y * 2) / Math.max(n - 1, 1);
    colIds.forEach((id, i) => {
      positions[id] = {
        x: PAD_X + d * colW,
        y: n === 1 ? svgH / 2 : PAD_Y + i * rowH,
      };
    });
  }

  return { positions, depthMap };
}

// ── Build merged edge list (parent → child, aggregated count) ────────────────

function buildEdges(elements) {
  const edges = [];
  for (const [id, node] of Object.entries(elements)) {
    if (node.parentId) {
      edges.push({ from: node.parentId, to: id, count: node.count || 0 });
    }
  }
  return edges;
}

// ── SVG path: horizontal cubic bezier ────────────────────────────────────────

function bezierPath(x1, y1, x2, y2) {
  const cp = (x2 - x1) * 0.5;
  return `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
}

// ── Main page renderer ────────────────────────────────────────────────────────

export default function renderJourneyFlow({ me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <style>
      .jf-page   { display:flex; flex-direction:column; gap:16px; height:100%; }
      .jf-toolbar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
      .jf-combo  { position:relative; min-width:280px; flex:1; max-width:480px; }
      .jf-combo-input { width:100%; padding:7px 11px; border:1px solid var(--border); border-radius:8px;
                        background:var(--bg,var(--panel)); color:var(--text); font:inherit; font-size:13px;
                        outline:none; box-sizing:border-box; }
      .jf-combo-input:focus  { border-color:#3b82f6; }
      .jf-combo-input:disabled { opacity:.5; cursor:not-allowed; }
      .jf-combo-list { display:none; position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:400;
                       max-height:260px; overflow-y:auto; background:var(--panel);
                       border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.4); }
      .jf-combo-list.open { display:block; }
      .jf-combo-option { padding:7px 12px; cursor:pointer; font-size:13px;
                         border-bottom:1px solid rgba(255,255,255,.04); }
      .jf-combo-option:last-child { border-bottom:none; }
      .jf-combo-option:hover { background:rgba(59,130,246,.15); color:#93c5fd; }
      .jf-combo-noresult { padding:10px 12px; font-size:12px; color:var(--muted); text-align:center; }
      .jf-btn    { padding:7px 18px; border:1px solid var(--border); border-radius:8px; background:var(--bg,var(--panel));
                   color:var(--text); font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; }
      .jf-btn:hover:not(:disabled) { border-color:#6b7280; }
      .jf-btn:disabled { opacity:.45; cursor:not-allowed; }
      .jf-btn-primary { background:#3b82f6; color:#fff; border-color:#3b82f6; }
      .jf-btn-primary:hover:not(:disabled) { background:#2563eb; border-color:#2563eb; }
      .jf-meta   { font-size:12px; color:var(--muted); }
      .jf-status { font-size:13px; color:var(--muted); min-height:20px; }
      .jf-status--error   { color:#f87171; }
      .jf-canvas { flex:1; min-height:520px; position:relative; overflow:hidden;
                   background:var(--bg,#1a1f2e); border:1px solid var(--border); border-radius:12px; }
      .jf-canvas svg { width:100%; height:100%; display:block; }
      .jf-node        { cursor:grab; }
      .jf-node:active { cursor:grabbing; }
      .jf-node-circle { transition:filter .1s; }
      .jf-node:hover .jf-node-circle { filter:brightness(1.25); }
      .jf-node-label  { font-size:11px; fill:#cdd6f4; pointer-events:none; text-anchor:middle;
                        dominant-baseline:middle; font-family:inherit; font-weight:600;
                        text-shadow:0 1px 4px rgba(0,0,0,.8); }
      .jf-node-count  { font-size:10px; fill:rgba(205,214,244,.7); pointer-events:none; text-anchor:middle;
                        dominant-baseline:middle; font-family:inherit; }
      .jf-edge { fill:none; stroke-linecap:round; opacity:.65; pointer-events:none; }
      .jf-tooltip { position:absolute; pointer-events:none; background:rgba(15,20,35,.95);
                    border:1px solid var(--border); border-radius:8px; padding:8px 12px;
                    font-size:12px; color:var(--text); white-space:nowrap; z-index:200;
                    box-shadow:0 4px 20px rgba(0,0,0,.5); transition:opacity .1s; }
      .jf-empty { display:flex; align-items:center; justify-content:center; height:100%;
                  font-size:14px; color:var(--muted); }
      .jf-select { padding:7px 11px; border:1px solid var(--border); border-radius:8px;
                   background:var(--bg,var(--panel)); color:var(--text); font:inherit; font-size:13px;
                   cursor:pointer; outline:none; }
      .jf-select:focus { border-color:#3b82f6; }
    </style>

    <div class="jf-page">
      <div class="jf-toolbar">
        <div class="jf-combo" id="jfFlowCombo">
          <input class="jf-combo-input" id="jfFlowInput" placeholder="Loading flows…" autocomplete="off" disabled>
          <div class="jf-combo-list" id="jfFlowList"></div>
        </div>
        <select class="jf-select" id="jfCategory">
          <option value="All">All</option>
          <option value="Abandoned">Abandoned</option>
          <option value="AgentEscalation">AgentEscalation</option>
          <option value="Complete">Complete</option>
          <option value="Disconnect">Disconnect</option>
          <option value="Error">Error</option>
          <option value="RecognitionFailure">RecognitionFailure</option>
          <option value="Transfer">Transfer</option>
        </select>
        <button class="jf-btn jf-btn-primary" id="jfLoadBtn" disabled>Load</button>
        <button class="jf-btn" id="jfResetBtn" disabled>Reset Layout</button>
        <span class="jf-meta" id="jfMeta"></span>
      </div>
      <div class="jf-status" id="jfStatus"></div>
      <div class="jf-canvas" id="jfCanvas">
        <div class="jf-empty">Select a flow above and click Load</div>
      </div>
    </div>

    <div class="jf-tooltip" id="jfTooltip" style="display:none"></div>
  `;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $flowIn    = el.querySelector("#jfFlowInput");
  const $flowList  = el.querySelector("#jfFlowList");
  const $category  = el.querySelector("#jfCategory");
  const $loadBtn   = el.querySelector("#jfLoadBtn");
  const $resetBtn  = el.querySelector("#jfResetBtn");
  const $meta      = el.querySelector("#jfMeta");
  const $status    = el.querySelector("#jfStatus");
  const $canvas    = el.querySelector("#jfCanvas");
  const $tooltip   = el.querySelector("#jfTooltip");

  // ── State ──────────────────────────────────────────────────────────────────
  let allFlows      = [];
  let selectedFlow  = null;
  let positions     = {};      // { [nodeId]: { x, y } }
  let defaultPos    = {};      // copy for reset
  let elements      = {};      // the raw API elements map
  let milestoneNames = {};
  let outcomeNames   = {};

  function setStatus(msg, cls = "") {
    $status.textContent = msg;
    $status.className = "jf-status" + (cls ? ` jf-status--${cls}` : "");
  }

  // ── Combobox ───────────────────────────────────────────────────────────────
  {
    let items = [], current = "";
    function renderList(filter) {
      const q = (filter || "").toLowerCase();
      const matched = q ? items.filter(f => f.name.toLowerCase().includes(q)) : items;
      $flowList.innerHTML = matched.length
        ? matched.map(f => `<div class="jf-combo-option" data-id="${escapeHtml(f.id)}" data-name="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>`).join("")
        : `<div class="jf-combo-noresult">No results</div>`;
      $flowList.classList.add("open");
    }
    $flowIn.addEventListener("focus", () => { if (!$flowIn.disabled) { $flowIn.select(); renderList(""); } });
    $flowIn.addEventListener("input", () => renderList($flowIn.value));
    $flowIn.addEventListener("blur",  () => setTimeout(() => $flowList.classList.remove("open"), 150));
    $flowList.addEventListener("mousedown", e => {
      const opt = e.target.closest(".jf-combo-option");
      if (!opt) return;
      current = opt.dataset.id;
      $flowIn.value = opt.dataset.name;
      selectedFlow = allFlows.find(f => f.id === opt.dataset.id) || null;
      $flowList.classList.remove("open");
      $loadBtn.disabled = false;
    });
    // expose setItems
    window._jfComboSetItems = (newItems) => {
      items = newItems;
      $flowIn.disabled = false;
      $flowIn.placeholder = "Select a flow…";
    };
  }

  // ── Load flows list on org change ──────────────────────────────────────────
  async function loadFlows() {
    const org = orgContext?.getDetails?.();
    if (!org) return;
    setStatus("Loading flows…");
    try {
      let page = 1, pageCount = null;
      const flows = [];
      do {
        const r = await api.proxyGenesys(org.id, "GET", "/api/v2/flows", {
          query: { pageSize: "200", pageNumber: String(page),
                   type: "INBOUNDCALL,INBOUNDCHAT,INBOUNDEMAIL,INBOUNDSHORTMESSAGE,OUTBOUNDCALL,COMMONMODULE,INQUEUECALL" },
        });
        pageCount = r.pageCount ?? 1;
        for (const f of (r.entities || [])) flows.push({ id: f.id, name: f.name || f.id, type: f.type });
        page++;
      } while (page <= pageCount);
      flows.sort((a, b) => a.name.localeCompare(b.name));
      allFlows = flows;
      window._jfComboSetItems(flows);
      setStatus("");
    } catch (err) {
      setStatus(`Failed to load flows: ${err.message}`, "error");
    }
  }

  // Watch for org selection
  const _origGetDetails = orgContext?.getDetails?.bind(orgContext);
  let _lastOrgId = null;
  function pollOrg() {
    const org = orgContext?.getDetails?.();
    if (org && org.id !== _lastOrgId) {
      _lastOrgId = org.id;
      loadFlows();
    }
  }
  const _pollInterval = setInterval(pollOrg, 800);
  el.addEventListener("disconnected", () => clearInterval(_pollInterval));
  // Fire immediately too
  setTimeout(pollOrg, 100);

  // ── Load journey data ──────────────────────────────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org || !selectedFlow) return;

    $loadBtn.disabled = true;
    $resetBtn.disabled = true;
    $canvas.innerHTML = `<div class="jf-empty">Loading…</div>`;
    $meta.textContent = "";
    setStatus("Querying journey flow paths…");

    try {
      // 1. Path query
      const pathResp = await api.proxyGenesys(org.id, "POST",
        "/api/v2/journey/flows/paths/query", {
          body: {
            category: $category.value,
            flows: [{ id: selectedFlow.id }],
          },
        });

      elements = pathResp.elements || {};
      if (Object.keys(elements).length === 0) {
        $canvas.innerHTML = `<div class="jf-empty">No journey path data found for this flow.</div>`;
        setStatus("");
        $loadBtn.disabled = false;
        return;
      }

      // 2. Milestone + outcome names in parallel
      setStatus("Resolving names…");
      const [mResp, oResp] = await Promise.all([
        api.proxyGenesys(org.id, "GET", "/api/v2/flows/milestones", { query: { pageSize: "200" } }),
        api.proxyGenesys(org.id, "GET", "/api/v2/flows/outcomes",   { query: { pageSize: "200" } }),
      ]);
      milestoneNames = {};
      for (const m of (mResp.entities || [])) milestoneNames[m.id] = m.name;
      outcomeNames = {};
      for (const o of (oResp.entities || [])) outcomeNames[o.id] = o.name;

      // 3. Date range from response
      const dateStart = pathResp.dateStart ? pathResp.dateStart.slice(0, 10) : "–";
      const dateEnd   = pathResp.dateEnd   ? pathResp.dateEnd.slice(0, 10)   : "–";
      const rootNode  = Object.values(elements).find(n => n.type === "Root");
      const total     = rootNode?.count ?? 0;
      $meta.textContent = `${dateStart} → ${dateEnd}   ·   ${total.toLocaleString()} paths`;

      // 4. Render
      renderDiagram();
      setStatus("");
      $resetBtn.disabled = false;
    } catch (err) {
      $canvas.innerHTML = `<div class="jf-empty">Error: ${escapeHtml(err.message)}</div>`;
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $loadBtn.disabled = false;
    }
  });

  // ── Reset layout ─────────────────────────────────────────────────────────
  $resetBtn.addEventListener("click", () => {
    positions = JSON.parse(JSON.stringify(defaultPos));
    redrawAll();
  });

  // ── Diagram rendering ─────────────────────────────────────────────────────
  function renderDiagram() {
    const W = $canvas.clientWidth  || 900;
    const H = $canvas.clientHeight || 560;

    const layout = computeLayout(elements, W, H);
    positions   = layout.positions;
    defaultPos  = JSON.parse(JSON.stringify(positions));

    $canvas.innerHTML = "";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.cssText = "width:100%;height:100%;display:block;";

    // ── Defs: marker (arrow) ─────────────────────────────────────────────
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
      <marker id="jf-arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 z" fill="rgba(45,190,180,.5)"/>
      </marker>
    `;
    svg.appendChild(defs);

    // ── Edge layer ──────────────────────────────────────────────────────
    const edgeG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    edgeG.setAttribute("id", "jf-edges");
    svg.appendChild(edgeG);

    // ── Node layer ─────────────────────────────────────────────────────
    const nodeG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    nodeG.setAttribute("id", "jf-nodes");
    svg.appendChild(nodeG);

    $canvas.appendChild(svg);

    const edges     = buildEdges(elements);
    const rootNode  = Object.values(elements).find(n => n.type === "Root");
    const maxCount  = rootNode?.count || 1;

    // Circle radii
    const R_MIN = 18, R_MAX = 44;
    function radius(count) {
      return R_MIN + (R_MAX - R_MIN) * Math.sqrt(count / maxCount);
    }

    // Draw edges first
    edges.forEach(edge => {
      const p1 = positions[edge.from];
      const p2 = positions[edge.to];
      if (!p1 || !p2) return;
      const r1 = radius(elements[edge.from]?.count || 0);
      const r2 = radius(elements[edge.to]?.count   || 0);
      const strokeW = Math.max(1.5, 14 * (edge.count / maxCount));
      const alpha   = 0.25 + 0.55 * (edge.count / maxCount);

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("id",     `jf-edge-${edge.from}-${edge.to}`);
      path.setAttribute("d",      bezierPath(p1.x + r1, p1.y, p2.x - r2, p2.y));
      path.setAttribute("class",  "jf-edge");
      path.setAttribute("stroke", `rgba(45,190,180,${alpha})`);
      path.setAttribute("stroke-width", String(strokeW));
      path.setAttribute("marker-end",   "url(#jf-arr)");
      edgeG.appendChild(path);
    });

    // Draw nodes
    for (const [id, node] of Object.entries(elements)) {
      const pos = positions[id];
      if (!pos) continue;
      const r     = radius(node.count || 0);
      const color = nodeColor(node.type, node.flowOutcomeValue);
      const label = nodeLabel(node, milestoneNames, outcomeNames);

      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class",     "jf-node");
      g.setAttribute("id",        `jf-node-${id}`);
      g.setAttribute("transform", `translate(${pos.x},${pos.y})`);
      g.dataset.nodeId = id;

      // Shadow
      const shadow = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      shadow.setAttribute("r",    String(r + 3));
      shadow.setAttribute("fill", "rgba(0,0,0,.35)");
      shadow.setAttribute("cx",   "2");
      shadow.setAttribute("cy",   "3");
      g.appendChild(shadow);

      // Main circle
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("class",  "jf-node-circle");
      circle.setAttribute("r",      String(r));
      circle.setAttribute("fill",   color.fill);
      circle.setAttribute("stroke", color.stroke);
      circle.setAttribute("stroke-width", "2");
      g.appendChild(circle);

      // Label — split into two lines if long
      const words    = label.split(" ");
      const midpoint = Math.ceil(words.length / 2);
      const line1    = words.slice(0, midpoint).join(" ");
      const line2    = words.slice(midpoint).join(" ");
      const hasTwo   = line2.length > 0;

      const text1 = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text1.setAttribute("class", "jf-node-label");
      text1.setAttribute("y",     hasTwo ? "-7" : "0");
      text1.textContent = line1;
      g.appendChild(text1);

      if (hasTwo) {
        const text2 = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text2.setAttribute("class", "jf-node-label");
        text2.setAttribute("y",     "7");
        text2.textContent = line2;
        g.appendChild(text2);
      }

      // Count badge (below circle)
      const countTxt = document.createElementNS("http://www.w3.org/2000/svg", "text");
      countTxt.setAttribute("class", "jf-node-count");
      countTxt.setAttribute("y",     String(r + 14));
      countTxt.textContent = (node.count || 0).toLocaleString();
      g.appendChild(countTxt);

      nodeG.appendChild(g);

      // ── Drag ───────────────────────────────────────────────────────────
      let dragging = false, ox = 0, oy = 0;

      g.addEventListener("mousedown", e => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        const svgRect = svg.getBoundingClientRect();
        const scaleX  = (svg.viewBox.baseVal.width  || W) / svgRect.width;
        const scaleY  = (svg.viewBox.baseVal.height || H) / svgRect.height;
        ox = (e.clientX - svgRect.left) * scaleX - positions[id].x;
        oy = (e.clientY - svgRect.top)  * scaleY - positions[id].y;
        $tooltip.style.display = "none";
        g.style.cursor = "grabbing";
      });

      svg.addEventListener("mousemove", e => {
        if (!dragging) return;
        const svgRect = svg.getBoundingClientRect();
        const scaleX  = (svg.viewBox.baseVal.width  || W) / svgRect.width;
        const scaleY  = (svg.viewBox.baseVal.height || H) / svgRect.height;
        const nx = (e.clientX - svgRect.left) * scaleX - ox;
        const ny = (e.clientY - svgRect.top)  * scaleY - oy;
        positions[id] = { x: nx, y: ny };
        g.setAttribute("transform", `translate(${nx},${ny})`);
        updateEdgesForNode(id);
      });

      svg.addEventListener("mouseup",    () => { dragging = false; g.style.cursor = "grab"; });
      svg.addEventListener("mouseleave", () => { dragging = false; g.style.cursor = "grab"; });

      // ── Tooltip ─────────────────────────────────────────────────────────
      g.addEventListener("mouseenter", e => {
        const total = (Object.values(elements).find(n => n.type === "Root")?.count) || 1;
        const pct   = ((node.count / total) * 100).toFixed(1);
        $tooltip.innerHTML = `
          <strong>${escapeHtml(label)}</strong><br>
          Paths: <strong>${(node.count||0).toLocaleString()}</strong>
          &nbsp;(${pct}% of total)
        `;
        $tooltip.style.display = "block";
        positionTooltip(e);
      });
      g.addEventListener("mousemove",  positionTooltip);
      g.addEventListener("mouseleave", () => { $tooltip.style.display = "none"; });
    }
  }

  function positionTooltip(e) {
    const canvasRect = $canvas.getBoundingClientRect();
    let tx = e.clientX - canvasRect.left + 14;
    let ty = e.clientY - canvasRect.top  + 14;
    const tw = $tooltip.offsetWidth || 180;
    if (tx + tw > $canvas.clientWidth - 10) tx -= tw + 28;
    $tooltip.style.left = `${tx}px`;
    $tooltip.style.top  = `${ty}px`;
  }

  // ── Re-draw all edges for a moved node ───────────────────────────────────
  function updateEdgesForNode(movedId) {
    const svg = $canvas.querySelector("svg");
    if (!svg) return;
    const maxCount = Object.values(elements).find(n => n.type === "Root")?.count || 1;
    const R_MIN = 18, R_MAX = 44;
    function radius(count) { return R_MIN + (R_MAX - R_MIN) * Math.sqrt(count / maxCount); }

    const edges = buildEdges(elements);
    for (const edge of edges) {
      if (edge.from !== movedId && edge.to !== movedId) continue;
      const pathEl = svg.querySelector(`#jf-edge-${edge.from}-${edge.to}`);
      if (!pathEl) continue;
      const p1 = positions[edge.from];
      const p2 = positions[edge.to];
      if (!p1 || !p2) continue;
      const r1 = radius(elements[edge.from]?.count || 0);
      const r2 = radius(elements[edge.to]?.count   || 0);
      pathEl.setAttribute("d", bezierPath(p1.x + r1, p1.y, p2.x - r2, p2.y));
    }
  }

  // ── Redraw entire diagram after reset ─────────────────────────────────────
  function redrawAll() {
    const svg = $canvas.querySelector("svg");
    if (!svg) return;
    const maxCount = Object.values(elements).find(n => n.type === "Root")?.count || 1;
    const R_MIN = 18, R_MAX = 44;
    function radius(count) { return R_MIN + (R_MAX - R_MIN) * Math.sqrt(count / maxCount); }

    // Update node positions
    for (const [id, pos] of Object.entries(positions)) {
      const g = svg.querySelector(`#jf-node-${id}`);
      if (g) g.setAttribute("transform", `translate(${pos.x},${pos.y})`);
    }
    // Update all edges
    const edges = buildEdges(elements);
    for (const edge of edges) {
      const pathEl = svg.querySelector(`#jf-edge-${edge.from}-${edge.to}`);
      if (!pathEl) continue;
      const p1 = positions[edge.from];
      const p2 = positions[edge.to];
      if (!p1 || !p2) continue;
      const r1 = radius(elements[edge.from]?.count || 0);
      const r2 = radius(elements[edge.to]?.count   || 0);
      pathEl.setAttribute("d", bezierPath(p1.x + r1, p1.y, p2.x - r2, p2.y));
    }
  }

  return el;
}
