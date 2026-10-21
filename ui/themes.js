"use strict";
/* Display: light / dark / system mode, a theme and an accent color.

   Loaded in <head>, right after style.css (the browser runs it once the
   stylesheet is in), so the first paint already has the right colors.
   style.css holds Snap Studio's own tokens, light and dark, selected by
   data-scheme on <html>; another theme only writes the tokens it changes,
   inline on <html>. Surfaces drawn outside CSS (WebGL, terminals) read
   the resolved tokens and listen to the "themechange" event.

   The top half is pure (no DOM) and tested by scripts/test-themes.js. */

const DISPLAY_KEY = "snapstudio.display";
const DISPLAY_MODES = ["system", "light", "dark"];
const DISPLAY_DEFAULT = { mode: "system", theme: "studio", accent: "theme" };

/* Accent presets (macOS colors). "theme" takes the theme's own accent,
   "system" the OS accent (AccentColor), a #rrggbb value is custom. */
const ACCENTS = [
  { id: "blue", hex: "#007aff", name: "display.accent.blue" },
  { id: "purple", hex: "#af52de", name: "display.accent.purple" },
  { id: "pink", hex: "#ff2d55", name: "display.accent.pink" },
  { id: "red", hex: "#ff3b30", name: "display.accent.red" },
  { id: "orange", hex: "#ff9500", name: "display.accent.orange" },
  { id: "yellow", hex: "#ffcc00", name: "display.accent.yellow" },
  { id: "green", hex: "#28cd41", name: "display.accent.green" },
  { id: "graphite", hex: "#8e8e93", name: "display.accent.graphite" },
];

/* Themes: each one gives its light and dark values, only for the tokens
   it changes (Snap Studio's are in style.css). `accent` is the theme's
   own accent per mode; none means the system accent. */
