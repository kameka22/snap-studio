// Prepare view rules: on / off the plate, slicing filter, slider steps.
const assert = require("assert");
const L = require("../ui/prepare-logic.js");

const bed = { w: 270, d: 270 };
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// Bed state from a footprint.
assert.strictEqual(L.plBedState(sq(10, 10, 50, 50), bed), "in");
assert.strictEqual(L.plBedState(sq(0, 0, 270, 270), bed), "in");
assert.strictEqual(L.plBedState(sq(-0.05, 0, 270.05, 270), bed), "in", "0.1 mm tolerance");
assert.strictEqual(L.plBedState(sq(250, 10, 290, 50), bed), "partial");
assert.strictEqual(L.plBedState(sq(-5, 10, 20, 50), bed), "partial");
assert.strictEqual(L.plBedState(sq(290, 10, 330, 50), bed), "out");
assert.strictEqual(L.plBedState(sq(10, -60, 50, -20), bed), "out");

// Groups and the slicing filter: only "in" objects are sliced.
const objs = [
  { id: 1, st: "in" },
  { id: 2, st: "out" },
  { id: 3, st: "partial" },
  { id: 4, st: "in" },
  { id: 5, st: "out" },
];
const stateOf = (o) => o.st;
const g = L.plGroups(objs, stateOf);
assert.deepStrictEqual(g.on.map((o) => o.id), [1, 3, 4], "sticking out stays with the plate");
assert.deepStrictEqual(g.off.map((o) => o.id), [2, 5]);
assert.strictEqual(g.partial, 1);
assert.strictEqual(g.sliced, 2);
assert.deepStrictEqual(L.plSliced(objs, stateOf).map((o) => o.id), [1, 4], "never an off-plate object");
assert.deepStrictEqual(L.plSliced([{ st: "out" }], stateOf), []);
const empty = L.plGroups([], stateOf);
assert.deepStrictEqual([empty.on.length, empty.off.length, empty.sliced], [0, 0, 0]);

// Slider bounds.
assert.deepStrictEqual([L.plRange("pos", bed, 0).min, L.plRange("pos", { w: 300, d: 200 }, 1).max], [0, 200]);
assert.deepStrictEqual([L.plRange("rot").min, L.plRange("rot").max], [-180, 180]);
assert.deepStrictEqual([L.plRange("scale").min, L.plRange("scale").max], [10, 400]);

// Magnetic 15 degree notches, off with Shift.
assert.strictEqual(L.plSnapAngle(43, false), 45);
assert.strictEqual(L.plSnapAngle(-88, false), -90);
assert.strictEqual(L.plSnapAngle(40, false), 40);
assert.strictEqual(L.plSnapAngle(43, true), 43);
assert.strictEqual(L.plSnapAngle(179, false), 180);

// Wheel / arrow steps.
assert.strictEqual(L.plNudge("pos", 100, 1, false, bed), 101);
assert.strictEqual(L.plNudge("pos", 100, -1, true, bed), 90);
assert.strictEqual(L.plNudge("pos", 103.5, 1, true, bed), 110, "coarse steps land on round values");
assert.strictEqual(L.plNudge("pos", 269.5, 1, false, bed), 270, "kept within the bed");
assert.strictEqual(L.plNudge("rot", 10, 1, true, bed), 15);
assert.strictEqual(L.plNudge("rot", 15, 1, true, bed), 30);
assert.strictEqual(L.plNudge("rot", 15, -1, true, bed), 0);
assert.strictEqual(L.plNudge("rot", 180, 1, false, bed), -179, "rotation wraps");
assert.strictEqual(L.plNudge("rot", -180, -1, true, bed), 165);
assert.strictEqual(L.plNudge("scale", 400, 1, false, bed), 400);
assert.strictEqual(L.plNudge("scale", 10, -1, true, bed), 10);
assert.strictEqual(L.plNudge("scale", 100, 1, true, bed), 110);
assert.strictEqual(L.plWrapDeg(270), -90);

// Bringing a box back on the plate by the smallest move.
assert.deepStrictEqual(L.plInside({ x0: 250, y0: 10, x1: 290, y1: 50 }, bed), [-20, 0]);
assert.deepStrictEqual(L.plInside({ x0: -5, y0: -8, x1: 20, y1: 30 }, bed), [5, 8]);
assert.deepStrictEqual(L.plInside({ x0: 10, y0: 10, x1: 20, y1: 20 }, bed), [0, 0]);
assert.strictEqual(L.plInside({ x0: -10, y0: 0, x1: 300, y1: 20 }, bed), null, "larger than the bed");

// Parking beside the plate: on its right, below what is already there.
assert.deepStrictEqual(L.plParkSpot([], bed, 40, 30), [290, 0]);
assert.deepStrictEqual(L.plParkSpot([{ x0: 290, y0: 0, x1: 330, y1: 30 }], bed, 40, 30), [290, 40]);
assert.deepStrictEqual(L.plParkSpot([{ x0: 290, y0: 60, x1: 330, y1: 90 }], bed, 40, 30), [290, 0], "a gap above is used");
assert.deepStrictEqual(L.plParkSpot([{ x0: 10, y0: 0, x1: 50, y1: 30 }], bed, 40, 30), [290, 0], "boxes on the plate do not count");

console.log("prepare: ok");
