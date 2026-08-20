/**
 * Feature Request Store — Azure Table Storage CRUD.
 *
 * Table: "featurerequests"
 * PartitionKey: "request"  (single partition — low volume, simple queries)
 * RowKey: UUID
 *
 * Follows scheduleStore rather than activityLogStore. The activity log's
 * inverted-timestamp RowKey exists to make the newest entry sort first in a
 * store that is only ever appended to; these records are updated in place —
 * status, note, votes — and a RowKey cannot change, so ordering happens on read.
 *
 * See docs/feature-requests-design.md §3 for the field list and §6 for the
 * visibility model this store's `visibility` field implements.
 *
 * Requires app setting:
 *   AZURE_STORAGE_CONNECTION_STRING
 */
const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");

const TABLE_NAME = "featurerequests";
const PARTITION = "request";
const RETENTION_MONTHS = 12;

// §8. Both sit far below Azure's limits (32 K per property, 1 MB per entity) so
// this store never needs the progressive-shrinking ladder activityLogStore grew.
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 4000;

// §8. Generous enough that nobody meets it by using the board, low enough to
// stop a loop. Votes need no equivalent — they are idempotent by construction.
const CREATES_PER_DAY = 20;

const TYPES = ["feature", "change", "bug", "question"];
const STATUSES = [
  "new",
  "considering",
  "awaiting-submitter",
  "planned",
  "in-progress",
  "shipped",
  "not-planned",
  "duplicate",
];

// Keys match the words people actually see. Both of these once did not:
// "declined" was labelled "Not planned", and "triaged" was labelled "Looked at"
// then renamed to "Considering". A mismatch is confusing enough that the first
// one was asked about, so the second was not left to become the same question.
//
// Rows written before either rename are mapped on the way in, so a request
// triaged last month still reads as Considering rather than falling back to New
// -- which is what an unrecognised status silently does.
const LEGACY_STATUS = { declined: "not-planned", triaged: "considering" };
const VISIBILITIES = ["private", "shared"];

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
  try {
    await getClient().createTable();
  } catch (err) {
    if (err.statusCode !== 409) throw err; // 409 = already exists
  }
  _tableEnsured = true;
}

// ── Field helpers ───────────────────────────────────────

function clamp(value, max) {
  return String(value == null ? "" : value).slice(0, max);
}

function normalizeType(value) {
  const t = String(value || "").trim().toLowerCase();
  return TYPES.includes(t) ? t : "feature";
}

function normalizeStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  const s = LEGACY_STATUS[raw] || raw;
  return STATUSES.includes(s) ? s : null;
}

function normalizeVisibility(value) {
  const v = String(value || "").trim().toLowerCase();
  return VISIBILITIES.includes(v) ? v : null;
}

