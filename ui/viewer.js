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
  bed: null,        // plaque et logo, voir buildBed
  cam: { yaw: -0.62, pitch: 0.46, dist: 260, target: [0, 0, 0] },
  drag: null,
  path: null,
  showPlate: true,
  raf: 0,
  /* Aperçu de découpe en cours : bilan, couleurs des têtes, actions. */
  preview: null,
  /* « feature » : couleur par trajectoire ; « tool » : par tête. */
  /* « material » : couleur du filament nuancée par famille (défaut) ;
     « feature » : couleur par trajectoire ; « tool » : couleur pure par tête. */
  colorMode: "material",
  /* Couleurs des filaments écrites dans le G-code ([r,g,b] ou null par tête). */
  fileColors: [],
};

/* Couleurs de repli des têtes, quand la bobine n'est pas connue. */
const TOOL_COLORS = [[0, 122, 255], [255, 149, 0], [52, 199, 89], [175, 82, 222]];

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

/* Extrusions en rubans : chaque segment (une instance) devient un quadrilatère
   tourné vers l'écran, de la largeur réelle d'extrusion, ombré comme un
   cylindre — clair au centre, sombre sur les bords. Les tampons de positions
   et de couleurs des lignes servent tels quels (pas de copie). */
const RIB_VS = `#version 300 es
in vec3 aA;
in vec3 aB;
in vec3 aCol;
in float aW;
uniform mat4 uMVP;
uniform vec2 uViewport;
uniform float uPxPerMm;
out vec3 vCol;
out float vSide;
void main() {
  // Six sommets : deux triangles ; t le long du segment, s en travers.
  int id = gl_VertexID;
  float t = (id == 1 || id == 2 || id == 4) ? 1.0 : 0.0;
  float s = (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0;
  vec4 pa = uMVP * vec4(aA, 1.0);
  vec4 pb = uMVP * vec4(aB, 1.0);
  vec2 sa = pa.xy / pa.w * uViewport, sb = pb.xy / pb.w * uViewport;
  vec2 dir = sb - sa;
  dir = length(dir) > 1e-4 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 p = mix(pa, pb, t);
  // Demi-largeur en pixels à cette profondeur ; un pixel au minimum.
  float hw = max(0.5, 0.5 * aW * uPxPerMm / p.w);
  // Les extrémités dépassent d'une demi-largeur : les jointures se recouvrent.
  vec2 off = nrm * s * hw + dir * (t * 2.0 - 1.0) * hw;
  p.xy += off / uViewport * p.w;
  gl_Position = p;
  vCol = aCol;
  vSide = s;
}`;

const RIB_FS = `#version 300 es
precision highp float;
in vec3 vCol;
in float vSide;
out vec4 frag;
void main() {
  float c = sqrt(max(0.0, 1.0 - vSide * vSide));
  vec3 col = vCol * (0.45 + 0.6 * c) + pow(c, 12.0) * 0.18;
  frag = vec4(col, 1.0);
}`;

/* Au-delà, on revient aux lignes simples : le rendu reste fluide. */
const RIBBON_MAX = 2_500_000;
/* Largeur supposée quand le G-code ne l'indique pas (mm). */
const DEFAULT_WIDTH = 0.42;

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
  // Version 2 : largeur par segment, puis couleurs des filaments.
  const version = dv.getUint8(4);
  const widths = version >= 2 ? new Uint8Array(buf, 40 + n * 28, n) : null;
  const fileColors = [];
  if (version >= 2) {
    let o = 40 + n * 29;
    const k = dv.getUint8(o++);
    for (let i = 0; i < k; i++, o += 4) {
      fileColors.push(dv.getUint8(o) ? [dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)] : null);
    }
  }

  // Séparation extrusions / déplacements ; l'ordre par couche est conservé.
  const count = { e: 0, t: 0 };
  for (let i = 0; i < n; i++) (attrs[i * 4 + 3] & 1 ? count.t++ : count.e++);
  const out = {
    e: {
      pos: new Float32Array(count.e * 6),
      col: new Float32Array(count.e * 6),
      feat: new Uint8Array(count.e),
      tool: new Uint8Array(count.e),
      width: new Float32Array(count.e),
      ends: new Int32Array(layers + 1),
    },
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
    if (!travel) {
      feats.add(Math.min(feat, FEATURES.length - 1));
      out.e.feat[k] = Math.min(feat, FEATURES.length - 1);
      out.e.tool[k] = attrs[i * 4 + 3] >> 4;
      out.e.width[k] = widths && widths[i] ? widths[i] / 100 : DEFAULT_WIDTH;
    }
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
  return { n, layers, min, max, truncated, out, layerZ, fileColors, feats: [...feats].sort((a, b) => a - b) };
}

