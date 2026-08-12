"use strict";
/**
 * Export artifact cache — lets an approved job deploy what it previewed without
 * re-exporting every flow.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every sdkExport call spawns a Node process that opens its own Flow Scripting
 * session (OAuth + SDK bootstrap), and the pipeline exports each flow TWICE
 * (YAML for dependency discovery, .i3 for the transfer). A preview pays that
 * whole cost; without a cache the approved deploy would pay it all again.
 *
 * Caching the raw exports is enough to skip every SDK export on the second
 * pass: dependency discovery is pure JS over those bytes (resolveDeps on the
 * YAML, a base64 decode + GUID scan on the .i3), so it re-runs in milliseconds.
 *
 * It also makes the deploy faithful to what was shown: you deploy the exact
 * snapshot you approved, not whatever the source looks like by the time you
 * click through. The TTL bounds how stale that snapshot can be.
 *
 * WHERE
 * ─────
 * Under %HOME%\data on Azure (an Azure Files share, so it survives the instance
 * recycling and scale-out of a Consumption plan — a local temp dir would not).
 * Falls back to the OS temp dir when HOME is unset, e.g. running locally.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Matches the approval window in processor.js: an approved job must never
// resume against artifacts that have already been evicted.
const TTL_MS = 30 * 60 * 1000;

function rootDir() {
  const home = process.env.HOME || process.env.HOMEPATH;
  const base = home && fs.existsSync(home) ? path.join(home, "data") : os.tmpdir();
  return path.join(base, "onboarding-cache");
}

/** Cache directory for one job. Created on demand. */
function dirFor(jobId) {
  const dir = path.join(rootDir(), String(jobId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Flow names carry spaces, slashes and unicode, so the file name is a hash of
 * the identity rather than the name itself.
 */
function fileFor(dir, name, type, format) {
  const key = `${type}::${name}::${format || "yaml"}`;
  return path.join(dir, crypto.createHash("sha1").update(key).digest("hex") + ".txt");
}

/** Cached export contents, or null on a miss. */
function read(dir, name, type, format) {
  try {
    const f = fileFor(dir, name, type, format);
    if (!fs.existsSync(f)) return null;
    // A stale artifact is a miss, not a hit — never resurrect an expired export.
    if (Date.now() - fs.statSync(f).mtimeMs > TTL_MS) return null;
    return fs.readFileSync(f, "utf8");
  } catch (_) {
    return null; // an unusable cache must never fail the job
  }
}

/** Store one export. Failures are swallowed — the cache is an optimisation. */
function write(dir, name, type, format, text) {
  try {
    fs.writeFileSync(fileFor(dir, name, type, format), text, "utf8");
    return true;
  } catch (_) {
    return false;
  }
}

/** Drop one job's artifacts (after it finishes, or when it expires). */
function drop(jobId) {
  try {
    fs.rmSync(path.join(rootDir(), String(jobId)), { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

/**
 * Delete artifacts older than the TTL. Cheap, and called on each runner tick so
 * abandoned previews cannot accumulate on the share.
 */
function purgeExpired() {
  let removed = 0;
  try {
    const root = rootDir();
    if (!fs.existsSync(root)) return 0;
    for (const entry of fs.readdirSync(root)) {
      const p = path.join(root, entry);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > TTL_MS) {
          fs.rmSync(p, { recursive: true, force: true });
          removed++;
        }
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* ignore */ }
  return removed;
}

module.exports = { dirFor, read, write, drop, purgeExpired, TTL_MS };
