"use strict";
/* The app's side of the plugins (plugins-logic.js has the lifecycle):
   where their tabs, toolbar actions and badges are drawn, what their host
   calls do, and the built-ins loaded at start (manifests checked by
   plugins.rs). v1: built-ins only, run in the main document; the files in
   ui/plugins/ reach the app through `ctx` alone (scripts/test-plugins.js
   checks it), so they can move to a sandbox later. */

const PLG_ICONS = {
  refresh: '<svg viewBox="0 0 24 24"><path d="M12 5a7 7 0 1 0 6.7 9h-2.1A5 5 0 1 1 12 7v3l4.5-4L12 2z"/></svg>',
};

/* Badges: source ("plugin:<id>", "bed") → printer id → { n, tip, where, tab }.
   The side list's dot sums the badges shown on the printer; a tab's ⚠
   shows the badges of that tab. */
const BADGES = new Map();

function appBadge(source, pid, b, where = ["tab", "printer"], tab = null) {
  if (!BADGES.has(source)) BADGES.set(source, new Map());
  if (b && b.n) BADGES.get(source).set(pid, { n: b.n, tip: b.tip || "", where, tab });
  else BADGES.get(source).delete(pid);
  if (typeof mtSideDots === "function") mtSideDots();
}

function appBadgesOf(pid, where, tab = null) {
  const out = [];
  for (const m of BADGES.values()) {
    const b = m.get(pid);
    if (b && b.where.includes(where) && (tab == null || b.tab === tab)) out.push(b);
  }
  return out;
}

/* The page that holds plugin tabs (v1: Care & Tuning). */
const PLG_PAGES = {
  maint: { tabs: () => $("mt-tabs"), boxes: () => document.querySelector("#view-maint .prn"), toolbar: () => $("mt-refresh") },
};

/* Plugin tabs and actions shown: "<plugin>:<tab>" → { plugin, decl, handlers, btn, box }. */
const PLG_TABS = new Map();
const PLG_ACTIONS = new Map();

/* The tabs of a page given by plugins, in order. */
const plgTabs = (page) => [...PLG_TABS.values()].filter((t) => t.decl.page === page).sort((a, b) => (a.decl.order ?? 100) - (b.decl.order ?? 100));
const plgTab = (page, id) => plgTabs(page).find((t) => t.decl.id === id) || null;
/* The toolbar actions of a page's tab. */
const plgActionsOf = (page, tab) => [...PLG_ACTIONS.values()].filter((a) => a.decl.page === page && (a.decl.tab == null || a.decl.tab === tab));

