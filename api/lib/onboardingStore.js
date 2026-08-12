/**
 * Onboarding Job Store — Azure Table Storage CRUD for onboarding deploy jobs.
 *
 * Table: "onboardingjobs"
 * PartitionKey: "job"   (single partition — low volume)
 * RowKey: jobId (UUID)
 *
 * Requires app setting:
 *   AZURE_STORAGE_CONNECTION_STRING
 */
"use strict";

const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");

const TABLE_NAME = "onboardingjobs";

let _client = null;
let _tableEnsured = false;

function getClient() {
  if (!_client) {
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connStr) {
      throw new Error(
        "AZURE_STORAGE_CONNECTION_STRING is not configured. " +
        "Add it to your Azure Static Web App application settings."
      );
    }
    _client = TableClient.fromConnectionString(connStr, TABLE_NAME);
  }
  return _client;
}

async function ensureTable() {
  if (_tableEnsured) return;
  try {
    await getClient().createTable();
  } catch (err) {
    if (err.statusCode !== 409) throw err; // 409 = already exists
  }
  _tableEnsured = true;
}

// ── Entity ↔ Job mapping ────────────────────────────────
// Complex fields (flows, phases, warnings) are stored as JSON strings.

function entityToJob(e) {
  return {
    jobId: e.rowKey,
    sourceOrgId: e.sourceOrgId,
    targetOrgId: e.targetOrgId,
    divisionId: e.divisionId,
    divisionName: e.divisionName || "",
    namePrefix: e.namePrefix || "",
    status: e.status || "queued",
    flows: safeParse(e.flows, []),
    phases: safeParse(e.phases, []),
    warnings: safeParse(e.warnings, []),
    error: e.error || null,
    startedBy: e.startedBy || "",
    startedByName: e.startedByName || "",
    startedById: e.startedById || "",
    createdAt: e.createdAt,
    updatedAt: e.updatedAt || e.createdAt,
    startedAt: e.startedAt || null,
    finishedAt: e.finishedAt || null,
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
    namePrefix: job.namePrefix || "",
    status: job.status || "queued",
    flows: JSON.stringify(job.flows || []),
    phases: JSON.stringify(job.phases || []),
    warnings: JSON.stringify(job.warnings || []),
    error: job.error || "",
    startedBy: job.startedBy || "",
    startedByName: job.startedByName || "",
    startedById: job.startedById || "",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt || job.createdAt,
    startedAt: job.startedAt || "",
    finishedAt: job.finishedAt || "",
  };
}

function safeParse(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── CRUD ────────────────────────────────────────────────

/** Create a new job. `plan` = { sourceOrgId, targetOrgId, divisionId, divisionName, flows, startedBy }. */
async function createJob(plan) {
  await ensureTable();
  const now = new Date().toISOString();
  const job = {
    jobId: crypto.randomUUID(),
    sourceOrgId: plan.sourceOrgId,
    targetOrgId: plan.targetOrgId,
    divisionId: plan.divisionId,
    divisionName: plan.divisionName || "",
    namePrefix: plan.namePrefix || "",
    status: "queued",
    flows: plan.flows || [],
    phases: [],
    warnings: [],
    error: null,
    startedBy: plan.startedBy || "",
    startedByName: plan.startedByName || "",
    startedById: plan.startedById || "",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  await getClient().createEntity(jobToEntity(job));
  return job;
}

/** Get a job by id, or null. */
async function getJob(jobId) {
  await ensureTable();
  try {
    const e = await getClient().getEntity("job", jobId);
    return entityToJob(e);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/** Merge `patch` into a job and persist. Returns the updated job (or null). */
async function updateJob(jobId, patch) {
  const current = await getJob(jobId);
  if (!current) return null;
  const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await getClient().updateEntity(jobToEntity(merged), "Replace");
  return merged;
}

module.exports = { createJob, getJob, updateJob };
