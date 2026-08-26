/**
 * WEM License Analysis
 *
 * Finds every user whose roles carry a permission that triggers a Workforce
 * Engagement Management add-on license, and cross-checks that against the WEM
 * licenses actually assigned to them.
 *
 * Unlike the Hourly Interacting check next door, nothing here is scraped:
 * Genesys publishes no list of WEM-triggering permissions, but it does expose
 * the mapping as an API, per org.
 *
 *   POST /api/v2/license/infer        [roleId]  → [licenseId]
 *        The same inference the Genesys admin UI runs when it warns that a
 *        role needs a license. Its answer is the billing answer, so it — not a
 *        permission comparison of our own — decides the verdict.
 *
 *   GET  /api/v2/license/definitions  every license the org can hold, each
 *        with permissions.ids / prerequisites / comprises. Used only to name
 *        *which* permissions triggered a role, which is presentation.
 *
 *   GET  /api/v2/license/users        the licenses a user is really assigned.
 *
 * Two mismatches both cost money, and the table separates them:
 *   Unlicensed trigger — permission granted that the org is not paying for.
 *   License unused     — a WEM seat whose roles never needed it.
 *
 * Exported function `renderWemContent` is called lazily from search.js when
 * the user toggles to the "WEM License" mode.
 */

import { escapeHtml, exportXlsx, timestampedFilename, makeStatus } from "../../utils.js";
import {
  fetchAllAuthorizationRoles,
  fetchAllUsers,
  fetchAllLicenseUsers,
  fetchLicenseDefinitions,
  fetchLicenseDefinition,
  inferLicensesForRoles,
} from "../../services/genesysApi.js";

// ── Constants ─────────────────────────────────────────────────────────────────

// Which license definitions count as the WEM add-on. A hint rather than a
// hardcoded id list, because which WEM SKUs an org holds varies — matched
// 2/2 on the first live orgs (gc2WEMupgrade beside cloudCX2).
//
// The page acts on this itself and reports what it found. It is deliberately
// not a control: this page answers one question — who holds a WEM licence and
// how they got it — and a picker would both widen that and depend on the one
// thing an admin has no reason to know, which id is WEM. If this hint ever
// misses an org, fix the hint.
const WEM_HINT = /wem|workforce\s*engagement/i;

// The WEM add-on an org holds follows its CX tier, and the three cases are
// exhaustive:
//
//   cloudCX1  →  gc1WEMupgrade
//   cloudCX2  →  gc2WEMupgrade
//   cloudCX3+ →  none; WEM is bundled into the base license
//
// The upgrades are alternatives, not additions — no org holds both. And
// `/license/definitions` returns only what an org can actually hold, so on
// CX3 the WEM SKU is genuinely absent rather than merely unselected: its
// absence is the answer, not a failure to find it.
//
// `wemLicenseIds` stays a list all the same. It costs nothing, and it keeps
// working if Genesys renames or adds a tier.
const BASE_TIER = /^cloudCX(\d+)/i;
const WEM_BUNDLED_FROM_TIER = 3;

/** The highest cloudCX tier this org can hold, or null if it holds none. */
function highestBaseTier(defs) {
  let best = null;
  for (const d of defs) {
    const m = BASE_TIER.exec(d.id || "");
    if (!m) continue;
    const tier = Number(m[1]);
    if (!Number.isNaN(tier) && (best === null || tier > best.tier)) {
      best = { tier, id: d.id };
    }
  }
  return best;
}

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

// ── License definition resolution ─────────────────────────────────────────────

/**
 * Get a definition with its `permissions` populated.
 *
 * The list endpoint may return skinny entries; the by-id endpoint always
 * carries permissions. Rather than find out in advance which shape this org
 * returns, ask for the full one whenever the listed entry came back without.
 */
