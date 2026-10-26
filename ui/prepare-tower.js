"use strict";
/* Prepare: the prime tower on the plate (rules in tower-logic.js).

   The "Prime tower" switch under the object list and the slice sheet's
   (#s-tower-sw) are one setting, `enable_prime_tower`, kept with the plate
   (`PR.tower.on`) — never the profile's: a new plate starts without one.
   When the engine will print a tower (advTowerOn: the option on, two heads
   used or more, layer by layer), a grey translucent box stands where it
   will be printed: placed in a free corner, moved and turned like a part,
   sent with the plate as `wipe_tower_x` / `wipe_tower_y` /
   `wipe_tower_rotation_angle`. Its size is estimated until a slice tells
   the real one. */

PR.towerSel = false;

/* The plate's tower as stored, in the plate and its undo steps. */
const prTowerStored = (t = PR.tower) => ({ on: !!t.on, x: t.x, y: t.y, rot: t.rot || 0, real: t.real || null });

/* A stored tower back (plate, undo step, older plate without one: off). */
function prTowerRestore(t) {
  PR.tower = { on: false, x: null, y: null, rot: 0, real: null, ...(t && typeof t === "object" ? t : {}) };
  PR.tower.on = ptOn({ tower: PR.tower });
}

// The plate read at start (prLoadState) holds its tower, or none.
prTowerRestore(PR.tower);

/* A 3MF's tower (plate_tower), for a file opened on an empty plate as it
   was laid out: its place, and its switch when Snap Studio saved it — an
   Orca project's is its profile's, and a new project starts without. */
async function prTowerFromFile(path) {
  const t = await invoke("plate_tower", { path }).catch(() => null);
  if (!t) return;
  PR.tower.x = t.x;
  PR.tower.y = t.y;
  PR.tower.rot = normDeg(t.rot || 0);
  PR.tower.real = null;
  if (t.ours) PR.tower.on = !!t.on;
}

/* ------------------------------------------------------------ settings */

/* The sheet's advanced differences for the remembered machine: its own
   once it has loaded them, otherwise the ones remembered for it. */
function prTowerAdv() {
  if (typeof SL === "undefined") return {};
  if ($("s-machine")?.value) return SL.adv || {};
  const machine = SL.memory?.last;
  return (machine && SL.memory[machine]?.adv) || {};
}

/* A profile's value: the sheet's, or the one read here, or the engine's. */
function prTowerProfileValue(k) {
  if (typeof ADV !== "undefined" && ADV.defaults?.[k] != null) return ADV.defaults[k];
  if (PR.towerProfile?.values?.[k] != null) return PR.towerProfile.values[k];
  return typeof ADV_ENGINE_DEFAULTS !== "undefined" ? ADV_ENGINE_DEFAULTS[k] : undefined;
}

/* The tower's settings, as the slice will send them: the sheet's
   differences, then the profile's values (loaded by the sheet, or here for
   the remembered profile), then the engine's defaults. */
function prTowerSetting(k) {
  const adv = prTowerAdv();
  return k in adv ? adv[k] : prTowerProfileValue(k);
}
const prTowerNum = (k, dflt) => {
  const v = parseFloat(String(prTowerSetting(k) ?? "").replace("%", ""));
  return isFinite(v) ? v : dflt;
};

/* The remembered machine and profile: the sheet's last choice. */
function prTowerProfileName() {
  if (typeof SL === "undefined") return null;
  const machine = SL.memory?.last;
  const m = machine ? SL.memory[machine] || {} : {};
  return machine && m.process ? { machine, process: m.process, simple: m.simple || null } : null;
}

/* The profile's tower values, read once per profile when the sheet has
   not loaded them (Prepare before the first slice). */
