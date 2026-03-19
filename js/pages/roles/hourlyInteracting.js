/**
 * Hourly Interacting License Analysis
 *
 * Searches for all users holding billing:user:hourlyInteracting and
 * classifies them as:
 *
 *   Hourly  — eligible for Hourly Interacting license
 *             (none of their roles grant a disqualifying permission)
 *   Full CX — requires a full CX license
 *             (at least one role grants a disqualifying permission)
 *
 * Disqualifying permissions are scraped live from the Genesys Cloud help
 * page via an Azure Function endpoint; if the scrape fails the module
 * falls back to the static snapshot in lib/hourlyDisqualifyingPermissions.js.
 *
 * Exported function `renderHourlyContent` is called lazily from search.js
 * when the user toggles to the "Hourly Interacting" mode.
 */

import { escapeHtml, exportXlsx, timestampedFilename } from "../../utils.js";
import {
  fetchAllAuthorizationRoles,
  fetchAllUsers,
} from "../../services/genesysApi.js";
import {
  HOURLY_DISQUALIFYING_PERMISSIONS,
} from "../../lib/hourlyDisqualifyingPermissions.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const BILLING_DOMAIN = "billing";
const BILLING_ENTITY = "user";
const BILLING_ACTION = "hourlyInteracting";
const SCRAPE_ENDPOINT = "/api/scrape-disqualifying-permissions";

// ── Concurrency helper ────────────────────────────────────────────────────────

async function runBatched(tasks, concurrency = 10) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker),
  );
  return results;
}

// ── Disqualifying-permission helpers ──────────────────────────────────────────

async function fetchDisqualifyingPermissions() {
  try {
    const resp = await fetch(SCRAPE_ENDPOINT);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (Array.isArray(data) && data.length > 0) return data;
  } catch {
    /* fall through to static list */
  }
  return [...HOURLY_DISQUALIFYING_PERMISSIONS];
}

/**
 * Build a domain→entity→Set<action> index for fast lookups.
 */
function buildDisqualifyingIndex(permArr) {
  const byDomain = {};
  for (const p of permArr) {
    const [domain, entity, action] = p.split(":");
    if (!byDomain[domain]) byDomain[domain] = {};
    if (!byDomain[domain][entity]) byDomain[domain][entity] = new Set();
    byDomain[domain][entity].add(action);
  }
  return byDomain;
}

/**
 * Does a single permissionPolicy entry match any disqualifying permission?
 * Handles wildcards in the policy's domain / entity / actionSet.
 */
function policyMatchesDisqualifying(policy, byDomain) {
  if (policy.domain === "*") return Object.keys(byDomain).length > 0;
  const domainEntry = byDomain[policy.domain];
  if (!domainEntry) return false;
  if (policy.entityName === "*") return true;
  const entityActions = domainEntry[policy.entityName];
  if (!entityActions) return false;
  if ((policy.actionSet || []).includes("*")) return true;
  return (policy.actionSet || []).some((a) => entityActions.has(a));
}

function roleHasDisqualifying(role, byDomain) {
  return (role.permissionPolicies || []).some((p) =>
    policyMatchesDisqualifying(p, byDomain),
  );
}

/**
 * Collect every concrete disqualifying permission matched by a role's
 * policies (expanding wildcards).
 */
function getDisqualifyingFromRole(role, byDomain) {
  const found = [];
  for (const p of role.permissionPolicies || []) {
    const domains =
      p.domain === "*"
        ? Object.keys(byDomain)
        : byDomain[p.domain]
          ? [p.domain]
          : [];
    for (const domain of domains) {
      const domainEntry = byDomain[domain];
      const entities =
        p.entityName === "*"
          ? Object.keys(domainEntry)
          : domainEntry[p.entityName]
            ? [p.entityName]
            : [];
      for (const entity of entities) {
        const entityActions = domainEntry[entity];
        if (!entityActions) continue;
        const actions = (p.actionSet || []).includes("*")
          ? [...entityActions]
          : (p.actionSet || []).filter((a) => entityActions.has(a));
        for (const action of actions) found.push(`${domain}:${entity}:${action}`);
      }
    }
  }
  return [...new Set(found)];
}

// ── Billing-role matcher ──────────────────────────────────────────────────────

function roleMatchesBilling(role) {
  for (const p of role.permissionPolicies || []) {
    const domainOk = p.domain === BILLING_DOMAIN || p.domain === "*";
    const entityOk = p.entityName === BILLING_ENTITY || p.entityName === "*";
    if (!domainOk || !entityOk) continue;
    const aSet = p.actionSet || [];
    if (aSet.includes("*") || aSet.includes(BILLING_ACTION)) return true;
  }
  return false;
}

