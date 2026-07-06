/**
 * Access Denied page.
 * Rendered when a user navigates to a route they don't have access to.
 *
 * @param {{ missing?: string[] }} [opts]  Optional list of missing Genesys
 *   permissions to show (when the page is blocked by permission refinement
 *   rather than by group access).
 */
export function renderAccessDeniedPage(opts = {}) {
  const missing = Array.isArray(opts.missing) ? opts.missing : [];
  const el = document.createElement("section");
  el.className = "card";
  const reason = missing.length
    ? `<p class="p">This action requires a Genesys permission your role doesn't include.</p>
       <p class="p" style="color:var(--muted);font-size:13px">Missing permission${missing.length > 1 ? "s" : ""}:</p>
       <ul class="p" style="color:var(--muted);font-size:13px;font-family:var(--font-mono, ui-monospace, monospace)">
         ${missing.map((p) => `<li>${p}</li>`).join("")}
       </ul>`
    : `<p class="p">You don't have permission to access this page.</p>`;
  el.innerHTML = `
    <h1 class="h1">Access Denied</h1>
    <hr class="hr">
    ${reason}
    <p class="p" style="color:var(--muted);font-size:13px">
      Contact your administrator to request access.
    </p>
  `;
  return el;
}
