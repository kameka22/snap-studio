"use strict";
/* Slice sheet: visual pickers.

   The hidden <select>s stay the source of truth — memory, spool reading and
   slicing read them as before. Each visual control sets its own, signals
   the change, and redraws from it. */

/* Sets a hidden <select> and notifies its listeners. */
function setSelect(el, value) {
  if (typeof el === "string") el = $(el);
  if (!el || el.value === value) return;
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/* ------------------------------------------------------------ search picker */

/* Panel anchored to an element: search, sections, a check mark on the
   current choice. Serves the filaments and the "Other profile…" buttons. */
const PK = { sections: [], value: null, onPick: null, foot: null, anchor: null };

function openPicker(anchor, { sections, value, onPick, foot = null, placeholder = "Rechercher" }) {
  Object.assign(PK, { sections, value, onPick, foot, anchor });
  const el = $("picker");
  $("picker-search").value = "";
  $("picker-search").placeholder = placeholder;
  $("picker-foot").classList.toggle("hidden", !foot);
  if (foot) $("picker-foot").textContent = foot.label;
  el.classList.remove("hidden");
  pkRender();
  // Below the element, or above it when there is no room.
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
  el.style.top = (r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
  requestAnimationFrame(() => $("picker-search").focus());
}

function closePicker() {
  $("picker").classList.add("hidden");
  PK.onPick = null;
}

function pkRender() {
  const q = $("picker-search").value.trim().toLowerCase();
  const html = [];
  for (const s of PK.sections) {
    const items = s.items.filter((it) => !q || `${it.label} ${it.sub || ""}`.toLowerCase().includes(q));
    if (!items.length) continue;
    html.push(`<div class="picker-section">${esc(s.label)}</div>`);
    for (const it of items) {
      html.push(`<button class="picker-item${it.value === PK.value ? " on" : ""}" data-v="${esc(it.value)}">
        ${it.color !== undefined ? `<i class="picker-dot" style="${it.color ? `background:${esc(it.color)}` : ""}"></i>` : ""}
        <span class="picker-text"><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</span>
        ${it.badge ? `<span class="picker-badge">${esc(it.badge)}</span>` : ""}
        ${it.value === PK.value ? '<span class="picker-check">✓</span>' : ""}
      </button>`);
    }
  }
  $("picker-list").innerHTML = html.join("") || `<div class="picker-empty">${esc(tr("picker.none"))}</div>`;
}

$("picker-search").addEventListener("input", pkRender);
$("picker-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("picker-list").querySelector(".picker-item")?.click();
  }
});
$("picker-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-v]");
  if (!b) return;
  const pick = PK.onPick;
  closePicker();
  pick?.(b.dataset.v);
});
$("picker-foot").addEventListener("click", () => PK.foot?.onClick());
// Anchored to a scrolling element: it closes rather than float elsewhere.
document.querySelector("#smodal .sl-cols").addEventListener("scroll", () => {
  if (!$("picker").classList.contains("hidden")) closePicker();
});
document.addEventListener("mousedown", (e) => {
  if ($("picker").classList.contains("hidden")) return;
  if (!e.target.closest("#picker") && !(PK.anchor && PK.anchor.contains(e.target))) closePicker();
});
// Esc closes the panel, not the slice sheet.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape" || $("picker").classList.contains("hidden")) return;
    e.stopImmediatePropagation();
    closePicker();
  },
  true
);

/* Presets in sections: system, then the user's. */
function pkPresets(list, sub) {
  return [
    { label: tr("picker.system"), items: list.filter((p) => !p.user).map((p) => ({ value: p.name, label: p.name, sub: sub?.(p) })) },
    { label: tr("picker.yours"), items: list.filter((p) => p.user).map((p) => ({ value: p.name, label: p.name, sub: sub?.(p), badge: tr("picker.custom") })) },
  ];
}

/* ------------------------------------------------------------ printers */

const PRINTER_ICON = '<svg viewBox="0 0 24 24"><path d="M7 3h10v4H7zm-2 6h14a2 2 0 0 1 2 2v5h-4v-3H7v3H3v-5a2 2 0 0 1 2-2m2 6h10v6H7z"/></svg>';
const NONE_ICON = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 2c1.85 0 3.55.63 4.9 1.69L5.69 16.9A8 8 0 0 1 12 4m0 16c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A8 8 0 0 1 12 20"/></svg>';
const PSTATES = ["printing", "paused", "offline", "error"];
const pstateLabel = (st) => (st === "checking" ? "…" : tr(PSTATES.includes(st) ? "slice.pstate." + st : "slice.pstate.ready"));

