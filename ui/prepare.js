"use strict";
/* "Prepare" view: the plate before slicing.

   Each object is an item of a file's <build>, served centered on itself by
   `mesh://…&i=`. Its placement: scale, rotations (X, then Y, then Z, in
   degrees), then position (X, Y) of its center; the object rests on the bed.
   Rust applies the same rule when slicing (`plate.rs`).

   A 3MF with several plates keeps Orca's layout: its first plate lands on
   ours, the others are set beside it, and what is off the plate is not
   sliced. */

const PR = {
  objects: [],
  sel: new Set(),
  nextId: 1,
  bed: { w: 270, d: 270, model: "Snapmaker U1" },
  gl: null,
  prog: null,
  line: null,
  grid: null,
  /* Bed plate and logo (buildBed), null for an unknown model. */
  plate: null,
  /* Loaded meshes, by file and rank: { vao, count, pos, hull, n } */
  meshes: new Map(),
  cam: { yaw: -0.62, pitch: 0.7, dist: 460, target: [135, 135, 0] },
  drag: null,
  raf: 0,
  framed: false,
};

const PREP_FS = MESH_FS.replace("out vec4 frag;", "uniform vec4 uTint;\nuniform float uAlpha;\nout vec4 frag;").replace(
  "frag = vec4(c, 1.0);",
  "c = mix(c, uTint.rgb, uTint.a);\n  frag = vec4(c, uAlpha);"
);
const FOV = 0.72;

/* Solid-color drawing (rotation rings, hovered facet). */
const SOLID_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;
const SOLID_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 frag;
void main() { frag = uColor; }`;

/* ------------------------------------------------------------ state */

function prSave() {
  const objects = PR.objects.map(({ id, name, path, item, pos, rot, scale, size, plate, extruders, free }) => ({
    id, name, path, item, pos, rot, scale, size, plate, extruders, free,
  }));
  localStorage.setItem("snapstudio.plate", JSON.stringify({ objects, nextId: PR.nextId }));
  prStatus();
}

function prLoadState() {
  try {
    const s = JSON.parse(localStorage.getItem("snapstudio.plate") || "null");
    if (s?.objects) {
      PR.objects = s.objects;
      PR.nextId = s.nextId || PR.objects.length + 1;
    }
  } catch {}
}

/* ------------------------------------------------------------ history */

/* Undo / redo: successive plate states (placements and object list, never
   the meshes), 100 levels. */
const HIST = { undo: [], redo: [] };
const prSnap = () => JSON.stringify(PR.objects);

/* Call right before a change. */
function prRemember(snapshot = prSnap()) {
  if (HIST.undo[HIST.undo.length - 1] === snapshot) return;
  HIST.undo.push(snapshot);
  if (HIST.undo.length > 100) HIST.undo.shift();
  HIST.redo = [];
}

function prRestore(from, to) {
  if (!from.length) return;
  to.push(prSnap());
  PR.objects = JSON.parse(from.pop());
  PR.sel = new Set([...PR.sel].filter((id) => PR.objects.some((o) => o.id === id)));
  prSave();
  prRenderInspector();
  prSchedule();
  if (PR.gl) Promise.all(PR.objects.map(prLoadMesh)).then(prSchedule);
}
const prUndo = () => prRestore(HIST.undo, HIST.redo);
const prRedo = () => prRestore(HIST.redo, HIST.undo);

const meshKey = (o) => `${o.path}#${o.item}`;
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

/* Rz · Ry · Rx, like `plate::rotation` in Rust. */
function rotation(rot) {
  const [a, b, c] = rot.map(rad);
  const [sa, ca, sb, cb, sc, cc] = [Math.sin(a), Math.cos(a), Math.sin(b), Math.cos(b), Math.sin(c), Math.cos(c)];
  return [
    [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa],
    [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa],
    [-sb, cb * sa, cb * ca],
  ];
}

const applyRS = (r, s, v) => {
  const p = [v[0] * s[0], v[1] * s[1], v[2] * s[2]];
  return [
    r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2],
    r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2],
    r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2],
  ];
};

/* Corners of the object's box (own frame, centered). */
function corners(o) {
  const [x, y, z] = o.size.map((v) => v / 2);
  const out = [];
  for (const i of [-x, x]) for (const j of [-y, y]) for (const k of [-z, z]) out.push([i, j, k]);
  return out;
}

/* Object hull rotated and scaled: lowest and highest point, and footprint
   seen from above (relative to the center). Exact whatever the tilt;
   without a hull, the box corners. Cached per orientation, the hull only
   has a few hundred vertices. */
const SHAPES = new Map();
function shape(o) {
  const mesh = PR.meshes.get(meshKey(o));
  const pts = mesh?.hullPts?.length ? mesh.hullPts : corners(o);
  const key = `${meshKey(o)}|${o.rot}|${o.scale}|${pts.length}`;
  let sh = SHAPES.get(key);
  if (sh) return sh;
  const r = rotation(o.rot);
  let zmin = Infinity, zmax = -Infinity;
  const xy = [];
  for (const p of pts) {
    const w = applyRS(r, o.scale, p);
    zmin = Math.min(zmin, w[2]);
    zmax = Math.max(zmax, w[2]);
    xy.push([w[0], w[1]]);
  }
  sh = { r, zmin, zmax, foot: convexHull(xy) };
  if (SHAPES.size > 500) SHAPES.clear();
  SHAPES.set(key, sh);
  return sh;
}

/* Full placement: rotation-scale, and the translation that rests the object. */
function placement(o) {
  const { r, zmin } = shape(o);
  return { r, t: [o.pos[0], o.pos[1], -zmin] };
}

/* Model matrix (columns, like m4). */
function modelMatrix(o) {
  const { r, t } = placement(o);
  const s = o.scale;
  const m = new Float32Array(16);
  for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) m[c * 4 + row] = r[row][c] * s[c];
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

/* Footprint seen from above, on the bed. */
function footprint(o) {
  return shape(o).foot.map((p) => [p[0] + o.pos[0], p[1] + o.pos[1]]);
}

/* Height of the rested object, and center of its box in the scene. */
function worldCenter(o) {
  const sh = shape(o);
  return [o.pos[0], o.pos[1], (sh.zmax - sh.zmin) / 2];
}

/* On the bed: "in", "partial" (sticks out) or "out" (beside it). */
function bedState(o) {
  const pts = footprint(o);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const e = 0.1, { w, d } = PR.bed;
  if (x1 < -e || y1 < -e || x0 > w + e || y0 > d + e) return "out";
  if (x0 < -e || y0 < -e || x1 > w + e || y1 > d + e) return "partial";
  return "in";
}

/* Ordered convex footprint (for overlap tests). */
const footprintPoly = (o) => convexHull(footprint(o));

function convexHull(points) {
  const pts = points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/* Do two convex polygons overlap? (separating axes) */
function polysOverlap(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const n = [q[1] - p[1], p[0] - q[0]];
      const proj = (P) => P.map((v) => v[0] * n[0] + v[1] * n[1]);
      const pa = proj(a), pb = proj(b);
      // A clean contact (less than 0.2 mm overlap) does not count.
      const len = Math.hypot(n[0], n[1]) || 1;
      if (Math.max(...pa) <= Math.min(...pb) + 0.2 * len || Math.max(...pb) <= Math.min(...pa) + 0.2 * len) return false;
    }
  }
  return true;
}

/* Objects overlapping another on the plate, as Orca flags them. */
function prOverlaps() {
  const on = PR.objects.filter((o) => bedState(o) !== "out").map((o) => ({ o, poly: footprintPoly(o) }));
  const hit = new Set();
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      if (polysOverlap(on[i].poly, on[j].poly)) {
        hit.add(on[i].o.id);
        hit.add(on[j].o.id);
      }
    }
  }
  return hit;
}


/* ------------------------------------------------------------ render */

