/**
 * Data Tables › Supervisor — row editing under the Administrator's rules.
 *
 * The Edit page's Rows grid, with the table's rules applied
 * (docs/data-table-rules-design.md §6):
 *
 *   - a column with a lookup is a dropdown of the allowed values — the
 *     names of the org's queues, skills, schedule groups, schedules or
 *     groups, or the keys of another table — so nothing is typed;
 *   - a Protected column is text, not an input;
 *   - a Hidden column is not shown at all — its value rides along unchanged
 *     when the row is saved;
 *   - a Mandatory column cannot be left empty; the row's status says which;
 *   - the key column is always protected on an existing row;
 *   - Add row appears only when the table's rules allow it; rows are never
 *     deleted here;
 *   - a Supervisor sees only the tables on their own row, chosen with the
 *     page on the users list (§11); an Administrator every table opened to
 *     Supervisors.
 *
 * A current value that is not in the list (a queue since deleted, a value
 * typed before the rule existed) is shown as an extra option marked so, and
 * can be left alone; the moment the cell is changed, only listed values
 * remain. The server checks every write again (§7), so what this page
 * refuses is refused, not merely hidden.
 *
 * No Schema mode, no table metadata — the table picker and the rows.
 */
import { escapeHtml, makeStatus, withBusy } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import { logAction } from "../../services/activityLogService.js";
import { createSingleSelect } from "../../components/multiSelect.js";
import { getDataTableRules, listDataTableRules, EMPTY_RULES } from "../../services/dataTableRulesService.js";
import { fetchAllLookupValues, clearLookupCache } from "../../lib/dataTableLookups.js";

const NOT_LISTED = "__not_listed__";   // the marker option's value: never a real value

