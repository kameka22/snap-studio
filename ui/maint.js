"use strict";
/* Printer care & tuning: the page and its tabs. Control (control.js) and
   Bed Leveling (bedmesh.js) are the app's; Care is a built-in plugin
   (ui/plugins/care), and plugins may add tabs here (plugins.js);
   Calibration waits for #17.

   The page draws the badges: the ⚠ of a tab that asks for something, and
   the dot on the printer in the side list (the sum of what its badges
   count). The bed's comes from bedmesh.js; the plugins' through `ctx`. */

const MT = { pid: null, tab: "care", ctx: {}, loading: false, reload: false };

/* The page's own tabs; plugin tabs join them (plgTabs). */
const MT_OWN_TABS = ["control", "level"];
const mtTabs = () => [...MT_OWN_TABS, ...(typeof plgTabs === "function" ? plgTabs("maint").map((t) => t.decl.id) : [])];
/* Care when it is there, as before plugins; otherwise Control. */
const mtDefaultTab = () => (mtTabs().includes("care") ? "care" : "control");

/* The last tab open, per printer. */
const mtTabKey = (pid) => `snapstudio.mtab.${pid}`;
const mtTabOf = (pid) => {
  const t = localStorage.getItem(mtTabKey(pid));
  return mtTabs().includes(t) ? t : mtDefaultTab();
};

/* ------------------------------------------------------------ the bed */

/* What the bed asks (out of tolerance, or a measurement due), or null. */
const mtBedDue = (pid) => (typeof bmDueOf === "function" ? bmDueOf(pid) : null);

/* The bed's badge, on its tab: Care lists the bed among its tasks, so
   Care's own count (on the printer's dot) includes it. */
function mtBedBadge(pid) {
  const due = mtBedDue(pid);
  const tip = due ? tr(due.kind === "out" ? "bm.alert_tab" : "bm.due_tab") : "";
  appBadge("bed", pid, due ? { n: 1, tip } : null, ["tab"], "level");
}

/* The bed as plugins read it (ctx.printer.bed): what it asks, and the
   measurements stored, with their deviation and status. Copies. */
function mtBedInfo(pid) {
  const st = bmSettingsOf(pid);
  const due = mtBedDue(pid);
  const meshes = (BM.hist.get(pid) || []).map((m) => {
    const dev = bmlStats(m)?.dev ?? 0;
    return { at: m.at, dev, status: bmlStatus(dev, st) };
  });
  return JSON.parse(JSON.stringify({ due: due ? { kind: due.kind, dev: due.dev ?? null, at: due.at ?? null, limit: st.limit, remind: due.remind || null } : null, meshes }));
}

/* Every printer's bed, quietly: at launch, then hourly. Care checks its
   own counters (its schedule). */
async function mtCheckAll() {
  if (typeof PLG !== "undefined") {
    PLG.printersKnown();
    PLG.emit("change");
  }
  await Promise.all(P.list.map((p) => bmLoad(p.id).then(() => mtBedChanged(p.id)).catch(() => null)));
}

/* A printer's bed changed (read, measured, settings): its badge, and the
   plugins that show it. */
function mtBedChanged(pid) {
  mtBedBadge(pid);
  if (typeof PLG !== "undefined") PLG.emit("bed", pid);
}

/* ------------------------------------------------------------ badges */

function mtSideDots() {
  document.querySelectorAll("#side-printers [data-maint]").forEach((b) => {
    const n = appBadgesOf(b.dataset.maint, "printer").reduce((s, x) => s + x.n, 0);
    b.querySelector(".mt-dot")?.classList.toggle("hidden", !n);
    b.title = n ? tr("maint.due_n", { n }) : "";
  });
  mtTabMarks();
}

function mtTabMarks() {
  if (!MT.pid) return;
  document.querySelectorAll("#mt-tabs [data-mtab]").forEach((b) => {
    const marks = appBadgesOf(MT.pid, "tab", b.dataset.mtab);
    b.querySelector(".tab-warn")?.classList.toggle("hidden", !marks.length);
    if (marks.length) b.title = marks.map((x) => x.tip).filter(Boolean).join(" · ");
    else b.removeAttribute("title");
  });
}

