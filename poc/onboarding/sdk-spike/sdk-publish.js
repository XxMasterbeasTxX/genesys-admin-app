"use strict";
/**
 * Onboarding POC (SDK engine) — import a (transformed) flow YAML into an org and
 * publish it, using the Genesys Flow Scripting SDK. No Archy, no CLI.
 *
 * Import model (per SDK docs): importFromContentAsync/importFromFileAsync are
 * INSTANCE methods on a flow — create an empty flow of the matching type, import
 * the exported content into it, then publish.
 *
 * Runs as its own process (a session = one org). Expects the YAML to already
 * have the "Template - " prefix stripped and the division set (../transform.js).
 *
 * Usage:
 *   node sdk-publish.js --options options.customer.json --file work/publish/flow.yaml
 *
 * options JSON: { "clientId": "...", "clientSecret": "...", "location": "prod_eu_west_1" }
 *
 * NOTE: encodes the confirmed SDK API shape; since it can't run here without live
 * org credentials, expect to fine-tune small runtime details (language/division)
 * on the first real run.
 */
const fs = require("fs");
const path = require("path");
const arch = require("purecloud-flow-scripting-api-sdk-javascript");
const { parseFlowMeta } = require("../deps.js");

const archSession = arch.environment.archSession;
const archEnums = arch.enums.archEnums;
const archFactoryFlows = arch.factories.archFactoryFlows;
const archLanguages = arch.languages.archLanguages;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) a[k.slice(2)] = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.options || !args.file) {
  console.error("Usage: node sdk-publish.js --options <opts.json> --file <flow.yaml>");
  process.exit(2);
}

const opts = JSON.parse(fs.readFileSync(args.options, "utf8"));
const yamlFile = path.resolve(args.file);
if (!fs.existsSync(yamlFile)) {
  console.error("File not found: " + yamlFile);
  process.exit(2);
}

const yamlText = fs.readFileSync(yamlFile, "utf8");
const meta = parseFlowMeta(yamlText); // { flowType: <root key e.g. inboundCall>, name }
if (!meta.flowType || !meta.name) {
  console.error("Could not determine flow type/name from YAML root.");
  process.exit(2);
}

// Root key (camelCase, e.g. "inboundCall") → factory "createFlowInboundCallAsync".
const createMethod =
  "createFlow" + meta.flowType.charAt(0).toUpperCase() + meta.flowType.slice(1) + "Async";
if (typeof archFactoryFlows[createMethod] !== "function") {
  console.error(`No factory method '${createMethod}' for flow type '${meta.flowType}'.`);
  process.exit(2);
}

// Default language from the YAML (e.g. "da-dk"), fallback to English US.
const langTagMatch = yamlText.match(/^\s*defaultLanguage:\s*(\S+)\s*$/m);
const language =
  (langTagMatch && archLanguages.getByLanguageTag(langTagMatch[1])) ||
  archLanguages.englishUnitedStates;

const location = archEnums.LOCATIONS[opts.location];
if (!location) {
  console.error(`Unknown location '${opts.location}'. Valid: ${archEnums.LOCATIONS_ALL.join(", ")}`);
  process.exit(2);
}

let exitCode = 1;

function doWork() {
  // 1) Create an empty flow container of the matching type.
  return archFactoryFlows[createMethod](meta.name, "", language, (flow) => {
    // 2) Import the exported (transformed) content into that flow.
    return flow
      .importFromFileAsync(yamlFile)
      .then(() => flow.validateAsync())
      .then((results) => {
        if (results.hasErrors) {
          const issues = (results.validationIssues || [])
            .map((i) => i.description || String(i))
            .slice(0, 10)
            .join("; ");
          throw new Error("Validation errors, not publishing: " + issues);
        }
        // 3) Publish (creates/overwrites the flow by name in the target org).
        return flow.publishAsync().then(() => {
          console.log("PUBLISHED " + flow.name);
          exitCode = 0;
        });
      });
  }).catch((err) => {
    console.error("Publish failed: " + (err && err.message ? err.message : err));
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
  true
);
