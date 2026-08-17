/**
 * Test case generation — turns a parsed Architect flow into a set of test cases.
 *
 * A test case is a PATH from the flow's start to a terminal action. The parser in
 * flowYaml.js already labels every branch (Yes/No, "Case N" with its condition,
 * DTMF digit + choice name, one edge per intent, Success/Failure, Found/Not
 * Found), so the branch labels are the test conditions — nothing has to be
 * re-derived from the raw YAML here.
 *
 *   generateTestCases(data, { mode, cap, idPrefix }) → {
 *     flow, mode, cases[], coverage, findings[], truncated
 *   }
 *
 * Pure: no DOM, no network, no layout — unit-testable against a saved parse, the
 * same contract as flowModel.js / flowYaml.js. See docs/test-case-design.md for
 * the full design; the subtleties that shape the walk are commented where they
 * bite.
 */

import { ACTION_KINDS } from "./flowModel.js";

// ── Coverage modes ───────────────────────────────────────────────────────────

export const COVERAGE_MODES = Object.freeze({
  branch: {
    key: "branch",
    label: "Branch coverage",
    hint: "Every branch exercised at least once. The usual acceptance criterion.",
  },
  happy: {
    key: "happy",
    label: "Happy paths",
    hint: "One case per distinct outcome, taking the primary branch throughout.",
  },
  all: {
    key: "all",
    label: "All paths",
    hint: "Every distinct path. Capped — use on small or critical flows.",
  },
});

/** Hard ceiling on cases per flow in "all" mode. Truncation is always reported. */
export const ALL_PATHS_CAP = 500;

/**
 * Branch labels that represent an action's PRIMARY continuation — the one a
 * caller takes when nothing goes wrong. Preferred at every choice in "happy"
 * mode, and used as the tie-break everywhere else. "call" is included so a Call
 * Task's descent into the called task is preferred over its failure paths.
 */
const PRIMARY_LABELS = new Set(["", "yes", "success", "found", "default", "complete", "out", "exit", "call"]);

/** Branch labels that represent something going wrong — drives case priority. */
const FAILURE_LABEL_RE = /fail|error|timeout|no ?input|no ?match|not ?found|no ?intent|max|invalid|unavailable/i;

/** Action keys that END an interaction rather than continuing it. */
const ENDING_KINDS = new Set(["end", "transfer"]);

/**
 * Endings that are scoped to the TASK, not the interaction. End Task and End
 * State finish the sequence they are in and hand control back to whatever called
 * it; only with nothing on the call stack do they end the flow. flowYaml groups
 * them with Disconnect under kind "end" because for drawing purposes they all
 * stop a line, but a test case that stops at the End Task of a called task never
 * reaches the caller's transfer — which is usually the whole point of the case.
 */
const TASK_SCOPED_ENDINGS = new Set(["endTask", "endState"]);

// ── Graph helpers ────────────────────────────────────────────────────────────

/**
 * Index the parsed flow into the lookups the walk needs.
 *
 * `depsByAction` is built from the dependency usages because an action does not
 * record its own resource references: a literal queue on a Transfer to ACD
 * becomes a dependency whose usage points back at the action, and the action
 * object itself has no queue field. Without this the expected result of every
 * transfer case would read "transferred to a queue".
 */
function indexGraph(data) {
  const nodeById = new Map((data.nodes || []).map((n) => [n.id, n]));
  const taskById = new Map((data.tasks || []).map((t) => [t.id, t]));
  const outEdges = new Map();
  for (const e of data.edges || []) {
    if (!outEdges.has(e.source)) outEdges.set(e.source, []);
    outEdges.get(e.source).push(e);
  }
  const depsByAction = new Map();
  for (const dep of data.dependencies || []) {
    for (const u of dep.usages || []) {
      if (!u.actionId) continue;
      if (!depsByAction.has(u.actionId)) depsByAction.set(u.actionId, []);
      depsByAction.get(u.actionId).push({ type: dep.type, name: dep.name, category: u.category || "" });
    }
  }
  return { nodeById, taskById, outEdges, depsByAction, actionById: data.actionById || new Map() };
}

/** The action node a container hands control to (its first action). */
function entryOf(g, containerId) {
  const task = g.taskById.get(containerId);
  return (task && task.entryId) || null;
}

/** True if this action terminates the interaction (End / Disconnect / Transfer). */
function isEnding(action) {
  return !!action && ENDING_KINDS.has(action.kind);
}

/**
 * The branches a node offers — what a test case can choose between.
 *
 * Two corrections to the raw out-edge list, both of which change the generated
 * cases materially:
 *
 * 1. CALL TASK is a call, not a branch. It emits both a jump edge to the callee
 *    and a fall-through edge to the next sibling; the fall-through is the RETURN
 *    target, not an alternative. Offering it as a choice would generate a case
 *    that skips the called task entirely with no explanation.
 *
 * 2. An ENDING action that carries a failure output has no edge for the
 *    successful case — flowYaml only adds a primary edge for action types whose
 *    primary output is a known continuation, and a transfer's is not. So a
 *    Transfer to ACD with a Failure output offers exactly one edge: Failure.
 *    A synthetic branch is added for the ending itself, otherwise the main
 *    "the transfer succeeds" case is missing from every flow that handles
 *    transfer failure.
 */
function branchesOf(g, nodeId) {
  const action = g.actionById.get(nodeId);
  const outs = g.outEdges.get(nodeId) || [];

  if (action && action.actionKey === "callTask") {
    const call = outs.find((e) => e.kind === "jump");
    if (call) {
      const named = outs.filter((e) => e.kind !== "jump" && e.label && !isReturnLabel(e.label));
      return [call, ...named];
    }
  }

  if (isEnding(action) && outs.length) {
    return [...outs, syntheticEnd(nodeId)];
  }
  return outs;
}

