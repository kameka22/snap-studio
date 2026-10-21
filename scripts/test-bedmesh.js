// node scripts/test-bedmesh.js — bed leveling: deviation, status, comparing meshes, estimates.
const assert = require("assert");
const L = require("../ui/bedmesh-logic.js");
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

const mesh = (points, at = 1, min = [3, 3], max = [267, 267]) => ({ at, min, max, points, partial: false });
const m3 = mesh([[0.05, -0.02, 0.01], [0.0, 0.03, -0.04], [0.12, 0.02, -0.06]]);

// Settings: defaults 0.20 / 0.30 mm, alert on, 20 kept; bounds; good ≤ limit.
assert.deepEqual(L.bmlSettings(null), { good: 0.2, limit: 0.3, alert: true, keep: 20 });
assert.deepEqual(L.bmlSettings({ good: 0.5, limit: 0.25, alert: false, keep: 7 }), { good: 0.25, limit: 0.25, alert: false, keep: 20 });
assert.deepEqual(L.bmlSettings({ good: "x", limit: 9, keep: 50 }), { good: 0.2, limit: 1, alert: true, keep: 50 });

// Stats: min, max, mean, deviation max − min, grid, where the extremes are.
const s = L.bmlStats(m3);
near(s.min, -0.06);
near(s.max, 0.12);
near(s.dev, 0.18);
near(s.mean, 0.11 / 9);
assert.deepEqual([s.nx, s.ny, s.count], [3, 3, 9]);
assert.deepEqual(s.maxAt, [0, 2]); // column 0 (min x), row 2 (max y)
assert.deepEqual(s.minAt, [2, 2]);
assert.equal(L.bmlStats({ points: [[]] }), null);
assert.equal(L.bmlStats(mesh([[null, 0.1], [0.3, null]])).dev.toFixed(2), "0.20");

// Status: Good ≤ 0.20, Watch ≤ 0.30, Out above; at the hundredth shown.
assert.equal(L.bmlStatus(0.18), "good");
assert.equal(L.bmlStatus(0.2), "good");
assert.equal(L.bmlStatus(0.2004), "good");
assert.equal(L.bmlStatus(0.21), "watch");
assert.equal(L.bmlStatus(0.3), "watch");
assert.equal(L.bmlStatus(0.34), "out");
assert.equal(L.bmlStatus(0.25, { good: 0.1, limit: 0.2 }), "out");
assert.equal(L.bmlStatus(null), null);

// Alert: the newest full mesh only, and only when the alert is on.
const out = mesh([[0, 0.34], [0, 0]], 10), ok = mesh([[0, 0.1], [0, 0]], 20);
assert.deepEqual(L.bmlAlert([out], {}), { dev: 0.34, at: 10 });
assert.equal(L.bmlAlert([out, ok], {}), null, "a new mesh back under the threshold clears it");
assert.equal(L.bmlAlert([ok, out].reverse(), {}), null, "order does not matter");
assert.equal(L.bmlAlert([out], { alert: false }), null);
assert.equal(L.bmlAlert([ok, { ...out, at: 30, partial: true }], {}), null, "an adaptive mesh does not count");
assert.equal(L.bmlAlert([], {}), null);

// Sampling: corners exact, bilinear between, null outside.
const lin = mesh([[0, 1], [2, 3]], 1, [0, 0], [10, 10]);
near(L.bmlSample(lin, 0, 0), 0);
near(L.bmlSample(lin, 10, 10), 3);
near(L.bmlSample(lin, 5, 5), 1.5);
near(L.bmlSample(lin, 10, 0), 1);
assert.equal(L.bmlSample(lin, 11, 5), null);
assert.deepEqual(L.bmlXY(m3, 2, 1), [267, 135]);

// Upsampling keeps the probed points and fills between them.
const up = L.bmlUpsample(lin, 2);
assert.deepEqual([up.points.length, up.points[0].length], [3, 3]);
near(up.points[1][1], 1.5);
near(up.points[2][2], 3);
assert.equal(L.bmlUpsample(lin, 1), lin);

// Difference: after − before, each from its own mean (a zero shift is no change).
const shifted = mesh(m3.points.map((r) => r.map((v) => v + 0.5)), 2);
const d0 = L.bmlDiff(m3, shifted);
assert.ok(d0.diff);
d0.points.flat().forEach((v) => near(v, 0, 1e-12));
const fixed = mesh([[0.05, -0.02, 0.01], [0.0, 0.03, -0.04], [0.02, 0.02, -0.06]], 3); // the 0.12 bump lowered by 0.10
const d = L.bmlDiff(m3, fixed);
const ds = L.bmlStats(d);
near(d.points[2][0] - d.points[0][0], -0.1, 1e-12);
assert.ok(ds.min < -0.08 && ds.max > 0);
// A different grid is resampled on the after grid.
const coarse = mesh([[0, 0], [0, 0]], 1, [3, 3], [267, 267]);
const fine = mesh([[0, 0, 0], [0, 0.09, 0], [0, 0, 0]], 2);
const dc = L.bmlDiff(coarse, fine);
assert.deepEqual([dc.points.length, dc.points[0].length], [3, 3]);
near(dc.points[1][1], 0.09 - 0.01);
// Barely overlapping areas: no comparison.
assert.equal(L.bmlDiff(mesh([[0, 0], [0, 0]], 1, [0, 0], [50, 50]), m3), null);

