/**
 * Utilities — Permission Catalog (internal, admin-only)
 *
 * Dumps the FULL live Genesys permission catalog for the selected org so we can
 * build/verify the feature → write-permission map (see docs/customer-facing-plan.md).
 *
 * Read-only. Reuses the same endpoint the Roles pages already call:
 *   GET /api/v2/authorization/permissions?pageSize=100&pageNumber=N   (paginated)
 *
 * Each catalog entry has a `domain` and a `permissionMap` of
 *   { entityName: [ { action, label, ... }, ... ] }
 * which we flatten to one row per `domain:entity:action`.
 */
import { escapeHtml, exportXlsx, timestampedFilename } from "../../utils.js";
import { orgContext } from "../../services/orgContext.js";

// ── Fetch & flatten the permission catalog ────────────────────────────
async function fetchPermissionRows(api, orgId) {
  const rows = [];
  let page = 1;
  let pageCount = null;
  do {
    const resp = await api.proxyGenesys(orgId, "GET", "/api/v2/authorization/permissions", {
      query: { pageSize: "100", pageNumber: String(page) },
    });
    pageCount = resp.pageCount ?? 1;
    for (const p of (resp.entities || [])) {
      if (!p.domain || !p.permissionMap) continue;
      for (const [entity, actionList] of Object.entries(p.permissionMap)) {
        for (const a of (actionList || [])) {
          if (!a || !a.action) continue;
          rows.push({
            domain: p.domain,
            entity,
            action: a.action,
            permission: `${p.domain}:${entity}:${a.action}`,
            label: a.label || "",
          });
        }
      }
    }
    page++;
  } while (page <= pageCount);

  rows.sort((x, y) => x.permission.localeCompare(y.permission));
  return rows;
}

// ── Scoped styles ─────────────────────────────────────────────────────
const PAGE_STYLES = `
.pc-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.pc-header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pc-filters { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 12px; align-items: flex-end; }
.pc-status { font-size: 13px; color: var(--muted); margin: 12px 0; }
.pc-status--error { color: #f87171; }
.pc-summary { font-size: 13px; color: var(--muted); margin: 8px 0 12px; }
.pc-actions-row { display: flex; gap: 8px; margin: 8px 0 12px; flex-wrap: wrap; align-items: center; }
.pc-copied { color: #4ade80; font-size: 12px; margin-left: 8px; }
.pc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.pc-table th, .pc-table td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
.pc-table th { font-weight: 600; color: var(--muted); cursor: pointer; user-select: none; white-space: nowrap; position: sticky; top: 0; background: var(--card, #1a1a1a); }
.pc-table th[data-sort]:hover { color: #fff; }
.pc-table td.pc-perm { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.pc-table-wrap { max-height: 62vh; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.pc-empty { padding: 20px; text-align: center; color: var(--muted); font-size: 13px; }
`;