/** A Call Task's return edge is its unlabelled continuation (or "Default"). */
function isReturnLabel(label) {
  const l = String(label || "").toLowerCase();
  return l === "" || l === "default";
}

/** Where a Call Task resumes once the called task ends (null = nowhere). */
function returnTargetOf(g, nodeId) {
  const outs = g.outEdges.get(nodeId) || [];
  const ret = outs.find((e) => e.kind !== "jump" && isReturnLabel(e.label));
  return ret ? ret.target : null;
}

function syntheticEnd(nodeId) {
  return { id: `${nodeId}->#end`, source: nodeId, target: null, label: "", kind: "end", synthetic: true };
}

/**
 * Where taking `edge` out of `nodeId` can lead, for REACHABILITY purposes.
 *
 * A Call Task's call branch leads into the called task AND, once that ends, on to
 * the caller's continuation — and the continuation is deliberately not one of its
 * branches (it is the return target, see branchesOf). A reachability check that
 * ignores it concludes that everything after a call is unreachable, so steering
 * gives up and the targets get retired. On a real flow that leans on Call Task
 * this collapsed branch coverage to a quarter of what it should be.
 */
function branchReachTargets(g, nodeId, edge) {
  const out = [];
  const t = resolveTarget(g, edge);
  if (t) out.push(t);
  const action = g.actionById.get(nodeId);
  if (action && action.actionKey === "callTask" && edge.kind === "jump") {
    const ret = returnTargetOf(g, nodeId);
    if (ret) out.push(ret);
  }
  return out;
}

/** Forward adjacency over branches, for reachability. Jumps resolve to entries. */
function adjacency(g) {
  const adj = new Map();
  for (const nodeId of g.actionById.keys()) {
    const targets = [];
    for (const e of branchesOf(g, nodeId)) targets.push(...branchReachTargets(g, nodeId, e));
    adj.set(nodeId, targets);
  }
  return adj;
}

/**
 * The action a branch leads to, hopping container → entry point.
 *
 * The test is membership of `taskById`, NOT the node's `isContainer` flag: a loop
 * action is drawn as a container too, and a loop-back edge targets the loop
 * action itself, which has no entry of its own. Testing `isContainer` sends every
 * loop-back to a dead end.
 */
function resolveTarget(g, edge) {
  if (!edge || !edge.target) return null;
  if (g.taskById.has(edge.target)) return entryOf(g, edge.target);
  return edge.target;
}

// ── Step + outcome description ───────────────────────────────────────────────

/**
 * The display name of a jump/call target. flowYaml stores it pre-labelled as
 * "Task: Sales Setup" / "Menu: Main" / "State: Greeting" for the diagram, so the
 * prefix is stripped here rather than doubled up in the step text.
 */
function targetName(action) {
  const sub = String(action.sublabel || "");
  const i = sub.indexOf(": ");
  return (i === -1 ? sub : sub.slice(i + 2)) || action.targetTaskRef || action.name || "";
}

/** The resource an action points at, for step and expected-result text. */
function resourceOf(g, action) {
  const deps = g.depsByAction.get(action.id) || [];
  const named = deps.find((d) => d.type === "queue") || deps[0];
  if (named) return named.name;
  const dyn = (action.dynamicRefs || [])[0];
  if (dyn) return `resolved at run time: ${dyn.exprText}`;
  return action.depName || "";
}

/**
 * A step sentence for one action, templated per action key. Deliberately plain
 * prose in the tester's voice — this is read by a person working through a
 * document, not by a machine.
 */
function describeStep(g, action) {
  const key = action.actionKey;
  const res = resourceOf(g, action);
  const name = action.name || key;

  if (/^playAudio/.test(key)) return `System plays audio: ${name}`;
  if (key === "updateData") {
    const sets = (action.sets || []).map((s) => `${s.target} = ${s.value || "(no value)"}`);
    return sets.length ? `System sets ${sets.join(", ")}` : "System updates data";
  }
  if (key === "decision") return `Condition is evaluated: ${action.exprText || name}`;
  if (key === "switch") return `Cases are evaluated in order (first true wins): ${name}`;
  if (key === "menu" || key === "getInput") return `Caller is offered the menu "${name}"`;
  if (key === "repeatMenu") return "Menu is repeated";
  if (key === "collectInput") return `Caller is prompted to enter input: ${name}`;
  if (key === "askForIntent") return "Caller is asked what they want, and states an intent";
  if (/^askFor/.test(key)) return `Caller is asked for ${name}`;
  if (key === "dataTableLookup") return `Data table "${res || name}" is looked up`;
  if (key === "callData") return `Data action "${res || name}" is called`;
  if (key === "callCommonModule") return `Common module "${res || name}" is called (tested separately)`;
  if (key === "callTask") return `Task "${targetName(action)}" is run, then control returns here`;
  if (key === "jumpToTask") return `Flow hands over to task "${targetName(action)}" (does not return)`;
  if (key === "jumpToMenu") return `Flow hands over to menu "${targetName(action)}" (does not return)`;
  if (key === "changeState") return `Flow changes to state "${targetName(action)}"`;
  if (/^loop/.test(key)) return `Loop: ${name}`;
  if (key === "setWrapupCode") return `System sets the wrap-up code${res ? ` to "${res}"` : ""}`;
  if (key === "setParticipantData") return "System sets participant data";
  if (key === "setLanguage") return "System sets the interaction language";
  if (key === "setScreenPop") return `System sets a screen pop${res ? `: "${res}"` : ""}`;
  if (key === "evaluateScheduleGroup") return `Schedule group${res ? ` "${res}"` : ""} is evaluated`;
  if (key === "transferToAcd") return `Call is transferred to queue ${res || "(unnamed)"}`;
  if (/^transferTo/.test(key)) return `Call is transferred: ${res || name}`;
  if (key === "disconnect") return "Call is disconnected";
  if (/^end/.test(key) || key === "exitBotFlow") return name;
  return name;
}

