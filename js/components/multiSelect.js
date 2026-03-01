/**
 * Reusable multi-select dropdown component.
 *
 * Creates a button that opens a checkbox list on click.
 * Displays a summary of selected items (e.g. "2 selected").
 *
 * Usage:
 *   const ms = createMultiSelect({
 *     placeholder: "Select queues…",
 *     onChange: (selectedIds) => { … },
 *   });
 *   container.append(ms.el);
 *
 *   ms.setItems([{ id: "abc", label: "Sales" }, …]);
 *   ms.getSelected();   // Set of selected IDs
 *   ms.setSelected(set); // programmatic selection
 *   ms.setEnabled(false); // grey-out
 */

/**
 * @param {Object}   opts
 * @param {string}   opts.placeholder  Text when nothing is selected.
 * @param {boolean}  [opts.searchable] Show a search/filter input at the top.
 * @param {Function} [opts.onChange]    Called with Set<string> of selected IDs.
 * @returns {{ el: HTMLElement, setItems, getSelected, setSelected, setEnabled }}
 */
export function createMultiSelect({ placeholder = "Select…", searchable = false, onChange }) {
  // ── Outer wrapper ──────────────────────────────────────
  const wrapper = document.createElement("div");
  wrapper.className = "ms-dropdown";

  // ── Trigger button ─────────────────────────────────────
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "ms-dropdown__trigger";
  trigger.textContent = placeholder;

  // ── Dropdown panel ─────────────────────────────────────
  const panel = document.createElement("div");
  panel.className = "ms-dropdown__panel";
  panel.hidden = true;

  // Search input (optional)
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "ms-dropdown__search";
  searchInput.placeholder = "Search…";
  if (searchable) {
    panel.append(searchInput);
  }

  // "Select All" row
  const allRow = document.createElement("label");
  allRow.className = "ms-dropdown__item ms-dropdown__item--all";
  const allCb = document.createElement("input");
  allCb.type = "checkbox";
  const allSpan = document.createElement("span");
  allSpan.textContent = "Select all";
  allRow.append(allCb, allSpan);

  const listEl = document.createElement("div");
  listEl.className = "ms-dropdown__list";

  panel.append(allRow, listEl);
  wrapper.append(trigger, panel);

  // ── State ──────────────────────────────────────────────
  let items = [];            // [{ id, label }]
  let selected = new Set();  // Set<id>
  let isOpen = false;
  let searchTerm = "";       // current filter text

  // ── Search filtering ───────────────────────────────────
  function getVisibleItems() {
    if (!searchTerm) return items;
    const q = searchTerm.toLowerCase();
    return items.filter(it => it.label.toLowerCase().includes(q));
  }

  searchInput.addEventListener("input", () => {
    searchTerm = searchInput.value.trim();
    renderList();
  });

  // Prevent panel close when clicking inside search
  searchInput.addEventListener("pointerdown", (e) => e.stopPropagation());

  // ── Open / close ───────────────────────────────────────
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!items.length) return;
    isOpen ? close() : open();
  });

  function open() {
    isOpen = true;
    panel.hidden = false;
    wrapper.classList.add("ms-dropdown--open");
    if (searchable) {
      searchInput.value = "";
      searchTerm = "";
      renderList();
      requestAnimationFrame(() => searchInput.focus());
    }
    // Close on outside click
    requestAnimationFrame(() =>
      document.addEventListener("pointerdown", onOutsideClick, { once: true }),
    );
  }

  function close() {
    isOpen = false;
    panel.hidden = true;
    wrapper.classList.remove("ms-dropdown--open");
  }

  function onOutsideClick(e) {
    if (wrapper.contains(e.target)) {
      // Click was inside — re-register
      requestAnimationFrame(() =>
        document.addEventListener("pointerdown", onOutsideClick, { once: true }),
      );
      return;
    }
    close();
  }

  // ── Render items ───────────────────────────────────────
  function renderList() {
    listEl.innerHTML = "";
    const visible = getVisibleItems();
    for (const item of visible) {
      const label = document.createElement("label");
      label.className = "ms-dropdown__item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(item.id);
      cb.dataset.id = item.id;
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(item.id);
        else selected.delete(item.id);
        syncAllCheckbox();
        updateTriggerText();
        onChange?.(new Set(selected));
      });
      const span = document.createElement("span");
      span.textContent = item.label;
      label.append(cb, span);
      listEl.append(label);
    }
    syncAllCheckbox();
    updateTriggerText();
  }

  // ── "Select All" logic ─────────────────────────────────
  allCb.addEventListener("change", () => {
    const visible = getVisibleItems();
    if (allCb.checked) {
      visible.forEach((it) => selected.add(it.id));
    } else {
      visible.forEach((it) => selected.delete(it.id));
    }
    renderList();
    onChange?.(new Set(selected));
  });

  function syncAllCheckbox() {
    const visible = getVisibleItems();
    const visibleSelected = visible.filter(it => selected.has(it.id)).length;
    allCb.checked = visible.length > 0 && visibleSelected === visible.length;
    allCb.indeterminate =
      visibleSelected > 0 && visibleSelected < visible.length;
    allSpan.textContent = searchTerm ? `Select all matching (${visible.length})` : "Select all";
  }

  // ── Trigger text ───────────────────────────────────────
  function updateTriggerText() {
    if (!selected.size) {
      trigger.textContent = placeholder;
      return;
    }
    if (selected.size === 1) {
      const it = items.find((i) => selected.has(i.id));
      trigger.textContent = it?.label ?? "1 selected";
      return;
    }
    if (selected.size === items.length) {
      trigger.textContent = "All selected";
      return;
    }
    trigger.textContent = `${selected.size} selected`;
  }

  // ── Public API ─────────────────────────────────────────
  return {
    el: wrapper,

    /** Replace the list of items. Clears selection. */
    setItems(newItems) {
      items = newItems.slice().sort((a, b) => a.label.localeCompare(b.label));
      selected.clear();
      renderList();
    },

    /** Replace items but keep current selection where IDs still exist. */
    setItemsKeepSelection(newItems) {
      items = newItems.slice().sort((a, b) => a.label.localeCompare(b.label));
      const validIds = new Set(items.map((i) => i.id));
      for (const id of selected) {
        if (!validIds.has(id)) selected.delete(id);
      }
      renderList();
    },

    /** Get current selection as a Set<string>. */
    getSelected() {
      return new Set(selected);
    },

    /** Programmatically set the selection. */
    setSelected(ids) {
      selected = new Set(ids);
      renderList();
    },

    /** Enable or disable the whole dropdown. */
    setEnabled(on) {
      trigger.disabled = !on;
      if (!on) close();
    },

    /** Update the placeholder text shown when nothing is selected. */
    setPlaceholder(text) {
      placeholder = text;
      if (!selected.size) trigger.textContent = placeholder;
    },
  };
}
