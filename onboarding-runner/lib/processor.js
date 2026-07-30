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

// ── topological order (deps first) among exported flows ──

function topoOrder(names, exported) {
  const order = [];
  const seen = new Set();
  const temp = new Set();
  const visit = (n) => {
    if (seen.has(n) || temp.has(n)) return;
    const rec = exported.get(n);
    if (!rec) return;
    temp.add(n);
    for (const d of rec.deps.commonModules) if (exported.has(d)) visit(d);
    temp.delete(n);
    seen.add(n);
    if (names.has(n)) order.push(n);
  };
  for (const n of names) visit(n);
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
        const yamlPath = await sdkExport(source, f.name, f.type, workDir);
        const yaml = fs.readFileSync(yamlPath, "utf8");
        const deps = resolveDeps(yaml);
        exported.set(f.name, { type: f.type, yamlPath, deps, yaml });
        deps.dataTables.forEach((t) => tableNames.add(t));
        deps.dataActions.forEach((a) => actionRefs.set(`${a.integration}::${a.action}`, a));
        deps.commonModules.forEach((n) => queue.push({ name: n, type: DEP_FLOW_TYPES.commonModule }));
        deps.inQueueFlows.forEach((n) => queue.push({ name: n, type: DEP_FLOW_TYPES.inQueue }));
        deps.transferFlows.forEach((n) =>
          warnings.push(`Flow '${f.name}' references transfer-target flow '${n}' — deploy it manually (type unknown).`));
        exportPhase.items.push({ old: f.name, new: stripPrefix(f.name), status: "ok", detail: f.type });
      } catch (err) {
        exportPhase.items.push({ old: f.name, new: stripPrefix(f.name), status: "error", detail: err.message });
      }
      await persist();
    }

    // ── Phase: data tables (REST) ─────────────────────────────────────
    const tablePhase = addPhase("Data tables");
    const [srcTables, tgtTables, tgtDivisions] = await Promise.all([
      rest.listDataTables(source), rest.listDataTables(target), rest.listDivisions(target),
    ]);
    const divisionId = (tgtDivisions.find((d) => d.name === division) || {}).id || job.divisionId;
    const srcTableByName = new Map(srcTables.map((t) => [t.name, t]));
    const tgtTableNames = new Set(tgtTables.map((t) => t.name));

    for (const srcName of [...tableNames].sort()) {
      const newName = stripPrefix(srcName);
      try {
        if (tgtTableNames.has(newName)) {
          tablePhase.items.push({ old: srcName, new: newName, status: "skipped", detail: "already exists" });
          continue;
        }
        const srcMeta = srcTableByName.get(srcName);
        if (!srcMeta) throw new Error("not found in source");
        const full = await rest.getDataTable(source, srcMeta.id);
        const created = await rest.createDataTable(target, {
          name: newName,
          description: full.description || undefined,
          division: { id: divisionId },
          schema: full.schema,
        });
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
        if (tgtActionNames.has(newName)) {
          actionPhase.items.push({ old: srcName, new: newName, status: "skipped", detail: "already exists" });
          continue;
        }
        const srcSummary = srcActionByName.get(srcName);
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
        await rest.createDataAction(target, {
          name: newName,
          category: full.category,
          integrationId: tgtInteg.id,
          contract: full.contract,
          config: full.config,
          secure: full.secure,
        });
        actionPhase.items.push({ old: srcName, new: newName, status: "ok", detail: tgtInteg.name });
      } catch (err) {
        actionPhase.items.push({ old: srcName, new: newName, status: "error", detail: err.message });
      }
      await persist();
    }

    // ── Publish flows via the architect (.i3) format ─────────────────────────
    //    The YAML import is gated in customer orgs; the .i3 (architect) format is
    //    not. .i3 is base64(url-encoded(JSON)) and contains the object NAMES, so
    //    we export each flow as .i3, strip the "Template - " prefix on it, then
    //    create + import + publish. Order: common modules → in-queue → callflows.
    const cmNames = new Set([...exported].filter(([, r]) => r.type === DEP_FLOW_TYPES.commonModule).map(([n]) => n));
    const iqNames = new Set([...exported].filter(([, r]) => r.type === DEP_FLOW_TYPES.inQueue).map(([n]) => n));
    const rootNames = new Set(job.flows.map((f) => f.name));

    await publishGroup("Common modules", topoOrder(cmNames, exported), "commonmodule");
    await publishGroup("In-queue flows", [...iqNames], "inqueuecall");
    await publishGroup("Callflows", [...rootNames], null);

    async function publishGroup(label, names, flowTypeForExistCheck) {
      const phase = addPhase(label);
      for (const name of names) {
        const rec = exported.get(name);
        const newName = stripPrefix(name);
        try {
          if (!rec) throw new Error("was not exported (see Export phase)");
          if (flowTypeForExistCheck) {
            const existing = await rest.fetchAllPages(target, "/api/v2/flows", {
              query: { type: flowTypeForExistCheck, nameOrDescription: newName },
            });
            if (existing.some((fl) => fl.name === newName)) {
              phase.items.push({ old: name, new: newName, status: "skipped", detail: "already exists" });
              continue;
            }
          }
          // Export as architect (.i3) from source → strip prefix → publish to target.
          const i3Path = await sdkExport(source, name, rec.type, workDir, "architect");
          const { output } = transformI3(fs.readFileSync(i3Path, "utf8"), { prefix: "Template - " });
          const pubFile = path.join(workDir, `publish-${newName}.i3InboundFlow`);
          fs.writeFileSync(pubFile, output, "utf8");
          await sdkPublish(target, pubFile, rec.type, newName, getDefaultLanguage(rec.yaml));
          phase.items.push({ old: name, new: newName, status: "ok" });
        } catch (err) {
          if (err.fullOutput) {
            log(`[onboarding-runner] SDK output for publish '${name}':\n${err.fullOutput}`);
          }
          phase.items.push({ old: name, new: newName, status: "error", detail: err.message });
        }
        await persist();
      }
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
