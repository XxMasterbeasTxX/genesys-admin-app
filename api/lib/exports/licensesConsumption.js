/**
 * Server-side License Consumption export.
 *
 * Exports a per-user licence consumption report. One row per user;
 * one boolean column per licence (or a single column when filtered).
 *
 * Requires:
 *   schedule.exportConfig.orgId         — org to export
 *   schedule.exportConfig.licenseFilter — specific licence ID, or "All Licenses" (default)
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary, error? }
 */
const customers = require("../customers.json");
const { getGenesysToken } = require("../genesysAuth");
const XLSX = require("xlsx-js-style");
const { buildStyledWorkbook } = require("../excelStyles");

const FIXED_HEADERS = ["Name", "Email", "Division"];
const ALL_LICENSES  = "All Licenses";

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
  const clientId     = process.env[`${envKey}_CLIENT_ID`];
  const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];

  if (!clientId || !clientSecret) {
    throw new Error(`Credentials not configured for ${customerId}`);
  }

  const token = await getGenesysToken(customerId, customer.region, clientId, clientSecret);
  const url   = `https://api.${customer.region}${path}`;

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
  let all  = [];

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const fullPath  = `${path}${separator}pageSize=${pageSize}&pageNumber=${page}`;
    const resp      = await genesysGet(customerId, fullPath);

    const items = resp.entities || [];
    all = all.concat(items);

    if (items.length < pageSize || page >= (resp.pageCount ?? page)) break;
    page++;
  }

  return all;
}

// ── Core export logic ────────────────────────────────────

async function execute(context, schedule) {
  const config        = schedule?.exportConfig || {};
  const orgId         = config.orgId;
  // Normalize: schedule panel may store as array (legacy) or string
  let licenseFilter   = config.licenseFilter || ALL_LICENSES;
  if (Array.isArray(licenseFilter)) licenseFilter = licenseFilter[0] || ALL_LICENSES;

  if (!orgId) {
    return { success: false, error: "No orgId specified in export config" };
  }

  const customer = customers.find((c) => c.id === orgId);
  if (!customer) {
    return { success: false, error: `Unknown org: ${orgId}` };
  }

  context.log(`License Consumption export for ${customer.name} (${orgId}) — filter: ${licenseFilter}`);

  try {
    // Step 1: fetch licence-user assignments (paginated)
    context.log("Fetching licence assignments…");
    const licenseUsers = await genesysGetAllPages(orgId, "/api/v2/license/users", 100);
    context.log(`Fetched ${licenseUsers.length} licence-user records`);

    // Build map: userId → Set<licenceId>
    // The API may return { user: { id }, licenses } or { id, licenses } — handle both
    const licenseMap = new Map();
    for (const entry of licenseUsers) {
      const userId = entry.user?.id || entry.id;
      if (userId) licenseMap.set(userId, new Set(entry.licenses || []));
    }
    context.log(`License map built: ${licenseMap.size} user entries`);
    if (licenseUsers.length > 0) {
      const sample = licenseUsers[0];
      context.log(`Sample entry keys: ${Object.keys(sample).join(", ")} — user?.id=${sample.user?.id} — id=${sample.id} — licenses count=${(sample.licenses||[]).length}`);
    }

    // Step 2: fetch all users with division expansion (paginated)
    context.log("Fetching users…");
    const allUsers = await genesysGetAllPages(orgId, "/api/v2/users?expand=division", 500);
    context.log(`Fetched ${allUsers.length} users`);

    // Step 3: determine licence columns
    let licenseColumns;
    if (licenseFilter === ALL_LICENSES) {
      const all = new Set();
      for (const [, set] of licenseMap) for (const l of set) all.add(l);
      licenseColumns = Array.from(all).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );
    } else {
      licenseColumns = [licenseFilter];
    }

    // Step 4: build rows
    const rows = [];
    for (const user of allUsers) {
      const name     = user.name          || "N/A";
      const email    = user.email         || "N/A";
      const division = user.division?.name || "N/A";

      const userLicenses = licenseMap.get(user.id) || new Set();

      // When filtered to a specific licence, skip users who don't hold it
      if (licenseFilter !== ALL_LICENSES && !userLicenses.has(licenseFilter)) continue;

      const licenseValues = licenseColumns.map(l => userLicenses.has(l));
      rows.push([name, email, division, ...licenseValues]);
    }

    context.log(`${rows.length} users in report — ${licenseColumns.length} licence column(s)`);

    // Step 5: build Excel
    const headers = [...FIXED_HEADERS, ...licenseColumns];
    const wsData  = [headers, ...rows];
    const wb      = buildStyledWorkbook(wsData, "User Licenses");

    const buf      = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    const base64   = Buffer.from(buf).toString("base64");
    const orgSlug  = customer.name.replace(/\s+/g, "_");
    const filename = timestampedFilename(`LicenseConsumption_${orgSlug}`, "xlsx");

    const filterLabel = licenseFilter === ALL_LICENSES ? "All Licenses" : licenseFilter;
    const summary = `${rows.length} user(s) — ${filterLabel} — ${licenseColumns.length} licence column(s) — ${customer.name}`;

    return {
      success: true,
      filename,
      base64,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      summary,
    };
  } catch (err) {
    context.log.error(`License Consumption export error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