/* A printer's state: the one just read, otherwise the background tracking's. */
function slPrinterStatus(id) {
  if (!id) return null;
  if (SL.pstate?.[id]) return SL.pstate[id];
  const live = typeof PJ !== "undefined" ? PJ.live.find((l) => l.printer_id === id) : null;
  return live ? (live.status.online ? live.status.state : "offline") : null;
}

/* Called by the spool reading; `id`: the printer queried. */
function slPrinterState(state, id = $("s-printer").value) {
  SL.pstate = { ...(SL.pstate || {}), [id]: state };
  slRenderPrinters();
}

function slRenderPrinters() {
  const cur = $("s-printer").value;
  // Printers first, "No printer" last.
  $("s-printers").innerHTML = [...$("s-printer").options]
    .sort((a, b) => !a.value - !b.value)
    .map((o) => {
      const st = slPrinterStatus(o.value);
      return `<button class="sl-pchip${o.value === cur ? " on" : ""}" data-printer="${esc(o.value)}">
        <span class="sl-pchip-icon${o.value ? "" : " none"}">${o.value ? PRINTER_ICON : NONE_ICON}</span>
        <span class="sl-pchip-text"><b>${esc(o.value ? o.textContent : tr("slice.none"))}</b>${
          o.value ? `<small class="st ${esc(st || "")}">${esc(st ? pstateLabel(st) : "—")}</small>` : `<small>${esc(tr("slice.presets_only"))}</small>`
        }</span></button>`;
    })
    .join("");
}

$("s-printers").addEventListener("click", (e) => {
  const b = e.target.closest("[data-printer]");
  if (!b || b.disabled) return;
  setSelect("s-printer", b.dataset.printer);
});

/* ------------------------------------------------------------ nozzle */

/* "Snapmaker U1 (0.4 nozzle)": the machine and the nozzle diameter. */
function nozzleOf(name) {
  const m = (name || "").match(/^(.*?)\s*\((\d+(?:\.\d+)?)\s*nozzle\)\s*$/i);
  return m ? { family: m[1], d: +m[2] } : null;
}

function slRenderMachine() {
  const cur = $("s-machine").value;
  const n = nozzleOf(cur);
  const machines = SL.lists?.machines || [];
  const sisters = n
    ? machines
        .filter((m) => !m.user && nozzleOf(m.name)?.family === n.family)
        .sort((a, b) => nozzleOf(a.name).d - nozzleOf(b.name).d)
    : [];
  $("s-nozzles").innerHTML = sisters
    .map((m) => `<button class="sl-chip${m.name === cur ? " on" : ""}" data-machine="${esc(m.name)}">${fmtNum(nozzleOf(m.name).d)}</button>`)
    .join("") || '<span class="sl-note">—</span>';
  $("s-machine-name").textContent = cur;
}

$("s-nozzles").addEventListener("click", (e) => {
  const b = e.target.closest("[data-machine]");
  if (b && !b.disabled) setSelect("s-machine", b.dataset.machine);
});
$("s-machine-other").addEventListener("click", (e) => {
  openPicker(e.currentTarget, {
    sections: pkPresets(SL.lists?.machines || []),
    value: $("s-machine").value,
    placeholder: tr("picker.search_machine"),
    onPick: (v) => setSelect("s-machine", v),
  });
});

/* ------------------------------------------------------------ quality */

/* Orca's profiles are named "height + style": 0.20mm Standard @… */
/* Style names come in English from Orca; the catalog may translate them. */
function styleLabel(style) {
  const key = "style." + style.toLowerCase().replace(/\s+/g, "_");
  const t = tr(key);
  return t === key ? style : t;
}

function parseProcess(name) {
  const m = (name || "").match(/^(\d+(?:\.\d+)?)\s*mm\s+(.+?)\s*@/i);
  return m ? { h: Math.round(+m[1] * 100) / 100, style: m[2].trim() } : null;
}

const STYLE_ORDER = ["Standard", "High Quality", "Quality", "Optimal", "Fine", "Extra Fine", "Detail", "Strength", "Strong", "Speed", "Draft", "Color Mixing"];
const styleRank = (s) => (STYLE_ORDER.includes(s) ? STYLE_ORDER.indexOf(s) : 99);

/* System profiles split into height × style. */
function slProcesses() {
  return (SL.lists?.processes || [])
    .filter((p) => !p.user)
    .map((p) => ({ name: p.name, ...parseProcess(p.name) }))
    .filter((p) => p.h);
}

