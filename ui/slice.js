"use strict";
/* Découpe : imprimante et bobines, préréglages, réglages rapides, puis aperçu
   du résultat dans le visualiseur, d'où l'on enregistre le G-code ou l'envoie
   à l'imprimante. Le moteur de Snapmaker Orca tourne en tâche de fond ; son
   avancement arrive par l'évènement `slice-progress`. */

const SL = {
  lists: null,
  source: null,
  job: null,
  /* Imprimantes enregistrées et bobines lues sur celle qui est choisie. */
  printers: [],
  slots: [],
  /* Filaments déclarés par le modèle : { filaments: [{index, kind, color}], used: [1, 2…] }. */
  models: [],
  /* Dernier aperçu produit, en attente d'une décision. */
  preview: null,
  /* Choix conservés : par préréglage machine, et dernière imprimante. */
  memory: JSON.parse(localStorage.getItem("snapstudio.slice") || "{}"),
};

function rememberFor(machine) {
  return SL.memory[machine] || {};
}

function remember(machine, data) {
  SL.memory[machine] = { ...rememberFor(machine), ...data };
  SL.memory.last = machine;
  localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
}

function rememberPrinter(id) {
  SL.memory.printer = id;
  localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
}

const fillSelect = (el, items, value) => {
  el.innerHTML = items
    .map((p) => `<option value="${esc(p.name)}"${p.user ? ' data-user="1"' : ""}>${esc(p.name)}${p.user ? " — perso" : ""}</option>`)
    .join("");
  if (value && items.some((p) => p.name === value)) el.value = value;
};

/* ------------------------------------------------------------ couleurs */

