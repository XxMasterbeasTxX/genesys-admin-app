/**
 * Server-side Users Filtered on Role(s) export.
 *
 * Exports active users filtered to those holding at least one of the
 * configured roles. One row per user; one boolean column per selected role.
 *
 * Requires:
 *   schedule.exportConfig.orgId   — org to export
 *   schedule.exportConfig.roles   — array of role name strings
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary, error? }
 */
const customers = require("../customers.json");
const { getGenesysToken } = require("../genesysAuth");
const XLSX = require("xlsx-js-style");
const { buildStyledWorkbook } = require("../excelStyles");

const FIXED_HEADERS = ["Name", "Email", "Division"];

// ── Helpers ─────────────────────────────────────────────

function timestampedFilename(prefix, ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${ts}.${ext}`;
}

// ── Genesys API wrappers ─────────────────────────────────

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

// ── Core export logic ────────────────────────────────────

async function execute(context, schedule) {
  const config = schedule?.exportConfig || {};
  const orgId = config.orgId;
  const selectedRoles = config.roles || [];

  if (!orgId) {
    return { success: false, error: "No orgId specified in export config" };
  }
  if (!selectedRoles.length) {
    return { success: false, error: "No roles specified in export config" };
  }

  const customer = customers.find((c) => c.id === orgId);
  if (!customer) {
    return { success: false, error: `Unknown org: ${orgId}` };
  }

  context.log(`Filtered Roles export for ${customer.name} (${orgId}) — ${selectedRoles.length} role(s): ${selectedRoles.join(", ")}`);

  try {
    // Fetch active users with authorization expansion (no state=any → active only)
    context.log("Fetching active users with authorization expansion…");
    const allUsers = await genesysGetAllPages(
      orgId,
      "/api/v2/users?expand=authorization",
      500
    );
    context.log(`Fetched ${allUsers.length} users`);

    // Build rows: one per user who holds at least one selected role
    const rows = [];
    for (const user of allUsers) {
      const name     = user.name  || "N/A";
      const email    = user.email || "N/A";
      const division = user.division?.name || "N/A";

      const userRoles = new Set(
        (user.authorization?.roles || []).map(r => r.name).filter(Boolean)
      );

      // Skip users who hold none of the selected roles
      if (!selectedRoles.some(r => userRoles.has(r))) continue;

      const roleValues = selectedRoles.map(r => userRoles.has(r));
      rows.push([name, email, division, ...roleValues]);
    }

    context.log(`${rows.length} users matched out of ${allUsers.length}`);

    // Build Excel with dynamic headers
    const headers = [...FIXED_HEADERS, ...selectedRoles];
    const wsData = [headers, ...rows];
    const wb = buildStyledWorkbook(wsData, "User Roles");

    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    const base64 = Buffer.from(buf).toString("base64");
    const filename = timestampedFilename(
      `FilteredRoles_${customer.name.replace(/\s+/g, "_")}`, "xlsx"
    );

    const summary = `${customer.name}: ${rows.length} matched users, ${selectedRoles.length} role(s)`;

    return {
      success: true,
      filename,
      base64,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      summary,
    };
  } catch (err) {
    context.log.error(`Filtered Roles export error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
