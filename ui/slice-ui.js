"use strict";
/* Fenêtre de découpe : sélecteurs visuels.

   Les <select> cachés restent la source de vérité — mémorisation, lecture des
   bobines, découpe les lisent comme avant. Chaque contrôle visuel règle le sien
   puis signale le changement, et se redessine d'après lui. */

/* Règle un <select> caché et prévient ses écouteurs. */
function setSelect(el, value) {
  if (typeof el === "string") el = $(el);
  if (!el || el.value === value) return;
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/* ------------------------------------------------------------ sélecteur à recherche */

/* Panneau ancré à un élément : recherche, sections, une coche sur le choix
   courant. Sert aux filaments et aux « Autre profil… ». */
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
  // Sous l'élément, ou au-dessus s'il n'y a pas la place.
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
  $("picker-list").innerHTML = html.join("") || '<div class="picker-empty">Aucun résultat</div>';
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
// Ancré à un élément qui défile : il se referme plutôt que de flotter ailleurs.
document.querySelector("#smodal .sl-cols").addEventListener("scroll", () => {
  if (!$("picker").classList.contains("hidden")) closePicker();
});
document.addEventListener("mousedown", (e) => {
  if ($("picker").classList.contains("hidden")) return;
  if (!e.target.closest("#picker") && !(PK.anchor && PK.anchor.contains(e.target))) closePicker();
});
// Échap ferme le panneau, pas la fenêtre de découpe.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape" || $("picker").classList.contains("hidden")) return;
    e.stopImmediatePropagation();
    closePicker();
  },
  true
);

/* Préréglages en sections : système, puis ceux de l'utilisateur. */
function pkPresets(list, sub) {
  return [
    { label: "Profils système", items: list.filter((p) => !p.user).map((p) => ({ value: p.name, label: p.name, sub: sub?.(p) })) },
    { label: "Vos profils", items: list.filter((p) => p.user).map((p) => ({ value: p.name, label: p.name, sub: sub?.(p), badge: "perso" })) },
  ];
}

/* ------------------------------------------------------------ imprimantes */

const PRINTER_ICON = '<svg viewBox="0 0 24 24"><path d="M7 3h10v4H7zm-2 6h14a2 2 0 0 1 2 2v5h-4v-3H7v3H3v-5a2 2 0 0 1 2-2m2 6h10v6H7z"/></svg>';
const NONE_ICON = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 2c1.85 0 3.55.63 4.9 1.69L5.69 16.9A8 8 0 0 1 12 4m0 16c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A8 8 0 0 1 12 20"/></svg>';
const PSTATE = { checking: "…", printing: "en impression", paused: "en pause", offline: "injoignable", error: "erreur" };

/* État d'une imprimante : celui lu à l'instant, sinon celui du suivi de fond. */
function slPrinterStatus(id) {
  if (!id) return null;
  if (SL.pstate?.[id]) return SL.pstate[id];
  const live = typeof PJ !== "undefined" ? PJ.live.find((l) => l.printer_id === id) : null;
  return live ? (live.status.online ? live.status.state : "offline") : null;
}

/* Appelé par la lecture des bobines ; `id` : l'imprimante interrogée. */
function slPrinterState(state, id = $("s-printer").value) {
  SL.pstate = { ...(SL.pstate || {}), [id]: state };
  slRenderPrinters();
}

function slRenderPrinters() {
  const cur = $("s-printer").value;
  // Les imprimantes d'abord, « Sans imprimante » en dernier.
  $("s-printers").innerHTML = [...$("s-printer").options]
    .sort((a, b) => !a.value - !b.value)
    .map((o) => {
      const st = slPrinterStatus(o.value);
      return `<button class="sl-pchip${o.value === cur ? " on" : ""}" data-printer="${esc(o.value)}">
        <span class="sl-pchip-icon${o.value ? "" : " none"}">${o.value ? PRINTER_ICON : NONE_ICON}</span>
        <span class="sl-pchip-text"><b>${esc(o.value ? o.textContent : "Aucune")}</b>${
          o.value ? `<small class="st ${esc(st || "")}">${esc(st ? PSTATE[st] || "prête" : "—")}</small>` : "<small>préréglages seuls</small>"
        }</span></button>`;
    })
    .join("");
}

