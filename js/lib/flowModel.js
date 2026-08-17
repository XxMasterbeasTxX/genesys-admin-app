/**
 * Flow model — pure, renderer-agnostic normalization of a Genesys Architect flow
 * configuration (the JSON returned by GET /api/v2/flows/{id}/latestconfiguration,
 * which is the same shape as an Architect `.i3*` export plus a `manifest`).
 *
 * It turns the raw config into node/edge lists at three detail levels plus two
 * cross-reference indexes that power the search / click-to-node UX:
 *
 *   buildModel(cfg, { level })   → { meta, nodes, edges, level, warnings }
 *   buildVariableIndex(cfg)      → Map varId → { variable, usages[] }
 *   buildDependencyIndex(cfg)    → Map depKey → { id, name, type, usages[] }
 *   buildActionIndex(cfg)        → Map actionId → { taskId, taskName, action }
 *
 * Detail levels:
 *   "high" — every task (as a container) with every action inside it, all edges.
 *   "mid"  — one node per task + one node per dependency; task→task jumps and
 *            task→dependency edges.
 *   "low"  — one node for the flow + one node per direct dependency.
 *
 * No DOM, no network, no layout engine here — this module is easily unit-tested
 * against a saved config. Layout (ELK) and rendering (SVG) live in the page.
 */

// ── Action classification ────────────────────────────────────────────────────
// Architect action objects carry no explicit "type" field; the kind is inferred
// from which properties are present. Dependency-call actions are additionally
// tagged authoritatively from the manifest (see buildManifestTags).

export const ACTION_KINDS = Object.freeze({
  start: { label: "Start", color: "#0e7c7b" },
  end: { label: "End / Disconnect", color: "#8a4b2f" },
  decision: { label: "Decision", color: "#b8860b" },
  switch: { label: "Switch", color: "#a9760b" },
  menu: { label: "Menu", color: "#6a4ba8" },
  collect: { label: "Collect Input", color: "#6a4ba8" },
  transfer: { label: "Transfer", color: "#1a6b8a" },
  callCommonModule: { label: "Call Common Module", color: "#2c7a4b" },
  dataTable: { label: "Data Table Lookup", color: "#2c6a7a" },
  dataAction: { label: "Call Data Action", color: "#2c6a7a" },
  jump: { label: "Jump to Task", color: "#7a5a2c" },
  bot: { label: "Call Bot Flow", color: "#7a2c6a" },
  loop: { label: "Loop", color: "#5a6b2c" },
  setData: { label: "Update / Set Data", color: "#4a6fa5" },
  audio: { label: "Play Audio / Prompt", color: "#4a6fa5" },
  action: { label: "Action", color: "#4a6fa5" },
});

/** Build a map of actionId → dependency tag from the manifest. */
function buildManifestTags(cfg) {
  const tags = new Map(); // actionId → { kind, depType, depId, depName }
  const m = cfg.manifest || {};
  const add = (list, kind, depType) => {
    for (const dep of list || []) {
      for (const ctx of dep.context || []) {
        if (ctx.id) tags.set(ctx.id, { kind, depType, depId: dep.id, depName: dep.name });
      }
    }
  };
  add(m.commonModuleFlow, "callCommonModule", "commonModule");
  add(m.dataTable, "dataTable", "dataTable");
  add(m.dataAction, "dataAction", "dataAction");
  add(m.inqueueCallFlow, "transfer", "inqueueCall");
  return tags;
}

/** Infer a display kind for an action. `tag` is the manifest tag if any. */
export function classifyAction(a, tag) {
  const name = (a.name || "").toLowerCase();
  if (tag && tag.kind) return tag.kind;
  if (a.taskReference || a.taskName) return "jump";
  if (a.datatableId) return "dataTable";
  if (a.flowId && a.flowName) return "callCommonModule";
  if (a.actionId && a.category) return "dataAction";
  if (a.cases) return "switch";
  if (a.queues || a.externalNumber || a.preTransferAudio || a.failureTransferAudio || a.inQueueFlowId)
    return "transfer";
  if (a.prompts && Array.isArray(a.paths) && a.paths.length > 2) return "menu";
  if (a.numberOfDigitsMax != null || a.interDigitTimeout != null) return "collect";
  if (a.expression && Array.isArray(a.paths) && a.paths.length >= 2) return "decision";
  if (/disconnect/.test(name)) return "end";
  if (/^end task$/.test(name) || /^end (state|program)$/.test(name)) return "end";
  if (/loop/.test(name)) return "loop";
  if (/^(set|update|initial|calculate|get |look ?up)/.test(name)) return "setData";
  if (/(play|audio|prompt|announcement|phrase)/.test(name)) return "audio";
  return "action";
}

