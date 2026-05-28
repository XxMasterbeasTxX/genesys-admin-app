/**
 * Server-side billing workbook builder.
 *
 * CommonJS twin of the browser modules:
 *   js/utils/billingProcessor.js
 *   js/utils/billingExcelStyles.js
 *
 * Kept self-contained (no cross-runtime imports) to match the convention
 * used by every other handler under api/lib/exports/*.js.
 *
 * If the browser-side logic changes, mirror the change here.
 */
const XLSX = require("xlsx-js-style");

// ── Processor constants (must match billingProcessor.js) ─────────────

const AI_TOKENS_PER_CONCURRENT = 350;
const AI_TOKENS_PER_NAMED      = 250;
const BYOC_MINS_PER_CONCURRENT = 6500;
const BYOC_MINS_PER_NAMED      = 5000;

const BYOC_LICENCE_NAME    = "Genesys Cloud BYOC Cloud";
const COLLABORATE_LICENCE  = "Genesys Cloud Collaborate User";
const CALL_LICENCE         = "Call";
// Substring match: "Genesys Cloud CX 2 Concurrent" etc.
const CX_LICENCE_PATTERN   = /\bCX\s*[123]\b/i;

const GROUP_FAIR_USE     = "fair-use";
const GROUP_ROLLUP       = "rollup";
const GROUP_ROLLUP_USAGE = "rollup-usage";

// ── Helpers ──────────────────────────────────────────────────────────

