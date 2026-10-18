"use strict";
/* Printer maintenance: what the printer counts, what is due, what was done.

   The Snapmaker U1 counts each head's tool changes and errors; Moonraker's
   history its hours and jobs (maintenance.rs). Tasks come from Snapmaker's
   maintenance guide and FAQ; what was done is logged in the app with the
   counters at that moment, and "since" counts from there. Read only:
   nothing is written to the printer. */

const MT = { pid: null, usage: null, log: [], err: null, due: new Map() };

const MT_GUIDE = "https://wiki.snapmaker.com/en/snapmaker_u1/troubleshooting/Core_Components_Maintenance_Guide";
const MT_VIDEO = "https://www.youtube.com/watch?v=EGfoaHfxalA";

/* Due after `swaps` tool changes (per head), `hours` of printing or
   `months` — whichever comes first. `t`: the video's chapter, in seconds.
   Intervals without an official figure are prudent defaults. */
const MT_TASKS = [
  { id: "contacts", swaps: 100000, t: 549 },
  { id: "docking", swaps: 100000, t: 477 },
  { id: "rails", hours: 500, months: 6, t: 15 },
  { id: "zscrews", hours: 250, months: 3, t: 330 },
  { id: "nozzles", hours: 100 },
  { id: "plate", hours: 50 },
];
const MT_MONTH = 30.44 * 86400;

const mtLast = (log, id) => log.filter((e) => e.task === id).sort((a, b) => b.at - a.at)[0] || null;

/* How far a task is: { ratio, text, last }. Never done: since the
   printer's start (and for the contacts, the count the printer itself
   reset at its last maintenance). */
function mtProgress(task, usage, log) {
  const last = mtLast(log, task.id);
  const parts = [];
  if (task.swaps) {
    if (!usage.heads.length) return null; // not a U1: no tool change counters
    const since = Math.max(...usage.heads.map((h, i) => h.switch_count - (last ? last.swaps[i] ?? h.last_maintenance_count : h.last_maintenance_count)));
    parts.push({ ratio: Math.max(0, since) / task.swaps, text: tr("maint.since.swaps", { n: fmtNum(Math.max(0, since)), max: fmtNum(task.swaps) }) });
  }
  if (task.hours) {
    const since = Math.max(0, usage.print_hours - (last?.print_hours || 0));
    parts.push({ ratio: since / task.hours, text: tr("maint.since.hours", { n: fmtNum(Math.round(since)), max: fmtNum(task.hours) }) });
  }
  if (task.months && last) {
    const months = (Date.now() / 1000 - last.at) / MT_MONTH;
    parts.push({ ratio: months / task.months, text: tr("maint.since.months", { n: fmtNum(Math.floor(months)), max: task.months }) });
  }
  const worst = parts.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  return { ratio: worst.ratio, text: worst.text, last };
}

const mtState = (ratio) => (ratio >= 1 ? "due" : ratio >= 0.8 ? "soon" : "ok");

/* Tasks due on a printer, for the sidebar's dot. */
function mtDueCount(usage, log) {
  return MT_TASKS.map((t) => mtProgress(t, usage, log)).filter((p) => p && p.ratio >= 1).length;
}

async function mtLoad(pid) {
  const p = P.list.find((x) => x.id === pid);
  if (!p) return null;
  const [usage, log] = await Promise.all([
    invoke("printer_maintenance", { host: p.host, port: p.port }),
    invoke("maintenance_log", { printerId: pid }).catch(() => []),
  ]);
  MT.due.set(pid, mtDueCount(usage, log));
  mtSideDots();
  return { usage, log };
}

/* Every printer's due tasks, quietly: at launch, then hourly. */
async function mtCheckAll() {
  await Promise.all(P.list.map((p) => mtLoad(p.id).catch(() => null)));
}

function mtSideDots() {
  document.querySelectorAll("#side-printers [data-maint]").forEach((b) => {
    const n = MT.due.get(b.dataset.maint) || 0;
    b.querySelector(".mt-dot")?.classList.toggle("hidden", !n);
    b.title = n ? tr("maint.due_n", { n }) : "";
  });
}

async function maintShow(pid) {
  MT.pid = pid;
  P.sel = pid;
  switchView("maint");
  MT.err = null;
  mtRender();
  try {
    const r = await mtLoad(pid);
    if (MT.pid !== pid || !r) return;
    MT.usage = r.usage;
    MT.log = r.log;
  } catch (e) {
    MT.err = String(e);
  }
  mtRender();
}