// ── Reference collection (variables) ─────────────────────────────────────────
// Architect tracks variable references inside every value/expression object under
// `metaData.references: [{ id, name, isSysRef, type }]` and inside operands as
// `{ ref: { val, text, type } }`. We deep-scan an action to gather all of them,
// which covers expressions, switch cases, input/output bindings and error
// bindings without needing to know each field name.

function collectVarRefsDeep(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectVarRefsDeep(item, out);
    return;
  }
  if (Array.isArray(node.references)) {
    for (const r of node.references) {
      if (r && r.id) out.set(r.id, { id: r.id, name: r.name || r.id, isSysRef: !!r.isSysRef, type: r.type });
    }
  }
  if (node.ref && typeof node.ref === "object" && node.ref.val) {
    const r = node.ref;
    if (!out.has(r.val)) out.set(r.val, { id: r.val, name: r.text || r.val, isSysRef: false, type: r.type });
  }
  for (const key of Object.keys(node)) {
    // Skip the reverse-heavy `paths` sub-trees? No — value bindings can live
    // anywhere; deep-scan everything except obviously huge non-ref keys.
    const v = node[key];
    if (v && typeof v === "object") collectVarRefsDeep(v, out);
  }
}

/** A short human string describing where in an action a value lives. */
function firstExprText(a) {
  if (a.expression && a.expression.text) return a.expression.text;
  if (Array.isArray(a.cases) && a.cases[0] && a.cases[0].value && a.cases[0].value.text)
    return a.cases[0].value.text;
  return "";
}

// ── Indexes ──────────────────────────────────────────────────────────────────

/** Map every action id → { taskId, taskName, action }. */
export function buildActionIndex(cfg) {
  const idx = new Map();
  for (const t of cfg.flowSequenceItemList || []) {
    for (const a of t.actionList || []) {
      idx.set(a.id, { taskId: t.id, taskName: t.name || "(initial)", action: a });
    }
  }
  return idx;
}

/**
 * Variable cross-reference index: varId → { variable, usages[] }.
 * `usages` = [{ taskId, taskName, actionId, actionName, kind, exprText }].
 * Includes every declared variable (even unused, usages: []).
 */
export function buildVariableIndex(cfg) {
  const tags = buildManifestTags(cfg);
  const index = new Map();

  // Seed with declared variables so unused ones are still listed.
  for (const v of cfg.variables || []) {
    index.set(v.id, { variable: normalizeVariable(v), usages: [] });
  }

  for (const t of cfg.flowSequenceItemList || []) {
    for (const a of t.actionList || []) {
      const refs = new Map();
      collectVarRefsDeep(a, refs);
      if (!refs.size) continue;
      const kind = classifyAction(a, tags.get(a.id));
      const exprText = firstExprText(a);
      for (const r of refs.values()) {
        let entry = index.get(r.id);
        if (!entry) {
          // A reference to something not in the declared list (system/built-in
          // variable). Still track it so search finds it.
          entry = { variable: { id: r.id, name: r.name, type: r.type || "", scope: scopeOf(r.name), isSystem: true }, usages: [] };
          index.set(r.id, entry);
        }
        entry.usages.push({
          taskId: t.id,
          taskName: t.name || "(initial)",
          actionId: a.id,
          actionName: a.name || "(action)",
          kind,
          exprText,
        });
      }
    }
  }
  return index;
}

function scopeOf(name) {
  const m = /^([A-Za-z]+)\./.exec(name || "");
  return m ? m[1] : "";
}

function normalizeVariable(v) {
  return {
    id: v.id,
    name: v.name,
    type: v.initialValue && v.initialValue.type ? v.initialValue.type : (v.type || ""),
    scope: scopeOf(v.name),
    isInput: !!v.isInput,
    isOutput: !!v.isOutput,
    isSecure: !!v.isSecure,
    isCollection: !!v.isCollection,
    initialText: v.initialValue && typeof v.initialValue.text === "string" ? v.initialValue.text : "",
  };
}

/**
 * Dependency cross-reference index from the manifest: depKey → { id, name,
 * type, usages[] }. `usages` action ids resolved to their task via actionIndex.
 */
