#!/usr/bin/env node
/**
 * build-pages — the server's list of every page a Super User scope may hold.
 *
 * The Super User scope and a Super User's own pages are stored as page access
 * keys (docs/customer-roles-design.md §2, docs/internal-roles-design.md §6)
 * and validated server-side. The API is deployed on its own and cannot read
 * js/navConfig.js at runtime, so the list is generated from the nav and
 * checked in as api/lib/pages.json — one file, every page an internal
 * colleague may hold, with `customer: true` on the ones a customer may hold
 * too (the customer set is a subset of the internal set).
 *
 *   node scripts/build-pages.mjs           rewrite the file
 *   node scripts/build-pages.mjs --check   exit 1 if it is stale
 *
 * The --check form runs in CI ahead of the deploy, so a page added to the nav
 * without regenerating the list fails the build rather than becoming a page
 * no Super User can ever be given.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const OUT = join(ROOT, "api", "lib", "pages.json");
const CHECK = process.argv.includes("--check");

// The same walk the app's own pages use (js/services/customerPageTree.js),
// so the server's list and the client's tree cannot disagree.
const fileUrl = (...parts) => join(ROOT, ...parts).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:");
const { customerPageTree, internalPageTree } = await import(fileUrl("js", "services", "customerPageTree.js"));

function leaves(tree) {
  const out = [];
  (function walk(nodes, trail) {
    for (const n of nodes) {
      if (n.children) { walk(n.children, [...trail, n.label]); continue; }
      out.push({ key: n.key, label: n.label, section: trail.join(" › ") });
    }
  })(tree, []);
  return out;
}
const customer = new Set(leaves(customerPageTree()).map((p) => p.key));
const pages = leaves(internalPageTree()).map((p) => ({ ...p, customer: customer.has(p.key) }));
const missing = [...customer].filter((k) => !pages.some((p) => p.key === k));
if (missing.length) { console.error(`customer pages not in the internal set: ${missing.join(", ")}`); process.exit(2); }
pages.sort((a, b) => a.key.localeCompare(b.key));

const next = JSON.stringify({ generatedBy: "scripts/build-pages.mjs", pages }, null, 2) + "\n";
let current = null;
try { current = readFileSync(OUT, "utf8"); } catch { /* first run */ }

const n = `${pages.length} internal, ${customer.size} customer`;
if (CHECK) {
  if (current === next) { console.log(`pages.json is current (${n}).`); process.exit(0); }
  console.log("pages.json is STALE. Run: node scripts/build-pages.mjs");
  process.exit(1);
}
writeFileSync(OUT, next);
console.log(`wrote ${OUT} — ${n}.`);
