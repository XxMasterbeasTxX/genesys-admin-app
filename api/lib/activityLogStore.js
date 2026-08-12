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

// Azure Table Storage caps a single string property at 32 K characters. Stay
// well under it — the entity carries other properties too, and the whole entity
// is capped at 1 MB.
const MAX_DETAILS_CHARS    = 30000;
// Per-phase item caps, tried in order until the payload fits.
const ITEM_CAP_LADDER      = [50, 25, 12, 6, 3, 1];

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

function safeParse(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Serialize the structured `details` payload to a JSON string that fits in a
 * table property. Oversized payloads are shrunk progressively rather than
 * dropped, so a big deploy still shows its failures.
 *
 * Keep in sync with onboarding-runner/lib/activityLogStore.js — both apps write
 * entries the same reader has to render.
 */
function serializeDetails(details) {
  if (details == null) return "";
  if (typeof details === "string") return details.slice(0, MAX_DETAILS_CHARS);

  let json = JSON.stringify(details);
  if (json.length <= MAX_DETAILS_CHARS) return json;

  const shrunk = JSON.parse(json);
  shrunk.truncated = true;

  // 1) Drop the free-text detail from everything that did not fail.
  for (const p of shrunk.phases || []) {
    for (const i of p.items || []) {
      if (i.status !== "error") delete i.detail;
    }
  }
  json = JSON.stringify(shrunk);
  if (json.length <= MAX_DETAILS_CHARS) return json;

  // 2) Still too big — cap each phase's item list, keeping failures first and
  //    tightening the cap until it fits. A fixed cap isn't enough: a job with
  //    many phases, or one whose failures all keep their detail text, can still
  //    overflow at 50 and would otherwise fall through to the summary-only
  //    fallback, losing every item.
  const fullItems = (shrunk.phases || []).map((p) => p.items || []);
  for (const cap of ITEM_CAP_LADDER) {
    (shrunk.phases || []).forEach((p, idx) => {
      const items = fullItems[idx];
      if (items.length <= cap) {
        p.items = items;
        delete p.omitted;
        return;
      }
      const errors = items.filter((i) => i.status === "error");
      const rest   = items.filter((i) => i.status !== "error");
      p.items   = [...errors, ...rest].slice(0, cap);
      p.omitted = items.length - p.items.length;
    });
    json = JSON.stringify(shrunk);
    if (json.length <= MAX_DETAILS_CHARS) return json;
  }

  // 3) Last resort — keep the summary and warnings, drop the item lists.
  return JSON.stringify({
    summary:   shrunk.summary  || null,
    warnings:  shrunk.warnings || [],
    truncated: true,
  }).slice(0, MAX_DETAILS_CHARS);
}

function entityToEntry(e) {
  return {
    id:           e.rowKey,
    logTimestamp: e.logTimestamp || "",
    userId:       e.userId       || "",
    userEmail:    e.userEmail    || "",
    userName:     e.userName     || "",
    orgId:        e.orgId        || "",
    orgName:      e.orgName      || "",
    ownerOrgId:   e.ownerOrgId   || "internal",
    action:       e.action       || "",
    description:  e.description  || "",
    result:       e.result       || "success",
    errorMessage: e.errorMessage || null,
    count:        e.count        ?? null,
    // Structured breakdown (onboarding deploys today) — null for plain entries.
    details:      safeParse(e.details, null),
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
    ownerOrgId:   data.ownerOrgId   || "internal",
    action:       data.action       || "",
    description:  data.description  || "",
    result:       data.result       || "success",
    errorMessage: data.errorMessage || null,
    count:        data.count        ?? null,
    details:      serializeDetails(data.details),
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
async function list({ userEmail = null, ownerOrgId = null, limit = 500 } = {}) {
  await ensureTable();
  const cutoff  = retentionCutoff();
  const entries = [];
  const iter    = getClient().listEntities({
    queryOptions: { filter: "PartitionKey eq 'log'" },
  });

  for await (const entity of iter) {
    if ((entity.logTimestamp || "") < cutoff) continue;
    if (ownerOrgId && (entity.ownerOrgId || "internal") !== ownerOrgId) continue;
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
