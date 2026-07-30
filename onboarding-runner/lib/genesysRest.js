/**
 * Genesys REST helper (runner) — client-credentials calls for the data table /
 * data action phases (the flow phases go through the SDK child workers instead).
 * `org` is a resolved object from regions.resolveOrg().
 */
"use strict";

const { getGenesysToken } = require("./genesysAuth");

async function gcFetch(org, method, path, { query, body } = {}) {
  const token = await getGenesysToken(org.id, org.region, org.clientId, org.clientSecret);
  let url = `https://api.${org.region}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body && method.toUpperCase() !== "GET") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (resp.status === 204) return null;
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok) {
    const err = new Error(json.message || json.error || `${method} ${path} → ${resp.status}`);
    err.status = resp.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function fetchAllPages(org, path, { query = {}, entitiesKey = "entities", pageSize = 100 } = {}) {
  let page = 1;
  let all = [];
  while (true) {
    const resp = await gcFetch(org, "GET", path, {
      query: { ...query, pageSize: String(pageSize), pageNumber: String(page) },
    });
    const items = resp[entitiesKey] || [];
    all = all.concat(items);
    if (items.length < pageSize || page >= (resp.pageCount ?? page)) break;
    page++;
  }
  return all;
}

// ── Divisions ───────────────────────────────────────────
const listDivisions = (org) =>
  fetchAllPages(org, "/api/v2/authorization/divisions");

// ── Data tables ─────────────────────────────────────────
const listDataTables = (org) =>
  fetchAllPages(org, "/api/v2/flows/datatables", { query: { expand: "schema" } });

const getDataTable = (org, id) =>
  gcFetch(org, "GET", `/api/v2/flows/datatables/${id}`, { query: { expand: "schema" } });

const createDataTable = (org, body) =>
  gcFetch(org, "POST", "/api/v2/flows/datatables", { body });

const fetchDataTableRows = (org, tableId) =>
  fetchAllPages(org, `/api/v2/flows/datatables/${tableId}/rows`, { query: { showbrief: "false" } });

const createDataTableRow = (org, tableId, row) =>
  gcFetch(org, "POST", `/api/v2/flows/datatables/${tableId}/rows`, { body: row });

// ── Data actions ────────────────────────────────────────
const listDataActions = (org) =>
  fetchAllPages(org, "/api/v2/integrations/actions", { query: { includeAuthActions: "false" } });

const getDataAction = (org, id) =>
  gcFetch(org, "GET", `/api/v2/integrations/actions/${id}`, { query: { expand: "contract" } });

const createDataAction = (org, body) =>
  gcFetch(org, "POST", "/api/v2/integrations/actions", { body });

const listIntegrations = (org) =>
  fetchAllPages(org, "/api/v2/integrations");

module.exports = {
  gcFetch,
  fetchAllPages,
  listDivisions,
  listDataTables,
  getDataTable,
  createDataTable,
  fetchDataTableRows,
  createDataTableRow,
  listDataActions,
  getDataAction,
  createDataAction,
  listIntegrations,
};
