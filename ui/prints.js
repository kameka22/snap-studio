"use strict";
/* Vue « Impressions » : en cours, file d'attente, terminées.

   Le Rust tient le magasin des travaux (`jobs_list`) et interroge les
   imprimantes en fond (`prints-status`). Une impression en cours est désignée
   par son imprimante (`live:<id>`) : elle peut venir d'un autre outil ; un
   travail du magasin par son identifiant (`job:<id>`).

   Fin d'impression avec une file non vide : le Rust émet `queue-next`, une
   fenêtre propose la suivante. Rien ne part sans un clic, plateau libéré. */

const PJ = {
  jobs: [],
  live: [],
  sel: null,
  cam: { id: null, on: false, n: 0, timer: 0, keep: 0 },
  /* Fenêtre « Lancer la suivante ? » : travail proposé, lancement en cours. */
  next: null,
  launching: false,
  /* Propositions arrivées pendant qu'une autre est affichée. */
  pending: [],
};

const PJ_BUSY = ["printing", "paused"];
const PJ_STATE = {
  printing: "En impression",
  paused: "En pause",
  queued: "En attente",
  complete: "Terminée",
  finished: "Terminée",
  cancelled: "Annulée",
  error: "Erreur",
};

/* ------------------------------------------------------------ données */

async function pjLoad() {
  PJ.jobs = (await invoke("jobs_list").catch(() => null)) || [];
  pjRenderSide();
  if (window.currentView === "prints") pjRender();
}

const pjQueue = () => PJ.jobs.filter((j) => j.state === "queued");
const pjDone = () =>
  PJ.jobs.filter((j) => !["queued", "printing"].includes(j.state)).sort((a, b) => (b.finished || 0) - (a.finished || 0));
const pjActive = () => PJ.live.filter((l) => l.status.online && PJ_BUSY.includes(l.status.state));
const pjLiveOf = (printerId) => PJ.live.find((l) => l.printer_id === printerId);
const pjPrinterName = (id) => pjLiveOf(id)?.printer_name || P.list.find((p) => p.id === id)?.name || "Imprimante";

/* Travail Snap Studio derrière une impression en cours, s'il y en a un. */
function pjJobOfLive(live) {
  const mine = PJ.jobs.filter((j) => j.printer_id === live.printer_id && j.state === "printing");
  return mine.find((j) => j.remote === live.status.job) || mine[mine.length - 1] || null;
}

const pjThumb = (job, px = 320) =>
  job?.file ? `thumb://localhost/t?p=${encodeURIComponent(job.file)}&s=${px}&k=0&v=${job.created}` : "";

const pjName = (live) => (live.status.job || "Impression").replace(/\.gcode$/i, "");

/* Heure de début estimée d'un travail en file, d'après ce qui le précède. */
function pjStartEstimate(job) {
  const live = pjLiveOf(job.printer_id);
  let t = Date.now();
  if (live && PJ_BUSY.includes(live.status.state)) t += (live.status.remaining_s || 0) * 1000;
  for (const j of pjQueue()) {
    if (j.id === job.id) break;
    if (j.printer_id === job.printer_id) t += (j.stats?.print_time_s || 0) * 1000;
  }
  return t;
}

/* ------------------------------------------------------------ barre latérale */

function pjRing(p) {
  const r = 6, c = 2 * Math.PI * r, k = Math.max(0, Math.min(1, p || 0));
  return `<svg class="pj-ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="${r}" class="track"/>
    <circle cx="8" cy="8" r="${r}" class="bar" stroke-dasharray="${(k * c).toFixed(1)} ${c.toFixed(1)}"/></svg>`;
}

