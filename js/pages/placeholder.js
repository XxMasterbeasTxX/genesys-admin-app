import { escapeHtml } from "../utils.js";

/**
 * Generic placeholder page used for routes that haven't been implemented yet.
 */
export function renderPlaceholder({ route } = {}) {
  const el = document.createElement("section");
  el.className = "card";
  const display = route ? escapeHtml(route) : "";

  el.innerHTML = `
    <h1 class="h1">Coming soon</h1>
    <p class="p">
      The page <code>${display}</code> is under construction.<br>
      Check back later!
    </p>
  `;
  return el;
}