const hexToRgb = (h) => {
  const m = /^#?([0-9a-f]{6})/i.exec(h || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const colorDistance = (a, b) => {
  const x = hexToRgb(a), y = hexToRgb(b);
  if (!x || !y) return 1e9;
  return (x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2;
};
const swatch = (color) =>
  `<span class="swatch${color ? "" : " none"}" style="${color ? `background:${esc(color)}` : ""}"></span>`;

/* ------------------------------------------------------------ ouverture */

/* La découpe porte sur le plateau de la vue Préparer. */
async function openSlice() {
  const scene = prepareScene();
  if (!scene) return;
  SL.source = scene;
  SL.job = null;
  SL.touched = new Set();
  $("s-file").textContent =
    `${scene.items.length} objet${scene.items.length > 1 ? "s" : ""} sur le plateau` +
    (scene.skipped ? ` · ${scene.skipped} à côté, non découpé${scene.skipped > 1 ? "s" : ""}` : "");
  setSliceMessage("");
  setSliceProgress(null);
  showSliceBusy(false);
  // Vignette du premier objet du plateau, si elle se laisse lire.
  const first = scene.items[0]?.path;
  const th = $("s-thumb");
  th.classList.add("hidden");
  if (first) {
    th.onload = () => th.classList.remove("hidden");
    th.onerror = () => th.classList.add("hidden");
    th.src = `thumb://localhost/t?p=${encodeURIComponent(first)}&s=160&k=0`;
  }
  openSheet($("smodal"));

  // Moteur attendu mais absent : la fenêtre propose d'abord de le télécharger.
  await engStatus();
  if (engNeeded()) {
    slEngineGate(true);
    return;
  }
  slEngineGate(false);
  await sliceLoad();
}

/* Le moteur manque : sa carte remplace le contenu, la découpe attend. */
function slEngineGate(on) {
  $("s-engine").classList.toggle("hidden", !on);
  document.querySelector("#smodal .sl-box").classList.toggle("needs-engine", on);
  $("s-go").disabled = on;
  if (on) {
    engMount($("s-engine"), {
      onDone: () => {
        engUnmount($("s-engine"));
        slEngineGate(false);
        sliceLoad();
      },
    });
  }
}

/* Imprimantes, couleurs du modèle, profils : le contenu de la fenêtre. */
async function sliceLoad() {
  try {
    const [printers, ...models] = await Promise.all([
      invoke("printers_list").catch(() => []),
      ...SL.source.files.map((path) => invoke("slice_model", { path }).catch(() => null)),
    ]);
    SL.printers = printers;
    // Couleurs du modèle, fichier par fichier.
    SL.models = SL.source.files.map((path, i) => {
      const m = models[i];
      return {
        path,
        stem: path.split("/").pop().replace(/\.(3mf|stl)$/i, ""),
        filaments: m?.filaments || [],
        used: m?.used?.length ? m.used : [1],
      };
    });
    const opts = [{ id: "", name: "Sans imprimante" }, ...printers];
    $("s-printer").innerHTML = opts
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.host)}</option>`)
      .join("");
    const keep = printers.some((p) => p.id === SL.memory.printer) ? SL.memory.printer : printers[0]?.id || "";
    $("s-printer").value = keep;
    SL.pstate = {};
    slRenderPrinters();
    await onPrinterChange();
  } catch (e) {
    setSliceMessage(String(e), "err");
  }
}

const currentPrinter = () => SL.printers.find((p) => p.id === $("s-printer").value) || null;

/* Une imprimante choisie impose sa machine et fait lire ses bobines. */
async function onPrinterChange() {
  const printer = currentPrinter();
  SL.slots = [];
  $("s-heads-note").textContent = printer ? "lecture des bobines…" : "";
  slPrinterState(printer ? "checking" : null);
  SL.lists = await invoke("slice_lists", { machine: SL.memory.last || null });

  const machines = SL.lists.machines;
  let machine = SL.memory.last || SL.lists.selected.machine || machines[0]?.name;
  if (printer) {
    const saved = SL.memory["printer:" + printer.id];
    machine = (saved && machines.some((m) => m.name === saved) && saved) || matchMachine(printer, machines, machine) || machine;
  }
  fillSelect($("s-machine"), machines, machine);
  slRenderMachine();
  await onMachineChange(null);

  if (printer) {
    try {
      const st = await invoke("printer_status", { host: printer.host, port: printer.port });
      // Son état vaut même si l'utilisateur est passé à une autre entre-temps.
      slPrinterState(st.online ? st.state : "offline", printer.id);
      if (currentPrinter() !== printer) return;
      SL.slots = st.filaments || [];
      $("s-heads-note").textContent = !st.online
        ? "imprimante injoignable"
        : SL.slots.length ? "bobines lues sur l'imprimante" : "bobines non exposées";
    } catch {
      slPrinterState("offline", printer.id);
      if (currentPrinter() !== printer) return;
      $("s-heads-note").textContent = "imprimante injoignable";
    }
    renderHeads(null, true);
    renderModelMap(true);
  }
}

/* Préréglage machine dont le nom contient le modèle de l'imprimante. */
/* À égalité (les profils U1 ne diffèrent que par la buse), `preferred` — le
   profil déjà choisi dans Orca ou ici — l'emporte, puis la buse de 0,4. */
function matchMachine(printer, machines, preferred) {
  const words = (printer.model || printer.name || "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return null;
  const scored = machines
    .map((m) => ({ m, n: words.filter((w) => m.name.toLowerCase().includes(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.m.name.length - b.m.name.length);
  if (!scored.length) return null;
  const top = scored.filter((x) => x.n === scored[0].n).map((x) => x.m.name);
  return top.find((n) => n === preferred) || top.find((n) => /\(0\.4 nozzle\)/i.test(n)) || top[0];
}

/* Plateaux de la machine : le choix fixe la température du plateau, lue dans
   le profil filament pour ce type de plateau. */
function fillBeds(saved) {
  const sel = $("s-bed");
  const types = SL.lists?.bed_types || [];
  sel.innerHTML = types.map((t) => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join("");
  sel.value = types.some((t) => t.value === saved) ? saved : SL.lists?.bed_type || types[0]?.value || "";
  // Tuiles : une par plateau, avec la température qu'il donnera.
  const tex = { "Textured PEI Plate": "textured", "High Temp Plate": "smooth", "Graphic Effect Plate": "graphic" };
  $("s-beds").innerHTML = types
    .map(
      (t) => `<button class="sl-bed${t.value === sel.value ? " on" : ""}" data-bed="${esc(t.value)}">
        <span class="sl-bed-tex ${tex[t.value] || "plain"}"></span>
        <b>${esc(t.label)}</b><small data-bedtemp="${esc(t.value)}">—</small></button>`
    )
    .join("");
}

$("s-beds").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bed]");
  if (!b || b.disabled) return;
  $("s-bed").value = b.dataset.bed;
  document.querySelectorAll("#s-beds .sl-bed").forEach((x) => x.classList.toggle("on", x === b));
  $("s-bed").dispatchEvent(new Event("change", { bubbles: true }));
  slSummary();
});

async function onMachineChange(mem) {
  const machine = $("s-machine").value;
  try {
    SL.lists = await invoke("slice_lists", { machine });
    const m = mem || rememberFor(machine);
    // Le premier choix connu et proposé pour cette machine ; à défaut, le
    // profil standard de 0,20 mm.
    const known = (n) => n && SL.lists.processes.some((p) => p.name === n);
    fillSelect($("s-process"), SL.lists.processes, [m.process, SL.lists.selected.print].find(known) || slProcessFor(0.2, "Standard"));
    slRenderMachine();
    slQuality();
    fillBeds(m.bed);
    renderHeads(m.filaments || (m.filament ? [m.filament] : null), false);
    renderModelMap(false);
    await loadDefaults(m.simple);
  } catch (e) {
    setSliceMessage(String(e), "err");
  }
}

/* ------------------------------------------------------------ têtes */

const headCount = () => Math.max(1, SL.lists?.extruders || 1);

/* Préréglage le plus proche d'une bobine : matière obligatoire, puis
   fabricant, puis sous-type ; un préréglage générique sert de repli. */
function bestFilament(slot, list) {
  const kind = (slot.kind || "").trim().toUpperCase();
  if (!kind) return null;
  const vendor = (slot.vendor || "").trim().toLowerCase();
  const sub = (slot.sub_type || "").trim().toLowerCase();
  let best = null, bestScore = -1;
  for (const p of list) {
    const t = (p.ftype || "").toUpperCase();
    if (t !== kind) continue;
    const name = p.name.toLowerCase();
    let score = 10;
    if (vendor && ((p.vendor || "").toLowerCase().includes(vendor) || name.includes(vendor))) score += 5;
    if (sub && name.includes(sub)) score += 3;
    if (!vendor && /generic|générique/.test(name)) score += 2;
    if (!sub && /basic/.test(name)) score += 1;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best?.name || null;
}

/* Une ligne par tête : bobine réelle (si connue) et préréglage filament. */
function renderHeads(saved, fromPrinter) {
  const list = SL.lists?.filaments || [];
  const fallback = SL.lists?.selected?.filament || list[0]?.name;
  const prev = [...document.querySelectorAll("#s-heads select")].map((s) => s.value);
  const rows = [];
  for (let i = 0; i < headCount(); i++) {
    const slot = SL.slots.find((s) => s.index === i);
    const auto = slot && slot.present ? bestFilament(slot, list) : null;
    const chosen = (fromPrinter && auto) || saved?.[i] || prev[i] || auto || fallback;
    // Carte bobine : couleur réelle en aplat, matière, préréglage choisi.
    const present = slot?.present;
    const kind = present ? [slot.kind, slot.sub_type].filter(Boolean).join(" ") || "?" : slot ? "Vide" : "";
    const sub = present
      ? slot.vendor || (auto ? "" : `aucun préréglage ${slot.kind || ""}`)
      : slot ? "aucune bobine" : "bobine inconnue";
    const color = present && slot.color ? slot.color : null;
    rows.push(`<div class="sl-headcard${slot && !present ? " is-empty" : ""}" data-card="${i}">
      <div class="sl-spool${color ? "" : " none"}"${color ? ` style="--c:${esc(color)}"` : ""}></div>
      <div class="sl-hc-top"><b>T${i}</b><span>${esc(kind)}</span></div>
      <small class="sl-hc-sub${present && !auto ? " warn" : ""}">${esc(sub)}</small>
      <select class="hidden" data-head="${i}" tabindex="-1">${list
        .map((p) => `<option value="${esc(p.name)}"${p.name === chosen ? " selected" : ""}>${esc(p.name)}</option>`)
        .join("")}</select>
      <span class="sel-row"><button class="sl-hc-preset" data-pick-head="${i}" title="Changer de profil filament"></button><button class="btn info-btn" data-info="head" data-head="${i}" title="Détails du profil">${INFO_ICON}</button></span>
      <small class="sl-hc-temp" data-temp="${i}"></small>
    </div>`);
  }
  $("s-heads").innerHTML = rows.join("");
  for (let i = 0; i < headCount(); i++) slHeadLabel(i);
  slUsedHeads();
  pdBedLine();
}

/* Têtes choisies pour chaque extrudeur de chaque fichier du plateau. */
function renderModelMap(fromPrinter) {
  const n = headCount();
  const prev = Object.fromEntries(
    [...document.querySelectorAll("#s-map select")].map((s) => [s.dataset.key, +s.value])
  );
  const taken = new Set();
  const several = SL.models.length > 1;
  const rows = [];
  SL.models.forEach((m, fi) => {
    for (const e of m.used) {
      const key = `${fi}:${e}`;
      const fil = m.filaments.find((f) => f.index === e);
      let head = fromPrinter ? null : prev[key];
      if (head == null || head >= n) head = autoHead(fil, e, taken);
      taken.add(head);
      const color = m.used.length === 1 ? "" : `Couleur ${e}`;
      const label = several ? [m.stem, color].filter(Boolean).join(" · ") : color || "Modèle";
      rows.push(`<div class="sl-maprow" draggable="true" data-drag="${key}" title="Glisser sur une bobine pour l'attribuer">
        ${swatch(fil?.color)}
        <span class="sl-map-label"><b>${esc(label)}</b>${fil?.kind ? `<small>${esc(fil.kind)}</small>` : ""}</span>
        <span class="sl-arrow">→</span>
        <span class="sl-tokens" data-tokens="${key}"></span>
        <select class="hidden" tabindex="-1" data-key="${key}" data-file="${fi}" data-ext="${e}">${Array.from({ length: n }, (_, h) => {
          const slot = SL.slots.find((s) => s.index === h);
          const desc = slot ? (slot.present ? ` · ${slot.kind || "?"}` : " · vide") : "";
          return `<option value="${h}"${h === head ? " selected" : ""}>T${h}${esc(desc)}</option>`;
        }).join("")}</select>
      </div>`);
    }
  });
  $("s-map").innerHTML = rows.join("");
  slUsedHeads();
  // Les températures de plateau dépendent des têtes employées.
  pdBedLine();
}

/* Têtes employées par le modèle : leur carte ressort, les autres s'effacent ;
   la pastille de chaque couleur prend celle de la bobine visée. */
function slUsedHeads() {
  const used = slUsedSet();
  document.querySelectorAll("#s-heads .sl-headcard").forEach((c) => c.classList.toggle("unused", used.size > 0 && !used.has(+c.dataset.card)));
  slTokens();
  slSummary();
  return used;
}

/* Tête la plus vraisemblable pour une couleur du modèle : même matière et
   couleur la plus proche parmi les bobines présentes, sans réutiliser une tête
   déjà prise si possible. */
function autoHead(fil, ext, taken) {
  const n = headCount();
  const present = SL.slots.filter((s) => s.present && s.index < n);
  if (present.length) {
    const kind = (fil?.kind || "").toUpperCase();
    const ranked = present
      .map((s) => ({
        h: s.index,
        score: (kind && (s.kind || "").toUpperCase() === kind ? 0 : 1e7) + (fil?.color ? colorDistance(fil.color, s.color) : 0) + (taken.has(s.index) ? 1e8 : 0),
      }))
      .sort((a, b) => a.score - b.score);
    return ranked[0].h;
  }
  return (ext - 1) % n;
}

/* ------------------------------------------------------------ réglages rapides */

/* Valeurs de départ : celles du préréglage, sauf si l'utilisateur en a déjà
   choisi d'autres pour cette imprimante. */
async function loadDefaults(saved) {
  const machine = $("s-machine").value;
  const process = $("s-process").value;
  if (!machine || !process) return;
  let d = {};
  try {
    d = await invoke("slice_defaults", { machine, process });
  } catch {}
  const v = { ...d, ...(saved || {}) };
  // La hauteur de couche est celle du profil (pastilles « Qualité ») : elle
  // n'est jamais surchargée, donc lue dans son nom ou ses valeurs.
  const h = parseProcess(process)?.h ?? d.layer_height;
  $("s-layer-val").textContent = h ? `${(+h).toFixed(2).replace(".", ",")} mm` : "—";
  setRange("s-infill", v.infill ?? 15, (x) => Math.round(x) + " %");
  setRange("s-walls", v.walls ?? 2, (x) => String(Math.round(x)));
  $("s-supports").checked = !!v.supports;
  $("s-brim").checked = !!v.brim;
  slQuality();
  slSummary();
}

document.querySelector("#smodal .sl-stepper").addEventListener("click", (e) => {
  const b = e.target.closest("[data-step]");
  if (!b) return;
  const el = $("s-walls");
  el.value = Math.max(+el.min, Math.min(+el.max, +el.value + +b.dataset.step));
  el.dispatchEvent(new Event("input"));
  slTouch("s-walls");
  slSummary();
});

/* Têtes employées par le modèle (couleurs → têtes) ; vide si inconnu. */
function slUsedSet() {
  return new Set([...document.querySelectorAll("#s-map select")].map((s) => +s.value));
}

/* Barre du bas : ce qui partira au moteur, en une ligne. */
function slSummary() {
  const used = slUsedSet();
  const bed = $("s-bed").selectedOptions[0]?.textContent || "";
  const temp = typeof PD !== "undefined" ? PD.bedTemps?.[$("s-bed").value] : null;
  const n = used.size || 1;
  const parts = [
    `${n} bobine${n > 1 ? "s" : ""}`,
    bed && `${bed}${temp ? ` ${temp}` : ""}`,
    $("s-layer-val").textContent,
    `${$("s-infill-val").textContent} remplissage`,
    `${$("s-walls-val").textContent} parois`,
    $("s-supports").checked && "supports",
    $("s-brim").checked && "bordure",
  ].filter(Boolean);
  $("s-summary").innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join("");
}

/* Ajustements touchés à la main : ils survivent à un changement de profil. */
const SL_TOUCH = { "s-infill": "infill", "s-walls": "walls", "s-supports": "supports", "s-brim": "brim" };
function slTouch(id) {
  (SL.touched ||= new Set()).add(SL_TOUCH[id]);
}

$("smodal").addEventListener("input", (e) => {
  if (e.target.id in SL_TOUCH && e.isTrusted) slTouch(e.target.id);
  if (e.target.matches("#s-infill, #s-supports, #s-brim")) slSummary();
});
$("smodal").addEventListener("change", (e) => {
  if (e.target.matches("#s-map select")) slUsedHeads();
  if (e.target.matches("#s-supports, #s-brim")) slSummary();
});

function setRange(id, value, fmt) {
  const el = $(id);
  el.value = value;
  el.dataset.fmt = "1";
  $(id + "-val").textContent = fmt(+el.value);
  el.oninput = () => ($(id + "-val").textContent = fmt(+el.value));
}

function currentSimple() {
  return {
    infill: +$("s-infill").value,
    walls: +$("s-walls").value,
    supports: $("s-supports").checked,
    brim: $("s-brim").checked,
  };
}

/* ------------------------------------------------------------ exécution */

function setSliceMessage(text, cls) {
  const el = $("s-msg");
  el.textContent = text;
  el.className = "pf-test" + (cls ? " " + cls : "");
}

/* Barre d'avancement ; `null` la masque. */
function setSliceProgress(pct) {
  $("s-progress").classList.toggle("hidden", pct == null);
  if (pct != null) $("s-progress").firstElementChild.style.width = Math.max(2, pct) + "%";
}

function showSliceBusy(busy) {
  $("s-go").classList.toggle("hidden", busy);
  $("s-cancel").classList.toggle("hidden", busy);
  $("s-stop").classList.toggle("hidden", !busy);
  document
    .querySelectorAll("#smodal select, #smodal input, #smodal .sl-cols button:not(.info-btn)")
    .forEach((el) => (el.disabled = busy));
  if (busy) closePicker();
  // Déverrouillé : les jetons des têtes vides doivent rester inactifs.
  else slTokens();
}

async function startSlice() {
  const machine = $("s-machine").value;
  const process = $("s-process").value;
  const filaments = [...document.querySelectorAll("#s-heads select")].map((s) => s.value);
  if (!machine || !process || !filaments.length || filaments.some((f) => !f)) {
    setSliceMessage("Choisissez une machine, un profil et un filament par tête.", "err");
    return;
  }
  // Extrudeur du modèle → tête, fichier par fichier ; l'entrée i concerne
  // l'extrudeur i + 1.
  const maps = SL.models.map(() => []);
  document.querySelectorAll("#s-map select").forEach((s) => (maps[+s.dataset.file][+s.dataset.ext - 1] = +s.value));
  for (const m of maps) for (let i = 0; i < m.length; i++) if (m[i] == null) m[i] = 0;
  const scene = SL.source.items.map((it) => ({ ...it, extruder_map: maps[SL.models.findIndex((m) => m.path === it.path)] || [] }));
  const heads = [...new Set(maps.flat())];
  const empty = heads.filter((h) => SL.slots.find((s) => s.index === h && !s.present));
  if (empty.length) {
    setSliceMessage(`La tête ${empty.map((h) => "T" + h).join(", ")} n'a pas de bobine.`, "err");
    return;
  }
  const colors = filaments.map((_, i) => {
    const slot = SL.slots.find((s) => s.index === i);
    return slot?.present && slot.color ? slot.color : null;
  });

  const simple = currentSimple();
  const bed = $("s-bed").value;
  remember(machine, { process, filaments, simple, bed });
  const printer = currentPrinter();
  rememberPrinter(printer?.id || "");
  if (printer) {
    SL.memory["printer:" + printer.id] = machine;
    localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
  }

  showSliceBusy(true);
  setSliceMessage("Préparation…", "busy");
  setSliceProgress(0);
  try {
    SL.job = await invoke("slice_start", {
      request: {
        source: "", scene, name: SL.source.name, machine, process, filaments, simple, colors,
        overrides: bed ? { curr_bed_type: bed } : {},
      },
    });
    const bedLabel = $("s-bed").selectedOptions[0]?.textContent || "";
    SL.request = { printer: printer?.id || "", filaments, colors, machine, process, bed, bedLabel };
  } catch (e) {
    showSliceBusy(false);
    setSliceProgress(null);
    setSliceMessage(String(e), "err");
  }
}

