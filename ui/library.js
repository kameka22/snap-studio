"use strict";
/* Library: browsing model sites.
   Each tab is a native web view laid over our interface. So we only draw
   what surrounds it — tab bar, address bar — and tell it its rectangle. It
   must be hidden as soon as something else comes in front: another sidebar
   entry, a dialog, the 3D viewer.

   Two pinned pages come first: Home, the sites to open, and Favorites, the
   models set aside. A site may be open in several tabs. */

const LIB = {
  sites: [],
  favs: [],
  restored: false,
  tabs: [],          // { id, site, title, url }
  active: "home",    // "home", "favs" or a tab id
  visible: false,    // is the Library view on screen?
};

const libPinned = (id) => id === "home" || id === "favs";

/* ------------------------------------------------------------ rectangle */

/* The native view goes where our frame is, in interface points. */
function libRect() {
  const r = $("lib-frame").getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function pushRect() {
  invoke("lib_rect", {
    rect: libRect(),
    // Our page height gives away the title bar's, by which the native view
    // must be offset.
    viewport: window.innerHeight,
    visible: LIB.visible && !libPinned(LIB.active) ? LIB.active : null,
  }).catch(() => {});
}

/* ------------------------------------------------------------ tabs */

const siteOf = (t) => LIB.sites.find((s) => s.id === t.site);
const tabName = (t) => t.title || siteOf(t)?.name || t.site;

function renderTabs() {
  document.querySelectorAll(".lib-tab.pin").forEach((el) => el.classList.toggle("on", el.dataset.tab === LIB.active));
  const box = $("lib-tablist");
  box.innerHTML = "";
  for (const t of LIB.tabs) {
    const el = document.createElement("button");
    el.className = "lib-tab" + (t.id === LIB.active ? " on" : "");
    el.title = `${siteOf(t)?.name || t.site} — ${t.url}`;
    el.innerHTML = `<span class="x" title="${esc(tr("common.close"))}">✕</span>${brandIcon(siteOf(t)?.name || t.site, 14)}<span class="name">${esc(tabName(t))}</span>`;
    el.onclick = (e) => {
      if (e.target.classList.contains("x")) closeTab(t.id);
      else activateTab(t.id);
    };
    // Middle click closes, as in a browser.
    el.onauxclick = (e) => {
      if (e.button === 1) closeTab(t.id);
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      tabMenu(e, t);
    };
    box.appendChild(el);
  }
  const browsing = !libPinned(LIB.active);
  $("lib-bar").classList.toggle("hidden", !browsing);
  $("lib-home").classList.toggle("hidden", LIB.active !== "home");
  $("lib-favs").classList.toggle("hidden", LIB.active !== "favs");
  libTitle();
  if (browsing) {
    const t = LIB.tabs.find((x) => x.id === LIB.active);
    setUrl(t ? t.url : "");
    libFavState();
  }
  sideSync();
}

function setUrl(url) {
  $("lib-url").textContent = url || "";
  $("lib-url").title = url || "";
}

/* The address area doubles as a status line: a notification bubble would
   show behind the native view. */
let statusTimer = 0;
function libStatus(text, ms = 3000) {
  clearTimeout(statusTimer);
  const el = $("lib-url");
  el.textContent = text;
  if (ms) {
    statusTimer = setTimeout(() => {
      const t = LIB.tabs.find((x) => x.id === LIB.active);
      setUrl(t ? t.url : "");
    }, ms);
  }
}

/* A new tab on a site, at its home page or at `url`. */
async function openSite(site, url = site.url) {
  const id = `${site.id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  LIB.tabs.push({ id, site: site.id, title: "", url });
  LIB.active = id;
  renderTabs();
  saveTabs();
  // The rectangle must be known before creation, otherwise the view is born elsewhere.
  pushRect();
  try {
    await invoke("lib_open", { id, url });
  } catch (e) {
    toast(String(e), true);
  }
  pushRect();
}

function activateTab(id) {
  LIB.active = id;
  renderTabs();
  saveTabs();
  pushRect();
  invoke("lib_show", { id: libPinned(id) ? null : id }).catch(() => {});
}

/* Open tabs come back at the next launch, each where it was. */
function saveTabs() {
  localStorage.setItem(
    "snapstudio.libtabs",
    JSON.stringify({
      tabs: LIB.tabs.map((t) => ({ site: t.site, url: t.url, title: t.title })),
      active: libPinned(LIB.active) ? LIB.active : LIB.tabs.findIndex((t) => t.id === LIB.active),
    })
  );
}

/* Native views cost memory: they are only recreated on the first visit to
   the Library, not at app startup. */
async function restoreTabs() {
  if (LIB.restored) return;
  LIB.restored = true;
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem("snapstudio.libtabs") || "null");
  } catch {
    saved = null;
  }
  if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return;
  const want = LIB.active;
  for (const t of saved.tabs) {
    // Before this version, a tab was just its site's id.
    const siteId = typeof t === "string" ? t : t.site;
    const site = LIB.sites.find((s) => s.id === siteId);
    if (!site) continue;
    const url = typeof t === "object" && /^https?:\/\//.test(t.url || "") ? t.url : site.url;
    await openSite(site, url);
    if (typeof t === "object" && t.title) LIB.tabs[LIB.tabs.length - 1].title = t.title;
  }
  // The sidebar's Favorites entry may have asked for a page meanwhile.
  const a = saved.active;
  const target = want !== "home" ? want : typeof a === "number" ? LIB.tabs[a]?.id || "home" : libPinned(a) ? a : "home";
  activateTab(target);
}

function closeTab(id) {
  invoke("lib_close", { id }).catch(() => {});
  const i = LIB.tabs.findIndex((t) => t.id === id);
  LIB.tabs = LIB.tabs.filter((t) => t.id !== id);
  if (LIB.active === id) {
    // The neighbour takes over, as in a browser.
    const next = LIB.tabs[Math.min(i, LIB.tabs.length - 1)];
    LIB.active = next ? next.id : "home";
  }
  saveTabs();
  activateTab(LIB.active);
}

function tabMenu(e, tab) {
  const name = siteOf(tab)?.name || tab.site;
  nativeMenu([
    { id: "tab:reload:" + tab.id, label: tr("library.reload") },
    { id: "tab:dup:" + tab.id, label: tr("library.duplicate_tab") },
    { id: "tab:copy:" + tab.id, label: tr("library.copy_link") },
    { id: "tab:browser:" + tab.id, label: tr("library.open_browser") },
    {},
    { id: "tab:logout:" + tab.id, label: tr("library.logout", { name }) },
    {},
    { id: "tab:close:" + tab.id, label: tr("library.close_tab") },
    { id: "tab:others:" + tab.id, label: tr("library.close_others"), enabled: LIB.tabs.length > 1 },
  ], e.clientX, e.clientY);
}
onMenu("tab", async (arg) => {
  const i = arg.indexOf(":");
  const what = arg.slice(0, i), id = arg.slice(i + 1);
  const tab = LIB.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (what === "reload") invoke("lib_command", { id, what: "reload" }).catch(() => {});
  if (what === "close") closeTab(id);
  if (what === "others") for (const t of LIB.tabs.filter((x) => x.id !== id)) closeTab(t.id);
  if (what === "dup" && siteOf(tab)) openSite(siteOf(tab), tab.url);
  if (what === "copy") {
    await navigator.clipboard.writeText(tab.url).catch(() => {});
    libStatus(tr("library.link_copied"));
  }
  if (what === "browser") invoke("plugin:opener|open_url", { url: tab.url }).catch((err) => toast(String(err), true));
  if (what === "logout") {
    try {
      const n = await invoke("lib_logout", { id, site: tab.site });
      libStatus(n ? tr("library.logged_out", { n }) : tr("library.no_session"));
    } catch (err) {
      libStatus(String(err), 4000);
    }
  }
});

/* ------------------------------------------------------------ favorites */

/* Brand icon: rounded square in the site's color, white or dark initial
   depending on the background luminance. Color derived from the name when
   unknown. */
const BRAND = { makerworld: "#00AE42", printables: "#FA6831", thingiverse: "#248BFB" };
const IOS_PALETTE = ["#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#00C7BE", "#30B0C7", "#32ADE6", "#007AFF", "#5856D6", "#AF52DE", "#FF2D55", "#A2845E"];
function brandIcon(name, size = 18) {
  const key = String(name || "?").toLowerCase().replace(/[^a-z0-9]/g, "");
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const bg = BRAND[key] || IOS_PALETTE[h % IOS_PALETTE.length];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const fg = lum > 0.72 ? "#1d1d1f" : "#fff";
  const initial = esc((String(name || "?").trim()[0] || "?").toUpperCase());
  return `<span class="brand" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.28)}px;background:${bg};color:${fg};font-size:${Math.round(size * 0.5)}px">${initial}</span>`;
}

