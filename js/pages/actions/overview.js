/**
 * Actions › Overview
 *
 * Placeholder page for the Actions feature.
 * This will be the first page users land on when navigating to the admin tool.
 */
export default function renderActionsOverview({ route, me, api }) {
  const el = document.createElement("section");
  el.className = "card";

  const name = me?.name || "Admin";

  el.innerHTML = `
    <h1 class="h1">Actions — Overview</h1>
    <hr class="hr">
    <p class="p">Welcome, <strong>${name}</strong>.</p>
    <p class="p" style="margin-top:8px">
      This page will display an overview of configured actions.
      Select an option from the navigation menu to get started.
    </p>
  `;
  return el;
}