const plgHost = {
  log: (msg) => console.warn(msg),
  t: (key, vars) => tr(key, vars),
  num: (n, opts) => fmtNum(n, opts),
  dec: (n, d) => fmtDec(n, d),
  locale: () => locale(),
  toast: (text, error, action) => toast(String(text), !!error, action && { label: String(action.label), run: action.run }),
  offline: (text, attr) => offlineLine(text, /^data-[a-z-]+$/.test(attr || "") ? attr : "data-plg-retry"),
  badge: (source, pid, b, where, tab) => appBadge(source, pid, b, where, tab),
  clearBadges: (source) => {
    BADGES.delete(source);
    if (typeof mtSideDots === "function") mtSideDots();
  },
  showTab: (pid, tab) => maintShow(pid, tab),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),

  async call(name, plugin, ...a) {
    const printer = (id) => {
      const p = P.list.find((x) => x.id === id);
      if (!p) throw new Error(`no printer ${id}`);
      return p;
    };
    switch (name) {
      case "printers.list":
        return P.list.map((p) => ({ id: p.id, name: p.name || p.host, model: p.model || "" }));
      case "printers.current":
        return window.currentView === "maint" ? MT.pid : P.sel;
      case "printer.maintenance": {
        const p = printer(a[0]);
        return invoke("printer_maintenance", { host: p.host, port: p.port });
      }
      case "printer.bed":
        printer(a[0]);
        return mtBedInfo(a[0]);
      case "storage.get":
        return invoke("plugin_storage_get", { plugin, key: String(a[0]) });
      case "storage.set":
        return invoke("plugin_storage_set", { plugin, key: String(a[0]), value: a[1] ?? null });
      case "open.url": {
        const url = String(a[0]);
        if (!/^https:\/\//.test(url)) throw new Error("only https links open");
        return invoke("plugin:opener|open_url", { url });
      }
    }
    throw new Error(`unknown call ${name}`);
  },

  /* A tab button among the page's (by `order`), and its empty box. */
  addTab(plugin, decl, handlers) {
    const page = PLG_PAGES[decl.page];
    if (!page) return console.warn(`[plugin ${plugin}] no page ${decl.page}`);
    const key = `${plugin}:${decl.id}`;
    const order = decl.order ?? 100;
    const btn = document.createElement("button");
    btn.className = "seg-btn labeled";
    btn.dataset.mtab = decl.id;
    btn.dataset.order = order;
    btn.innerHTML = `<span></span><span class="tab-warn hidden" aria-hidden="true">⚠</span>`;
    btn.firstChild.textContent = tr(decl.title);
    const next = [...page.tabs().querySelectorAll("[data-mtab]")].find((b) => +(b.dataset.order ?? 100) > order);
    page.tabs().insertBefore(btn, next || null);
    const box = document.createElement("section");
    box.className = "prn-main hv hidden";
    box.dataset.plugin = plugin;
    box.dataset.tab = decl.id;
    page.boxes().appendChild(box);
    PLG_TABS.set(key, { plugin, decl, handlers, btn, box, shown: false });
    if (window.currentView === decl.page && typeof mtSetTab === "function" && MT.pid) mtSetTab(MT.tab);
  },

  removeTab(plugin, decl) {
    const key = `${plugin}:${decl.id}`;
    const t = PLG_TABS.get(key);
    if (!t) return;
    PLG_TABS.delete(key);
    t.btn.remove();
    t.box.remove();
    if (window.currentView === decl.page && MT.tab === decl.id && typeof mtSetTab === "function") mtSetTab(mtDefaultTab());
  },

  /* A toolbar button, before the page's own; shown on its tab only. */
  addAction(plugin, decl, run) {
    const page = PLG_PAGES[decl.page];
    if (!page || decl.where !== "toolbar") return console.warn(`[plugin ${plugin}] action ${decl.id}: only page toolbars in v1`);
    const b = document.createElement("button");
    b.className = "tb-btn hidden";
    b.dataset.plugin = plugin;
    b.dataset.icon = decl.icon || "";
    b.title = tr(decl.title);
    b.innerHTML = PLG_ICONS[decl.icon] || "";
    if (!b.innerHTML) b.textContent = tr(decl.title);
    b.onclick = () => run(MT.pid);
    page.toolbar().before(b);
    PLG_ACTIONS.set(`${plugin}:${decl.id}`, { plugin, decl, btn: b });
    if (window.currentView === decl.page && typeof mtSetTab === "function" && MT.pid) mtSetTab(MT.tab);
  },

  removeAction(plugin, decl) {
    const a = PLG_ACTIONS.get(`${plugin}:${decl.id}`);
    if (!a) return;
    PLG_ACTIONS.delete(`${plugin}:${decl.id}`);
    a.btn.remove();
    if (window.currentView === decl.page && typeof mtSetTab === "function" && MT.pid) mtSetTab(MT.tab);
  },

  /* The plugin's script; `n` makes a reload take a fresh copy. */
  loadScript(p, n) {
    return new Promise((resolve, reject) => {
      document.querySelector(`script[data-plugin="${CSS.escape(p.id)}"]`)?.remove();
      const s = document.createElement("script");
      s.src = `plugins/${p.dir}/${p.manifest.entry}?v=${n}`;
      s.dataset.plugin = p.id;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`${p.manifest.entry} could not be loaded`));
      document.body.appendChild(s);
    });
  },
  unloadScript(p) {
    document.querySelector(`script[data-plugin="${CSS.escape(p.id)}"]`)?.remove();
  },
};

const PLG = plgCreate(plgHost);
/* What a plugin's script calls. */
const snapPlugin = (def) => PLG.register(def);

/* The last counters Care read, kept by versions before plugins in the
   page's storage: into its store, once. */
async function plgImportCare() {
  try {
    if ((await invoke("plugin_storage_get", { plugin: "snapstudio.care", key: "cache" })) != null) return;
    const cache = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith("snapstudio.maint.")) continue;
      try {
        const c = JSON.parse(localStorage.getItem(k));
        if (c?.usage) cache[k.slice("snapstudio.maint.".length)] = c;
      } catch {}
    }
    await invoke("plugin_storage_set", { plugin: "snapstudio.care", key: "cache", value: cache });
  } catch (e) {
    console.warn("[plugin snapstudio.care] cache not imported", e);
  }
}

async function plgBoot() {
  const found = await invoke("plugins_list").catch((e) => {
    console.warn("[plugin] list", e);
    return [];
  });
  if (found.some((f) => f.id === "snapstudio.care" && f.manifest)) await plgImportCare();
  await PLG.load(found);
}

window.addEventListener("langchange", () => {
  for (const t of PLG_TABS.values()) t.btn.firstChild.textContent = tr(t.decl.title);
  for (const a of PLG_ACTIONS.values()) a.btn.title = tr(a.decl.title);
  PLG.emit("lang");
});

plgBoot();
