/**
 * GDPR Watch Store — Azure Table Storage for "email me when this completes".
 *
 * Table: "gdprwatches"
 * PartitionKey: customer org id (slug)
 * RowKey:       Genesys GDPR request id
 *
 * One row per request the person asked to be told about. The hourly sweep in
 * api/scheduled-runner reads every open row, asks Genesys for the org's
 * requests, mails once, and marks the row notified; notified rows are purged
 * seven days later. Nothing about the data subject is ever stored here — the
 * request id, the org, the request type, who raised it and where to write.
 *
 * See docs/gdpr-completion-notify-design.md.
 *
 * Requires app setting:
 *   AZURE_STORAGE_CONNECTION_STRING
 */
const { TableClient } = require("@azure/data-tables");

const TABLE_NAME = "gdprwatches";
// One row, partition "_meta", that says when the last sweep ran. The runner
// fires every five minutes; this is what makes the GDPR step hourly.
const META_PK = "_meta";
const META_RK = "sweep";

/** A watch that has not completed by then is mailed "still not complete" and closed. */
const WATCH_DAYS = 30;
/** A notified row stays this long so "did it mail, and where?" has an answer. */
const KEEP_NOTIFIED_DAYS = 7;

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
    if (err.statusCode !== 409) throw err;   // 409 = already exists
  }
  _tableEnsured = true;
}

function entityToWatch(e) {
  return {
    orgId:         e.partitionKey,
    requestId:     e.rowKey,
    ownerOrgId:    e.ownerOrgId || "internal",
    orgName:       e.orgName || "",
    email:         e.email,
    requestType:   e.requestType || "",
    submittedBy:   e.submittedBy || "",
    submittedById: e.submittedById || "",
    createdAt:     e.createdAt,
    lastStatus:    e.lastStatus || null,
    lastCheckedAt: e.lastCheckedAt || null,
    notifiedAt:    e.notifiedAt || null,
    outcome:       e.outcome || null,
    lastError:     e.lastError || null,
  };
}

// ── Writes ──────────────────────────────────────────────

/**
 * Register one watch. Idempotent on (orgId, requestId): a second submission
 * of the same id — there is no such thing in practice — replaces the row.
 */
async function create({ orgId, requestId, ownerOrgId, orgName, email, requestType, submittedBy, submittedById }) {
  await ensureTable();
  const entity = {
    partitionKey:  orgId,
    rowKey:        requestId,
    ownerOrgId:    ownerOrgId || "internal",
    orgName:       orgName || "",
    email,
    requestType:   requestType || "",
    submittedBy:   submittedBy || "",
    submittedById: submittedById || "",
    createdAt:     new Date().toISOString(),
    lastStatus:    null,
    lastCheckedAt: null,
    notifiedAt:    null,
    outcome:       null,
    lastError:     null,
  };
  await getClient().upsertEntity(entity, "Replace");
  return entityToWatch(entity);
}

/** Record what the sweep saw without closing the watch. */
async function touch(orgId, requestId, { lastStatus = null, lastError = null } = {}) {
  await ensureTable();
  await getClient().updateEntity(
    { partitionKey: orgId, rowKey: requestId, lastStatus, lastError, lastCheckedAt: new Date().toISOString() },
    "Merge",
  );
}

/** Close the watch: mailed (or gave up). Never called twice for one row. */
async function markNotified(orgId, requestId, { outcome, lastStatus = null, lastError = null } = {}) {
  await ensureTable();
  await getClient().updateEntity(
    { partitionKey: orgId, rowKey: requestId, outcome, lastStatus, lastError,
      notifiedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() },
    "Merge",
  );
}

// ── Reads ───────────────────────────────────────────────

/** Every watch not yet notified, grouped by org id. */
async function listOpenByOrg() {
  await ensureTable();
  const byOrg = new Map();
  for await (const e of getClient().listEntities()) {
    if (e.partitionKey === META_PK || e.notifiedAt) continue;
    const w = entityToWatch(e);
    if (!byOrg.has(w.orgId)) byOrg.set(w.orgId, []);
    byOrg.get(w.orgId).push(w);
  }
  return byOrg;
}

/** Delete notified rows older than KEEP_NOTIFIED_DAYS. Returns how many. */
async function purgeNotified() {
  await ensureTable();
  const cutoff = new Date(Date.now() - KEEP_NOTIFIED_DAYS * 86400000).toISOString();
  const client = getClient();
  let n = 0;
  const doomed = [];
  for await (const e of client.listEntities()) {
    if (e.notifiedAt && e.notifiedAt < cutoff) doomed.push([e.partitionKey, e.rowKey]);
  }
  for (const [pk, rk] of doomed) {
    try { await client.deleteEntity(pk, rk); n++; } catch { /* already gone */ }
  }
  return n;
}

// ── The sweep marker ────────────────────────────────────

async function getLastSweep() {
  await ensureTable();
  try {
    const e = await getClient().getEntity(META_PK, META_RK);
    return e.lastSweep || null;
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function setLastSweep(iso) {
  await ensureTable();
  await getClient().upsertEntity({ partitionKey: META_PK, rowKey: META_RK, lastSweep: iso }, "Merge");
}

module.exports = {
  create, touch, markNotified, listOpenByOrg, purgeNotified,
  getLastSweep, setLastSweep,
  WATCH_DAYS, KEEP_NOTIFIED_DAYS,
};
