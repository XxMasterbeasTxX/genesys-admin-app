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
/**
 * refId out of a jump pointer, which addresses either collection:
 *   "/inboundCall/tasks/task[Main_12]"      → "Main_12"
 *   "/inboundCall/menus/menu[Leasy - Main_44]" → "Leasy - Main_44"
 * Menus are containers keyed by refId alongside tasks, so both resolve the same.
 */
function jumpTargetId(ref) {
  const m = /(?:task|menu|state|bot)\[([^\]]+)\]/.exec(String(ref || ""));
  return m ? m[1] : null;
}
function scopeOf(name) {
  const m = /^([A-Za-z]+)\./.exec(name || "");
  return m ? m[1] : "";
}
/** "success"→"Success", "notFound"→"Not Found", '"yes"'→"Yes". */
function prettyOutputLabel(l) {
  l = String(l == null ? "" : l).replace(/^"|"$/g, "");
  if (!l) return "";
  return (l.charAt(0).toUpperCase() + l.slice(1)).replace(/([a-z])([A-Z])/g, "$1 $2");
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
  repeatMenu: "menu",
  collectInput: "collect",
  loop: "loop",
  loopNext: "loop",
  loopExit: "loop",
  endTask: "end",
  endState: "end",
  endProgram: "end",
  disconnect: "end",
  exitBotFlow: "end",
  askForSlot: "collect",
  askForBoolean: "collect",
  askForIntent: "collect",
  jumpToMenu: "jump",
  jumpToTask: "jump",
  changeState: "jump",
  callDigitalBotFlow: "bot",
  callBotFlow: "bot",
  callBot: "bot",
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
  "endTask", "endState", "endProgram", "disconnect", "exitBotFlow",
  "jumpToTask", "jumpToMenu", "changeState",
  "transferToAcd", "transferToNumber", "transferToGroup", "transferToUser",
  "transferToFlow", "transferToFlowSecure", "transferToVoicemail",
  "transferToGroupVoicemail", "loopExit", "loopNext",
]);

function kindFor(actionKey) {
  return YAML_KIND[actionKey] || "action";
}

// The primary/continuation output of a branching action is usually OMITTED from
// the YAML `outputs` (it just continues to the next sibling). If none of these
// keys is present, we add the implicit primary edge, labelled per action type.
const PRIMARY_OUTPUT_KEYS = new Set(["found", "success", "default", "out", "complete", "exit"]);
const PRIMARY_OUTPUT_LABEL = {
  dataTableLookup: "Found",
  callData: "Success",
  callBridge: "Success",
  collectInput: "Next",
};

// ── Parse ────────────────────────────────────────────────────────────────────

