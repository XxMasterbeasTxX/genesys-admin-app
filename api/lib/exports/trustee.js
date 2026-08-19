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
const { genesysGet, genesysGetAllPages } = require("../genesysFetch");
const XLSX = require("xlsx-js-style");

/** Orgs walked at once. Each one fans out again internally. */
const ORG_CONCURRENCY = 6;

/**
 * Run tasks with a ceiling on how many are in flight.
 *
 * The org walk fans out per org, then per trustee, then per group, then per
 * member — so firing every org at once multiplies into hundreds of concurrent
 * proxy calls against a rate-limited API. Results keep their input order, and
 * like Promise.allSettled a rejection is reported rather than thrown.
 */
async function runSettledBatched(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;

  const run = async () => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        results[i] = { status: "fulfilled", value: await worker(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run)
  );
  return results;
}


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

    // Process all customer orgs in parallel
    const orgResults = await runSettledBatched(customers, async (cust) => {
        log.info(`Trustee export: processing ${cust.name}`);
        const localMap = new Map();

        const trusteeResp = await genesysGet(cust.id, "/api/v2/orgauthorization/trustees");
        const trustees = trusteeResp.entities || [];

        // Process all trustees in parallel
        await Promise.allSettled(trustees.map(async (trustee) => {
          const trusteeOrgName = trustee.organization?.name;
          if (!trusteeOrgName) return;
          const trusteeCustomerId = TRUSTEE_NAME_MAP[trusteeOrgName];
          if (!trusteeCustomerId) return;
          const displayName = normaliseTrusteeOrg(trusteeOrgName);
          const trusteeId = trustee.id;
          if (!trusteeId) return;

          let groups = [];
          try {
            const groupsResp = await genesysGet(cust.id, `/api/v2/orgauthorization/trustees/${trusteeId}/groups`);
            groups = groupsResp.entities || [];
          } catch (err) {
            log.warn(`Failed to get trustee groups for ${cust.name}: ${err.message}`);
            return;
          }

          // Process all groups in parallel
          await Promise.allSettled(groups.map(async (group) => {
            const groupId = group.id;
            if (!groupId) return;

            let members = [];
            try {
              members = await genesysGetAllPages(trusteeCustomerId, `/api/v2/groups/${groupId}/members`);
            } catch (err) {
              log.warn(`Failed to get group members for group ${groupId}: ${err.message}`);
              return;
            }

            // Resolve full user data for all members in parallel
            const resolvedMembers = await Promise.allSettled(members.map(async (member) => {
              let userName = member.name || null;
              let userEmail = member.email || null;
              if (!userName || !userEmail) {
                try {
                  const full = await genesysGet(trusteeCustomerId, `/api/v2/users/${member.id}`);
                  userName = userName || full.name;
                  userEmail = userEmail || full.email;
                } catch (_) { /* best effort */ }
              }
              return { name: userName || "Unknown", email: userEmail || "N/A" };
            }));

            for (const r of resolvedMembers) {
              if (r.status !== "fulfilled") continue;
              const { name: userName, email: userEmail } = r.value;
              const key = `${displayName}||${userEmail}`;
              if (!localMap.has(key)) {
                localMap.set(key, { trusteeOrg: displayName, name: userName, email: userEmail, orgs: {} });
              }
              localMap.get(key).orgs[cust.name] = true;
            }
          }));
        }));

        return { custName: cust.name, localMap };
    }, ORG_CONCURRENCY);

    // Merge all per-org results into usersMap
    for (const result of orgResults) {
      if (result.status !== "fulfilled") {
        log.error(`Error processing an org: ${result.reason?.message}`);
        continue;
      }
      for (const [key, entry] of result.value.localMap.entries()) {
        if (!usersMap.has(key)) {
          usersMap.set(key, { trusteeOrg: entry.trusteeOrg, name: entry.name, email: entry.email, orgs: {} });
        }
        Object.assign(usersMap.get(key).orgs, entry.orgs);
      }
    }

    // Build results
    const totalOrgs = customers.length;
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
