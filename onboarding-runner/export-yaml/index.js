/**
 * POST /api/export-yaml  (onboarding-runner HTTP function)
 *
 * Exports a single Architect flow to Archy YAML using the Flow Scripting SDK and
 * returns the YAML text. Used by the Flow Overview feature, which needs the
 * *structured* YAML (the flat REST latestconfiguration omits implicit default
 * connections). One SDK session = one child process (same pattern as the
 * onboarding processor).
 *
 * Auth: shared secret in the `x-export-key` header, compared to EXPORT_YAML_KEY.
 * Body: { orgId, flowName, flowType }
 * Returns: { yaml, flowName, flowType }
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { resolveOrg } = require("../lib/regions");

const EXPORT_SCRIPT = path.join(__dirname, "..", "lib", "sdkExport.js");

function json(context, status, body) {
  context.res = { status, headers: { "Content-Type": "application/json" }, body };
}

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

module.exports = async function (context, req) {
  // ── Auth ───────────────────────────────────────────────
  const expected = process.env.EXPORT_YAML_KEY;
  const provided = req.headers["x-export-key"] || req.headers["X-Export-Key"];
  if (!expected || provided !== expected) {
    return json(context, 401, { error: "unauthorized" });
  }

  const body = req.body || {};
  const orgId = String(body.orgId || "").trim();
  const flowName = String(body.flowName || "").trim();
  const flowType = String(body.flowType || "").trim().toLowerCase();
  if (!orgId || !flowName || !flowType) {
    return json(context, 400, { error: "orgId, flowName and flowType are required" });
  }

  let org;
  try {
    org = resolveOrg(orgId);
  } catch (err) {
    return json(context, 400, { error: err.message || String(err) });
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowyaml-"));
  try {
    const args = [
      "--clientId", org.clientId,
      "--clientSecret", org.clientSecret,
      "--location", org.location,
      "--flowName", flowName,
      "--flowType", flowType,
      "--outDir", outDir,
    ];
    const res = await runChild(EXPORT_SCRIPT, args);
    const m = res.stdout.match(/EXPORTED (.+)/);
    if (res.code !== 0 || !m) {
      // Never surface SDK stdout (it may echo credentials) — only a short reason.
      const reason = (res.stderr || "export failed").trim().split("\n").pop();
      context.log.error("[export-yaml] export failed:", reason);
      return json(context, 502, { error: "flow export failed: " + reason });
    }
    const yamlPath = m[1].trim();
    const yaml = fs.readFileSync(yamlPath, "utf8");
    return json(context, 200, { yaml, flowName, flowType });
  } catch (err) {
    context.log.error("[export-yaml] error:", err.message || err);
    return json(context, 500, { error: err.message || String(err) });
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
};
