"use strict";
/* Vue « Imprimantes ».
   Le statut est lu par l'API HTTP Moonraker de l'imprimante (Klipper) :
   la Snapmaker U1 l'expose sur le port 7125, et sur le port 80 derrière son nginx.
   La recherche réseau (mDNS) ne tourne que pendant l'affichage de la liste
   « Sur le réseau » ; sinon, seules les adresses enregistrées sont interrogées. */

const P = {
  list: [],
  sel: null,
  status: new Map(),   // id -> dernier statut connu
  seen: new Map(),     // id -> horodatage de la dernière donnée reçue
  live: new Map(),     // id -> flux temps réel établi
  timer: null,
  editing: null,
  busy: false,
};

window.currentView = "files";

/* ------------------------------------------------------------ navigation */

function switchView(v) {
  window.currentView = v;
  document.querySelectorAll(".views > .view").forEach((s) => {
    s.classList.toggle("hidden", s.id !== "view-" + v);
  });
  if (v === "printers") startLive();
  else {
    stopLive();
    camStop();
  }
  if (v === "prints") pjRender();
  else if (typeof pjCamStop === "function") pjCamStop();
  // Les vues natives de la Bibliothèque ne doivent vivre que dans son onglet.
  libSetVisible(v === "library");
  if (v === "settings") refreshCacheSize();
  if (v === "prepare") prepareShow();
  if (v === "ia") iaRefresh();
  // Le visualiseur ancré doit suivre l'onglet, pas y rester prisonnier.
  iaSetVisible(v === "ia");
  tbRender();
  sideSync();
}

document.querySelectorAll(".sidebar .side-item[data-view]").forEach((b) =>
  b.addEventListener("click", () => switchView(b.dataset.view))
);
tbSet("prepare", "Plateau");
tbSet("library", "Bibliothèque");
tbSet("ia", "IA");
tbSet("printers", "Imprimantes");
tbSet("settings", "Réglages");

/* ------------------------------------------------------------ liste */

async function prnLoad(selectId) {
  P.list = await invoke("printers_list");
  if (selectId) P.sel = selectId;
  if (P.sel && !P.list.some((p) => p.id === P.sel)) P.sel = null;
  if (!P.sel && P.list.length) P.sel = P.list[0].id;
  prnRenderList();
  prnRenderDetail();
  if (window.currentView === "printers") startLive();
}

function ledClass(st, id) {
  if (id != null && P.live.get(id) === false) return "err";
  if (!st || !st.online) return "";
  if (st.state === "printing") return "busy";
  if (st.state === "error") return "err";
  return "ok";
}

const SIDE_PRINTER = '<svg viewBox="0 0 24 24"><path d="M7 3h10v4H7zm-2 6h14a2 2 0 0 1 2 2v5h-4v-3H7v3H3v-5a2 2 0 0 1 2-2m2 6h10v6H7z"/></svg>';

/* Les imprimantes s'affichent dans la barre latérale, voyant d'état à droite.
   Les statuts arrivent en continu : si la liste n'a pas changé, on ne touche
   qu'aux voyants, sans remplacer les entrées (un clic en cours serait perdu). */
function prnRenderList() {
  const box = $("side-printers");
  const items = [...box.children];
  if (items.length === P.list.length && items.every((el, i) => el.dataset.id === P.list[i].id)) {
    items.forEach((el, i) => {
      const p = P.list[i];
      el.querySelector(".led").className = "led " + ledClass(P.status.get(p.id), p.id);
      el.querySelector(".lbl").textContent = p.name || p.host;
    });
    sideSync();
    return;
  }
  box.innerHTML = "";
  for (const p of P.list) {
    const st = P.status.get(p.id);
    const el = document.createElement("button");
    el.className = "side-item";
    el.dataset.id = p.id;
    el.title = `${p.host}${p.port && p.port !== 80 ? ":" + p.port : ""}`;
    el.innerHTML = `<span class="glyph" style="color: #34C759">${SIDE_PRINTER}</span>
      <span class="lbl">${esc(p.name || p.host)}</span><span class="led ${ledClass(st, p.id)}"></span>`;
    el.onclick = () => {
      P.sel = p.id;
      prnRenderDetail();
      switchView("printers");
      refreshSelected();
    };
    el.oncontextmenu = (e) =>
      nativeMenu([
        { id: "prn:edit:" + p.id, label: "Modifier…" },
        {},
        { id: "prn:remove:" + p.id, label: "Supprimer" },
      ], e.clientX, e.clientY);
    box.appendChild(el);
  }
  sideSync();
}

