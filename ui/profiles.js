"use strict";
/* Détail des profils de découpe.

   Les valeurs viennent du Rust (`slice_details`) : héritage résolu, plus ce que
   Snap Studio ajoute pour la découpe (réglages rapides, plateau, couleur de la
   bobine) — exactement ce que reçoit le moteur. La présentation reprend les
   onglets de Snapmaker Orca, en français : `assets/orca-settings.json`, généré
   depuis ses sources par `scripts/gen-orca-settings.py`. */

const INFO_ICON = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16m-1 3h2v2h-2zm0 4h2v6h-2z"/></svg>';

const PD = {
  schema: null,
  details: null,
  page: 0,
  bed: null,
  /* Profils filament déjà lus, pour la ligne « Plateau à … ». */
  temps: new Map(),
};

/* Température du plateau selon son type (`curr_bed_type`). */
const BED_TEMP_KEY = {
  "Cool Plate": "cool_plate_temp",
  "Engineering Plate": "eng_plate_temp",
  "High Temp Plate": "hot_plate_temp",
  "Textured PEI Plate": "textured_plate_temp",
  "Textured Cool Plate": "textured_cool_plate_temp",
  "Supertack Plate": "supertack_plate_temp",
  "Graphic Effect Plate": "graphic_effect_plate_temp",
};

async function pdSchema() {
  if (!PD.schema) PD.schema = await fetch("assets/orca-settings.json").then((r) => r.json());
  return PD.schema;
}

/* Ce que Snap Studio applique en ce moment dans la fenêtre de découpe. */
function pdContext(head) {
  const slot = head == null ? null : SL.slots.find((s) => s.index === head);
  return {
    machine: $("s-machine").value,
    simple: currentSimple(),
    overrides: $("s-bed").value ? { curr_bed_type: $("s-bed").value } : {},
    color: slot?.present && slot.color ? slot.color : null,
  };
}

function pdFetch(name, head) {
  return invoke("slice_details", { name, ...pdContext(head) });
}

/* ------------------------------------------------------------ valeurs */

/* Orca range les textes (G-code…) échappés à la C : « \n » pour une ligne. */
const unescapeC = (s) =>
  typeof s === "string" && s.includes("\\")
    ? s.replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", r: "" })[c] ?? c)
    : s;

