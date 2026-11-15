// node scripts/test-plugins.js — plugin API v1: lifecycle, permissions, contributions, cleanup.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { plgCreate, plgEvery, PLG_NEEDS } = require("../ui/plugins-logic.js");

(async () => {
  // Intervals: "1h", "30m"; under 5 minutes or unreadable: none.
  assert.equal(plgEvery("1h"), 3600e3);
  assert.equal(plgEvery("30m"), 1800e3);
  assert.equal(plgEvery("5m"), 300e3);
  assert.equal(plgEvery("4m"), null);
  assert.equal(plgEvery("1d"), null);
  assert.equal(plgEvery(""), null);
  assert.deepEqual(Object.values(PLG_NEEDS).sort(), ["open.url", "printer.read", "printer.read", "storage", "storage"]);

  /* A fake page: records what the plugins add; `scripts` are their files. */
  function fakeHost(scripts) {
    const h = {
      logs: [], calls: [], tabs: new Map(), actions: new Map(), badges: new Map(), timers: new Map(), toasts: [], n: 0,
      log: (m) => h.logs.push(m),
      t: (k) => k, num: String, dec: (n, d) => n.toFixed(d), locale: () => "en",
      toast: (text, error, action) => h.toasts.push({ text, error, action }),
      offline: (text) => `<off>${text}</off>`,
      badge: (source, pid, b, where, tab) => (b ? h.badges.set(`${source}/${pid}`, { ...b, where, tab }) : h.badges.delete(`${source}/${pid}`)),
      clearBadges: (source) => [...h.badges.keys()].filter((k) => k.startsWith(source + "/")).forEach((k) => h.badges.delete(k)),
      showTab: () => {},
      setInterval: (fn, ms) => (h.timers.set(++h.n, { fn, ms }), h.n),
      clearInterval: (t) => h.timers.delete(t),
      async call(name, plugin, ...a) {
        h.calls.push([name, plugin, ...a]);
        if (name === "printers.list") return [{ id: "p1", name: "U1" }];
        return { name, a };
      },
      addTab: (plugin, decl, handlers) => h.tabs.set(`${plugin}:${decl.id}`, handlers),
      removeTab: (plugin, decl) => h.tabs.delete(`${plugin}:${decl.id}`),
      addAction: (plugin, decl, run) => h.actions.set(`${plugin}:${decl.id}`, run),
      removeAction: (plugin, decl) => h.actions.delete(`${plugin}:${decl.id}`),
      loads: 0,
      loadScript(p) {
        h.loads++;
        const s = scripts[p.id];
        if (s) s(PLG.register);
        return Promise.resolve();
      },
    };
    let PLG;
    h.bind = (plg) => (PLG = plg);
    return h;
  }
  const manifest = (over = {}) => ({
    id: "test.demo", api: 1, version: "1.0.0", name: "Demo", kind: "builtin", entry: "main.js",
    permissions: ["storage"],
    contributes: {
      tabs: [{ id: "demo", page: "maint", title: "demo.title" }],
      actions: [{ id: "go", where: "toolbar", page: "maint", tab: "demo", title: "demo.go", icon: "refresh" }],
      badges: ["tab", "printer"],
      schedules: [{ id: "check", every: "1h", atStart: true }],
      snappy: [{ id: "demo", opens: "demo" }],
    },
    ...over,
  });
  const setup = (scripts, found) => {
    const host = fakeHost(scripts);
    const PLG = plgCreate(host);
    host.bind(PLG);
    return { host, PLG, load: () => PLG.load(found) };
  };

  // A plugin that does everything its manifest declares.
  const seen = { activate: 0, deactivate: 0, check: 0, go: 0, lang: 0, ctx: null };
  const demo = (register) =>
    register({
      id: "test.demo",
      async activate(ctx) {
        seen.activate++;
        seen.ctx = ctx;
        ctx.tab("demo", { show() {}, hide() {} });
        ctx.action("go", () => seen.go++);
        ctx.schedule("check", () => seen.check++);
        ctx.i18n.on("change", () => seen.lang++);
        ctx.ui.badge("p1", { n: 2, tip: "two" });
      },
      deactivate: () => seen.deactivate++,
    });
  {
    const { host, PLG, load } = setup({ "test.demo": demo }, [{ id: "test.demo", dir: "demo", manifest: manifest() }]);
    await load();
    const p = PLG.plugins.get("test.demo");
    assert.equal(p.state, "activated");
    assert.equal(seen.activate, 1);
    assert.ok(host.tabs.has("test.demo:demo"), "its tab is shown");
    assert.ok(host.actions.has("test.demo:go"), "its action is shown");
    assert.deepEqual(host.badges.get("plugin:test.demo/p1"), { n: 2, tip: "two", where: ["tab", "printer"], tab: "demo" });
    assert.equal(host.timers.size, 1);
    assert.equal([...host.timers.values()][0].ms, 3600e3);
    // "At start" waits for the printers, then runs once.
    assert.equal(seen.check, 0);
    PLG.printersKnown();
    PLG.printersKnown();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(seen.check, 1, "at start, once");
    [...host.timers.values()][0].fn();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(seen.check, 2, "then on its interval");
    await host.actions.get("test.demo:go")();
    assert.equal(seen.go, 1);
    PLG.emit("lang");
    assert.equal(seen.lang, 1);
    assert.deepEqual(PLG.snappy("demo"), { plugin: "test.demo", tab: "demo" });
    assert.equal(PLG.snappy("nope"), null);

    // Permissions: storage declared, open.url and printer.read not.
    assert.deepEqual(await seen.ctx.storage.get("k"), { name: "storage.get", a: ["k"] });
    assert.deepEqual(host.calls.at(-1), ["storage.get", "test.demo", "k"], "called as the plugin");
    await assert.rejects(seen.ctx.open.url("https://x"), /permission open.url/);
    await assert.rejects(seen.ctx.printer.maintenance("p1"), /permission printer.read/);
    assert.ok(host.logs.some((l) => /refused: open.url/.test(l)), "a refusal is logged");
    assert.ok(!host.calls.some((c) => c[0] === "open.url"), "and never reaches the app");
    // Always allowed.
    assert.deepEqual(await seen.ctx.printers.list(), [{ id: "p1", name: "U1" }]);
    // Undeclared contributions and events.
    assert.throws(() => seen.ctx.tab("other", {}), /not declared/);
    assert.throws(() => seen.ctx.schedule("other", () => {}), /not declared/);
    assert.throws(() => seen.ctx.printers.on("nope", () => {}), /unknown event/);

    // Deactivated: everything it added goes.
    assert.equal(await PLG.deactivate("test.demo"), true);
    assert.equal(p.state, "deactivated");
    assert.equal(seen.deactivate, 1);
    assert.equal(host.tabs.size + host.actions.size + host.timers.size + host.badges.size, 0);
    await assert.rejects(seen.ctx.storage.get("k"), /not active/);
    seen.ctx.ui.badge("p1", { n: 1 });
    assert.equal(host.badges.size, 0, "no badge once off");
    PLG.emit("lang");
    assert.equal(seen.lang, 1, "no events once off");
    assert.equal(PLG.snappy("demo"), null);

    // Reload: a fresh copy of its script, activated again.
    const loads = host.loads;
    assert.equal(await PLG.reload("test.demo"), true);
    assert.equal(host.loads, loads + 1);
    assert.equal(seen.activate, 2);
    assert.equal(p.state, "activated");
    assert.equal(host.tabs.size, 1);
    assert.equal(host.timers.size, 1, "one timer, not two");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(seen.check, 3, "at start again: the printers are known");
  }

  // A plugin whose activate throws: failed, and what it added is gone.
  {
    const bad = (register) =>
      register({
        id: "test.demo",
        activate(ctx) {
          ctx.tab("demo", {});
          ctx.ui.badge("p1", { n: 1 });
          throw new Error("boom");
        },
      });
    const { host, PLG, load } = setup({ "test.demo": bad }, [{ id: "test.demo", dir: "demo", manifest: manifest() }]);
    await load();
    const p = PLG.plugins.get("test.demo");
    assert.equal(p.state, "failed");
    assert.equal(p.error, "boom");
    assert.equal(host.tabs.size + host.badges.size + host.timers.size, 0);
  }

  // A script that never calls snapPlugin; a manifest the app refused; badges undeclared.
  {
    const quiet = (register) =>
      register({ id: "test.quiet", activate(ctx) { ctx.ui.badge("p1", { n: 1 }); } });
    const { host, PLG, load } = setup({ "test.silent": () => {}, "test.quiet": quiet }, [
      { id: "test.silent", dir: "s", manifest: manifest({ id: "test.silent" }) },
      { id: "test.off", dir: "o", manifest: null, error: "api 2 not supported" },
      { id: "test.quiet", dir: "q", manifest: manifest({ id: "test.quiet", contributes: {} }) },
    ]);
    await load();
    assert.equal(PLG.plugins.get("test.silent").state, "failed");
    assert.match(PLG.plugins.get("test.silent").error, /did not call snapPlugin/);
    assert.equal(PLG.plugins.get("test.off").state, "failed");
    assert.ok(host.logs.some((l) => /test.off.*api 2/.test(l)));
    assert.equal(PLG.plugins.get("test.quiet").state, "activated");
    assert.equal(host.badges.size, 0, "a badge needs a badges contribution");
    // snapPlugin for an id the app did not find.
    PLG.register({ id: "test.unknown", activate() {} });
    assert.ok(host.logs.some((l) => /unknown or invalid test.unknown/.test(l)));
  }

  // The built-ins reach the app through ctx only: no page, no app calls.
  const dir = path.join(__dirname, "..", "ui", "plugins");
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".js") && files.push(path.join(d, e.name))));
  walk(dir);
  assert.ok(files.length, "built-in plugins found");
  for (const f of files) {
    const code = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const word of ["invoke", "document", "window", "localStorage", "sessionStorage", "fetch", "XMLHttpRequest", "__TAURI", "eval", "Function("]) {
      assert.ok(!new RegExp(`\\b${word.replace("(", "\\(")}`).test(code), `${path.relative(dir, f)} uses ${word}`);
    }
  }
  // Each built-in in the index has a manifest naming its entry.
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  for (const b of index.builtin) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, b.dir, "plugin.json"), "utf8"));
    assert.equal(m.id, b.id);
    assert.ok(fs.existsSync(path.join(dir, b.dir, m.entry)), `${b.id}: ${m.entry}`);
  }

  console.log("plugins: ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
