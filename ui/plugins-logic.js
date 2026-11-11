"use strict";
/* Plugin API v1 (docs/plans/plugin-api-v1.md): the lifecycle of the
   plugins, what they may call (`ctx`) and the places they declare. No DOM
   here: the page's part (plugins.js) is the `host` given to plgCreate, and
   scripts/test-plugins.js gives a fake one.

   A plugin's script calls snapPlugin({ id, activate(ctx), deactivate() });
   in activate it registers what its contributions do: ctx.tab, ctx.action,
   ctx.schedule. Whatever it registered or set (tabs, actions, badges,
   schedules, listeners) goes when it is deactivated: the app removes it. */

/* Host calls and the permission each needs (none: always allowed). */
const PLG_NEEDS = {
  "printer.maintenance": "printer.read",
  "printer.bed": "printer.read",
  "storage.get": "storage",
  "storage.set": "storage",
  "open.url": "open.url",
};
const PLG_EVENTS = ["change", "bed", "lang"];

/* "1h", "30m" → milliseconds; null below 5 minutes or unreadable. */
function plgEvery(s) {
  const m = /^(\d+)\s*(m|h)$/.exec(String(s || "").trim());
  if (!m) return null;
  const ms = +m[1] * (m[2] === "h" ? 3600e3 : 60e3);
  return ms >= 5 * 60e3 ? ms : null;
}

