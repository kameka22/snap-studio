# Calibration tab (Care & Tuning)

## Goal

A fourth tab, **Calibration**, in Printer › Care & Tuning (next to Control,
Care and Bed Leveling), with guided assistants that are simple to use and
explained with drawings. Scope and order come from draft PR #38. This plan
covers the mockups, the flow of each assistant, the commands behind each
step, the safety rules and, above all, **what the Snapmaker U1 really allows**
(see "U1 compatibility"). That section changed the design: the scope's
"PID then `SAVE_CONFIG`" flow does not match the U1, the bed's PID is locked,
and the XYZ offset routine is better left to the touchscreen.

Mockup: [`docs/mockups/calibration-tab/index.html`](../mockups/calibration-tab/index.html)
(open it in a browser; the bar at the bottom switches screen, theme and
language). Screenshots, 1440 × 900, French UI, sample data for one U1 named
"U1"; `shoot.sh` redraws them with headless Chrome:

| File | Screen |
|---|---|
| `home-{light,dark}-fr.png`, `home-light-en.png` | Tab home: what the U1 already does, four assistant cards |
| `pid-1-choose-{light,dark}-fr.png` | PID 1/4: pick the nozzle on a drawing, measurement temperature |
| `pid-2-prepare-light-fr.png` | PID 2/4: illustrated checklist |
| `pid-2-confirm-light-fr.png` | PID: confirmation before launch (the result overwrites at once) |
| `pid-3-run-{light,dark}-fr.png` | PID 3/4: live temperature curve, progress, cancel, emergency stop |
| `pid-4-result-light-fr.png`, `pid-4-result-dark-en.png` | PID 4/4: before / new values in plain words |
| `is-1-prepare-light-fr.png` | Vibration compensation 1/3: X/Y and accelerometer drawing, checklist |
| `is-3-result-{light,dark}-fr.png` | Vibration compensation 3/3: frequency charts, chosen filter |
| `xyz-current-light-fr.png` | Offset between heads: current offsets, how to rerun from the screen |
| `refused-printing-{light,dark}-fr.png` | Refused: print running, same status line as Maintenance / Control |

Everything is built on `ui/style.css` (cards, `.ct-status`, `.ct-estop`,
`.seg`, `input.sw`, `.mt-stale`, `.modal`); the new pieces are prefixed
`cb-` in `mock.css`. Drawings are inline SVG coloured with the theme's
variables, so they follow light and dark.

## UX flow

### Tab home

- The same status bar as Control (state dot, chips, emergency stop).
- A banner: **what the U1 already does by itself** (bed mesh before every
  print, dynamic flow at print start when ticked on the screen, results kept
  in the printer), and when these assistants are useful.
- Four cards, each with a drawing, one line on what and why, the last
  result and its date, the duration and one button:
  1. **Vibration compensation** (input shaper), ≈ 5 min, *Start*.
  2. **Dynamic flow (K)**, ≈ 3 min 30 per head, *Start*.
  3. **Offset between heads**, 15–20 min, *View* (result + how to run it
     from the touchscreen; see why below).
  4. **Nozzle PID**, ≈ 5 min per nozzle, badge *Advanced*, *Start*.
- Order: most useful first. PID is last because Snapmaker does not expose
  it and its result cannot be undone from the app.

### Nozzle PID (4 steps)

1. **Choose**: the four heads drawn side by side (the chosen one glows) and
   a picker with each head's spool; the bed drawn locked ("factory-tuned,
   locked by the firmware"). Temperature: presets PLA 220 / PETG 250 /
   ABS·ASA 270 / TPU 230 and a slider (180–300 °C, the heater's
   `max_temp` is 300). Default from the loaded filament. Optional switch:
   "All 4 nozzles in a row".
2. **Prepare**: illustrated checklist. Printer idle (checked by the app),
   nozzle clean (user ticks), part fan off (handled by the app), don't touch
   the head and don't start anything on the touchscreen (user ticks).
3. **Confirm** (sheet): "T1 will heat to 220 °C… The result immediately
   replaces T1's current settings in the printer's memory." Then
   **Calibrate**: live temperature curve (target band, current point,
   heat-up then cycles), progress by cycles (6 cycles = 12 peaks), elapsed /
   remaining, *Cancel calibration*, emergency stop in the status bar.
