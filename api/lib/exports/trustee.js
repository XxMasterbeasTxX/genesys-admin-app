/**
 * Server-side Trustee Access Matrix export.
 *
 * Mirrors the browser-side logic in js/pages/export/users/trustee.js
 * but runs headless via client credentials — no browser required.
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary, error? }
 */
const customers = require("../customers.json");
const { getGenesysToken } = require("../genesysAuth");
const XLSX = require("xlsx-js-style");

// ── Known trustee org name variations → our internal customer id ────
const TRUSTEE_NAME_MAP = {
  "Netdesign DE": "demo",
  "NetDesign DE": "demo",
  "netdesign de": "demo",
  "Netdesign":    "test-ie",
  "NetDesign":    "test-ie",
  "netdesign":    "test-ie",
};

const TRUSTEE_SHEET_SUFFIX = {
  "Netdesign DE": "DE",
  "Netdesign":    "IE",
};

// ── Excel style constants (matching Python openpyxl formatting) ─────
const STYLE_HEADER = {
  fill:      { fgColor: { rgb: "366092" } },
  font:      { bold: true, sz: 11, color: { rgb: "FFFFFF" } },
  alignment: { horizontal: "center", vertical: "center" },
  border:    {
    top:    { style: "thin", color: { rgb: "000000" } },
    bottom: { style: "thin", color: { rgb: "000000" } },
    left:   { style: "thin", color: { rgb: "000000" } },
    right:  { style: "thin", color: { rgb: "000000" } },
  },
};
const STYLE_TRUE = {
  fill:      { fgColor: { rgb: "C6EFCE" } },
  font:      { color: { rgb: "006100" } },
  alignment: { horizontal: "center", vertical: "center" },
};
const STYLE_FALSE = {
  fill:      { fgColor: { rgb: "FFC7CE" } },
  font:      { color: { rgb: "9C0006" } },
  alignment: { horizontal: "center", vertical: "center" },
};

// ── Helpers ─────────────────────────────────────────────

function normaliseTrusteeOrg(name) {
  const lower = (name || "").toLowerCase();
  if (lower.includes("netdesign de")) return "Netdesign DE";
  if (lower === "netdesign") return "Netdesign";
  return name;
}

function getTrusteeSheetName(trusteeOrg) {
  const suffix = TRUSTEE_SHEET_SUFFIX[trusteeOrg] || trusteeOrg;
  return `Trustee Org - ${suffix}`;
}

