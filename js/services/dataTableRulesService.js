/**
 * Data table rules — the client side of /api/datatable-rules.
 *
 * What a Supervisor may write into a data table, per column and per table
 * (docs/data-table-rules-design.md). Set by Administrators on Data Tables ›
 * Edit; read by Data Tables › Supervisor. Who may set is decided by the
 * server from the caller's own row; a customer's customerId is ignored in
 * favour of the verified one.
 */
import { withUserToken } from "./apiAuth.js";

/** The lookup types, in the order the dropdown offers them. */
export const LOOKUP_TYPES = Object.freeze([
  { id: "",              label: "(none)" },
  { id: "dataTable",     label: "Data Table" },
  { id: "queue",         label: "Queue" },
  { id: "skill",         label: "Skill" },
  { id: "scheduleGroup", label: "Schedule Group" },
  { id: "schedule",      label: "Schedule" },
  { id: "group",         label: "Group" },
]);

export const lookupLabel = (id) => (LOOKUP_TYPES.find((t) => t.id === id) || LOOKUP_TYPES[0]).label;

export const EMPTY_RULES = Object.freeze({ columns: {}, mayAddRows: false });

async function call(method, path, body) {
  const resp = await fetch(path, {
    method,
    headers: withUserToken({ "Content-Type": "application/json", Accept: "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(message(json.error, resp.status));
    err.code = json.error || "request_failed";
    err.status = resp.status;
    throw err;
  }
  return json;
}

function message(code, status) {
  switch (code) {
    case "administrator_required": return "Only an Administrator of your organisation can set rules.";
    case "edit_page_required":     return "Setting rules needs the Data Tables › Edit page.";
    case "page_required":          return "You do not have a data-table page.";
    case "tableId_required":       return "Choose a data table first.";
    case "customerId_required":    return "Select a customer organisation first.";
    case "not_a_customer":         return "This organisation is not set up as a customer.";
    case "identity_unavailable":   return "We could not verify who you are just now. Try again in a moment.";
    default:                       return `The request failed (${code || status}).`;
  }
}

/** The rules for one table; EMPTY_RULES when none are set. */
export async function getDataTableRules(customerId, tableId) {
  const r = await call("GET", `/api/datatable-rules?customerId=${encodeURIComponent(customerId)}&tableId=${encodeURIComponent(tableId)}`);
  return r.rules || EMPTY_RULES;
}

/** Overwrite one table's rules. `tableName` is for the log line only. */
export function setDataTableRules(customerId, tableId, rules, tableName = "") {
  return call("PUT", "/api/datatable-rules", { customerId, tableId, rules, tableName });
}
