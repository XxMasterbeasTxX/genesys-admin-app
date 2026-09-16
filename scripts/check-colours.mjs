#!/usr/bin/env node
/**
 * check-colours — every colour in the app must come from css/tokens.css.
 *
 * Scans the stylesheet, every app module under js/ (vendor bundles excluded
 * by name), and the two HTML files for colour literals — hex, rgb()/rgba(), hsl()/hsla(), and CSS named
 * colours in a declaration — and reports every one found outside tokens.css.
 *
 *   node scripts/check-colours.mjs            report; always exits 0
 *   node scripts/check-colours.mjs --strict   exit 1 if anything is found
 *   node scripts/check-colours.mjs --all      list every finding, not just the
 *                                             first few per file
 *
 * Why this exists: the 24 light-mode patch blocks the stylesheet used to
 * carry are what "one place" turns into without a guard, one feature at a
 * time. Every one of them was reasonable when it was written. The check runs
 * in CI ahead of the deploy, so a literal that gets past review does not get
 * deployed. See docs/colour-tokens-design.md §9.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const args = new Set(process.argv.slice(2));
const STRICT = args.has("--strict");
const ALL = args.has("--all");
const PER_FILE = ALL ? Infinity : 6;

// ── What is scanned ─────────────────────────────────────────────────────────

const TOKENS = "css/tokens.css";                   // the one place; never flagged
const SKIP_DIRS = new Set(["node_modules", ".git", "api", "docs",
                           "timer-functions", "timer-functions-check", "onboarding-runner"]);
// js/lib mixes vendor bundles with our own modules (flowModel.js and friends
// are app code). Skip by name, not by directory, so ours are still scanned.
const VENDOR = /\.(min|bundled|bundle)\.js$/;
// Document palettes: the colours of an exported Excel workbook are the look of
// the document, not the app's theme, and deliberately do not follow it. They
// are to be consolidated into one file of their own — see
// docs/colour-tokens-design.md §12 — but they are not this file's business.
const DOCUMENT_PALETTES = new Set(["js/utils/excelStyles.js", "js/utils/billingExcelStyles.js"]);
const ROOTS = ["css", "js", "index.html", "download.html"];
const EXT = new Set([".css", ".js", ".mjs", ".html"]);

function* walk(rel) {
  const abs = join(ROOT, rel);
  if (!statSync(abs, { throwIfNoEntry: false })) return;
  if (statSync(abs).isFile()) { yield rel; return; }
  for (const name of readdirSync(abs)) {
    const child = rel ? `${rel}/${name}` : name;
    if (SKIP_DIRS.has(child)) continue;
    const st = statSync(join(ROOT, child));
    if (st.isDirectory()) yield* walk(child);
    else if (EXT.has(child.slice(child.lastIndexOf("."))) && !VENDOR.test(child)) yield child;
  }
}

// ── What counts as a colour ─────────────────────────────────────────────────

// #rgb #rgba #rrggbb #rrggbbaa — but not an HTML entity (&#8592;) and not a
// fragment of a longer token. Case-insensitive.
const HEX = /(?<![&\w])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;

const FUNC = /\b(?:rgba?|hsla?)\(/g;

// Named colours count only in value position — `color: red`, `fill:white` —
// so "red" in prose, a class name or a variable does not trip it. The three
// keywords that are not colours are excluded.
const NAMED = new RegExp(
  "(?<=:\\s*)(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|" +
  "blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|" +
  "cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|" +
  "darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|" +
  "darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|" +
  "dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|" +
  "green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|" +
  "lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|" +
  "lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|" +
  "lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|" +
  "mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|" +
  "mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|" +
  "olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|" +
  "papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|" +
  "saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|" +
  "slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|" +
  "whitesmoke|yellow|yellowgreen)(?=\\s*[;)\"'`}])", "gi");

// Comments are not colours. CSS and JS block comments are stripped before the
// scan; a line comment is left alone because `//` also lives inside URLs.
function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

// ── Scan ────────────────────────────────────────────────────────────────────

const findings = new Map();   // file -> [{ line, col, text, snippet }]
let total = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (file === TOKENS || DOCUMENT_PALETTES.has(file)) continue;
    const src = stripBlockComments(readFileSync(join(ROOT, file), "utf8"));
    const lines = src.split("\n");
    const hits = [];
    lines.forEach((line, i) => {
      for (const re of [HEX, FUNC, NAMED]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const col = m.index;
          const lo = Math.max(0, col - 28), hi = Math.min(line.length, col + m[0].length + 20);
          hits.push({ line: i + 1, col: col + 1, text: m[0],
                      snippet: (lo ? "…" : "") + line.slice(lo, hi).trim() + (hi < line.length ? "…" : "") });
        }
      }
    });
    if (hits.length) { findings.set(file, hits); total += hits.length; }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

const files = [...findings.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [file, hits] of files) {
  console.log(`\n${file.split(sep).join("/")}  (${hits.length})`);
  for (const h of hits.slice(0, PER_FILE)) {
    console.log(`  ${String(h.line).padStart(5)}:${String(h.col).padEnd(4)} ${h.text.padEnd(9)} ${h.snippet}`);
  }
  if (hits.length > PER_FILE) console.log(`  … +${hits.length - PER_FILE} more (run with --all)`);
}

console.log(`\n${"─".repeat(72)}`);
console.log(`colour literals outside ${TOKENS}: ${total}  in ${files.length} file${files.length === 1 ? "" : "s"}`);
if (total === 0) console.log("Every colour derives from the token file.");
else if (STRICT) { console.log("STRICT: failing. Move these into css/tokens.css and reference them with var()."); process.exit(1); }
else console.log("(report mode — add --strict to fail on findings)");
