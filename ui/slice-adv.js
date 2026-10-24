"use strict";
/* Advanced settings of the slice sheet, Snapmaker Orca style.

   Supports, Brim, Seam and Multi-material each open a sub-panel inside the
   sheet. Every field is an Orca process key, described by
   `assets/orca-settings.<lang>.json` (label, unit, values, tooltip) and
   checked against the shipped engine (Snapmaker Orca 2.4.0). Only values
   that differ from the chosen profile are kept, in `SL.adv`, remembered per
   machine profile, and sent to the engine as `overrides` (which win over the
   profile and the quick settings, see slice.rs). */

const ADV = { schema: null, defaults: {}, cat: null, seq: 0 };
SL.adv = SL.adv || {};

/* Engine defaults (Snapmaker Orca 2.4.0, PrintConfig.cpp) for the keys a
   profile may leave out: the engine then applies these. */
const ADV_ENGINE_DEFAULTS = {
  seam_position: "aligned", staggered_inner_seams: "0", seam_gap: "10%",
  support_type: "normal(auto)", support_style: "default", support_threshold_angle: "30",
  support_on_build_plate_only: "0", support_critical_regions_only: "0", support_remove_small_overhang: "1",
  support_top_z_distance: "0.2", support_bottom_z_distance: "0.2", support_interface_top_layers: "3",
  support_interface_bottom_layers: "0", support_interface_pattern: "auto", support_interface_spacing: "0.5",
  support_base_pattern: "default", support_base_pattern_spacing: "2.5", support_object_xy_distance: "0.35",
  bridge_no_support: "0", tree_support_branch_angle: "40", tree_support_branch_angle_organic: "40",
  tree_support_branch_distance: "5", tree_support_branch_distance_organic: "1", tree_support_branch_diameter: "5",
  tree_support_branch_diameter_organic: "2", tree_support_tip_diameter: "0.8", tree_support_wall_count: "0",
  tree_support_auto_brim: "1", tree_support_brim_width: "3", support_filament: "0", support_interface_filament: "0",
  brim_type: "auto_brim", brim_width: "0", brim_object_gap: "0", brim_ears_max_angle: "125",
  enable_prime_tower: "0", prime_tower_width: "60", prime_volume: "45", prime_tower_brim_width: "3",
  flush_into_infill: "0", flush_into_objects: "0", flush_into_support: "1",
  wall_filament: "1", sparse_infill_filament: "1", solid_infill_filament: "1",
  wipe_tower_filament: "0", ooze_prevention: "0", standby_temperature_delta: "-5", preheat_time: "30",
  // A filament key (sent to every filament, slice.rs): 0 on the U1's.
  idle_temperature: "0", print_sequence: "by layer",
};
const advVal = (k) => (k in SL.adv ? SL.adv[k] : ADV.defaults[k]);
const advOn = (k) => String(advVal(k)) === "1" || advVal(k) === true;
const multiHead = () => headCount() > 1;
const isTree = () => String(advVal("support_type") || "").startsWith("tree");
/* Orca: a tree support in "default" style is organic ("Default (Grid/Organic)"). */
const isOrganic = () => isTree() && ["organic", "default"].includes(advVal("support_style"));

/* Keys holding a head number, 1-based. The support ones and the prime
   tower's accept 0 ("default": the engine picks); the per-feature ones
   start at 1. */
const ADV_FILAMENT = new Set(["support_filament", "support_interface_filament", "wall_filament", "sparse_infill_filament", "solid_infill_filament", "wipe_tower_filament"]);
const ADV_HEAD_AUTO = new Set(["support_filament", "support_interface_filament", "wipe_tower_filament"]);
/* Units the settings catalog leaves out. */
const ADV_UNITS = { standby_temperature_delta: "°C", idle_temperature: "°C" };
/* Values hidden from a list: handled elsewhere ("no_brim" is the switch) or
   needing tools the app does not have (painted brim). */