const THEMES = [
  { id: "studio", name: "display.theme.studio", sub: "display.theme.studio.sub", accent: null, tokens: { light: {}, dark: {} } },
  {
    id: "space",
    name: "display.theme.space",
    sub: "display.theme.space.sub",
    accent: { light: "#0c63e2", dark: "#3d8bff" },
    tokens: {
      light: {
        "--content-bg": "#f3f4f6",
        "--card-bg": "#ffffff",
        "--card-border": "#e5e7eb",
        "--sidebar-bg": "rgba(247, 249, 252, 0.62)",
        "--sidebar-opaque": "#f7f9fc",
        "--text": "#242424",
        "--text-secondary": "#6b6b6b",
        "--text-tertiary": "#a3a3a3",
        "--separator": "#e5e7eb",
        "--control-bg": "#ffffff",
        "--control-border": "#dcdfe4",
        "--field-bg": "#ffffff",
        "--field-border": "#d9dce1",
        "--sheet-bg": "#f7f9fc",
        "--seg-on": "#ffffff",
        "--thumb-bg": "linear-gradient(160deg, #f7f9fc 0%, #eceef2 100%)",
        "--term-selection": "#c9dcfb",
      },
      dark: {
        "--content-bg": "#171717",
        "--card-bg": "#242424",
        "--card-border": "rgba(255, 255, 255, 0.06)",
        "--sidebar-bg": "rgba(23, 23, 23, 0.62)",
        "--sidebar-opaque": "#1c1c1c",
        "--sidebar-item-hover": "rgba(255, 255, 255, 0.06)",
        "--text": "#f3f4f6",
        "--text-secondary": "#a3a3a3",
        "--text-tertiary": "#6b6b6b",
        "--separator": "#3a3a3a",
        "--control-bg": "rgba(255, 255, 255, 0.06)",
        "--control-border": "#3a3a3a",
        "--field-bg": "#1c1c1c",
        "--field-border": "#4a4a4a",
        "--sheet-bg": "#1e1e1e",
        "--seg-on": "#3a3a3a",
        "--toast-bg": "rgba(36, 36, 36, 0.96)",
        "--thumb-bg": "linear-gradient(160deg, #2a2a2a 0%, #1e1e1e 100%)",
        "--term-selection": "#26406a",
      },
    },
  },
  {
    id: "contrast",
    name: "display.theme.contrast",
    sub: "display.theme.contrast.sub",
    accent: { light: "#0040dd", dark: "#409cff" },
    tokens: {
      light: {
        "--content-bg": "#ffffff",
        "--card-bg": "#ffffff",
        "--card-border": "rgba(0, 0, 0, 0.55)",
        "--sidebar-bg": "rgba(242, 242, 242, 0.94)",
        "--sidebar-opaque": "#f2f2f2",
        "--sidebar-item-hover": "rgba(0, 0, 0, 0.1)",
        "--sidebar-item-selected-inactive": "rgba(0, 0, 0, 0.2)",
        "--text": "#000000",
        "--text-secondary": "#3a3a3c",
        "--text-tertiary": "#6c6c70",
        "--separator": "rgba(0, 0, 0, 0.5)",
        "--control-bg": "#ffffff",
        "--control-border": "rgba(0, 0, 0, 0.6)",
        "--control-bg-hover": "rgba(0, 0, 0, 0.08)",
        "--field-bg": "#ffffff",
        "--field-border": "rgba(0, 0, 0, 0.65)",
        "--focus-ring": "0 0 0 3px var(--accent)",
        "--sheet-bg": "#ffffff",
        "--sheet-shadow": "0 20px 60px rgba(0, 0, 0, 0.35), 0 0 0 2px #000000",
        "--toast-bg": "#000000",
        "--toast-text": "#ffffff",
        "--danger": "#d70015",
        "--warning": "#b25000",
        "--success": "#248a3d",
        "--success-text": "#1b6e2f",
        "--warning-text": "#8a3d00",
        "--ring-track": "rgba(0, 0, 0, 0.2)",
        "--seg-on": "#ffffff",
        "--thumb-bg": "#f2f2f2",
        "--term-selection": "#9cc6ff",
      },
      dark: {
        "--content-bg": "#000000",
        "--card-bg": "#121212",
        "--card-border": "rgba(255, 255, 255, 0.55)",
        "--sidebar-bg": "rgba(10, 10, 10, 0.94)",
        "--sidebar-opaque": "#0a0a0a",
        "--sidebar-item-hover": "rgba(255, 255, 255, 0.14)",
        "--sidebar-item-selected-inactive": "rgba(255, 255, 255, 0.24)",
        "--text": "#ffffff",
        "--text-secondary": "#d1d1d6",
        "--text-tertiary": "#aeaeb2",
        "--separator": "rgba(255, 255, 255, 0.5)",
        "--control-bg": "#1c1c1e",
        "--control-border": "rgba(255, 255, 255, 0.6)",
        "--control-bg-hover": "rgba(255, 255, 255, 0.14)",
        "--field-bg": "#000000",
        "--field-border": "rgba(255, 255, 255, 0.65)",
        "--focus-ring": "0 0 0 3px var(--accent)",
        "--sheet-bg": "#121212",
        "--sheet-shadow": "0 20px 60px rgba(0, 0, 0, 0.7), 0 0 0 2px #ffffff",
        "--toast-bg": "#ffffff",
        "--toast-text": "#000000",
        "--danger": "#ff6961",
        "--warning": "#ffb340",
        "--success": "#30db5b",
        "--success-text": "#30db5b",
        "--warning-text": "#ffb340",
        "--ring-track": "rgba(255, 255, 255, 0.3)",
        "--seg-on": "#3a3a3c",
        "--thumb-bg": "#1c1c1e",
        "--term-selection": "#1f4a8a",
      },
    },
  },
];

const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
const DISPLAY_HEX = /^#[0-9a-f]{6}$/;

/* Stored settings, made safe: unknown values fall back to the defaults. */
function displayNormalize(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const accent = String(s.accent || "").toLowerCase();
  return {
    mode: DISPLAY_MODES.includes(s.mode) ? s.mode : DISPLAY_DEFAULT.mode,
    theme: THEMES.some((t) => t.id === s.theme) ? s.theme : DISPLAY_DEFAULT.theme,
    accent: accent === "theme" || accent === "system" || ACCENTS.some((a) => a.id === accent) || DISPLAY_HEX.test(accent) ? accent : DISPLAY_DEFAULT.accent,
  };
}

const displayResolveMode = (mode, systemDark) => (mode === "light" || mode === "dark" ? mode : systemDark ? "dark" : "light");

/* The accent to write (#rrggbb), or null for the system accent. */
function displayAccent(s, mode) {
  if (s.accent === "system") return null;
  if (s.accent === "theme") return themeById(s.theme).accent?.[mode] || null;
  const preset = ACCENTS.find((a) => a.id === s.accent);
  return preset ? preset.hex : s.accent;
}