/** The expected result of a path that ends on this action. */
function describeOutcome(g, action) {
  const key = action.actionKey;
  const res = resourceOf(g, action);
  if (key === "transferToAcd") return `Call is transferred to queue ${res || "(unnamed)"}`;
  if (key === "transferToNumber") return `Call is transferred to an external number${res ? ` (${res})` : ""}`;
  if (key === "transferToVoicemail" || key === "transferToGroupVoicemail") return "Call is sent to voicemail";
  if (/^transferTo/.test(key)) return `Call is transferred: ${res || action.name || key}`;
  if (key === "disconnect") return "Call is disconnected";
  if (key === "exitBotFlow") return `Bot flow exits: ${action.name || key}`;
  if (key === "endProgram") return "Flow ends";
  // Reached with nothing on the call stack: the sequence is over and there is no
  // caller to go back to, so Architect disconnects. Worth stating plainly — an
  // interaction ending here is usually not what the flow author intended.
  if (TASK_SCOPED_ENDINGS.has(key)) return `"${action.name || key}" — nothing follows, so the call is disconnected`;
  if (/^end/.test(key)) return `Flow ends: ${action.name || key}`;
  return action.name || key;
}

/**
 * Collapse whitespace so a step reads as one line in a table cell. Architect
 * expressions carry real newlines — a log string built over six lines is common
 * — and pasted verbatim they turn one row of the document into twelve.
 */
function oneLine(s, max = 300) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Human label for an action's kind, for the Steps sheet. */
export function kindLabel(kind) {
  return (ACTION_KINDS[kind] && ACTION_KINDS[kind].label) || kind || "";
}

// ── The walk ─────────────────────────────────────────────────────────────────

/**
 * What happens at one node, given the current call stack. The single place the
 * graph's shape is interpreted, shared by both walkers so they cannot drift.
 *
 * Three shape facts drive it (docs/test-case-design.md §4):
 *
 *   - A jump edge targets a CONTAINER; execution continues at its `entryId`.
 *   - Call Task returns, Jump to Task does not — hence the call stack.
 *   - "No outgoing branches" means a genuine terminal (Disconnect / Transfer /
 *     End Program), the end of a called task (return), or the flow running out.
 *
 * @returns {{ branches: object[] } | { outcome: object } | { popTo: string }}
 */
function classify(g, nodeId, stack) {
  const action = g.actionById.get(nodeId);
  if (!action) return { outcome: { kind: "unknown", text: "Path left the flow's actions" } };

  const branches = branchesOf(g, nodeId);
  if (branches.length) return { branches, action };

  if (isEnding(action)) {
    // End Task / End State inside a called task returns to the caller; only with
    // an empty stack does it end the interaction.
    if (TASK_SCOPED_ENDINGS.has(action.actionKey) && stack.length) {
      return { popTo: stack[stack.length - 1], action };
    }
    return { outcome: { kind: "end", text: describeOutcome(g, action), action }, action };
  }
  if (stack.length) return { popTo: stack[stack.length - 1], action };
  return {
    outcome: { kind: "endOfFlow", text: "End of flow (no further action — Architect disconnects)" },
    action,
  };
}

/**
 * Walk one path from `startId`, asking `choose(nodeId, branches)` at each
 * decision. Returns the steps taken, the outcome, and the branch ids used.
 *
 * Loops and jump cycles are bounded by never revisiting a node already on this
 * path: a case that goes round a loop twice tests nothing the once-through case
 * does not.
 */
function walkPath(g, startId, choose) {
  const steps = [];
  const used = new Set();
  const onPath = new Set();      // raw node ids, for the chooser's heuristics
  const onPathKeys = new Set();  // node + call context, for the cycle guard
  const stack = [];
  let cur = startId;
  let outcome = null;

  while (cur) {
    if (onPathKeys.has(contextKey(cur, stack))) {
      const node = g.nodeById.get(cur);
      outcome = { kind: "loop", text: `Loops back to "${(node && node.label) || cur}"` };
      break;
    }
    onPathKeys.add(contextKey(cur, stack));
    onPath.add(cur);

    const c = classify(g, cur, stack);
    if (c.outcome) {
      if (c.action) steps.push({ action: c.action, edge: null });
      outcome = c.outcome;
      break;
    }
    if (c.popTo) {
      steps.push({ action: c.action, edge: null });
      stack.pop();
      cur = c.popTo;
      continue;
    }

    const edge = choose(cur, c.branches, onPath);
    used.add(edge.id);
    steps.push({ action: c.action, edge });

    if (edge.synthetic || edge.kind === "end") {
      outcome = { kind: "end", text: describeOutcome(g, c.action), action: c.action };
      break;
    }
    if (edge.kind === "jump" && c.action.actionKey === "callTask") {
      const ret = returnTargetOf(g, cur);
      if (ret) stack.push(ret);   // no return target → the caller's task ends too
    }

    const next = resolveTarget(g, edge);
    if (!next) {
      if (stack.length) { cur = stack.pop(); continue; }
      outcome = { kind: "endOfFlow", text: "End of flow (branch leads nowhere)" };
      break;
    }
    cur = next;
  }

  return { steps, used, outcome: outcome || { kind: "unknown", text: "Path did not resolve" } };
}

/**
 * Cycle-guard identity: an action plus the call context it is running in.
 *
 * Keying on the action alone is wrong for a flow that calls a shared task from
 * two places on the same path — a validation module called before a menu and
 * again after it. The second call is not a loop, but a bare node guard reads it
 * as one and cuts the case short there, so the part of the flow after the second
 * call never gets tested. A genuine loop revisits the same action with the same
 * return stack, and that is still caught.
 */
function contextKey(nodeId, stack) {
  return stack.length ? `${nodeId}@${stack.join(">")}` : nodeId;
}

/** A path's identity, for dropping duplicates. */
function signatureOf(path) {
  return path.steps.map((s) => `${s.action.id}:${s.edge ? s.edge.id : ""}`).join("|") + `#${path.outcome.text}`;
}

