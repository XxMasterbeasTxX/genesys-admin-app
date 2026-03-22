/**
 * Template Store — Azure Table Storage CRUD for skill/queue templates.
 *
 * Table: "skilltemplates"
 * PartitionKey: orgId  (templates are per-organisation)
 * RowKey: UUID
 *
 * Requires app setting:
 *   AZURE_STORAGE_CONNECTION_STRING
 */
const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");

const TABLE_NAME = "skilltemplates";
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

// ── Entity ↔ Template mapping ───────────────────────────

function entityToTemplate(entity) {
  return {
    id: entity.rowKey,
    orgId: entity.partitionKey,
    name: entity.name,
    skills: entity.skills ? JSON.parse(entity.skills) : [],
    queues: entity.queues ? JSON.parse(entity.queues) : [],
    roles: entity.roles ? JSON.parse(entity.roles) : [],
    languages: entity.languages ? JSON.parse(entity.languages) : [],
    createdBy: entity.createdBy,
    createdByName: entity.createdByName || "",
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt || entity.createdAt,
  };
}

function templateToEntity(template) {
  return {
    partitionKey: template.orgId,
    rowKey: template.id,
    name: template.name,
    skills: JSON.stringify(template.skills || []),
    queues: JSON.stringify(template.queues || []),
    roles: JSON.stringify(template.roles || []),
    languages: JSON.stringify(template.languages || []),
    createdBy: template.createdBy,
    createdByName: template.createdByName,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

// ── CRUD operations ─────────────────────────────────────

async function listByOrg(orgId) {
  await ensureTable();
  const client = getClient();
  const templates = [];
  const iter = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${orgId}'` },
  });
  for await (const entity of iter) {
    templates.push(entityToTemplate(entity));
  }
  return templates;
}

async function getById(orgId, id) {
  await ensureTable();
  const client = getClient();
  try {
    const entity = await client.getEntity(orgId, id);
    return entityToTemplate(entity);
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

  const template = {
    id,
    orgId: data.orgId,
    name: data.name,
    skills: data.skills || [],
    queues: data.queues || [],
    roles: data.roles || [],
    languages: data.languages || [],
    createdBy: data.createdBy,
    createdByName: data.createdByName || "",
    createdAt: now,
    updatedAt: now,
  };

  await client.createEntity(templateToEntity(template));
  return template;
}

async function update(orgId, id, data) {
  await ensureTable();
  const client = getClient();
  const existing = await getById(orgId, id);
  if (!existing) return null;

  const updated = {
    ...existing,
    name: data.name ?? existing.name,
    skills: data.skills ?? existing.skills,
    queues: data.queues ?? existing.queues,
    roles: data.roles ?? existing.roles,
    languages: data.languages ?? existing.languages,
    // Preserve immutable fields
    id,
    orgId,
    createdBy: existing.createdBy,
    createdByName: existing.createdByName,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  await client.updateEntity(templateToEntity(updated), "Replace");
  return updated;
}

async function remove(orgId, id) {
  await ensureTable();
  const client = getClient();
  try {
    await client.deleteEntity(orgId, id);
    return true;
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

// ── Permission helpers ──────────────────────────────────

function canEdit(template, userEmail) {
  if (!userEmail) return false;
  const lower = userEmail.toLowerCase();
  return (
    lower === template.createdBy.toLowerCase() || lower === ADMIN_EMAIL
  );
}

module.exports = { listByOrg, getById, create, update, remove, canEdit };
