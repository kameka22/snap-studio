"use strict";
/* "Prints" view: running, queued, finished.

   Rust keeps the job store (`jobs_list`) and polls the printers in the
   background (`prints-status`). A running print is designated by its printer
   (`live:<id>`): it may come from another tool; a stored job by its id
   (`job:<id>`).

   End of a print with a non-empty queue: Rust emits `queue-next`, a sheet
   offers the next one. Nothing starts without a click, bed cleared. */

const PJ = {
  jobs: [],
  live: [],
  sel: null,
  cam: { id: null, on: false, n: 0, timer: 0, keep: 0 },
  /* "Start the next one?" sheet: job offered, launch in progress. */
  next: null,
  launching: false,
  /* Offers that arrived while another one was shown. */
  pending: [],
};

const PJ_BUSY = ["printing", "paused"];
const PJ_STATES = ["printing", "paused", "queued", "complete", "finished", "cancelled", "error"];
const pjState = (s) => (PJ_STATES.includes(s) ? tr("prints.state." + s) : s);

/* ------------------------------------------------------------ data */

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
const pjPrinterName = (id) => pjLiveOf(id)?.printer_name || P.list.find((p) => p.id === id)?.name || tr("slice.printer");

/* Snap Studio job behind a running print, if there is one. */
function pjJobOfLive(live) {
  const mine = PJ.jobs.filter((j) => j.printer_id === live.printer_id && j.state === "printing");
  return mine.find((j) => j.remote === live.status.job) || mine[mine.length - 1] || null;
}

const pjThumb = (job, px = 320) =>
  job?.file ? thumbSrc(job.file, px, 0, job.created) : "";

const pjName = (live) => (live.status.job || tr("prints.print")).replace(/\.gcode$/i, "");

/* Estimated start time of a queued job, from what comes before it. */
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

/* ------------------------------------------------------------ sidebar */

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
      <span class="count">${paused ? esc(tr("prints.pause_short")) : Math.round((l.status.progress || 0) * 100) + " %"}</span></button>`);
  }
  pjQueue().forEach((j, i) => {
    items.push(`<button class="side-item" data-pj="job:${esc(j.id)}" title="${esc(pjState("queued"))} · ${esc(pjPrinterName(j.printer_id))}">
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

/* ------------------------------------------------------------ view */

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
  $("pj-back").classList.toggle("hidden", !detail);
  if (!detail) {
    PJ.sel = null;
    pjCamStop();
    pjRenderOverview();
    tbSet("prints", tr("nav.prints"), pjSubtitle());
    return;
  }
  pjRenderDetail(detail);
}

function pjSubtitle() {
  const a = pjActive().length, q = pjQueue().length;
  return [a && tr("prints.n_running", { n: a }), q && tr("prints.n_queued", { n: q })].filter(Boolean).join(" · ");
}