const relDate = (secs) => {
  const d = Math.floor(Date.now() / 1000) - secs;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto", style: "short" });
  if (d < 3600) return tr("library.just_now");
  if (d < 86400) return rtf.format(-Math.floor(d / 3600), "hour");
  if (d < 7 * 86400) return rtf.format(-Math.floor(d / 86400), "day");
  return new Date(secs * 1000).toLocaleDateString(locale());
};

/* Toolbar title: the page shown; the sidebar counts the favorites. */
function libTitle() {
  const n = LIB.favs.length;
  $("count-favs").textContent = n ? String(n) : "";
  const t = !libPinned(LIB.active) && LIB.tabs.find((x) => x.id === LIB.active);
  if (t) tbSet("library", tabName(t), siteOf(t)?.name !== tabName(t) ? siteOf(t)?.name || "" : "");
  else if (LIB.active === "favs") tbSet("library", tr("library.favorites"), n ? tr("library.fav_count", { n }) : "");
  else tbSet("library", tr("nav.library"), "");
}

/* The toolbar star is filled when the page shown is a favorite. */
function libFavState() {
  const t = LIB.tabs.find((x) => x.id === LIB.active);
  const on = !!t && LIB.favs.some((f) => f.url === t.url);
  $("lib-fav").classList.toggle("on", on);
  $("lib-fav").title = tr(on ? "library.fav_already" : "library.fav");
}

