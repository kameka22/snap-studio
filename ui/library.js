"use strict";
/* Bibliothèque : navigation dans les sites de modèles.
   Chaque onglet est une vue web native posée par-dessus notre interface. Nous
   ne dessinons donc que ce qui l'entoure — barre d'onglets, barre d'adresse —
   et nous lui indiquons son rectangle. Elle doit être masquée dès qu'autre
   chose passe devant : autre entrée de la barre latérale, dialogue, visualiseur 3D. */

const LIB = {
  sites: [],
  favs: [],
  restored: false,
  tabs: [],          // { id, name, url }
  active: "home",    // "home" ou l'identifiant d'un site
  visible: false,    // la vue Bibliothèque est-elle à l'écran ?
};

/* ------------------------------------------------------------ rectangle */

/* La vue native se place où se trouve notre cadre, en points d'interface. */
function libRect() {
  const r = $("lib-frame").getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function pushRect() {
  invoke("lib_rect", {
    rect: libRect(),
    // La hauteur de notre page sert à déduire celle de la barre de titre, dont
    // la vue native doit être décalée.
    viewport: window.innerHeight,
    visible: LIB.visible && LIB.active !== "home" ? LIB.active : null,
  }).catch(() => {});
}

/* ------------------------------------------------------------ onglets */

function renderTabs() {
  document.querySelector('.lib-tab[data-tab="home"]').classList.toggle("on", LIB.active === "home");
  const box = $("lib-tablist");
  box.innerHTML = "";
  for (const t of LIB.tabs) {
    const el = document.createElement("button");
    el.className = "lib-tab" + (t.id === LIB.active ? " on" : "");
    el.innerHTML = `<span class="name">${esc(t.name)}</span><span class="x" title="Fermer">✕</span>`;
    el.onclick = (e) => {
      if (e.target.classList.contains("x")) closeTab(t.id);
      else activateTab(t.id);
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      tabMenu(e, t);
    };
    box.appendChild(el);
  }
  const browsing = LIB.active !== "home";
  $("lib-bar").classList.toggle("hidden", !browsing);
  $("lib-home").classList.toggle("hidden", browsing);
  libTitle();
  if (browsing) {
    const t = LIB.tabs.find((x) => x.id === LIB.active);
    setUrl(t ? t.url : "");
  }
}

function setUrl(url) {
  $("lib-url").textContent = url || "";
  $("lib-url").title = url || "";
}

/* La zone d'adresse sert aussi de ligne d'état : une bulle de notification
   s'afficherait derrière la vue native. */
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

async function openSite(site) {
  if (!LIB.tabs.some((t) => t.id === site.id)) {
    LIB.tabs.push({ id: site.id, name: site.name, url: site.url });
  }
  LIB.active = site.id;
  renderTabs();
  saveTabs();
  // Le rectangle doit être connu avant la création, sinon la vue naît ailleurs.
  pushRect();
  try {
    await invoke("lib_open", { id: site.id, url: site.url });
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
  invoke("lib_show", { id: id === "home" ? null : id }).catch(() => {});
}

/* Les onglets ouverts sont retrouvés au lancement suivant. */
function saveTabs() {
  localStorage.setItem(
    "snapstudio.libtabs",
    JSON.stringify({ tabs: LIB.tabs.map((t) => t.id), active: LIB.active })
  );
}

/* Les vues natives coûtent de la mémoire : on ne les recrée qu'à la première
   visite de la Bibliothèque, pas au démarrage de l'application. */
async function restoreTabs() {
  if (LIB.restored) return;
  LIB.restored = true;
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem("snapstudio.libtabs") || "null");
  } catch {
    saved = null;
  }
  if (!saved || !saved.tabs || !saved.tabs.length) return;
  for (const id of saved.tabs) {
    const site = LIB.sites.find((s) => s.id === id);
    if (site) await openSite(site);
  }
  if (saved.active === "home" || LIB.tabs.some((t) => t.id === saved.active)) {
    activateTab(saved.active);
  }
}

function closeTab(id) {
  invoke("lib_close", { id }).catch(() => {});
  LIB.tabs = LIB.tabs.filter((t) => t.id !== id);
  if (LIB.active === id) LIB.active = LIB.tabs.length ? LIB.tabs[LIB.tabs.length - 1].id : "home";
  saveTabs();
  renderTabs();
  activateTab(LIB.active);
}