function mtRender() {
  const p = P.list.find((x) => x.id === MT.pid);
  if (!p) return;
  tbSet("maint", tr("maint.title"), p.name || p.host);
  const box = $("mt-body");
  if (MT.err) {
    box.innerHTML = `<p class="hv-note">${esc(tr("maint.unreachable"))}</p><p class="mt-err">${esc(MT.err)}</p>`;
    return;
  }
  const u = MT.usage;
  if (!u) {
    box.innerHTML = `<p class="hv-note">${esc(tr("maint.loading"))}</p>`;
    return;
  }
  const hm = (h) => `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  const tiles = [
    [tr("maint.u.hours"), `${fmtNum(Math.round(u.print_hours))} h`],
    [tr("maint.u.jobs"), fmtNum(u.jobs)],
    [tr("maint.u.filament"), u.filament_m >= 1000 ? `${fmtDec(u.filament_m / 1000, 2)} km` : `${fmtNum(Math.round(u.filament_m))} m`],
    [tr("maint.u.longest"), hm(u.longest_print_hours)],
    u.purifier_hours ? [tr("maint.u.purifier"), `${fmtNum(Math.round(u.purifier_hours))} h`] : null,
  ].filter(Boolean);

  const contacts = mtLast(MT.log, "contacts");
  const heads = u.heads.map((h, i) => {
    const base = contacts ? contacts.swaps[i] ?? h.last_maintenance_count : h.last_maintenance_count;
    const since = Math.max(0, h.switch_count - base);
    const pct = Math.min(100, (since / 100000) * 100);
    const nozzle = [h.diameter ? `${fmtDec(h.diameter, 1)} mm` : "", h.nozzle ? tr("maint.nozzle." + h.nozzle) : ""].filter(Boolean).join(" · ");
    return `<div class="mt-head">
      <div class="mt-head-top"><b>T${h.index}</b><span>${esc(nozzle)}</span></div>
      <div class="mt-k">${esc(tr("maint.h.swaps"))}<b>${fmtNum(h.switch_count)}</b></div>
      <div class="mt-bar"><i style="width:${pct}%"></i></div>
      <div class="mt-sub">${esc(tr("maint.h.since", { n: fmtNum(since) }))}</div>
      <div class="mt-k">${esc(tr("maint.h.errors"))}<b class="${h.error_count ? "warn" : ""}">${fmtNum(h.error_count)}</b></div>
      <div class="mt-k">${esc(tr("maint.h.retries"))}<b>${fmtNum(h.retry_count)}</b></div>
      ${h.error_count ? `<div class="mt-hint">${esc(tr("maint.h.errors_hint"))}</div>` : ""}
    </div>`;
  }).join("");

  const tasks = MT_TASKS.map((t) => {
    const pr = mtProgress(t, u, MT.log);
    if (!pr) return "";
    const st = mtState(pr.ratio);
    const when = pr.last ? tr("maint.last", { d: mtDate(pr.last.at) }) : tr("maint.never");
    return `<div class="mt-task">
      <div class="mt-task-main">
        <b>${esc(tr(`maint.t.${t.id}`))}</b>
        <small>${esc(tr(`maint.t.${t.id}.how`))}</small>
        <small class="mt-when">${esc(when)} · ${esc(pr.text)}</small>
      </div>
      <span class="mt-pill ${st}">${esc(tr("maint.state." + st))}</span>
      <span class="mt-acts">
        <button class="btn small" data-mt-link="${esc(MT_GUIDE)}">${esc(tr("maint.guide"))}</button>
        ${t.t ? `<button class="btn small" data-mt-link="${esc(`${MT_VIDEO}&t=${t.t}s`)}">${esc(tr("maint.video"))}</button>` : ""}
        <button class="btn small primary" data-mt-done="${t.id}">${esc(tr("maint.done"))}</button>
      </span>
    </div>`;
  }).join("");

  const log = [...MT.log].sort((a, b) => b.at - a.at).map((e) => `<div class="grow-row mt-log">
      <span class="k">${esc(tr(`maint.t.${e.task}`))}<span class="sub">${esc(mtDate(e.at))} · ${esc(tr("maint.at_hours", { n: fmtNum(Math.round(e.print_hours)) }))}</span></span>
      <button class="btn small" data-mt-undo="${esc(e.task)}" data-at="${e.at}" title="${esc(tr("maint.undo"))}">${esc(tr("maint.undo"))}</button>
    </div>`).join("");

  box.innerHTML = `
    <div class="vp-section">${esc(tr("maint.usage"))}</div>
    <div class="mt-tiles">${tiles.map(([k, v]) => `<div class="mt-tile"><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join("")}</div>
    ${heads ? `<div class="vp-section">${esc(tr("maint.heads"))}</div><div class="mt-heads">${heads}</div>` : ""}
    <div class="vp-section">${esc(tr("maint.tasks"))}</div>
    <div class="group mt-tasks">${tasks}</div>
    <p class="hv-note mt-note">${esc(tr("maint.note"))}</p>
    <div class="vp-section">${esc(tr("maint.log"))}</div>
    <div class="group">${log || `<div class="grow-row"><span class="k mt-empty">${esc(tr("maint.log.empty"))}</span></div>`}</div>`;
}

const mtDate = (at) => new Date(at * 1000).toLocaleDateString(document.documentElement.lang || undefined, { day: "numeric", month: "short", year: "numeric" });

$("mt-body").addEventListener("click", async (e) => {
  const link = e.target.closest("[data-mt-link]");
  if (link) {
    invoke("plugin:opener|open_url", { url: link.dataset.mtLink }).catch((err) => toast(String(err), true));
    return;
  }
  const done = e.target.closest("[data-mt-done]");
  if (done && MT.usage) {
    try {
      MT.log = await invoke("maintenance_done", {
        printerId: MT.pid,
        task: done.dataset.mtDone,
        printHours: MT.usage.print_hours,
        swaps: MT.usage.heads.map((h) => h.switch_count),
      });
      MT.due.set(MT.pid, mtDueCount(MT.usage, MT.log));
      mtSideDots();
      mtRender();
      toast(tr("maint.done_toast", { task: tr(`maint.t.${done.dataset.mtDone}`) }));
    } catch (err) {
      toast(String(err), true);
    }
    return;
  }
  const undo = e.target.closest("[data-mt-undo]");
  if (undo) {
    MT.log = await invoke("maintenance_remove", { printerId: MT.pid, task: undo.dataset.mtUndo, at: +undo.dataset.at }).catch((err) => (toast(String(err), true), MT.log));
    MT.due.set(MT.pid, mtDueCount(MT.usage, MT.log));
    mtSideDots();
    mtRender();
  }
});
$("mt-refresh").addEventListener("click", () => MT.pid && maintShow(MT.pid));
window.addEventListener("langchange", () => window.currentView === "maint" && mtRender());
setInterval(() => typeof P !== "undefined" && P.list.length && mtCheckAll(), 3600 * 1000);
