export function renderWelcomePage() {
  const el = document.createElement("section");
  el.className = "card";
  el.innerHTML = `
    <h1 class="h1">Welcome</h1>
    <p class="p">Select a page from the navigation menu to get started.</p>
  `;
  return el;
}