function prEnsureGL() {
  if (PR.gl) return true;
  const gl = $("p-canvas").getContext("webgl2", { antialias: true, depth: true });
  if (!gl) {
    $("p-msg").textContent = tr("viewer.no_webgl");
    $("p-msg").classList.remove("hidden");
    return false;
  }
  PR.gl = gl;
  PR.prog = program(gl, MESH_VS, PREP_FS);
  PR.line = program(gl, LINE_VS, LINE_FS);
  PR.solid = program(gl, SOLID_VS, SOLID_FS);
  PR.grid = buildGrid(gl, PR.bed.w, PR.bed.d);
  PR.plate = buildBed(gl, PR.bed.w, PR.bed.d, PR.bed.model, prSchedule);
  prBindInteractions($("p-canvas"));
  return true;
}

async function prLoadMesh(o) {
  const key = meshKey(o);
  if (PR.meshes.has(key)) return PR.meshes.get(key);
  const entry = { loading: true };
  PR.meshes.set(key, entry);
  const q = `/b?p=${encodeURIComponent(o.path)}&i=${o.item}&b=400000`;
  let buf = null, err = null;
  for (const base of ["mesh://localhost", "http://mesh.localhost"]) {
    try {
      const r = await fetch(base + q);
      if (r.ok) {
        buf = await r.arrayBuffer();
        break;
      }
      err = new Error(r.headers.get("X-Error") || `erreur ${r.status}`);
    } catch (e) {
      err = e;
    }
  }
  if (!buf) {
    PR.meshes.set(key, { failed: String(err?.message || err) });
    toast(tr("prepare.bad_mesh", { name: o.name }), true);
    return null;
  }
  const data = decodeMesh(buf);
  const gl = PR.gl;
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const pb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pb);
  gl.bufferData(gl.ARRAY_BUFFER, data.pos, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(PR.prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  const cb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cb);
  gl.bufferData(gl.ARRAY_BUFFER, data.col, gl.STATIC_DRAW);
  const aCol = gl.getAttribLocation(PR.prog, "aCol");
  gl.enableVertexAttribArray(aCol);
  gl.vertexAttribPointer(aCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);
  gl.bindVertexArray(null);
  Object.assign(entry, { loading: false, vao, count: data.n * 3, n: data.n, pos: data.pos });
  PR.meshes.set(key, entry);
  // Convex hull: exact resting, footprint, "lay on face".
  invoke("plate_hull", { path: o.path, item: o.item })
    .then((h) => {
      entry.hullPts = h.points;
      entry.hullFaces = h.faces;
      SHAPES.clear();
      prRenderInspector();
      prSchedule();
    })
    .catch(() => {});
  return entry;
}

function prCamera(w, h) {
  const c = PR.cam;
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const eye = add3(c.target, [c.dist * cp * Math.sin(c.yaw), -c.dist * cp * Math.cos(c.yaw), c.dist * sp]);
  const view = m4.lookAt(eye, c.target, [0, 0, 1]);
  const proj = m4.perspective(FOV, Math.max(w / Math.max(h, 1), 0.01), Math.max(c.dist / 100, 0.5), c.dist * 12 + 4000);
  return { eye, view, proj };
}

function prDraw() {
  const gl = PR.gl;
  if (!gl) return;
  const canvas = gl.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  const light = !isDark();
  gl.clearColor(...(light ? [0.953, 0.953, 0.961, 1] : [0.118, 0.118, 0.125, 1]));
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  const { view, proj } = prCamera(w, h);
  const vp = m4.mul(proj, view);

  drawBed(gl, PR.plate, PR.grid, vp, view, light);
  // Off-plate objects and selection box: translucent.
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // Objects: red when sticking out, dimmed when beside the plate, tinted
  // with the accent color when selected.
  const accent = accentRgb();
  gl.useProgram(PR.prog);
  const uMVP = gl.getUniformLocation(PR.prog, "uMVP"), uMV = gl.getUniformLocation(PR.prog, "uMV");
  const uTint = gl.getUniformLocation(PR.prog, "uTint"), uAlpha = gl.getUniformLocation(PR.prog, "uAlpha");
  const boxes = [];
  const overlap = prOverlaps();
  for (const o of PR.objects) {
    const mesh = PR.meshes.get(meshKey(o));
    if (!mesh?.vao) continue;
    const model = modelMatrix(o);
    const st = bedState(o);
    const selected = PR.sel.has(o.id);
    gl.uniformMatrix4fv(uMVP, false, m4.mul(vp, model));
    gl.uniformMatrix4fv(uMV, false, m4.mul(view, model));
    const tint =
      st === "partial" ? [1, 0.23, 0.19, 0.45]
      : selected ? [...accent, 0.28]
      : overlap.has(o.id) ? [1, 0.58, 0, 0.4]
      : [0, 0, 0, 0];
    gl.uniform4fv(uTint, tint);
    gl.uniform1f(uAlpha, st === "out" ? 0.45 : 1);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    if (selected) boxes.push(o);
  }

  // Selection box
  if (boxes.length) {
    const pts = [];
    for (const o of boxes) {
      const { r, t } = placement(o);
      // Box slightly bigger than the object: its edges must not merge with the
      // surface, which the depth test would favor.
      const grow = (p, k) => p + Math.sign(p) * Math.max(0.6, Math.abs(o.size[k]) * 0.02) / Math.abs(o.scale[k] || 1);
      const c = corners(o).map((p) => add3(applyRS(r, o.scale, p.map(grow)), t));
      for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) {
        pts.push(...c[a], ...c[b]);
      }
    }
    const buf = gl.createBuffer();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STREAM_DRAW);
    const aPos = gl.getAttribLocation(PR.line, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttrib1f(gl.getAttribLocation(PR.line, "aMain"), 1);
    gl.useProgram(PR.line);
    gl.uniformMatrix4fv(gl.getUniformLocation(PR.line, "uMVP"), false, vp);
    gl.uniform3fv(gl.getUniformLocation(PR.line, "uColor"), accent);
    gl.drawArrays(gl.LINES, 0, pts.length / 3);
    gl.deleteVertexArray(vao);
    gl.deleteBuffer(buf);
  }
  // Rotate tool: three rings (ribbons) around the selection, always visible;
  // the hovered or grabbed ring thickens and lightens.
  const f = PR.tool === "rotate" ? ringFrame() : null;
  if (f) {
    gl.disable(gl.DEPTH_TEST);
    const active = PR.drag?.mode === "ring" ? PR.drag.axis : PR.hoverRing;
    AXES.forEach((a, k) => {
      const u = Math.abs(a[2]) > 0.5 ? [1, 0, 0] : [0, 0, 1];
      const v = cross3(a, u);
      const w = Math.max(1, f.r * 0.05) * (k === active ? 1.7 : 1);
      const pts = [];
      const n = 128;
      for (let i = 0; i <= n; i++) {
        const th = (i / n) * Math.PI * 2;
        const dir = add3(u.map((x) => x * Math.cos(th)), v.map((x) => x * Math.sin(th)));
        pts.push(...add3(f.c, dir.map((x) => x * (f.r - w / 2))), ...add3(f.c, dir.map((x) => x * (f.r + w / 2))));
      }
      const col = AXIS_COLORS[k].map((x) => (k === active ? x + (1 - x) * 0.35 : x));
      drawSolid(gl, vp, pts, [...col, 0.9], gl.TRIANGLE_STRIP);
    });
    gl.enable(gl.DEPTH_TEST);
  }

  // Lay on face: hovered facet highlighted.
  if (PR.tool === "face" && PR.hoverFace) {
    const { o, faces } = PR.hoverFace;
    const mesh = PR.meshes.get(meshKey(o));
    const { r, t } = placement(o);
    const pts = [];
    for (const fc of faces) for (const i of fc) pts.push(...add3(applyRS(r, o.scale, mesh.hullPts[i]), t));
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-2, -2);
    drawSolid(gl, vp, pts, [...accent, 0.6], gl.TRIANGLES);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);
}

