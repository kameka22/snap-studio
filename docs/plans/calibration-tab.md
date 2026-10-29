# Calibration tab (Care & Tuning)

## Goal

A fourth tab, **Calibration**, in Printer › Care & Tuning (next to Control,
Care and Bed Leveling), with guided assistants that are simple to use and
explained with drawings. Scope and order come from draft PR #38. This plan
covers the mockups, the flow of each assistant, the commands behind each
step, the safety rules and, above all, **what the Snapmaker U1 really allows**
(see "U1 compatibility"). That section changed the design: the scope's
"PID then `SAVE_CONFIG`" flow does not match the U1, the bed's PID is locked,
and the XYZ offset routine is better left to the touchscreen. Round 2
answers the six open questions with sources (A–D below), adds the flow
assistant and both PID modes, and lists where every displayed value comes
from. Nothing is implemented before the user validates mockups and specs.

Mockup: [`docs/mockups/calibration-tab/index.html`](../mockups/calibration-tab/index.html)
(open it in a browser; the bar at the bottom switches screen, theme and
language). Screenshots, 1440 × 900, French UI, sample data for one U1 named
"U1"; `shoot.sh` redraws them with headless Chrome. **Every number on the
screens is sample data**; where each one comes from on a real U1 is in
"Data sources and checks" below.

| File | Screen |
|---|---|
| `home-{light,dark}-fr.png`, `home-light-en.png` | Tab home: what the U1 already does, four assistant cards |
| `pid-1-choose-{light,dark}-fr.png` | PID 1/4, mode *One nozzle*: pick it on the drawing, temperature from its filament, presets, slider |
| `pid-1-choose-all-light-fr.png` | PID 1/4, mode *All 4 in a row*: one temperature per head from its declared filament |
| `pid-2-prepare-light-fr.png` | PID 2/4: checklist (idle, clean nozzle, part fan reads 0 %, hands off) |
| `pid-2-confirm-light-fr.png` | PID: confirmation (overwrites at once, no undo, current values read first) |
| `pid-3-run-{light,dark}-fr.png` | PID 3/4, one nozzle: live curve, cycles, cancel, emergency stop |
| `pid-3-run-all-light-fr.png` | PID 3/4, all 4: queue (done / running / waiting) |
| `pid-4-result-light-fr.png`, `pid-4-result-dark-en.png` | PID 4/4: values read before vs new, plain words, no restore button |
| `is-1-prepare-light-fr.png` | Vibration compensation 1/3: X/Y and accelerometer drawing, checklist |
| `is-3-result-{light,dark}-fr.png` | Vibration compensation 3/3: frequency charts, chosen filter, restore |
| `flow-1-choose-{light,dark}-fr.png`, `flow-1-choose-light-en.png` | Flow 1/4: heads with declared filament, current K, temperature |
| `flow-2-prepare-light-fr.png` | Flow 2/4: idle, filament loaded and declared, waste bin, homing |
| `flow-3-run-{light,dark}-fr.png` | Flow 3/4: head 1 of 2, measurement points on the K chart |
| `flow-4-result-{light,dark}-fr.png` | Flow 4/4: old vs new K per head, out-of-range fallback, reset to default |
| `xyz-current-light-fr.png` | Offset between heads: current offsets (read-only), screen assistant vs bare command, how to rerun |
| `refused-printing-{light,dark}-fr.png` | Refused: print running, same status line as Maintenance / Control |

Everything is built on `ui/style.css` (cards, `.ct-status`, `.ct-estop`,
`.seg`, `input.sw`, `.mt-stale`, `.modal`); the new pieces are prefixed
`cb-` in `mock.css`. Drawings are inline SVG coloured with the theme's
variables, so they follow light and dark.

## UX flow

### Tab home

- The same status bar as Control (state dot, chips, emergency stop).
- A banner: **what the U1 already does by itself** (bed mesh and dynamic
  flow at print start when ticked on the screen, results kept in the
  printer), and when these assistants are useful.
