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

console.log("adv: ok");