$("s-printers").addEventListener("click", (e) => {
  const b = e.target.closest("[data-printer]");
  if (!b || b.disabled) return;
  setSelect("s-printer", b.dataset.printer);
});

/* ------------------------------------------------------------ buse */

/* « Snapmaker U1 (0.4 nozzle) » : la machine et le diamètre de buse. */
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
    .map((m) => `<button class="sl-chip${m.name === cur ? " on" : ""}" data-machine="${esc(m.name)}">${String(nozzleOf(m.name).d).replace(".", ",")}</button>`)
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
    placeholder: "Rechercher une machine",
    onPick: (v) => setSelect("s-machine", v),
  });
});

/* ------------------------------------------------------------ qualité */

/* Les profils d'Orca se nomment « hauteur + style » : 0.20mm Standard @… */
const STYLE_FR = {
  Standard: "Standard",
  "High Quality": "Haute qualité",
  Quality: "Qualité",
  Optimal: "Optimal",
  Fine: "Fin",
  "Extra Fine": "Extra fin",
  Detail: "Détail",
  Strength: "Résistance",
  Strong: "Solide",
  Draft: "Brouillon",
  Speed: "Rapide",
  Balanced: "Équilibré",
  "Color Mixing": "Mélange de couleurs",
};

function parseProcess(name) {
  const m = (name || "").match(/^(\d+(?:\.\d+)?)\s*mm\s+(.+?)\s*@/i);
  return m ? { h: Math.round(+m[1] * 100) / 100, style: m[2].trim() } : null;
}

const STYLE_ORDER = ["Standard", "High Quality", "Quality", "Optimal", "Fine", "Extra Fine", "Detail", "Strength", "Strong", "Speed", "Draft", "Color Mixing"];
const styleRank = (s) => (STYLE_ORDER.includes(s) ? STYLE_ORDER.indexOf(s) : 99);

/* Profils système décomposés en hauteur × style. */
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
    .map((h) => `<button class="sl-chip${sys && sys.h === h ? " on" : ""}" data-h="${h}">${h.toFixed(2).replace(".", ",")}</button>`)
    .join("");
  const styles = sys
    ? procs.filter((p) => p.h === sys.h).sort((a, b) => styleRank(a.style) - styleRank(b.style))
    : [];
  $("s-styles").innerHTML = sys
    ? styles
        .map((p) => `<button class="sl-chip wide${p.style === sys.style ? " on" : ""}" data-style="${esc(p.style)}">${esc(STYLE_FR[p.style] || p.style)}</button>`)
        .join("")
    : `<span class="sl-note">Profil personnalisé — choisi par « Autre profil… »</span>`;
  $("s-process-name").textContent = cur;
}

/* Profil d'une hauteur donnée : même style si possible, sinon Standard. */
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
    placeholder: "Rechercher un profil d'impression",
    onPick: (v) => setSelect("s-process", v),
  });
});

/* ------------------------------------------------------------ filaments */

/* Libellé de la carte : profil choisi, « auto » s'il vient de la bobine lue. */
function slHeadLabel(i) {
  const sel = document.querySelector(`#s-heads select[data-head="${i}"]`);
  const btn = document.querySelector(`#s-heads [data-pick-head="${i}"]`);
  if (!sel || !btn) return;
  const slot = SL.slots.find((s) => s.index === i);
  const auto = slot?.present ? bestFilament(slot, SL.lists?.filaments || []) : null;
  btn.innerHTML = `<span>${esc(sel.value || "—")}</span>${sel.value && sel.value === auto ? '<em>auto</em>' : ""}<i>▾</i>`;
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
    badge: badge || (p.user ? "perso" : p.name === auto ? "auto" : ""),
  });
  let sections;
  if (kind && !all) {
    const same = list.filter((p) => (p.ftype || "").toUpperCase() === kind);
    const rec = same.filter((p) => !p.user && (p.name === auto || (vendor && (p.vendor || "").toLowerCase().includes(vendor))));
    const recNames = new Set(rec.map((p) => p.name));
    rec.sort((a, b) => (b.name === auto) - (a.name === auto));
    sections = [
      { label: "Recommandé pour cette bobine", items: rec.map((p) => item(p)) },
      { label: "Vos profils", items: same.filter((p) => p.user).map((p) => item(p)) },
      { label: `Autres ${kind}`, items: same.filter((p) => !p.user && !recNames.has(p.name)).map((p) => item(p)) },
    ];
  } else {
    // Toutes les matières, regroupées.
    const kinds = [...new Set(list.map((p) => p.ftype || "Autre"))].sort();
    sections = kinds.map((k) => ({ label: k, items: list.filter((p) => (p.ftype || "Autre") === k).map((p) => item(p)) }));
  }
  openPicker(anchor, {
    sections,
    value: sel.value,
    placeholder: "Rechercher un filament",
    foot: kind && !all ? { label: "Afficher toutes les matières", onClick: () => slPickFilament(i, anchor, true) } : null,
    onPick: (v) => {
      setSelect(sel, v);
      slHeadLabel(i);
    },
  });
}

