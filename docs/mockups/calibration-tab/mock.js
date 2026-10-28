"use strict";
/* Calibration tab mockup (#38). Static sample data for one Snapmaker U1
   named "U1". Each screen notes the command behind it; the facts (heater
   names, where results are stored, what the firmware allows) come from
   Snapmaker's u1-klipper sources, see docs/plans/calibration-tab.md. */

const Q = new URLSearchParams(location.search);
const S = { v: Q.get("v") || "home", theme: Q.get("theme") || "light", lang: Q.get("lang") || "fr" };
if (Q.has("shot")) document.documentElement.classList.add("shot");
const EN = () => S.lang === "en";
const T = (fr, en) => (EN() && en != null ? en : fr);
const $ = (id) => document.getElementById(id);

/* Spools in the 4 heads (T0..T3). */
const HEADS = [
  { n: 0, c: "#2B2B2D", name: "PLA Noir mat", en: "Matte black PLA", k: "0,032", t: 220 },
  { n: 1, c: "#FF7A1A", name: "PLA Orange", en: "Orange PLA", k: "0,028", t: 220 },
  { n: 2, c: "#F2F2EF", name: "PETG Blanc", en: "White PETG", k: null, t: 250 },
  { n: 3, c: "#1E6FD9", name: "PLA Bleu", en: "Blue PLA", k: "0,041", t: 220 },
];

const I = {
  printer: '<svg viewBox="0 0 24 24"><path d="M7 3h10v4H7zm-2 6h14a2 2 0 0 1 2 2v5h-4v-3H7v3H3v-5a2 2 0 0 1 2-2m2 6h10v6H7z"/></svg>',
  spool: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6m0-4a7 7 0 0 1 6.9 6h-3a4 4 0 0 0-7.8 0h-3A7 7 0 0 1 12 5"/></svg>',
  wrench: '<svg viewBox="0 0 24 24"><path d="M21.7 6.3a5.5 5.5 0 0 1-7.4 6.7L6.7 20.6a2 2 0 0 1-2.8-2.8L11.5 10.2a5.5 5.5 0 0 1 6.7-7.4l-3.4 3.4.7 2.8 2.8.7z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16m-1 3v6l5 3 1-1.7-4-2.4V7z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m-1 5h2v2h-2zm0 4h2v6h-2z"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 2 1 21h22zm-1 7h2v6h-2zm0 8h2v2h-2z"/></svg>',
  power: '<svg viewBox="0 0 24 24"><path d="M11 3h2v9h-2zM6.3 6.3l1.4 1.4A6 6 0 1 0 16.3 7.7l1.4-1.4A8 8 0 1 1 6.3 6.3z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2m2 2v4h8V5zm5 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6"/></svg>',
  screen: '<svg viewBox="0 0 24 24"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2m0 2v10h16V6z"/></svg>',
};

/* ------------------------------------------------------------ drawings */
/* All drawings use the theme's variables, so they follow light and dark. */
const st = (s) => `style="${s}"`;
const LINE = "stroke:var(--ill-line);stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round";

/* One U1 toolhead seen from the front: body, spool-colour band, heater
   block and nozzle. `hot` adds the heat glow, `sel` the accent ring. */
function headSvg(x, y, h, { hot = false, sel = false, dim = false, scale = 1, label = true } = {}) {
  const w = 46 * scale, H = 58 * scale;
  return `<g transform="translate(${x} ${y})" ${dim ? 'opacity=".45"' : ""}>
    ${sel ? `<rect x="${-w / 2 - 6}" y="-6" width="${w + 12}" height="${H + 44 * scale}" rx="${12 * scale}" ${st("fill:var(--accent-soft);stroke:var(--accent);stroke-width:2")}/>` : ""}
    ${hot ? `<ellipse cx="0" cy="${H + 14 * scale}" rx="${20 * scale}" ry="${11 * scale}" ${st("fill:var(--heat);opacity:.25")}/>
      <path d="M${-30 * scale} ${18 * scale}q-5 6 0 12t0 12M${30 * scale} ${18 * scale}q5 6 0 12t0 12" ${st("stroke:var(--heat);stroke-width:1.8;fill:none;stroke-linecap:round;opacity:.85")}/>` : ""}
    <rect x="${-w / 2}" y="0" width="${w}" height="${H}" rx="${8 * scale}" ${st("fill:var(--card-bg);stroke:var(--ill-line);stroke-width:1.6")}/>
    <rect x="${-w / 2 + 5 * scale}" y="${6 * scale}" width="${w - 10 * scale}" height="${9 * scale}" rx="${4 * scale}" style="fill:${h.c};stroke:var(--ill-line);stroke-width:.8"/>
    <circle cx="0" cy="${33 * scale}" r="${9 * scale}" ${st("fill:var(--ill-soft);stroke:var(--ill-line);stroke-width:1.2")}/>
    <path d="M${-6 * scale} ${33 * scale}h${12 * scale}M0 ${27 * scale}v${12 * scale}" ${st("stroke:var(--ill-line);stroke-width:1")} transform="rotate(45 0 ${33 * scale})"/>
    <rect x="${-11 * scale}" y="${H}" width="${22 * scale}" height="${9 * scale}" rx="${2 * scale}" style="fill:${hot ? "var(--heat)" : "var(--ill-metal)"};stroke:var(--ill-line);stroke-width:1.2"/>
    <path d="M${-5 * scale} ${H + 9 * scale}h${10 * scale}l${-5 * scale} ${7 * scale}z" ${st("fill:var(--ill-metal);stroke:var(--ill-line);stroke-width:1.2;stroke-linejoin:round")}/>
    ${label ? `<text x="0" y="${H + 36 * scale}" text-anchor="middle" style="font:600 ${12 * scale}px var(--font-ui);fill:${sel ? "var(--accent)" : "var(--text-secondary)"}">T${h.n}</text>` : ""}
  </g>`;
}

/* PID: the four heads parked side by side above the bed; the chosen one
   glows; the bed carries a lock (the firmware blocks its PID). */
function illPidPick(selN = 1, { compact = false } = {}) {
  const heads = HEADS.map((h, i) => headSvg(70 + i * 90, 46, h, { hot: i === selN, sel: !compact && i === selN, scale: 1 })).join("");
  return `<svg class="${compact ? "" : "big"}" viewBox="${compact ? "20 22 360 240" : "0 0 400 300"}" role="img" aria-label="U1">
    ${compact ? "" : `<rect x="14" y="14" width="372" height="272" rx="18" ${st("fill:var(--card-bg);stroke:var(--ill-mid);stroke-width:1.5")}/>`}
    <path d="M30 34h340" ${st("stroke:var(--ill-mid);stroke-width:5;stroke-linecap:round")}/>
    ${[0, 1, 2, 3].map((i) => `<path d="M${55 + i * 90} 34v10M${85 + i * 90} 34v10" ${st("stroke:var(--ill-mid);stroke-width:3;stroke-linecap:round")}/>`).join("")}
    ${heads}
    <g ${compact ? "" : 'opacity=".55"'}>
      <rect x="50" y="232" width="300" height="16" rx="4" ${st("fill:var(--ill-soft);stroke:var(--ill-line);stroke-width:1.4")}/>
      <path d="M62 252h276" ${st("stroke:var(--ill-mid);stroke-width:5;stroke-linecap:round")}/>
      ${compact ? "" : `<g transform="translate(200 240)"><circle r="13" ${st("fill:var(--card-bg);stroke:var(--ill-line);stroke-width:1.4")}/>
        <path d="M-5-1v-3a5 5 0 0 1 10 0v3M-7-1h14v9h-14z" ${st("fill:none;stroke:var(--ill-line);stroke-width:1.6;stroke-linejoin:round")}/></g>`}
    </g>
    ${compact ? "" : `<text x="200" y="274" text-anchor="middle" style="font:500 11px var(--font-ui);fill:var(--text-secondary)">${T("Plateau : réglé en usine, verrouillé par le firmware", "Bed: factory-tuned, locked by the firmware")}</text>`}
  </svg>`;
}

