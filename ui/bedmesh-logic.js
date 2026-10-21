"use strict";
/* Bed leveling: the pure part (deviation, status, scales, comparing two
   meshes, the measurement's estimate and phase), tested by
   scripts/test-bedmesh.js. bedmesh.js draws what these return.

   A mesh, as bedmesh.rs gives it: { at, min: [x, y], max: [x, y],
   points: rows from min y to max y, each from min x to max x (mm) }. */

const BML_DEFAULTS = { good: 0.2, limit: 0.3, alert: true, keep: 20 };
const BML_KEEPS = [5, 10, 20, 50, 100];

const bmlRound = (x, n = 3) => Math.round(x * 10 ** n) / 10 ** n;

/* Settings read back: defaults, bounds, "good" never above the limit. */
function bmlSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const num = (v, d, lo, hi) => (Number.isFinite(+v) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, +v)) : d);
  const limit = bmlRound(num(r.limit, BML_DEFAULTS.limit, 0.05, 1), 2);
  const good = bmlRound(Math.min(limit, num(r.good, BML_DEFAULTS.good, 0.02, 1)), 2);
  const keep = BML_KEEPS.includes(+r.keep) ? +r.keep : BML_DEFAULTS.keep;
  return { good, limit, alert: r.alert === undefined ? BML_DEFAULTS.alert : !!r.alert, keep };
}

/* Min, max, mean, deviation (max − min), grid size, where the extremes are. */
function bmlStats(mesh) {
  const rows = mesh?.points || [];
  let min = Infinity, max = -Infinity, sum = 0, n = 0, minAt = null, maxAt = null;
  rows.forEach((r, j) =>
    r.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) return;
      sum += v;
      n++;
      if (v < min) (min = v), (minAt = [i, j]);
      if (v > max) (max = v), (maxAt = [i, j]);
    })
  );
  if (!n) return null;
  return { min, max, mean: sum / n, dev: max - min, nx: rows[0]?.length || 0, ny: rows.length, minAt, maxAt, count: n };
}

/* Good up to `good`, Watch up to `limit`, Out of tolerance above. */
function bmlStatus(dev, s) {
  const { good, limit } = bmlSettings(s);
  if (dev == null || !Number.isFinite(dev)) return null;
  // Compared at the hundredth shown, so 0.20 reads Good under a 0.20 limit.
  const d = bmlRound(dev, 2);
  return d <= good ? "good" : d <= limit ? "watch" : "out";
}

/* The newest stored mesh, when it is out of tolerance and the alert is on:
   { dev, at }; otherwise null. */
function bmlAlert(hist, s) {
  const st = bmlSettings(s);
  if (!st.alert || !hist?.length) return null;
  const last = [...hist].filter((m) => !m.partial).sort((a, b) => b.at - a.at)[0];
  const stats = last && bmlStats(last);
  return stats && bmlStatus(stats.dev, st) === "out" ? { dev: stats.dev, at: last.at } : null;
}

/* Grid coordinates (mm) of a point. */
function bmlXY(mesh, i, j) {
  const nx = mesh.points[0].length, ny = mesh.points.length;
  return [mesh.min[0] + ((mesh.max[0] - mesh.min[0]) * i) / (nx - 1), mesh.min[1] + ((mesh.max[1] - mesh.min[1]) * j) / (ny - 1)];
}

/* Height at (x, y) mm, bilinear between the probed points; null outside. */
function bmlSample(mesh, x, y) {
  const p = mesh.points, nx = p[0].length, ny = p.length;
  const fx = ((x - mesh.min[0]) / (mesh.max[0] - mesh.min[0])) * (nx - 1);
  const fy = ((y - mesh.min[1]) / (mesh.max[1] - mesh.min[1])) * (ny - 1);
  const eps = 1e-9;
  if (!(fx >= -eps && fy >= -eps && fx <= nx - 1 + eps && fy <= ny - 1 + eps)) return null;
  const i = Math.min(nx - 2, Math.max(0, Math.floor(fx))), j = Math.min(ny - 2, Math.max(0, Math.floor(fy)));
  const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fy - j));
  const a = p[j][i], b = p[j][i + 1], c = p[j + 1][i], d = p[j + 1][i + 1];
  if ([a, b, c, d].some((z) => z == null)) return null;
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/* A finer grid for the 3D surface: `f` cells per probed cell. */
function bmlUpsample(mesh, f) {
  const nx = mesh.points[0].length, ny = mesh.points.length;
  if (f <= 1) return mesh;
  const w = (nx - 1) * f + 1, h = (ny - 1) * f + 1;
  const points = [];
  for (let j = 0; j < h; j++) {
    const row = [];
    for (let i = 0; i < w; i++) {
      const x = mesh.min[0] + ((mesh.max[0] - mesh.min[0]) * i) / (w - 1);
      const y = mesh.min[1] + ((mesh.max[1] - mesh.min[1]) * j) / (h - 1);
      row.push(bmlSample(mesh, x, y));
    }
    points.push(row);
  }
  return { ...mesh, points };
}

