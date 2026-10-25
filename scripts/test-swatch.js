// node scripts/test-swatch.js — head pickers shown as spools.
const assert = require("assert");
const S = require("../ui/swatch-logic.js");

// Luminance and the dot's edge: close to white or black only.
assert.strictEqual(S.swLuma("nope"), null);
assert.strictEqual(S.swLuma(""), null);
assert.ok(Math.abs(S.swLuma("#ffffff") - 1) < 1e-9);
assert.strictEqual(S.swLuma("#000000"), 0);
assert.ok(S.swLuma("#ff0000") > 0.2 && S.swLuma("#ff0000") < 0.22, "sRGB red ≈ 0.2126");
assert.strictEqual(S.swLuma("#FFFFFFFF"), S.swLuma("#ffffff"), "RGBA as the printer reports it");
for (const c of ["#ffffff", "#f4f4f0", "#000000", "#1a1a1a"]) assert.strictEqual(S.swEdge(c), true, c);
for (const c of ["#ff0000", "#0047ab", "#808080", "#f5c400", "", null]) assert.strictEqual(S.swEdge(c), false, String(c));

// Heads: loaded with a colour, empty, loaded without a colour, not read.
const slots = [
  { index: 0, present: true, kind: "PLA", color: "#ff0000" },
  { index: 1, present: false },
  { index: 2, present: true, kind: "PETG", color: "" },
];
const heads = S.swHeads({ count: 4, slots, material: (h) => (h === 3 ? "TPU" : h === 2 ? "" : "PLA"), base: 1, warn: [2] });
assert.deepStrictEqual(heads.map((e) => e.state), ["ok", "empty", "unknown", "none"]);
assert.deepStrictEqual(heads.map((e) => e.value), ["1", "2", "3", "4"], "advanced values from 1");
assert.deepStrictEqual(heads.map((e) => e.h), [0, 1, 2, 3], "shown heads from 0");
assert.deepStrictEqual(heads.map((e) => e.kind), ["PLA", "PLA", "PETG", "TPU"], "the profile's material, else the spool's");
assert.deepStrictEqual(heads.map((e) => e.color), ["#ff0000", "", "", ""]);
assert.ok(heads.every((e) => !e.disabled), "an empty head stays pickable: the spool can be loaded later");
assert.deepStrictEqual(heads.map((e) => e.warn), [false, false, true, false]);
// Map and Prepare heads are 0-based.
assert.deepStrictEqual(S.swHeads({ count: 2 }).map((e) => e.value), ["0", "1"]);
assert.deepStrictEqual(S.swHeads({ count: 0 }), []);
// Offline: nothing read, every head neutral.
assert.ok(S.swHeads({ count: 4, slots: [] }).every((e) => e.state === "none" && !e.color));

// Entries: "Automatic" first; a stored head the printer lacks is shown, not pickable.
const e1 = S.swEntries(heads, { value: "0", auto: { value: "0" }, base: 1 });
assert.strictEqual(e1[0].state, "auto");
assert.strictEqual(e1[0].value, "0", "0 is Automatic, not T0");
assert.strictEqual(e1.length, 5);
assert.strictEqual(e1[0].warn, false);
assert.strictEqual(S.swEntries(heads, { auto: { value: "0", warn: true }, base: 1 })[0].warn, true, "Automatic flagged");
const e2 = S.swEntries(heads, { value: "6", auto: { value: "0" }, base: 1 });
const lost = e2[e2.length - 1];
assert.deepStrictEqual([lost.value, lost.h, lost.state, lost.disabled], ["6", 5, "unavailable", true], "T5 kept as it is");
assert.strictEqual(S.swEntries(heads, { value: "3", base: 1 }).length, 4, "a known head adds nothing");
assert.strictEqual(S.swEntries(heads, { value: "", base: 1 }).length, 4);
assert.strictEqual(S.swEntries(heads, { value: null, base: 1 }).length, 4);
assert.strictEqual(S.swEntries(S.swHeads({ count: 2 }), { value: "3" }).pop().h, 3, "0-based value");

// Roving focus: wraps, Home/End, skips disabled ones.
const it = [{}, { disabled: true }, {}, {}];
assert.strictEqual(S.swMove(it, 0, "ArrowRight"), 2, "skips the disabled one");
assert.strictEqual(S.swMove(it, 2, "ArrowLeft"), 0);
assert.strictEqual(S.swMove(it, 3, "ArrowDown"), 0, "wraps forward");
assert.strictEqual(S.swMove(it, 0, "ArrowUp"), 3, "wraps back");
assert.strictEqual(S.swMove(it, 2, "Home"), 0);
assert.strictEqual(S.swMove(it, 0, "End"), 3);
assert.strictEqual(S.swMove([{ disabled: true }, {}, { disabled: true }], 1, "End"), 1);
assert.strictEqual(S.swMove(it, 0, "Enter"), -1, "not a move");
assert.strictEqual(S.swMove([{ disabled: true }], 0, "ArrowRight"), -1, "nothing to move to");
assert.strictEqual(S.swMove([], 0, "Home"), -1);

console.log("swatch: ok");