- Four cards, each with a drawing, one line on what and why, the last
  result and its date, the duration and one button:
  1. **Vibration compensation** (input shaper), ≈ 5 min, *Start*.
  2. **Dynamic flow (K)**, ≈ 3 min 30 per head, *Start*; current K per head.
  3. **Offset between heads**, 15–20 min, *View* (result + how to run it
     from the touchscreen; see why below).
  4. **Nozzle PID**, ≈ 5 min per nozzle, badge *Advanced*, *Start*.
- Order: most useful first. PID is last because Snapmaker does not support
  it on the U1 and its result cannot be undone from the app.

### Nozzle PID (4 steps, two modes)

1. **Choose**: segmented control *One nozzle* / *All 4 in a row*.
   - *One nozzle*: the four heads drawn side by side (the chosen one
     glows), a picker with each head's declared filament, the bed drawn
     locked ("locked by the firmware, not offered"). Temperature: default =
     Snapmaker's print temperature for the declared filament; presets PLA
     220 / PETG 255 / ABS 270 / ASA 260 / TPU 240 °C and a slider
     180–290 °C (the heater's `max_temp` is 300).
   - *All 4*: one line per head with its temperature (declared filament,
     PLA 220 when none is declared); ≈ 20 min; one heater at a time.
   - A warning: Snapmaker does not offer PID on the U1 (official FAQ); the
     result can't be undone from the app.
2. **Prepare**: idle (app), nozzle clean (user), **part fan of that head
   reads 0 %** (app reads it, does not drive it; offers to stop it if not
   0), hands off and nothing started on the screen (user).
3. **Confirm** (sheet): overwrites at once, no undo; Snap Studio first
   reads and keeps the current values to compare. Then **Calibrate**: live
   curve, cycles (12 peaks), elapsed / remaining, *Cancel calibration*,
   emergency stop. In *All 4* a queue shows done / running / waiting; each
   head is saved as soon as it ends, a cancel keeps the finished ones.
4. **Result**: "New T1 settings saved, already active, no restart"; Kp,
   Ki, Kd **before** (read from the U1 before the run) / new, a plain-words
   label each. No restore button (see C below). **No `SAVE_CONFIG`.**

### Vibration compensation (3 steps)

1. **Prepare**: top-view drawing (gantry, head T0 with its accelerometer,
   X and Y arrows), how it works in two sentences, checklist (idle, clear
   bed, homing and T0 done by the U1, it gets loud). Same measurement as
   the touchscreen's Vibration Compensation.
2. **Measure**: progress per axis (X then Y), same live layout as PID
   (not drawn separately).
3. **Result**: one chart per axis, X and Y values with the previous ones,
   a plain-words reading, and *Restore previous values*.

### Dynamic flow (K) (4 steps)

1. **Choose**: heads with a declared filament (an undeclared head is greyed
   with "declare it on the U1 screen"), each with its filament, current K
   (calibrated / default) and Snapmaker's temperature for that filament.
2. **Prepare**: idle (app), filament loaded and declared (app: motion
   sensor + `print_task_config`), waste bin in place (user), homing and
   head pick done by the U1.
3. **Measure**: head n of N, measure k of 4–5 on a chart (K tested vs
   pressure too low / too high), phases: homing + bin, heat, measuring
   extrusions, compute + save + back to rest.
4. **Result**: table old K → new K per head; out of range → "the U1 applied
   Snapmaker's default for this filament"; the setting follows the
   **head** and goes back to default when its filament changes;
   *Reset T1 to default* (`FLOW_RESET_K`) and *Done*.

### Offset between heads

Read-only: current X/Y offset of each head **from the centre of the four
heads** and Z **from T0**, worst gap, date; a side-by-side "screen
assistant vs bare command"; the two steps to rerun it **on the
touchscreen**; the drawing of how it measures. No *Start* in v1 (see D).

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

`K` = <https://github.com/Snapmaker/u1-klipper/blob/93cb12faebf6e74c51bbc5f0be66e95124af14c8/>
below (u1-klipper @ `93cb12f`); `M` =
<https://github.com/Snapmaker/u1-moonraker/blob/a308cfae31b7eb70ebf96bc73e6968d9792e4d73/>
(u1-moonraker @ `a308cfa`, "Release firmware version 2.0.0").

- **Commands (Confirmed)**: `PID_CALIBRATE HEATER=extruder1 TARGET=220`;
  parameters `HEATER`, `TARGET`, `WRITE_FILE`, `PROFILE` (default
  `default`) (`K/klippy/extras/pid_calibrate.py` L16-20). The app uses
  `default` and never sends `SAVE_CONFIG`. *All 4* = four commands queued
  by the app, one after the other (one heater at a time).
- **Where the result goes (Confirmed)**: the console prints
  `PID parameters: pid_Kp=… pid_Ki=… pid_Kd=…` (L47-50); the values are
  also staged for `SAVE_CONFIG` (L51-57); unless the heater has
  `ignore_pid_json: True` they are written at once to
  `<config dir>/snapmaker/<heater>_pid_parameters.json` as
  `{"default": {"Kp", "Ki", "Kd", …}, "pid2": …}` and applied live when the
  active profile is the one tuned (L59-87). At start-up the JSON **wins
  over** `printer.cfg`; a missing JSON is recreated from `printer.cfg`
  (`K/klippy/extras/heaters.py` L253-325); the active profile is reset to
  `default` at every start (L327). The config dir is the folder of
  `printer.cfg` (`K/klippy/klippy.py` L47-52, L85-86). A Reddit user sees
  the same files (unofficial):
  <https://www.reddit.com/r/snapmaker/comments/1rtak9c/u1_pid_calibration/>.
- **Bed (Confirmed in the reference config, check on the U1)**:
  `[heater_bed]` has `allow_pid_calibrate: False`, `ignore_pid_json: True`
  (`K/lava/printer.cfg` L210-227); `PID_CALIBRATE HEATER=heater_bed` fails
  with "PID calibration is not allowed" (`pid_calibrate.py` L28-29,
  `heaters.py` L63). **The bed is not offered.** Staff confirm the bed is
  PID-controlled: <https://forum.snapmaker.com/t/u1-faq-official-info-summary/39648/5>.
- **Factory values (Confirmed in the reference config)**: all four
  extruders `pid_Kp 33.540`, `pid_Ki 9.317`, `pid_Kd 30.186`, `max_temp
  300` (`printer.cfg` `[extruder]` L666-691, `[extruder1]` L831,
  `[extruder2]` L970, `[extruder3]` L1108).
- **Side effect to know (Confirmed in code)**: `SHAPER_CALIBRATE` on the U1
  is a macro that ends with `SAVE_CONFIG RESTART=0`
  (`K/lava/fluidd.cfg` L187-191). Anything staged by an earlier
  `PID_CALIBRATE` in the same Klipper session is then written to the
  `printer.cfg` autosave block (`configfile.py` L394-443, with a
  `printer-YYYYMMDD_HHMMSS.cfg` backup). The JSON still wins at start-up,
  so this is harmless while the JSON exists, but it becomes the value used
  to recreate the JSON if it is ever deleted. Snap Studio does not act on
  it; it is documented here only.
- **Risk**: overwrites the per-nozzle tuning with no undo from the app.
  Hence the *Advanced* badge, last position, the confirmation sheet. PID
  does not set a calibration `main_state`, so the touchscreen might still
  accept a job meanwhile (**check on the U1**).
- **Orca**: Orca's Calibration menu (Temperature, Flow rate, Pressure
  advance, Retraction, Max flowrate, Cornering, Input Shaping, VFA) has no
  PID: no overlap.

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
  the classic `SAVE_CONFIG` hint is commented out. But the U1's
  `SHAPER_CALIBRATE` is a macro that runs the base command then
  `SAVE_CONFIG RESTART=0` (`lava/fluidd.cfg` L187-191): it also writes any
  pending config change (e.g. an earlier PID) to `printer.cfg`, without
  restarting. The shaper type is
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
  `extruder.extruder_offset`: X/Y relative to the centre of the four heads'
  positions, Z relative to T0 (`extruder.py` L704-728).
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
  (wiki troubleshooting above; the support article
  36143460809367 is a video with no text).
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
  In code, `FLOW_RESET_K` runs when the head's filament info changes (RFID
  read, `SET_PRINT_FILAMENT_CONFIG`, reload check:
  `print_task_config.py` L314-371, L585-708, L853-886); whether a plain
  unload triggers it is **check on the U1**.
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
- **Value added (smaller than first thought)**: the 2025 FAQ said the
  screen can't calibrate a single head in a multi-colour job, but firmware
  V1.1.0 "Added selective flow calibration. Users can choose specific
  toolhead(s)"
  (<https://wiki.snapmaker.com/en/snapmaker_u1/firmware/release_notes/v110>).
  What the app still adds: calibrate **without starting a print**, see old
  vs new K per head, reset a head to default. 1 head ≈ 3 min 30, 4 heads ≈
  14 min 40 (FAQ above).
- **Overlap / risk**: same storage as the screen's routine (last run wins,
  no conflict). Orca's *Pressure advance* test prints set
  `SET_PRESSURE_ADVANCE` in the G-code: they test values for one print and
  don't touch `flow_calibrator.json` (Inferred). Uses filament (purge).