function tabMenu(e, tab) {
  nativeMenu([
    { id: "tab:reload:" + tab.id, label: "Recharger" },
    { id: "tab:logout:" + tab.id, label: `Se déconnecter de ${tab.name}` },
    {},
    { id: "tab:close:" + tab.id, label: "Fermer l'onglet" },
  ], e.clientX, e.clientY);
}
onMenu("tab", async (arg) => {
  const i = arg.indexOf(":");
  const what = arg.slice(0, i), id = arg.slice(i + 1);
  const tab = LIB.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (what === "reload") invoke("lib_command", { id, what: "reload" }).catch(() => {});
  if (what === "close") closeTab(id);
  if (what === "logout") {
    try {
      const n = await invoke("lib_logout", { id });
      libStatus(n ? `Déconnecté (${n} témoins effacés)` : "Aucune session à effacer");
    } catch (err) {
      libStatus(String(err), 4000);
    }
  }
});

/* ------------------------------------------------------------ favoris */

/* Icône de marque : carré arrondi à la couleur du site, initiale blanche ou
   sombre selon la luminance du fond. Couleur dérivée du nom si inconnue. */
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
  if (d < 3600) return "à l'instant";
  if (d < 86400) return `il y a ${Math.floor(d / 3600)} h`;
  if (d < 7 * 86400) return `il y a ${Math.floor(d / 86400)} j`;
  return new Date(secs * 1000).toLocaleDateString("fr-FR");
};

/* Titre de la barre d'outils : le site affiché, ou le décompte des favoris. */
function libTitle() {
  const todo = LIB.favs.filter((f) => !f.done).length;
  sideCount("library", todo);
  const t = LIB.active !== "home" && LIB.tabs.find((x) => x.id === LIB.active);
  if (t) tbSet("library", t.name, "");
  else tbSet("library", "Bibliothèque", LIB.favs.length ? `${todo} à imprimer sur ${LIB.favs.length}` : "");
}

async function favAct(what, id) {
  const f = LIB.favs.find((x) => x.id === id);
  if (!f) return;
  if (what === "open") return openFavorite(f);
  if (what === "done") LIB.favs = await invoke("fav_done", { id, done: !f.done });
  if (what === "remove") {
    if (!(await confirmDelete(`Retirer « ${f.title} » ?`, "Le modèle disparaîtra de vos prints ; la page reste accessible sur le site."))) return;
    LIB.favs = await invoke("fav_remove", { id });
  }
  renderFavs();
}
onMenu("fav", (arg) => {
  const i = arg.indexOf(":");
  favAct(arg.slice(0, i), arg.slice(i + 1));
});

function renderFavs() {
  const grid = $("lib-grid");
  const has = LIB.favs.length > 0;
  libTitle();
  grid.classList.toggle("hidden", !has);
  $("lib-empty").classList.toggle("hidden", has);
  if (!has) return;
  grid.innerHTML = "";
  for (const f of LIB.favs) {
    const el = document.createElement("div");
    el.className = "fav" + (f.done ? " done" : "");
    el.innerHTML = `
      <div class="fav-img">${
        f.image
          ? `<img src="favimg://localhost/i?f=${encodeURIComponent(f.image)}" alt="" />`
          : '<span class="none">sans aperçu</span>'
      }</div>
      <div class="fav-body">
        <div class="fav-title">${esc(f.title)}</div>
        <div class="fav-site">${brandIcon(f.site)}${esc(f.site)} · ${relDate(f.added_at)}${
          f.done ? '<span class="fav-flag">FAIT</span>' : ""
        }</div>
      </div>
      <div class="fav-actions">
        <button class="btn small go">Ouvrir</button>
        <button class="btn small done" title="Marquer comme imprimé">${f.done ? "À refaire" : "Fait"}</button>
        <button class="btn small danger del" title="Retirer">Retirer</button>
      </div>`;
    el.querySelector(".go").onclick = () => favAct("open", f.id);
    el.querySelector(".done").onclick = () => favAct("done", f.id);
    el.querySelector(".del").onclick = () => favAct("remove", f.id);
    el.oncontextmenu = (e) =>
      nativeMenu([
        { id: "fav:open:" + f.id, label: "Ouvrir" },
        { id: "fav:done:" + f.id, label: f.done ? "Marquer à refaire" : "Marquer comme imprimé" },
        {},
        { id: "fav:remove:" + f.id, label: "Retirer de vos prints" },
      ], e.clientX, e.clientY);
    grid.appendChild(el);
  }
}