/* One-off drawing of a single-color shape (with transparency). */
function drawSolid(gl, vp, pts, rgba, mode) {
  const buf = gl.createBuffer();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STREAM_DRAW);
  const aPos = gl.getAttribLocation(PR.solid, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  gl.useProgram(PR.solid);
  gl.uniformMatrix4fv(gl.getUniformLocation(PR.solid, "uMVP"), false, vp);
  gl.uniform4fv(gl.getUniformLocation(PR.solid, "uColor"), rgba);
  gl.drawArrays(mode, 0, pts.length / 3);
  gl.bindVertexArray(null);
  gl.deleteVertexArray(vao);
  gl.deleteBuffer(buf);
}


const prSchedule = () => {
  if (PR.raf) return;
  PR.raf = requestAnimationFrame(() => {
    PR.raf = 0;
    prDraw();
  });
};
window.addEventListener("themechange", prSchedule);
addEventListener("resize", () => window.currentView === "prepare" && prSchedule());

/* Resolved accent color (AccentColor included), as 0–1 components. */
function accentRgb() {
  const probe = document.createElement("i");
  probe.style.color = "var(--accent)";
  document.body.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/[\d.]+/g) || [0, 122, 255];
  probe.remove();
  return [m[0] / 255, m[1] / 255, m[2] / 255];
}

function prFrame() {
  const { w, d } = PR.bed;
  PR.cam = { yaw: -0.62, pitch: 0.7, dist: Math.max(w, d) * 2.1, target: [w / 2, d / 2, 0] };
  prSchedule();
}

/* ------------------------------------------------------------ selection */

/* Ray from the eye towards the pixel aimed at. */
function prRay(e) {
  const canvas = $("p-canvas");
  const rect = canvas.getBoundingClientRect();
  const { eye } = prCamera(rect.width, rect.height);
  const f = norm3(sub3(PR.cam.target, eye));
  const right = norm3(cross3(f, [0, 0, 1]));
  const up = cross3(right, f);
  const t = Math.tan(FOV / 2);
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const y = 1 - ((e.clientY - rect.top) / rect.height) * 2;
  const aspect = rect.width / Math.max(rect.height, 1);
  const dir = norm3([
    f[0] + right[0] * x * t * aspect + up[0] * y * t,
    f[1] + right[1] * x * t * aspect + up[1] * y * t,
    f[2] + right[2] * x * t * aspect + up[2] * y * t,
  ]);
  return { o: eye, d: dir };
}

/* Point of the Z = 0 plane under the cursor. */
function prBedPoint(e) {
  const { o, d } = prRay(e);
  if (Math.abs(d[2]) < 1e-6) return null;
  const t = -o[2] / d[2];
  return t > 0 ? [o[0] + d[0] * t, o[1] + d[1] * t] : null;
}

/* Object hit by the ray: box, then triangles when the mesh is reasonable.
   Returns the object closest to the eye. */
function prPick(e) {
  const ray = prRay(e);
  let best = null, bestT = Infinity;
  for (const o of PR.objects) {
    const { r, t } = placement(o);
    // Ray brought into the own frame: Rᵀ, then divided by the scale.
    const toLocal = (v, isPoint) => {
      const p = isPoint ? sub3(v, t) : v;
      const q = [
        r[0][0] * p[0] + r[1][0] * p[1] + r[2][0] * p[2],
        r[0][1] * p[0] + r[1][1] * p[1] + r[2][1] * p[2],
        r[0][2] * p[0] + r[1][2] * p[1] + r[2][2] * p[2],
      ];
      return [q[0] / o.scale[0], q[1] / o.scale[1], q[2] / o.scale[2]];
    };
    const lo = toLocal(ray.o, true), ld = toLocal(ray.d, false);
    const half = o.size.map((v) => v / 2);
    let t0 = -Infinity, t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(ld[k]) < 1e-12) {
        if (lo[k] < -half[k] || lo[k] > half[k]) t0 = Infinity;
        continue;
      }
      const a = (-half[k] - lo[k]) / ld[k], b = (half[k] - lo[k]) / ld[k];
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (t0 > t1 || t1 < 0) continue;
    let hit = Math.max(t0, 0);
    const mesh = PR.meshes.get(meshKey(o));
    if (mesh?.pos && mesh.n <= 250000) {
      hit = rayTriangles(lo, ld, mesh.pos);
      if (hit == null) continue;
    }
    // Distance comparable between objects: hit point, brought back to the scene.
    const lp = [lo[0] + ld[0] * hit, lo[1] + ld[1] * hit, lo[2] + ld[2] * hit];
    const wp = add3(applyRS(r, o.scale, lp), t);
    const dist = Math.hypot(...sub3(wp, ray.o));
    if (dist < bestT) {
      bestT = dist;
      best = o;
    }
  }
  return best;
}

/* Möller–Trumbore over all triangles; the closest, or null. */
function rayTriangles(o, d, pos) {
  let best = null;
  for (let i = 0; i < pos.length; i += 9) {
    const e1 = [pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2]];
    const e2 = [pos[i + 6] - pos[i], pos[i + 7] - pos[i + 1], pos[i + 8] - pos[i + 2]];
    const p = cross3(d, e2);
    const det = dot3(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const s = [o[0] - pos[i], o[1] - pos[i + 1], o[2] - pos[i + 2]];
    const u = dot3(s, p) * inv;
    if (u < 0 || u > 1) continue;
    const q = cross3(s, e1);
    const v = dot3(d, q) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = dot3(e2, q) * inv;
    if (t > 0 && (best == null || t < best)) best = t;
  }
  return best;
}

function prSelect(ids, toggle) {
  if (toggle) {
    for (const id of ids) PR.sel.has(id) ? PR.sel.delete(id) : PR.sel.add(id);
  } else {
    PR.sel = new Set(ids);
  }
  prRenderInspector();
  prSchedule();
}

/* ------------------------------------------------------------ mouse */

