"use strict";
/* Settings of the slice sheet's Advanced panels shown only with the one
   they detail (slice-adv.js ADV_WHEN). Pure, for scripts/test-adv.js. */

const advTrue = (v) => String(v) === "1" || v === true || String(v) === "true";

/* key → { on: the setting it details, when(value of that setting) }. */
const ADV_DEPENDS = {
  // The speeds by how much a line overhangs: when it slows down for them.
  ...Object.fromEntries(["overhang_1_4_speed", "overhang_2_4_speed", "overhang_3_4_speed", "overhang_4_4_speed"].map((k) => [k, { on: "enable_overhang_speed", when: advTrue }])),
  // Ironing's pattern, flow, spacing and speed: with ironing.
  ...Object.fromEntries(["ironing_pattern", "ironing_flow", "ironing_spacing", "ironing_speed"].map((k) => [k, { on: "ironing_type", when: (v) => v != null && v !== "no ironing" }])),
  // Fuzzy skin's thickness and spacing: with fuzzy skin.
  ...Object.fromEntries(["fuzzy_skin_thickness", "fuzzy_skin_point_distance"].map((k) => [k, { on: "fuzzy_skin", when: (v) => v != null && v !== "none" }])),
  // The skirt's distance, height and draft shield: with a skirt.
  ...Object.fromEntries(["skirt_distance", "skirt_height", "draft_shield"].map((k) => [k, { on: "skirt_loops", when: (v) => +v > 0 }])),
};

/* Whether `k` is shown, `val(key)` giving the values in effect. */
function advShown(k, val) {
  const d = ADV_DEPENDS[k];
  return !d || d.when(val(d.on));
}

if (typeof module !== "undefined") module.exports = { ADV_DEPENDS, advShown, advTrue };
