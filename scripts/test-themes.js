// node scripts/test-themes.js — display settings: themes, mode, accent, contrast.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const T = require("../ui/themes.js");

const css = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8");
// Snap Studio's tokens, light and dark, as written in style.css.
const block = (head) => {
  const at = css.indexOf(head);
  assert.ok(at >= 0, `token block ${head}`);
  const body = css.slice(at + head.length, css.indexOf("\n}\n", at));
  return Object.fromEntries([...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
};
const LIGHT = block(':root,\n[data-scheme="light"] {');
const DARK = { ...LIGHT, ...block('[data-scheme="dark"] {') };
assert.strictEqual(LIGHT["--content-bg"], "#f3f3f5");
assert.strictEqual(DARK["--content-bg"], "#1e1e20");

// The mode is only decided by tokens on data-scheme: no media query left.
assert.ok(!/prefers-color-scheme/.test(css), "style.css follows data-scheme, not the media query");

// Settings are normalised.
assert.deepStrictEqual(T.displayNormalize(null), T.DISPLAY_DEFAULT);
assert.deepStrictEqual(T.displayNormalize({ mode: "dim", theme: "nope", accent: "javascript:x" }), T.DISPLAY_DEFAULT);
assert.deepStrictEqual(T.displayNormalize({ mode: "dark", theme: "space", accent: "#A1B2C3" }), { mode: "dark", theme: "space", accent: "#a1b2c3" });
assert.deepStrictEqual(T.displayNormalize({ accent: "green" }).accent, "green");
assert.strictEqual(T.displayNormalize({ accent: "#fff" }).accent, "theme", "only #rrggbb");

// Mode resolution.
assert.strictEqual(T.displayResolveMode("system", true), "dark");
assert.strictEqual(T.displayResolveMode("system", false), "light");
assert.strictEqual(T.displayResolveMode("light", true), "light");
assert.strictEqual(T.displayResolveMode("dark", false), "dark");

// Accent: theme's own, system (null: the CSS keeps AccentColor), preset, custom.
const S = (o) => T.displayNormalize({ ...T.DISPLAY_DEFAULT, ...o });
assert.strictEqual(T.displayAccent(S({}), "light"), null, "Snap Studio: system accent");
assert.strictEqual(T.displayAccent(S({ theme: "space" }), "light"), "#0c63e2");
assert.strictEqual(T.displayAccent(S({ theme: "space" }), "dark"), "#3d8bff");
assert.strictEqual(T.displayAccent(S({ theme: "space", accent: "system" }), "dark"), null);
assert.strictEqual(T.displayAccent(S({ accent: "purple" }), "dark"), "#af52de");
assert.strictEqual(T.displayAccent(S({ accent: "#123456" }), "light"), "#123456");

// Tokens written inline: nothing for the default look.
assert.deepStrictEqual(T.displayTokens(S({}), "light"), {});
assert.deepStrictEqual(T.displayTokens(S({}), "dark"), {});
assert.deepStrictEqual(T.displayTokens(S({ accent: "red" }), "light"), { "--accent": "#ff3b30" });
const space = T.displayTokens(S({ theme: "space" }), "dark");
assert.strictEqual(space["--content-bg"], "#171717");
assert.strictEqual(space["--accent"], "#3d8bff");

// Every token a theme writes exists in style.css (no typo silently ignored).
for (const t of T.THEMES) {
  assert.ok(t.name.startsWith("display.theme.") && t.sub, t.id);
  for (const mode of ["light", "dark"]) {
    for (const k of Object.keys(t.tokens[mode])) assert.ok(k in LIGHT, `${t.id}/${mode}: unknown token ${k}`);
  }
}
assert.deepStrictEqual(T.THEMES.map((t) => t.id), ["studio", "space", "contrast"]);

// Colors.
assert.deepStrictEqual(T.parseColor("#fff"), [255, 255, 255, 1]);
assert.deepStrictEqual(T.parseColor("rgba(10, 20, 30, 0.5)"), [10, 20, 30, 0.5]);
assert.deepStrictEqual(T.parseColor("rgb(1 2 3 / 0.25)"), [1, 2, 3, 0.25]);
assert.strictEqual(T.parseColor("AccentColor"), null);
assert.ok(Math.abs(T.contrastRatio([0, 0, 0], [255, 255, 255]) - 21) < 1e-9);
assert.strictEqual(T.accentTextFor([0, 122, 255]), "#ffffff", "white on the macOS blue");
assert.strictEqual(T.accentTextFor(T.parseColor("#ffcc00")), "#1d1d1f", "dark on yellow");
assert.strictEqual(T.accentTextFor(T.parseColor("#28cd41")), "#1d1d1f", "dark on light green");

// Contrast per theme and mode (WCAG): text AA everywhere (Apple's own
// secondary text is lighter by design); the new themes keep their
// secondary text AA; High contrast is AAA, with visible borders.
const opaque = (c, bg) => {
  const p = T.parseColor(c);
  assert.ok(p, `color ${c}`);
  return p[3] < 1 ? T.blendOver(p, bg) : p;
};
for (const t of T.THEMES) {
  for (const mode of ["light", "dark"]) {
    const tok = { ...(mode === "dark" ? DARK : LIGHT), ...t.tokens[mode] };
    for (const surface of ["--content-bg", "--card-bg", "--sheet-bg"]) {
      const bg = opaque(tok[surface], [0, 0, 0, 1]);
      const ratio = (k) => T.contrastRatio(opaque(tok[k], bg), bg);
      const where = `${t.id}/${mode} on ${surface}`;
      assert.ok(ratio("--text") >= (t.id === "contrast" ? 15 : 7), `${where}: text ${ratio("--text").toFixed(2)}`);
      if (t.id !== "studio") assert.ok(ratio("--text-secondary") >= (t.id === "contrast" ? 7 : 4.5), `${where}: secondary ${ratio("--text-secondary").toFixed(2)}`);
      if (t.id === "contrast") {
        assert.ok(ratio("--separator") >= 3, `${where}: separator ${ratio("--separator").toFixed(2)}`);
        assert.ok(ratio("--control-border") >= 3, `${where}: control border`);
      }
    }
    // Text on the theme's own accent (primary buttons, selection).
    const acc = t.accent?.[mode];
    if (acc) {
      const a = T.parseColor(acc);
      const fg = T.parseColor(T.accentTextFor(a));
      assert.ok(T.contrastRatio(a, fg) >= (t.id === "contrast" ? 4.5 : 3), `${t.id}/${mode}: text on accent`);
      // The accent itself stands out from the page (links, focus, selected rows).
      const bg = opaque(tok["--content-bg"], [0, 0, 0, 1]);
      assert.ok(T.contrastRatio(a, bg) >= 3, `${t.id}/${mode}: accent on page`);
    }
  }
}

// The page's scripts share one global scope: themes.js (loaded first)
// must not declare a name another script declares too.
const UI = path.join(__dirname, "..", "ui");
const decl = /^(?:async )?function (\w+)|^(?:const|let|var|class) (\w+)/gm;
const seen = new Map();
for (const f of fs.readdirSync(UI).filter((f) => f.endsWith(".js"))) {
  for (const m of fs.readFileSync(path.join(UI, f), "utf8").matchAll(decl)) {
    const name = m[1] || m[2];
    assert.ok(!seen.has(name), `${name} declared in ${seen.get(name)} and ${f}`);
    seen.set(name, f);
  }
}

console.log("themes: ok");