/**
 * Can `from` still reach one of `holders` without passing back through a node in
 * `blocked` (the nodes already on the current path)?
 *
 * Path-awareness is the whole point. A precomputed "which nodes can reach a
 * target" answer is wrong at a loop: the loop body can reach the target only by
 * coming back round through the loop node, which the cycle guard forbids — so
 * the walk would take the loop branch, hit the guard, and cover nothing. Asking
 * per decision, with the current path excluded, picks the Exit branch instead.
 */
function reachesHolder(g, adj, from, holders, blocked) {
  if (holders.has(from)) return true;
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const n = queue.pop();
    for (const t of adj.get(n) || []) {
      if (seen.has(t) || blocked.has(t)) continue;
      if (holders.has(t)) return true;
      seen.add(t);
      queue.push(t);
    }
  }
  return false;
}

function isPrimary(edge) {
  return PRIMARY_LABELS.has(String(edge.label || "").toLowerCase());
}

/** Prefer the primary continuation, else the first branch offered. */
function preferPrimary(branches) {
  return branches.find(isPrimary) || branches[0];
}

/**
 * Prefer a branch that carries on rather than one that closes a cycle. Stepping
 * onto a node already on the path ends the case immediately (see walkPath), so a
 * branch that goes somewhere new is nearly always the more useful test.
 */
function preferForward(g, branches, onPath) {
  const forward = branches.filter((e) => {
    const t = resolveTarget(g, e);
    return !t || !onPath.has(t);
  });
  return preferPrimary(forward.length ? forward : branches);
}

/**
 * A branch that keeps the walk going, for use when it is off-route inside a
 * called task and still has somewhere to be.
 *
 * Walking into a called task means leaving the plotted route until the call
 * returns, and the ordinary preference takes the primary branch at each step —
 * which inside a task like "Check Schedule" is often the one that announces and
 * disconnects. The case then ends inside the callee and never reaches what it
 * was aiming at. On one production flow this stranded 367 of 389 attempts.
 * Returns null when every branch ends the interaction.
 */
/**
 * Which actions can reach the end of their own task without ending the
 * interaction — i.e. from which a called task can still RETURN to its caller.
 *
 * A one-step "does this branch end the call" test is not enough. Inside a called
 * task, `Blacklisted? → Yes` looks harmless: it goes to an Update Data. Four
 * steps later it disconnects, the case dies inside the callee, and it never
 * reaches what it was aiming at. Knowing which branches can still return is what
 * lets the walk pick its way out of a called task.
 *
 * Least fixpoint from the task-end nodes backwards. Jumps are excluded: Jump to
 * Task hands control over for good, so it never returns to the caller. A Call
 * Task returns wherever its own return target leads, and a call with no return
 * target ends the task, which is itself a return.
 */
function computeCanReturn(g) {
  const nodes = [...g.actionById.keys()];
  const can = new Set();

  for (const n of nodes) {
    if (branchesOf(g, n).length) continue;
    const action = g.actionById.get(n);
    // End of the sequence: a return, unless it ends the interaction outright.
    if (!action || !isEnding(action) || TASK_SCOPED_ENDINGS.has(action.actionKey)) can.add(n);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (can.has(n)) continue;
      const action = g.actionById.get(n);
      if (action && action.actionKey === "callTask") {
        const ret = returnTargetOf(g, n);
        if (!ret || can.has(ret)) { can.add(n); changed = true; }
        continue;
      }
      for (const e of branchesOf(g, n)) {
        if (e.synthetic || e.kind === "end" || e.kind === "jump") continue;
        const t = resolveTarget(g, e);
        if (t && can.has(t)) { can.add(n); changed = true; break; }
      }
    }
  }
  return can;
}

/** A branch that leaves the walk able to carry on and, if called, to return. */
function keepsWalking(g, edge, onPath, canReturn) {
  if (edge.synthetic || edge.kind === "end") return false;
  const t = resolveTarget(g, edge);
  if (!t || onPath.has(t)) return false;
  return canReturn.has(t);
}

function preferNonTerminal(g, branches, onPath, canReturn) {
  const alive = branches.filter((e) => keepsWalking(g, e, onPath, canReturn));
  return alive.length ? preferPrimary(alive) : null;
}

/**
 * Shortest route of nodes from `from` to `to` over `adj`, or null.
 *
 * BFS, which matters for more than speed: the route it returns never repeats a
 * node, so following it can never trip the cycle guard. Steering step by step on
 * a reachability estimate does trip it — on a real flow the walk went into a
 * loop on 170 of 173 attempts, because a route that looked clear at step 3
 * needed a node the walk had visited by step 7. Committing to a simple route up
 * front removes the problem rather than mitigating it.
 */
function shortestRoute(adj, from, to) {
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const queue = [from];
  let head = 0;
  while (head < queue.length) {
    const n = queue[head++];
    for (const t of adj.get(n) || []) {
      if (prev.has(t)) continue;
      prev.set(t, n);
      if (t === to) {
        const route = [t];
        for (let p = n; p != null; p = prev.get(p)) route.unshift(p);
        return route;
      }
      queue.push(t);
    }
  }
  return null;
}

/**
 * Greedy coverage walk, shared by "branch" and "happy" mode — the two differ
 * only in what counts as a target:
 *
 *   branch → every branch (edge) must be taken by some case
 *   happy  → every reachable terminal must be reached by some case
 *
 * Each iteration aims at ONE outstanding target and walks from the start
 * steering toward it, taking any other uncovered branch it passes on the way.
 *
 * Aiming at a single target matters. An earlier version steered at "anything
 * still uncovered" and stopped the whole run the first time a path covered
 * nothing new — and on a real flow that happens early, because once the walk
 * commits to a prefix, some targets are only reachable through nodes already on
 * the path. On a 546-branch production flow it gave up after 24 cases with 273
 * reachable branches never tested. Retiring only the target that could not be
 * reached, and carrying on, is what makes coverage complete.
 *
 * Terminates because every iteration either covers a target or retires one.
 */