/* ------------------------------------------------------------ détail */

const STATES = {
  standby: ["Prête", "ok"],
  ready: ["Prête", "ok"],
  printing: ["Impression en cours", "busy"],
  paused: ["En pause", "busy"],
  complete: ["Impression terminée", "ok"],
  cancelled: ["Impression annulée", ""],
  error: ["Erreur", "err"],
  offline: ["Hors ligne", "err"],
};

const fmtHms = (s) => {
  if (s == null || !isFinite(s)) return null;
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
};

function current() {
  return P.list.find((p) => p.id === P.sel) || null;
}

function prnRenderDetail() {
  const p = current();
  // La caméra suit l'imprimante affichée : on coupe en changeant d'imprimante.
  if (CAM.id && CAM.id !== p?.id) camStop();
  $("prn-empty").classList.toggle("hidden", !!p);
  $("prn-detail").classList.toggle("hidden", !p);
  $("prn-tools").classList.toggle("hidden", !p);
  if (!p) {
    tbSet("printers", "Imprimantes");
    return;
  }
  tbSet("printers", p.name || p.host, `${p.host}:${p.port}${p.model ? " · " + p.model : ""}`);
  renderStatus(P.status.get(p.id));
}

function renderStatus(st) {
  const pill = $("prn-pill");
  if (!st) {
    pill.className = "pill";
    pill.textContent = "Interrogation…";
    paintPrinter({ online: false, state: "offline", nozzles: [] });
    return;
  }
  const [label, cls] = STATES[st.online ? st.state : "offline"] || [st.state, ""];
  pill.className = "pill " + cls;
  pill.textContent = label;

  const msg = $("prn-msg");
  const text = !st.online
    ? "Imprimante injoignable. " + (st.message || "")
    : st.state === "error"
    ? st.message || "Erreur signalée par Klipper."
    : "";
  msg.textContent = text;
  msg.classList.toggle("hidden", !text);

  // Anneau de progression
  const printing = st.job && st.progress != null;
  const pct = printing ? Math.round(st.progress * 100) : null;
  const C = 2 * Math.PI * 50;
  const ring = $("prn-ring");
  ring.style.strokeDashoffset = C * (1 - (printing ? st.progress : 0));
  ring.style.opacity = printing ? 1 : 0;
  $("prn-jobpct").textContent = pct != null ? pct + " %" : "—";
  $("prn-ringlbl").textContent = printing
    ? "imprimé"
    : st.online
    ? (STATES[st.state] || ["au repos"])[0].toLowerCase()
    : "hors ligne";
  $("prn-jobname").textContent = st.job || (st.online ? "Aucune impression en cours" : "Aucune donnée");

  const times = [];
  const el = fmtHms(st.elapsed_s);
  const re = fmtHms(st.remaining_s);
  if (el) times.push("écoulé " + el);
  if (re) times.push("reste environ " + re);
  $("prn-times").textContent = times.join(" · ");

  // Étiquettes de contexte
  const chips = [];
  if (st.layer) chips.push(chip("Couche", `${st.layer[0]} / ${st.layer[1]}`));
  if (st.filament_mm) chips.push(chip("Filament", (st.filament_mm / 1000).toFixed(2).replace(".", ",") + " m"));
  const act = (st.nozzles || []).find((n) => n.active);
  if (act) {
    const t = act.current.toFixed(1).replace(".", ",");
    chips.push(chip("Buse T" + act.index, act.target > 0 ? `${t} → ${Math.round(act.target)} °C` : `${t} °C`));
  }
  // Une vitesse à 100 % n'apprend rien : on ne l'affiche que si elle est modifiée.
  if (st.speed_factor != null && Math.round(st.speed_factor * 100) !== 100)
    chips.push(chip("Vitesse", Math.round(st.speed_factor * 100) + " %"));
  if (st.fan != null) chips.push(chip("Ventilateur", Math.round(st.fan * 100) + " %"));
  $("prn-chips").innerHTML = chips.join("");

  // Filaments chargés (U1) et températures
  renderFilaments(st);
  const rows = [];
  if (!(st.filaments || []).length) {
    // Imprimante sans emplacements déclarés : les buses restent listées ici.
    for (const n of st.nozzles || []) {
      rows.push(tempRow(`Buse T${n.index}`, n.active ? "tête active" : "", n.current, n.target, n.active, ICON_NOZZLE));
    }
  }
  if (st.bed) rows.push(tempRow("Plateau", "", st.bed.current, st.bed.target, false, ICON_BED));
  if (st.chamber) rows.push(tempRow("Caisson", "", st.chamber.current, st.chamber.target, false, ICON_BED));
  $("prn-temps").innerHTML = rows.join("");

  // Informations
  const p = current();
  const info = [];
  const add = (k, v) => v != null && v !== "" && info.push(
    `<div class="grow-row"><span class="k">${esc(k)}</span><span class="val">${esc(String(v))}</span></div>`
  );
  add("Modèle", p?.model);
  add("Adresse", `${p?.host}:${p?.port}`);
  add("Nom d'hôte", st.hostname);
  add("Klipper", st.klipper);
  add("Note", p?.note);
  $("prn-info").innerHTML = info.join("");

  paintPrinter(st);
  updateFreshness();
}

