"use strict";
/**
 * Onboarding POC (SDK engine) — export ONE flow from an org to a YAML file using
 * the Genesys Flow Scripting SDK. No Archy, no CLI — pure npm, in-process.
 *
 * A Scripting session authenticates to a single org, so export (demo) and publish
 * (customer) run as two separate processes. This also mirrors the production
 * background runner (spawn export → transform → spawn publish).
 *
 * Usage:
 *   node sdk-export.js --options options.demo.json \
 *        --flowName "Template - Inbound Voice" --flowType inboundcall \
 *        --outDir work/export
 *
 * options JSON: { "clientId": "...", "clientSecret": "...", "location": "prod_eu_west_1" }
 */
const fs = require("fs");
const arch = require("purecloud-flow-scripting-api-sdk-javascript");

const archSession = arch.environment.archSession;
const archEnums = arch.enums.archEnums;
const archFactoryFlows = arch.factories.archFactoryFlows;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) a[k.slice(2)] = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.options || !args.flowName || !args.flowType) {
  console.error('Usage: node sdk-export.js --options <opts.json> --flowName "<name>" --flowType <type> [--outDir work/export]');
  process.exit(2);
}

const opts = JSON.parse(fs.readFileSync(args.options, "utf8"));
const outDir = args.outDir || "work/export";
fs.mkdirSync(outDir, { recursive: true });

const location = archEnums.LOCATIONS[opts.location];
if (!location) {
  console.error(`Unknown location '${opts.location}'. Valid: ${archEnums.LOCATIONS_ALL.join(", ")}`);
  process.exit(2);
}

let exitCode = 1;

function doWork() {
  return archFactoryFlows
    .loadFlowByFlowNameAsync(args.flowName, args.flowType)
    .then((flow) =>
      flow.exportToDirAsync(outDir, undefined, archEnums.FLOW_FORMAT_TYPES.yaml)
    )
    .then((fullPath) => {
      console.log("EXPORTED " + fullPath);
      exitCode = 0;
    })
    .catch((err) => {
      console.error("Export failed: " + (err && err.message ? err.message : err));
      exitCode = 1;
    });
}

function onEnd() {
  process.exitCode = exitCode;
}

archSession.startWithClientIdAndSecret(
  location,
  doWork,
  opts.clientId,
  opts.clientSecret,
  onEnd,
  true // client-credentials OAuth client
);