listen("slice-progress", async (e) => {
  const p = e.payload;
  if (!SL.job || p.id !== SL.job) return;
  if (p.phase === "preparation") {
    setSliceMessage("Préparation du modèle et des profils…", "busy");
  } else if (p.phase === "slicing") {
    if (p.percent != null) {
      stopElapsed();
      setSliceProgress(p.percent);
      setSliceMessage(`${p.message || "Découpe en cours…"} ${Math.round(p.percent)} %`, "busy");
    } else {
      tickElapsed(p.elapsed_s);
    }
  } else if (p.phase === "preview") {
    stopElapsed();
    showSliceBusy(false);
    setSliceProgress(null);
    const job = SL.job;
    SL.job = null;
    closeSheet($("smodal"));
    showPreview(job, p);
  } else if (p.phase === "cancelled") {
    stopElapsed();
    showSliceBusy(false);
    setSliceProgress(null);
    SL.job = null;
    setSliceMessage("Découpe interrompue.", "");
  } else if (p.phase === "error") {
    stopElapsed();
    showSliceBusy(false);
    setSliceProgress(null);
    SL.job = null;
    setSliceMessage(p.message || "Le moteur s'est arrêté sans message.", "err");
  }
});

/* Le compteur tourne côté interface quand le moteur ne donne pas d'avancement. */
let elapsedTimer = 0;
function tickElapsed(from) {
  stopElapsed();
  const t0 = Date.now() - from * 1000;
  elapsedTimer = setInterval(() => {
    setSliceMessage(`Découpe en cours… ${((Date.now() - t0) / 1000).toFixed(0)} s`, "busy");
  }, 500);
}
function stopElapsed() {
  clearInterval(elapsedTimer);
  elapsedTimer = 0;
}