// ── Source attribution ────────────────────────────────────────────────────────

function buildSourceLabel(roleId, userGroups, groupGrantsCache, groupNameCache) {
  const groupRoleIds = new Set();
  for (const g of userGroups) {
    for (const grant of groupGrantsCache.get(g.id) || []) {
      if (grant.role?.id) groupRoleIds.add(grant.role.id);
    }
  }
  const sources = [];
  if (!groupRoleIds.has(roleId)) sources.push("Assigned manually");
  for (const g of userGroups) {
    if ((groupGrantsCache.get(g.id) || []).some((gr) => gr.role?.id === roleId)) {
      sources.push(
        `Inherited from Group: ${groupNameCache.get(g.id) || g.name || g.id}`,
      );
    }
  }
  return sources.length ? sources.join("; ") : "Assigned manually";
}

// ── Badge renderers ───────────────────────────────────────────────────────────

function sourceBadge(source) {
  if (!source || source === "Resolving…") {
    return `<span class="rs-badge rs-badge--pending">Resolving…</span>`;
  }
  return source
    .split(";")
    .map((s) => {
      s = s.trim();
      if (s === "Assigned manually")
        return `<span class="rs-badge rs-badge--manual">Assigned manually</span>`;
      return `<span class="rs-badge rs-badge--group">${escapeHtml(s)}</span>`;
    })
    .join(" ");
}

// ── Public entry-point ────────────────────────────────────────────────────────