async function prTowerLoadProfile() {
  const p = prTowerProfileName();
  if (!p || (typeof ADV !== "undefined" && ADV.defaults?.prime_tower_width != null)) return;
  const key = `${p.machine}\n${p.process}`;
  if (PR.towerProfile?.key === key) return;
  PR.towerProfile = { key, values: null };
  const d = await invoke("slice_details", { name: p.process, machine: p.machine, simple: p.simple, overrides: {}, color: null }).catch(() => null);
  if (PR.towerProfile?.key !== key) return;
  PR.towerProfile.values = Object.fromEntries(Object.entries(d?.values || {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  prTowerChanged();
}

/* Heads the plate prints with: its sliced objects' colours, and the heads
   the advanced settings send supports, walls or infill to. */
function prTowerHeads() {
  const live = typeof headsActive === "function";
  const pid = live ? headsActive() : "";
  const slots = live ? headsSlots(pid) : [];
  const n = live ? headsCount(pid) : 1;
  const used = new Set();
  for (const o of plSliced(PR.objects, bedState)) {
    const heads = PR.assoc === "colour" ? prSliceHeads(o) : live ? Object.fromEntries(Object.entries(prHeads(o, pid, slots, n)).map(([e, v]) => [e, v.h])) : o.heads || {};
    for (const ext of prColors(o)) used.add(heads[ext] ?? 0);
  }
  if (typeof advHeads === "function") for (const h of Object.values(advHeads({ tower: false }))) used.add(h);
  // A virtual head prints with its two heads; an orphan with none.
  return vhPhysical(used, headsVirtual(pid));
}

/* The plate uses a virtual head: it changes heads at every layer. */
function prTowerVirtualUsed() {
  const list = headsVirtual(headsActive());
  // A virtual head is always a choice: in the heads the slice gets.
  return list.length > 0 && plSliced(PR.objects, bedState).some((o) => Object.values(prSliceHeads(o)).some((h) => vhFind(list, h)));
}

/* Whether the engine prints a tower now, and why not. */
const prTowerState = (heads = prTowerHeads().size) =>
  ptState({ heads, on: PR.tower.on, sequence: String(prTowerSetting("print_sequence") || "by layer") });
const prTowerShown = () => PR.tower.on && prTowerState().show;

/* What the size depends on (tower-logic.js ptSizeKey). */
function prTowerKey(heads = prTowerHeads().size) {
  const parts = plSliced(PR.objects, bedState).map((o) => [meshKey(o), o.rot, o.scale]);
  const p = prTowerProfileName();
  const settings = ["prime_tower_width", "prime_volume", "prime_tower_brim_width", "wipe_tower_wall_type", "wipe_tower_rib_width", "wipe_tower_extra_rib_length", "wipe_tower_extra_spacing", "layer_height"].map(prTowerSetting);
  return ptSizeKey(parts, [heads, p?.machine, p?.process, settings]);
}

/* The tower's box: the slice's while nothing it depends on changed,
   otherwise estimated. null without a tower. */
function prTowerBox() {
  // Off: nothing to work out (this runs on every frame and pointer move).
  if (!PR.tower.on) return null;
  const heads = prTowerHeads().size;
  if (!prTowerState(heads).show) return null;
  const real = PR.tower.real;
  if (real?.box && real.key === prTowerKey(heads)) return { ...real.box, est: false };
  const height = Math.max(0, ...plSliced(PR.objects, bedState).map((o) => shape(o).zmax - shape(o).zmin));
  const name = prTowerProfileName()?.machine || "";
  const nozzle = prTowerNum("nozzle_diameter", +(/([\d.]+) nozzle/.exec(name)?.[1] || 0.4));
  const e = ptEstimate({
    heads,
    height,
    layer: prTowerNum("layer_height", 0.2),
    width: prTowerNum("prime_tower_width", 60),
    volume: prTowerNum("prime_volume", 45),
    brim: prTowerNum("prime_tower_brim_width", 3),
    nozzle,
    wall: String(prTowerSetting("wipe_tower_wall_type") || "rectangle"),
    ribWidth: prTowerNum("wipe_tower_rib_width", 8),
    ribExtra: prTowerNum("wipe_tower_extra_rib_length", 0),
    spacing: prTowerNum("wipe_tower_extra_spacing", 100) / 100,
  });
  return e && { ...e, est: true };
}

/* ------------------------------------------------------------ placement */

/* Part footprints the tower must keep clear of: the objects on the plate. */
const prTowerParts = () => PR.objects.filter((o) => bedState(o) !== "out").map(footprintPoly);

/* A free spot for the tower, its rotation kept. */
function prTowerSpot(box = prTowerBox()) {
  return box ? ptSpot(box, PR.bed, prTowerParts(), PR.tower.rot || 0) : null;
}

/* A tower shown for the first time takes a free corner. */
function prTowerEnsurePlaced() {
  if (PR.tower.x != null || !prTowerShown()) return;
  const s = prTowerSpot();
  if (!s) return;
  PR.tower.x = s.x;
  PR.tower.y = s.y;
  prSave();
}

/* "Move it to a free spot": the automatic placement again, one undo step. */
function prTowerToSpot() {
  const s = prTowerSpot();
  if (!s) return;
  prRemember();
  PR.tower.x = s.x;
  PR.tower.y = s.y;
  if (!s.free) toast(tr("prepare.tower.no_spot"), true);
  prTowerChanged(true);
}

/* Its corners on the plate, and its state there: "in", "partial" or
   "out", overlapping a part or not. */
function prTowerCheck(box = prTowerBox()) {
  if (!box || PR.tower.x == null) return null;
  const poly = ptCorners(PR.tower, box);
  const parts = PR.objects.filter((o) => bedState(o) !== "out");
  const hits = parts.filter((o) => ptConvexOverlap(poly, footprintPoly(o)));
  return { poly, state: ptBedState(PR.tower, box, PR.bed), hits: hits.map((o) => o.id) };
}

/* The plate, a part or a setting changed: the tower follows (shown or
   not, placed, redrawn), and the slice sheet's switch with it. `save`:
   its own change, kept with the plate. */
function prTowerChanged(save = false) {
  prTowerEnsurePlaced();
  if (save) prSave();
  prRenderInspector();
  prSchedule();
  if (typeof advRenderRows === "function" && !$("smodal").classList.contains("hidden")) {
    advRenderRows();
    if (ADV.cat === "mm") advRenderPanel();
  }
}

/* The option, from either switch. */
function prTowerSetOn(on) {
  if (PR.tower.on === !!on) return;
  PR.tower.on = !!on;
  if (on) prTowerLoadProfile();
  if (!prTowerShown()) PR.towerSel = false;
  prTowerChanged(true);
}

/* The overrides a slice sends: the tower's place, with it only. */
function prTowerOverrides() {
  if (!prTowerShown() || PR.tower.x == null) return {};
  const n = (v) => String(Math.round(v * 1000) / 1000);
  return { wipe_tower_x: [n(PR.tower.x)], wipe_tower_y: [n(PR.tower.y)], wipe_tower_rotation_angle: n(PR.tower.rot || 0) };
}

/* A slice is done: the tower it printed (gcode.rs TowerBox) gives the real
   size, for the plate as it was sliced (`key`). */
function prTowerSliced(t, key) {
  const box = ptFromGcode(t);
  PR.tower.real = box && key ? { box, key } : null;
  prSave();
  prSchedule();
}

/* The prime volume from Prepare's slider: the slice sheet's setting, a
   difference from the profile shown there (Multi-material panel). Before
   the sheet has loaded this machine's settings, it goes to the ones
   remembered for it, which the sheet loads. */
function prTowerSetVolume(v) {
  const k = "prime_volume", value = String(Math.round(v));
  if ($("s-machine")?.value && ADV.defaults?.[k] != null) return advSet(k, value);
  const machine = prTowerProfileName()?.machine;
  if (!machine) return;
  const adv = { ...(rememberFor(machine).adv || {}) };
  if (value === String(prTowerProfileValue(k))) delete adv[k];
  else adv[k] = value;
  SL.memory[machine] = { ...rememberFor(machine), adv };
  localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
}

/* Its bounds: the least the engine purges on the tower
   (filament_minimal_purge_on_wipe_tower, 15 on the U1), up to twice the
   profile's. */
function prTowerVolumeRange() {
  const min = Math.max(1, Math.round(prTowerNum("filament_minimal_purge_on_wipe_tower", 15)));
  const profile = parseFloat(prTowerProfileValue("prime_volume")) || 45;
  return { min, max: Math.max(90, Math.round(profile * 2)), profile };
}

/* Moves and turns, the turn around the box's middle. */
function prTowerMove(dx, dy) {
  PR.tower.x = Math.round((PR.tower.x + dx) * 100) / 100;
  PR.tower.y = Math.round((PR.tower.y + dy) * 100) / 100;
}
function prTowerTurn(rot, box = prTowerBox()) {
  if (!box) return;
  const t = ptTurn(PR.tower, box, normDeg(rot));
  Object.assign(PR.tower, { x: Math.round(t.x * 100) / 100, y: Math.round(t.y * 100) / 100, rot: t.rot });
}

/* ------------------------------------------------------------ picking */

/* Distance along the pointer's ray to the tower's box, or null. */
function prTowerHit(e, ray = prRay(e)) {
  const box = prTowerBox();
  if (!box || PR.tower.x == null) return null;
  const a = (-(PR.tower.rot || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const local = (v, point) => {
    const x = point ? v[0] - PR.tower.x : v[0], y = point ? v[1] - PR.tower.y : v[1];
    return [x * c - y * s, x * s + y * c, v[2]];
  };
  const o = local(ray.o, true), d = local(ray.d, false);
  const lo = [box.x0, box.y0, 0], hi = [box.x0 + box.w, box.y0 + box.d, Math.max(box.h, 1)];
  let t0 = 0, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < lo[k] || o[k] > hi[k]) return null;
      continue;
    }
    const p = (lo[k] - o[k]) / d[k], q = (hi[k] - o[k]) / d[k];
    t0 = Math.max(t0, Math.min(p, q));
    t1 = Math.min(t1, Math.max(p, q));
  }
  return t0 <= t1 ? t0 : null;
}

/* The tower selected (alone), or not. */
function prTowerSelect(on) {
  PR.towerSel = !!on && prTowerShown();
  if (PR.towerSel) PR.sel.clear();
  prRenderInspector();
  prSchedule();
}

/* ------------------------------------------------------------ drawing */

const TOWER_GREY = [0.55, 0.56, 0.58];

/* The box, translucent, with darker edges; selected, overlapping or off
   the plate, it takes the parts' tints. */
function prTowerDraw(gl, vp, accent) {
  const box = prTowerBox();
  const chk = prTowerCheck(box);
  if (!chk) return;
  const h = Math.max(box.h, 1);
  const lo = chk.poly.map(([x, y]) => [x, y, 0.05]), hi = chk.poly.map(([x, y]) => [x, y, h]);
  const tint =
    chk.state !== "in" ? [prTok("--danger", [1, 0.23, 0.19]), 0.5]
    : PR.towerSel ? [accent, 0.4]
    : chk.hits.length ? [prTok("--warning", [1, 0.58, 0]), 0.45]
    : null;
  const base = tint ? TOWER_GREY.map((v, i) => v + (tint[0][i] - v) * tint[1]) : TOWER_GREY;
  const shade = (k) => [...base.map((v) => v * k), 0.35];
  const quad = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d];
  // Translucent faces: what is behind shows; the depth buffer is left as
  // the parts made it. The canvas itself stays opaque (its alpha kept at
  // 1): otherwise the page behind it would show through the faces.
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
  gl.depthMask(false);
  drawSolid(gl, vp, quad(hi[0], hi[1], hi[2], hi[3]), shade(1), gl.TRIANGLES);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    drawSolid(gl, vp, quad(lo[i], lo[j], hi[j], hi[i]), shade(i % 2 ? 0.78 : 0.88), gl.TRIANGLES);
  }
  gl.depthMask(true);
  const edges = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    edges.push(...lo[i], ...lo[j], ...hi[i], ...hi[j], ...lo[i], ...hi[i]);
  }
  const edge = PR.towerSel ? accent : base.map((v) => v * 0.55);
  drawSolid(gl, vp, edges, [...edge, PR.towerSel ? 1 : 0.9], gl.LINES);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
}

