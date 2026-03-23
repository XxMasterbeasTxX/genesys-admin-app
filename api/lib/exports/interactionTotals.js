/**
 * Server-side Interaction Totals export.
 *
 * Mirrors the browser-side logic in js/pages/export/interactions/totals.js
 * but runs headless via client credentials — no browser required.
 *
 * Requires `schedule.exportConfig.orgId` to specify which org to export.
 * Optional `schedule.exportConfig.periodPreset` (default "lastMonth").
 * Optional `schedule.exportConfig.mediaType` (default "" = all).
 * Optional `schedule.exportConfig.direction` (default "" = all).
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary, error? }
 */
const customers = require("../customers.json");
const { getGenesysToken } = require("../genesysAuth");
const XLSX = require("xlsx-js-style");
const { buildStyledWorkbook, STYLE_HEADER } = require("../excelStyles");

// ── Label maps ──────────────────────────────────────────

const MEDIA_LABELS = {
  voice: "Voice", callback: "Callback", chat: "Chat",
  email: "Email", message: "Message", cobrowse: "Cobrowse",
  screenshare: "Screen Share", internalmessage: "Internal Message",
};
const DIRECTION_LABELS = { inbound: "Inbound", outbound: "Outbound" };
const ROUTING_LABELS   = { contactcenter: "ACD", enterprise: "Non-ACD" };

function friendlyLabel(key, map) {
  return map[key?.toLowerCase?.()] || key || "Unknown";
}

// ── Date helpers ────────────────────────────────────────

function monthStart(offset) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - offset);
  return d.toISOString().slice(0, 10);
}

function lastDayOfPrevMonth() {
  const d = new Date();
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

function lastYearStart() {
  return `${new Date().getUTCFullYear() - 1}-01-01`;
}

function lastYearEnd() {
  return `${new Date().getUTCFullYear() - 1}-12-31`;
}

function lastWeekStart() {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day - 6);
  return d.toISOString().slice(0, 10);
}

