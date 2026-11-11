"use strict";
/* Care: the built-in plugin of the Care tab in Care & Tuning (plugin API
   v1, docs/plans/plugin-api-v1.md). What the printer counts, what is due,
   what was done.

   The Snapmaker U1 counts each head's tool changes and errors; Moonraker's
   history its hours and jobs (read by the app, `ctx.printer.maintenance`).
   Tasks come from Snapmaker's maintenance guide and FAQ; what was done is
   logged in the plugin's store with the counters at that moment, and
   "since" counts from there. Read only: nothing is written to the printer.

   It reaches the app through `ctx` only (scripts/test-plugins.js checks
   it). Store: `log` (printer → tasks done, oldest first) and `cache`
   (printer → the last counters read and when). */
(function () {
  const GUIDE = "https://wiki.snapmaker.com/en/snapmaker_u1/troubleshooting/Core_Components_Maintenance_Guide";
  const VIDEO = "https://www.youtube.com/watch?v=EGfoaHfxalA";

  /* Due after `swaps` tool changes (per head), `hours` of printing or
     `months` — whichever comes first. `t`: the video's chapter, in seconds.
     Intervals without an official figure are prudent defaults. `steps`: how
     many `maint.t.<id>.s<n>` texts. */
  const TASKS = [
    { id: "contacts", swaps: 100000, t: 549, steps: 3 },
    { id: "docking", swaps: 100000, t: 477, steps: 2 },
    { id: "rails", hours: 500, months: 6, t: 15, steps: 3 },
    { id: "zscrews", hours: 250, months: 3, t: 330, steps: 3 },
    { id: "nozzles", hours: 100, steps: 3 },
    { id: "plate", hours: 50, steps: 3 },
  ];
  const MONTH = 30.44 * 86400;

  const last = (log, id) => log.filter((e) => e.task === id).sort((a, b) => b.at - a.at)[0] || null;

  /* How far a task is: { ratio, left, unit, last } — the most advanced of
     its counters. Never done: since the printer's start (and for the
     contacts, the count the printer itself reset at its last maintenance).
     `now`: Unix seconds. */
  function progress(task, usage, log, now = Date.now() / 1000) {
    const done = last(log, task.id);
    const parts = [];
    if (task.swaps) {
      if (!usage.heads.length) return null; // not a U1: no tool change counters
      const since = Math.max(0, ...usage.heads.map((h, i) => h.switch_count - (done ? done.swaps[i] ?? h.last_maintenance_count : h.last_maintenance_count)));
      parts.push({ ratio: since / task.swaps, left: task.swaps - since, unit: "swaps" });
    }
    if (task.hours) {
      const since = Math.max(0, usage.print_hours - (done?.print_hours || 0));
      parts.push({ ratio: since / task.hours, left: Math.round(task.hours - since), unit: "hours" });
    }
    if (task.months && done) {
      const months = (now - done.at) / MONTH;
      parts.push({ ratio: months / task.months, left: Math.round(task.months - months), unit: "months" });
    }
    const worst = parts.reduce((x, y) => (y.ratio > x.ratio ? y : x));
    return { ...worst, last: done };
  }

  const stateOf = (ratio) => (ratio >= 1 ? "due" : ratio >= 0.8 ? "soon" : "ok");

  /* Tasks due on a printer. */
  const dueCount = (usage, log, now) => TASKS.map((t) => progress(t, usage, log, now)).filter((p) => p && p.ratio >= 1).length;

  /* An entry of the log: a task done at `at`, with the counters then. */
  const entry = (task, usage, at) => ({ task, at, print_hours: usage.print_hours, swaps: usage.heads.map((h) => h.switch_count) });

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /* ------------------------------------------------------------ plugin */

  function activate(ctx) {
    const t = ctx.i18n.t;
    const num = (n) => ctx.i18n.num(n);
    const dec = (n, d) => ctx.i18n.dec(n, d);
    const date = (at) => new Date(at * 1000).toLocaleDateString(ctx.i18n.locale(), { day: "numeric", month: "short", year: "numeric" });
    const dateTime = (ms) => new Date(ms).toLocaleString(ctx.i18n.locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

    // The printer shown, what is known about it, and the tab's state.
    const S = { pid: null, box: null, usage: null, log: [], stale: null, bed: null, loading: false, open: new Set(), histOpen: false, seq: 0 };
    const due = new Map(); // printer → tasks due (its counters known)
    const shown = () => !!S.box && !S.box.classList.contains("hidden");

    /* Every read-change-write of the store, one after the other: the
       hourly check reads all printers at once, and a store key holds them
       all. */
    let queue = Promise.resolve();
    const serial = (fn) => (queue = queue.then(fn, fn));
    const logOf = async (pid) => ((await ctx.storage.get("log")) || {})[pid] || [];
    const cacheOf = async (pid) => ((await ctx.storage.get("cache")) || {})[pid] || null;

    /* The badge: the tasks due and the bed when it asks (Care lists it). */
    async function badge(pid) {
      const bed = await ctx.printer.bed(pid).catch(() => null);
      const n = (due.get(pid) || 0) + (bed?.due ? 1 : 0);
      ctx.ui.badge(pid, n ? { n, tip: t("maint.due_n", { n }) } : null);
      return bed;
    }

    /* A printer's counters and log. Unreachable: its last counters, with
       the time they were read (`stale`); never read: `usage` null. */
    async function load(pid) {
      const log = await logOf(pid).catch(() => []);
      let usage = null,
        stale = null;
      try {
        usage = await ctx.printer.maintenance(pid);
        await serial(async () => {
          const cache = (await ctx.storage.get("cache")) || {};
          cache[pid] = { usage, at: Date.now() };
          await ctx.storage.set("cache", cache);
        });
      } catch {
        const c = await cacheOf(pid).catch(() => null);
        if (c?.usage) (usage = c.usage), (stale = c.at);
      }
      if (usage) due.set(pid, dueCount(usage, log));
      const bed = await badge(pid);
      return { usage, log, stale, bed };
    }

    /* Every printer, quietly: at launch, then hourly. */
    ctx.schedule("check", async () => {
      const list = await ctx.printers.list();
      await Promise.all(list.map((p) => load(p.id).catch(() => null)));
      if (shown() && S.pid) {
        const r = await load(S.pid).catch(() => null);
        if (r) Object.assign(S, r), render();
      }
    });

    /* Opens on a printer; `reload`: read it again. What is known shows at
       once, the printer's answer follows. */
    async function show(pid, box, { reload = false } = {}) {
      if (S.box !== box) attach(box);
      const fresh = S.pid !== pid;
      S.pid = pid;
      if (!fresh && !reload) return render();
      const seq = ++S.seq;
      if (fresh) {
        const c = await cacheOf(pid).catch(() => null);
        if (seq !== S.seq) return;
        S.usage = c?.usage || null;
        S.stale = c?.at || null;
        S.log = [];
        S.bed = null;
      }
      S.loading = true;
      render();
      const r = await load(pid).catch(() => null);
      if (seq !== S.seq || S.pid !== pid) return;
      S.loading = false;
      if (r) Object.assign(S, r);
      render();
    }

    ctx.tab("care", { show, hide: () => {} });
    ctx.action("refresh", () => S.pid && show(S.pid, S.box, { reload: true }));

    // The bed changed: the badge, and the bed's row when shown.
    ctx.printers.on("bed", async (pid) => {
      const bed = await badge(pid);
      if (pid === S.pid && shown()) {
        S.bed = bed;
        render();
      }
    });
    ctx.i18n.on("change", () => {
      for (const pid of due.keys()) badge(pid);
      if (shown()) render();
    });

    /* "In 80 h" / "Overdue by 296 h" / "In 98,396 tool changes". */
    const when = (pr) => t(pr.left < 0 ? `maint.late.${pr.unit}` : `maint.in.${pr.unit}`, { n: num(Math.abs(pr.left)) });

    function render() {
      const box = S.box;
      if (!box || !S.pid) return;
      const u = S.usage;
      if (!u) {
        // Never read: said in one line, as on the printer's other screens,
        // then the log, which is ours.
        box.innerHTML = S.loading ? `<p class="hv-note">${esc(t("maint.loading"))}</p>` : `${ctx.ui.offline(t("printers.no_answer", { name: printerName() }), "data-mt-retry")}${history()}`;
        bindHistory();
        return;
      }
      const order = { due: 0, soon: 1, ok: 2 };
      const tasks = TASKS.map((x) => ({ t: x, pr: progress(x, u, S.log) }))
        .filter((x) => x.pr)
        .map((x) => ({ ...x, st: stateOf(x.pr.ratio) }))
        .sort((a, b) => order[a.st] - order[b.st] || b.pr.ratio - a.pr.ratio);
      const level = S.bed?.due || null;
      const pending = tasks.filter((x) => x.st !== "ok");
      const nDue = pending.length + (level ? 1 : 0);

      // Summary: what to do, or what comes next.
      const next = tasks.filter((x) => x.st === "ok").sort((a, b) => b.pr.ratio - a.pr.ratio)[0];
      const never = pending.length && !S.log.length;
      const banner = `<div class="mt-banner ${nDue ? "" : "ok"}">
        <div class="mt-banner-text"><b>${esc(nDue ? t("maint.due_n", { n: nDue }) : t("maint.all_ok"))}</b>
        <small>${esc(nDue ? (never ? t("maint.never_hint") : t("maint.others_ok")) : next ? t("maint.next", { task: t(`maint.t.${next.t.id}`), when: when(next.pr).toLowerCase() }) : "")}</small></div>
        ${never ? `<button class="btn small" data-mt-all>${esc(t("maint.all_done"))}</button>` : ""}
      </div>`;

      const hm = (h) => `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
      const strip = [
        [`${num(Math.round(u.print_hours))} h`, t("maint.u.hours")],
        [num(u.jobs), t("maint.u.jobs")],
        [u.filament_m >= 1000 ? `${dec(u.filament_m / 1000, 2)} km` : `${num(Math.round(u.filament_m))} m`, t("maint.u.filament")],
        [hm(u.longest_print_hours), t("maint.u.longest")],
        u.purifier_hours ? [`${num(Math.round(u.purifier_hours))} h`, t("maint.u.purifier")] : null,
      ]
        .filter(Boolean)
        .map(([v, k]) => `<span><b>${esc(v)}</b>${esc(k)}</span>`)
        .join("");

      // The bed out of tolerance or due: a task of its own, opening its tab.
      const lvCls = level?.kind === "out" ? "due" : "soon";
      const levelRow = level
        ? `<div class="mt-task" data-mt-task="level">
        <div class="mt-row" data-mt-level>
          <span class="mt-chev"></span><span class="mt-dot-st ${lvCls}"></span>
          <span class="mt-name"><b>${esc(t("maint.tab.level"))}</b><small class="${lvCls}">${esc(
            level.kind === "out"
              ? t("bm.task_sub", { dev: dec(level.dev, 2), limit: dec(level.limit, 2), d: date(level.at) })
              : level.remind?.reason === "prints"
                ? t("bm.task_stale_prints", { n: level.remind.prints })
                : t("bm.task_stale_days", { n: level.remind?.days })
          )}</small></span>
          <span class="mt-mini ${lvCls}"><i class="full"></i></span>
          <button class="btn small primary" data-mt-level>${esc(t("bm.open"))}</button>
        </div>
      </div>`
        : "";
      const rows =
        levelRow +
        tasks
          .map(({ t: task, pr, st }) => {
            const open = S.open.has(task.id);
            const pct = Math.min(100, pr.ratio * 100);
            const note = pr.last ? t("maint.last", { d: date(pr.last.at) }) : task.hours ? t("maint.never") : "";
            const steps = Array.from({ length: task.steps }, (_, i) => `<li>${esc(t(`maint.t.${task.id}.s${i + 1}`))}</li>`).join("");
            const video = task.t
              ? `<button class="mt-card" data-mt-link="${esc(`${VIDEO}&t=${task.t}s`)}">
          <span class="mt-thumb"><i></i><em>${Math.floor(task.t / 60)}:${String(task.t % 60).padStart(2, "0")}</em></span>
          <span class="mt-card-text"><b>${esc(t("maint.video"))}</b><small>${esc(t(`maint.t.${task.id}.video`))}</small></span><span class="mt-ext">↗</span></button>`
              : "";
            return `<div class="mt-task${open ? " open" : ""}" data-mt-task="${task.id}">
        <div class="mt-row" data-mt-toggle="${task.id}">
          <span class="mt-chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span><span class="mt-dot-st ${st}"></span>
          <span class="mt-name"><b>${esc(t(`maint.t.${task.id}`))}</b><small class="${st === "ok" ? "" : st}">${esc([when(pr), note].filter(Boolean).join(" · "))}</small></span>
          <span class="mt-mini ${st}"><i style="width:${pct}%"></i></span>
          ${st === "ok" ? `<span class="mt-done-gap"></span>` : `<button class="btn small primary" data-mt-done="${task.id}">${esc(t("maint.done"))}</button>`}
        </div>
        <div class="mt-detail">
          <ol class="mt-steps">${steps}</ol>
          <div class="mt-res">${video}
            <button class="mt-card" data-mt-link="${esc(GUIDE)}">
              <span class="mt-doc"><svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6zm8 1.5V8h4.5zM8 12h8v1.5H8zm0 3h8v1.5H8zm0 3h5v1.5H8z"/></svg></span>
              <span class="mt-card-text"><b>${esc(t("maint.guide"))}</b><small>${esc(t("maint.guide_sub"))}</small></span><span class="mt-ext">↗</span></button>
          </div>
          ${st === "ok" ? `<button class="btn small mt-note-done" data-mt-done="${task.id}">${esc(t("maint.mark_done"))}</button>` : ""}
        </div>
      </div>`;
          })
          .join("");

      const contacts = last(S.log, "contacts");
      const heads = u.heads
        .map((h, i) => {
          const base = contacts ? contacts.swaps[i] ?? h.last_maintenance_count : h.last_maintenance_count;
          const since = Math.max(0, h.switch_count - base);
          const pct = (since / 100000) * 100;
          const chip = [h.diameter ? dec(h.diameter, 1) : "", h.nozzle ? t("maint.nozzle." + h.nozzle) : ""].filter(Boolean).join(" · ");
          const issues = [h.error_count ? t("maint.h.errors_n", { n: h.error_count }) : "", h.retry_count ? t("maint.h.retries_n", { n: h.retry_count }) : ""]
            .filter(Boolean)
            .join(" · ");
          return `<div class="mt-head">
        <div class="mt-head-top"><b>T${h.index}</b>${chip ? `<span class="mt-chip${h.nozzle === "high_flow" ? " hf" : ""}">${esc(chip)}</span>` : ""}</div>
        <div class="mt-big">${num(h.switch_count)}<small>${esc(t("maint.h.swaps"))}</small></div>
        <div class="mt-bar"><i style="width:${Math.min(100, pct)}%"></i></div>
        <div class="mt-sub">${esc(t("maint.h.towards", { p: dec(pct, 1) }))}</div>
        ${issues ? `<div class="mt-hint" title="${esc(t("maint.h.errors_hint"))}">⚠ ${esc(issues)}${h.error_count ? ` — ${esc(t("maint.h.clean"))}` : ""}</div>` : ""}
      </div>`;
        })
        .join("");

      const notice =
        S.loading && S.stale
          ? `<div class="mt-stale"><span class="spinner"></span>${esc(t("maint.connecting"))}</div>`
          : S.stale
            ? ctx.ui.offline(t("maint.stale", { name: printerName(), d: dateTime(S.stale) }), "data-mt-retry")
            : "";
      box.innerHTML = `${notice}${banner}
      <div class="mt-strip">${strip}</div>
      <div class="vp-section">${esc(t("maint.tasks"))} <span class="mt-info" title="${esc(t("maint.note"))}">i</span></div>
      <div class="group mt-tasks">${rows}</div>
      ${heads ? `<div class="vp-section">${esc(t("maint.heads"))}</div><div class="mt-heads">${heads}</div>` : ""}
      ${history()}`;
      bindHistory();
    }

    // The printer's name, from the last list read.
    let names = new Map();
    const printerName = () => names.get(S.pid) || "";
    const readNames = async () => (names = new Map((await ctx.printers.list()).map((p) => [p.id, p.name])));
    ctx.printers.on("change", readNames);

    /* The log, collapsed: the plugin's own record, shown even printer off;
       bed measurements stored by the app join the tasks done. */
    function history() {
      const meshes = (S.bed?.meshes || []).map((m) => ({ mesh: m, at: m.at }));
      const all = [...S.log, ...meshes].sort((a, b) => b.at - a.at);
      const rows = all
        .map((e) => {
          if (e.mesh) return `<div class="mt-hrow"><span>${esc(t("bm.hist_entry"))}</span><small>${esc(date(e.at))} · ${esc(t("bm.dev_mm", { v: dec(e.mesh.dev, 2) }))} · ${esc(t(`bm.st.${e.mesh.status}`))}</small></div>`;
          return `<div class="mt-hrow"><span>${esc(t(`maint.t.${e.task}`))}</span><small>${esc(date(e.at))} · ${esc(t("maint.at_hours", { n: num(Math.round(e.print_hours)) }))}</small></div>`;
        })
        .join("");
      return `<details class="mt-hist"${S.histOpen ? " open" : ""}><summary>${esc(t("maint.log_n", { n: all.length }))}</summary>
      <div class="group">${rows || `<div class="mt-hrow"><span class="mt-empty">${esc(t("maint.log.empty"))}</span></div>`}</div></details>`;
    }
    const bindHistory = () => S.box.querySelector(".mt-hist")?.addEventListener("toggle", (e) => (S.histOpen = e.target.open));

    /* The log of a printer, changed and saved; returns it. */
    const editLog = (pid, change) =>
      serial(async () => {
        const all = (await ctx.storage.get("log")) || {};
        all[pid] = change(all[pid] || []);
        await ctx.storage.set("log", all);
        return all[pid];
      });

    function afterLog(pid) {
      if (pid !== S.pid) return;
      if (S.usage) due.set(pid, dueCount(S.usage, S.log));
      badge(pid);
      render();
    }

    /* Logs tasks as done now; the toast offers to undo. */
    async function markDone(ids) {
      const pid = S.pid,
        usage = S.usage;
      const at = Math.floor(Date.now() / 1000);
      const added = ids.map((task) => entry(task, usage, at));
      try {
        S.log = await editLog(pid, (log) => [...log, ...added]);
      } catch (err) {
        ctx.ui.toast(String(err?.message || err), true);
        return;
      }
      afterLog(pid);
      const msg = added.length === 1 ? t("maint.done_toast", { task: t(`maint.t.${added[0].task}`) }) : t("maint.done_many", { n: added.length });
      ctx.ui.toast(msg, false, {
        label: t("maint.undo"),
        run: async () => {
          const log = await editLog(pid, (log) => log.filter((e) => !added.some((a) => a.task === e.task && a.at === e.at))).catch(() => null);
          if (log && pid === S.pid) (S.log = log), afterLog(pid);
        },
      });
    }

    function onClick(e) {
      const link = e.target.closest("[data-mt-link]");
      if (link) {
        ctx.open.url(link.dataset.mtLink).catch((err) => ctx.ui.toast(String(err?.message || err), true));
        return;
      }
      if (e.target.closest("[data-mt-level]")) return ctx.ui.showTab(S.pid, "level");
      if (e.target.closest("[data-mt-retry]")) return show(S.pid, S.box, { reload: true });
      const done = e.target.closest("[data-mt-done]");
      if (done && S.usage) return markDone([done.dataset.mtDone]);
      if (e.target.closest("[data-mt-all]") && S.usage) {
        return markDone(
          TASKS.filter((x) => {
            const pr = progress(x, S.usage, S.log);
            return pr && pr.ratio >= 0.8;
          }).map((x) => x.id)
        );
      }
      const row = e.target.closest("[data-mt-toggle]");
      if (row) {
        const id = row.dataset.mtToggle;
        S.open.has(id) ? S.open.delete(id) : S.open.add(id);
        row.parentElement.classList.toggle("open");
      }
    }

    function attach(box) {
      S.box = box;
      box.classList.add("mt");
      box.addEventListener("click", onClick);
    }

    return readNames().catch(() => null);
  }

  const api = { id: "snapstudio.care", activate, deactivate() {}, logic: { TASKS, progress, stateOf, dueCount, entry } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else snapPlugin(api);
})();