const ADV_HIDE = { brim_type: ["no_brim", "painted"] };

/* Sub-panels: groups of keys, with the conditions under which they apply. */
const ADV_CATS = {
  support: {
    title: "slice.supports",
    groups: [
      { t: "slice.adv.g.support", keys: ["support_type", "support_style", "support_threshold_angle", "support_on_build_plate_only", "support_critical_regions_only", "support_remove_small_overhang"] },
      { t: "slice.adv.g.interface", keys: ["support_top_z_distance", "support_bottom_z_distance", "support_interface_top_layers", "support_interface_bottom_layers", "support_interface_pattern", "support_interface_spacing"] },
      { t: "slice.adv.g.base", keys: ["support_base_pattern", "support_base_pattern_spacing", "support_object_xy_distance", "bridge_no_support"] },
      {
        t: "slice.adv.g.tree",
        when: isTree,
        keys: () => [
          ...(isOrganic()
            ? ["tree_support_branch_angle_organic", "tree_support_branch_distance_organic", "tree_support_branch_diameter_organic"]
            : ["tree_support_branch_angle", "tree_support_branch_distance", "tree_support_branch_diameter"]),
          "tree_support_tip_diameter", "tree_support_wall_count", "tree_support_auto_brim", "tree_support_brim_width",
        ],
      },
      { t: "slice.adv.g.support_filament", when: multiHead, keys: ["support_filament", "support_interface_filament"] },
    ],
  },
  brim: { title: "slice.brim", groups: [{ t: "slice.brim", keys: ["brim_type", "brim_width", "brim_object_gap", "brim_ears_max_angle"] }] },
  seam: { title: "slice.adv.seam", groups: [{ t: "slice.adv.seam", keys: ["seam_position", "staggered_inner_seams", "seam_gap"] }] },
  mm: {
    title: "slice.adv.mm",
    groups: [
      { t: "slice.adv.g.tower", keys: ["enable_prime_tower", "wipe_tower_filament", "prime_tower_width", "prime_volume", "prime_tower_brim_width"] },
      { t: "slice.adv.g.ooze", keys: ["ooze_prevention", "standby_temperature_delta", "preheat_time", "idle_temperature"] },
      { t: "slice.adv.g.flush", keys: ["flush_into_infill", "flush_into_objects", "flush_into_support"] },
      { t: "slice.adv.g.features", keys: ["wall_filament", "sparse_infill_filament", "solid_infill_filament"] },
    ],
  },
};

/* A field shown only when it means something. */
const ADV_WHEN = {
  brim_ears_max_angle: () => advVal("brim_type") === "brim_ears",
  tree_support_brim_width: () => !advOn("tree_support_auto_brim"),
  prime_tower_width: () => advOn("enable_prime_tower"),
  prime_volume: () => advOn("enable_prime_tower"),
  prime_tower_brim_width: () => advOn("enable_prime_tower"),
  wipe_tower_filament: () => advOn("enable_prime_tower"),
  // The other heads' temperature while one prints: with ooze prevention.
  standby_temperature_delta: () => advOn("ooze_prevention"),
  preheat_time: () => advOn("ooze_prevention"),
  idle_temperature: () => advOn("ooze_prevention"),
};

/* Category keys that apply right now (multi-material only with several
   heads; brim keys only with the brim on). */
function advCatKeys(cat) {
  if (cat === "mm" && !multiHead()) return [];
  return ADV_CATS[cat].groups
    .filter((g) => !g.when || g.when())
    .flatMap((g) => (typeof g.keys === "function" ? g.keys() : g.keys));
}

/* Heads offered to the per-feature filament fields: from the shared
   "Heads and spools" state when heads.js is loaded, otherwise the heads
   configured in this sheet (renderHeads). */
