/**
 * Activity Log Store — Azure Table Storage CRUD.
 *
 * Table: "activitylog"
 * PartitionKey: "log"   (single partition — low volume, simple queries)
 * RowKey: inverted-timestamp_uuid (smallest RowKey = newest entry, sorts first)
 *
 * Retention: entries with logTimestamp older than RETENTION_MONTHS are
 * excluded from reads and purged when an admin requests the log.
 *
 * Requires app setting:
 *   AZURE_STORAGE_CONNECTION_STRING
 */
const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");

const TABLE_NAME       = "activitylog";
const ADMIN_EMAIL      = "thva@tdc.dk";
const RETENTION_MONTHS = 12;
const MAX_TS           = 9_999_999_999_999; // stays valid until ~year 2286

let _client       = null;
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
    if (err.statusCode !== 409) throw err;
  }
  _tableEnsured = true;
}

/** Build a RowKey that sorts newest entries first. */
function makeRowKey() {
  const inverted = String(MAX_TS - Date.now()).padStart(13, "0");
  return `${inverted}_${crypto.randomUUID()}`;
}

/** ISO string for retention cutoff (entries older than this are stale). */
function retentionCutoff() {
  const d = new Date();
  d.setMonth(d.getMonth() - RETENTION_MONTHS);
  return d.toISOString();
}

// ── Entity ↔ LogEntry mapping ───────────────────────────

function entityToEntry(e) {
  return {
    id:           e.rowKey,
    logTimestamp: e.logTimestamp || "",
    userId:       e.userId       || "",
    userEmail:    e.userEmail    || "",
    userName:     e.userName     || "",
    orgId:        e.orgId        || "",
    orgName:      e.orgName      || "",
    action:       e.action       || "",
    description:  e.description  || "",
    result:       e.result       || "success",
    errorMessage: e.errorMessage || null,
    count:        e.count        ?? null,
  };
}

function entryToEntity(data) {
  return {
    partitionKey: "log",
    rowKey:       makeRowKey(),
    logTimestamp: data.logTimestamp || new Date().toISOString(),
    userId:       data.userId       || "",
    userEmail:    data.userEmail    || "",
    userName:     data.userName     || "",
    orgId:        data.orgId        || "",
    orgName:      data.orgName      || "",
    action:       data.action       || "",
    description:  data.description  || "",
    result:       data.result       || "success",
    errorMessage: data.errorMessage || null,
    count:        data.count        ?? null,
  };
}

// ── CRUD ────────────────────────────────────────────────

/**
 * Write a new activity log entry.
 * @param {object} data  Log entry fields (see entryToEntity)
 */
async function create(data) {
  await ensureTable();
  const entity = entryToEntity(data);
  await getClient().createEntity(entity);
  return entityToEntry(entity);
}

/**
 * List log entries, newest first (RowKey sort order).
 * Entries older than RETENTION_MONTHS are excluded.
 *
 * @param {string|null} userEmail  Filter to a specific user; null = return all (admin)
 * @param {number}      limit      Maximum entries to return (default 500)
 */
async function list({ userEmail = null, limit = 500 } = {}) {
  await ensureTable();
  const cutoff  = retentionCutoff();
  const entries = [];
  const iter    = getClient().listEntities({
    queryOptions: { filter: "PartitionKey eq 'log'" },
  });

  for await (const entity of iter) {
    if ((entity.logTimestamp || "") < cutoff) continue;
    if (userEmail && entity.userEmail?.toLowerCase() !== userEmail.toLowerCase()) continue;
    entries.push(entityToEntry(entity));
    if (entries.length >= limit) break;
  }

  return entries;
}

/**
 * Delete all entries whose logTimestamp is older than the retention window.
 * Should only be called by admin requests. Errors per entity are swallowed.
 * @returns {number} Number of entities deleted.
 */
async function purgeOld() {
  await ensureTable();
  const cutoff   = retentionCutoff();
  const client   = getClient();
  const toDelete = [];

  const iter = client.listEntities({
    queryOptions: { filter: "PartitionKey eq 'log'" },
  });
  for await (const entity of iter) {
    if ((entity.logTimestamp || "") < cutoff) {
      toDelete.push({ partitionKey: entity.partitionKey, rowKey: entity.rowKey });
    }
  }

  for (const key of toDelete) {
    try { await client.deleteEntity(key.partitionKey, key.rowKey); } catch (_) {}
  }

  return toDelete.length;
}

module.exports = { create, list, purgeOld, ADMIN_EMAIL };