/* Couleur d'une tête : bobine lue sur l'imprimante (aperçu de découpe), sinon
   celle que le trancheur a écrite dans le G-code, sinon la palette. */
function toolRgb(t) {
  return V.preview?.toolColors?.[t] || V.fileColors?.[t] || TOOL_COLORS[t % TOOL_COLORS.length];
}

/* Mode « Matière » : la couleur du filament, nuancée par famille pour garder
   la lecture de la structure. `k` assombrit, `w` éclaircit vers le blanc,
   `g` désature vers le gris. Indices de `FEATURES`. */
const MATERIAL_SHADE = [
  { k: 0.85 }, // autre
  { k: 1 }, // paroi extérieure
  { k: 0.8 }, // paroi intérieure
  { w: 0.18 }, // surface supérieure
  { k: 0.9 }, // surface inférieure
  { k: 0.62 }, // remplissage
  { k: 0.74 }, // remplissage plein
  { w: 0.12 }, // pont
  { g: 0.75, k: 0.78 }, // support
  { k: 0.88 }, // jupe et bordure
  { g: 0.6, k: 0.72 }, // tour de purge
  { w: 0.06 }, // surplomb
];

function shade(rgb, feat) {
  let [r, g, b] = rgb.map((x) => x / 255);
  const sh = MATERIAL_SHADE[feat] || {};
  // Un filament très sombre s'éclaircit un peu : sinon ses nuances disparaissent.
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum < 0.12) [r, g, b] = [r, g, b].map((x) => x + (0.12 - lum));
  if (sh.g) {
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    [r, g, b] = [r, g, b].map((x) => x + (l - x) * sh.g);
  }
  if (sh.w) [r, g, b] = [r, g, b].map((x) => x + (1 - x) * sh.w);
  if (sh.k) [r, g, b] = [r, g, b].map((x) => x * sh.k);
  return [r, g, b].map((x) => Math.max(0, Math.min(1, x)) * 255);
}

/* Couleurs des extrusions selon le mode : matière (défaut), famille de
   trajectoire, ou tête en couleur pure. */
function extrusionColors(e, mode) {
  const col = new Float32Array(e.feat.length * 6);
  for (let k = 0; k < e.feat.length; k++) {
    const c =
      mode === "material" ? shade(toolRgb(e.tool[k]), e.feat[k])
      : mode === "tool" ? toolRgb(e.tool[k])
      : FEATURES[e.feat[k]][1];
    for (let v = 0; v < 2; v++) {
      col[k * 6 + v * 3] = c[0] / 255;
      col[k * 6 + v * 3 + 1] = c[1] / 255;
      col[k * 6 + v * 3 + 2] = c[2] / 255;
    }
  }
  return col;
}

function setColorMode(mode) {
  V.colorMode = mode;
  const p = V.paths;
  if (!p || !p.extr.colBuf) return;
  const gl = V.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, p.extr.colBuf);
  gl.bufferData(gl.ARRAY_BUFFER, extrusionColors(p.data, mode), gl.STATIC_DRAW);
  document.querySelectorAll("#v-colors [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  renderLegend(p.feats);
  schedule();
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
  return { vao, ends: part.ends, colBuf: cb, posBuf: pb };
}

/* Rubans : une instance par segment, lue dans les tampons des lignes
   (positions a puis b, couleur du premier sommet), plus la largeur. */
function buildRibbons(gl, prog, part, lines) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lines.posBuf);
  const aA = gl.getAttribLocation(prog, "aA"), aB = gl.getAttribLocation(prog, "aB");
  gl.enableVertexAttribArray(aA);
  gl.vertexAttribPointer(aA, 3, gl.FLOAT, false, 24, 0);
  gl.vertexAttribDivisor(aA, 1);
  gl.enableVertexAttribArray(aB);
  gl.vertexAttribPointer(aB, 3, gl.FLOAT, false, 24, 12);
  gl.vertexAttribDivisor(aB, 1);
  gl.bindBuffer(gl.ARRAY_BUFFER, lines.colBuf);
  const aCol = gl.getAttribLocation(prog, "aCol");
  gl.enableVertexAttribArray(aCol);
  gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 24, 0);
  gl.vertexAttribDivisor(aCol, 1);
  const wb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, wb);
  gl.bufferData(gl.ARRAY_BUFFER, part.width, gl.STATIC_DRAW);
  const aW = gl.getAttribLocation(prog, "aW");
  gl.enableVertexAttribArray(aW);
  gl.vertexAttribPointer(aW, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(aW, 1);
  gl.bindVertexArray(null);
  return { vao, widthBuf: wb };
}

