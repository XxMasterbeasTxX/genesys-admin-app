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

// ── Busy state (throbbers) ──────────────────────────────────────────
//
// See docs/throbber-design.md. Every asynchronous operation must show a
// running throbber next to the text describing it: a status line that has
// stopped updating because the request is slow and one that stopped because
// the request died look identical, and only motion tells them apart.

/**
 * Build a status line that carries a throbber.
 *
 * Returns the same `setStatus(msg, type)` the pages already call, so a page
 * adopts this by deleting its local copy — no call site changes:
 *
 *   const setStatus = makeStatus($status, "te-status");
 *
 * A message containing `…` is taken to be a busy message and gets a throbber.
 * That is not a guess: every one of the app's busy messages already ends its
 * clause with an ellipsis, which is what the character means. Pass `busy`
 * explicitly for the rare message that needs the opposite.
 *
 * The test is `includes`, not `endsWith`, because the longest-running
 * operations append a counter after the ellipsis — `Resolving group role
 * grants… 340 / 1200`.
 *
 * @param {HTMLElement} $el       The status element.
 * @param {string}      [baseClass] Its class, e.g. "te-status". A `type`
 *                                argument appends `${baseClass}--${type}` as
 *                                before. Omit it for a status element that is
 *                                styled inline and carries no class of its own;
 *                                the element's `class` is then left untouched.
 */
export function makeStatus($el, baseClass) {
  // Created once and only re-parented. Rewriting innerHTML on every call —
  // which is what the hand-rolled versions did — destroys and recreates the
  // element, restarting the animation from 0°. On a status line that updates
  // per item the throbber then never advances past a few degrees and reads as
  // frozen, which is the exact failure this is here to prevent.
  const spin = document.createElement("span");
  spin.className = "spin";
  spin.setAttribute("aria-hidden", "true");   // redundant to a screen reader

  // Twenty pages seed their opening message straight into the markup
  // (`<div class="cs-status">Loading sites…</div>`). Taking it over blindly
  // would wipe that message; it is instead replayed through the setter below,
  // so a seeded "…" message gets its throbber from the first paint.
  const seeded = ($el.textContent || "").trim();

  const text = document.createTextNode("");
  $el.replaceChildren(text);
  $el.setAttribute("role", "status");         // implicit aria-live="polite"

  function setStatus(msg, type = "", busy = null) {
    const s = String(typeof msg === "function" ? msg() : (msg ?? ""));
    // Three dots as well as the character: the app writes "…" everywhere bar
    // one page, and a stray "..." must not silently lose its throbber.
    const isBusy = busy === null ? (s.includes("…") || s.includes("...")) : !!busy;

    text.nodeValue = isBusy ? ` ${s}` : s;

    // A caller that also writes $el.textContent directly replaces every child,
    // detaching the two nodes held above. insertBefore would then throw
    // NotFoundError on the next busy message and take the caller down with it,
    // which is exactly what happened to Flow Overview. Re-seat instead: this
    // setter is the authority on what the status line says.
    if (text.parentNode !== $el) $el.replaceChildren(text);

    // parentNode, not isConnected: a page builds its DOM detached and the router
    // attaches it afterwards, so isConnected is false for the whole of render
    // and the throbber would never be taken down again.
    const shown = spin.parentNode === $el;
    if (isBusy && !shown) $el.insertBefore(spin, text);
    else if (!isBusy && shown) spin.remove();

    if (baseClass) $el.className = baseClass + (type ? ` ${baseClass}--${type}` : "");
  }

  if (seeded) setStatus(seeded);
  return setStatus;
}

/**
 * A centred throbber block for a panel, an outlet or a table that has nothing
 * to show yet. Returns the element; the caller decides where it goes.
 */
/**
 * Throbber markup for a spot that takes innerHTML rather than an element —
 * a table cell, a drawer pane, a panel body.
 *
 * The same `.spin` ring `makeStatus` and `spinPanel` use, so every waiting
 * state in the app turns the same way. Text without a spinner reads as a
 * result ("Loading…" is a sentence); the ring is what says it is still moving.
 */
export function spinHtml(message = "Loading…") {
  return `<span class="spin-inline"><span class="spin" aria-hidden="true"></span>` +
    `<span>${escapeHtml(message)}</span></span>`;
}