/* Input shaper: top view, the head on its gantry, X and Y arrows, the
   accelerometer chip inside T0, vibration waves. */
function illShaper({ compact = false } = {}) {
  return `<svg class="${compact ? "" : "big"}" viewBox="0 0 400 300" role="img">
    <rect x="40" y="24" width="320" height="252" rx="16" ${st("fill:var(--card-bg);stroke:var(--ill-mid);stroke-width:1.5")}/>
    <rect x="76" y="58" width="248" height="190" rx="8" ${st("fill:var(--ill-soft);stroke:var(--ill-mid);stroke-width:1.2;stroke-dasharray:4 4")}/>
    <path d="M58 40v220M342 40v220" ${st("stroke:var(--ill-mid);stroke-width:5;stroke-linecap:round")}/>
    <path d="M58 132h284" ${st("stroke:var(--ill-line);stroke-width:5;stroke-linecap:round")}/>
    <g transform="translate(200 132)">
      <path d="M-58 -22q6-8 12 0t12 0M-58 22q6-8 12 0t12 0M46 -22q6-8 12 0t12 0M46 22q6-8 12 0t12 0" ${st("stroke:var(--accent);stroke-width:1.8;fill:none;stroke-linecap:round;opacity:.7")}/>
      <rect x="-30" y="-26" width="60" height="52" rx="10" ${st("fill:var(--card-bg);stroke:var(--ill-line);stroke-width:1.8")}/>
      <rect x="-24" y="-20" width="48" height="8" rx="4" style="fill:${HEADS[0].c};stroke:var(--ill-line);stroke-width:.8"/>
      <rect x="-9" y="-3" width="18" height="16" rx="3" ${st("fill:var(--heat)")}/>
      <path d="M-5 1h10M-5 5h10M-5 9h10" ${st("stroke:#fff;stroke-width:1.2;opacity:.8")}/>
      <text x="0" y="40" text-anchor="middle" style="font:600 11px var(--font-ui);fill:var(--text-secondary)">T0</text>
    </g>
    <g ${st("stroke:var(--accent);stroke-width:2.4;fill:none;stroke-linecap:round;stroke-linejoin:round")}>
      <path d="M120 200h160M128 192l-8 8 8 8M272 192l8 8-8 8"/>
      <path d="M302 92v128M294 100l8-8 8 8M294 212l8 8 8-8"/>
    </g>
    <text x="200" y="224" text-anchor="middle" style="font:700 14px var(--font-ui);fill:var(--accent)">X</text>
    <text x="322" y="160" text-anchor="middle" style="font:700 14px var(--font-ui);fill:var(--accent)">Y</text>
    ${compact ? "" : `<g transform="translate(92 84)"><path d="M96 4 108 44" ${st("stroke:var(--heat);stroke-width:1.4")}/><rect x="0" y="-12" width="96" height="22" rx="11" ${st("fill:var(--card-bg);stroke:var(--heat);stroke-width:1.4")}/>
      <text x="48" y="3" text-anchor="middle" style="font:600 10.5px var(--font-ui);fill:var(--text)">${T("accéléromètre", "accelerometer")}</text></g>`}
  </svg>`;
}

/* XYZ offsets: each nozzle in turn touches the edge of a fixed reference
   at the back left (10 points); the contact sensor in its head feels each
   touch and the U1 fits the circle's centre (PROBE_XYZ_OFFSET_CALIBRATE,
   PROBE_POINTS=10). The exact shape of the reference is inferred. */
function illXyz({ compact = false } = {}) {
  const R = 78;
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2;
    return `<circle cx="${(200 + R * Math.cos(a)).toFixed(1)}" cy="${(150 + R * Math.sin(a)).toFixed(1)}" r="5" style="fill:var(--accent);stroke:var(--card-bg);stroke-width:1.5"/>`;
  }).join("");
  return `<svg class="${compact ? "" : "big"}" viewBox="0 0 400 300" role="img">
    <rect x="96" y="46" width="208" height="208" rx="26" ${st("fill:var(--ill-metal);opacity:.35")}/>
    <circle cx="200" cy="150" r="${R + 6}" ${st("fill:var(--card-bg);stroke:var(--ill-line);stroke-width:2")}/>
    <circle cx="200" cy="150" r="${R}" ${st("fill:var(--ill-soft);stroke:var(--ill-mid);stroke-width:1.2")}/>
    <path d="M188 150h24M200 138v24" ${st("stroke:var(--success);stroke-width:1.6")}/>
    <circle cx="200" cy="150" r="4" ${st("fill:var(--success)")}/>
    ${pts}
    <g transform="translate(${200 + R - 16} 150)"><circle r="14" ${st("fill:#d08a46;stroke:var(--ill-line);stroke-width:1.4")}/><circle r="5" ${st("fill:var(--ill-metal);stroke:var(--ill-line);stroke-width:1")}/></g>
    <path d="M${200 + R - 30} 150h-40" ${st("stroke:var(--accent);stroke-width:2;stroke-linecap:round;stroke-dasharray:2 4")}/>
    ${compact ? "" : `<text x="200" y="32" text-anchor="middle" style="font:600 11px var(--font-ui);fill:var(--text-secondary)">${T("Repère de calibration, arrière gauche (vu de dessus)", "Calibration reference, back left (top view)")}</text>
    <path d="M${200 + R - 6} 162 330 214" style="stroke:var(--ill-line);stroke-width:1"/><text x="336" y="226" text-anchor="middle" style="font:600 11px var(--font-ui);fill:var(--text-secondary)">${T("buse", "nozzle")}</text>
    <text x="200" y="280" text-anchor="middle" style="font:500 11px var(--font-ui);fill:var(--text-secondary)">${T("La buse touche le bord en 10 points → centre exact de chaque tête", "The nozzle touches the edge at 10 points → each head's exact centre")}</text>`}
  </svg>`;
}

/* Dynamic flow: a head over the purge chute, extruding; pressure arrows;
   the sensor reading the extrusion. */