4. **Result**: "New T1 settings saved, already active, no restart"; Kp, Ki,
   Kd before / new with a plain-words label each and a one-sentence
   reading. **No `SAVE_CONFIG`** (see compatibility).

### Vibration compensation (3 steps)

1. **Prepare**: top-view drawing (gantry, head T0 with its accelerometer,
   X and Y arrows), how it works in two sentences, checklist (idle, clear
   bed, homing and T0 done by the U1, it gets loud). Notes it is the same
   measurement as the touchscreen's Vibration Compensation.
2. **Measure**: progress per axis (X then Y), same live layout as PID
   (not drawn separately).
3. **Result**: one chart per axis (measured vibrations, what is left after
   the filter, the chosen frequency), X and Y values with the previous
   ones, a plain-words reading, and *Restore previous values*.

### Dynamic flow (K)

Card only in this round (the flow follows the PID pattern): choose heads
(only heads with a declared filament), prepare (filament loaded and
declared, purge chute clear), run head by head, result per head (new K, the
filament it belongs to). Flagged to the user as the third priority.

### Offset between heads

A read-only screen: current offset of T1–T3 from T0 (X, Y, Z), worst gap,
date; the three steps to rerun it **on the touchscreen**; the drawing of
how it measures. No *Start* in v1 (see compatibility).

### Refused / unavailable

When the printer prints, is paused, runs one of its routines or is
offline: the status line used by Maintenance and Control
(`offlineLine` / `.ct-status.off-status`) with the reason, cards greyed and
their buttons disabled, last results still shown with the `.mt-stale` line.

## Safety rules (shared with Control)

- Every machine action goes through `ctlRun` (`ui/control.js`) and
  `control.rs`: **one action at a time** per printer, confirmations, the
  **emergency stop always available** (never queued). New `Action` kinds:
  `pid_calibrate { n, target }`, `shaper_calibrate`, `flow_calibrate { n }`.
  `control.rs` builds the G-code and refuses what the rules forbid; the UI
  never sends raw G-code.
- **Refused while printing or paused**, or when the U1 is not idle:
  `print_stats.state` not in `standby / complete / cancelled / error`, or
  `machine_state_manager.main_state` not `IDLE` (the U1 enters
  `SHAPER_CALIBRATE`, `FLOW_CALIBRATION`, `XYZ_OFFSET_CALIBRATE`,
  `BED_LEVELING`… during its own routines), or `idle_timeout.state` is
  `Printing`.
- **Homing**: the shaper and flow commands home by themselves on the U1
  (`G28` / `G28 X Y` in the firmware); PID needs none. The app does not
  add its own homing.
- **Idle timeout**: Klipper turns heaters and motors off after 300 s of
  inactivity (`[idle_timeout] timeout: 300`). The long commands keep
  Klipper busy, so the risk is between steps (a preheated nozzle waiting
  on the checklist): the app does not preheat before launch, and the
  wizard footer reminds it.
- Cancel = Klipper's own interrupt path; if it does not stop cleanly,
  `TURN_OFF_HEATERS`; the emergency stop is `M112` as in Control.
- A calibration in progress survives leaving the tab (state read from
  Moonraker); the app keeps the last result and its date per printer.

## U1 compatibility

Sources read on 2026-10-28:

- **Snapmaker/u1-klipper** (public, "Klipper firmware for Snapmaker U1"),
  commit `93cb12f` "Release firmware version 2.0.0":
  <https://github.com/Snapmaker/u1-klipper/tree/93cb12faebf6e74c51bbc5f0be66e95124af14c8>.
  Its reference config is `lava/printer.cfg` and
  `lava/xyz_offset_calibration.cfg` (the U1's own config may differ: every
  config fact below is marked **check on the U1**).
- **Snapmaker/OrcaSlicer** tag `v2.4.0`: U1 machine profile
  `resources/profiles/Snapmaker/machine/Snapmaker U1 (0.4 nozzle).json`
  and the Calibration menu in `src/slic3r/GUI/MainFrame.cpp`.
- Snapmaker support / forum / wiki pages linked per item below.