/* Unité affichable : « mm ou % » → « mm », « argent/kg » → « /kg ». */
const unitOf = (u) => (u ? u.split(/ ou | or /)[0].replace(/^(argent|money)\//i, "/") : "");

const one = (v) => (Array.isArray(v) ? (v.length && v.every((x) => x === v[0]) ? v[0] : null) : v);

function pdFormat(key, v) {
  const meta = PD.schema.keys[key] || {};
  const fmt = (x) => {
    if (x == null || x === "") return "—";
    if (meta.type === "bool") return x === "1" || x === true || x === "true" ? "Oui" : "Non";
    if (meta.type === "enum") return meta.enum?.[x] || x;
    let s = String(x);
    const unit = unitOf(meta.unit);
    if (unit && !s.endsWith("%") && !/[a-z]$/i.test(s)) s += unit.startsWith("/") ? ` ${unit}` : " " + unit;
    return s;
  };
  if (Array.isArray(v)) {
    const same = one(v);
    if (same !== null || v.length <= 1) return fmt(same ?? v[0]);
    // Une valeur par tête (machine) ou une liste (points, vitesses…).
    return meta.type === "point" ? v.join(" · ") : v.map((x, i) => `T${i} ${fmt(x)}`).join(" · ");
  }
  return fmt(v);
}

/* Texte long ou sur plusieurs lignes : affiché en bloc sous le libellé. */
const isBlock = (v) => typeof v === "string" && (v.includes("\n") || v.length > 80);

/* ------------------------------------------------------------ résumé */

function pdTile(label, value, sub = "", strong = false) {
  return `<div class="pd-tile${strong ? " strong" : ""}"><small>${esc(label)}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
}

function pdSummary(d) {
  const v = d.values, f = (k) => pdFormat(k, v[k]);
  if (d.kind === "filament") {
    const bed = PD.bed || "Textured PEI Plate";
    const key = BED_TEMP_KEY[bed];
    const bedLabel = PD.schema.keys.curr_bed_type?.enum?.[bed] || bed;
    const others = Object.entries(BED_TEMP_KEY)
      .filter(([b, k]) => b !== bed && v[k] != null)
      .map(([b, k]) => `${esc(PD.schema.keys.curr_bed_type?.enum?.[b] || b)} ${esc(one(v[k]))} °C`)
      .join(" · ");
    const color = one(v.filament_colour);
    return [
      pdTile("Matière", `${color ? `<i class="pd-swatch" style="background:${esc(color)}"></i>` : ""}${esc(f("filament_type"))}`, esc(one(v.filament_vendor) || "")),
      pdTile("Buse", `${esc(one(v.nozzle_temperature))} °C`, `1re couche ${esc(one(v.nozzle_temperature_initial_layer))} °C`),
      pdTile("Plateau", `${esc(one(v[key]) ?? "—")} °C`, `${esc(bedLabel)} · 1re couche ${esc(one(v[key + "_initial_layer"]) ?? "—")} °C`, true),
      pdTile("Ventilateur", `${esc(one(v.fan_min_speed))}–${esc(one(v.fan_max_speed))} %`),
      pdTile("Débit max", `${esc(one(v.filament_max_volumetric_speed))} mm³/s`),
    ].join("") + (others ? `<div class="pd-others">Autres plateaux : ${others}</div>` : "");
  }
  if (d.kind === "process") {
    return [
      pdTile("Couche", f("layer_height"), `1re couche ${esc(f("initial_layer_print_height"))}`),
      pdTile("Parois", esc(f("wall_loops")), `dessus ${esc(f("top_shell_layers"))} · dessous ${esc(f("bottom_shell_layers"))}`),
      pdTile("Remplissage", esc(f("sparse_infill_density")), esc(f("sparse_infill_pattern"))),
      pdTile("Supports", esc(f("enable_support")), v.enable_support === "1" ? esc(f("support_type")) : ""),
      pdTile("Plateau", esc(f("curr_bed_type")), "", true),
      pdTile("Paroi extérieure", esc(f("outer_wall_speed"))),
    ].join("");
  }
  const area = (v.printable_area || []).map((p) => p.split("x").map(Number));
  const size = area.length
    ? `${Math.round(Math.max(...area.map((p) => p[0])) - Math.min(...area.map((p) => p[0])))} × ${Math.round(Math.max(...area.map((p) => p[1])) - Math.min(...area.map((p) => p[1])))} mm`
    : "—";
  return [
    pdTile("Plateau", size, `hauteur ${esc(f("printable_height"))}`),
    pdTile("Buse", esc(f("nozzle_diameter")), `${(v.nozzle_diameter || []).length || 1} tête(s)`),
    pdTile("Modèle", esc(v.printer_model || "—")),
    pdTile("Firmware", esc(f("gcode_flavor"))),
  ].join("");
}

/* ------------------------------------------------------------ onglets */

function pdPages(d) {
  const pages = PD.schema[d.kind] || [];
  if (!$("pd-all").checked) return pages;
  const used = new Set(pages.flatMap((p) => p.groups.flatMap((g) => g.keys)));
  const rest = Object.keys(d.values).filter((k) => !used.has(k)).sort();
  return rest.length ? [...pages, { title: "Autres réglages", groups: [{ title: "Hors des onglets d'Orca", keys: rest }] }] : pages;
}

function pdRow(d, key, line) {
  const meta = PD.schema.keys[key] || {};
  const v = meta.type === "string" ? unescapeC(d.values[key]) : d.values[key];
  const label = line ? `${line} — ${meta.short || meta.label || key}` : meta.label || key;
  const badges =
    (d.snap.includes(key) ? '<span class="pd-badge snap">Snap Studio</span>' : "") +
    (d.custom.includes(key) ? '<span class="pd-badge perso">perso</span>' : "");
  const value = isBlock(v)
    ? `<pre class="pd-code${v.includes("\n") ? "" : " wrap"}">${esc(v)}</pre>`
    : `<span class="pd-val">${esc(pdFormat(key, v))}</span>`;
  return `<div class="grow-row pd-row${d.snap.includes(key) ? " snap" : ""}${isBlock(v) ? " block" : ""}" title="${esc(meta.tooltip || key)}">
    <span class="k">${esc(label)}${badges}</span>${value}</div>`;
}

function pdRender() {
  const d = PD.details;
  if (!d) return;
  const q = $("pd-search").value.trim().toLowerCase();
  const pages = pdPages(d);
  PD.page = Math.min(PD.page, pages.length - 1);
  $("pd-tabs").classList.toggle("hidden", !!q);
  $("pd-tabs").innerHTML = pages
    .map((p, i) => `<button class="seg-btn${i === PD.page ? " on" : ""}" data-page="${i}">${esc(p.title)}</button>`)
    .join("");
  // Recherche : dans tous les onglets ; sinon l'onglet courant.
  const shown = q ? pages : [pages[PD.page]];
  const html = [];
  for (const p of shown) {
    for (const g of p.groups) {
      const rows = g.keys
        .filter((k) => k in d.values)
        .filter((k) => {
          if (!q) return true;
          const meta = PD.schema.keys[k] || {};
          return [k, meta.label, g.lines?.[k], pdFormat(k, d.values[k])].some((s) => s && String(s).toLowerCase().includes(q));
        })
        .map((k) => pdRow(d, k, g.lines?.[k]));
      if (rows.length) {
        html.push(`<div class="vp-section">${esc(q ? `${p.title} › ${g.title}` : g.title)}</div><div class="group">${rows.join("")}</div>`);
      }
    }
  }
  $("pd-body").innerHTML = html.join("") || `<div class="pd-empty">${q ? "Aucun réglage ne correspond." : "Rien à afficher."}</div>`;
}

async function pdOpen(name, head) {
  if (!name) return;
  PD.bed = $("s-bed").value;
  $("pd-name").textContent = name;
  $("pd-sub").textContent = "Lecture du profil…";
  $("pd-summary").innerHTML = "";
  $("pd-body").innerHTML = "";
  $("pd-search").value = "";
  PD.page = 0;
  openSheet($("pdmodal"));
  try {
    await pdSchema();
    const d = await pdFetch(name, head);
    PD.details = d;
    const kind = { machine: "Machine", process: "Impression", filament: "Filament" }[d.kind];
    const origin = d.user ? "Profil personnel" : "Profil système";
    const chain = d.chain.slice(1);
    $("pd-sub").textContent = `${kind}${head != null ? ` · tête T${head}` : ""} · ${origin}${chain.length ? ` · hérite de ${chain.join(" → ")}` : ""}`;
    $("pd-summary").innerHTML = pdSummary(d);
    pdRender();
  } catch (e) {
    $("pd-sub").textContent = `Profil illisible : ${e}`;
  }
}

/* ------------------------------------------------------------ plateau */

/* Sous « Plateau » : la température qui partira à l'imprimante, par tête. */
async function pdBedLine() {
  const box = $("s-bedtemp");
  const bed = $("s-bed").value;
  const key = BED_TEMP_KEY[bed];
  const heads = [...document.querySelectorAll("#s-heads select")].map((s) => s.value);
  if (!key || !heads.length) {
    box.textContent = "";
    return;
  }
  const want = `${bed}|${heads.join("|")}`;
  box.dataset.want = want;
  const temps = [];
  for (const name of heads) {
    if (!PD.temps.has(name)) {
      try {
        const d = await invoke("slice_details", { name, machine: $("s-machine").value });
        PD.temps.set(name, d.values);
      } catch {
        PD.temps.set(name, {});
      }
    }
    const v = PD.temps.get(name);
    temps.push({ first: one(v[key + "_initial_layer"]), rest: one(v[key]) });
  }
  if (box.dataset.want !== want) return;
  const groups = new Map();
  temps.forEach((t, i) => {
    const k = t.first === t.rest ? `${t.rest} °C` : `${t.rest} °C (1re couche ${t.first} °C)`;
    groups.set(k, [...(groups.get(k) || []), `T${i}`]);
  });
  box.innerHTML =
    groups.size === 1
      ? `Plateau à <b>${esc([...groups.keys()][0])}</b> avec ces filaments`
      : `Plateau : ${[...groups].map(([t, h]) => `<b>${esc(t)}</b> (${h.join(", ")})`).join(" · ")}`;
}

/* ------------------------------------------------------------ événements */

$("smodal").addEventListener("click", (e) => {
  const b = e.target.closest("[data-info]");
  if (!b) return;
  e.preventDefault();
  if (b.dataset.info === "machine") pdOpen($("s-machine").value, null);
  else if (b.dataset.info === "process") pdOpen($("s-process").value, null);
  else {
    const i = +b.dataset.head;
    pdOpen(document.querySelector(`#s-heads select[data-head="${i}"]`)?.value, i);
  }
});
$("smodal").addEventListener("change", (e) => {
  if (e.target.matches("#s-bed, #s-heads select, #s-machine")) pdBedLine();
});
$("pd-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (!b) return;
  PD.page = +b.dataset.page;
  pdRender();
  $("pd-body").scrollTop = 0;
});
$("pd-search").addEventListener("input", pdRender);
$("pd-all").addEventListener("change", pdRender);
$("pd-close").addEventListener("click", () => closeSheet($("pdmodal")));
// Au niveau du document : après un clic sur un onglet, le focus n'est plus
// dans la feuille. Elle se ferme seule ; la fenêtre de découpe reste.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("pdmodal").classList.contains("hidden")) return;
  e.stopImmediatePropagation();
  closeSheet($("pdmodal"));
}, true);