/* "Prime tower 60 × 34 × 42 mm", "estimated" before slicing; `short`:
   the size alone, beside the tower's name. */
function prTowerLabel(box = prTowerBox(), short = false) {
  if (!box) return "";
  const size = [box.w, box.d, box.h].map((v) => fmtDec(v, 0)).join(" × ");
  const key = short ? (box.est ? "prepare.tower.dims_est" : "prepare.tower.dims") : box.est ? "prepare.tower.size_est" : "prepare.tower.size";
  return tr(key, { size });
}

/* The hover label, under the pointer. */
function prTowerHover(e) {
  const tip = $("p-tower-tip");
  const over = !PR.drag && e && prTowerHit(e) != null && !(prPickDist(e)?.dist < prTowerHit(e));
  tip.classList.toggle("hidden", !over);
  if (!over) return;
  const rect = $("p-canvas").getBoundingClientRect();
  tip.textContent = prTowerLabel();
  tip.style.left = e.clientX - rect.left + "px";
  tip.style.top = e.clientY - rect.top + "px";
}

/* ------------------------------------------------------------ panels */

/* The switch under the list: on or off, disabled with its reason when no
   tower can be printed (the choice kept for when one can). Not shown at
   all while the plate prints with one head: there is nothing to choose. */
function prTowerRenderSwitch() {
  const sw = $("p-tower-sw");
  if (!sw) return;
  const st = prTowerState();
  $("p-plateopts").classList.toggle("hidden", st.reason === "single");
  sw.checked = PR.tower.on;
  sw.disabled = !!st.reason;
  const why = $("p-tower-why");
  // Off with a virtual head: advised, never turned on for the user.
  why.textContent = st.reason ? tr(`prepare.tower.why.${st.reason}`) : st.show ? prTowerLabel(undefined, true) : !PR.tower.on && prTowerVirtualUsed() ? tr("prepare.tower.virtual_hint") : "";
  why.classList.toggle("hidden", !why.textContent);
  sw.title = st.reason ? why.textContent : "";
  $("p-tower-row").classList.toggle("off", !!st.reason);
}

