"use strict";
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

/* Sur macOS, la barre de menus porte les raccourcis à ⌘ et la fenêtre est
   vibrante, barre de titre en surimpression ; ailleurs, fenêtre classique. */
const IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent);
document.documentElement.classList.toggle("mac", IS_MAC);

/* Reprise des réglages de l'ancienne « 3MF Studio » (clés trimf.*). Le
   stockage WebKit lui-même a été recopié par le Rust au démarrage. */
for (const [o, n] of [["trimf", "snapstudio"], ["trimf.slice", "snapstudio.slice"], ["trimf.libtabs", "snapstudio.libtabs"]]) {
  if (localStorage.getItem(n) === null && localStorage.getItem(o) !== null) {
    localStorage.setItem(n, localStorage.getItem(o));
    localStorage.removeItem(o);
  }
}

/* ------------------------------------------------------------------ état */

const DEFAULTS = {
  view: "grid",
  sort: "name",
  asc: true,
  tile: 220,
  pref: 0,
  recursive: false,
  detailsWidth: 340,
  invertWheel: false,
  slicer: null,
  wheelAction: "zoom",
  wheelSpeed: 1,
  dir: null,
  recents: [],
};

const state = {
  ...DEFAULTS,
  ...JSON.parse(localStorage.getItem("snapstudio") || "{}"),
  files: [],
  meta: new Map(),
  analysis: new Map(),
  view_files: [],
  sel: new Set(),
  anchor: -1,
  rendered: 0,
  nodes: new Map(),
  scanning: false,
};

function save() {
  const { view, sort, asc, tile, pref, recursive, detailsWidth, invertWheel, wheelAction, wheelSpeed, slicer, dir, recents } = state;
  localStorage.setItem(
    "snapstudio",
    JSON.stringify({ view, sort, asc, tile, pref, recursive, detailsWidth, invertWheel, wheelAction, wheelSpeed, slicer, dir, recents })
  );
}

/* ------------------------------------------------------------- formatage */

const fmtSize = (b) => {
  if (b < 1024) return b + " o";
  const u = ["Ko", "Mo", "Go", "To"];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)).toString().replace(".", ",") + " " + u[i];
};

const fmtDuration = (s) => {
  if (s == null) return null;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${Math.max(m, 1)} min`;
};

const fmtWeight = (g) => (g == null ? null : `${g < 10 ? g.toFixed(1).replace(".", ",") : Math.round(g)} g`);

const dtf = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });
/* Heure du jour, « 16 h 40 » ; la date s'ajoute si ce n'est pas aujourd'hui. */
function fmtClock(ms) {
  const d = new Date(ms);
  const hm = `${d.getHours()} h ${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })} ${hm}`;
}
const fmtDate = (secs) => dtf.format(new Date(secs * 1000));

/* --------------------------------------------------------------- vignettes */

const SIZES = [192, 256, 320, 448, 640, 896];
const bucket = (n) => SIZES.find((s) => s >= n) ?? SIZES[SIZES.length - 1];

function thumbUrl(f, px) {
  const s = bucket(Math.round(px * Math.min(window.devicePixelRatio || 1, 2)));
  return `thumb://localhost/t?p=${encodeURIComponent(f.path)}&s=${s}&k=${state.pref}&v=${f.modified}`;
}

/* ------------------------------------------------------------------ thème */

/* Clair ou sombre : seul le réglage du système décide. Les surfaces dessinées
   hors CSS (WebGL, terminal) écoutent l'événement « themechange ». */
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => darkScheme.matches;
darkScheme.addEventListener("change", () => window.dispatchEvent(new Event("themechange")));

/* ------------------------------------------------------- menus natifs */

/* Le menu est construit côté Rust ; chaque entrée porte un identifiant
   « verbe:argument » qui revient par l'événement « menu ». Une entrée sans
   id est un séparateur ; « checked » en fait une entrée cochable. */
const MENU = {};
const onMenu = (verb, fn) => (MENU[verb] = fn);
listen("menu", (e) => {
  const id = String(e.payload);
  const i = id.indexOf(":");
  const fn = MENU[i < 0 ? id : id.slice(0, i)];
  if (fn) fn(i < 0 ? "" : id.slice(i + 1));
});
function nativeMenu(items, x, y) {
  return invoke("popup_menu", { items, x, y }).catch((e) => toast(String(e), true));
}
/* Toute suppression se confirme par une alerte native (NSAlert). */
function confirmDelete(title, message) {
  return window.__TAURI__.dialog.ask(message, {
    title,
    kind: "warning",
    okLabel: "Supprimer",
    cancelLabel: "Annuler",
  });
}

/* Pas de menu contextuel du navigateur, sauf dans les champs de saisie. */
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("input, textarea, [contenteditable]")) e.preventDefault();
});

/* Menu ouvert sous un bouton de barre d'outils. */
function menuUnder(el, items) {
  const r = el.getBoundingClientRect();
  return nativeMenu(items, r.left, r.bottom + 4);
}

/* ------------------------------------------------- barre d'outils commune */

/* Chaque vue déclare son titre et son sous-titre ; seule la vue affichée
   les montre. Ses contrôles vivent dans un créneau .tb-actions[data-for]. */
const TB = {};
function tbSet(view, title, sub = "") {
  TB[view] = { title, sub };
  if ((window.currentView || "files") === view) tbRender();
}
function tbRender() {
  const v = window.currentView || "files";
  const t = TB[v] || { title: "", sub: "" };
  $("tb-title").textContent = t.title;
  $("tb-sub").textContent = t.sub;
  document.querySelectorAll(".tb-actions").forEach((el) => el.classList.toggle("on", el.dataset.for === v));
}

