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
 *   role          "" for a plain named colleague; "customer-manager" on an
 *                 INTERNAL row lets that colleague name users for customer
 *                 orgs (docs/internal-user-access-design.md §5). On a CUSTOMER
 *                 row, "administrator" or "supervisor", required
 *                 (docs/customer-roles-design.md §4).
 *   features      JSON array of page access keys — a supervisor's own pages,
 *                 a subset of the org's Supervisor scope. [] otherwise.
 *   assignedBy, assignedByEmail, assignedByName
 *                 who named them — always an internal person.
 *   roleSetBy, roleSetByEmail, roleSetByName, roleSetByOrg, roleSetAt
 *                 the last role/pages change. roleSetByOrg is "internal" or
 *                 the customer slug, so the endpoint can decide what a
 *                 customer session may see of who did it.
 *
 * The internal org has rows too, under its own slug: an internal colleague is
 * named exactly as a customer user is. Its rows carry no billing meaning —
 * the internal org is a trustee org and is never billed.
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
    assignedByName:  e.assignedByName || "",
    assignedAt: e.assignedAt,
    revokedBy:  e.revokedBy || null,
    revokedAt:  e.revokedAt || null,
    role:       e.role || "",
    features:   parseFeatures(e.features),
    // The last change to the row after the add — a role or pages edit, or
    // the customer-manager tick on an internal row. Null until there is one.
    modifiedBy:      e.roleSetBy || "",
    modifiedByEmail: e.roleSetByEmail || "",
    modifiedByName:  e.roleSetByName || "",
    // Rows stamped before the org was recorded were all edited internally.
    modifiedByOrg:   e.roleSetAt ? (e.roleSetByOrg || "internal") : "",
    modifiedAt:      e.roleSetAt || null,
  };
}

function parseFeatures(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
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
  return !!(await activeRow(customerId, userId));
}

/** The active row for a user, or null — the gate reads the role off it. */
async function activeRow(customerId, userId) {
  const rows = await listRows(customerId);
  return rows.find((r) => r.userId === userId && !r.revokedAt) || null;
}

/**
 * Name a user. Idempotent: an existing active row for the id is returned,
 * never duplicated — the second Add of the same person is not a second seat.
 *
 * @param {string} customerId
 * @param {{ id: string, email?: string, name?: string }} user
 * @param {{ id: string, email?: string, name?: string }} by   the caller's VERIFIED identity
 * @returns {Promise<{ row: object, created: boolean }>}
 */
async function assign(customerId, user, by, { role = "", features = [] } = {}) {
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
    assignedByName:  by.name || "",
    assignedAt,
    role:         role || "",
    features:     JSON.stringify(Array.isArray(features) ? features : []),
  };
  await getClient().createEntity(entity);
  return { row: entityToRow(entity), created: true };
}

/**
 * Set the role on a user's active row. Only "" and "customer-manager" mean
 * anything today; the endpoint decides who may call this. Stamped with who
 * and when, so a grant is as traceable as an assignment.
 *
 * @returns {Promise<{ row: object|null, changed: boolean }>}
 */
async function setRole(customerId, userId, role, by, features = null) {
  const active = await activeRow(customerId, userId);
  if (!active) return { row: null, changed: false };
  const nextFeatures = Array.isArray(features) ? [...features].sort() : [];
  const sameRole = (active.role || "") === (role || "");
  const sameFeatures = JSON.stringify([...(active.features || [])].sort()) === JSON.stringify(nextFeatures);
  if (sameRole && sameFeatures) return { row: active, changed: false };
  const roleSetAt = new Date().toISOString();
  await getClient().updateEntity(
    {
      partitionKey: safeKey(customerId),
      rowKey:       `${safeKey(userId)}|${active.assignedAt}`,
      role:         role || "",
      features:     JSON.stringify(nextFeatures),
      roleSetBy:    by.id || "",
      roleSetByEmail: by.email || "",
      roleSetByName:  by.name || "",
      roleSetByOrg:   by.org || "internal",
      roleSetAt,
    },
    "Merge",
  );
  return {
    row: {
      ...active, role: role || "", features: nextFeatures,
      modifiedBy: by.id || "", modifiedByEmail: by.email || "", modifiedByName: by.name || "",
      modifiedByOrg: by.org || "internal", modifiedAt: roleSetAt,
    },
    changed: true,
  };
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

module.exports = { listActive, isActive, activeRow, assign, setRole, revoke, peakAssigned, peakOfRows, TABLE_NAME };