function safeParseObject(str) {
  if (!str) return {};
  try {
    const parsed = JSON.parse(str);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeParseArray(str) {
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string" && v) : [];
  } catch {
    return [];
  }
}

function retentionCutoff() {
  const d = new Date();
  d.setMonth(d.getMonth() - RETENTION_MONTHS);
  return d.toISOString();
}

// ── Entity ↔ Request mapping ────────────────────────────

function entityToRequest(e) {
  return {
    id: e.rowKey,
    ownerOrgId: e.ownerOrgId || "internal",
    type: e.type || "feature",
    title: e.title || "",
    description: e.description || "",
    route: e.route || "",
    pageLabel: e.pageLabel || "",
    orgId: e.orgId || "",
    orgName: e.orgName || "",
    appVersion: e.appVersion || "",
    userId: e.userId || "",
    userEmail: e.userEmail || "",
    userName: e.userName || "",
    createdAt: e.createdAt || "",
    updatedAt: e.updatedAt || "",
    status: normalizeStatus(e.status) || "new",
    adminNote: e.adminNote || "",
    shippedVersion: e.shippedVersion || "",
    duplicateOf: e.duplicateOf || "",
    votes: safeParseArray(e.votes),
    // Address per voter id, kept so a status change can reach everyone who
    // wanted the thing. A voter on a promoted request may be in any
    // organisation, so there is no single org to look them up against at send
    // time. NEVER projected onto a card — see toOwnCard and toSharedCard.
    voterEmails: safeParseObject(e.voterEmails),
    visibility: e.visibility || "private",
    sharedTitle: e.sharedTitle || "",
    sharedDescription: e.sharedDescription || "",
    publishAnonymously: e.publishAnonymously === true,
    // Denormalised thread summary, so a board can show "Discussion (3)" and
    // whether a reply is waiting without reading every thread it lists.
    threadCount: Number(e.threadCount) || 0,
    threadLastAt: e.threadLastAt || "",
    threadLastRole: e.threadLastRole || "",
  };
}

function requestToEntity(data) {
  return {
    partitionKey: PARTITION,
    rowKey: data.id || crypto.randomUUID(),
    ownerOrgId: data.ownerOrgId || "internal",
    type: normalizeType(data.type),
    title: clamp(data.title, TITLE_MAX),
    description: clamp(data.description, DESCRIPTION_MAX),
    route: clamp(data.route, 200),
    pageLabel: clamp(data.pageLabel, 200),
    orgId: clamp(data.orgId, 100),
    orgName: clamp(data.orgName, 200),
    appVersion: clamp(data.appVersion, 20),
    userId: data.userId || "",
    userEmail: data.userEmail || "",
    userName: data.userName || "",
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: data.updatedAt || new Date().toISOString(),
    status: normalizeStatus(data.status) || "new",
    adminNote: clamp(data.adminNote, DESCRIPTION_MAX),
    shippedVersion: clamp(data.shippedVersion, 20),
    duplicateOf: clamp(data.duplicateOf, 60),
    votes: JSON.stringify(Array.isArray(data.votes) ? data.votes : []),
    voterEmails: JSON.stringify(
      data.voterEmails && typeof data.voterEmails === "object" ? data.voterEmails : {}
    ),
    visibility: normalizeVisibility(data.visibility) || "private",
    sharedTitle: clamp(data.sharedTitle, TITLE_MAX),
    sharedDescription: clamp(data.sharedDescription, DESCRIPTION_MAX),
    publishAnonymously: data.publishAnonymously === true,
    threadCount: Number(data.threadCount) || 0,
    threadLastAt: clamp(data.threadLastAt, 40),
    threadLastRole: clamp(data.threadLastRole, 20),
  };
}

// ── Projections ─────────────────────────────────────────

/**
 * "Thomas Valhøj" → "Thomas V." — given name plus the surname's initial (§6.6).
 *
 * A single-word name is returned as-is; there is no initial to add, and
 * inventing one would be worse than showing what the person is called.
 */
function abbreviateName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/**
 * The shared-board view of a request (§6.7).
 *
 * Built here rather than filtered in the browser. A redaction the page performs
 * is not a redaction: the withheld fields would already have been delivered,
 * one network-tab click away. What crosses a tenant boundary is exactly what
 * this function returns.
 *
 * Withheld deliberately: the submitter's own words (`title`, `description` —
 * the shared board shows the curated wording instead), every identifier
 * (`userId`, `userEmail`, `userName`, `ownerOrgId`, `orgId`, `orgName`), the
 * raw `votes` list, and `route`/`pageLabel` — which look harmless but, combined
 * with the request text, narrow down the author considerably.
 */
function toSharedCard(request, callerUserId) {
  const votes = Array.isArray(request.votes) ? request.votes : [];
  return {
    id: request.id,
    type: request.type,
    title: request.sharedTitle,
    description: request.sharedDescription,
    status: request.status,
    shippedVersion: request.shippedVersion,
    adminNote: request.adminNote,
    createdAt: request.createdAt,
    voteCount: votes.length,
    hasVoted: !!callerUserId && votes.includes(callerUserId),
    submitter: request.publishAnonymously
      ? (request.ownerOrgId === "internal" ? "Internal" : "A customer")
      : abbreviateName(request.userName),
  };
}

/**
 * The own-org view: the whole record, minus the raw vote list.
 *
 * `votes` becomes a count and a flag even here. Who voted for what is nobody's
 * business but the voter's, and the page has no use for the list.
 */
function toOwnCard(request, callerUserId, { includeEmail = false } = {}) {
  const votes = Array.isArray(request.votes) ? request.votes : [];
  // `voterEmails` is dropped by name, not left to the spread: this projection
  // passes unknown fields straight through, so anything added to the record
  // arrives on the card unless it is taken out here.
  const { votes: _dropVotes, voterEmails: _dropVoterEmails, userEmail, ...rest } = request;
  return {
    ...rest,
    ...(includeEmail ? { userEmail } : {}),
    voteCount: votes.length,
    hasVoted: !!callerUserId && votes.includes(callerUserId),
  };
}

// ── CRUD ────────────────────────────────────────────────

/** Every request, newest first. Entries past the retention window are excluded. */
async function listAll() {
  await ensureTable();
  const cutoff = retentionCutoff();
  const out = [];
  const iter = getClient().listEntities({
    queryOptions: { filter: `PartitionKey eq '${PARTITION}'` },
  });
  for await (const entity of iter) {
    if ((entity.createdAt || "") < cutoff) continue;
    out.push(entityToRequest(entity));
  }
  return out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

async function getById(id) {
  await ensureTable();
  try {
    const entity = await getClient().getEntity(PARTITION, id);
    return entityToRequest(entity);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function create(data) {
  await ensureTable();
  const entity = requestToEntity(data);
  await getClient().createEntity(entity);
  return entityToRequest(entity);
}

/**
 * Merge `patch` into an existing request. Returns the updated record, or null
 * if it no longer exists.
 */
async function update(id, patch) {
  const existing = await getById(id);
  if (!existing) return null;

  const merged = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
  const entity = requestToEntity(merged);
  await getClient().updateEntity(entity, "Replace");
  return entityToRequest(entity);
}

async function remove(id) {
  await ensureTable();
  try {
    await getClient().deleteEntity(PARTITION, id);
    return true;
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

/**
 * Add or remove the caller's vote. Idempotent by construction: the vote is the
 * caller's id being present in a list, so a repeated call toggles rather than
 * accumulating, and no separate de-duplication is needed.
 */
async function toggleVote(id, userId, userEmail = "") {
  const existing = await getById(id);
  if (!existing) return null;

  const votes = new Set(existing.votes);
  const voterEmails = { ...existing.voterEmails };

  if (votes.has(userId)) {
    votes.delete(userId);
    delete voterEmails[userId];
  } else {
    votes.add(userId);
    if (userEmail) voterEmails[userId] = userEmail;
  }

  return update(id, { votes: [...votes], voterEmails });
}

/**
 * How many requests this user has created in the last 24 hours (§8 rate limit).
 * Counted over the caller's own records only.
 */
async function countRecentByUser(userId) {
  if (!userId) return 0;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const all = await listAll();
  return all.filter((r) => r.userId === userId && (r.createdAt || "") >= since).length;
}

/**
 * Delete requests past the retention window.
 *
 * Returns the ids it removed, so the caller can take their discussion threads
 * with them: a thread whose request is gone is unreachable, and leaving it
 * would keep the submitter's words past the window that deleted the request.
 *
 * Errors per entity are swallowed — a purge is maintenance, and one stuck row
 * must not fail the read that triggered it.
 */
async function purgeOld() {
  await ensureTable();
  const cutoff = retentionCutoff();
  const client = getClient();
  const stale = [];

  const iter = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${PARTITION}'` },
  });
  for await (const entity of iter) {
    if ((entity.createdAt || "") < cutoff) {
      stale.push({ partitionKey: entity.partitionKey, rowKey: entity.rowKey });
    }
  }

  const deleted = [];
  for (const key of stale) {
    try {
      await client.deleteEntity(key.partitionKey, key.rowKey);
      deleted.push(key.rowKey);
    } catch (_) {}
  }
  return deleted;
}

module.exports = {
  listAll,
  getById,
  create,
  update,
  remove,
  toggleVote,
  countRecentByUser,
  purgeOld,
  toSharedCard,
  toOwnCard,
  abbreviateName,
  normalizeStatus,
  normalizeType,
  normalizeVisibility,
  TYPES,
  STATUSES,
  VISIBILITIES,
  TITLE_MAX,
  DESCRIPTION_MAX,
  CREATES_PER_DAY,
};
