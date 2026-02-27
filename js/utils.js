/**
 * Shared utility helpers.
 *
 * Centralised module for generic functions used across multiple pages.
 * Keep Genesys-specific logic in services/genesysApi.js instead.
 */

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

/** Return today's date as YYYY-MM-DD. */
export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/** Return a date N days ago as YYYY-MM-DD. */
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

// ── Excel (.xlsx) ───────────────────────────────────────────────────

/**
 * Escape a string for XML content.
 */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Generate a minimal .xlsx file (as a Blob) from row objects.
 *
 * Uses the SpreadsheetML (XML-based) format wrapped in a ZIP via the
 * built-in CompressionStream API (available in modern browsers).
 * No external dependencies.
 *
 * @param {Object[]} rows      Array of row objects.
 * @param {{ key: string, label: string }[]} columns  Column definitions.
 * @returns {Promise<Blob>}  The .xlsx Blob.
 */
export async function generateXlsx(rows, columns) {
  // Build the sheet XML
  const sheetRows = [];

  // Header row
  const headerCells = columns.map(
    (c) => `<c t="inlineStr"><is><t>${xmlEscape(c.label)}</t></is></c>`
  ).join("");
  sheetRows.push(`<row>${headerCells}</row>`);

  // Data rows
  for (const r of rows) {
    const cells = columns.map((c) => {
      const v = r[c.key] ?? "";
      return `<c t="inlineStr"><is><t>${xmlEscape(v)}</t></is></c>`;
    }).join("");
    sheetRows.push(`<row>${cells}</row>`);
  }

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${sheetRows.join("")}</sheetData>
</worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  // Build ZIP manually (store-only, no compression — simple & reliable)
  const files = [
    { path: "[Content_Types].xml", data: contentTypesXml },
    { path: "_rels/.rels", data: relsXml },
    { path: "xl/workbook.xml", data: workbookXml },
    { path: "xl/_rels/workbook.xml.rels", data: workbookRelsXml },
    { path: "xl/worksheets/sheet1.xml", data: sheetXml },
  ];

  return buildZipBlob(files);
}

/**
 * Build a ZIP blob from an array of { path, data } entries (store-only).
 * Uses DataView for byte-level control — no external libs required.
 */
function buildZipBlob(files) {
  const encoder = new TextEncoder();
  const entries = files.map((f) => ({
    path: encoder.encode(f.path),
    data: encoder.encode(f.data),
  }));

  // Calculate sizes
  let offset = 0;
  const localHeaders = [];
  for (const e of entries) {
    const headerSize = 30 + e.path.length;
    localHeaders.push({ offset, headerSize });
    offset += headerSize + e.data.length;
  }
  const centralStart = offset;

  let centralSize = 0;
  for (const e of entries) {
    centralSize += 46 + e.path.length;
  }
  const totalSize = centralStart + centralSize + 22; // +22 for EOCD

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let pos = 0;

  // CRC-32 table
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c;
  }
  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Write local file headers + data
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const crc = crc32(e.data);
    entries[i].crc = crc;

    view.setUint32(pos, 0x04034B50, true); pos += 4; // signature
    view.setUint16(pos, 20, true); pos += 2;         // version needed
    view.setUint16(pos, 0, true); pos += 2;          // flags
    view.setUint16(pos, 0, true); pos += 2;          // compression (store)
    view.setUint16(pos, 0, true); pos += 2;          // mod time
    view.setUint16(pos, 0, true); pos += 2;          // mod date
    view.setUint32(pos, crc, true); pos += 4;        // crc32
    view.setUint32(pos, e.data.length, true); pos += 4; // compressed size
    view.setUint32(pos, e.data.length, true); pos += 4; // uncompressed size
    view.setUint16(pos, e.path.length, true); pos += 2; // filename length
    view.setUint16(pos, 0, true); pos += 2;          // extra field length
    u8.set(e.path, pos); pos += e.path.length;
    u8.set(e.data, pos); pos += e.data.length;
  }

  // Write central directory
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    view.setUint32(pos, 0x02014B50, true); pos += 4; // signature
    view.setUint16(pos, 20, true); pos += 2;         // version made by
    view.setUint16(pos, 20, true); pos += 2;         // version needed
    view.setUint16(pos, 0, true); pos += 2;          // flags
    view.setUint16(pos, 0, true); pos += 2;          // compression
    view.setUint16(pos, 0, true); pos += 2;          // mod time
    view.setUint16(pos, 0, true); pos += 2;          // mod date
    view.setUint32(pos, e.crc, true); pos += 4;      // crc32
    view.setUint32(pos, e.data.length, true); pos += 4;
    view.setUint32(pos, e.data.length, true); pos += 4;
    view.setUint16(pos, e.path.length, true); pos += 2;
    view.setUint16(pos, 0, true); pos += 2;          // extra field length
    view.setUint16(pos, 0, true); pos += 2;          // comment length
    view.setUint16(pos, 0, true); pos += 2;          // disk number
    view.setUint16(pos, 0, true); pos += 2;          // internal attrs
    view.setUint32(pos, 0, true); pos += 4;          // external attrs
    view.setUint32(pos, localHeaders[i].offset, true); pos += 4;
    u8.set(e.path, pos); pos += e.path.length;
  }

  // End of central directory
  view.setUint32(pos, 0x06054B50, true); pos += 4;
  view.setUint16(pos, 0, true); pos += 2;   // disk number
  view.setUint16(pos, 0, true); pos += 2;   // central dir disk
  view.setUint16(pos, entries.length, true); pos += 2;
  view.setUint16(pos, entries.length, true); pos += 2;
  view.setUint32(pos, centralSize, true); pos += 4;
  view.setUint32(pos, centralStart, true); pos += 4;
  view.setUint16(pos, 0, true); // comment length

  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ── File download ───────────────────────────────────────────────────

/**
 * Trigger a file download in the browser.
 *
 * @param {string}       filename  Suggested filename.
 * @param {string|Blob}  content   File content (string or Blob).
 * @param {string}       [mime]    MIME type (ignored when content is a Blob).
 */
export function downloadFile(filename, content, mime = "text/csv;charset=utf-8;") {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Generate a timestamped filename, e.g. "Prefix_2026-02-27T14-30-00". */
export function timestampedFilename(prefix, ext = "csv") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${prefix}_${ts}.${ext}`;
}
