"use strict";
/* Care & Tuning › Control: the printer's basic actions, laid out as the
   validated mockup (#17): status bar with the emergency stop, jog pad,
   head cards in their spool's colour, bed, fans and light, camera,
   "turn heaters off" and an Advanced fold (motors off, firmware restart).

   The interface asks control.rs for an action (never G-code); the same
   rules (control-logic.js) grey out what the printer would refuse and say
   why. One action at a time; the state is read again every 1.5 s while
   the tab is shown. */

const CT = {
  pid: null,
  st: null,
  cfg: null,
  err: null,
  busy: null, // { label } while an action runs
  homedSeen: false, // homed earlier in this visit: a loss is Klipper's standby
  step: +localStorage.getItem("snapstudio.ctl.step") || 10,
  timer: 0,
  reading: false,
  built: null, // the pid the skeleton was built for
  cam: { on: false, n: 0, timer: 0, keep: 0 },
};

const ctOn = () => window.currentView === "maint" && MT.tab === "control";
const ctDeg = (v) => (v == null ? "—" : `${fmtNum(Math.round(v))}°`);
const ctMm = (v) => fmtDec(v, 1);

/* Opens the tab on a printer: its configuration once, then the state. */
async function ctShow(pid) {
  if (CT.pid !== pid) {
    ctCamStop();
    Object.assign(CT, { pid, st: null, cfg: null, err: null, busy: null, built: null, homedSeen: false });
  }
  ctBuild();
  ctUpdate();
  // Opened straight here: the spools are not known yet (the printer's page
  // reads them); the tab reads them itself.
  ctSlots();
  await ctRead(true);
  ctPoll();
}

/* The heads' spools (colour, material), read from the printer: on opening,
   every 30 s while shown, after a load or an unload. */
let ctSlotsAt = 0;
async function ctSlots() {
  const pid = CT.pid;
  if (!pid || typeof headsRefreshSlots !== "function") return;
  ctSlotsAt = Date.now();
  await headsRefreshSlots(pid);
  if (CT.pid === pid && ctOn()) ctUpdate();
}

function ctLeave() {
  clearTimeout(CT.timer);
  CT.timer = 0;
  ctCamStop();
}

function ctPoll() {
  clearTimeout(CT.timer);
  if (!ctOn()) return;
  CT.timer = setTimeout(async () => {
    await ctRead(!CT.cfg);
    if (Date.now() - ctSlotsAt > 30000) ctSlots();
    ctPoll();
  }, 1500);
}

/* One read at a time. */
async function ctRead(config = false) {
  const pid = CT.pid;
  if (!pid || CT.reading) return;
  CT.reading = true;
  try {
    const r = await invoke("control_read", { printerId: pid, config });
    if (CT.pid !== pid) return;
    CT.st = r.state;
    if (r.config) CT.cfg = r.config;
    CT.err = null;
  } catch (e) {
    if (CT.pid === pid) CT.err = String(e);
  } finally {
    CT.reading = false;
  }
  if (CT.pid !== pid) return;
  if (CT.built !== `${pid}:${CT.cfg ? CT.cfg.heads.length : 0}`) ctBuild();
  ctUpdate();
}

/* ------------------------------------------------------------ layout */

