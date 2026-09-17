/**
 * Per-org settings the app owns.
 *
 * The Supervisor scope: the set of pages a Supervisor in that org may have
 * AT ALL (docs/customer-roles-design.md §2). A Supervisor's own pages are a
 * subset of it, and the intersection is computed at sign-in, so editing
 * the scope reaches every Supervisor without touching their rows.
 *
 *   partitionKey  customer slug
 *   rowKey        "supervisorScope"
 *   features      JSON array of page access keys
 *   setBy, setByEmail, setAt
 *
 * Data table rules: what a Supervisor may write into one table
 * (docs/data-table-rules-design.md §4).
 *
 *   partitionKey  customer slug
 *   rowKey        "dataTableRules|<tableId>"
 *   rules         JSON (dataTableRules.normalizeRules shape)
 *   setBy, setByEmail, setAt
 *
 * Absent means empty / no rules. Nothing is deleted; a save overwrites.
 */
const { TableClient } = require("@azure/data-tables");

const TABLE_NAME = "orgsettings";
const SCOPE_ROW = "supervisorScope";

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
  try { await getClient().createTable(); } catch (err) { if (err.statusCode !== 409) throw err; }
  _tableEnsured = true;
}

function safeKey(s) {
  return String(s || "").replace(/[/\\#?]/g, "_");
}

/** The org's Supervisor scope: page keys, sorted; [] when none set. */
async function getSupervisorScope(orgId) {
  await ensureTable();
  try {
    const e = await getClient().getEntity(safeKey(orgId), SCOPE_ROW);
    const list = JSON.parse(e.features || "[]");
    return Array.isArray(list) ? list.map(String).sort() : [];
  } catch (err) {
    if (err.statusCode === 404) return [];
    throw err;
  }
}

/**
 * Overwrite the org's Supervisor scope. The caller has already validated the
 * keys (pages.js); this stores what it is given.
 * @returns {Promise<{ features: string[], setAt: string }>}
 */
async function setSupervisorScope(orgId, features, by) {
  await ensureTable();
  const setAt = new Date().toISOString();
  const list = [...new Set((features || []).map(String))].sort();
  await getClient().upsertEntity({
    partitionKey: safeKey(orgId),
    rowKey:       SCOPE_ROW,
    features:     JSON.stringify(list),
    setBy:        (by && by.id) || "",
    setByEmail:   (by && by.email) || "",
    setAt,
  }, "Replace");
  return { features: list, setAt };
}

const RULES_PREFIX = "dataTableRules|";

/** The rules for one table, or null when none are set. Raw JSON; the caller normalizes. */
async function getDataTableRules(orgId, tableId) {
  await ensureTable();
  try {
    const e = await getClient().getEntity(safeKey(orgId), RULES_PREFIX + safeKey(tableId));
    return { rules: JSON.parse(e.rules || "{}"), setBy: e.setBy || "", setByEmail: e.setByEmail || "", setAt: e.setAt || null };
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/** Every table's rules row for an org: { tableId → { rules, setAt } }. Raw JSON; the caller normalizes. */
async function listDataTableRules(orgId) {
  await ensureTable();
  const out = {};
  const pk = safeKey(orgId).replace(/'/g, "''");
  // Row keys "dataTableRules|<id>": '}' is the character after '|'.
  const iter = getClient().listEntities({
    queryOptions: { filter: `PartitionKey eq '${pk}' and RowKey ge '${RULES_PREFIX}' and RowKey lt 'dataTableRules}'` },
  });
  for await (const e of iter) {
    const tableId = String(e.rowKey || "").slice(RULES_PREFIX.length);
    if (!tableId) continue;
    let rules = {};
    try { rules = JSON.parse(e.rules || "{}"); } catch { /* unreadable → no rules */ }
    out[tableId] = { rules, setAt: e.setAt || null };
  }
  return out;
}

/** Overwrite one table's rules. The caller has normalized them. */
async function setDataTableRules(orgId, tableId, rules, by) {
  await ensureTable();
  const setAt = new Date().toISOString();
  await getClient().upsertEntity({
    partitionKey: safeKey(orgId),
    rowKey:       RULES_PREFIX + safeKey(tableId),
    rules:        JSON.stringify(rules || {}),
    setBy:        (by && by.id) || "",
    setByEmail:   (by && by.email) || "",
    setAt,
  }, "Replace");
  return { rules, setAt };
}

module.exports = { getSupervisorScope, setSupervisorScope, getDataTableRules, setDataTableRules, listDataTableRules, TABLE_NAME };