export function buildDependencyIndex(cfg) {
  const actionIndex = buildActionIndex(cfg);
  const m = cfg.manifest || {};
  const index = new Map();
  const addGroup = (list, type) => {
    for (const dep of list || []) {
      const key = `${type}:${dep.id}`;
      const usages = (dep.context || []).map((ctx) => {
        const loc = actionIndex.get(ctx.id);
        return {
          actionId: ctx.id,
          actionName: ctx.name || (loc && loc.action.name) || "(action)",
          actionType: ctx.actionName || "",
          taskId: loc ? loc.taskId : null,
          taskName: loc ? loc.taskName : null,
        };
      });
      index.set(key, { key, id: dep.id, name: dep.name, type, usages });
    }
  };
  addGroup(m.commonModuleFlow, "commonModule");
  addGroup(m.inqueueCallFlow, "inqueueCall");
  addGroup(m.dataTable, "dataTable");
  addGroup(m.dataAction, "dataAction");
  addGroup(m.userPrompt, "userPrompt");
  return index;
}

// ── Edge resolution within/between tasks ─────────────────────────────────────
// An action continues via `nextAction` (single) and/or branches via `paths[]`.
// A path with `nextActionId` jumps there; a path WITHOUT one falls through to the
// action's `nextAction`. Actions with neither are terminal.
//
// Loop actions additionally carry a singular `path` object (the loop-back output,
// e.g. { nextActionId, label:"Loop" }) alongside their `nextAction` (loop exit).

function actionEdges(a) {
  const edges = []; // { target, label }
  const paths = Array.isArray(a.paths) ? a.paths : [];
  let fallthroughUsed = false;
  for (const p of paths) {
    if (p.nextActionId) {
      edges.push({ target: p.nextActionId, label: p.label || "" });
    } else if (a.nextAction && !fallthroughUsed) {
      // Only the FIRST target-less output (the default) continues to
      // `nextAction`. Any further target-less outputs are genuinely unconnected
      // in the flow (dead-ends) and must not be wired to nextAction as well.
      edges.push({ target: a.nextAction, label: p.label || "" });
      fallthroughUsed = true;
    }
  }
  // Singular `path` (Loop actions): a distinct loop-back edge.
  const singlePaths = a.path ? (Array.isArray(a.path) ? a.path : [a.path]) : [];
  for (const p of singlePaths) {
    if (p && p.nextActionId) edges.push({ target: p.nextActionId, label: p.label || "Loop" });
  }
  if (!paths.length && a.nextAction) {
    edges.push({ target: a.nextAction, label: "" });
  } else if (paths.length && a.nextAction && !fallthroughUsed) {
    // nextAction not consumed by any path → still a real continuation edge.
    edges.push({ target: a.nextAction, label: "" });
  }
  return edges;
}

// ── Model builders per level ─────────────────────────────────────────────────

function flowMeta(cfg) {
  return {
    name: cfg.name || "(unnamed flow)",
    type: cfg.type || "",
    description: cfg.description || "",
    defaultLanguage: cfg.defaultLanguage || "",
    supportedLanguages: cfg.supportedLanguages || [],
    initialSequence: cfg.initialSequence || null,
    variableCount: (cfg.variables || []).length,
    taskCount: (cfg.flowSequenceItemList || []).length,
  };
}

function buildHigh(cfg) {
  const tags = buildManifestTags(cfg);
  const actionIndex = buildActionIndex(cfg);
  const nodes = [];
  const edges = [];
  const startId = cfg.initialSequence;

  for (const t of cfg.flowSequenceItemList || []) {
    const isStartTask = t.id === startId;
    nodes.push({
      id: t.id,
      kind: "task",
      label: t.name || "(initial)",
      isContainer: true,
      isStart: isStartTask,
    });
    for (const a of t.actionList || []) {
      const tag = tags.get(a.id);
      const kind = classifyAction(a, tag);
      nodes.push({
        id: a.id,
        kind,
        label: a.name || ACTION_KINDS[kind]?.label || "action",
        sublabel: depLabel(a, tag),
        parent: t.id,
        taskId: t.id,
        taskName: t.name || "(initial)",
        isTaskStart: a.id === t.startAction,
      });
      // Intra/inter-task edges from this action.
      for (const e of actionEdges(a)) {
        edges.push({ id: `${a.id}->${e.target}`, source: a.id, target: e.target, label: e.label, kind: "flow" });
      }
      // Task jumps.
      if (a.taskReference) {
        edges.push({ id: `${a.id}=>${a.taskReference}`, source: a.id, target: a.taskReference, label: "task", kind: "jump" });
      }
    }
  }

  // Drop edges whose target doesn't resolve to a known node (defensive).
  const nodeIds = new Set(nodes.map((n) => n.id));
  const cleanEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  const warnings = [];
  if (cleanEdges.length !== edges.length)
    warnings.push(`${edges.length - cleanEdges.length} edge(s) referenced an unknown node and were dropped.`);
  return { nodes, edges: cleanEdges, warnings, actionIndex };
}

