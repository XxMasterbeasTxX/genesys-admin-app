/**
 * Template Schedule Store — Azure Table Storage CRUD for template schedules.
 *
 * Table: "templateschedules"
 * PartitionKey: "tplsched"  (single partition — low volume, simple queries)
 * RowKey: UUID
 *
 * Requires app setting:
 *   AZURE_STORAGE_CONNECTION_STRING
 */
const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");

const TABLE_NAME = "templateschedules";
const PARTITION = "tplsched";
const ADMIN_EMAIL = "thva@tdc.dk";

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

/** Create the table if it doesn't exist (idempotent). */
async function ensureTable() {
  if (_tableEnsured) return;
  const client = getClient();
  try {
    await client.createTable();
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
  _tableEnsured = true;
}

// ── Entity ↔ Schedule mapping ───────────────────────────

function entityToSchedule(entity) {
  let targets = [];
  if (entity.targets) {
    try { targets = JSON.parse(entity.targets); } catch (_) { targets = []; }
  }
  return {
    id: entity.rowKey,
    templateId: entity.templateId,
    templateName: entity.templateName || "",
    orgId: entity.orgId,
    mode: entity.mode, // "reset" or "add"
    scheduleType: entity.scheduleType, // "once", "daily", "weekly", "monthly"
    scheduleTime: entity.scheduleTime,
    scheduleDayOfWeek: entity.scheduleDayOfWeek ?? null,
    scheduleDayOfMonth: entity.scheduleDayOfMonth ?? null,
    scheduleDate: entity.scheduleDate || null, // ISO date for "once"
    enabled: entity.enabled === true,
    targets,
    createdBy: entity.createdBy,
    createdByName: entity.createdByName || "",
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt || entity.createdAt,
    lastRun: entity.lastRun || null,
    lastStatus: entity.lastStatus || null,
    lastError: entity.lastError || null,
  };
}

function scheduleToEntity(schedule) {
  return {
    partitionKey: PARTITION,
    rowKey: schedule.id,
    templateId: schedule.templateId,
    templateName: schedule.templateName,
    orgId: schedule.orgId,
    mode: schedule.mode,
    scheduleType: schedule.scheduleType,
    scheduleTime: schedule.scheduleTime,
    scheduleDayOfWeek: schedule.scheduleDayOfWeek,
    scheduleDayOfMonth: schedule.scheduleDayOfMonth,
    scheduleDate: schedule.scheduleDate,
    enabled: schedule.enabled,
    targets: JSON.stringify(schedule.targets || []),
    createdBy: schedule.createdBy,
    createdByName: schedule.createdByName,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    lastRun: schedule.lastRun,
    lastStatus: schedule.lastStatus,
    lastError: schedule.lastError,
  };
}

// ── CRUD operations ─────────────────────────────────────

async function listAll() {
  await ensureTable();
  const client = getClient();
  const schedules = [];
  const iter = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${PARTITION}'` },
  });
  for await (const entity of iter) {
    schedules.push(entityToSchedule(entity));
  }
  return schedules;
}

async function listByOrg(orgId) {
  const all = await listAll();
  return all.filter((s) => s.orgId === orgId);
}

async function getById(id) {
  await ensureTable();
  const client = getClient();
  try {
    const entity = await client.getEntity(PARTITION, id);
    return entityToSchedule(entity);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function create(data) {
  await ensureTable();
  const client = getClient();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const schedule = {
    id,
    templateId: data.templateId,
    templateName: data.templateName || "",
    orgId: data.orgId,
    mode: data.mode,
    scheduleType: data.scheduleType,
    scheduleTime: data.scheduleTime,
    scheduleDayOfWeek: data.scheduleDayOfWeek ?? null,
    scheduleDayOfMonth: data.scheduleDayOfMonth ?? null,
    scheduleDate: data.scheduleDate || null,
    enabled: data.enabled !== false,
    targets: data.targets || [],
    createdBy: data.createdBy,
    createdByName: data.createdByName || "",
    createdAt: now,
    updatedAt: now,
    lastRun: null,
    lastStatus: null,
    lastError: null,
  };

  await client.createEntity(scheduleToEntity(schedule));
  return schedule;
}

async function update(id, data) {
  await ensureTable();
  const client = getClient();
  const existing = await getById(id);
  if (!existing) return null;

  const updated = {
    ...existing,
    templateId: data.templateId ?? existing.templateId,
    templateName: data.templateName ?? existing.templateName,
    orgId: data.orgId ?? existing.orgId,
    mode: data.mode ?? existing.mode,
    scheduleType: data.scheduleType ?? existing.scheduleType,
    scheduleTime: data.scheduleTime ?? existing.scheduleTime,
    scheduleDayOfWeek: data.scheduleDayOfWeek ?? existing.scheduleDayOfWeek,
    scheduleDayOfMonth: data.scheduleDayOfMonth ?? existing.scheduleDayOfMonth,
    scheduleDate: data.scheduleDate ?? existing.scheduleDate,
    enabled: data.enabled ?? existing.enabled,
    targets: data.targets ?? existing.targets,
    // Preserve immutable fields
    id,
    createdBy: existing.createdBy,
    createdByName: existing.createdByName,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  await client.updateEntity(scheduleToEntity(updated), "Replace");
  return updated;
}

async function remove(id) {
  await ensureTable();
  const client = getClient();
  try {
    await client.deleteEntity(PARTITION, id);
    return true;
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

async function updateRunStatus(id, status, error) {
  await ensureTable();
  const client = getClient();
  const existing = await getById(id);
  if (!existing) return null;

  existing.lastRun = new Date().toISOString();
  existing.lastStatus = status;
  existing.lastError = error || null;
  existing.updatedAt = existing.lastRun;

  // For one-time schedules, disable after execution
  if (existing.scheduleType === "once" && status === "success") {
    existing.enabled = false;
  }

  await client.updateEntity(scheduleToEntity(existing), "Replace");
  return existing;
}

// ── Permission helpers ──────────────────────────────────

function canEdit(schedule, userEmail) {
  if (!userEmail) return false;
  const lower = userEmail.toLowerCase();
  return (
    lower === schedule.createdBy.toLowerCase() || lower === ADMIN_EMAIL
  );
}

module.exports = {
  listAll,
  listByOrg,
  getById,
  create,
  update,
  remove,
  updateRunStatus,
  canEdit,
};
