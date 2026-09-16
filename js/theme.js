// Theme selection. Loaded as a plain script in <head>, ahead of the
// stylesheets, so the first paint is already the right theme — no flash of
// dark on a light desktop. Shared by index.html and download.html.
//
// Colours are chosen by the data-theme attribute, never by a media query in
// CSS (see docs/colour-tokens-design.md §5). With no saved preference the OS
// decides, and keeps deciding if it changes while the app is open. A manual
// switch later writes localStorage.theme and this defers to it.
(function () {
  var mq = matchMedia("(prefers-color-scheme: light)");
  function saved() { try { return localStorage.getItem("theme"); } catch (e) { return null; } }
  function apply() {
    document.documentElement.dataset.theme = saved() || (mq.matches ? "light" : "dark");
  }
  apply();
  mq.addEventListener("change", function () { if (!saved()) apply(); });
})();
