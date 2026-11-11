// node scripts/test-care.js — the Care plugin: what is due, its log, its badge.
const assert = require("assert");
const care = require("../ui/plugins/care/main.js");
const { plgCreate } = require("../ui/plugins-logic.js");
const manifest = require("../ui/plugins/care/plugin.json");
const { TASKS, progress, stateOf, dueCount, entry } = care.logic;
const task = (id) => TASKS.find((t) => t.id === id);

const DAY = 86400;
const now = 1_800_000_000;
const usage = (o = {}) => ({
  print_hours: 120, jobs: 40, filament_m: 900, longest_print_hours: 5.5, purifier_hours: 0,
  heads: [0, 1, 2, 3].map((index) => ({ index, switch_count: 5000, last_maintenance_count: 0, error_count: 0, retry_count: 0 })),
  ...o,
});

// States.
assert.deepEqual([stateOf(0.5), stateOf(0.8), stateOf(1), stateOf(3)], ["ok", "soon", "due", "due"]);

// Never done: the plate (50 h) is overdue at 120 h, the nozzles (100 h) too.
let pr = progress(task("plate"), usage(), [], now);
assert.equal(pr.unit, "hours");
assert.equal(pr.left, -70);
assert.equal(pr.last, null);
assert.equal(progress(task("nozzles"), usage(), [], now).left, -20);
// Tool changes: the head with most since its last count; the printer's own reset counts.
pr = progress(task("contacts"), usage({ heads: [{ index: 0, switch_count: 90000, last_maintenance_count: 10000 }, { index: 1, switch_count: 30000, last_maintenance_count: 0 }] }), [], now);
assert.equal(pr.unit, "swaps");
assert.equal(pr.left, 20000);
// Not a U1 (no heads): no tool change tasks.
assert.equal(progress(task("contacts"), usage({ heads: [] }), [], now), null);
assert.equal(dueCount(usage({ heads: [] }), [], now), 2, "plate and nozzles");

// Done: counts from then. The log entry keeps the counters then.
const e = entry("plate", usage(), now - 10 * DAY);
assert.deepEqual(e, { task: "plate", at: now - 10 * DAY, print_hours: 120, swaps: [5000, 5000, 5000, 5000] });
pr = progress(task("plate"), usage({ print_hours: 160 }), [e], now);
assert.equal(pr.left, 10);
assert.equal(pr.last, e);
assert.equal(stateOf(pr.ratio), "soon");
// The newest entry counts, whatever the log's order.
const older = entry("plate", usage({ print_hours: 20 }), now - 100 * DAY);
assert.equal(progress(task("plate"), usage({ print_hours: 160 }), [e, older], now).last, e);
// Months: the rails, done 7 months ago with few hours since, are due by time.
const rails = entry("rails", usage(), now - 7 * 30.44 * DAY);
pr = progress(task("rails"), usage({ print_hours: 130 }), [rails], now);
assert.equal(pr.unit, "months");
assert.equal(pr.left, -1);
// Contacts done: from the swaps then, per head.
const c = { ...entry("contacts", usage(), now), swaps: [5000, 4000, 5000, 5000] };
assert.equal(progress(task("contacts"), usage(), [c], now).left, 99000);

/* The plugin, as the app runs it: a fake page with a store. */
(async () => {
  const store = { log: { p1: [entry("plate", usage(), now)] } };
  const badges = new Map();
  const state = { usage: usage(), bed: null, offline: false };
  const host = {
    log: (m) => { throw new Error(m); },
    t: (k, v) => (v ? `${k} ${JSON.stringify(v)}` : k), num: String, dec: (n, d) => n.toFixed(d), locale: () => "en",
    toast() {}, offline: (t) => t, showTab() {},
    badge: (source, pid, b) => (b ? badges.set(pid, b) : badges.delete(pid)),
    clearBadges: () => badges.clear(),
    setInterval: () => 1, clearInterval() {},
    addTab() {}, removeTab() {}, addAction() {}, removeAction() {},
    loadScript: () => Promise.resolve(PLG.register(care)),
    async call(name, plugin, ...a) {
      assert.equal(plugin, "snapstudio.care");
      switch (name) {
        case "printers.list": return [{ id: "p1", name: "U1" }, { id: "p2", name: "U1 bis" }];
        case "printer.maintenance":
          if (state.offline || a[0] === "p2") throw new Error("no answer");
          return state.usage;
        case "printer.bed": return state.bed;
        case "storage.get": return store[a[0]] == null ? null : JSON.parse(JSON.stringify(store[a[0]]));
        case "storage.set": store[a[0]] = a[1]; return null;
      }
      throw new Error(name);
    },
  };
  const PLG = plgCreate(host);
  await PLG.load([{ id: manifest.id, dir: "care", manifest }]);
  assert.equal(PLG.plugins.get("snapstudio.care").state, "activated");
  assert.deepEqual(PLG.snappy("maintenance"), { plugin: "snapstudio.care", tab: "care" });

  const tick = () => new Promise((r) => setTimeout(r, 10));
  PLG.printersKnown();
  await tick();
  // p1: plate done now at 120 h, nozzles never (100 h): one task due.
  assert.equal(badges.get("p1").n, 1);
  assert.match(badges.get("p1").tip, /maint.due_n/);
  assert.ok(!badges.has("p2"), "p2 never answered: nothing known");
  // Its counters are kept for when it does not answer.
  assert.equal(store.cache.p1.usage.print_hours, 120);
  assert.equal(store.log.p1.length, 1, "the log is never rewritten by a check");

  // The bed asks: Care counts it (+1).
  state.bed = { due: { kind: "out", dev: 1.2, at: now, limit: 1, remind: null }, meshes: [] };
  PLG.emit("bed", "p1");
  await tick();
  assert.equal(badges.get("p1").n, 2);
  state.bed = null;
  PLG.emit("bed", "p1");
  await tick();
  assert.equal(badges.get("p1").n, 1);

  // Offline: the last counters still count.
  state.offline = true;
  state.usage = usage({ print_hours: 500 });
  await PLG.deactivate("snapstudio.care");
  assert.equal(badges.size, 0, "off: its badges go");
  await PLG.activate("snapstudio.care");
  PLG.printersKnown(); // already known: activate ran "at start"
  await tick();
  assert.equal(badges.get("p1").n, 1, "from the cache");

  // Two printers read at once (the hourly check): neither one's counters
  // nor a task marked meanwhile are lost, whatever the store's delays.
  {
    const store2 = {};
    const slow = () => new Promise((r) => setTimeout(r, Math.random() * 5));
    const host2 = {
      ...host,
      badge() {},
      loadScript: () => Promise.resolve(PLG2.register(care)),
      async call(name, plugin, ...a) {
        await slow();
        switch (name) {
          case "printers.list": return [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
          case "printer.maintenance": return usage();
          case "printer.bed": return null;
          case "storage.get": { const v = store2[a[0]]; await slow(); return v == null ? null : JSON.parse(JSON.stringify(v)); }
          case "storage.set": await slow(); store2[a[0]] = a[1]; return null;
        }
        throw new Error(name);
      },
    };
    const PLG2 = plgCreate(host2);
    await PLG2.load([{ id: manifest.id, dir: "care", manifest }]);
    PLG2.printersKnown();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(Object.keys(store2.cache).sort(), ["a", "b", "c"], "every printer's counters kept");
  }

  console.log("care: ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