function advHeadChoices() {
  const pid = typeof headsCount === "function" ? currentPrinter()?.id : null;
  if (pid) {
    const slots = headsSlots(pid);
    return Array.from({ length: headsCount(pid) }, (_, i) => {
      const slot = slots.find((x) => x.index === i);
      const name = headsProfile(pid, i, SL.lists?.filaments || null).name;
      return { value: String(i + 1), label: `T${i}${name ? " · " + name : ""}`, color: slot?.present ? slot.color : null };
    });
  }
  return [...document.querySelectorAll("#s-heads select")].map((s, i) => {
    const slot = SL.slots.find((x) => x.index === i);
    return { value: String(i + 1), label: `T${i}${s.value ? " · " + s.value : ""}`, color: slot?.present ? slot.color : null };
  });
}

async function advSchema() {
  // Same catalog as the profile details (profiles.js).
  ADV.schema = await pdSchema();
  return ADV.schema;
}

/* Values sent to the engine: the kept differences, minus what does not
   apply (brim type with the brim off: the switch's "no_brim" must win). */
function advOverrides() {
  const o = { ...(SL.adv || {}) };
  if (!$("s-brim").checked) for (const k of advCatKeysAll("brim")) delete o[k];
  if (!multiHead()) {
    for (const k of advCatKeysAll("mm")) delete o[k];
    delete o.support_filament;
    delete o.support_interface_filament;
  }
  for (const k in o) o[k] = String(o[k]);
  return o;
}
/* Every key of a category, whatever applies now (counting, resetting). */
const ADV_TREE_ALL = ["tree_support_branch_angle", "tree_support_branch_angle_organic", "tree_support_branch_distance", "tree_support_branch_distance_organic", "tree_support_branch_diameter", "tree_support_branch_diameter_organic", "tree_support_tip_diameter", "tree_support_wall_count", "tree_support_auto_brim", "tree_support_brim_width"];
function advCatKeysAll(cat) {
  return ADV_CATS[cat].groups.flatMap((g) => (typeof g.keys === "function" ? ADV_TREE_ALL : g.keys));
}
const advCountOf = (cat) => advCatKeysAll(cat).filter((k) => k in SL.adv).length;
function advCount() {
  return Object.keys(advOverrides()).length;
}

/* Machine profile changed: its remembered differences come back. */
function advLoad(saved) {
  SL.adv = { ...(saved || {}) };
  advRefreshDefaults();
}

/* Reference values: the chosen profile with the quick settings, without
   the advanced differences. They also give the Speed adjustment its
   profile values (speed.js); a slice waits for them (`ADV.ready`). */