/* The inspector for the tower: its corner, its turn, its prime volume
   (prepare.js PF, sliders or typed as the objects'), its size and what is
   wrong with its place. */
function prTowerRenderProps() {
  const on = PR.towerSel && prTowerShown() && PR.tower.x != null;
  $("p-tower-props").classList.toggle("hidden", !on);
  if (!on) return false;
  $("p-insp").classList.remove("hidden");
  $("p-props").classList.add("hidden");
  $("p-insp-name").textContent = $("p-insp-name").title = tr("prepare.tower");
  for (const [id, f] of Object.entries(PF)) if (f.tower) prRenderField(id, f, f.get(PR.tower));
  // Less than the profile purges: colours may mix at head changes.
  const vol = PF["p-tvol"].get(), lim = prTowerVolumeRange();
  $("p-tvol-note").classList.toggle("hidden", !(vol < lim.profile));
  const box = prTowerBox(), chk = prTowerCheck(box);
  $("p-tower-dims").textContent = prTowerLabel(box, true);
  const warn = !chk ? "" : chk.state !== "in" ? tr("prepare.tower.off_plate") : chk.hits.length ? tr("prepare.tower.overlap") : "";
  $("p-tower-warn").textContent = warn;
  $("p-tower-warn").classList.toggle("hidden", !warn);
  return true;
}