// ── Page renderer ─────────────────────────────────────────────────────
export default async function renderPermissionCatalog(ctx = {}) {
  const { api } = ctx;
  const el = document.createElement("section");
  el.className = "card";

  const styleTag = document.createElement("style");
  styleTag.textContent = PAGE_STYLES;
  el.appendChild(styleTag);

  el.insertAdjacentHTML("beforeend", `
    <div class="pc-header">
      <div>
        <h2 class="h2">Permission Catalog</h2>
        <p class="page-desc">
          Full list of Genesys Cloud permissions (<code>domain:entity:action</code>) available in the
          selected org. Internal tool for building and verifying the feature → permission map.
          Source: <code>GET /api/v2/authorization/permissions</code>.
        </p>
      </div>
      <div class="pc-header-actions">
        <button class="btn" id="pcRefreshBtn">Refresh</button>
      </div>
    </div>

    <hr class="hr">

    <div class="pc-filters">
      <div class="di-control-group" style="flex: 1; min-width: 280px;">
        <label class="di-label" for="pcSearch">Filter</label>
        <input type="text" class="input" id="pcSearch" placeholder="e.g. authorization:role or datatable or edit">
      </div>
    </div>

    <p class="pc-status" id="pcStatus">Loading…</p>

    <div class="pc-actions-row" id="pcActionsRow" style="display:none">
      <button class="btn" id="pcCopyBtn">Copy permissions</button>
      <button class="btn" id="pcExportBtn">Export to Excel</button>
      <span class="pc-copied" id="pcCopied" style="display:none">Copied!</span>
    </div>

    <div class="pc-summary" id="pcSummary" style="display:none"></div>

    <div id="pcResults"></div>
  `);

  // ── DOM refs ─────────────────────────────────────────
  const $search  = el.querySelector("#pcSearch");
  const $status  = el.querySelector("#pcStatus");
  const $results = el.querySelector("#pcResults");
  const $summary = el.querySelector("#pcSummary");
  const $actions = el.querySelector("#pcActionsRow");
  const $refresh = el.querySelector("#pcRefreshBtn");
  const $copy    = el.querySelector("#pcCopyBtn");
  const $copied  = el.querySelector("#pcCopied");
  const $export  = el.querySelector("#pcExportBtn");

  // ── State ────────────────────────────────────────────
  let allRows = [];
  let sortKey = "permission";
  let sortDir = "asc";

  function setStatus(msg, kind) {
    $status.textContent = msg;
    $status.className = "pc-status" + (kind === "error" ? " pc-status--error" : "");
    $status.style.display = msg ? "block" : "none";
  }

  function filteredRows() {
    const q = $search.value.trim().toLowerCase();
    let rows = allRows;
    if (q) {
      rows = rows.filter((r) =>
        r.permission.toLowerCase().includes(q) ||
        (r.label && r.label.toLowerCase().includes(q))
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) =>
      dir * String(a[sortKey]).localeCompare(String(b[sortKey]))
    );
  }

  function render() {
    if (!allRows.length) return;
    const rows = filteredRows();

    const domains = new Set(allRows.map((r) => r.domain));
    const entities = new Set(allRows.map((r) => `${r.domain}:${r.entity}`));
    $summary.style.display = "block";
    $summary.textContent =
      `Domains: ${domains.size} · Entities: ${entities.size} · Permissions: ${allRows.length}` +
      (rows.length !== allRows.length ? ` · Showing ${rows.length}` : "");

    if (!rows.length) {
      $results.innerHTML = `<div class="pc-empty">No permissions match the filter.</div>`;
      return;
    }

    const arrow = (key) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");
    $results.innerHTML = `
      <div class="pc-table-wrap">
        <table class="pc-table">
          <thead>
            <tr>
              <th data-sort="domain">Domain${arrow("domain")}</th>
              <th data-sort="entity">Entity${arrow("entity")}</th>
              <th data-sort="action">Action${arrow("action")}</th>
              <th data-sort="permission">Permission${arrow("permission")}</th>
              <th data-sort="label">Label${arrow("label")}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${escapeHtml(r.domain)}</td>
                <td>${escapeHtml(r.entity)}</td>
                <td>${escapeHtml(r.action)}</td>
                <td class="pc-perm">${escapeHtml(r.permission)}</td>
                <td>${escapeHtml(r.label)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    $results.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (sortKey === key) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortKey = key;
          sortDir = "asc";
        }
        render();
      });
    });
  }

  async function load() {
    const org = orgContext?.getDetails?.();
    if (!org) {
      allRows = [];
      $actions.style.display = "none";
      $summary.style.display = "none";
      $results.innerHTML = "";
      setStatus("Please select a customer org first.", "error");
      return;
    }

    setStatus(`Loading permission catalog for ${org.name}…`);
    $actions.style.display = "none";
    $summary.style.display = "none";
    $results.innerHTML = "";
    $refresh.disabled = true;

    try {
      allRows = await fetchPermissionRows(api, org.id);
      if (!allRows.length) {
        setStatus("No permissions returned for this org.", "error");
        return;
      }
      setStatus("");
      $actions.style.display = "flex";
      render();
    } catch (err) {
      console.error("[permissionCatalog] load failed:", err);
      setStatus(`Failed to load permission catalog: ${err?.message || err}`, "error");
    } finally {
      $refresh.disabled = false;
    }
  }

  // ── Wiring ───────────────────────────────────────────
  let searchTimer = null;
  $search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 120);
  });

  $refresh.addEventListener("click", load);

  $copy.addEventListener("click", () => {
    const text = filteredRows().map((r) => r.permission).join("\n");

    const finish = (ok) => {
      if (ok) {
        $copied.style.display = "inline";
        setTimeout(() => { $copied.style.display = "none"; }, 1500);
      } else {
        setStatus("Copy failed — clipboard not available.", "error");
      }
    };

    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); finish(true); }
      catch { finish(false); }
      document.body.removeChild(ta);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => finish(true)).catch(fallback);
    } else {
      fallback();
    }
  });

  $export.addEventListener("click", () => {
    const org = orgContext?.getDetails?.();
    const rows = filteredRows();
    if (!rows.length) return;
    const sheets = [{
      name: "Permissions",
      rows,
      columns: [
        { key: "domain",     label: "Domain",     wch: 24 },
        { key: "entity",     label: "Entity",     wch: 32 },
        { key: "action",     label: "Action",     wch: 20 },
        { key: "permission", label: "Permission", wch: 56 },
        { key: "label",      label: "Label",      wch: 48 },
      ],
    }];
    const prefix = `Permission_Catalog_${(org?.name || "org").replace(/[^\w]+/g, "_")}`;
    try {
      exportXlsx(sheets, timestampedFilename(prefix, "xlsx"));
    } catch (err) {
      setStatus(err?.message || "Export failed.", "error");
    }
  });

  // Initial load
  load();

  return el;
}