function advRefreshDefaults() {
  return (ADV.ready = advRefreshNow());
}
async function advRefreshNow() {
  const machine = $("s-machine").value, process = $("s-process").value;
  const seq = ++ADV.seq;
  if (machine && process) {
    try {
      const d = await invoke("slice_details", {
        name: process, machine, simple: currentSimple(),
        overrides: $("s-bed").value ? { curr_bed_type: $("s-bed").value } : {}, color: null,
      });
      if (seq !== ADV.seq) return;
      ADV.defaults = { ...ADV_ENGINE_DEFAULTS, ...Object.fromEntries(Object.entries(d?.values || {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) };
      await spdSetProfile(d?.values || null);
    } catch {
      ADV.defaults = { ...ADV_ENGINE_DEFAULTS };
      await spdSetProfile(null);
    }
    if (seq !== ADV.seq) return;
  }
  // With the brim switch on, the quick settings send "outer_only".
  if ($("s-brim").checked) ADV.defaults.brim_type = "outer_only";
  // Differences equal to the new profile's values are no longer differences.
  for (const k of Object.keys(SL.adv)) if (String(SL.adv[k]) === String(ADV.defaults[k])) delete SL.adv[k];
  await advSchema().catch(() => null);
  advRenderRows();
  if (ADV.cat) advRenderPanel();
}

function advRemember() {
  const machine = $("s-machine").value;
  if (machine) remember(machine, { adv: SL.adv });
}

/* ------------------------------------------------------------ main rows */

function advLabel(k, v = advVal(k)) {
  const def = ADV.schema?.keys?.[k];
  if (v == null || v === "") return "";
  if (ADV_FILAMENT.has(k)) return +v > 0 ? `T${+v - 1}` : tr("slice.adv.default_head");
  if (def?.enum) return def.enum[v] ?? v;
  if (def?.type === "bool") return tr(String(v) === "1" ? "common.yes" : "common.no");
  const unit = def?.unit || ADV_UNITS[k];
  return `${v}${unit && !String(v).endsWith("%") ? " " + unit : ""}`;
}

function advRenderRows() {
  if (!$("s-adv-mm-row")) return;
  $("s-adv-mm-row").classList.toggle("hidden", !multiHead());
  const sum = {
    support: $("s-supports").checked ? advLabel("support_type") : tr("slice.adv.off"),
    brim: $("s-brim").checked ? advLabel("brim_type", SL.adv.brim_type || "outer_only") : tr("slice.adv.off"),
    seam: advLabel("seam_position"),
    mm: tr("slice.adv.mm_sum", { v: advLabel("enable_prime_tower") }),
  };
  for (const cat of Object.keys(ADV_CATS)) {
    $("s-adv-sum-" + cat).textContent = sum[cat] || "";
    const n = advCountOf(cat);
    const btn = document.querySelector(`.sl-adv-btn[data-adv="${cat}"]`);
    btn.classList.toggle("mod", n > 0);
    btn.querySelector(".sl-adv-n").textContent = n || "";
  }
  spdRenderRow();
  slSummary();
}

/* ------------------------------------------------------------ sub-panel */

async function advOpen(cat) {
  await advSchema();
  ADV.cat = cat;
  advFit();
  // The sheet can change height while the panel is open (spools read,
  // window resized): the panel follows.
  ADV.ro ||= new ResizeObserver(() => ADV.cat && advFit());
  ADV.ro.observe(document.querySelector("#smodal .sl-areas"));
  ADV.ro.observe(document.querySelector("#smodal .sl-box"));
  $("s-adv").classList.remove("hidden");
  advRenderPanel();
  requestAnimationFrame(() => $("s-adv-back").focus());
}

/* Covers exactly the sheet's areas: header and footer stay. */
function advFit() {
  const cols = document.querySelector("#smodal .sl-areas");
  Object.assign($("s-adv").style, { top: cols.offsetTop + "px", height: cols.offsetHeight + "px" });
}

function advClose() {
  ADV.cat = null;
  ADV.ro?.disconnect();
  $("s-adv").classList.add("hidden");
  advRenderRows();
}

function advField(k) {
  const def = ADV.schema?.keys?.[k];
  if (!def) return "";
  const v = advVal(k);
  const mod = k in SL.adv;
  let input;
  if (ADV_FILAMENT.has(k)) {
    const opts = [...(ADV_HEAD_AUTO.has(k) ? [{ value: "0", label: tr("slice.adv.default_head") }] : []), ...advHeadChoices()];
    input = `<select class="field" data-k="${k}">${opts
      .map((o) => `<option value="${o.value}"${String(v ?? opts[0].value) === o.value ? " selected" : ""}>${esc(o.label)}</option>`)
      .join("")}</select>`;
  } else if (def.type === "enum") {
    const hide = ADV_HIDE[k] || [];
    input = `<select class="field" data-k="${k}">${Object.entries(def.enum)
      .filter(([val]) => !hide.includes(val))
      .map(([val, lbl]) => `<option value="${esc(val)}"${String(v) === val ? " selected" : ""}>${esc(lbl)}</option>`)
      .join("")}</select>`;
  } else if (def.type === "bool") {
    input = `<input type="checkbox" class="sw" role="switch" data-k="${k}"${String(v) === "1" ? " checked" : ""} />`;
  } else {
    const pct = def.type === "percent" || String(v ?? "").endsWith("%");
    const num = v == null ? "" : String(v).replace(/%$/, "");
    const step = def.type === "int" ? 1 : 0.1;
    input = `<input type="number" class="field num" step="${step}" data-k="${k}" data-pct="${pct ? 1 : ""}" value="${esc(num)}" /><span class="unit">${esc(pct ? "%" : def.unit || ADV_UNITS[k] || "")}</span>`;
  }
  return `<div class="grow-row adv-row${mod ? " mod" : ""}" title="${esc(def.tooltip || "")}">
    <span class="k">${esc(def.label)}${mod ? `<small class="sub">${esc(tr("slice.adv.profile_value", { v: advLabel(k, ADV.defaults[k]) || "—" }))}</small>` : ""}</span>
    ${mod ? `<button class="adv-reset" data-reset="${k}" title="${esc(tr("slice.adv.reset"))}">↺</button>` : ""}
    ${input}
  </div>`;
}

function advRenderPanel() {
  if (ADV.cat === "speed") return spdRenderPanel();
  const c = ADV_CATS[ADV.cat];
  if (!c) return;
  $("s-adv-title").textContent = tr(c.title);
  $("s-adv-reset").classList.toggle("hidden", advCountOf(ADV.cat) === 0);
  const note = ADV.cat === "support" && !$("s-supports").checked ? tr("slice.adv.support_off") : ADV.cat === "brim" && !$("s-brim").checked ? tr("slice.adv.brim_off") : "";
  const groups = c.groups
    .filter((g) => !g.when || g.when())
    .map((g) => {
      const keys = (typeof g.keys === "function" ? g.keys() : g.keys).filter((k) => !ADV_WHEN[k] || ADV_WHEN[k]());
      const rows = keys.map(advField).join("");
      return rows ? `<div class="set-section">${esc(tr(g.t))}</div><div class="group">${rows}</div>` : "";
    })
    .join("");
  $("s-adv-body").innerHTML = (note ? `<div class="sl-adv-note">${esc(note)}</div>` : "") + groups;
}

function advSet(k, v) {
  if (v === "" || v == null || String(v) === String(ADV.defaults[k])) delete SL.adv[k];
  else SL.adv[k] = String(v);
  advRemember();
  advRenderPanel();
  advRenderRows();
  // A head chosen for supports, walls or infill counts for the plate.
  if (ADV_FILAMENT.has(k) && typeof pdBedLine === "function") pdBedLine();
}

/* Heads the advanced settings send elements to — supports (when on),
   walls, infill — as the engine gets them: { key: head }. */
function advHeads() {
  const o = advOverrides();
  const out = {};
  for (const k of ADV_FILAMENT) {
    const v = +o[k];
    if (!(v > 0)) continue;
    if (k.startsWith("support") && !$("s-supports").checked) continue;
    // The tower's outer wall: only with a tower.
    if (k === "wipe_tower_filament" && !advTowerOn()) continue;
    out[k] = v - 1;
  }
  return out;
}

/* Those heads, short, for the summary: { supports: "T3", others: "walls T1" }. */
function advHeadsSummary() {
  const h = advHeads();
  const list = (...keys) => [...new Set(keys.map((k) => h[k]).filter((x) => x != null))].map((x) => "T" + x).join("/");
  const others = [
    h.wall_filament != null && tr("slice.sum.h.walls", { t: list("wall_filament") }),
    list("sparse_infill_filament", "solid_infill_filament") && tr("slice.sum.h.infill", { t: list("sparse_infill_filament", "solid_infill_filament") }),
  ].filter(Boolean);
  return { supports: list("support_filament", "support_interface_filament"), others: others.join(" · ") };
}

/* ------------------------------------------------------------ prime tower */

/* A prime tower is printed: on, with several heads, layer by layer (the
   engine prints none object by object). */
const advTowerOn = () => multiHead() && advOn("enable_prime_tower") && advVal("print_sequence") !== "by object";

/* The heads the plate prints with — its colors' heads, and those the
   advanced settings send supports, walls, infill or the tower's wall to —
   with their filament's material (the profile's type, else its name). */
function advTowerHeads() {
  const names = [...document.querySelectorAll("#s-heads select")].map((s) => s.value);
  const used = new Set([...slUsedSet(), ...Object.values(advHeads())].filter((n) => n < names.length));
  return [...used].sort((a, b) => a - b).map((n) => {
    const p = SL.lists?.filaments?.find((f) => f.name === names[n]);
    return { n, material: p?.ftype || spMaterialFromName(names[n]) };
  });
}

/* The tower shared by materials that do not bond (spoolcheck.js): it
   comes off or collapses. Said above the Slice button, with the fixes the
   engine allows (one tower per plate): no tower — the U1's tower only
   primes the nozzle, ooze prevention covers the rest — or its outer wall
   in one material, the wiki's advice (the inside still mixes). */
function advRenderTower() {
  const box = $("s-tower");
  if (!box) return;
  const wall = +advVal("wipe_tower_filament") > 0 ? +advVal("wipe_tower_filament") - 1 : null;
  const a = spTowerAdvice({ heads: advTowerHeads(), tower: advTowerOn(), wall });
  let html = "";
  if (a) {
    const heads = (g) => g.heads.map((n) => "T" + n).join(", ");
    const list = a.families.map((g) => `<b>${esc(g.family)}</b> (${esc(heads(g))})`).join(" · ");
    const off = `<button class="btn small" data-tower="off">${esc(tr("slice.tower.off"))}</button>`;
    if (a.state === "walled") {
      const g = a.families.find((x) => x.heads.includes(wall));
      html = `<span class="sl-tower-t">${tr("slice.tower.walled", { m: `<b>${esc(g.family)}</b>`, t: `T${wall}` })}</span>
        <span class="sl-tower-acts">${off}<button class="btn small" data-tower="undo">${esc(tr("slice.tower.undo"))}</button></span>`;
    } else {
      const walls = a.families
        .map((g) => `<button class="btn small" data-tower-wall="${g.heads[0]}">${esc(tr("slice.tower.wall", { m: g.family, t: `T${g.heads[0]}` }))}</button>`)
        .join("");
      html = `<span class="sl-tower-t">${tr("slice.tower.conflict", { list })}</span><span class="sl-tower-acts">${off}${walls}</span>`;
    }
  }
  // Rewritten only when it changes (the summary is refreshed often): a
  // focused button keeps its focus, the screen reader is not repeated.
  if (html === ADV.tower) return;
  ADV.tower = html;
  box.innerHTML = html;
  box.classList.toggle("hidden", !html);
  // Locked while slicing, as the sheet's other settings (showSliceBusy).
  box.querySelectorAll("button").forEach((b) => (b.disabled = !!SL.job));
}

$("s-tower")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tower], [data-tower-wall]");
  if (!b) return;
  if (b.dataset.tower === "off") advSet("enable_prime_tower", "0");
  else if (b.dataset.tower === "undo") advSet("wipe_tower_filament", null);
  else advSet("wipe_tower_filament", String(+b.dataset.towerWall + 1));
});

