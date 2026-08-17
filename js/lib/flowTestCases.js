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

/** Forward adjacency over branches, for reachability. Jumps resolve to entries. */
function adjacency(g) {
  const adj = new Map();
  for (const nodeId of g.actionById.keys()) {
    const targets = [];
    for (const e of branchesOf(g, nodeId)) {
      const t = resolveTarget(g, e);
      if (t) targets.push(t);
    }
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
  const onPath = new Set();
  const stack = [];
  let cur = startId;
  let outcome = null;

  while (cur) {
    if (onPath.has(cur)) {
      const node = g.nodeById.get(cur);
      outcome = { kind: "loop", text: `Loops back to "${(node && node.label) || cur}"` };
      break;
    }
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
 * Greedy coverage walk, shared by "branch" and "happy" mode — the two differ
 * only in what counts as a target:
 *
 *   branch → every branch (edge) must be taken by some case
 *   happy  → every reachable terminal must be reached by some case
 *
 * Each iteration walks from the start preferring (1) a branch that is itself an
 * uncovered target, (2) a branch from which an uncovered target is still
 * reachable, (3) the primary continuation. Terminates because an iteration that
 * covers nothing new stops the loop: the targets still outstanding are then only
 * reachable by revisiting a node, which no simple path does.
 */
function greedyCover(g, startId, { targetEdges, targetNodes, cap }) {
  const adj = adjacency(g);
  const uncoveredEdges = new Set(targetEdges || []);
  const uncoveredNodes = new Set(targetNodes || []);
  const paths = [];
  let truncated = false;

  const outstanding = () => uncoveredEdges.size + uncoveredNodes.size;

  while (outstanding() > 0) {
    if (paths.length >= cap) { truncated = true; break; }

    // Nodes that still hold something uncovered — an uncovered target node, or a
    // node with an uncovered branch out of it. Recomputed once per iteration.
    const holders = new Set(uncoveredNodes);
    for (const [nodeId] of adj) {
      for (const e of branchesOf(g, nodeId)) {
        if (uncoveredEdges.has(e.id)) { holders.add(nodeId); break; }
      }
    }

    const path = walkPath(g, startId, (nodeId, branches, onPath) => {
      const direct = branches.find((e) => uncoveredEdges.has(e.id));
      if (direct) return direct;
      const toward = branches.find((e) => {
        const t = resolveTarget(g, e);
        return t && !onPath.has(t) && reachesHolder(g, adj, t, holders, onPath);
      });
      return toward || preferPrimary(branches);
    });

    const before = outstanding();
    for (const id of path.used) uncoveredEdges.delete(id);
    // A target node counts as covered only when it is the path's OUTCOME, not
    // when the path merely passes through it. Walking through "To Sales Queue"
    // on the way to its Failure handler does not test the transfer succeeding.
    if (path.outcome.action) uncoveredNodes.delete(path.outcome.action.id);

    // A path that covers nothing new adds no test value, and means whatever is
    // left is only reachable by revisiting a node — which no simple path does.
    // Stop WITHOUT emitting it, or the set ends with a duplicate of an earlier
    // case.
    if (outstanding() === before) break;
    paths.push(path);
  }

  // A flow with no branches at all still has one case to generate.
  if (!paths.length) paths.push(walkPath(g, startId, (_n, branches) => preferPrimary(branches)));

  return { paths, truncated };
}

/**
 * Exhaustive enumeration: every distinct path, depth-first, capped.
 *
 * Explicit recursion over the branch set at each node, carrying the walk state
 * (steps so far, call stack, nodes on this path) down each branch as a copy.
 * Every path corresponds to one distinct sequence of branch choices, so no
 * de-duplication is needed and nothing is missed.
 */
function allPaths(g, startId, cap) {
  const paths = [];
  let truncated = false;

  const visit = (cur, steps, used, onPath, stack) => {
    if (paths.length >= cap) { truncated = true; return; }

    if (onPath.has(cur)) {
      const node = g.nodeById.get(cur);
      paths.push({ steps, used, outcome: { kind: "loop", text: `Loops back to "${(node && node.label) || cur}"` } });
      return;
    }
    const path = new Set(onPath);
    path.add(cur);

    const c = classify(g, cur, stack);
    if (c.outcome) {
      paths.push({ steps: [...steps, { action: c.action, edge: null }], used, outcome: c.outcome });
      return;
    }
    if (c.popTo) {
      visit(c.popTo, [...steps, { action: c.action, edge: null }], used, path, stack.slice(0, -1));
      return;
    }

    for (const edge of c.branches) {
      if (paths.length >= cap) { truncated = true; return; }
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
        if (nextStack.length) visit(nextStack[nextStack.length - 1], nextSteps, nextUsed, path, nextStack.slice(0, -1));
        else paths.push({ steps: nextSteps, used: nextUsed, outcome: { kind: "endOfFlow", text: "End of flow (branch leads nowhere)" } });
        continue;
      }
      visit(next, nextSteps, nextUsed, path, nextStack);
    }
  };

  visit(startId, [], new Set(), new Set(), []);
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

/**
 * The conditions that must hold to force this path. Stated, never solved:
 * Architect expressions are arbitrary, so the document says what must be true
 * and the tester sets it up. See docs/test-case-design.md §7.
 */
function testDataFor(steps) {
  const out = [];
  for (const s of steps) {
    if (!s.edge || !s.edge.label) continue;
    const expr = s.edge.detail || s.action.exprText || "";
    const where = s.action.name || s.action.actionKey;
    if (expr) out.push(`${where} → "${s.edge.label}": ${expr}`);
    else out.push(`${where} → "${s.edge.label}"`);
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

function titleFor(startName, steps, outcome) {
  const branches = steps
    .filter((s) => s.edge && s.edge.label && !PRIMARY_LABELS.has(String(s.edge.label).toLowerCase()))
    .map((s) => s.edge.label);
  const parts = [startName, ...branches.slice(0, 4)];
  if (branches.length > 4) parts.push("…");
  parts.push(outcome.text);
  const title = parts.filter(Boolean).join(" → ");
  return title.length > 200 ? title.slice(0, 199) + "…" : title;
}

function pad(n, width) {
  return String(n).padStart(width, "0");
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
      action: describeStep(g, s.action),
      actionName: s.action.name || "",
      actionType: kindLabel(s.action.kind),
      branch: s.edge && !s.edge.synthetic ? s.edge.label || "" : "",
      detail: (s.edge && s.edge.detail) || s.action.exprText || "",
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
  const cases = built.map((c, i) => ({ id: `${idPrefix}-${pad(i + 1, 3)}`, ...c }));

  // Coverage: which branches any case took, and which none could reach.
  const covered = new Set();
  for (const c of cases) for (const id of c.edgeIds) covered.add(id);
  const uncovered = allBranches
    .filter((e) => !covered.has(e.id))
    .map((e) => ({
      id: e.id,
      label: e.label || "(default)",
      from: describeNodeLabel(g, e.source),
      to: e.target ? describeNodeLabel(g, e.target) : "(ends the interaction)",
      detail: e.detail || "",
    }));

  if (uncovered.length && mode === "branch") {
    findings.push(
      `${uncovered.length} branch(es) in "${flow.name}" could not be reached from the start — ` +
      `usually an output wired to nothing, or a task nothing jumps to. Listed on the Coverage sheet.`
    );
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
