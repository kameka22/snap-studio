"use strict";
/* Printer maintenance: what the printer counts, what is due, what was done.

   The Snapmaker U1 counts each head's tool changes and errors; Moonraker's
   history its hours and jobs (maintenance.rs). Tasks come from Snapmaker's
   maintenance guide and FAQ; what was done is logged in the app with the
   counters at that moment, and "since" counts from there. Read only:
   nothing is written to the printer. */

const MT = { pid: null, usage: null, log: [], err: null, due: new Map(), open: new Set(), histOpen: false };

const MT_GUIDE = "https://wiki.snapmaker.com/en/snapmaker_u1/troubleshooting/Core_Components_Maintenance_Guide";
const MT_VIDEO = "https://www.youtube.com/watch?v=EGfoaHfxalA";

/* Due after `swaps` tool changes (per head), `hours` of printing or
   `months` — whichever comes first. `t`: the video's chapter, in seconds.
   Intervals without an official figure are prudent defaults. `steps`: how
   many `maint.t.<id>.s<n>` texts. */
const MT_TASKS = [
  { id: "contacts", swaps: 100000, t: 549, steps: 3 },
  { id: "docking", swaps: 100000, t: 477, steps: 2 },
  { id: "rails", hours: 500, months: 6, t: 15, steps: 3 },
  { id: "zscrews", hours: 250, months: 3, t: 330, steps: 3 },
  { id: "nozzles", hours: 100, steps: 3 },
  { id: "plate", hours: 50, steps: 3 },
];
const MT_MONTH = 30.44 * 86400;

const mtLast = (log, id) => log.filter((e) => e.task === id).sort((a, b) => b.at - a.at)[0] || null;

/* How far a task is: { ratio, left, unit, last } — the most advanced of
   its counters. Never done: since the printer's start (and for the
   contacts, the count the printer itself reset at its last maintenance). */
function mtProgress(task, usage, log) {
  const last = mtLast(log, task.id);
  const parts = [];
  if (task.swaps) {
    if (!usage.heads.length) return null; // not a U1: no tool change counters
    const since = Math.max(0, ...usage.heads.map((h, i) => h.switch_count - (last ? last.swaps[i] ?? h.last_maintenance_count : h.last_maintenance_count)));
    parts.push({ ratio: since / task.swaps, left: task.swaps - since, unit: "swaps" });
  }
  if (task.hours) {
    const since = Math.max(0, usage.print_hours - (last?.print_hours || 0));
    parts.push({ ratio: since / task.hours, left: Math.round(task.hours - since), unit: "hours" });
  }
  if (task.months && last) {
    const months = (Date.now() / 1000 - last.at) / MT_MONTH;
    parts.push({ ratio: months / task.months, left: Math.round(task.months - months), unit: "months" });
  }
  const worst = parts.reduce((x, y) => (y.ratio > x.ratio ? y : x));
  return { ...worst, last };
}