function pjRenderSide() {
  const box = $("side-prints");
  const items = [];
  for (const l of pjActive()) {
    const paused = l.status.state === "paused";
    items.push(`<button class="side-item" data-pj="live:${esc(l.printer_id)}" title="${esc(l.printer_name)}">
      <span class="glyph">${pjRing(l.status.progress)}</span>
      <span class="lbl">${esc(pjName(l))}</span>
      <span class="count">${paused ? "pause" : Math.round((l.status.progress || 0) * 100) + " %"}</span></button>`);
  }
  pjQueue().forEach((j, i) => {
    items.push(`<button class="side-item" data-pj="job:${esc(j.id)}" title="En attente · ${esc(pjPrinterName(j.printer_id))}">
      <span class="glyph pj-num">${i + 1}</span><span class="lbl">${esc(j.name)}</span></button>`);
  });
  box.innerHTML = items.join("");
  const n = pjActive().length + pjQueue().length;
  $("count-prints").textContent = n ? String(n) : "";
  sideSync();
}

$("side-prints").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pj]");
  if (b) pjShow(b.dataset.pj);
});

/* ------------------------------------------------------------ vue */

function pjShow(key) {
  PJ.sel = key || null;
  if (window.currentView !== "prints") switchView("prints");
  else {
    pjRender();
    sideSync();
  }
}

function pjRender() {
  const key = PJ.sel;
  const detail = !!key && pjResolve(key);
  $("pj-overview").classList.toggle("hidden", !!detail);
  $("pj-detail").classList.toggle("hidden", !detail);
  if (!detail) {
    PJ.sel = null;
    pjCamStop();
    pjRenderOverview();
    tbSet("prints", "Impressions", pjSubtitle());
    return;
  }
  pjRenderDetail(detail);
}

function pjSubtitle() {
  const a = pjActive().length, q = pjQueue().length;
  return [a && `${a} en cours`, q && `${q} en attente`].filter(Boolean).join(" · ");
}

/* Ce que désigne une clé : impression en cours, ou travail du magasin. */
function pjResolve(key) {
  if (key.startsWith("live:")) {
    const live = pjLiveOf(key.slice(5));
    if (!live || !PJ_BUSY.includes(live.status.state)) {
      // Impression finie depuis : on bascule sur sa fiche d'historique.
      const done = pjDone().find((j) => j.printer_id === key.slice(5));
      return done ? { job: done, live: pjLiveOf(done.printer_id) } : null;
    }
    return { live, job: pjJobOfLive(live), active: true };
  }
  const job = PJ.jobs.find((j) => j.id === key.slice(4));
  if (!job) return null;
  if (job.state === "printing") {
    const live = pjLiveOf(job.printer_id);
    if (live && PJ_BUSY.includes(live.status.state)) return { live, job, active: true };
  }
  return { job, live: pjLiveOf(job.printer_id) };
}

function pjCard(key, thumb, title, sub, badge, extra = "") {
  return `<button class="pj-card" data-key="${esc(key)}">
    <span class="pj-card-thumb">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" />` : PJ_PLACEHOLDER}</span>
    <span class="pj-card-text"><b>${esc(title)}</b><small>${sub}</small>${extra}</span>
    ${badge}</button>`;
}

const PJ_PLACEHOLDER =
  '<svg class="pj-ph" viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7zm0 2.3L5 8.2v7.6l7 3.9 7-3.9V8.2z"/></svg>';
const pjBadge = (state) => `<span class="pj-badge ${esc(state)}">${esc(PJ_STATE[state] || state)}</span>`;

function pjRenderOverview() {
  const box = $("pj-overview");
  const active = pjActive(), queue = pjQueue(), done = pjDone();
  const html = [];
  if (active.length) {
    html.push('<div class="vp-section">En cours</div><div class="pj-cards">');
    for (const l of active) {
      const job = pjJobOfLive(l);
      const st = l.status;
      const bar = `<span class="pj-mini-bar"><i style="width:${Math.round((st.progress || 0) * 100)}%"></i></span>`;
      html.push(
        pjCard(`live:${l.printer_id}`, pjThumb(job), job?.name || pjName(l),
          `${esc(l.printer_name)} · ${Math.round((st.progress || 0) * 100)} %${st.remaining_s ? ` · fin vers ${fmtClock(Date.now() + st.remaining_s * 1000)}` : ""}`,
          pjBadge(st.state), bar)
      );
    }
    html.push("</div>");
  }
  if (queue.length) {
    html.push('<div class="vp-section">En attente</div><div class="pj-cards">');
    queue.forEach((j, i) => {
      html.push(
        pjCard(`job:${j.id}`, pjThumb(j), `${i + 1}. ${j.name}`,
          `${esc(pjPrinterName(j.printer_id))}${j.stats?.print_time_s ? ` · ${fmtDuration(j.stats.print_time_s)}` : ""} · début ~${fmtClock(pjStartEstimate(j))}`,
          pjBadge("queued"))
      );
    });
    html.push("</div>");
  }
  if (done.length) {
    html.push('<div class="vp-section">Terminées</div><div class="pj-cards">');
    for (const j of done) {
      html.push(
        pjCard(`job:${j.id}`, pjThumb(j), j.name,
          `${esc(pjPrinterName(j.printer_id))}${j.finished ? ` · ${dtf.format(new Date(j.finished * 1000))}` : ""}`,
          pjBadge(j.state))
      );
    }
    html.push("</div>");
  }
  box.innerHTML = html.length
    ? html.join("")
    : `<div class="empty"><div class="empty-art">${PJ_PLACEHOLDER}</div><h1>Aucune impression</h1>
       <p>Découpez un modèle puis envoyez-le à une imprimante, ou mettez-le en file d'attente.</p></div>`;
}

