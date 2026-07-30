#!/usr/bin/env node
/**
 * Onboarding POC — dependency resolver.
 *
 * Parses an Architect flow YAML and auto-discovers everything it references, so
 * the operator only needs to pick the callflow(s) — the app finds the rest.
 *
 * Detected reference types (all name-based in Archy YAML):
 *   • callCommonModule  → commonModule: <name>        (a flow → recurse)
 *   • dataTableLookup   → dataTable:  <name>          (leaf)
 *   • callData          → category: <integration> / dataAction: <name>   (leaf)
 *   • overrideInQueueFlow → name: <in-queue flow>     (a flow → recurse)
 *   • transferToFlow(Secure) → targetFlow: name: <flow> (a flow → recurse)
 *
 * Common modules and in-queue flows are themselves flows, so a full onboarding
 * would export each discovered flow and resolve it too — this module exposes
 * `resolveDeps(yaml)` for that recursion. The CLI resolves a single file and
 * prints the dependency set + a suggested deploy order (leaves first).
 *
 * Dependency-free (pure line scan) — no YAML library, so Archy's exact output is
 * never reformatted.
 *
 * Usage:  node deps.js <flow.yaml> [--json]
 */
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Resolve the direct dependencies referenced by one flow YAML.
 * @returns {{ commonModules:string[], inQueueFlows:string[], transferFlows:string[],
 *            dataTables:string[], dataActions:Array<{integration:string,action:string}> }}
 */
function resolveDeps(yaml) {
  const lines = yaml.split(/\r?\n/);

  const commonModules = new Set();
  const inQueueFlows = new Set();
  const transferFlows = new Set();
  const dataTables = new Set();
  const dataActions = new Map(); // key `${integration}::${action}` → {integration, action}

  let lastIntegration = null;

  const nextMappingKey = (i) => {
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      const m = t.match(/^(.+?):\s*$/);
      return m ? m[1].trim() : null;
    }
    return null;
  };
  const nextNameValue = (i) => {
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      const m = t.match(/^name:\s*(.+?)\s*$/);
      return m ? stripQuotes(m[1].trim()) : null;
    }
    return null;
  };

  lines.forEach((line, i) => {
    const t = line.trim();
    switch (t) {
      case "commonModule:": {
        const n = nextMappingKey(i);
        if (n) commonModules.add(n);
        break;
      }
      case "dataTable:": {
        const n = nextMappingKey(i);
        if (n) dataTables.add(n);
        break;
      }
      case "category:": {
        // The next mapping key under `category:` is the integration name; it is
        // followed by `dataAction:`. Only treat it as an integration if a
        // dataAction actually follows (guards against unrelated `category:` keys).
        lastIntegration = nextMappingKey(i);
        break;
      }
      case "dataAction:": {
        const action = nextMappingKey(i);
        if (action) {
          const integration = lastIntegration || "(unknown integration)";
          dataActions.set(`${integration}::${action}`, { integration, action });
        }
        break;
      }
      case "overrideInQueueFlow:": {
        const n = nextNameValue(i);
        if (n) inQueueFlows.add(n);
        break;
      }
      case "targetFlow:": {
        const n = nextNameValue(i);
        if (n) transferFlows.add(n);
        break;
      }
      default:
        break;
    }
  });

  return {
    commonModules: [...commonModules].sort(),
    inQueueFlows: [...inQueueFlows].sort(),
    transferFlows: [...transferFlows].sort(),
    dataTables: [...dataTables].sort(),
    dataActions: [...dataActions.values()].sort((a, b) =>
      (a.integration + a.action).localeCompare(b.integration + b.action)
    ),
  };
}

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, "");
}

// ── Transitive closure over a folder of exported YAMLs ──────────────────────────

const CALLFLOW_TYPES = new Set([
  "inboundCall", "inboundChat", "inboundEmail", "inboundShortMessage",
  "outboundCall", "workflow", "bot", "digitalBot",
]);
const INQUEUE_TYPES = new Set(["inQueueCall", "inQueueEmail", "inQueueShortMessage"]);