/* Nom français approximatif d'une couleur, pour décrire une bobine. */
function colorName(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  if (d < 0.08) return l > 0.85 ? "blanc" : l < 0.12 ? "noir" : "gris";
  let deg = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (deg < 0) deg += 360;
  const table = [[15, "rouge"], [45, "orange"], [70, "jaune"], [160, "vert"], [200, "cyan"],
                 [255, "bleu"], [290, "violet"], [330, "rose"], [361, "rouge"]];
  let name = table.find(([lim]) => deg < lim)[1];
  if (l < 0.22) name += " foncé";
  else if (l > 0.82) name += " clair";
  return name;
}

/* Bobines chargées, la tête active en premier. */
function renderFilaments(st) {
  const box = $("prn-filaments");
  const fils = st.filaments || [];
  if (!fils.length) {
    box.innerHTML = "";
    return;
  }
  const act = (st.nozzles || []).find((n) => n.active);
  const ai = act ? act.index : -1;
  const printing = st.state === "printing";
  const sorted = [...fils].sort((a, b) => {
    if (a.index === ai) return -1;
    if (b.index === ai) return 1;
    return a.index - b.index;
  });

  const rows = sorted.map((f) => {
    const on = f.index === ai;
    const n = (st.nozzles || []).find((x) => x.index === f.index);
    const bits = [];
    if (f.present) {
      const kind = [f.kind, f.sub_type].filter(Boolean).join(" ");
      // Le code hexadécimal est une donnée technique : en ui-monospace.
      const col = f.color ? `${esc(colorName(f.color))} <code>${esc(f.color.toUpperCase())}</code>` : "";
      bits.push([esc(kind), col].filter(Boolean).join(" · "));
      if (f.vendor) bits.push(esc(f.vendor));
    } else {
      bits.push("emplacement vide");
    }
    const tags = [];
    if (on) {
      tags.push(`<span class="ftag accent">${printing ? "EN EXTRUSION" : "TÊTE ACTIVE"}</span>`);
    } else if (f.used && st.job) {
      // `extruders_used` garde la trace du dernier travail : sans impression en
      // cours, la mention n'aurait plus de sens.
      tags.push('<span class="ftag">utilisé par le travail</span>');
    }
    if (!f.present) tags.push('<span class="ftag">vide</span>');
    const temp = n ? `${n.current.toFixed(1).replace(".", ",")} °C` : "";
    const sw = f.present && f.color ? `background:${esc(f.color)}` : "";
    return `<div class="frow${on ? " on" : ""}">
      <span class="fbar"></span>
      <span class="fsw" style="${sw}"></span>
      <span class="k"><b>T${f.index}</b><span class="sub">${bits.join(" · ")}</span></span>
      <span class="ftags">${tags.join("")}<span class="ftemp">${esc(temp)}</span></span>
    </div>`;
  });

  box.innerHTML =
    `<div class="ghead">Filaments chargés<span class="note">${fils.length} emplacements</span></div>` +
    rows.join("");
}

const chip = (k, v) => `<span class="chip">${esc(k)} <b>${esc(v)}</b></span>`;

const ICON_NOZZLE =
  '<svg viewBox="0 0 24 24"><path d="M8 3h8v5l-2 3v4l-2 6-2-6v-4L8 8z"/></svg>';
