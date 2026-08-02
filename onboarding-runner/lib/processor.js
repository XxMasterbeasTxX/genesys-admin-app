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

// ── main ────────────────────────────────────────────────

/**
 * @param {object} job   the claimed job (status already "running")
 * @param {object} store onboardingStore (for updateJob)
 * @param {object} log   context.log
 */
async function processJob(job, store, log) {
  const source = resolveOrg(job.sourceOrgId);
  const target = resolveOrg(job.targetOrgId);
  const division = job.divisionName || "Home";

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `onboarding-${job.jobId}-`));
  const phases = [];
  const warnings = [];

  const addPhase = (name) => { const p = { phase: name, items: [] }; phases.push(p); return p; };
  const persist = () => store.updateJob(job.jobId, { phases, warnings });

  try {
    // ── Source indexes (id → name/type) for GUID-based reference discovery ──
    const [srcFlowsAll, srcScriptsAll, srcSurveyFormsAll] = await Promise.all([
      rest.listFlows(source), rest.listScripts(source), rest.listSurveyForms(source),
    ]);
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

    const queue = job.flows.map((f) => ({ name: f.name, type: f.type }));
    while (queue.length) {
      const f = queue.shift();
      try {
        // Resolve the flow type from the source index if the caller didn't give one.
        let type = f.type ? String(f.type).toLowerCase() : null;
        if (!type) {
          for (const info of srcFlowById.values()) { if (info.name === f.name) { type = info.type; break; } }
          if (!type) {
            exportPhase.items.push({ old: f.name, new: stripPrefix(f.name), status: "error", detail: "referenced flow not found in source" });
            await persist();
            continue;
          }
        }
        // Key by type + name: the SAME name can exist as different flow types
        // (e.g. an inbound flow and an in-queue flow both named "X").
        const key = `${type}::${f.name}`;
        if (exported.has(key)) continue;

        // YAML export → data table / data action refs + default language.
        const yamlPath = await sdkExport(source, f.name, type, workDir);
        const yaml = fs.readFileSync(yamlPath, "utf8");
        const deps = resolveDeps(yaml);
        deps.dataTables.forEach((t) => tableNames.add(t));
        deps.dataActions.forEach((a) => actionRefs.set(`${a.integration}::${a.action}`, a));

        // Architect (.i3) export → scan for EVERY referenced flow & script GUID.
        // .i3 is base64(url-encoded(JSON)); GUIDs appear verbatim, so any source
        // flow/script whose id appears is a dependency — regardless of the action
        // that references it (transfer targets, post-flow refs, screen-pop scripts,
        // common modules, in-queue flows, …). This is the general reference map.
        const i3raw = fs.readFileSync(await sdkExport(source, f.name, type, workDir, "architect"), "utf8");
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
        // Voice-survey flows reference a survey form (by version id or contextId).
        // Record the form so it can be deployed + remapped, and remember it on the
        // flow record so we can pass the form NAME to the SDK create call.
        let surveyForm = null;
        for (const [guid, sf] of srcSurveyFormByGuid) {
          if (guidSet.has(guid)) { surveyFormRefs.set(guid, sf); surveyForm = sf; }
        }

        exported.set(key, { name: f.name, type, yaml, i3raw, flowDepKeys, surveyForm });
        exportPhase.items.push({ old: f.name, new: stripPrefix(f.name), status: "ok", detail: type });
      } catch (err) {
        exportPhase.items.push({ old: f.name, new: stripPrefix(f.name), status: "error", detail: err.message });
      }
      await persist();
    }

    log(`[onboarding] discovered flows: ${[...exported.keys()].join(", ") || "(none)"}`);
    log(`[onboarding] discovered script refs: ${scriptRefs.size ? [...scriptRefs.entries()].map(([id, n]) => `${n}=${id}`).join(", ") : "(none)"}`);
    log(`[onboarding] discovered survey forms: ${surveyFormRefs.size ? [...new Set([...surveyFormRefs.values()].map((s) => s.name))].join(", ") : "(none)"}`);

    // ── Phase: data tables (REST) ─────────────────────────────────────
    const guidMap = new Map(); // demo dependency GUID → customer GUID (for .i3 remap)
    const tablePhase = addPhase("Data tables");
    const [srcTables, tgtTables, tgtDivisions] = await Promise.all([
      rest.listDataTables(source), rest.listDataTables(target), rest.listDivisions(target),
    ]);
    const divisionId = (tgtDivisions.find((d) => d.name === division) || {}).id || job.divisionId;
    const srcTableByName = new Map(srcTables.map((t) => [t.name, t]));
    const tgtTableByName = new Map(tgtTables.map((t) => [t.name, t]));
    const tgtTableNames = new Set(tgtTables.map((t) => t.name));

    for (const srcName of [...tableNames].sort()) {
      const newName = stripPrefix(srcName);
      try {
        const srcMeta = srcTableByName.get(srcName);
        if (tgtTableNames.has(newName)) {
          const existing = tgtTableByName.get(newName);
          if (srcMeta && existing) guidMap.set(srcMeta.id, existing.id);
          tablePhase.items.push({ old: srcName, new: newName, status: "skipped", detail: "already exists" });
          continue;
        }
        if (!srcMeta) throw new Error("not found in source");
        const full = await rest.getDataTable(source, srcMeta.id);
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
      const newName = stripPrefix(srcName);
      try {
        const srcSummary = srcActionByName.get(srcName);
        if (tgtActionNames.has(newName)) {
          const existing = tgtActionByName.get(newName);
          if (srcSummary && existing) guidMap.set(srcSummary.id, existing.id);
          actionPhase.items.push({ old: srcName, new: newName, status: "skipped", detail: "already exists" });
          continue;
        }
        if (!srcSummary) throw new Error("not found in source");
        const full = await rest.getDataAction(source, srcSummary.id);
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

    // ── Phase: scripts (screen-pop references) ───────────────────────
    //    Any script referenced by a flow (e.g. a screen pop) is exported from the
    //    source and imported into the target, then its GUID is remapped in the .i3.
    if (scriptRefs.size) {
      const scriptPhase = addPhase("Scripts");
      const tgtScriptByName = new Map((await rest.listScripts(target)).map((s) => [s.name, s]));
      for (const [srcId, srcName] of scriptRefs) {
        const newName = stripPrefix(srcName);
        try {
          const existing = tgtScriptByName.get(newName);
          if (existing) {
            // The script exists but earlier runs imported it as an unpublished
            // draft — the flow validator only sees PUBLISHED scripts, so publish
            // it now (idempotent) before recording the GUID remap.
            try { await rest.publishScript(target, existing.id); } catch (e) { log(`[onboarding] publish existing script '${newName}' failed: ${e.message}`); }
            guidMap.set(srcId, existing.id);
            scriptPhase.items.push({ old: srcName, new: newName, status: "skipped", detail: "already exists · published" });
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
          }
          scriptPhase.items.push({ old: srcName, new: newName, status: created ? "ok" : "error", detail: created ? "imported · published" : "imported but not found by name" });
        } catch (err) {
          scriptPhase.items.push({ old: srcName, new: newName, status: "error", detail: err.message });
        }
        await persist();
      }
    }

    // ── Phase: survey forms (voice-survey flow dependency) ───────────
    //    A voice-survey flow can only be CREATED against an existing survey form,
    //    and its imported .i3 references the form by GUID. So deploy + publish the
    //    form first, remap its id/contextId (demo → customer) in guidMap, and
    //    remember the target form NAME to pass to the SDK create call.
    if (surveyFormRefs.size) {
      const surveyPhase = addPhase("Survey forms");
      const uniqueForms = new Map(); // source form id → { id, contextId, name }
      for (const sf of surveyFormRefs.values()) uniqueForms.set(sf.id, sf);
      const tgtFormByName = new Map((await rest.listSurveyForms(target)).map((f) => [f.name, f]));
      for (const sf of uniqueForms.values()) {
        const newName = stripPrefix(sf.name);
        try {
          let tgt = tgtFormByName.get(newName);
          if (!tgt) {
            // Fetch the full source form, strip server-assigned ids, create + publish.
            const full = await rest.getSurveyForm(source, sf.id);
            const body = sanitizeSurveyForm(full, newName);
            const created = await rest.createSurveyForm(target, body);
            const published = await rest.publishSurveyForm(target, created.id);
            tgt = published && published.id ? published : created;
          } else {
            // Ensure the existing form is published so flows can reference it.
            try { await rest.publishSurveyForm(target, tgt.id); } catch (_) { /* already published */ }
          }
          // Remap both the source version id and contextId → target values so the
          // imported .i3 (whichever it stores) points at the deployed form.
          if (sf.id && tgt.id) guidMap.set(String(sf.id).toLowerCase(), tgt.id);
          if (sf.contextId && tgt.contextId) guidMap.set(String(sf.contextId).toLowerCase(), tgt.contextId);
          surveyPhase.items.push({ old: sf.name, new: newName, status: "ok", detail: tgtFormByName.get(newName) ? "already exists · published" : "created · published" });
        } catch (err) {
          surveyPhase.items.push({ old: sf.name, new: newName, status: "error", detail: err.message });
        }
        await persist();
      }
    }

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
      const newName = stripPrefix(name);
      try {
        // Skip if the flow already exists in the target (record its id for remap).
        const existing = await rest.fetchAllPages(target, "/api/v2/flows", {
          query: { type: rec.type, nameOrDescription: newName },
        });
        const existingFlow = existing.find((fl) => fl.name === newName);
        if (existingFlow) {
          const demoId = await rest.findFlowIdByName(source, rec.type, name);
          if (demoId) guidMap.set(demoId, existingFlow.id);
          flowPhase.items.push({ old: name, new: newName, status: "skipped", detail: `${rec.type} · already exists` });
          await persist();
          continue;
        }
        // Export as architect (.i3) from source → strip prefix + remap dependency
        // GUIDs (demo → customer) → create + import + publish to target.
        const demoFlowId = await rest.findFlowIdByName(source, rec.type, name);
        const { output, remapped } = transformI3(rec.i3raw, { prefix: "Template - ", guidMap });
        log(`[onboarding] publish '${newName}' (${rec.type}): remapped ${remapped} dependency GUID occurrence(s); guidMap has ${guidMap.size} entries`);
        const pubFile = path.join(workDir, `publish-${rec.type}-${newName}.i3InboundFlow`);
        fs.writeFileSync(pubFile, output, "utf8");
        // Voice-survey flows must be created against a survey form — pass the
        // deployed form's (stripped) name so the SDK create call succeeds.
        const surveyFormName = rec.surveyForm ? stripPrefix(rec.surveyForm.name) : undefined;
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
        flowPhase.items.push({ old: name, new: newName, status: "ok", detail: rec.type });
      } catch (err) {
        if (err.fullOutput) log(`[onboarding-runner] SDK output for publish '${name}':\n${err.fullOutput}`);
        flowPhase.items.push({ old: name, new: newName, status: "error", detail: err.message });
      }
      await persist();
    }

    // ── Finalize ──────────────────────────────────────────────────────
    const allItems = phases.flatMap((p) => p.items);
    const anyError = allItems.some((i) => i.status === "error");
    const anyOk = allItems.some((i) => i.status === "ok");
    const status = anyError ? (anyOk ? "partial" : "failed") : "succeeded";
    await store.updateJob(job.jobId, { phases, warnings, status, finishedAt: new Date().toISOString() });
    log(`[onboarding-runner] job ${job.jobId} → ${status}`);
  } catch (err) {
    log.error ? log.error(`[onboarding-runner] job ${job.jobId} failed: ${err.message}`) : log(`job failed: ${err.message}`);
    await store.updateJob(job.jobId, {
      phases, warnings, status: "failed", error: err.message, finishedAt: new Date().toISOString(),
    });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

module.exports = { processJob };
