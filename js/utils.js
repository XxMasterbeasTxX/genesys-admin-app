/**
 * Shared utility helpers.
 *
 * Centralised module for generic functions used across multiple pages.
 * Keep Genesys-specific logic in services/genesysApi.js instead.
 */

import { addStyledSheet } from "./utils/excelStyles.js";

// ── String / HTML ───────────────────────────────────────────────────

/** Escape a string for safe insertion into HTML. */
export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ── Date / Time ─────────────────────────────────────────────────────

/**
 * Format an ISO datetime string (or Date) to a readable local string.
 * Returns "" for falsy input.
 */
export function formatDateTime(iso) {
  if (!iso) return "";
  try {
    const d = iso instanceof Date ? iso : new Date(iso);
    return d.toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "medium" });
  } catch {
    return String(iso);
  }
}

/**
 * Build an ISO 8601 interval string from two YYYY-MM-DD date strings.
 * Start is midnight UTC, end is 23:59:59.999 UTC.
 */
export function buildInterval(from, to) {
  return `${from}T00:00:00.000Z/${to}T23:59:59.999Z`;
}

/** Return today's date as YYYY-MM-DD (UTC). */
export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/** Return a date N days ago as YYYY-MM-DD (UTC). */
export function daysAgoStr(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

// ── Async ───────────────────────────────────────────────────────────

/** Promise-based delay. */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── CSV ─────────────────────────────────────────────────────────────

/**
 * Generate a CSV string from an array of row objects.
 *
 * @param {Object[]}  rows     Array of objects.
 * @param {{ key: string, label: string }[]} columns  Column definitions.
 * @returns {string}  CSV text with header row.
 */
export function generateCsv(rows, columns) {
  const header = columns.map((c) => c.label).join(",");
  const body = rows.map((r) =>
    columns
      .map((c) => `"${String(r[c.key] ?? "").replace(/"/g, '""')}"`)
      .join(",")
  );
  return [header, ...body].join("\n");
}

// ── Excel (.xlsx) export via SheetJS + download.html ────────────────

/**
 * Build and download an .xlsx workbook using the SheetJS library.
 *
 * The app runs inside a Genesys Cloud iframe where direct blob
 * downloads are blocked. We encode the file as base64 and open
 * download.html in a new tab, which handles the actual save.
 *
 * @param {Array<{ name: string, rows: Object[], columns: { key: string, label: string, wch?: number }[] }>} sheets
 *   One or more sheets to include in the workbook.
 * @param {string} filename  Suggested filename (e.g. "Report_2026-02-27.xlsx").
 */
export function exportXlsx(sheets, filename) {
  if (typeof XLSX === "undefined") {
    throw new Error("Excel library not loaded. Please reload the page.");
  }

  const wb = XLSX.utils.book_new();

  for (const sheet of sheets) {
    // Build array-of-arrays: header row + data rows
    const headers = sheet.columns.map((c) => c.label);
    const dataRows = sheet.rows.map((r) =>
      sheet.columns.map((c) => r[c.key] ?? "")
    );
    addStyledSheet(wb, [headers, ...dataRows], sheet.name || "Sheet1");
  }

  downloadWorkbook(wb, filename);
}

/**
 * Status colouring for run logs, applied by first match on the status text.
 *
 * Deliberately prefix-anchored: a status of "Failed: name already in use"
 * must read as a failure, not as a duplicate-skip, so substring matching on
 * words like "exists" is not used.
 */
const STATUS_STYLES = [
  { match: /^(created|moved|updated|deleted|ok|success)/i,
    style: { font: { color: { rgb: "16A34A" }, bold: true } } },
  { match: /^failed/i,
    style: { font: { color: { rgb: "DC2626" }, bold: true } } },
  { match: /^(skipped|cancelled|not run)/i,
    style: { font: { color: { rgb: "D97706" } } } },
];

/**
 * Build and download a single-sheet .xlsx run log with a colour-coded
 * status column, a blue header row and an auto-filter.
 *
 * This is the log format the bulk-action pages produce (as opposed to
 * `exportXlsx`, which is the alternating-row report format used by the
 * export pages). Both end up in download.html the same way.
 *
 * @param {Object}   opts
 * @param {string}   opts.sheetName  Worksheet tab name.
 * @param {{ key: string, label: string, wch?: number }[]} opts.columns
 * @param {Object[]} opts.rows       Row objects keyed by column `key`.
 * @param {string}   opts.filename   Suggested filename.
 * @param {string}   [opts.statusKey="status"]  Column to colour-code.
 */
export function exportLogXlsx({ sheetName, columns, rows, filename, statusKey = "status" }) {
  if (typeof XLSX === "undefined") {
    throw new Error("Excel library not loaded. Please reload the page.");
  }

  const header = columns.map((c) => c.label);
  const body = rows.map((r) => columns.map((c) => r[c.key] ?? ""));
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);

  ws["!cols"] = columns.map((c) => ({ wch: c.wch || 15 }));

  const headerStyle = {
    font: { bold: true, color: { rgb: "FFFFFF" } },
    fill: { fgColor: { rgb: "3B82F6" } },
    alignment: { horizontal: "center" },
  };
  for (let c = 0; c < columns.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = headerStyle;
  }

  const statusCol = columns.findIndex((c) => c.key === statusKey);
  if (statusCol >= 0) {
    for (let r = 1; r <= rows.length; r++) {
      const addr = XLSX.utils.encode_cell({ r, c: statusCol });
      if (!ws[addr]) continue;
      const val = String(ws[addr].v ?? "");
      const hit = STATUS_STYLES.find((s) => s.match.test(val));
      if (hit) ws[addr].s = hit.style;
    }
  }

  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: rows.length, c: columns.length - 1 },
    }),
  };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || "Log");
  downloadWorkbook(wb, filename);
}

/**
 * Hand a finished workbook to download.html.
 *
 * The app runs inside a Genesys Cloud iframe where direct blob downloads are
 * blocked. The data is stashed on `window` under a random key (not in the URL
 * — browsers reject megabytes of base64 there) and the helper page reads it
 * back through `window.opener`.
 */
function downloadWorkbook(wb, filename) {
  const b64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
  const key = "xlsx_" + Date.now() + "_" + Math.random().toString(36).slice(2);
  window._xlsxDownload = window._xlsxDownload || {};
  window._xlsxDownload[key] = { filename, b64 };

  const helperUrl = new URL("download.html", document.baseURI);
  helperUrl.hash = key;

  const popup = window.open(helperUrl.href, "_blank");
  if (!popup) {
    delete window._xlsxDownload[key];
    throw new Error("Pop-up blocked. Please allow pop-ups for this site and try again.");
  }
}

/** Generate a timestamped filename, e.g. "Prefix_2026-02-27T14-30-00". */
export function timestampedFilename(prefix, ext = "csv") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${prefix}_${ts}.${ext}`;
}