async function favAct(what, id) {
  const f = LIB.favs.find((x) => x.id === id);
  if (!f) return;
  if (what === "open") return openFavorite(f);
  if (what === "copy") {
    await navigator.clipboard.writeText(f.url).catch(() => {});
    return toast(tr("library.link_copied"));
  }
  if (what === "remove") {
    if (!(await confirmDelete(tr("library.remove.title", { name: f.title }), tr("library.remove.text"), tr("prints.remove")))) return;
    LIB.favs = await invoke("fav_remove", { id });
  }
  renderFavs();
}
onMenu("fav", (arg) => {
  const i = arg.indexOf(":");
  favAct(arg.slice(0, i), arg.slice(i + 1));
});

/* The address without its scheme, for the second line of a favorite. */
const shortUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

/* Favorites: one line per link, newest first. */
function renderFavs() {
  const list = $("lib-grid");
  const has = LIB.favs.length > 0;
  libTitle();
  libFavState();
  list.classList.toggle("hidden", !has);
  $("lib-empty").classList.toggle("hidden", has);
  if (!has) return;
  list.innerHTML = "";
  for (const f of LIB.favs) {
    const el = document.createElement("div");
    el.className = "fav-row";
    el.title = f.url;
    el.innerHTML = `${brandIcon(f.site, 28)}
      <div class="fav-text">
        <div class="fav-title">${esc(f.title)}</div>
        <div class="fav-sub">${esc(f.site)} · ${esc(relDate(f.added_at))} · <span class="fav-url">${esc(shortUrl(f.url))}</span></div>
      </div>
      <button class="btn small go">${esc(tr("common.open"))}</button>
      <button class="btn small danger del">${esc(tr("prints.remove"))}</button>`;
    el.onclick = (e) => {
      if (e.target.closest(".del")) favAct("remove", f.id);
      else favAct("open", f.id);
    };
    el.oncontextmenu = (e) =>
      nativeMenu([
        { id: "fav:open:" + f.id, label: tr("common.open") },
        { id: "fav:copy:" + f.id, label: tr("library.copy_link") },
        {},
        { id: "fav:remove:" + f.id, label: tr("library.remove_menu") },
      ], e.clientX, e.clientY);
    list.appendChild(el);
  }
}

/* Opens a favorite in a new tab of its site. */
async function openFavorite(f) {
  const host = (() => {
    try {
      return new URL(f.url).host;
    } catch {
      return "";
    }
  })();
  const site = LIB.sites.find((s) => host.includes(s.id)) || LIB.sites[0];
  if (!site) return;
  await openSite(site, f.url);
}

async function loadFavs() {
  try {
    LIB.favs = await invoke("fav_list");
  } catch {
    LIB.favs = [];
  }
  renderFavs();
}

/* The star saves the page shown; on a favorite already, it shows Favorites.
   The address is asked of the view itself: the one kept for the tab may
   lag behind a page that changed without loading. */
$("lib-fav").addEventListener("click", async () => {
  const t = LIB.tabs.find((x) => x.id === LIB.active);
  if (!t) return;
  const url = (await invoke("lib_url", { id: t.id }).catch(() => null)) || t.url;
  if (url !== t.url) {
    t.url = url;
    setUrl(url);
    saveTabs();
  }
  if (LIB.favs.some((f) => f.url === url)) return activateTab("favs");
  try {
    LIB.favs = await invoke("fav_add", { url, title: t.title || null });
    renderFavs();
    libStatus(tr("library.added"));
  } catch (e) {
    libStatus(String(e), 4000);
  }
});

/* The sidebar's Favorites entry. */
$("side-favs").addEventListener("click", () => {
  switchView("library");
  activateTab("favs");
});

