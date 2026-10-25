// node scripts/test-visual.js — pictures for the slice settings' lists.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const V = require("../ui/visual-logic.js");
const I = require("../ui/slice-icons.js");

// The control a list gets.
assert.strictEqual(V.vpMode(3, 3), "pills");
assert.strictEqual(V.vpMode(2, 1), "pills", "half pictured is enough");
assert.strictEqual(V.vpMode(4, 4), "visual");
assert.strictEqual(V.vpMode(7, 4), "visual");
assert.strictEqual(V.vpMode(7, 3), "select", "fewer than half pictured, too many to segment");
assert.strictEqual(V.vpMode(4, 1), "segmented");
assert.strictEqual(V.vpMode(2, 0), "segmented");
assert.strictEqual(V.vpMode(5, 0), "select");
assert.strictEqual(V.vpMode(0, 0), "segmented");
assert.strictEqual(V.vpColumns(4), 2);
assert.strictEqual(V.vpColumns(5), 3);

// Support styles by type, as Orca; the style after a type change.
assert.deepStrictEqual(V.vpStyles("normal(auto)"), ["default", "grid", "snug"]);
assert.deepStrictEqual(V.vpStyles("tree(manual)"), ["default", "tree_slim", "tree_strong", "tree_hybrid", "organic"]);
assert.strictEqual(V.vpStyles(undefined), V.VP_STYLES.normal);
assert.strictEqual(V.vpStyleAfterType("tree(auto)", "snug"), "default");
assert.strictEqual(V.vpStyleAfterType("normal(auto)", "organic"), "default");
assert.strictEqual(V.vpStyleAfterType("tree(auto)", "organic"), "organic");
assert.strictEqual(V.vpStyleAfterType("normal(manual)", "grid"), "grid");
assert.strictEqual(V.vpStyleAfterType("tree(auto)", "default"), "default");

// A value the list does not offer: kept, chosen, marked.
const opts = [["auto_brim", "Auto"], ["outer_only", "Outer brim only"]];
assert.deepStrictEqual(V.vpEntries(opts, "outer_only").map((e) => e.state), ["ok", "ok"]);
const hid = V.vpEntries(opts, "painted", ["auto_brim", "outer_only", "painted", "no_brim"]);
assert.deepStrictEqual(hid[2], { value: "painted", label: "painted", state: "hidden" });
assert.strictEqual(V.vpEntries(opts, "spiral", ["auto_brim"])[2].state, "unknown");
assert.strictEqual(V.vpEntries(opts, "").length, 2);
assert.strictEqual(V.vpEntries(opts, null).length, 2);

// Every option the panel shows today has a picture; the icons are clean.
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ui", "assets", "orca-settings.en.json"), "utf8"));
const HIDE = { brim_type: ["no_brim", "painted"] };
let shown = 0;
for (const k of ["support_type", "support_style", "support_interface_pattern", "support_base_pattern", "brim_type", "seam_position"]) {
  const vals = Object.keys(cat.keys[k].enum).filter((v) => !(HIDE[k] || []).includes(v));
  for (const v of vals) assert.ok(I.SLICE_ICONS[k]?.[v], `icon for ${k}=${v}`);
  shown += vals.length;
}
assert.strictEqual(shown, 32, "32 options shown");
for (const s of [...I.SLICE_ICON_SVG]) {
  assert.ok(/^<svg viewBox="[\d. ]+"[^>]*aria-hidden="true" focusable="false">/.test(s), s.slice(0, 60));
  assert.ok(!/\bid=|<defs|<image|<script|\swidth=|\sheight=/.test(s.replace(/<rect[^>]*>/g, "")), "no id, defs, size");
  assert.ok(!/#[0-9a-f]{3,8}\b|rgb/i.test(s), "no hard-coded colour");
  for (const v of s.match(/var\(--[^)]*\)/g) || []) assert.ok(["var(--vp-p, currentColor)", "var(--vp-s, currentColor)"].includes(v), v);
}
assert.ok(I.SLICE_ICON_UNKNOWN.includes("aria-hidden"));
const size = fs.statSync(path.join(__dirname, "..", "ui", "slice-icons.js")).size;
assert.ok(size <= 20 * 1024, `slice-icons.js ${size} bytes, budget 20 KB`);

// The settings catalog's "Aligned back" is untranslated in French: the app has its own words.
const fr = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ui", "i18n", "fr.json"), "utf8"));
assert.strictEqual(fr["slice.vp.label.seam_position.aligned_back"], "Alignée à l'arrière");
// An explanation per option shown, in each language.
const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ui", "i18n", "en.json"), "utf8"));
for (const k in I.SLICE_ICONS) for (const v in I.SLICE_ICONS[k]) for (const c of [en, fr]) assert.ok(c[`slice.vp.${k}.${v}`], `slice.vp.${k}.${v}`);

console.log("visual: ok");