function num(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function groupingOf(usage) {
  return String(usage.grouping || "").trim().toLowerCase();
}

function fmtInt(n) {
  return Math.round(n).toLocaleString("en-US");
}

function fmtTokens(n) {
  return `${fmtInt(n)} tokens`;
}

function fmtDate(d) {
  if (!d) return "";
  const date = (d instanceof Date) ? d : new Date(d);
  if (isNaN(date)) return String(d);
  const yyyy = date.getUTCFullYear();
  const mm   = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ── Processor ────────────────────────────────────────────────────────

function processBillingOverview(overview) {
  const usages = Array.isArray(overview && overview.usages) ? overview.usages : [];

  const isConcurrent = usages.some((u) => /Concurrent/i.test((u && u.name) || ""));
  const licenseType  = isConcurrent ? "Concurrent" : "Named";

  let aiRollup     = 0;
  let hasAiFairUse = false;
  let hasAiRollup  = false;

  for (const u of usages) {
    const g = groupingOf(u);
    if (g === GROUP_FAIR_USE)  hasAiFairUse = true;
    if (g === GROUP_ROLLUP)  { hasAiRollup = true; aiRollup = num(u.usageQuantity); }
  }
  const hasAi     = hasAiFairUse || hasAiRollup;
  const aiFairUse = isConcurrent ? AI_TOKENS_PER_CONCURRENT : AI_TOKENS_PER_NAMED;
  if (hasAiFairUse && !hasAiRollup) aiRollup = aiFairUse;
  const aiBillable = aiRollup > aiFairUse ? aiRollup - aiFairUse : 0;

  let cxLicenseCount = 0;
  for (const u of usages) {
    if (CX_LICENCE_PATTERN.test((u && u.name) || "")) {
      cxLicenseCount += num(u.prepayQuantity);
    }
  }
  const byocCommitted = cxLicenseCount * (isConcurrent ? BYOC_MINS_PER_CONCURRENT : BYOC_MINS_PER_NAMED);

  const regularRows     = [];
  const aiBreakdownRows = [];
  const overageRows     = [];

  for (const u of usages) {
    const g         = groupingOf(u);
    const name      = String((u && u.name) || "").trim();
    const usageQty  = num(u.usageQuantity);
    const prepayQty = num(u.prepayQuantity);

    if (usageQty <= 0) continue;
    if (g === GROUP_FAIR_USE || g === GROUP_ROLLUP) continue;

    if (g === GROUP_ROLLUP_USAGE) {
      aiBreakdownRows.push({ name, committed: "", actualUsage: usageQty, onDemand: "" });
      continue;
    }

    let committed = prepayQty;
    let onDemand;

    if (name === CALL_LICENCE) {
      committed = usageQty;
      onDemand  = "";
    } else if (name === COLLABORATE_LICENCE) {
      committed = usageQty;
      onDemand  = "";
    } else if (name === BYOC_LICENCE_NAME) {
      committed = byocCommitted;
      onDemand  = Math.max(0, usageQty - byocCommitted);
    } else {
      onDemand = Math.max(0, usageQty - committed);
    }

    const row = { name, committed, actualUsage: usageQty, onDemand };
    regularRows.push(row);

    if (typeof onDemand === "number" && onDemand > 0) {
      overageRows.push({ ...row });
    }
  }

  if (hasAi && aiBillable > 0) {
    overageRows.push({
      name:        "AI Tokens - Billable",
      committed:   "",
      actualUsage: "",
      onDemand:    Math.round(aiBillable),
    });
  }

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  regularRows.sort(byName);
  aiBreakdownRows.sort(byName);
  overageRows.sort(byName);

  return {
    summary: {
      licenseType,
      startDate:     fmtDate(overview && overview.billingPeriodStartDate),
      endDate:       fmtDate(overview && overview.billingPeriodEndDate),
      billableItems: overageRows.length,
      aiFairUse,
      aiRollup,
      aiBillable,
      hasAi,
    },
    regularRows,
    aiBreakdownRows,
    overageRows,
  };
}

// ── Styles (must match billingExcelStyles.js) ────────────────────────

const BILLING_HEADERS = ["Name", "Committed", "Actual Usage", "On-Demand"];

const BORDER_THIN = {
  top:    { style: "thin", color: { rgb: "D3D3D3" } },
  bottom: { style: "thin", color: { rgb: "D3D3D3" } },
  left:   { style: "thin", color: { rgb: "D3D3D3" } },
  right:  { style: "thin", color: { rgb: "D3D3D3" } },
};

const STYLE_COLUMN_HEADER = {
  fill: { fgColor: { rgb: "366092" } },
  font: { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "center", vertical: "center" },
  border: BORDER_THIN,
};
const STYLE_SUMMARY_HEADER = {
  fill: { fgColor: { rgb: "4472C4" } },
  font: { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER_THIN,
};
const STYLE_SUMMARY_ROW = {
  fill: { fgColor: { rgb: "E7E6E6" } },
  font: { bold: true, sz: 10, color: { rgb: "000000" }, name: "Calibri" },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER_THIN,
};
const STYLE_DIVIDER = {
  fill: { fgColor: { rgb: "70AD47" } },
  font: { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER_THIN,
};
const STYLE_DATA_NAME = {
  font: { sz: 10, color: { rgb: "000000" }, name: "Calibri" },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER_THIN,
};
const STYLE_DATA_NUMBER = {
  font: { sz: 10, color: { rgb: "000000" }, name: "Calibri" },
  alignment: { horizontal: "right", vertical: "center" },
  numFmt: "#,##0",
  border: BORDER_THIN,
};
const STYLE_DATA_TEXT = {
  font: { sz: 10, color: { rgb: "000000" }, name: "Calibri" },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER_THIN,
};
const STYLE_OVERAGE_NAME = {
  fill: { fgColor: { rgb: "C00C0C" } },
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER_THIN,
};
const STYLE_OVERAGE_NUMBER = {
  fill: { fgColor: { rgb: "C00C0C" } },
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "right", vertical: "center" },
  numFmt: "#,##0",
  border: BORDER_THIN,
};
const STYLE_OVERAGE_TEXT = {
  fill: { fgColor: { rgb: "C00C0C" } },
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "left", vertical: "center" },
  border: BORDER_THIN,
};

// ── Sheet builder ────────────────────────────────────────────────────

function tokensLabel(n) {
  return `${Math.round(n).toLocaleString("en-US")} tokens`;
}

function writeRow(ws, state, values, styles) {
  for (let c = 0; c < values.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: state.row, c });
    const v = values[c];
    const isNum = typeof v === "number" && Number.isFinite(v);
    ws[addr] = { t: isNum ? "n" : "s", v: v == null ? "" : v };
    if (styles[c]) ws[addr].s = styles[c];
  }
  state.row += 1;
}

function writeMergedBanner(ws, state, text, style) {
  writeRow(ws, state, [text, "", "", ""], [style, style, style, style]);
  ws["!merges"] = ws["!merges"] || [];
  ws["!merges"].push({ s: { r: state.row - 1, c: 0 }, e: { r: state.row - 1, c: 3 } });
}

function writeKv(ws, state, key, value) {
  writeRow(ws, state, [key, value, "", ""], [STYLE_SUMMARY_ROW, STYLE_SUMMARY_ROW, STYLE_SUMMARY_ROW, STYLE_SUMMARY_ROW]);
  ws["!merges"] = ws["!merges"] || [];
  ws["!merges"].push({ s: { r: state.row - 1, c: 1 }, e: { r: state.row - 1, c: 3 } });
}

