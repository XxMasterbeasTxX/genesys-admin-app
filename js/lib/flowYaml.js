/**
 * Flow YAML model — parses an Archy/SDK-exported flow YAML (already loaded into a
 * plain JS object via a YAML parser) into the same renderer-agnostic node/edge
 * model used by the Flow Overview page.
 *
 * Why YAML instead of the REST `latestconfiguration`: the YAML is a *structured,
 * nested* representation, so the implicit "Default output continues to the next
 * action" links are explicit in the ordering. The flat REST/JSON form omits those
 * links (Architect rebuilds them with its layout engine), which made them
 * impossible to draw reliably. See the Welcome/adhoc reconvergence example.
 *
 * Entry points mirror flowModel.js so the page can swap sources:
 *   parseFlowYaml(root)              → normalized `data`
 *   buildModel(data, { level })      → { level, meta, nodes, edges, warnings }
 *   buildVariableIndex(data)         → Map varName → { variable, usages[] }
 *   buildDependencyIndex(data)       → Map depKey → { id, name, type, usages[] }
 *   buildActionIndex(data)           → Map actionId → normalized action
 */

import { ACTION_KINDS } from "./flowModel.js";

// ── Small helpers ────────────────────────────────────────────────────────────

function singleKey(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj);
  return keys.length ? keys[0] : null;
}
function taskRefId(ref) {
  const m = /task\[([^\]]+)\]/.exec(String(ref || ""));
  return m ? m[1] : null;
}
function scopeOf(name) {
  const m = /^([A-Za-z]+)\./.exec(name || "");
  return m ? m[1] : "";
}
/** Read an expression/value node → its text ("exp"/"lit"/"var"/"noValue"). */
function valueText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v !== "object") return String(v);
  if (v.noValue) return "";
  if (typeof v.exp === "string") return v.exp;
  if (v.lit != null) return String(v.lit);
  if (typeof v.var === "string") return v.var;
  return "";
}

// ── Action classification (YAML action key → display kind) ───────────────────

const YAML_KIND = {
  callTask: "jump",
  callCommonModule: "callCommonModule",
  decision: "decision",
  switch: "switch",
  menu: "menu",
  getInput: "menu",
  collectInput: "collect",
  loop: "loop",
  loopNext: "loop",
  loopExit: "loop",
  endTask: "end",
  endState: "end",
  endProgram: "end",
  disconnect: "end",
  jumpToMenu: "jump",
  jumpToTask: "jump",
  transferToAcd: "transfer",
  transferToNumber: "transfer",
  transferToGroup: "transfer",
  transferToUser: "transfer",
  transferToFlow: "transfer",
  transferToFlowSecure: "transfer",
  transferToVoicemail: "transfer",
  transferToGroupVoicemail: "transfer",
  updateData: "setData",
  dataTableLookup: "dataTable",
  callData: "dataAction",
  callBridge: "action",
  evaluateScheduleGroup: "action",
  enableParticipantRecord: "action",
  setParticipantData: "setData",
  setWrapupCode: "setData",
  setLanguage: "setData",
  setScreenPop: "action",
  playAudio: "audio",
  playAudioOnSilence: "audio",
};

// Action keys that terminate a sequence (no default fall-through edge).
const TERMINAL_KINDS = new Set([
  "endTask", "endState", "endProgram", "disconnect", "jumpToTask", "jumpToMenu",
  "transferToAcd", "transferToNumber", "transferToGroup", "transferToUser",
  "transferToFlow", "transferToFlowSecure", "transferToVoicemail",
  "transferToGroupVoicemail", "loopExit", "loopNext",
]);

function kindFor(actionKey) {
  return YAML_KIND[actionKey] || "action";
}

// ── Parse ────────────────────────────────────────────────────────────────────