const ICON_BED =
  '<svg viewBox="0 0 24 24"><path d="M3 13h18v3H3zm2 4h3v3H5zm11 0h3v3h-3z"/><path d="M7 4c0 2-2 2-2 4h2c0-2 2-2 2-4zm5 0c0 2-2 2-2 4h2c0-2 2-2 2-4zm5 0c0 2-2 2-2 4h2c0-2 2-2 2-4z"/></svg>';

function tempRow(label, sub, cur, target, active, icon) {
  const heat = target > 0 ? Math.max(0, Math.min(1, cur / target)) : 0;
  return `<div class="grow-row${active ? " active" : ""}">
    <span class="ic">${icon}</span>
    <span class="k">${esc(label)}${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</span>
    <span class="heat"><i style="width:${(heat * 100).toFixed(0)}%"></i></span>
    <span class="v"><b>${cur.toFixed(1).replace(".", ",")} °C</b>
      <span>${target > 0 ? "→ " + Math.round(target) + " °C" : "sans chauffe"}</span></span>
  </div>`;
}

/* Anime l'illustration avec les données réelles : tête active désignée,
   couleurs des bobines et des tubes, chaleur, pièce qui grandit. */
const HEADS = [[103, 71], [126, 63], [150, 54], [173, 46]];

function paintPrinter(st) {
  const pv = $("pv");
  if (!pv) return;
  const printing = st.online && st.state === "printing";
  pv.classList.toggle("printing", printing);
  pv.classList.toggle("off", !st.online);

  const fil = (i) => (st.filaments || []).find((f) => f.index === i);
  const colorOf = (i) => {
    const f = fil(i);
    return f && f.present && f.color ? f.color : null;
  };
  const noz = (i) => (st.nozzles || []).find((n) => n.index === i);
  const act = (st.nozzles || []).find((n) => n.active);
  const ai = st.online && act ? act.index : -1;

  $("pv-lamp").setAttribute("opacity", st.online ? (printing ? 0.16 : 0.07) : 0);

  pv.querySelectorAll(".pv-head").forEach((h) => {
    const i = +h.dataset.i;
    h.classList.toggle("on", i === ai);
    // Sans information, on montre les quatre têtes de la U1.
    h.style.display = !st.nozzles?.length || noz(i) ? "" : "none";
  });
  pv.querySelectorAll(".pv-chip").forEach((c) => {
    c.style.fill = colorOf(+c.dataset.i) || "";
  });
  pv.querySelectorAll(".pv-spool").forEach((s) => {
    s.style.fill = colorOf(+s.dataset.i) || "";
  });
  pv.querySelectorAll(".pv-tube").forEach((t) => {
    t.style.stroke = colorOf(+t.dataset.i) || "";
  });

  // Désignation de la tête active : halo, étiquette et trait de rappel.
  const badge = $("pv-badge");
  if (ai >= 0) {
    const [x, y] = HEADS[ai];
    $("pv-glow").setAttribute("cx", x);
    $("pv-glow").setAttribute("cy", y + 8);
    $("pv-glow").setAttribute("opacity", 1);
    badge.setAttribute("opacity", 1);
    badge.querySelector("rect").setAttribute("x", x - 22);
    const t = badge.querySelector("text");
    t.setAttribute("x", x);
    t.textContent = "T" + ai;
    badge.querySelector(".pv-badge-line").setAttribute("d", `M${x} 33 L${x} ${y - 10}`);

    const n = noz(ai);
    const heat = n ? Math.max(0, Math.min(1, (n.current - 40) / 180)) : 0;
    $("pv-heat").setAttribute("cx", x);
    $("pv-heat").setAttribute("cy", y + 20);
    $("pv-heat").setAttribute("opacity", (heat * 0.95).toFixed(2));
  } else {
    $("pv-glow").setAttribute("opacity", 0);
    $("pv-heat").setAttribute("opacity", 0);
    badge.setAttribute("opacity", 0);
  }

  const bed = st.bed ? Math.max(0, Math.min(1, (st.bed.current - 30) / 60)) : 0;
  $("pv-bedglow").setAttribute("opacity", (bed * 0.8).toFixed(2));

  // La pièce grandit sur le plateau, dans la couleur du filament employé.
  const h = st.job && st.progress != null ? 4 + st.progress * 40 : 0;
  const obj = $("pv-obj");
  obj.setAttribute("d", `M181 ${(172 - h).toFixed(1)} L206 ${(163 - h).toFixed(1)} L206 163 L181 172 Z`);
  obj.style.fill = (ai >= 0 && colorOf(ai)) || "";

  $("pv-screen").setAttribute(
    "class",
    st.online ? (printing ? "busy" : st.state === "error" ? "err" : "ok") : ""
  );
}