function timestampedFilename(prefix, ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${ts}.${ext}`;
}

// ── Genesys API wrappers (server-side, using client credentials) ────

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

/**
 * Paginated GET — fetches all pages of a paginated Genesys endpoint.
 */
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

// ── Build Excel workbook ────────────────────────────────

function buildTrusteeWorkbook(byTrusteeOrg, customerNames) {
  const wb = XLSX.utils.book_new();

  for (const trusteeOrg of Object.keys(byTrusteeOrg).sort()) {
    const users = byTrusteeOrg[trusteeOrg].sort((a, b) => a.name.localeCompare(b.name));
    const activeCols = customerNames.filter((cn) => users.some((u) => u.orgs[cn]));
    const headers = ["Name", "Email", ...activeCols];

    const rows = users.map((u) => {
      const row = [u.name, u.email];
      for (const cn of activeCols) row.push(u.orgs[cn] === true);
      return row;
    });

    const wsData = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Header styles
    for (let c = 0; c < headers.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) ws[addr].s = STYLE_HEADER;
    }

    // Data cell styles
    for (let r = 0; r < rows.length; r++) {
      for (let c = 2; c < headers.length; c++) {
        const addr = XLSX.utils.encode_cell({ r: r + 1, c });
        if (ws[addr]) {
          ws[addr].s = ws[addr].v === true ? STYLE_TRUE : STYLE_FALSE;
        }
      }
    }

    // Column widths
    const colWidths = headers.map((h, i) => {
      let maxLen = h.length;
      for (const row of rows) {
        const val = String(row[i] ?? "");
        if (val.length > maxLen) maxLen = val.length;
      }
      return { wch: Math.min(maxLen + 2, 50) };
    });
    ws["!cols"] = colWidths;

    // Freeze panes + auto-filter
    ws["!views"] = [{ state: "frozen", xSplit: 2, ySplit: 1 }];
    ws["!autofilter"] = { ref: ws["!ref"] };

    XLSX.utils.book_append_sheet(wb, ws, getTrusteeSheetName(trusteeOrg).slice(0, 31));
  }

  return wb;
}

// ── Main export function ────────────────────────────────

/**
 * Execute the trustee export server-side.
 *
 * @param {Object} context   Azure Functions context (for logging)
 * @param {Object} [schedule] Schedule object (unused by trustee, included for interface compat)
 * @returns {Object} { success, filename, base64, mimeType, summary, error? }
 */
async function execute(context, schedule) {
  const log = context?.log || console;

  try {
    const usersMap = new Map();
    let processedOrgs = 0;
    const totalOrgs = customers.length;

    for (const cust of customers) {
      processedOrgs++;
      log.info(`Trustee export: processing ${processedOrgs}/${totalOrgs}: ${cust.name}`);

      try {
        // 1. Get trustees for this customer org
        const trusteeResp = await genesysGet(cust.id, "/api/v2/orgauthorization/trustees");
        const trustees = trusteeResp.entities || [];

        for (const trustee of trustees) {
          const trusteeOrgName = trustee.organization?.name;
          if (!trusteeOrgName) continue;

          const trusteeCustomerId = TRUSTEE_NAME_MAP[trusteeOrgName];
          if (!trusteeCustomerId) continue;

          const displayName = normaliseTrusteeOrg(trusteeOrgName);
          const trusteeId = trustee.id;
          if (!trusteeId) continue;

          // 2. Get groups granted to this trustee
          let groups = [];
          try {
            const groupsResp = await genesysGet(
              cust.id,
              `/api/v2/orgauthorization/trustees/${trusteeId}/groups`
            );
            groups = groupsResp.entities || [];
          } catch (err) {
            log.warn(`Failed to get trustee groups for ${cust.name}: ${err.message}`);
            continue;
          }

          for (const group of groups) {
            const groupId = group.id;
            if (!groupId) continue;

            // 3. Get group members from the TRUSTEE org
            let members = [];
            try {
              members = await genesysGetAllPages(
                trusteeCustomerId,
                `/api/v2/groups/${groupId}/members`
              );
            } catch (err) {
              log.warn(`Failed to get group members for group ${groupId}: ${err.message}`);
              continue;
            }

            for (const member of members) {
              let userName = member.name || null;
              let userEmail = member.email || null;

              // Fallback: fetch full user if name/email missing
              if (!userName || !userEmail) {
                try {
                  const full = await genesysGet(
                    trusteeCustomerId,
                    `/api/v2/users/${member.id}`
                  );
                  userName = userName || full.name;
                  userEmail = userEmail || full.email;
                } catch (_) { /* best effort */ }
              }

              userName = userName || "Unknown";
              userEmail = userEmail || "N/A";

              const key = `${displayName}||${userEmail}`;
              if (!usersMap.has(key)) {
                usersMap.set(key, {
                  trusteeOrg: displayName,
                  name: userName,
                  email: userEmail,
                  orgs: {},
                });
              }
              usersMap.get(key).orgs[cust.name] = true;
            }
          }
        }
      } catch (err) {
        log.error(`Error processing ${cust.name}: ${err.message}`);
        // Continue to next org
      }
    }

    // Build results
    const allUsers = Array.from(usersMap.values());

    if (!allUsers.length) {
      return {
        success: false,
        filename: null,
        base64: null,
        mimeType: null,
        summary: "No trustee access data found.",
        error: "No trustee access data found across any customer org.",
      };
    }

    // Group by trustee org
    const byTrusteeOrg = {};
    for (const u of allUsers) {
      if (!byTrusteeOrg[u.trusteeOrg]) byTrusteeOrg[u.trusteeOrg] = [];
      byTrusteeOrg[u.trusteeOrg].push(u);
    }

    const customerNames = customers.map((c) => c.name).sort();

    // Build Excel
    const wb = buildTrusteeWorkbook(byTrusteeOrg, customerNames);
    const base64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
    const filename = timestampedFilename("trustee_export", "xlsx");

    const summary = `Users: ${allUsers.length} • Orgs scanned: ${totalOrgs} • Trustee orgs: ${Object.keys(byTrusteeOrg).length}`;
    log.info(`Trustee export completed: ${summary}`);

    return {
      success: true,
      filename,
      base64,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      summary,
    };
  } catch (err) {
    log.error(`Trustee export failed: ${err.message}`);
    return {
      success: false,
      filename: null,
      base64: null,
      mimeType: null,
      summary: null,
      error: err.message,
    };
  }
}

module.exports = { execute };
