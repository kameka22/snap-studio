"use strict";
/* Visualiseur 3D.
   Le maillage est servi en binaire par Rust (protocole mesh://), le rendu se
   fait en WebGL2 sans bibliothèque : ombrage plat calculé par dérivées d'écran,
   donc aucune normale à transporter. */

const V = {
  gl: null,
  /* Appelé à la fermeture quand quelqu'un a emprunté le visualiseur. */
  onClose: null,
  mesh: null,       // { prog, vao, count, min, max, truncated }
  paths: null,      // trajectoires G-code
  layer: 0,         // couche la plus haute affichée
  showTravel: false,
  grid: null,       // { prog, vao, count }
  cam: { yaw: -0.62, pitch: 0.46, dist: 260, target: [0, 0, 0] },
  drag: null,
  path: null,
  showPlate: true,
  raf: 0,
};

/* Plateau de la Snapmaker U1, en millimètres. */
const PLATE = { w: 270, d: 270, step: 10 };

/* ---------------------------------------------------------------- matrices */

const m4 = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const o = new Float32Array(16);
    o[0] = f / aspect;
    o[5] = f;
    o[10] = (far + near) / (near - far);
    o[11] = -1;
    o[14] = (2 * far * near) / (near - far);
    return o;
  },
  lookAt(eye, center, up) {
    const z = norm3(sub3(eye, center));
    const x = norm3(cross3(up, z));
    const y = cross3(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
    ]);
  },
};
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/* ---------------------------------------------------------------- shaders */

const MESH_VS = `#version 300 es
in vec3 aPos;
in vec3 aCol;
uniform mat4 uMVP;
uniform mat4 uMV;
out vec3 vCol;
out vec3 vPosV;
void main() {
  vCol = aCol;
  vPosV = (uMV * vec4(aPos, 1.0)).xyz;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 vCol;
in vec3 vPosV;
out vec4 frag;
void main() {
  // Normale reconstruite depuis la surface : ombrage plat, sans normales transportées.
  vec3 n = normalize(cross(dFdx(vPosV), dFdy(vPosV)));
  if (n.z < 0.0) n = -n;
  vec3 key = normalize(vec3(-0.45, 0.72, 0.58));
  vec3 fill = normalize(vec3(0.75, -0.15, 0.35));
  float diff = max(dot(n, key), 0.0);
  float fl = max(dot(n, fill), 0.0) * 0.22;
  float amb = 0.32 + 0.16 * (n.z * 0.5 + 0.5);
  float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0) * 0.45;
  vec3 h = normalize(key + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, h), 0.0), 26.0) * 0.28;
  vec3 c = vCol * (amb + diff * 0.82 + fl) + spec + rim * vec3(0.82, 0.86, 1.0);
  frag = vec4(c, 1.0);
}`;

const PATH_VS = `#version 300 es
in vec3 aPos;
in vec3 aCol;
uniform mat4 uMVP;
out vec3 vCol;
void main() {
  vCol = aCol;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const PATH_FS = `#version 300 es
