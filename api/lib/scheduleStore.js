/**
 * Schedule Store — Azure Table Storage CRUD for scheduled exports.
 *
 * Table: "schedules"
 * PartitionKey: "schedule"  (single partition — low volume, simple queries)
 * RowKey: UUID
 *
 * Requires app setting:
 *   AZURE_STORAGE_CONNECTION_STRING
 */
const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");

const TABLE_NAME = "schedules";
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
    // 409 = table already exists — safe to ignore
    if (err.statusCode !== 409) throw err;
  }
  _tableEnsured = true;
}

// ── Entity ↔ Schedule mapping ───────────────────────────

function entityToSchedule(entity) {
  return {
    id: entity.rowKey,
    exportType: entity.exportType,
    exportLabel: entity.exportLabel || entity.exportType,
    scheduleType: entity.scheduleType,
    scheduleTime: entity.scheduleTime,
    scheduleDayOfWeek: entity.scheduleDayOfWeek ?? null,
    scheduleDayOfMonth: entity.scheduleDayOfMonth ?? null,
    enabled: entity.enabled === true,
    emailRecipients: entity.emailRecipients || "",
    emailMessage: entity.emailMessage || "",
    exportConfig: entity.exportConfig
      ? JSON.parse(entity.exportConfig)
      : {},
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
    partitionKey: "schedule",
    rowKey: schedule.id,
    exportType: schedule.exportType,
    exportLabel: schedule.exportLabel,
    scheduleType: schedule.scheduleType,
    scheduleTime: schedule.scheduleTime,
    scheduleDayOfWeek: schedule.scheduleDayOfWeek,
    scheduleDayOfMonth: schedule.scheduleDayOfMonth,
    enabled: schedule.enabled,
    emailRecipients: schedule.emailRecipients,
    emailMessage: schedule.emailMessage,
    exportConfig: JSON.stringify(schedule.exportConfig || {}),
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
    queryOptions: { filter: "PartitionKey eq 'schedule'" },
  });
  for await (const entity of iter) {
    schedules.push(entityToSchedule(entity));
  }
  return schedules;
}

async function getById(id) {
  await ensureTable();
  const client = getClient();
  try {
    const entity = await client.getEntity("schedule", id);
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
    exportType: data.exportType,
    exportLabel: data.exportLabel || data.exportType,
    scheduleType: data.scheduleType,
    scheduleTime: data.scheduleTime,
    scheduleDayOfWeek: data.scheduleDayOfWeek ?? null,
    scheduleDayOfMonth: data.scheduleDayOfMonth ?? null,
    enabled: data.enabled !== false,
    emailRecipients: data.emailRecipients || "",
    emailMessage: data.emailMessage || "",
    exportConfig: data.exportConfig || {},
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
    exportType: data.exportType ?? existing.exportType,
    exportLabel: data.exportLabel ?? existing.exportLabel,
    scheduleType: data.scheduleType ?? existing.scheduleType,
    scheduleTime: data.scheduleTime ?? existing.scheduleTime,
    scheduleDayOfWeek: data.scheduleDayOfWeek ?? existing.scheduleDayOfWeek,
    scheduleDayOfMonth: data.scheduleDayOfMonth ?? existing.scheduleDayOfMonth,
    enabled: data.enabled ?? existing.enabled,
    emailRecipients: data.emailRecipients ?? existing.emailRecipients,
    emailMessage: data.emailMessage ?? existing.emailMessage,
    exportConfig: data.exportConfig ?? existing.exportConfig,
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
    await client.deleteEntity("schedule", id);
    return true;
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

// ── Permission helpers ──────────────────────────────────

function canEdit(schedule, userEmail) {
  if (!userEmail) return false;
  const lower = userEmail.toLowerCase();
  return (
    lower === schedule.createdBy.toLowerCase() || lower === ADMIN_EMAIL
  );
}

module.exports = { listAll, getById, create, update, remove, canEdit, ADMIN_EMAIL };