Labels: **Confirmed** (read in Snapmaker's sources or docs), **Inferred**
(deduced from the code, not stated), **Check on the U1** (with the query
to run; `<ip>` is the printer's address).

### Heater and object names

| Item | Value | Status |
|---|---|---|
| Nozzle heaters | `extruder`, `extruder1`, `extruder2`, `extruder3` (T0–T3) | Confirmed in `lava/printer.cfg` and the index map in `probe_inductance_coil.py` |
| Bed heater | `heater_bed` | Confirmed (`lava/printer.cfg`) |
| Machine state | object `machine_state_manager`, field `main_state` (`IDLE`, `PRINTING`, `XYZ_OFFSET_CALIBRATE`, `BED_LEVELING`, `FLOW_CALIBRATION`, `SHAPER_CALIBRATE`, …) | Confirmed (`klippy/extras/machine_state_manager.py`) |
| Idle timeout | 300 s | Confirmed in the reference config; check: `GET http://<ip>/printer/objects/query?configfile=settings` → `settings.idle_timeout.timeout` |

### 1. Nozzle PID

- **Commands**: `PID_CALIBRATE HEATER=extruder1 TARGET=220` (Klipper's
  command, kept by Snapmaker). Optional `PROFILE=` (`default`, `pid2`,
  `pid3`); the app uses `default`. No `SAVE_CONFIG`.
- **Where the result goes (Confirmed,
  [`pid_calibrate.py`](https://github.com/Snapmaker/u1-klipper/blob/93cb12faebf6e74c51bbc5f0be66e95124af14c8/klippy/extras/pid_calibrate.py),
  [`heaters.py`](https://github.com/Snapmaker/u1-klipper/blob/93cb12faebf6e74c51bbc5f0be66e95124af14c8/klippy/extras/heaters.py))**:
  unless the heater has `ignore_pid_json: True`, Snapmaker's
  `PID_CALIBRATE` writes the values at once to
  `<config dir>/snapmaker/<heater>_pid_parameters.json` and applies them
  live; at start-up that JSON **wins over** `printer.cfg`. So
  `SAVE_CONFIG` is not needed, would restart Klipper for nothing and would
  write values that the JSON overrides anyway. A user on Reddit reports
  the same files (`extruder2_pid_parameters.json`), unofficial:
  <https://www.reddit.com/r/snapmaker/comments/1rtak9c/u1_pid_calibration/>.
- **Bed (Confirmed in the reference config, check on the U1)**:
  `[heater_bed]` has `allow_pid_calibrate: False` and
  `ignore_pid_json: True`; `PID_CALIBRATE HEATER=heater_bed` then fails
  with "PID calibration is not allowed". **The bed is not offered.** Check:
  `GET http://<ip>/printer/objects/query?configfile=settings` →
  `settings.heater_bed.allow_pid_calibrate` (expect `false`) and
  `settings.extruder.allow_pid_calibrate` / `ignore_pid_json` (expect
  absent or `true` / `false`).
- **Previous values (Inferred)**: Klipper exposes no live Kp/Ki/Kd. The app
  can show the factory values (`configfile.settings.extruder.pid_kp` …,
  33.540 / 9.317 / 30.186 in the reference config) and its own history of
  results; the values inside the JSON are not readable through Klipper
  objects. Check whether Moonraker serves them:
  `GET http://<ip>/server/files/list?root=config` and look for
  `snapmaker/extruder_pid_parameters.json`.
- **Undo (Inferred)**: no command writes Kp/Ki/Kd (only `SET_PID_PROFILE`
  selects a profile). Undo would mean editing that JSON (Moonraker file
  upload + firmware restart): not in v1; the confirmation says so.
- **Snapmaker docs**: no PID calibration in the official U1 calibration
  pages (Home Calibration & Manual Leveling, Dynamic Flow Calibration,
  Multi-toolhead Offset Calibration, Vibration Compensation:
  <https://support.snapmaker.com/hc/en-us/sections/36143450884119-Calibration>).
  The hotend is factory-tuned and sold as a single unit
  (<https://wiki.snapmaker.com/en/FAQ/u1>).
- **Risk**: overwrites the per-nozzle tuning with no undo from the app.
  Hence the *Advanced* badge, last position, the confirmation sheet, and a
  plain "useful after a hotend swap or if it swings". Also: PID does not
  put the U1 in a calibration `main_state`, so the touchscreen would still
  accept a print meanwhile: the checklist asks not to touch the screen
  (**check on the U1** whether the screen blocks itself while a heater is
  under `PID_CALIBRATE`).
- **Orca**: Orca's Calibration menu (Temperature, Flow rate, Pressure
  advance, Retraction, Max flowrate, Cornering, Input Shaping, VFA) has no
  PID: no overlap.
- **Check the command exists**: `GET http://<ip>/printer/gcode/help` →
  `PID_CALIBRATE`, `SET_PID_PROFILE`.

### 2. Vibration compensation (input shaper)

- **Command**: `SHAPER_CALIBRATE` (both axes; Confirmed,
  [`resonance_tester.py`](https://github.com/Snapmaker/u1-klipper/blob/93cb12faebf6e74c51bbc5f0be66e95124af14c8/klippy/extras/resonance_tester.py)).
  Snapmaker's version sets `main_state` to `SHAPER_CALIBRATE`, homes with
  `G28` if needed, picks T0 (`T0 A0`) and uses the accelerometer in T0
  (`accel_chip: … e0_accelerometer`, LIS2DW or SC7A20).
  `SM_FAST_SHAPER_CALIBRATE` exists but is marked "not used yet" in the
  source: it only sweeps ±10 Hz around the current values. **Not used.**
- **What it does with the result (Confirmed)**: for each axis it applies
  the result at once through `SET_INPUT_SHAPER`, which on the U1 also
  **saves** it to `<config dir>/snapmaker/input_shaper.json`
  ([`input_shaper.py`](https://github.com/Snapmaker/u1-klipper/blob/93cb12faebf6e74c51bbc5f0be66e95124af14c8/klippy/extras/input_shaper.py));
  the classic `SAVE_CONFIG` hint is commented out. The shaper type is
  forced to `fixed_shaper` (default `mzv`) and a frequency outside
  `shaper_freq_*_min/max` (reference: X 47.5–62.5 Hz, Y 43–54 Hz) falls
  back to the default (X 54, Y 47.5). The UI says so in plain words.
- **Chart (Confirmed path, check on the U1)**: the CSV goes to
  `log_path: /userdata/gcodes/shaper_calibrate` →
  `calibration_data_x_<name>.csv` / `_y_`. If that is Moonraker's
  `gcodes` root, the app downloads it and draws the chart. Check:
  `GET http://<ip>/server/files/directory?path=gcodes/shaper_calibrate`.
  The console lines `Recommended shaper_type_x = …` and `Selected …` are a
  fallback.
- **Previous values / restore (Confirmed command, Inferred flow)**:
  `input_shaper` has no Klipper status; `SET_INPUT_SHAPER` with no
  parameter prints the current values in the console. Before launching,
  the app runs it and keeps the answer; *Restore previous values* sends
  `SET_INPUT_SHAPER SHAPER_TYPE_X=mzv SHAPER_FREQ_X=… SHAPER_TYPE_Y=mzv
  SHAPER_FREQ_Y=…` (which saves them again). Check in the console:
  `SET_INPUT_SHAPER`.
- **Duration (Confirmed)**: ≈ 5 min with homing, 3 min 41 s without
  (<https://forum.snapmaker.com/t/u1-faq-official-info-summary/39648/25>).
- **Overlap**: same routine as the screen's *Settings › Maintenance ›
  Device Calibration › Vibration Compensation*
  (<https://support.snapmaker.com/hc/en-us/articles/36143420606231-Vibration-Compensation>,
  <https://forum.snapmaker.com/t/snapmaker-u1-official-video-guides/39977>).
  Both write the same file: no conflict, the last run wins. The card says
  "Also on the U1 screen".
- **Orca conflict (Confirmed in code, flag to users)**: Orca's *Input
  Shaping Frequency / Damping* test prints emit `SET_INPUT_SHAPER`
  (`src/libslic3r/GCodeWriter.cpp`, Snapmaker fork v2.4.0). On the U1 that
  command **persists**, so after such a test print the last tested value
  stays saved. The assistant's result screen and the plan's "To validate"
  list mention it; Snap Studio could warn when it sees that test.

### 3. Offset between heads (XYZ)

- **Firmware routine (Confirmed,
  [`xyz_offset_calibration.cfg`](https://github.com/Snapmaker/u1-klipper/blob/93cb12faebf6e74c51bbc5f0be66e95124af14c8/lava/xyz_offset_calibration.cfg),
  [`probe_inductance_coil.py`](https://github.com/Snapmaker/u1-klipper/blob/93cb12faebf6e74c51bbc5f0be66e95124af14c8/klippy/extras/probe_inductance_coil.py))**:
  `XYZ_OFFSET_CALIBRATE_ALL` = `T0 A0`, `G0 Z2`, then
  `XYZ_OFFSET_CALIBRATE` per head (a macro around
  `PROBE_XYZ_OFFSET_CALIBRATE … HORIZONTAL_MOVE_X=13 HORIZONTAL_MOVE_Y=234.5
  PROBE_POINTS=10 …`), then `EXTRUDER_OFFSET_ACTION_SAVE_RESULT FORCE_SAVE=0`.
  It needs Z homed ("Must home before probe"). Each head probes 10 points
  and the firmware fits a circle's centre. Results are written to
  `extruder_base_position.json` (or `SAVE_CONFIG RESTART=0` only when
  that backup file does not exist) and exposed per head as
  `extruder.extruder_offset`.
- **Physical method (Inferred)**: the nozzle touches a fixed reference at
  the back left (X 13, Y 234.5) and the contact sensor in the head (an
  inductance coil facing the hotend's copper plate) feels each touch. The
  wiki's troubleshooting gives the copper plate / sensor gap (0.1–0.4 mm):
  <https://wiki.snapmaker.cn/en/snapmaker_u1/troubleshooting/multi-color_misalignment>.
  The reference's exact shape is not documented; the drawing stays
  generic.
- **The touchscreen does more**: its assistant runs the
  `EXTRUDER_OFFSET_ACTION_*` sequence (`PRESTART`, `PREHEAT`, `HEAT`,
  `AUTO_CLEAN` / `MANUAL_CLEAN`, `WAIT_COOL` per head, `DETECT_PLATE`,
  `PROBE_CALIBRATE`, `SAVE_RESULT`, `EXIT`) with its own parameters
  (temperatures, `SAFE_MOVE_Y_POS`, plate check), which the reference
  config only shows commented out. Snapmaker asks to unload and clean the
  nozzles first
  (<https://support.snapmaker.com/hc/en-us/articles/36143460809367-Multi-toolhead-Offset-Calibration>).
  `XYZ_OFFSET_CALIBRATE_ALL` alone **skips heating, cleaning and the plate
  check** and then **overwrites** every head's base position: a dirty
  nozzle gives a wrong offset and collisions or misaligned colours.
- **Decision**: **no Start in v1.** The screen shows the current offsets
  (read-only) and how to run it from the touchscreen. A later version can
  drive the full `EXTRUDER_OFFSET_ACTION_*` sequence once its parameters
  are read on a real U1.
- **Check on the U1**:
  `GET http://<ip>/printer/objects/list` → `gcode_macro
  XYZ_OFFSET_CALIBRATE_ALL`, `extruder_offset_calibration`;
  `GET http://<ip>/printer/objects/query?extruder=extruder_offset&extruder1=extruder_offset&extruder2=extruder_offset&extruder3=extruder_offset`;
  and, to learn the screen's own parameters, run the touchscreen
  calibration once with Fluidd's console open and copy the commands it
  logs.
- **Not to confuse** with the pick & park coordinates (Homing Calibration
  on the screen, `extruder_config.json`):
  <https://wiki.snapmaker.com/en/snapmaker_u1/troubleshooting/u1_how_to_adjust_the_pick_and_park_coordinates>.
  Out of scope.

### 4. Dynamic flow (K / pressure advance)

- **Commands (Confirmed,
  [`flow_calibrator.py`](https://github.com/Snapmaker/u1-klipper/blob/93cb12faebf6e74c51bbc5f0be66e95124af14c8/klippy/extras/flow_calibrator.py))**:
  `T<n>` then `FLOW_CALIBRATE` (calibrates the **active** head).
  Outside a print it needs the head's filament declared
  (`print_task_config.filament_type[n]` not `NONE`, else error 523/39),
  allowed for that filament, and filament present (motion sensor). It sets
  `main_state` `FLOW_CALIBRATION`, homes X/Y, moves to the purge position
  (`MOVE_TO_DISCARD_FILAMENT_POSITION`), heats to the filament's built-in
  print temperature, extrudes and measures with the head's sensor.
  Related: `FLOW_RESET_K EXTRUDER=n` (back to the filament's default K),
  `FLOW_APPLY_CALIBRATE_K EXTRUDER=n` (what `PRINT_START` calls).
- **Storage (Confirmed)**: K is kept **per head** (extruder name) in
  `<config dir>/snapmaker/flow_calibrator.json`, not per filament profile.
  Snapmaker's FAQ: the value belongs to the loaded filament and resets to
  the default K when the filament is unloaded
  (<https://forum.snapmaker.com/t/u1-faq-official-info-summary/39648/25>).
  Live value: `extruder.pressure_advance` (check:
  `GET http://<ip>/printer/objects/query?extruder=pressure_advance&extruder1=pressure_advance`).
- **At print start (Confirmed)**: the U1 profile's start G-code calls
  `SM_PRINT_FLOW_CALIBRATE EXTRUDER=0..3` (Snapmaker OrcaSlicer v2.4.0,
  `Snapmaker U1 (0.4 nozzle).json`); the firmware only calibrates when the
  screen's *Dynamic Flow Calibration* is ticked (`print_task_config`
  flag `flow_calibrate`; the link to the screen option is Inferred) and
  skips a head already calibrated in that print. The `SM_PRINT_*` macros are not in the public
  repo (**check on the U1**: `GET http://<ip>/printer/objects/list` →
  `gcode_macro sm_print_flow_calibrate`).
- **Value added**: the screen can't calibrate a single head in a
  multi-colour job (FAQ above); the app can, head by head, without
  printing. 1 head ≈ 3 min 30, 4 heads ≈ 14 min 40 (same FAQ).
- **Overlap / risk**: same storage as the screen's routine (last run wins,
  no conflict). Orca's *Pressure advance* test prints set
  `SET_PRESSURE_ADVANCE` in the G-code: they test values for one print and
  don't touch `flow_calibrator.json` (Inferred). Uses filament (purge).
- **Check on the U1**: run `T1` then `FLOW_CALIBRATE` from the Fluidd
  console with a declared filament, then read `extruder1.pressure_advance`.

### Summary

| Assistant | Offered | Main command | Saves to | Undo | Conflicts / risks |
|---|---|---|---|---|---|
| Vibration compensation | Yes | `SHAPER_CALIBRATE` | `snapmaker/input_shaper.json` (auto) | Yes, `SET_INPUT_SHAPER` with the old values | Same as the screen's; Orca's IS test prints persist their last value |
| Dynamic flow (K) | Yes | `T<n>` + `FLOW_CALIBRATE` | `snapmaker/flow_calibrator.json` per head (auto) | `FLOW_RESET_K` (filament default) | Same as print-start calibration; resets on unload |
| Offset between heads | Read-only + touchscreen steps | (screen) `EXTRUDER_OFFSET_ACTION_*` | `extruder_base_position.json` | No | Bare `XYZ_OFFSET_CALIBRATE_ALL` skips cleaning: not offered |
| Nozzle PID | Yes, Advanced | `PID_CALIBRATE HEATER=extruderN TARGET=…` | `snapmaker/extruderN_pid_parameters.json` (auto) | No (from the app) | Not exposed by Snapmaker; no `SAVE_CONFIG` |
| Bed PID | **No** | — | — | — | Locked by the firmware (`allow_pid_calibrate: False`) |

## Open questions for the user

1. **PID temperatures**: presets PLA 220 / PETG 250 / ABS·ASA 270 /
   TPU 230 °C (Snapmaker's own figures: PLA 220, ABS 280 in the U1 FAQ's
   power table). Keep, or always use the loaded filament's temperature?
2. **All four nozzles in a row** (≈ 20 min): keep the switch, or one
   nozzle at a time only?
3. **PID at all?** Snapmaker does not expose it and the app cannot undo
   it. Keep it as *Advanced* (proposed), hide it behind a setting, or drop
   it?
4. **Part fan during PID**: off (proposed, simplest) or at a fixed speed?
5. **XYZ offsets**: OK to keep v1 read-only with the touchscreen steps?
6. **Flow**: mockups for its steps in the next round, or straight to code
   after PID and the shaper?

## To validate on the real machine

Run each query of the compatibility section on a U1 with the current
firmware, then:

- `PID_CALIBRATE HEATER=heater_bed TARGET=60` is refused.
- After `PID_CALIBRATE HEATER=extruder1 TARGET=220`, the JSON file exists
  and the values survive a firmware restart without `SAVE_CONFIG`.
- The shaper CSV is downloadable from Moonraker; `SET_INPUT_SHAPER` alone
  prints the current values.
- `FLOW_CALIBRATE` runs outside a print on one head.
- What the touchscreen shows while the app runs `PID_CALIBRATE`.
