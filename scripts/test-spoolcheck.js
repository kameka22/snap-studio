// node scripts/test-spoolcheck.js — spool check before sending.
const assert = require("assert");
const S = require("../ui/spoolcheck.js");

// Material families: case, suffixes, aliases.
for (const m of ["PLA", "pla", "PLA+", "PLA Matte", "PLA Silk", "PLA-CF", " pla basic "]) assert.equal(S.spMaterialFamily(m), "PLA", m);
assert.equal(S.spMaterialFamily("PETG"), "PETG");
assert.equal(S.spMaterialFamily("PETG-CF"), "PETG");
assert.equal(S.spMaterialFamily("PET"), "PET");
assert.equal(S.spMaterialFamily("PCTG"), "PCTG");
assert.equal(S.spMaterialFamily("PC"), "PC");
assert.equal(S.spMaterialFamily("Nylon"), "PA");
assert.equal(S.spMaterialFamily("PA12-CF"), "PA");
assert.equal(S.spMaterialFamily("TPU 95A"), "TPU");
assert.equal(S.spMaterialFamily(""), "");
assert.equal(S.spMaterialFamily("?"), "");
assert.equal(S.spMaterialFromName("Snapmaker PLA SnapSpeed @U1"), "PLA");
assert.equal(S.spMaterialFromName("Generic PETG @Snapmaker U1"), "PETG");
assert.equal(S.spMaterialFromName("Mon profil"), "");

// Colors: small differences tolerated, clear ones not.
assert.ok(S.spColorDelta("#ff0000", "#f01010") < S.SP_COLOR_TOL);
assert.ok(S.spColorDelta("#FFFFFF", "#f4f4f0FF") < S.SP_COLOR_TOL, "white / off-white, RGBA accepted");
assert.ok(S.spColorDelta("#ff0000", "#000000") > S.SP_COLOR_TOL);
assert.ok(S.spColorDelta("#0047ab", "#00a651") > S.SP_COLOR_TOL, "blue / green");
assert.equal(S.spColorDelta("", "#000000"), Infinity);

const slots = [
  { index: 0, present: true, kind: "PLA", sub_type: "Matte", color: "#ffffff", vendor: "Snapmaker" },
  { index: 1, present: true, kind: "PLA", sub_type: "", color: "#e01010" },
  { index: 2, present: true, kind: "PETG", sub_type: "", color: "#000000" },
  { index: 3, present: false, kind: "", color: null },
];

// Expected: slice-time spool colors and profile types win, G-code fills gaps.
const exp = S.spExpected({
  tools: [0, 2, 2],
  profile: { filaments: ["Snapmaker PLA @U1", "x", "Generic PLA @U1"], colors: ["#FFFFFF", null, "#ff0000"] },
  stats: { filament_types: ["PLA", "PLA", ""], filament_colors: ["#000000", "", "#00ff00"] },
});
assert.deepEqual(exp, [{ tool: 0, material: "PLA", color: "#ffffff" }, { tool: 2, material: "PLA", color: "#ff0000" }]);
assert.deepEqual(S.spExpected({ tools: [], stats: { filament_types: ["PETG"], filament_colors: ["#123456"] } }), [{ tool: 0, material: "PETG", color: "#123456" }]);
assert.equal(S.spExpected({ tools: [1], profile: { filaments: ["", "Mine"] }, ftypeOf: (n) => (n === "Mine" ? "TPU" : "") })[0].material, "TPU");

// T2: red PLA expected, black PETG loaded → material and color. T0 fits. T1, T3 unused: ignored.
let mm = S.spMismatches(exp, slots);
assert.equal(mm.length, 1);
assert.equal(mm[0].tool, 2);
assert.deepEqual(mm[0].reasons, ["material", "color"]);
// Same material, near color: no warning.
assert.equal(S.spMismatches([{ tool: 1, material: "PLA", color: "#ff0000" }], slots).length, 0);
// Only the color differs.
assert.deepEqual(S.spMismatches([{ tool: 0, material: "PLA", color: "#ff0000" }], slots)[0].reasons, ["color"]);
// Unknown expectations: nothing to compare.
assert.equal(S.spMismatches([{ tool: 2, material: "", color: "" }], slots).length, 0);
// Empty and unknown heads are warnings.
assert.deepEqual(S.spMismatches([{ tool: 3, material: "PLA", color: "" }], slots)[0].reasons, ["empty"]);
assert.deepEqual(S.spMismatches([{ tool: 3, material: "PLA", color: "" }], [])[0].reasons, ["unknown"]);
assert.deepEqual(S.spMismatches([{ tool: 0, material: "PLA", color: "" }], [{ index: 0, present: true, kind: "" }])[0].reasons, ["unknown"]);