function lastWeekEnd() {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function periodToInterval(preset) {
  switch (preset) {
    case "lastWeek":    return { from: lastWeekStart(), to: lastWeekEnd() };
    case "last3Months": return { from: monthStart(3), to: lastDayOfPrevMonth() };
    case "lastYear":    return { from: lastYearStart(), to: lastYearEnd() };
    case "lastMonth":
    default:            return { from: monthStart(1), to: lastDayOfPrevMonth() };
  }
}

function timestampedFilename(prefix, ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${ts}.${ext}`;
}

// ── Genesys API wrapper (server-side) ──────────────────

async function genesysFetch(customerId, method, path, body) {
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

  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`Genesys API ${resp.status} ${method} ${path}: ${errBody.slice(0, 300)}`);
  }
  return resp.json();
}

// ── Aggregates helper ───────────────────────────────────

async function fetchAggregates(orgId, interval, context) {
  const path = "/api/v2/analytics/conversations/aggregates/query";
  const makeBody = (groupBy, extraPreds = []) => {
    const body = { interval, metrics: ["nConversations"] };
    if (groupBy) body.groupBy = [groupBy];
    if (extraPreds.length) body.filter = { type: "and", predicates: extraPreds };
    return body;
  };

  context.log("Querying aggregates…");
  const [mediaResp, dirResp, routingResp, totalResp] = await Promise.all([
    genesysFetch(orgId, "POST", path, makeBody("mediaType")),
    genesysFetch(orgId, "POST", path, makeBody("originatingDirection")),
    genesysFetch(orgId, "POST", path, makeBody("interactionType")),
    genesysFetch(orgId, "POST", path, makeBody(null)),
  ]);

  function parseGrouped(resp, key) {
    const map = new Map();
    for (const r of resp.results || []) {
      const v = r.group?.[key];
      if (!v) continue;
      const c = r.data?.[0]?.metrics?.[0]?.stats?.count || 0;
      map.set(v, c);
    }
    return map;
  }
  function parseTotal(resp) {
    return resp.results?.[0]?.data?.[0]?.metrics?.[0]?.stats?.count || 0;
  }

  return {
    mediaCounts:   parseGrouped(mediaResp, "mediaType"),
    dirCounts:     parseGrouped(dirResp, "originatingDirection"),
    routingCounts: parseGrouped(routingResp, "interactionType"),
    grandTotal:    parseTotal(totalResp),
  };
}

function mapToSorted(map) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

// ── Core export logic ───────────────────────────────────

async function execute(context, schedule) {
  const config = schedule?.exportConfig || {};
  const orgId = config.orgId;
  const periodPreset = config.periodPreset || "lastMonth";

  if (!orgId) {
    return { success: false, error: "No orgId specified in export config" };
  }

  const customer = customers.find((c) => c.id === orgId);
  if (!customer) {
    return { success: false, error: `Unknown org: ${orgId}` };
  }

  context.log(`Interaction Totals export for ${customer.name} (${orgId}), period: ${periodPreset}`);

  try {
    // Build interval
    const { from, to } = periodToInterval(periodPreset);
    const interval = `${from}T00:00:00.000Z/${to}T23:59:59.999Z`;

    const { mediaCounts, dirCounts, routingCounts, grandTotal } =
      await fetchAggregates(orgId, interval, context);
    context.log(`Total conversations: ${grandTotal}`);

    // Build Excel
    const rows = [
      ["Interaction Totals"],
      [`Org: ${customer.name}`, "", `Period: ${from} — ${to}`],
      [],
    ];
    const titleRowCount = rows.length;

    const HEADERS = ["Category", "Value", "Count", "Percentage"];
    rows.push(HEADERS);
    rows.push(["Total", "All Interactions", grandTotal, "100.0%"]);
    rows.push([]);

    const mediaArr = mapToSorted(mediaCounts);
    const mediaTotal = mediaArr.reduce((s, d) => s + d.count, 0);
    for (const { key, count } of mediaArr) {
      const pct = mediaTotal > 0 ? ((count / mediaTotal) * 100).toFixed(1) + "%" : "0.0%";
      rows.push(["Media Type", friendlyLabel(key, MEDIA_LABELS), count, pct]);
    }
    rows.push([]);

    const dirArr = mapToSorted(dirCounts);
    const dirTotal = dirArr.reduce((s, d) => s + d.count, 0);
    for (const { key, count } of dirArr) {
      const pct = dirTotal > 0 ? ((count / dirTotal) * 100).toFixed(1) + "%" : "0.0%";
      rows.push(["Direction", friendlyLabel(key, DIRECTION_LABELS), count, pct]);
    }
    rows.push([]);

    const routingArr = mapToSorted(routingCounts);
    const routingTotal = routingArr.reduce((s, d) => s + d.count, 0);
    for (const { key, count } of routingArr) {
      const pct = routingTotal > 0 ? ((count / routingTotal) * 100).toFixed(1) + "%" : "0.0%";
      rows.push(["Routing", friendlyLabel(key, ROUTING_LABELS), count, pct]);
    }

    const wb = buildStyledWorkbook(rows, "Interaction Totals");
    const ws = wb.Sheets["Interaction Totals"];

    // Re-style title rows (bold, not header-blue)
    const titleStyle = { font: { bold: true, sz: 12, name: "Calibri" } };
    for (let r = 0; r < titleRowCount; r++) {
      for (let c = 0; c < 4; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (ws[addr]) ws[addr].s = titleStyle;
      }
    }
    // Apply header style to real column header row
    for (let c = 0; c < HEADERS.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: titleRowCount, c });
      if (ws[addr]) ws[addr].s = STYLE_HEADER;
    }
    // Freeze pane below the header row
    ws["!views"] = [{ state: "frozen", ySplit: titleRowCount + 1 }];
    const lastRow = rows.length - 1;
    ws["!autofilter"] = {
      ref: `${XLSX.utils.encode_cell({ r: titleRowCount, c: 0 })}:${XLSX.utils.encode_cell({ r: lastRow, c: HEADERS.length - 1 })}`,
    };

    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    const base64 = Buffer.from(buf).toString("base64");
    const filename = timestampedFilename(`InteractionTotals_${customer.name.replace(/\s+/g, "_")}`, "xlsx");

    const summary = `${customer.name}: ${grandTotal.toLocaleString()} interactions (${from} to ${to})`;

    return {
      success: true,
      filename,
      base64,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      summary,
    };
  } catch (err) {
    context.log.error(`Interaction Totals export error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
