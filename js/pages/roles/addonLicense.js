/**
 * Add-on License Analysis — shared engine for the WEM and STA tabs.
 *
 * Finds every user whose roles carry a permission that triggers an add-on
 * license, and cross-checks that against the licenses actually assigned.
 *
 * Nothing here is scraped. Genesys publishes no list of add-on-triggering
 * permissions, but it exposes the mapping as an API, per org:
 *
 *   POST /api/v2/license/infer        [roleId]  -> [licenseId]
 *        The same inference the Genesys admin UI runs when it warns that a
 *        role needs a license. Its answer is the billing answer, so it — not a
 *        permission comparison of our own — decides the verdict.
 *
 *        It also applies Genesys' precedence between add-ons. A user who
 *        would qualify for both WEM and STA is assigned WEM alone ("each user
 *        can be assigned only one add-on at a time"), and infer returns WEM
 *        alone — measured across two orgs, 2026-09-04. So each tab sees only
 *        the users its own licence actually covers, and no page-side
 *        precedence handling is needed.
 *
 *   GET  /api/v2/license/definitions  every license the org can hold, each
 *        with permissions.ids / prerequisites / comprises. Used only to name
 *        *which* permissions triggered a role, which is presentation.
 *
 *   GET  /api/v2/license/users        the licenses a user is really assigned.
 *
 * What that COSTS depends on the org's licensing model, which no API exposes —
 * `/api/v2/license/organization` is POST-only and nothing in the spec carries a
 * billing-model field. On named licensing each triggering user is a billable
 * seat; on concurrent they are merely eligible, and the org pays for the peak
 * number logged in simultaneously. So this page reports the mechanism and
 * deliberately says nothing about the bill.
 *
 * `renderAddonContent(container, ctx, cfg)` takes a descriptor saying which
 * add-on to analyse — see wemLicense.js and staLicense.js, which bind one each
 * and are what search.js imports.
 *
 * Descriptor:
 *   name             short name used in copy ("WEM")
 *   longName         full name for the intro line
 *   hint             RegExp identifying the add-on among license definitions,
 *                    tested against id and description
 *   bundledFromTier  cloudCX tier at which the add-on stops existing because
 *                    the base license includes it, or null if never bundled
 *   domPrefix        prefix for element ids, so two tabs can coexist
 *   filePrefix       export filename stem
 *   supersededBy     RegExp matching an add-on that outranks this one, used
 *                    only to explain an empty result; omit if nothing does
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

// Which definitions count as *this* add-on comes from the descriptor's `hint`,
// a regex rather than a hardcoded id list, because which SKUs an org holds
// varies: WEM is gc1WEMupgrade on CX1 and gc2WEMupgrade on CX2, and STA is
// gcSTAupgrade at both. Matched 3/3 on live orgs.
//
// The page acts on the hint itself and reports what it found. It is
// deliberately not a control: each tab answers one question — who holds this
// licence and how they got it — and a picker would both widen that and depend
// on the one thing an admin has no reason to know, which id is which. If a
// hint ever misses an org, fix the hint.
//
// An add-on stops existing above `bundledFromTier`, because the base license
// includes it — CX3 bundles both WEM and STA. `/license/definitions` returns
// only what an org can actually hold, so there the SKU is genuinely absent
// rather than merely unselected: its absence is the answer, not a failure to
// find it. Milestone (CX2, no WEM) proves the same holds for entitlement and
// not just tier.
//
// The id list stays a list even though most orgs hold one. It costs nothing,
// and it keeps working if Genesys renames or adds a tier.
const BASE_TIER = /^cloudCX(\d+)/i;

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
async function addonOnlyPermissions(api, orgId, licenseIds, listed, cache) {
  const byId = new Map(listed.map((d) => [d.id, d]));
  const selected = new Set(licenseIds);
  const out = new Set();

  // Net each licence against ITS OWN prerequisites, then union the results.
  //
  // Unioning everything first and subtracting everything after lets one SKU's
  // base cancel another SKU's triggers. An org holding both WEM upgrades hit
  // exactly that: Quality Management requires the add-on on CX 1, so quality
  // permissions are in gc1WEMupgrade — but they are bundled into cloudCX2,
  // which is gc2WEMupgrade's prerequisite. Subtracting globally erased them,
  // and a Quality Administrator role came back "Not attributable" while
  // /license/infer still said it needed WEM.
  for (const id of licenseIds) {
    const def = await resolveDefinition(api, orgId, byId.get(id) || id, cache);
    if (!def) continue;

    const granted = await collectPermissions(api, orgId, def, cache);

    const base = new Set();
    for (const pre of def.prerequisites || []) {
      const preId = typeof pre === "string" ? pre : pre?.id;
      // A selected licence is never its own base: if one WEM SKU lists another
      // as a prerequisite, subtracting it would empty the result.
      if (selected.has(preId)) continue;
      for (const p of await collectPermissions(api, orgId, pre, cache)) base.add(p);
    }

    for (const p of granted) if (!base.has(p)) out.add(p);
  }

  return out;
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
 *
 * The wildcard expansion should now be inert. Genesys deprecated the
 * "including any future permissions" logic behind All Permissions effective
 * 2026-06-01: existing roles were refreshed to explicit permissions, and API
 * responses expand wildcards rather than returning `*`. Kept as a safety net —
 * regional rollouts lag, and a bare `*` reaching here is a useful signal that
 * an org was not migrated, rather than something to silently drop.
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
  gap:      { label: "Unlicensed trigger", cls: "addon-cat-gap" },
  licensed: { label: "Licensed",           cls: "addon-cat-ok" },
};

/**
 * There is deliberately no "licence but no trigger" category.
 *
 * It cannot occur. An add-on licence is only ever held because a permission asked
 * for it: on named licensing the licence follows the permission, and on
 * concurrent the set is recalculated each billing period, so a user with no
 * triggering role in the next period simply is not assigned one. The only way
 * to hold a licence with nothing asking for it is transiently, mid-period after
 * a role is removed — which self-heals and is not actionable.
 */