function buildPaths(gl, data) {
  const prog = program(gl, PATH_VS, PATH_FS);
  const extr = buildPathBuffers(gl, prog, data.out.e);
  // Rubans ombrés, sauf pour un G-code démesuré : lignes simples.
  let ribbons = null;
  if (data.out.e.feat.length <= RIBBON_MAX) {
    const rprog = program(gl, RIB_VS, RIB_FS);
    ribbons = { prog: rprog, ...buildRibbons(gl, rprog, data.out.e, extr) };
  }
  return {
    prog,
    ribbons,
    extr,
    trav: buildPathBuffers(gl, prog, data.out.t),
    data: data.out.e,
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
function buildGrid(gl, w = PLATE.w, d = PLATE.d) {
  const pos = [];
  const main = [];
  const line = (a, b, strong) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    main.push(strong, strong);
  };
  for (let x = 0; x <= w + 1e-6; x += PLATE.step) {
    line([x, 0, 0], [x, d, 0], x % 50 === 0 ? 1 : 0);
  }
  for (let y = 0; y <= d + 1e-6; y += PLATE.step) {
    line([0, y, 0], [w, y, 0], y % 50 === 0 ? 1 : 0);
  }
  // Bordure : le plateau garde un contour net même hors du pas de 10 mm.
  line([0, 0, 0], [w, 0, 0], 1);
  line([w, 0, 0], [w, d, 0], 1);
  line([w, d, 0], [0, d, 0], 1);
  line([0, d, 0], [0, 0, 0], 1);
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

/* ---------------------------------------------------------------- plateau physique */

/* Plaques connues, d'après les profils de Snapmaker Orca (`bed_model`,
   `bed_texture` du modèle d'imprimante) : maillage de la plaque, logo. */
const BED_ASSETS = {
  "Snapmaker U1": { model: "assets/bed/u1-bed.stl", texture: "assets/bed/u1-texture.svg" },
};
/* Couleurs d'Orca : plaque (Bed3D), zone imprimable (PartPlate), lignes. */
const BED_COLORS = { plate: [0.3255, 0.337, 0.337], area: [0.267, 0.278, 0.278], grid: [0.62, 0.64, 0.64] };
/* Orca descend la plaque sous le plateau pour qu'elle ne masque pas la grille. */
const BED_MODEL_Z = -0.43;

const TEX_VS = `#version 300 es
in vec3 aPos;
in vec2 aUV;
uniform mat4 uMVP;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const TEX_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec4 uColor;
uniform bool uUseTex;
out vec4 frag;
void main() { frag = uUseTex ? texture(uTex, vUV) * uColor : uColor; }`;

/* Fichiers de plaque, lus une fois pour tous les contextes graphiques. */
const BED_FILES = new Map();
function bedFile(url, load) {
  if (!BED_FILES.has(url)) BED_FILES.set(url, load(url));
  return BED_FILES.get(url);
}

/* STL binaire : 80 octets d'en-tête, le nombre de facettes, puis 50 octets
   par facette (normale, trois sommets, attribut). */
async function loadStl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`erreur ${r.status}`);
  const buf = await r.arrayBuffer();
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  if (84 + n * 50 > buf.byteLength) throw new Error("STL binaire attendu");
  const pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
  }
  return pos;
}

function loadImage(url) {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => ko(new Error(`image illisible : ${url}`));
    img.src = url;
  });
}

/* Plateau d'un modèle d'imprimante connu, null sinon. Les fichiers arrivent
   après coup : `onReady` redemande alors un rendu. */