/* An emptied plate is a new print: the heads chosen for supports, walls
   or infill are forgotten, in every machine's memory — the spools will
   have changed, and a PETG support head once raised a PLA print's plate
   to 80°. The other advanced settings stay. */
function advForgetHeads() {
  for (const k of ADV_FILAMENT) delete SL.adv[k];
  for (const m of Object.values(SL.memory)) {
    if (m && typeof m === "object" && m.adv) for (const k of ADV_FILAMENT) delete m.adv[k];
  }
  localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
}

$("s-adv-body").addEventListener("change", (e) => {
  const el = e.target.closest("[data-k]");
  if (!el) return;
  const k = el.dataset.k;
  let v;
  if (el.type === "checkbox") v = el.checked ? "1" : "0";
  else if (el.type === "number") v = el.value === "" ? null : el.value + (el.dataset.pct ? "%" : "");
  else v = el.value;
  advSet(k, v);
});
$("s-adv-body").addEventListener("click", (e) => {
  const b = e.target.closest("[data-reset]");
  if (b) advSet(b.dataset.reset, null);
});
$("s-adv-back").addEventListener("click", advClose);
$("s-adv-reset").addEventListener("click", () => {
  if (ADV.cat === "speed") return spdResetAll();
  for (const k of advCatKeysAll(ADV.cat)) delete SL.adv[k];
  advRemember();
  advRenderPanel();
  advRenderRows();
});
document.querySelectorAll(".sl-adv-btn").forEach((b) => b.addEventListener("click", () => advOpen(b.dataset.adv)));
$("smodal").addEventListener("change", (e) => {
  if (e.target.matches("#s-supports, #s-brim, #s-bed")) advRefreshDefaults();
  else if (e.target.matches("#s-heads select")) advRenderRows();
});
window.addEventListener("langchange", () => {
  if ($("smodal").classList.contains("hidden")) return;
  advSchema().then(() => {
    advRenderRows();
    if (ADV.cat) advRenderPanel();
  });
});

