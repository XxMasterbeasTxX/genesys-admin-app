/**
 * Server-side Users All Roles export.
 *
 * Mirrors the browser-side logic in js/pages/export/users/allRoles.js
 * but runs headless via client credentials — no browser required.
 *
 * Requires `schedule.exportConfig.orgId` to specify which org to export.
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary, error? }
 */
const customers = require("../customers.json");
const { getGenesysToken } = require("../genesysAuth");
const XLSX = require("xlsx-js-style");
const { buildStyledWorkbook } = require("../excelStyles");

const HEADERS = ["Index", "Name", "Email", "Division", "Active", "Date Last Login", "Role", "Assigned", "Assigned by"];

// ── Helpers ─────────────────────────────────────────────

function timestampedFilename(prefix, ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${ts}.${ext}`;
}

function formatLastLogin(dateStr) {
  if (!dateStr) return "Never";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "Never";
    return d.toLocaleString("da-DK", {
      timeZone: "Europe/Copenhagen",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return "Never"; }
}

/** Run async tasks with bounded concurrency. */
async function runBatched(tasks, concurrency = 25) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) await tasks[idx++]();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

/**
 * Build rows with Assigned / Assigned by attribution.
 * Matches by role name (unique per org).
 */
function buildRowsWithAttribution(users, userGroupMap, groupGrantsCache, groupNameCache) {
  const rows = [];
  let userIndex = 1;

  for (const user of users) {
    const roles = user.authorization?.roles || [];
    if (roles.length === 0) continue;

    const name      = user.name || "N/A";
    const email     = user.email || "N/A";
    const division  = user.division?.name || "N/A";
    const active    = user.state || "N/A";
    const lastLogin = formatLastLogin(user.dateLastLogin);
    const userGroups = userGroupMap.get(user.id) || [];

    const groupRoleNames = new Set();
    for (const g of userGroups) {
      for (const grant of (groupGrantsCache.get(g.id) || [])) {
        if (grant.role?.name) groupRoleNames.add(grant.role.name);
      }
    }

    for (const roleObj of roles) {
      const roleName = roleObj.name || roleObj.id || "";
      if (!roleName) continue;

      const sources = [];

      if (!groupRoleNames.has(roleName)) {
        sources.push({ assigned: "Manually assigned", assignedBy: "User" });
      }

      for (const g of userGroups) {
        if ((groupGrantsCache.get(g.id) || []).some(gr => gr.role?.name === roleName)) {
          sources.push({ assigned: "Inherited", assignedBy: groupNameCache.get(g.id) || g.name || g.id });
        }
      }

      if (sources.length === 0) {
        sources.push({ assigned: "Manually assigned", assignedBy: "User" });
      }

      for (const src of sources) {
        rows.push({ index: userIndex, name, email, division, active, lastLogin,
                    role: roleName, assigned: src.assigned, assignedBy: src.assignedBy });
      }
    }

    userIndex++;
  }

  return rows;
}

// ── Genesys API wrappers (server-side, client credentials) ──────────

async function genesysGet(customerId, path) {
  const customer = customers.find((c) => c.id === customerId);
  if (!customer) throw new Error(`Unknown customer: ${customerId}`);

  const envKey = `GENESYS_${customerId.replace(/-/g, "_").toUpperCase()}`;
  const clientId = process.env[`${envKey}_CLIENT_ID`];
  const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];

  if (!clientId || !clientSecret) {
    throw new Error(`Credentials not configured for ${customerId}`);
  }

  const token = await getGenesysToken(customerId, customer.region, clientId, clientSecret);
  const url = `https://api.${customer.region}${path}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Genesys API ${resp.status} for ${customerId} ${path}: ${body.slice(0, 200)}`);
  }

  return resp.json();
}

async function genesysGetAllPages(customerId, path, pageSize = 100) {
  let page = 1;
  let all = [];

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const fullPath = `${path}${separator}pageSize=${pageSize}&pageNumber=${page}`;
    const resp = await genesysGet(customerId, fullPath);

    const items = resp.entities || [];
    all = all.concat(items);

    if (items.length < pageSize || page >= (resp.pageCount ?? page)) break;
    page++;
  }

  return all;
}

// ── Core export logic ───────────────────────────────────

async function execute(context, schedule) {
  const config = schedule?.exportConfig || {};
  const orgId = config.orgId;

  if (!orgId) {
    return { success: false, error: "No orgId specified in export config" };
  }

  const customer = customers.find((c) => c.id === orgId);
  if (!customer) {
    return { success: false, error: `Unknown org: ${orgId}` };
  }

  context.log(`All Roles export for ${customer.name} (${orgId})`);

  try {
    // Fetch all users with authorization + dateLastLogin (state=any includes inactive/deleted)
    context.log("Fetching all users with role assignments…");
    const allUsers = await genesysGetAllPages(
      orgId,
      "/api/v2/users?state=any&expand=authorization,dateLastLogin",
      500
    );
    context.log(`Fetched ${allUsers.length} users`);

    // Phase 2: Fetch group memberships for users with roles
    const usersWithRoles = allUsers.filter(u => u.authorization?.roles?.length > 0);
    const userGroupMap = new Map();
    if (usersWithRoles.length > 0) {
      context.log(`Fetching group memberships for ${usersWithRoles.length} users…`);
      await runBatched(
        usersWithRoles.map(user => async () => {
          try {
            const detail = await genesysGet(orgId, `/api/v2/users/${user.id}?expand=groups`);
            userGroupMap.set(user.id, detail.groups || []);
          } catch {
            userGroupMap.set(user.id, []);
          }
        }),
        25
      );
    }

    // Phase 3: Resolve group role grants + display names
    const allGroupIds = new Set([...userGroupMap.values()].flatMap(gs => gs.map(g => g.id)));
    const groupGrantsCache = new Map();
    const groupNameCache   = new Map();
    if (allGroupIds.size > 0) {
      context.log(`Resolving role grants for ${allGroupIds.size} groups…`);
      await runBatched(
        [...allGroupIds].map(groupId => async () => {
          try {
            const [gs, gd] = await Promise.all([
              genesysGet(orgId, `/api/v2/authorization/subjects/${groupId}`),
              genesysGet(orgId, `/api/v2/groups/${groupId}`),
            ]);
            groupGrantsCache.set(groupId, gs.grants || []);
            groupNameCache.set(groupId, gd.name || groupId);
          } catch {
            groupGrantsCache.set(groupId, []);
          }
        }),
        25
      );
    }

    // Phase 4: Build rows with attribution
    const rows = buildRowsWithAttribution(allUsers, userGroupMap, groupGrantsCache, groupNameCache);
    context.log(`Built ${rows.length} rows from ${allUsers.length} users`);

    // Build Excel workbook
    const wsData = [HEADERS];
    for (const r of rows) {
      wsData.push([r.index, r.name, r.email, r.division, r.active, r.lastLogin,
                   r.role, r.assigned, r.assignedBy]);
    }
    const wb = buildStyledWorkbook(wsData, "Users Roles Export");

    // Convert to base64
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    const base64 = Buffer.from(buf).toString("base64");
    const filename = timestampedFilename(`AllRoles_${customer.name.replace(/\s+/g, "_")}`, "xlsx");

    const uniqueUsers = new Set(rows.map((r) => r.email)).size;
    const summary = `${customer.name}: ${uniqueUsers} users, ${rows.length} rows`;

    return {
      success: true,
      filename,
      base64,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      summary,
    };
  } catch (err) {
    context.log.error(`All Roles export error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