/* ------------------------------------------------------------ aperçu */

function showPreview(job, p) {
  const req = SL.request || { filaments: [], colors: [] };
  SL.preview = { job, source: SL.source, gcode: p.gcode, stats: p.stats || {}, printer: req.printer, saved: null };
  const toolColors = req.filaments.map((_, i) => hexToRgb(req.colors[i]));
  const toolNames = req.filaments.map((name) => name.replace(/\s*@.*$/, ""));
  openPreview({
    path: p.gcode,
    name: SL.source.name + " — aperçu",
    stats: p.stats || {},
    toolColors,
    toolNames,
    onSend: openSend,
    onSave: savePreview,
    onEdit: () => {
      closeViewer();
      switchView("prepare");
      openSlice();
    },
    // Fermer l'aperçu le supprime : ce qui a été enregistré reste.
    onClose: () => {
      if (SL.preview) invoke("slice_discard", { id: SL.preview.job }).catch(() => {});
      SL.preview = null;
    },
  });
}

async function savePreview() {
  const pv = SL.preview;
  if (!pv) return;
  try {
    const path = await invoke("slice_save", { id: pv.job, dir: null });
    pv.saved = path;
    toast("G-code enregistré : " + path.split("/").pop());
    await refresh();
  } catch (e) {
    toast(String(e), true);
  }
}