function greedyCover(g, startId, { targetEdges, targetNodes, cap }) {
  const adj = adjacency(g);
  const canReturn = computeCanReturn(g);
  const uncoveredEdges = new Set(targetEdges || []);
  const uncoveredNodes = new Set(targetNodes || []);
  const paths = [];
  const retired = new Set();
  let truncated = false;

  // Branch lookup, so an aimed-at edge can be resolved back to its source node.
  const edgeById = new Map();
  for (const nodeId of g.actionById.keys()) {
    for (const e of branchesOf(g, nodeId)) edgeById.set(e.id, e);
  }

  const outstanding = () => uncoveredEdges.size + uncoveredNodes.size;

  while (outstanding() > 0) {
    if (paths.length >= cap) { truncated = true; break; }

    const aimEdgeId = uncoveredEdges.values().next().value || null;
    const aimNodeId = aimEdgeId ? null : (uncoveredNodes.values().next().value || null);
    const aimEdge = aimEdgeId ? edgeById.get(aimEdgeId) : null;
    const aimSource = aimEdge ? aimEdge.source : aimNodeId;

    // Plot a simple route to the aim before walking. No route at all means
    // nothing reaches it — retire it without spending a walk.
    const route = aimSource ? shortestRoute(adj, startId, aimSource) : null;
    if (!route) {
      if (aimEdgeId) { uncoveredEdges.delete(aimEdgeId); retired.add(aimEdgeId); }
      else if (aimNodeId) { uncoveredNodes.delete(aimNodeId); retired.add(aimNodeId); }
      continue;
    }
    const pos = new Map(route.map((n, i) => [n, i]));
    let want = 0;

    const path = walkPath(g, startId, (nodeId, branches, onPath) => {
      // Standing on the target branch: take it.
      if (aimEdgeId) {
        const hit = branches.find((e) => e.id === aimEdgeId);
        if (hit) return hit;
      }
      // Follow the plotted route. The walk may step off it — through a called
      // task, whose actions are not on the route — and rejoin at the return.
      if (pos.has(nodeId)) want = Math.max(want, pos.get(nodeId) + 1);
      const next = route[want];
      if (next) {
        const step = branches.find((e) => branchReachTargets(g, nodeId, e).includes(next));
        if (step) return step;
      }
      // Off-route — most likely inside a called task, waiting for it to return.
      // While there is still somewhere to be, only pick up branches that keep
      // the walk alive: taking an uncovered branch that disconnects ends the
      // case inside the callee and it never gets where it was going.
      if (next) {
        const spareAlive = branches.find((e) => uncoveredEdges.has(e.id) && keepsWalking(g, e, onPath, canReturn));
        if (spareAlive) return spareAlive;
        const alive = preferNonTerminal(g, branches, onPath, canReturn);
        if (alive) return alive;
      }
      const spare = branches.find((e) => {
        if (!uncoveredEdges.has(e.id)) return false;
        const t = resolveTarget(g, e);
        return !t || !onPath.has(t);
      });
      return spare || preferForward(g, branches, onPath);
    });

    const before = outstanding();
    for (const id of path.used) uncoveredEdges.delete(id);
    // A target node counts as covered only when it is the path's OUTCOME, not
    // when the path merely passes through it. Walking through "To Sales Queue"
    // on the way to its Failure handler does not test the transfer succeeding.
    if (path.outcome.action) uncoveredNodes.delete(path.outcome.action.id);
    const coveredSomething = outstanding() < before;

    const hit = aimEdgeId
      ? path.used.has(aimEdgeId)
      : !!(path.outcome.action && path.outcome.action.id === aimNodeId);

    if (!hit) {
      // Could not be reached on a simple path. Retire THIS target and carry on,
      // rather than abandoning every other target too.
      if (aimEdgeId) { uncoveredEdges.delete(aimEdgeId); retired.add(aimEdgeId); }
      else if (aimNodeId) { uncoveredNodes.delete(aimNodeId); retired.add(aimNodeId); }
    }
    if (coveredSomething) paths.push(path);
  }

  // A flow with no branches at all still has one case to generate.
  if (!paths.length) paths.push(walkPath(g, startId, (_n, branches) => preferPrimary(branches)));

  return { paths, truncated, retired };
}

/**
 * Every branch reachable from the start, ignoring the cycle guard and the call
 * stack — an UPPER BOUND on what any set of test cases could cover.
 *
 * Used to explain an uncovered branch rather than merely report it. "Nothing can
 * reach this" and "one pass cannot reach this, but a second trip round the loop
 * would" are different findings: the first is usually a defect in the flow, the
 * second is a limit of testing each path once.
 */
function reachableBranchIds(g, startId) {
  const seenNodes = new Set();
  const seenEdges = new Set();
  const queue = [startId];
  while (queue.length) {
    const n = queue.pop();
    if (!n || seenNodes.has(n)) continue;
    seenNodes.add(n);
    for (const e of branchesOf(g, n)) {
      seenEdges.add(e.id);
      for (const t of branchReachTargets(g, n, e)) queue.push(t);
    }
  }
  return seenEdges;
}

/**
 * Exhaustive enumeration: every distinct path, depth-first, capped.
 *
 * Depth-first over an EXPLICIT worklist, carrying the walk state (steps so far,
 * call stack, nodes on this path) down each branch as a copy. Every path is one
 * distinct sequence of branch choices, so nothing is missed and no
 * de-duplication is needed.
 *
 * Not recursive: a real bot flow overflowed the JS stack, because paths get long
 * once the cycle guard is per call context and a deeply nested flow recurses one
 * frame per step.
 */
