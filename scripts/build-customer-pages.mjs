#!/usr/bin/env node
/**
 * build-customer-pages — the server's list of every page a customer may hold.
 *
 * The Supervisor scope and a Supervisor's own pages are stored as page access
 * keys (docs/customer-roles-design.md §2) and validated server-side. The API
 * is deployed on its own and cannot read js/navConfig.js at runtime, so the
 * list is generated from the nav tree minus CUSTOMER_EXCLUDED_KEYS and
 * CUSTOMER_ADMIN_KEYS and checked in as api/lib/customerPages.json.
 *
 *   node scripts/build-customer-pages.mjs           rewrite the file
 *   node scripts/build-customer-pages.mjs --check   exit 1 if it is stale
 *
 * The --check form runs in CI ahead of the deploy, so a page added to the nav
 * without regenerating the list fails the build rather than becoming a page
 * no Supervisor can ever be given.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const OUT = join(ROOT, "api", "lib", "customerPages.json");
const CHECK = process.argv.includes("--check");

// The same walk the app's own pages use (js/services/customerPageTree.js),
// so the server's list and the client's tree cannot disagree.
const fileUrl = (...parts) => join(ROOT, ...parts).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:");
const { customerPageTree } = await import(fileUrl("js", "services", "customerPageTree.js"));

// Every page, with the section path it sits under, so the server can also
// say which section a key belongs to if it ever needs to.
const pages = [];
(function walk(nodes, trail) {
  for (const n of nodes) {
    if (n.children) { walk(n.children, [...trail, n.label]); continue; }
    pages.push({ key: n.key, label: n.label, section: trail.join(" › ") });
  }
})(customerPageTree(), []);
pages.sort((a, b) => a.key.localeCompare(b.key));

const next = JSON.stringify({ generatedBy: "scripts/build-customer-pages.mjs", pages }, null, 2) + "\n";
let current = null;
try { current = readFileSync(OUT, "utf8"); } catch { /* first run */ }

if (CHECK) {
  if (current === next) { console.log(`customerPages.json is current (${pages.length} pages).`); process.exit(0); }
  console.log("customerPages.json is STALE. Run: node scripts/build-customer-pages.mjs");
  process.exit(1);
}
writeFileSync(OUT, next);
console.log(`wrote ${OUT} — ${pages.length} customer pages.`);