- **Check on the U1**: run `T1` then `FLOW_CALIBRATE` from the Fluidd
  console with a declared filament, then read `extruder1.pressure_advance`.


### Summary

| Assistant | Offered | Main command | Saves to | Undo | Conflicts / risks |
|---|---|---|---|---|---|
| Vibration compensation | Yes | `SHAPER_CALIBRATE` | `snapmaker/input_shaper.json` (auto) | Yes, `SET_INPUT_SHAPER` with the old values | Same as the screen's; Orca's IS test prints persist their last value; macro ends with `SAVE_CONFIG RESTART=0` |
| Dynamic flow (K) | Yes | `T<n>` + `FLOW_CALIBRATE` | `snapmaker/flow_calibrator.json` per head (auto) | `FLOW_RESET_K` (filament default) | Same as print-start calibration; resets when the head's filament changes |
| Offset between heads | Read-only + touchscreen steps | (screen) `EXTRUDER_OFFSET_ACTION_*` | `extruder_base_position.json` | No | Bare `XYZ_OFFSET_CALIBRATE_ALL` skips cleaning: not offered |
| Nozzle PID | Yes, Advanced | `PID_CALIBRATE HEATER=extruderN TARGET=…` | `snapmaker/extruderN_pid_parameters.json` (auto) | No (old values read and shown; re-run) | Not supported by Snapmaker; no `SAVE_CONFIG`; a later `SHAPER_CALIBRATE` writes the pending values to `printer.cfg` |
| Bed PID | **No** | — | — | — | Locked by the firmware (`allow_pid_calibrate: False`) |


