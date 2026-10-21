// node scripts/test-control.js — Care & Tuning › Control: what the interface allows, and why not.
const assert = require("assert");
const C = require("../ui/control-logic.js");

// A U1 as control.rs reads it.
const cfg = {
  heads: [0, 1, 2, 3].map((index) => ({ index, max_temp: 300, min_extrude_temp: 170 })),
  bed_max: 100, min: [0, 0, -6], max: [271, 335, 275],
  chamber_fan: true, light: true, purifier: true, u1: true,
};
const idle = {
  state: "standby", main_state: "IDLE", progress: 0, homed: "xyz", position: [135, 135, 10], active: 1,
  heads: [{ index: 0, temp: 24, target: 0 }, { index: 1, temp: 210, target: 210 }, { index: 2, temp: 23, target: 0 }, { index: 3, temp: 23, target: 0 }],
  bed: { temp: 58, target: 60 }, part_fan: 0.5, chamber_fan: 0.2, light: true, purifier: false, idle: "Ready",
};
const why = (kind, st = idle, o = {}) => C.ctlWhy(kind, st, cfg, o);

// Idle and homed: everything can run.
for (const k of ["home", "heaters_off", "motors_off", "firmware_restart", "clean", "purge_position", "light", "purifier", "chamber_fan", "bed_temp", "part_fan"]) assert.equal(why(k), "", k);
assert.equal(why("jog", idle, { axis: "x", dist: 10 }), "");
assert.equal(why("tool", idle, { n: 2 }), "");
assert.equal(why("tool", idle, { n: 1 }), "ctl.why.active", "the active head");
assert.equal(why("extrude", idle, { n: 1 }), "");
assert.equal(why("extrude", idle, { n: 2 }), "ctl.why.cold", "a cold nozzle does not extrude");
assert.equal(why("load", idle, { n: 3 }), "");
assert.equal(why("tool", idle, { n: 7 }), "ctl.why.missing");

// Jogging: the steps offered, Z ≥ 0.5 mm and 10 mm at most, the travel, Y in front of a U1's docks.
assert.equal(why("jog", idle, { axis: "x", dist: 7 }), "ctl.why.limit");
assert.equal(why("jog", idle, { axis: "z", dist: -10 }), "ctl.why.limit", "10 - 10 = 0 < 0.5");
assert.equal(why("jog", { ...idle, position: [135, 135, 0.55] }, { axis: "z", dist: -0.1 }), "ctl.why.limit");
assert.equal(why("jog", idle, { axis: "z", dist: 50 }), "ctl.why.zstep");
assert.equal(why("jog", { ...idle, position: [135, 250, 10] }, { axis: "y", dist: 50 }), "ctl.why.limit");
assert.equal(why("jog", { ...idle, position: [135, 250, 10] }, { axis: "y", dist: 10 }), "");
assert.deepEqual(C.ctlRange(cfg, 1), [0, 270]);
assert.deepEqual(C.ctlRange({ ...cfg, u1: false }, 1), [0, 335]);
assert.deepEqual(C.ctlRange(cfg, 2), [0.5, 275]);

// Not homed: moves, head changes, unloading and cleaning wait; homing and heating do not.
const notHomed = { ...idle, homed: "" };
for (const [k, o] of [["jog", { axis: "x", dist: 1 }], ["tool", { n: 2 }], ["unload", { n: 1 }], ["clean", {}], ["purge_position", {}]]) assert.equal(why(k, notHomed, o), "ctl.why.home", k);
assert.equal(why("home", notHomed), "");
assert.equal(why("nozzle_temp", notHomed, { n: 0 }), "");
assert.equal(why("extrude", notHomed, { n: 1 }), "", "the active head extrudes without homing");
assert.equal(why("extrude", { ...notHomed, heads: idle.heads.map((h) => ({ ...h, temp: 220 })) }, { n: 2 }), "ctl.why.home", "another head must be picked first");

// Printing: only the emergency stop and the light.
const printing = { ...idle, state: "printing", progress: 0.42 };
assert.equal(why("emergency_stop", printing), "");
assert.equal(why("light", printing), "");
for (const k of ["home", "heaters_off", "firmware_restart", "motors_off", "bed_temp"]) assert.equal(why(k, printing), "ctl.why.printing", k);
assert.equal(why("home", { ...idle, state: "paused" }), "ctl.why.printing");
// The U1 in one of its procedures: waits, the restart stays possible.
const leveling = { ...idle, main_state: "BED_LEVELING" };
assert.equal(why("home", leveling), "ctl.why.machine");
assert.equal(why("firmware_restart", leveling), "");
// What the printer lacks; no printer.
const bare = { ...cfg, light: false, chamber_fan: false, purifier: false };
assert.equal(C.ctlWhy("light", idle, bare), "ctl.why.missing");
assert.equal(C.ctlWhy("chamber_fan", idle, bare), "ctl.why.missing");
assert.equal(C.ctlWhy("purifier", idle, bare), "ctl.why.missing");
assert.equal(C.ctlWhy("home", null, cfg), "ctl.why.offline");

// The status bar's word.
assert.equal(C.ctlStateOf(idle), "idle");
assert.equal(C.ctlStateOf(printing), "printing");
assert.equal(C.ctlStateOf({ ...idle, state: "paused" }), "paused");
assert.equal(C.ctlStateOf(leveling), "busy");
assert.equal(C.ctlStateOf(null), "offline");
assert.equal(C.ctlStateOf({ ...idle, main_state: "" }), "idle", "another Klipper has no machine state");

// Gauges.
assert.equal(C.ctlPct(150, 300), 0.5);
assert.equal(C.ctlPct(400, 300), 1);
assert.equal(C.ctlHeat(120, 210), "heating");
assert.equal(C.ctlHeat(209, 210), "ready");
assert.equal(C.ctlHeat(150, 0), "cooling");
assert.equal(C.ctlHeat(24, 0), "off");

// The page: Control is a Care & Tuning tab between Bed Leveling and the
// hidden Calibration, and the printer card opens it.
const fs = require("fs");
const html = fs.readFileSync(require("path").join(__dirname, "..", "ui", "index.html"), "utf8");
const tabs = html.slice(html.indexOf('id="mt-tabs"'), html.indexOf("</div>", html.indexOf('id="mt-tabs"')));
assert.ok(tabs.indexOf('data-mtab="level"') < tabs.indexOf('data-mtab="control"') && tabs.indexOf('data-mtab="control"') < tabs.indexOf('data-mtab="calib"'));
assert.ok(/<button class="seg-btn labeled hidden" data-mtab="calib">/.test(html), "Calibration still hidden");
assert.ok(/id="prn-control"/.test(html) && /id="ct-body"/.test(html));
const maint = fs.readFileSync(require("path").join(__dirname, "..", "ui", "maint.js"), "utf8");
assert.ok(/const MT_TABS = \["care", "level", "control"\]/.test(maint));

console.log("control: ok");
