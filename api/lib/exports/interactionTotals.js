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
const ROUTING_LABELS   = { acd: "ACD", "non-acd": "Non-ACD" };

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

// ── Genesys API wrappers (server-side) ──────────────────

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

async function submitJob(orgId, interval, jobBody) {
  const body = { ...jobBody, interval };
  const resp = await genesysFetch(orgId, "POST",
    "/api/v2/analytics/conversations/details/jobs", body);
  return resp.jobId;
}

async function pollJob(orgId, jobId, context) {
  const MAX_WAIT = 10 * 60 * 1000; // 10 minutes
  const POLL_INTERVAL = 3000;
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT) {
    const status = await genesysFetch(orgId, "GET",
      `/api/v2/analytics/conversations/details/jobs/${jobId}`);
    if (status.state === "FULFILLED") return;
    if (status.state === "FAILED") throw new Error(`Job ${jobId} failed: ${status.errorMessage || "unknown"}`);
    context.log(`Job ${jobId}: ${status.state}, waiting…`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`Job ${jobId} timed out after 10 minutes`);
}

async function fetchJobResults(orgId, jobId, context) {
  const allConversations = [];
  let cursor = null;

  do {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}&pageSize=10000` : "?pageSize=10000";
    const resp = await genesysFetch(orgId, "GET",
      `/api/v2/analytics/conversations/details/jobs/${jobId}/results${qs}`);
    const items = resp.conversations || [];
    allConversations.push(...items);
    cursor = resp.cursor || null;
    context.log(`Fetched ${allConversations.length} conversations so far…`);
  } while (cursor);

  return allConversations;
}

// ── Tally conversations ─────────────────────────────────

function tallyConversations(conversations) {
  const mediaCounts = new Map();
  const dirCounts = new Map();
  let acdCount = 0;

  for (const conv of conversations) {
    const dir = conv.originatingDirection;
    if (dir) dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);

    const mediaTypes = new Set();
    let hasAcd = false;

    for (const p of conv.participants || []) {
      if (p.purpose === "acd") hasAcd = true;
      for (const s of p.sessions || []) {
        if (s.mediaType) mediaTypes.add(s.mediaType);
      }
    }

    for (const mt of mediaTypes) {
      mediaCounts.set(mt, (mediaCounts.get(mt) || 0) + 1);
    }
    if (hasAcd) acdCount++;
  }

  return { mediaCounts, dirCounts, acdCount };
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

    const jobBody = {};

    // Submit → Poll → Fetch
    context.log("Submitting analytics job…");
    const jobId = await submitJob(orgId, interval, jobBody);
    context.log(`Job submitted: ${jobId}`);

    await pollJob(orgId, jobId, context);
    context.log("Job fulfilled, fetching results…");

    const conversations = await fetchJobResults(orgId, jobId, context);
    context.log(`Total conversations: ${conversations.length}`);

    // Tally
    const { mediaCounts, dirCounts, acdCount } = tallyConversations(conversations);
    const grandTotal = conversations.length;

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

    const nonAcd = grandTotal - acdCount;
    const routingData = [
      { key: "acd", count: acdCount },
      { key: "non-acd", count: nonAcd > 0 ? nonAcd : 0 },
    ].filter(d => d.count > 0).sort((a, b) => b.count - a.count);
    for (const { key, count } of routingData) {
      const pct = grandTotal > 0 ? ((count / grandTotal) * 100).toFixed(1) + "%" : "0.0%";
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