function buildBed(gl, w, d, model, onReady) {
  const a = BED_ASSETS[model];
  if (!a) return null;
  const bed = { w, d, model, plate: null, texture: null };

  // Zone imprimable : support du fond et du logo. Le haut de l'image va au
  // fond du plateau.
  bed.tex = program(gl, TEX_VS, TEX_FS);
  bed.quad = gl.createVertexArray();
  gl.bindVertexArray(bed.quad);
  const qb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, qb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0, 0, 0, 1, w, 0, 0, 1, 1, w, d, 0, 1, 0,
    0, 0, 0, 0, 1, w, d, 0, 1, 0, 0, d, 0, 0, 0,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(bed.tex, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 20, 0);
  const aUV = gl.getAttribLocation(bed.tex, "aUV");
  gl.enableVertexAttribArray(aUV);
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 20, 12);
  gl.bindVertexArray(null);

  // Plaque : maillage du constructeur, centré sur la zone imprimable.
  bedFile(a.model, loadStl)
    .then((src) => {
      const pos = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        pos[i] = src[i] + w / 2;
        pos[i + 1] = src[i + 1] + d / 2;
        pos[i + 2] = src[i + 2] + BED_MODEL_Z;
      }
      const prog = program(gl, MESH_VS, MESH_FS);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const pb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pb);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
      const p = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(p);
      gl.vertexAttribPointer(p, 3, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      bed.plate = { prog, vao, count: pos.length / 3, aCol: gl.getAttribLocation(prog, "aCol") };
      onReady?.();
    })
    .catch((e) => console.warn("plaque :", e.message));

  // Logo : le SVG est tramé à 2048 px au plus, comme dans Orca.
  bedFile(a.texture, loadImage)
    .then((img) => {
      const k = 2048 / Math.max(w, d);
      const cv = document.createElement("canvas");
      cv.width = Math.round(w * k);
      cv.height = Math.round(d * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // Vue rasante : le filtrage anisotrope garde le logo net.
      const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      gl.bindTexture(gl.TEXTURE_2D, null);
      bed.texture = tex;
      onReady?.();
    })
    .catch((e) => console.warn("logo du plateau :", e.message));
  return bed;
}

function disposeBed(gl, bed) {
  if (!bed) return;
  gl.deleteVertexArray(bed.quad);
  gl.deleteProgram(bed.tex);
  if (bed.plate) {
    gl.deleteVertexArray(bed.plate.vao);
    gl.deleteProgram(bed.plate.prog);
  }
  if (bed.texture) gl.deleteTexture(bed.texture);
}

/* Plateau, de bas en haut comme dans Orca : plaque, zone imprimable, grille,
   logo. Seule la plaque écrit la profondeur ; le reste se superpose, et les
   objets, dessinés ensuite, passent devant. Sans plaque connue : la grille. */
