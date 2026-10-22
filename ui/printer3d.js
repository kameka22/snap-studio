"use strict";
/* The printer page's 3D view (#34): the U1 seen from the front, its parts
   clickable (spools, heads, bed, light). A click opens a quick panel over
   the view, Prepare-style (.p-float), composed of Care & Tuning ›
   Control's compact components (control.js) — one command service, one
   filament source, no copy; "All controls" opens that tab on the right
   head (ctlOpen). The scene (printer3d/view.js, three.js) loads on the
   first visit; without WebGL the page keeps its 2D picture (the hero).
   The rules are in printer3d-logic.js. */

const P3 = {
  view: null,
  loading: null,
  failed: false,
  pid: null,
  zone: null, // the zone whose panel is open
  pending: null, // a spool's panel, opened once the view has turned
  built: "", // what the panel was built for
  timer: 0,
};

const p3dOn = () => window.currentView === "printers" && !!P3.pid && !$("p3d").classList.contains("hidden");

/* Loads the scene once; null without WebGL. */
function p3dLoad() {
  if (P3.loading) return P3.loading;
  P3.loading = import("./printer3d/view.js")
    .then((m) => {
      const view = m.createView($("p3d-canvas"), { hover: p3dHover, pick: p3dPick, turn: p3dTurned });
      if (!view) throw new Error("WebGL");
      view.setTheme(isDark());
      P3.view = view;
      return view;
    })
    .catch((e) => {
      console.warn("3D view unavailable:", e);
      P3.failed = true;
      return null;
    });
  return P3.loading;
}

/* The printer page shows a printer (prnRenderDetail): the view follows it. */
function p3dShow(p) {
  const pid = p?.id || null;
  if (pid !== P3.pid) {
    P3.pid = pid;
    $("p3d").dataset.ctlPid = pid || "";
    p3dClose();
    if (P3.view) {
      P3.view.turn("front", 0);
      p3dSegment("front");
    }
  }
}

/* The page's status (renderStatus): the view replaces the hero while the
   printer answers; offline, the "not connected" card is alone. */
function p3dStatus(st) {
  const box = $("p3d");
  const online = !!st?.online;
  const use = online && !P3.failed;
  box.classList.toggle("hidden", !use);
  $("prn-hero").classList.toggle("hidden", !online || (use && !!P3.view));
  if (!use) {
    p3dStop();
    return;
  }
  p3dLoad().then((view) => {
    if (!view) {
      box.classList.add("hidden");
      $("prn-hero").classList.toggle("hidden", !P.status.get(P3.pid)?.online);
      return;
    }
    $("prn-hero").classList.add("hidden");
    view.setShown(p3dOn());
    p3dPaint();
    p3dPoll();
  });
  p3dCard(st);
}

/* Control's state, every 3 s while the view is shown (light, temperatures,
   the active head, the carriage); the spools come with the page's status. */
function p3dPoll() {
  if (P3.timer || !p3dOn()) return;
  const pid = P3.pid;
  ctlRead(pid, !ctlData(pid).cfg);
  P3.timer = setTimeout(function next() {
    if (!p3dOn() || P3.pid !== pid) return p3dStop();
    ctlRead(pid);
    P3.timer = setTimeout(next, 3000);
  }, 3000);
}
function p3dStop() {
  clearTimeout(P3.timer);
  P3.timer = 0;
  P3.view?.setShown(false);
}
/* The printers view shown or left (switchView). */
function p3dVisible(on) {
  if (!on) {
    p3dStop();
    p3dTip(null);
  } else if (P3.pid) p3dStatus(P.status.get(P3.pid));
}

ctlSubscribe((pid) => {
  if (pid === P3.pid && P3.view) p3dPaint();
});
window.addEventListener("themechange", () => P3.view?.setTheme(isDark()));

/* ------------------------------------------------------------ the model */

/* The model and the overlays from what is known: the page's status, and
   Control's state when read. */
function p3dPaint() {
  const pid = P3.pid, st = P.status.get(pid), cs = ctlState(pid);
  if (!pid || !P3.view) return;
  const spool = (n) => ctlSpool(pid, n);
  const active = cs ? cs.active ?? null : (st?.nozzles || []).find((n) => n.active)?.index ?? null;
  const noz = cs ? cs.heads.find((h) => h.index === active) : (st?.nozzles || []).find((n) => n.index === active);
  const sum = p3dSummary(st);
  P3.view.setState({
    spools: [0, 1, 2, 3].map((n) => (spool(n).present ? spool(n).color || "#9a9ca2" : null)),
    active,
    heat: noz ? p3dHeat(noz.temp ?? noz.current, noz.target) : 0,
    light: !!cs?.light,
    carriage: cs ? p3dCarriage(cs.position) : null,
    printing: sum.state === "printing",
    progress: sum.progress,
    partColor: active != null ? spool(active).color : null,
  });
  p3dCard(st);
  p3dPanelPaint();
  const box = $("p3d");
  ctlPaint(box.querySelector(".p3d-estop"), pid);
}