async function resolveDefinition(api, orgId, def, cache) {
  const id = typeof def === "string" ? def : def?.id;
  if (!id) return null;
  if (cache.has(id)) return cache.get(id);

  let full = typeof def === "object" ? def : null;
  if (!full?.permissions?.ids?.length) {
    try {
      full = await fetchLicenseDefinition(api, orgId, id);
    } catch {
      full = full || { id };
    }
  }
  cache.set(id, full);
  return full;
}

/**
 * Every permission a license grants, following `comprises` for bundle licenses.
 */
async function collectPermissions(api, orgId, def, cache, seen = new Set()) {
  const full = await resolveDefinition(api, orgId, def, cache);
  if (!full?.id || seen.has(full.id)) return new Set();
  seen.add(full.id);

  const out = new Set(full.permissions?.ids || []);
  for (const child of full.comprises || []) {
    for (const p of await collectPermissions(api, orgId, child, cache, seen)) {
      out.add(p);
    }
  }
  return out;
}

/**
 * The permissions that the selected licenses add over and above their
 * prerequisites.
 *
 * Genesys does not say whether an upgrade license's `permissions.ids` is
 * incremental (only what the upgrade unlocks) or cumulative (the base license
 * plus the upgrade). Subtracting the prerequisites is correct either way — on
 * a cumulative list it strips the base, on an incremental one the sets barely
 * overlap and it is a no-op — so the question never has to be answered. And a
 * permission already granted by the base license cannot trigger the add-on, so
 * nothing legitimate is lost to over-subtraction.
 *
 * A selected license is never treated as its own base: if one WEM SKU lists
 * another as a prerequisite, subtracting it would empty the result.
 */
async function wemOnlyPermissions(api, orgId, licenseIds, listed, cache) {
  const byId = new Map(listed.map((d) => [d.id, d]));
  const selected = new Set(licenseIds);
  const granted = new Set();
  const base = new Set();

  for (const id of licenseIds) {
    const def = await resolveDefinition(api, orgId, byId.get(id) || id, cache);
    if (!def) continue;
    for (const p of await collectPermissions(api, orgId, def, cache)) granted.add(p);
    for (const pre of def.prerequisites || []) {
      const preId = typeof pre === "string" ? pre : pre?.id;
      if (selected.has(preId)) continue;
      for (const p of await collectPermissions(api, orgId, pre, cache)) base.add(p);
    }
  }

  return new Set([...granted].filter((p) => !base.has(p)));
}

// ── Permission matching (wildcard-aware) ──────────────────────────────────────

/** Build a domain→entity→Set<action> index for fast lookups. */
function buildPermissionIndex(permArr) {
  const byDomain = {};
  for (const p of permArr) {
    const [domain, entity, action] = String(p).split(":");
    if (!domain || !entity || !action) continue;
    if (!byDomain[domain]) byDomain[domain] = {};
    if (!byDomain[domain][entity]) byDomain[domain][entity] = new Set();
    byDomain[domain][entity].add(action);
  }
  return byDomain;
}

/**
 * Collect every concrete indexed permission matched by a role's policies,
 * expanding the wildcards a policy may carry in domain / entity / actionSet.
 */