/* "In 80 h" / "Overdue by 296 h" / "In 98,396 tool changes". */
function mtWhen(pr) {
  const n = fmtNum(Math.abs(pr.left));
  return tr(pr.left < 0 ? `maint.late.${pr.unit}` : `maint.in.${pr.unit}`, { n });
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
  const order = { due: 0, soon: 1, ok: 2 };
  const tasks = MT_TASKS.map((t) => ({ t, pr: mtProgress(t, u, MT.log) }))
    .filter((x) => x.pr)
    .map((x) => ({ ...x, st: mtState(x.pr.ratio) }))
    .sort((a, b) => order[a.st] - order[b.st] || b.pr.ratio - a.pr.ratio);
  const pending = tasks.filter((x) => x.st !== "ok");

  // Summary: what to do, or what comes next.
  const next = tasks.filter((x) => x.st === "ok").sort((a, b) => b.pr.ratio - a.pr.ratio)[0];
  const never = pending.length && !MT.log.length;
  const banner = `<div class="mt-banner ${pending.length ? "" : "ok"}">
      <div class="mt-banner-text"><b>${esc(pending.length ? tr("maint.due_n", { n: pending.length }) : tr("maint.all_ok"))}</b>
      <small>${esc(pending.length ? (never ? tr("maint.never_hint") : tr("maint.others_ok")) : next ? tr("maint.next", { task: tr(`maint.t.${next.t.id}`), when: mtWhen(next.pr).toLowerCase() }) : "")}</small></div>
      ${never ? `<button class="btn small" data-mt-all>${esc(tr("maint.all_done"))}</button>` : ""}
    </div>`;

  const hm = (h) => `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  const strip = [
    [`${fmtNum(Math.round(u.print_hours))} h`, tr("maint.u.hours")],
    [fmtNum(u.jobs), tr("maint.u.jobs")],
    [u.filament_m >= 1000 ? `${fmtDec(u.filament_m / 1000, 2)} km` : `${fmtNum(Math.round(u.filament_m))} m`, tr("maint.u.filament")],
    [hm(u.longest_print_hours), tr("maint.u.longest")],
    u.purifier_hours ? [`${fmtNum(Math.round(u.purifier_hours))} h`, tr("maint.u.purifier")] : null,
  ].filter(Boolean).map(([v, k]) => `<span><b>${esc(v)}</b>${esc(k)}</span>`).join("");

  const rows = tasks.map(({ t, pr, st }) => {
    const open = MT.open.has(t.id);
    const pct = Math.min(100, pr.ratio * 100);
    const note = pr.last ? tr("maint.last", { d: mtDate(pr.last.at) }) : t.hours ? tr("maint.never") : "";
    const steps = Array.from({ length: t.steps }, (_, i) => `<li>${esc(tr(`maint.t.${t.id}.s${i + 1}`))}</li>`).join("");
    const video = t.t ? `<button class="mt-card" data-mt-link="${esc(`${MT_VIDEO}&t=${t.t}s`)}">
        <span class="mt-thumb"><i></i><em>${Math.floor(t.t / 60)}:${String(t.t % 60).padStart(2, "0")}</em></span>
        <span class="mt-card-text"><b>${esc(tr("maint.video"))}</b><small>${esc(tr(`maint.t.${t.id}.video`))}</small></span><span class="mt-ext">↗</span></button>` : "";
    return `<div class="mt-task${open ? " open" : ""}" data-mt-task="${t.id}">
      <div class="mt-row" data-mt-toggle="${t.id}">
        <span class="mt-chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span><span class="mt-dot-st ${st}"></span>
        <span class="mt-name"><b>${esc(tr(`maint.t.${t.id}`))}</b><small class="${st === "ok" ? "" : st}">${esc([mtWhen(pr), note].filter(Boolean).join(" · "))}</small></span>
        <span class="mt-mini ${st}"><i style="width:${pct}%"></i></span>
        ${st === "ok" ? `<span class="mt-done-gap"></span>` : `<button class="btn small primary" data-mt-done="${t.id}">${esc(tr("maint.done"))}</button>`}
      </div>
      <div class="mt-detail">
        <ol class="mt-steps">${steps}</ol>
        <div class="mt-res">${video}
          <button class="mt-card" data-mt-link="${esc(MT_GUIDE)}">
            <span class="mt-doc"><svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6zm8 1.5V8h4.5zM8 12h8v1.5H8zm0 3h8v1.5H8zm0 3h5v1.5H8z"/></svg></span>
            <span class="mt-card-text"><b>${esc(tr("maint.guide"))}</b><small>${esc(tr("maint.guide_sub"))}</small></span><span class="mt-ext">↗</span></button>
        </div>
        ${st === "ok" ? `<button class="btn small mt-note-done" data-mt-done="${t.id}">${esc(tr("maint.mark_done"))}</button>` : ""}
      </div>
    </div>`;
  }).join("");

  const contacts = mtLast(MT.log, "contacts");
  const heads = u.heads.map((h, i) => {
    const base = contacts ? contacts.swaps[i] ?? h.last_maintenance_count : h.last_maintenance_count;
    const since = Math.max(0, h.switch_count - base);
    const pct = (since / 100000) * 100;
    const chip = [h.diameter ? fmtDec(h.diameter, 1) : "", h.nozzle ? tr("maint.nozzle." + h.nozzle) : ""].filter(Boolean).join(" · ");
    const issues = [
      h.error_count ? tr("maint.h.errors_n", { n: h.error_count }) : "",
      h.retry_count ? tr("maint.h.retries_n", { n: h.retry_count }) : "",
    ].filter(Boolean).join(" · ");
    return `<div class="mt-head">
      <div class="mt-head-top"><b>T${h.index}</b>${chip ? `<span class="mt-chip${h.nozzle === "high_flow" ? " hf" : ""}">${esc(chip)}</span>` : ""}</div>
      <div class="mt-big">${fmtNum(h.switch_count)}<small>${esc(tr("maint.h.swaps"))}</small></div>
      <div class="mt-bar"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div class="mt-sub">${esc(tr("maint.h.towards", { p: fmtDec(pct, 1) }))}</div>
      ${issues ? `<div class="mt-hint" title="${esc(tr("maint.h.errors_hint"))}">⚠ ${esc(issues)}${h.error_count ? ` — ${esc(tr("maint.h.clean"))}` : ""}</div>` : ""}
    </div>`;
  }).join("");

  const log = [...MT.log].sort((a, b) => b.at - a.at).map((e) => `<div class="mt-hrow"><span>${esc(tr(`maint.t.${e.task}`))}</span><small>${esc(mtDate(e.at))} · ${esc(tr("maint.at_hours", { n: fmtNum(Math.round(e.print_hours)) }))}</small></div>`).join("");

  box.innerHTML = `${banner}
    <div class="mt-strip">${strip}</div>
    <div class="vp-section">${esc(tr("maint.tasks"))} <span class="mt-info" title="${esc(tr("maint.note"))}">i</span></div>
    <div class="group mt-tasks">${rows}</div>
    ${heads ? `<div class="vp-section">${esc(tr("maint.heads"))}</div><div class="mt-heads">${heads}</div>` : ""}
    <details class="mt-hist"${MT.histOpen ? " open" : ""}><summary>${esc(tr("maint.log_n", { n: MT.log.length }))}</summary>
      <div class="group">${log || `<div class="mt-hrow"><span class="mt-empty">${esc(tr("maint.log.empty"))}</span></div>`}</div></details>`;
  box.querySelector(".mt-hist").addEventListener("toggle", (e) => (MT.histOpen = e.target.open));
}

const mtDate = (at) => new Date(at * 1000).toLocaleDateString(document.documentElement.lang || undefined, { day: "numeric", month: "short", year: "numeric" });

/* Logs tasks as done now; the toast offers to undo. */
async function mtMarkDone(ids) {
  const added = [];
  try {
    for (const task of ids) {
      MT.log = await invoke("maintenance_done", {
        printerId: MT.pid,
        task,
        printHours: MT.usage.print_hours,
        swaps: MT.usage.heads.map((h) => h.switch_count),
      });
      const e = MT.log[MT.log.length - 1];
      added.push({ task: e.task, at: e.at });
    }
  } catch (err) {
    toast(String(err), true);
  }
  mtAfterLog();
  if (!added.length) return;
  const pid = MT.pid;
  const msg = added.length === 1 ? tr("maint.done_toast", { task: tr(`maint.t.${added[0].task}`) }) : tr("maint.done_many", { n: added.length });
  toast(msg, false, {
    label: tr("maint.undo"),
    run: async () => {
      for (const e of added) MT.log = await invoke("maintenance_remove", { printerId: pid, task: e.task, at: e.at }).catch(() => MT.log);
      if (MT.pid === pid) mtAfterLog();
    },
  });
}

function mtAfterLog() {
  MT.due.set(MT.pid, mtDueCount(MT.usage, MT.log));
  mtSideDots();
  mtRender();
}

$("mt-body").addEventListener("click", (e) => {
  const link = e.target.closest("[data-mt-link]");
  if (link) {
    invoke("plugin:opener|open_url", { url: link.dataset.mtLink }).catch((err) => toast(String(err), true));
    return;
  }
  const done = e.target.closest("[data-mt-done]");
  if (done && MT.usage) {
    mtMarkDone([done.dataset.mtDone]);
    return;
  }
  if (e.target.closest("[data-mt-all]") && MT.usage) {
    mtMarkDone(MT_TASKS.filter((t) => {
      const pr = mtProgress(t, MT.usage, MT.log);
      return pr && pr.ratio >= 0.8;
    }).map((t) => t.id));
    return;
  }
  const row = e.target.closest("[data-mt-toggle]");
  if (row) {
    const id = row.dataset.mtToggle;
    MT.open.has(id) ? MT.open.delete(id) : MT.open.add(id);
    row.parentElement.classList.toggle("open");
    row.parentElement.querySelector(".mt-chev");
  }
});
$("mt-refresh").addEventListener("click", () => MT.pid && maintShow(MT.pid));
window.addEventListener("langchange", () => window.currentView === "maint" && mtRender());
setInterval(() => typeof P !== "undefined" && P.list.length && mtCheckAll(), 3600 * 1000);