/* What a key designates: a running print, or a stored job. */
function pjResolve(key) {
  if (key.startsWith("live:")) {
    const live = pjLiveOf(key.slice(5));
    if (!live || !PJ_BUSY.includes(live.status.state)) {
      // The print has finished since: switch to its history record.
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
const pjBadge = (state) => `<span class="pj-badge ${esc(state)}">${esc(pjState(state))}</span>`;

function pjRenderOverview() {
  const box = $("pj-overview");
  const active = pjActive(), queue = pjQueue(), done = pjDone();
  const html = [];
  if (active.length) {
    html.push(`<div class="vp-section">${esc(tr("prints.running"))}</div><div class="pj-cards">`);
    for (const l of active) {
      const job = pjJobOfLive(l);
      const st = l.status;
      const bar = `<span class="pj-mini-bar"><i style="width:${Math.round((st.progress || 0) * 100)}%"></i></span>`;
      html.push(
        pjCard(`live:${l.printer_id}`, pjThumb(job), job?.name || pjName(l),
          `${esc(l.printer_name)} · ${Math.round((st.progress || 0) * 100)} %${st.remaining_s ? ` · ${esc(tr("prints.ends_at", { time: fmtClock(Date.now() + st.remaining_s * 1000) }))}` : ""}`,
          pjBadge(st.state), bar)
      );
    }
    html.push("</div>");
  }
  if (queue.length) {
    html.push(`<div class="vp-section">${esc(pjState("queued"))}</div><div class="pj-cards">`);
    queue.forEach((j, i) => {
      html.push(
        pjCard(`job:${j.id}`, pjThumb(j), `${i + 1}. ${j.name}`,
          `${esc(pjPrinterName(j.printer_id))}${j.stats?.print_time_s ? ` · ${fmtDuration(j.stats.print_time_s)}` : ""} · ${esc(tr("prints.starts_at", { time: fmtClock(pjStartEstimate(j)) }))}`,
          pjBadge("queued"))
      );
    });
    html.push("</div>");
  }
  if (done.length) {
    html.push(`<div class="vp-section">${esc(tr("prints.finished"))}</div><div class="pj-cards">`);
    for (const j of done) {
      html.push(
        pjCard(`job:${j.id}`, pjThumb(j), j.name,
          `${esc(pjPrinterName(j.printer_id))}${j.finished ? ` · ${fmtDate(j.finished)}` : ""}`,
          pjBadge(j.state))
      );
    }
    html.push("</div>");
  }
  box.innerHTML = html.length
    ? html.join("")
    : `<div class="empty"><div class="empty-art">${PJ_PLACEHOLDER}</div><h1>${esc(tr("prints.empty.title"))}</h1>
       <p>${esc(tr("prints.empty.text"))}</p></div>`;
}

$("pj-overview").addEventListener("click", (e) => {
  const c = e.target.closest("[data-key]");
  if (c) pjShow(c.dataset.key);
});

/* ------------------------------------------------------------ record */

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
      <span>${esc(names[t] || names[0] || "")}</span><em>${g != null ? `${fmtDec(g, 1)} g` : ""}</em></div>`;
  });
  return rows.length ? `<div class="grow-row pj-fils"><span class="k">${esc(tr("files.col.weight"))}</span><div>${rows.join("")}</div></div>` : "";
}

function pjSummary(job) {
  if (!job) {
    return `<div class="group"><div class="grow-row"><span class="k pj-muted">${esc(tr("prints.foreign"))}</span></div></div>`;
  }
  const s = job.stats || {};
  const o = job.options || {};
  const opts = [o.bed_leveling && tr("prints.opt.leveling"), o.flow_calibration && tr("prints.opt.flow"), o.timelapse && tr("prints.opt.timelapse")].filter(Boolean);
  const when = (t) => (t ? esc(fmtDate(t)) : null);
  return `<div class="group">
    ${pjRow(tr("viewer.est_time"), s.print_time_s ? esc(fmtDuration(s.print_time_s)) : null)}
    ${pjRow(tr("prints.layers"), s.layers ? String(s.layers) : null)}
    ${pjFilamentRows(job)}
    ${pjRow(tr("prints.total"), s.filament_g ? `${fmtDec(s.filament_g, 1)} g${s.cost ? ` · ${fmtDec(s.cost, 2)} €` : ""}` : null)}
    ${pjRow(tr("slice.plate"), job.profile?.bed ? esc(job.profile.bed_label || job.profile.bed) : null)}
    ${pjRow(tr("prints.process"), esc(job.profile?.process || ""))}
    ${pjRow(tr("prints.machine"), esc(job.profile?.machine || ""))}
    ${pjRow(tr("prints.options"), esc(opts.length ? opts.join(", ") : tr("prints.options.none")))}
    ${pjRow(tr("printers.form.model"), job.source ? esc(job.source.split(/[\\/]/).pop()) : null)}
    ${pjRow(tr(job.state === "queued" ? "prints.added_at" : "prints.sliced_at"), when(job.created))}
    ${pjRow(tr("prints.started_at"), when(job.started))}
    ${pjRow(tr("prints.finished_at"), when(job.finished))}
  </div>`;
}

function pjTemps(st) {
  const rows = [];
  for (const n of st.nozzles || []) {
    rows.push(pjRow(tr("printers.nozzle", { i: n.index }) + (n.active ? " · " + tr("prints.active") : ""), `${Math.round(n.current)} / ${Math.round(n.target)} °C`));
  }
  if (st.bed) rows.push(pjRow(tr("slice.plate"), `${Math.round(st.bed.current)} / ${Math.round(st.bed.target)} °C`));
  if (st.chamber) rows.push(pjRow(tr("printers.chamber"), `${Math.round(st.chamber.current)} °C`));
  if (st.fan != null) rows.push(pjRow(tr("printers.fan"), `${Math.round(st.fan * 100)} %`));
  if (st.speed_factor != null) rows.push(pjRow(tr("printers.speed"), `${Math.round(st.speed_factor * 100)} %`));
  return rows.join("");
}

function pjRenderDetail({ job, live, active }) {
  const box = $("pj-detail");
  const st = live?.status;
  const printerName = live?.printer_name || pjPrinterName(job?.printer_id);
  const name = job?.name || (live ? pjName(live) : tr("prints.print"));
  const state = active ? st.state : job.state;
  const queue = pjQueue();
  const qi = job ? queue.findIndex((j) => j.id === job.id) : -1;
  const printerFree = live?.status.online && !PJ_BUSY.includes(live.status.state);
  tbSet("prints", name, PJ_STATES.includes(state) ? pjState(state) : "");

  let kicker = "", progress = "", actions = "";
  if (active) {
    const pct = Math.round((st.progress || 0) * 100);
    kicker = `${esc(printerName)}`;
    progress = `<div class="pj-progress"><div class="progress"><i style="width:${pct}%"></i></div><b>${pct} %</b></div>
      <div class="pj-times">${st.elapsed_s ? esc(tr("prints.elapsed", { t: fmtDuration(st.elapsed_s) })) : ""}${
        st.remaining_s ? ` · ${esc(tr("prints.left", { t: fmtDuration(st.remaining_s) }))} · ${esc(tr("prints.ends_at", { time: fmtClock(Date.now() + st.remaining_s * 1000) }))}` : ""
      }${st.layer ? ` · ${esc(tr("prints.layer_of", { a: st.layer[0], b: st.layer[1] }))}` : ""}</div>`;
    actions =
      (st.state === "paused"
        ? `<button class="btn" data-act="resume">${esc(tr("prints.resume"))}</button>`
        : `<button class="btn" data-act="pause">${esc(tr("prints.pause"))}</button>`) +
      `<button class="btn danger" data-act="cancel">${esc(tr("prints.cancel"))}</button>`;
  } else if (state === "queued") {
    kicker = esc(`${tr("prints.position", { n: qi + 1 })} · ${tr("prints.starts_at", { time: fmtClock(pjStartEstimate(job)) })}`);
    progress = `<label class="pj-for">${esc(tr("prints.for"))} <select id="pj-printer">${P.list
      .map((p) => `<option value="${esc(p.id)}"${p.id === job.printer_id ? " selected" : ""}>${esc(p.name || p.host)}</option>`)
      .join("")}</select></label>
      <div class="pj-opts">
        <label><input type="checkbox" data-opt="bed_leveling"${job.options.bed_leveling ? " checked" : ""}/> ${esc(tr("prints.opt.leveling_cap"))}</label>
        <label><input type="checkbox" data-opt="flow_calibration"${job.options.flow_calibration ? " checked" : ""}/> ${esc(tr("prints.opt.flow_cap"))}</label>
        <label><input type="checkbox" data-opt="timelapse"${job.options.timelapse ? " checked" : ""}/> ${esc(tr("prints.opt.timelapse_cap"))}</label>
      </div>`;
    actions = `<button class="btn primary" data-act="launch"${printerFree ? "" : " disabled"} title="${
      printerFree ? "" : esc(tr("prints.not_free", { name: printerName }))
    }">${esc(tr("prints.launch_now"))}</button>
      <button class="btn" data-act="up"${qi <= 0 ? " disabled" : ""} title="${esc(tr("prints.move_up"))}">↑</button>
      <button class="btn" data-act="down"${qi >= queue.length - 1 ? " disabled" : ""} title="${esc(tr("prints.move_down"))}">↓</button>
      <button class="btn danger" data-act="remove">${esc(tr("prints.remove"))}</button>`;
  } else if (state === "printing") {
    // Launched, but the background tracking has not yet seen the printer
    // start (or it no longer answers).
    kicker = `${esc(printerName)} · ${esc(tr(live?.status.online === false ? "prints.unreachable" : "printers.cam.starting"))}`;
    actions = live?.status.online === false ? `<button class="btn danger" data-act="remove">${esc(tr("prints.remove_list"))}</button>` : "";
  } else {
    kicker = `${esc(printerName)}${job.finished ? ` · ${fmtDate(job.finished)}` : ""}`;
    actions = `<button class="btn primary" data-act="requeue">${esc(tr("prints.requeue"))}</button>
      <button class="btn danger" data-act="remove">${esc(tr("prints.remove_history"))}</button>`;
  }
  // Before the destructive button, which always comes last.
  if (job?.file) {
    const paths = `<button class="btn" data-act="paths">${esc(tr("files.view_paths"))}</button>`;
    const i = actions.lastIndexOf('<button class="btn danger"');
    actions = i < 0 ? actions + paths : actions.slice(0, i) + paths + actions.slice(i);
  }

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
        <div class="vp-section">${esc(tr("prints.summary"))}</div>
        ${pjSummary(job)}
      </div>
      <div>
        ${
          active
            ? `<div class="vp-section">${esc(printerName)}</div><div class="group">${pjTemps(st)}</div>
               <div class="vp-section">${esc(tr("printers.camera"))} <button id="pj-cam-toggle" class="btn small">${esc(tr(PJ.cam.on ? "common.hide" : "common.show"))}</button></div>
               <div id="pj-cam" class="pj-cam${PJ.cam.on ? "" : " hidden"}"><img id="pj-cam-img" alt="" /><span id="pj-cam-note"></span></div>`
            : live
              ? `<div class="vp-section">${esc(printerName)}</div><div class="group">${pjRow(tr("prints.status"), esc(live.status.online ? (PJ_STATES.includes(live.status.state) ? pjState(live.status.state) : tr("printers.state.ready")) : tr("printers.state.offline")))}${live.status.online ? pjTemps(live.status) : ""}</div>`
              : ""
        }
        ${live ? `<button class="btn pj-goto" data-act="printer">${esc(tr("prints.goto_printer"))}</button>` : ""}
      </div>
    </div>`;
  box.dataset.printer = live?.printer_id || job?.printer_id || "";
  box.dataset.job = job?.id || "";
  if (active && PJ.cam.on && PJ.cam.id === live.printer_id) {
    // Record redrawn: the last image, cached, comes back at once; the next
    // one is requested when it loads.
    pjCamNext(PJ.cam.last);
  }
  else if (!active || PJ.cam.id !== live.printer_id) pjCamStop();
}

/* Background tracking refreshes the record; an open drop-down's selection
   must not jump: wait until it closes. */
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
      toast(tr(act === "pause" ? "prints.pause_requested" : "prints.resume_requested"));
    } else if (act === "cancel") {
      const ok = await window.__TAURI__.dialog.ask(tr("prints.cancel.text"), {
        title: tr("prints.cancel.title"),
        kind: "warning",
        okLabel: tr("prints.cancel"),
        cancelLabel: tr("common.continue"),
      });
      if (ok) {
        await invoke("print_action", { printerId: printer, action: "cancel" });
        toast(tr("prints.cancel_requested"));
      }
    } else if (act === "launch" && job) {
      pjOfferNext({ printer_id: job.printer_id, printer_name: pjPrinterName(job.printer_id), finished: null, next: job }, true);
    } else if (act === "up" || act === "down") {
      await invoke("job_move", { id, delta: act === "up" ? -1 : 1 });
    } else if (act === "remove" && job) {
      const ok = await confirmDelete(
        tr(job.state === "queued" ? "prints.remove.queue" : "prints.remove.history"),
        tr("prints.remove.text", { name: job.name }),
        tr("prints.remove")
      );
      if (ok) {
        await invoke("job_remove", { id });
        PJ.sel = null;
      }
    } else if (act === "requeue" && job) {
      const j = await invoke("job_requeue", { id });
      await pjLoad();
      pjShow("job:" + j.id);
      toast(tr("prints.requeued"));
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

/* ------------------------------------------------------------ camera */

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
    $("pj-cam-note").textContent = tr("printers.cam.retry");
    PJ.cam.timer = setTimeout(pjCamNext, 1000);
  };
  img.src = again || schemeUrl("cam", `/f?id=${encodeURIComponent(PJ.cam.id)}&n=${++PJ.cam.n}`);
}

