"use strict";
/* Spool check before sending.

   Before a sliced print leaves for the printer (Send, or Start from the
   queue), each head the G-code uses is compared with the spool loaded on
   it now. Expected: the material and color recorded at slice time (the
   slice's head profiles and spool colors), otherwise the G-code's own
   `filament_type` / `filament_colour`. Heads the print does not use are
   ignored. A different material family, a clearly different color, or an
   empty or unknown spool opens a sheet listing each head; the user cancels,
   sends anyway, or picks another loaded spool for that head.

   Material: compared by family, case-insensitive. "PLA", "PLA+", "PLA Matte",
   "PLA Silk", "PLA-CF" are all PLA; "PETG" and "PET" differ, as do "PC" and
   "PCTG". Unknown material on either side: not compared.
   Color: CIE76 distance in Lab; below SP_COLOR_TOL the spools match (a
   white and an off-white, two reds of different brands). Unknown color on
   either side: not compared.

   Substitution: the G-code tool is routed to the chosen head through the
   firmware's extruder map (SET_PRINT_EXTRUDER_MAP, sent before every print
   anyway). One tool per head; the G-code itself is not rewritten, so its
   temperatures stay those of the sliced material. */

const SP_COLOR_TOL = 25;
const SP_KEY = "snapstudio.spoolcheck.off";

/* Longest names first: PETG before PET, PCTG before PC, PPS before PP. */
const SP_FAMILIES = ["PETG", "PCTG", "PAHT", "PPSU", "PEBA", "BVOH", "HIPS", "PLA", "PET", "ABS", "ASA", "TPU", "TPE", "PVA", "PPS", "PEEK", "PEI", "PA", "PC", "PP", "PE"];
const SP_ALIASES = { NYLON: "PA", PA6: "PA", PA12: "PA", "PA-CF": "PA", PAHT: "PA", FLEX: "TPU" };

/* Family of a material ("PLA Matte" → "PLA"); "" when unknown. */
function spMaterialFamily(s) {
  const up = String(s || "").trim().toUpperCase();
  if (!up || up === "?") return "";
  const word = up.split(/[\s_\/+-]+/)[0];
  if (SP_ALIASES[word]) return SP_ALIASES[word];
  if (SP_ALIASES[up]) return SP_ALIASES[up];
  for (const f of SP_FAMILIES) if (word.startsWith(f) && (f !== "PE" || word === "PE")) return f;
  return word;
}

/* Material named in a filament profile ("Snapmaker PLA SnapSpeed @U1" →
   "PLA"), for profiles whose type is not known. */
function spMaterialFromName(name) {
  const words = String(name || "").replace(/@.*$/, "").toUpperCase().split(/[\s_\/()]+/);
  for (const w of words) {
    const base = w.replace(/\+$/, "");
    if (SP_ALIASES[base]) return SP_ALIASES[base];
    if (SP_FAMILIES.includes(base) || SP_FAMILIES.includes(base.split("-")[0])) return spMaterialFamily(base);
  }
  return "";
}