export function parseFlowYaml(root) {
  // js-yaml gives { <flowType>: {...} }. Accept either that or the inner object.
  let flowTypeKey = singleKey(root);
  let flow = root[flowTypeKey];
  if (!flow || (!flow.tasks && !flow.variables && !flow.name)) {
    // Maybe root IS the flow.
    flow = root;
    flowTypeKey = "flow";
  }

  const variables = parseVariables(flow.variables);
  const varNames = new Set(variables.map((v) => v.name));
  const startRef = taskRefId(flow.startUpRef);

  const tasks = [];
  const nodes = [];
  const edges = [];
  const actionById = new Map();
  const varUsages = new Map(); // varName → [usage]
  const depMap = new Map(); // key → { key, id, name, type, usages[] }

  let uid = 0;
  const newId = (taskId) => `${taskId}#${uid++}`;

  const taskList = collectTasks(flow);
  const taskByRef = new Map(taskList.map((t) => [t.refId, t]));

  const ctx = { nodes, edges, actionById, varUsages, depMap, varNames, newId, taskByRef };

  for (const t of taskList) {
    const isStart = t.refId === startRef;
    tasks.push({ id: t.refId, name: t.name, isStart });
    nodes.push({ id: t.refId, kind: "task", label: t.name, isContainer: true, isStart });
    // Each task's actions reconverge to an implicit "end of task" (no node).
    walk(t.actions || [], { taskId: t.refId, taskName: t.name, loopCtx: null }, null, ctx);
  }

  // Drop edges to unknown nodes (defensive).
  const nodeIds = new Set(nodes.map((n) => n.id));
  const cleanEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  return {
    meta: {
      name: flow.name || "(flow)",
      type: flowTypeKey,
      division: flow.division || "",
      defaultLanguage: flow.defaultLanguage || "",
      description: flow.description || "",
      taskCount: tasks.length,
      variableCount: variables.length,
    },
    variables,
    tasks,
    nodes,
    edges: cleanEdges,
    actionById,
    varUsages,
    dependencies: [...depMap.values()],
  };
}

function collectTasks(flow) {
  // tasks may be flow.tasks (array of { task: {...} }) or a map.
  const out = [];
  const arr = Array.isArray(flow.tasks) ? flow.tasks : [];
  for (const item of arr) {
    const t = item && item.task ? item.task : item;
    if (t && (t.refId || t.name)) out.push({ refId: t.refId || t.name, name: t.name || t.refId, actions: t.actions || [] });
  }
  return out;
}

function parseVariables(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const key = singleKey(item);
    if (!key) continue;
    const v = item[key];
    if (!v || !v.name) continue;
    const type = key.replace(/Variable$/, "").toLowerCase(); // string/boolean/integer/decimal/...
    out.push({
      id: v.name,
      name: v.name,
      type,
      scope: scopeOf(v.name),
      initialText: v.initialValue ? valueText(v.initialValue) : "",
      isInput: !!v.isInput,
      isOutput: !!v.isOutput,
      isSecure: !!v.isSecure,
      isCollection: /collection/i.test(key),
    });
  }
  return out;
}

// ── Recursive walk: build nodes + edges with sequential fall-through ──────────

/**
 * Walk an ordered `actions` list. `continuation` = node id to flow to when the
 * sequence ends (the sibling after the enclosing block, or null = end of task).
 * Returns the id of the first node (entry point) of this list.
 */
function walk(actions, scope, continuation, ctx) {
  if (!Array.isArray(actions) || !actions.length) return continuation;

  // First pass: create a node id for each action so we can wire fall-through.
  const items = actions.map((a) => {
    const key = singleKey(a);
    return { key, body: a[key], id: ctx.newId(scope.taskId) };
  });

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const next = i + 1 < items.length ? items[i + 1].id : continuation;
    processAction(it, next, scope, ctx);
  }
  return items[0].id;
}