function categorise(assigned) {
  return assigned ? "licensed" : "gap";
}

// ── Public entry-point ────────────────────────────────────────────────────────

export function renderAddonContent(container, { me, api, orgContext }, cfg) {
  const P = cfg.domPrefix;
  container.innerHTML = `
    <style>
      .addon-pills { display:flex; gap:6px; margin-bottom:16px; flex-wrap:wrap; }
      .addon-pill { padding:6px 18px; border-radius:20px; border:1px solid var(--border); background:transparent;
                  color:var(--muted); cursor:pointer; font:inherit; font-size:13px; font-weight:600;
                  transition:background .12s, color .12s, border-color .12s; user-select:none; }
      .addon-pill:hover:not(.active) { border-color:#6b7280; color:var(--text); }
      .addon-pill.active { background:rgba(59,130,246,.22); border-color:#3b82f6; color:#60a5fa; }
      .addon-pill .addon-pill-count { margin-left:6px; font-size:11px; opacity:.7; }
      /* ── License picker ── */
      /* ── Scope line ── */
      .addon-scope { font-size:13px; color:var(--muted); margin-bottom:16px; max-width:760px; line-height:1.6; }
      .addon-scope strong { color:#93c5fd; font-weight:600; }
      /* ── Permission badge ── */
      .addon-badge--perm { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600;
                         white-space:nowrap; background:rgba(239,68,68,.15); color:#fca5a5; border:1px solid #ef4444; margin:1px 2px; }
      .addon-badge--none { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600;
                         white-space:nowrap; background:rgba(107,114,128,.15); color:var(--muted); border:1px solid var(--border); }
      .addon-badge--yes { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600;
                        background:rgba(22,163,74,.12); color:#86efac; border:1px solid #16a34a; }
      .addon-badge--no { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600;
                       background:rgba(239,68,68,.15); color:#fca5a5; border:1px solid #ef4444; }
      /* ── Category colour ── */
      .addon-pill--roles { margin-left:6px; border-left-width:1px; }
      .addon-num { text-align:right; font-variant-numeric:tabular-nums; width:1%; white-space:nowrap; }
      .addon-cat-gap    { color:#fca5a5; font-weight:600; }
      .addon-cat-ok     { color:#86efac; font-weight:600; }
      /* Cost caveat — the page cannot know the org's licensing model. */
      .addon-note--model { font-size:12px; color:var(--muted); margin:12px 0 0; max-width:760px; line-height:1.5; }
      /* ── Fallback note ── */
      .addon-note { font-size:12px; color:#fbbf24; margin-bottom:12px; max-width:760px; line-height:1.5; }
    </style>

    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">
      Find every user whose roles carry a permission that triggers a
      <strong>${escapeHtml(cfg.longName)}</strong> add-on license, and whether a ${escapeHtml(cfg.name)} license is
      also assigned to them:
      <span style="color:#fca5a5;font-weight:600">Unlicensed trigger</span> (holds a triggering
      permission, no ${escapeHtml(cfg.name)} license assigned) or
      <span style="color:#86efac;font-weight:600">Licensed</span> (both).
    </p>

    <p class="addon-scope" id="${P}Scope">Loading license definitions…</p>

    <div style="margin-bottom:18px">
      <button class="rs-search-btn" id="${P}SearchBtn" disabled>Search</button>
    </div>

    <div class="rs-status" id="${P}Status"></div>
    <div class="rs-progress-wrap" id="${P}ProgressWrap" style="display:none">
      <div class="rs-progress-track"><div class="rs-progress-fill" id="${P}ProgressFill"></div></div>
      <div class="rs-progress-detail" id="${P}ProgressDetail"></div>
    </div>

    <div id="${P}Results">
      <div class="rs-empty">
        <div class="rs-empty-icon">🎧</div>
        <p>Click <strong>Search</strong> to check this org.</p>
      </div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────────
  const $scope          = container.querySelector(`#${P}Scope`);
  const $searchBtn      = container.querySelector(`#${P}SearchBtn`);
  const $status         = container.querySelector(`#${P}Status`);
  const $progressWrap   = container.querySelector(`#${P}ProgressWrap`);
  const $progressFill   = container.querySelector(`#${P}ProgressFill`);
  const $progressDetail = container.querySelector(`#${P}ProgressDetail`);
  const $results        = container.querySelector(`#${P}Results`);

  let activeFilter = "all"; // "all" | "gap" | "licensed"
  let listedDefs    = [];
  let licenseIds = [];

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

  // ── Identify the add-on ───────────────────────────────────
  // Read-only. The tab has one job — who holds this licence, and how they got
  // it — so it works out which SKU that is and says so. It does not offer the
  // choice: an escape hatch would need exactly the knowledge an admin does not
  // have (which id is which), so it could only ever help whoever is debugging
  // it. If the hint ever misses an org, the hint is what gets fixed.
  (async function identifyAddonLicense() {
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

      licenseIds = listedDefs
        .filter((d) => cfg.hint.test(d.id || "") || cfg.hint.test(d.description || ""))
        .map((d) => d.id);

      if (licenseIds.length) {
        $scope.innerHTML =
          `Checking against ${licenseIds.map((id) => `<strong>${escapeHtml(id)}</strong>`).join(" and ")}.`;
        $searchBtn.disabled = false;
        return;
      }

      // No add-on. Two reasons, one conclusion: nobody here can be holding
      // this licence, so there is nothing for this check to find.
      const base = highestBaseTier(listedDefs);
      const bundled = base && base.tier >= cfg.bundledFromTier;
      $searchBtn.disabled = true;
      $scope.innerHTML = bundled
        ? `This org has no separate ${escapeHtml(cfg.name)} add-on — <strong>${escapeHtml(base.id)}</strong> includes ${escapeHtml(cfg.name)}.`
        : `This org has no ${escapeHtml(cfg.name)} add-on.`;
      $results.innerHTML = `<div class="rs-empty">
        <div class="rs-empty-icon">📦</div>
        <p>${bundled
              ? `<strong>${escapeHtml(base.id)}</strong> already includes ${escapeHtml(cfg.name)}.`
              : `No ${escapeHtml(cfg.name)} add-on for this org.`}</p>
        <p style="font-size:13px;max-width:46ch;margin:8px auto 0">
          There is no separate ${escapeHtml(cfg.name)} licence for anyone here to hold, so nobody
          can be carrying a ${escapeHtml(cfg.name)} permission this org is not paying for.
        </p>
      </div>`;
    } catch (err) {
      $scope.innerHTML = `<span style="color:#f87171">Could not load license definitions: ${escapeHtml(err.message)}</span>`;
    }
  })();


  // ── Filters ───────────────────────────────────────────────
  function applyFilters() {
    const $tbody = container.querySelector(`#${P}Tbody`);
    if (!$tbody) return;
    const q = (container.querySelector(`#${P}Filter`)?.value || "").toLowerCase();
    const $summaryEl = container.querySelector(`#${P}Summary`);
    const $userWrap  = $tbody.closest(".rs-table-wrap");
    const $roleWrap  = container.querySelector(`#${P}RoleWrap`);
    const $filterEl  = container.querySelector(`#${P}Filter`);

    // The Roles pill swaps the table rather than filtering it: it answers a
    // different question from the other three, over the same data.
    if (activeFilter === "roles") {
      if ($userWrap) $userWrap.hidden = true;
      if ($roleWrap) $roleWrap.hidden = false;
      if ($filterEl) $filterEl.placeholder = "Filter by role\u2026";

      let shown = 0, total = 0;
      for (const tr of container.querySelectorAll(`#${P}RoleTbody tr`)) {
        total++;
        const show = !q || (tr.dataset.name || "").toLowerCase().includes(q);
        tr.hidden = !show;
        if (show) shown++;
      }
      if ($summaryEl) {
        $summaryEl.textContent = shown === total
          ? `${total} role${total !== 1 ? "s" : ""}`
          : `${shown} of ${total} roles`;
      }
      return;
    }

    if ($userWrap) $userWrap.hidden = false;
    if ($roleWrap) $roleWrap.hidden = true;
    if ($filterEl) $filterEl.placeholder = "Filter by name or email\u2026";

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

    const $summary = container.querySelector(`#${P}Summary`);
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
    const addonIds = licenseIds;
    if (!addonIds.length) {
      setStatus(`Select at least one ${cfg.name} license.`, "error");
      return;
    }

    $searchBtn.disabled = true;
    activeFilter = "all";
    $results.innerHTML = "";
    setStatus("Resolving license definitions…");

    try {
      // ── Step 0: the permissions the selected licenses add ──
      const defCache  = new Map();
      const addonPerms  = await addonOnlyPermissions(api, org.id, addonIds, listedDefs, defCache);
      const permIndex = buildPermissionIndex(addonPerms);
      const addonIdSet  = new Set(addonIds);

      setStatus(
        `${addonPerms.size} permission${addonPerms.size !== 1 ? "s" : ""} attributed to the selected license(s). ` +
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
          // org where the add-on is widely deployed the matched set approaches the
          // whole directory, so that loop was the page's real scaling cost —
          // an order of magnitude more requests than the per-role infer calls.
          expand: ["authorization", "groups"],
          // Active users only, which is /api/v2/users' default. Inactive
          // accounts are deliberately out of scope: they do not count towards
          // licence billing, so a deactivated user holding the licence is
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

      // ── Step 2: which roles trigger the add-on? ──
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
        `Asking Genesys which of ${usedRoleIds.size} in-use role${usedRoleIds.size !== 1 ? "s" : ""} require a ${cfg.name} license…`,
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
              triggers = inferred.some((l) => addonIdSet.has(l));
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

      // ── Step 3: users who trigger, or hold the license, or both ──
      const matchedUsers = [];
      for (const user of allUsers) {
        const ids  = userRoleIds.get(user.id) || [];
        const hits = ids.filter((id) => triggeringRoles.has(id));
        const assigned = [...(assignedMap.get(user.id) || [])].filter((l) =>
          addonIdSet.has(l),
        );
        if (!hits.length) continue;
        matchedUsers.push({
          userId: user.id,
          userName: user.name || user.username || user.id,
          email: user.email || "",
          triggeringRoleIds: hits,
          assigned,
          category: categorise(assigned.length > 0),
          groups: user.groups || [],
        });
      }

      if (!matchedUsers.length) {
        hideProgress();
        setStatus("");

        // On an org that also holds a superseding add-on, "nobody" is the
        // answer rather than a failed search, and saying so is the difference
        // between a result and a blank screen. Genesys assigns each user one
        // add-on and /license/infer applies the precedence itself, so everyone
        // who would trigger this licence is counted against the bigger one —
        // measured on an org holding both, where this tab correctly finds
        // nobody while the other carries the whole population.
        const superseder = cfg.supersededBy
          ? listedDefs.find((d) => cfg.supersededBy.test(d.id || "")
                                || cfg.supersededBy.test(d.description || ""))
          : null;

        $results.innerHTML = `<div class="rs-empty"><div class="rs-empty-icon">👥</div>
          <p>No user in this org holds a permission that triggers <strong>${escapeHtml(addonIds.join(", "))}</strong>.</p>
          ${superseder ? `<p style="font-size:13px;max-width:52ch;margin:8px auto 0">
            This org also holds <strong>${escapeHtml(superseder.id)}</strong>, which takes precedence over
            ${escapeHtml(cfg.name)}. Genesys assigns each user only one add-on, so anyone who would
            trigger ${escapeHtml(cfg.name)} is counted against <strong>${escapeHtml(superseder.id)}</strong>
            instead — check that tab rather than this one.
          </p>` : ""}</div>`;
        return;
      }

      matchedUsers.sort((a, b) =>
        a.userName.localeCompare(b.userName, undefined, { sensitivity: "base" }),
      );

      // ── Step 4: resolve group grants for source attribution ──
      // Group memberships already arrived with the bulk user fetch, so the only
      // per-object work left is reading each group's role grants — and only for
      // groups belonging to users who actually have a triggering role to
      // attribute, and every matched user has one.
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
      // One row per user × triggering role. Every matched user has at least
      // one, so there is no roleless branch.
      const displayRows = [];
      for (const u of matchedUsers) {
        for (const roleId of u.triggeringRoleIds) {
          displayRows.push({
            ...u,
            roleId,
            role: triggeringRoles.get(roleId),
            source: buildSourceLabel(roleId, u.groups, groupGrantsCache, groupNameCache),
          });
        }
      }

      // ── Step 5b: the same rows, grouped by role ──
      // A user list answers "is this person meant to have it". A role list
      // answers "what do I change" — and one role usually accounts for most of
      // the table, so this is the shape you act on. Sorted by blast radius.
      const roleRows = [];
      {
        const byRole = new Map();
        for (const r of displayRows) {
          if (!byRole.has(r.roleId)) {
            byRole.set(r.roleId, {
              name: r.role?.name || r.roleId,
              perms: r.role?.perms || [],
              users: new Set(),
              licensed: new Set(),
            });
          }
          const e = byRole.get(r.roleId);
          e.users.add(r.userId);
          if (r.category === "licensed") e.licensed.add(r.userId);
        }
        for (const e of byRole.values()) {
          roleRows.push({
            name: e.name,
            perms: e.perms,
            users: e.users.size,
            licensed: e.licensed.size,
            unlicensed: e.users.size - e.licensed.size,
          });
        }
        roleRows.sort((a, b) => b.users - a.users
          || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      }

      const uniq = (pred) => new Set(displayRows.filter(pred).map((r) => r.userId)).size;
      const uniqueAll      = uniq(() => true);
      const uniqueGap      = uniq((r) => r.category === "gap");
      const uniqueLicensed = uniq((r) => r.category === "licensed");

      const wrap = document.createElement("div");

      if (inferFailed) {
        const note = document.createElement("div");
        note.className = "addon-note";
        note.textContent =
          "POST /api/v2/license/infer was unavailable, so roles were classified by " +
          "matching their permissions against the license definition instead. That " +
          "is this app's reading of the mapping, not Genesys' own — treat the " +
          "verdicts as indicative.";
        wrap.appendChild(note);
      }

      // Filter pills
      const pillsDiv = document.createElement("div");
      pillsDiv.className = "addon-pills";
      pillsDiv.innerHTML = `
        <button class="addon-pill active" data-filter="all">All<span class="addon-pill-count">${uniqueAll}</span></button>
        <button class="addon-pill" data-filter="gap">Unlicensed trigger<span class="addon-pill-count">${uniqueGap}</span></button>
        <button class="addon-pill" data-filter="licensed">Licensed<span class="addon-pill-count">${uniqueLicensed}</span></button>
        <button class="addon-pill addon-pill--roles" data-filter="roles">Roles<span class="addon-pill-count">${roleRows.length}</span></button>
      `;
      wrap.appendChild(pillsDiv);

      pillsDiv.querySelectorAll(".addon-pill").forEach((btn) => {
        btn.addEventListener("click", () => {
          pillsDiv.querySelectorAll(".addon-pill").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          activeFilter = btn.dataset.filter;
          applyFilters();
        });
      });

      // Filter row
      const filterRow = document.createElement("div");
      filterRow.className = "rs-filter-row";
      filterRow.innerHTML = `
        <input class="rs-filter-input" id="${P}Filter" placeholder="Filter by name or email…">
        <span class="rs-summary" id="${P}Summary"></span>
        <button class="rs-export-btn" id="${P}ExportBtn">Export to Excel</button>
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
              <th>${escapeHtml(cfg.name)} License Assigned</th>
            </tr>
          </thead>
          <tbody id="${P}Tbody"></tbody>
        </table>
      `;
      wrap.appendChild(tableWrap);

      const roleWrap = document.createElement("div");
      roleWrap.className = "rs-table-wrap";
      roleWrap.id = `${P}RoleWrap`;
      roleWrap.hidden = true;
      roleWrap.innerHTML = `
        <table class="rs-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Users</th>
              <th>Licensed</th>
              <th>Unlicensed</th>
              <th>Triggering Permissions</th>
            </tr>
          </thead>
          <tbody id="${P}RoleTbody"></tbody>
        </table>
      `;
      wrap.appendChild(roleWrap);
      $results.appendChild(wrap);

      const $tbody = container.querySelector(`#${P}Tbody`);
      for (const row of displayRows) {
        const cat = CATEGORY[row.category];
        const permCell = row.role
          ? row.role.perms.length
            ? `<span class="addon-badge--perm" title="${escapeHtml(row.role.perms.join(", "))}">${escapeHtml(row.role.perms[0])}${row.role.perms.length > 1 ? ` +${row.role.perms.length - 1}` : ""}</span>`
            : `<span class="addon-badge--none">Not attributable</span>`
          : `<span class="addon-badge--none">—</span>`;
        const assignedCell = row.assigned.length
          ? `<span class="addon-badge--yes" title="${escapeHtml(row.assigned.join(", "))}">${escapeHtml(row.assigned.join(", "))}</span>`
          : `<span class="addon-badge--no">None</span>`;

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

      // The page cannot know whether this org is on named or concurrent
      // licensing, and the two make the same figures mean different things.
      // Say so rather than let the reader assume one.
      const modelNote = document.createElement("p");
      modelNote.className = "addon-note--model";
      modelNote.textContent =
        "What this costs depends on your licensing model. With named licensing each " +
        "triggering user is a billable seat. With concurrent licensing they are only " +
        "eligible — you are billed for the peak number logged in simultaneously during " +
        "the period, not for the total above.";
      wrap.appendChild(modelNote);

      const $roleTbody = container.querySelector(`#${P}RoleTbody`);
      for (const r of roleRows) {
        const tr = document.createElement("tr");
        tr.dataset.name = r.name;
        tr.innerHTML = `
          <td class="rs-role-cell">${escapeHtml(r.name)}</td>
          <td class="addon-num">${r.users}</td>
          <td class="addon-num"><span class="addon-cat-ok">${r.licensed || ""}</span></td>
          <td class="addon-num"><span class="addon-cat-gap">${r.unlicensed || ""}</span></td>
          <td>${r.perms.length
            ? `<span class="addon-badge--perm" title="${escapeHtml(r.perms.join(", "))}">${escapeHtml(r.perms[0])}${r.perms.length > 1 ? ` +${r.perms.length - 1}` : ""}</span>`
            : `<span class="addon-badge--none">Not attributable</span>`}</td>
        `;
        $roleTbody.appendChild(tr);
      }

      container.querySelector(`#${P}Filter`).addEventListener("input", () => applyFilters());

      applyFilters();
      hideProgress();
      setStatus(
        `Done — ${uniqueAll} user${uniqueAll !== 1 ? "s" : ""} ` +
          `(${uniqueGap} unlicensed trigger, ${uniqueLicensed} licensed).`,
      );

      // ── Export ──
      // Exports the full permission list, not the "+n" the table cell had to
      // truncate to: a spreadsheet has room for it, and that column is what the
      // billing conversation actually turns on.
      container.querySelector(`#${P}ExportBtn`).addEventListener("click", () => {
        const safe     = (s) => s.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
        const orgSlug  = safe(org?.name || "") || "org";
        const filename = timestampedFilename(`${cfg.filePrefix}_${orgSlug}`, "xlsx");
        const columns = [
          { key: "user",     label: "User",                   wch: 30 },
          { key: "email",    label: "Email",                  wch: 36 },
          { key: "status",   label: "Status",                 wch: 20 },
          { key: "role",     label: "Triggering Role",        wch: 40 },
          { key: "source",   label: "Source",                 wch: 50 },
          { key: "perms",    label: "Triggering Permissions", wch: 70 },
          { key: "assigned", label: `${cfg.name} License Assigned`, wch: 32 },
        ];
        // Export the view you are looking at, and only its visible rows.
        if (activeFilter === "roles") {
          const rtrs = [...container.querySelectorAll(`#${P}RoleTbody tr`)];
          const roleCols = [
            { key: "role",       label: "Role",                   wch: 44 },
            { key: "users",      label: "Users",                  wch: 8  },
            { key: "licensed",   label: "Licensed",               wch: 10 },
            { key: "unlicensed", label: "Unlicensed",             wch: 12 },
            { key: "perms",      label: "Triggering Permissions", wch: 70 },
          ];
          const rrows = roleRows
            .filter((_, i) => !rtrs[i]?.hidden)
            .map((r) => ({
              role: r.name, users: r.users, licensed: r.licensed,
              unlicensed: r.unlicensed, perms: r.perms.join(", "),
            }));
          try {
            exportXlsx([{ name: `${cfg.name} Roles`, rows: rrows, columns: roleCols }],
              timestampedFilename(`${cfg.filePrefix}_Roles_${orgSlug}`, "xlsx"));
          } catch (err) {
            setStatus(err.message, "error");
          }
          return;
        }

        const trs = [...container.querySelectorAll(`#${P}Tbody tr`)];
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
          exportXlsx([{ name: `${cfg.name} License`, rows, columns }], filename);
        } catch (err) {
          setStatus(err.message, "error");
        }
      });
    } catch (err) {
      hideProgress();
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $searchBtn.disabled = licenseIds.length === 0;
    }
  });
}