/* ------------------------------------------------------------ interrogation */

async function pollOne(p) {
  try {
    const st = await invoke("printer_status", { host: p.host, port: p.port });
    P.status.set(p.id, st);
    P.seen.set(p.id, Date.now());
  } catch {
    P.status.set(p.id, { online: false, state: "offline", message: "Erreur interne" });
  }
}

async function refreshSelected() {
  const p = current();
  if (!p) return;
  await pollOne(p);
  if (current()?.id === p.id) {
    renderStatus(P.status.get(p.id));
    prnRenderList();
  }
}

async function refreshAll() {
  if (P.busy) return;
  P.busy = true;
  await Promise.all(P.list.map(pollOne));
  P.busy = false;
  prnRenderList();
  if (current()) renderStatus(P.status.get(P.sel));
}

/* Flux temps réel : l'imprimante pousse ses changements par WebSocket
   (JSON-RPC Moonraker). Les connexions ne vivent que pendant l'affichage
   de cet onglet. */
function startLive() {
  invoke("printers_watch_start").catch((e) => toast(String(e), true));
  // Rafraîchit l'horodatage « il y a … » sans aucun trafic réseau.
  clearInterval(P.timer);
  P.timer = setInterval(() => {
    if (current()) updateFreshness();
  }, 1000);
}

function stopLive() {
  invoke("printers_watch_stop").catch(() => {});
  clearInterval(P.timer);
  P.timer = null;
  P.live.clear();
}

listen("printer-status", (e) => {
  const { id, live, status } = e.payload;
  P.status.set(id, status);
  P.live.set(id, live);
  if (live) P.seen.set(id, Date.now());
  prnRenderList();
  if (id === P.sel) renderStatus(status);
});

function updateFreshness() {
  const seen = P.seen.get(P.sel);
  const live = P.live.get(P.sel);
  const box = $("prn-updated");
  if (!seen) {
    box.textContent = live ? "Connexion au flux temps réel…" : "";
    return;
  }
  const age = Math.round((Date.now() - seen) / 1000);
  box.textContent = live
    ? `Flux temps réel · donnée reçue il y a ${age} s`
    : `Hors ligne · dernière donnée à ${new Date(seen).toLocaleTimeString("fr-FR")}`;
}

/* ------------------------------------------------------------ formulaire */

/* ------------------------------------------------- recherche réseau */

/* Liste « Sur le réseau », partagée par la fenêtre d'ajout et l'assistant de
   bienvenue : une seule recherche à la fois, affichée dans la dernière liste
   ouverte. Les imprimantes arrivent au fil des réponses, une par adresse. */
const DISC = { items: new Map(), running: false, error: null, picked: null, view: null };

function discoveryList(box, onPick) {
  DISC.view = { box, onPick };
  box.classList.add("disc");
  box.innerHTML = `<div class="disc-head">
      <span class="disc-title">Sur le réseau</span>
      <span class="disc-state"></span>
      <button class="btn small disc-again hidden">Relancer</button>
    </div>
    <div class="disc-list"></div>`;
  box.querySelector(".disc-again").onclick = discoverStart;
  discoverStart();
}

async function discoverStart() {
  DISC.items.clear();
  DISC.picked = null;
  DISC.error = null;
  DISC.running = true;
  discRender();
  try {
    await invoke("printer_discover_start");
  } catch (e) {
    DISC.running = false;
    DISC.error = String(e);
    discRender();
  }
}

function discoverStop() {
  if (DISC.running) invoke("printer_discover_stop").catch(() => {});
  DISC.running = false;
  DISC.view = null;
}

/* Modèle à proposer pour une imprimante trouvée. */
const discModel = (f) => f.model || (f.service === "snapmaker" ? "Snapmaker U1" : "Klipper / Moonraker");

/* Déjà enregistrée : même adresse. */
const discKnown = (f) => P.list.some((p) => p.host === f.ip);