function processAction(it, next, scope, ctx) {
  const { key, body, id } = it;
  const kind = kindFor(key);
  const name = (body && body.name) || key;

  const node = {
    id,
    kind,
    label: name,
    parent: scope.taskId,
    taskId: scope.taskId,
    taskName: scope.taskName,
    sublabel: "",
  };
  const action = {
    id, kind, name, actionKey: key,
    taskId: scope.taskId, taskName: scope.taskName,
    sets: [], refs: [], exprText: "", sublabel: "", depName: "", targetTaskRef: null,
    inputs: [], outputs: [],
  };

  // Collect variable references + assignments + dependency + condition text.
  extractDetails(key, body, action, ctx);
  node.sublabel = action.sublabel;

  ctx.nodes.push(node);
  ctx.actionById.set(id, action);
  recordUsages(action, ctx);

  // ── Edges by action type ───────────────────────────────────────────────────
  const addEdge = (source, target, label, ekind) => {
    if (!target) return;
    ctx.edges.push({ id: `${source}->${target}:${label || ""}`, source, target, label: label || "", kind: ekind || "flow" });
  };

  // Branching actions with named outputs.
  if (key === "decision") {
    const outs = (body && body.outputs) || {};
    for (const label of ["yes", "no"]) {
      const branch = outs[label] || outs['"' + label + '"'];
      const acts = branch && branch.actions;
      if (acts && acts.length) addEdge(id, walk(acts, scope, next, ctx), label === "yes" ? "Yes" : "No", "flow");
      else addEdge(id, next, label === "yes" ? "Yes" : "No", "flow");
    }
    return;
  }

  if (key === "switch") {
    const cases = (((body || {}).evaluate || {}).firstTrue || {}).cases || (body || {}).cases || [];
    let ci = 0;
    for (const c of cases) {
      const cc = c && c.case ? c.case : c;
      ci++;
      const label = "Case " + ci;
      const acts = cc && cc.actions;
      if (acts && acts.length) addEdge(id, walk(acts, scope, next, ctx), label, "flow");
      else addEdge(id, next, label, "flow");
    }
    // default output → continuation
    addEdge(id, next, "Default", "flow");
    return;
  }

  if (key === "menu" || key === "getInput") {
    const choices = (body && body.choices) || (body && body.outputs) || {};
    let any = false;
    for (const label of Object.keys(choices)) {
      const branch = choices[label];
      const acts = branch && branch.actions;
      any = true;
      if (acts && acts.length) addEdge(id, walk(acts, scope, next, ctx), label, "flow");
      else addEdge(id, next, label, "flow");
    }
    if (!any) addEdge(id, next, "", "flow");
    return;
  }

  if (key === "loop") {
    const outs = (body && body.outputs) || {};
    const bodyActs = (outs.loop && outs.loop.actions) || [];
    const loopScope = { ...scope, loopCtx: { loopId: id, exitId: next } };
    if (bodyActs.length) addEdge(id, walkLoopBody(bodyActs, loopScope, id, ctx), "Loop", "flow");
    addEdge(id, next, "Exit", "flow");
    return;
  }

  if (key === "loopNext") { addEdge(id, scope.loopCtx ? scope.loopCtx.loopId : next, "", "flow"); return; }
  if (key === "loopExit") { addEdge(id, scope.loopCtx ? scope.loopCtx.exitId : next, "", "flow"); return; }

  if (key === "callTask") {
    const ref = taskRefId(body && body.targetTaskRef);
    if (ref && ctx.taskByRef.has(ref)) addEdge(id, ref, "call", "jump");
    action.targetTaskRef = ref;
    addEdge(id, next, "", "flow"); // returns via Default to the next sibling
    return;
  }

  if (TERMINAL_KINDS.has(key)) {
    // Terminal: no default edge. (Transfers may add a failure output later.)
    return;
  }

  // Default: sequential action → next.
  addEdge(id, next, "", "flow");
}

/** Loop body: fall-through end returns to the loop node (iterate). */
function walkLoopBody(actions, scope, loopId, ctx) {
  return walk(actions, scope, loopId, ctx);
}

// ── Detail extraction (deps, assignments, variable refs, condition) ──────────

function extractDetails(key, body, action, ctx) {
  if (!body || typeof body !== "object") return;

  if (key === "decision" && body.condition) action.exprText = valueText(body.condition);
  if (key === "switch") action.exprText = "switch";

  if (key === "callCommonModule" && body.commonModule) {
    const modName = singleKey(body.commonModule);
    action.depName = modName || "";
    action.sublabel = modName || "";
    addDep(ctx, "commonModule", modName, action);
  }
  if (key === "dataTableLookup" && body.dataTable) {
    const tbl = singleKey(body.dataTable);
    action.depName = tbl || "";
    action.sublabel = tbl || "";
    addDep(ctx, "dataTable", tbl, action);
  }
  if (key === "callData") {
    const nm = body.name || "";
    action.sublabel = nm;
    addDep(ctx, "dataAction", body.dataAction || nm, action);
  }
  if (key === "callTask") action.sublabel = "Task: " + ((body.targetTaskRef && taskRefId(body.targetTaskRef)) || "");

  // updateData assignments.
  if (key === "updateData" && Array.isArray(body.statements)) {
    for (const st of body.statements) {
      const t = singleKey(st);
      const s = st[t];
      if (s && s.variable) action.sets.push({ target: s.variable, value: valueText(s.value) });
    }
  }

  // Deep-scan for variable references (exp/var/variable tokens) matching declared vars.
  const refs = new Set();
  collectRefs(body, refs, ctx.varNames);
  action.refs = [...refs];
}