function allPaths(g, startId, cap) {
  const paths = [];
  let truncated = false;
  const work = [{ cur: startId, steps: [], used: new Set(), onPath: new Set(), stack: [] }];

  while (work.length) {
    if (paths.length >= cap) { truncated = true; break; }
    const { cur, steps, used, onPath, stack } = work.pop();

    const key = contextKey(cur, stack);
    if (onPath.has(key)) {
      const node = g.nodeById.get(cur);
      paths.push({ steps, used, outcome: { kind: "loop", text: `Loops back to "${(node && node.label) || cur}"` } });
      continue;
    }
    const path = new Set(onPath);
    path.add(key);

    const c = classify(g, cur, stack);
    if (c.outcome) {
      paths.push({ steps: [...steps, { action: c.action, edge: null }], used, outcome: c.outcome });
      continue;
    }
    if (c.popTo) {
      work.push({ cur: c.popTo, steps: [...steps, { action: c.action, edge: null }], used, onPath: path, stack: stack.slice(0, -1) });
      continue;
    }

    // Reversed, so popping the worklist explores the branches in their own order.
    for (let i = c.branches.length - 1; i >= 0; i--) {
      const edge = c.branches[i];
      const nextSteps = [...steps, { action: c.action, edge }];
      const nextUsed = new Set(used).add(edge.id);

      if (edge.synthetic || edge.kind === "end") {
        paths.push({ steps: nextSteps, used: nextUsed, outcome: { kind: "end", text: describeOutcome(g, c.action), action: c.action } });
        continue;
      }
      let nextStack = stack;
      if (edge.kind === "jump" && c.action.actionKey === "callTask") {
        const ret = returnTargetOf(g, cur);
        if (ret) nextStack = [...stack, ret];
      }
      const next = resolveTarget(g, edge);
      if (!next) {
        if (nextStack.length) {
          work.push({ cur: nextStack[nextStack.length - 1], steps: nextSteps, used: nextUsed, onPath: path, stack: nextStack.slice(0, -1) });
        } else {
          paths.push({ steps: nextSteps, used: nextUsed, outcome: { kind: "endOfFlow", text: "End of flow (branch leads nowhere)" } });
        }
        continue;
      }
      work.push({ cur: next, steps: nextSteps, used: nextUsed, onPath: path, stack: nextStack });
    }
  }
  return { paths, truncated };
}

// ── Case assembly ────────────────────────────────────────────────────────────

const DEP_PRECONDITION = {
  dataTable: (name) => `Data table "${name}" contains the rows this path needs`,
  dataAction: (name) => `Data action "${name}" is available and returns the expected result`,
  commonModule: (name) => `Common module "${name}" is deployed and published`,
  inqueueCall: (name) => `In-queue flow "${name}" is deployed and published`,
  bot: (name) => `Bot flow "${name}" is deployed and published`,
  flow: (name) => `Flow "${name}" is deployed and published`,
  queue: (name) => `Queue "${name}" exists and has an available agent`,
  skill: (name) => `Skill "${name}" exists and is assigned to an agent`,
  prompt: (name) => `Prompt "${name}" has a recording in the language under test`,
  scheduleGroup: (name) => `Schedule group "${name}" is set so this path is taken`,
  wrapupCode: (name) => `Wrap-up code "${name}" exists`,
  screenPop: (name) => `Screen pop script "${name}" is deployed`,
};

/** Preconditions implied by the resources a path touches. */
function preconditionsFor(g, steps) {
  const out = new Set();
  for (const s of steps) {
    for (const d of g.depsByAction.get(s.action.id) || []) {
      const tmpl = DEP_PRECONDITION[d.type];
      if (tmpl) out.add(tmpl(d.name));
    }
  }
  return [...out];
}

/** A bare positional branch label — meaningless without its condition. */
const ORDINAL_LABEL_RE = /^Case \d+$/;

/**
 * What a branch label means, for reading on its own. "Case 3" is the label
 * flowYaml gives a switch branch, because on a diagram the conditions are too
 * long and too alike to tell apart — but in a document nobody knows which case
 * is which by heart, so the condition is folded back in.
 */
function branchText(step, max = 70) {
  const label = String((step.edge && step.edge.label) || "");
  const detail = (step.edge && step.edge.detail) || "";
  if (!ORDINAL_LABEL_RE.test(label) || !detail) return label;
  return `${label}: ${oneLine(detail, max)}`;
}

/**
 * The conditions a switch branch implies.
 *
 * A switch is FIRST TRUE: reaching Case 3 means cases 1 and 2 did NOT match, not
 * merely that case 3 did. A tester who sets up data satisfying case 3 while
 * case 1 also matches exercises a different branch entirely, and the case fails
 * for a reason that has nothing to do with what it was testing. Spelling the
 * earlier cases out is the difference between a document you can execute and one
 * that looks executable.
 */
function switchConditions(action, label) {
  const cases = action.cases || [];
  const idx = cases.findIndex((c) => c.label === label);
  if (idx === -1) return null;
  const lines = [];
  for (let i = 0; i < idx; i++) {
    if (cases[i].exprText) lines.push(`${cases[i].label} must NOT match: ${cases[i].exprText}`);
  }
  const own = cases[idx];
  lines.push(own.exprText ? `${own.label} must match: ${own.exprText}` : `${own.label} — no earlier case matched`);
  return lines;
}

/**
 * The conditions that must hold to force this path. Stated, never solved:
 * Architect expressions are arbitrary, so the document says what must be true
 * and the tester sets it up. See docs/test-case-design.md §7.
 */