listen("printer-found", (e) => {
  const f = e.payload;
  const prev = DISC.items.get(f.ip);
  // Une U1 s'annonce parfois deux fois (Snapmaker et Moonraker) : la fiche
  // Snapmaker, plus riche, l'emporte.
  if (prev?.service === "snapmaker" && f.service !== "snapmaker") return;
  DISC.items.set(f.ip, f);
  discRender();
});
listen("printer-discover-done", () => {
  DISC.running = false;
  discRender();
});

function discRender() {
  const v = DISC.view;
  if (!v) return;
  const items = [...DISC.items.values()].sort((a, b) => a.name.localeCompare(b.name));
  const st = v.box.querySelector(".disc-state");
  st.innerHTML = DISC.running
    ? '<span class="spinner small"></span>Recherche…'
    : items.length
      ? `${items.length} trouvée${items.length > 1 ? "s" : ""}`
      : "";
  v.box.querySelector(".disc-again").classList.toggle("hidden", DISC.running);
  const list = v.box.querySelector(".disc-list");
  if (!items.length) {
    list.innerHTML = DISC.running
      ? ""
      : `<div class="disc-empty">${esc(DISC.error || "Aucune imprimante trouvée — vérifiez qu'elle est allumée et sur le même réseau, ou saisissez son adresse.")}</div>`;
    return;
  }
  list.innerHTML = "";
  for (const f of items) {
    const known = discKnown(f);
    const el = document.createElement("button");
    el.className = "disc-item" + (DISC.picked === f.ip ? " on" : "");
    el.disabled = known;
    const sub = [f.ip, discModel(f), f.firmware && `firmware ${f.firmware}`].filter(Boolean).join(" · ");
    el.innerHTML = `<span class="glyph">${SIDE_PRINTER}</span>
      <span class="disc-text"><b>${esc(f.name)}</b><small>${esc(sub)}</small></span>
      ${known ? '<span class="disc-tag">déjà ajoutée</span>' : ""}`;
    el.onclick = () => {
      DISC.picked = f.ip;
      discRender();
      v.onPick(f);
    };
    list.appendChild(el);
  }
}

function openForm(printer) {
  P.editing = printer || null;
  $("pmodal-title").textContent = printer ? "Modifier l'imprimante" : "Ajouter une imprimante";
  $("pf-name").value = printer?.name || "";
  $("pf-host").value = printer?.host || "";
  $("pf-port").value = printer?.port || 7125;
  $("pf-model").value = printer?.model || "Snapmaker U1";
  $("pf-test").textContent = "";
  $("pf-test").className = "pf-test";
  // La recherche ne sert qu'à un ajout.
  $("pf-disc").classList.toggle("hidden", !!printer);
  if (!printer) {
    discoveryList($("pf-disc"), (f) => {
      $("pf-name").value = f.name;
      $("pf-host").value = f.ip;
      $("pf-port").value = 7125;
      $("pf-model").value = discModel(f);
      probeForm();
    });
  }
  openSheet($("pmodal"));
  setTimeout(() => $("pf-host").focus(), 30);
}

function closeForm() {
  discoverStop();
  closeSheet($("pmodal"));
  P.editing = null;
}

async function probeForm() {
  const host = $("pf-host").value.trim();
  if (!host) return;
  const box = $("pf-test");
  box.className = "pf-test";
  box.textContent = "Test en cours…";
  const r = await invoke("printer_probe", { host, port: +$("pf-port").value || 7125 });
  box.className = "pf-test " + (r.ok ? "ok" : "err");
  box.textContent = r.detail;
  if (r.ok) {
    $("pf-port").value = r.port;
    if (!$("pf-name").value.trim() && r.hostname) $("pf-name").value = r.hostname;
  }
}

async function saveForm() {
  const host = $("pf-host").value.trim();
  if (!host) {
    $("pf-test").className = "pf-test err";
    $("pf-test").textContent = "Indiquez l'adresse IP ou le nom d'hôte de l'imprimante.";
    return;
  }
  const printer = {
    id: P.editing?.id || "",
    name: $("pf-name").value.trim() || host,
    host,
    port: +$("pf-port").value || 7125,
    model: $("pf-model").value.trim(),
    note: P.editing?.note || "",
  };
  try {
    P.list = await invoke("printer_save", { printer });
    const saved = P.list.find((x) => x.host === printer.host && x.port === printer.port);
    closeForm();
    await prnLoad(printer.id || saved?.id);
    switchView("printers");
    toast(P.editing ? "Imprimante mise à jour" : "Imprimante ajoutée");
  } catch (e) {
    toast("Enregistrement impossible : " + e, true);
  }
}