/* The status card: state, chamber, the print, the four spools. */
function p3dCard(st) {
  const pid = P3.pid, sum = p3dSummary(st);
  const s = STATES[sum.state] ? sum.state : "standby";
  $("p3d-state").className = "p3d-state " + (STATES[s]?.[1] || "");
  $("p3d-state-t").textContent = stateLabel(sum.state);
  $("p3d-chamber").textContent = st?.chamber ? tr("p3d.chamber", { t: fmtNum(Math.round(st.chamber.current)) }) : "";
  $("p3d-job").textContent = sum.job || tr("p3d.no_job");
  const printing = sum.progress != null;
  $("p3d-prog").classList.toggle("hidden", !printing);
  if (printing) {
    $("p3d-bar").style.width = `${Math.round(sum.progress * 100)}%`;
    const bits = [`${Math.round(sum.progress * 100)} %`];
    if (sum.layer) bits.push(tr("p3d.layer", { a: sum.layer[0], b: sum.layer[1] }));
    const left = fmtHms(sum.left);
    if (left) bits.push(tr("p3d.left", { t: left }));
    $("p3d-prog-t").textContent = bits.join(" · ");
  }
  const chips = $("p3d-chips");
  if (!chips.children.length) {
    chips.innerHTML = P3D_SPOOLS.map(({ n }) => `<button class="p3d-chip" data-zone="spool:${n}"><i></i><b>T${n}</b><small></small></button>`).join("");
  }
  chips.querySelectorAll(".p3d-chip").forEach((c) => {
    const n = +c.dataset.zone.slice(6), sp = ctlSpool(pid, n);
    c.style.setProperty("--spool", sp.present ? sp.color || "var(--text-tertiary)" : "transparent");
    c.classList.toggle("empty", !sp.present);
    c.classList.toggle("on", p3dParse(P3.zone)?.n === n);
    c.querySelector("small").textContent = sp.present ? sp.kind || "?" : tr("p3d.empty");
    c.title = sp.present ? sp.name : tr("ctl.no_spool");
  });
}

/* ------------------------------------------------------------ hover, pick */

function p3dLabel(zone) {
  const z = p3dParse(zone), pid = P3.pid;
  if (!z) return null;
  if (z.kind === "spool") {
    const sp = ctlSpool(pid, z.n);
    return { title: `T${z.n} · ${sp.present ? sp.name || tr("ctl.loaded") : tr("ctl.no_spool")}`, sub: tr(`p3d.side.${P3D_SPOOLS[z.n].side}`) + " · " + tr("p3d.click_turn"), color: sp.present ? sp.color : null };
  }
  if (z.kind === "head") {
    const h = ctlState(pid)?.heads.find((x) => x.index === z.n);
    return { title: tr("p3d.head", { n: z.n }), sub: h ? `${ctlDeg(h.temp)}${h.target > 0 ? ` → ${ctlDeg(h.target)}` : ""}` : tr("p3d.click_open"), color: ctlSpool(pid, z.n).color };
  }
  if (z.kind === "bed") {
    const b = ctlState(pid)?.bed;
    return { title: tr("ctl.bed"), sub: b ? `${ctlDeg(b.temp)}${b.target > 0 ? ` → ${ctlDeg(b.target)}` : ""}` : tr("p3d.click_open") };
  }
  return { title: tr("ctl.light"), sub: ctlState(pid)?.light ? tr("p3d.on") : tr("p3d.off") };
}

function p3dTip(zone, x, y) {
  const tip = $("p3d-tip");
  const l = zone && zone !== P3.zone ? p3dLabel(zone) : null;
  tip.classList.toggle("hidden", !l);
  if (!l) return;
  tip.innerHTML = `<b>${l.color !== undefined ? `<i style="--spool:${esc(l.color || "transparent")}"></i>` : ""}${esc(l.title)}</b><small>${esc(l.sub)}</small>`;
  const r = $("p3d").getBoundingClientRect();
  tip.style.left = `${Math.min(x - r.left + 14, r.width - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.max(8, y - r.top - tip.offsetHeight - 10)}px`;
}
const p3dHover = (zone, x, y) => p3dTip(zone, x, y);

/* A click: a spool turns the view to its side, then its panel opens; a
   head zooms on its place; elsewhere the panel opens at once; nothing
   closes it. */
