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

// Dependency flow name → its Genesys/SDK flow type.
const DEP_FLOW_TYPES = { commonModule: "commonmodule", inQueue: "inqueuecall" };

// Flow types a "Transfer to Flow" action can target, in resolution priority.
// (In-queue and common-module flows are referenced differently, never via a
// transfer, so they are excluded — this disambiguates a name that exists as
// multiple flow types, e.g. an inbound flow + an in-queue flow of the same name.)
const TRANSFER_TARGET_TYPES = [
  "inboundcall", "securecall", "workflow", "voice", "voicemail",
  "bot", "digitalbot", "inboundchat", "inboundemail", "inboundshortmessage", "outboundcall",
];

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

async function sdkPublish(targetOrg, file, flowType, flowName, languageTag) {
  const argv = [
    "--clientId", targetOrg.clientId, "--clientSecret", targetOrg.clientSecret,
    "--location", targetOrg.location, "--file", file,
    "--flowType", flowType, "--flowName", flowName,
  ];
  if (languageTag) argv.push("--languageTag", languageTag);
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
  return true;
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
    // ── Phase: export + discover (recursive closure) ──────────────────
    const exportPhase = addPhase("Export & discover");
    const exported = new Map();      // name → { type, yamlPath, deps, yaml }
    const tableNames = new Set();    // source table names (prefixed)
    const actionRefs = new Map();    // key → { integration, action }

    const queue = job.flows.map((f) => ({ name: f.name, type: f.type }));
    while (queue.length) {
      const f = queue.shift();
      if (exported.has(f.name)) continue;
      try {
        // Resolve the flow type if unknown (transfer-target flows) via REST.
        let type = f.type;
        if (!type) {
          const srcFlows = await rest.fetchAllPages(source, "/api/v2/flows", { query: { nameOrDescription: f.name } });
          // Genesys returns `type` upper-cased (e.g. "INBOUNDCALL"); the SDK wants
          // lower-case. A name can collide across flow types, so pick a
          // transfer-eligible type by priority (never in-queue / common-module).
          const matches = srcFlows
            .filter((fl) => fl.name === f.name)
            .map((fl) => String(fl.type || "").toLowerCase());
          type = TRANSFER_TARGET_TYPES.find((t) => matches.includes(t))
            || matches.find((t) => t !== "inqueuecall" && t !== "commonmodule")
            || null;
          if (!type) {
            exportPhase.items.push({ old: f.name, new: stripPrefix(f.name), status: "error", detail: "referenced flow not found in source" });
            await persist();
            continue;
          }
        }
        const yamlPath = await sdkExport(source, f.name, type, workDir);
        const yaml = fs.readFileSync(yamlPath, "utf8");
        const deps = resolveDeps(yaml);
        exported.set(f.name, { type, yamlPath, deps, yaml });
        deps.dataTables.forEach((t) => tableNames.add(t));
        deps.dataActions.forEach((a) => actionRefs.set(`${a.integration}::${a.action}`, a));
        deps.commonModules.forEach((n) => queue.push({ name: n, type: DEP_FLOW_TYPES.commonModule }));
        deps.inQueueFlows.forEach((n) => queue.push({ name: n, type: DEP_FLOW_TYPES.inQueue }));
        // Transfer-target flows (inbound callflows, workflows, secure call flows): type
        // resolved on dequeue via REST, then treated as a full flow dependency.
        deps.transferFlows.forEach((n) => queue.push({ name: n, type: null }));
        exportPhase.items.push({ old: f.name, new: stripPrefix(f.name), status: "ok", detail: type });
      } catch (err) {
        exportPhase.items.push({ old: f.name, new: stripPrefix(f.name), status: "error", detail: err.message });
      }
      await persist();
    }

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

    // ── Publish ALL flows (common modules, in-queue, transfer targets, callflows)
    //    in dependency order via the architect (.i3) format. .i3 is
    //    base64(url-encoded(JSON)); we strip the "Template - " prefix and remap
    //    demo dependency GUIDs → customer GUIDs, then create + import + publish. ──
    const allFlowNames = new Set(exported.keys());
    const flowEdges = new Map();
    for (const [n, r] of exported) {
      const flowDeps = [...r.deps.commonModules, ...r.deps.inQueueFlows, ...r.deps.transferFlows]
        .filter((d) => allFlowNames.has(d));
      flowEdges.set(n, new Set(flowDeps));
    }
    const publishOrder = topoSort(allFlowNames, flowEdges); // dependencies first

    const flowPhase = addPhase("Flows");
    for (const name of publishOrder) {
      const rec = exported.get(name);
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
        const i3Path = await sdkExport(source, name, rec.type, workDir, "architect");
        const { output } = transformI3(fs.readFileSync(i3Path, "utf8"), { prefix: "Template - ", guidMap });
        const pubFile = path.join(workDir, `publish-${newName}.i3InboundFlow`);
        fs.writeFileSync(pubFile, output, "utf8");
        await sdkPublish(target, pubFile, rec.type, newName, getDefaultLanguage(rec.yaml));
        const custFlowId = await rest.findFlowIdByName(target, rec.type, newName);
        if (demoFlowId && custFlowId) guidMap.set(demoFlowId, custFlowId);
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
