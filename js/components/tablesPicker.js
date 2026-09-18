/**
 * The data tables a Supervisor (or a template) may open — one box per table
 * the org has made visible to Supervisors, drawn under the Data Tables ›
 * Supervisor page in a page tree (`createPageTree`'s `extras`).
 *
 * Used on Customers › Access for a Supervisor's own tables and on Supervisor
 * Access for a template's (docs/data-table-rules-design.md §11,
 * docs/supervisor-templates-design.md). Locked tables — a template's, on a
 * user — are ticked and greyed and survive Untick all.
 *
 * Usage:
 *   const picker = createTablesPicker({ tables, initial, onChange, emptyNote });
 *   picker.el; picker.getSelected(); picker.setSelected(ids); picker.setLocked(ids); picker.setEnabled(on)
 */
import { escapeHtml } from "../utils.js";

/**
 * @param {Object}   opts
 * @param {Array<{id:string,name:string}>|null} opts.tables  Visible tables; null = could not be loaded.
 * @param {string[]} [opts.initial]     Ticked at the start.
 * @param {Function} [opts.onChange]    Called after every change.
 * @param {string}   [opts.error]       Why the tables could not be loaded (with tables = null).
 * @param {string}   [opts.emptyNote]   What to say when no table is visible.
 * @param {Function} [opts.countText]   (n, total) → the count line; default asks for at least one.
 */
export function createTablesPicker({ tables, initial = [], onChange, error = "", emptyNote = "", countText = null }) {
  ensureTablesPickerStyles();
  const wrap = document.createElement("div");
  wrap.className = "tp-tables";
  const list = tables || [];
  const uid = `tp${Math.random().toString(36).slice(2, 8)}`;
  if (!list.length) {
    wrap.innerHTML = `<div class="tp-note">${error
      ? `The data tables could not be loaded: ${escapeHtml(error)}`
      : escapeHtml(emptyNote || `No data table has been made visible to Supervisors yet, so this page cannot be given. An Administrator opens a table with "Visible to Supervisors" on Data Tables › Edit.`)}</div>`;
    return { el: wrap, getSelected: () => [], setSelected() {}, setLocked() {}, setEnabled() {}, size: 0 };
  }
  wrap.innerHTML = `
    <div class="tp-head">
      <span class="tp-count"></span>
      <span class="tp-spacer"></span>
      <button type="button" class="btn btn-secondary btn-sm" data-all title="Tick every data table in this list">All tables</button>
      <button type="button" class="btn btn-secondary btn-sm" data-none title="Untick every data table in this list">No tables</button>
    </div>
    <div class="tp-list">
      ${list.map((t, i) => `<label for="${uid}-${i}"><input id="${uid}-${i}" type="checkbox" value="${escapeHtml(t.id)}"> ${escapeHtml(t.name)}</label>`).join("")}
    </div>`;
  const boxes = [...wrap.querySelectorAll("input[type=checkbox]")];
  const $count = wrap.querySelector(".tp-count");
  let locked = new Set();
  let enabled = true;
  const set0 = new Set(initial || []);
  for (const b of boxes) b.checked = set0.has(b.value);
  const getSelected = () => boxes.filter((b) => b.checked).map((b) => b.value);
  function count() {
    const n = getSelected().length;
    $count.textContent = countText ? countText(n, boxes.length)
      : `${n} of ${boxes.length} data table${boxes.length === 1 ? "" : "s"} ticked${n ? "" : " — tick at least one"}`;
  }
  function changed() { count(); if (onChange) onChange(); }
  boxes.forEach((b) => b.addEventListener("change", changed));
  wrap.querySelector("[data-all]").addEventListener("click", () => { boxes.forEach((b) => { b.checked = true; }); changed(); });
  wrap.querySelector("[data-none]").addEventListener("click", () => { boxes.forEach((b) => { b.checked = locked.has(b.value); }); changed(); });
  count();
  return {
    el: wrap, getSelected, size: boxes.length,
    setSelected(ids) { const s = new Set(ids || []); boxes.forEach((b) => { b.checked = s.has(b.value) || locked.has(b.value); }); count(); },
    setLocked(ids) {
      locked = new Set(ids || []);
      boxes.forEach((b) => { const on = locked.has(b.value); if (on) b.checked = true; b.disabled = !enabled || on; b.closest("label").classList.toggle("is-locked", on); });
      count();
    },
    setEnabled(on) {
      enabled = !!on;
      boxes.forEach((b) => { b.disabled = !enabled || locked.has(b.value); });
      wrap.querySelectorAll("button").forEach((b) => { b.disabled = !enabled; });
    },
  };
}

function ensureTablesPickerStyles() {
  if (document.getElementById("tp-styles")) return;
  const style = document.createElement("style");
  style.id = "tp-styles";
  style.textContent = `
    .tp-tables { border-left: 2px solid var(--border); padding: 4px 0 4px 10px; font-size: 13px; }
    .tp-head { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; margin-bottom: 4px; flex-wrap: wrap; }
    .tp-head .tp-spacer { flex: 1; }
    .tp-list { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow: auto; }
    .tp-list label { display: inline-flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 6px; cursor: pointer; color: var(--text); }
    .tp-list label:hover { background: color-mix(in srgb, var(--accent-strong) 12%, transparent); }
    .tp-list label.is-locked { color: var(--muted); cursor: default; }
    .tp-list label.is-locked:hover { background: transparent; }
    .tp-list input { margin: 0; }
    .tp-note { color: var(--muted); font-size: 12px; }
  `;
  document.head.append(style);
}