function prBindInteractions(canvas) {
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const hit = prPick(e);
    if (!hit) return;
    if (!PR.sel.has(hit.id)) prSelect([hit.id], false);
    const many = PR.sel.size > 1;
    nativeMenu([
      { id: "prep:dup", label: many ? tr("prepare.menu.dup_many", { n: PR.sel.size }) : tr("prepare.menu.dup") },
      { id: "prep:center", label: tr("prepare.menu.center") },
      { id: "prep:resetrot", label: tr("prepare.menu.reset_rot") },
      { id: "prep:orient", label: tr("prepare.menu.orient") },
      { id: "prep:facetool", label: tr("prepare.menu.face") },
      {},
      { id: "prep:arrange", label: tr("prepare.menu.arrange") },
      {},
      { id: "prep:del", label: many ? tr("prepare.menu.del_many", { n: PR.sel.size }) : tr("prepare.menu.del") },
    ], e.clientX, e.clientY);
  });
  canvas.addEventListener("mousedown", (e) => {
    e.preventDefault();
    // A click in the scene gives the keyboard back to the view (arrows, A,
    // ⌘Z…): `preventDefault` would otherwise keep it in an inspector field.
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const pan = e.shiftKey || e.button === 1 || e.button === 2;
    const base = { x: e.clientX, y: e.clientY, moved: false };
    // Right click on an object: context menu ("contextmenu" event).
    if (e.button === 2 && prPick(e)) return;
    if (!pan && PR.tool === "rotate") {
      const rh = ringHit(e);
      if (rh) {
        const f = ringFrame();
        PR.drag = {
          ...base,
          mode: "ring",
          axis: rh.axis,
          c: f.c,
          v0: sub3(rh.p, f.c),
          orig: f.sel.map((o) => ({ o, R: rotation(o.rot), pos: [...o.pos] })),
          before: prSnap(),
        };
        return;
      }
    }
    if (!pan && PR.tool === "face") {
      const fh = faceHit(e);
      if (fh) {
        prLayOnFace(fh);
        return;
      }
    }
    if (pan) {
      PR.drag = { ...base, mode: "pan" };
      return;
    }
    const hit = prPick(e);
    if (!hit) {
      PR.drag = { ...base, mode: "orbit", clear: !(e.metaKey || e.ctrlKey) };
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      prSelect([hit.id], true);
    } else if (!PR.sel.has(hit.id)) {
      prSelect([hit.id], false);
    }
    const start = prBedPoint(e);
    if (!start || !PR.sel.has(hit.id)) return;
    const moving = PR.objects.filter((o) => PR.sel.has(o.id));
    PR.drag = {
      ...base,
      mode: e.altKey ? "rotate" : "move",
      // A plain click (no drag) on an object of a multiple selection keeps
      // only it, as in the Finder; dragging moves the group.
      only: e.metaKey || e.ctrlKey ? null : hit.id,
      start,
      center: [...hit.pos],
      orig: moving.map((o) => ({ o, pos: [...o.pos], rz: o.rot[2] })),
      before: prSnap(),
    };
  });
  addEventListener("mousemove", (e) => {
    const d = PR.drag;
    if (!d || window.currentView !== "prepare") return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    if (d.mode === "pan" || d.mode === "orbit") {
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.mode === "pan") prPan(dx, dy);
      else {
        PR.cam.yaw -= dx * 0.008;
        PR.cam.pitch = clamp(PR.cam.pitch + dy * 0.008, 0.05, 1.5);
      }
      prSchedule();
      return;
    }
    if (d.mode === "ring") {
      if (!d.moved) return;
      const a = AXES[d.axis];
      const q = rayPlane(prRay(e), a, d.c);
      if (!q) return;
      if (!d.remembered) {
        prRemember(d.before);
        d.remembered = true;
      }
      const v1 = sub3(q, d.c);
      let ang = deg(Math.atan2(dot3(cross3(d.v0, v1), a), dot3(d.v0, v1)));
      if (e.shiftKey) ang = Math.round(ang / 15) * 15;
      const R = axisAngle(a, rad(ang));
      for (const { o, R: r0, pos } of d.orig) {
        o.rot = eulerOf(mat3mul(R, r0));
        // A group rotates around its common center.
        const rel = [pos[0] - d.c[0], pos[1] - d.c[1], 0];
        const w = [0, 1].map((i) => R[i][0] * rel[0] + R[i][1] * rel[1] + R[i][2] * rel[2]);
        o.pos = [d.c[0] + w[0], d.c[1] + w[1]];
      }
      const lab = $("p-angle"), rect = $("p-canvas").getBoundingClientRect();
      lab.textContent = `${ang > 0 ? "+" : ""}${Math.round(ang * 10) / 10}°`;
      lab.style.left = e.clientX - rect.left + "px";
      lab.style.top = e.clientY - rect.top + "px";
      lab.classList.remove("hidden");
      prRenderProps();
      prSchedule();
      return;
    }
    const p = prBedPoint(e);
    if (!p || !d.moved) return;
    if (!d.remembered) {
      prRemember(d.before);
      d.remembered = true;
    }
    if (d.mode === "move") {
      for (const { o, pos } of d.orig) o.pos = [pos[0] + p[0] - d.start[0], pos[1] + p[1] - d.start[1]];
    } else {
      const a0 = Math.atan2(d.start[1] - d.center[1], d.start[0] - d.center[0]);
      const a1 = Math.atan2(p[1] - d.center[1], p[0] - d.center[0]);
      let delta = deg(a1 - a0);
      // ⇧: 15° steps, as in Orca.
      if (e.shiftKey) delta = Math.round(delta / 15) * 15;
      for (const { o, rz } of d.orig) o.rot = [o.rot[0], o.rot[1], normDeg(rz + delta)];
    }
    prRenderProps();
    prSchedule();
  });
  addEventListener("mouseup", () => {
    const d = PR.drag;
    PR.drag = null;
    if (!d || window.currentView !== "prepare") return;
    if (d.mode === "orbit" && !d.moved && d.clear) prSelect([], false);
    $("p-angle").classList.add("hidden");
    if ((d.mode === "move" || d.mode === "rotate" || d.mode === "ring") && d.moved) {
      prSave();
      prRenderInspector();
    } else if (d.mode === "move" && !d.moved && d.only != null && PR.sel.size > 1) {
      prSelect([d.only], false);
    }
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const dir = state.invertWheel ? -1 : 1;
      const speed = state.wheelSpeed || 1;
      const pinch = e.ctrlKey;
      const action = pinch ? "zoom" : state.wheelAction || "zoom";
      if (action === "zoom") {
        PR.cam.dist = clamp(PR.cam.dist * Math.exp(e.deltaY * 0.0012 * (pinch ? 1 : dir) * speed), 20, 4000);
      } else if (action === "pan") {
        prPan(-e.deltaX * dir * speed, -e.deltaY * dir * speed);
      } else {
        PR.cam.yaw += e.deltaX * 0.006 * dir * speed;
        PR.cam.pitch = clamp(PR.cam.pitch - e.deltaY * 0.006 * dir * speed, 0.05, 1.5);
      }
      prSchedule();
    },
    { passive: false }
  );
  // Hover: ring or facet highlighted.
  canvas.addEventListener("mousemove", (e) => {
    if (PR.drag) return;
    if (PR.tool === "rotate") {
      const k = ringHit(e)?.axis ?? null;
      if (k !== PR.hoverRing) {
        PR.hoverRing = k;
        prSchedule();
      }
    } else if (PR.tool === "face") {
      PR.hoverFace = faceHit(e);
      prSchedule();
    }
  });
  canvas.addEventListener("dblclick", (e) => {
    if (!prPick(e)) prFrame();
  });
}

const normDeg = (a) => {
  let x = ((a % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return Math.round(x * 100) / 100;
};

function prPan(dx, dy) {
  const c = PR.cam;
  const right = [Math.cos(c.yaw), Math.sin(c.yaw), 0];
  const up = [-Math.sin(c.yaw) * Math.sin(c.pitch), Math.cos(c.yaw) * Math.sin(c.pitch), Math.cos(c.pitch)];
  const k = c.dist * 0.0016;
  c.target = add3(c.target, [
    (-right[0] * dx + up[0] * dy) * k,
    (-right[1] * dx + up[1] * dy) * k,
    (-right[2] * dx + up[2] * dy) * k,
  ]);
}

/* ------------------------------------------------------------ inspector */

function prStatus() {
  const n = PR.objects.length;
  const out = PR.objects.filter((o) => bedState(o) !== "in").length;
  sideCount("prepare", n);
  tbSet("prepare", tr("slice.plate"), n ? tr("prepare.count", { n }) + (out ? " · " + tr("prepare.off_count", { n: out }) : "") : "");
  $("p-empty").classList.toggle("hidden", n > 0);
  $("p-del").disabled = PR.sel.size === 0;
  $("p-dup").disabled = PR.sel.size === 0;
  $("p-save").disabled = $("p-clear").disabled = n === 0;
  $("p-arrange").disabled = !PR.objects.some((o) => bedState(o) !== "out");
  $("p-orient").disabled = PR.orienting || !PR.objects.length;
  $("p-slice").disabled = n === 0;
}

function prRenderInspector() {
  const overlap = prOverlaps();
  $("p-list").innerHTML = PR.objects
    .map((o) => {
      const st = bedState(o);
      const tag =
        st === "partial" ? `<span class="tag bad">${esc(tr("prepare.tag.over"))}</span>`
        : st === "out" ? `<span class="tag">${esc(o.plate > 1 ? tr("prepare.tag.plate", { n: o.plate }) : tr("prepare.tag.off"))}</span>`
        : overlap.has(o.id) ? `<span class="tag warn">${esc(tr("prepare.tag.overlap"))}</span>`
        : "";
      return `<button class="grow-row p-obj${PR.sel.has(o.id) ? " on" : ""}" data-id="${o.id}">
        <span class="k">${esc(o.name)}</span>${tag}</button>`;
    })
    .join("");
  prRenderProps();
  prStatus();
}

function prRenderProps() {
  const sel = PR.objects.filter((o) => PR.sel.has(o.id));
  $("p-props").classList.toggle("hidden", sel.length !== 1);
  $("p-multi").classList.toggle("hidden", sel.length < 2);
  $("p-multi").textContent = tr("prepare.selected", { n: sel.length });
  if (sel.length !== 1) return;
  const o = sel[0];
  const set = (id, v) => {
    if (document.activeElement !== $(id)) $(id).value = v;
  };
  set("p-x", Math.round(o.pos[0] * 10) / 10);
  set("p-y", Math.round(o.pos[1] * 10) / 10);
  set("p-rx", Math.round(o.rot[0] * 10) / 10);
  set("p-ry", Math.round(o.rot[1] * 10) / 10);
  set("p-rz", Math.round(o.rot[2] * 10) / 10);
  set("p-scale", Math.round(o.scale[0] * 1000) / 10);
  set("p-sx", Math.round(o.scale[0] * 1000) / 10);
  set("p-sy", Math.round(o.scale[1] * 1000) / 10);
  set("p-sz", Math.round(o.scale[2] * 1000) / 10);
  // Proportions: lock on the object, open as soon as the scale is not uniform.
  const uniform = o.scale[0] === o.scale[1] && o.scale[1] === o.scale[2];
  if (!uniform) o.free = true;
  $("p-lock").checked = !o.free;
  $("p-lock").closest(".group").classList.toggle("locked", !o.free);
  // Dimensions of the rested volume (box aligned on the bed axes).
  const sh = shape(o);
  const xs = sh.foot.map((p) => p[0]), ys = sh.foot.map((p) => p[1]);
  const dims = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), sh.zmax - sh.zmin].map((v) => fmtDec(v, 1));
  $("p-dims").textContent = `${dims.join(" × ")} mm${o.plate > 1 ? " · " + tr("prepare.file_plate", { n: o.plate }) : ""}`;
}

