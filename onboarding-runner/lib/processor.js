"use strict";
/**
 * Onboarding pipeline — processes ONE job end-to-end.
 *
 * Phases (each recorded in the job's `phases[]` for the UI to poll):
 *   export   → SDK-export selected root flows from source + recurse into their
 *              flow dependencies (common modules, in-queue flows) until closure.
 *   dataTables  → REST create in target (renamed, chosen division) + copy rows.
 *   dataActions → REST create in target (renamed, integration matched by name).
 *   commonModules / inQueue / callflows → SDK create+import+publish (deps-first).
 *
 * Existing objects (matched by their stripped name) are skipped and noted, so a
 * failed job is safe to re-run.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { resolveOrg } = require("./regions");
const rest = require("./genesysRest");
const activityLog = require("./activityLogStore");
const exportCache = require("./exportCache");
const {
  transformFlowYaml, resolveDeps, parseFlowMeta, stripPrefix, transformI3, getDefaultLanguage,
} = require("./onboardingEngine");

const EXPORT_DIR = path.join(__dirname, "sdkExport.js");
const PUBLISH_DIR = path.join(__dirname, "sdkPublish.js");

// Matches a GUID anywhere in the (url-encoded) .i3 content — used to discover
// every referenced flow / script by id, regardless of the referencing action.
const GUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── child-process helpers ───────────────────────────────

function runChild(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err) }));
  });
}

async function sdkExport(sourceOrg, name, type, outDir, format) {
  const argv = [
    "--clientId", sourceOrg.clientId, "--clientSecret", sourceOrg.clientSecret,
    "--location", sourceOrg.location, "--flowName", name, "--flowType", type,
    "--outDir", outDir,
  ];
  if (format) argv.push("--format", format);
  const res = await runChild(EXPORT_DIR, argv);
  const m = res.stdout.match(/EXPORTED (.+)/);
  if (res.code !== 0 || !m) {
    throw new Error((res.stderr || res.stdout || "export failed").trim().split("\n").pop());
  }
  return m[1].trim();
}

async function sdkPublish(targetOrg, file, flowType, flowName, languageTag, surveyFormName) {
  const argv = [
    "--clientId", targetOrg.clientId, "--clientSecret", targetOrg.clientSecret,
    "--location", targetOrg.location, "--file", file,
    "--flowType", flowType, "--flowName", flowName,
  ];
  if (languageTag) argv.push("--languageTag", languageTag);
  if (surveyFormName) argv.push("--surveyFormName", surveyFormName);
  const res = await runChild(PUBLISH_DIR, argv);
  if (res.code !== 0) {
    // Surface the most informative tail of the child output (stderr holds the
    // error line; stdout may hold preceding verbose SDK context).
    const errLines = (res.stderr || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const primary = errLines.filter((l) => /fail|error|invalid|permission|not available/i.test(l));
    const detail = (primary.length ? primary : errLines).slice(-3).join(" | ");
    const err = new Error((detail || "publish failed").slice(0, 600));
    // Attach the full (verbose) child output so the caller can log it to App Insights.
    err.fullOutput = ((res.stdout || "") + "\n---STDERR---\n" + (res.stderr || "")).slice(-12000);
    throw err;
  }
  // Return the full child output so the caller can log it even on "success"
  // (e.g. to diagnose a flow that reports PUBLISHED but doesn't actually persist).
  const fullOutput = ((res.stdout || "") + "\n---STDERR---\n" + (res.stderr || "")).slice(-12000);
  // The child prints "FLOW_ID <guid> isPublished=<bool>" from the SDK after publish.
  const m = /FLOW_ID\s+([0-9a-fA-F-]{36})\s+isPublished=(\w+)/.exec(res.stdout || "");
  return { fullOutput, flowId: m ? m[1] : null, isPublished: m ? m[2] === "true" : null };
}

/**
 * Prepare a source survey form for creation in the target org: strip the
 * server-assigned form id/contextId and metadata (a new form gets fresh ones),
 * strip the "Template - " prefix from the name, and remove version-specific `id`
 * fields from nested question groups / questions / answer options while keeping
 * their stable `contextId` so the imported flow's references still resolve.
 */
function sanitizeSurveyForm(form, newName) {
  const clone = JSON.parse(JSON.stringify(form));
  for (const k of ["id", "contextId", "modifiedDate", "dateModified", "publishedVersions", "redacted", "selfUri", "division"]) {
    delete clone[k];
  }
  clone.name = newName;
  clone.published = false;
  const stripIds = (node) => {
    if (Array.isArray(node)) return node.forEach(stripIds);
    if (node && typeof node === "object") {
      delete node.id;
      for (const v of Object.values(node)) stripIds(v);
    }
  };
  if (Array.isArray(clone.questionGroups)) stripIds(clone.questionGroups);
  return clone;
}

// ── topological order (deps first); cycle-safe ──

function topoSort(nodes, edges) {
  const order = [];
  const seen = new Set();
  const temp = new Set();
  const visit = (n) => {
    if (seen.has(n) || temp.has(n)) return;
    if (!nodes.has(n)) return;
    temp.add(n);
    for (const d of edges.get(n) || []) visit(d);
    temp.delete(n);
    seen.add(n);
    order.push(n);
  };
  for (const n of nodes) visit(n);
  return order;
}

// ── activity log ────────────────────────────────────────

const LOG_ACTION = "deployment_onboarding";
// A preview that was never approved is its own kind of event: nothing was
// written, so it is not a failure — but it must never be mistaken for a deploy
// either. A distinct action keeps the two apart in the log.
const LOG_ACTION_PREVIEW = "deployment_onboarding_preview";
const RESULT_FOR_STATUS = { succeeded: "success", partial: "partial", failed: "failure", expired: "success" };

/** "3 callflow(s)" etc. — keeps the description readable for a single item. */
function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Write the job's outcome to the activity log: one entry per deploy, carrying
 * the full phase/item breakdown in `details` for the log page to expand.
 *
 * Best-effort — a logging failure must never change the job's outcome.
 */