/* ------------------------------------------------------------ envoi */

async function openSend() {
  const pv = SL.preview;
  if (!pv) return;
  if (!SL.printers.length) SL.printers = await invoke("printers_list").catch(() => []);
  if (!SL.printers.length) {
    toast("Ajoutez d'abord une imprimante", true);
    return;
  }
  $("snd-file").textContent = pv.source.name + (pv.stats.print_time_s ? " · " + fmtDuration(pv.stats.print_time_s) : "");
  $("snd-printer").innerHTML = SL.printers
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.host)}</option>`)
    .join("");
  $("snd-printer").value = SL.printers.some((p) => p.id === pv.printer) ? pv.printer : SL.printers[0].id;
  // Options toujours décochées à l'ouverture, comme demandé.
  ["snd-level", "snd-flow", "snd-timelapse"].forEach((id) => ($(id).checked = false));
  setSendBusy(false);
  setSendMessage("");
  setSendProgress(null);
  openSheet($("sendmodal"));
  checkSendPrinter();
}

const sendPrinter = () => SL.printers.find((p) => p.id === $("snd-printer").value);

/* Imprimante libre : lancer, ou mettre en file. Occupée ou injoignable :
   seulement la file d'attente. */
function setSendMode(mode) {
  SL.sendMode = mode;
  $("snd-go").textContent = mode === "queue" ? "Ajouter à la file d'attente" : "Lancer l'impression";
  $("snd-queue").classList.toggle("hidden", mode !== "launch");
}

/* État de l'imprimante visée : on ne lance que sur une machine au repos. */
async function checkSendPrinter() {
  const p = sendPrinter();
  const el = $("snd-state");
  $("snd-go").disabled = true;
  setSendMode("launch");
  $("snd-queue").classList.add("hidden");
  if (!p) return;
  el.className = "pf-test busy";
  el.textContent = "Interrogation de l'imprimante…";
  const st = await invoke("printer_status", { host: p.host, port: p.port }).catch(() => null);
  if (sendPrinter() !== p) return;
  if (!st || !st.online) {
    el.className = "pf-test err";
    el.textContent = `${p.name} ne répond pas : l'impression peut attendre dans la file.`;
    setSendMode("queue");
    $("snd-go").disabled = false;
    return;
  }
  if (["printing", "paused"].includes(st.state)) {
    const end = st.remaining_s ? ` — fin prévue vers ${fmtClock(Date.now() + st.remaining_s * 1000)}` : "";
    el.className = "pf-test warn";
    el.textContent = `${p.name} imprime « ${(st.job || "").replace(/\.gcode$/, "")} »${end}.`;
    setSendMode("queue");
    $("snd-go").disabled = false;
    return;
  }
  // Têtes du G-code sans bobine sur cette machine : à signaler avant l'envoi.
  const tools = SL.preview?.stats?.tools || [];
  const missing = tools.filter((t) => (st.filaments || []).some((f) => f.index === t && !f.present));
  el.className = "pf-test" + (missing.length ? " err" : " ok");
  el.textContent = missing.length
    ? `Tête ${missing.map((t) => "T" + t).join(", ")} sans bobine sur ${p.name}.`
    : `${p.name} est prête.`;
  $("snd-go").disabled = missing.length > 0;
  setSendMode("launch");
}

