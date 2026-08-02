#!/usr/bin/env node
/**
 * Onboarding POC — Architect flow YAML reference transform.
 *
 * Strips the "Template - " prefix from every Architect object name and reference
 * in an Archy-exported flow YAML, and optionally sets the flow's division.
 *
 * Why this is enough: every Architect cross-object reference is by NAME, not by
 * GUID — common modules (callCommonModule), data tables (dataTableLookup), data
 * actions (callData → dataAction), the in-queue flow (overrideInQueueFlow), and
 * the flow's own name. Removing the shared prefix consistently rewrites every
 * reference at once, so the published flow binds to the renamed customer-org
 * objects automatically.
 *
 * Deliberately dependency-free (pure string ops) so it can run anywhere — the
 * browser, a plain Node function, or inside the Archy runner container — without
 * pulling a YAML library that might reformat Archy's output.
 *
 * Usage:
 *   node transform.js <input.yaml> [--out <output.yaml>] [--division "Name"]
 *                     [--prefix "Template - "]
 *
 * Exit code 0 on success; prints a change report + warnings to stderr.
 */
"use strict";

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--division") args.division = argv[++i];
    else if (a === "--prefix") args.prefix = argv[++i];
    else args._.push(a);
  }
  return args;
}

/**
 * Transform an Archy flow YAML string.
 * @param {string} yaml   Raw exported YAML.
 * @param {object} opts   { prefix, division }
 * @returns {{ output: string, renames: Array, divisionFrom: string|null,
 *            divisionTo: string|null, warnings: string[] }}
 */
function transformFlowYaml(yaml, opts = {}) {
  const prefix = opts.prefix ?? "Template - ";
  const division = opts.division ?? null;

  // 1) Discover every distinct name that carries the prefix. A name token runs
  //    from the prefix up to the next YAML structural boundary (newline, colon,
  //    or quote). This gives us an explicit oldName → newName rename map, which
  //    is exactly what the real feature will build from the selected assets.
  const tokenRe = new RegExp(escapeRegExp(prefix) + "[^\\n:\"']+", "g");
  const oldNames = new Set();
  for (const m of yaml.matchAll(tokenRe)) oldNames.add(m[0].trim());

  const renames = [...oldNames].map((oldName) => ({
    old: oldName,
    new: stripPrefix(oldName, prefix),
    count: countOccurrences(yaml, oldName),
  }));

  // 2) Apply the renames. We replace the exact discovered name tokens (not a
  //    blanket prefix wipe) so any unrelated literal that merely *contains* the
  //    prefix text (e.g. a TTS phrase) is left untouched. Longest names first so
  //    a shorter name can never partially clobber a longer one.
  let output = yaml;
  for (const r of renames.sort((a, b) => b.old.length - a.old.length)) {
    output = output.split(r.old).join(r.new);
  }

  // 3) Set the flow's division (first top-level `division:` line only).
  let divisionFrom = null;
  let divisionTo = null;
  if (division) {
    output = output.replace(/^(\s*division:\s*)(.*)$/m, (_m, lead, val) => {
      divisionFrom = val.trim();
      divisionTo = division;
      return lead + division;
    });
  }

  // 4) Non-fatal warnings: things the prefix rule intentionally does NOT touch,
  //    which the operator should eyeball (see design §9).
  const warnings = collectWarnings(output);

  return { output, renames, divisionFrom, divisionTo, warnings };
}

function collectWarnings(yaml) {
  const warnings = [];

  // User prompts referenced by name — NOT auto-created; must exist in target.
  // Only literal (quoted) arguments are actual prompt names; a variable argument
  // (e.g. FindUserPrompt(Task.phraseIvrDK1)) resolves dynamically at runtime from
  // data-table values, so we can't name the prompt statically.
  const promptRe = /FindUserPrompt\(\s*("([^"]+)"|'([^']+)')\s*\)/g;
  const literalPrompts = new Set();
  for (const m of yaml.matchAll(promptRe)) literalPrompts.add((m[2] ?? m[3]).trim());
  const dynamicPromptCount =
    (yaml.match(/FindUserPrompt\(/g) || []).length - literalPrompts.size;
  if (literalPrompts.size) {
    warnings.push(
      `Referenced user prompts (must already exist in target org): ` +
        [...literalPrompts].join(", ")
    );
  }
  if (dynamicPromptCount > 0) {
    warnings.push(
      `${dynamicPromptCount} dynamic FindUserPrompt(...) call(s) resolve prompt ` +
        `names from data-table values at runtime — ensure those prompts exist in ` +
        `the target org.`
    );
  }

  // Hardcoded string literals that look like object names (e.g. a default queue
  // baked into the flow). Heuristic: `lit:` scalar values with letters. These
  // are demo-specific and copied as-is.
  const litRe = /\blit:\s*([A-Za-z][A-Za-z0-9 _%&-]{2,})\s*$/gm;
  const lits = new Set();
  for (const m of yaml.matchAll(litRe)) {
    const v = m[1].trim();
    // Skip obvious non-name literals.
    if (/^(true|false|closed|holiday|standard|default|voice|callback)$/i.test(v)) continue;
    lits.add(v);
  }
  if (lits.size) {
    warnings.push(
      `Hardcoded literals left unchanged (verify they are valid in the target ` +
        `org): ` + [...lits].join(", ")
    );
  }

  return warnings;
}

function stripPrefix(name, prefix) {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  return hay.split(needle).length - 1;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0];
  if (!input) {
    console.error("Usage: node transform.js <input.yaml> [--out <output.yaml>] [--division \"Name\"] [--prefix \"Template - \"]");
    process.exit(2);
  }

  const yaml = fs.readFileSync(input, "utf8");
  const result = transformFlowYaml(yaml, {
    prefix: args.prefix,
    division: args.division,
  });

  const outPath =
    args.out || path.join(path.dirname(input), "transformed-" + path.basename(input));
  fs.writeFileSync(outPath, result.output, "utf8");

  // Report → stderr so stdout stays clean if this is ever piped.
  console.error(`\nOnboarding transform — ${path.basename(input)}`);
  console.error("─".repeat(60));
  console.error(`Renamed ${result.renames.length} object name(s):`);
  for (const r of result.renames.sort((a, b) => a.new.localeCompare(b.new))) {
    console.error(`  • "${r.old}"  →  "${r.new}"   (${r.count}×)`);
  }
  if (result.divisionTo) {
    console.error(`\nDivision: "${result.divisionFrom}"  →  "${result.divisionTo}"`);
  } else {
    console.error(`\nDivision: (unchanged — pass --division to set it)`);
  }
  if (result.warnings.length) {
    console.error(`\nWarnings (${result.warnings.length}):`);
    for (const w of result.warnings) console.error(`  ⚠ ${w}`);
  }
  console.error(`\nWrote → ${outPath}\n`);
}

if (require.main === module) main();

module.exports = { transformFlowYaml };
