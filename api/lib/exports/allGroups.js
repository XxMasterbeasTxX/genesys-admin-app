/**
 * Server-side Users All Groups export.
 *
 * Mirrors the browser-side logic in js/pages/export/users/allGroups.js
 * but runs headless via client credentials — no browser required.
 *
 * Requires `schedule.exportConfig.orgId` to specify which org to export.
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary, error? }
 */
const customers = require("../customers.json");
const { genesysGet, genesysGetAllPages } = require("../genesysFetch");
const XLSX = require("xlsx-js-style");
const { buildStyledWorkbook } = require("../excelStyles");

// Note: Python uses "eMail" and "LastLogin" (not "Email" / "Date Last Login")
const HEADERS = ["Index", "Name", "eMail", "Division", "Active", "LastLogin", "WorkTeam", "Group"];

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

// ── Genesys API wrappers (server-side, client credentials) ──────────

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

  context.log(`All Groups export for ${customer.name} (${orgId})`);

  try {
    // Phase 1+2: Fetch groups and users in parallel
    context.log("Phase 1+2: Fetching groups and users in parallel…");
    const [allGroupsRaw, allUsers] = await Promise.all([
      genesysGetAllPages(orgId, "/api/v2/groups", 500),
      genesysGetAllPages(orgId, "/api/v2/users?state=any&expand=groups,team,dateLastLogin", 500),
    ]);
    const groupMap = new Map(allGroupsRaw.map(g => [g.id, g.name]));
    context.log(`Fetched ${allGroupsRaw.length} groups, ${allUsers.length} users`);

    // Phase 3: Build rows — one per user-group combination
    const rows = [];
    let userIndex = 1;

    for (const user of allUsers) {
      const name      = user.name  || "n/a";
      const email     = user.email || "n/a";
      const division  = user.division?.name || "n/a";
      const active    = user.state || "n/a";
      const lastLogin = formatLastLogin(user.dateLastLogin);
      const workTeam  = user.team?.name || "";

      const groupNames = [];
      if (user.groups?.length) {
        for (const g of user.groups) {
          const gName = groupMap.get(g.id);
          if (gName) groupNames.push(gName);
        }
      }

      if (groupNames.length > 0) {
        for (const group of groupNames) {
          rows.push({ index: userIndex, name, email, division, active, lastLogin, workTeam, group });
        }
      } else {
        rows.push({ index: userIndex, name, email, division, active, lastLogin, workTeam, group: "" });
      }

      userIndex++;
    }

    context.log(`Built ${rows.length} rows from ${allUsers.length} users`);

    // Phase 4: Build Excel
    const wsData = [HEADERS];
    for (const r of rows) {
      wsData.push([r.index, r.name, r.email, r.division, r.active, r.lastLogin, r.workTeam, r.group]);
    }
    const wb = buildStyledWorkbook(wsData, "Users Groups Export");

    // Convert to base64
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    const base64 = Buffer.from(buf).toString("base64");
    const filename = timestampedFilename(`AllGroups_${customer.name.replace(/\s+/g, "_")}`, "xlsx");

    // Counted by identity, not by email. This export includes deleted users
    // (state: any) and Genesys releases a deleted user's email for reuse, so
    // emails are neither always present nor unique; the "N/A" fallback
    // collapsed them into one. Mirrors the client-side page.
    const uniqueUsers = new Set(rows.map((r) => r.index)).size;
    const summary = `${customer.name}: ${uniqueUsers} users, ${rows.length} rows`;

    return {
      success: true,
      filename,
      base64,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      summary,
    };
  } catch (err) {
    context.log.error(`All Groups export error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
