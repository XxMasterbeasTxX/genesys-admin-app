/**
 * Onboarding engine (copy for the runner app) — pure, dependency-free logic.
 * Mirrors api/lib/onboardingEngine.js. See that file for the canonical version.
 */
"use strict";

const DEFAULT_PREFIX = "Template - ";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPrefix(name, prefix = DEFAULT_PREFIX) {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

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

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, "");
}

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

function resolveDeps(yaml) {
  const lines = yaml.split(/\r?\n/);

  const commonModules = new Set();
  const inQueueFlows = new Set();
  const transferFlows = new Set();
  const dataTables = new Set();
  const dataActions = new Map();
  const prompts = new Set();

  let lastIntegration = null;

  // A directly referenced user prompt, e.g.
  //     audio:
  //       prompt: Prompt.TemplateTestPrompt
  // Anchored on the whole value so "SystemPrompt.x" does NOT match — system
  // prompts exist in every org and must not be copied. Keys that merely end in
  // "prompt" (processingPrompt:) can't match either, because the key is anchored.
  const PROMPT_REF = /^\s*prompt:\s*["']?Prompt\.(.+?)["']?\s*$/;

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
    const promptMatch = line.match(PROMPT_REF);
    if (promptMatch) prompts.add(stripQuotes(promptMatch[1].trim()));

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
    prompts: [...prompts].sort(),
    dataActions: [...dataActions.values()].sort((a, b) =>
      (a.integration + a.action).localeCompare(b.integration + b.action)
    ),
  };
}

// ── i3 (architect-format) transform ─────────────────────────────────────────

/**
 * Transform an .i3InboundFlow (architect-format) flow file.
 *
 * The file is base64( url-encoded( JSON ) ). Object names appear url-encoded
 * (spaces → %20), so we strip the url-encoded prefix ("Template%20-%20") directly
 * on the url-encoded layer — no full JSON decode/re-encode, preserving the exact
 * bytes the SDK expects. Used because YAML flow import is gated in customer orgs
 * but the architect format is not.
 *
 * @returns {{ output: string (base64), count: number }}
 */
function transformI3(base64Content, opts = {}) {
  const prefix = opts.prefix || DEFAULT_PREFIX;
  const guidMap = opts.guidMap || null; // Map|object: demoGUID → customerGUID
  const urlPrefix = encodeURIComponent(prefix); // "Template - " → "Template%20-%20"
  let urlEnc = Buffer.from(String(base64Content).trim(), "base64").toString("utf8");

  // 1) Strip the "Template - " prefix from names (url-encoded layer).
  const count = urlEnc.split(urlPrefix).length - 1;
  urlEnc = urlEnc.split(urlPrefix).join("");

  // 2) Remap demo dependency GUIDs → customer GUIDs. GUIDs are URL-safe (hex +
  //    hyphens), so they appear verbatim in the url-encoded content. Only the
  //    specific dependency GUIDs in the map are replaced; the flow's internal
  //    task/action GUIDs (different GUIDs) are left untouched.
  let remapped = 0;
  if (guidMap) {
    const entries = guidMap instanceof Map ? [...guidMap] : Object.entries(guidMap);
    for (const [demo, cust] of entries) {
      if (demo && cust && demo !== cust && urlEnc.includes(demo)) {
        const parts = urlEnc.split(demo);
        remapped += parts.length - 1;
        urlEnc = parts.join(cust);
      }
    }
  }

  // 3) Optionally rename the flow itself (e.g. to apply a user prefix). We anchor on
  //    the url-encoded QUOTED name so only exact full-name matches are replaced —
  //    not substrings inside nested task/menu names.
  if (opts.renameFrom && opts.renameTo && opts.renameFrom !== opts.renameTo) {
    const from = encodeURIComponent(`"${opts.renameFrom}"`);
    const to = encodeURIComponent(`"${opts.renameTo}"`);
    if (urlEnc.includes(from)) urlEnc = urlEnc.split(from).join(to);
  }

  return { output: Buffer.from(urlEnc, "utf8").toString("base64"), count, remapped };
}

/** Read the default language tag (e.g. "da-dk") from an exported flow YAML. */
function getDefaultLanguage(yaml) {
  const m = String(yaml).match(/^\s*defaultLanguage:\s*(\S+)/m);
  return m ? m[1] : null;
}

module.exports = {
  DEFAULT_PREFIX,
  stripPrefix,
  transformFlowYaml,
  parseFlowMeta,
  resolveDeps,
  transformI3,
  getDefaultLanguage,
};