## Answers to the round-1 questions

Labels as above: **Confirmed**, **Inferred**, **Check on the U1**.
Question 1 → A, 4 → B, 3 → C, 5 → D. Question 2 (one nozzle or all
four): both modes, see the PID flow. Question 6: flow mockups are in this
round, and nothing is coded before mockups and specs are validated.

### A. Which temperature for PID?

- **Snapmaker**: no recommendation, because the U1 officially does not
  support hot-end PID tuning. Wiki FAQ: "Does the Snapmaker U1 support PID
  tuning for the hot end? No, the Snapmaker U1 does not support PID tuning
  for the hot end at this time."
  (<https://wiki.snapmaker.com/en/FAQ/u1#does-the-snapmaker-u1-support-pid-tuning-for-the-hot-end>,
  Confirmed). The 220 °C / 280 °C figures on the same page are a **power
  consumption** table ("Single-Color PLA Printing … Nozzle 220 … Bed 65"),
  not PID advice. No U1 PID article on support.snapmaker.com (searched
  2026-10-28). On the forum, staff only say they'll forward a community
  request to the wiki team
  (<https://forum.snapmaker.com/t/pid-autotune/43024>, Confirmed).
- **Klipper docs**: example `PID_CALIBRATE HEATER=extruder TARGET=170`,
  then `SAVE_CONFIG`; bed `TARGET=60`
  (`K/docs/Config_checks.md` L125-146, same text upstream). A generic
  example, not a recommendation for a temperature. Klipper's LCD menu
  uses 210 / 60 (`K/klippy/extras/display/menu.cfg` L693/699), but the U1 has
  no `[display]` (Confirmed), so it is not used.
- **Firmware code**: no PID macro or default target anywhere in
  u1-klipper (Confirmed by search). `PID_CALIBRATE` heats at full power
  and swings ±5 °C around the target for 12 peaks
  (`pid_calibrate.py` L89, L113-137).
- **Community (unofficial)**: a Reddit macro linked from the forum thread
  runs `PID_CALIBRATE … TARGET=260` on each head then `SAVE_CONFIG`
  (<https://www.reddit.com/r/SnapmakerU1/comments/1vq4yrf/i_made_a_pid_autotune_macro/>,
  read from search snippets; Reddit blocks fetching).
- **Recommendation (Inferred)**: tune at the temperature the head will
  print at. Default = Snapmaker's own print temperature for the filament
  declared on that head, from the firmware's filament table
  (`K/klippy/extras/filament_parameters.py`, `STANDARD_04`): generic PLA
  220 (L234), Snapmaker PLA Matte 215 (L252), PETG 255 (L340/L352), ABS
  270 (L398), ASA 260 (L421), TPU 240 (L437), PA 260 (L478), PC 280
  (L528). Presets PLA 220 / PETG 255 / ABS 270 / ASA 260 / TPU 240; slider
  180–290 °C, below `max_temp` 300. That table is not exposed to Moonraker
  (`get_status` returns `{}`, L1612-1613), so the app ships the same
  values and labels them "Snapmaker defaults".

### B. Part fan during PID?

- **Snapmaker**: no PID routine, so no stated rule (Confirmed, A).
- **Firmware code**: `pid_calibrate.py` never touches a fan (Confirmed).
  The hot-end fan is a `heater_fan` that runs by itself above 45 °C
  (`[heater_fan e0_nozzle_fan]`, `printer.cfg` L738-746). Snapmaker's own
  routines use the part fan only to **cool down** before probing
  (`SET_FAN_SPEED FAN=cavity_fan SPEED=1`, `M106 S255`, `M109 … S130`, then
  off: `K/lava/xyz_offset_calibration.cfg` L290-340).
- **Klipper docs**: silent (Confirmed). Community macro: no fan commands.
- **Recommendation (Inferred)**: Snap Studio does **not** drive the fans
  during PID, like the bare command. Before launch it reads the part fan
  of that head (`fan.speed` for T0; `fan_generic e1_fan` / `e2_fan` /
  `e3_fan` `.speed` for T1–T3, `printer.cfg` L729, L894, L1033, L1171) and
  blocks the step if it is not 0, with a *Stop the fan* button:
  `M107` (T0, `K/klippy/extras/fan.py` L199-212: without `P` it drives
  `[fan]`) or `SET_FAN_SPEED FAN=e1_fan SPEED=0` (`fan_generic.py`
  L17-20). That `eN_fan` = part fan of head N is Inferred from the pins
  (`e1:PB3` like `[fan]` on `e0:PB3`): **check on the U1**.

### C. Undo / restore PID

- **No set command (Confirmed)**: Snapmaker's heaters register only
  `SET_HEATER_TEMPERATURE` and `SET_PID_PROFILE` (`heaters.py` L78-83);
  there is no `SET_HEATER_PID`. `heater.get_status` returns only
  temperature / target / power (L192-198); `configfile.settings` holds the
  `printer.cfg` values, not the JSON ones.
- **Reading the current values (Inferred, check on the U1)**: Moonraker
  registers the `config` root (the `printer.cfg` folder) readable
  (`M/moonraker/components/file_manager/file_manager.py` L173-175), so
  `GET http://<ip>/server/files/config/snapmaker/extruder1_pid_parameters.json`
  should return the JSON. Snap Studio reads it before the run and shows
  "before" from it.
- **Writing it back (Confirmed: possible only in advanced mode; not
  offered)**: the `config` root is writable only when
  `<data_path>/.fluidd` or `/oem/.factory` exists (`M/moonraker/server.py`
  L68-69, L743-752), and heaters load the JSON only at start-up
  (`heaters.py` L253-325), so a restore would be *upload JSON +
  `FIRMWARE_RESTART`*. Not offered in v1.
- **Rejected**: running PID into `PROFILE=pid2` and switching: the
  profile is reset to `default` at each start (`heaters.py` L327).
- **Safest approach (proposal)**: read and keep the old JSON values
  before each run, show old vs new, no restore button; to undo, run the
  calibration again. The plan documents a manual restore (advanced users:
  edit the JSON from Fluidd, then `FIRMWARE_RESTART`).
- **Factory reset**: Moonraker only flags `.factory_reset`
  (`file_manager.py` L235-242); whether the touchscreen's reset deletes
  `snapmaker/*.json` is unknown (**check on the U1**). If it does, the
  JSON is recreated from `printer.cfg` (factory values, or the autosave
  block if a `SAVE_CONFIG` ran, see "Side effect" above). Firmware release
  notes say calibration data are kept across upgrades.

### D. XYZ: "read-only" vs "run from the app"

- **Read-only (v1)**: Snap Studio only reads and shows
  `extruderN.extruder_offset` (`K/klippy/extras/extruder.py` L729-751)
  and the date; it sends nothing. The user runs the calibration on the
  touchscreen.
- **"Run from the app" with the bare command**:
  `XYZ_OFFSET_CALIBRATE_ALL` (`xyz_offset_calibration.cfg` L405-417)
  probes the four heads and saves at once
  (`probe_inductance_coil.py` L1831-1971), but **skips** the
  preheat, heat-and-clean per head, cool-down, plate check and exit
  that the screen assistant runs (`EXTRUDER_OFFSET_ACTION_PRESTART`
  L1431-1455, `PREHOMING` L1457-1493, `DETECT_PLATE` L1495-1596, `HEAT`
  L1665-1695, `AUTO_CLEAN` L1697-1740, `WAIT_COOL` L1742-1778, `EXIT`
  L1973+). Snapmaker asks to unload filament and check the nozzles first
  (<https://wiki.snapmaker.cn/en/snapmaker_u1/troubleshooting/multi-color_misalignment>,
  video guide <https://forum.snapmaker.com/t/snapmaker-u1-official-video-guides/39977>).
  A dirty nozzle gives a wrong offset, saved over the good one.
- **A safe app version** would replay the screen's sequence. The commands
  exist in the code (Confirmed), but the order and parameters the screen
  uses (`PRESENCE` for the plate check, temperatures, `SAFE_MOVE_Y_POS`,
  auto vs manual clean) are not public: the reference `PRESTART` macro has
  every step commented out except preheat and homing (L1-34). Feasible
  later, only after the screen's console log has been captured on a U1.
  Until then: read-only.

## Data sources and checks

Every value shown on the mockups, where a real U1 gives it, and how sure we
are. `Q` = `GET http://<ip>/printer/objects/query?…` (Moonraker);
`F` = `GET http://<ip>/server/files/…`. Values on the PNGs are samples.

| Screen value | Source on the U1 | Status |
|---|---|---|
| Status dot, "Au repos" / refused reason | `Q print_stats=state` + `Q machine_state_manager=main_state,action_code` (`machine_state_manager.py` L322-326) + `Q idle_timeout=state` | Confirmed (code); same as Control |
| "Origine faite" chip | `Q toolhead=homed_axes` | Confirmed (Klipper) |
| Heads T0–T3, which exist | `GET /printer/objects/list` → `extruder`…`extruder3` | Confirmed (`printer.cfg`) |
| Declared filament per head (vendor, type, sub-type, colour) | `Q print_task_config` → `filament_vendor`, `filament_type`, `filament_sub_type`, `filament_color_rgba` lists (`print_task_config.py` L22-63, L529-533) | Confirmed (code); check field names on the U1 |
| "Non déclaré" | `filament_type[n] == "NONE"` | Confirmed (`flow_calibrator.py` L642-712) |
| Filament loaded (flow checklist) | `Q filament_motion_sensor%20e1_filament` → `filament_detected` (`filament_switch_sensor.py` L162-165) | Confirmed (code); check object names |
| Temperature per filament (PID default, flow "Chauffe") | Shipped copy of `filament_parameters.py` `STANDARD_04` (L221-570); not exposed (L1612-1613) | Confirmed values; kept in sync by hand |
| Live nozzle temperature, PID curve | `Q extruder1=temperature,target,power` (`heaters.py` L192-198) | Confirmed |
| PID cycles 3 / 6 | Inferred from the temperature curve (12 peaks, `pid_calibrate.py` L137); no status field | Inferred |
| PID "before" Kp/Ki/Kd | `F config/snapmaker/extruder1_pid_parameters.json` → `default.Kp/Ki/Kd` | Inferred; **check** |
| PID new Kp/Ki/Kd | Console line `PID parameters: pid_Kp=…` (`pid_calibrate.py` L47-50), then re-read the JSON | Confirmed (code) |
| PID "usine" (factory) | `Q configfile=settings` → `settings.extruder1.pid_kp…` compared with the JSON | Inferred |
| PID last date per head | `F list?root=config` → `modified` of the JSON | Inferred; **check** |
| Bed locked | `Q configfile=settings` → `settings.heater_bed.allow_pid_calibrate == false` | Confirmed (reference cfg); **check** |
| Part fan 0 % | `Q fan=speed` (T0), `Q fan_generic%20e1_fan=speed` (T1–T3) | Command Confirmed; fan↔head Inferred; **check** |
| Idle timeout 5 min (footers) | `Q configfile=settings` → `settings.idle_timeout.timeout` (300 in `printer.cfg` L1332-1334) | Confirmed (reference cfg); **check** |
| Shaper X/Y frequency, filter (current) | Console reply of `SET_INPUT_SHAPER` without parameters (`input_shaper.py` L216-223) | Confirmed (code); **check** |
| Shaper charts | CSV in `log_path: /userdata/gcodes/shaper_calibrate` (`printer.cfg` L86) via `F directory?path=gcodes/shaper_calibrate` | Inferred (same folder as Moonraker's `gcodes`?); **check** |
| Shaper durations ≈ 5 min | Staff FAQ (5 min 06 s with homing) | Confirmed (doc) |
| Current K per head | `Q extruder1=pressure_advance` (`extruder.py` L305-307) | Confirmed (code) |
| K "calibré" vs "défaut" | Compare with the filament's default K (`STANDARD_04`, e.g. PLA 0.02, Snapmaker PETG 0.05) | Inferred |
| K range shown (0,005–0,040…) | `STANDARD_04` `flow_k_min/max` per filament | Confirmed (code) |
| Flow measure k, points on the chart | Console `measure k: …`, `measure area: …`, `cali_k: …` (`flow_calibrator.py` L974-1033) | Confirmed (code); format **check** |
| Flow out of range → default | Console `flow k is out of range, use default value:…` (L1163-1176) | Confirmed (code) |
| Flow current head | `main_state FLOW_CALIBRATION`, `action_code EXTRUDER{N}_FLOW_CALIBRATING` (L879-889) | Confirmed (code) |
| Flow durations 3 min 30 / head | Staff FAQ 39648/25 | Confirmed (doc) |
| K reset on filament change | `FLOW_RESET_K` called on RFID / `SET_PRINT_FILAMENT_CONFIG` / reload (`print_task_config.py` L314-371, L585-708, L853-886); FAQ says "once the filament is unloaded" | Code vs doc wording differ; **check** |
| XYZ offsets per head | `Q extruder=extruder_offset&extruder1=…` (`extruder.py` L729-751); X/Y from the centre of the 4 heads, Z from T0 (L704-728) | Confirmed (code) |
| XYZ worst gap | Computed by the app from the offsets | Inferred |
| XYZ date | `F list?root=config` → `modified` of `extruder_base_position.json` (`extruder_config_bak.py` L7) | Inferred; **check** |
| XYZ 15–20 min | Official video guide (forum 39977) | Confirmed (doc) |

## U1 checks to run

Replace `<ip>` with the U1's address. Moonraker queries (browser or curl):

1. `GET http://<ip>/printer/gcode/help` → `PID_CALIBRATE`,
   `SET_PID_PROFILE`, `FLOW_CALIBRATE`, `FLOW_RESET_K`,
   `XYZ_OFFSET_CALIBRATE_ALL` listed.
2. `GET http://<ip>/printer/objects/query?configfile=settings` →
   `heater_bed.allow_pid_calibrate`, `heater_bed.ignore_pid_json`,
   `extruder.pid_kp`, `idle_timeout.timeout`.
3. `GET http://<ip>/server/files/list?root=config` → `snapmaker/` files and
   their `modified` dates.
4. `GET http://<ip>/server/files/config/snapmaker/extruder1_pid_parameters.json`
   → readable, `default.Kp/Ki/Kd`.
5. `GET http://<ip>/printer/objects/query?print_task_config` and
   `?machine_state_manager` → field names and values.
6. `GET http://<ip>/printer/objects/query?extruder=pressure_advance,extruder_offset&extruder1=pressure_advance,extruder_offset`
7. `GET http://<ip>/printer/objects/query?fan&fan_generic%20e1_fan` →
   spin T1's part fan from the screen and see which one moves.
8. `GET http://<ip>/printer/objects/query?filament_motion_sensor%20e1_filament`
9. `GET http://<ip>/printer/objects/query?extruder_offset_calibration`
10. `GET http://<ip>/printer/objects/query?configfile=config` → the
    `gcode_macro SHAPER_CALIBRATE` section with `SAVE_CONFIG RESTART=0`.
11. `GET http://<ip>/server/files/directory?path=gcodes/shaper_calibrate`

Fluidd console (machine idle, nothing on the bed):

12. `SET_INPUT_SHAPER` (no parameters) → prints the current values.
13. `PID_CALIBRATE HEATER=heater_bed TARGET=60` → refused.
14. `PID_CALIBRATE HEATER=extruder1 TARGET=220` with T1 parked → runs; the
    JSON changes; values survive `FIRMWARE_RESTART` without `SAVE_CONFIG`;
    note what the touchscreen shows meanwhile.
15. `T1` then `FLOW_CALIBRATE` with a declared filament → console lines,
    then read `extruder1.pressure_advance`.
16. Unload T1's filament only (no RFID change) → does K go back to
    default?
17. Run the touchscreen's multi-head offset calibration with the console
    open and copy every command it logs.
18. Before / after a touchscreen factory reset (only if planned anyway):
    does `snapmaker/*.json` survive?