/* The slice sheet's warning: the tower on a part (the engine refuses
   such a plate) or off the plate (slicing waits for it), with the way
   out. */
function prTowerSheetWarning() {
  const box = $("s-tower-place");
  if (!box) return;
  const chk = prTowerShown() ? prTowerCheck() : null;
  const kind = !chk ? "" : chk.state !== "in" ? "off_plate" : chk.hits.length ? "overlap" : "";
  const html = kind
    ? `<span class="sl-tower-t">${esc(tr(`slice.tower.place.${kind}`))}</span><span class="sl-tower-acts"><button class="btn small" data-tower-spot>${esc(tr("prepare.tower.spot"))}</button></span>`
    : "";
  box.classList.toggle("bad", kind === "off_plate");
  if (box.innerHTML !== html) box.innerHTML = html;
  box.classList.toggle("hidden", !html);
  box.querySelectorAll("button").forEach((b) => (b.disabled = !!SL.job));
}

/* Off the plate, the engine would print it there: slicing waits, as for
   a part sticking out. */
const prTowerBlocks = () => prTowerShown() && prTowerCheck()?.state !== "in" && PR.tower.x != null;

/* ------------------------------------------------------------ events */

$("p-tower-sw").addEventListener("change", (e) => prTowerSetOn(e.target.checked));
$("s-tower-place").addEventListener("click", (e) => {
  if (!e.target.closest("[data-tower-spot]")) return;
  prTowerToSpot();
  prTowerSheetWarning();
});
onMenu("tower", (what) => {
  if (what === "spot") prTowerToSpot();
  if (what === "off") prTowerSetOn(false);
});

/* The tower's menu, from the plate. */
function prTowerMenu(x, y) {
  prTowerSelect(true);
  nativeMenu([
    { id: "tower:spot", label: tr("prepare.tower.spot") },
    {},
    { id: "tower:off", label: tr("prepare.tower.turn_off") },
  ], x, y);
}