/* Tokens written inline for these settings in this mode: the theme's
   overrides and the accent. --accent-text is added by the caller once the
   accent's color is known (AccentColor is only known to the browser). */
function displayTokens(s, mode) {
  const out = { ...themeById(s.theme).tokens[mode] };
  const accent = displayAccent(s, mode);
  if (accent) out["--accent"] = accent;
  return out;
}

/* Colors: "#rgb", "#rrggbb", "rgb(…)" or "rgba(…)" → [r, g, b, a]. */
function parseColor(c) {
  c = String(c).trim().toLowerCase();
  let m = c.match(/^#([0-9a-f]{3})$/);
  if (m) return [...m[1]].map((x) => parseInt(x + x, 16)).concat(1);
  m = c.match(/^#([0-9a-f]{6})$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.slice(0, 3).every(isFinite)) return [p[0], p[1], p[2], p.length > 3 && isFinite(p[3]) ? p[3] : 1];
  }
  return null;
}

/* A translucent color seen over an opaque background. */
const blendOver = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);

function luminance([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/* WCAG contrast ratio between two opaque colors. */
function contrastRatio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* Text on an accent: white, as on macOS, unless the accent is too light
   for it (yellow, orange, light blue…): then near-black. */
const accentTextFor = (rgb) => (contrastRatio(rgb, [255, 255, 255]) >= 3 ? "#ffffff" : "#1d1d1f");

/* ------------------------------------------------------------ applying */

let DISPLAY = DISPLAY_DEFAULT;
let displayApplied = [];
let displayLast = "";

function displayLoad() {
  try {
    return displayNormalize(JSON.parse(localStorage.getItem(DISPLAY_KEY) || "null"));
  } catch {
    return { ...DISPLAY_DEFAULT };
  }
}

const displaySystemDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/* A CSS color expression resolved by the browser (AccentColor, var()…),
   as "rgb(…)". Works in <head>, before <body> exists. */
function cssColor(expr) {
  const probe = document.createElement("i");
  probe.style.color = expr;
  probe.style.display = "none";
  (document.body || document.documentElement).appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

/* Applies settings to <html>; fires "themechange" when the result
   changed, and aligns the native window (title bar, vibrancy). */
function displayApply(s = DISPLAY) {
  DISPLAY = displayNormalize(s);
  const root = document.documentElement;
  const mode = displayResolveMode(DISPLAY.mode, displaySystemDark());
  root.dataset.scheme = mode;
  root.dataset.theme = DISPLAY.theme;
  for (const k of displayApplied) root.style.removeProperty(k);
  const tokens = displayTokens(DISPLAY, mode);
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  const rgb = parseColor(cssColor("var(--accent)")) || [0, 122, 255];
  root.style.setProperty("--accent-text", accentTextFor(rgb));
  displayApplied = [...Object.keys(tokens), "--accent-text"];
  displayNative();
  const sig = JSON.stringify([mode, tokens, rgb]);
  if (sig !== displayLast) {
    const first = !displayLast;
    displayLast = sig;
    if (!first) window.dispatchEvent(new Event("themechange"));
  }
}

function displaySet(patch) {
  const next = displayNormalize({ ...DISPLAY, ...patch });
  localStorage.setItem(DISPLAY_KEY, JSON.stringify(next));
  displayApply(next);
}

/* A forced mode also forces the window's appearance (macOS title bar
   and vibrancy, Windows title bar); System gives it back to the OS. */
let displayNativeMode;
function displayNative() {
  const want = DISPLAY.mode === "system" ? null : DISPLAY.mode;
  if (want === displayNativeMode) return;
  displayNativeMode = want;
  try {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    win?.setTheme?.(want)?.catch?.(() => {});
  } catch {}
}

const isDark = () => document.documentElement.dataset.scheme === "dark";

if (typeof document !== "undefined" && typeof window !== "undefined") {
  displayApply(displayLoad());
  // System mode follows the OS as it changes.
  if (typeof matchMedia === "function") {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (DISPLAY.mode === "system") displayApply();
    });
  }
  // Another window of the app changed the settings.
  window.addEventListener("storage", (e) => e.key === DISPLAY_KEY && displayApply(displayLoad()));
}

if (typeof module !== "undefined") {
  module.exports = {
    DISPLAY_DEFAULT, DISPLAY_MODES, ACCENTS, THEMES, themeById, displayNormalize, displayResolveMode, displayAccent,
    displayTokens, parseColor, blendOver, contrastRatio, accentTextFor,
  };
}
