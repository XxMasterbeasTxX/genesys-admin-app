/**
 * Access Denied page.
 * Rendered when a user navigates to a route they don't have access to.
 */
export function renderAccessDeniedPage() {
  const el = document.createElement("section");
  el.className = "card";
  el.innerHTML = `
    <h1 class="h1">Access Denied</h1>
    <hr class="hr">
    <p class="p">You don't have permission to access this page.</p>
    <p class="p" style="color:var(--muted);font-size:13px">
      Contact your administrator to request access.
    </p>
  `;
  return el;
}
