/**
 * Activity Log Store (runner copy) — write-only.
 *
 * Same table and entity shape as api/lib/activityLogStore.js, reduced to the
 * single operation the runner needs: append one entry. Reads, retention and
 * purging stay with the API.
 *
 * Why a direct table write instead of POST /api/activity-log: that endpoint
 * authenticates the caller from their own Genesys token (X-Genesys-Token), and
 * the runner has none — it wakes up on a timer, minutes after the operator's
 * session is gone. Duplicating the store across the two apps is the same pattern
 * onboardingStore.js already uses.
 *
 * Onboarding is internal-only (the API guards it with requireInternal), so every
 * entry written here is owned by "internal".
 *
 * Requires app setting:
 *   AZURE_STORAGE_CONNECTION_STRING   (same account as the job store)
 */
"use strict";

const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");

const TABLE_NAME = "activitylog";
const INTERNAL_OWNER = "internal";
const MAX_TS = 9_999_999_999_999; // stays valid until ~year 2286

// Azure Table Storage caps a single string property at 32 K characters. Stay
// well under it — the entity carries other properties too, and the whole entity
// is capped at 1 MB.
const MAX_DETAILS_CHARS = 30000;
// Per-phase item caps, tried in order until the payload fits.
const ITEM_CAP_LADDER = [50, 25, 12, 6, 3, 1];

let _client = null;
let _tableEnsured = false;

function getClient() {
  if (!_client) {
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connStr) throw new Error("AZURE_STORAGE_CONNECTION_STRING is not configured.");
    _client = TableClient.fromConnectionString(connStr, TABLE_NAME);
  }
  return _client;
}

async function ensureTable() {
  if (_tableEnsured) return;
  try { await getClient().createTable(); }
  catch (err) { if (err.statusCode !== 409) throw err; } // 409 = already exists
  _tableEnsured = true;
}

/** Build a RowKey that sorts newest entries first. */
function makeRowKey() {
  const inverted = String(MAX_TS - Date.now()).padStart(13, "0");
  return `${inverted}_${crypto.randomUUID()}`;
}

/**
 * Serialize the structured `details` payload to a JSON string that fits in a
 * table property. Oversized payloads are shrunk progressively rather than
 * dropped, so a big deploy still shows its failures.
 *
 * Keep in sync with api/lib/activityLogStore.js — both apps write entries the
 * same reader has to render.
 */
function serializeDetails(details) {
  if (details == null) return "";
  if (typeof details === "string") return details.slice(0, MAX_DETAILS_CHARS);

  let json = JSON.stringify(details);
  if (json.length <= MAX_DETAILS_CHARS) return json;

  const shrunk = JSON.parse(json);
  shrunk.truncated = true;

  // 1) Drop the free-text detail from everything that did not fail.
  for (const p of shrunk.phases || []) {
    for (const i of p.items || []) {
      if (i.status !== "error") delete i.detail;
    }
  }
  json = JSON.stringify(shrunk);
  if (json.length <= MAX_DETAILS_CHARS) return json;

  // 2) Still too big — cap each phase's item list, keeping failures first and
  //    tightening the cap until it fits. A fixed cap isn't enough: a job with
  //    many phases, or one whose failures all keep their detail text, can still
  //    overflow at 50 and would otherwise fall through to the summary-only
  //    fallback, losing every item.
  const fullItems = (shrunk.phases || []).map((p) => p.items || []);
  for (const cap of ITEM_CAP_LADDER) {
    (shrunk.phases || []).forEach((p, idx) => {
      const items = fullItems[idx];
      if (items.length <= cap) {
        p.items = items;
        delete p.omitted;
        return;
      }
      const errors = items.filter((i) => i.status === "error");
      const rest = items.filter((i) => i.status !== "error");
      p.items = [...errors, ...rest].slice(0, cap);
      p.omitted = items.length - p.items.length;
    });
    json = JSON.stringify(shrunk);
    if (json.length <= MAX_DETAILS_CHARS) return json;
  }

  // 3) Last resort — keep the summary and warnings, drop the item lists.
  return JSON.stringify({
    summary: shrunk.summary || null,
    warnings: shrunk.warnings || [],
    truncated: true,
  }).slice(0, MAX_DETAILS_CHARS);
}

/**
 * Append one activity-log entry.
 *
 * @param {object} data  { userEmail, userName, userId, orgId, orgName, action,
 *                         description, result, errorMessage, count, details }
 *                       `details` may be an object (serialized here) or a string.
 */
async function create(data) {
  await ensureTable();
  const entity = {
    partitionKey: "log",
    rowKey: makeRowKey(),
    logTimestamp: data.logTimestamp || new Date().toISOString(),
    userId: data.userId || "",
    userEmail: data.userEmail || "",
    userName: data.userName || "",
    orgId: data.orgId || "",
    orgName: data.orgName || "",
    ownerOrgId: INTERNAL_OWNER,
    action: data.action || "",
    description: data.description || "",
    result: data.result || "success",
    errorMessage: data.errorMessage || null,
    count: data.count ?? null,
    details: serializeDetails(data.details),
  };
  await getClient().createEntity(entity);
  return entity;
}

module.exports = { create, serializeDetails, MAX_DETAILS_CHARS };