function slQuality() {
  const procs = slProcesses();
  const cur = $("s-process").value;
  const sys = procs.find((p) => p.name === cur);
  const heights = [...new Set(procs.map((p) => p.h))].sort((a, b) => a - b);
  $("s-layer-chips").innerHTML = heights
    .map((h) => `<button class="sl-chip${sys && sys.h === h ? " on" : ""}" data-h="${h}">${fmtDec(h, 2)}</button>`)
    .join("");
  const styles = sys
    ? procs.filter((p) => p.h === sys.h).sort((a, b) => styleRank(a.style) - styleRank(b.style))
    : [];
  $("s-styles").innerHTML = sys
    ? styles
        .map((p) => `<button class="sl-chip wide${p.style === sys.style ? " on" : ""}" data-style="${esc(p.style)}">${esc(styleLabel(p.style))}</button>`)
        .join("")
    : `<span class="sl-note">${esc(tr("slice.custom_profile"))}</span>`;
  $("s-process-name").textContent = cur;
}

/* Profile of a given height: same style if possible, otherwise Standard. */
function slProcessFor(h, style) {
  const at = slProcesses().filter((p) => p.h === h);
  return (at.find((p) => p.style === style) || at.find((p) => p.style === "Standard") || at.sort((a, b) => styleRank(a.style) - styleRank(b.style))[0])?.name;
}

$("s-layer-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-h]");
  if (!b || b.disabled) return;
  const name = slProcessFor(+b.dataset.h, parseProcess($("s-process").value)?.style);
  if (name) setSelect("s-process", name);
});
$("s-styles").addEventListener("click", (e) => {
  const b = e.target.closest("[data-style]");
  if (!b || b.disabled) return;
  const h = parseProcess($("s-process").value)?.h;
  const name = slProcesses().find((p) => p.h === h && p.style === b.dataset.style)?.name;
  if (name) setSelect("s-process", name);
});
$("s-process-other").addEventListener("click", (e) => {
  openPicker(e.currentTarget, {
    sections: pkPresets(SL.lists?.processes || []),
    value: $("s-process").value,
    placeholder: tr("picker.search_process"),
    onPick: (v) => setSelect("s-process", v),
  });
});

/* ------------------------------------------------------------ filaments */

/* Card label: the chosen profile, "auto" when it comes from the spool read. */
function slHeadLabel(i) {
  const sel = document.querySelector(`#s-heads select[data-head="${i}"]`);
  const btn = document.querySelector(`#s-heads [data-pick-head="${i}"]`);
  if (!sel || !btn) return;
  const slot = SL.slots.find((s) => s.index === i);
  const auto = slot?.present ? bestFilament(slot, SL.lists?.filaments || []) : null;
  // A head known to be empty shows no profile: it prints nothing. (The engine
  // still gets the select's value, as every extruder needs one.)
  const empty = slot && !slot.present;
  btn.disabled = !!empty;
  btn.innerHTML = empty
    ? `<span>${esc(tr("slice.head_unused"))}</span>`
    : `<span>${esc(sel.value || "—")}</span>${sel.value && sel.value === auto ? '<em>auto</em>' : ""}<i>▾</i>`;
}

function slPickFilament(i, anchor, all = false) {
  const sel = document.querySelector(`#s-heads select[data-head="${i}"]`);
  if (!sel || sel.disabled) return;
  const list = SL.lists?.filaments || [];
  const slot = SL.slots.find((s) => s.index === i);
  const kind = slot?.present ? (slot.kind || "").toUpperCase() : "";
  const auto = slot?.present ? bestFilament(slot, list) : null;
  const vendor = (slot?.vendor || "").toLowerCase();
  const item = (p, badge) => ({
    value: p.name,
    label: p.name,
    sub: [p.ftype, p.vendor].filter(Boolean).join(" · "),
    badge: badge || (p.user ? tr("picker.custom") : p.name === auto ? "auto" : ""),
  });
  let sections;
  if (kind && !all) {
    const same = list.filter((p) => (p.ftype || "").toUpperCase() === kind);
    const rec = same.filter((p) => !p.user && (p.name === auto || (vendor && (p.vendor || "").toLowerCase().includes(vendor))));
    const recNames = new Set(rec.map((p) => p.name));
    rec.sort((a, b) => (b.name === auto) - (a.name === auto));
    sections = [
      { label: tr("picker.recommended"), items: rec.map((p) => item(p)) },
      { label: tr("picker.yours"), items: same.filter((p) => p.user).map((p) => item(p)) },
      { label: tr("picker.others", { kind }), items: same.filter((p) => !p.user && !recNames.has(p.name)).map((p) => item(p)) },
    ];
  } else {
    // All materials, grouped.
    const other = tr("feature.other");
    const kinds = [...new Set(list.map((p) => p.ftype || other))].sort();
    sections = kinds.map((k) => ({ label: k, items: list.filter((p) => (p.ftype || other) === k).map((p) => item(p)) }));
  }
  openPicker(anchor, {
    sections,
    value: sel.value,
    placeholder: tr("picker.search_filament"),
    foot: kind && !all ? { label: tr("picker.all_materials"), onClick: () => slPickFilament(i, anchor, true) } : null,
    onPick: (v) => {
      setSelect(sel, v);
      slHeadLabel(i);
    },
  });
}

