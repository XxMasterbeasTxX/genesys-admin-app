/**
 * Billing Excel styles + sheet builders.
 *
 * Reproduces the Python openpyxl design used by all 7
 * GUI_Billing_Export*.py scripts:
 *
 *   Column layout (always 4 columns):
 *     A: Name     B: Committed     C: Actual Usage     D: On-Demand
 *
 *   Section vocabulary:
 *     - Period banner   (dark-blue bg, white bold)
 *     - Summary header  (dark-blue bg, white bold) + summary rows (light-gray)
 *     - Section divider (green bg, white bold)            — "─── REGULAR LICENSES ───" etc.
 *     - Overage rows    (red bg, white bold)              — only when On-Demand > 0
 *
 *   Colour palette (matches Python exactly):
 *     headerBg          #366092   columnHeaderFont white bold
 *     summaryHeaderBg   #4472C4   white bold
 *     summaryRowBg      #E7E6E6   black
 *     dividerBg         #70AD47   white bold
 *     overageBg         #C00C0C   white bold
 */

export const BILLING_HEADERS = ["Name", "Committed", "Actual Usage", "On-Demand"];

// ── Cell styles ──────────────────────────────────────────────────────

const BORDER_THIN = {
  top:    { style: "thin", color: { rgb: "D3D3D3" } },
  bottom: { style: "thin", color: { rgb: "D3D3D3" } },
  left:   { style: "thin", color: { rgb: "D3D3D3" } },
  right:  { style: "thin", color: { rgb: "D3D3D3" } },
};

export const STYLE_COLUMN_HEADER = {
  fill:      { fgColor: { rgb: "366092" } },
  font:      { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "center", vertical: "center" },
  border:    BORDER_THIN,
};

export const STYLE_PERIOD_BANNER = {
  fill:      { fgColor: { rgb: "366092" } },
  font:      { bold: true, sz: 12, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "left",  vertical: "center" },
  border:    BORDER_THIN,
};

export const STYLE_SUMMARY_HEADER = {
  fill:      { fgColor: { rgb: "4472C4" } },
  font:      { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "left",  vertical: "center" },
  border:    BORDER_THIN,
};

export const STYLE_SUMMARY_ROW = {
  fill:      { fgColor: { rgb: "E7E6E6" } },
  font:      { bold: true, sz: 10, color: { rgb: "000000" }, name: "Calibri" },
  alignment: { horizontal: "left",  vertical: "center" },
  border:    BORDER_THIN,
};

export const STYLE_DIVIDER = {
  fill:      { fgColor: { rgb: "70AD47" } },
  font:      { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "left",  vertical: "center" },
  border:    BORDER_THIN,
};

export const STYLE_DATA_NAME = {
  font:      { sz: 10, color: { rgb: "000000" }, name: "Calibri" },
  alignment: { horizontal: "left",  vertical: "center" },
  border:    BORDER_THIN,
};

export const STYLE_DATA_NUMBER = {
  font:      { sz: 10, color: { rgb: "000000" }, name: "Calibri" },
  alignment: { horizontal: "right", vertical: "center" },
  numFmt:    "#,##0",
  border:    BORDER_THIN,
};

export const STYLE_DATA_TEXT = {
  font:      { sz: 10, color: { rgb: "000000" }, name: "Calibri" },
  alignment: { horizontal: "left",  vertical: "center" },
  border:    BORDER_THIN,
};

export const STYLE_OVERAGE_NAME = {
  fill:      { fgColor: { rgb: "C00C0C" } },
  font:      { bold: true, sz: 10, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "left",  vertical: "center" },
  border:    BORDER_THIN,
};

export const STYLE_OVERAGE_NUMBER = {
  fill:      { fgColor: { rgb: "C00C0C" } },
  font:      { bold: true, sz: 10, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "right", vertical: "center" },
  numFmt:    "#,##0",
  border:    BORDER_THIN,
};