function addDep(ctx, type, name, action) {
  if (!name) return;
  const key = `${type}:${name}`;
  let dep = ctx.depMap.get(key);
  if (!dep) { dep = { key, id: name, name, type, usages: [] }; ctx.depMap.set(key, dep); }
  dep.usages.push({ actionId: action.id, actionName: action.name, taskId: action.taskId, taskName: action.taskName });
}

function collectRefs(node, out, varNames) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) collectRefs(x, out, varNames); return; }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if ((k === "exp" || k === "var" || k === "variable") && typeof v === "string") {
      for (const name of varNames) if (v.includes(name)) out.add(name);
    } else if (v && typeof v === "object") {
      collectRefs(v, out, varNames);
    }
  }
}

function recordUsages(action, ctx) {
  const seen = new Set();
  const add = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    if (!ctx.varUsages.has(name)) ctx.varUsages.set(name, []);
    ctx.varUsages.get(name).push({
      taskId: action.taskId, taskName: action.taskName,
      actionId: action.id, actionName: action.name, kind: action.kind,
      exprText: action.exprText || (action.sets[0] ? `${action.sets[0].target} = ${action.sets[0].value}` : ""),
    });
  };
  for (const r of action.refs) add(r);
  for (const s of action.sets) add(s.target);
}

// ── Indexes + model (mirror flowModel API) ───────────────────────────────────

export function buildActionIndex(data) {
  return data.actionById;
}

export function buildVariableIndex(data) {
  const index = new Map();
  for (const v of data.variables) index.set(v.name, { variable: v, usages: [] });
  for (const [name, usages] of data.varUsages) {
    let entry = index.get(name);
    if (!entry) { entry = { variable: { id: name, name, type: "", scope: scopeOf(name), isSystem: true }, usages: [] }; index.set(name, entry); }
    entry.usages = usages;
  }
  return index;
}

export function buildDependencyIndex(data) {
  const index = new Map();
  for (const d of data.dependencies) index.set(d.key, d);
  return index;
}

export function buildModel(data, opts = {}) {
  const level = opts.level || "high";
  if (level === "high") {
    return { level, meta: data.meta, nodes: data.nodes, edges: data.edges, warnings: [] };
  }
  // mid / low derived from tasks + dependencies.
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const pushEdge = (s, t, label, kind) => { const id = `${kind}:${s}->${t}`; if (seen.has(id)) return; seen.add(id); edges.push({ id, source: s, target: t, label, kind }); };

  if (level === "mid") {
    for (const t of data.tasks) nodes.push({ id: t.id, kind: "task", label: t.name, isStart: t.isStart });
    const taskIds = new Set(nodes.map((n) => n.id));
    // task→task edges from callTask jumps
    for (const e of data.edges) {
      if (e.kind === "jump") {
        const from = data.actionById.get(e.source);
        if (from && taskIds.has(from.taskId) && taskIds.has(e.target) && from.taskId !== e.target) pushEdge(from.taskId, e.target, "", "jump");
      }
    }
    for (const dep of data.dependencies) {
      const depNode = `dep:${dep.key}`;
      nodes.push({ id: depNode, kind: depKind(dep.type), label: dep.name, depType: dep.type, isDependency: true });
      for (const u of dep.usages) if (taskIds.has(u.taskId)) pushEdge(u.taskId, depNode, "", "dep");
    }
    return { level, meta: data.meta, nodes, edges, warnings: [] };
  }

  // low
  const flowId = "__flow__";
  nodes.push({ id: flowId, kind: "task", label: data.meta.name, isStart: true, isFlowRoot: true });
  for (const dep of data.dependencies) {
    const depNode = `dep:${dep.key}`;
    nodes.push({ id: depNode, kind: depKind(dep.type), label: dep.name, depType: dep.type, isDependency: true, sublabel: `${dep.usages.length} use${dep.usages.length === 1 ? "" : "s"}` });
    edges.push({ id: `dep:${flowId}->${depNode}`, source: flowId, target: depNode, label: "", kind: "dep" });
  }
  return { level, meta: data.meta, nodes, edges, warnings: [] };
}

function depKind(type) {
  if (type === "commonModule") return "callCommonModule";
  if (type === "dataTable") return "dataTable";
  if (type === "dataAction") return "dataAction";
  return "action";
}

export { ACTION_KINDS };
