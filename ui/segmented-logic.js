"use strict";
/* Segmented controls over hidden <select>s (segmented.js): the segments
   from the options, the language flags, the filters' count. Pure, for
   scripts/test-segmented.js. */

/* The segments of a select's options ({ value, text|label, disabled }):
   the chosen one on; the first when none matches (a select shows its
   first option then). */
function segItems(options, value) {
  const items = [...(options || [])].map((o) => ({ value: String(o.value), label: String(o.label ?? o.text ?? o.value).trim(), disabled: !!o.disabled }));
  const v = value == null ? null : String(value);
  const at = Math.max(0, items.findIndex((it) => it.value === v));
  return items.map((it, i) => ({ ...it, on: items.length > 0 && i === at }));
}

/* Flags drawn inline: emoji flags are letters on Windows. 3:2, rounded by
   the CSS. A language without its flag shows its code. */
const SEG_FLAGS = {
  fr: '<svg viewBox="0 0 3 2" aria-hidden="true"><path fill="#002654" d="M0 0h1v2H0z"/><path fill="#fff" d="M1 0h1v2H1z"/><path fill="#ce1126" d="M2 0h1v2H2z"/></svg>',
  en: '<svg viewBox="0 0 60 40" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path fill="#012169" d="M0 0h60v40H0z"/><path stroke="#fff" stroke-width="8" d="M0 0l60 40M60 0L0 40"/><path stroke="#c8102e" stroke-width="3" d="M0 0l60 40M60 0L0 40"/><path stroke="#fff" stroke-width="12" d="M30 0v40M0 20h60"/><path stroke="#c8102e" stroke-width="7" d="M30 0v40M0 20h60"/></svg>',
};
function segFlag(code) {
  const c = String(code || "").toLowerCase();
  return SEG_FLAGS[c] || `<span class="seg-flag-code" aria-hidden="true">${c.slice(0, 2).toUpperCase().replace(/[^A-Z]/g, "")}</span>`;
}

/* Up to this many languages side by side; more open a list. */
const SEG_FLAG_MAX = 4;
const segFlagMode = (n) => (n > SEG_FLAG_MAX ? "popover" : "pills");

/* Filters that narrow a list: those not on their "all" value. */
const segActive = (filters, all = "all") => Object.values(filters || {}).filter((v) => v != null && v !== all).length;

if (typeof module !== "undefined") module.exports = { segItems, segFlag, SEG_FLAGS, SEG_FLAG_MAX, segFlagMode, segActive };