$("pj-overview").addEventListener("click", (e) => {
  const c = e.target.closest("[data-key]");
  if (c) pjShow(c.dataset.key);
});

/* ------------------------------------------------------------ fiche */

function pjRow(k, v) {
  return v == null || v === "" ? "" : `<div class="grow-row"><span class="k">${esc(k)}</span><span class="pj-v">${v}</span></div>`;
}

function pjFilamentRows(job) {
  const s = job?.stats;
  if (!s) return "";
  const colors = job.profile?.colors || [];
  const names = job.profile?.filaments || [];
  const rows = (s.tools || []).map((t) => {
    const g = s.per_tool_g?.[t];
    const c = colors[t];
    return `<div class="pj-fil">${c ? `<i style="background:${esc(c)}"></i>` : "<i></i>"}<b>T${t}</b>
      <span>${esc(names[t] || names[0] || "")}</span><em>${g != null ? `${g.toFixed(1).replace(".", ",")} g` : ""}</em></div>`;
  });
  return rows.length ? `<div class="grow-row pj-fils"><span class="k">Filament</span><div>${rows.join("")}</div></div>` : "";
}

function pjSummary(job) {
  if (!job) {
    return `<div class="group"><div class="grow-row"><span class="k pj-muted">Impression lancée depuis un autre outil : Snap Studio n'en connaît que ce que l'imprimante rapporte.</span></div></div>`;
  }
  const s = job.stats || {};
  const o = job.options || {};
  const opts = [o.bed_leveling && "nivellement", o.flow_calibration && "calibration du débit", o.timelapse && "timelapse"].filter(Boolean);
  const when = (t) => (t ? esc(dtf.format(new Date(t * 1000))) : null);
  return `<div class="group">
    ${pjRow("Durée estimée", s.print_time_s ? esc(fmtDuration(s.print_time_s)) : null)}
    ${pjRow("Couches", s.layers ? String(s.layers) : null)}
    ${pjFilamentRows(job)}
    ${pjRow("Total", s.filament_g ? `${s.filament_g.toFixed(1).replace(".", ",")} g${s.cost ? ` · ${s.cost.toFixed(2).replace(".", ",")} €` : ""}` : null)}
    ${pjRow("Plateau", job.profile?.bed ? esc(job.profile.bed_label || job.profile.bed) : null)}
    ${pjRow("Profil d'impression", esc(job.profile?.process || ""))}
    ${pjRow("Machine", esc(job.profile?.machine || ""))}
    ${pjRow("Options", opts.length ? esc(opts.join(", ")) : "aucune")}
    ${pjRow("Modèle", job.source ? esc(job.source.split(/[\\/]/).pop()) : null)}
    ${pjRow(job.state === "queued" ? "Ajoutée" : "Découpée", when(job.created))}
    ${pjRow("Lancée", when(job.started))}
    ${pjRow("Fin", when(job.finished))}
  </div>`;
}