/* ------------------------------------------------------------ downloads */

listen("lib-download", async (e) => {
  const { phase, path } = e.payload;
  const name = (path || "").split("/").pop();
  if (phase === "started") {
    libStatus(tr("library.dl.started", { name }), 0);
  } else if (phase === "finished") {
    libStatus(tr("library.dl.finished", { name }), 2500);
    // The file lands in Downloads: go and show it.
    switchView("files");
    await refresh();
    const f = state.files.find((x) => x.path === path);
    if (f) {
      setSel([f.path], { scroll: true });
      toast(tr("library.dl.added", { name: f.name }));
    } else {
      toast(tr("library.dl.done", { name }));
    }
  } else {
    libStatus(tr("library.dl.failed"), 4000);
  }
});

/* ------------------------------------------------------------ visibility */

/* Called by the sidebar: the Library comes on or goes off screen. */
function libSetVisible(on) {
  LIB.visible = on;
  if (on) {
    restoreTabs();
    pushRect();
    invoke("lib_show", { id: libPinned(LIB.active) ? null : LIB.active }).catch(() => {});
  } else {
    invoke("lib_show", { id: null }).catch(() => {});
  }
}

/* Hides the view while a dialog or the viewer is in front. */
function libSuspend() {
  invoke("lib_show", { id: null }).catch(() => {});
}

function libResume() {
  if (LIB.visible) libSetVisible(true);
}

/* ------------------------------------------------------------ events */

listen("lib-url", (e) => {
  const { id, url } = e.payload;
  const t = LIB.tabs.find((x) => x.id === id);
  if (!t) return;
  t.url = url;
  saveTabs();
  if (LIB.active === id) {
    setUrl(url);
    libFavState();
  }
});

listen("lib-title", (e) => {
  const { id, title } = e.payload;
  const t = LIB.tabs.find((x) => x.id === id);
  if (!t || !title || title === t.title) return;
  t.title = title;
  saveTabs();
  renderTabs();
});

$("lib-add").addEventListener("click", (e) =>
  menuUnder(e.currentTarget, LIB.sites.map((s) => ({ id: "site:" + s.id, label: s.name })))
);
onMenu("site", (id) => {
  const s = LIB.sites.find((x) => String(x.id) === id);
  if (s) {
    switchView("library");
    openSite(s);
  }
});

document.querySelectorAll(".lib-tab.pin").forEach((el) => el.addEventListener("click", () => activateTab(el.dataset.tab)));
const libCmd = (what) => {
  if (libPinned(LIB.active)) return;
  invoke("lib_command", { id: LIB.active, what }).catch((e) => toast(String(e), true));
};
$("lib-back").addEventListener("click", () => libCmd("back"));
$("lib-fwd").addEventListener("click", () => libCmd("forward"));
$("lib-reload").addEventListener("click", () => libCmd("reload"));

addEventListener("resize", () => LIB.visible && pushRect());
new ResizeObserver(() => LIB.visible && pushRect()).observe($("lib-frame"));

/* Home: one card per site. */
function renderSites() {
  const box = $("lib-sites");
  box.innerHTML = "";
  for (const s of LIB.sites) {
    const b = document.createElement("button");
    b.className = "lib-site";
    const host = (() => {
      try {
        return new URL(s.url).host.replace(/^www\./, "");
      } catch {
        return "";
      }
    })();
    b.innerHTML = `${brandIcon(s.name, 36)}<span class="lib-site-name">${esc(s.name)}</span><span class="lib-site-host">${esc(host)}</span>`;
    b.onclick = () => openSite(s);
    box.appendChild(b);
  }
}

(async () => {
  try {
    LIB.sites = await invoke("lib_sites");
  } catch {
    LIB.sites = [];
  }
  renderSites();
  renderTabs();
  await loadFavs();
})();

window.addEventListener("langchange", () => {
  renderTabs();
  renderFavs();
});

/* Native views draw on top of everything: they are hidden while a sheet,
   the viewer or the welcome assistant takes the screen, and brought back
   afterwards. Every sheet counts: one opened by an event (the queue's
   next print, an update, a sign-in) would otherwise sit under the page,
   invisible, its backdrop blocking the app. */
const OVERLAY_SEL = ".modal, .viewer, .welcome";
(() => {
  const check = () => {
    const shown = [...document.querySelectorAll(OVERLAY_SEL)].some((el) => !el.classList.contains("hidden"));
    if (shown) libSuspend();
    else libResume();
  };
  const obs = new MutationObserver(check);
  for (const el of document.querySelectorAll(OVERLAY_SEL)) obs.observe(el, { attributes: true, attributeFilter: ["class"] });
})();
