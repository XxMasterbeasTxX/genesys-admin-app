"use strict";
/**
 * SDK child worker — IMPORT a (transformed) flow YAML into an org and PUBLISH it.
 * Spawned by processor.js as its own process (a Scripting session = one org).
 *
 * Args: --clientId --clientSecret --location --file
 * On success prints "PUBLISHED <name>" and exits 0.
 *
 * Import model: create an empty flow of the matching type, import the content
 * into it, validate, publish. The YAML must already be transformed (prefix
 * stripped, division set).
 */
const fs = require("fs");
const path = require("path");
const arch = require("purecloud-flow-scripting-api-sdk-javascript");
const { parseFlowMeta } = require("./onboardingEngine");

const archSession = arch.environment.archSession;
const archEnums = arch.enums.archEnums;
const archFactoryFlows = arch.factories.archFactoryFlows;
const archLanguages = arch.languages.archLanguages;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
for (const k of ["clientId", "clientSecret", "location", "file"]) {
  if (!args[k]) { console.error(`Missing --${k}`); process.exit(2); }
}
const yamlFile = path.resolve(args.file);
if (!fs.existsSync(yamlFile)) { console.error("File not found: " + yamlFile); process.exit(2); }

const yamlText = fs.readFileSync(yamlFile, "utf8");
const meta = parseFlowMeta(yamlText);
if (!meta.flowType || !meta.name) { console.error("Could not read flow type/name from YAML."); process.exit(2); }

const createMethod =
  "createFlow" + meta.flowType.charAt(0).toUpperCase() + meta.flowType.slice(1) + "Async";
if (typeof archFactoryFlows[createMethod] !== "function") {
  console.error(`No factory method '${createMethod}' for flow type '${meta.flowType}'.`);
  process.exit(2);
}

const langTagMatch = yamlText.match(/^\s*defaultLanguage:\s*(\S+)\s*$/m);
const language =
  (langTagMatch && archLanguages.getByLanguageTag(langTagMatch[1])) ||
  archLanguages.englishUnitedStates;

const location = archEnums.LOCATIONS[args.location];
if (!location) { console.error(`Unknown location '${args.location}'`); process.exit(2); }

let exitCode = 1;

function doWork() {
  return archFactoryFlows[createMethod](meta.name, "", language, (flow) =>
    flow
      .importFromFileAsync(yamlFile)
      .then(() => flow.validateAsync())
      .then((results) => {
        if (results.hasErrors) {
          const issues = (results.validationIssues || [])
            .map((i) => i.description || String(i))
            .slice(0, 10)
            .join("; ");
          throw new Error("Validation errors: " + issues);
        }
        return flow.publishAsync().then(() => { console.log("PUBLISHED " + flow.name); exitCode = 0; });
      })
  ).catch((err) => { console.error("Publish failed: " + (err && err.message ? err.message : err)); exitCode = 1; });
}

function onEnd() { process.exitCode = exitCode; }

archSession.startWithClientIdAndSecret(location, doWork, args.clientId, args.clientSecret, onEnd, true);