$("s-heads").addEventListener("click", (e) => {
  if (e.target.closest("[data-info]")) return;
  const card = e.target.closest("[data-card]");
  if (card && !card.classList.contains("is-empty")) slPickFilament(+card.dataset.card, card.querySelector("[data-pick-head]") || card);
});

/* ------------------------------------------------------------ colors → heads */

/* One chip per head, in its spool's color; the chosen head is ringed, an
   empty head greyed, a mismatched material flagged. */
function slTokens() {
  const n = headCount();
  document.querySelectorAll("#s-map select").forEach((sel) => {
    const box = document.querySelector(`#s-map [data-tokens="${sel.dataset.key}"]`);
    if (!box) return;
    const [fi, ext] = sel.dataset.key.split(":").map(Number);
    const fil = SL.models[fi]?.filaments.find((f) => f.index === ext);
    box.innerHTML = Array.from({ length: n }, (_, h) => {
      const slot = SL.slots.find((s) => s.index === h);
      const empty = slot && !slot.present;
      const clash = slot?.present && fil?.kind && slot.kind && fil.kind.toUpperCase() !== slot.kind.toUpperCase();
      const color = slot?.present && slot.color ? slot.color : "";
      const title = `T${h}${slot ? (slot.present ? ` · ${slot.kind || "?"}` : " · " + tr("printers.empty_tag")) : ""}${clash ? " · " + tr("slice.material_clash") : ""}`;
      return `<span class="sl-token ro${+sel.value === h ? " on" : ""}${empty ? " is-empty" : ""}"
        title="${esc(title)}"><i style="${color ? `background:${esc(color)}` : ""}"></i>T${h}${clash ? "<em>⚠</em>" : ""}</span>`;
    }).join("");
  });
}

/* ------------------------------------------------------------ refreshes */

/* The hidden <select>s change (by code or by a control): their
   representations follow. */
window.addEventListener("langchange", () => {
  if ($("smodal").classList.contains("hidden") || !SL.lists) return;
  slRenderPrinters();
  slRenderMachine();
  slQuality();
});

$("smodal").addEventListener("change", (e) => {
  if (e.target.id === "s-printer") slRenderPrinters();
  if (e.target.id === "s-machine") slRenderMachine();
  if (e.target.id === "s-process") slQuality();
});

/* ------------------------------------------------- heads and spools */

/* A filament profile picked here is the printer's, everywhere. */
$("s-heads").addEventListener("change", (e) => {
  const i = e.target.dataset?.head;
  const pid = currentPrinter()?.id;
  if (i != null && pid) headsSetFilament(pid, +i, e.target.value, "slice");
});

/* The color -> head table is read-only here: edited in Prepare. */
$("s-map-edit").addEventListener("click", () => {
  // Every plate object of the files in the sheet gets selected.
  const paths = new Set(SL.models.map((m) => m.path));
  closeSheet($("smodal"));
  switchView("prepare");
  if (typeof PR !== "undefined") {
    const ids = PR.objects.filter((o) => paths.has(o.path)).map((o) => o.id);
    if (ids.length) prSelect(ids, false);
  }
});

window.addEventListener("headschange", (e) => {
  if (e.detail?.src === "slice" || $("smodal").classList.contains("hidden") || !SL.lists) return;
  const pid = currentPrinter()?.id;
  if (e.detail?.pid && e.detail.pid !== pid) return;
  if (e.detail?.what === "filament") renderHeads(null, false);
  if (e.detail?.what === "map" || e.detail?.what === "model") renderModelMap(false);
});
