export function renderWelcomePage({ debugInfo } = {}) {
  const el = document.createElement("section");
  el.className = "card";

  let debugHtml = "";
  if (debugInfo) {
    const { userId, isSuperuser, groupNames, accessKeys } = debugInfo;
    const groups = groupNames?.length
      ? groupNames.map(g => `<li>${g}</li>`).join("")
      : "<li><em>none found</em></li>";
    const keys = accessKeys?.length
      ? accessKeys.map(k => `<li><code>${k}</code></li>`).join("")
      : "<li><em style='color:#f87171'>none — this is why the menu is empty!</em></li>";
    debugHtml = `
      <hr class="hr" style="margin:16px 0">
      <p style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Debug — Access Info</p>
      <p style="font-size:12px"><strong>User ID:</strong> <code>${userId ?? "unknown"}</code></p>
      <p style="font-size:12px"><strong>Superuser:</strong> ${isSuperuser ? "<span style='color:#34d399'>yes ✓</span>" : "<span style='color:#f87171'>no</span>"}</p>
      <p style="font-size:12px"><strong>Genesys groups resolved:</strong></p>
      <ul style="font-size:12px;margin:4px 0 10px 16px">${groups}</ul>
      <p style="font-size:12px"><strong>Access keys granted:</strong></p>
      <ul style="font-size:12px;margin:4px 0 0 16px">${keys}</ul>
    `;
  }

  el.innerHTML = `
    <h1 class="h1">Welcome</h1>
    <p class="p">Select a page from the navigation menu to get started.</p>
    ${debugHtml}
  `;
  return el;
}