function p3dPick(zone) {
  p3dTip(null);
  if (!zone) return p3dClose();
  const side = p3dSideOf(zone);
  if (side !== "front" && P3.view.side !== side) {
    P3.pending = zone;
    p3dSegment(side);
    P3.view.turn(side);
    return;
  }
  p3dOpen(zone);
}
function p3dTurned(side, dragged) {
  p3dSegment(side);
  if (dragged || !P3.pending) return;
  const zone = P3.pending;
  P3.pending = null;
  p3dOpen(zone);
}
function p3dSegment(side) {
  $("p3d-views").querySelectorAll("[data-side]").forEach((b) => b.classList.toggle("on", b.dataset.side === side));
}

/* ------------------------------------------------------------ the panel */

function p3dOpen(zone) {
  P3.zone = zone;
  P3.built = "";
  $("p3d-panel").classList.remove("hidden");
  P3.view?.choose(zone);
  // A head: a close-up from above on its place.
  const z = p3dParse(zone);
  P3.view?.focus(z.kind === "head" ? z.n : null);
  p3dPanelPaint();
  p3dCard(P.status.get(P3.pid));
}
function p3dClose() {
  P3.zone = null;
  P3.pending = null;
  $("p3d-panel").classList.add("hidden");
  P3.view?.choose(null);
  P3.view?.focus(null);
  if (P3.pid) p3dCard(P.status.get(P3.pid));
}

/* Builds the panel for its zone (again once Control's configuration is
   known), then paints it with the components' paints. */
function p3dPanelPaint() {
  const z = p3dParse(P3.zone), pid = P3.pid;
  if (!z || !pid) return;
  const cfg = ctlData(pid).cfg;
  const key = `${pid}:${P3.zone}:${cfg ? 1 : 0}`;
  const body = $("p3d-panel-body");
  if (P3.built !== key) {
    P3.built = key;
    const head = z.kind === "spool" || z.kind === "head" ? z.n : null;
    const h = head != null ? cfg?.heads.find((x) => x.index === head) : null;
    $("p3d-panel-t").textContent =
      z.kind === "spool" ? tr("p3d.spool_t", { n: z.n, side: tr(`p3d.side.${P3D_SPOOLS[z.n].side}`).toLowerCase() })
      : z.kind === "head" ? tr("p3d.head", { n: z.n })
      : tr(z.kind === "bed" ? "ctl.bed" : "ctl.light");
    const parts = [];
    if (z.kind === "spool") parts.push(ctlSpoolHtml(z.n, { compact: true }));
    if (head != null) parts.push(h ? ctlHeadHtml(h, { compact: true }) : `<div class="ctl-c p3d-wait">${esc(tr("p3d.reading"))}</div>`);
    if (z.kind === "bed") parts.push(cfg ? ctlBedHtml(cfg, { compact: true }) : `<div class="ctl-c p3d-wait">${esc(tr("p3d.reading"))}</div>`);
    if (z.kind === "light") parts.push(ctlLightHtml({ compact: true }));
    const all = head != null ? tr("p3d.all_head", { n: head }) : tr("p3d.all");
    body.innerHTML = `${parts.join("")}
      <div class="p3d-busy hidden" role="status"><span class="spinner small"></span><span></span></div>
      <button class="p3d-link" data-all="${head ?? ""}">${esc(all)}<span aria-hidden="true">›</span></button>`;
  }
  ctlPaint(body, pid);
  const busy = ctlBusy(pid), b = body.querySelector(".p3d-busy");
  b.classList.toggle("hidden", !busy);
  b.lastElementChild.textContent = busy || "";
}

/* ------------------------------------------------------------ events */

const p3dEstop = () => ($("p3d").querySelector(".p3d-estop").innerHTML = ctlEstopHtml());
p3dEstop();
ctlBind($("p3d"));
$("p3d-close").addEventListener("click", p3dClose);
$("p3d-panel").addEventListener("click", (e) => {
  const all = e.target.closest("[data-all]");
  if (all) ctlOpen(P3.pid, all.dataset.all === "" ? {} : { head: +all.dataset.all });
});
$("p3d-chips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-zone]");
  if (c && P3.view) p3dPick(c.dataset.zone);
});
$("p3d-views").addEventListener("click", (e) => {
  const b = e.target.closest("[data-side]");
  if (!b || !P3.view) return;
  // Turning away from an open spool's side closes its panel.
  if (P3.zone && p3dSideOf(P3.zone) !== b.dataset.side && p3dSideOf(P3.zone) !== "front") p3dClose();
  p3dSegment(b.dataset.side);
  P3.view.turn(b.dataset.side);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && P3.zone && p3dOn() && !document.querySelector(".modal:not(.hidden)")) p3dClose();
});
window.addEventListener("langchange", () => {
  P3.built = "";
  p3dEstop();
  $("p3d-chips").innerHTML = "";
  if (P3.pid) p3dStatus(P.status.get(P3.pid));
});