function plgCreate(host) {
  const plugins = new Map(); // id → { id, dir, manifest, state, error, def, own }
  let printersKnown = false;
  let loads = 0;

  const log = (id, msg) => host.log(`[plugin ${id}] ${msg}`);
  const declared = (p, kind) => p.manifest.contributes?.[kind] || [];

  function fresh() {
    return { tabs: new Map(), actions: new Map(), schedules: new Map(), timers: [], listeners: [], badges: false };
  }

  /* What the plugin's `activate` receives. Every call is checked against
     the manifest's permissions; a call without it is refused and logged. */
  function ctxFor(p) {
    const perms = new Set(p.manifest.permissions || []);
    const live = () => p.state === "activated" || p.state === "activating";
    const call = (name, ...args) => {
      const need = PLG_NEEDS[name];
      if (need && !perms.has(need)) {
        log(p.id, `refused: ${name} needs the permission ${need}`);
        return Promise.reject(new Error(`permission ${need} not declared`));
      }
      if (!live()) return Promise.reject(new Error("plugin not active"));
      return Promise.resolve().then(() => host.call(name, p.id, ...args));
    };
    const register = (kind, map) => (id, value) => {
      if (!declared(p, kind).some((c) => c.id === id)) throw new Error(`${kind} ${id} is not declared in plugin.json`);
      map.set(id, value);
    };
    const on = (event, fn) => {
      if (!PLG_EVENTS.includes(event)) throw new Error(`unknown event ${event}`);
      p.own.listeners.push({ event, fn });
    };
    return {
      plugin: { id: p.id, version: p.manifest.version },
      printers: {
        list: () => call("printers.list"),
        current: () => call("printers.current"),
        on: (event, fn) => on(event === "change" ? "change" : event, fn),
      },
      printer: {
        maintenance: (id) => call("printer.maintenance", id),
        bed: (id) => call("printer.bed", id),
      },
      storage: {
        get: (key) => call("storage.get", key),
        set: (key, value) => call("storage.set", key, value),
      },
      open: { url: (url) => call("open.url", url) },
      i18n: {
        t: (key, vars) => host.t(key, vars),
        num: (n, opts) => host.num(n, opts),
        dec: (n, digits) => host.dec(n, digits),
        locale: () => host.locale(),
        on: (event, fn) => on(event === "change" ? "lang" : event, fn),
      },
      ui: {
        toast: (text, error = false, action = null) => live() && host.toast(text, error, action),
        badge: (printerId, b) => {
          if (!live()) return;
          const where = p.manifest.contributes?.badges || [];
          if (!where.length) return log(p.id, "refused: badge without a badges contribution");
          p.own.badges = true;
          host.badge(`plugin:${p.id}`, printerId, b && b.n ? { n: b.n, tip: b.tip || "" } : null, where, declared(p, "tabs")[0]?.id);
        },
        showTab: (printerId, tab) => live() && host.showTab(printerId, tab),
        offline: (text, attr) => host.offline(text, attr),
      },
      tab: register("tabs", p.own.tabs),
      action: register("actions", p.own.actions),
      schedule: register("schedules", p.own.schedules),
    };
  }

  function runSchedule(p, id) {
    const fn = p.own.schedules.get(id);
    if (!fn || p.state !== "activated") return;
    Promise.resolve()
      .then(fn)
      .catch((e) => log(p.id, `schedule ${id}: ${e?.message || e}`));
  }

  async function activate(id) {
    const p = plugins.get(id);
    if (!p || !p.manifest || p.state === "activated") return false;
    p.own = fresh();
    p.state = "activating";
    try {
      if (!p.def) {
        await host.loadScript(p, ++loads);
        if (!p.def) throw new Error(`${p.manifest.entry} did not call snapPlugin`);
      }
      await p.def.activate(ctxFor(p));
    } catch (e) {
      p.state = "failed";
      p.error = String(e?.message || e);
      log(p.id, `not activated: ${p.error}`);
      undo(p);
      return false;
    }
    p.state = "activated";
    for (const t of declared(p, "tabs")) {
      if (p.own.tabs.has(t.id)) host.addTab(p.id, t, p.own.tabs.get(t.id));
      else log(p.id, `tab ${t.id} declared but not registered`);
    }
    for (const a of declared(p, "actions")) {
      if (p.own.actions.has(a.id)) host.addAction(p.id, a, () => Promise.resolve().then(p.own.actions.get(a.id)).catch((e) => log(p.id, `action ${a.id}: ${e?.message || e}`)));
    }
    for (const s of declared(p, "schedules")) {
      if (!p.own.schedules.has(s.id)) continue;
      const every = s.every != null ? plgEvery(s.every) : null;
      if (s.every != null && every == null) log(p.id, `schedule ${s.id}: "every" must be 5m or more`);
      if (every) p.own.timers.push(host.setInterval(() => runSchedule(p, s.id), every));
      if (s.atStart && printersKnown) runSchedule(p, s.id);
    }
    return true;
  }

  /* Everything the plugin added goes, whatever its own deactivate does. */
  function undo(p) {
    const own = p.own || fresh();
    for (const t of own.timers) host.clearInterval(t);
    for (const t of declared(p, "tabs")) if (own.tabs.has(t.id)) host.removeTab(p.id, t);
    for (const a of declared(p, "actions")) if (own.actions.has(a.id)) host.removeAction(p.id, a);
    if (own.badges) host.clearBadges(`plugin:${p.id}`);
    p.own = fresh();
  }

  async function deactivate(id) {
    const p = plugins.get(id);
    if (!p || p.state !== "activated") return false;
    p.state = "deactivating";
    try {
      await p.def?.deactivate?.();
    } catch (e) {
      log(p.id, `deactivate: ${e?.message || e}`);
    }
    undo(p);
    p.state = "deactivated";
    return true;
  }

  return {
    plugins,

    /* The built-ins as the app found them ([{ id, dir, manifest, error }],
       manifests checked by plugins.rs): found → checked → activated. */
    async load(found) {
      for (const f of found) {
        const p = { id: f.id, dir: f.dir, manifest: f.manifest, state: f.manifest ? "checked" : "failed", error: f.error || null, def: null, own: fresh() };
        plugins.set(f.id, p);
        if (!f.manifest) log(f.id, `off: ${f.error}`);
      }
      for (const p of plugins.values()) if (p.state === "checked") await activate(p.id);
    },

    /* Called by the plugin's script. */
    register(def) {
      const p = def && plugins.get(def.id);
      if (!p || typeof def.activate !== "function") return host.log(`[plugin] snapPlugin: unknown or invalid ${def?.id}`);
      p.def = def;
    },

    activate,
    deactivate,

    /* Deactivate, a fresh copy of its script, activate. */
    async reload(id) {
      const p = plugins.get(id);
      if (!p) return false;
      await deactivate(id);
      host.unloadScript?.(p);
      p.def = null;
      return activate(id);
    },

    /* The app knows its printers: schedules "at start" run, once. */
    printersKnown() {
      const first = !printersKnown;
      printersKnown = true;
      if (first) for (const p of plugins.values()) for (const s of declared(p, "schedules")) if (s.atStart) runSchedule(p, s.id);
    },

    /* An event to the active plugins: "change" (printers), "bed" (a
       printer's bed mesh), "lang". */
    emit(event, ...args) {
      for (const p of plugins.values()) {
        if (p.state !== "activated") continue;
        for (const l of p.own.listeners) {
          if (l.event !== event) continue;
          try {
            Promise.resolve(l.fn(...args)).catch((e) => log(p.id, `${event}: ${e?.message || e}`));
          } catch (e) {
            log(p.id, `${event}: ${e?.message || e}`);
          }
        }
      }
    },

    /* Snappy's "open" contributions: { plugin, tab } for an action name. */
    snappy(name) {
      for (const p of plugins.values()) {
        if (p.state !== "activated") continue;
        const s = declared(p, "snappy").find((x) => x.id === name);
        if (s && p.own.tabs.has(s.opens)) return { plugin: p.id, tab: s.opens };
      }
      return null;
    },
  };
}

if (typeof module !== "undefined") module.exports = { plgCreate, plgEvery, PLG_NEEDS };