export function spinPanel(message = "Loading…") {
  const wrap = document.createElement("div");
  wrap.className = "spin-panel";

  const spin = document.createElement("div");
  spin.className = "spin spin--block";
  spin.setAttribute("aria-hidden", "true");

  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = message;

  wrap.append(spin, p);
  wrap.setAttribute("role", "status");
  return wrap;
}

/**
 * A throbber for a control that fills itself asynchronously — a `<select>` whose
 * options arrive from Genesys, or a combobox input disabled until its list
 * loads.
 *
 * The throbber goes on the control's **label**, not the control: a `<select>`
 * cannot hold one, and wrapping it risks the grid the control sits in. The
 * label is the nearest thing to the `Loading …` placeholder that can show
 * motion, and it needs no layout change.
 *
 * @param {HTMLElement} $label The label (or any inline host) beside the control.
 * @returns {(busy: boolean) => void}
 */
export function makeControlBusy($label) {
  if (!$label) return () => {};
  const spin = document.createElement("span");
  spin.className = "spin spin--sm spin--label";
  spin.setAttribute("aria-hidden", "true");
  return function setControlBusy(busy) {
    const shown = spin.parentNode === $label;
    if (busy && !shown) $label.append(spin);
    else if (!busy && shown) spin.remove();
  };
}

/**
 * Run `fn` with a throbber inside `$btn`, disabled for the duration.
 *
 * For an action whose feedback would otherwise land in a page-level status
 * line somewhere else on the screen — a row's delete, a modal's save, a vote.
 * The throbber belongs where the click was.
 *
 * The button is always restored, including when `fn` throws, so a failure
 * cannot leave a throbber spinning for ever. The caller still handles the
 * error; this only owns the button.
 */
export async function withBusy($btn, fn) {
  if (!$btn) return fn();
  if ($btn.dataset.busy === "1") return;       // ignore a double click

  const spin = document.createElement("span");
  spin.className = "spin spin--btn";
  spin.setAttribute("aria-hidden", "true");

  $btn.dataset.busy = "1";
  $btn.disabled = true;
  $btn.setAttribute("aria-busy", "true");
  $btn.prepend(spin);

  try {
    return await fn();
  } finally {
    spin.remove();
    $btn.disabled = false;
    $btn.removeAttribute("aria-busy");
    delete $btn.dataset.busy;
  }
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
 * Hand an already-encoded file to download.html.
 *
 * The app runs inside a Genesys Cloud iframe where direct blob downloads are
 * blocked. The data is stashed on `window` under a random key (not in the URL
 * — browsers reject megabytes of base64 there) and the helper page reads it
 * back through `window.opener`. download.html picks the MIME type from the
 * filename extension, so this serves .xlsx, .zip, .csv and .pdf alike.
 *
 * Throws when the pop-up is blocked. Callers are expected to catch and surface
 * the message — a silent no-op reads as a broken button.
 *
 * @param {string} filename  Suggested filename, extension included.
 * @param {string} b64       Base64-encoded file content.
 */
export function downloadBase64(filename, b64) {
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

/**
 * Encode a finished workbook and hand it to download.html.
 *
 * @param {object} wb        SheetJS workbook.
 * @param {string} filename  Suggested filename, e.g. "Report_2026-02-27.xlsx".
 */
export function downloadWorkbook(wb, filename) {
  if (typeof XLSX === "undefined") {
    throw new Error("Excel library not loaded. Please reload the page.");
  }
  downloadBase64(filename, XLSX.write(wb, { bookType: "xlsx", type: "base64" }));
}

/**
 * A wait, rounded to one unit — "45s", "12m", "3h", "6d", "2mo".
 *
 * Returns `null` for anything that is not a usable duration, so a caller can
 * leave the phrase out entirely rather than print "oldest waiting null".
 *
 * Lived in `disconnect.js` until Move needed the same phrasing beside the same
 * queue-depth figure; two copies of a formatter is how two pages come to
 * describe the same number differently.
 */
export function formatWait(ms) {
  if (typeof ms !== "number" || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60)      return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60)      return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48)      return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 60)      return `${d}d`;
  return `${Math.round(d / 30)}mo`;
}

/** Generate a timestamped filename, e.g. "Prefix_2026-02-27T14-30-00". */
export function timestampedFilename(prefix, ext = "csv") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${prefix}_${ts}.${ext}`;
}
