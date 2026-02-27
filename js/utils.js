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

// ── File download ───────────────────────────────────────────────────

/**
 * Trigger a file download in the browser from in-memory content.
 *
 * @param {string} filename   Suggested filename.
 * @param {string} content    File content.
 * @param {string} [mime]     MIME type (default: text/csv).
 */
export function downloadFile(filename, content, mime = "text/csv;charset=utf-8;") {
  const blob = new Blob([content], { type: mime });
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
