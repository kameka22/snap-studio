"use strict";
/* The floating navigation over a site's view (overlay.html): each button
   asks Rust to act on the tab shown. This page has no other script. */
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]");
  if (!b) return;
  window.__TAURI__.core.invoke("lib_nav", { what: b.dataset.nav }).catch(() => {});
});
