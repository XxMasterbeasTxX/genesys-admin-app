/**
 * Named-user licences, in the app's own store.
 *
 * Customers pay for the app per named user, and the list of names IS the
 * contract — there is no seat count to keep in step with it
 * (docs/customer-user-licensing-design.md §0). One row per assignment
 * interval: who was named, by whom, when, and — once removed — by whom and
 * when. Nothing is ever hard-deleted, because billing will later ask "how
 * many were named at the peak of this billing period", and only the
 * intervals can answer that.
 *
 *   partitionKey  customer slug (the registry / customers.json slug)
 *   rowKey        `<userId>|<assignedAt>` — a user removed and re-added has
 *                 two rows, both true
 *   userId, email, name, assignedBy, assignedAt, revokedBy, revokedAt
 *
 * Timestamps are UTC ISO-8601. Genesys billing periods arrive the same way,
 * so the peak sweep compares like with like.
 */
const { TableClient } = require("@azure/data-tables");

const TABLE_NAME = "licenses";

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
    if (err.statusCode !== 409) throw err; // 409 = exists
  }
  _tableEnsured = true;
}

/** Table Storage keys cannot contain / \ # ? — a Genesys id never does, but be safe. */
function safeKey(s) {
  return String(s || "").replace(/[/\\#?]/g, "_");
}

function entityToRow(e) {
  return {
    customerId: e.partitionKey,
    userId:     e.userId,
    email:      e.email || "",
    name:       e.name || "",
    assignedBy: e.assignedBy || "",
    assignedByEmail: e.assignedByEmail || "",
    assignedAt: e.assignedAt,
    revokedBy:  e.revokedBy || null,
    revokedAt:  e.revokedAt || null,
  };
}

async function listRows(customerId) {
  await ensureTable();
  const rows = [];
  const iter = getClient().listEntities({
    queryOptions: { filter: `PartitionKey eq '${safeKey(customerId).replace(/'/g, "''")}'` },
  });
  for await (const e of iter) rows.push(entityToRow(e));
  return rows;
}

// ── The questions the app asks ────────────────────────────────────────────

/** Every currently named user for a customer, oldest assignment first. */
async function listActive(customerId) {
  const rows = await listRows(customerId);
  return rows.filter((r) => !r.revokedAt).sort((a, b) => a.assignedAt.localeCompare(b.assignedAt));
}

/** The gate's question: is this user named right now? */
async function isActive(customerId, userId) {
  const rows = await listRows(customerId);
  return rows.some((r) => r.userId === userId && !r.revokedAt);
}

/**
 * Name a user. Idempotent: an existing active row for the id is returned,
 * never duplicated — the second Add of the same person is not a second seat.
 *
 * @param {string} customerId
 * @param {{ id: string, email?: string, name?: string }} user
 * @param {{ id: string, email?: string }} by   the caller's VERIFIED identity
 * @returns {Promise<{ row: object, created: boolean }>}
 */
async function assign(customerId, user, by) {
  const rows = await listRows(customerId);
  const existing = rows.find((r) => r.userId === user.id && !r.revokedAt);
  if (existing) return { row: existing, created: false };

  const assignedAt = new Date().toISOString();
  const entity = {
    partitionKey: safeKey(customerId),
    rowKey:       `${safeKey(user.id)}|${assignedAt}`,
    userId:       user.id,
    email:        user.email || "",
    name:         user.name || "",
    assignedBy:   by.id || "",
    assignedByEmail: by.email || "",
    assignedAt,
  };
  await getClient().createEntity(entity);
  return { row: entityToRow(entity), created: true };
}

/**
 * Remove a user's access. The row is stamped, not deleted — it is billing
 * history now. Idempotent: no active row is a no-op.
 *
 * @returns {Promise<{ row: object|null, revoked: boolean }>}
 */
async function revoke(customerId, userId, by) {
  const rows = await listRows(customerId);
  const active = rows.find((r) => r.userId === userId && !r.revokedAt);
  if (!active) return { row: null, revoked: false };

  const revokedAt = new Date().toISOString();
  await getClient().updateEntity(
    {
      partitionKey: safeKey(customerId),
      rowKey:       `${safeKey(userId)}|${active.assignedAt}`,
      revokedBy:    by.id || "",
      revokedByEmail: by.email || "",
      revokedAt,
    },
    "Merge",
  );
  return { row: { ...active, revokedBy: by.id || "", revokedAt }, revoked: true };
}

/**
 * The highest number of named users at any moment inside [start, end].
 *
 * This is the billing rule (design §0): a customer that had 5 and dropped to
 * 4 mid-period is billed for 5; one that had 4 and added a fifth on the last
 * day is billed for 5; someone named for an afternoon counts for that
 * afternoon. The same rule Genesys applies to its own named licences.
 *
 * Built now and called by nothing yet, so the rows are proven to carry what
 * billing needs before any history accumulates.
 *
 * @param {string} customerId
 * @param {string} start  ISO datetime (inclusive)
 * @param {string} end    ISO datetime (inclusive)
 * @returns {Promise<number>}
 */
async function peakAssigned(customerId, start, end) {
  const rows = await listRows(customerId);
  return peakOfRows(rows, start, end);
}

/** The sweep itself, on rows already in hand — exported for the harness. */
function peakOfRows(rows, start, end) {
  const s = Date.parse(start), e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) throw new Error("peakAssigned: invalid period");

  // Everyone whose interval was open at `start` is the baseline.
  let count = 0;
  const events = [];
  for (const r of rows) {
    const a = Date.parse(r.assignedAt);
    const v = r.revokedAt ? Date.parse(r.revokedAt) : Infinity;
    if (a <= s && v > s) count++;
    // Changes inside the window. Add before remove at the same instant, so a
    // same-second swap never under-counts the moment both were present.
    if (a > s && a <= e) events.push([a, 0, +1]);
    if (v > s && v <= e) events.push([v, 1, -1]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  let peak = count;
  for (const [, , d] of events) {
    count += d;
    if (count > peak) peak = count;
  }
  return peak;
}

module.exports = { listActive, isActive, assign, revoke, peakAssigned, peakOfRows, TABLE_NAME };