/* Inspector fields: applied live, saved on commit. */
function prBindField(id, apply) {
  const el = $(id);
  const run = (commit) => {
    const o = PR.objects.find((x) => PR.sel.has(x.id));
    const v = parseFloat(String(el.value).replace(",", "."));
    if (!o || !isFinite(v)) return;
    apply(o, v);
    prSchedule();
    if (commit) {
      prSave();
      prRenderInspector();
    } else {
      prRenderProps();
    }
  };
  let before = null;
  el.addEventListener("focus", () => (before = prSnap()));
  el.addEventListener("input", () => run(false));
  el.addEventListener("change", () => {
    if (before) prRemember(before);
    before = prSnap();
    run(true);
  });
}
prBindField("p-x", (o, v) => (o.pos = [v, o.pos[1]]));
prBindField("p-y", (o, v) => (o.pos = [o.pos[0], v]));
prBindField("p-rx", (o, v) => (o.rot = [normDeg(v), o.rot[1], o.rot[2]]));
prBindField("p-ry", (o, v) => (o.rot = [o.rot[0], normDeg(v), o.rot[2]]));
prBindField("p-rz", (o, v) => (o.rot = [o.rot[0], o.rot[1], normDeg(v)]));
prBindField("p-sx", (o, v) => (o.scale = [Math.max(1, v) / 100, o.scale[1], o.scale[2]]));
prBindField("p-sy", (o, v) => (o.scale = [o.scale[0], Math.max(1, v) / 100, o.scale[2]]));
prBindField("p-sz", (o, v) => (o.scale = [o.scale[0], o.scale[1], Math.max(1, v) / 100]));
$("p-lock").addEventListener("change", () => {
  const o = PR.objects.find((x) => PR.sel.has(x.id));
  if (!o) return;
  prRemember();
  o.free = !$("p-lock").checked;
  // Locking again brings back a uniform scale (X's).
  if (!o.free) o.scale = [o.scale[0], o.scale[0], o.scale[0]];
  prSave();
  prRenderInspector();
  prSchedule();
});
prBindField("p-scale", (o, v) => {
  const s = Math.max(1, v) / 100;
  o.scale = [s, s, s];
});

$("p-list").addEventListener("click", (e) => {
  const row = e.target.closest(".p-obj");
  if (row) prSelect([+row.dataset.id], e.metaKey || e.ctrlKey);
});

/* ------------------------------------------------------------ adding */

/* Top-view box of a set of objects, from their boxes. */
function groupBox(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of list) {
    for (const [x, y] of footprint(o)) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, x1, y1 };
}

/* Adds a file's objects. The file's first plate keeps its layout; it is
   placed as is when the plate is empty and it fits, otherwise moved as a
   block to a free spot. The other plates follow, beside it. */
async function prepareAddFile(path, { remember = true } = {}) {
  let items;
  try {
    items = await invoke("plate_items", { path });
  } catch (e) {
    toast(`${path.split("/").pop()} : ${e}`, true);
    return;
  }
  if (!items.length) return;
  const added = items.map((it) => ({
    id: PR.nextId++,
    name: it.name,
    path,
    item: it.index,
    pos: [it.center[0], it.center[1]],
    rot: [0, 0, 0],
    scale: [1, 1, 1],
    size: it.size,
    plate: it.plate,
    extruders: it.extruders,
  }));
  if (remember) prRemember();
  const first = added.filter((o) => o.plate === 1);
  const main = first.length ? first : added;
  const box = groupBox(main);
  const { w, d } = PR.bed;
  const fits = box.x0 >= 0 && box.y0 >= 0 && box.x1 <= w && box.y1 <= d;
  let dx = 0, dy = 0;
  if (!(fits && PR.objects.length === 0)) {
    const bw = box.x1 - box.x0, bd = box.y1 - box.y0;
    const spot = freeSpot(bw, bd) || [(w - bw) / 2, (d - bd) / 2];
    dx = spot[0] - box.x0;
    dy = spot[1] - box.y0;
  }
  for (const o of added) o.pos = [o.pos[0] + dx, o.pos[1] + dy];
  PR.objects.push(...added);
  PR.sel = new Set(main.map((o) => o.id));
  prSave();
  prRenderInspector();
  if (PR.gl) await Promise.all(added.map(prLoadMesh));
  prSchedule();
  const others = added.length - main.length;
  toast(tr("prepare.added", { n: main.length }) + (others ? " · " + tr("prepare.added_others", { n: others }) : ""));
}

/* Corner of a free area of `bw` × `bd` mm (5 mm margin), center first. */
function freeSpot(bw, bd, except) {
  const { w, d } = PR.bed, m = 5;
  const taken = PR.objects.filter((o) => o.id !== except && bedState(o) !== "out").map((o) => groupBox([o]));
  const free = (x, y) =>
    x >= 0 && y >= 0 && x + bw <= w && y + bd <= d &&
    taken.every((b) => x + bw + m <= b.x0 || b.x1 + m <= x || y + bd + m <= b.y0 || b.y1 + m <= y);
  const c = [(w - bw) / 2, (d - bd) / 2];
  if (free(...c)) return c;
  let best = null, bestD = Infinity;
  for (let y = 0; y + bd <= d; y += 5) {
    for (let x = 0; x + bw <= w; x += 5) {
      if (!free(x, y)) continue;
      const dist = Math.hypot(x - c[0], y - c[1]);
      if (dist < bestD) {
        bestD = dist;
        best = [x, y];
      }
    }
  }
  return best;
}

function prRemoveSelection() {
  if (!PR.sel.size) return;
  prRemember();
  PR.objects = PR.objects.filter((o) => !PR.sel.has(o.id));
  PR.sel.clear();
  prSave();
  prRenderInspector();
  prSchedule();
}

/* ------------------------------------------------------------ tools */

/* Product of 3 × 3 matrices (rows). */
const mat3mul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));

/* X, Y, Z angles (degrees) of an Rz · Ry · Rx matrix: the inverse of `rotation`. */
function eulerOf(m) {
  const ry = Math.asin(clamp(-m[2][0], -1, 1));
  let rx, rz;
  if (Math.abs(Math.cos(ry)) > 1e-6) {
    rx = Math.atan2(m[2][1], m[2][2]);
    rz = Math.atan2(m[1][0], m[0][0]);
  } else {
    rx = 0;
    rz = Math.atan2(-m[0][1], m[1][1]);
  }
  return [normDeg(deg(rx)), normDeg(deg(ry)), normDeg(deg(rz))];
}

