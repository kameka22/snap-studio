// node scripts/test-adv.js — Advanced panels: settings shown with the one they detail.
const assert = require("assert");
const A = require("../ui/adv-logic.js");

const shown = (k, vals) => A.advShown(k, (x) => vals[x]);
// Overhang speeds: with "slow down for overhangs".
assert.strictEqual(shown("overhang_2_4_speed", { enable_overhang_speed: "1" }), true);
assert.strictEqual(shown("overhang_2_4_speed", { enable_overhang_speed: "0" }), false);
assert.strictEqual(shown("overhang_4_4_speed", { enable_overhang_speed: true }), true);
// Ironing: its details only with ironing.
for (const k of ["ironing_pattern", "ironing_flow", "ironing_spacing", "ironing_speed"]) {
  assert.strictEqual(shown(k, { ironing_type: "no ironing" }), false, k);
  assert.strictEqual(shown(k, { ironing_type: "top" }), true, k);
  assert.strictEqual(shown(k, {}), false, k + ": unknown means off");
}
assert.strictEqual(shown("ironing_type", { ironing_type: "no ironing" }), true, "the switch itself stays");
// Fuzzy skin.
assert.strictEqual(shown("fuzzy_skin_thickness", { fuzzy_skin: "none" }), false);
assert.strictEqual(shown("fuzzy_skin_point_distance", { fuzzy_skin: "external" }), true);
// Skirt: its details with at least one loop.
assert.strictEqual(shown("skirt_distance", { skirt_loops: "0" }), false);
assert.strictEqual(shown("draft_shield", { skirt_loops: "2" }), true);
assert.strictEqual(shown("skirt_height", { skirt_loops: 1 }), true);
// A setting that details nothing is always shown.
assert.strictEqual(shown("top_shell_layers", {}), true);
assert.ok(Object.values(A.ADV_DEPENDS).every((d) => d.on && typeof d.when === "function"));

// ------------------------------------------------------------ levels

// ADV_CATS as slice-adv.js declares it (its literal, run with stand-ins for
// the conditions), so the advanced-only list cannot drift from the panels.
const fs = require("fs"), vm = require("vm");
const src = fs.readFileSync(require("path").join(__dirname, "../ui/slice-adv.js"), "utf8");
const lit = src.slice(src.indexOf("const ADV_CATS = {") + "const ADV_CATS = ".length, src.indexOf("\n};\n", src.indexOf("const ADV_CATS = {")) + 2);
const catsWith = (organic) => vm.runInNewContext(`(${lit})`, { isTree: () => true, isOrganic: () => organic, multiHead: () => true });
const keysOf = (g) => (typeof g.keys === "function" ? [...g.keys()] : g.keys);
const levelKeys = new Set();
for (const organic of [false, true]) {
  for (const [cat, c] of Object.entries(catsWith(organic))) {
    for (const g of c.groups) {
      const advanced = !A.advLevelShows(cat, g.t, "basic");
      for (const k of keysOf(g)) {
        if (advanced) levelKeys.add(k);
        assert.strictEqual(A.ADV_LEVEL_KEYS.has(k), advanced, `${cat} / ${g.t} / ${k}: advanced-only = ${advanced}`);
      }
    }
  }
}
assert.deepStrictEqual([...A.ADV_LEVEL_KEYS].filter((k) => !levelKeys.has(k)), [], "no key the panels do not hold");
// Basic keeps Supports, Brim, Seam, the tower, flushing and heads per feature.
for (const k of ["support_type", "tree_support_branch_angle", "brim_width", "seam_position", "wipe_tower_filament", "prime_volume", "flush_into_infill", "wall_filament"]) {
  assert.ok(!A.ADV_LEVEL_KEYS.has(k), k);
}
for (const k of ["sparse_infill_pattern", "ironing_type", "ooze_prevention", "idle_temperature", "print_sequence", "line_width"]) assert.ok(A.ADV_LEVEL_KEYS.has(k), k);
// Shown groups.
assert.strictEqual(A.advLevelShows("quality", "slice.adv.g.first_layer", "basic"), false);
assert.strictEqual(A.advLevelShows("quality", "slice.adv.g.first_layer", "advanced"), true);
assert.strictEqual(A.advLevelShows("mm", "slice.adv.g.ooze", "basic"), false, "the ooze group");
assert.strictEqual(A.advLevelShows("mm", "slice.adv.g.tower", "basic"), true);
assert.strictEqual(A.advLevelShows("support", "slice.adv.g.tree", "basic"), true);

// Hidden differences: advanced-only, applying now; none in Advanced.
const diff = { sparse_infill_pattern: "gyroid", brim_width: "5", ironing_flow: "15%", ooze_prevention: "1" };
assert.deepStrictEqual(A.advHiddenKeys(diff, "basic").sort(), ["ironing_flow", "ooze_prevention", "sparse_infill_pattern"]);
assert.deepStrictEqual(A.advHiddenKeys(diff, "basic", (k) => k !== "ironing_flow").sort(), ["ooze_prevention", "sparse_infill_pattern"], "ironing's detail without ironing");
assert.deepStrictEqual(A.advHiddenKeys(diff, "advanced"), []);
assert.deepStrictEqual(A.advHiddenKeys({ brim_width: "5", seam_position: "back" }, "basic"), [], "Basic keys only");
assert.deepStrictEqual(A.advHiddenKeys(null, "basic"), []);

// The first level.
assert.strictEqual(A.sliceLevelDefault({}), "basic", "new installation");
assert.strictEqual(A.sliceLevelDefault(undefined), "basic");
assert.strictEqual(A.sliceLevelDefault({ last: "U1", U1: { process: "x", adv: { ironing_type: "top" } } }), "advanced");
assert.strictEqual(A.sliceLevelDefault({ U1: { adv: { ooze_prevention: "1" } } }), "advanced");
assert.strictEqual(A.sliceLevelDefault({ U1: { adv: { brim_width: "5", support_type: "tree(auto)" } } }), "basic", "Basic keys only");
assert.strictEqual(A.sliceLevelDefault({ last: "U1", printer: "p1", "printer:p1": "U1", U1: { adv: {} } }), "basic", "last / printer entries ignored");
assert.strictEqual(A.sliceLevelDefault({ U1: null, U2: "corrupt", U3: { adv: "x" } }), "basic", "a corrupt entry");
assert.strictEqual(A.sliceLevelValid("basic") && A.sliceLevelValid("advanced"), true);
assert.strictEqual(A.sliceLevelValid(null) || A.sliceLevelValid("full"), false);

console.log("adv: ok");