function spHex(hex) {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(hex || "").trim());
  return m ? "#" + m[1].toLowerCase() : "";
}
function spLab(hex) {
  const h = spHex(hex);
  if (!h) return null;
  const n = parseInt(h.slice(1), 16);
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const r = lin(n >> 16), g = lin((n >> 8) & 255), b = lin(n & 255);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
/* Perceptual distance (CIE76); Infinity when one color is unknown. */
function spColorDelta(a, b) {
  const x = spLab(a), y = spLab(b);
  if (!x || !y) return Infinity;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/* What each used G-code tool expects. `ftypeOf(profile name)` gives a
   profile's material when the caller knows its list. */
function spExpected({ tools, profile = {}, stats = {}, ftypeOf = () => "" }) {
  const list = tools?.length ? tools : [0];
  return [...new Set(list)].map((t) => {
    const prof = profile.filaments?.[t] || "";
    const material = spMaterialFamily(stats.filament_types?.[t]) || spMaterialFamily(ftypeOf(prof)) || spMaterialFromName(prof);
    const color = spHex(profile.colors?.[t]) || spHex(stats.filament_colors?.[t]);
    return { tool: t, material, color };
  });
}

/* Spool loaded on a head, as the printer reports it. */
function spLoaded(slots, head) {
  const s = (slots || []).find((x) => x.index === head);
  if (!s) return { head, state: "unknown", material: "", color: "" };
  if (!s.present) return { head, state: "empty", material: "", color: "" };
  const material = spMaterialFamily(s.kind);
  const label = [s.kind, s.sub_type].filter(Boolean).join(" ");
  return { head, state: material ? "ok" : "unknown", material, label, color: spHex(s.color), vendor: s.vendor || "" };
}

/* Reasons a loaded spool does not fit what a tool expects ([] = fits). */
function spReasons(exp, loaded) {
  if (loaded.state === "empty") return ["empty"];
  if (loaded.state === "unknown") return ["unknown"];
  const out = [];
  if (exp.material && loaded.material && exp.material !== loaded.material) out.push("material");
  if (exp.color && loaded.color && spColorDelta(exp.color, loaded.color) > SP_COLOR_TOL) out.push("color");
  return out;
}

/* Head printing each tool: its substitute, otherwise the same number. */
const spHeadOf = (tool, map = []) => (map.find(([t]) => t === tool) || [tool, tool])[1];

/* Tools whose head does not hold the expected spool, with the map applied. */
function spMismatches(expected, slots, map = []) {
  return expected
    .map((e) => {
      const loaded = spLoaded(slots, spHeadOf(e.tool, map));
      return { ...e, head: loaded.head, loaded, reasons: spReasons(e, loaded) };
    })
    .filter((m) => m.reasons.length);
}

/* Substitution from the user's picks ({ tool: head }): only real changes,
   one tool per head among the used tools, heads 0 to 3. Throws otherwise. */
function spRemap(tools, picks = {}) {
  const used = [...new Set(tools?.length ? tools : [0])];
  const map = used.filter((t) => picks[t] != null && +picks[t] !== t).map((t) => [t, +picks[t]]);
  for (const [t, h] of map) if (!Number.isInteger(h) || h < 0 || h > 3) throw new Error(`T${t}: no head ${h}`);
  const heads = used.map((t) => spHeadOf(t, map));
  const dup = heads.find((h, i) => heads.indexOf(h) !== i);
  if (dup != null) throw new Error(`two tools on head T${dup}`);
  return map;
}

/* Loaded spool that best replaces a tool's: one that fits fully (same
   material, then closest color) and no other used tool already prints from. */
function spSuggest(exp, slots, taken) {
  let best = null, bestD = Infinity;
  for (const s of slots || []) {
    if (!s.present || taken.has(s.index)) continue;
    const l = spLoaded(slots, s.index);
    if (spReasons(exp, l).length) continue;
    const d = exp.color && l.color ? spColorDelta(exp.color, l.color) : 0;
    if (d < bestD) {
      best = s.index;
      bestD = d;
    }
  }
  return best;
}

/* ------------------------------------------------------------ re-slicing */

/* Which action the sheet recommends: re-slicing when a head would print
   another material family than sliced (temperatures, flow and purge must
   follow), the substitution when it fixes everything or only colors differ. */
function spPrimary(bad, slots, map) {
  const fam = bad.some((m) => {
    const l = spLoaded(slots, spHeadOf(m.tool, map));
    return m.material && l.material && l.material !== m.material;
  });
  if (fam) return "reslice";
  return map.length ? "substitute" : "reslice";
}

/* Generic preset of a material family, when no preset fits the spool:
   "Generic …" first, then a system preset, then any. */
function spGenericPreset(family, list) {
  const same = (list || []).filter((p) => spMaterialFamily(p.ftype || spMaterialFromName(p.name)) === family);
  return (
    same.find((p) => /generic|générique/i.test(p.name) && !p.user) ||
    same.find((p) => !p.user) ||
    same[0] ||
    null
  )?.name || null;
}

/* Slice request for the same plate with the spools now chosen.
   `req`: the request of the first slice. `used`: its G-code tools (= heads
   at slice time). `picks`: { tool: head } chosen in the sheet. `tools`:
   the mismatched tools, whose head takes the spool loaded on it (the
   substitute, otherwise the one there now). `best(slot, list)`: preset of
   a spool, as when slicing from the printer's spools.
   → { request, heads: [{ tool, head, preset, generic }] }; throws when a
   head has no usable spool or no preset of its material. */
function spResliceRequest(req, { used, picks = {}, tools, slots, list, best }) {
  if (!req) throw new Error("no project");
  const map = spRemap(used, picks);
  const route = (h) => (used.includes(h) ? spHeadOf(h, map) : h);
  // An empty map sends the model to head 0: it only changes if T0 moves.
  const remapList = (m) => (m?.length ? m.map(route) : route(0) !== 0 ? [route(0)] : m || []);
  const out = JSON.parse(JSON.stringify(req));
  out.scene = (out.scene || []).map((it) => ({ ...it, extruder_map: remapList(it.extruder_map) }));
  if (!out.scene.length) out.extruder_map = remapList(out.extruder_map);
  out.filaments = [...(out.filaments || [])];
  out.colors = [...(out.colors || [])];
  const heads = [];
  for (const t of tools) {
    const h = spHeadOf(t, map);
    const slot = (slots || []).find((s) => s.index === h);
    if (!slot?.present) throw new Error(`T${h}: no spool`);
    let preset = best ? best(slot, list || []) : null;
    let generic = false;
    if (!preset) {
      preset = spGenericPreset(spMaterialFamily(slot.kind), list);
      generic = true;
    }
    if (!preset) throw new Error(`T${h}: no ${slot.kind || "?"} preset`);
    // Heads in between keep a preset: the engine needs one per head.
    for (let i = out.filaments.length; i < h; i++) out.filaments[i] = out.filaments[0] || preset;
    out.filaments[h] = preset;
    for (let i = out.colors.length; i < h; i++) out.colors[i] = null;
    out.colors[h] = spHex(slot.color) || null;
    heads.push({ tool: t, head: h, preset, generic });
  }
  return { request: out, heads };
}

if (typeof module !== "undefined") {
  module.exports = { SP_COLOR_TOL, spMaterialFamily, spMaterialFromName, spColorDelta, spExpected, spLoaded, spReasons, spMismatches, spRemap, spSuggest, spHeadOf, spPrimary, spGenericPreset, spResliceRequest };
}

/* ------------------------------------------------------------ the sheet */

const spEnabled = () => typeof localStorage === "undefined" || localStorage.getItem(SP_KEY) !== "1";
function spSetEnabled(on) {
  if (on) localStorage.removeItem(SP_KEY);
  else localStorage.setItem(SP_KEY, "1");
  const box = document.getElementById("set-spool-check");
  if (box) box.checked = on;
}

/* Material of a filament profile, from the lists already loaded. */
function spFtypeOf(pid) {
  const lists = [typeof HD !== "undefined" ? HD.listsNow?.[pid] : null, typeof SL !== "undefined" ? SL.lists?.filaments : null];
  return (name) => {
    for (const l of lists) {
      const p = (l || []).find((x) => x.name === name);
      if (p?.ftype) return p.ftype;
    }
    return "";
  };
}

/* "red PLA" / "PLA rouge"; parts left out when unknown. */
function spDescribe(material, color, fallback) {
  const c = color ? colorName(color) : "";
  if (!material && !c) return fallback;
  if (!c) return material;
  if (!material) return c;
  return tr("spool.desc", { mat: material, color: c });
}
function spLoadedText(l) {
  if (l.state === "empty") return tr("spool.loaded_empty");
  if (l.state === "unknown" && !l.color) return tr("spool.loaded_unknown");
  return tr("spool.loaded", { what: spDescribe(l.label || l.material, l.color, tr("spool.unknown")) });
}
function spLineText(m) {
  const exp = tr("spool.expected", { what: spDescribe(m.material, m.color, tr("spool.unknown")) });
  return tr("spool.line", { head: "T" + m.tool, expected: exp, loaded: spLoadedText(m.loaded) });
}

const spSwatch = (c) => `<i class="sp-sw${c ? "" : " none"}"${c ? ` style="--c:${esc(c)}"` : ""}></i>`;

/* Asks when the loaded spools differ from the slice's.
   → { map: [[tool, head]…] } to send (map empty: as sliced), or null. */
function spoolCheck({ pid, tools, profile, stats, slots, canReslice = false }) {
  const used = [...new Set(tools?.length ? tools : [0])];
  const expected = spExpected({ tools: used, profile, stats, ftypeOf: spFtypeOf(pid) });
  const bad = spMismatches(expected, slots);
  if (!bad.length || !spEnabled()) return Promise.resolve({ map: [] });

  // Picks: the head each mismatched tool will print from (own head = keep).
  const picks = {};
  const taken = new Set(used);
  for (const m of bad) {
    const s = spSuggest(m, slots, new Set([...taken].filter((h) => h !== m.tool)));
    if (s != null && s !== m.tool && !Object.values(picks).includes(s) && !used.includes(s)) picks[m.tool] = s;
  }

  const modal = $("spmodal");
  const render = () => {
    let map = [];
    try {
      map = spRemap(used, picks);
    } catch {}
    const headsNow = used.map((t) => spHeadOf(t, map));
    const after = spMismatches(expected, slots, map);
    $("sp-title").textContent = tr("spool.title", { n: bad.length });
    $("sp-list").innerHTML = bad
      .map((m) => {
        const cur = picks[m.tool] ?? m.tool;
        const opts = (slots || [])
          .filter((s) => s.present)
          .map((s) => {
            const l = spLoaded(slots, s.index);
            // Head already printing another tool: not offered.
            const busy = s.index !== cur && headsNow.includes(s.index);
            const fits = !spReasons(m, l).length;
            const label = spDescribe(l.label || l.material, l.color, tr("spool.unknown"));
            return `<button type="button" class="sp-opt${s.index === cur ? " on" : ""}${fits ? " fits" : ""}" data-tool="${m.tool}" data-head="${s.index}"${busy ? " disabled" : ""}
              title="${esc(busy ? tr("spool.head_busy") : label)}">${spSwatch(l.color)}<b>T${s.index}</b><span>${esc(label)}</span>${s.index === m.tool ? `<em>${esc(tr("spool.keep"))}</em>` : ""}</button>`;
          })
          .join("");
        const still = after.find((a) => a.tool === m.tool);
        const note = cur !== m.tool
          ? `<small class="sp-note${still ? " warn" : ""}">${esc(still ? tr("spool.sub_still", { head: "T" + cur }) : tr("spool.sub_ok", { tool: "T" + m.tool, head: "T" + cur }))}</small>`
          : "";
        return `<div class="sp-row">
          <div class="sp-line">${spSwatch(m.color)}<span>${esc(spLineText(m))}</span></div>
          <div class="sp-pick" role="radiogroup" aria-label="${esc(tr("spool.pick", { head: "T" + m.tool }))}"><span class="sp-pick-k">${esc(tr("spool.use"))}</span>${opts}</div>
          ${note}
        </div>`;
      })
      .join("");
    // An empty head left as is: the printer would refuse the job.
    const blocked = bad.some((m) => m.loaded.state === "empty" && (picks[m.tool] ?? m.tool) === m.tool);
    $("sp-sub").disabled = !map.length || blocked;
    $("sp-anyway").disabled = blocked;
    $("sp-anyway").title = $("sp-sub").title = blocked ? tr("spool.anyway_blocked") : "";
    // Re-slicing: the substitutes, or the spools loaded now, become the
    // filaments of the slice. Only with the plate it came from.
    const emptyKept = bad.some((m) => spLoaded(slots, spHeadOf(m.tool, map)).state !== "ok");
    const rs = $("sp-reslice");
    rs.disabled = !canReslice || emptyKept;
    rs.title = !canReslice ? tr("spool.reslice_none") : emptyKept ? tr("spool.reslice_empty") : tr("spool.reslice_tip");
    const primary = rs.disabled ? "substitute" : spPrimary(bad, slots, map);
    rs.classList.toggle("primary", primary === "reslice");
    $("sp-sub").classList.toggle("primary", primary === "substitute");
    $("sp-hint").textContent = !canReslice ? tr("spool.reslice_none") : rs.disabled || primary !== "reslice" ? "" : tr(bad.some((m) => spReasons(m, spLoaded(slots, spHeadOf(m.tool, map))).includes("material")) ? "spool.hint_material" : "spool.hint_reslice");
  };
  render();
  $("sp-noask").checked = false;
  openSheet(modal);
  requestAnimationFrame(() => (document.querySelector("#spmodal .modal-actions .primary:not(:disabled)") || $("sp-cancel")).focus());
  return new Promise((resolve) => {
    const done = (v) => {
      if (v && $("sp-noask").checked) spSetEnabled(false);
      $("sp-sub").onclick = $("sp-reslice").onclick = $("sp-anyway").onclick = $("sp-cancel").onclick = $("sp-list").onclick = modal.onkeydown = null;
      closeSheet(modal);
      resolve(v);
    };
    $("sp-list").onclick = (e) => {
      const b = e.target.closest(".sp-opt");
      if (!b || b.disabled) return;
      const t = +b.dataset.tool, h = +b.dataset.head;
      if (h === t) delete picks[t];
      else picks[t] = h;
      render();
    };
    $("sp-sub").onclick = () => {
      try {
        done({ map: spRemap(used, picks) });
      } catch (e) {
        toast(String(e.message || e), true);
      }
    };
    $("sp-reslice").onclick = () => {
      try {
        done({ reslice: true, picks: { ...picks }, tools: bad.map((m) => m.tool), map: spRemap(used, picks) });
      } catch (e) {
        toast(String(e.message || e), true);
      }
    };
    $("sp-anyway").onclick = () => done({ map: [] });
    $("sp-cancel").onclick = () => done(null);
    modal.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(null);
      }
    };
  });
}

