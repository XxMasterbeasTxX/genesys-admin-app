"use strict";
/**
 * SDK child worker — EXPORT one flow from an org to a YAML file.
 * Spawned by processor.js as its own process (a Scripting session = one org).
 *
 * Args: --clientId --clientSecret --location --flowName --flowType --outDir
 * On success prints "EXPORTED <fullPath>" and exits 0.
 */
const fs = require("fs");
const arch = require("purecloud-flow-scripting-api-sdk-javascript");

const archSession = arch.environment.archSession;
const archEnums = arch.enums.archEnums;
const archFactoryFlows = arch.factories.archFactoryFlows;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
for (const k of ["clientId", "clientSecret", "location", "flowName", "flowType", "outDir"]) {
  if (!args[k]) { console.error(`Missing --${k}`); process.exit(2); }
}
fs.mkdirSync(args.outDir, { recursive: true });

const location = archEnums.LOCATIONS[args.location];
if (!location) { console.error(`Unknown location '${args.location}'`); process.exit(2); }

let exitCode = 1;

function doWork() {
  return archFactoryFlows
    .loadFlowByFlowNameAsync(args.flowName, args.flowType)
    .then((flow) => {
      if (!flow) throw new Error(`Flow not found: '${args.flowName}' (${args.flowType})`);
      return flow.exportToDirAsync(args.outDir, undefined, archEnums.FLOW_FORMAT_TYPES.yaml);
    })
    .then((fullPath) => { console.log("EXPORTED " + fullPath); exitCode = 0; })
    .catch((err) => { console.error("Export failed: " + (err && err.message ? err.message : err)); exitCode = 1; });
}

function onEnd() { process.exitCode = exitCode; }

archSession.startWithClientIdAndSecret(location, doWork, args.clientId, args.clientSecret, onEnd, true);