precision highp float;
in vec3 vCol;
uniform float uAlpha;
out vec4 frag;
void main() { frag = vec4(vCol, uAlpha); }`;

/* Couleurs des familles, identiques à celles des vignettes calculées en Rust. */
const FEATURES = [
  ["Autre", [150, 158, 175]],
  ["Paroi extérieure", [232, 108, 62]],
  ["Paroi intérieure", [236, 168, 84]],
  ["Surface supérieure", [226, 84, 106]],
  ["Surface inférieure", [120, 170, 226]],
  ["Remplissage", [150, 120, 214]],
  ["Remplissage plein", [98, 186, 160]],
  ["Pont", [70, 150, 235]],
  ["Support", [120, 132, 154]],
  ["Jupe et bordure", [214, 200, 96]],
  ["Tour de purge", [180, 120, 190]],
  ["Surplomb", [242, 96, 96]],
];

const LINE_VS = `#version 300 es
in vec3 aPos;
in float aMain;
uniform mat4 uMVP;
out float vMain;
void main() {
  vMain = aMain;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in float vMain;
uniform vec3 uColor;
out vec4 frag;
void main() { frag = vec4(uColor, mix(0.22, 0.65, vMain)); }`;

function compile(gl, src, type) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error("shader : " + gl.getShaderInfoLog(s));
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, vs, gl.VERTEX_SHADER));
  gl.attachShader(p, compile(gl, fs, gl.FRAGMENT_SHADER));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("liaison : " + gl.getProgramInfoLog(p));
  }
  return p;
}

/* ---------------------------------------------------------------- données */

/* Décode le tampon produit par `mesh::encode` côté Rust. */
function decodeMesh(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "3MFM") throw new Error("format de maillage inattendu");
  const truncated = (dv.getUint8(5) & 1) === 1;
  const n = dv.getUint32(8, true);
  const min = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)];
  const max = [dv.getFloat32(24, true), dv.getFloat32(28, true), dv.getFloat32(32, true)];
  const pos = new Float32Array(buf, 36, n * 9);
  const triCol = new Uint8Array(buf, 36 + n * 36, n * 3);
  // Une couleur par triangle : on la recopie sur ses trois sommets.
  const col = new Uint8Array(n * 9);
  for (let i = 0; i < n; i++) {
    const r = triCol[i * 3], g = triCol[i * 3 + 1], b = triCol[i * 3 + 2];
    for (let k = 0; k < 3; k++) {
      col[i * 9 + k * 3] = r;
      col[i * 9 + k * 3 + 1] = g;
      col[i * 9 + k * 3 + 2] = b;
    }
  }
  return { n, min, max, pos, col, truncated };
}

/* Décode le tampon produit par `gcode::encode` (en-tête de 40 octets). */
function decodeGcode(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "3MFG") throw new Error("format de trajectoires inattendu");
  const truncated = (dv.getUint8(5) & 1) === 1;
  const n = dv.getUint32(8, true);
  const layers = dv.getUint32(12, true);
  const min = [dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)];
  const max = [dv.getFloat32(28, true), dv.getFloat32(32, true), dv.getFloat32(36, true)];
  const pos = new Float32Array(buf, 40, n * 6);
  const attrs = new Uint8Array(buf, 40 + n * 24, n * 4);

  // Séparation extrusions / déplacements ; l'ordre par couche est conservé.
  const count = { e: 0, t: 0 };
  for (let i = 0; i < n; i++) (attrs[i * 4 + 3] & 1 ? count.t++ : count.e++);
  const out = {
    e: { pos: new Float32Array(count.e * 6), col: new Float32Array(count.e * 6), ends: new Int32Array(layers + 1) },
    t: { pos: new Float32Array(count.t * 6), col: new Float32Array(count.t * 6), ends: new Int32Array(layers + 1) },
  };
  const layerZ = new Float32Array(layers);
  const feats = new Set();
  let ei = 0, ti = 0;
  for (let i = 0; i < n; i++) {
    const layer = attrs[i * 4] | (attrs[i * 4 + 1] << 8);
    const feat = attrs[i * 4 + 2];
    const travel = attrs[i * 4 + 3] & 1;
    const dst = travel ? out.t : out.e;
    const k = travel ? ti++ : ei++;
    for (let v = 0; v < 6; v++) dst.pos[k * 6 + v] = pos[i * 6 + v];
    if (!travel) feats.add(Math.min(feat, FEATURES.length - 1));
    const c = travel ? [96, 104, 126] : FEATURES[Math.min(feat, FEATURES.length - 1)][1];
    for (let v = 0; v < 2; v++) {
      dst.col[k * 6 + v * 3] = c[0] / 255;
      dst.col[k * 6 + v * 3 + 1] = c[1] / 255;
      dst.col[k * 6 + v * 3 + 2] = c[2] / 255;
    }
    if (layer < layers) {
      dst.ends[layer] = travel ? ti : ei;
      if (!travel) layerZ[layer] = Math.max(layerZ[layer], pos[i * 6 + 5]);
    }
  }
  // Bornes cumulées : une couche sans segment reprend la borne précédente.
  for (const d of [out.e, out.t]) {
    let last = 0;
    for (let l = 0; l <= layers; l++) {
      if (d.ends[l] < last) d.ends[l] = last;
      last = d.ends[l];
    }
    d.ends[layers] = d === out.e ? count.e : count.t;
  }
  for (let l = 1; l < layers; l++) if (layerZ[l] === 0) layerZ[l] = layerZ[l - 1];
  return { n, layers, min, max, truncated, out, layerZ, feats: [...feats].sort((a, b) => a - b) };
}

function buildPathBuffers(gl, prog, part) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const pb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pb);
  gl.bufferData(gl.ARRAY_BUFFER, part.pos, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  const cb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cb);
  gl.bufferData(gl.ARRAY_BUFFER, part.col, gl.STATIC_DRAW);
  const aCol = gl.getAttribLocation(prog, "aCol");
  gl.enableVertexAttribArray(aCol);
  gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, ends: part.ends };
}

function buildPaths(gl, data) {
  const prog = program(gl, PATH_VS, PATH_FS);
  return {
    prog,
    extr: buildPathBuffers(gl, prog, data.out.e),
    trav: buildPathBuffers(gl, prog, data.out.t),
    min: data.min,
    max: data.max,
    layers: data.layers,
    layerZ: data.layerZ,
    truncated: data.truncated,
    n: data.n,
    feats: data.feats,
  };
}

function buildMesh(gl, data) {
  const prog = program(gl, MESH_VS, MESH_FS);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const pb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pb);
  gl.bufferData(gl.ARRAY_BUFFER, data.pos, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

  const cb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cb);
  gl.bufferData(gl.ARRAY_BUFFER, data.col, gl.STATIC_DRAW);
  const aCol = gl.getAttribLocation(prog, "aCol");
  gl.enableVertexAttribArray(aCol);
  gl.vertexAttribPointer(aCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);

  gl.bindVertexArray(null);
  return { prog, vao, count: data.n * 3, min: data.min, max: data.max, truncated: data.truncated };
}

/* Quadrillage du plateau : lignes tous les 10 mm, bordure accentuée. */
function buildGrid(gl) {
  const pos = [];
  const main = [];
  const line = (a, b, strong) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    main.push(strong, strong);
  };
  for (let x = 0; x <= PLATE.w; x += PLATE.step) {
    line([x, 0, 0], [x, PLATE.d, 0], x % 50 === 0 ? 1 : 0);
  }
  for (let y = 0; y <= PLATE.d; y += PLATE.step) {
    line([0, y, 0], [PLATE.w, y, 0], y % 50 === 0 ? 1 : 0);
  }
  const prog = program(gl, LINE_VS, LINE_FS);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const pb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  const mb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, mb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(main), gl.STATIC_DRAW);
  const aMain = gl.getAttribLocation(prog, "aMain");
  gl.enableVertexAttribArray(aMain);
  gl.vertexAttribPointer(aMain, 1, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { prog, vao, count: pos.length / 3 };
}

/* ---------------------------------------------------------------- rendu */

function frameCamera() {
  const m = V.paths || V.mesh;
  if (!m) return;
  V.cam.target = [
    (m.min[0] + m.max[0]) / 2,
    (m.min[1] + m.max[1]) / 2,
    (m.min[2] + m.max[2]) / 2,
  ];
  const size = Math.max(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2], 1);
  V.cam.dist = size * 2.1;
  V.cam.yaw = -0.62;
  V.cam.pitch = 0.46;
  draw();
}

function draw() {
  const gl = V.gl;
  if (!gl) return;
  const canvas = gl.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  const light = !isDark();
  // --content-bg : #f3f3f5 en clair, #1e1e20 en sombre.
  gl.clearColor(...(light ? [0.953, 0.953, 0.961, 1] : [0.118, 0.118, 0.125, 1]));
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);

  const c = V.cam;
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const eye = add3(c.target, [
    c.dist * cp * Math.sin(c.yaw),
    -c.dist * cp * Math.cos(c.yaw),
    c.dist * sp,
  ]);
  const view = m4.lookAt(eye, c.target, [0, 0, 1]);
  const proj = m4.perspective(0.72, Math.max(w / Math.max(h, 1), 0.01), Math.max(c.dist / 100, 0.5), c.dist * 12 + 2000);
  const mvp = m4.mul(proj, view);

  if (V.showPlate && V.grid) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(V.grid.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(V.grid.prog, "uMVP"), false, mvp);
    gl.uniform3fv(
      gl.getUniformLocation(V.grid.prog, "uColor"),
      light ? [0.45, 0.48, 0.56] : [0.55, 0.60, 0.72]
    );
    gl.bindVertexArray(V.grid.vao);
    gl.drawArrays(gl.LINES, 0, V.grid.count);
    gl.disable(gl.BLEND);
  }

  if (V.paths) {
    const p = V.paths;
    const upto = Math.min(V.layer, p.layers - 1);
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(p.prog, "uMVP"), false, mvp);
    const alpha = gl.getUniformLocation(p.prog, "uAlpha");
    if (V.showTravel) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(alpha, 0.3);
      gl.bindVertexArray(p.trav.vao);
      gl.drawArrays(gl.LINES, 0, p.trav.ends[upto] * 2);
      gl.disable(gl.BLEND);
    }
    gl.uniform1f(alpha, 1);
    gl.bindVertexArray(p.extr.vao);
    gl.drawArrays(gl.LINES, 0, p.extr.ends[upto] * 2);
  }

  if (V.mesh) {
    gl.useProgram(V.mesh.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(V.mesh.prog, "uMVP"), false, mvp);
    gl.uniformMatrix4fv(gl.getUniformLocation(V.mesh.prog, "uMV"), false, view);
    gl.bindVertexArray(V.mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, V.mesh.count);
  }
  gl.bindVertexArray(null);
}

const schedule = () => {
  if (V.raf) return;
  V.raf = requestAnimationFrame(() => {
    V.raf = 0;
    draw();
  });
};
window.addEventListener("themechange", schedule);

/* Selon la plateforme, Tauri sert les protocoles personnalisés sous l'une ou
   l'autre forme : on tente les deux. */
async function fetchBinary(scheme, path, bust) {
  const q =
    `/b?p=${encodeURIComponent(path)}` + (bust ? `&v=${encodeURIComponent(bust)}` : "");
  let last;
  for (const base of [`${scheme}://localhost`, `http://${scheme}.localhost`]) {
    try {
      const r = await fetch(base + q);
      if (r.ok) return await r.arrayBuffer();
      last = new Error(r.headers.get("X-Error") || `erreur ${r.status}`);
      if (r.status !== 404 || base.startsWith("http")) throw last;
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error("protocole indisponible");
}

/* ---------------------------------------------------------------- ouverture */

function disposeScene() {
  const gl = V.gl;
  if (!gl) return;
  if (V.mesh) {
    gl.deleteVertexArray(V.mesh.vao);
    gl.deleteProgram(V.mesh.prog);
    V.mesh = null;
  }
  if (V.paths) {
    gl.deleteVertexArray(V.paths.extr.vao);
    gl.deleteVertexArray(V.paths.trav.vao);
    gl.deleteProgram(V.paths.prog);
    V.paths = null;
  }
}

async function openViewer(path, name, kind, bust) {
  const box = $("viewer");
  box.classList.remove("hidden");
  $("v-name").textContent = name || "";
  $("v-stats").textContent = "";
  $("v-msg").textContent = "Lecture du maillage…";
  $("v-msg").classList.remove("hidden");
  const acts = { zoom: "molette : zoomer", pan: "molette : déplacer", orbit: "molette : pivoter" };
  $("v-hint").textContent =
    "glisser : pivoter · ⇧ glisser ou clic droit : déplacer · " +
    (acts[state.wheelAction] || acts.zoom);
  V.path = path;

  const canvas = $("v-canvas");
  if (!V.gl) {
    V.gl = canvas.getContext("webgl2", { antialias: true, depth: true });
    if (!V.gl) {
      $("v-msg").textContent = "WebGL2 indisponible sur ce système.";
      return;
    }
    V.grid = buildGrid(V.gl);
    bindInteractions(canvas);
  }

  const gcode = kind === "gcode";
  $("v-layers").classList.toggle("hidden", !gcode);
  $("v-legend").classList.toggle("hidden", !gcode);
  $("v-travel").classList.toggle("hidden", !gcode);

  try {
    const buf = await fetchBinary(gcode ? "gcode" : "mesh", path, bust);
    if (V.path !== path) return;
    disposeScene();
    const dim = (mn, mx) =>
      [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
        .map((x) => x.toFixed(1).replace(".", ","))
        .join(" × ") + " mm";

    if (gcode) {
      const data = decodeGcode(buf);
      V.paths = buildPaths(V.gl, data);
      V.layer = data.layers - 1;
      setupLayerSlider(data);
      renderLegend(data.feats);
      $("v-stats").textContent =
        `${dim(data.min, data.max)} · ${data.layers.toLocaleString("fr-FR")} couches · ` +
        `${data.n.toLocaleString("fr-FR")} segments${data.truncated ? " (tronqué)" : ""}`;
    } else {
      const data = decodeMesh(buf);
      V.mesh = buildMesh(V.gl, data);
      $("v-stats").textContent =
        `${dim(data.min, data.max)} · ${data.n.toLocaleString("fr-FR")} triangles` +
        (data.truncated ? " (échantillonné)" : "");
    }
    $("v-msg").classList.add("hidden");
    frameCamera();
  } catch (e) {
    $("v-msg").textContent = (gcode ? "Trajectoires illisibles : " : "Maillage illisible : ") + e.message;
  }
}

function setupLayerSlider(data) {
  const s = $("v-layer");
  s.min = 1;
  s.max = data.layers;
  s.value = data.layers;
  updateLayerLabel();
}

function updateLayerLabel() {
  const p = V.paths;
  if (!p) return;
  const n = V.layer + 1;
  $("v-layer-n").textContent = `Couche ${n} / ${p.layers}`;
  const z = p.layerZ[Math.min(V.layer, p.layerZ.length - 1)];
  $("v-layer-z").textContent = z ? `Z ${z.toFixed(2).replace(".", ",")} mm` : "";
}

function renderLegend(feats) {
  $("v-legend").innerHTML = feats
    .map((f) => {
      const [name, c] = FEATURES[f];
      return `<span class="leg"><i style="background:rgb(${c[0]},${c[1]},${c[2]})"></i>${name}</span>`;
    })
    .join("");
}

function closeViewer() {
  // Ancré dans une conversation, le visualiseur fait partie de l'écran :
  // Échap ne doit pas le faire disparaître.
  if ($("viewer").classList.contains("docked")) return;
  // Agrandi depuis une conversation, il doit y retourner plutôt que s'éteindre.
  if (V.onClose) {
    const back = V.onClose;
    V.onClose = null;
    back();
    return;
  }
  $("viewer").classList.add("hidden");
  V.path = null;
}

/* Déplace la cible de la caméra dans le plan de l'écran. */
function panBy(dx, dy) {
  const c = V.cam;
  const right = [Math.cos(c.yaw), Math.sin(c.yaw), 0];
  const up = [
    -Math.sin(c.yaw) * Math.sin(c.pitch),
    Math.cos(c.yaw) * Math.sin(c.pitch),
    Math.cos(c.pitch),
  ];
  const k = c.dist * 0.0022;
  c.target = add3(c.target, [
    (-right[0] * dx + up[0] * dy) * k,
    (-right[1] * dx + up[1] * dy) * k,
    (-right[2] * dx + up[2] * dy) * k,
  ]);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function bindInteractions(canvas) {
  canvas.addEventListener("mousedown", (e) => {
    // Clic droit ou molette enfoncée : déplacement, comme dans les logiciels de CAO.
    V.drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1 || e.button === 2 };
    e.preventDefault();
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  addEventListener("mousemove", (e) => {
    if (!V.drag || $("viewer").classList.contains("hidden")) return;
    const dx = e.clientX - V.drag.x;
    const dy = e.clientY - V.drag.y;
    V.drag.x = e.clientX;
    V.drag.y = e.clientY;
    if (V.drag.pan) {
      panBy(dx, dy);
    } else {
      // La scène suit le curseur : glisser vers la gauche l'emmène vers la
      // gauche, comme le déplacement latéral juste au-dessus.
      V.cam.yaw -= dx * 0.008;
      V.cam.pitch = Math.max(-1.45, Math.min(1.45, V.cam.pitch + dy * 0.008));
    }
    schedule();
  });
  addEventListener("mouseup", () => (V.drag = null));
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      // Les réglages viennent de app.js ; ils sont enregistrés entre deux lancements.
      const dir = state.invertWheel ? -1 : 1;
      const speed = state.wheelSpeed || 1;
      // Le pincement du trackpad arrive en molette avec ctrl : c'est toujours un zoom,
      // et jamais inversé, sinon le geste devient contre-intuitif.
      const pinch = e.ctrlKey;
      const action = pinch ? "zoom" : state.wheelAction || "zoom";

      if (action === "zoom") {
        const s = pinch ? 1 : dir;
        V.cam.dist = clamp(V.cam.dist * Math.exp(e.deltaY * 0.0012 * s * speed), 2, 4000);
      } else if (action === "pan") {
        panBy(-e.deltaX * dir * speed, -e.deltaY * dir * speed);
      } else {
        V.cam.yaw += e.deltaX * 0.006 * dir * speed;
        V.cam.pitch = clamp(V.cam.pitch - e.deltaY * 0.006 * dir * speed, -1.45, 1.45);
      }
      schedule();
    },
    { passive: false }
  );
  canvas.addEventListener("dblclick", frameCamera);
  addEventListener("resize", schedule);
}

$("v-layer").addEventListener("input", () => {
  V.layer = +$("v-layer").value - 1;
  updateLayerLabel();
  schedule();
});
$("v-travel").addEventListener("click", () => {
  V.showTravel = !V.showTravel;
  $("v-travel").classList.toggle("on", V.showTravel);
  draw();
});
$("v-close").addEventListener("click", closeViewer);
$("v-reset").addEventListener("click", frameCamera);
$("v-plate").addEventListener("click", () => {
  V.showPlate = !V.showPlate;
  $("v-plate").classList.toggle("on", V.showPlate);
  draw();
});
document.addEventListener("keydown", (e) => {
  const box = $("viewer");
  // Ancré dans une conversation, le clavier appartient au terminal : un « R »
  // au fil d'une phrase ne doit pas recadrer la caméra.
  if (box.classList.contains("hidden") || box.classList.contains("docked")) return;
  if (e.key === "Escape") closeViewer();
  if (e.key.toLowerCase() === "r") frameCamera();
});