/* Rotation d'angle `a` (radians) autour d'un axe unitaire (Rodrigues). */
function axisAngle(k, a) {
  const [x, y, z] = k, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/* Shortest rotation bringing `from` onto `to`. */
function rotationBetween(from, to) {
  const a = norm3(from), b = norm3(to);
  const c = dot3(a, b), v = cross3(a, b), s = Math.hypot(...v);
  if (s < 1e-9) {
    if (c > 0) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const axis = norm3(Math.abs(a[0]) < 0.9 ? cross3(a, [1, 0, 0]) : cross3(a, [0, 1, 0]));
    return axisAngle(axis, Math.PI);
  }
  return axisAngle(norm3(v), Math.atan2(s, c));
}

const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const AXIS_COLORS = [[1, 0.27, 0.23], [0.2, 0.78, 0.35], [0.04, 0.52, 1]];
PR.tool = null;
PR.hoverRing = null;
PR.hoverFace = null;

const TOOL_HINTS = { rotate: "prepare.hint.rotate", face: "prepare.hint.face" };

function prSetTool(t) {
  PR.tool = PR.tool === t ? null : t;
  PR.hoverRing = PR.hoverFace = null;
  $("p-rotate").classList.toggle("on", PR.tool === "rotate");
  $("p-face").classList.toggle("on", PR.tool === "face");
  $("p-toolhint").textContent = PR.tool ? tr(TOOL_HINTS[PR.tool]) : "";
  $("p-toolhint").classList.toggle("hidden", !PR.tool);
  prSchedule();
}

/* Center and radius of the rings, around the selection. */
function ringFrame() {
  const sel = PR.objects.filter((o) => PR.sel.has(o.id));
  if (!sel.length) return null;
  const b = groupBox(sel);
  const h = Math.max(...sel.map((o) => shape(o).zmax - shape(o).zmin));
  const c = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, h / 2];
  const r = Math.hypot(b.x1 - b.x0, b.y1 - b.y0, h) / 2 + 4;
  return { c, r, sel };
}

/* Point of a ray in the plane perpendicular to `a` through `c`. */
function rayPlane(ray, a, c) {
  const dn = dot3(ray.d, a);
  if (Math.abs(dn) < 1e-6) return null;
  const t = dot3(sub3(c, ray.o), a) / dn;
  return t > 0 ? add3(ray.o, ray.d.map((v) => v * t)) : null;
}

/* Ring under the cursor, if any. */
function ringHit(e) {
  const f = ringFrame();
  if (!f) return null;
  const ray = prRay(e);
  let best = null;
  AXES.forEach((a, k) => {
    // Ring seen edge-on: impossible to grab cleanly.
    if (Math.abs(dot3(ray.d, a)) < 0.08) return;
    const p = rayPlane(ray, a, f.c);
    if (!p) return;
    const err = Math.abs(Math.hypot(...sub3(p, f.c)) - f.r);
    if (err < f.r * 0.12 + 1.5 && (!best || err < best.err)) best = { axis: k, p, err };
  });
  return best;
}

/* Convex hull face under the cursor (lay on face): the face hit and the
   coplanar faces forming a facet with it. */
function faceHit(e) {
  const ray = prRay(e);
  let best = null;
  for (const o of PR.objects) {
    const mesh = PR.meshes.get(meshKey(o));
    if (!mesh?.hullFaces) continue;
    const { r, t } = placement(o);
    const toLocal = (v, isPoint) => {
      const p = isPoint ? sub3(v, t) : v;
      const q = [0, 1, 2].map((j) => r[0][j] * p[0] + r[1][j] * p[1] + r[2][j] * p[2]);
      return [q[0] / o.scale[0], q[1] / o.scale[1], q[2] / o.scale[2]];
    };
    const lo = toLocal(ray.o, true), ld = toLocal(ray.d, false);
    // The object's box first: faces are only tested when it is hit.
    const half = o.size.map((v) => v / 2 + 0.01);
    let t0 = -Infinity, t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(ld[k]) < 1e-12) {
        if (lo[k] < -half[k] || lo[k] > half[k]) t0 = Infinity;
        continue;
      }
      const a = (-half[k] - lo[k]) / ld[k], b = (half[k] - lo[k]) / ld[k];
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (t0 > t1 || t1 < 0) continue;
    const P = mesh.hullPts;
    mesh.hullFaces.forEach((f, i) => {
      const pos = [...P[f[0]], ...P[f[1]], ...P[f[2]]];
      const hit = rayTriangles(lo, ld, pos);
      if (hit == null) return;
      const wp = add3(applyRS(r, o.scale, [lo[0] + ld[0] * hit, lo[1] + ld[1] * hit, lo[2] + ld[2] * hit]), t);
      const dist = Math.hypot(...sub3(wp, ray.o));
      if (!best || dist < best.dist) best = { o, face: i, dist };
    });
  }
  if (!best) return null;
  const mesh = PR.meshes.get(meshKey(best.o));
  const P = mesh.hullPts;
  const nrm = (f) => norm3(cross3(sub3(P[f[1]], P[f[0]]), sub3(P[f[2]], P[f[0]])));
  const n = nrm(mesh.hullFaces[best.face]);
  const p0 = P[mesh.hullFaces[best.face][0]];
  const tol = Math.max(...best.o.size) * 1e-3 + 1e-4;
  const faces = mesh.hullFaces.filter((f) => dot3(nrm(f), n) > 0.9999 && Math.abs(dot3(n, sub3(P[f[0]], p0))) < tol);
  return { o: best.o, n, faces };
}

/* Lays the targeted facet on the bed. */
function prLayOnFace(hit) {
  const o = hit.o;
  prRemember();
  const r = rotation(o.rot);
  // Normal in the scene: R · S⁻¹ · n (scaling distorts normals).
  const ns = [hit.n[0] / o.scale[0], hit.n[1] / o.scale[1], hit.n[2] / o.scale[2]];
  const nw = norm3([0, 1, 2].map((i) => r[i][0] * ns[0] + r[i][1] * ns[1] + r[i][2] * ns[2]));
  o.rot = eulerOf(mat3mul(rotationBetween(nw, [0, 0, -1]), r));
  PR.hoverFace = null;
  prSave();
  prRenderInspector();
  prSchedule();
}

/* Auto-orientation, Orca's rules (computed in Rust). `all`: the whole
   plate; otherwise the selection, or the whole plate if nothing is selected. */
async function prOrient(all) {
  const onBed = PR.objects.filter((o) => bedState(o) !== "out");
  const targets = all || !PR.sel.size ? onBed : PR.objects.filter((o) => PR.sel.has(o.id));
  if (!targets.length || PR.orienting) return;
  PR.orienting = true;
  $("p-orient").disabled = true;
  $("p-toolhint").textContent = tr("prepare.orienting", { n: targets.length });
  $("p-toolhint").classList.remove("hidden");
  const before = prSnap();
  try {
    const process = SL.memory[SL.memory.last]?.process || null;
    const mats = await invoke("plate_orient", {
      items: targets.map((o) => ({ path: o.path, item: o.item, scale: o.scale })),
      process,
    });
    prRemember(before);
    // The tilt comes from the computation; the chosen Z rotation is kept.
    targets.forEach((o, i) => (o.rot = eulerOf(mat3mul(rotation([0, 0, o.rot[2]]), mats[i]))));
    prSave();
    prRenderInspector();
    prSchedule();
    toast(tr("prepare.oriented", { n: targets.length }));
  } catch (e) {
    toast(tr("prepare.orient_failed", { err: e }), true);
  } finally {
    PR.orienting = false;
    $("p-orient").disabled = false;
    $("p-toolhint").textContent = PR.tool ? tr(TOOL_HINTS[PR.tool]) : "";
    $("p-toolhint").classList.toggle("hidden", !PR.tool);
  }
}