export function parseFlowYaml(root) {
  // js-yaml gives { <flowType>: {...} }. Accept either that or the inner object.
  let flowTypeKey = singleKey(root);
  let flow = root[flowTypeKey];
  if (!flow || (!flow.tasks && !flow.states && !flow.variables && !flow.name)) {
    // Maybe root IS the flow.
    flow = root;
    flowTypeKey = "flow";
  }

  const taskList = collectTasks(flow);

  // Task- and state-scoped variables are declared on their container rather than
  // at flow level. Without them, Task.X / State.X turn up in the search panel as
  // untyped synthetic entries. Names are deduped: two tasks may each declare a
  // Task.-scoped variable of the same name.
  const variables = [];
  const seenVar = new Set();
  for (const v of [...parseVariables(flow.variables), ...taskList.flatMap((t) => parseVariables(t.variables))]) {
    if (seenVar.has(v.name)) continue;
    seenVar.add(v.name);
    variables.push(v);
  }
  const varNames = new Set(variables.map((v) => v.name));
  // startUpRef addresses a task OR a state, depending on the flow type.
  const startRef = jumpTargetId(flow.startUpRef);

  const tasks = [];
  const nodes = [];
  const edges = [];
  const actionById = new Map();
  const varUsages = new Map(); // varName → [usage]
  const depMap = new Map(); // key → { key, id, name, type, usages[] }

  let uid = 0;
  const newId = (taskId) => `${taskId}#${uid++}`;

  const taskByRef = new Map(taskList.map((t) => [t.refId, t]));
  const hasStartRef = !!startRef && taskList.some((t) => t.refId === startRef);

  const ctx = { nodes, edges, actionById, varUsages, depMap, varNames, newId, taskByRef };

  taskList.forEach((t, i) => {
    const isStart = hasStartRef ? t.refId === startRef : (!t.isMenu && (t.isStartup || i === 0));
    tasks.push({ id: t.refId, name: t.name, isStart, isMenu: !!t.isMenu, isState: !!t.isState, isBot: !!t.isBot });
    nodes.push({ id: t.refId, kind: "task", label: t.name, isContainer: true, isStart, isMenu: !!t.isMenu, isState: !!t.isState, isBot: !!t.isBot });
    // Each task's actions reconverge to an implicit "end of task" (no node).
    // `walk` returns the id of the task's first (entry) action. In tasks whose
    // first action is a loop, that entry node has ONLY loop-back incoming edges,
    // so ELK can't tell it's the start — mark it explicitly so the layout can
    // pin it to the first layer (top of the container).
    const entryId = walk(t.actions || [], { taskId: t.refId, taskName: t.name, containerId: t.refId, loopCtx: null }, null, ctx);
    const entryNode = nodes.find((n) => n.id === entryId);
    if (entryNode && !entryNode.isContainer) entryNode.isEntry = true;
    tasks[tasks.length - 1].entryId = entryId || null;
  });

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
      taskCount: tasks.filter((t) => !t.isMenu && !t.isState && !t.isBot).length,
      menuCount: tasks.filter((t) => t.isMenu).length,
      stateCount: tasks.filter((t) => t.isState).length,
      botCount: tasks.filter((t) => t.isBot).length,
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

/**
 * Architect groups a flow's top level into refId-keyed collections that vary by
 * flow type: `states` for messaging and email, `bots` for bot flows, `tasks`
 * everywhere. All three are plain action lists and become containers the same
 * way; `menus` (call flows) is handled separately because a menu is a prompt
 * plus choices rather than a sequence. Non-task collections come first so the
 * flow's entry container reads at the top of the diagram.
 */
const CONTAINER_COLLECTIONS = [
  { key: "states", item: "state", flag: "isState" },
  { key: "bots", item: "bot", flag: "isBot" },
  { key: "tasks", item: "task", flag: null },
];

function collectTasks(flow) {
  const out = [];
  for (const spec of CONTAINER_COLLECTIONS) {
    // A collection may be an array of { <item>: {...} } wrappers, or bare items.
    for (const entry of Array.isArray(flow[spec.key]) ? flow[spec.key] : []) {
      const c = (entry && entry[spec.item]) || entry;
      if (!c || (!c.refId && !c.name)) continue;
      const container = {
        refId: c.refId || c.name, name: c.name || c.refId,
        actions: c.actions || [], variables: c.variables,
      };
      if (spec.flag) container[spec.flag] = true;
      out.push(container);
    }
  }
  // Common modules / in-queue and other single-sequence flow types keep their
  // main sequence under `startUpTaskActions` (one implicit startup task).
  if (Array.isArray(flow.startUpTaskActions) && flow.startUpTaskActions.length) {
    out.push({ refId: "__startup__", name: flow.name || "Main", actions: flow.startUpTaskActions, isStartup: true });
  }
  // Menus live under `flow.menus`, a top-level sibling of `flow.tasks`. Each is
  // its own refId-addressable container (a jumpToMenu target, just as a task is
  // a jumpToTask target), holding one synthetic `menu` action whose choices
  // branch out inside it. Appended last so they can never win the "first task is
  // the start" fallback below.
  const menus = Array.isArray(flow.menus) ? flow.menus : [];
  for (const item of menus) {
    const m = item && item.menu ? item.menu : item;
    if (!m || (!m.refId && !m.name)) continue;
    out.push({ refId: m.refId || m.name, name: m.name || m.refId, actions: [{ menu: m }], isMenu: true });
  }
  return out;
}

/**
 * DTMF key of a menu choice: "digit_1" → "1", "digit_#" → "#", "star" → "*".
 * The symbol keys matter — a menu's two repeat choices are * and #, and without
 * them both branches would render as the same bare label.
 */
const DTMF_SYMBOL = { star: "*", pound: "#" };
function dtmfLabel(d) {
  const s = String(d || "");
  const m = /^digit_(.)$/.exec(s);
  if (m) return m[1];
  return DTMF_SYMBOL[s] || "";
}

/**
 * Menu choices come in two shapes: the object map an inline `menu` action uses
 * ({ label: { actions } }), and the ordered list a top-level menu uses
 * ([{ menuTask: { name, dtmf, task: { actions } } }]). Normalize both to
 * { label, actions }.
 */
function normalizeChoices(body) {
  const raw = (body && body.choices) || (body && body.outputs) || null;
  if (!raw) return [];
  if (!Array.isArray(raw)) {
    return Object.keys(raw).map((label) => ({ label, actions: (raw[label] && raw[label].actions) || [] }));
  }
  const out = [];
  for (const item of raw) {
    const key = singleKey(item);
    if (!key) continue;
    const c = item[key] || {};
    const digit = dtmfLabel(c.dtmf);
    const name = c.name || key;
    let actions = (c.task && c.task.actions) || c.actions || null;
    if (!actions) {
      // A choice that carries no nested sequence is itself the destination.
      // A sub-menu re-enters this handler; anything else (menuDisconnect,
      // menuTransferToAcd, …) is re-keyed to the action it wraps so it renders
      // as an ordinary node instead of disappearing.
      const inner = key.replace(/^menu/, "");
      const actionKey = inner ? inner.charAt(0).toLowerCase() + inner.slice(1) : "action";
      actions = c.choices ? [{ menu: c }] : [{ [actionKey]: c }];
    }
    out.push({ label: digit ? `${digit} · ${name}` : name, actions });
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
    parent: scope.containerId || scope.taskId,
    taskId: scope.taskId,
    taskName: scope.taskName,
    sublabel: "",
  };
  // A `loop` action is a visual container: its body actions nest inside it
  // (matching Architect). loopNext/loopExit share the "loop" kind but are leaf
  // actions, so only the real `loop` key becomes a container.
  if (key === "loop") node.isContainer = true;
  const action = {
    id, kind, name, actionKey: key,
    taskId: scope.taskId, taskName: scope.taskName,
    sets: [], refs: [], exprText: "", sublabel: "", depName: "", targetTaskRef: null,
    inputs: [], outputs: [], cases: [], depCategory: "", dynamicRefs: [],
  };

  // Collect variable references + assignments + dependency + condition text.
  extractDetails(key, body, action, ctx);
  node.sublabel = action.sublabel;

  ctx.nodes.push(node);
  ctx.actionById.set(id, action);
  recordUsages(action, ctx);

  // ── Edges by action type ───────────────────────────────────────────────────
  // `detail` is long-form text for the edge (a switch case's condition): too long
  // for the on-diagram label, shown on hover and in the connection panel.
  const addEdge = (source, target, label, ekind, detail) => {
    if (!target) return;
    const edge = { id: `${source}->${target}:${label || ""}`, source, target, label: label || "", kind: ekind || "flow" };
    if (detail) edge.detail = detail;
    ctx.edges.push(edge);
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
    const ft = (((body || {}).evaluate || {}).firstTrue) || {};
    const cases = ft.cases || (body || {}).cases || [];
    let ci = 0;
    for (const c of cases) {
      const cc = c && c.case ? c.case : c;
      ci++;
      // The ordinal is the label: `firstTrue` means order decides which branch
      // wins, and sibling conditions routinely share a long common prefix, so a
      // truncated expression would render several edges as identical text. The
      // condition rides along as `detail` instead.
      const label = "Case " + ci;
      const expr = valueText(cc && cc.value);
      const acts = cc && cc.actions;
      if (acts && acts.length) addEdge(id, walk(acts, scope, next, ctx), label, "flow", expr);
      else addEdge(id, next, label, "flow", expr);
    }
    // Default case: may carry its own actions (evaluate.firstTrue.default.actions).
    const defActs = ft.default && ft.default.actions;
    if (defActs && defActs.length) addEdge(id, walk(defActs, scope, next, ctx), "Default", "flow");
    else addEdge(id, next, "Default", "flow");
    return;
  }

  if (key === "menu" || key === "getInput") {
    const choices = normalizeChoices(body);
    // Choices are walked knowing which menu they belong to, so a "Repeat Menu"
    // choice can point back at it (the same trick loopNext uses for its loop).
    const menuScope = { ...scope, menuCtx: { menuId: id } };
    for (const ch of choices) {
      if (ch.actions && ch.actions.length) addEdge(id, walk(ch.actions, menuScope, next, ctx), ch.label, "flow");
      else addEdge(id, next, ch.label, "flow");
    }
    if (!choices.length) addEdge(id, next, "", "flow");
    return;
  }

  if (key === "repeatMenu") { addEdge(id, scope.menuCtx ? scope.menuCtx.menuId : next, "", "flow"); return; }

  if (key === "loop") {
    const outs = (body && body.outputs) || {};
    const bodyActs = (outs.loop && outs.loop.actions) || [];
    const loopScope = { ...scope, containerId: id, loopCtx: { loopId: id, exitId: next } };
    if (bodyActs.length) addEdge(id, walkLoopBody(bodyActs, loopScope, id, ctx), "Loop", "flow");
    addEdge(id, next, "Exit", "flow");
    return;
  }

  if (key === "loopNext") { addEdge(id, scope.loopCtx ? scope.loopCtx.loopId : next, "", "flow"); return; }
  if (key === "loopExit") { addEdge(id, scope.loopCtx ? scope.loopCtx.exitId : next, "", "flow"); return; }

  // All three address a container by refId — callTask/jumpToTask via
  // `targetTaskRef`, jumpToMenu via `targetMenuRef`. They differ in what happens
  // afterwards: callTask returns via Default to the next sibling, while a jump
  // hands control over for good — the flow stays in the target until it jumps,
  // transfers or ends. So a jump gets no fall-through edge, which also means any
  // sibling after it is unreachable (as in Architect).
  if (key === "callTask" || key === "jumpToTask" || key === "jumpToMenu" || key === "changeState") {
    const isCall = key === "callTask";
    const ref = jumpTargetId(body && (body.targetTaskRef || body.targetMenuRef || body.targetStateRef));
    if (ref && ctx.taskByRef.has(ref)) addEdge(id, ref, isCall ? "call" : "jump", "jump");
    action.targetTaskRef = ref;
    if (isCall) {
      // A callTask's `outputs` comes in two shapes, and it can carry both:
      //   outputs.paths[] — { path: { name, actions } }, the named output paths
      //                     the called task declares (Failure, Timeout, …).
      //   outputs.default — a nested sequence run once the called task returns,
      //                     in place of simply continuing at the next sibling.
      // Anything not covered by a named path still falls through to `next`.
      const outs = (body && body.outputs) || {};
      for (const item of Array.isArray(outs.paths) ? outs.paths : []) {
        const p = (item && item.path) || item;
        if (!p) continue;
        const lbl = p.name || "Path";
        if (p.actions && p.actions.length) addEdge(id, walk(p.actions, scope, next, ctx), lbl, "flow");
        else addEdge(id, next, lbl, "flow");
      }
      const defActs = outs.default && outs.default.actions;
      if (defActs && defActs.length) addEdge(id, walk(defActs, scope, next, ctx), "Default", "flow");
      else addEdge(id, next, "", "flow"); // returns via Default to the next sibling
    }
    return;
  }

  // Generic named-output branches: data actions (success/failure), data-table
  // lookups (found/notFound), bridge/API calls, transfers with a failure output,
  // etc. Each present branch's nested actions are walked and reconverge to `next`.
  if (body && body.outputs && typeof body.outputs === "object" && !Array.isArray(body.outputs)) {
    const keys = Object.keys(body.outputs);
    if (keys.length) {
      let hasPrimary = false;
      for (const label of keys) {
        const norm = label.replace(/"/g, "").toLowerCase();
        if (PRIMARY_OUTPUT_KEYS.has(norm)) hasPrimary = true;
        const branch = body.outputs[label];
        const acts = branch && branch.actions;
        const lbl = prettyOutputLabel(label);
        if (acts && acts.length) addEdge(id, walk(acts, scope, next, ctx), lbl, "flow");
        else addEdge(id, next, lbl, "flow");
      }
      // The primary output (found/success) is usually omitted from the YAML — it
      // just continues to the next sibling. Add that edge ONLY for action types
      // whose primary output is a known continuation (data-table Found, data-
      // action Success, …). Other actions (evaluateScheduleGroup open/closed/…,
      // menus, …) leave their unlisted outputs unconnected, as Architect does.
      if (!hasPrimary && PRIMARY_OUTPUT_LABEL[key]) {
        addEdge(id, next, PRIMARY_OUTPUT_LABEL[key], "flow");
      }
      return;
    }
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
  if (key === "switch") {
    // Keep the per-case conditions structured so the detail panel can list them
    // in full, and flatten them into exprText for the variable-usage rows (which
    // previously read just "switch" for every variable a switch touched).
    const ft = ((body.evaluate || {}).firstTrue) || {};
    const list = ft.cases || body.cases || [];
    action.cases = list.map((c, i) => {
      const cc = c && c.case ? c.case : c;
      return { label: "Case " + (i + 1), exprText: valueText(cc && cc.value) };
    });
    if (ft.default) action.cases.push({ label: "Default", exprText: "" });
    action.exprText = action.cases
      .filter((c) => c.exprText)
      .map((c) => `${c.label}: ${c.exprText}`)
      .join("  ·  ");
  }

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
    // Data-action name is nested: category.<integration>.dataAction.<name>.
    const cat = body.category && singleKey(body.category);
    const catObj = cat && body.category[cat];
    const da = catObj && catObj.dataAction;
    const daName = da && singleKey(da);
    const nm = daName || body.name || "";
    action.sublabel = nm;
    action.depName = nm;
    // `category` is the integration the data action belongs to ("Genesys Cloud
    // Data Actions", "CX Cloud - Salesforce Data Actions - Sandbox", …).
    action.depCategory = cat || "";
    addDep(ctx, "dataAction", nm, action);
  }
  if (key === "callTask" || key === "jumpToTask" || key === "jumpToMenu" || key === "changeState") {
    // Show the target's display name rather than its refId ("Backup GDF
    // Scheduling", not "Backup GDF Scheduling_215"); fall back to the raw ref
    // when the target lives outside this flow's containers.
    const ref = jumpTargetId(body.targetTaskRef || body.targetMenuRef || body.targetStateRef);
    const target = ref && ctx.taskByRef.get(ref);
    const prefix = key === "jumpToMenu" ? "Menu: " : key === "changeState" ? "State: " : "Task: ";
    action.sublabel = prefix + ((target && target.name) || ref || "");
  }

  // Cross-flow references (any flow type → its own tab):
  //   overrideInQueueFlow (nested on ACD transfers) → in-queue flow
  //   transferToFlow / transferToFlowSecure         → target call/secure flow
  //   bot-call actions                              → bot / digital-bot flow
  // Read directly, NOT via findNested: an action's body contains its nested
  // output actions, so a deep search hands the in-queue flow to every ancestor
  // as well as the transfer that owns it (in one real flow: 15 usages across
  // decisions and data actions, for 3 actual transfers).
  const inq = body.overrideInQueueFlow;
  if (inq && inq.name) addDep(ctx, "inqueueCall", inq.name, action);
  if (/^transferToFlow/i.test(key)) {
    const tf = body.targetFlow || body.flow || (findNested(body, "targetFlow"));
    const nm = tf && tf.name;
    if (nm) { action.depName = nm; action.sublabel = nm; addDep(ctx, "flow", nm, action); }
  }
  if (/bot/i.test(key)) {
    const bf = body.botFlow || body.digitalBotFlow || body.flow || (findNested(body, "botFlow"));
    // The bot flow is named by the KEY, not a `name` property — the value under
    // it is the version ("Messaging - Categories 2: { ver_latestPublished: … }").
    const nm = (bf && bf.name) || singleKey(bf);
    if (nm) { action.depName = nm; action.sublabel = nm; addDep(ctx, "bot", nm, action); }
  }

  // updateData assignments.
  if (key === "updateData" && Array.isArray(body.statements)) {
    for (const st of body.statements) {
      const t = singleKey(st);
      const s = st[t];
      if (s && s.variable) action.sets.push({ target: s.variable, value: valueText(s.value) });
    }
  }

  scanReferences(body, action, ctx);

  // Deep-scan for variable references (exp/var/variable tokens) matching declared vars.
  const refs = new Set();
  collectRefs(body, refs, ctx.varNames);
  action.refs = [...refs];
}

/**
 * Action fields that point at an org resource. In data-driven flows these are
 * nearly always expressions resolved at run time — `FindQueue(Flow.Queue)`,
 * `ToAudio(FindUserPrompt(Task.Audio))` — so there is no name to enumerate.
 * Those are recorded as `dynamicRefs` so an export can flag them for manual
 * checking. Where a field IS a literal name it becomes a real dependency, but
 * only for the kinds worth drawing (a hardcoded queue or prompt); a literal
 * phone number or language code is not a dependency.
 */
const REF_FIELDS = {
  targetQueue:     { kind: "Queue",              dep: "queue" },
  scheduleGroup:   { kind: "Schedule group",     dep: "scheduleGroup" },
  emergencyGroup:  { kind: "Emergency group",    dep: "scheduleGroup" },
  audio:           { kind: "Prompt / audio",     dep: "prompt" },
  wrapupCode:      { kind: "Wrap-up code",       dep: "wrapupCode" },
  languageSkill:   { kind: "Language skill",     dep: "skill" },
  // Written as a single-key object: `screenPopScript: { "<script name>": … }`.
  screenPopScript: { kind: "Screen pop script",  dep: "screenPop", shape: "key" },
  // Written as a plain `{ name }`.
  flowOutcome:     { kind: "Flow outcome",       dep: "flowOutcome", shape: "name" },
  milestone:       { kind: "Milestone",          dep: "milestone",   shape: "name" },
  targetNumber:    { kind: "Number",             dep: "" },
  targetUser:      { kind: "User",               dep: "" },
  targetGroup:     { kind: "Group",              dep: "" },
  language:        { kind: "Language",           dep: "" },
};

/**
 * The literal name in a reference. Fields differ in how they carry it, so the
 * shape is declared per field rather than guessed — reading a key-shaped field
 * generically would return "exp" for an expression.
 */
function staticRefName(v, shape) {
  if (shape === "key") return singleKey(v) || "";
  if (shape === "name") return typeof v.name === "string" ? v.name : "";
  if (typeof v.prompt === "string") return v.prompt;
  if (v.lit && typeof v.lit === "object" && v.lit.name) return v.lit.name;
  if (typeof v.lit === "string") return v.lit;
  return "";
}

function scanReferences(body, action, ctx) {
  for (const field of Object.keys(REF_FIELDS)) {
    const v = body[field];
    if (!v || typeof v !== "object" || v.noValue) continue;
    const spec = REF_FIELDS[field];
    // Expressions first: every shape can be an expression instead of a name.
    if (typeof v.exp === "string") {
      action.dynamicRefs.push({ kind: spec.kind, exprText: v.exp });
      continue;
    }
    const name = staticRefName(v, spec.shape);
    if (name && spec.dep) addDep(ctx, spec.dep, name, action);
  }
  scanSkills(body, action, ctx);
}

/** ACD skills are a list — `acdSkills: [{ acdSkill: <value> }, …]` — not a field. */
function scanSkills(body, action, ctx) {
  if (!Array.isArray(body.acdSkills)) return;
  for (const item of body.acdSkills) {
    const v = (item && item.acdSkill) || item;
    if (!v || typeof v !== "object" || v.noValue) continue;
    if (typeof v.exp === "string") action.dynamicRefs.push({ kind: "Skill", exprText: v.exp });
    else {
      const nm = staticRefName(v);
      if (nm) addDep(ctx, "skill", nm, action);
    }
  }
}

function addDep(ctx, type, name, action) {
  if (!name) return;
  const key = `${type}:${name}`;
  let dep = ctx.depMap.get(key);
  if (!dep) { dep = { key, id: name, name, type, usages: [] }; ctx.depMap.set(key, dep); }
  // Category rides on the usage rather than the dependency: the dep key is
  // `<type>:<name>`, so two integrations exposing a same-named data action would
  // merge into one entry and lose a category. Per-usage keeps both.
  dep.usages.push({
    actionId: action.id, actionName: action.name,
    taskId: action.taskId, taskName: action.taskName,
    category: action.depCategory || "",
  });
}

/** Find the first nested object stored under `key` anywhere within `node`. */
function findNested(node, key) {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const x of node) { const r = findNested(x, key); if (r) return r; }
    return null;
  }
  if (node[key] && typeof node[key] === "object") return node[key];
  for (const k of Object.keys(node)) {
    const r = findNested(node[k], key);
    if (r) return r;
  }
  return null;
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

/**
 * Dependency types kept out of the mid/low DIAGRAM only. Milestones and flow
 * outcomes are reporting metadata rather than things the flow calls, and there
 * are far too many to draw: five real flows declare 89 distinct milestones
 * between them, which would bury the task nodes those levels exist to show.
 * They stay in the index, so the search panel, the detail panel and the
 * dependency export still list every one of them.
 */
const DIAGRAM_HIDDEN_DEP_TYPES = new Set(["milestone", "flowOutcome"]);
const diagramDeps = (data) => data.dependencies.filter((d) => !DIAGRAM_HIDDEN_DEP_TYPES.has(d.type));

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
    for (const t of data.tasks) nodes.push({ id: t.id, kind: "task", label: t.name, isStart: t.isStart, isMenu: t.isMenu, isState: t.isState, isBot: t.isBot });
    const taskIds = new Set(nodes.map((n) => n.id));
    // task→task edges from callTask jumps
    for (const e of data.edges) {
      if (e.kind === "jump") {
        const from = data.actionById.get(e.source);
        if (from && taskIds.has(from.taskId) && taskIds.has(e.target) && from.taskId !== e.target) pushEdge(from.taskId, e.target, "", "jump");
      }
    }
    for (const dep of diagramDeps(data)) {
      const depNode = `dep:${dep.key}`;
      nodes.push({ id: depNode, kind: depKind(dep.type), label: dep.name, depType: dep.type, isDependency: true });
      for (const u of dep.usages) if (taskIds.has(u.taskId)) pushEdge(u.taskId, depNode, "", "dep");
    }
    return { level, meta: data.meta, nodes, edges, warnings: [] };
  }

  // low
  const flowId = "__flow__";
  nodes.push({ id: flowId, kind: "task", label: data.meta.name, isStart: true, isFlowRoot: true });
  for (const dep of diagramDeps(data)) {
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
  if (type === "bot") return "bot";
  return "action";
}

export { ACTION_KINDS };
