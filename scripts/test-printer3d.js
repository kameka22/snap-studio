// node scripts/test-printer3d.js — the 3D printer view: zones, sides, heat, the status card.
const assert = require("assert");
const L = require("../ui/printer3d-logic.js");

// The parts picked, from the mesh up: spools, docks (heads), the carriage, bed, light.
assert.equal(L.p3dZoneOf(["spoolLeftTopFilament", "spoolLeftTop", "SnapmakerU1"]), "spool:0");
assert.equal(L.p3dZoneOf(["", "spoolRightBottom", "SnapmakerU1"]), "spool:3");
assert.equal(L.p3dZoneOf(["", "parked2", "dock2", "SnapmakerU1"]), "head:2");
assert.equal(L.p3dZoneOf(["nozzle", "toolhead", "SnapmakerU1"], 1), "head:1", "the carriage is the active head");
assert.equal(L.p3dZoneOf(["nozzle", "toolhead", "SnapmakerU1"], null), null, "no head on the carriage");
assert.equal(L.p3dZoneOf(["", "bed", "SnapmakerU1"]), "bed");
assert.equal(L.p3dZoneOf(["", "light", "SnapmakerU1"]), "light");
assert.equal(L.p3dZoneOf(["doorGlass", "door", "SnapmakerU1"]), null);
assert.equal(L.p3dZoneOf([]), null);

// Zones parsed; the side each sits on (T0 T1 left, T2 T3 right).
assert.deepEqual(L.p3dParse("spool:2"), { kind: "spool", n: 2 });
assert.deepEqual(L.p3dParse("head:0"), { kind: "head", n: 0 });
assert.deepEqual(L.p3dParse("bed"), { kind: "bed", n: null });
assert.equal(L.p3dParse("door"), null);
assert.equal(L.p3dParse(null), null);
assert.deepEqual([0, 1, 2, 3].map((n) => L.p3dSideOf(`spool:${n}`)), ["left", "left", "right", "right"]);
assert.equal(L.p3dSideOf("head:0"), "front");
assert.equal(L.p3dSideOf("light"), "front");
assert.ok(L.P3D_YAW.left > 0 && L.P3D_YAW.right < 0 && L.P3D_YAW.front === 0, "a positive turn shows the left side");

// A nozzle's glow: cold, on its way, at its target, cooling without one.
assert.equal(L.p3dHeat(24, 0), 0);
assert.equal(L.p3dHeat(220, 220), 1);
assert.equal(L.p3dHeat(130, 220), 0.5);
assert.equal(L.p3dHeat(300, 220), 1, "never above 1");
assert.equal(L.p3dHeat(120, 0), 0.5, "cooling: towards 200 °C");
assert.equal(L.p3dHeat(null, 0), 0);

// The status card.
assert.equal(L.p3dSummary(null).state, "offline");
assert.equal(L.p3dSummary({ online: false, state: "printing" }).state, "offline");
assert.deepEqual(L.p3dSummary({ online: true, state: "standby", job: "old.gcode", progress: 1 }), { state: "standby", job: "", progress: null, layer: null, left: null }, "a finished job is not shown as running");
assert.deepEqual(L.p3dSummary({ online: true, state: "printing", job: "cube.gcode", progress: 0.42, layer: [12, 80], remaining_s: 3600 }), { state: "printing", job: "cube.gcode", progress: 0.42, layer: [12, 80], left: 3600 });
assert.equal(L.p3dSummary({ online: true, state: "paused", job: "a", progress: 0.1 }).progress, 0.1);
assert.equal(L.p3dSummary({ online: true }).state, "standby");

// The carriage: the bed's centre, its corners (Y+ at the back), unknown.
assert.deepEqual(L.p3dCarriage([135, 135, 10]), { x: 0, z: 0 });
assert.deepEqual(L.p3dCarriage([270, 0, 0]), { x: 0.135, z: 0.135 });
assert.deepEqual(L.p3dCarriage([0, 270, 0]), { x: -0.135, z: -0.135 });
assert.equal(L.p3dCarriage(null), null);
assert.equal(L.p3dCarriage([NaN, 0]), null);

// The turns' easing: from 0 to 1, symmetric.
assert.equal(L.p3dEase(0), 0);
assert.equal(L.p3dEase(1), 1);
assert.equal(L.p3dEase(0.5), 0.5);
assert.ok(L.p3dEase(0.25) < 0.25 && L.p3dEase(0.75) > 0.75);

console.log("printer3d: ok");