/* Saves the whole plate as 3MF (the model's parts and extruders kept). */
async function prSavePlate() {
  if (!PR.objects.length) return;
  const dir = state.dir || PR.objects[0].path.replace(/\/[^/]*$/, "");
  const dest = await window.__TAURI__.dialog
    .save({ defaultPath: dir + "/" + tr("prepare.default_name"), filters: [{ name: "3MF", extensions: ["3mf"] }] })
    .catch(() => null);
  if (!dest) return;
  const identity = Array.from({ length: 16 }, (_, i) => i);
  try {
    await invoke("plate_save", {
      scene: PR.objects.map((o) => ({ path: o.path, item: o.item, name: o.name, pos: o.pos, rot: o.rot, scale: o.scale, extruder_map: identity })),
      path: dest,
    });
    toast(tr("prepare.saved", { name: dest.split("/").pop() }));
    if (state.dir && dest.startsWith(state.dir)) refresh();
  } catch (e) {
    toast(tr("printers.form.save_failed", { err: e }), true);
  }
}

/* ------------------------------------------------------------ arrangement */

/* Cells (1 mm) covered by the footprint of an object rotated by `rz`,
   grown by `margin`: relative to its center. */
function cellMask(o, rz, margin) {
  const poly = convexHull(footprint({ ...o, pos: [0, 0], rot: [o.rot[0], o.rot[1], rz] }));
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs) - margin), x1 = Math.ceil(Math.max(...xs) + margin);
  const y0 = Math.floor(Math.min(...ys) - margin), y1 = Math.ceil(Math.max(...ys) + margin);
  // Distance from a point to the convex polygon (0 inside).
  const dist = (x, y) => {
    let inside = true, best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      if (ex * (y - a[1]) - ey * (x - a[0]) < 0) inside = false;
      const t = clamp(((x - a[0]) * ex + (y - a[1]) * ey) / (ex * ex + ey * ey || 1), 0, 1);
      best = Math.min(best, Math.hypot(x - a[0] - t * ex, y - a[1] - t * ey));
    }
    return inside ? 0 : best;
  };
  const cells = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (dist(x + 0.5, y + 0.5) <= margin) cells.push(x, y);
  return { cells, x0, x1, y0, y1, area: (x1 - x0) * (y1 - y0) };
}

/* Auto-arrange: millimeter grid, objects from largest to smallest, each in
   the first free spot (bottom, then left), with a 90° attempt; 6 mm
   between two objects. The group is then recentered. What does not fit is
   set beside the plate. */
function prArrange() {
  const list = PR.objects.filter((o) => bedState(o) !== "out");
  if (!list.length) return;
  prRemember();
  const W = Math.floor(PR.bed.w), D = Math.floor(PR.bed.d);
  const grid = new Uint8Array(W * D);
  const margin = 3;
  const plans = list
    .map((o) => {
      // An own rotation (X/Y) is kept as is; only Z varies.
      const tries = [o.rot[2], normDeg(o.rot[2] + 90)].map((rz) => ({ rz, mask: cellMask(o, rz, margin) }));
      return { o, tries, area: Math.min(...tries.map((t) => t.mask.area)) };
    })
    .sort((a, b) => b.area - a.area);
  const fits = (m, cx, cy) => {
    const c = m.cells;
    for (let i = 0; i < c.length; i += 2) {
      const x = cx + c[i], y = cy + c[i + 1];
      if (x < 0 || y < 0 || x >= W || y >= D || grid[y * W + x]) return false;
    }
    return true;
  };
  const placed = [], left = [];
  for (const plan of plans) {
    let best = null;
    for (const t of plan.tries) {
      const m = t.mask;
      search: for (let cy = -m.y0; cy <= D - 1 - m.y1; cy += 1) {
        for (let cx = -m.x0; cx <= W - 1 - m.x1; cx += 1) {
          if (best && (cy > best.cy || (cy === best.cy && cx >= best.cx))) break search;
          if (fits(m, cx, cy)) {
            best = { cx, cy, t };
            break search;
          }
        }
      }
    }
    if (!best) {
      left.push(plan.o);
      continue;
    }
    const c = best.t.mask.cells;
    for (let i = 0; i < c.length; i += 2) grid[(best.cy + c[i + 1]) * W + best.cx + c[i]] = 1;
    placed.push({ o: plan.o, cx: best.cx, cy: best.cy, rz: best.t.rz, m: best.t.mask });
  }
  // Group recentered on the plate.
  if (placed.length) {
    const x0 = Math.min(...placed.map((p) => p.cx + p.m.x0)), x1 = Math.max(...placed.map((p) => p.cx + p.m.x1));
    const y0 = Math.min(...placed.map((p) => p.cy + p.m.y0)), y1 = Math.max(...placed.map((p) => p.cy + p.m.y1));
    const dx = Math.floor((W - 1 - x1 - x0) / 2), dy = Math.floor((D - 1 - y1 - y0) / 2);
    for (const p of placed) {
      p.o.rot = [p.o.rot[0], p.o.rot[1], p.rz];
      p.o.pos = [p.cx + dx, p.cy + dy];
    }
  }
  // What does not fit waits on the right of the plate.
  let y = 0;
  for (const o of left) {
    const b = groupBox([{ ...o, pos: [0, 0] }]);
    o.pos = [PR.bed.w + 20 - b.x0, y - b.y0];
    y += b.y1 - b.y0 + 10;
  }
  prSave();
  prRenderInspector();
  prSchedule();
  if (left.length) toast(tr("prepare.no_fit", { n: left.length }), true);
}

/* Duplicates the selection; copies go to the nearest free spot. */
function prDuplicate() {
  const sel = PR.objects.filter((o) => PR.sel.has(o.id));
  if (!sel.length) return;
  prRemember();
  const copies = [];
  for (const o of sel) {
    const c = { ...o, id: PR.nextId++, pos: [...o.pos], rot: [...o.rot], scale: [...o.scale] };
    const b = groupBox([c]);
    PR.objects.push(c);
    const spot = freeSpot(b.x1 - b.x0, b.y1 - b.y0, c.id);
    c.pos = spot ? [c.pos[0] + spot[0] - b.x0, c.pos[1] + spot[1] - b.y0] : [c.pos[0] + 10, c.pos[1] + 10];
    copies.push(c.id);
  }
  PR.sel = new Set(copies);
  prSave();
  prRenderInspector();
  prSchedule();
}

/* Moves the selection, as a block. */
function prMoveSelection(dx, dy, remember = true) {
  if (!PR.sel.size) return;
  if (remember) prRemember();
  for (const o of PR.objects) if (PR.sel.has(o.id)) o.pos = [o.pos[0] + dx, o.pos[1] + dy];
  prSave();
  prRenderInspector();
  prSchedule();
}

function prCenterSelection() {
  const sel = PR.objects.filter((o) => PR.sel.has(o.id));
  if (!sel.length) return;
  const b = groupBox(sel);
  prMoveSelection(PR.bed.w / 2 - (b.x0 + b.x1) / 2, PR.bed.d / 2 - (b.y0 + b.y1) / 2);
}

function prResetRotation() {
  if (!PR.sel.size) return;
  prRemember();
  for (const o of PR.objects) if (PR.sel.has(o.id)) o.rot = [0, 0, 0];
  prSave();
  prRenderInspector();
  prSchedule();
}

/* ------------------------------------------------------------ view */

/* Called when the view shows: graphics context, bed, meshes. */
async function prepareShow() {
  prStatus();
  if (!prEnsureGL()) return;
  const bed = await invoke("plate_bed", { machine: SL.memory.last || null }).catch(() => null);
  if (bed && (bed.w !== PR.bed.w || bed.d !== PR.bed.d || bed.model !== PR.bed.model)) {
    PR.bed = { w: bed.w, d: bed.d, model: bed.model };
    PR.grid = buildGrid(PR.gl, PR.bed.w, PR.bed.d);
    disposeBed(PR.gl, PR.plate);
    PR.plate = buildBed(PR.gl, PR.bed.w, PR.bed.d, PR.bed.model, prSchedule);
    PR.framed = false;
  }
  if (!PR.framed) {
    prFrame();
    PR.framed = true;
  }
  prRenderInspector();
  prSchedule();
  await Promise.all(PR.objects.map(prLoadMesh));
  prRenderInspector();
  prSchedule();
}