// Colour scale: around the mean, at least the good band; a difference around 0.
const flat = L.bmlStats(mesh([[0, 0.01], [0, 0]]));
const sc = L.bmlScale(flat, {});
near(sc.span, 0.1);
near(L.bmlT(flat.mean, sc), 0.5);
assert.ok(L.bmlT(0.01, sc) < 0.6, "a flat bed stays mid-scale");
const sc2 = L.bmlScale(s, {});
near(L.bmlT(s.max, sc2), 0.5 + (s.max - s.mean) / (2 * sc2.span));
assert.equal(L.bmlT(99, sc2), 1);
assert.equal(L.bmlT(-99, sc2), 0);
const sd = L.bmlScale({ min: -0.01, max: 0.005 }, {}, true);
assert.deepEqual(sd, { center: 0, span: 0.02 });
const stops = [[0, 0, 255], [0, 255, 0], [255, 0, 0]];
assert.deepEqual(L.bmlColor(0, stops), [0, 0, 255]);
assert.deepEqual(L.bmlColor(0.5, stops), [0, 255, 0]);
assert.deepEqual(L.bmlColor(1, stops), [255, 0, 0]);
assert.deepEqual(L.bmlColor(0.75, stops), [255, 255, 0], "green → red through yellow");
assert.deepEqual(L.bmlColor(0.25, stops), [0, 255, 255], "blue → green through cyan");
const theme = [[47, 111, 219], [52, 199, 89], [255, 59, 48]];
for (const t of [0, 0.5, 1]) assert.ok(L.bmlColor(t, theme).every((c, k) => Math.abs(c - theme[t * 2][k]) <= 1), `stop ${t} kept`);
assert.deepEqual(L.bmlColor(0.5, [[0, 0, 0], [128, 128, 128], [255, 255, 255]]), [128, 128, 128], "greys stay grey");
assert.equal(L.bmlInk([255, 255, 255]), "#000");
assert.equal(L.bmlInk([0, 0, 120]), "#fff");
assert.equal(L.bmlInk([240, 228, 66]), "#000");

// Estimate: homing, heating, the U1 macro's soak and preheat, the points.
const e = L.bmlEstimate({ points: 169, samples: 3, preheat: 60, temp: 55, bed: 25, autoMacro: true, homed: "xyz" });
assert.equal(e, Math.round(60 + 180 + 169 * 2.6));
assert.equal(L.bmlEstimate({ points: 49, samples: 1, temp: 0, homed: "" }), Math.round(40 + 49 * 1.4));
assert.equal(L.bmlEstimate({ points: 100, temp: 60, bed: 70, autoMacro: false, homed: "xyz", perPoint: 2 }), 200);

// Phase of a running measurement.
assert.deepEqual(L.bmlPhase({ progress: { state: "probing", current: 28, total: 169 } }, 55), { phase: "probing", current: 28, total: 169 });
assert.deepEqual(L.bmlPhase({ progress: { state: "preheating", preheat_left: 40, preheat_total: 60 } }, 55), { phase: "preheat", left: 40, total: 60 });
assert.equal(L.bmlPhase({ progress: { state: "idle" }, bed: { current: 30, target: 55 } }, 55).phase, "heating");
assert.equal(L.bmlPhase({ progress: { state: "completed" }, bed: { current: 54.5, target: 55 } }, 55).phase, "soak");
assert.equal(L.bmlPhase({ progress: { state: "aborted" } }, 55).phase, "aborted");
assert.equal(L.bmlPhase(null, 0).phase, "soak");

// Trend: full meshes, oldest first.
assert.deepEqual(L.bmlTrend([ok, out, { ...out, at: 5, partial: true }]).map((x) => [x.at, x.dev.toFixed(2)]), [[10, "0.34"], [20, "0.10"]]);

// Left-aligned tabs: right after the title, before the flexible spacer, for
// these three only; the other segmented controls stay on the right.
const fs = require("fs");
const html = fs.readFileSync(require("path").join(__dirname, "..", "ui", "index.html"), "utf8");
const bar = html.slice(html.indexOf('<header class="toolbar"'), html.indexOf("</header>"));
const spacer = bar.indexOf('class="tb-spacer"');
const title = bar.indexOf('class="tb-title"');
for (const id of ["pfl-tabs", "ia-views", "mt-tabs"]) {
  const at = bar.indexOf(`id="${id}"`);
  assert.ok(at > title && at < spacer, `${id} sits left, after the title`);
  assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
}
for (const id of ["pfl-layout", "view-grid", "pfl-sort", "pfl-q", "ia-folder", "mt-refresh", "bm-measure-btn"]) assert.ok(bar.indexOf(`id="${id}"`) > spacer, `${id} stays right`);
// Calibration waits for #17; Care & Tuning uses the Files tabs' component.
assert.ok(/<button class="seg-btn labeled hidden" data-mtab="calib">/.test(html));
assert.ok(/<div id="mt-tabs" class="seg"/.test(html) && /<div id="pfl-tabs" class="seg"/.test(html));

console.log("bedmesh: ok");