function pjTemps(st) {
  const rows = [];
  for (const n of st.nozzles || []) {
    rows.push(pjRow(`Buse T${n.index}${n.active ? " · active" : ""}`, `${Math.round(n.current)} / ${Math.round(n.target)} °C`));
  }
  if (st.bed) rows.push(pjRow("Plateau", `${Math.round(st.bed.current)} / ${Math.round(st.bed.target)} °C`));
  if (st.chamber) rows.push(pjRow("Caisson", `${Math.round(st.chamber.current)} °C`));
  if (st.fan != null) rows.push(pjRow("Ventilateur", `${Math.round(st.fan * 100)} %`));
  if (st.speed_factor != null) rows.push(pjRow("Vitesse", `${Math.round(st.speed_factor * 100)} %`));
  return rows.join("");
}

function pjRenderDetail({ job, live, active }) {
  const box = $("pj-detail");
  const st = live?.status;
  const printerName = live?.printer_name || pjPrinterName(job?.printer_id);
  const name = job?.name || (live ? pjName(live) : "Impression");
  const state = active ? st.state : job.state;
  const queue = pjQueue();
  const qi = job ? queue.findIndex((j) => j.id === job.id) : -1;
  const printerFree = live?.status.online && !PJ_BUSY.includes(live.status.state);
  tbSet("prints", name, PJ_STATE[state] || "");

  let kicker = "", progress = "", actions = "";
  if (active) {
    const pct = Math.round((st.progress || 0) * 100);
    kicker = `${esc(printerName)}`;
    progress = `<div class="pj-progress"><div class="progress"><i style="width:${pct}%"></i></div><b>${pct} %</b></div>
      <div class="pj-times">${st.elapsed_s ? `${esc(fmtDuration(st.elapsed_s))} écoulé` : ""}${
        st.remaining_s ? ` · reste ${esc(fmtDuration(st.remaining_s))} · fin vers ${fmtClock(Date.now() + st.remaining_s * 1000)}` : ""
      }${st.layer ? ` · couche ${st.layer[0]} / ${st.layer[1]}` : ""}</div>`;
    actions =
      (st.state === "paused"
        ? `<button class="btn" data-act="resume">Reprendre</button>`
        : `<button class="btn" data-act="pause">Pause</button>`) +
      `<button class="btn danger" data-act="cancel">Annuler l'impression</button>`;
  } else if (state === "queued") {
    kicker = `${qi + 1}${qi === 0 ? "re" : "e"} position · début ~${fmtClock(pjStartEstimate(job))}`;
    progress = `<label class="pj-for">Pour <select id="pj-printer">${P.list
      .map((p) => `<option value="${esc(p.id)}"${p.id === job.printer_id ? " selected" : ""}>${esc(p.name || p.host)}</option>`)
      .join("")}</select></label>
      <div class="pj-opts">
        <label><input type="checkbox" data-opt="bed_leveling"${job.options.bed_leveling ? " checked" : ""}/> Nivellement</label>
        <label><input type="checkbox" data-opt="flow_calibration"${job.options.flow_calibration ? " checked" : ""}/> Calibration du débit</label>
        <label><input type="checkbox" data-opt="timelapse"${job.options.timelapse ? " checked" : ""}/> Timelapse</label>
      </div>`;
    actions = `<button class="btn primary" data-act="launch"${printerFree ? "" : " disabled"} title="${
      printerFree ? "" : esc(`${printerName} n'est pas libre`)
    }">Lancer maintenant</button>
      <button class="btn" data-act="up"${qi <= 0 ? " disabled" : ""} title="Monter dans la file">↑</button>
      <button class="btn" data-act="down"${qi >= queue.length - 1 ? " disabled" : ""} title="Descendre dans la file">↓</button>
      <button class="btn danger" data-act="remove">Retirer</button>`;
  } else if (state === "printing") {
    // Lancé, mais le suivi de fond n'a pas encore vu l'imprimante démarrer
    // (ou elle ne répond plus).
    kicker = `${esc(printerName)} · ${live?.status.online === false ? "imprimante injoignable" : "démarrage…"}`;
    actions = live?.status.online === false ? `<button class="btn" data-act="remove">Retirer de la liste</button>` : "";
  } else {
    kicker = `${esc(printerName)}${job.finished ? ` · ${dtf.format(new Date(job.finished * 1000))}` : ""}`;
    actions = `<button class="btn primary" data-act="requeue">Remettre en file</button>
      <button class="btn" data-act="remove">Retirer de l'historique</button>`;
  }
  if (job?.file) actions += `<button class="btn" data-act="paths">Voir les trajectoires</button>`;

  const thumb = pjThumb(job, 640);
  box.innerHTML = `
    <div class="pj-hero">
      <div class="pj-thumb">${thumb ? `<img src="${esc(thumb)}" alt="" />` : PJ_PLACEHOLDER}</div>
      <div class="pj-head">
        <div class="pj-kicker">${pjBadge(state)} <span>${kicker}</span></div>
        <h2>${esc(name)}</h2>
        ${progress}
        <div class="pj-actions">${actions}</div>
      </div>
    </div>
    <div class="pj-cols">
      <div>
        <div class="vp-section">Bilan de la découpe</div>
        ${pjSummary(job)}
      </div>
      <div>
        ${
          active
            ? `<div class="vp-section">${esc(printerName)}</div><div class="group">${pjTemps(st)}</div>
               <div class="vp-section">Caméra <button id="pj-cam-toggle" class="btn small">${PJ.cam.on ? "Masquer" : "Afficher"}</button></div>
               <div id="pj-cam" class="pj-cam${PJ.cam.on ? "" : " hidden"}"><img id="pj-cam-img" alt="" /><span id="pj-cam-note"></span></div>`
            : live
              ? `<div class="vp-section">${esc(printerName)}</div><div class="group">${pjRow("État", esc(live.status.online ? PJ_STATE[live.status.state] || "Prête" : "Hors ligne"))}${live.status.online ? pjTemps(live.status) : ""}</div>`
              : ""
        }
        ${live ? `<button class="btn pj-goto" data-act="printer">Voir l'imprimante</button>` : ""}
      </div>
    </div>`;
  box.dataset.printer = live?.printer_id || job?.printer_id || "";
  box.dataset.job = job?.id || "";
  if (active && PJ.cam.on && PJ.cam.id === live.printer_id) {
    // Fiche redessinée : la dernière image, en cache, revient tout de suite ;
    // la suivante est demandée à son chargement.
    pjCamNext(PJ.cam.last);
  }
  else if (!active || PJ.cam.id !== live.printer_id) pjCamStop();
}

/* Le suivi de fond rafraîchit la fiche ; la sélection d'un menu déroulant
   ouvert ne doit pas sauter : on attend qu'il se referme. */
function pjRefreshDetail() {
  if (window.currentView !== "prints") return;
  const a = document.activeElement;
  if (a && a.closest("#pj-detail") && a.tagName === "SELECT") return;
  pjRender();
}

$("pj-detail").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (b) pjAct(b.dataset.act);
  if (e.target.closest("#pj-cam-toggle")) PJ.cam.on ? pjCamStop(true) : pjCamStart();
});
$("pj-detail").addEventListener("change", async (e) => {
  const id = $("pj-detail").dataset.job;
  if (!id) return;
  try {
    if (e.target.id === "pj-printer") {
      await invoke("job_edit", { id, printerId: e.target.value });
    } else if (e.target.dataset.opt) {
      const options = {};
      document.querySelectorAll("#pj-detail [data-opt]").forEach((c) => (options[c.dataset.opt] = c.checked));
      await invoke("job_edit", { id, options });
    }
  } catch (err) {
    toast(String(err), true);
  }
});

async function pjAct(act) {
  const box = $("pj-detail");
  const id = box.dataset.job, printer = box.dataset.printer;
  const job = PJ.jobs.find((j) => j.id === id);
  try {
    if (act === "pause" || act === "resume") {
      await invoke("print_action", { printerId: printer, action: act });
      toast(act === "pause" ? "Mise en pause demandée" : "Reprise demandée");
    } else if (act === "cancel") {
      const ok = await window.__TAURI__.dialog.ask("L'impression en cours sera arrêtée définitivement.", {
        title: "Annuler l'impression ?",
        kind: "warning",
        okLabel: "Annuler l'impression",
        cancelLabel: "Continuer",
      });
      if (ok) {
        await invoke("print_action", { printerId: printer, action: "cancel" });
        toast("Annulation demandée");
      }
    } else if (act === "launch" && job) {
      pjOfferNext({ printer_id: job.printer_id, printer_name: pjPrinterName(job.printer_id), finished: null, next: job }, true);
    } else if (act === "up" || act === "down") {
      await invoke("job_move", { id, delta: act === "up" ? -1 : 1 });
    } else if (act === "remove" && job) {
      const ok = await confirmDelete(
        job.state === "queued" ? "Retirer de la file ?" : "Retirer de l'historique ?",
        `« ${job.name} » et son G-code seront supprimés de Snap Studio.`
      );
      if (ok) {
        await invoke("job_remove", { id });
        PJ.sel = null;
      }
    } else if (act === "requeue" && job) {
      const j = await invoke("job_requeue", { id });
      await pjLoad();
      pjShow("job:" + j.id);
      toast("Remise en file d'attente");
    } else if (act === "paths" && job) {
      openViewer(job.file, job.name, "gcode");
    } else if (act === "printer") {
      P.sel = printer;
      prnRenderDetail();
      switchView("printers");
    }
  } catch (e) {
    toast(String(e), true);
  }
}

/* ------------------------------------------------------------ caméra */

async function pjCamStart() {
  const id = $("pj-detail").dataset.printer;
  if (!id) return;
  pjCamStop();
  Object.assign(PJ.cam, { id, on: true });
  pjRender();
  try {
    await invoke("camera_start", { printerId: id });
  } catch (e) {
    $("pj-cam-note") && ($("pj-cam-note").textContent = String(e));
    return;
  }
  PJ.cam.keep = setInterval(() => invoke("camera_start", { printerId: id }).catch(() => {}), 10000);
  pjCamNext();
}

function pjCamNext(again) {
  const img = $("pj-cam-img");
  if (!PJ.cam.on || !img) return;
  clearTimeout(PJ.cam.timer);
  img.onload = () => {
    PJ.cam.last = img.src;
    $("pj-cam-note").textContent = "";
    PJ.cam.timer = setTimeout(pjCamNext, 250);
  };
  img.onerror = () => {
    $("pj-cam-note").textContent = "image indisponible, nouvel essai…";
    PJ.cam.timer = setTimeout(pjCamNext, 1000);
  };
  img.src = again || `cam://localhost/f?id=${encodeURIComponent(PJ.cam.id)}&n=${++PJ.cam.n}`;
}

