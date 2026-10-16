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
};
const advVal = (k) => (k in SL.adv ? SL.adv[k] : ADV.defaults[k]);
const advOn = (k) => String(advVal(k)) === "1" || advVal(k) === true;
const multiHead = () => headCount() > 1;
const isTree = () => String(advVal("support_type") || "").startsWith("tree");
/* Orca: a tree support in "default" style is organic ("Default (Grid/Organic)"). */
const isOrganic = () => isTree() && ["organic", "default"].includes(advVal("support_style"));

/* Keys holding a head number, 1-based. Only the support ones accept 0
   ("default": the engine picks); the per-feature ones start at 1. */
const ADV_FILAMENT = new Set(["support_filament", "support_interface_filament", "wall_filament", "sparse_infill_filament", "solid_infill_filament"]);
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
      { t: "slice.adv.g.tower", keys: ["enable_prime_tower", "prime_tower_width", "prime_volume", "prime_tower_brim_width"] },
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
   the advanced differences. */
async function advRefreshDefaults() {
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
    } catch {
      ADV.defaults = { ...ADV_ENGINE_DEFAULTS };
    }
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
  return `${v}${def?.unit && !String(v).endsWith("%") ? " " + def.unit : ""}`;
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
  ADV.ro.observe(document.querySelector("#smodal .sl-cols"));
  ADV.ro.observe(document.querySelector("#smodal .sl-box"));
  $("s-adv").classList.remove("hidden");
  advRenderPanel();
  requestAnimationFrame(() => $("s-adv-back").focus());
}

/* Covers exactly the sheet's columns: header and footer stay. */
function advFit() {
  const cols = document.querySelector("#smodal .sl-cols");
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
    const opts = [...(k.startsWith("support_") ? [{ value: "0", label: tr("slice.adv.default_head") }] : []), ...advHeadChoices()];
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
    input = `<input type="checkbox" class="sw" data-k="${k}"${String(v) === "1" ? " checked" : ""} />`;
  } else {
    const pct = def.type === "percent" || String(v ?? "").endsWith("%");
    const num = v == null ? "" : String(v).replace(/%$/, "");
    const step = def.type === "int" ? 1 : 0.1;
    input = `<input type="number" class="field num" step="${step}" data-k="${k}" data-pct="${pct ? 1 : ""}" value="${esc(num)}" /><span class="unit">${esc(pct ? "%" : def.unit || "")}</span>`;
  }
  return `<div class="grow-row adv-row${mod ? " mod" : ""}" title="${esc(def.tooltip || "")}">
    <span class="k">${esc(def.label)}${mod ? `<small class="sub">${esc(tr("slice.adv.profile_value", { v: advLabel(k, ADV.defaults[k]) || "—" }))}</small>` : ""}</span>
    ${mod ? `<button class="adv-reset" data-reset="${k}" title="${esc(tr("slice.adv.reset"))}">↺</button>` : ""}
    ${input}
  </div>`;
}

function advRenderPanel() {
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
  const n = advCount();
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
    await invoke("slice_save_process", { name, base, simple: currentSimple(), overrides: advOverrides() });
  } catch (e) {
    $("advsave-msg").textContent = String(e);
    $("advsave-msg").className = "pf-test err";
    return;
  }
  closeSheet($("advsave"));
  // The new profile carries the differences: it becomes the choice, clean.
  SL.lists = await invoke("slice_lists", { machine }).catch(() => SL.lists);
  fillSelect($("s-process"), SL.lists.processes, name);
  SL.adv = {};
  remember(machine, { process: name, adv: {} });
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
