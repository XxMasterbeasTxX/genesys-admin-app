/**
 * Template Assignment Store — Azure Table Storage CRUD for tracking
 * which templates have been assigned to which users.
 *
 * Table: "templateassignments"
 * PartitionKey: orgId
 * RowKey: UUID
 *
 * Requires app setting:
 *   AZURE_STORAGE_CONNECTION_STRING
 */
const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");

const TABLE_NAME = "templateassignments";

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

// ── Entity ↔ Assignment mapping ─────────────────────────

function entityToAssignment(entity) {
  return {
    id: entity.rowKey,
    orgId: entity.partitionKey,
    type: entity.type || "user",
    userId: entity.userId || "",
    userName: entity.userName || "",
    groupId: entity.groupId || "",
    groupName: entity.groupName || "",
    workteamId: entity.workteamId || "",
    workteamName: entity.workteamName || "",
    templateId: entity.templateId,
    templateName: entity.templateName || "",
    assignedAt: entity.assignedAt,
    assignedBy: entity.assignedBy || "",
  };
}

function assignmentToEntity(a) {
  return {
    partitionKey: a.orgId,
    rowKey: a.id,
    type: a.type || "user",
    userId: a.userId || "",
    userName: a.userName || "",
    groupId: a.groupId || "",
    groupName: a.groupName || "",
    workteamId: a.workteamId || "",
    workteamName: a.workteamName || "",
    templateId: a.templateId,
    templateName: a.templateName || "",
    assignedAt: a.assignedAt,
    assignedBy: a.assignedBy || "",
  };
}

// ── CRUD operations ─────────────────────────────────────

/** List all assignments for an org. */
async function listByOrg(orgId) {
  await ensureTable();
  const client = getClient();
  const results = [];
  const iter = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${orgId}'` },
  });
  for await (const entity of iter) {
    results.push(entityToAssignment(entity));
  }
  return results;
}

/** List assignments for a specific user in an org. */
async function listByUser(orgId, userId) {
  const all = await listByOrg(orgId);
  return all.filter((a) => a.userId === userId);
}

/** List assignments for a specific template in an org. */
async function listByTemplate(orgId, templateId) {
  const all = await listByOrg(orgId);
  return all.filter((a) => a.templateId === templateId);
}

/** Create a new assignment. */
async function create(data) {
  await ensureTable();
  const client = getClient();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const assignment = {
    id,
    orgId: data.orgId,
    type: data.type || "user",
    userId: data.userId || "",
    userName: data.userName || "",
    groupId: data.groupId || "",
    groupName: data.groupName || "",
    workteamId: data.workteamId || "",
    workteamName: data.workteamName || "",
    templateId: data.templateId,
    templateName: data.templateName || "",
    assignedAt: now,
    assignedBy: data.assignedBy || "",
  };

  await client.createEntity(assignmentToEntity(assignment));
  return assignment;
}

/** Remove a specific assignment by id. */
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

/** Remove all assignments for a user+template combination. Returns count removed. */
async function removeByUserAndTemplate(orgId, userId, templateId) {
  const assignments = await listByOrg(orgId);
  const toRemove = assignments.filter(
    (a) => a.userId === userId && a.templateId === templateId
  );
  let removed = 0;
  for (const a of toRemove) {
    if (await remove(orgId, a.id)) removed++;
  }
  return removed;
}

/** Remove assignment for a group or workteam + template combination. */
async function removeByEntityAndTemplate(orgId, entityId, entityField, templateId) {
  const assignments = await listByOrg(orgId);
  const toRemove = assignments.filter(
    (a) => a[entityField] === entityId && a.templateId === templateId
  );
  let removed = 0;
  for (const a of toRemove) {
    if (await remove(orgId, a.id)) removed++;
  }
  return removed;
}

module.exports = {
  listByOrg,
  listByUser,
  listByTemplate,
  create,
  remove,
  removeByUserAndTemplate,
  removeByEntityAndTemplate,
};