function depLabel(a, tag) {
  if (tag && tag.depName) return tag.depName;
  if (a.flowName) return a.flowName;
  if (a.datatableName) return a.datatableName;
  if (a.actionName) return a.actionName;
  if (a.taskName) return a.taskName;
  return "";
}

function buildMid(cfg) {
  const actionIndex = buildActionIndex(cfg);
  const depIndex = buildDependencyIndex(cfg);
  const nodes = [];
  const edges = [];
  const startId = cfg.initialSequence;
  const seenEdge = new Set();
  const pushEdge = (source, target, label, kind) => {
    const id = `${kind}:${source}->${target}`;
    if (seenEdge.has(id)) return;
    seenEdge.add(id);
    edges.push({ id, source, target, label, kind });
  };

  for (const t of cfg.flowSequenceItemList || []) {
    nodes.push({ id: t.id, kind: "task", label: t.name || "(initial)", isStart: t.id === startId });
  }
  const taskIds = new Set(nodes.map((n) => n.id));

  // Task→task edges: explicit jumps + cross-task branch targets.
  for (const t of cfg.flowSequenceItemList || []) {
    for (const a of t.actionList || []) {
      if (a.taskReference && taskIds.has(a.taskReference) && a.taskReference !== t.id) {
        pushEdge(t.id, a.taskReference, a.name || "jump", "jump");
      }
      for (const e of actionEdges(a)) {
        const loc = actionIndex.get(e.target);
        if (loc && loc.taskId !== t.id) pushEdge(t.id, loc.taskId, "", "flow");
      }
    }
  }

  // Dependency nodes + task→dependency edges.
  for (const dep of depIndex.values()) {
    if (!dep.usages.length) continue;
    const depNodeId = `dep:${dep.key}`;
    nodes.push({ id: depNodeId, kind: depKindFor(dep.type), label: dep.name, depType: dep.type, isDependency: true });
    for (const u of dep.usages) {
      if (u.taskId && taskIds.has(u.taskId)) pushEdge(u.taskId, depNodeId, "", "dep");
    }
  }

  return { nodes, edges, warnings: [], actionIndex };
}

function depKindFor(type) {
  if (type === "commonModule") return "callCommonModule";
  if (type === "dataTable") return "dataTable";
  if (type === "dataAction") return "dataAction";
  if (type === "inqueueCall") return "transfer";
  return "action";
}

function buildLow(cfg) {
  const depIndex = buildDependencyIndex(cfg);
  const nodes = [];
  const edges = [];
  const flowId = "__flow__";
  nodes.push({ id: flowId, kind: "task", label: cfg.name || "(flow)", isStart: true, isFlowRoot: true });
  for (const dep of depIndex.values()) {
    if (!dep.usages.length) continue;
    const depNodeId = `dep:${dep.key}`;
    nodes.push({
      id: depNodeId,
      kind: depKindFor(dep.type),
      label: dep.name,
      depType: dep.type,
      isDependency: true,
      sublabel: `${dep.usages.length} use${dep.usages.length === 1 ? "" : "s"}`,
    });
    edges.push({ id: `dep:${flowId}->${depNodeId}`, source: flowId, target: depNodeId, label: "", kind: "dep" });
  }
  return { nodes, edges, warnings: [], actionIndex: buildActionIndex(cfg) };
}

/**
 * Build a renderer-agnostic model at the requested detail level.
 * @param {object} cfg   The latestconfiguration JSON.
 * @param {object} opts  { level: "high"|"mid"|"low" }
 */
export function buildModel(cfg, opts = {}) {
  const level = opts.level || "high";
  let built;
  if (level === "low") built = buildLow(cfg);
  else if (level === "mid") built = buildMid(cfg);
  else built = buildHigh(cfg);
  return {
    level,
    meta: flowMeta(cfg),
    nodes: built.nodes,
    edges: built.edges,
    warnings: built.warnings || [],
  };
}