function pjCamStop(rerender) {
  clearTimeout(PJ.cam.timer);
  clearInterval(PJ.cam.keep);
  if (PJ.cam.on && PJ.cam.id) invoke("camera_stop", { printerId: PJ.cam.id }).catch(() => {});
  Object.assign(PJ.cam, { id: null, on: false, timer: 0, keep: 0, last: "" });
  if (rerender) pjRender();
}

/* ------------------------------------------------------------ next */

/* `manual`: "Start Now" from the record, not the end of a print. */
function pjOfferNext(ev, manual = false) {
  // An offer already shown (or a launch in progress): the next one waits
  // its turn, one per printer.
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
    const key = { cancelled: "queue.done.cancelled", error: "queue.done.error" }[f.state] || "queue.done.ok";
    done.innerHTML = `<b>✓ ${esc(tr(key, { name: f.name }))}</b><small>${esc(tr("queue.on", { name: ev.printer_name }))}${
      f.started && f.finished ? ` (${esc(fmtDuration(f.finished - f.started))})` : ""
    }</small>`;
  }
  $("q-title").textContent = manual ? tr("queue.title_on", { name: ev.printer_name }) : tr("queue.title");
  const thumb = pjThumb(j, 240);
  $("q-thumb").classList.toggle("hidden", !thumb);
  if (thumb) $("q-thumb").src = thumb;
  $("q-name").textContent = j.name;
  const s = j.stats || {};
  $("q-sub").textContent = [s.print_time_s && fmtDuration(s.print_time_s), s.filament_g && `${s.filament_g.toFixed(0)} g`]
    .filter(Boolean)
    .join(" · ");
  $("q-sub2").textContent = [j.profile?.bed && (j.profile.bed_label || j.profile.bed), tr("queue.on", { name: ev.printer_name })]
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
/* Sheet closed: the next offer, if any. */
function pjQueueClosed() {
  PJ.next = null;
  const ev = PJ.pending.shift();
  // After the sheet's closing animation.
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
  if (!ev || !$("q-free").checked || PJ.launching || PJ.checking) return;
  // Spools loaded now against those of the slice.
  const j = ev.next;
  const pid = j.printer_id || ev.printer_id;
  PJ.checking = true;
  let ok, slots;
  try {
    slots = await headsRefreshSlots(pid);
    // Back to Prepare: only for jobs that kept their plate; an older record
    // has nothing to slice again.
    ok = await spoolCheck({ pid, tools: j.tools, profile: j.profile || {}, stats: j.stats || {}, slots, canEdit: !!j.profile?.plate?.length });
  } finally {
    PJ.checking = false;
  }
  if (!ok || PJ.next !== ev) return;
  if (ok.edit) return pjEditInPrepare(ev);
  PJ.launching = true;
  $("q-go").disabled = true;
  $("q-later").disabled = true;
  $("q-msg").className = "pf-test busy";
  $("q-msg").textContent = tr("send.preparing");
  try {
    await invoke("job_launch", { id: ev.next.id, map: ok.map });
    PJ.launching = false;
    closeSheet($("qmodal"));
    toast(tr("queue.launched", { name: ev.next.name, printer: ev.printer_name }));
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
/* Spool check's "Edit in Prepare" for a queued print: its plate replaces
   Prepare's (asked first when the plate holds other objects), and the Slice
   sheet opens on its printer, spools read again. Once the new slice is sent,
   the queued print is removed. */
async function pjEditInPrepare(ev) {
  const j = ev.next;
  if (PR.objects.length) {
    const ok = await confirmDelete(tr("spool.replace.title"), tr("spool.replace.text"), tr("spool.replace.ok"));
    if (!ok) return;
  }
  // As "Later": not offered again until the printer finishes another print.
  invoke("queue_dismiss", { printerId: ev.printer_id }).catch(() => {});
  closeSheet($("qmodal"));
  pjQueueClosed();
  switchView("prepare");
  await prLoadPlate(j.profile.plate);
  rememberPrinter(j.printer_id || ev.printer_id);
  openSlice({ replaces: j.id });
}

listen("print-send", (e) => {
  if (!PJ.launching) return;
  const s = e.payload;
  if (s.phase === "check") $("q-msg").textContent = tr("send.checking");
  else if (s.phase === "upload") {
    $("q-progress").classList.remove("hidden");
    $("q-progress").firstElementChild.style.width = Math.max(2, s.percent || 0) + "%";
    $("q-msg").textContent = tr("send.uploading", { p: Math.round(s.percent || 0) });
  } else if (s.phase === "done" && s.message) toast(s.message, true);
});

/* ------------------------------------------------------------ events */

listen("prints-status", (e) => {
  PJ.live = e.payload || [];
  pjRenderSide();
  pjRefreshDetail();
});
listen("jobs-changed", pjLoad);
listen("queue-next", (e) => pjOfferNext(e.payload));

tbSet("prints", tr("nav.prints"));
window.addEventListener("langchange", () => {
  pjRenderSide();
  if (window.currentView === "prints") pjRender();
  else tbSet("prints", tr("nav.prints"), pjSubtitle());
});

(async () => {
  PJ.live = (await invoke("prints_status").catch(() => null)) || [];
  await pjLoad();
  // Listeners in place: the pending question (non-empty queue on a printer
  // free at launch) can be asked.
  invoke("queue_check").catch(() => {});
})();

/* Back to every print: the toolbar's arrow, or Esc when nothing else
   (sheet, field) takes it. */
$("pj-back").addEventListener("click", () => pjShow(null));
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || window.currentView !== "prints" || !PJ.sel) return;
  if (document.querySelector(".modal:not(.hidden)") || e.target.closest?.("input, textarea, select")) return;
  pjShow(null);
});