function illFlow() {
  return `<svg viewBox="0 0 400 300" role="img">
    ${headSvg(200, 40, HEADS[1], { hot: false, scale: 1.4, label: false })}
    <path d="M200 166v54" ${st("stroke:" + HEADS[1].c + ";stroke-width:7;stroke-linecap:round")}/>
    <path d="M150 230h100l-14 40h-72z" ${st("fill:var(--ill-soft);stroke:var(--ill-line);stroke-width:1.6;stroke-linejoin:round")}/>
    <g ${st("stroke:var(--accent);stroke-width:2.2;fill:none;stroke-linecap:round")}>
      <path d="M118 90h34M118 110h34M118 130h34"/><path d="M146 84l8 6-8 6M146 104l8 6-8 6M146 124l8 6-8 6"/>
    </g>
  </svg>`;
}

/* Small checklist drawings (64 × 64). */
const PIC = {
  idle: `<svg class="pic" viewBox="0 0 64 64"><rect x="12" y="14" width="40" height="36" rx="6" ${st(LINE)}/><path d="M18 22h28M22 22v8M42 22v8" ${st(LINE)}/><rect x="24" y="30" width="16" height="9" rx="2" ${st(LINE)}/><path d="M18 44h28" ${st(LINE)}/><circle cx="48" cy="48" r="8" ${st("fill:var(--success)")}/><path d="m44.5 48 2.5 2.5 4.5-5" ${st("stroke:#fff;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round")}/></svg>`,
  clean: `<svg class="pic" viewBox="0 0 64 64"><rect x="20" y="10" width="20" height="20" rx="3" ${st(LINE)}/><rect x="24" y="30" width="12" height="7" rx="1.5" ${st("fill:var(--ill-metal);stroke:var(--ill-line);stroke-width:1.4")}/><path d="M27 37h6l-3 5z" ${st("fill:var(--ill-metal);stroke:var(--ill-line);stroke-width:1.4;stroke-linejoin:round")}/><g transform="rotate(-25 44 48)"><rect x="34" y="44" width="24" height="6" rx="2" ${st("fill:var(--accent);opacity:.85")}/><path d="M36 50v6M39 50v6M42 50v6M45 50v6M48 50v6" ${st("stroke:var(--ill-line);stroke-width:1.2")}/></g><path d="M14 44l3 3M12 52h4M18 56l2-3" ${st("stroke:var(--accent);stroke-width:1.6;stroke-linecap:round")}/></svg>`,
  fan: `<svg class="pic" viewBox="0 0 64 64"><circle cx="32" cy="32" r="20" ${st(LINE)}/><circle cx="32" cy="32" r="4" ${st("fill:var(--ill-line)")}/><path d="M32 28c-2-8 2-13 8-12 3 6-2 10-8 12M36 32c8-2 13 2 12 8-6 3-10-2-12-8M32 36c2 8-2 13-8 12-3-6 2-10 8-12M28 32c-8 2-13-2-12-8 6-3 10 2 12 8" ${st("fill:var(--ill-mid);stroke:var(--ill-line);stroke-width:1.2")}/><path d="M12 52 52 12" ${st("stroke:var(--text-secondary);stroke-width:2.2;stroke-linecap:round")}/></svg>`,
  hands: `<svg class="pic" viewBox="0 0 64 64"><path d="M22 52V30a3 3 0 0 1 6 0v10V22a3 3 0 0 1 6 0v18V24a3 3 0 0 1 6 0v18-12a3 3 0 0 1 6 0v14c0 8-5 12-12 12h-4c-4 0-6-2-8-6" ${st(LINE)}/><path d="M10 18q3-4 0-8M16 20q3-4 0-8" ${st("stroke:var(--heat);stroke-width:1.8;fill:none;stroke-linecap:round")}/><circle cx="32" cy="32" r="27" ${st("fill:none;stroke:var(--danger);stroke-width:2.4")}/><path d="M13 13l38 38" ${st("stroke:var(--danger);stroke-width:2.4;stroke-linecap:round")}/></svg>`,
  noise: `<svg class="pic" viewBox="0 0 64 64"><path d="M12 26h8l12-10v32L20 38h-8z" ${st(LINE)}/><path d="M40 24q6 8 0 16M46 18q11 14 0 28" ${st("stroke:var(--accent);stroke-width:2;fill:none;stroke-linecap:round")}/></svg>`,
  bed: `<svg class="pic" viewBox="0 0 64 64"><path d="M8 40 32 28l24 12-24 12z" ${st(LINE)}/><path d="M20 30l-4-8M44 30l4-8M32 22V12" ${st("stroke:var(--success);stroke-width:2;stroke-linecap:round")}/></svg>`,
  home: `<svg class="pic" viewBox="0 0 64 64"><path d="M14 30 32 14l18 16M20 26v22h24V26" ${st(LINE)}/><path d="M30 48V38h4v10" ${st(LINE)}/><path d="M8 54h48" ${st("stroke:var(--accent);stroke-width:2;stroke-linecap:round;stroke-dasharray:3 4")}/></svg>`,
  screen: `<svg class="pic" viewBox="0 0 64 64"><rect x="10" y="14" width="44" height="30" rx="4" ${st(LINE)}/><path d="M26 50h12M32 44v6" ${st(LINE)}/><path d="M22 29h20" ${st("stroke:var(--danger);stroke-width:2.4;stroke-linecap:round")}/><circle cx="32" cy="29" r="10" ${st("fill:none;stroke:var(--danger);stroke-width:2")}/></svg>`,
};

/* Temperature during a PID run: heat-up, then the relay cycles around the
   target (Klipper's autotune switches the heater full on / off). */
