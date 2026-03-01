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

// ── Excel style constants (matching Python formatting) ──────────────
const STYLE_HEADER = {
  fill:      { fgColor: { rgb: "366092" } },
  font:      { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "center", vertical: "center" },
  border: {
    top:    { style: "thin", color: { rgb: "D3D3D3" } },
    bottom: { style: "thin", color: { rgb: "D3D3D3" } },
    left:   { style: "thin", color: { rgb: "D3D3D3" } },
    right:  { style: "thin", color: { rgb: "D3D3D3" } },
  },
};

const STYLE_ROW_EVEN = {
  fill:      { fgColor: { rgb: "F2F2F2" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: {
    top:    { style: "thin", color: { rgb: "D3D3D3" } },
    bottom: { style: "thin", color: { rgb: "D3D3D3" } },
    left:   { style: "thin", color: { rgb: "D3D3D3" } },
    right:  { style: "thin", color: { rgb: "D3D3D3" } },
  },
};

const STYLE_ROW_ODD = {
  fill:      { fgColor: { rgb: "FFFFFF" } },
  alignment: { horizontal: "left", vertical: "center" },
  border: {
    top:    { style: "thin", color: { rgb: "D3D3D3" } },
    bottom: { style: "thin", color: { rgb: "D3D3D3" } },
    left:   { style: "thin", color: { rgb: "D3D3D3" } },
    right:  { style: "thin", color: { rgb: "D3D3D3" } },
  },
};

const HEADERS = ["Index", "Name", "Email", "Division", "Active", "Date Last Login", "Role"];

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

    // Build rows: one per user-role combination
    const rows = [];
    let userIndex = 1;

    for (const user of allUsers) {
      const name      = user.name || "N/A";
      const email     = user.email || "N/A";
      const division  = user.division?.name || "N/A";
      const active    = user.state || "N/A";
      const lastLogin = formatLastLogin(user.dateLastLogin);

      const roleNames = [];
      if (user.authorization?.roles?.length) {
        for (const role of user.authorization.roles) {
          if (role.name) roleNames.push(role.name);
        }
      }

      if (roleNames.length > 0) {
        for (const role of roleNames) {
          rows.push({ index: userIndex, name, email, division, active, lastLogin, role });
        }
      } else {
        rows.push({ index: userIndex, name, email, division, active, lastLogin, role: "" });
      }

      userIndex++;
    }

    context.log(`Built ${rows.length} rows from ${allUsers.length} users`);

    // Build Excel workbook
    const wb = XLSX.utils.book_new();
    const wsData = [HEADERS];
    for (const r of rows) {
      wsData.push([r.index, r.name, r.email, r.division, r.active, r.lastLogin, r.role]);
    }

    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Header styles
    for (let c = 0; c < HEADERS.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) ws[addr].s = STYLE_HEADER;
    }

    // Data styles: alternating rows
    for (let r = 0; r < rows.length; r++) {
      const style = (r + 1) % 2 === 0 ? STYLE_ROW_EVEN : STYLE_ROW_ODD;
      for (let c = 0; c < HEADERS.length; c++) {
        const addr = XLSX.utils.encode_cell({ r: r + 1, c });
        if (ws[addr]) ws[addr].s = style;
      }
    }

    // Column widths
    const colWidths = HEADERS.map((h, i) => {
      let maxLen = h.length;
      for (const row of wsData.slice(1)) {
        const val = String(row[i] ?? "");
        if (val.length > maxLen) maxLen = val.length;
      }
      return { wch: Math.min(maxLen + 2, 50) };
    });
    ws["!cols"] = colWidths;
    ws["!views"] = [{ state: "frozen", ySplit: 1 }];
    ws["!autofilter"] = { ref: ws["!ref"] };

    XLSX.utils.book_append_sheet(wb, ws, "Users Roles Export");

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