/* ------------------------------------------------------- barre latérale */

const SIDE_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const baseName = (p) => p.split("/").filter(Boolean).pop() || p;

function sideCount(view, n) {
  const el = $("count-" + view);
  if (el) el.textContent = n ? String(n) : "";
}

function renderRecents() {
  const box = $("side-recents");
  box.innerHTML = "";
  for (const d of state.recents) {
    const b = document.createElement("button");
    b.className = "side-item";
    b.dataset.dir = d;
    b.title = d;
    b.innerHTML = `<span class="glyph" style="color: #32ADE6">${SIDE_FOLDER}</span><span class="lbl">${esc(baseName(d))}</span><span class="count"></span>`;
    b.onclick = () => {
      switchView("files");
      if (d !== state.dir) openDir(d);
    };
    b.oncontextmenu = (e) =>
      nativeMenu([
        { id: "recent:reveal:" + d, label: "Afficher dans le Finder" },
        {},
        { id: "recent:forget:" + d, label: "Retirer des récents" },
      ], e.clientX, e.clientY);
    box.appendChild(b);
  }
  sideSync();
}

onMenu("recent", (arg) => {
  const i = arg.indexOf(":");
  const what = arg.slice(0, i), dir = arg.slice(i + 1);
  if (what === "reveal") invoke("reveal", { path: dir }).catch((e) => toast(String(e), true));
  if (what === "forget") {
    state.recents = state.recents.filter((d) => d !== dir);
    save();
    renderRecents();
  }
});

/* Une seule sélection dans la barre latérale, comme dans le Finder : le
   dossier ouvert, l'imprimante affichée, sinon l'entrée de la vue. */
function sideSync() {
  const v = window.currentView || "files";
  let target = null;
  if (v === "files" && state.dir) target = document.querySelector(`#side-recents [data-dir="${CSS.escape(state.dir)}"]`);
  if (v === "printers" && typeof P !== "undefined" && P.sel) target = document.querySelector(`#side-printers [data-id="${CSS.escape(P.sel)}"]`);
  if (v === "ia" && typeof IA !== "undefined" && IA.open) target = document.querySelector(`#side-ia [data-conv="${CSS.escape(IA.open)}"]`);
  if (v === "prints" && typeof PJ !== "undefined" && PJ.sel) {
    target = document.querySelector(`#side-prints [data-pj="${CSS.escape(PJ.sel)}"]`);
    // Une impression en cours lancée par Snap Studio : son entrée « live ».
    if (!target && PJ.sel.startsWith("job:")) {
      const j = PJ.jobs.find((x) => "job:" + x.id === PJ.sel);
      if (j?.state === "printing") target = document.querySelector(`#side-prints [data-pj="live:${CSS.escape(j.printer_id)}"]`);
    }
  }
  if (!target) target = document.querySelector(`.sidebar .side-item[data-view="${v}"]`);
  document.querySelectorAll(".sidebar .side-item").forEach((el) => el.classList.toggle("on", el === target));
  // Le décompte du dossier ouvert s'affiche sur son entrée.
  document.querySelectorAll("#side-recents .count").forEach((c) => (c.textContent = ""));
  if (v === "files" && target && target.dataset.dir) {
    target.querySelector(".count").textContent = state.dir ? String(state.files.length || "") : "";
  }
}

/* La sélection passe au gris quand la fenêtre perd le focus. On écoute la
   fenêtre native : le document perd aussi le focus quand on clique dans une
   page de la Bibliothèque, qui vit dans une autre vue de la même fenêtre. */
const setInactive = (off) => $("sidebar").classList.toggle("inactive", off);
const tauriWin = window.__TAURI__.window?.getCurrentWindow?.();
if (tauriWin) tauriWin.onFocusChanged(({ payload }) => setInactive(!payload));
else {
  window.addEventListener("blur", () => setInactive(true));
  window.addEventListener("focus", () => setInactive(false));
}

/* ------------------------------------------------------------------ sheets */

/* Feuilles modales façon AppKit : elles descendent de la barre de titre.
   Clic sur le voile = Annuler ; le premier champ prend le focus. */
function openSheet(el) {
  el.classList.remove("closing", "hidden");
  requestAnimationFrame(() => {
    const f = el.querySelector("input:not([type=range]):not([type=checkbox]), textarea, select");
    if (f) f.focus();
  });
}
function closeSheet(el) {
  if (el.classList.contains("hidden") || el.classList.contains("closing")) return;
  el.classList.add("closing");
  setTimeout(() => {
    if (!el.classList.contains("closing")) return;
    el.classList.remove("closing");
    el.classList.add("hidden");
  }, 150);
}
document.querySelectorAll(".modal").forEach((m) =>
  m.addEventListener("mousedown", (e) => {
    if (e.target !== m) return;
    const cancel = m.querySelector("[data-cancel]");
    if (cancel && !cancel.classList.contains("hidden")) cancel.click();
  })
);

/* ------------------------------------------------------------------ toasts */

const TOAST_OK = '<svg class="ok" viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>';
const TOAST_KO = '<svg class="ko" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m1 15h-2v-2h2zm0-4h-2V7h2z"/></svg>';

/* Capsule en bas de fenêtre, jamais de bouton ; 2,6 s, 5 s pour une erreur. */
function toast(msg, err = false) {
  const el = document.createElement("div");
  el.className = "toast" + (err ? " err" : "");
  el.innerHTML = err ? TOAST_KO : TOAST_OK;
  const span = document.createElement("span");
  span.textContent = msg;
  el.appendChild(span);
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 180);
  }, err ? 5000 : 2600);
}

