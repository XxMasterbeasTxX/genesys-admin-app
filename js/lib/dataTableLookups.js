/**
 * The allowed values behind a data table rule's lookup — the names a
 * Super User may choose from (docs/data-table-rules-design.md §2).
 *
 *   queue, skill, scheduleGroup, schedule, group   the org's objects, by name
 *   dataTable                                      the KEYS of another table
 *
 * Keys are cheap: GET /flows/datatables/{id}/rows with showbrief (the
 * default) returns one field per row, the key, so even a large table is a
 * handful of small pages — fetched several at a time, as the documentation
 * export fetches datatable pages. Everything is cached for the session per
 * org and lookup, so a table with three Queue columns fetches the queues
 * once, and re-opening the table costs nothing; Refresh on the page clears
 * the cache for that org.
 */
import * as gc from "../services/genesysApi.js";

const PAGE = 100;        // rows per page for the key walk
const PARALLEL = 5;      // pages in flight for the key walk

const cache = new Map();   // `${orgId}|${lookup}|${tableId}` → Promise<string[]>

function cacheKey(orgId, rule) {
  return `${orgId}|${rule.lookup}|${rule.lookup === "dataTable" ? rule.tableId : ""}`;
}

/** Forget what was fetched for an org (the page's Refresh). */
export function clearLookupCache(orgId) {
  for (const k of [...cache.keys()]) if (!orgId || k.startsWith(orgId + "|")) cache.delete(k);
}

const names = (list) => [...new Set((list || []).map((e) => e && e.name).filter((n) => typeof n === "string" && n !== ""))]
  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

/**
 * Every key of a data table, in key order. The first page says how many
 * pages there are; the rest are fetched PARALLEL at a time.
 */
async function fetchTableKeys(api, orgId, tableId) {
  const path = `/api/v2/flows/datatables/${encodeURIComponent(tableId)}/rows`;
  // A brief row is meant to be `{ key }`; if it ever arrives as a single
  // field under another name, that field is the key. If a page carries rows
  // but no key can be read from them, fall back to full rows — heavier, but
  // the Edit page proves those carry `key`.
  const keyOf = (r) => {
    if (!r || typeof r !== "object") return null;
    if (r.key != null) return String(r.key);
    const vals = Object.values(r);
    return vals.length === 1 && vals[0] != null && typeof vals[0] !== "object" ? String(vals[0]) : null;
  };
  const fetchPage = (n, brief) => api.proxyGenesys(orgId, "GET", path, {
    query: { pageSize: String(PAGE), pageNumber: String(n), ...(brief ? {} : { showbrief: "false" }) },
  });
  let brief = true;
  let first = await fetchPage(1, true);
  let firstKeys = (first.entities || []).map(keyOf).filter((k) => k != null);
  if ((first.entities || []).length && !firstKeys.length) {
    console.warn("[dataTableLookups] brief rows carried no readable key; falling back to full rows", first.entities[0]);
    brief = false;
    first = await fetchPage(1, false);
    firstKeys = (first.entities || []).map(keyOf).filter((k) => k != null);
  }
  const keys = firstKeys;
  const pageCount = Number(first.pageCount) || 1;
  for (let p = 2; p <= pageCount; p += PARALLEL) {
    const batch = [];
    for (let q = p; q < p + PARALLEL && q <= pageCount; q++) batch.push(fetchPage(q, brief));
    for (const resp of await Promise.all(batch)) {
      for (const r of resp.entities || []) { const k = keyOf(r); if (k != null) keys.push(k); }
    }
  }
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/**
 * The allowed values for a rule with a lookup. Sorted, unique, cached.
 * @param {{ lookup: string, tableId?: string, values?: string[] }} rule
 * @returns {Promise<string[]>}
 */
export function fetchLookupValues(api, orgId, rule) {
  if (!rule || !rule.lookup) return Promise.resolve([]);
  // A typed list is the rule itself: nothing to fetch, nothing to cache,
  // and the Master Admin's order is the dropdown's order.
  if (rule.lookup === "list") return Promise.resolve([...(Array.isArray(rule.values) ? rule.values : [])]);
  const key = cacheKey(orgId, rule);
  if (cache.has(key)) return cache.get(key);
  let p;
  switch (rule.lookup) {
    case "dataTable":     p = fetchTableKeys(api, orgId, rule.tableId); break;
    case "queue":         p = gc.fetchAllQueues(api, orgId).then(names); break;
    case "skill":         p = gc.fetchAllSkills(api, orgId).then(names); break;
    case "scheduleGroup": p = gc.fetchAllScheduleGroups(api, orgId).then(names); break;
    case "schedule":      p = gc.fetchAllSchedules(api, orgId).then(names); break;
    case "group":         p = gc.fetchAllGroups(api, orgId).then(names); break;
    default:              p = Promise.resolve([]);
  }
  // A failed fetch is not remembered: the next attempt tries again.
  p = p.catch((err) => { cache.delete(key); throw err; });
  cache.set(key, p);
  return p;
}

/**
 * The values for every lookup column of a table's rules, fetched together.
 * @returns {Promise<{ values: Object<string, string[]>, failed: Object<string, string> }>}
 *   values by column name; failed by column name with the error message.
 */
export async function fetchAllLookupValues(api, orgId, rules) {
  const values = {}, failed = {};
  const cols = Object.entries((rules && rules.columns) || {}).filter(([, r]) => r && r.lookup);
  await Promise.all(cols.map(async ([name, rule]) => {
    try { values[name] = await fetchLookupValues(api, orgId, rule); }
    catch (err) { failed[name] = err.message || String(err); }
  }));
  return { values, failed };
}