function setSendMessage(text, cls) {
  const el = $("snd-msg");
  el.textContent = text;
  el.className = "pf-test" + (cls ? " " + cls : "");
}
function setSendProgress(pct) {
  $("snd-progress").classList.toggle("hidden", pct == null);
  if (pct != null) $("snd-progress").firstElementChild.style.width = Math.max(2, pct) + "%";
}
function setSendBusy(busy) {
  SL.sending = busy;
  $("snd-go").classList.toggle("hidden", busy);
  // Après un échec, les choix d'avant reviennent (dont « Mettre en file »).
  if (busy) $("snd-queue").classList.add("hidden");
  else if (SL.sendMode) setSendMode(SL.sendMode);
  $("snd-cancel").classList.toggle("hidden", busy);
  ["snd-printer", "snd-level", "snd-flow", "snd-timelapse"].forEach((id) => ($(id).disabled = busy));
}

async function sendPrint(queue = SL.sendMode === "queue") {
  const pv = SL.preview, p = sendPrinter();
  if (!pv || !p || (!queue && $("snd-go").disabled)) return;
  setSendBusy(true);
  setSendProgress(queue ? null : 0);
  setSendMessage(queue ? "Ajout à la file d'attente…" : "Préparation de l'imprimante…", "busy");
  const r = SL.request || {};
  try {
    const id = await invoke("print_send", {
      request: {
        printer_id: p.id,
        job: pv.job,
        queue,
        tools: pv.stats.tools?.length ? pv.stats.tools : [0],
        options: {
          bed_leveling: $("snd-level").checked,
          flow_calibration: $("snd-flow").checked,
          timelapse: $("snd-timelapse").checked,
        },
        profile: {
          machine: r.machine || "",
          process: r.process || "",
          filaments: r.filaments || [],
          bed: r.bed || null,
          bed_label: r.bedLabel || null,
          colors: r.colors || [],
        },
      },
    });
    if (!queue) {
      // L'instantané des imprimantes peut encore dire « libre » : la fiche
      // se désigne par le travail, pas par l'imprimante.
      await pjLoad();
      pjShow(id ? "job:" + id : null);
    } else {
      setSendBusy(false);
      closeSheet($("sendmodal"));
      closeViewer();
      await pjLoad();
      const pos = pjQueue().findIndex((j) => j.id === id) + 1;
      toast(`Ajoutée à la file d'attente de ${p.name}${pos ? ` (${pos}${pos === 1 ? "re" : "e"} position)` : ""}`);
      pjShow("job:" + id);
    }
  } catch (e) {
    setSendBusy(false);
    setSendProgress(null);
    setSendMessage(String(e), "err");
  }
}