function writeBlankRow(ws, state) { state.row += 1; }

function writeDataRow(ws, state, row, isOverage) {
  const nameStyle = isOverage ? STYLE_OVERAGE_NAME   : STYLE_DATA_NAME;
  const numStyle  = isOverage ? STYLE_OVERAGE_NUMBER : STYLE_DATA_NUMBER;
  const txtStyle  = isOverage ? STYLE_OVERAGE_TEXT   : STYLE_DATA_TEXT;
  writeRow(ws, state,
    [row.name, row.committed, row.actualUsage, row.onDemand],
    [
      nameStyle,
      typeof row.committed   === "number" ? numStyle : txtStyle,
      typeof row.actualUsage === "number" ? numStyle : txtStyle,
      typeof row.onDemand    === "number" ? numStyle : txtStyle,
    ]);
}

function refreshSheetRef(ws, lastRowExclusive) {
  const lastRow = Math.max(0, lastRowExclusive - 1);
  ws["!ref"] = `A1:${XLSX.utils.encode_col(3)}${lastRow + 1}`;
}

function safeSheetName(name) {
  return String(name || "Sheet1").replace(/[\\\/\?\*\[\]:]/g, "_").slice(0, 31);
}

function appendBillingBlock(ws, state, processed, opts) {
  const orgName     = opts && opts.orgName;
  const periodLabel = opts && opts.periodLabel;
  const { summary, regularRows, aiBreakdownRows, overageRows } = processed;

  if (periodLabel) writeMergedBanner(ws, state, periodLabel, STYLE_SUMMARY_HEADER);

  const headerLabel = orgName
    ? `─── BILLING SUMMARY: ${orgName} ───`
    : "─── BILLING SUMMARY ───";
  writeMergedBanner(ws, state, headerLabel, STYLE_SUMMARY_HEADER);
  writeKv(ws, state, "License Type",   summary.licenseType);
  writeKv(ws, state, "Billing Period", `${summary.startDate} to ${summary.endDate}`);
  writeKv(ws, state, "Billable Items", String(summary.billableItems));

  if (summary.hasAi) {
    writeKv(ws, state, "AI Tokens - Free",       tokensLabel(summary.aiFairUse));
    writeKv(ws, state, "AI Tokens - Total Used", tokensLabel(summary.aiRollup));
    writeKv(ws, state, "AI Tokens - Billable",   tokensLabel(summary.aiBillable));
  }
  writeBlankRow(ws, state);

  writeMergedBanner(ws, state, "─── REGULAR LICENSES (All Items with Usage) ───", STYLE_DIVIDER);
  for (const r of regularRows) writeDataRow(ws, state, r, false);
  writeBlankRow(ws, state);

  if (aiBreakdownRows.length) {
    writeMergedBanner(ws, state,
      `─── AI TOKENS USAGE BREAKDOWN (${summary.licenseType} Licenses) ───`, STYLE_DIVIDER);
    for (const r of aiBreakdownRows) writeDataRow(ws, state, r, false);
    writeBlankRow(ws, state);
  }

  if (overageRows.length) {
    writeMergedBanner(ws, state,
      "─── ITEMS WITH OVERAGE AND OTHER BILLABLE ITEMS ───", STYLE_DIVIDER);
    for (const r of overageRows) writeDataRow(ws, state, r, true);
    writeBlankRow(ws, state);
  }

  refreshSheetRef(ws, state.row);
}

/**
 * Build a complete single-period billing workbook for one org.
 * @returns {Buffer} xlsx file buffer
 */
function buildSingleOrgWorkbook({ orgName, processed }) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([]);
  const state = { row: 0 };

  writeRow(ws, state, BILLING_HEADERS,
    [STYLE_COLUMN_HEADER, STYLE_COLUMN_HEADER, STYLE_COLUMN_HEADER, STYLE_COLUMN_HEADER]);
  appendBillingBlock(ws, state, processed, { orgName });

  ws["!cols"]       = [{ wch: 46 }, { wch: 22 }, { wch: 22 }, { wch: 22 }];
  ws["!views"]      = [{ state: "frozen", ySplit: 1 }];
  ws["!autofilter"] = { ref: "A1:D1" };

  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(orgName));
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
}

module.exports = {
  processBillingOverview,
  buildSingleOrgWorkbook,
  safeSheetName,
  fmtDate,
};