/* Runs a slice through the usual engine pipeline, without the slice sheet:
   progress goes to `onProgress(text, percent)`. → the "preview" payload
   ({ id, gcode, stats }). */
const SP_RUNS = new Map(); // job id -> { events: [], cb }
let spWaiting = 0;
if (typeof listen === "function") {
  listen("slice-progress", (e) => {
    const p = e.payload || {};
    if (!p.id || (typeof SL !== "undefined" && SL.job === p.id)) return;
    // Before slice_start answers, events are kept only while one is awaited.
    if (!SP_RUNS.has(p.id) && !spWaiting) return;
    const r = SP_RUNS.get(p.id) || SP_RUNS.set(p.id, { events: [] }).get(p.id);
    if (r.cb) r.cb(p);
    else r.events.push(p);
  });
}
async function spSlice(request, onProgress) {
  onProgress(tr("slice.preparing"), null);
  spWaiting++;
  let id;
  try {
    id = await invoke("slice_start", { request });
  } finally {
    spWaiting--;
  }
  return new Promise((resolve, reject) => {
    const r = SP_RUNS.get(id) || SP_RUNS.set(id, { events: [] }).get(id);
    r.cb = (p) => {
      if (p.phase === "preparation") onProgress(tr("slice.preparing_model"), null);
      else if (p.phase === "slicing") onProgress(p.percent != null ? `${tr("spool.reslicing")} ${Math.round(p.percent)} %` : tr("spool.reslicing"), p.percent ?? null);
      else {
        SP_RUNS.delete(id);
        if (p.phase === "preview") resolve({ ...p, id });
        else if (p.phase === "cancelled") reject(new Error(tr("slice.stopped")));
        else reject(new Error(p.message || tr("slice.engine_silent")));
      }
    };
    r.events.splice(0).forEach(r.cb);
  });
}

/* Notes for presets taken by default ("T3: Generic PETG, no preset fits"). */
function spGenericNote(heads) {
  const g = heads.filter((h) => h.generic);
  return g.length ? tr("spool.generic_used", { list: g.map((h) => `T${h.head} → ${h.preset.replace(/\s*@.*$/, "")}`).join(", ") }) : "";
}

if (typeof document !== "undefined" && document.getElementById("set-spool-check")) {
  $("set-spool-check").checked = spEnabled();
  $("set-spool-check").addEventListener("change", (e) => spSetEnabled(e.target.checked));
}
