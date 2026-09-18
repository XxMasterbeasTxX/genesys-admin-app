/**
 * A tree of pages as checkboxes — the sidebar's sections and groups, one box
 * per page, a box per group that ticks and unticks everything under it and
 * shows the mixed state when only some are ticked.
 *
 * Used twice (docs/customer-roles-design.md §8): on Super User Access for the
 * org's scope, and on Customers › Access for a Super User's own pages, where
 * it is given the scope's pages only — and, under Data Tables › Super User,
 * their data tables (`extras`).
 *
 * Usage:
 *   const tree = createPageTree({ tree: customerPageTree(), onChange });
 *   container.append(tree.el);
 *   tree.setSelected(["export.users.lastLogin"]);
 *   tree.getSelected();          // string[] of page keys, in nav order
 *   tree.setEnabled(false);
 */
import { leavesOf } from "../services/customerPageTree.js";

/**
 * @param {Object}   opts
 * @param {Array}    opts.tree        From customerPageTree() or pruneTree().
 * @param {Function} [opts.onChange]  Called with string[] after every change.
 * @param {boolean}  [opts.open]      Start with every group expanded (default true).
 * @param {Object<string, HTMLElement>} [opts.extras]
 *        An element to draw under a page, indented, shown only while that
 *        page is ticked — the data tables under Data Tables › Super User.
 *        Whatever the element contains is the caller's; the tree only shows
 *        and hides it.
 */
export function createPageTree({ tree, onChange, open = true, extras = {} }) {
  const el = document.createElement("div");
  el.className = "pt-tree";

  /** @type {Map<string, HTMLInputElement>} leaf key → its box */
  const leafBoxes = new Map();
  /** @type {Array<{ box: HTMLInputElement, keys: string[] }>} */
  const groupBoxes = [];
  /** @type {Array<{ key: string, el: HTMLElement, li: HTMLElement }>} */
  const extraBoxes = [];
  const order = tree.flatMap(leavesOf).map((l) => l.key);
  let enabled = true;
  /** Pages a template supplies: ticked and not the user's to untick. */
  let locked = new Set();

  function build(nodes) {
    const ul = document.createElement("ul");
    ul.className = "pt-list";
    for (const n of nodes) {
      const li = document.createElement("li");
      li.className = n.children ? "pt-group" + (open ? " open" : "") : "pt-page";
      const label = document.createElement("label");
      label.className = "pt-label";
      const box = document.createElement("input");
      box.type = "checkbox";
      if (n.children) {
        const keys = leavesOf(n).map((l) => l.key);
        const count = document.createElement("span");
        count.className = "pt-count";
        groupBoxes.push({ box, keys, count, total: keys.length });
        box.addEventListener("change", () => {
          for (const k of keys) leafBoxes.get(k).checked = box.checked || locked.has(k);
          changed();
        });
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "pt-toggle";
        toggle.setAttribute("aria-label", `Expand ${n.label}`);
        toggle.textContent = "›";
        toggle.addEventListener("click", () => li.classList.toggle("open"));
        label.append(box, document.createTextNode(` ${n.label}`), count);
        li.append(toggle, label, build(n.children));
      } else {
        box.dataset.key = n.key;
        leafBoxes.set(n.key, box);
        box.addEventListener("change", changed);
        label.append(box, document.createTextNode(` ${n.label}`));
        li.append(label);
        if (extras[n.key]) {
          const extra = document.createElement("div");
          extra.className = "pt-extra";
          extra.append(extras[n.key]);
          li.append(extra);
          extraBoxes.push({ key: n.key, el: extra, li });
        }
      }
      ul.append(li);
    }
    return ul;
  }

  function syncGroups() {
    for (const x of extraBoxes) x.el.hidden = !leafBoxes.get(x.key).checked;
    for (const g of groupBoxes) {
      const on = g.keys.filter((k) => leafBoxes.get(k).checked).length;
      g.box.checked = on === g.keys.length && g.keys.length > 0;
      g.box.indeterminate = on > 0 && on < g.keys.length;
      g.count.textContent = ` ${on} / ${g.total}`;
    }
  }

  function getSelected() {
    return order.filter((k) => leafBoxes.get(k).checked);
  }

  function changed() {
    syncGroups();
    if (onChange) onChange(getSelected());
  }

  function setSelected(keys) {
    const set = new Set(keys || []);
    for (const [k, box] of leafBoxes) box.checked = set.has(k) || locked.has(k);
    syncGroups();
  }

  function setEnabled(on) {
    enabled = !!on;
    el.classList.toggle("is-disabled", !enabled);
    for (const [k, box] of leafBoxes) box.disabled = !enabled || locked.has(k);
    for (const g of groupBoxes) g.box.disabled = !enabled;
  }

  /**
   * Lock pages on: ticked, greyed, kept through Untick all and a group's
   * untick. What a template supplies; the rest stay the caller's to tick.
   */
  function setLocked(keys) {
    locked = new Set(keys || []);
    for (const [k, box] of leafBoxes) {
      const on = locked.has(k);
      if (on) box.checked = true;
      box.disabled = !enabled || on;
      box.closest(".pt-label").classList.toggle("is-locked", on);
    }
    syncGroups();
  }

  function selectAll(on) {
    for (const [k, box] of leafBoxes) box.checked = !!on || locked.has(k);
    changed();
  }

  el.append(build(tree));
  syncGroups();

  /** Open every group on the way to a page, so what is under it can be seen. */
  function reveal(key) {
    const box = leafBoxes.get(key);
    if (!box) return;
    for (let li = box.closest("li"); li; li = li.parentElement && li.parentElement.closest("li")) li.classList.add("open");
  }

  return { el, getSelected, setSelected, setEnabled, setLocked, selectAll, reveal, has: (key) => leafBoxes.has(key), size: order.length };
}

/** The section › page names for a list of keys, for a confirm step. */
export function describePages(tree, keys) {
  const set = new Set(keys || []);
  const lines = [];
  (function walk(nodes, trail) {
    for (const n of nodes) {
      if (n.children) walk(n.children, [...trail, n.label]);
      else if (set.has(n.key)) lines.push([...trail, n.label].join(" › "));
    }
  })(tree, []);
  return lines;
}

/** The styles, once per document. */
export function ensurePageTreeStyles() {
  if (document.getElementById("pt-styles")) return;
  const style = document.createElement("style");
  style.id = "pt-styles";
  style.textContent = `
    .pt-tree { font-size: 13px; }
    .pt-list { list-style: none; margin: 0; padding: 0; }
    .pt-list .pt-list { padding-left: 26px; display: none; }
    .pt-group.open > .pt-list { display: block; }
    .pt-group, .pt-page { margin: 0; }
    .pt-label { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; cursor: pointer; color: var(--text); }
    .pt-label:hover { background: color-mix(in srgb, var(--accent-strong) 12%, transparent); }
    .pt-label input[type=checkbox] { margin: 0; }
    .pt-group > .pt-label { font-weight: 500; }
    .pt-count { color: var(--muted); font-weight: 400; font-size: 12px; }
    .pt-toggle { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 4px; display: inline-block; transition: transform .15s ease; }
    .pt-group.open > .pt-toggle { transform: rotate(90deg); }
    .pt-extra { margin: 2px 0 6px 32px; }
    .pt-label.is-locked { color: var(--muted); cursor: default; }
    .pt-label.is-locked:hover { background: transparent; }
    .pt-tree.is-disabled .pt-label { color: var(--muted); cursor: default; }
    .pt-tree.is-disabled .pt-label:hover { background: transparent; }
  `;
  document.head.append(style);
}
