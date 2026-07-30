/**
 * Onboarding engine — pure, dependency-free logic shared by the backend runner.
 *
 * Ported from the validated POC (poc/onboarding/transform.js + deps.js):
 *   - transformFlowYaml : strip the "Template - " prefix from every name/reference
 *                         and set the flow division.
 *   - resolveDeps       : discover a flow's direct dependencies from its YAML.
 *   - parseFlowMeta     : read the flow type (root key) + name from exported YAML.
 *
 * All functions operate on the name-based Archy YAML produced by the Flow
 * Scripting SDK's exportToObjectAsync('yaml') / exportToDirAsync.
 */
"use strict";

const DEFAULT_PREFIX = "Template - ";

// ── Transform ───────────────────────────────────────────────────────────────

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPrefix(name, prefix = DEFAULT_PREFIX) {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * Strip the prefix from every discovered name token and (optionally) set the
 * flow's division. Returns the rewritten YAML plus a change report.
 */
function transformFlowYaml(yaml, opts = {}) {
  const prefix = opts.prefix || DEFAULT_PREFIX;
  const division = opts.division || null;

  const tokenRe = new RegExp(escapeRegExp(prefix) + "[^\\n:\"']+", "g");
  const oldNames = new Set();
  for (const m of yaml.matchAll(tokenRe)) oldNames.add(m[0].trim());

  const renames = [...oldNames].map((oldName) => ({
    old: oldName,
    new: stripPrefix(oldName, prefix),
  }));

  // Longest first so a shorter name can't partially clobber a longer one.
  let output = yaml;
  for (const r of renames.sort((a, b) => b.old.length - a.old.length)) {
    output = output.split(r.old).join(r.new);
  }

  let divisionFrom = null;
  let divisionTo = null;
  if (division) {
    output = output.replace(/^(\s*division:\s*)(.*)$/m, (_m, lead, val) => {
      divisionFrom = val.trim();
      divisionTo = division;
      return lead + division;
    });
  }

  return { output, renames, divisionFrom, divisionTo };
}

// ── Flow meta ───────────────────────────────────────────────────────────────

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, "");
}

/** Extract the top-level flow type (root key) and name from an exported YAML. */
function parseFlowMeta(yaml) {
  const lines = yaml.split(/\r?\n/);
  let flowType = null;
  let name = null;
  for (const line of lines) {
    if (flowType === null) {
      const m = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*$/);
      if (m) { flowType = m[1]; continue; }
    } else if (name === null) {
      const m = line.match(/^\s+name:\s*(.+?)\s*$/);
      if (m) { name = stripQuotes(m[1].trim()); break; }
    }
  }
  return { flowType, name };
}

// ── Dependency resolver ─────────────────────────────────────────────────────

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
  const dataActions = new Map();

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
    switch (line.trim()) {
      case "commonModule:": { const n = nextMappingKey(i); if (n) commonModules.add(n); break; }
      case "dataTable:": { const n = nextMappingKey(i); if (n) dataTables.add(n); break; }
      case "category:": { lastIntegration = nextMappingKey(i); break; }
      case "dataAction:": {
        const action = nextMappingKey(i);
        if (action) {
          const integration = lastIntegration || "(unknown integration)";
          dataActions.set(`${integration}::${action}`, { integration, action });
        }
        break;
      }
      case "overrideInQueueFlow:": { const n = nextNameValue(i); if (n) inQueueFlows.add(n); break; }
      case "targetFlow:": { const n = nextNameValue(i); if (n) transferFlows.add(n); break; }
      default: break;
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

module.exports = {
  DEFAULT_PREFIX,
  stripPrefix,
  transformFlowYaml,
  parseFlowMeta,
  resolveDeps,
};
