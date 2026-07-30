/**
 * Onboarding Job Store (runner copy) — Azure Table Storage.
 * Same table/shape as api/lib/onboardingStore.js, with listByStatus + claimNextQueued
 * for the runner to pick up work.
 */
"use strict";

const { TableClient, odata } = require("@azure/data-tables");

const TABLE_NAME = "onboardingjobs";

let _client = null;
let _tableEnsured = false;

function getClient() {
  if (!_client) {
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connStr) throw new Error("AZURE_STORAGE_CONNECTION_STRING is not configured.");
    _client = TableClient.fromConnectionString(connStr, TABLE_NAME);
  }
  return _client;
}

async function ensureTable() {
  if (_tableEnsured) return;
  try { await getClient().createTable(); }
  catch (err) { if (err.statusCode !== 409) throw err; }
  _tableEnsured = true;
}

function safeParse(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function entityToJob(e) {
  return {
    jobId: e.rowKey,
    sourceOrgId: e.sourceOrgId,
    targetOrgId: e.targetOrgId,
    divisionId: e.divisionId,
    divisionName: e.divisionName || "",
    status: e.status || "queued",
    flows: safeParse(e.flows, []),
    phases: safeParse(e.phases, []),
    warnings: safeParse(e.warnings, []),
    error: e.error || null,
    startedBy: e.startedBy || "",
    createdAt: e.createdAt,
    updatedAt: e.updatedAt || e.createdAt,
    startedAt: e.startedAt || null,
    finishedAt: e.finishedAt || null,
    _etag: e.etag,
  };
}

function jobToEntity(job) {
  return {
    partitionKey: "job",
    rowKey: job.jobId,
    sourceOrgId: job.sourceOrgId,
    targetOrgId: job.targetOrgId,
    divisionId: job.divisionId,
    divisionName: job.divisionName || "",
    status: job.status || "queued",
    flows: JSON.stringify(job.flows || []),
    phases: JSON.stringify(job.phases || []),
    warnings: JSON.stringify(job.warnings || []),
    error: job.error || "",
    startedBy: job.startedBy || "",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt || job.createdAt,
    startedAt: job.startedAt || "",
    finishedAt: job.finishedAt || "",
  };
}

async function getJob(jobId) {
  await ensureTable();
  try {
    return entityToJob(await getClient().getEntity("job", jobId));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function updateJob(jobId, patch) {
  const current = await getJob(jobId);
  if (!current) return null;
  const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await getClient().updateEntity(jobToEntity(merged), "Replace");
  return merged;
}

/** List jobs with a given status (oldest first). */
async function listByStatus(status) {
  await ensureTable();
  const out = [];
  const iter = getClient().listEntities({
    queryOptions: { filter: odata`PartitionKey eq 'job' and status eq ${status}` },
  });
  for await (const e of iter) out.push(entityToJob(e));
  out.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  return out;
}

/**
 * Atomically claim the next queued job by flipping it to "running" using an
 * optimistic-concurrency (etag) update. Returns the claimed job or null.
 * Prevents two runner instances from processing the same job.
 */
async function claimNextQueued() {
  const queued = await listByStatus("queued");
  for (const job of queued) {
    try {
      const entity = jobToEntity({
        ...job,
        status: "running",
        startedAt: job.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await getClient().updateEntity(entity, "Replace", { etag: job._etag });
      return { ...job, status: "running" };
    } catch (err) {
      if (err.statusCode === 412) continue; // lost the race — try the next one
      throw err;
    }
  }
  return null;
}

module.exports = { getJob, updateJob, listByStatus, claimNextQueued };