function testDataFor(steps) {
  const out = [];
  for (const s of steps) {
    if (!s.edge || !s.edge.label) continue;
    const where = s.action.name || s.action.actionKey;
    const label = String(s.edge.label);

    if (s.action.actionKey === "switch") {
      const lines = switchConditions(s.action, label);
      if (lines) { for (const l of lines) out.push(oneLine(`${where} — ${l}`)); continue; }
    }
    // "Is VIP? → No: Flow.Type == "Gold"" reads like an instruction to set it to
    // Gold. Say which way the condition has to go.
    if (s.action.actionKey === "decision" && s.action.exprText) {
      const want = /^yes$/i.test(label) ? "TRUE" : /^no$/i.test(label) ? "FALSE" : "";
      if (want) { out.push(oneLine(`${where} — ${s.action.exprText} must be ${want}`)); continue; }
    }
    const expr = s.edge.detail || s.action.exprText || "";
    out.push(oneLine(expr ? `${where} → "${label}": ${expr}` : `${where} → "${label}"`));
  }
  return out;
}

/**
 * Case priority, so a tester with limited time starts in the right place.
 *
 *   High   — no failure branch, and the interaction reaches an agent. This is
 *            the outcome the flow exists to produce.
 *   Low    — goes through a failure / timeout / no-input handler, or ends
 *            without resolving (a loop, or the flow running out).
 *   Medium — everything else: a clean path that ends in a disconnect or an end.
 *
 * Deliberately NOT "every branch taken was the primary one": in any menu-driven
 * flow no path qualifies, since a DTMF choice is never a primary output, and the
 * whole document comes out as Medium.
 */
function priorityFor(steps, outcome) {
  const labels = steps.filter((s) => s.edge).map((s) => String(s.edge.label || ""));
  if (labels.some((l) => FAILURE_LABEL_RE.test(l))) return "Low";
  if (outcome.kind === "loop" || outcome.kind === "endOfFlow" || outcome.kind === "unknown") return "Low";
  if (outcome.action && outcome.action.kind === "transfer") return "High";
  return "Medium";
}

const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };

/**
 * A case's one-line scenario: where it starts, the decisions that make it this
 * case, and where it ends.
 *
 * Long paths are trimmed from the MIDDLE, keeping the first branches and the
 * last. Keeping only the first four made 168 of one flow's 203 cases read
 * identically: they shared an opening sequence and differed only near the end,
 * and the part that told them apart was exactly the part being cut.
 */
function titleFor(startName, steps, outcome) {
  const branches = steps
    .filter((s) => s.edge && s.edge.label && !PRIMARY_LABELS.has(String(s.edge.label).toLowerCase()))
    .map((s) => branchText(s));
  const shown = branches.length > 5
    ? [...branches.slice(0, 2), `… ${branches.length - 4} more …`, ...branches.slice(-2)]
    : branches;
  const title = [startName, ...shown, outcome.text].filter(Boolean).join(" → ");
  return title.length > 300 ? title.slice(0, 299) + "…" : title;
}

function pad(n, width) {
  return String(n).padStart(width, "0");
}

/**
 * Make every scenario line read differently from every other.
 *
 * A title lists the branches that make a case what it is, and leaves out the
 * primary continuations — otherwise every line carries the same noise. But two
 * paths CAN differ only in a primary output (one data action succeeded, the
 * other returned Found), and then the two cases read identically while testing
 * different things. On one real flow that was 111 of 203 cases.
 *
 * So: find the first step where the group actually diverges and name it. Any
 * that still collide get an ordinal, which is at least honest about being one
 * of several.
 */
function disambiguateTitles(cases) {
  const groups = new Map();
  for (const c of cases) {
    if (!groups.has(c.title)) groups.set(c.title, []);
    groups.get(c.title).push(c);
  }
  for (const [title, group] of groups) {
    if (group.length < 2) continue;
    const seqs = group.map((c) => c.steps.map((s) => `${s.actionName}:${s.branch}`));
    const longest = Math.max(...seqs.map((s) => s.length));
    let at = -1;
    for (let i = 0; i < longest; i++) {
      if (new Set(seqs.map((s) => s[i] || "")).size > 1) { at = i; break; }
    }
    for (const c of group) {
      const step = at >= 0 ? c.steps[at] : null;
      if (step) c.title = `${title} [${step.actionName} → "${step.branch || "continues"}"]`;
    }
  }
  // Anything still identical gets numbered.
  const seen = new Map();
  for (const c of cases) {
    const n = (seen.get(c.title) || 0) + 1;
    seen.set(c.title, n);
    if (n > 1) c.title = `${c.title} (${n})`;
  }
}

/**
 * Generate test cases for one parsed flow.
 *
 * @param {object} data  parsed flow (parseFlowYaml)
 * @param {object} [opts]
 * @param {"branch"|"happy"|"all"} [opts.mode="branch"]
 * @param {number} [opts.cap=ALL_PATHS_CAP]  max cases for this flow
 * @param {string} [opts.idPrefix="TC"]      case id prefix
 * @returns {{ flow: object, mode: string, cases: object[], coverage: object,
 *            findings: string[], truncated: boolean }}
 */