/* Scene handed to slicing: objects on the plate only. */
function prepareScene() {
  const on = PR.objects.filter((o) => bedState(o) === "in");
  const partial = PR.objects.filter((o) => bedState(o) === "partial");
  if (partial.length) {
    toast(tr("prepare.sticks_out", { names: partial.map((o) => o.name).join(", "), n: partial.length }), true);
    return null;
  }
  if (!on.length) {
    toast(tr("prepare.nothing"), true);
    return null;
  }
  const files = [...new Set(on.map((o) => o.path))];
  const name = files.length === 1 ? files[0].split("/").pop().replace(/\.(3mf|stl)$/i, "") : tr("slice.plate").toLowerCase();
  return {
    name,
    files,
    skipped: PR.objects.length - on.length,
    items: on.map((o) => ({ path: o.path, item: o.item, name: o.name, pos: o.pos, rot: o.rot, scale: o.scale })),
  };
}

/* ------------------------------------------------------------ events */

$("p-add").addEventListener("click", prAddFiles);
$("p-save").addEventListener("click", prSavePlate);
$("p-clear").addEventListener("click", prClear);
onMenu("prep", async (what) => {
  if (what === "dup") prDuplicate();
  if (what === "center") prCenterSelection();
  if (what === "resetrot") prResetRotation();
  if (what === "arrange") prArrange();
  if (what === "del") prRemoveSelection();
  if (what === "orient") prOrient(false);
  if (what === "facetool") prSetTool("face");
  if (what === "save") prSavePlate();
  if (what === "add") prAddFiles();
  if (what === "clear") prClear();
});

/* Files picked from disk, added to the plate. */
async function prAddFiles() {
  const picked = await window.__TAURI__.dialog
    .open({ multiple: true, filters: [{ name: tr("prepare.filter"), extensions: ["3mf", "stl"] }] })
    .catch(() => null);
  for (const p of [].concat(picked || [])) await prepareAddFile(typeof p === "string" ? p : p.path);
}

async function prClear() {
  if (!PR.objects.length) return;
  const ok = await confirmDelete(tr("prepare.clear.title"), tr("prepare.clear.text"), tr("prepare.clear.ok"));
  if (!ok) return;
  prEmpty();
}

/* Empties the plate as one undo step and redraws. */
function prEmpty() {
  prRemember();
  PR.objects = [];
  PR.sel.clear();
  prSave();
  prRenderInspector();
  prSchedule();
}
$("p-del").addEventListener("click", prRemoveSelection);
$("p-dup").addEventListener("click", prDuplicate);
$("p-rotate").addEventListener("click", () => prSetTool("rotate"));
$("p-face").addEventListener("click", () => prSetTool("face"));
$("p-orient").addEventListener("click", (e) => prOrient(e.shiftKey));
$("p-arrange").addEventListener("click", prArrange);
$("p-slice").addEventListener("click", () => openSlice());

/* ------------------------------------------------- plate already occupied */

/* Preparing new models (Files, AI) while objects already sit on the plate
   asks first: clear it, or keep it and add beside. Only objects on the bed
   count (not those parked beside it), and the plate is looked at once,
   before anything is added: the models being prepared together never
   trigger it. The plate's own "Add" button never asks. */
const OCC_KEY = "snapstudio.plate.noask";
const occAsk = () => localStorage.getItem(OCC_KEY) !== "1";
function occSetAsk(on) {
  if (on) localStorage.removeItem(OCC_KEY);
  else localStorage.setItem(OCC_KEY, "1");
  $("set-plate-ask").checked = on;
}

function occRows(entries) {
  return entries
    .map(({ name, n, dup }) => `<div class="grow-row"><span class="k">${esc(name)}</span>${
      dup ? `<span class="occ-dup">${esc(tr("prepare.occupied.dup"))}</span>` : ""
    }${n > 1 ? `<span class="val">× ${n}</span>` : ""}</div>`)
    .join("");
}

/* "keep" | "clear" | null (cancelled). */
function occConfirm(paths) {
  const on = PR.objects.filter((o) => bedState(o) !== "out");
  if (!on.length || !occAsk()) return Promise.resolve("keep");
  const byFile = new Map();
  for (const o of on) byFile.set(o.path, (byFile.get(o.path) || 0) + 1);
  $("occ-title").textContent = tr("prepare.occupied.title", { n: on.length });
  $("occ-on").innerHTML = occRows([...byFile].map(([p, n]) => ({ name: baseName(p), n })));
  $("occ-new").innerHTML = occRows(paths.map((p) => ({ name: baseName(p), n: 1, dup: byFile.has(p) })));
  $("occ-noask").checked = false;
  const modal = $("occmodal");
  openSheet(modal);
  requestAnimationFrame(() => $("occ-keep").focus());
  return new Promise((resolve) => {
    const done = (v) => {
      if (v && $("occ-noask").checked) occSetAsk(false);
      $("occ-keep").onclick = $("occ-clear").onclick = $("occ-cancel").onclick = modal.onkeydown = null;
      closeSheet(modal);
      resolve(v);
    };
    $("occ-keep").onclick = () => done("keep");
    $("occ-clear").onclick = () => done("clear");
    $("occ-cancel").onclick = () => done(null);
    modal.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      }
    };
  });
}

/* Adds models to the plate after the occupied-plate check. */
async function prepareModels(paths) {
  if (!paths.length) return;
  switchView("prepare");
  const choice = await occConfirm(paths);
  if (!choice) return;
  let remember = true;
  if (choice === "clear") {
    // Clearing and adding make one undo step.
    prEmpty();
    remember = false;
  }
  const before = new Set(PR.objects.map((o) => o.id));
  for (const p of paths) await prepareAddFile(p, { remember });
  // The whole multi-selection being prepared ends up selected, not only its
  // last file: it stands apart from what was already on the plate.
  if (paths.length > 1) {
    PR.sel = new Set(PR.objects.filter((o) => !before.has(o.id) && o.plate === 1).map((o) => o.id));
    prRenderInspector();
    prSchedule();
  }
}

$("set-plate-ask").checked = occAsk();
$("set-plate-ask").addEventListener("change", (e) => occSetAsk(e.target.checked));

/* Files: "Prepare" adds the selected models to the plate and shows it.
   G-code files are already sliced: they are left out. */
async function prepareFiles(paths) {
  const models = paths
    .map((p) => state.files.find((x) => x.path === p))
    .filter((f) => f && f.kind !== "gcode");
  if (!models.length) {
    if (paths.length) toast(tr("prepare.already_sliced"), true);
    return;
  }
  await prepareModels(models.map((f) => f.path));
}

$("act-slice").addEventListener("click", () => prepareFiles([...state.sel].slice(0, 1)));

/* View keyboard: the menu bar does not have these commands, and ⌘Z/⇧⌘Z
   are intercepted here before the Edit menu (which keeps them in text
   fields). */
let nudgeAt = 0;
document.addEventListener("keydown", (e) => {
  if (window.currentView !== "prepare") return;
  if (document.querySelector(".modal:not(.hidden)")) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") {
    e.preventDefault();
    e.shiftKey ? prRedo() : prUndo();
  } else if (mod && k === "y") {
    e.preventDefault();
    prRedo();
  } else if (mod && k === "d") {
    e.preventDefault();
    prDuplicate();
  } else if (!mod && k === "a") {
    prArrange();
  } else if (!mod && k === "r") {
    prSetTool("rotate");
  } else if (!mod && k === "f") {
    prSetTool("face");
  } else if (!mod && k === "q") {
    prOrient(e.shiftKey);
  } else if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    prRemoveSelection();
  } else if (e.key === "Escape") {
    if (PR.tool) prSetTool(PR.tool);
    else prSelect([], false);
  } else if (e.key.startsWith("Arrow") && PR.sel.size) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const v = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    // A burst of arrows only makes one undo step.
    const now = Date.now();
    prMoveSelection(v[0], v[1], now - nudgeAt > 700);
    nudgeAt = now;
  }
});

window.addEventListener("langchange", () => {
  prRenderInspector();
  if (PR.tool) $("p-toolhint").textContent = tr(TOOL_HINTS[PR.tool]);
});

prLoadState();
prStatus();
