/**
 * Flow layout — turns a renderer-agnostic flow model (js/lib/flowModel.js) into
 * positioned nodes and routed edges using the ELK layered algorithm.
 *
 * ELK is loaded globally from index.html (`window.ELK`, the vendored
 * js/lib/elk.bundled.js UMD bundle). This module is the only place that knows
 * about ELK; the page consumes the plain `{ nodes, edges, width, height }`
 * result and draws SVG.
 *
 * Coordinate model (verified against elkjs 0.9):
 *   - Node x/y are relative to the PARENT node → we accumulate parent offsets to
 *     get absolute positions.
 *   - Edge section points are relative to `edge.container` (a node id, or the
 *     root) → we offset by that container's absolute position.
 */

const NODE_MIN_W = 128;
const NODE_MAX_W = 280;
const NODE_H = 38;
const NODE_H_SUB = 52;

/** Approximate on-screen width for a node given its label/sublabel. */
function nodeSize(node) {
  const labelLen = (node.label || "").length;
  const subLen = (node.sublabel || "").length;
  const w = Math.max(NODE_MIN_W, Math.min(NODE_MAX_W, Math.max(labelLen, subLen) * 7.2 + 30));
  const h = node.sublabel ? NODE_H_SUB : NODE_H;
  return { w: Math.round(w), h };
}

const BASE_OPTS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "44",
  "elk.spacing.nodeNode": "26",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.spacing.edgeNode": "16",
  "elk.spacing.edgeEdge": "12",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.crossingMinimization.semiInteractive": "true",
};

/** Build the ELK graph JSON from the model. */
function toElkGraph(model) {
  const sizes = new Map();
  for (const n of model.nodes) sizes.set(n.id, nodeSize(n));

  if (model.level === "high") {
    const containers = new Map();
    for (const n of model.nodes) {
      if (n.isContainer) {
        containers.set(n.id, {
          id: n.id,
          layoutOptions: { "elk.padding": "[top=36,left=16,bottom=16,right=16]" },
          children: [],
        });
      }
    }
    const orphans = [];
    for (const n of model.nodes) {
      if (n.isContainer) continue;
      const sz = sizes.get(n.id);
      const child = { id: n.id, width: sz.w, height: sz.h };
      const parent = n.parent && containers.get(n.parent);
      if (parent) parent.children.push(child);
      else orphans.push(child);
    }
    return {
      id: "root",
      layoutOptions: BASE_OPTS,
      children: [...containers.values(), ...orphans],
      edges: model.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };
  }

  // Flat layout (mid / low).
  return {
    id: "root",
    layoutOptions: BASE_OPTS,
    children: model.nodes.map((n) => {
      const sz = sizes.get(n.id);
      return { id: n.id, width: sz.w, height: sz.h };
    }),
    edges: model.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
}

/** Recursively record absolute positions of every node. */
function collectAbsolute(elkNode, offX, offY, out) {
  for (const c of elkNode.children || []) {
    const ax = offX + (c.x || 0);
    const ay = offY + (c.y || 0);
    out.set(c.id, { x: ax, y: ay, w: c.width || 0, h: c.height || 0 });
    if (c.children && c.children.length) collectAbsolute(c, ax, ay, out);
  }
}

/** Gather every edge in the laid-out graph (root + nested), with container id. */
function collectEdges(elkNode, out) {
  for (const e of elkNode.edges || []) out.push({ edge: e, container: elkNode.id });
  for (const c of elkNode.children || []) collectEdges(c, out);
}

/**
 * Lay out a model. Returns:
 *   { nodes: [{...modelNode, x,y,w,h}], edges: [{...modelEdge, points:[{x,y}]}],
 *     width, height }
 */
export async function layoutModel(model) {
  if (typeof window === "undefined" || !window.ELK) {
    throw new Error("ELK layout engine not loaded (js/lib/elk.bundled.js).");
  }
  const elk = new window.ELK();
  const graph = toElkGraph(model);
  const laid = await elk.layout(graph);

  const absPos = new Map();
  collectAbsolute(laid, 0, 0, absPos);

  const modelById = new Map(model.nodes.map((n) => [n.id, n]));
  const nodes = [];
  for (const [id, pos] of absPos) {
    const mn = modelById.get(id);
    if (mn) nodes.push({ ...mn, ...pos });
  }

  const rawEdges = [];
  collectEdges(laid, rawEdges);
  const modelEdgeById = new Map(model.edges.map((e) => [e.id, e]));
  const edges = [];
  for (const { edge, container } of rawEdges) {
    const me = modelEdgeById.get(edge.id);
    const cont = container === laid.id ? { x: 0, y: 0 } : absPos.get(container) || { x: 0, y: 0 };
    const sec = (edge.sections && edge.sections[0]) || null;
    if (!sec) continue;
    const pts = [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint].map((p) => ({
      x: p.x + cont.x,
      y: p.y + cont.y,
    }));
    edges.push({ ...(me || { id: edge.id, kind: "flow" }), points: pts });
  }

  return {
    nodes,
    edges,
    width: laid.width || 1000,
    height: laid.height || 800,
  };
}
