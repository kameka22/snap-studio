"use strict";
/* Interface language.

   The catalogs (ui/i18n/*.json) are injected by Rust before any script runs,
   with the current language, as `window.__I18N__`. They are shared with the
   native side, which uses them for menus and messages.

   - Static markup carries its key in an attribute and is filled by
     `applyI18n()`: data-i18n (text), data-i18n-html (trusted markup from the
     catalog), data-i18n-title, data-i18n-placeholder, data-i18n-aria, data-i18n-alt.
   - Code calls `tr(key, params)` (not `t`, a common local name here). A plural entry is an object keyed by
     Intl.PluralRules categories and picks its form from `params.n`.
   - Changing language re-applies the markup and fires "langchange" on window:
     every view that builds text in code re-renders on it, like "themechange". */

const I18N = window.__I18N__ || { lang: "en", catalogs: {} };
I18N.catalogs.en = I18N.catalogs.en || {};
let LANG = I18N.catalogs[I18N.lang] ? I18N.lang : "en";

/* Languages offered by the pickers, each named in its own language. */
const LANG_NAMES = { en: "English", fr: "Français" };
const LOCALES = { en: "en-US", fr: "fr-FR" };
const locale = () => LOCALES[LANG] || "en-US";

let PLURALS = new Intl.PluralRules(locale());

function tRaw(key) {
  const own = I18N.catalogs[LANG]?.[key];
  return own ?? I18N.catalogs.en[key] ?? key;
}

/* Translation of `key`; `{name}` placeholders come from `params`. A number
   passed as `n` is formatted for the current locale. */
function tr(key, params = {}) {
  let s = tRaw(key);
  if (s && typeof s === "object") {
    s = s[PLURALS.select(Number(params.n) || 0)] ?? s.other ?? key;
  }
  return String(s).replace(/\{(\w+)\}/g, (m, k) => {
    if (!(k in params)) return m;
    const v = params[k];
    return typeof v === "number" ? fmtNum(v) : String(v);
  });
}

/* Fills every element under `root` that carries a translation key. */
function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = tr(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-html]")) el.innerHTML = tr(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = tr(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = tr(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", tr(el.dataset.i18nAria));
  for (const el of root.querySelectorAll("[data-i18n-alt]")) el.alt = tr(el.dataset.i18nAlt);
}

/* ------------------------------------------------------------ formatting */

const NUMS = new Map();
function numberFormat(opts) {
  const k = LANG + JSON.stringify(opts || {});
  if (!NUMS.has(k)) NUMS.set(k, new Intl.NumberFormat(locale(), opts));
  return NUMS.get(k);
}

/* 1234.5 → "1,234.5" or "1 234,5". */
const fmtNum = (n, opts) => numberFormat(opts).format(n);
/* Fixed number of decimals: fmtDec(3.14159, 1) → "3.1" or "3,1". */
const fmtDec = (n, digits = 1) =>
  fmtNum(n, { minimumFractionDigits: digits, maximumFractionDigits: digits });

/* "5 minutes ago", "il y a 2 heures"; older than a day: a short date. */
function fmtAgo(secs) {
  const mins = (Date.now() - secs * 1000) / 60000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  if (mins < 1) return rtf.format(0, "second");
  if (mins < 60) return rtf.format(-Math.round(mins), "minute");
  if (mins < 60 * 24) return rtf.format(-Math.round(mins / 60), "hour");
  return new Date(secs * 1000).toLocaleDateString(locale(), { day: "numeric", month: "short" });
}

/* Locale-aware comparison for sorting names. */
const collate = (a, b) => a.localeCompare(b, locale(), { numeric: true, sensitivity: "base" });

/* ------------------------------------------------------------ switching */

function fillLangPickers() {
  for (const sel of document.querySelectorAll("select[data-lang-picker]")) {
    sel.innerHTML = Object.entries(LANG_NAMES)
      .filter(([code]) => I18N.catalogs[code])
      .map(([code, name]) => `<option value="${code}">${name}</option>`)
      .join("");
    sel.value = LANG;
  }
}

async function setLanguage(lang, persist = true) {
  if (!I18N.catalogs[lang]) return;
  if (persist) {
    try {
      await window.__TAURI__.core.invoke("language_set", { lang });
    } catch (e) {
      console.error(e);
    }
  }
  if (lang === LANG) return;
  LANG = lang;
  PLURALS = new Intl.PluralRules(locale());
  NUMS.clear();
  document.documentElement.lang = lang;
  applyI18n();
  fillLangPickers();
  window.dispatchEvent(new Event("langchange"));
}

document.addEventListener("change", (e) => {
  if (e.target.matches("select[data-lang-picker]")) setLanguage(e.target.value);
});

document.documentElement.lang = LANG;
fillLangPickers();
applyI18n();