function getMatchingFromRole(role, byDomain) {
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

function sourceBadge(source) {
  if (!source) return "";
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

// ── Categories ────────────────────────────────────────────────────────────────

const CATEGORY = {
  gap:      { label: "Unlicensed trigger", cls: "wem-cat-gap" },
  licensed: { label: "Licensed",           cls: "wem-cat-ok" },
  unused:   { label: "License unused",     cls: "wem-cat-unused" },
};

function categorise(triggers, assigned) {
  if (triggers && !assigned) return "gap";
  if (triggers && assigned) return "licensed";
  return "unused";
}

// ── Public entry-point ────────────────────────────────────────────────────────

export function renderWemContent(container, { me, api, orgContext }) {
  container.innerHTML = `
    <style>
      .wem-pills { display:flex; gap:6px; margin-bottom:16px; flex-wrap:wrap; }
      .wem-pill { padding:6px 18px; border-radius:20px; border:1px solid var(--border); background:transparent;
                  color:var(--muted); cursor:pointer; font:inherit; font-size:13px; font-weight:600;
                  transition:background .12s, color .12s, border-color .12s; user-select:none; }
      .wem-pill:hover:not(.active) { border-color:#6b7280; color:var(--text); }
      .wem-pill.active { background:rgba(59,130,246,.22); border-color:#3b82f6; color:#60a5fa; }
      .wem-pill .wem-pill-count { margin-left:6px; font-size:11px; opacity:.7; }
      /* ── License picker ── */
      /* ── Scope line ── */
      .wem-scope { font-size:13px; color:var(--muted); margin-bottom:16px; max-width:760px; line-height:1.6; }
      .wem-scope strong { color:#93c5fd; font-weight:600; }
      /* ── Permission badge ── */
      .wem-badge--perm { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600;
                         white-space:nowrap; background:rgba(239,68,68,.15); color:#fca5a5; border:1px solid #ef4444; margin:1px 2px; }
      .wem-badge--none { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600;
                         white-space:nowrap; background:rgba(107,114,128,.15); color:var(--muted); border:1px solid var(--border); }
      .wem-badge--yes { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600;
                        background:rgba(22,163,74,.12); color:#86efac; border:1px solid #16a34a; }
      .wem-badge--no { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600;
                       background:rgba(239,68,68,.15); color:#fca5a5; border:1px solid #ef4444; }
      /* ── Category colour ── */
      .wem-cat-gap    { color:#fca5a5; font-weight:600; }
      .wem-cat-ok     { color:#86efac; font-weight:600; }
      .wem-cat-unused { color:#fbbf24; font-weight:600; }
      /* ── Fallback note ── */
      .wem-note { font-size:12px; color:#fbbf24; margin-bottom:12px; max-width:760px; line-height:1.5; }
    </style>

    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">
      Find every user whose roles carry a permission that triggers a
      <strong>Workforce Engagement Management</strong> add-on license, and compare that against the
      WEM licenses they are actually assigned:
      <span style="color:#fca5a5;font-weight:600">Unlicensed trigger</span> (permission granted but not paid for),
      <span style="color:#86efac;font-weight:600">Licensed</span>, or
      <span style="color:#fbbf24;font-weight:600">License unused</span> (a WEM seat no role needs).
    </p>

    <p class="wem-scope" id="wemScope">Loading license definitions…</p>

    <div style="margin-bottom:18px">
      <button class="rs-search-btn" id="wemSearchBtn" disabled>Search</button>
    </div>

    <div class="rs-status" id="wemStatus"></div>
    <div class="rs-progress-wrap" id="wemProgressWrap" style="display:none">
      <div class="rs-progress-track"><div class="rs-progress-fill" id="wemProgressFill"></div></div>
      <div class="rs-progress-detail" id="wemProgressDetail"></div>
    </div>

    <div id="wemResults">
      <div class="rs-empty">
        <div class="rs-empty-icon">🎧</div>
        <p>Click <strong>Search</strong> to check this org.</p>
      </div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────────
  const $scope          = container.querySelector("#wemScope");
  const $searchBtn      = container.querySelector("#wemSearchBtn");
  const $status         = container.querySelector("#wemStatus");
  const $progressWrap   = container.querySelector("#wemProgressWrap");
  const $progressFill   = container.querySelector("#wemProgressFill");
  const $progressDetail = container.querySelector("#wemProgressDetail");
  const $results        = container.querySelector("#wemResults");

  let activeFilter = "all"; // "all" | "gap" | "licensed" | "unused"
  let listedDefs    = [];
  let wemLicenseIds = [];

  const setStatus = makeStatus($status, "rs-status");

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

  // ── Identify the WEM add-on ───────────────────────────────
  // Read-only. The page has one job — who holds a WEM licence, and how they
  // got it — so it works out which SKU that is and says so. It does not offer
  // the choice: an escape hatch would need exactly the knowledge an admin does
  // not have (which id is WEM), so it could only ever help whoever is debugging
  // it. If the hint ever misses an org, the hint is what gets fixed.
  (async function identifyWemLicense() {
    const org = orgContext?.getDetails?.();
    if (!org) {
      $scope.textContent = "Select a customer org first.";
      return;
    }
    try {
      listedDefs = await fetchLicenseDefinitions(api, org.id);
      if (!listedDefs.length) {
        $scope.textContent = "No license definitions returned for this org.";
        return;
      }

      wemLicenseIds = listedDefs
        .filter((d) => WEM_HINT.test(d.id || "") || WEM_HINT.test(d.description || ""))
        .map((d) => d.id);

      if (wemLicenseIds.length) {
        $scope.innerHTML =
          `Checking against ${wemLicenseIds.map((id) => `<strong>${escapeHtml(id)}</strong>`).join(" and ")}.`;
        $searchBtn.disabled = false;
        return;
      }

      // No WEM add-on. Two reasons, one conclusion: nobody here can be holding
      // a WEM licence, so there is nothing for this check to find.
      const base = highestBaseTier(listedDefs);
      const bundled = base && base.tier >= WEM_BUNDLED_FROM_TIER;
      $searchBtn.disabled = true;
      $scope.innerHTML = bundled
        ? `This org has no separate WEM add-on — <strong>${escapeHtml(base.id)}</strong> includes WEM.`
        : `This org has no WEM add-on.`;
      $results.innerHTML = `<div class="rs-empty">
        <div class="rs-empty-icon">📦</div>
        <p>${bundled
              ? `<strong>${escapeHtml(base.id)}</strong> already includes WEM.`
              : `No WEM add-on for this org.`}</p>
        <p style="font-size:13px;max-width:46ch;margin:8px auto 0">
          There is no separate WEM licence for anyone here to hold, so nobody can be
          carrying a WEM permission this org is not paying for.
        </p>
      </div>`;
    } catch (err) {
      $scope.innerHTML = `<span style="color:#f87171">Could not load license definitions: ${escapeHtml(err.message)}</span>`;
    }
  })();


  // ── Filters ───────────────────────────────────────────────
  function applyFilters() {
    const $tbody = container.querySelector("#wemTbody");
    if (!$tbody) return;
    const q = (container.querySelector("#wemFilter")?.value || "").toLowerCase();

    let visibleCount = 0;
    let totalCount = 0;
    for (const tr of $tbody.querySelectorAll("tr")) {
      totalCount++;
      let show = activeFilter === "all" || tr.dataset.category === activeFilter;
      if (show && q) {
        const name  = (tr.dataset.name  || "").toLowerCase();
        const email = (tr.dataset.email || "").toLowerCase();
        if (!name.includes(q) && !email.includes(q)) show = false;
      }
      tr.hidden = !show;
      if (show) visibleCount++;
    }

    const $summary = container.querySelector("#wemSummary");
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
    const wemIds = wemLicenseIds;
    if (!wemIds.length) {
      setStatus("Select at least one WEM license.", "error");
      return;
    }

    $searchBtn.disabled = true;
    activeFilter = "all";
    $results.innerHTML = "";
    setStatus("Resolving license definitions…");

    try {
      // ── Step 0: the permissions the selected licenses add ──
      const defCache  = new Map();
      const wemPerms  = await wemOnlyPermissions(api, org.id, wemIds, listedDefs, defCache);
      const permIndex = buildPermissionIndex(wemPerms);
      const wemIdSet  = new Set(wemIds);

      setStatus(
        `${wemPerms.size} permission${wemPerms.size !== 1 ? "s" : ""} attributed to the selected license(s). ` +
          `Fetching roles, users and license assignments…`,
      );

      // ── Step 1: roles + users + assigned licenses, in parallel ──
      let rolesFetched = 0, rolesTotal = null;
      let usersFetched = 0, usersTotal = null;
      let licsFetched  = 0, licsTotal  = null;
      const updateProgress = () => {
        const total =
          rolesTotal != null && usersTotal != null && licsTotal != null
            ? rolesTotal + usersTotal + licsTotal
            : null;
        showProgress(rolesFetched + usersFetched + licsFetched, total);
      };
      showProgress(0, null);

      const [allRoles, allUsers, licenseUsers] = await Promise.all([
        fetchAllAuthorizationRoles(api, org.id, {
          onProgress: (f, t) => { rolesFetched = f; if (t != null) rolesTotal = t; updateProgress(); },
        }),
        fetchAllUsers(api, org.id, {
          // `groups` rides along with the bulk fetch rather than costing a
          // GET /users/{id}?expand=groups per matched user afterwards. On an
          // org where WEM is widely deployed the matched set approaches the
          // whole directory, so that loop was the page's real scaling cost —
          // an order of magnitude more requests than the per-role infer calls.
          expand: ["authorization", "groups"],
          // Active users only, which is /api/v2/users' default. Inactive
          // accounts are deliberately out of scope: they do not count towards
          // licence billing, so a deactivated user holding a WEM licence is
          // not a seat anyone is paying for and would only be noise here.
          onProgress: (f, t) => { usersFetched = f; if (t != null) usersTotal = t; updateProgress(); },
        }),
        fetchAllLicenseUsers(api, org.id, {
          onProgress: (f, t) => { licsFetched = f; if (t != null) licsTotal = t; updateProgress(); },
        }),
      ]);

      const roleMap = new Map(allRoles.map((r) => [r.id, r]));
      const assignedMap = new Map(
        licenseUsers.map((e) => [e.id, new Set(e.licenses || [])]),
      );

      // ── Step 2: which roles trigger WEM? ──
      // Only roles somebody actually holds are worth an infer call.
      const usedRoleIds = new Set();
      const userRoleIds = new Map();
      for (const user of allUsers) {
        const ids = (user.authorization?.roles || [])
          .map((r) => r.id || r.roleId)
          .filter(Boolean);
        userRoleIds.set(user.id, ids);
        for (const id of ids) usedRoleIds.add(id);
      }

      setStatus(
        `Asking Genesys which of ${usedRoleIds.size} in-use role${usedRoleIds.size !== 1 ? "s" : ""} require a WEM license…`,
      );
      let inferFetched = 0;
      showProgress(0, usedRoleIds.size);

      // If /license/infer is unavailable (not enabled, not permitted), fall
      // back to matching the role's permissions against the license definition
      // ourselves. Less authoritative — it is our reading of the mapping rather
      // than Genesys' — so say so on the page instead of quietly substituting.
      let inferFailed = false;
      const triggeringRoles = new Map(); // roleId → { name, perms }

      await runBatched(
        [...usedRoleIds].map((roleId) => async () => {
          const role  = roleMap.get(roleId);
          const perms = role ? getMatchingFromRole(role, permIndex) : [];
          let triggers = null;

          if (!inferFailed) {
            try {
              const inferred = await inferLicensesForRoles(api, org.id, [roleId]);
              triggers = inferred.some((l) => wemIdSet.has(l));
            } catch {
              inferFailed = true;
            }
          }
          if (triggers === null) triggers = perms.length > 0;

          if (triggers) triggeringRoles.set(roleId, { name: role?.name || roleId, perms });
          showProgress(++inferFetched, usedRoleIds.size);
        }),
        10,
      );

      // ── Step 3: users who trigger, or hold a WEM license, or both ──
      const matchedUsers = [];
      for (const user of allUsers) {
        const ids  = userRoleIds.get(user.id) || [];
        const hits = ids.filter((id) => triggeringRoles.has(id));
        const assigned = [...(assignedMap.get(user.id) || [])].filter((l) =>
          wemIdSet.has(l),
        );
        if (!hits.length && !assigned.length) continue;
        matchedUsers.push({
          userId: user.id,
          userName: user.name || user.username || user.id,
          email: user.email || "",
          triggeringRoleIds: hits,
          assigned,
          category: categorise(hits.length > 0, assigned.length > 0),
          groups: user.groups || [],
        });
      }

      if (!matchedUsers.length) {
        hideProgress();
        setStatus("");
        $results.innerHTML = `<div class="rs-empty"><div class="rs-empty-icon">👥</div>
          <p>No user in this org triggers or holds <strong>${escapeHtml(wemIds.join(", "))}</strong>.</p></div>`;
        return;
      }

      matchedUsers.sort((a, b) =>
        a.userName.localeCompare(b.userName, undefined, { sensitivity: "base" }),
      );

      // ── Step 4: resolve group grants for source attribution ──
      // Group memberships already arrived with the bulk user fetch, so the only
      // per-object work left is reading each group's role grants — and only for
      // groups belonging to users who actually have a triggering role to
      // attribute. A "License unused" user has no role to explain, so their
      // groups are never looked up.
      setStatus(
        `Found ${matchedUsers.length} user${matchedUsers.length !== 1 ? "s" : ""} — resolving sources…`,
      );
      const allGroupIds = new Set(
        matchedUsers
          .filter((u) => u.triggeringRoleIds.length)
          .flatMap((u) => u.groups.map((g) => g.id)),
      );
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

      // ── Step 5: expand into display rows ──
      // One row per user × triggering role; users who only hold an unused
      // license get a single row with nothing to attribute.
      const displayRows = [];
      for (const u of matchedUsers) {
        if (u.triggeringRoleIds.length) {
          for (const roleId of u.triggeringRoleIds) {
            displayRows.push({
              ...u,
              role: triggeringRoles.get(roleId),
              source: buildSourceLabel(roleId, u.groups, groupGrantsCache, groupNameCache),
            });
          }
        } else {
          displayRows.push({ ...u, role: null, source: "" });
        }
      }

      const uniq = (pred) => new Set(displayRows.filter(pred).map((r) => r.userId)).size;
      const uniqueAll      = uniq(() => true);
      const uniqueGap      = uniq((r) => r.category === "gap");
      const uniqueLicensed = uniq((r) => r.category === "licensed");
      const uniqueUnused   = uniq((r) => r.category === "unused");

      const wrap = document.createElement("div");

      if (inferFailed) {
        const note = document.createElement("div");
        note.className = "wem-note";
        note.textContent =
          "POST /api/v2/license/infer was unavailable, so roles were classified by " +
          "matching their permissions against the license definition instead. That " +
          "is this app's reading of the mapping, not Genesys' own — treat the " +
          "verdicts as indicative.";
        wrap.appendChild(note);
      }

      // Filter pills
      const pillsDiv = document.createElement("div");
      pillsDiv.className = "wem-pills";
      pillsDiv.innerHTML = `
        <button class="wem-pill active" data-filter="all">All<span class="wem-pill-count">${uniqueAll}</span></button>
        <button class="wem-pill" data-filter="gap">Unlicensed trigger<span class="wem-pill-count">${uniqueGap}</span></button>
        <button class="wem-pill" data-filter="licensed">Licensed<span class="wem-pill-count">${uniqueLicensed}</span></button>
        <button class="wem-pill" data-filter="unused">License unused<span class="wem-pill-count">${uniqueUnused}</span></button>
      `;
      wrap.appendChild(pillsDiv);

      pillsDiv.querySelectorAll(".wem-pill").forEach((btn) => {
        btn.addEventListener("click", () => {
          pillsDiv.querySelectorAll(".wem-pill").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          activeFilter = btn.dataset.filter;
          applyFilters();
        });
      });

      // Filter row
      const filterRow = document.createElement("div");
      filterRow.className = "rs-filter-row";
      filterRow.innerHTML = `
        <input class="rs-filter-input" id="wemFilter" placeholder="Filter by name or email…">
        <span class="rs-summary" id="wemSummary"></span>
        <button class="rs-export-btn" id="wemExportBtn">Export to Excel</button>
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
              <th>Status</th>
              <th>Triggering Role</th>
              <th>Source</th>
              <th>Triggering Permissions</th>
              <th>WEM License Assigned</th>
            </tr>
          </thead>
          <tbody id="wemTbody"></tbody>
        </table>
      `;
      wrap.appendChild(tableWrap);
      $results.appendChild(wrap);

      const $tbody = container.querySelector("#wemTbody");
      for (const row of displayRows) {
        const cat = CATEGORY[row.category];
        const permCell = row.role
          ? row.role.perms.length
            ? `<span class="wem-badge--perm" title="${escapeHtml(row.role.perms.join(", "))}">${escapeHtml(row.role.perms[0])}${row.role.perms.length > 1 ? ` +${row.role.perms.length - 1}` : ""}</span>`
            : `<span class="wem-badge--none">Not attributable</span>`
          : `<span class="wem-badge--none">—</span>`;
        const assignedCell = row.assigned.length
          ? `<span class="wem-badge--yes" title="${escapeHtml(row.assigned.join(", "))}">${escapeHtml(row.assigned.join(", "))}</span>`
          : `<span class="wem-badge--no">None</span>`;

        const tr = document.createElement("tr");
        tr.dataset.name     = row.userName;
        tr.dataset.email    = row.email;
        tr.dataset.category = row.category;
        tr.innerHTML = `
          <td>${escapeHtml(row.userName)}</td>
          <td>${escapeHtml(row.email)}</td>
          <td><span class="${cat.cls}">${cat.label}</span></td>
          <td class="rs-role-cell">${row.role ? escapeHtml(row.role.name) : "—"}</td>
          <td>${sourceBadge(row.source)}</td>
          <td>${permCell}</td>
          <td>${assignedCell}</td>
        `;
        $tbody.appendChild(tr);
      }

      container.querySelector("#wemFilter").addEventListener("input", () => applyFilters());

      applyFilters();
      hideProgress();
      setStatus(
        `Done — ${uniqueAll} user${uniqueAll !== 1 ? "s" : ""} ` +
          `(${uniqueGap} unlicensed trigger, ${uniqueLicensed} licensed, ${uniqueUnused} license unused).`,
      );

      // ── Export ──
      // Exports the full permission list, not the "+n" the table cell had to
      // truncate to: a spreadsheet has room for it, and that column is what the
      // billing conversation actually turns on.
      container.querySelector("#wemExportBtn").addEventListener("click", () => {
        const safe     = (s) => s.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
        const orgSlug  = safe(org?.name || "") || "org";
        const filename = timestampedFilename(`WEM_License_${orgSlug}`, "xlsx");
        const columns = [
          { key: "user",     label: "User",                   wch: 30 },
          { key: "email",    label: "Email",                  wch: 36 },
          { key: "status",   label: "Status",                 wch: 20 },
          { key: "role",     label: "Triggering Role",        wch: 40 },
          { key: "source",   label: "Source",                 wch: 50 },
          { key: "perms",    label: "Triggering Permissions", wch: 70 },
          { key: "assigned", label: "WEM License Assigned",   wch: 32 },
        ];
        const trs = [...container.querySelectorAll("#wemTbody tr")];
        const rows = displayRows
          .filter((_, i) => !trs[i]?.hidden)
          .map((r) => ({
            user:     r.userName,
            email:    r.email,
            status:   CATEGORY[r.category].label,
            role:     r.role ? r.role.name : "",
            source:   r.source,
            perms:    r.role ? r.role.perms.join(", ") : "",
            assigned: r.assigned.join(", "),
          }));
        try {
          exportXlsx([{ name: "WEM License", rows, columns }], filename);
        } catch (err) {
          setStatus(err.message, "error");
        }
      });
    } catch (err) {
      hideProgress();
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $searchBtn.disabled = wemLicenseIds.length === 0;
    }
  });
}