export const STYLE_OVERAGE_TEXT = {
  fill:      { fgColor: { rgb: "C00C0C" } },
  font:      { bold: true, sz: 10, color: { rgb: "FFFFFF" }, name: "Calibri" },
  alignment: { horizontal: "left",  vertical: "center" },
  border:    BORDER_THIN,
};

// ── Sheet builder ────────────────────────────────────────────────────

/**
 * Build (or append to) a billing worksheet using SheetJS (xlsx-js-style).
 *
 * Multiple periods can be appended one after another to the same sheet
 * by re-using the returned `state` from a previous call (the writer keeps
 * track of the next row index).
 *
 * @param {object} args
 * @param {object} args.workbook       Existing XLSX workbook (created elsewhere).
 * @param {string} args.sheetName      Worksheet tab name (max 31 chars).
 * @param {object} args.processed      Output of `processBillingOverview()`.
 * @param {string} [args.periodLabel]  Optional banner above the period (e.g. "═══ PERIOD: 2025-01-15 to 2025-02-14 ═══").
 *                                     When omitted, the start/end dates from the summary are used.
 * @returns {object} XLSX worksheet
 */
export function buildBillingSheet({ workbook, sheetName, processed, periodLabel }) {
  const XLSX = window.XLSX;
  const ws = XLSX.utils.aoa_to_sheet([]);
  const state = { row: 0 };

  // Row 1 — column headers
  writeRow(ws, state, BILLING_HEADERS, [STYLE_COLUMN_HEADER, STYLE_COLUMN_HEADER, STYLE_COLUMN_HEADER, STYLE_COLUMN_HEADER]);

  appendBillingBlock(ws, state, processed, { periodLabel });

  // Column widths (matches Python "auto, max 50"; safe defaults here)
  ws["!cols"] = [
    { wch: 46 }, // Name
    { wch: 22 }, // Committed
    { wch: 22 }, // Actual Usage
    { wch: 22 }, // On-Demand
  ];

  ws["!views"]      = [{ state: "frozen", ySplit: 1 }];
  ws["!autofilter"] = { ref: `A1:D1` };

  XLSX.utils.book_append_sheet(workbook, ws, safeSheetName(sheetName));
  return ws;
}

/**
 * Append one period's worth of content to an existing billing worksheet.
 * Use this to stack multiple periods vertically (calendar year / date range).
 */
export function appendBillingBlock(ws, state, processed, { periodLabel } = {}) {
  const { summary, regularRows, aiBreakdownRows, overageRows } = processed;

  const banner = periodLabel
    || `═══ PERIOD: ${summary.startDate} to ${summary.endDate} ═══`;

  // Period banner (merged A:D)
  writeMergedBanner(ws, state, banner, STYLE_PERIOD_BANNER);

  // ── Summary block ──────────────────────────────────────────────────
  writeMergedBanner(ws, state, "BILLING SUMMARY", STYLE_SUMMARY_HEADER);
  writeKv(ws, state, "License Type",       summary.licenseType);
  writeKv(ws, state, "Billing Period",     `${summary.startDate} to ${summary.endDate}`);
  if (summary.subscriptionType) writeKv(ws, state, "Subscription Type", summary.subscriptionType);
  if (summary.currency)         writeKv(ws, state, "Currency",          summary.currency);
  writeKv(ws, state, "Billable Items",     String(summary.billableItems));

  if (summary.hasAi) {
    writeKv(ws, state, "AI Tokens — Free",       tokensLabel(summary.aiFairUse));
    writeKv(ws, state, "AI Tokens — Total Used", tokensLabel(summary.aiRollup));
    writeKv(ws, state, "AI Tokens — Billable",   tokensLabel(summary.aiBillable));
  }
  writeBlankRow(ws, state);

  // ── Regular licences ───────────────────────────────────────────────
  writeMergedBanner(ws, state, "─── REGULAR LICENSES ───", STYLE_DIVIDER);
  for (const r of regularRows) writeDataRow(ws, state, r, false);
  writeBlankRow(ws, state);

  // ── AI breakdown (only if any AI rows) ─────────────────────────────
  if (aiBreakdownRows.length) {
    const label = `─── AI TOKENS USAGE BREAKDOWN (${summary.licenseType}) ───`;
    writeMergedBanner(ws, state, label, STYLE_DIVIDER);
    for (const r of aiBreakdownRows) writeDataRow(ws, state, r, false);
    writeBlankRow(ws, state);
  }

  // ── Overage / billable items (only if any) ─────────────────────────
  if (overageRows.length) {
    writeMergedBanner(ws, state, "─── ITEMS WITH OVERAGE AND OTHER BILLABLE ITEMS ───", STYLE_DIVIDER);
    for (const r of overageRows) writeDataRow(ws, state, r, true);
    writeBlankRow(ws, state);
  }

  // Refresh the sheet `!ref` so autofilter / freeze stays consistent.
  refreshSheetRef(ws, state.row);
}