export function generateTestCases(data, opts = {}) {
  const mode = COVERAGE_MODES[opts.mode] ? opts.mode : "branch";
  const cap = opts.cap || ALL_PATHS_CAP;
  const idPrefix = opts.idPrefix || "TC";
  const g = indexGraph(data);
  const findings = [];

  const flow = {
    name: (data.meta && data.meta.name) || "(flow)",
    type: (data.meta && data.meta.type) || "",
    division: (data.meta && data.meta.division) || "",
  };

  // Start container: the one the parser marked, else the first task.
  const tasks = data.tasks || [];
  let start = tasks.find((t) => t.isStart);
  if (!start && tasks.length) {
    start = tasks[0];
    findings.push(`No start container was marked in "${flow.name}"; generation started at "${start.name}".`);
  }
  const startId = start && start.entryId;
  if (!startId) {
    findings.push(`"${flow.name}" has no reachable start action — nothing to generate.`);
    return { flow, mode, cases: [], coverage: emptyCoverage(), findings, truncated: false };
  }

  // Every branch in the flow, as the coverage denominator.
  const allBranches = [];
  for (const nodeId of g.actionById.keys()) {
    for (const e of branchesOf(g, nodeId)) allBranches.push(e);
  }
  const branchById = new Map(allBranches.map((e) => [e.id, e]));

  let result;
  if (mode === "all") {
    result = allPaths(g, startId, cap);
  } else if (mode === "happy") {
    // Targets are the OUTCOMES a case can end on. End Task / End State inside a
    // called task always returns to its caller, so it can never be an outcome —
    // leaving it in the target set makes the walk steer at something it can
    // never reach, and the "covered nothing new" stop fires early, cutting the
    // document short. The fallback covers a flow whose main task simply ends,
    // where those ARE the only outcomes there are.
    const endings = [...g.actionById.values()].filter(isEnding);
    const outcomes = endings.filter((a) => !TASK_SCOPED_ENDINGS.has(a.actionKey));
    result = greedyCover(g, startId, { targetNodes: (outcomes.length ? outcomes : endings).map((a) => a.id), cap });
  } else {
    result = greedyCover(g, startId, { targetEdges: allBranches.map((e) => e.id), cap });
  }

  // Identical paths carry no extra test value. The walkers should not produce
  // any, but a duplicate reaching the document is a visible defect in it.
  const seen = new Set();
  const paths = result.paths.filter((p) => {
    const sig = signatureOf(p);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });

  const built = paths.map((p) => {
    const steps = p.steps.map((s, n) => ({
      index: n + 1,
      task: s.action.taskName || "",
      action: oneLine(describeStep(g, s.action)),
      actionName: s.action.name || "",
      actionType: kindLabel(s.action.kind),
      branch: s.edge && !s.edge.synthetic ? s.edge.label || "" : "",
      detail: oneLine((s.edge && s.edge.detail) || s.action.exprText || ""),
    }));
    return {
      flow: flow.name,
      flowType: flow.type,
      entryPoint: start.name,
      title: titleFor(start.name, p.steps, p.outcome),
      preconditions: preconditionsFor(g, p.steps),
      testData: testDataFor(p.steps),
      steps,
      expected: p.outcome.text,
      outcomeKind: p.outcome.kind,
      priority: priorityFor(p.steps, p.outcome),
      edgeIds: [...p.used],
    };
  });

  // Highest priority first, so the document opens on the cases that matter and
  // the error handling follows. Ids are assigned after the sort, so TC-001 is
  // always the first case in the document.
  built.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  disambiguateTitles(built);
  const cases = built.map((c, i) => ({ id: `${idPrefix}-${pad(i + 1, 3)}`, ...c }));

  // Coverage: which branches any case took, and which none could reach.
  const covered = new Set();
  for (const c of cases) for (const id of c.edgeIds) covered.add(id);
  const reachable = reachableBranchIds(g, startId);
  const uncovered = allBranches
    .filter((e) => !covered.has(e.id))
    .map((e) => ({
      id: e.id,
      label: e.label || "(default)",
      from: describeNodeLabel(g, e.source),
      to: e.target ? describeNodeLabel(g, e.target) : "(ends the interaction)",
      detail: e.detail || "",
      reason: reachable.has(e.id)
        ? "Only reachable by repeating a step already taken (e.g. a second pass round a loop)"
        : "Nothing reaches this branch from the start of the flow",
    }));

  if (uncovered.length && mode === "branch") {
    const dead = uncovered.filter((u) => !reachable.has(u.id)).length;
    const loopOnly = uncovered.length - dead;
    if (dead) {
      findings.push(
        `${dead} branch(es) in "${flow.name}" cannot be reached from the start — ` +
        `usually an output wired to nothing, or a task nothing jumps to. Worth checking: ` +
        `nothing a caller does will ever run them. Listed on the Coverage sheet.`
      );
    }
    if (loopOnly) {
      findings.push(
        `${loopOnly} branch(es) in "${flow.name}" are reachable only by repeating a step ` +
        `already taken — a second pass round a loop — so no single-pass test case covers them.`
      );
    }
  }
  if (result.truncated) {
    findings.push(
      `Generation for "${flow.name}" hit the ${cap}-case cap and is INCOMPLETE. ` +
      `Use Branch coverage for a complete set, or test this flow in parts.`
    );
  }

  return {
    flow,
    mode,
    cases,
    coverage: {
      branchesTotal: allBranches.length,
      branchesCovered: covered.size,
      percent: allBranches.length ? Math.round((covered.size / allBranches.length) * 100) : 100,
      uncovered,
      byBranch: allBranches.map((e) => ({
        id: e.id,
        label: e.label || "(default)",
        from: describeNodeLabel(g, e.source),
        to: e.target ? describeNodeLabel(g, e.target) : "(ends the interaction)",
        detail: e.detail || "",
        cases: cases.filter((c) => c.edgeIds.includes(e.id)).map((c) => c.id),
      })),
      branchById,
    },
    findings,
    truncated: result.truncated,
  };
}

function describeNodeLabel(g, nodeId) {
  const node = g.nodeById.get(nodeId);
  if (!node) return nodeId;
  const task = node.taskName ? `${node.taskName} · ` : "";
  return `${task}${node.label || nodeId}`;
}

function emptyCoverage() {
  return { branchesTotal: 0, branchesCovered: 0, percent: 0, uncovered: [], byBranch: [], branchById: new Map() };
}

/**
 * The run-time-resolved references a tester has to confirm by hand. A queue
 * chosen by FindQueue(Flow.Queue) cannot be enumerated, so it is flagged rather
 * than guessed — the same set the dependency export reports.
 */
export function manualChecks(data) {
  const out = [];
  for (const a of (data.actionById || new Map()).values()) {
    for (const r of a.dynamicRefs || []) {
      out.push({
        flow: (data.meta && data.meta.name) || "",
        kind: r.kind,
        expression: r.exprText,
        task: a.taskName || "",
        action: a.name || "",
      });
    }
  }
  return out;
}