function drawBed(gl, bed, grid, vp, view, light) {
  if (bed?.plate) {
    const p = bed.plate;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(p.prog, "uMVP"), false, vp);
    gl.uniformMatrix4fv(gl.getUniformLocation(p.prog, "uMV"), false, view);
    gl.bindVertexArray(p.vao);
    gl.vertexAttrib3f(p.aCol, ...BED_COLORS.plate);
    gl.drawArrays(gl.TRIANGLES, 0, p.count);
  }
  gl.depthMask(false);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  if (bed) {
    gl.useProgram(bed.tex);
    gl.uniformMatrix4fv(gl.getUniformLocation(bed.tex, "uMVP"), false, vp);
    gl.uniform1i(gl.getUniformLocation(bed.tex, "uUseTex"), 0);
    gl.uniform4fv(gl.getUniformLocation(bed.tex, "uColor"), [...BED_COLORS.area, 1]);
    gl.bindVertexArray(bed.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  if (grid) {
    gl.useProgram(grid.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(grid.prog, "uMVP"), false, vp);
    gl.uniform3fv(
      gl.getUniformLocation(grid.prog, "uColor"),
      bed ? BED_COLORS.grid : light ? [0.45, 0.48, 0.56] : [0.55, 0.6, 0.72]
    );
    gl.bindVertexArray(grid.vao);
    gl.drawArrays(gl.LINES, 0, grid.count);
  }
  if (bed?.texture) {
    // Texture prémultipliée : bords du logo sans liseré sombre.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(bed.tex);
    gl.uniform1i(gl.getUniformLocation(bed.tex, "uUseTex"), 1);
    gl.uniform4fv(gl.getUniformLocation(bed.tex, "uColor"), [0.92, 0.92, 0.92, 0.92]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bed.texture);
    gl.uniform1i(gl.getUniformLocation(bed.tex, "uTex"), 0);
    gl.bindVertexArray(bed.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  gl.disable(gl.BLEND);
  gl.depthMask(true);
  gl.bindVertexArray(null);
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

  if (V.showPlate && V.grid) drawBed(gl, V.bed, V.grid, mvp, view, light);

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
    if (p.ribbons) {
      const r = p.ribbons;
      gl.useProgram(r.prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(r.prog, "uMVP"), false, mvp);
      // Pixels par unité d'écran normalisée, et par millimètre à la distance 1.
      gl.uniform2f(gl.getUniformLocation(r.prog, "uViewport"), w / 2, h / 2);
      gl.uniform1f(gl.getUniformLocation(r.prog, "uPxPerMm"), proj[5] * h / 2);
      gl.bindVertexArray(r.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, p.extr.ends[upto]);
    } else {
      gl.uniform1f(alpha, 1);
      gl.bindVertexArray(p.extr.vao);
      gl.drawArrays(gl.LINES, 0, p.extr.ends[upto] * 2);
    }
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
    const p = V.paths;
    gl.deleteVertexArray(p.extr.vao);
    gl.deleteVertexArray(p.trav.vao);
    for (const b of [p.extr.posBuf, p.extr.colBuf, p.trav.posBuf, p.trav.colBuf]) gl.deleteBuffer(b);
    if (p.ribbons) {
      gl.deleteVertexArray(p.ribbons.vao);
      gl.deleteBuffer(p.ribbons.widthBuf);
      gl.deleteProgram(p.ribbons.prog);
    }
    gl.deleteProgram(p.prog);
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
    V.bed = buildBed(V.gl, PLATE.w, PLATE.d, "Snapmaker U1", schedule);
    bindInteractions(canvas);
  }

  const gcode = kind === "gcode";
  // Un aperçu de découpe garde son panneau ; une ouverture ordinaire l'efface.
  if (!V.preview || V.preview.path !== path) hidePreviewPanel();
  $("v-layers").classList.toggle("hidden", !gcode);
  $("v-legend").classList.toggle("hidden", !gcode);
  $("v-travel").classList.toggle("hidden", !gcode);
  $("v-colors").classList.toggle("hidden", !gcode);

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
      // Couleurs écrites par le trancheur : base du mode « Matière ».
      V.fileColors = data.fileColors;
      // Couleurs du G-code connues : le panneau de l'aperçu les reprend.
      if (V.preview && V.preview.path === path) renderPreviewPanel();
      if (V.colorMode !== "feature") data.out.e.col = extrusionColors(data.out.e, V.colorMode);
      V.paths = buildPaths(V.gl, data);
      document.querySelectorAll("#v-colors [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === V.colorMode));
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
  const t = V.preview?.stats?.layer_end_s?.[Math.min(V.layer, (V.preview.stats.layer_end_s.length || 1) - 1)];
  $("v-layer-z").textContent =
    (z ? `Z ${z.toFixed(2).replace(".", ",")} mm` : "") + (t != null ? ` · ${fmtSpan(t)}` : "");
}

function renderLegend(feats) {
  const tools = [...new Set(V.paths?.data.tool || [])].sort((a, b) => a - b);
  const name = (t) => V.preview?.toolNames?.[t];
  const sw = (c) => `<i style="background:rgb(${c.map(Math.round).join(",")})"></i>`;
  if (V.colorMode === "tool" || V.colorMode === "material") {
    const heads = tools.map((t) => `<span class="leg">${sw(toolRgb(t))}T${t}${name(t) ? " · " + esc(name(t)) : ""}</span>`);
    // Matière : les nuances de la première tête, pour lire la structure.
    const base = toolRgb(tools[0] ?? 0);
    const shades =
      V.colorMode === "material"
        ? feats.map((f) => `<span class="leg sub">${sw(shade(base, f))}${FEATURES[f][0]}</span>`)
        : [];
    $("v-legend").innerHTML = heads.join("") + (shades.length ? '<span class="leg-sep"></span>' + shades.join("") : "");
    return;
  }
  $("v-legend").innerHTML = feats
    .map((f) => {
      const [label, c] = FEATURES[f];
      return `<span class="leg">${sw(c)}${label}</span>`;
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
  if (V.preview) {
    const pv = V.preview;
    hidePreviewPanel();
    if (pv.onClose) pv.onClose();
  }
}

/* ------------------------------------------------------------ aperçu de découpe */

const fmtSpan = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, "0")}`;
  if (m) return `${m} min${m < 10 && sec ? " " + String(sec).padStart(2, "0") + " s" : ""}`;
  return `${sec} s`;
};
const fmtNum = (x, d = 1) => (x ?? 0).toFixed(d).replace(".", ",");

/* Ouvre un G-code de découpe avec son bilan. `opts` : path, name, stats,
   toolColors ([r,g,b] par tête), toolNames, onSend, onSave, onEdit, onClose. */
function openPreview(opts) {
  V.preview = opts;
  V.colorMode = "material";
  V.fileColors = [];
  renderPreviewPanel();
  $("v-panel").classList.remove("hidden");
  $("viewer").classList.add("previewing");
  return openViewer(opts.path, opts.name, "gcode");
}

function hidePreviewPanel() {
  V.preview = null;
  // Chaque ouverture repart en mode « Matière ».
  V.colorMode = "material";
  $("v-panel").classList.add("hidden");
  $("viewer").classList.remove("previewing");
}

function renderPreviewPanel() {
  const st = V.preview.stats || {};
  $("vp-time").textContent = st.print_time_s ? fmtSpan(st.print_time_s) : "—";
  $("vp-first").textContent = [
    st.first_layer_s ? `première couche ${fmtSpan(st.first_layer_s)}` : "",
    st.layers ? `${st.layers.toLocaleString("fr-FR")} couches` : "",
  ].filter(Boolean).join(" · ");

  // Une ligne par tête qui extrude, puis le total.
  const tools = st.tools?.length ? st.tools : [0];
  const rows = tools.map((t) => {
    const c = toolRgb(t);
    const g = st.per_tool_g?.[t], m = st.per_tool_m?.[t];
    return `<div class="grow-row"><span class="swatch" style="background:rgb(${c[0]},${c[1]},${c[2]})"></span>
      <span class="k">T${t}${V.preview.toolNames?.[t] ? `<span class="sub">${esc(V.preview.toolNames[t])}</span>` : ""}</span>
      <span class="val">${g != null ? fmtNum(g) + " g" : ""}${m != null ? `<span class="sub">${fmtNum(m, 2)} m</span>` : ""}</span></div>`;
  });
  if (tools.length > 1 || st.cost) {
    rows.push(`<div class="grow-row total"><span class="k">Total</span><span class="val">${
      st.filament_g != null ? fmtNum(st.filament_g) + " g" : "—"
    }${st.cost ? `<span class="sub">${fmtNum(st.cost, 2)} €</span>` : ""}</span></div>`);
  }
  $("vp-fil").innerHTML = rows.join("");

  // Répartition : familles de trajectoires puis déplacements, en part du total.
  const total = (st.features || []).reduce((a, f) => a + f.seconds, 0) + (st.travel_s || 0);
  const feat = (st.features || []).map((f) => ({ name: FEATURES[Math.min(f.feature, FEATURES.length - 1)][0], c: FEATURES[Math.min(f.feature, FEATURES.length - 1)][1], s: f.seconds }));
  if (st.travel_s > 0) feat.push({ name: "Déplacements", c: [96, 104, 126], s: st.travel_s });
  $("vp-feat").innerHTML = feat
    .map((f) => {
      const pct = total ? (f.s * 100) / total : 0;
      return `<div class="grow-row vp-feat"><span class="swatch sq" style="background:rgb(${f.c[0]},${f.c[1]},${f.c[2]})"></span>
        <span class="k">${esc(f.name)}</span>
        <span class="vp-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
        <span class="val">${fmtSpan(f.s)}</span></div>`;
    })
    .join("");
}

$("v-colors").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (b) setColorMode(b.dataset.mode);
});
$("vp-send").addEventListener("click", () => V.preview?.onSend?.());
$("vp-save").addEventListener("click", () => V.preview?.onSave?.());
$("vp-edit").addEventListener("click", () => V.preview?.onEdit?.());

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
  // Une sheet ouverte par-dessus (envoi à l'imprimante) garde le clavier.
  if (document.querySelector(".modal:not(.hidden)")) return;
  if (e.key === "Escape") closeViewer();
  if (e.key.toLowerCase() === "r") frameCamera();
});