// Substitution: T2 → head 1 (red PLA) clears the warning.
assert.equal(S.spSuggest(exp[1], slots, new Set([0])), 1);
assert.equal(S.spSuggest(exp[1], slots, new Set([0, 1])), null, "head 1 taken");
const map = S.spRemap([0, 2], { 2: 1 });
assert.deepEqual(map, [[2, 1]]);
assert.equal(S.spMismatches(exp, slots, map).length, 0);
assert.equal(S.spHeadOf(2, map), 1);
assert.equal(S.spHeadOf(0, map), 0);
// Keeping its own head is no change.
assert.deepEqual(S.spRemap([0, 2], { 2: 2 }), []);
assert.deepEqual(S.spRemap([0, 2], {}), []);
// Swap is fine; two tools on one head, or a head that does not exist, are not.
assert.deepEqual(S.spRemap([0, 1], { 0: 1, 1: 0 }), [[0, 1], [1, 0]]);
assert.throws(() => S.spRemap([0, 2], { 2: 0 }), /two tools/);
assert.throws(() => S.spRemap([0], { 0: 4 }), /no head/);
// Picks of tools the print does not use are ignored.
assert.deepEqual(S.spRemap([0], { 3: 1 }), []);

// ---------------------------------------------------------------- re-slicing
// Which action leads: another family → re-slice; colors only / fixed by substitution → substitution.
const bad01 = S.spMismatches([{ tool: 0, material: "PLA", color: "#ff8a00" }, { tool: 1, material: "PLA", color: "#e01b1b" }], slots);
assert.equal(S.spPrimary(bad01, slots, []), "reslice", "T1 holds PETG: another family");
const colorOnly = S.spMismatches([{ tool: 1, material: "PLA", color: "#0000ff" }], slots);
assert.deepEqual(colorOnly[0].reasons, ["color"]);
assert.equal(S.spPrimary(colorOnly, slots, [[1, 0]]), "substitute", "only the color differs, a substitute is chosen");
assert.equal(S.spPrimary(colorOnly, slots, []), "reslice", "nothing chosen: re-slicing is what fixes it");
const slots4 = [...slots.slice(0, 3), { index: 3, present: true, kind: "PLA", color: "#d42a2a" }];
const t1 = S.spMismatches([{ tool: 1, material: "PLA", color: "#0000ff" }], slots4);
assert.equal(t1.length, 1);
assert.equal(S.spPrimary(t1, slots4, [[1, 3]]), "substitute", "substitute is PLA too: only colors differ");
assert.equal(S.spPrimary(t1, slots4, [[1, 2]]), "reslice", "substitute is PETG");

// Generic preset of a family.
const list = [
  { name: "Snapmaker PLA @U1", ftype: "PLA" },
  { name: "Generic PLA @U1", ftype: "PLA" },
  { name: "Generic PETG @U1", ftype: "PETG" },
  { name: "My PETG", ftype: "PETG", user: true },
  { name: "Generic TPU", ftype: "" },
];
assert.equal(S.spGenericPreset("PETG", list), "Generic PETG @U1");
assert.equal(S.spGenericPreset("TPU", list), "Generic TPU", "family read from the name");
assert.equal(S.spGenericPreset("ABS", list), null);