function chartPid({ w = 520, h = 300, target = 220, at = 0.62 } = {}) {
  const pad = { l: 40, r: 14, t: 18, b: 28 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const tMin = 20, tMax = 245;
  const y = (t) => pad.t + ih * (1 - (t - tMin) / (tMax - tMin));
  const pts = [];
  const N = 220;
  for (let i = 0; i <= N; i++) {
    const x = i / N;
    let t;
    if (x < 0.22) t = 25 + (target - 25) * (1 - Math.exp(-x * 13)) / (1 - Math.exp(-0.22 * 13));
    else t = target + 2 + 7 * Math.sin(((x - 0.22) / 0.78) * 2 * Math.PI * 6) * (0.92 + 0.08 * Math.cos(x * 9));
    pts.push([pad.l + x * iw, y(t)]);
  }
  const cut = Math.round(at * N);
  const path = (a) => a.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
  const done = pts.slice(0, cut + 1), rest = pts.slice(cut);
  const now = pts[cut];
  const grid = [50, 100, 150, 200].map((t) => `<path class="grid" d="M${pad.l} ${y(t)}H${w - pad.r}"/><text x="${pad.l - 6}" y="${y(t) + 3}" text-anchor="end">${t}°</text>`).join("");
  const mins = [0, 1, 2, 3, 4, 5].map((m) => `<text x="${pad.l + (m / 5) * iw}" y="${h - 8}" text-anchor="middle">${m} min</text>`).join("");
  return `<svg class="chart big" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="pidfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--heat)" stop-opacity=".22"/><stop offset="1" stop-color="var(--heat)" stop-opacity="0"/></linearGradient></defs>
    ${grid}${mins}
    <rect x="${pad.l}" y="${y(target + 7)}" width="${iw}" height="${y(target - 7) - y(target + 7)}" style="fill:var(--accent-soft)"/>
    <path d="M${pad.l} ${y(target)}H${w - pad.r}" style="stroke:var(--accent);stroke-width:1.6;stroke-dasharray:6 5"/>
    <text x="${w - pad.r - 4}" y="${y(target) - 6}" text-anchor="end" style="fill:var(--accent);font-weight:600">${T("cible", "target")} ${target} °C</text>
    <path d="${path(done)}L${now[0]} ${pad.t + ih}L${pad.l} ${pad.t + ih}z" style="fill:url(#pidfill)"/>
    <path d="${path(done)}" style="fill:none;stroke:var(--heat);stroke-width:2.4;stroke-linejoin:round"/>
    <path d="${path(rest)}" style="fill:none;stroke:var(--ill-mid);stroke-width:1.6;stroke-dasharray:3 5"/>
    <circle cx="${now[0]}" cy="${now[1]}" r="6" style="fill:var(--card-bg);stroke:var(--heat);stroke-width:3"/>
    <path class="axis" d="M${pad.l} ${pad.t + ih}H${w - pad.r}"/>
  </svg>`;
}

/* Frequency response from the shaper CSV: measured vibration, then what
   is left after the chosen shaper; the recommended frequency marked. */
function chartShaper(axis, f0, { w = 520, h = 190 } = {}) {
  const pad = { l: 12, r: 10, t: 14, b: 24 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const fx = (f) => pad.l + (f / 120) * iw;
  const psd = (f) => 0.05 + 0.95 * Math.exp(-((f - f0 - 2) ** 2) / 60) + 0.28 * Math.exp(-((f - f0 * 1.9) ** 2) / 90) + 0.06 * Math.sin(f / 3) ** 2;
  const shp = (f) => psd(f) * (1 - 0.92 * Math.exp(-((f - f0) ** 2) / 260)) * (f > f0 * 1.5 ? 0.45 : 1);
  const line = (fn) => Array.from({ length: 121 }, (_, f) => `${f ? "L" : "M"}${fx(f).toFixed(1)} ${(pad.t + ih * (1 - fn(f))).toFixed(1)}`).join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">
    ${[0, 20, 40, 60, 80, 100, 120].map((f) => `<text x="${fx(f)}" y="${h - 7}" text-anchor="middle">${f}</text>`).join("")}
    <path class="axis" d="M${pad.l} ${pad.t + ih}H${w - pad.r}"/>
    <path d="${line(psd)}L${fx(120)} ${pad.t + ih}L${fx(0)} ${pad.t + ih}z" style="fill:color-mix(in srgb, var(--warning) 18%, transparent)"/>
    <path d="${line(psd)}" style="fill:none;stroke:var(--warning);stroke-width:1.8"/>
    <path d="${line(shp)}" style="fill:none;stroke:var(--success);stroke-width:2.4"/>
    <path d="M${fx(f0)} ${pad.t - 2}V${pad.t + ih}" style="stroke:var(--accent);stroke-width:1.4;stroke-dasharray:4 4"/>
    <text x="${fx(f0) + 6}" y="${pad.t + 10}" style="fill:var(--accent);font-weight:700;font-size:11px;paint-order:stroke;stroke:var(--ill-bg);stroke-width:4">${String(f0).replace(".", T(",", "."))} Hz</text>
    <text x="${w - pad.r}" y="${pad.t + 8}" text-anchor="end" style="font-weight:700;fill:var(--text)">${axis}</text>
  </svg>`;
}

/* ------------------------------------------------------------ chrome */
function renderSide() {
  $("side-printers").innerHTML = `<button class="side-item"><span class="glyph" style="color:#34C759">${I.printer}</span><span class="lbl">U1</span><span class="led ${S.v === "refused" ? "busy" : "on"}"></span></button>
     <div class="side-group side-sub">
       <button class="side-item"><span class="glyph" style="color:#34C759">${I.spool}</span><span class="lbl">${T("Têtes et bobines", "Heads & Spools")}</span></button>
       <button class="side-item on"><span class="glyph" style="color:#8E8E93">${I.wrench}</span><span class="lbl">${T("Entretien et réglages", "Care & Tuning")}</span></button>
       <button class="side-item"><span class="glyph" style="color:#1E8CFF">${I.folder}</span><span class="lbl">${T("Fichiers", "Files")}</span><span class="count">14</span></button>
     </div>`;
  document.querySelectorAll(".side-item .lbl").forEach((l) => {
    const map = { "Explorer": "Explore", "Créer": "Create", "Fichiers": "Files", "Préparer": "Prepare", "Impressions": "Prints", "Ajouter une imprimante": "Add a Printer", "Réglages": "Settings" };
    if (!l.dataset.fr) l.dataset.fr = l.textContent;
    if (map[l.dataset.fr]) l.textContent = EN() ? map[l.dataset.fr] : l.dataset.fr;
  });
  document.querySelectorAll(".side-section").forEach((s) => (s.textContent = T("Imprimantes", "Printers")));
}
function toolbar() {
  const tabs = [["control", T("Contrôle", "Control")], ["care", T("Entretien", "Care")], ["level", T("Nivellement", "Bed Leveling")], ["calib", "Calibration"]];
  $("toolbar").innerHTML = `
    <div class="tb-title"><h1>U1</h1><span id="tb-sub">${T("Entretien et réglages", "Care & Tuning")}</span></div>
    <div class="tb-actions tb-tabs on"><div class="seg">${tabs.map(([k, t]) => `<button class="seg-btn labeled${k === "calib" ? " on" : ""}"><span>${t}</span></button>`).join("")}</div></div>
    <div class="tb-spacer"></div>
    <div class="tb-actions on"><button class="tb-btn" title="${T("Actualiser", "Refresh")}"><svg viewBox="0 0 24 24"><path d="M12 5a7 7 0 1 0 6.7 9h-2.1A5 5 0 1 1 12 7v3l4.5-4L12 2z"/></svg></button><span class="mk-tag">${T("Maquette · données d'exemple", "Mockup · sample data")}</span></div>`;
}
/* The status bar shared with Control: state, chips, busy, emergency stop. */
function statusBar({ state = "idle", label, chips = [], busy = "" } = {}) {
  label = label || T("Au repos", "Idle");
  return `<div class="ct-status">
    <span class="ct-state ${state}"><i></i><b>${label}</b></span>
    ${chips.map((c) => `<span class="ct-chip${c.warn ? " warn" : ""}">${c.t}</span>`).join("")}
    ${busy ? `<span class="ct-busy"><span class="spinner small"></span><span>${busy}</span></span>` : ""}
    <button class="ct-estop">${I.power}<span>${T("Arrêt d'urgence", "Emergency stop")}</span></button>
  </div>`;
}
function stepper(steps, on) {
  return `<div class="cw-steps">${steps.map((s, i) => `${i ? `<span class="cw-sep${i <= on ? " done" : ""}"></span>` : ""}<span class="cw-step${i < on ? " done" : i === on ? " on" : ""}"><i>${i < on ? "✓" : i + 1}</i>${s}</span>`).join("")}</div>`;
}
function wizard({ title, steps, on, art, side, foot }) {
  return `<div class="cw">
    <div class="cw-head"><span class="cw-back">${I.back}Calibration</span><h2>${title}</h2>${stepper(steps, on)}</div>
    <div class="cw-main"><div class="cw-art">${art}</div><div class="cw-side">${side}</div></div>
    <div class="cw-foot">${foot}</div>
  </div>`;
}
const page = (inner) => `<div class="prn"><section class="prn-main hv"><div class="cb">${inner}</div></section></div>`;
const PID_STEPS = () => [T("Choisir", "Choose"), T("Préparer", "Prepare"), T("Calibrer", "Calibrate"), T("Résultat", "Result")];
const IS_STEPS = () => [T("Préparer", "Prepare"), T("Mesurer", "Measure"), T("Résultat", "Result")];
const idleNote = () => `<span class="note">${I.clock}${T("Klipper coupe la chauffe après 5 min sans activité : l'assistant garde la main pendant la mesure.", "Klipper turns heaters off after 5 min of inactivity: the assistant keeps the printer busy during the measurement.")}</span>`;

/* ------------------------------------------------------------ home */
function card({ ill, title, badge = "", why, last, dur, btn = T("Lancer", "Start"), btnCls = "primary", off = false }) {
  return `<div class="cb-card${off ? " off" : ""}">
    <div class="cb-ill">${ill}${badge}</div>
    <div class="cb-body">
      <div class="cb-title"><b>${title}</b></div>
      <p class="cb-why">${why}</p>
      <div class="cb-meta"><span class="last">${last}</span><span class="dur">${I.clock}${dur}</span><button class="btn small ${btnCls}"${off ? " disabled" : ""}>${btn}</button></div>
    </div>
  </div>`;
}
function homeCards(off = false) {
  return `<div class="cb-grid">
    ${card({ off, ill: illShaper({ compact: true }), title: T("Compensation des vibrations", "Vibration compensation"),
      badge: `<span class="cb-badge">${T("Aussi sur l'écran de la U1", "Also on the U1 screen")}</span>`,
      why: T("Mesure comment X et Y vibrent pour des parois lisses à grande vitesse (input shaper).", "Measures how X and Y vibrate, for smooth walls at high speed (input shaper)."),
      last: T("Dernière : <b>X 54,2 Hz · Y 46,8 Hz</b> · 12 oct.", "Last: <b>X 54.2 Hz · Y 46.8 Hz</b> · Oct 12"), dur: "≈ 5 min" })}
    ${card({ off, ill: illFlow(), title: T("Débit dynamique (K)", "Dynamic flow (K)"),
      badge: `<span class="cb-badge">${T("Aussi au début d'une impression", "Also at print start")}</span>`,
      why: T("Règle la pression d'extrusion pour le filament chargé, tête par tête.", "Tunes extrusion pressure for the loaded filament, head by head."),
      last: T("Actuel : <b>T0 0,032 · T1 0,028 · T2 défaut · T3 0,041</b>", "Now: <b>T0 0.032 · T1 0.028 · T2 default · T3 0.041</b>"), dur: T("≈ 3 min 30 / tête", "≈ 3.5 min / head") })}
    ${card({ off, ill: illXyz({ compact: true }), title: T("Décalage entre les têtes", "Offset between heads"),
      badge: `<span class="cb-badge acc">${T("Lancement depuis l'écran", "Run from the screen")}</span>`,
      why: T("Aligne les 4 têtes entre elles pour des couleurs bien raccord. Snap Studio affiche le résultat.", "Lines the 4 heads up so colours meet cleanly. Snap Studio shows the result."),
      last: T("Dernière : <b>écart max 0,03 mm</b> · 2 oct.", "Last: <b>max gap 0.03 mm</b> · Oct 2"), dur: "15–20 min", btn: T("Voir", "View"), btnCls: "" })}
    ${card({ off, ill: illPidPick(1, { compact: true }), title: T("PID des buses", "Nozzle PID"),
      badge: `<span class="cb-badge adv">${T("Avancé", "Advanced")}</span>`,
      why: T("Stabilise la température d'une buse. Utile après un changement de hotend ou si elle oscille.", "Keeps a nozzle's temperature steady. Useful after a hotend swap or if it swings."),
      last: T("Dernière : <b>T2 · 23 oct.</b> · les autres : usine", "Last: <b>T2 · Oct 23</b> · others: factory"), dur: T("≈ 5 min / buse", "≈ 5 min / nozzle") })}
  </div>`;
}
function intro() {
  return `<div class="cb-intro">
    <svg class="ic" viewBox="0 0 24 24" style="fill:var(--accent)"><path d="M12 1 3 5v6c0 5.6 3.8 10.7 9 12 5.2-1.3 9-6.4 9-12V5zm-1.4 15.4-4-4L8 11l2.6 2.6L16 8.2l1.4 1.4z"/></svg>
    <div><b>${T("La U1 se calibre déjà en grande partie toute seule", "The U1 already calibrates most things by itself")}</b>
      <ul><li>${T("Nivellement avant chaque impression", "Bed mesh before every print")}</li><li>${T("Débit dynamique au début d'une impression (option de l'écran)", "Dynamic flow at print start (screen option)")}</li><li>${T("Résultats gardés dans la mémoire de l'imprimante", "Results kept in the printer's memory")}</li></ul>
      <p>${T("Ces assistants servent après un changement de pièce, un déménagement ou un défaut visible. Ils n'ont pas besoin de redémarrer Klipper.", "Use these assistants after a part swap, a move, or a visible defect. None of them restarts Klipper.")}</p></div>
  </div>`;
}
function renderHome() {
  $("view").innerHTML = page(`${statusBar({ chips: [{ t: T("4 têtes", "4 heads") }, { t: T("Origine faite", "Homed") }] })}
    ${intro()}${homeCards()}
    <div class="cb-foot">${I.info}${T("Une calibration à la fois, jamais pendant une impression. L'arrêt d'urgence reste toujours disponible.", "One calibration at a time, never during a print. The emergency stop is always available.")}</div>`);
}
function renderRefused() {
  $("view").innerHTML = page(`<div class="ct-status off-status" role="status" style="margin-bottom:0">
      <span class="ct-state printing"><i></i><b>${T("Impression en cours (62 %)", "Printing (62%)")}</b></span>
      <span class="off-why">${T("Calibration indisponible pendant une impression. Elle reviendra quand U1 sera au repos.", "Calibration is unavailable during a print. It comes back when U1 is idle.")}</span>
      <button class="btn small">${T("Voir l'impression", "View the print")}</button>
      <button class="ct-estop">${I.power}<span>${T("Arrêt d'urgence", "Emergency stop")}</span></button>
    </div>
    <div class="mt-stale"><span class="mt-stale-dot"></span><span>${T("Résultats lus à 16:20 · Support casque, fin vers 18:18", "Results read at 4:20 PM · Helmet stand, ends around 6:18 PM")}</span></div>
    ${homeCards(true)}`);
}

/* ------------------------------------------------------------ PID */
function headsPicker(sel) {
  return `<div class="cb-heads">${HEADS.map((h) => `<div class="cb-head${h.n === sel ? " on" : ""}" style="--c:${h.c}"><i></i><b>T${h.n}</b><small>${T(h.name, h.en)}</small></div>`).join("")}</div>`;
}
function renderPidChoose() {
  $("view").innerHTML = page(`${statusBar({ chips: [{ t: T("4 têtes", "4 heads") }] })}${wizard({
    title: T("PID des buses", "Nozzle PID"), steps: PID_STEPS(), on: 0,
    art: `${illPidPick(1)}<div class="cw-cap">${T("Touche une buse sur le dessin ou dans la liste.", "Tap a nozzle in the drawing or in the list.")}</div>`,
    side: `<h3>${T("Quelle buse calibrer ?", "Which nozzle?")}</h3>
      <p class="lead">${T("La buse chauffe, puis Klipper coupe et relance la chauffe plusieurs fois pour apprendre comment elle réagit.", "The nozzle heats; Klipper then switches the heater off and on a few times to learn how it reacts.")}</p>
      <div class="cw-field"><span class="cw-k">${T("Buse", "Nozzle")}</span>${headsPicker(1)}</div>
      <div class="cw-field"><span class="cw-k">${T("Température de mesure", "Measurement temperature")}</span>
        <div class="seg full"><button class="seg-btn on">PLA <small>220°</small></button><button class="seg-btn">PETG <small>250°</small></button><button class="seg-btn">ABS·ASA <small>270°</small></button><button class="seg-btn">TPU <small>230°</small></button></div>
        <div class="cb-range"><input type="range" min="180" max="300" value="220" /><b>220 °C</b></div>
        <span class="hint">${T("Choisis la température à laquelle tu imprimes le plus avec cette buse. Proposée d'après le filament chargé : PLA Orange.", "Pick the temperature you print at most with this nozzle. Suggested from the loaded filament: Orange PLA.")}</span></div>
      <label class="cb-switch"><span>${T("Les 4 buses à la suite", "All 4 nozzles in a row")}<small>${T("Une après l'autre, à la même température · ≈ 20 min", "One after the other, same temperature · ≈ 20 min")}</small></span><input type="checkbox" class="sw" role="switch" /></label>`,
    foot: `<span class="note">${I.info}${T("Le plateau n'est pas proposé : la U1 bloque son PID (réglé en usine).", "The bed is not offered: the U1 locks its PID (factory-tuned).")}</span><span class="grow"></span><button class="btn lg">${T("Annuler", "Cancel")}</button><button class="btn lg primary">${T("Suivant", "Next")}</button>`,
  })}`);
}
function check(pic, title, text, state) {
  const tick = state === "auto" ? `<span class="cb-tick">✓</span>` : state === "box" ? `<span class="cb-tick box">✓</span>` : `<span class="cb-tick todo"></span>`;
  return `<div class="cb-check">${PIC[pic]}<div class="t"><b>${title}</b><small>${text}</small>${state === "auto" ? `<span class="cb-auto">${T("Vérifié par Snap Studio", "Checked by Snap Studio")}</span>` : ""}</div>${tick}</div>`;
}
function pidPrepareSide() {
  return `<h3>${T("Avant de lancer", "Before you start")}</h3>
    <p class="lead">${T("Quatre points, et la mesure sera fiable. T1 · 220 °C · ≈ 5 min.", "Four points for a reliable measurement. T1 · 220 °C · ≈ 5 min.")}</p>
    <div class="cb-checks">
      ${check("idle", T("Imprimante au repos", "Printer idle"), T("Aucune impression, pause ni procédure en cours.", "No print, pause or routine running."), "auto")}
      ${check("clean", T("Buse propre", "Clean nozzle"), T("Retire le filament collé autour de la buse T1.", "Remove filament stuck around nozzle T1."), "box")}
      ${check("fan", T("Ventilateur de pièce coupé", "Part fan off"), T("Snap Studio le coupe pendant la mesure, puis le remet comme avant.", "Snap Studio turns it off during the measurement, then restores it."), "auto")}
      ${check("hands", T("Ne touche pas la tête", "Don't touch the head"), T("Elle monte à 220 °C. Ne lance rien sur l'écran tactile en même temps.", "It goes up to 220 °C. Don't start anything on the touchscreen meanwhile."), "todo")}
    </div>`;
}
function renderPidPrepare(modal = false) {
  $("view").innerHTML = page(`${statusBar({ chips: [{ t: T("4 têtes", "4 heads") }] })}${wizard({
    title: T("PID des buses", "Nozzle PID"), steps: PID_STEPS(), on: 1,
    art: `${illPidPick(1)}<div class="cw-cap">${T("T1 chauffera seule, dans son support. Les autres têtes restent froides.", "T1 heats alone, in its dock. The other heads stay cold.")}</div>`,
    side: pidPrepareSide(),
    foot: `${idleNote()}<span class="grow"></span><button class="btn lg">${T("Retour", "Back")}</button><button class="btn lg primary">${T("Lancer la calibration", "Start calibration")}</button>`,
  })}`);
  $("modal").innerHTML = modal ? `<div class="modal static"><div class="modal-box">
      <div class="cb-mhead"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" style="fill:color-mix(in srgb, var(--heat) 16%, transparent)"/><path d="M20 12h8v15a7 7 0 1 1-8 0z" style="fill:none;stroke:var(--heat);stroke-width:2.4;stroke-linejoin:round"/><circle cx="24" cy="32" r="3.5" style="fill:var(--heat)"/></svg>
        <div><h3>${T("Lancer la calibration PID de T1 ?", "Start the PID calibration of T1?")}</h3><p style="margin-top:4px">${T("T1 va chauffer à 220 °C et osciller autour pendant environ 5 minutes.", "T1 will heat to 220 °C and swing around it for about 5 minutes.")}</p></div></div>
      <div class="cb-info warn">${I.warn}<span>${T("<b>Le résultat remplace aussitôt les réglages actuels de T1</b> dans la mémoire de l'imprimante. Snap Studio garde les anciennes valeurs pour te les montrer, mais ne peut pas les remettre lui-même.", "<b>The result immediately replaces T1's current settings</b> in the printer's memory. Snap Studio keeps the old values to show them, but cannot put them back itself.")}</span></div>
      <ul><li>${T("Pas de redémarrage de Klipper.", "Klipper does not restart.")}</li><li>${T("Tu peux annuler à tout moment : les anciens réglages restent alors en place.", "You can cancel at any time: the old settings then stay.")}</li></ul>
      <div class="modal-actions"><button class="btn">${T("Annuler", "Cancel")}</button><button class="btn primary">${T("Lancer", "Start")}</button></div>
    </div></div>` : "";
}
function renderPidRun() {
  $("view").innerHTML = page(`${statusBar({ state: "busy", label: T("Calibration", "Calibrating"), busy: T("PID de T1 à 220 °C…", "T1 PID at 220 °C…") })}${wizard({
    title: T("PID des buses", "Nozzle PID"), steps: PID_STEPS(), on: 2,
    art: `${chartPid()}<div class="cw-cap">${T("Température de T1 en direct. Les vagues autour de la cible sont normales : c'est la mesure.", "T1's live temperature. The waves around the target are expected: that is the measurement.")}</div>`,
    side: `<h3>${T("Calibration de T1 en cours", "Calibrating T1")}</h3>
      <div class="cb-live"><b>221,4 °C</b><span>${T("cible 220 °C", "target 220 °C")}</span></div>
      <div class="cb-prog"><i style="width:62%"></i></div>
      <div class="cb-facts"><div><small>${T("Écoulé", "Elapsed")}</small><b>3 min 06</b></div><div><small>${T("Reste environ", "About")}</small><b>${T("2 min", "2 min left")}</b></div><div><small>${T("Cycles", "Cycles")}</small><b>3 / 6</b></div></div>
      <div class="cb-phases">
        <div class="done"><i>✓</i>${T("Chauffe jusqu'à 220 °C", "Heat to 220 °C")}</div>
        <div class="now"><i></i>${T("Cycles de mesure autour de la cible", "Measurement cycles around the target")}</div>
        <div><i></i>${T("Calcul et enregistrement des réglages", "Compute and store the settings")}</div>
      </div>
      <div class="cb-info">${I.info}<span>${T("Tu peux quitter cet onglet : la mesure continue sur l'imprimante et le résultat t'attendra ici.", "You can leave this tab: the measurement goes on in the printer and the result will wait for you here.")}</span></div>`,
    foot: `${idleNote()}<span class="grow"></span><button class="btn lg danger">${T("Annuler la calibration", "Cancel calibration")}</button>`,
  })}`);
}
function renderPidResult() {
  $("view").innerHTML = page(`${statusBar({ chips: [{ t: T("T1 refroidit · 84 °C", "T1 cooling · 84 °C") }] })}${wizard({
    title: T("PID des buses", "Nozzle PID"), steps: PID_STEPS(), on: 3,
    art: `${chartPid({ at: 1 })}<div class="cw-cap">${T("Mesure terminée en 5 min 12 · 6 cycles", "Measured in 5 min 12 s · 6 cycles")}</div>`,
    side: `<div class="cb-ok"><i>✓</i><div><b>${T("Nouveaux réglages de T1 enregistrés", "New T1 settings saved")}</b><small>${T("Déjà actifs dans l'imprimante · aucun redémarrage", "Already active in the printer · no restart")}</small></div></div>
      <p class="cb-plain">${T("T1 réagit <b>un peu plus doucement</b> qu'avant : sa température devrait rester à <b>±1 °C</b> de la cible pendant l'impression, sans dépasser.", "T1 now reacts <b>a little more gently</b>: its temperature should stay within <b>±1 °C</b> of the target while printing, without overshooting.")}</p>
      <div class="cb-table">
        <div class="r"><span>${T("Réglage", "Setting")}</span><span class="num">${T("Avant", "Before")}</span><span class="num">${T("Nouveau", "New")}</span><span class="cb-delta">${T("Écart", "Change")}</span></div>
        <div class="r"><span><b>Kp</b><small>${T("Force de la réaction", "Reaction strength")}</small></span><span class="num">${T("33,540", "33.540")}</span><span class="num"><b>${T("31,822", "31.822")}</b></span><span class="cb-delta">−5 %</span></div>
        <div class="r"><span><b>Ki</b><small>${T("Correction de l'écart dans la durée", "Correction over time")}</small></span><span class="num">${T("9,317", "9.317")}</span><span class="num"><b>${T("8,904", "8.904")}</b></span><span class="cb-delta">−4 %</span></div>
        <div class="r"><span><b>Kd</b><small>${T("Anticipation des variations", "Anticipation of changes")}</small></span><span class="num">${T("30,186", "30.186")}</span><span class="num"><b>${T("28,431", "28.431")}</b></span><span class="cb-delta">−6 %</span></div>
      </div>
      <span class="hint">${T("« Avant » : valeurs d'usine lues dans la configuration de la U1, gardées dans l'historique de Snap Studio.", "“Before”: factory values read from the U1's configuration, kept in Snap Studio's history.")}</span>`,
    foot: `<span class="note">${I.save}${T("Pas besoin de SAVE_CONFIG : la U1 garde ce réglage elle-même.", "No SAVE_CONFIG needed: the U1 keeps this setting itself.")}</span><span class="grow"></span><button class="btn lg">${T("Calibrer une autre buse", "Calibrate another nozzle")}</button><button class="btn lg primary">${T("Terminer", "Done")}</button>`,
  })}`);
}

/* ------------------------------------------------------------ input shaper */
function renderIsPrepare() {
  $("view").innerHTML = page(`${statusBar({ chips: [{ t: T("Origine faite", "Homed") }] })}${wizard({
    title: T("Compensation des vibrations", "Vibration compensation"), steps: IS_STEPS(), on: 0,
    art: `${illShaper()}<div class="cw-cap">${T("La tête T0 secoue l'axe X puis l'axe Y de 5 à 100 Hz. Son accéléromètre mesure les vibrations.", "Head T0 shakes the X axis, then Y, from 5 to 100 Hz. Its accelerometer measures the vibrations.")}</div>`,
    side: `<h3>${T("Comment ça marche", "How it works")}</h3>
      <p class="lead">${T("Chaque axe a une fréquence où il vibre le plus. Klipper la trouve et ajoute un filtre qui l'efface : moins de vagues sur les parois.", "Each axis has a frequency where it vibrates most. Klipper finds it and adds a filter that cancels it: fewer ripples on walls.")}</p>
      <div class="cb-checks">
        ${check("idle", T("Imprimante au repos", "Printer idle"), T("Aucune impression ni procédure en cours.", "No print or routine running."), "auto")}
        ${check("bed", T("Plateau dégagé", "Clear bed"), T("Rien sur le plateau ni sur le trajet de la tête.", "Nothing on the bed or in the head's way."), "box")}
        ${check("home", T("Origine et tête T0", "Homing and head T0"), T("La U1 fait son origine si besoin et prend T0 toute seule.", "The U1 homes if needed and picks T0 by itself."), "auto")}
        ${check("noise", T("Ça fait du bruit", "It gets loud"), T("Bourdonnement fort pendant 3 à 5 min : c'est normal.", "Loud buzzing for 3 to 5 min: that's normal.") , "todo")}
      </div>
      <div class="cb-info">${I.screen}<span>${T("C'est la même mesure que <b>Réglages › Maintenance › Calibration de l'appareil › Compensation des vibrations</b> sur l'écran de la U1.", "It is the same measurement as <b>Settings › Maintenance › Device Calibration › Vibration Compensation</b> on the U1 screen.")}</span></div>`,
    foot: `${idleNote()}<span class="grow"></span><button class="btn lg">${T("Annuler", "Cancel")}</button><button class="btn lg primary">${T("Lancer · ≈ 5 min", "Start · ≈ 5 min")}</button>`,
  })}`);
}
function renderIsResult() {
  $("view").innerHTML = page(`${statusBar({ chips: [{ t: T("Origine faite", "Homed") }] })}${wizard({
    title: T("Compensation des vibrations", "Vibration compensation"), steps: IS_STEPS(), on: 2,
    art: `<div style="display:flex;flex-direction:column;gap:12px">${chartShaper("X", 54.2)}${chartShaper("Y", 46.8)}</div>
      <div class="cw-cap"><span style="color:var(--warning)">■</span> ${T("vibrations mesurées", "measured vibrations")} &nbsp; <span style="color:var(--success)">■</span> ${T("après le filtre", "after the filter")} &nbsp; · ${T("fréquence en Hz", "frequency in Hz")}</div>`,
    side: `<div class="cb-ok"><i>✓</i><div><b>${T("Filtres appliqués et enregistrés", "Filters applied and saved")}</b><small>${T("Par la U1 elle-même · aucun redémarrage", "By the U1 itself · no restart")}</small></div></div>
      <div class="cb-shaper">
        <div><small>${T("Axe X", "X axis")}</small><b>${T("54,2 Hz", "54.2 Hz")}</b><span>${T("filtre MZV · avant 54,0 Hz", "MZV filter · was 54.0 Hz")}</span></div>
        <div><small>${T("Axe Y", "Y axis")}</small><b>${T("46,8 Hz", "46.8 Hz")}</b><span>${T("filtre MZV · avant 47,5 Hz", "MZV filter · was 47.5 Hz")}</span></div>
      </div>
      <p class="cb-plain">${T("Les deux axes vibrent surtout <b>vers 55 Hz et 47 Hz</b>, comme prévu pour une U1. Les filtres réduisent ces vibrations d'environ <b>90 %</b> : les parois resteront lisses aux vitesses actuelles.", "Both axes vibrate mostly <b>around 55 Hz and 47 Hz</b>, as expected for a U1. The filters cut these vibrations by about <b>90%</b>: walls stay smooth at the current speeds.")}</p>
      <div class="cb-info">${I.info}<span>${T("La U1 garde toujours le filtre <b>MZV</b> et limite la fréquence à sa plage d'usine (X 47,5–62,5 Hz, Y 43–54 Hz).", "The U1 always keeps the <b>MZV</b> filter and limits the frequency to its factory range (X 47.5–62.5 Hz, Y 43–54 Hz).")}</span></div>`,
    foot: `<span class="note">${I.save}${T("Mesures du 28 oct. 10:42 enregistrées dans l'historique.", "Measured Oct 28, 10:42 AM, kept in the history.")}</span><span class="grow"></span><button class="btn lg">${T("Revenir aux anciennes valeurs", "Restore previous values")}</button><button class="btn lg primary">${T("Terminer", "Done")}</button>`,
  })}`);
}

/* ------------------------------------------------------------ XYZ */
function renderXyz() {
  const rows = [[0, "0,000", "0,000", "0,000"], [1, "+0,012", "−0,021", "+0,008"], [2, "−0,018", "+0,009", "−0,004"], [3, "+0,027", "+0,014", "+0,011"]];
  $("view").innerHTML = page(`${statusBar({ chips: [{ t: T("4 têtes", "4 heads") }] })}${wizard({
    title: T("Décalage entre les têtes", "Offset between heads"), steps: [T("Résultat actuel", "Current result")], on: 0,
    art: `${illXyz()}<div class="cw-cap">${T("Le capteur de contact de chaque tête sent quand la buse touche ; la U1 en déduit sa position par rapport à T0.", "Each head\'s contact sensor feels when the nozzle touches; the U1 works out its position relative to T0.")}</div>`,
    side: `<h3>${T("Têtes alignées", "Heads aligned")} <span class="cb-badge ok" style="vertical-align:3px">${T("écart max 0,03 mm", "max gap 0.03 mm")}</span></h3>
      <p class="lead">${T("Dernière calibration le 2 oct. Écart par rapport à T0, en millimètres :", "Last calibrated Oct 2. Offset from T0, in millimetres:")}</p>
      <div class="cb-off"><div>${T("Tête", "Head")}</div><div>X</div><div>Y</div><div>Z</div>${rows.map(([n, x, y, z]) => `<div><i style="--c:${HEADS[n].c}"></i>T${n}</div><div>${x}</div><div>${y}</div><div>${z}</div>`).join("")}</div>
      <div class="cw-field"><span class="cw-k">${T("Pour recalibrer (15–20 min)", "To recalibrate (15–20 min)")}</span>
        <ol class="cb-steps-list">
          <li><span>${T("Retire le filament des 4 têtes et nettoie le bout des buses.", "Unload all 4 heads and clean the nozzle tips.")}</span></li>
          <li><span>${T("Sur l'écran de la U1 : <b>Réglages › Calibration de l'appareil › Calibration du décalage multi-têtes</b>.", "On the U1 screen: <b>Settings › Device Calibration › Multi-toolhead Offset Calibration</b>.")}</span></li>
          <li><span>${T("Snap Studio affichera le nouveau résultat ici.", "Snap Studio will show the new result here.")}</span></li>
        </ol></div>
      <div class="cb-info">${I.info}<span>${T("L'écran chauffe, nettoie et vérifie chaque buse avant de mesurer. Snap Studio ne lance pas cette mesure pour ne pas sauter ces étapes.", "The screen heats, cleans and checks each nozzle before measuring. Snap Studio doesn't start it, so none of those steps is skipped.")}</span></div>`,
    foot: `<span class="note">${I.info}${T("Recommandée après un changement de hotend ou un choc de buse.", "Recommended after a hotend swap or a nozzle crash.")}</span><span class="grow"></span><button class="btn lg primary">${T("Fermer", "Close")}</button>`,
  })}`);
}

/* ------------------------------------------------------------ switcher */
const VIEWS = {
  home: [renderHome, "Accueil"], "pid-choose": [renderPidChoose, "PID 1"], "pid-prepare": [() => renderPidPrepare(false), "PID 2"],
  "pid-confirm": [() => renderPidPrepare(true), "PID 2 + confirmation"], "pid-run": [renderPidRun, "PID 3"], "pid-result": [renderPidResult, "PID 4"],
  "is-prepare": [renderIsPrepare, "Vibrations 1"], "is-result": [renderIsResult, "Vibrations 3"], xyz: [renderXyz, "Décalage XYZ"], refused: [renderRefused, "Refus (impression)"],
};
function render() {
  document.documentElement.dataset.scheme = S.theme;
  document.documentElement.lang = S.lang;
  $("modal").innerHTML = "";
  renderSide();
  toolbar();
  (VIEWS[S.v] || VIEWS.home)[0]();
  const sw = (key, items) => `<div class="seg">${items.map(([v, t]) => `<button class="seg-btn${S[key] === v ? " on" : ""}" data-k="${key}" data-v="${v}">${t}</button>`).join("")}</div>`;
  $("switch").innerHTML = `${sw("v", Object.entries(VIEWS).map(([k, [, t]]) => [k, t]))}${sw("theme", [["light", "Clair"], ["dark", "Sombre"]])}${sw("lang", [["fr", "FR"], ["en", "EN"]])}`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-k]");
  if (!b) return;
  S[b.dataset.k] = b.dataset.v;
  history.replaceState(null, "", `?v=${S.v}&theme=${S.theme}&lang=${S.lang}`);
  render();
});
render();