/* ---------------------------------------------------------------- dossier */

async function pickFolder() {
  const dir = await invoke("pick_folder");
  if (dir) openDir(dir);
}

async function openDir(dir) {
  state.dir = dir;
  // Un dossier déjà listé garde sa place dans la barre latérale ; seul un
  // nouveau venu s'ajoute en tête (le plus ancien sort quand la liste est pleine).
  if (!state.recents.includes(dir)) state.recents = [dir, ...state.recents].slice(0, 8);
  save();
  renderRecents();
  updateStatus();
  await refresh();
}

async function refresh() {
  if (!state.dir) return;
  state.scanning = true;
  setSel([]);
  state.meta.clear();
  state.analysis.clear();
  $("empty").classList.add("hidden");
  $("loading").classList.remove("hidden");
  $("items").innerHTML = "";
  try {
    state.files = await invoke("scan_folder", { dir: state.dir, recursive: state.recursive });
  } catch (e) {
    state.files = [];
    toast(String(e), true);
  }
  state.scanning = false;
  $("loading").classList.add("hidden");
  applyView();
  updateDetails();
  loadMetas();
}

/* Les métadonnées arrivent par lots pour ne pas bloquer l'affichage. */
async function loadMetas() {
  const token = (loadMetas.token = Symbol());
  const paths = state.files.map((f) => f.path);
  for (let i = 0; i < paths.length; i += 60) {
    const chunk = paths.slice(i, i + 60);
    let metas;
    try {
      metas = await invoke("read_metas", { paths: chunk });
    } catch {
      return;
    }
    if (token !== loadMetas.token) return;
    for (const m of metas) state.meta.set(m.path, m);
    for (const p of chunk) patchNode(p);
    if (state.sort === "time" || state.sort === "weight") applyView();
    if (state.sel.size === 1 && chunk.includes([...state.sel][0])) updateDetails();
    updateStatus();
  }
}

/* --------------------------------------------------------- tri et filtrage */

function subtitle(f) {
  const m = state.meta.get(f.path);
  const bits = [];
  const d = fmtDuration(m?.print_time_s);
  if (d) bits.push(d);
  const w = fmtWeight(m?.weight_g);
  if (w) bits.push(w);
  if (!bits.length) bits.push(fmtSize(f.size));
  return bits;
}