/** Extract the top-level flow type and name from an exported YAML. */
function parseFlowMeta(yaml) {
  const lines = yaml.split(/\r?\n/);
  let flowType = null;
  let name = null;
  for (const line of lines) {
    if (flowType === null) {
      const m = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*$/); // column-0 top-level key
      if (m) { flowType = m[1]; continue; }
    } else if (name === null) {
      const m = line.match(/^\s+name:\s*(.+?)\s*$/);
      if (m) { name = stripQuotes(m[1].trim()); break; }
    }
  }
  return { flowType, name };
}

/** Read every *.yaml/*.yml under a directory (recursively) into a name index. */
function indexFlowDir(dir) {
  const index = new Map(); // name → { name, flowType, file, yaml }
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ya?ml$/i.test(entry.name)) {
        const yaml = fs.readFileSync(full, "utf8");
        const meta = parseFlowMeta(yaml);
        if (meta.name) index.set(meta.name, { ...meta, file: full, yaml });
      }
    }
  };
  walk(dir);
  return index;
}

/**
 * Walk the full transitive dependency closure starting from `roots` (flow names),
 * resolving referenced common modules / in-queue / transfer flows against `index`.
 */
function buildClosure(index, roots) {
  const visited = new Set();
  const missingFlows = new Set();
  const dataTables = new Set();
  const dataActions = new Map();
  const edges = new Map(); // flowName → Set(dependency flow names)

  const visit = (name) => {
    if (visited.has(name)) return;
    visited.add(name);
    const entry = index.get(name);
    if (!entry) { missingFlows.add(name); return; }
    const deps = resolveDeps(entry.yaml);
    deps.dataTables.forEach((t) => dataTables.add(t));
    deps.dataActions.forEach((a) => dataActions.set(`${a.integration}::${a.action}`, a));
    const flowDeps = [...deps.commonModules, ...deps.inQueueFlows, ...deps.transferFlows];
    edges.set(name, new Set(flowDeps));
    flowDeps.forEach(visit);
  };
  roots.forEach(visit);

  const presentFlows = new Set([...visited].filter((n) => index.has(n)));
  return { presentFlows, missingFlows, dataTables, dataActions, edges };
}

/** Topological order (dependencies before dependents); cycle-safe. */
function topoSort(nodes, edges) {
  const order = [];
  const temp = new Set();
  const perm = new Set();
  const visit = (n) => {
    if (perm.has(n) || temp.has(n)) return;
    temp.add(n);
    for (const d of edges.get(n) || []) if (nodes.has(d)) visit(d);
    temp.delete(n);
    perm.add(n);
    order.push(n);
  };
  for (const n of nodes) visit(n);
  return order;
}

