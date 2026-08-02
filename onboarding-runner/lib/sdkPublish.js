"use strict";
/**
 * SDK child worker — IMPORT a (transformed) flow file into an org and PUBLISH it.
 * Spawned by processor.js as its own process (a Scripting session = one org).
 *
 * Args: --clientId --clientSecret --location --file --flowType --flowName [--languageTag]
 * Works with either format: YAML or architect (.i3InboundFlow). The file must
 * already be transformed (prefix stripped). On success prints "PUBLISHED <name>".
 *
 * Import model: create an empty flow of the given type, import the content into
 * it, validate, publish.
 */
const fs = require("fs");
const path = require("path");
const arch = require("purecloud-flow-scripting-api-sdk-javascript");

const archSession = arch.environment.archSession;
const archEnums = arch.enums.archEnums;
const archFactoryFlows = arch.factories.archFactoryFlows;
const archLanguages = arch.languages.archLanguages;

// Verbose SDK logging → richer diagnostics captured by the runner (helps pin down
// errors like "functionality not available", which is often a missing Architect
// permission on the client-credentials OAuth client).
try { arch.services.archLogging.logNotesVerbose = true; } catch (_) { /* ignore */ }

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
for (const k of ["clientId", "clientSecret", "location", "file", "flowType", "flowName"]) {
  if (!args[k]) { console.error(`Missing --${k}`); process.exit(2); }
}
const flowFile = path.resolve(args.file);
if (!fs.existsSync(flowFile)) { console.error("File not found: " + flowFile); process.exit(2); }

// Find the factory create method case-insensitively — the SDK's method casing
// (e.g. createFlowInQueueCallAsync) doesn't always match the flow-type casing.
const wantMethod = ("createflow" + args.flowType + "async").toLowerCase();
const createMethod = Object.getOwnPropertyNames(Object.getPrototypeOf(archFactoryFlows))
  .concat(Object.getOwnPropertyNames(archFactoryFlows))
  .find((n) => n.toLowerCase() === wantMethod);
if (!createMethod || typeof archFactoryFlows[createMethod] !== "function") {
  console.error(`No factory method for flow type '${args.flowType}'.`);
  process.exit(2);
}

const language =
  (args.languageTag && archLanguages.getByLanguageTag(args.languageTag)) ||
  archLanguages.englishUnitedStates;

const location = archEnums.LOCATIONS[args.location];
if (!location) { console.error(`Unknown location '${args.location}'`); process.exit(2); }

let exitCode = 1;

function doWork() {
  return archFactoryFlows[createMethod](args.flowName, "", language, (flow) =>
    flow
      .importFromFileAsync(flowFile)
      .then(() => flow.validateAsync())
      .then((results) => {
        if (results.hasErrors) {
          let arr = results.validationIssues || results.issues || results.errors || results.validationErrors;
          if (typeof arr === "function") { try { arr = arr.call(results); } catch (_) { arr = null; } }
          const list = Array.isArray(arr) ? arr : [];
          const structured = [];
          const msgs = [];
          for (const i of list) {
            if (!i) continue;
            const errs = Array.isArray(i.errors) ? i.errors : [];
            if (!errs.length) continue; // skip warning-only issues — only real errors block publish
            const objName = (i.archObject && (i.archObject.name || i.archObject.displayTypeName)) || "";
            structured.push({ obj: objName, errors: errs, logStr: typeof i.logStr === "string" ? i.logStr : undefined });
            errs.forEach((e) => msgs.push((objName ? objName + ": " : "") + e));
          }
          // Dump structured issues so they reach the runner logs / App Insights.
          try { console.error("VALIDATION_ISSUES " + JSON.stringify(structured).slice(0, 6000)); } catch (_) { /* ignore */ }
          throw new Error("Validation errors: " + (msgs.slice(0, 15).join(" | ") || "(detail in runner logs)"));
        }
        return flow.publishAsync().then(() => { console.log("PUBLISHED " + flow.name); exitCode = 0; });
      })
  ).catch((err) => { console.error("Publish failed: " + (err && err.message ? err.message : err)); exitCode = 1; });
}

function onEnd() { process.exitCode = exitCode; }

archSession.startWithClientIdAndSecret(location, doWork, args.clientId, args.clientSecret, onEnd, true);