function applyView() {
  const q = $("search").value.trim().toLowerCase();
  let list = state.files;
  if (q) {
    const terms = q.split(/\s+/);
    list = list.filter((f) => {
      const m = state.meta.get(f.path);
      const hay = (
        f.name + " " + f.rel + " " + (m?.title || "") + " " + (m?.designer || "") +
        " " + (m?.objects || []).join(" ")
      ).toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  const dir = state.asc ? 1 : -1;
  const byName = (a, b) => a.name.localeCompare(b.name, "fr", { numeric: true, sensitivity: "base" });
  const num = (v) => (v == null ? null : v);
  const cmpNullable = (av, bv, a, b) => {
    if (av == null && bv == null) return byName(a, b);
    if (av == null) return 1;   // sans valeur : toujours en fin de liste
    if (bv == null) return -1;
    return (av - bv) * dir || byName(a, b);
  };

  list = [...list].sort((a, b) => {
    switch (state.sort) {
      case "date": return (a.modified - b.modified) * dir || byName(a, b);
      case "size": return (a.size - b.size) * dir || byName(a, b);
      case "time": return cmpNullable(num(state.meta.get(a.path)?.print_time_s), num(state.meta.get(b.path)?.print_time_s), a, b);
      case "weight": return cmpNullable(num(state.meta.get(a.path)?.weight_g), num(state.meta.get(b.path)?.weight_g), a, b);
      case "folder": return a.rel.localeCompare(b.rel, "fr") * dir || byName(a, b);
      default: return byName(a, b) * dir;
    }
  });

  state.view_files = list;
  renderReset();
  updateStatus();
}

/* ------------------------------------------------------------------ rendu */

const BATCH = 100;

function renderReset() {
  const items = $("items");
  items.innerHTML = "";
  state.nodes.clear();
  state.rendered = 0;
  items.className = state.view === "grid" ? "grid" : "items-list";
  $("listhead").classList.toggle("hidden", state.view !== "list" || !state.view_files.length);
  const nothing = !state.view_files.length && !state.scanning && state.dir;
  $("noresult").classList.toggle("hidden", !nothing);
  if (nothing) {
    $("noresult").querySelector("p").textContent = state.files.length
      ? "Aucun fichier ne correspond à la recherche."
      : "Aucun fichier 3MF dans ce dossier." +
        (state.recursive ? "" : " Activez « Inclure les sous-dossiers » dans les options.");
  }
  $("empty").classList.toggle("hidden", !!state.dir);
  document.documentElement.style.setProperty("--tile", state.tile + "px");
  renderMore();
}

function renderMore() {
  const items = $("items");
  const frag = document.createDocumentFragment();
  const end = Math.min(state.rendered + BATCH, state.view_files.length);
  for (let i = state.rendered; i < end; i++) {
    const f = state.view_files[i];
    const node = state.view === "grid" ? makeCard(f) : makeRow(f);
    node.dataset.path = f.path;
    node.dataset.index = i;
    if (state.sel.has(f.path)) node.classList.add("sel");
    state.nodes.set(f.path, node);
    frag.appendChild(node);
  }
  items.appendChild(frag);
  state.rendered = end;
}

function thumbImg(f, px, cls) {
  const img = document.createElement("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.draggable = false;
  img.alt = "";
  img.src = thumbUrl(f, px);
  img.addEventListener("load", () => img.classList.add("ok"));
  img.addEventListener("error", () => {
    const box = img.parentElement;
    img.remove();
    const d = document.createElement("div");
    d.className = "fail";
    d.textContent = cls === "row" ? "?" : "Aperçu indisponible";
    box.appendChild(d);
  });
  return img;
}

function pickBox() {
  const p = document.createElement("div");
  p.className = "pick";
  p.title = "Ajouter à la sélection";
  p.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9.5 17.2 4.8 12.5l1.4-1.4 3.3 3.3 8-8 1.4 1.4z"/></svg>';
  return p;
}

function makeCard(f) {
  const card = document.createElement("div");
  card.className = "card";
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.appendChild(thumbImg(f, state.tile));
  thumb.appendChild(pickBox());
  card.appendChild(thumb);

  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = f.name.replace(/\.3mf$/i, "");
  name.title = f.name;
  const sub = document.createElement("div");
  sub.className = "sub";
  meta.append(name, sub);
  card.appendChild(meta);
  fillSub(sub, f);
  addBadges(card, f);
  return card;
}

function makeRow(f) {
  const row = document.createElement("div");
  row.className = "row-item";
  const th = document.createElement("div");
  th.className = "rthumb";
  th.appendChild(thumbImg(f, 46, "row"));

  const nameWrap = document.createElement("div");
  const n = document.createElement("div");
  n.className = "rname";
  n.textContent = f.name.replace(/\.3mf$/i, "");
  const s = document.createElement("div");
  s.className = "rsub";
  nameWrap.append(n, s);

  const cells = ["time", "weight", "size", "date"].map((k) => {
    const c = document.createElement("div");
    c.className = "cell " + k;
    return c;
  });
  row.append(pickBox(), th, nameWrap, ...cells);
  fillRow(row, f);
  return row;
}

function fillSub(sub, f) {
  sub.innerHTML = "";
  const bits = subtitle(f);
  bits.forEach((b, i) => {
    if (i) {
      const d = document.createElement("span");
      d.className = "dot";
      sub.appendChild(d);
    }
    const sp = document.createElement("span");
    sp.textContent = b;
    sub.appendChild(sp);
  });
}

function fillRow(row, f) {
  const m = state.meta.get(f.path);
  const sub = row.querySelector(".rsub");
  const parts = [];
  if (f.rel) parts.push(f.rel);
  if (m?.title && m.title !== f.name) parts.push(m.title);
  if (m?.designer) parts.push(m.designer);
  if (m?.objects?.length > 1) parts.push(`${m.objects.length} pièces`);
  sub.textContent = parts.join(" · ");
  const [t, w, sz, dt] = row.querySelectorAll(".cell");
  t.textContent = fmtDuration(m?.print_time_s) || "—";
  w.textContent = fmtWeight(m?.weight_g) || "—";
  sz.textContent = fmtSize(f.size);
  dt.textContent = fmtDate(f.modified);
}

function addBadges(card, f) {
  const m = state.meta.get(f.path);
  card.querySelectorAll(".badge").forEach((b) => b.remove());
  if (f.kind === "gcode") {
    const b = document.createElement("div");
    b.className = "badge gcode";
    b.textContent = "G-code";
    b.title = "Fichier de trajectoires prêt à imprimer";
    card.querySelector(".thumb").appendChild(b);
    return;
  }
  if (!m) return;
  if (state.pref === 3 || (state.pref !== 2 && !m.has_embedded_thumb)) {
    const b = document.createElement("div");
    b.className = "badge";
    b.textContent = "Rendu 3D";
    b.title = "Aucune vignette dans le fichier : rendu calculé depuis la géométrie";
    card.querySelector(".thumb").appendChild(b);
  }
  if (m.plates > 1) {
    const b = document.createElement("div");
    b.className = "badge plates";
    b.textContent = m.plates + " plateaux";
    card.querySelector(".thumb").appendChild(b);
  }
}

function patchNode(path) {
  const node = state.nodes.get(path);
  if (!node) return;
  const f = state.files.find((x) => x.path === path);
  if (!f) return;
  if (state.view === "grid") {
    fillSub(node.querySelector(".sub"), f);
    addBadges(node, f);
  } else {
    fillRow(node, f);
  }
}

/* -------------------------------------------------------------- sélection */

function setSel(paths, { scroll = false } = {}) {
  state.sel = new Set(paths);
  document.body.classList.toggle("has-sel", state.sel.size > 0);
  for (const [p, n] of state.nodes) n.classList.toggle("sel", state.sel.has(p));
  if (scroll && paths.length) {
    const n = state.nodes.get(paths[paths.length - 1]);
    if (n) n.scrollIntoView({ block: "nearest" });
  }
  updateDetails();
  updateStatus();
  updateSelBar();
}

function updateSelBar() {
  const n = state.sel.size;
  const bar = $("selbar");
  bar.classList.toggle("hidden", n < 2);
  if (n >= 2) {
    const size = state.files.filter((f) => state.sel.has(f.path)).reduce((s, f) => s + f.size, 0);
    $("selbar-txt").textContent = `${n} fichiers sélectionnés · ${fmtSize(size)}`;
  }
}

function selectAll() {
  while (state.rendered < state.view_files.length) renderMore();
  setSel(state.view_files.map((f) => f.path));
}

function indexOfPath(p) {
  return state.view_files.findIndex((f) => f.path === p);
}

function toggleOne(path) {
  const s = new Set(state.sel);
  s.has(path) ? s.delete(path) : s.add(path);
  state.anchor = indexOfPath(path);
  setSel([...s]);
}

function clickItem(ev, path) {
  const idx = indexOfPath(path);
  if (ev.shiftKey && state.anchor >= 0) {
    const [a, b] = [state.anchor, idx].sort((x, y) => x - y);
    setSel(state.view_files.slice(a, b + 1).map((f) => f.path));
  } else if (ev.metaKey || ev.ctrlKey) {
    const s = new Set(state.sel);
    s.has(path) ? s.delete(path) : s.add(path);
    state.anchor = idx;
    setSel([...s]);
  } else {
    state.anchor = idx;
    setSel([path]);
  }
}

function moveSel(delta) {
  if (!state.view_files.length) return;
  const cur = state.sel.size ? indexOfPath([...state.sel][state.sel.size - 1]) : -1;
  let next = Math.min(Math.max(cur + delta, 0), state.view_files.length - 1);
  while (next >= state.rendered) renderMore();
  state.anchor = next;
  setSel([state.view_files[next].path], { scroll: true });
}

function columns() {
  if (state.view === "list") return 1;
  const cs = getComputedStyle($("items")).gridTemplateColumns;
  return Math.max(1, cs.split(" ").filter(Boolean).length);
}

/* ------------------------------------------------------------- détails */

async function updateDetails() {
  const n = state.sel.size;
  $("det-empty").classList.toggle("hidden", n !== 0);
  $("det-body").classList.toggle("hidden", n !== 1);
  $("det-multi").classList.toggle("hidden", n < 2);

  if (n > 1) {
    const files = state.files.filter((f) => state.sel.has(f.path));
    $("multi-count").textContent = n;
    $("multi-size").textContent = fmtSize(files.reduce((s, f) => s + f.size, 0)) + " au total";
    return;
  }
  if (n !== 1) return;

  const path = [...state.sel][0];
  const f = state.files.find((x) => x.path === path);
  if (!f) return;
  const dimg = $("det-img");
  dimg.style.visibility = "hidden";
  dimg.onload = () => (dimg.style.visibility = "visible");
  dimg.onerror = () => (dimg.style.visibility = "hidden");
  dimg.src = thumbUrl(f, 640);
  $("det-name").textContent = f.name;
  $("det-name").title = f.path;

  if (!state.meta.has(path)) {
    try {
      const [m] = await invoke("read_metas", { paths: [path] });
      if (m) state.meta.set(path, m);
      patchNode(path);
    } catch {}
    if (![...state.sel][0] || [...state.sel][0] !== path) return;
  }
  const m = state.meta.get(path) || {};
  $("det-sub").textContent = [m.title, m.designer && "par " + m.designer].filter(Boolean).join(" — ");
  const rendered = state.pref === 3 || (state.pref !== 2 && !m.has_embedded_thumb);
  $("det-badge").textContent = rendered ? "Rendu 3D" : "";
  $("det-badge").style.display = rendered ? "" : "none";

  const rows = [];
  const add = (k, v) => v && rows.push([k, v]);
  add("Taille", fmtSize(f.size));
  add("Modifié", fmtDate(f.modified));
  if (f.rel) add("Sous-dossier", f.rel);
  add("Durée", fmtDuration(m.print_time_s));
  add("Filament", fmtWeight(m.weight_g));
  if (m.plates > 1) add("Plateaux", m.plates);
  if (m.objects?.length) add("Pièces", m.objects.length > 3 ? `${m.objects.length}` : m.objects.join(", "));
  add("Imprimante", m.printer);
  add("Logiciel", m.application);
  add("Créé le", m.creation_date);
  add("Licence", m.license);
  const a = state.analysis.get(path);
  if (a) {
    add("Encombrement", a.size_mm.map((v) => v.toFixed(1).replace(".", ",")).join(" × ") + " mm");
    add("Triangles", a.triangles.toLocaleString("fr-FR") + (a.approximated ? " (échantillonné)" : ""));
  }
  $("det-info").innerHTML = rows
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`)
    .join("");

  $("det-filaments").innerHTML = (m.filaments || [])
    .map(
      (fl) => `<div class="fil"><span class="swatch" style="background:${esc(fl.color || "#888")}"></span>
      <span>${esc(fl.kind || "?")}</span>
      <span class="g">${fl.used_g != null ? esc(fmtWeight(fl.used_g)) : ""}${
        fl.used_m != null ? " · " + fl.used_m.toFixed(1).replace(".", ",") + " m" : ""
      }</span></div>`
    )
    .join("");

  // L'analyse géométrique ne concerne que les maillages.
  const isGcode = f.kind === "gcode";
  $("act-analyze").classList.toggle("hidden", !!a || isGcode);
  $("act-plate").classList.toggle("hidden", isGcode);
  $("act-slice").parentElement.classList.toggle("hidden", isGcode);
  $("det-ia").classList.toggle("hidden", isGcode);
  $("det-3d").lastChild.textContent = isGcode ? " Trajectoires" : " Vue 3D";
  $("det-desc").textContent = m.description || "";
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function analyzeSelected() {
  const path = [...state.sel][0];
  if (!path) return;
  const btn = $("act-analyze");
  btn.disabled = true;
  btn.textContent = "Analyse en cours…";
  try {
    const a = await invoke("analyze", { path });
    state.analysis.set(path, a);
    updateDetails();
  } catch (e) {
    toast("Analyse impossible : " + e, true);
  }
  btn.disabled = false;
  btn.textContent = "Analyser la géométrie";
}

/* ------------------------------------------------------------ suppression */

async function askDelete() {
  if (!state.sel.size) return;
  const files = state.files.filter((f) => state.sel.has(f.path));
  const ok = await confirmDelete(
    files.length === 1 ? `Mettre « ${files[0].name} » à la corbeille ?` : `Mettre ${files.length} fichiers à la corbeille ?`,
    files.length === 1
      ? "Le fichier sera placé dans la corbeille du système."
      : `${fmtSize(files.reduce((s, f) => s + f.size, 0))} seront placés dans la corbeille du système.`
  );
  if (ok) doDelete();
}

async function doDelete() {
  const paths = [...state.sel];
  try {
    await invoke("trash_files", { paths });
  } catch (e) {
    toast("Suppression impossible : " + e, true);
    return;
  }
  const gone = new Set(paths);
  const idx = indexOfPath(paths[0]);
  state.files = state.files.filter((f) => !gone.has(f.path));
  state.sel.clear();
  applyView();
  const next = state.view_files[Math.min(idx, state.view_files.length - 1)];
  setSel(next ? [next.path] : []);
  toast(paths.length === 1 ? "Fichier mis à la corbeille" : `${paths.length} fichiers mis à la corbeille`);
}

/* ------------------------------------------------------------ menu, divers */

/* Menu contextuel natif d'un fichier ; il agit sur la sélection courante,
   à laquelle le clic droit a déjà ajouté l'élément visé. Ses entrées portent
   le chemin visé (« ctxfile:action:chemin »), distinctes de celles de la
   barre de menus (« file:action »). */
function openMenu(x, y, path) {
  const many = state.sel.size > 1;
  const f0 = state.files.find((f) => f.path === path);
  const id = (what) => `ctxfile:${what}:${path}`;
  nativeMenu([
    { id: id("open"), label: many ? `Ouvrir ${state.sel.size} fichiers` : "Ouvrir" },
    ...(f0?.kind !== "gcode" ? [{ id: id("plate"), label: "Ajouter au plateau du trancheur" }] : []),
    ...(many ? [] : [
      {},
      { id: id("view3d"), label: f0?.kind === "gcode" ? "Voir les trajectoires" : "Vue 3D" },
      { id: id("reveal"), label: "Afficher dans le Finder" },
      { id: id("copy"), label: "Copier le chemin" },
    ]),
    {},
    { id: id("delete"), label: many ? `Mettre ${state.sel.size} fichiers à la corbeille` : "Mettre à la corbeille" },
  ], x, y);
}

function fileAction(what, path) {
  if (what === "open") sendToSlicer(false);
  if (what === "plate") sendToSlicer(true);
  if (what === "view3d") open3d(path);
  if (what === "reveal") invoke("reveal", { path }).catch((e) => toast(String(e), true));
  if (what === "copy") copy(path);
  if (what === "delete") askDelete();
}
onMenu("ctxfile", (arg) => {
  const i = arg.indexOf(":");
  const path = arg.slice(i + 1);
  if (state.sel.has(path)) fileAction(arg.slice(0, i), path);
});
/* Depuis la barre de menus : vue Fichiers seulement, ni sheet ni saisie en cours. */
onMenu("file", (what) => {
  const path = [...state.sel][0];
  if (!path || window.currentView !== "files") return;
  if (document.querySelector(".modal:not(.hidden)")) return;
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
  fileAction(what, path);
});

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Chemin copié");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("Chemin copié");
  }
}

function updateStatus() {
  const total = state.view_files.reduce((s, f) => s + f.size, 0);
  const filtered = state.view_files.length !== state.files.length;
  const sub = state.dir
    ? `${state.view_files.length} fichier${state.view_files.length > 1 ? "s" : ""}${
        filtered ? ` sur ${state.files.length}` : ""
      } · ${fmtSize(total)}`
    : "";
  tbSet("files", state.dir ? baseName(state.dir) : "Fichiers", sub);
  sideSync();
}

/* ------------------------------------------------------------- évènements */

$("items").addEventListener("mousedown", (e) => {
  const node = e.target.closest("[data-path]");
  if (!node) return;
  if (e.target.closest(".pick")) {
    e.preventDefault();
    e.stopPropagation();
    toggleOne(node.dataset.path);
    return;
  }
  if (e.button === 2) {
    if (!state.sel.has(node.dataset.path)) clickItem(e, node.dataset.path);
    return;
  }
  clickItem(e, node.dataset.path);
});

$("items").addEventListener("dblclick", (e) => {
  const node = e.target.closest("[data-path]");
  if (node) sendToSlicer(false);
});

$("items").addEventListener("contextmenu", (e) => {
  const node = e.target.closest("[data-path]");
  if (!node) return;
  e.preventDefault();
  openMenu(e.clientX, e.clientY, node.dataset.path);
});

document.addEventListener("mousedown", (e) => {
  if ((e.target === $("stage") || e.target === $("items")) && !e.metaKey && !e.ctrlKey && !e.shiftKey)
    setSel([]);
});

document.addEventListener("keydown", (e) => {
  // Les raccourcis de la vue Fichiers ne s'appliquent qu'à elle.
  if (window.currentView && window.currentView !== "files") return;
  if (!$("viewer").classList.contains("hidden")) return;
  // Une sheet ouverte garde le clavier pour elle.
  if (document.querySelector(".modal:not(.hidden)")) return;
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName);
  const mod = e.metaKey || e.ctrlKey;
  // ⌘A sélectionne les fichiers ; ailleurs, la sélection native du menu Édition.
  if (mod && e.key.toLowerCase() === "a" && !typing) { e.preventDefault(); selectAll(); return; }
  // Sur macOS, les autres combinaisons sont des accélérateurs de la barre de menus.
  if (mod && IS_MAC) return;
  if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); pickFolder(); return; }
  if (mod && e.key.toLowerCase() === "r") { e.preventDefault(); refresh(); return; }
  if (mod && e.key === "1") { setView("grid"); return; }
  if (mod && e.key === "2") { setView("list"); return; }
  if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); $("search").focus(); $("search").select(); return; }
  if (e.key === "Escape") {
    if (typing) { $("search").blur(); return; }
    setSel([]);
    return;
  }
  if (typing) return;
  if (e.key.toLowerCase() === "v") {
    const p = [...state.sel][0];
    if (p) open3d(p);
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); askDelete(); return; }
  if (e.key === "Enter") {
    sendToSlicer(mod);   // ⌘⏎ ajoute au plateau
    return;
  }
  const cols = columns();
  if (e.key === "ArrowRight") { e.preventDefault(); moveSel(1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); moveSel(-1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); moveSel(cols); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-cols); }
});

$("stage").addEventListener("scroll", () => {
  const s = $("stage");
  if (s.scrollTop + s.clientHeight > s.scrollHeight - 600 && state.rendered < state.view_files.length)
    renderMore();
});

$("search").addEventListener("input", () => applyView());
const SORTS = [
  ["name", "Nom"],
  ["date", "Date de modification"],
  ["size", "Taille du fichier"],
  ["time", "Durée d'impression"],
  ["weight", "Poids de filament"],
  ["folder", "Dossier"],
];
$("btn-sort").addEventListener("click", (e) =>
  menuUnder(e.currentTarget, [
    ...SORTS.map(([k, label]) => ({ id: "sort:" + k, label, checked: state.sort === k })),
    {},
    { id: "order:asc", label: "Croissant", checked: state.asc },
    { id: "order:desc", label: "Décroissant", checked: !state.asc },
  ])
);
onMenu("sort", (k) => { state.sort = k; save(); applyView(); syncHead(); });
onMenu("order", (o) => { state.asc = o === "asc"; save(); applyView(); syncHead(); });
$("btn-add").addEventListener("click", (e) =>
  menuUnder(e.currentTarget, [
    { id: "files:open", label: "Ouvrir un dossier…", accel: "CmdOrCtrl+O" },
    { id: "files:refresh", label: "Actualiser", accel: "CmdOrCtrl+R", enabled: !!state.dir },
    {},
    { id: "files:reveal", label: "Afficher dans le Finder", enabled: !!state.dir },
  ])
);
onMenu("nav", (v) => switchView(v));
onMenu("view", (v) => { switchView("files"); setView(v); });
onMenu("edit", (what) => {
  if (what === "find" && window.currentView === "files") { $("search").focus(); $("search").select(); }
});
onMenu("files", (what) => {
  if (what === "open") { switchView("files"); pickFolder(); }
  // ⌘R recharge la page dans la Bibliothèque, le dossier ailleurs.
  if (what === "refresh") window.currentView === "library" ? libCmd("reload") : refresh();
  if (what === "reveal" && state.dir) invoke("reveal", { path: state.dir }).catch((e) => toast(String(e), true));
});
$("tile").addEventListener("input", () => {
  state.tile = +$("tile").value;
  document.documentElement.style.setProperty("--tile", state.tile + "px");
  save();
});
$("tile").addEventListener("change", () => applyView());
$("btn-open2").addEventListener("click", pickFolder);
$("btn-refresh").addEventListener("click", refresh);
$("view-grid").addEventListener("click", () => setView("grid"));
$("view-list").addEventListener("click", () => setView("list"));
function sendToSlicer(add) {
  const paths = [...state.sel];
  if (!paths.length) return;
  invoke("open_in_slicer", { paths, app: state.slicer || null, add })
    .then(() => {
      const n = paths.length;
      if (add) toast(n > 1 ? `${n} pièces ajoutées au plateau` : "Pièce ajoutée au plateau");
    })
    .catch((e) => toast(String(e), true));
}

$("act-open").addEventListener("click", () => sendToSlicer(false));
$("act-plate").addEventListener("click", () => sendToSlicer(true));
$("act-reveal").addEventListener("click", () => {
  const p = [...state.sel][0];
  if (p) invoke("reveal", { path: p }).catch((e) => toast(String(e), true));
});
$("act-delete").addEventListener("click", askDelete);
$("det-3d").addEventListener("click", () => {
  const p = [...state.sel][0];
  if (p) open3d(p);
});
$("det-img").addEventListener("click", () => {
  const p = [...state.sel][0];
  if (p) open3d(p);
});

/* Le visualiseur est défini dans viewer.js, chargé après ce fichier. */
function open3d(path) {
  const f = state.files.find((x) => x.path === path);
  if (f) openViewer(f.path, f.name, f.kind);
}
$("multi-delete").addEventListener("click", askDelete);
$("act-analyze").addEventListener("click", analyzeSelected);
$("selbar-all").addEventListener("click", selectAll);
$("selbar-none").addEventListener("click", () => setSel([]));
$("selbar-del").addEventListener("click", askDelete);

$("listhead").addEventListener("click", (e) => {
  const c = e.target.closest(".sortable");
  if (!c) return;
  const k = c.dataset.sort;
  if (state.sort === k) state.asc = !state.asc;
  else { state.sort = k; state.asc = true; }
  save();
  applyView();
  syncHead();
});

function syncHead() {
  $("listhead").querySelectorAll(".sortable").forEach((c) =>
    c.classList.toggle("on", c.dataset.sort === state.sort)
  );
}

function setView(v) {
  state.view = v;
  save();
  $("view-grid").classList.toggle("on", v === "grid");
  $("view-list").classList.toggle("on", v === "list");
  $("tile").style.display = v === "grid" ? "" : "none";
  renderReset();
}

/* réglages */
$("set-invert-wheel").addEventListener("change", () => {
  state.invertWheel = $("set-invert-wheel").checked;
  save();
});
$("set-wheel-action").addEventListener("change", () => {
  state.wheelAction = $("set-wheel-action").value;
  save();
});
$("set-wheel-speed").addEventListener("input", () => {
  state.wheelSpeed = +$("set-wheel-speed").value;
  $("set-wheel-speed-val").textContent = state.wheelSpeed.toFixed(1).replace(".", ",") + "×";
  save();
});
$("opt-slicer").addEventListener("change", () => {
  state.slicer = $("opt-slicer").value || null;
  save();
});

async function fillSlicers() {
  const list = await invoke("slicers_list");
  const sel = $("opt-slicer");
  sel.innerHTML =
    '<option value="">Application par défaut du système</option>' +
    list.map((s) => `<option value="${esc(s.path)}">${esc(s.name)}</option>`).join("");
  // Premier lancement : on retient le trancheur le mieux placé, Snapmaker Orca
  // en tête de la liste des applications reconnues.
  if (state.slicer === null && list.length) {
    state.slicer = list[0].path;
    save();
  }
  sel.value = state.slicer || "";
}

$("opt-recursive").addEventListener("change", () => {
  state.recursive = $("opt-recursive").checked;
  save();
  refresh();
});
$("opt-pref").addEventListener("change", () => {
  state.pref = +$("opt-pref").value;
  save();
  renderReset();
  updateDetails();
});
$("opt-clear").addEventListener("click", async () => {
  const n = await invoke("clear_cache");
  refreshCacheSize();
  toast(`${n} vignettes supprimées du cache`);
  renderReset();
});

function refreshCacheSize() {
  invoke("cache_info").then((c) => ($("cache-size").textContent = fmtSize(c.bytes)));
}


/* glisser-déposer d'un dossier */
listen("tauri://drag-enter", () => document.body.classList.add("dragover"));
listen("tauri://drag-leave", () => document.body.classList.remove("dragover"));
listen("tauri://drag-drop", (e) => {
  document.body.classList.remove("dragover");
  const p = e.payload?.paths?.[0];
  if (p) openDir(p.replace(/\/[^/]+\.3mf$/i, ""));
});

/* sélection au lasso dans la zone vide */
(() => {
  const stage = $("stage");
  const items = $("items");
  let box = null, sx = 0, sy = 0, base = null, active = false, rects = null;

  stage.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || (e.target !== stage && e.target !== items)) return;
    sx = e.clientX;
    sy = e.clientY;
    base = e.metaKey || e.ctrlKey || e.shiftKey ? new Set(state.sel) : new Set();
    active = true;
    rects = null;
  });

  addEventListener("mousemove", (e) => {
    if (!active) return;
    if (!box && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 5) return;
    if (!box) {
      box = document.createElement("div");
      box.className = "rubber";
      document.body.appendChild(box);
      // Les positions sont figées au début du geste : un seul calcul de mise en page.
      rects = [...state.nodes].map(([p, n]) => [p, n.getBoundingClientRect()]);
    }
    const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
    const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
    Object.assign(box.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    const sel = new Set(base);
    for (const [p, r] of rects) {
      if (r.left < x + w && r.right > x && r.top < y + h && r.bottom > y) sel.add(p);
    }
    if (sel.size !== state.sel.size || [...sel].some((p) => !state.sel.has(p))) setSel([...sel]);
  });

  addEventListener("mouseup", () => {
    active = false;
    if (box) {
      box.remove();
      box = null;
    }
  });
})();

/* largeur du panneau de détail */
(() => {
  const sp = $("splitter");
  let startX = 0, startW = 0, dragging = false;
  sp.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = $("details").offsetWidth;
    sp.classList.add("drag");
    e.preventDefault();
  });
  addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.min(Math.max(startW - (e.clientX - startX), 260), 560);
    $("details").style.width = w + "px";
    state.detailsWidth = w;
  });
  addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    sp.classList.remove("drag");
    save();
  });
})();

/* ------------------------------------------------------------ démarrage */

async function boot() {
  $("opt-recursive").checked = state.recursive;
  $("set-invert-wheel").checked = state.invertWheel;
  $("set-wheel-action").value = state.wheelAction;
  $("set-wheel-speed").value = state.wheelSpeed;
  $("set-wheel-speed-val").textContent = state.wheelSpeed.toFixed(1).replace(".", ",") + "×";
  $("opt-pref").value = String(state.pref);
  $("tile").value = state.tile;
  $("details").style.width = state.detailsWidth + "px";
  setView(state.view);
  syncHead();

  await fillSlicers();

  const places = await invoke("quick_places");
  $("places").innerHTML = "";
  for (const p of places) {
    const b = document.createElement("button");
    b.className = "place";
    b.textContent = p.label;
    b.title = p.path;
    b.onclick = () => openDir(p.path);
    $("places").appendChild(b);
  }

  const arg = await invoke("initial_dir");
  if (arg) state.dir = arg;

  renderRecents();
  updateStatus();
  if (state.dir) await refresh();
}

boot();
