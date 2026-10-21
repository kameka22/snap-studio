"use strict";
/* Care & Tuning › Control: the pure part, tested by scripts/test-control.js.
   The same rules as control.rs, so the interface greys out what the
   printer would refuse and says why; control.rs checks them again.

   `st`: control_read's state, `cfg`: its configuration (control.rs). */

const CTL_STEPS = [0.1, 1, 10, 50];
const CTL_Z_FLOOR = 0.5;
const CTL_Z_STEP_MAX = 10;
/* On a U1 the head docks sit behind the bed. */
const CTL_U1_Y_MAX = 270;

const ctlHomed = (st) => !!st && ["x", "y", "z"].every((a) => (st.homed || "").includes(a));
const ctlPrinting = (st) => ["printing", "paused"].includes(st?.state);
const ctlMachineBusy = (st) => !!st?.main_state && st.main_state !== "IDLE";

/* The travel range of an axis (0 x, 1 y, 2 z): the printer's, Z never
   under the floor, Y in front of a U1's head docks. */
function ctlRange(cfg, i) {
  const min = i === 2 ? Math.max(cfg.min[2], CTL_Z_FLOOR) : cfg.min[i];
  const max = i === 1 && cfg.u1 ? Math.min(cfg.max[1], CTL_U1_Y_MAX) : cfg.max[i];
  return [min, max];
}

/* Why an action cannot run now: an i18n key (ctl.why.*), or "" when it
   can. `kind` as control.rs's Action; `n` the head, `axis` and `dist` a jog. */
function ctlWhy(kind, st, cfg, { n = null, axis = null, dist = 0 } = {}) {
  if (!st || !cfg) return "ctl.why.offline";
  if (kind === "emergency_stop") return "";
  if (kind === "light") return cfg.light ? "" : "ctl.why.missing";
  if (ctlPrinting(st)) return "ctl.why.printing";
  if (kind === "firmware_restart") return "";
  if (ctlMachineBusy(st)) return "ctl.why.machine";
  const head = n == null ? null : cfg.heads.find((h) => h.index === n);
  if (n != null && !head) return "ctl.why.missing";
  if (kind === "chamber_fan" && !cfg.chamber_fan) return "ctl.why.missing";
  if (kind === "purifier" && !cfg.purifier) return "ctl.why.missing";
  if (kind === "jog") {
    if (!ctlHomed(st)) return "ctl.why.home";
    const i = ["x", "y", "z"].indexOf(axis);
    if (i < 0 || !CTL_STEPS.some((s) => Math.abs(Math.abs(dist) - s) < 1e-9)) return "ctl.why.limit";
    if (i === 2 && Math.abs(dist) > CTL_Z_STEP_MAX) return "ctl.why.zstep";
    const [min, max] = ctlRange(cfg, i);
    const to = st.position[i] + dist;
    return to < min - 1e-6 || to > max + 1e-6 ? "ctl.why.limit" : "";
  }
  if (["tool", "unload", "clean", "purge_position"].includes(kind) && !ctlHomed(st)) return "ctl.why.home";
  if (kind === "extrude" || kind === "retract") {
    const h = st.heads.find((x) => x.index === n);
    if (!h || h.temp < head.min_extrude_temp) return "ctl.why.cold";
    if (st.active !== n && !ctlHomed(st)) return "ctl.why.home";
  }
  if (kind === "tool" && st.active === n) return "ctl.why.active";
  return "";
}

/* The machine's state in a word for the status bar: offline, printing,
   paused, busy (a U1 procedure), idle. */
function ctlStateOf(st) {
  if (!st) return "offline";
  if (st.state === "printing") return "printing";
  if (st.state === "paused") return "paused";
  if (ctlMachineBusy(st)) return "busy";
  return "idle";
}

/* A temperature's share of its scale, for the gauges (0–1). */
const ctlPct = (v, max) => (max > 0 ? Math.max(0, Math.min(1, (v || 0) / max)) : 0);

/* A heater heating, cooling or steady: for its gauge's colour. */
function ctlHeat(temp, target) {
  if (!(target > 0)) return temp > 45 ? "cooling" : "off";
  return Math.abs(temp - target) <= 3 ? "ready" : temp < target ? "heating" : "cooling";
}

if (typeof module !== "undefined")
  module.exports = { CTL_STEPS, CTL_Z_FLOOR, CTL_U1_Y_MAX, ctlHomed, ctlRange, ctlWhy, ctlStateOf, ctlPct, ctlHeat };