async function logJobOutcome({ job, source, target, division, phases, warnings, status, error, log }) {
  try {
    const items = phases.flatMap((p) => p.items || []);
    const ok = items.filter((i) => i.status === "ok").length;
    const skipped = items.filter((i) => i.status === "skipped").length;
    const failed = items.filter((i) => i.status === "error");
    const planned = items.filter((i) => i.status === "planned").length;

    const srcName = source?.name || job.sourceOrgId;
    const tgtName = target?.name || job.targetOrgId;
    const expired = status === "expired";

    // Three shapes: an abandoned preview, an aborted run, and a completed one.
    const description = expired
      ? `[Onboarding] Previewed ${plural(job.flows?.length || 0, "callflow")} from ${srcName} ` +
        `into ${tgtName} · division '${division}' — NOT deployed ` +
        `(${planned} object(s) would have been created; approval expired after 30 minutes)`
      : error
      ? `[Onboarding] Deploy of ${plural(job.flows?.length || 0, "callflow")} from ${srcName} ` +
        `into ${tgtName} · division '${division}' aborted: ${error}`
      : `[Onboarding] Deployed ${plural(job.flows?.length || 0, "callflow")} (+ dependencies) ` +
        `from ${srcName} into ${tgtName} · division '${division}' — ` +
        `${ok} created, ${skipped} skipped, ${failed.length} failed`;

    // Surface the failures inline so the row is useful before it is expanded.
    const failedNames = failed.map((i) => i.new || i.old).filter(Boolean);
    const errorMessage = error
      || (failedNames.length
        ? "Failed: " + failedNames.slice(0, 3).join(", ")
          + (failedNames.length > 3 ? ` and ${failedNames.length - 3} more` : "")
        : null);

    await activityLog.create({
      userEmail: job.startedBy || "",
      userName: job.startedByName || "",
      userId: job.startedById || "",
      orgId: job.targetOrgId,        // the org that was written to
      orgName: tgtName,
      action: expired ? LOG_ACTION_PREVIEW : LOG_ACTION,
      description,
      result: RESULT_FOR_STATUS[status] || "failure",
      errorMessage,
      count: expired ? planned : ok,
      details: {
        summary: {
          jobId: job.jobId,
          status,
          sourceOrgId: job.sourceOrgId,
          sourceOrgName: srcName,
          targetOrgId: job.targetOrgId,
          targetOrgName: tgtName,
          division,
          namePrefix: job.namePrefix || "",
          rootFlows: (job.flows || []).map((f) => f.name),
          created: ok,
          skipped,
          failed: failed.length,
          ...(planned ? { plannedObjects: planned } : {}),
          startedAt: job.startedAt || null,
          finishedAt: new Date().toISOString(),
        },
        phases,
        warnings,
        error: error || null,
      },
    });
  } catch (err) {
    log.error
      ? log.error(`[onboarding-runner] activity log write failed (non-critical): ${err.message}`)
      : log(`activity log write failed: ${err.message}`);
  }
}

// ── name conflicts ──────────────────────────────────────

// Fields that always differ between two orgs (or between two copies of the same
// object) and say nothing about whether the content was edited.
const VOLATILE_KEYS = new Set([
  "id", "selfUri", "name", "division", "contextId", "version",
  "dateCreated", "dateModified", "createdBy", "modifiedBy", "self",
]);

/** Deep copy with volatile fields dropped and object keys sorted. */
function normalizeForCompare(value) {
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = normalizeForCompare(value[k]);
    }
    return out;
  }
  return value;
}

