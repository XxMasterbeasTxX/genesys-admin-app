/**
 * Server-side Users Last Login export.
 *
 * Mirrors the browser-side logic in js/pages/export/users/lastLogin.js
 * but runs headless via client credentials — no browser required.
 *
 * Requires `schedule.exportConfig.orgId` to specify which org to export.
 * Optional `schedule.exportConfig.filterMonths` (default 0 = no filter).
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary, error? }
 */
const customers = require("../customers.json");
const { genesysGet, genesysGetAllPages } = require("../genesysFetch");
const XLSX = require("xlsx-js-style");
const { buildStyledWorkbook } = require("../excelStyles");

const HEADERS = ["Index", "Name", "Email", "Division", "Date Last Login", "License"];

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
  const filterMonths = config.filterMonths || 0;

  if (!orgId) {
    return { success: false, error: "No orgId specified in export config" };
  }

  const customer = customers.find((c) => c.id === orgId);
  if (!customer) {
    return { success: false, error: `Unknown org: ${orgId}` };
  }

  context.log(`Last Login export for ${customer.name} (${orgId}), filter: ${filterMonths} months`);

  try {
    // Phase 1+2: Fetch license data and users in parallel
    context.log("Phase 1+2: Fetching license data and users in parallel…");
    const [licenseUsers, allUsers] = await Promise.all([
      genesysGetAllPages(orgId, "/api/v2/license/users"),
      genesysGetAllPages(orgId, "/api/v2/users?expand=division,dateLastLogin&state=active"),
    ]);
    const licenseMap = {};
    for (const lu of licenseUsers) {
      licenseMap[lu.id] = lu.licenses || [];
    }
    context.log(`License data: ${licenseUsers.length} users, User data: ${allUsers.length} users`);

    // Phase 3: Filter by inactivity
    let filtered = allUsers;
    if (filterMonths > 0) {
      // Pin to day 1 before shifting the month: setMonth on the 31st overflows
      // into the following month (31 Mar minus one month lands on 3 Mar), which
      // moved the cutoff and let recently-active users through the filter.
      const now    = new Date();
      const cutoff = new Date(now.getFullYear(), now.getMonth() - filterMonths, 1);
      const lastDay = new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate();
      cutoff.setDate(Math.min(now.getDate(), lastDay));
      cutoff.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
      filtered = allUsers.filter((u) => {
        if (!u.dateLastLogin) return true;
        return new Date(u.dateLastLogin) < cutoff;
      });
      context.log(`Filtered: ${filtered.length}/${allUsers.length} users (inactive ≥ ${filterMonths} months)`);
    }

    // Phase 4: Build rows (one per user-license combo)
    const rows = [];
    for (const user of filtered) {
      const name = user.name || "N/A";
      const email = user.email || "N/A";
      const division = user.division?.name || "Unknown";
      const lastLogin = formatLastLogin(user.dateLastLogin);
      const licenses = licenseMap[user.id] || [];

      if (licenses.length > 0) {
        // Copy before sorting — this array belongs to the licence response.
        for (const lic of [...licenses].sort()) {
          rows.push({ name, email, division, lastLogin, license: lic });
        }
      } else {
        rows.push({ name, email, division, lastLogin, license: "" });
      }
    }
    context.log(`Built ${rows.length} rows from ${filtered.length} users`);

    // Phase 5: Build Excel
    const wsData = [HEADERS];
    rows.forEach((r, i) => {
      wsData.push([i + 1, r.name, r.email, r.division, r.lastLogin, r.license]);
    });
    const wb = buildStyledWorkbook(wsData, "Users Last Login Export");

    // Convert to base64
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    const base64 = Buffer.from(buf).toString("base64");
    const filename = timestampedFilename(`LastLogin_${customer.name.replace(/\s+/g, "_")}`, "xlsx");

    // The filtered user list is the count; row emails are a display field that
    // falls back to "N/A" and would collapse distinct users into one.
    const uniqueUsers = filtered.length;
    const summary = `${customer.name}: ${uniqueUsers} users, ${rows.length} rows` +
      (filterMonths > 0 ? ` (inactive ≥ ${filterMonths}mo)` : "");

    return {
      success: true,
      filename,
      base64,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      summary,
    };
  } catch (err) {
    context.log.error(`Last Login export error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