// ── Low-level write helpers ──────────────────────────────────────────

function tokensLabel(n) {
  return `${Math.round(n).toLocaleString("en-US")} tokens`;
}

function writeRow(ws, state, values, styles) {
  const XLSX = window.XLSX;
  for (let c = 0; c < values.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: state.row, c });
    const v = values[c];
    const isNum = typeof v === "number" && Number.isFinite(v);
    ws[addr] = { t: isNum ? "n" : "s", v: v ?? "" };
    if (styles[c]) ws[addr].s = styles[c];
  }
  state.row += 1;
}

function writeMergedBanner(ws, state, text, style) {
  const XLSX = window.XLSX;
  // Write the text in column A, leave B–D blank but styled (so the
  // merged-cell area shows a continuous fill).
  writeRow(ws, state, [text, "", "", ""], [style, style, style, style]);
  ws["!merges"] = ws["!merges"] || [];
  ws["!merges"].push({
    s: { r: state.row - 1, c: 0 },
    e: { r: state.row - 1, c: 3 },
  });
}

function writeKv(ws, state, key, value) {
  writeRow(ws, state, [key, value, "", ""], [STYLE_SUMMARY_ROW, STYLE_SUMMARY_ROW, STYLE_SUMMARY_ROW, STYLE_SUMMARY_ROW]);
  // Merge B:D for the value cell so long strings (e.g. dates) render cleanly.
  ws["!merges"] = ws["!merges"] || [];
  ws["!merges"].push({
    s: { r: state.row - 1, c: 1 },
    e: { r: state.row - 1, c: 3 },
  });
}

function writeBlankRow(ws, state) {
  state.row += 1; // truly empty — no cell objects
}

function writeDataRow(ws, state, row, isOverage) {
  const nameStyle = isOverage ? STYLE_OVERAGE_NAME : STYLE_DATA_NAME;
  const numStyle  = isOverage ? STYLE_OVERAGE_NUMBER : STYLE_DATA_NUMBER;
  const txtStyle  = isOverage ? STYLE_OVERAGE_TEXT : STYLE_DATA_TEXT;

  const cells   = [row.name, row.committed, row.actualUsage, row.onDemand];
  const styles  = [
    nameStyle,
    typeof row.committed   === "number" ? numStyle : txtStyle,
    typeof row.actualUsage === "number" ? numStyle : txtStyle,
    typeof row.onDemand    === "number" ? numStyle : txtStyle,
  ];
  writeRow(ws, state, cells, styles);
}

function refreshSheetRef(ws, lastRowExclusive) {
  const XLSX = window.XLSX;
  const lastRow = Math.max(0, lastRowExclusive - 1);
  ws["!ref"] = `A1:${XLSX.utils.encode_col(3)}${lastRow + 1}`;
}

/** Sanitise a sheet name (Excel max 31 chars, no `: \ / ? * [ ]`). */
export function safeSheetName(name) {
  return String(name || "Sheet1")
    .replace(/[\\\/\?\*\[\]:]/g, "_")
    .slice(0, 31);
}