/* After − before, on the after grid, each mesh taken from its own mean
   (Klipper's zero moves between measurements: the shapes are compared).
   Null when they share less than half of the after area. */
function bmlDiff(before, after) {
  const sb = bmlStats(before), sa = bmlStats(after);
  if (!sb || !sa) return null;
  let inside = 0, total = 0;
  const points = after.points.map((r, j) =>
    r.map((v, i) => {
      total++;
      const [x, y] = bmlXY(after, i, j);
      const b = bmlSample(before, x, y);
      if (b == null || v == null) return null;
      inside++;
      return v - sa.mean - (b - sb.mean);
    })
  );
  if (inside < total / 2) return null;
  return { ...after, at: after.at, points, diff: true };
}

/* Where a height sits on the colour scale, 0 (low) … 1 (high): around the
   mean, over at least the "good" band so a flat bed stays mid-scale. A
   difference: around zero, over at least 0.02 mm. */
function bmlScale(stats, s, diff = false) {
  if (diff) {
    const span = Math.max(Math.abs(stats.min), Math.abs(stats.max), 0.02);
    return { center: 0, span };
  }
  const { good } = bmlSettings(s);
  return { center: stats.mean, span: Math.max(stats.max - stats.mean, stats.mean - stats.min, good / 2) };
}
const bmlT = (v, sc) => Math.min(1, Math.max(0, 0.5 + (v - sc.center) / (2 * sc.span)));

/* Colour at t between three stops ([r, g, b] each), the hue turning the
   short way (green → yellow → red, not through brown). */
function bmlColor(t, stops) {
  const [a, b] = t <= 0.5 ? [stops[0], stops[1]] : [stops[1], stops[2]];
  const u = t <= 0.5 ? t * 2 : (t - 0.5) * 2;
  const A = bmlHsl(a), B = bmlHsl(b);
  // A grey stop has no hue: it takes the other's.
  if (A[1] < 1e-6) A[0] = B[0];
  if (B[1] < 1e-6) B[0] = A[0];
  let dh = B[0] - A[0];
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return bmlRgb([(A[0] + dh * u + 360) % 360, A[1] + (B[1] - A[1]) * u, A[2] + (B[2] - A[2]) * u]);
}
function bmlHsl([r, g, b]) {
  (r /= 255), (g /= 255), (b /= 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function bmlRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

/* Black or white text, whichever reads better on rgb. */
function bmlInk(rgb) {
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? "#000" : "#fff";
}

/* How long a measurement should take, in seconds: homing, heating from
   the bed's temperature, the macro's soak, the U1's preheat, the points.
   `perPoint`: the last measurement's own pace, when known. */
function bmlEstimate({ points = 169, samples = 3, preheat = 60, temp = 55, bed = 25, autoMacro = true, homed = "", perPoint = null }) {
  let s = /x/.test(homed) && /y/.test(homed) && /z/.test(homed) ? 0 : 40;
  if (temp > 0) {
    s += Math.max(0, temp - bed) / 0.5; // ~0.5 °C/s
    if (autoMacro) s += 120 + preheat; // AUTO_BED_MESH_CALIBRATE: 2 min, then the probe's preheat
  }
  s += points * (perPoint || 0.8 + 0.6 * samples);
  return Math.round(s);
}

/* What the printer is doing during a measurement, from bed_mesh.progress
   and the bed: heating, soak, preheat, prescan, probing, done. */
function bmlPhase(live, temp) {
  const p = live?.progress, bed = live?.bed;
  if (p?.state === "probing") return { phase: "probing", current: p.current, total: p.total };
  if (p?.state === "preheating") return { phase: "preheat", left: p.preheat_left, total: p.preheat_total };
  if (p?.state === "prescanning") return { phase: "prescan" };
  if (p?.state === "aborting" || p?.state === "aborted") return { phase: "aborted" };
  if (temp > 0 && bed && bed.current < temp - 1) return { phase: "heating", current: bed.current, target: temp };
  return { phase: "soak" };
}

/* The deviation over time: [{ at, dev }], oldest first. */
const bmlTrend = (hist) => [...(hist || [])].filter((m) => !m.partial).sort((a, b) => a.at - b.at).map((m) => ({ at: m.at, dev: bmlStats(m)?.dev ?? 0 }));

if (typeof module !== "undefined")
  module.exports = { BML_DEFAULTS, BML_KEEPS, bmlSettings, bmlStats, bmlStatus, bmlAlert, bmlXY, bmlSample, bmlUpsample, bmlDiff, bmlScale, bmlT, bmlColor, bmlInk, bmlEstimate, bmlPhase, bmlTrend };
