/**
 * Builds a recursive, collapsible navigation tree.
 *
 * Usage:
 *   const nav = createNav(containerEl, NAV_TREE);
 *   nav.updateActive("/actions/overview");
 */
export function createNav(containerEl, tree) {
  const rootList = buildList(tree, "");
  containerEl.replaceChildren(rootList);

  return {
    /** Highlight the active leaf and ensure its ancestor folders are open. */
    updateActive(route) {
      // Clear previous active
      containerEl
        .querySelectorAll(".nav-leaf.active")
        .forEach((el) => el.classList.remove("active"));

      // Find the matching leaf
      const leaf = containerEl.querySelector(
        `.nav-leaf[data-route="${route}"]`,
      );
      if (!leaf) return;

      leaf.classList.add("active");

      // Expand ancestor groups (without collapsing user-opened branches)
      let group = leaf.closest(".nav-group");
      while (group) {
        group.classList.add("open");
        group = group.parentElement?.closest(".nav-group");
      }
    },
  };
}

function buildList(nodes, parentPath) {
  const ul = document.createElement("ul");
  ul.className = "nav-list";

  // Sort nodes alphabetically by label
  const sorted = [...nodes].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
  );

  for (const node of sorted) {
    // Skip disabled nodes
    if (node.enabled === false) continue;

    const fullPath = `${parentPath}/${node.path}`;
    const li = document.createElement("li");

    if (node.children?.length) {
      // Filter to enabled children only
      const enabledChildren = node.children.filter((c) => c.enabled !== false);
      if (!enabledChildren.length) continue; // hide folder if all children disabled

      // Folder
      li.className = "nav-group";

      const btn = document.createElement("button");
      btn.className = "nav-folder";
      btn.type = "button";

      const chevron = document.createElement("span");
      chevron.className = "nav-chevron";
      chevron.textContent = "\u203A"; // ›

      btn.append(chevron, document.createTextNode(` ${node.label}`));
      btn.addEventListener("click", () => li.classList.toggle("open"));

      li.append(btn, buildList(enabledChildren, fullPath));
    } else {
      // Leaf
      const a = document.createElement("a");
      a.className = "nav-leaf";
      a.href = `#${fullPath}`;
      a.dataset.route = fullPath;
      a.textContent = node.label;
      li.appendChild(a);
    }

    ul.appendChild(li);
  }

  return ul;
}