/* ------------------------------------------------------ save as profile */

function advSaveOpen() {
  const process = $("s-process").value;
  if (!process) return;
  $("advsave-base").textContent = tr("slice.adv.save.base", { name: process });
  $("advsave-name").value = tr("slice.adv.save.default", { name: process.replace(/ @.*$/, "") });
  const n = advCount() + spdNChanged();
  $("advsave-what").textContent = tr("slice.adv.save.what", { n });
  $("advsave-msg").textContent = "";
  $("advsave-msg").className = "pf-test";
  openSheet($("advsave"));
  requestAnimationFrame(() => $("advsave-name").select());
}

async function advSaveGo() {
  const name = $("advsave-name").value.trim();
  const base = $("s-process").value;
  const machine = $("s-machine").value;
  if (!name) return;
  const exists = SL.lists?.processes?.find((p) => p.name === name);
  if (exists && !exists.user) {
    $("advsave-msg").textContent = tr("err.preset_exists", { name });
    $("advsave-msg").className = "pf-test err";
    return;
  }
  if (exists && !(await confirmDelete(tr("slice.adv.save.replace_title"), tr("slice.adv.save.replace_text", { name }), tr("slice.adv.save.replace")))) return;
  try {
    await invoke("slice_save_process", { name, base, simple: currentSimple(), overrides: { ...advOverrides(), ...spdOverrides() } });
  } catch (e) {
    $("advsave-msg").textContent = String(e);
    $("advsave-msg").className = "pf-test err";
    return;
  }
  closeSheet($("advsave"));
  // The new profile carries the differences: it becomes the choice, clean.
  SL.lists = await invoke("slice_lists", { machine }).catch(() => SL.lists);
  fillSelect($("s-process"), SL.lists.processes, name);
  // The speed, too, is now the profile's.
  SL.adv = {};
  SL.speed = spdReset();
  remember(machine, { process: name, adv: {}, speed: SL.speed });
  $("s-process").dispatchEvent(new Event("change", { bubbles: true }));
  toast(tr("slice.adv.save.done", { name }));
}

$("s-save-process").addEventListener("click", advSaveOpen);
$("advsave-go").addEventListener("click", advSaveGo);
$("advsave-cancel").addEventListener("click", () => closeSheet($("advsave")));
$("advsave").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeSheet($("advsave"));
  } else if (e.key === "Enter") {
    e.preventDefault();
    advSaveGo();
  }
});

/* The sub-panel closes with the sheet: it reopens on the main settings. */
new MutationObserver(() => {
  if (ADV.cat && $("smodal").classList.contains("hidden")) advClose();
}).observe($("smodal"), { attributes: true, attributeFilter: ["class"] });

/* Heads changed in "Heads and spools" (heads.js): the filament fields follow. */
window.addEventListener("headschange", () => {
  if (ADV.cat) advRenderPanel();
});