function pjCamStop(rerender) {
  clearTimeout(PJ.cam.timer);
  clearInterval(PJ.cam.keep);
  if (PJ.cam.on && PJ.cam.id) invoke("camera_stop", { printerId: PJ.cam.id }).catch(() => {});
  Object.assign(PJ.cam, { id: null, on: false, timer: 0, keep: 0, last: "" });
  if (rerender) pjRender();
}

/* ------------------------------------------------------------ suivante */

/* `manual` : « Lancer maintenant » depuis la fiche, pas une fin d'impression. */
function pjOfferNext(ev, manual = false) {
  // Une proposition déjà affichée (ou un lancement en cours) : la suivante
  // attend son tour, une par imprimante.
  if (PJ.launching || (!$("qmodal").classList.contains("hidden") && PJ.next)) {
    if (!manual) {
      PJ.pending = PJ.pending.filter((p) => p.printer_id !== ev.printer_id);
      PJ.pending.push(ev);
    }
    return;
  }
  PJ.next = ev;
  const j = ev.next;
  const f = ev.finished;
  const done = $("q-done");
  done.classList.toggle("hidden", !f);
  if (f) {
    const verb = { cancelled: "a été annulée", error: "s'est arrêtée sur une erreur" }[f.state] || "est terminée";
    done.innerHTML = `<b>✓ « ${esc(f.name)} » ${esc(verb)}</b><small>sur ${esc(ev.printer_name)}${
      f.started && f.finished ? ` (${esc(fmtDuration(f.finished - f.started))})` : ""
    }</small>`;
  }
  $("q-title").textContent = manual ? `Lancer sur ${ev.printer_name} ?` : "Lancer la prochaine impression ?";
  const thumb = pjThumb(j, 240);
  $("q-thumb").classList.toggle("hidden", !thumb);
  if (thumb) $("q-thumb").src = thumb;
  $("q-name").textContent = j.name;
  const s = j.stats || {};
  $("q-sub").textContent = [s.print_time_s && fmtDuration(s.print_time_s), s.filament_g && `${s.filament_g.toFixed(0)} g`]
    .filter(Boolean)
    .join(" · ");
  $("q-sub2").textContent = [j.profile?.bed && (j.profile.bed_label || j.profile.bed), `sur ${ev.printer_name}`]
    .filter(Boolean)
    .join(" · ");
  $("q-free").checked = false;
  $("q-go").disabled = true;
  $("q-progress").classList.add("hidden");
  $("q-msg").textContent = "";
  $("q-later").disabled = false;
  openSheet($("qmodal"));
}