function recurseMain(argv) {
  const asJson = argv.includes("--json");
  const dirIdx = argv.indexOf("--recurse");
  const dir = argv[dirIdx + 1];
  if (!dir || dir.startsWith("--")) {
    console.error('Usage: node deps.js --recurse <folder> [--root "Flow Name" ...] [--json]');
    process.exit(2);
  }
  // Collect explicit roots (repeatable --root), else default to callflow-type files.
  const roots = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--root") roots.push(argv[++i]);

  const index = indexFlowDir(dir);
  if (!index.size) { console.error(`No flow YAMLs found under ${dir}`); process.exit(1); }

  const rootNames = roots.length
    ? roots
    : [...index.values()].filter((e) => CALLFLOW_TYPES.has(e.flowType)).map((e) => e.name);
  if (!rootNames.length) {
    console.error("No root callflows found (none of the given types). Pass --root explicitly.");
    process.exit(1);
  }

  const c = buildClosure(index, rootNames);
  const flowOrder = topoSort(c.presentFlows, c.edges);

  const classify = (n) => {
    const t = index.get(n)?.flowType;
    if (INQUEUE_TYPES.has(t)) return "in-queue";
    if (t === "commonModule") return "common-module";
    if (CALLFLOW_TYPES.has(t)) return "callflow";
    return t || "unknown";
  };

  if (asJson) {
    process.stdout.write(JSON.stringify({
      roots: rootNames,
      flowsInDeployOrder: flowOrder.map((n) => ({ name: n, type: classify(n) })),
      dataTables: [...c.dataTables].sort(),
      dataActions: [...c.dataActions.values()],
      missingFlows: [...c.missingFlows].sort(),
    }, null, 2) + "\n");
    return;
  }

  console.log(`\nTransitive closure from ${rootNames.length} root callflow(s)`);
  console.log("─".repeat(64));
  console.log(`Indexed ${index.size} flow file(s) in ${dir}\n`);

  console.log(`Data tables  [leaf] (${c.dataTables.size}):`);
  [...c.dataTables].sort().forEach((t) => console.log(`  • ${t}`));
  console.log(`\nData actions  [leaf] (${c.dataActions.size}):`);
  [...c.dataActions.values()].forEach((a) => console.log(`  • ${a.action}   (integration: ${a.integration})`));

  console.log(`\nFull deploy order (dependencies first):`);
  let step = 1;
  console.log(`  ${step++}. Data tables:  ${c.dataTables.size}`);
  console.log(`  ${step++}. Data actions: ${c.dataActions.size}`);
  flowOrder.forEach((n) => console.log(`  ${step++}. [${classify(n)}] ${n}`));

  if (c.missingFlows.size) {
    console.log(`\n⚠ Referenced flows NOT found in ${dir} — export these too (${c.missingFlows.size}):`);
    [...c.missingFlows].sort().forEach((n) => console.log(`  • ${n}`));
  } else {
    console.log(`\n✓ Closure complete — every referenced flow is present in the folder.`);
  }
  console.log("");
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--recurse")) return recurseMain(argv);

  const asJson = argv.includes("--json");
  const input = argv.find((a) => !a.startsWith("--"));
  if (!input) {
    console.error("Usage:\n  node deps.js <flow.yaml> [--json]\n  node deps.js --recurse <folder> [--root \"Flow Name\" ...] [--json]");
    process.exit(2);
  }

  const yaml = fs.readFileSync(input, "utf8");
  const deps = resolveDeps(yaml);

  if (asJson) {
    process.stdout.write(JSON.stringify(deps, null, 2) + "\n");
    return;
  }

  const flowsToRecurse = [...deps.commonModules, ...deps.inQueueFlows, ...deps.transferFlows];

  console.log(`\nDependencies discovered in ${path.basename(input)}`);
  console.log("─".repeat(64));

  const section = (title, items) => {
    console.log(`\n${title} (${items.length}):`);
    if (!items.length) console.log("  —");
    else items.forEach((x) => console.log(`  • ${x}`));
  };

  section("Common modules  [flow → recurse]", deps.commonModules);
  section("In-queue flows  [flow → recurse]", deps.inQueueFlows);
  if (deps.transferFlows.length) section("Transfer target flows  [flow → recurse]", deps.transferFlows);
  section("Data tables  [leaf]", deps.dataTables);
  section(
    "Data actions  [leaf]",
    deps.dataActions.map((d) => `${d.action}   (integration: ${d.integration})`)
  );

  console.log(`\nSuggested deploy order (leaves first):`);
  console.log(`  1. Data tables:  ${deps.dataTables.length}`);
  console.log(`  2. Data actions: ${deps.dataActions.length}`);
  console.log(`  3. Common modules: ${deps.commonModules.length}`);
  console.log(`  4. In-queue flows: ${deps.inQueueFlows.length}`);
  console.log(`  5. This callflow`);

  if (flowsToRecurse.length) {
    console.log(
      `\nNote: ${flowsToRecurse.length} referenced flow(s) are themselves flows — ` +
        `the full feature exports each and resolves it recursively to catch nested ` +
        `dependencies. Recurse into: ${flowsToRecurse.join(", ")}`
    );
  }
  console.log("");
}

if (require.main === module) main();

module.exports = { resolveDeps, indexFlowDir, buildClosure, topoSort, parseFlowMeta };
