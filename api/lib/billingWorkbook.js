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

// AI detection (must mirror df_ai mask in Python GUI_Billing_Export.py)
const AI_PART_NUMBER = "GC-170-NV-AITC";
const AI_NAME_PATTERN = new RegExp(
  [
    "AI Guide",
    "AI Scoring",
    "AI Summary",
    "AI Translate",
    "Speech and Text Analytics",
    "Agent Copilot",
    "Virtual Agent",        // also covers "Agentic Virtual Agent"
    "Predictive Routing",
    "Predictive Engagement",
    "Bot Flow",
  ].join("|"),
  "i"
);

function isAiItem(name, partNumber) {
  if (partNumber === AI_PART_NUMBER) return true;
  const n = String(name || "");
  if (/AI/i.test(n) && /Token/i.test(n)) return true;
  if (AI_NAME_PATTERN.test(n)) return true;
  return false;
}

function isAiTokenStrict(name) {
  const n = String(name || "");
  return /AI/i.test(n) && /Token/i.test(n);
}

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
// Mirrors Python GUI_Billing_Export.py exactly. See js/utils/billingProcessor.js
// for the heavily-commented twin — any change here MUST be applied there too.

function processBillingOverview(overview) {
  const usages = Array.isArray(overview && overview.usages) ? overview.usages : [];

  // Pass 1: collect non-AI fair-use allocations (Voice Transcription, etc.)
  const fairUseAllocations = new Map();
  for (const u of usages) {
    const g    = groupingOf(u);
    const name = String((u && u.name) || "");
    const qty  = num(u && u.usageQuantity);
    if (g === GROUP_FAIR_USE && !isAiTokenStrict(name) && qty > 0) {
      fairUseAllocations.set(name, qty);
    }
  }

  // Pass 2: build expanded row list
  const rawRows = [];
  for (const u of usages) {
    const g          = groupingOf(u);
    const name       = String((u && u.name) || "");
    const usageQty   = num(u && u.usageQuantity);
    const partNumber = String((u && u.partNumber) || "");

    if (usageQty <= 0) continue;
    if (g === GROUP_FAIR_USE && !isAiTokenStrict(name)) continue;

    let prepayQty = num(u && u.prepayQuantity);
    if (fairUseAllocations.has(name) && prepayQty === 0) {
      prepayQty = fairUseAllocations.get(name);
    }

    rawRows.push({
      name,
      grouping:    g,
      partNumber,
      committed:   prepayQty,
      actualUsage: usageQty,
      onDemand:    Math.max(0, usageQty - prepayQty),
    });
  }

  // Split: AI vs Regular
  const aiRowsAll  = rawRows.filter((r) => isAiItem(r.name, r.partNumber));
  const regularSrc = rawRows.filter((r) => !isAiItem(r.name, r.partNumber));

  // License type — Python checks regular rows only
  const isConcurrent = regularSrc.some((r) => /Concurrent/i.test(r.name));
  const licenseType  = isConcurrent ? "Concurrent" : "Named";
  const expectedFairUse = isConcurrent ? AI_TOKENS_PER_CONCURRENT : AI_TOKENS_PER_NAMED;

  // AI summary (from AI subset only)
  let aiFairUse = 0;
  let aiRollup  = 0;
  const aiBreakdownRows = [];
  for (const r of aiRowsAll) {
    if (r.grouping === GROUP_FAIR_USE) {
      aiFairUse = r.actualUsage;
    } else if (r.grouping === GROUP_ROLLUP) {
      aiRollup = r.actualUsage;
    } else if (r.grouping === GROUP_ROLLUP_USAGE && r.actualUsage > 0) {
      aiBreakdownRows.push({
        name:        r.name,
        committed:   "",
        actualUsage: r.actualUsage,
        onDemand:    "",
      });
    }
  }
  if (aiFairUse === 0 && aiRollup > 0) aiFairUse = expectedFairUse;
  if (aiFairUse > 0  && aiRollup === 0) aiRollup  = aiFairUse;
  const aiBillable = aiRollup > aiFairUse ? aiRollup - aiFairUse : 0;
  // Python gates AI summary on `if ai_rollup > 0`. Breakdown is independent.
  const hasAi = aiRollup > 0;

  // Count CX 1/2/3 for BYOC + concurrent flag for BYOC multiplier
  let cxLicenseCount     = 0;
  let licenseTypeForByoc = "named";
  for (const r of regularSrc) {
    if (CX_LICENCE_PATTERN.test(r.name)) {
      if (typeof r.committed === "number" && r.committed > 0) {
        cxLicenseCount += r.committed;
      }
      if (/Concurrent/i.test(r.name)) licenseTypeForByoc = "concurrent";
    }
  }
  const byocMultiplier = licenseTypeForByoc === "concurrent"
    ? BYOC_MINS_PER_CONCURRENT
    : BYOC_MINS_PER_NAMED;
  const byocCommitted = cxLicenseCount > 0
    ? Math.trunc(cxLicenseCount * byocMultiplier)
    : "";

  // Apply per-license-name overrides
  const regularRows = [];
  const overageRows = [];
  for (const r of regularSrc) {
    let committed   = r.committed;
    let actualUsage = r.actualUsage;
    let onDemand    = r.onDemand;

    if (r.name === CALL_LICENCE) {
      committed = actualUsage;
      onDemand  = "";
    } else if (r.name === COLLABORATE_LICENCE) {
      committed = actualUsage;
      onDemand  = "";
    } else if (r.name === BYOC_LICENCE_NAME) {
      committed = byocCommitted;
      if (typeof committed === "number" && actualUsage > committed) {
        onDemand = actualUsage - committed;
      } else {
        onDemand = "";
      }
    }

    const out = { name: r.name, committed, actualUsage, onDemand };
    regularRows.push(out);

    if (typeof onDemand === "number" && onDemand > 0) {
      overageRows.push(Object.assign({}, out));
    }
  }

  // AI billable surfaced in overage section
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

/**
 * Build a complete "All Orgs — Latest" billing workbook.
 *
 * Mirrors the Python script GUI_Billing_Export_Scheduled_All.py +
 * export_to_excel(): a single .xlsx with ONE SHEET PER ORG (sheet name
 * = org name, truncated to Excel's 31-char limit).
 *
 * @param {object} args
 * @param {Array<{orgName: string, processed: object}>} args.orgsData
 * @returns {Buffer} xlsx file buffer
 */
function buildAllOrgsLatestWorkbook({ orgsData }) {
  const wb = XLSX.utils.book_new();

  for (const { orgName, processed } of orgsData) {
    const ws = XLSX.utils.aoa_to_sheet([]);
    const state = { row: 0 };

    writeRow(ws, state, BILLING_HEADERS,
      [STYLE_COLUMN_HEADER, STYLE_COLUMN_HEADER, STYLE_COLUMN_HEADER, STYLE_COLUMN_HEADER]);
    appendBillingBlock(ws, state, processed, { orgName });

    ws["!cols"]       = [{ wch: 46 }, { wch: 22 }, { wch: 22 }, { wch: 22 }];
    ws["!views"]      = [{ state: "frozen", ySplit: 1 }];
    ws["!autofilter"] = { ref: "A1:D1" };

    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(orgName));
  }

  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
}

module.exports = {
  processBillingOverview,
  buildSingleOrgWorkbook,
  buildAllOrgsLatestWorkbook,
  safeSheetName,
  fmtDate,
};