export function renderHourlyContent(container, { me, api, orgContext }) {
  container.innerHTML = `
    <style>
      /* ── Filter pills ── */
      .hi-pills { display:flex; gap:6px; margin-bottom:16px; flex-wrap:wrap; }
      .hi-pill { padding:6px 18px; border-radius:20px; border:1px solid var(--border); background:transparent;
                 color:var(--muted); cursor:pointer; font:inherit; font-size:13px; font-weight:600;
                 transition:background .12s, color .12s, border-color .12s; user-select:none; }
      .hi-pill:hover:not(.active) { border-color:#6b7280; color:var(--text); }
      .hi-pill.active { background:rgba(59,130,246,.22); border-color:#3b82f6; color:#60a5fa; }
      .hi-pill .hi-pill-count { margin-left:6px; font-size:11px; opacity:.7; }
      /* ── Forbidden-role badge ── */
      .hi-badge--forbidden { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600;
                             white-space:nowrap; background:rgba(239,68,68,.15); color:#fca5a5; border:1px solid #ef4444; margin:1px 2px; }
      .hi-badge--none { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600;
                        white-space:nowrap; background:rgba(22,163,74,.12); color:#86efac; border:1px solid #16a34a; }
      /* ── Category colour ── */
      .hi-cat-hourly { color:#86efac; font-weight:600; }
      .hi-cat-fullcx { color:#fbbf24; font-weight:600; }
    </style>

    <p style="font-size:13px;color:var(--muted);margin-bottom:18px">
      Find all users with the <strong>billing:user:hourlyInteracting</strong> permission and classify them
      as <span style="color:#86efac;font-weight:600">Hourly</span> (no disqualifying permissions) or
      <span style="color:#fbbf24;font-weight:600">Full CX</span> (has disqualifying permissions).
    </p>

    <div style="margin-bottom:18px">
      <button class="rs-search-btn" id="hiSearchBtn">Search</button>
    </div>

    <div class="rs-status" id="hiStatus"></div>
    <div class="rs-progress-wrap" id="hiProgressWrap" style="display:none">
      <div class="rs-progress-track"><div class="rs-progress-fill" id="hiProgressFill"></div></div>
      <div class="rs-progress-detail" id="hiProgressDetail"></div>
    </div>

    <div id="hiResults">
      <div class="rs-empty">
        <div class="rs-empty-icon">📊</div>
        <p>Click <strong>Search</strong> to find all users with the Hourly Interacting permission.</p>
      </div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────────
  const $searchBtn      = container.querySelector("#hiSearchBtn");
  const $status         = container.querySelector("#hiStatus");
  const $progressWrap   = container.querySelector("#hiProgressWrap");
  const $progressFill   = container.querySelector("#hiProgressFill");
  const $progressDetail = container.querySelector("#hiProgressDetail");
  const $results        = container.querySelector("#hiResults");

  let searching    = false;
  let activeFilter = "all"; // "all" | "hourly" | "fullcx"

  // ── Helpers ───────────────────────────────────────────────
  function setStatus(msg, cls = "") {
    $status.textContent = msg;
    $status.className = "rs-status" + (cls ? ` rs-status--${cls}` : "");
  }

  function showProgress(fetched, total) {
    $progressWrap.style.display = "";
    if (total && total > 0) {
      const pct = Math.min(100, Math.round((fetched / total) * 100));
      $progressFill.style.width = `${pct}%`;
      $progressFill.classList.remove("indeterminate");
      $progressDetail.textContent = `${fetched.toLocaleString()} / ${total.toLocaleString()}`;
    } else {
      $progressFill.classList.add("indeterminate");
      $progressFill.style.width = "";
      $progressDetail.textContent =
        fetched > 0 ? `${fetched.toLocaleString()} loaded…` : "";
    }
  }

  function hideProgress() {
    $progressWrap.style.display = "none";
    $progressFill.style.width = "0";
    $progressFill.classList.remove("indeterminate");
    $progressDetail.textContent = "";
  }

  function applyFilters() {
    const $tbody = container.querySelector("#hiTbody");
    if (!$tbody) return;

    const filterInput = container.querySelector("#hiFilter");
    const q = (filterInput?.value || "").toLowerCase();

    let visibleCount = 0;
    let totalCount = 0;

    for (const tr of $tbody.querySelectorAll("tr")) {
      totalCount++;
      const cat = tr.dataset.category;
      let show = activeFilter === "all" || cat === activeFilter;
      if (show && q) {
        const name  = (tr.dataset.name  || "").toLowerCase();
        const email = (tr.dataset.email || "").toLowerCase();
        if (!name.includes(q) && !email.includes(q)) show = false;
      }
      tr.hidden = !show;
      if (show) visibleCount++;
    }

    const $summary = container.querySelector("#hiSummary");
    if ($summary) {
      $summary.textContent =
        visibleCount === totalCount
          ? `${totalCount} result${totalCount !== 1 ? "s" : ""}`
          : `${visibleCount} of ${totalCount} results`;
    }
  }

  // ── Search ────────────────────────────────────────────────
  $searchBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) {
      setStatus("Please select a customer org first.", "error");
      return;
    }

    searching = true;
    $searchBtn.disabled = true;
    activeFilter = "all";
    setStatus("Fetching disqualifying permissions…");
    $results.innerHTML = "";

    try {
      // ── Step 0: disqualifying permissions (scrape → static fallback) ──
      const dqPerms   = await fetchDisqualifyingPermissions();
      const byDomain  = buildDisqualifyingIndex(dqPerms);
      setStatus(
        `Loaded ${dqPerms.length} disqualifying permissions. Fetching roles and users…`,
      );

      // ── Step 1: fetch all roles + all users in parallel ──
      let rolesFetched = 0,
        rolesTotal = null;
      let usersFetched = 0,
        usersTotal = null;
      const updateProgress = () => {
        const total =
          rolesTotal != null && usersTotal != null
            ? rolesTotal + usersTotal
            : null;
        showProgress(rolesFetched + usersFetched, total);
      };
      showProgress(0, null);

      const [allRoles, allUsers] = await Promise.all([
        fetchAllAuthorizationRoles(api, org.id, {
          onProgress: (f, t) => {
            rolesFetched = f;
            if (t != null) rolesTotal = t;
            updateProgress();
          },
        }),
        fetchAllUsers(api, org.id, {
          expand: ["authorization"],
          onProgress: (f, t) => {
            usersFetched = f;
            if (t != null) usersTotal = t;
            updateProgress();
          },
        }),
      ]);

      // Build role lookup
      const roleMap       = new Map(allRoles.map((r) => [r.id, r]));
      const billingRoleIds = new Set(
        allRoles.filter((r) => roleMatchesBilling(r)).map((r) => r.id),
      );

      if (billingRoleIds.size === 0) {
        hideProgress();
        setStatus("");
        $results.innerHTML = `<div class="rs-empty"><div class="rs-empty-icon">🔍</div>
          <p>No roles found with permission <strong>billing:user:hourlyInteracting</strong>.</p></div>`;
        return;
      }

      // ── Step 2: find users who hold the billing permission ──
      const matchedUsers = [];
      for (const user of allUsers) {
        const userRoleIds = (user.authorization?.roles || [])
          .map((r) => r.id || r.roleId)
          .filter(Boolean);
        const userBillingRoles = userRoleIds.filter((rid) =>
          billingRoleIds.has(rid),
        );
        if (userBillingRoles.length === 0) continue;

        // Check ALL of this user's roles for disqualifying permissions
        const forbiddenRoles = [];
        for (const rid of userRoleIds) {
          const role = roleMap.get(rid);
          if (!role) continue;
          if (roleHasDisqualifying(role, byDomain)) {
            forbiddenRoles.push({
              id: rid,
              name: role.name || rid,
              perms: getDisqualifyingFromRole(role, byDomain),
            });
          }
        }
        const category = forbiddenRoles.length > 0 ? "fullcx" : "hourly";

        for (const billingRoleId of userBillingRoles) {
          matchedUsers.push({
            userId: user.id,
            userName: user.name || user.username || user.id,
            email: user.email || "",
            roleId: billingRoleId,
            roleName: roleMap.get(billingRoleId)?.name || billingRoleId,
            groups: [],
            category,
            forbiddenRoles,
          });
        }
      }

      if (matchedUsers.length === 0) {
        hideProgress();
        setStatus("");
        $results.innerHTML = `<div class="rs-empty"><div class="rs-empty-icon">👥</div>
          <p>No users in this org have the <strong>billing:user:hourlyInteracting</strong> permission.</p></div>`;
        return;
      }

      // ── Step 2b: fetch group memberships for matched users ──
      const uniqueUserIds = [...new Set(matchedUsers.map((u) => u.userId))];
      let grpFetched = 0;
      setStatus(
        `Found ${matchedUsers.length} assignment${matchedUsers.length !== 1 ? "s" : ""} — fetching group memberships…`,
      );
      showProgress(0, uniqueUserIds.length);
      const userGroupMap = new Map();

      await runBatched(
        uniqueUserIds.map((userId) => async () => {
          try {
            const detail = await api.proxyGenesys(
              org.id,
              "GET",
              `/api/v2/users/${userId}`,
              { query: { expand: "groups" } },
            );
            userGroupMap.set(userId, detail.groups || []);
          } catch {
            userGroupMap.set(userId, []);
          }
          showProgress(++grpFetched, uniqueUserIds.length);
        }),
        10,
      );

      for (const u of matchedUsers) {
        u.groups = userGroupMap.get(u.userId) || [];
      }

      // Sort alphabetically
      matchedUsers.sort((a, b) =>
        a.userName.localeCompare(b.userName, undefined, { sensitivity: "base" }),
      );

      // ── Step 3: resolve group subjects for source attribution ──
      setStatus("Resolving sources…");
      const allGroupIds      = new Set(matchedUsers.flatMap((u) => u.groups.map((g) => g.id)));
      const groupGrantsCache = new Map();
      const groupNameCache   = new Map();

      if (allGroupIds.size > 0) showProgress(0, allGroupIds.size);
      else hideProgress();
      let srcFetched = 0;

      await runBatched(
        [...allGroupIds].map((groupId) => async () => {
          try {
            const [gs, gd] = await Promise.all([
              api.proxyGenesys(org.id, "GET", `/api/v2/authorization/subjects/${groupId}`),
              api.proxyGenesys(org.id, "GET", `/api/v2/groups/${groupId}`),
            ]);
            groupGrantsCache.set(groupId, gs.grants || []);
            groupNameCache.set(groupId, gd.name || groupId);
          } catch {
            groupGrantsCache.set(groupId, []);
          }
          showProgress(++srcFetched, allGroupIds.size);
        }),
        10,
      );

      // ── Step 4: expand into display rows ──
      // One row per billing-role × forbidden-role for Full CX users,
      // one row per billing-role for Hourly users.
      const displayRows = [];
      for (const u of matchedUsers) {
        const source = buildSourceLabel(
          u.roleId,
          u.groups,
          groupGrantsCache,
          groupNameCache,
        );
        if (u.forbiddenRoles.length > 0) {
          for (const fr of u.forbiddenRoles) {
            displayRows.push({ ...u, source, forbiddenRole: fr });
          }
        } else {
          displayRows.push({ ...u, source, forbiddenRole: null });
        }
      }

      const hourlyCount = displayRows.filter((r) => r.category === "hourly").length;
      const fullcxCount = displayRows.filter((r) => r.category === "fullcx").length;

      const wrap = document.createElement("div");

      // Filter pills
      const pillsDiv = document.createElement("div");
      pillsDiv.className = "hi-pills";
      pillsDiv.innerHTML = `
        <button class="hi-pill active" data-filter="all">All<span class="hi-pill-count">${displayRows.length}</span></button>
        <button class="hi-pill" data-filter="hourly">Hourly<span class="hi-pill-count">${hourlyCount}</span></button>
        <button class="hi-pill" data-filter="fullcx">Full CX<span class="hi-pill-count">${fullcxCount}</span></button>
      `;
      wrap.appendChild(pillsDiv);

      pillsDiv.querySelectorAll(".hi-pill").forEach((btn) => {
        btn.addEventListener("click", () => {
          pillsDiv.querySelectorAll(".hi-pill").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          activeFilter = btn.dataset.filter;
          applyFilters();
        });
      });

      // Filter row
      const filterRow = document.createElement("div");
      filterRow.className = "rs-filter-row";
      filterRow.innerHTML = `
        <input class="rs-filter-input" id="hiFilter" placeholder="Filter by name or email…">
        <span class="rs-summary" id="hiSummary"></span>
        <button class="rs-export-btn" id="hiExportBtn">Export to Excel</button>
      `;
      wrap.appendChild(filterRow);

      // Table
      const tableWrap = document.createElement("div");
      tableWrap.className = "rs-table-wrap";
      tableWrap.innerHTML = `
        <table class="rs-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Category</th>
              <th>Role</th>
              <th>Source</th>
              <th>Role with Forbidden Permission</th>
            </tr>
          </thead>
          <tbody id="hiTbody"></tbody>
        </table>
      `;
      wrap.appendChild(tableWrap);
      $results.appendChild(wrap);

      // Populate rows
      const $tbody = container.querySelector("#hiTbody");
      for (const row of displayRows) {
        const catLabel =
          row.category === "hourly"
            ? `<span class="hi-cat-hourly">Hourly</span>`
            : `<span class="hi-cat-fullcx">Full CX</span>`;

        const forbiddenCell = row.forbiddenRole
          ? `<span class="hi-badge--forbidden" title="${escapeHtml(row.forbiddenRole.perms.join(", "))}">${escapeHtml(row.forbiddenRole.name)} (${row.forbiddenRole.perms.length})</span>`
          : `<span class="hi-badge--none">None</span>`;

        const tr = document.createElement("tr");
        tr.dataset.name     = row.userName;
        tr.dataset.email    = row.email;
        tr.dataset.category = row.category;
        tr.innerHTML = `
          <td>${escapeHtml(row.userName)}</td>
          <td>${escapeHtml(row.email)}</td>
          <td>${catLabel}</td>
          <td class="rs-role-cell">${escapeHtml(row.roleName)}</td>
          <td>${sourceBadge(row.source)}</td>
          <td>${forbiddenCell}</td>
        `;
        $tbody.appendChild(tr);
      }

      // Wire filter input
      container.querySelector("#hiFilter").addEventListener("input", () => applyFilters());

      applyFilters();
      hideProgress();
      setStatus(
        `Done — ${displayRows.length} row${displayRows.length !== 1 ? "s" : ""} ` +
          `(${hourlyCount} Hourly, ${fullcxCount} Full CX).`,
      );

      // Wire export
      container.querySelector("#hiExportBtn").addEventListener("click", () => {
        const org     = orgContext?.getDetails?.();
        const safe    = (s) => s.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
        const orgSlug = safe(org?.name || "") || "org";
        const filename = timestampedFilename(
          `Hourly_Interacting_${orgSlug}`,
          "xlsx",
        );
        const columns = [
          { key: "user",      label: "User",                           wch: 30 },
          { key: "email",     label: "Email",                          wch: 36 },
          { key: "category",  label: "Category",                       wch: 12 },
          { key: "role",      label: "Role",                           wch: 40 },
          { key: "source",    label: "Source",                         wch: 50 },
          { key: "forbidden", label: "Role with Forbidden Permission", wch: 60 },
        ];
        const rows = [];
        container.querySelectorAll("#hiTbody tr").forEach((tr) => {
          const cells = tr.querySelectorAll("td");
          rows.push({
            user:      cells[0]?.textContent?.trim() || "",
            email:     cells[1]?.textContent?.trim() || "",
            category:  cells[2]?.textContent?.trim() || "",
            role:      cells[3]?.textContent?.trim() || "",
            source:    cells[4]?.textContent?.trim() || "",
            forbidden: cells[5]?.textContent?.trim() || "",
          });
        });
        try {
          exportXlsx(
            [{ name: "Hourly Interacting", rows, columns }],
            filename,
          );
        } catch (err) {
          setStatus(err.message, "error");
        }
      });
    } catch (err) {
      hideProgress();
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      searching = false;
      $searchBtn.disabled = false;
    }
  });
}