/** True when two objects match once volatile fields are ignored. */
function sameContent(a, b) {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

/**
 * Next free name for a "create new" choice.
 *
 * With no suffix supplied this numbers upward — "X (2)", "X (3)" — so a second
 * conflict never lands on an existing object. A custom suffix is used verbatim
 * and only numbered if that is taken too.
 */
function suffixedName(base, suffix, taken, identifier = false) {
  const sfx = String(suffix || "").trim();
  // Prompt names are identifiers — " (2)" would not be a legal name — so they
  // are numbered with an underscore and any custom suffix is joined without a
  // space. Everything else keeps the readable " (2)" form.
  const join = identifier ? "_" : " ";
  if (!sfx) {
    let n = 2;
    const numbered = (i) => (identifier ? `${base}_${i}` : `${base} (${i})`);
    let candidate = numbered(n);
    while (taken && taken.has(candidate)) candidate = numbered(++n);
    return candidate;
  }
  let candidate = `${base}${join}${sfx}`;
  let n = 1;
  while (taken && taken.has(candidate)) candidate = `${base}${join}${sfx}${join}${++n}`;
  return candidate;
}

// ── one pass over the pipeline ──────────────────────────

/**
 * Run the pipeline once.
 *
 * The SAME function performs both the preview and the real deploy — only the
 * create/publish calls are guarded. That is deliberate: a preview that walked a
 * separate code path could drift from what a deploy actually does, and then it
 * would be worse than no preview at all. Name resolution, existence checks and
 * integration matching are therefore identical in both modes.
 *
 * @param {object} job    the claimed job
 * @param {object} store  onboardingStore (for updateJob)
 * @param {object} log    context.log
 * @param {object} opts   { preview, decisions, cacheDir }
 *   preview   — record what WOULD happen; perform no writes
 *   decisions — operator's per-collision choices, keyed by collision id
 *   cacheDir  — where exported artifacts are read from / written to
 * @returns {Promise<{phases, warnings, collisions, error}>}
 */
async function runPass(job, store, log, opts) {
  const { preview = false, decisions = {}, cacheDir = null, priorRunNames = new Set() } = opts || {};

  const source = resolveOrg(job.sourceOrgId);
  const target = resolveOrg(job.targetOrgId);
  const division = job.divisionName || "Home";

  // Target object names = "<prefix> - <original>" when a prefix is supplied.
  // `original` is the source name with any "Template - " prefix stripped.
  const namePrefix = (job.namePrefix || "").trim();
  const finalName = (n) => (namePrefix ? `${namePrefix} - ${stripPrefix(n)}` : stripPrefix(n));

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `onboarding-${job.jobId}-`));
  const phases = [];
  const warnings = [];
  const collisions = [];

  const addPhase = (name) => { const p = { phase: name, items: [] }; phases.push(p); return p; };
  const persist = () => store.updateJob(job.jobId, { phases, warnings });

  /**
   * Export via the cache. On the approved second pass every flow is already
   * cached, so this returns immediately and no SDK session is opened at all.
   */
  const exportText = async (name, type, format) => {
    if (cacheDir) {
      const hit = exportCache.read(cacheDir, name, type, format);
      if (hit != null) return hit;
    }
    const text = fs.readFileSync(await sdkExport(source, name, type, workDir, format), "utf8");
    if (cacheDir) exportCache.write(cacheDir, name, type, format, text);
    return text;
  };

  /**
   * Record a name conflict and resolve what to do about it.
   *
   * The default is chosen by comparing the target object with the source:
   * identical means there is nothing to gain from a duplicate (and makes a
   * re-run of a failed job safe, since its own objects match by construction),
   * while a difference is the case worth defaulting away from — someone has
   * edited it, and binding new flows to it would not behave as deployed.
   *
   * `differs` is null when no meaningful comparison exists (see sameContent).
   *
   * `decisions` is keyed by collision id, plus one reserved key `__suffix`
   * holding the suffix the operator chose for "create new" (blank = number it).
   */
  const resolveCollision = ({ kind, key, sourceName, targetName, existing, differs, taken, priorRun = false }) => {
    const id = `${kind}::${key}`;
    const decided = decisions[id];
    const suggested = suffixedName(targetName, decisions.__suffix, taken, kind === "prompt");
    const action = decided?.action || (differs === true ? "new" : "existing");
    const newName = decided?.name || suggested;
    collisions.push({
      id, kind, sourceName, targetName,
      existingId: existing?.id || null,
      differs,                       // true | false | null (not comparable)
      priorRun,                      // an earlier deploy of this pair created it
      defaultAction: differs === true ? "new" : "existing",
      suggestedName: suggested,
      action, chosenName: action === "new" ? newName : targetName,
    });
    return { action, name: action === "new" ? newName : targetName };
  };

  /** Wording for a conflict resolved as "keep the existing object". */
  const reuseDetail = (differs, extra = "") => {
    const state = differs === true ? " · differs" : differs === false ? " · identical" : "";
    return `already exists in destination${state} · ${preview ? "would be reused" : "reused"}${extra}`;
  };
  /** Reused objects are a result when deploying, and a plan when previewing. */
  const reuseStatus = () => (preview ? "planned" : "skipped");

  /**
   * Close a phase that produced no items by recording why. Without this an empty
   * phase is ambiguous in the results list — "nothing was referenced" looks the
   * same as "this never ran" — and phases skipped entirely used to vanish from
   * the stepper altogether.
   *
   * The `none` status is informational: it is deliberately neither ok, skipped
   * nor error, so it stays out of the created/skipped/failed tallies.
   */
  const closePhase = async (phase, what) => {
    if (phase.items.length) return;
    phase.items.push({ new: `No ${what} found`, status: "none" });
    await persist();
  };

  try {
    // ── Source indexes (id → name/type) for GUID-based reference discovery ──
    const [srcFlowsAll, srcScriptsAll, srcSurveyFormsAll, srcPromptsAll] = await Promise.all([
      rest.listFlows(source), rest.listScripts(source), rest.listSurveyForms(source),
      rest.listPrompts(source),
    ]);
    // Prompts are found two ways — by name from the YAML (`prompt: Prompt.X`)
    // and by id from the .i3 GUID scan — because it is not certain which form
    // Architect serialises into the .i3. Indexing both makes it work either way.
    const srcPromptById = new Map(srcPromptsAll.map((p) => [String(p.id).toLowerCase(), p]));
    const srcPromptByName = new Map(srcPromptsAll.map((p) => [p.name, p]));
    const srcFlowById = new Map(
      srcFlowsAll.map((fl) => [String(fl.id).toLowerCase(), { name: fl.name, type: String(fl.type || "").toLowerCase() }])
    );
    const srcScriptById = new Map(
      srcScriptsAll.map((s) => [String(s.id).toLowerCase(), s.name])
    );
    // Survey forms may be referenced (by voice-survey flows) via either their
    // version id or their stable contextId — index by both so the .i3 GUID scan
    // matches whichever the flow stores.
    const srcSurveyFormByGuid = new Map();
    for (const sf of srcSurveyFormsAll) {
      const rec = { id: sf.id, contextId: sf.contextId, name: sf.name };
      if (sf.id) srcSurveyFormByGuid.set(String(sf.id).toLowerCase(), rec);
      if (sf.contextId) srcSurveyFormByGuid.set(String(sf.contextId).toLowerCase(), rec);
    }

    // ── Phase: export + discover (recursive closure) ──────────────────
    const exportPhase = addPhase("Export & discover");
    const exported = new Map();      // "type::name" → { name, type, yaml, i3raw, flowDepKeys }
    const tableNames = new Set();    // source table names (prefixed)
    const actionRefs = new Map();    // key → { integration, action }
    const scriptRefs = new Map();    // source script id → source script name
    const surveyFormRefs = new Map();// source form id/contextId key → { id, contextId, name }
    const promptRefs = new Map();    // source prompt id → source prompt record

    const queue = job.flows.map((f) => ({ name: f.name, type: f.type }));
    while (queue.length) {
      const f = queue.shift();
      try {
        // Resolve the flow type from the source index if the caller didn't give one.
        let type = f.type ? String(f.type).toLowerCase() : null;
        if (!type) {
          for (const info of srcFlowById.values()) { if (info.name === f.name) { type = info.type; break; } }
          if (!type) {
            exportPhase.items.push({ old: f.name, new: finalName(f.name), status: "error", detail: "referenced flow not found in source" });
            await persist();
            continue;
          }
        }
        // Key by type + name: the SAME name can exist as different flow types
        // (e.g. an inbound flow and an in-queue flow both named "X").
        const key = `${type}::${f.name}`;
        if (exported.has(key)) continue;

        // YAML export → data table / data action refs + default language.
        const yaml = await exportText(f.name, type, null);
        const deps = resolveDeps(yaml);
        deps.dataTables.forEach((t) => tableNames.add(t));
        deps.dataActions.forEach((a) => actionRefs.set(`${a.integration}::${a.action}`, a));
        // Directly referenced user prompts, by name. A name the source org does
        // not have is reported rather than silently dropped — it would otherwise
        // become a flow that fails to publish in the destination.
        for (const promptName of deps.prompts) {
          const p = srcPromptByName.get(promptName);
          if (p) promptRefs.set(String(p.id).toLowerCase(), p);
          else warnings.push(`Flow '${f.name}' references prompt '${promptName}', which does not exist in ${source.name}`);
        }

        // Architect (.i3) export → scan for EVERY referenced flow & script GUID.
        // .i3 is base64(url-encoded(JSON)); GUIDs appear verbatim, so any source
        // flow/script whose id appears is a dependency — regardless of the action
        // that references it (transfer targets, post-flow refs, screen-pop scripts,
        // common modules, in-queue flows, …). This is the general reference map.
        const i3raw = await exportText(f.name, type, "architect");
        const i3text = Buffer.from(i3raw.trim(), "base64").toString("utf8");
        const guidSet = new Set((i3text.match(GUID_RE) || []).map((g) => g.toLowerCase()));
        const self = [...srcFlowById].find(([, info]) => info.name === f.name && info.type === type);
        const selfGuid = self ? self[0] : null;

        const flowDepKeys = new Set();
        for (const [id, info] of srcFlowById) {
          if (id === selfGuid) continue;
          if (guidSet.has(id)) {
            flowDepKeys.add(`${info.type}::${info.name}`);
            queue.push({ name: info.name, type: info.type });
          }
        }
        for (const [id, sname] of srcScriptById) {
          if (guidSet.has(id)) scriptRefs.set(id, sname);
        }
        for (const [id, prompt] of srcPromptById) {
          if (guidSet.has(id)) promptRefs.set(id, prompt);
        }
        // Voice-survey flows reference a survey form (by version id or contextId).
        // Record the form so it can be deployed + remapped, and remember it on the
        // flow record so we can pass the form NAME to the SDK create call.
        let surveyForm = null;
        for (const [guid, sf] of srcSurveyFormByGuid) {
          if (guidSet.has(guid)) { surveyFormRefs.set(guid, sf); surveyForm = sf; }
        }

        exported.set(key, { name: f.name, type, yaml, i3raw, flowDepKeys, surveyForm });
        exportPhase.items.push({ old: f.name, new: finalName(f.name), status: "ok", detail: type });
      } catch (err) {
        exportPhase.items.push({ old: f.name, new: finalName(f.name), status: "error", detail: err.message });
      }
      await persist();
    }

    log(`[onboarding] discovered flows: ${[...exported.keys()].join(", ") || "(none)"}`);
    log(`[onboarding] discovered script refs: ${scriptRefs.size ? [...scriptRefs.entries()].map(([id, n]) => `${n}=${id}`).join(", ") : "(none)"}`);
    log(`[onboarding] discovered survey forms: ${surveyFormRefs.size ? [...new Set([...surveyFormRefs.values()].map((s) => s.name))].join(", ") : "(none)"}`);

    // ── Phase: data tables (REST) ─────────────────────────────────────
    const guidMap = new Map(); // demo dependency GUID → customer GUID (for .i3 remap)
    // Ids of objects the runner CREATES this run — moved into the chosen division
    // at the end of their phase (the SDK/script-import APIs default to Home).
    const createdFlowIds = [];
    const createdScriptIds = [];
    const tablePhase = addPhase("Data tables");
    const [srcTables, tgtTables, tgtDivisions] = await Promise.all([
      rest.listDataTables(source), rest.listDataTables(target), rest.listDivisions(target),
    ]);
    const divisionId = (tgtDivisions.find((d) => d.name === division) || {}).id || job.divisionId;
    const srcTableByName = new Map(srcTables.map((t) => [t.name, t]));
    const tgtTableByName = new Map(tgtTables.map((t) => [t.name, t]));
    const tgtTableNames = new Set(tgtTables.map((t) => t.name));

    for (const srcName of [...tableNames].sort()) {
      let newName = finalName(srcName);
      try {
        const srcMeta = srcTableByName.get(srcName);
        if (!srcMeta) throw new Error("not found in source");
        const full = await rest.getDataTable(source, srcMeta.id);

        if (tgtTableNames.has(newName)) {
          const existing = tgtTableByName.get(newName);
          // Compare schemas so the default choice reflects whether the target
          // copy has been edited since it was deployed.
          let differs = null;
          try {
            const tgtFull = await rest.getDataTable(target, existing.id);
            differs = !sameContent(full.schema, tgtFull.schema);
          } catch (_) { differs = null; }

          const choice = resolveCollision({
            kind: "dataTable", key: srcName, sourceName: srcName, targetName: newName,
            existing, differs, taken: tgtTableNames,
          });
          if (choice.action === "existing") {
            if (existing) guidMap.set(srcMeta.id, existing.id);
            tablePhase.items.push({ old: srcName, new: newName, status: reuseStatus(), detail: reuseDetail(differs) });
            await persist();
            continue;
          }
          newName = choice.name;           // create alongside it under a new name
          tgtTableNames.add(newName);
        }

        if (preview) {
          tablePhase.items.push({ old: srcName, new: newName, status: "planned", detail: "would be created" });
          await persist();
          continue;
        }

        const created = await rest.createDataTable(target, {
          name: newName,
          description: full.description || undefined,
          division: { id: divisionId },
          schema: full.schema,
        });
        guidMap.set(srcMeta.id, created.id);
        // Copy rows
        let rowCount = 0;
        const rows = await rest.fetchDataTableRows(source, srcMeta.id);
        for (const row of rows) {
          const clean = { ...row };
          delete clean.selfUri;
          try { await rest.createDataTableRow(target, created.id, clean); rowCount++; } catch (_) { /* per-row */ }
        }
        tablePhase.items.push({ old: srcName, new: newName, status: "ok", detail: `${rowCount} row(s)` });
      } catch (err) {
        tablePhase.items.push({ old: srcName, new: newName, status: "error", detail: err.message });
      }
      await persist();
    }
    await closePhase(tablePhase, "data tables");

    // ── Phase: data actions (REST) ────────────────────────────────────
    const actionPhase = addPhase("Data actions");
    const [srcActions, tgtActions, srcIntegs, tgtIntegs] = await Promise.all([
      rest.listDataActions(source), rest.listDataActions(target),
      rest.listIntegrations(source), rest.listIntegrations(target),
    ]);
    const srcActionByName = new Map(srcActions.map((a) => [a.name, a]));
    const tgtActionByName = new Map(tgtActions.map((a) => [a.name, a]));
    const tgtActionNames = new Set(tgtActions.map((a) => a.name));
    const srcIntegById = new Map(srcIntegs.map((i) => [i.id, i]));
    const tgtIntegByName = new Map(tgtIntegs.map((i) => [i.name, i]));
    const tgtIntegByType = new Map();
    for (const i of tgtIntegs) {
      const t = i.integrationType && i.integrationType.id;
      if (t && !tgtIntegByType.has(t)) tgtIntegByType.set(t, i);
    }

    for (const { action: srcName } of [...actionRefs.values()]) {
      let newName = finalName(srcName);
      try {
        const srcSummary = srcActionByName.get(srcName);
        if (!srcSummary) throw new Error("not found in source");
        const full = await rest.getDataAction(source, srcSummary.id);

        if (tgtActionNames.has(newName)) {
          const existing = tgtActionByName.get(newName);
          // The contract and config are what a flow actually depends on, so
          // compare those rather than the whole action envelope.
          let differs = null;
          try {
            const tgtFull = await rest.getDataAction(target, existing.id);
            differs = !sameContent(
              { contract: full.contract, config: full.config },
              { contract: tgtFull.contract, config: tgtFull.config }
            );
          } catch (_) { differs = null; }

          const choice = resolveCollision({
            kind: "dataAction", key: srcName, sourceName: srcName, targetName: newName,
            existing, differs, taken: tgtActionNames,
          });
          if (choice.action === "existing") {
            if (existing) guidMap.set(srcSummary.id, existing.id);
            actionPhase.items.push({ old: srcName, new: newName, status: reuseStatus(), detail: reuseDetail(differs) });
            await persist();
            continue;
          }
          newName = choice.name;
          tgtActionNames.add(newName);
        }
        // Match target integration by connector TYPE first (robust to renames),
        // then by display name.
        const srcInteg = srcIntegById.get(full.integrationId);
        const srcType = srcInteg && srcInteg.integrationType && srcInteg.integrationType.id;
        const tgtInteg =
          (srcType && tgtIntegByType.get(srcType)) ||
          (srcInteg && tgtIntegByName.get(srcInteg.name)) ||
          null;
        if (!tgtInteg) {
          throw new Error(
            `target org has no '${srcInteg ? srcInteg.name : "?"}' integration ` +
            `(type ${srcType || "?"}) — install/activate it in the target first`
          );
        }
        if (preview) {
          actionPhase.items.push({
            old: srcName, new: newName, status: "planned",
            detail: `would be created · ${tgtInteg.name}`,
          });
          await persist();
          continue;
        }
        const createdAction = await rest.createDataAction(target, {
          name: newName,
          category: full.category,
          integrationId: tgtInteg.id,
          contract: full.contract,
          config: full.config,
          secure: full.secure,
        });
        if (createdAction && createdAction.id) guidMap.set(srcSummary.id, createdAction.id);
        actionPhase.items.push({ old: srcName, new: newName, status: "ok", detail: tgtInteg.name });
      } catch (err) {
        actionPhase.items.push({ old: srcName, new: newName, status: "error", detail: err.message });
      }
      await persist();
    }
    await closePhase(actionPhase, "data actions");

    // ── Phase: scripts (screen-pop references) ───────────────────────
    //    Any script referenced by a flow (e.g. a screen pop) is exported from the
    //    source and imported into the target, then its GUID is remapped in the .i3.
    //    The phase is recorded even when nothing references a script, so the
    //    results list and stepper show it rather than silently omitting it.
    const scriptPhase = addPhase("Scripts");
    if (scriptRefs.size) {
      const tgtScriptByName = new Map((await rest.listScripts(target)).map((s) => [s.name, s]));
      const tgtScriptNames = new Set(tgtScriptByName.keys());
      for (const [srcId, srcName] of scriptRefs) {
        let newName = finalName(srcName);
        try {
          const existing = tgtScriptByName.get(newName);
          if (existing) {
            // A script's exported payload carries ids and timestamps that always
            // differ between orgs, so there is no comparison here that would mean
            // anything — `differs: null` says "not checked" rather than guessing.
            const choice = resolveCollision({
              kind: "script", key: srcName, sourceName: srcName, targetName: newName,
              existing, differs: null, taken: tgtScriptNames,
            });
            if (choice.action === "existing") {
              if (!preview) {
                // The script exists but earlier runs imported it as an unpublished
                // draft — the flow validator only sees PUBLISHED scripts, so publish
                // it now (idempotent) before recording the GUID remap.
                try { await rest.publishScript(target, existing.id); } catch (e) { log(`[onboarding] publish existing script '${newName}' failed: ${e.message}`); }
                guidMap.set(srcId, existing.id);
              }
              scriptPhase.items.push({ old: srcName, new: newName, status: reuseStatus(), detail: reuseDetail(null, " · published") });
              await persist();
              continue;
            }
            newName = choice.name;
            tgtScriptNames.add(newName);
          }
          if (preview) {
            scriptPhase.items.push({ old: srcName, new: newName, status: "planned", detail: "would be imported · published" });
            await persist();
            continue;
          }
          // Export the source script to a file, then import it into the target.
          const url = await rest.getScriptExportUrl(source, srcId);
          if (!url) throw new Error("source export URL not returned");
          const fileText = await rest.downloadText(url);
          const uploadId = await rest.importScript(target, newName, fileText);
          // Poll the upload until it finishes.
          let done = false, lastMsg = "";
          for (let n = 0; n < 40 && !done; n++) {
            await sleep(1500);
            let st = null;
            try { st = await rest.getScriptUploadStatus(target, uploadId); } catch (_) { /* transient */ }
            const s = st && String(st.status || "").toLowerCase();
            lastMsg = (st && (st.message || st.status)) || lastMsg;
            if (st && (st.succeeded === true || s === "success" || s === "succeeded" || s === "done")) done = true;
            else if (st && (st.failed === true || s === "failure" || s === "failed" || s === "error")) throw new Error("import failed: " + lastMsg);
          }
          if (!done) throw new Error("import did not complete in time" + (lastMsg ? ": " + lastMsg : ""));
          // Resolve the new script id by name, publish it, and record the remap.
          const created = (await rest.listScripts(target)).find((s) => s.name === newName);
          if (created) {
            try { await rest.publishScript(target, created.id); } catch (e) { log(`[onboarding] publish new script '${newName}' failed: ${e.message}`); }
            guidMap.set(srcId, created.id);
            createdScriptIds.push(created.id);
          }
          scriptPhase.items.push({ old: srcName, new: newName, status: created ? "ok" : "error", detail: created ? "imported · published" : "imported but not found by name" });
        } catch (err) {
          scriptPhase.items.push({ old: srcName, new: newName, status: "error", detail: err.message });
        }
        await persist();
      }
      // Place newly-created scripts in the chosen division (default Home otherwise).
      // !preview is redundant today (nothing is created in a preview, so the id
      // list is empty) but states the invariant rather than relying on it.
      if (!preview && divisionId && createdScriptIds.length) {
        try {
          await rest.moveObjectsToDivision(target, divisionId, "SCRIPT", createdScriptIds);
          scriptPhase.items.push({ old: "(division)", new: division, status: "ok", detail: `${createdScriptIds.length} script(s) → ${division}` });
        } catch (err) {
          scriptPhase.items.push({ old: "(division)", new: division, status: "error", detail: `division move failed: ${err.message}` });
          warnings.push(`Could not move scripts into division '${division}': ${err.message}`);
        }
        await persist();
      }
    }
    await closePhase(scriptPhase, "scripts");

    // ── Phase: survey forms (voice-survey flow dependency) ───────────
    //    A voice-survey flow can only be CREATED against an existing survey form,
    //    and its imported .i3 references the form by GUID. So deploy + publish the
    //    form first, remap its id/contextId (demo → customer) in guidMap, and
    //    remember the target form NAME to pass to the SDK create call.
    const surveyPhase = addPhase("Survey forms");
    if (surveyFormRefs.size) {
      const uniqueForms = new Map(); // source form id → { id, contextId, name }
      for (const sf of surveyFormRefs.values()) uniqueForms.set(sf.id, sf);
      const tgtFormByName = new Map((await rest.listSurveyForms(target)).map((f) => [f.name, f]));
      const tgtFormNames = new Set(tgtFormByName.keys());
      for (const sf of uniqueForms.values()) {
        let newName = finalName(sf.name);
        try {
          const full = await rest.getSurveyForm(source, sf.id);
          let tgt = tgtFormByName.get(newName);

          if (tgt) {
            // The question structure is what the flow depends on; ids and version
            // metadata differ between orgs by definition.
            let differs = null;
            try {
              const tgtFull = await rest.getSurveyForm(target, tgt.id);
              differs = !sameContent(full.questionGroups, tgtFull.questionGroups);
            } catch (_) { differs = null; }

            const choice = resolveCollision({
              kind: "surveyForm", key: sf.name, sourceName: sf.name, targetName: newName,
              existing: tgt, differs, taken: tgtFormNames,
            });
            if (choice.action === "existing") {
              if (!preview) {
                // Ensure the existing form is published so flows can reference it.
                try { await rest.publishSurveyForm(target, tgt.id); } catch (_) { /* already published */ }
                if (sf.id && tgt.id) guidMap.set(String(sf.id).toLowerCase(), tgt.id);
                if (sf.contextId && tgt.contextId) guidMap.set(String(sf.contextId).toLowerCase(), tgt.contextId);
              }
              surveyPhase.items.push({ old: sf.name, new: newName, status: reuseStatus(), detail: reuseDetail(differs, " · published") });
              await persist();
              continue;
            }
            newName = choice.name;
            tgtFormNames.add(newName);
            tgt = null;                    // create a separate form under the new name
          }

          if (preview) {
            surveyPhase.items.push({ old: sf.name, new: newName, status: "planned", detail: "would be created · published" });
            await persist();
            continue;
          }

          // Strip server-assigned ids from the source form, then create + publish.
          const body = sanitizeSurveyForm(full, newName);
          const created = await rest.createSurveyForm(target, body);
          const published = await rest.publishSurveyForm(target, created.id);
          tgt = published && published.id ? published : created;
          // Remap both the source version id and contextId → target values so the
          // imported .i3 (whichever it stores) points at the deployed form.
          if (sf.id && tgt.id) guidMap.set(String(sf.id).toLowerCase(), tgt.id);
          if (sf.contextId && tgt.contextId) guidMap.set(String(sf.contextId).toLowerCase(), tgt.contextId);
          surveyPhase.items.push({ old: sf.name, new: newName, status: "ok", detail: "created · published" });
        } catch (err) {
          surveyPhase.items.push({ old: sf.name, new: newName, status: "error", detail: err.message });
        }
        await persist();
      }
    }
    await closePhase(surveyPhase, "survey forms");

    // ── Phase: user prompts (referenced directly by a flow action) ───
    //    Everything but the recorded audio is copied: the prompt itself and
    //    each language resource's TTS text and tags. Customers record their own
    //    audio, so copying media between orgs is deliberately not attempted.
    const promptPhase = addPhase("Prompts");
    if (promptRefs.size) {
      const tgtPrompts = await rest.listPrompts(target);
      const tgtPromptByName = new Map(tgtPrompts.map((p) => [p.name, p]));
      const tgtPromptNames = new Set(tgtPromptByName.keys());

      for (const srcPrompt of promptRefs.values()) {
        // Prompt names are identifiers, so the "Template - " strip and the name
        // prefix are both skipped — the name is carried across verbatim.
        let newName = srcPrompt.name;
        try {
          const existing = tgtPromptByName.get(newName);
          if (existing) {
            // No comparison: a prompt of this name in the destination is the
            // customer's own recording, and duplicating it would be worse than
            // reusing it. `differs: null` defaults the choice to "use existing".
            const choice = resolveCollision({
              kind: "prompt", key: srcPrompt.name, sourceName: srcPrompt.name, targetName: newName,
              existing, differs: null, taken: tgtPromptNames,
            });
            if (choice.action === "existing") {
              if (!preview) guidMap.set(String(srcPrompt.id).toLowerCase(), existing.id);
              promptPhase.items.push({ old: srcPrompt.name, new: newName, status: reuseStatus(), detail: reuseDetail(null) });
              await persist();
              continue;
            }
            newName = choice.name;
            tgtPromptNames.add(newName);
          }

          const resources = await rest.listPromptResources(source, srcPrompt.id);
          const langs = resources.map((r) => r.language).filter(Boolean);

          if (preview) {
            promptPhase.items.push({
              old: srcPrompt.name, new: newName, status: "planned",
              detail: `would be created · ${langs.length} language(s)${langs.length ? ` (${langs.join(", ")})` : ""} · no audio`,
            });
            await persist();
            continue;
          }

          const created = await rest.createPrompt(target, {
            name: newName,
            description: srcPrompt.description || undefined,
          });
          guidMap.set(String(srcPrompt.id).toLowerCase(), created.id);

          // One resource per language, carrying everything except the media.
          let copied = 0;
          const failed = [];
          for (const r of resources) {
            if (!r.language) continue;
            try {
              await rest.createPromptResource(target, created.id, {
                language: r.language,
                ttsString: r.ttsString || undefined,
                text: r.text || undefined,
                tags: r.tags || undefined,
              });
              copied++;
            } catch (err) {
              failed.push(`${r.language}: ${err.message}`);
            }
          }
          promptPhase.items.push({
            old: srcPrompt.name, new: newName,
            status: failed.length && !copied ? "error" : "ok",
            detail: failed.length
              ? `${copied} language(s) copied, no audio — failed: ${failed.join("; ")}`
              : `${copied} language(s) copied · no audio`,
          });
        } catch (err) {
          promptPhase.items.push({ old: srcPrompt.name, new: newName, status: "error", detail: err.message });
        }
        await persist();
      }
    }
    await closePhase(promptPhase, "prompts");

    // ── Publish ALL flows (common modules, in-queue, transfer targets, callflows)
    //    in dependency order via the architect (.i3) format. .i3 is
    //    base64(url-encoded(JSON)); we strip the "Template - " prefix and remap
    //    demo dependency GUIDs → customer GUIDs, then create + import + publish. ──
    const flowEdges = new Map();
    for (const [key, r] of exported) {
      flowEdges.set(key, new Set([...r.flowDepKeys].filter((k) => exported.has(k))));
    }
    const publishOrder = topoSort(new Set(exported.keys()), flowEdges); // dependencies first

    const flowPhase = addPhase("Flows");
    for (const key of publishOrder) {
      const rec = exported.get(key);
      const name = rec.name;
      let newName = finalName(name);
      try {
        // Skip if the flow already exists in the target (record its id for remap).
        const existing = await rest.fetchAllPages(target, "/api/v2/flows", {
          query: { type: rec.type, nameOrDescription: newName },
        });
        const existingFlow = existing.find((fl) => fl.name === newName);
        if (existingFlow) {
          // A deployed flow has remapped GUIDs and a stripped name, so it can
          // never compare equal to its source — "differs" would be meaningless
          // here. `priorRun` (this pair was deployed before) is the honest
          // signal instead; see buildPriorRunNames.
          const choice = resolveCollision({
            kind: "flow", key: `${rec.type}::${name}`, sourceName: name, targetName: newName,
            existing: existingFlow, differs: null, taken: null,
            priorRun: priorRunNames.has(newName),
          });
          if (choice.action === "existing") {
            const demoId = await rest.findFlowIdByName(source, rec.type, name);
            if (demoId) guidMap.set(demoId, existingFlow.id);
            flowPhase.items.push({ old: name, new: newName, status: reuseStatus(), detail: `${rec.type} · ${reuseDetail(null)}` });
            await persist();
            continue;
          }
          newName = choice.name;
        }
        if (preview) {
          flowPhase.items.push({ old: name, new: newName, status: "planned", detail: `${rec.type} · would be published` });
          await persist();
          continue;
        }
        // Export as architect (.i3) from source → strip prefix + remap dependency
        // GUIDs (demo → customer) → create + import + publish to target.
        const demoFlowId = await rest.findFlowIdByName(source, rec.type, name);
        const { output, remapped } = transformI3(rec.i3raw, { prefix: "Template - ", guidMap, renameFrom: stripPrefix(name), renameTo: newName });
        log(`[onboarding] publish '${newName}' (${rec.type}): remapped ${remapped} dependency GUID occurrence(s); guidMap has ${guidMap.size} entries`);
        const pubFile = path.join(workDir, `publish-${rec.type}-${newName}.i3InboundFlow`);
        fs.writeFileSync(pubFile, output, "utf8");
        // Voice-survey flows must be created against a survey form — pass the
        // deployed form's (stripped) name so the SDK create call succeeds.
        const surveyFormName = rec.surveyForm ? finalName(rec.surveyForm.name) : undefined;
        const pubResult = await sdkPublish(target, pubFile, rec.type, newName, getDefaultLanguage(rec.yaml), surveyFormName);
        // Definitively verify the flow actually persisted. Prefer the flow id the SDK
        // emitted (type-agnostic GET by id); fall back to a REST lookup by name.
        let custFlowId = null;
        if (pubResult.flowId) {
          try { const f = await rest.gcFetch(target, "GET", `/api/v2/flows/${pubResult.flowId}`); if (f && f.id) custFlowId = f.id; } catch (_) { /* 404 → not persisted */ }
        }
        if (!custFlowId) custFlowId = await rest.findFlowIdByName(target, rec.type, newName);
        if (!custFlowId) {
          // The child reported PUBLISHED but the flow is not retrievable — a false
          // success. Capture the full SDK output so we can see what publishAsync did.
          if (pubResult && pubResult.fullOutput) log(`[onboarding-runner] SDK output for publish '${name}' (reported PUBLISHED sdkFlowId=${pubResult.flowId} isPublished=${pubResult.isPublished} but flow NOT retrievable):\n${pubResult.fullOutput}`);
          throw new Error(`published but flow not retrievable in target (type ${rec.type}, sdkId ${pubResult.flowId || "none"})`);
        }
        log(`[onboarding] published '${newName}' (${rec.type}) → target flow id ${custFlowId} (sdkId=${pubResult.flowId} isPublished=${pubResult.isPublished})`);
        if (demoFlowId) guidMap.set(demoFlowId, custFlowId);
        createdFlowIds.push(custFlowId);
        flowPhase.items.push({ old: name, new: newName, status: "ok", detail: rec.type });
      } catch (err) {
        if (err.fullOutput) log(`[onboarding-runner] SDK output for publish '${name}':\n${err.fullOutput}`);
        flowPhase.items.push({ old: name, new: newName, status: "error", detail: err.message });
      }
      await persist();
    }

    // Place newly-created flows (roots + common modules + in-queue + survey …) in
    // the chosen division — the Flow Scripting SDK creates them in Home by default.
    if (!preview && divisionId && createdFlowIds.length) {
      try {
        await rest.moveObjectsToDivision(target, divisionId, "FLOW", createdFlowIds);
        flowPhase.items.push({ old: "(division)", new: division, status: "ok", detail: `${createdFlowIds.length} flow(s) → ${division}` });
      } catch (err) {
        flowPhase.items.push({ old: "(division)", new: division, status: "error", detail: `division move failed: ${err.message}` });
        warnings.push(`Could not move flows into division '${division}': ${err.message}`);
      }
      await persist();
    }
    await closePhase(flowPhase, "flows");

    return { phases, warnings, collisions, error: null };
  } catch (err) {
    log.error ? log.error(`[onboarding-runner] job ${job.jobId} failed: ${err.message}`) : log(`job failed: ${err.message}`);
    return { phases, warnings, collisions, error: err.message };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

// ── orchestration ───────────────────────────────────────

/** How long an unapproved preview waits before it is abandoned. */
const APPROVAL_TTL_MS = 30 * 60 * 1000;

/** resolveOrg, but never throwing — used on paths that only need a display name. */
function safeOrg(orgId) {
  try { return resolveOrg(orgId); } catch (_) { return { id: orgId, name: orgId }; }
}

/**
 * Names an earlier deploy of this same source→target pair created. For flows
 * this is the only honest signal that a conflict is "our own previous run"
 * rather than something that was already in the org.
 */
async function buildPriorRunNames(store, job, log) {
  const names = new Set();
  try {
    if (typeof store.listForPair !== "function") return names;
    for (const prior of await store.listForPair(job.sourceOrgId, job.targetOrgId)) {
      if (prior.jobId === job.jobId) continue;
      for (const phase of prior.phases || []) {
        if (phase.phase !== "Flows") continue;
        for (const item of phase.items || []) {
          if (item.status === "ok" && item.new) names.add(item.new);
        }
      }
    }
  } catch (err) {
    log(`[onboarding] prior-run lookup failed (non-critical): ${err.message}`);
  }
  return names;
}

/** Record a pass's terminal state and write the activity-log entry. */
async function finish(job, store, log, res, ctx) {
  const allItems = res.phases.flatMap((p) => p.items);
  const anyError = allItems.some((i) => i.status === "error") || !!res.error;
  const anyOk = allItems.some((i) => i.status === "ok");
  const status = anyError ? (anyOk ? "partial" : "failed") : "succeeded";
  await store.updateJob(job.jobId, {
    phases: res.phases, warnings: res.warnings, status,
    error: res.error || null, finishedAt: new Date().toISOString(),
  });
  log(`[onboarding-runner] job ${job.jobId} → ${status}`);
  await logJobOutcome({ ...ctx, job, phases: res.phases, warnings: res.warnings, status, error: res.error || null, log });
  exportCache.drop(job.jobId);
}

/**
 * Process one claimed job.
 *
 * A job always previews first. It then either stops for approval — because
 * "Preview and Deploy" was used, or because there is a name conflict to resolve
 * — or, with nothing to decide, carries straight on into the deploy reusing the
 * artifacts it just exported. An approved job skips the preview and deploys the
 * snapshot it was approved against.
 */
async function processJob(job, store, log) {
  const cacheDir = exportCache.dirFor(job.jobId);
  const ctx = {
    source: safeOrg(job.sourceOrgId),
    target: safeOrg(job.targetOrgId),
    division: job.divisionName || "Home",
  };

  // ── Approved: deploy what was previewed (no SDK exports — all cached) ──
  if (job.approved) {
    log(`[onboarding-runner] job ${job.jobId} approved — deploying`);
    const res = await runPass(job, store, log, { preview: false, decisions: job.decisions || {}, cacheDir });
    await finish(job, store, log, res, ctx);
    return;
  }

  // ── Pass 1: preview. Writes nothing. ──
  const priorRunNames = await buildPriorRunNames(store, job, log);
  const pre = await runPass(job, store, log, { preview: true, decisions: {}, cacheDir, priorRunNames });

  if (pre.error) {
    await finish(job, store, log, pre, ctx);
    return;
  }

  // Stop when there is something to decide. A conflict is one reason; so is a
  // failure the preview already proved will happen — a missing integration, say.
  // Ploughing on would write half the objects and then fail on the one we
  // already knew about, which is the mess this pass exists to prevent.
  const previewErrors = pre.phases
    .flatMap((p) => p.items || [])
    .filter((i) => i.status === "error").length;

  if (job.stopForPreview || pre.collisions.length || previewErrors) {
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
    await store.updateJob(job.jobId, {
      phases: pre.phases, warnings: pre.warnings, collisions: pre.collisions,
      status: "awaiting-approval", expiresAt,
    });
    log(
      `[onboarding-runner] job ${job.jobId} awaiting approval ` +
      `(${pre.collisions.length} conflict(s), ${previewErrors} predicted failure(s), expires ${expiresAt})`
    );
    return; // nothing is logged yet — the entry is written when it resolves
  }

  // ── Nothing to decide: deploy straight through from the warm cache ──
  const res = await runPass(job, store, log, { preview: false, decisions: {}, cacheDir, priorRunNames });
  await finish(job, store, log, res, ctx);
}

/**
 * Abandon a preview nobody approved. Logged so the audit trail shows the deploy
 * was considered and did not happen, rather than leaving no trace at all.
 */
async function expireJob(job, store, log) {
  await store.updateJob(job.jobId, { status: "expired", finishedAt: new Date().toISOString() });
  exportCache.drop(job.jobId);
  log(`[onboarding-runner] job ${job.jobId} expired without approval`);
  await logJobOutcome({
    job,
    source: safeOrg(job.sourceOrgId),
    target: safeOrg(job.targetOrgId),
    division: job.divisionName || "Home",
    phases: job.phases || [], warnings: job.warnings || [],
    status: "expired", error: null, log,
  });
}

module.exports = { processJob, expireJob };
