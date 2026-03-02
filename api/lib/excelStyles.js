/**
 * Shared Excel styling for server-side export handlers.
 *
 * Provides standard style constants and a workbook builder that matches
 * the Python openpyxl formatting used across all export scripts:
 *   - Header: #366092 blue, white bold Calibri 11pt, center aligned
 *   - Alternating rows: #F2F2F2 (even) / #FFFFFF (odd)
 *   - Borders: #D3D3D3 thin all sides
 *   - Frozen header row, auto-filter, auto-sized columns (max 50)
 *
 * Used by: exports/allGroups.js, exports/allRoles.js, exports/lastLogin.js
 */
const XLSX = require("xlsx-js-style");

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

/**
 * Build a styled Excel workbook with standard Python-matching formatting.
 *
 * @param {Array[]} wsData   - Array of arrays; wsData[0] must be the header row.
 * @param {string}  sheetName - Worksheet tab name.
 * @returns XLSX workbook object.
 */
function buildStyledWorkbook(wsData, sheetName) {
  const wb       = XLSX.utils.book_new();
  const headers  = wsData[0];
  const dataRows = wsData.slice(1);

  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Header styles
  for (let c = 0; c < headers.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = STYLE_HEADER;
  }

  // Data styles: alternating rows
  for (let r = 0; r < dataRows.length; r++) {
    const style = (r + 1) % 2 === 0 ? STYLE_ROW_EVEN : STYLE_ROW_ODD;
    for (let c = 0; c < headers.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: r + 1, c });
      if (ws[addr]) ws[addr].s = style;
    }
  }

  // Auto-adjust column widths (max 50, padding +2)
  ws["!cols"] = headers.map((h, i) => {
    let maxLen = h.length;
    for (const row of dataRows) {
      const val = String(row[i] ?? "");
      if (val.length > maxLen) maxLen = val.length;
    }
    return { wch: Math.min(maxLen + 2, 50) };
  });

  // Freeze header row
  ws["!views"] = [{ state: "frozen", ySplit: 1 }];

  // Auto-filter
  ws["!autofilter"] = { ref: ws["!ref"] };

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return wb;
}

/**
 * Add a styled sheet to an existing workbook (for multi-sheet exports).
 * Applies the same Python-matching formatting as buildStyledWorkbook.
 *
 * @param {Object}  wb        - Existing XLSX workbook (mutated in place).
 * @param {Array[]} wsData    - Array of arrays; wsData[0] must be the header row.
 * @param {string}  sheetName - Worksheet tab name (max 31 chars, no special chars).
 */
function addStyledSheet(wb, wsData, sheetName) {
  const headers  = wsData[0];
  const dataRows = wsData.slice(1);

  const ws = XLSX.utils.aoa_to_sheet(wsData);

  for (let c = 0; c < headers.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = STYLE_HEADER;
  }

  for (let r = 0; r < dataRows.length; r++) {
    const style = (r + 1) % 2 === 0 ? STYLE_ROW_EVEN : STYLE_ROW_ODD;
    for (let c = 0; c < headers.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: r + 1, c });
      if (ws[addr]) ws[addr].s = style;
    }
  }

  ws["!cols"] = headers.map((h, i) => {
    let maxLen = h.length;
    for (const row of dataRows) {
      const val = String(row[i] ?? "");
      if (val.length > maxLen) maxLen = val.length;
    }
    return { wch: Math.min(maxLen + 2, 50) };
  });

  ws["!views"] = [{ state: "frozen", ySplit: 1 }];
  ws["!autofilter"] = { ref: ws["!ref"] };

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

module.exports = { STYLE_HEADER, STYLE_ROW_EVEN, STYLE_ROW_ODD, buildStyledWorkbook, addStyledSheet };