// Assignment: the same plate, the substitute's head and preset.
const best = (slot, l) => l.find((p) => p.ftype === slot.kind && /Snapmaker/.test(p.name))?.name || null;
const req = {
  source: "", name: "dragon", machine: "U1", process: "0.20mm",
  filaments: ["Snapmaker PLA @U1", "Snapmaker PLA @U1", "Snapmaker PLA @U1", "Snapmaker PLA @U1"],
  colors: ["#ff8a00", "#e01b1b", null, null],
  overrides: { curr_bed_type: "Textured PEI Plate" },
  scene: [{ path: "/m/a.3mf", item: 0, pos: [1, 2], extruder_map: [0, 1, 1] }, { path: "/m/b.stl", item: 0, pos: [3, 4], extruder_map: [] }],
};
const slotsR = [
  { index: 0, present: true, kind: "PLA", color: "#f2d21b" },
  { index: 1, present: true, kind: "PETG", color: "#111111" },
  { index: 2, present: false, kind: "" },
  { index: 3, present: true, kind: "PLA", sub_type: "Matte", color: "#D42A2A" },
];
// T1 → head 3 (red PLA); T0 kept: it takes the yellow PLA loaded on head 0.
let out = S.spResliceRequest(req, { used: [0, 1], picks: { 1: 3 }, tools: [0, 1], slots: slotsR, list, best });
assert.deepEqual(out.request.scene.map((i) => i.extruder_map), [[0, 3, 3], []], "model colors follow T1 to head 3; single-color part stays on 0");
assert.equal(out.request.filaments[3], "Snapmaker PLA @U1");
assert.equal(out.request.colors[3], "#d42a2a");
assert.equal(out.request.colors[0], "#f2d21b", "kept head takes the color loaded now");
assert.equal(out.request.colors[1], "#e01b1b", "head 1 no longer used: left alone");
assert.deepEqual(out.heads, [{ tool: 0, head: 0, preset: "Snapmaker PLA @U1", generic: false }, { tool: 1, head: 3, preset: "Snapmaker PLA @U1", generic: false }]);
assert.equal(out.request.overrides.curr_bed_type, "Textured PEI Plate", "rest of the request unchanged");
assert.deepEqual(req.scene[0].extruder_map, [0, 1, 1], "original request untouched");
// No substitute: the spool on the head now (PETG), no Snapmaker PETG preset → generic, flagged.
out = S.spResliceRequest(req, { used: [0, 1], picks: {}, tools: [1], slots: slotsR, list, best });
assert.equal(out.request.filaments[1], "Generic PETG @U1");
assert.equal(out.request.colors[1], "#111111");
assert.equal(out.heads[0].generic, true);
assert.deepEqual(out.request.scene[0].extruder_map, [0, 1, 1]);
// Single-color part moved: an empty map becomes [head].
out = S.spResliceRequest({ ...req, scene: [{ path: "/m/b.stl", item: 0, pos: [0, 0], extruder_map: [] }] }, { used: [0], picks: { 0: 3 }, tools: [0], slots: slotsR, list, best });
assert.deepEqual(out.request.scene[0].extruder_map, [3]);
// Single source (no scene): its extruder_map is remapped.
out = S.spResliceRequest({ ...req, scene: [], source: "/m/a.3mf", extruder_map: [0, 1] }, { used: [0, 1], picks: { 0: 1, 1: 0 }, tools: [0, 1], slots: slotsR, list, best });
assert.deepEqual(out.request.extruder_map, [1, 0], "swap");
// Short filament list: padded up to the head.
out = S.spResliceRequest({ ...req, filaments: ["Snapmaker PLA @U1"], colors: ["#fff"] }, { used: [0], picks: { 0: 3 }, tools: [0], slots: slotsR, list, best });
assert.equal(out.request.filaments.length, 4);
assert.equal(out.request.colors[3], "#d42a2a");
// Errors: empty head, no preset at all, no project.
assert.throws(() => S.spResliceRequest(req, { used: [2], tools: [2], slots: slotsR, list, best }), /T2: no spool/);
assert.throws(() => S.spResliceRequest(req, { used: [0], tools: [0], slots: [{ index: 0, present: true, kind: "ABS", color: "#000000" }], list, best }), /no ABS preset/);
assert.throws(() => S.spResliceRequest(null, { used: [0], tools: [0], slots: slotsR, list, best }), /no project/);
assert.throws(() => S.spResliceRequest(req, { used: [0, 1], picks: { 1: 0 }, tools: [1], slots: slotsR, list, best }), /two tools/);

console.log("spoolcheck.js OK");
