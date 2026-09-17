/**
 * Data table rules — what a Supervisor may write into a data table.
 *
 * An Administrator sets, per column, a lookup (the value must be the name
 * of a queue, skill, schedule group, schedule or group in the org, or a key
 * of another data table), Protected (cannot change), Mandatory (cannot
 * be empty) and Hidden (not shown — and so not changeable either); per
 * table, whether it is open to Supervisors at all, and whether they may add
 * rows. Supervisors never delete rows. A table nobody has opened is closed:
 * the Supervisor page does not list it, and a write to it is refused.
 * (docs/data-table-rules-design.md §2). The browser guides; this holds the
 * line for a Supervisor who calls the proxy directly (§7).
 *
 * The check costs one read of the current row per row write (Protected,
 * and to know which cells changed), and one by-name or by-key read per
 * changed lookup cell — exact, and cheap enough to be exact.
 */

const LOOKUPS = new Set(["dataTable", "queue", "skill", "scheduleGroup", "schedule", "group"]);
const ROWS_PATH = /^\/api\/v2\/flows\/datatables\/([^/?]+)\/rows(?:\/([^/?]+))?\/?$/i;

/** The stored shape, from whatever a PUT sent. Junk is dropped, never kept. */
function normalizeRules(input) {
  const src = input && typeof input === "object" ? input : {};
  const columns = {};
  const cols = src.columns && typeof src.columns === "object" ? src.columns : {};
  for (const [name, raw] of Object.entries(cols)) {
    const key = String(name || "").trim();
    if (!key || !raw || typeof raw !== "object") continue;
    let lookup = LOOKUPS.has(raw.lookup) ? raw.lookup : "";
    const tableId = lookup === "dataTable" ? String(raw.tableId || "").trim() : "";
    if (lookup === "dataTable" && !tableId) lookup = "";
    const rule = {
      lookup,
      ...(tableId ? { tableId } : {}),
      protected: raw.protected === true,
      mandatory: raw.mandatory === true,
      hidden:    raw.hidden === true,
    };
    if (rule.lookup || rule.protected || rule.mandatory || rule.hidden) columns[key] = rule;
  }
  return {
    columns,
    visibleToSupervisors: src.visibleToSupervisors === true,
    mayAddRows: src.mayAddRows === true,
  };
}

const EMPTY_RULES = Object.freeze(normalizeRules({}));

/** Is this a data table row write, and of which table and key? */
function parseRowWrite(method, path) {
  const m = ROWS_PATH.exec(String(path || ""));
  if (!m) return null;
  const verb = String(method || "").toUpperCase();
  if (!["POST", "PUT", "DELETE"].includes(verb)) return null;
  let key = null;
  if (m[2] != null) { try { key = decodeURIComponent(m[2]); } catch { key = m[2]; } }
  return { tableId: m[1], key, verb };
}

const isEmpty = (v) => v == null || (typeof v === "string" && v.trim() === "");
const same = (a, b) => String(a ?? "") === String(b ?? "");

/**
 * Does the value exist under this lookup? One read, exact match on the
 * name (Genesys's name filters are prefix or contains filters).
 * @param {(method: string, path: string, opts?: { query?: object, body?: object }) => Promise<{status:number, body:any}>} read
 */
async function lookupExists(read, rule, value) {
  const v = String(value);
  const exact = (list) => Array.isArray(list) && list.some((e) => e && same(e.name, v));
  switch (rule.lookup) {
    case "dataTable": {
      const r = await read("GET", `/api/v2/flows/datatables/${encodeURIComponent(rule.tableId)}/rows/${encodeURIComponent(v)}`);
      return r.status === 200;
    }
    case "queue": {
      const r = await read("GET", "/api/v2/routing/queues", { query: { name: v, pageSize: "100" } });
      return r.status === 200 && exact(r.body && r.body.entities);
    }
    case "skill": {
      const r = await read("GET", "/api/v2/routing/skills", { query: { name: v, pageSize: "100" } });
      return r.status === 200 && exact(r.body && r.body.entities);
    }
    case "scheduleGroup": {
      const r = await read("GET", "/api/v2/architect/schedulegroups", { query: { name: v, pageSize: "100" } });
      return r.status === 200 && exact(r.body && r.body.entities);
    }
    case "schedule": {
      const r = await read("GET", "/api/v2/architect/schedules", { query: { name: v, pageSize: "100" } });
      return r.status === 200 && exact(r.body && r.body.entities);
    }
    case "group": {
      const r = await read("POST", "/api/v2/groups/search", {
        body: { pageSize: 100, pageNumber: 1, query: [{ type: "EXACT", fields: ["name"], value: v }] },
      });
      return r.status === 200 && exact(r.body && r.body.results);
    }
    default:
      return true;
  }
}

/**
 * Check one row write against the table's rules.
 *
 * @param {{ verb: string, key: string|null, body: object }} write
 * @param {object} rules      normalized
 * @param {Function} read     see lookupExists
 * @param {string} tableId
 * @returns {Promise<{ ok: true } | { ok: false, error: string, detail: string, column?: string }>}
 */
async function checkRowWrite(write, rules, read, tableId) {
  const refuse = (detail, column) => ({ ok: false, error: "datatable_rule", detail, ...(column ? { column } : {}) });
  const { verb } = write;

  if (verb === "DELETE") {
    return refuse("Supervisors cannot delete rows.");
  }
  if (!rules.visibleToSupervisors) {
    return refuse("This table is not open to Supervisors.");
  }
  if (verb === "POST" && !rules.mayAddRows) {
    return refuse("Supervisors may not add rows to this table.");
  }

  const body = write.body && typeof write.body === "object" ? write.body : {};
  const cols = Object.entries(rules.columns);
  if (!cols.length) return { ok: true };

  // The current row, for Protected and for knowing what changed.
  let current = null;
  if (verb === "PUT") {
    const r = await read("GET", `/api/v2/flows/datatables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(write.key ?? "")}`, { query: { showbrief: "false" } });
    if (r.status === 200 && r.body && typeof r.body === "object") current = r.body;
    else if (r.status === 404) return refuse("The row no longer exists.");
    else return refuse("The current row could not be read, so the change was not made. Try again.");
  }

  for (const [name, rule] of cols) {
    const has = Object.prototype.hasOwnProperty.call(body, name);
    const next = has ? body[name] : (current ? current[name] : undefined);
    const changed = current ? (has && !same(next, current[name])) : has;

    if ((rule.protected || rule.hidden) && current && changed) {
      return refuse(`"${name}" is ${rule.hidden ? "hidden from Supervisors" : "protected"} and cannot be changed.`, name);
    }
    if (rule.hidden && !current && has && !isEmpty(next)) {
      // A new row: a hidden column takes the table's default, never a value.
      return refuse(`"${name}" is hidden from Supervisors and cannot be set.`, name);
    }
    if (rule.mandatory && isEmpty(next)) {
      return refuse(`"${name}" is mandatory and cannot be empty.`, name);
    }
    if (rule.lookup && changed && !isEmpty(next)) {
      if (!(await lookupExists(read, rule, next))) {
        return refuse(`"${name}" must be one of the allowed values; "${next}" is not.`, name);
      }
    }
  }
  return { ok: true };
}

module.exports = { LOOKUPS, normalizeRules, EMPTY_RULES, parseRowWrite, checkRowWrite, lookupExists };
