import { escapeHtml } from "../utils.js";

export function renderNotFoundPage({ route } = {}) {
  const el = document.createElement("section");
  el.className = "card";

  const display = route ? escapeHtml(route) : "(unknown)";

  el.innerHTML = `
    <h1 class="h1">Page not found</h1>
    <p class="p">
      No page matches <code>${display}</code>.<br>
      Use the navigation menu on the left to find what you need.
    </p>
  `;
  return el;
}
