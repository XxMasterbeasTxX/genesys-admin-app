/**
 * Feature Request Thread Store — Azure Table Storage.
 *
 * Table: "featurerequestthread"
 * PartitionKey: the request's id  (one partition per thread)
 * RowKey: inverted-timestamp_uuid (newest first within a partition)
 *
 * A thread is append-only, which is why the inverted-timestamp RowKey that was
 * wrong for the requests themselves is right here: messages are never edited,
 * so nothing has to be found and rewritten by key.
 *
 * Partitioning by request id means reading a thread is a single partition query
 * rather than a scan, and it is the reason this is a separate table rather than
 * a JSON array on the request row. Messages accumulate and a single table
 * property caps at 32 K: a handful of detailed exchanges would eventually need
 * the progressive-shrinking ladder activityLogStore had to grow. Separate rows
 * have no such ceiling.
 *
 * See docs/feature-requests-design.md §3a.
 *
 * Requires app setting:
 *   AZURE_STORAGE_CONNECTION_STRING
 */
const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");

const TABLE_NAME = "featurerequestthread";
const BODY_MAX = 4000;
const MAX_TS = 9_999_999_999_999; // stays valid until ~year 2286

const ROLES = ["submitter", "superuser"];

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
    if (err.statusCode !== 409) throw err;
  }
  _tableEnsured = true;
}

/** A RowKey that sorts newest first inside the partition. */
function makeRowKey() {
  const inverted = String(MAX_TS - Date.now()).padStart(13, "0");
  return `${inverted}_${crypto.randomUUID()}`;
}

function entityToMessage(e) {
  return {
    id: e.rowKey,
    requestId: e.partitionKey,
    authorId: e.authorId || "",
    authorName: e.authorName || "",
    authorRole: ROLES.includes(e.authorRole) ? e.authorRole : "submitter",
    body: e.body || "",
    createdAt: e.createdAt || "",
  };
}

/**
 * Every message on a request, oldest first.
 *
 * Stored newest-first by RowKey but returned in reading order: a conversation
 * read bottom-up is not a conversation.
 */
async function listByRequest(requestId) {
  await ensureTable();
  const out = [];
  const iter = getClient().listEntities({
    queryOptions: { filter: `PartitionKey eq '${String(requestId).replace(/'/g, "''")}'` },
  });
  for await (const entity of iter) out.push(entityToMessage(entity));
  return out.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

/** Append a message. */
async function create({ requestId, authorId, authorName, authorRole, body }) {
  await ensureTable();
  const entity = {
    partitionKey: String(requestId),
    rowKey: makeRowKey(),
    authorId: authorId || "",
    authorName: authorName || "",
    authorRole: ROLES.includes(authorRole) ? authorRole : "submitter",
    body: String(body == null ? "" : body).slice(0, BODY_MAX),
    createdAt: new Date().toISOString(),
  };
  await getClient().createEntity(entity);
  return entityToMessage(entity);
}

async function getById(requestId, messageId) {
  await ensureTable();
  try {
    return entityToMessage(await getClient().getEntity(String(requestId), messageId));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function remove(requestId, messageId) {
  await ensureTable();
  try {
    await getClient().deleteEntity(String(requestId), messageId);
    return true;
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

/**
 * Delete a whole thread. Called when its request is removed or purged — a
 * thread whose request is gone is unreachable, and leaving it behind would keep
 * the submitter's words past the retention window that deleted the request.
 * Errors per message are swallowed; this is cleanup, not the caller's business.
 */
async function removeThread(requestId) {
  await ensureTable();
  const client = getClient();
  const messages = await listByRequest(requestId);
  for (const m of messages) {
    try { await client.deleteEntity(String(requestId), m.id); } catch (_) {}
  }
  return messages.length;
}

/**
 * Reduce a thread to what a board needs to show about it: how many messages,
 * when the last one landed, and who wrote it.
 *
 * The role of the last author is what lets a card say "waiting on you" without
 * any per-person read state: if the newest message came from the other side of
 * the conversation, the ball is in yours.
 */
function summarize(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return { threadCount: 0, threadLastAt: "", threadLastRole: "" };
  const last = list[list.length - 1]; // listByRequest returns reading order
  return {
    threadCount: list.length,
    threadLastAt: last.createdAt || "",
    threadLastRole: last.authorRole || "",
  };
}

/** What a customer sees instead of the name of whoever answered them. */
const SUPPORT_LABEL = "Support";

/**
 * Hide who answered, for readers outside our own organisation.
 *
 * §6.6 decided that replies carry no personal name: a named individual invites
 * follow-up outside the board and quietly turns one person into the support
 * SLA. That reasoning applies harder to a back-and-forth than to the one-line
 * response it was written about, so superuser messages on a CUSTOMER'S request
 * are attributed to "Support" rather than to a person.
 *
 * Internal threads keep real names — the demo org knows who is answering, and
 * anonymising a conversation between colleagues would be strange. Superusers
 * always see real names too, including when reading a customer's thread, so
 * triage never loses track of who said what.
 *
 * Done here rather than in the page for the same reason as the shared card: a
 * name the browser was sent and chose not to draw has still been sent.
 */
function projectMessages(messages, { anonymiseSuperuser = false } = {}) {
  if (!anonymiseSuperuser) return messages;
  return messages.map((m) =>
    m.authorRole === "superuser"
      ? { ...m, authorName: SUPPORT_LABEL, authorId: "" }
      : m
  );
}

module.exports = {
  listByRequest,
  create,
  getById,
  remove,
  removeThread,
  projectMessages,
  summarize,
  BODY_MAX,
  SUPPORT_LABEL,
};