$("q-free").addEventListener("change", () => ($("q-go").disabled = !$("q-free").checked || PJ.launching));
/* Fenêtre refermée : la proposition suivante, s'il y en a une. */
function pjQueueClosed() {
  PJ.next = null;
  const ev = PJ.pending.shift();
  // Après la fermeture animée de la feuille.
  if (ev) setTimeout(() => pjOfferNext(ev), 250);
}

$("q-later").addEventListener("click", () => {
  if (PJ.launching) return;
  if (PJ.next) invoke("queue_dismiss", { printerId: PJ.next.printer_id }).catch(() => {});
  closeSheet($("qmodal"));
  pjQueueClosed();
});
$("q-go").addEventListener("click", async () => {
  const ev = PJ.next;
  if (!ev || !$("q-free").checked || PJ.launching) return;
  PJ.launching = true;
  $("q-go").disabled = true;
  $("q-later").disabled = true;
  $("q-msg").className = "pf-test busy";
  $("q-msg").textContent = "Préparation de l'imprimante…";
  try {
    await invoke("job_launch", { id: ev.next.id });
    PJ.launching = false;
    closeSheet($("qmodal"));
    toast(`« ${ev.next.name} » lancée sur ${ev.printer_name}`);
    await pjLoad();
    pjShow("job:" + ev.next.id);
    pjQueueClosed();
  } catch (e) {
    PJ.launching = false;
    $("q-later").disabled = false;
    $("q-go").disabled = !$("q-free").checked;
    $("q-progress").classList.add("hidden");
    $("q-msg").className = "pf-test err";
    $("q-msg").textContent = String(e);
  }
});
listen("print-send", (e) => {
  if (!PJ.launching) return;
  const s = e.payload;
  if (s.phase === "check") $("q-msg").textContent = "Vérification de l'imprimante…";
  else if (s.phase === "upload") {
    $("q-progress").classList.remove("hidden");
    $("q-progress").firstElementChild.style.width = Math.max(2, s.percent || 0) + "%";
    $("q-msg").textContent = `Envoi du fichier… ${Math.round(s.percent || 0)} %`;
  } else if (s.phase === "done" && s.message) toast(s.message, true);
});

/* ------------------------------------------------------------ évènements */

listen("prints-status", (e) => {
  PJ.live = e.payload || [];
  pjRenderSide();
  pjRefreshDetail();
});
listen("jobs-changed", pjLoad);
listen("queue-next", (e) => pjOfferNext(e.payload));

tbSet("prints", "Impressions");

(async () => {
  PJ.live = (await invoke("prints_status").catch(() => null)) || [];
  await pjLoad();
  // Écouteurs en place : la question en attente (file non vide sur une
  // imprimante libre au lancement) peut être posée.
  invoke("queue_check").catch(() => {});
})();
