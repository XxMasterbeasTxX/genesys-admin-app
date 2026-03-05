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
const { getGenesysToken } = require("../genesysAuth");
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
    // Fetch roles and active users in parallel
    context.log("Fetching authorization roles and active users in parallel…");
    const [roles, activeUsers] = await Promise.all([
      genesysGetAllPages(orgId, "/api/v2/authorization/roles", 100),
      genesysGetAllPages(orgId, "/api/v2/users", 500),
    ]);
    const activeIds = new Set(activeUsers.map(u => u.id));
    context.log(`Fetched ${roles.length} roles and ${activeUsers.length} active users`);

    // Per-role: fetch assigned users in parallel
    context.log(`Fetching user counts for ${roles.length} roles in parallel…`);
    const roleUserResults = await Promise.allSettled(
      roles.map(role => genesysGetAllPages(orgId, `/api/v2/authorization/roles/${role.id}/users`, 100))
    );
    const counts = {};
    roles.forEach((role, i) => {
      const r = roleUserResults[i];
      const users = r.status === "fulfilled" ? r.value : [];
      counts[role.id] = users.filter(u => activeIds.has(u.id)).length;
    });

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
