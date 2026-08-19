/**
 * Server-side Roles — Single Org export.
 *
 * Exports all authorization roles for the configured org with accurate
 * member counts. Member counts reflect active org users only
 * (deleted and external-org users are excluded).
 *
 * Requires:
 *   schedule.exportConfig.orgId  — org to export
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary, error? }
 */
const customers = require("../customers.json");
const { genesysGet, genesysGetAllPages } = require("../genesysFetch");
const XLSX = require("xlsx-js-style");
const { buildStyledWorkbook } = require("../excelStyles");

const HEADERS = ["Name", "Description", "Members"];

// ── Helpers ──────────────────────────────────────────────

function timestampedFilename(prefix, ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${ts}.${ext}`;
}

// ── Genesys API wrappers ──────────────────────────────────

// ── Core export logic ─────────────────────────────────────

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

  context.log(`Roles Single Org export for ${customer.name} (${orgId})`);

  try {
    // Fetch roles and users (with roles embedded) in parallel — 2 calls, no per-role calls
    context.log("Fetching authorization roles and users with expand=authorization in parallel…");
    const [roles, activeUsers] = await Promise.all([
      genesysGetAllPages(orgId, "/api/v2/authorization/roles", 100),
      genesysGetAllPages(orgId, "/api/v2/users?expand=authorization", 500),
    ]);
    context.log(`Fetched ${roles.length} roles and ${activeUsers.length} users`);

    // Count role members locally from embedded authorization data
    const counts = {};
    for (const role of roles) counts[role.id] = 0;
    for (const user of activeUsers) {
      for (const r of (user.authorization?.roles || [])) {
        const rid = r.id || r.roleId;
        if (rid && counts[rid] !== undefined) counts[rid]++;
      }
    }

    // Build rows sorted alphabetically
    const rows = [...roles]
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }))
      .map(r => [r.name || "Unnamed", r.description || "", counts[r.id] ?? 0]);

    // Build Excel
    const wsData = [HEADERS, ...rows];
    const wb = buildStyledWorkbook(wsData, "Roles");

    const xlsxBuffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    const base64 = Buffer.from(xlsxBuffer).toString("base64");
    const filename = timestampedFilename(`Roles_${customer.name.replace(/\s+/g, "_")}`, "xlsx");

    return {
      success: true,
      filename,
      base64,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      summary: `${rows.length} roles — ${customer.name}`,
    };

  } catch (err) {
    context.log(`Roles Single Org export failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