listen("print-send", (e) => {
  if (!SL.sending) return;
  const s = e.payload;
  if (s.phase === "check") setSendMessage("Vérification de l'imprimante…", "busy");
  else if (s.phase === "prepare") setSendMessage("Préparation de l'imprimante…", "busy");
  else if (s.phase === "upload") {
    setSendProgress(s.percent);
    setSendMessage(`Envoi du fichier… ${Math.round(s.percent || 0)} %`, "busy");
  } else if (s.phase === "done") {
    const p = sendPrinter();
    setSendBusy(false);
    closeSheet($("sendmodal"));
    toast(`Impression lancée sur ${p?.name || "l'imprimante"}`);
    if (s.message) toast(s.message, true);
    closeViewer();
  }
});

/* ------------------------------------------------------------ évènements */

$("s-printer").addEventListener("change", onPrinterChange);
$("s-machine").addEventListener("change", () => onMachineChange(null));
// Changer de profil (hauteur, style) applique ses valeurs, sauf pour les
// ajustements que l'utilisateur a déjà touchés dans cette fenêtre.
$("s-process").addEventListener("change", () => {
  const cur = currentSimple();
  loadDefaults(Object.fromEntries([...(SL.touched || [])].map((k) => [k, cur[k]])));
});
$("s-go").addEventListener("click", startSlice);
$("s-cancel").addEventListener("click", () => closeSheet($("smodal")));
$("s-stop").addEventListener("click", () => {
  if (SL.job) invoke("slice_cancel", { id: SL.job });
});
document.addEventListener("keydown", (e) => {
  if ($("smodal").classList.contains("hidden")) return;
  // Le détail d'un profil, ouvert par-dessus, garde ses touches.
  if (!$("pdmodal").classList.contains("hidden")) return;
  if (e.key === "Escape" && !SL.job) closeSheet($("smodal"));
  if (e.key === "Enter" && !SL.job && e.target.tagName !== "SELECT") startSlice();
});

$("snd-printer").addEventListener("change", checkSendPrinter);
$("snd-go").addEventListener("click", () => sendPrint());
$("snd-cancel").addEventListener("click", () => closeSheet($("sendmodal")));
$("snd-queue").addEventListener("click", () => sendPrint(true));
document.addEventListener("keydown", (e) => {
  if ($("sendmodal").classList.contains("hidden") || SL.sending) return;
  if (e.key === "Escape") closeSheet($("sendmodal"));
});