/* suppression en deux temps, sans fenêtre supplémentaire */
onMenu("prn", (arg) => {
  const i = arg.indexOf(":");
  const what = arg.slice(0, i), id = arg.slice(i + 1);
  const p = P.list.find((x) => x.id === id);
  if (!p) return;
  if (what === "edit") openForm(p);
  if (what === "remove") askRemove(p);
});

/* Suppression : confirmation par une alerte native. */
async function askRemove(target) {
  const p = target && target.id ? target : current();
  if (!p) return;
  const ok = await confirmDelete(
    `Supprimer « ${p.name || p.host} » ?`,
    "Elle disparaîtra de la liste ; rien n'est modifié sur la machine."
  );
  if (!ok) return;
  invoke("printer_remove", { id: p.id })
    .then(() => {
      P.status.delete(p.id);
      if (P.sel === p.id) P.sel = null;
      return prnLoad();
    })
    .then(() => toast("Imprimante supprimée"))
    .catch((e) => toast(String(e), true));
}

/* ------------------------------------------------------------ caméra */

/* Comme Snapmaker Orca : la caméra est réveillée par `camera.start_monitor`,
   publie une image JPEG renouvelée en continu, qu'on relit en boucle ; elle
   s'éteint d'elle-même si on ne la relance pas, d'où la relance toutes les
   10 s. Une seule lecture en vol à la fois : la suivante part au chargement. */
const CAM = { id: null, on: false, n: 0, timer: 0, keep: 0 };

async function camStart() {
  const p = current();
  if (!p) return;
  camStop();
  Object.assign(CAM, { id: p.id, on: true });
  $("cam-toggle").textContent = "Masquer";
  $("cam-note").textContent = "démarrage…";
  $("cam-box").classList.remove("hidden");
  try {
    await invoke("camera_start", { printerId: p.id });
  } catch (e) {
    if (CAM.id !== p.id) return;
    camStop();
    $("cam-note").textContent = String(e);
    return;
  }
  if (!CAM.on || CAM.id !== p.id) return;
  CAM.keep = setInterval(() => invoke("camera_start", { printerId: p.id }).catch(() => {}), 10000);
  camNext();
}

function camNext() {
  if (!CAM.on) return;
  $("cam-img").src = `cam://localhost/f?id=${encodeURIComponent(CAM.id)}&n=${++CAM.n}`;
}

function camStop() {
  clearTimeout(CAM.timer);
  clearInterval(CAM.keep);
  if (CAM.on && CAM.id) invoke("camera_stop", { printerId: CAM.id }).catch(() => {});
  Object.assign(CAM, { id: null, on: false, timer: 0, keep: 0 });
  $("cam-toggle").textContent = "Afficher";
  $("cam-note").textContent = "";
  $("cam-box").classList.add("hidden");
  $("cam-img").removeAttribute("src");
}

$("cam-img").addEventListener("load", () => {
  if (!CAM.on) return;
  $("cam-note").textContent = "";
  CAM.timer = setTimeout(camNext, 200);
});
$("cam-img").addEventListener("error", () => {
  if (!CAM.on) return;
  $("cam-note").textContent = "image indisponible, nouvel essai…";
  CAM.timer = setTimeout(camNext, 1000);
});
$("cam-toggle").addEventListener("click", () => (CAM.on ? camStop() : camStart()));
// Double-clic : l'image prend toute la largeur de l'écran de l'imprimante.
$("cam-box").addEventListener("dblclick", () => $("cam-box").classList.toggle("big"));

/* ------------------------------------------------------------ événements */

$("prn-add").addEventListener("click", () => openForm(null));
$("prn-add2").addEventListener("click", () => openForm(null));
$("prn-add3").addEventListener("click", () => openForm(null));
$("prn-edit").addEventListener("click", () => openForm(current()));
$("prn-del").addEventListener("click", () => askRemove());
$("prn-refresh").addEventListener("click", () => { refreshSelected(); startLive(); });
$("pf-cancel").addEventListener("click", closeForm);
$("pf-probe").addEventListener("click", probeForm);
$("pf-save").addEventListener("click", saveForm);
$("pmodal").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveForm();
  if (e.key === "Escape") closeForm();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("pmodal").classList.contains("hidden")) closeForm();
});

prnLoad();
