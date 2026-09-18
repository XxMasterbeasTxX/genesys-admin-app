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

// ── Supervisor templates ──────────────────────────────────────────────────
// A named set of pages and data tables a Supervisor can be put on
// (docs/supervisor-templates-design.md). Row key "supervisorTemplate|<id>";
// the id is minted here. Pages and tables are stored as validated by the
// endpoint — subsets of the scope and of the tables open to Supervisors.

const TEMPLATE_PREFIX = "supervisorTemplate|";
const crypto = require("crypto");

function templateFromEntity(e) {
  const parse = (raw) => { try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
  return {
    id: String(e.rowKey || "").slice(TEMPLATE_PREFIX.length),
    name: e.name || "",
    features: parse(e.features).sort(),
    dataTables: parse(e.dataTables).sort(),
    setBy: e.setBy || "", setByEmail: e.setByEmail || "", setAt: e.setAt || null,
  };
}

/** Every template of an org, by name. */
async function listSupervisorTemplates(orgId) {
  await ensureTable();
  const out = [];
  const pk = safeKey(orgId).replace(/'/g, "''");
  const iter = getClient().listEntities({
    queryOptions: { filter: `PartitionKey eq '${pk}' and RowKey ge '${TEMPLATE_PREFIX}' and RowKey lt 'supervisorTemplate}'` },
  });
  for await (const e of iter) out.push(templateFromEntity(e));
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** One template, or null. */
async function getSupervisorTemplate(orgId, id) {
  await ensureTable();
  try {
    return templateFromEntity(await getClient().getEntity(safeKey(orgId), TEMPLATE_PREFIX + safeKey(id)));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * Create (no id) or overwrite (id) a template. The endpoint has validated
 * the name, pages and tables.
 * @returns {Promise<object>} the template as stored
 */
async function setSupervisorTemplate(orgId, id, { name, features, dataTables }, by) {
  await ensureTable();
  const tid = id || crypto.randomUUID();
  const setAt = new Date().toISOString();
  const entity = {
    partitionKey: safeKey(orgId),
    rowKey:       TEMPLATE_PREFIX + safeKey(tid),
    name:         String(name || ""),
    features:     JSON.stringify([...new Set((features || []).map(String))].sort()),
    dataTables:   JSON.stringify([...new Set((dataTables || []).map(String))].sort()),
    setBy:        (by && by.id) || "",
    setByEmail:   (by && by.email) || "",
    setAt,
  };
  await getClient().upsertEntity(entity, "Replace");
  return templateFromEntity(entity);
}

/** Remove a template. The endpoint has checked nobody is on it. */
async function deleteSupervisorTemplate(orgId, id) {
  await ensureTable();
  try { await getClient().deleteEntity(safeKey(orgId), TEMPLATE_PREFIX + safeKey(id)); return true; }
  catch (err) { if (err.statusCode === 404) return false; throw err; }
}

module.exports = {
  getSupervisorScope, setSupervisorScope, getDataTableRules, setDataTableRules, listDataTableRules,
  listSupervisorTemplates, getSupervisorTemplate, setSupervisorTemplate, deleteSupervisorTemplate, TABLE_NAME,
};