/* ------------------------------------------------------------ tabs */

/* Shows a tab of the printer shown. */
function mtSetTab(tab) {
  MT.tab = mtTabs().includes(tab) ? tab : mtDefaultTab();
  if (MT.pid) localStorage.setItem(mtTabKey(MT.pid), MT.tab);
  document.querySelectorAll("#mt-tabs [data-mtab]").forEach((b) => {
    b.classList.toggle("on", b.dataset.mtab === MT.tab);
    b.setAttribute("aria-pressed", String(b.dataset.mtab === MT.tab));
  });
  $("bm-body").classList.toggle("hidden", MT.tab !== "level");
  $("ct-body").classList.toggle("hidden", MT.tab !== "control");
  ["bm-measure-btn", "bm-settings-btn"].forEach((id) => $(id).classList.toggle("hidden", MT.tab !== "level"));
  // A plugin tab's own toolbar actions; its refresh takes the page's place.
  const actions = plgActionsOf("maint", MT.tab);
  for (const a of PLG_ACTIONS.values()) a.btn.classList.toggle("hidden", !actions.includes(a));
  $("mt-refresh").classList.toggle("hidden", actions.some((a) => a.decl.icon === "refresh"));
  $("mt-refresh").title = tr(MT.tab === "level" ? "bm.refresh" : MT.tab === "control" ? "ctl.refresh" : "maint.refresh_any");
  const p = P.list.find((x) => x.id === MT.pid);
  if (p) tbSet("maint", tr("maint.title"), p.name || p.host);
  mtTabMarks();
  // Plugin tabs: shown in their box (`reload`: opened or refreshed, read
  // the printer again), told when they are left.
  const reload = MT.reload;
  MT.reload = false;
  for (const t of plgTabs("maint")) {
    const on = t.decl.id === MT.tab && !!MT.pid;
    t.box.classList.toggle("hidden", !on);
    if (on) {
      t.shown = true;
      mtPluginCall(t, "show", MT.pid, t.box, { reload });
    } else if (t.shown) {
      t.shown = false;
      mtPluginCall(t, "hide");
    }
  }
  if (MT.tab === "level") bmShow(MT.pid);
  // Control reads the printer while it is shown, and only then.
  if (MT.tab === "control") ctShow(MT.pid, MT.ctx || {});
  else ctLeave();
  MT.ctx = {};
}

function mtPluginCall(t, fn, ...args) {
  try {
    Promise.resolve(t.handlers[fn]?.(...args)).catch((e) => console.warn(`[plugin ${t.plugin}] ${fn}`, e));
  } catch (e) {
    console.warn(`[plugin ${t.plugin}] ${fn}`, e);
  }
}

/* Opens Care & Tuning on a printer and a tab; `ctx` is the tab's opening
   context (Control: { head }). */
async function maintShow(pid, tab, ctx = {}) {
  const fresh = MT.pid !== pid;
  MT.ctx = ctx;
  MT.pid = pid;
  P.sel = pid;
  switchView("maint");
  if (tab || fresh) MT.tab = tab && mtTabs().includes(tab) ? tab : mtTabOf(pid);
  MT.loading = true;
  BM.loading = true;
  MT.reload = true;
  mtSetTab(MT.tab);
  // The bed mesh, read (and a new full one stored) for its badge.
  await bmLoad(pid).catch(() => null);
  if (MT.pid !== pid) return;
  MT.loading = false;
  BM.loading = false;
  mtBedChanged(pid);
  if (MT.tab === "level") bmRender();
}

const mtDate = (at) => new Date(at * 1000).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });

$("mt-refresh").addEventListener("click", () => {
  if (!MT.pid) return;
  if (MT.tab === "control") return ctRead(true);
  maintShow(MT.pid);
});
$("mt-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mtab]");
  if (b && b.dataset.mtab !== MT.tab) mtSetTab(b.dataset.mtab);
});
window.addEventListener("langchange", () => {
  if (window.currentView !== "maint") return;
  mtSetTab(MT.tab);
});
setInterval(() => typeof P !== "undefined" && P.list.length && mtCheckAll(), 3600 * 1000);
