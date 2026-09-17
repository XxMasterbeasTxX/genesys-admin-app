// Theme selection and the switch. Loaded as a plain script in <head>, ahead
// of the stylesheets, so the first paint is already the right theme — no
// flash of dark on a light desktop. Shared by index.html and download.html.
//
// Colours are chosen by the data-theme attribute on <html>, never by a media
// query in CSS (docs/colour-tokens-design.md §5). Three modes:
//
//   system  follow the OS, and keep following it if it changes  (the default)
//   dark    always dark
//   light   always light
//
// A choice is remembered per browser in localStorage.theme; "system" is the
// absence of a choice — what a new browser starts with. The header button
// (#themeBtn, index.html) toggles between dark and light and shows the icon
// of the theme that is on; "system" is not a stop on the button, because a
// third click to get back where you were is two clicks too many. The first
// click therefore turns following-the-OS off; nothing turns it back on but
// clearing the stored value.
(function () {
  var KEY = "theme";
  var mq = matchMedia("(prefers-color-scheme: light)");

  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function mode() { var s = saved(); return s === "dark" || s === "light" ? s : "system"; }
  function effective() { var m = mode(); return m === "system" ? (mq.matches ? "light" : "dark") : m; }

  function apply() {
    document.documentElement.dataset.theme = effective();
    render();
  }

  function setTheme(next) {
    try {
      if (next === "dark" || next === "light") localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    } catch (e) { /* storage unavailable — the choice lasts for this page only */ }
    apply();
  }

  // ── The button ──────────────────────────────────────────────────────────
  var ICON = {
    dark:   '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 9.8A6 6 0 0 1 6.2 2.5a6 6 0 1 0 7.3 7.3z"/></svg>',
    light:  '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>',
  };
  var LABEL = { dark: "Dark", light: "Light" };
  var OTHER = { dark: "light", light: "dark" };

  function render() {
    var btn = document.getElementById("themeBtn");
    if (!btn) return;
    var on = effective();
    var now = LABEL[on] + (mode() === "system" ? " (following your OS)" : "");
    btn.innerHTML = ICON[on];
    btn.setAttribute("aria-label", "Theme: " + LABEL[on] + ". Switch to " + LABEL[OTHER[on]]);
    btn.title = "Theme: " + now + ". Click for " + LABEL[OTHER[on]] + ".";
    btn.dataset.mode = mode();
  }

  apply();
  mq.addEventListener("change", function () { if (mode() === "system") apply(); });
  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("themeBtn");
    if (btn) btn.addEventListener("click", function () { setTheme(OTHER[effective()]); });
    render();
  });

  // For anything else that wants to read or set it (nothing does today).
  window.appTheme = { get: mode, set: setTheme };
})();