$("s-heads").addEventListener("click", (e) => {
  if (e.target.closest("[data-info]")) return;
  const card = e.target.closest("[data-card]");
  if (card) slPickFilament(+card.dataset.card, card.querySelector("[data-pick-head]") || card);
});

/* ------------------------------------------------------------ couleurs → têtes */

/* Un jeton par tête, à la couleur de sa bobine ; la tête choisie est cerclée,
   une tête vide grisée, une matière qui ne correspond pas signalée. */
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
      const title = `T${h}${slot ? (slot.present ? ` · ${slot.kind || "?"}` : " · vide") : ""}${clash ? " · matière différente" : ""}`;
      return `<button class="sl-token${+sel.value === h ? " on" : ""}${empty ? " is-empty" : ""}" data-token="${sel.dataset.key}" data-h="${h}"
        title="${esc(title)}"${empty ? " disabled" : ""}><i style="${color ? `background:${esc(color)}` : ""}"></i>T${h}${clash ? "<em>⚠</em>" : ""}</button>`;
    }).join("");
  });
}

function slAssign(key, h) {
  const sel = document.querySelector(`#s-map select[data-key="${key}"]`);
  if (!sel || sel.disabled) return;
  setSelect(sel, String(h));
}

$("s-map").addEventListener("click", (e) => {
  const b = e.target.closest("[data-token]");
  if (b && !b.disabled) slAssign(b.dataset.token, +b.dataset.h);
});

/* Glisser une couleur du modèle sur une carte bobine. Type propre : un texte
   glissé d'ailleurs n'est pas accepté. */
const SL_DRAG = "application/x-snapstudio-color";
$("s-map").addEventListener("dragstart", (e) => {
  const row = e.target.closest("[data-drag]");
  if (!row) return;
  e.dataTransfer.setData(SL_DRAG, row.dataset.drag);
  e.dataTransfer.effectAllowed = "link";
  document.body.classList.add("sl-dragging");
});
$("s-map").addEventListener("dragend", () => {
  document.body.classList.remove("sl-dragging");
  document.querySelectorAll("#s-heads .drop").forEach((c) => c.classList.remove("drop"));
});
$("s-heads").addEventListener("dragover", (e) => {
  const card = e.target.closest("[data-card]");
  if (!card || card.classList.contains("is-empty") || !e.dataTransfer.types.includes(SL_DRAG)) return;
  e.preventDefault();
  document.querySelectorAll("#s-heads .drop").forEach((c) => c.classList.toggle("drop", c === card));
});
$("s-heads").addEventListener("dragleave", (e) => {
  const card = e.target.closest("[data-card]");
  if (card && !card.contains(e.relatedTarget)) card.classList.remove("drop");
});
$("s-heads").addEventListener("drop", (e) => {
  const card = e.target.closest("[data-card]");
  if (!card) return;
  e.preventDefault();
  card.classList.remove("drop");
  const key = e.dataTransfer.getData(SL_DRAG);
  if (/^\d+:\d+$/.test(key)) slAssign(key, +card.dataset.card);
});

/* ------------------------------------------------------------ rafraîchissements */

/* Les <select> cachés changent (par le code ou par un contrôle) : leurs
   représentations suivent. */
$("smodal").addEventListener("change", (e) => {
  if (e.target.id === "s-printer") slRenderPrinters();
  if (e.target.id === "s-machine") slRenderMachine();
  if (e.target.id === "s-process") slQuality();
});