export default function renderSupervisorDataTable({ me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";
  el.innerHTML = `
    <style>
      .dts-grid-wrap { width: 100%; overflow-x: auto; transform: rotateX(180deg); }
      .dts-grid-wrap > .dts-grid { transform: rotateX(180deg); }
      .dts-grid { width: 100%; min-width: 900px; border-collapse: collapse; table-layout: auto; }
      .dts-grid thead th { text-align: left; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--bg, var(--panel)); white-space: nowrap; vertical-align: bottom; }
      .dts-grid th.dts-col, .dts-grid td.dts-col { min-width: 150px; }
      .dts-grid tbody td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
      .dts-grid .dt-input, .dts-grid .dt-select { width: 100%; box-sizing: border-box; max-width: none; }
      .dts-grid tr.dts-row-dirty { background: color-mix(in srgb, var(--accent-strong) 8%, transparent); }
      .dts-grid tr.dts-row-invalid { background: color-mix(in srgb, var(--danger-strong) 8%, transparent); }
      .dts-row-status { font-size: 11px; color: var(--muted); }
      .dts-row-status--error { color: var(--danger); }
      .dts-protected { color: var(--text); font-size: 13px; padding: 6px 0; display: block; }
      .dts-toolbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
      .dts-toolbar-left, .dts-toolbar-right { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
      .dts-toolbar-left { flex: 1 1 520px; }
      .dts-search { min-width: 240px; flex: 0 1 420px; }
      .dts-pager { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
      .dts-pager-info { font-size: 12px; color: var(--muted); }
      .dts-not-listed { color: var(--warn); }
    </style>

    <h2>Data Tables — Supervisor</h2>
    <p class="page-desc">
      Edit the values of a data table. Where the table has rules, a column offers only the allowed
      values, cannot be changed, or cannot be left empty — so nothing is misspelled and nothing is
      changed that should not be.
    </p>

    <div class="dt-controls" style="margin-bottom:12px">
      <div class="dt-control-group" style="flex:1;max-width:420px">
        <label class="dt-label" for="dtsTableSelect">Data Table</label>
        <div id="dtsTableSelectHost"></div>
      </div>
    </div>

    <div class="dt-actions" id="dtsActions" hidden>
      <button class="btn btn-secondary" id="dtsUndoBtn" disabled>Undo All</button>
      <button class="btn" id="dtsSaveBtn" disabled>Save Changes</button>
    </div>

    <div id="dtsStatus" class="dt-status"></div>

    <div id="dtsBody" hidden>
      <div class="dts-toolbar">
        <div class="dts-toolbar-left">
          <div class="dt-control-group dts-search">
            <label class="dt-label" for="dtsSearch">Search all fields</label>
            <input class="dt-input" id="dtsSearch" type="text" placeholder="Type to filter rows" autocomplete="off" />
          </div>
          <div class="dt-control-group" style="align-self:flex-end">
            <button class="btn" id="dtsAddBtn" type="button" hidden>Add Row</button>
          </div>
        </div>
        <div class="dts-toolbar-right">
          <div class="dt-control-group" style="min-width:120px">
            <label class="dt-label" for="dtsPageSize">Rows per page</label>
            <select class="dt-select" id="dtsPageSize">
              <option value="25">25</option><option value="50" selected>50</option><option value="100">100</option><option value="250">250</option>
            </select>
          </div>
          <div class="dt-control-group" style="align-self:flex-end">
            <button class="btn btn-secondary" id="dtsRefreshBtn" type="button">Refresh</button>
          </div>
        </div>
      </div>
      <div id="dtsGrid"></div>
      <div class="dts-pager">
        <button class="btn btn-secondary btn-sm" id="dtsPrev" type="button">Prev</button>
        <span class="dts-pager-info" id="dtsPagerInfo">Page 1/1</span>
        <button class="btn btn-secondary btn-sm" id="dtsNext" type="button">Next</button>
        <span class="dts-pager-info" id="dtsSummary"></span>
      </div>
    </div>
  `;

  const $ = (id) => el.querySelector("#" + id);
  const $actions = $("dtsActions"), $undoBtn = $("dtsUndoBtn"), $saveBtn = $("dtsSaveBtn");
  const $body = $("dtsBody"), $search = $("dtsSearch"), $addBtn = $("dtsAddBtn");
  const $pageSize = $("dtsPageSize"), $refreshBtn = $("dtsRefreshBtn");
  const $grid = $("dtsGrid"), $prev = $("dtsPrev"), $next = $("dtsNext"), $pagerInfo = $("dtsPagerInfo"), $summary = $("dtsSummary");
  const setStatus = makeStatus($("dtsStatus"), "dt-status");

  const can = (action) => !access || !access.can || access.can("data-tables.supervisor", action);

  // ── State ──────────────────────────────────────────────────────────
  let tableId = null, table = null, columns = [], rules = EMPTY_RULES;
  let lookups = {};            // column name → allowed values
  let lookupFailed = {};       // column name → error
  let models = [], nextId = 1, page = 1, search = "";
  let loadSeq = 0;

  const rule = (name) => rules.columns[name] || null;
  const isEmpty = (v) => v == null || String(v).trim() === "";
  const visibleColumns = () => columns.filter((c) => !(rule(c.name) && rule(c.name).hidden));

  // ── Table picker ───────────────────────────────────────────────────
  const tableSelect = createSingleSelect({
    placeholder: "Select a data table…",
    searchable: true,
    onChange: (id) => load(id || null),
  });
  $("dtsTableSelectHost").append(tableSelect.el);

  async function loadTables() {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("Please select a customer org first.", "error"); return; }
    tableSelect.setEnabled(false);
    setStatus("Loading data tables…");
    try {
      // Only the tables an Administrator has opened to Supervisors — and,
      // for a Supervisor, only the ones on their own row (§11). The server
      // refuses the rest anyway; this keeps the picker honest.
      const [tables, allRules] = await Promise.all([gc.fetchAllDataTables(api, orgId), listDataTableRules(orgId)]);
      const own = access && Array.isArray(access.dataTables) ? new Set(access.dataTables) : null;
      const open = (tables || []).filter((t) => allRules[t.id] && allRules[t.id].visibleToSupervisors && (!own || own.has(t.id)));
      const sorted = open.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      tableSelect.setItems(sorted.map((t) => ({ id: t.id, label: t.name })));
      setStatus(sorted.length ? "" : (own
        ? "No data table has been given to you. An Administrator chooses which data tables a Supervisor may open, on the users list."
        : "No data table has been made visible to Supervisors in this org. An Administrator opens one on Data Tables › Edit."));
    } catch (err) {
      setStatus(`Failed to load data tables: ${err.message}`, "error");
      tableSelect.setItems([]);
    } finally {
      tableSelect.setEnabled(true);
    }
  }

  // ── Loading a table: schema, rules, rows and the lookup values ────
  function orderedColumns() {
    const props = table?.schema?.properties || {};
    return Object.entries(props)
      .map(([name, def]) => ({ name, title: def?.title || name, type: def?.type || "string", order: name === "key" ? -1 : (def?.displayOrder ?? 9999) }))
      .sort((a, b) => a.order - b.order);
  }

  function uiValue(type, v) {
    if (type === "boolean") return v === true;
    return v == null ? "" : String(v);
  }

  function toModel(row) {
    const data = {};
    for (const c of columns) data[c.name] = uiValue(c.type, row?.[c.name]);
    if (!("key" in data)) data.key = row?.key == null ? "" : String(row.key);
    return { id: nextId++, originalKey: String(row?.key ?? ""), originalData: JSON.parse(JSON.stringify(data)), data, isNew: false, isDirty: false, status: "Clean" };
  }

  async function load(id) {
    const orgId = orgContext.get();
    const seq = ++loadSeq;
    tableId = id; table = null; models = []; search = ""; $search.value = ""; page = 1;
    if (!id || !orgId) { $body.hidden = true; $actions.hidden = true; setStatus(""); return; }
    setStatus("Loading the table, its rules and the allowed values…");
    try {
      const [t, r] = await Promise.all([gc.getDataTable(api, orgId, id), getDataTableRules(orgId, id)]);
      if (seq !== loadSeq) return;
      table = t; rules = r || EMPTY_RULES; columns = orderedColumns();
      const [rows, lk] = await Promise.all([
        gc.fetchDataTableRows(api, orgId, id, { query: { showbrief: "false" } }),
        fetchAllLookupValues(api, orgId, rules),
      ]);
      if (seq !== loadSeq) return;
      lookups = lk.values; lookupFailed = lk.failed;
      models = (Array.isArray(rows) ? rows : []).map(toModel);
      $addBtn.hidden = !rules.mayAddRows || !can("rowsAdd");
      $body.hidden = false; $actions.hidden = false;
      render();
      const failed = Object.keys(lookupFailed);
      setStatus(failed.length
        ? `Rows loaded (${models.length}). The allowed values for ${failed.map((n) => `"${colTitle(n)}"`).join(", ")} could not be loaded, so those columns cannot be changed until Refresh succeeds.`
        : `Rows loaded (${models.length}).`, failed.length ? "error" : "success");
    } catch (err) {
      if (seq !== loadSeq) return;
      setStatus(`Failed to load: ${err.message}`, "error");
      $body.hidden = true; $actions.hidden = true;
    }
  }

  const colTitle = (name) => (columns.find((c) => c.name === name) || { title: name }).title;

  // ── The grid ───────────────────────────────────────────────────────
  function filtered() {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => visibleColumns().some((c) => String(m.data[c.name] ?? "").toLowerCase().includes(q)));
  }

  /** Why this row cannot be saved, or "". */
  function invalidReason(m) {
    for (const c of columns) {
      const r = rule(c.name);
      if (!r) continue;
      const v = m.data[c.name];
      if (r.mandatory && c.type !== "boolean" && isEmpty(v)) return `Mandatory: ${c.title}`;
      if (r.lookup && !isEmpty(v) && lookups[c.name] && !lookups[c.name].includes(String(v))) {
        // A pre-existing value outside the list may stay; a changed one may not.
        const changed = m.isNew || String(v) !== String(m.originalData[c.name] ?? "");
        if (changed) return `Not an allowed value: ${c.title}`;
      }
    }
    if (m.isNew && isEmpty(m.data.key)) return "Key is required";
    return "";
  }

  function cell(m, c, idx) {
    const r = rule(c.name);
    const v = m.data[c.name];
    const inputId = `dts-${m.id}-${idx}`;
    const attrs = `data-row-id="${m.id}" data-col="${escapeHtml(c.name)}" data-type="${escapeHtml(c.type)}"`;
    const isKey = c.name === "key";
    const protectedNow = (r && r.protected) || (isKey && !m.isNew);
    if (protectedNow) {
      return `<span class="dts-protected" title="Protected">${c.type === "boolean" ? (v === true ? "true" : "false") : escapeHtml(String(v ?? ""))}</span>`;
    }
    if (c.type === "boolean") {
      return `<label class="dtc-bool-wrap" for="${inputId}"><input id="${inputId}" type="checkbox" ${attrs} ${v === true ? "checked" : ""}><span class="dtc-bool-label">${v === true ? "true" : "false"}</span></label>`;
    }
    if (r && r.lookup) {
      const list = lookups[c.name];
      if (!list) return `<span class="dts-protected" title="${escapeHtml(lookupFailed[c.name] || "Allowed values not loaded")}">${escapeHtml(String(v ?? ""))}</span>`;
      const cur = String(v ?? "");
      const listed = cur === "" || list.includes(cur);
      const opts = [];
      if (!r.mandatory || cur === "") opts.push(`<option value="" ${cur === "" ? "selected" : ""}>${r.mandatory ? "— choose —" : "(empty)"}</option>`);
      if (!listed) opts.push(`<option value="${NOT_LISTED}" selected class="dts-not-listed">${escapeHtml(cur)} (current value, not in the list)</option>`);
      for (const o of list) opts.push(`<option value="${escapeHtml(o)}" ${o === cur ? "selected" : ""}>${escapeHtml(o)}</option>`);
      return `<select id="${inputId}" class="dt-select" ${attrs} data-current="${escapeHtml(cur)}">${opts.join("")}</select>`;
    }
    const inputType = (c.type === "integer" || c.type === "number") ? "number" : "text";
    const step = c.type === "integer" ? 'step="1"' : (c.type === "number" ? 'step="any"' : "");
    return `<input id="${inputId}" class="dt-input" type="${inputType}" ${step} ${attrs} value="${escapeHtml(String(v ?? ""))}" autocomplete="off">`;
  }

  function render() {
    const all = filtered();
    const size = Number($pageSize.value) || 50;
    const pages = Math.max(1, Math.ceil(all.length / size));
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    const rows = all.slice((page - 1) * size, page * size);
    $summary.textContent = `${all.length} of ${models.length} rows`;
    $pagerInfo.textContent = `Page ${page}/${pages}`;
    $prev.disabled = page <= 1; $next.disabled = page >= pages;

    if (!rows.length) { $grid.innerHTML = `<div class="dt-status">No rows match your search.</div>`; validate(); return; }

    const shown = visibleColumns();
    const head = shown.map((c) => `<th class="dts-col">${escapeHtml(c.title)}${(rule(c.name)?.mandatory || c.name === "key") ? " *" : ""}</th>`).join("");
    const body = rows.map((m) => {
      const reason = invalidReason(m);
      const status = reason || m.status || (m.isNew ? "New row" : (m.isDirty ? "Pending changes" : "Clean"));
      const cls = reason && m.isDirty ? "dts-row-invalid" : (m.isDirty ? "dts-row-dirty" : "");
      return `<tr class="${cls}">
        ${shown.map((c, i) => `<td class="dts-col" data-label="${escapeHtml(c.title)}">${cell(m, c, i)}</td>`).join("")}
        <td><span class="dts-row-status ${reason && m.isDirty ? "dts-row-status--error" : ""}">${escapeHtml(status)}</span></td>
      </tr>`;
    }).join("");
    $grid.innerHTML = `<div class="dts-grid-wrap"><table class="dts-grid"><thead><tr>${head}<th>Status</th></tr></thead><tbody>${body}</tbody></table></div>`;
    validate();
  }

  function validate() {
    const dirty = models.filter((m) => m.isDirty);
    const invalid = dirty.filter((m) => invalidReason(m));
    $undoBtn.disabled = !dirty.length;
    $saveBtn.disabled = !dirty.length || invalid.length > 0 || !can("rowsEdit");
    $saveBtn.textContent = dirty.length ? `Save Changes (${dirty.length}${invalid.length ? `, ${invalid.length} invalid` : ""})` : "Save Changes";
  }

  // ── Editing ────────────────────────────────────────────────────────
  $grid.addEventListener("input", onEdit);
  $grid.addEventListener("change", onEdit);

  function onEdit(e) {
    const t = e.target;
    const id = t.getAttribute("data-row-id");
    if (!id) return;
    const m = models.find((x) => x.id === Number(id));
    if (!m) return;
    const col = t.getAttribute("data-col"), type = t.getAttribute("data-type");
    let value;
    if (type === "boolean") {
      value = !!t.checked;
      const lbl = t.nextElementSibling; if (lbl) lbl.textContent = value ? "true" : "false";
    } else if (t.tagName === "SELECT") {
      if (t.value === NOT_LISTED) return;          // still the old value: nothing changed
      value = t.value;
      // Once changed, the marker option goes: only listed values remain.
      const marker = t.querySelector(`option[value="${NOT_LISTED}"]`);
      if (marker) marker.remove();
    } else {
      value = t.value;
    }
    m.data[col] = value;
    m.isDirty = m.isNew || columns.some((c) => String(m.data[c.name] ?? "") !== String(m.originalData[c.name] ?? ""));
    m.status = "";
    const tr = t.closest("tr");
    if (tr) {
      const reason = invalidReason(m);
      tr.className = reason && m.isDirty ? "dts-row-invalid" : (m.isDirty ? "dts-row-dirty" : "");
      const st = tr.querySelector(".dts-row-status");
      if (st) { st.textContent = reason || (m.isNew ? "New row" : (m.isDirty ? "Pending changes" : "Clean")); st.classList.toggle("dts-row-status--error", !!(reason && m.isDirty)); }
    }
    validate();
  }

  $search.addEventListener("input", () => { search = $search.value; page = 1; render(); });
  $pageSize.addEventListener("change", () => { page = 1; render(); });
  $prev.addEventListener("click", () => { page--; render(); });
  $next.addEventListener("click", () => { page++; render(); });
  $refreshBtn.addEventListener("click", () => {
    if (models.some((m) => m.isDirty) && !window.confirm("Discard unsaved changes and reload?")) return;
    clearLookupCache(orgContext.get());
    load(tableId);
  });
  $undoBtn.addEventListener("click", () => {
    models = models.filter((m) => !m.isNew);
    for (const m of models) { m.data = JSON.parse(JSON.stringify(m.originalData)); m.isDirty = false; m.status = "Clean"; }
    render();
  });

  $addBtn.addEventListener("click", () => {
    const data = {};
    for (const c of columns) {
      const def = table?.schema?.properties?.[c.name]?.default;
      data[c.name] = uiValue(c.type, def);
    }
    data.key = "";
    models.unshift({ id: nextId++, originalKey: "", originalData: JSON.parse(JSON.stringify(data)), data, isNew: true, isDirty: true, status: "New row" });
    page = 1; search = ""; $search.value = "";
    render();
  });

  // ── Saving ─────────────────────────────────────────────────────────
  function payloadOf(m) {
    const out = {};
    for (const c of columns) {
      // A hidden column on a new row takes the table's default: it is left
      // out of the create, never sent. On an existing row it rides along
      // unchanged — the PUT is a full replace.
      if (m.isNew && rule(c.name)?.hidden) continue;
      const raw = m.data[c.name];
      if (c.type === "boolean") { out[c.name] = !!raw; continue; }
      const text = String(raw ?? "").trim();
      if (c.type === "integer" || c.type === "number") {
        if (text === "") { out[c.name] = null; continue; }
        const n = Number(text);
        if (!Number.isFinite(n)) throw new Error(`Invalid number in '${c.title}'.`);
        out[c.name] = c.type === "integer" ? Math.trunc(n) : n;
        continue;
      }
      out[c.name] = String(raw ?? "");
    }
    out.key = String(out.key ?? "").trim();
    if (!out.key) throw new Error("Row key is required.");
    return out;
  }

  $saveBtn.addEventListener("click", () => withBusy($saveBtn, async () => {
    const orgId = orgContext.get();
    const dirty = models.filter((m) => m.isDirty);
    if (!dirty.length) return;
    setStatus(`Saving ${dirty.length} row change(s)…`);
    let ok = 0, fail = 0;
    for (const m of dirty) {
      try {
        const payload = payloadOf(m);
        if (m.isNew) await gc.createDataTableRow(api, orgId, tableId, payload);
        else await gc.putDataTableRow(api, orgId, tableId, m.originalKey, payload);
        m.originalKey = payload.key; m.originalData = JSON.parse(JSON.stringify(m.data));
        m.isNew = false; m.isDirty = false; m.status = "Saved"; ok++;
      } catch (err) {
        m.status = `Error: ${err.message}`; fail++;
      }
    }
    render();
    setStatus(fail ? `Saved ${ok} row(s), ${fail} failed.` : `✓ Saved ${ok} row(s).`, fail ? "error" : "success");
    logAction({ me, orgId, action: "datatable_supervisor", description: `Saved data table rows for '${table?.name || tableId}' (Supervisor). Success: ${ok}, Failed: ${fail}`, result: fail ? "failure" : "success", errorMessage: fail ? `${fail} row(s) failed to save` : undefined });
  }));

  loadTables();
  const unsubscribe = orgContext?.onChange?.(() => { tableSelect.setValue(""); load(null); loadTables(); });
  el.__destroy = () => { unsubscribe?.(); };
  return el;
}