/* Ouvre un favori dans l'onglet de son site, créé au besoin. */
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
  await openSite(site);
  invoke("lib_navigate", { id: site.id, url: f.url }).catch((e) => toast(String(e), true));
}

async function loadFavs() {
  try {
    LIB.favs = await invoke("fav_list");
  } catch {
    LIB.favs = [];
  }
  renderFavs();
}

$("lib-fav").addEventListener("click", async () => {
  const t = LIB.tabs.find((x) => x.id === LIB.active);
  if (!t) return;
  libStatus("Lecture de la page…", 0);
  try {
    LIB.favs = await invoke("fav_add", { url: t.url });
    renderFavs();
    libStatus("Ajouté à vos prints ★");
  } catch (e) {
    libStatus(String(e), 4000);
  }
});

/* ------------------------------------------------------------ téléchargements */

listen("lib-download", async (e) => {
  const { phase, path } = e.payload;
  const name = (path || "").split("/").pop();
  if (phase === "started") {
    libStatus(`Téléchargement de ${name}…`, 0);
  } else if (phase === "finished") {
    libStatus(`${name} téléchargé`, 2500);
    // Le fichier arrive dans Téléchargements : on va le montrer.
    switchView("files");
    await refresh();
    const f = state.files.find((x) => x.path === path);
    if (f) {
      setSel([f.path], { scroll: true });
      toast(`${f.name} ajouté à la bibliothèque`);
    } else {
      toast(`Téléchargé : ${name}`);
    }
  } else {
    libStatus("Téléchargement interrompu", 4000);
  }
});

/* ------------------------------------------------------------ visibilité */

/* Appelé par la barre latérale : la Bibliothèque entre ou sort de l'écran. */
function libSetVisible(on) {
  LIB.visible = on;
  if (on) {
    restoreTabs();
    pushRect();
    invoke("lib_show", { id: LIB.active === "home" ? null : LIB.active }).catch(() => {});
  } else {
    invoke("lib_show", { id: null }).catch(() => {});
  }
}

/* Masque la vue le temps qu'un dialogue ou le visualiseur passe devant. */
function libSuspend() {
  invoke("lib_show", { id: null }).catch(() => {});
}

function libResume() {
  if (LIB.visible) libSetVisible(true);
}

/* ------------------------------------------------------------ évènements */

listen("lib-url", (e) => {
  const { id, url } = e.payload;
  const t = LIB.tabs.find((x) => x.id === id);
  if (t) t.url = url;
  if (LIB.active === id) setUrl(url);
});

$("lib-add").addEventListener("click", (e) =>
  menuUnder(e.currentTarget, LIB.sites.map((s) => ({ id: "site:" + s.id, label: s.name })))
);
onMenu("site", (id) => {
  const s = LIB.sites.find((x) => String(x.id) === id);
  if (s) openSite(s);
});

document.querySelector('.lib-tab[data-tab="home"]').addEventListener("click", () => activateTab("home"));
const libCmd = (what) => {
  if (LIB.active === "home") return;
  invoke("lib_command", { id: LIB.active, what }).catch((e) => toast(String(e), true));
};
$("lib-back").addEventListener("click", () => libCmd("back"));
$("lib-fwd").addEventListener("click", () => libCmd("forward"));
$("lib-reload").addEventListener("click", () => libCmd("reload"));

addEventListener("resize", () => LIB.visible && pushRect());
new ResizeObserver(() => LIB.visible && pushRect()).observe($("lib-frame"));

(async () => {
  try {
    LIB.sites = await invoke("lib_sites");
  } catch {
    LIB.sites = [];
  }
  const box = $("lib-sites");
  box.innerHTML = "";
  for (const s of LIB.sites) {
    const b = document.createElement("button");
    b.className = "place";
    b.textContent = s.name;
    b.onclick = () => openSite(s);
    box.appendChild(b);
  }
  renderTabs();
  await loadFavs();
})();

/* Les vues natives se dessinent au-dessus de tout : on les efface pendant
   qu'un dialogue ou le visualiseur occupe l'écran, et on les rappelle après. */
const OVERLAYS = ["smodal", "pmodal", "iamodal", "sendmodal", "viewer"];
(() => {
  const check = () => {
    const shown = OVERLAYS.some((id) => $(id) && !$(id).classList.contains("hidden"));
    if (shown) libSuspend();
    else libResume();
  };
  const obs = new MutationObserver(check);
  for (const id of OVERLAYS) {
    const el = $(id);
    if (el) obs.observe(el, { attributes: true, attributeFilter: ["class"] });
  }
})();