const CT_ICONS = {
  up: '<path d="M12 6l6 7H6z"/>',
  down: '<path d="M12 18l6-7H6z"/>',
  left: '<path d="M6 12l7-6v12z"/>',
  right: '<path d="M18 12l-7-6v12z"/>',
  home: '<path d="M12 4l8 7h-2.5v8h-4v-5h-3v5h-4v-8H4z"/>',
  power: '<path d="M11 3h2v9h-2zM6.3 6.3l1.4 1.4A6 6 0 1 0 16.3 7.7l1.4-1.4A8 8 0 1 1 6.3 6.3z"/>',
};
const ctIcon = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${CT_ICONS[k]}</svg>`;

function ctBuild() {
  const cfg = CT.cfg;
  CT.built = `${CT.pid}:${cfg ? cfg.heads.length : 0}`;
  const box = $("ct-body");
  const heads = cfg ? cfg.heads : [];
  const jog = (axis, dist, icon, label) =>
    `<button class="ct-jog" data-act="jog" data-axis="${axis}" data-sign="${dist}" aria-label="${esc(label)}" title="${esc(label)}">${ctIcon(icon)}<small>${esc(label)}</small></button>`;
  const headCard = (h) => `
    <div class="ct-head" data-head="${h.index}">
      <div class="ct-head-top">
        <b>T${h.index}</b><i class="ct-spool" aria-hidden="true"></i><span class="ct-mat" data-v="mat"></span>
        <span class="ct-badge" data-v="badge"></span>
      </div>
      <div class="ct-head-mid">
        <div class="ct-gauge" data-v="gauge"><span><b data-v="temp">—</b><small data-v="target"></small></span></div>
        <div class="ct-head-set">
          <label class="ct-slider"><span>${esc(tr("ctl.nozzle"))}</span>
            <input type="range" min="0" max="${Math.round(h.max_temp)}" step="5" data-temp="${h.index}" aria-label="${esc(tr("ctl.nozzle_n", { n: h.index }))}" />
            <b data-v="set">0°</b></label>
          <button class="btn small ct-activate" data-act="tool" data-n="${h.index}">${esc(tr("ctl.activate"))}</button>
        </div>
      </div>
      <div class="ct-head-acts">
        <button class="btn small" data-act="load" data-n="${h.index}">${esc(tr("ctl.load"))}</button>
        <button class="btn small" data-act="unload" data-n="${h.index}">${esc(tr("ctl.unload"))}</button>
        <button class="btn small" data-act="extrude" data-n="${h.index}" title="${esc(tr("ctl.extrude_sub"))}">↓ ${esc(tr("ctl.extrude"))}</button>
        <button class="btn small" data-act="retract" data-n="${h.index}">↑ ${esc(tr("ctl.retract"))}</button>
      </div>
    </div>`;
  box.innerHTML = `<div class="ct">
    <div class="ct-status">
      <span class="ct-state" id="ct-state"><i></i><b id="ct-state-t"></b></span>
      <span class="ct-chip" id="ct-homed"></span>
      <span class="ct-chip" id="ct-active"></span>
      <span class="ct-busy hidden" id="ct-busy" role="status"><span class="spinner small"></span><span id="ct-busy-t"></span></span>
      <button class="ct-estop" id="ct-estop" data-act="emergency_stop">${ctIcon("power")}<span>${esc(tr("ctl.estop"))}</span></button>
    </div>
    <div class="mt-stale hidden" id="ct-conn" role="status"></div>
    <div class="ct-lock hidden" id="ct-lock" role="status"></div>
    <div class="ct-top">
      <section class="ct-card ct-move">
        <div class="ct-card-head">${esc(tr("ctl.move"))}<span class="ct-pos" id="ct-pos"></span></div>
        <div class="ct-move-body">
          <div class="ct-pad" role="group" aria-label="${esc(tr("ctl.move_xy"))}">
            <span></span>${jog("y", 1, "up", "Y+")}<span></span>
            ${jog("x", -1, "left", "X−")}<button class="ct-jog ct-home" data-act="home" data-axes="xy" title="${esc(tr("ctl.home_xy"))}" aria-label="${esc(tr("ctl.home_xy"))}">${ctIcon("home")}<small>XY</small></button>${jog("x", 1, "right", "X+")}
            <span></span>${jog("y", -1, "down", "Y−")}<span></span>
          </div>
          <div class="ct-zpad" role="group" aria-label="${esc(tr("ctl.move_z"))}">
            ${jog("z", 1, "up", "Z+")}
            <button class="ct-jog ct-home" data-act="home" data-axes="z" title="${esc(tr("ctl.home_z"))}" aria-label="${esc(tr("ctl.home_z"))}">${ctIcon("home")}<small>Z</small></button>
            ${jog("z", -1, "down", "Z−")}
          </div>
        </div>
        <div class="ct-row"><span class="ct-k">${esc(tr("ctl.step"))}</span>
          <div class="seg ct-steps" id="ct-steps" role="radiogroup" aria-label="${esc(tr("ctl.step"))}">${CTL_STEPS.map((s) => `<button class="seg-btn" role="radio" data-step="${s}">${esc(fmtDec(s, s < 1 ? 1 : 0))}</button>`).join("")}</div>
          <span class="ct-unit">mm</span></div>
        <div class="ct-row ct-homes">
          <button class="btn small primary" data-act="home" data-axes="xyz">${ctIcon("home")} ${esc(tr("ctl.home_all"))}</button>
          <button class="btn small" data-act="home" data-axes="x">X</button><button class="btn small" data-act="home" data-axes="y">Y</button><button class="btn small" data-act="home" data-axes="z">Z</button>
        </div>
        <div class="ct-warn hidden" id="ct-nohome"><span>${esc(tr("ctl.not_homed"))}</span><button class="btn small primary" data-act="home" data-axes="xyz">${esc(tr("ctl.home_now"))}</button></div>
        <div class="ct-row ct-tools">
          <button class="btn small" data-act="clean">${esc(tr("ctl.clean"))}</button>
          <button class="btn small" data-act="purge_position">${esc(tr("ctl.purge"))}</button>
        </div>
      </section>
      <section class="ct-card ct-heads">
        <div class="ct-card-head"><button class="ct-help" data-ct-help title="${esc(tr("ctl.help.title"))}" aria-label="${esc(tr("ctl.help.title"))}">?</button>${esc(tr("ctl.heads"))}</div>
        <div class="ct-head-grid">${heads.length ? heads.map(headCard).join("") : `<p class="ct-empty">${esc(tr(CT.err ? "ctl.offline" : "ctl.reading"))}</p>`}</div>
      </section>
    </div>
    <div class="ct-bottom">
      <section class="ct-card ct-bed">
        <div class="ct-card-head">${esc(tr("ctl.bed"))}</div>
        <div class="ct-head-mid">
          <div class="ct-gauge" id="ct-bed-gauge"><span><b id="ct-bed-t">—</b><small id="ct-bed-target"></small></span></div>
          <div class="ct-head-set">
            <label class="ct-slider"><span>${esc(tr("ctl.target"))}</span><input type="range" min="0" max="${Math.round(cfg?.bed_max || 100)}" step="5" id="ct-bed-set" aria-label="${esc(tr("ctl.bed"))}" /><b id="ct-bed-set-v">0°</b></label>
            <small class="ct-note">${esc(tr("ctl.max", { t: fmtNum(Math.round(cfg?.bed_max || 100)) }))}</small>
          </div>
        </div>
      </section>
      <section class="ct-card ct-air">
        <div class="ct-card-head">${esc(tr("ctl.air"))}</div>
        <label class="ct-slider wide"><span>${esc(tr("ctl.part_fan"))}</span><input type="range" min="0" max="100" step="5" id="ct-fan" aria-label="${esc(tr("ctl.part_fan"))}" /><b id="ct-fan-v">0 %</b></label>
        <label class="ct-slider wide${cfg?.chamber_fan ? "" : " hidden"}"><span>${esc(tr("ctl.chamber_fan"))}</span><input type="range" min="0" max="100" step="5" id="ct-cfan" aria-label="${esc(tr("ctl.chamber_fan"))}" /><b id="ct-cfan-v">0 %</b></label>
        <label class="ct-switch${cfg?.purifier ? "" : " hidden"}"><span>${esc(tr("ctl.purifier"))}</span><input type="checkbox" class="sw" role="switch" id="ct-purifier" /></label>
        <label class="ct-switch${cfg?.light ? "" : " hidden"}"><span>${esc(tr("ctl.light"))}</span><input type="checkbox" class="sw" role="switch" id="ct-light" /></label>
      </section>
      <section class="ct-card ct-cam">
        <div class="ct-card-head">${esc(tr("printers.camera"))}<input type="checkbox" class="sw small" role="switch" id="ct-cam-sw" aria-label="${esc(tr("printers.camera"))}" /></div>
        <div class="ct-cam-box" id="ct-cam-box"><img id="ct-cam-img" alt="${esc(tr("printers.camera_alt"))}" /><span class="ct-cam-note" id="ct-cam-note">${esc(tr("ctl.cam_off"))}</span></div>
      </section>
    </div>
    <div class="ct-foot">
      <button class="btn" data-act="heaters_off">${esc(tr("ctl.heaters_off"))}</button>
      <span class="ct-note" id="ct-idle-note">${esc(tr("ctl.idle_note"))}</span>
      <details class="ct-adv"><summary>${esc(tr("ctl.advanced"))}</summary>
        <div class="ct-adv-body">
          <button class="btn small" data-act="motors_off">${esc(tr("ctl.motors_off"))}</button>
          <button class="btn small" data-act="firmware_restart">${esc(tr("ctl.restart"))}</button>
        </div>
      </details>
    </div>
  </div>`;
}

/* ------------------------------------------------------------ values */

function ctUpdate() {
  const box = $("ct-body");
  if (!box.firstElementChild) return;
  const { cfg } = CT;
  // Not answering: nothing can run (the last state read is not the printer's now).
  const st = CT.err ? null : CT.st;
  const state = CT.err ? "offline" : !st ? "reading" : ctlStateOf(st);
  const stateText = state === "printing" ? tr("ctl.st.printing", { p: fmtNum(Math.round((st.progress || 0) * 100)) })
    : state === "busy" ? tr("ctl.st.busy", { state: st.main_state }) : tr(`ctl.st.${state}`);
  $("ct-state").className = `ct-state ${state}`;
  $("ct-state-t").textContent = stateText;
  const homed = ctlHomed(st);
  $("ct-homed").textContent = st ? tr(homed ? "ctl.homed" : "ctl.not_homed_short") : "";
  $("ct-homed").className = `ct-chip${st && !homed ? " warn" : ""}`;
  $("ct-active").textContent = st?.active != null ? tr("ctl.active_head", { n: st.active }) : "";
  $("ct-busy").classList.toggle("hidden", !CT.busy);
  $("ct-busy-t").textContent = CT.busy?.label || "";
  // Reading the printer, or it does not answer: said plainly, with a retry.
  const conn = $("ct-conn");
  conn.classList.toggle("hidden", state !== "reading" && state !== "offline");
  if (state === "reading") conn.innerHTML = `<span class="spinner"></span><span>${esc(tr("ctl.reading"))}</span>`;
  else if (state === "offline") conn.innerHTML = `<span class="mt-stale-dot"></span><span>${esc(tr("ctl.offline_err", { err: CT.err }))}</span><button class="btn small" data-ct-retry>${esc(tr("printers.offline.retry"))}</button>`;
  // The heads' box before the printer's configuration is known.
  box.querySelector(".ct-empty")?.replaceChildren(tr(state === "offline" ? "ctl.offline" : "ctl.reading"));
  // Printing or a U1 procedure: what stays possible is said.
  const lock = state === "printing" || state === "paused" ? "ctl.lock.printing" : state === "busy" ? "ctl.lock.busy" : "";
  $("ct-lock").classList.toggle("hidden", !lock);
  if (lock) $("ct-lock").textContent = tr(lock);
  $("ct-nohome").classList.toggle("hidden", !st || homed || !!lock);
  // Homed a moment ago, not any more, nothing moved: Klipper's standby
  // (5 min without a command) turned the motors off. Said as such.
  if (homed) CT.homedSeen = true;
  $("ct-nohome").querySelector("span").textContent = tr(CT.homedSeen && !homed && st?.idle === "Idle" ? "ctl.not_homed_idle" : "ctl.not_homed");
  $("ct-pos").textContent = st && homed ? `X ${ctMm(st.position[0])}  Y ${ctMm(st.position[1])}  Z ${ctMm(st.position[2])}` : "";
  document.querySelectorAll("#ct-steps [data-step]").forEach((b) => {
    const on = +b.dataset.step === CT.step;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  // Heads: their spool, temperature and target, the active one.
  const slots = typeof headsSlots === "function" ? headsSlots(CT.pid) : [];
  for (const h of cfg?.heads || []) {
    const card = box.querySelector(`.ct-head[data-head="${h.index}"]`);
    if (!card) continue;
    const hs = st?.heads.find((x) => x.index === h.index);
    const slot = slots.find((s) => s.index === h.index);
    const color = slot?.present && slot.color ? slot.color : null;
    card.style.setProperty("--spool", color || "var(--separator)");
    card.classList.toggle("empty", !slot?.present);
    card.classList.toggle("active", st?.active === h.index);
    const name = [colorName(color), slot?.kind].filter(Boolean).join(" ");
    card.querySelector('[data-v="mat"]').textContent = slot?.present ? (name ? name[0].toUpperCase() + name.slice(1) : tr("ctl.loaded")) : tr("ctl.no_spool");
    card.querySelector('[data-v="badge"]').textContent = st?.active === h.index ? tr("ctl.is_active") : "";
    card.querySelector('[data-v="temp"]').textContent = ctDeg(hs?.temp);
    card.querySelector('[data-v="target"]').textContent = hs?.target > 0 ? `→ ${ctDeg(hs.target)}` : tr("ctl.off");
    ctGauge(card.querySelector('[data-v="gauge"]'), hs?.temp, hs?.target, h.max_temp);
    const r = card.querySelector(`[data-temp="${h.index}"]`);
    if (document.activeElement !== r && !r.dataset.drag) {
      r.value = String(Math.round(hs?.target || 0));
      card.querySelector('[data-v="set"]').textContent = ctDeg(+r.value);
    }
  }
  // Bed, fans, light.
  const bed = st?.bed;
  $("ct-bed-t").textContent = ctDeg(bed?.temp);
  $("ct-bed-target").textContent = bed?.target > 0 ? `→ ${ctDeg(bed.target)}` : tr("ctl.off");
  ctGauge($("ct-bed-gauge"), bed?.temp, bed?.target, cfg?.bed_max || 100);
  ctSyncRange($("ct-bed-set"), Math.round(bed?.target || 0), $("ct-bed-set-v"), ctDeg);
  ctSyncRange($("ct-fan"), Math.round((st?.part_fan || 0) * 100), $("ct-fan-v"), (v) => `${fmtNum(v)} %`);
  ctSyncRange($("ct-cfan"), Math.round((st?.chamber_fan || 0) * 100), $("ct-cfan-v"), (v) => `${fmtNum(v)} %`);
  if (document.activeElement !== $("ct-light")) $("ct-light").checked = !!st?.light;
  if (document.activeElement !== $("ct-purifier")) $("ct-purifier").checked = !!st?.purifier;
  // What can run now: one action at a time, and the printer's rules.
  box.querySelectorAll("[data-act]").forEach((b) => {
    const kind = b.dataset.act;
    const opts = { n: b.dataset.n == null ? null : +b.dataset.n, axis: b.dataset.axis, dist: b.dataset.sign ? +b.dataset.sign * CT.step : 0 };
    const why = kind === "emergency_stop" ? (st || CT.cfg ? "" : "ctl.why.offline") : CT.busy ? "ctl.why.busy" : ctlWhy(kind, st, cfg, opts);
    b.disabled = !!why;
    if (why) b.title = tr(why, { t: fmtNum(Math.round(cfg?.heads.find((h) => h.index === opts.n)?.min_extrude_temp || 170)) });
    else if (b.dataset.tip) b.title = b.dataset.tip;
    else if (!b.classList.contains("ct-jog")) b.removeAttribute("title");
  });
  const ranges = [
    ...[...box.querySelectorAll("[data-temp]")].map((r) => [r, "nozzle_temp", +r.dataset.temp]),
    [$("ct-bed-set"), "bed_temp", null], [$("ct-fan"), "part_fan", null], [$("ct-cfan"), "chamber_fan", null],
  ];
  for (const [r, kind, n] of ranges) r.disabled = !!CT.busy || !!ctlWhy(kind, st, cfg, { n });
  $("ct-light").disabled = !!ctlWhy("light", st, cfg);
  $("ct-purifier").disabled = !!CT.busy || !!ctlWhy("purifier", st, cfg);
}

function ctSyncRange(r, v, label, fmt) {
  if (document.activeElement === r || r.dataset.drag) return;
  r.value = String(v);
  label.textContent = fmt(v);
}

/* A round gauge: the temperature's share of the heater's maximum, its
   colour from heating to ready. */
function ctGauge(el, temp, target, max) {
  el.style.setProperty("--p", String(ctlPct(temp, max)));
  el.style.setProperty("--t", String(ctlPct(target, max)));
  el.dataset.heat = ctlHeat(temp || 0, target || 0);
}

/* ------------------------------------------------------------ actions */

const CT_CONFIRM = {
  emergency_stop: ["ctl.confirm.estop_t", "ctl.confirm.estop", "ctl.estop_ok"],
  motors_off: ["ctl.confirm.motors_t", "ctl.confirm.motors", "ctl.motors_off"],
  firmware_restart: ["ctl.confirm.restart_t", "ctl.confirm.restart", "ctl.restart"],
};

/* Runs an action; while it runs everything else waits. */
async function ctRun(action, label) {
  const pid = CT.pid;
  const stop = action.kind === "emergency_stop";
  if (!pid || (CT.busy && !stop)) return;
  const c = CT_CONFIRM[action.kind];
  if (c && !(await confirmDelete(tr(c[0]), tr(c[1]), tr(c[2])))) return;
  if (!stop) CT.busy = { label };
  ctUpdate();
  try {
    await invoke("control_run", { printerId: pid, action });
  } catch (e) {
    toast(String(e), true);
  } finally {
    if (!stop) CT.busy = null;
    if (CT.pid === pid) {
      await ctRead();
      ctUpdate();
      // A spool went in or out.
      if (action.kind === "load" || action.kind === "unload") ctSlots();
    }
  }
}

function ctLabel(kind, n, extra) {
  const key = { home: "ctl.doing.home", jog: "ctl.doing.jog", tool: "ctl.doing.tool", load: "ctl.doing.load", unload: "ctl.doing.unload", extrude: "ctl.doing.extrude", retract: "ctl.doing.retract", clean: "ctl.doing.clean", purge_position: "ctl.doing.purge", heaters_off: "ctl.doing.off", motors_off: "ctl.doing.motors", firmware_restart: "ctl.doing.restart" }[kind];
  return key ? tr(key, { n, ...extra }) : tr("ctl.doing.any");
}

$("ct-body").addEventListener("click", (e) => {
  if (e.target.closest("[data-ct-help]")) return ctHelp();
  if (e.target.closest("[data-ct-retry]")) {
    CT.err = null;
    ctUpdate();
    return ctRead(true);
  }
  const step = e.target.closest("[data-step]");
  if (step) {
    CT.step = +step.dataset.step;
    localStorage.setItem("snapstudio.ctl.step", String(CT.step));
    return ctUpdate();
  }
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled) return;
  const kind = b.dataset.act;
  const n = b.dataset.n == null ? undefined : +b.dataset.n;
  if (kind === "jog") {
    const dist = +b.dataset.sign * CT.step;
    return ctRun({ kind, axis: b.dataset.axis, dist }, ctLabel(kind, n, { axis: b.dataset.axis.toUpperCase(), d: fmtDec(dist, CT.step < 1 ? 1 : 0) }));
  }
  if (kind === "home") return ctRun({ kind, axes: b.dataset.axes }, ctLabel(kind, n, { axes: b.dataset.axes.toUpperCase() }));
  const action = { kind };
  if (n !== undefined) action.n = n;
  ctRun(action, ctLabel(kind, n));
});

/* Sliders: the value follows the drag; the printer gets it on release. */
$("ct-body").addEventListener("input", (e) => {
  const r = e.target;
  if (r.type !== "range") return;
  r.dataset.drag = "1";
  const v = +r.value;
  if (r.dataset.temp != null) r.closest(".ct-head").querySelector('[data-v="set"]').textContent = ctDeg(v);
  else if (r.id === "ct-bed-set") $("ct-bed-set-v").textContent = ctDeg(v);
  else if (r.id === "ct-fan") $("ct-fan-v").textContent = `${fmtNum(v)} %`;
  else if (r.id === "ct-cfan") $("ct-cfan-v").textContent = `${fmtNum(v)} %`;
});
$("ct-body").addEventListener("change", (e) => {
  const r = e.target;
  delete r.dataset.drag;
  const v = +r.value;
  if (r.dataset.temp != null) return ctRun({ kind: "nozzle_temp", n: +r.dataset.temp, temp: v }, tr("ctl.doing.temp", { n: r.dataset.temp, t: fmtNum(v) }));
  if (r.id === "ct-bed-set") return ctRun({ kind: "bed_temp", temp: v }, tr("ctl.doing.bed", { t: fmtNum(v) }));
  if (r.id === "ct-fan") return ctRun({ kind: "part_fan", pct: v }, tr("ctl.doing.fan"));
  if (r.id === "ct-cfan") return ctRun({ kind: "chamber_fan", pct: v }, tr("ctl.doing.fan"));
  if (r.id === "ct-light") return ctRun({ kind: "light", on: r.checked }, tr("ctl.doing.light"));
  if (r.id === "ct-purifier") return ctRun({ kind: "purifier", on: r.checked }, tr("ctl.doing.purifier"));
  if (r.id === "ct-cam-sw") return r.checked ? ctCamStart() : ctCamStop();
});

/* ------------------------------------------------------------ help */

/* The heads' buttons explained: what each does, the U1 command, when it
   is greyed out; then what holds for all of them. */
function ctHelp() {
  const rows = ["temp", "tool", "load", "unload", "extrude", "retract"].map((k) => `<div class="ct-help-row">
      <b>${esc(tr(`ctl.help.${k}_t`))}</b>
      <span>${esc(tr(`ctl.help.${k}`))}</span>
      <small>${esc(tr(`ctl.help.${k}_when`))}</small>
    </div>`).join("");
  const notes = ["greyed", "one", "idle", "commands"].map((k) => `<li>${esc(tr(`ctl.help.note_${k}`))}</li>`).join("");
  $("cthelp-body").innerHTML = `<div class="ct-help-list">${rows}</div><ul class="ct-help-notes">${notes}</ul>`;
  openSheet($("cthelp"));
}
$("cthelp-close").addEventListener("click", () => closeSheet($("cthelp")));

/* ------------------------------------------------------------ camera */

/* The printer's camera, small: the same feed as the printer page (woken by
   camera_start, a JPEG read again in a loop, kept awake every 10 s). */
async function ctCamStart() {
  const pid = CT.pid;
  if (!pid) return;
  ctCamStop();
  Object.assign(CT.cam, { on: true, pid });
  $("ct-cam-sw").checked = true;
  $("ct-cam-note").textContent = tr("printers.cam.starting");
  $("ct-cam-box").classList.add("on");
  try {
    await invoke("camera_start", { printerId: pid });
  } catch (e) {
    ctCamStop();
    $("ct-cam-note").textContent = String(e);
    return;
  }
  if (!CT.cam.on || CT.pid !== pid) return;
  CT.cam.keep = setInterval(() => invoke("camera_start", { printerId: pid }).catch(() => {}), 10000);
  ctCamNext();
}
function ctCamNext() {
  if (!CT.cam.on) return;
  $("ct-cam-img").src = schemeUrl("cam", `/f?id=${encodeURIComponent(CT.cam.pid)}&n=${++CT.cam.n}`);
}
function ctCamStop() {
  const c = CT.cam;
  clearTimeout(c.timer);
  clearInterval(c.keep);
  if (c.on && c.pid) invoke("camera_stop", { printerId: c.pid }).catch(() => {});
  Object.assign(c, { on: false, pid: null, timer: 0, keep: 0 });
  const sw = $("ct-cam-sw");
  if (!sw) return;
  sw.checked = false;
  $("ct-cam-box").classList.remove("on");
  $("ct-cam-img").removeAttribute("src");
  $("ct-cam-note").textContent = tr("ctl.cam_off");
}
$("ct-body").addEventListener("load", (e) => {
  if (e.target.id !== "ct-cam-img" || !CT.cam.on) return;
  $("ct-cam-note").textContent = "";
  CT.cam.timer = setTimeout(ctCamNext, 200);
}, true);
$("ct-body").addEventListener("error", (e) => {
  if (e.target.id !== "ct-cam-img" || !CT.cam.on) return;
  $("ct-cam-note").textContent = tr("printers.cam.retry");
  CT.cam.timer = setTimeout(ctCamNext, 1000);
}, true);

/* Spools changed (heads.js): the cards' colours follow. */
window.addEventListener("headschange", () => ctOn() && ctUpdate());
window.addEventListener("langchange", () => {
  if (!ctOn()) return;
  CT.built = null;
  ctBuild();
  ctUpdate();
});
