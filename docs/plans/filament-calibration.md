# Filament calibration tests (Care & Tuning › Calibration)

Status: **analysis only**. No code yet. Follow-up of draft PR #38.

## Request

Raised in the official Snapmaker Discord (`#third-party-software`,
<https://discord.com/channels/1086575708903571536/1391158072210096288>),
messages from the user "Somebody" on 2026-10-27, around 20:23 and 21:27
(Paris time). Somebody prints in Brazil with **local filament brands**
that have no profile and no reference values online: the generic profiles
are a starting point, and the right temperature, flow or retraction has to
be found by printing.

The request: **guided filament tests in the style of OrcaSlicer**, in
**Entretien et réglages › Calibration** (Care & Tuning › Calibration):
temperature tower, flow rate, retraction, max volumetric speed…, with the
result **saved into a custom filament profile**.

Not to redo what the U1 already does at print start: per-filament **flow
and pressure advance** calibration.

## Where it fits

- **#17** (merged): Care & Tuning › Control and the command service
  (`ui/control.js`: `CTL`, `ctlRead`, `ctlRun`, `ctlSubscribe`, `ctlSpool`;
  `src-tauri/src/control.rs`: `Action`, `busy_printing`, the U1's
  `main_state`).
- **#38** (draft, scope only, one empty commit): the **Calibration** tab in
  Care & Tuning, with guided Klipper assistants: PID, then wrappers around
  the U1's input shaper and XYZ offsets, then flow / K. It says:
  *"Orca-style filament tests are out of scope for the first version."*
  **This plan is that next version.** It reuses #38's tab, its step-by-step
  assistant layout and its safety rules, and adds a **Filament** section
  next to #38's **Machine** section.
- **Full Spectrum color calibration** (draft PR #70,
  `full-spectrum-calibration.md`): same "print a test, read it, save the
  result" loop for colors. The two share the job tag and the result sheet
  pattern described below.

## What the U1 already does (left out)

- **Pressure advance per head and filament**: the U1's `flow_calibrator`
  (`FLOW_CALIBRATE`, `FLOW_MEASURE_K`), run at print start when the "flow
  calibration" option is on. Snap Studio already sends that option
  (`printers.rs` `StartOptions.flow_calibration` → `flow_calibrate`
  preference; switch `#snd-flow` in the slice sheet). So **no pressure
  advance test** here (Orca's PA line / pattern / tower), and the tests
  below are printed **with the U1's own calibration on**, so their K is the
  one real prints get.
- Note on words: the U1 calls this "flow calibration", but what it measures
  is K (pressure advance). The **flow ratio** (extrusion multiplier,
  `filament_flow_ratio`) is a slicer value the U1 does not touch, so its
  test stays in scope. Checked on a U1: `PRINT_START` only runs
  `FLOW_APPLY_CALIBRATE_K EXTRUDER=<i>` per head (plus `M220 S100`), no
  `M221`, so the extrusion multiplier is left alone.
- Bed mesh (#21), bed knobs (#32), XYZ offsets, input shaper: machine
  calibration, #38's side.

## The tests

Order from OrcaSlicer's own
[calibration guide](https://www.orcaslicer.com/wiki/guides/calibration_guide)
("each test builds on the results of the ones before it"), minus pressure
advance:

| # | Test | Orca's model and method (Snapmaker Orca `v2.4.0`) | Reads | Saved as |
|---|---|---|---|---|
| 1 | **Temperature tower** ([Orca wiki](https://www.orcaslicer.com/wiki/calibration/temp_calib)) | `resources/calib/temperature_tower/temperature_tower.stl`, cut to the range; `GCode.cpp` sets the temperature at each 10 mm block, −5 °C per block (`Calib_Temp_Tower`) | The best block (stringing, bridges, overhangs, layer adhesion) | `nozzle_temperature`, `nozzle_temperature_initial_layer` |
| 2 | **Max volumetric speed** ([Orca wiki](https://www.orcaslicer.com/wiki/calibration/volumetric_speed_calib.html)) | `volumetric_speed/SpeedTestStructure.step`, spiral vase, `filament_max_volumetric_speed` lifted to 200 for the test, wall speed rising with Z (`Plater::calib_max_vol_speed`, `Calib_Vol_speed_Tower`) | The height where the wall fails, with calipers: `start + height × step` | `filament_max_volumetric_speed` (result − 10 to 20 %, as the wiki advises) |
| 3 | **Flow ratio** | `filament_flow/flowrate-test-pass1.3mf` then `pass2.3mf` (or `Orca-LinearFlow*.3mf`): one block per value, each with its own `print_flow_ratio` object setting (`Plater::calib_flowrate`) | The smoothest top surface; pass 1 coarse, pass 2 fine | `filament_flow_ratio` (base × chosen factor) |
| 4 | **Retraction** ([Orca wiki](https://github.com/orcaslicer/orcaslicer/wiki/retraction_calib)) | `retraction/retraction_tower.stl`; `GCode.cpp` changes `retraction_length` every mm of height (`Calib_Retraction_tower`), default 0 to 2 mm by 0.1 for direct drive (the U1 is) | The lowest clean section | `filament_retraction_length` |

Later, if asked: VFA (a machine artefact more than a filament one),
tolerance, Orca's "fine" passes for temperature.

## Proposed UX

In **Care & Tuning › Calibration** (#38), a **Filament** section:

1. **Choose the filament**: the head (T0–T3) and its spool (`ctlSpool`,
   color and material as read by the U1), and the **base profile**, the
   one the head uses today (`headsProfile`). A banner when the spool is a
   generic profile: « Pas de profil pour cette marque : les tests partent du
   profil générique PLA ».
2. **The four tests as cards**, in order, each with: what it finds (one
   line), its duration and filament (from the slice), its state (À faire /
   Imprimé / Résultat saisi), and its result once entered. The order is
   advised, not enforced: a user who already knows the temperature can
   start at the flow ratio.
3. **A test**, the same step-by-step layout as #38's assistants:
   explanation → parameters with defaults (temperature range from the
   profile's `nozzle_temperature_range_low/high`, step 5 °C; MVS 5 → 20
   mm³/s by 0.5; flow pass 1, then pass 2 around the result; retraction 0 →
   2 mm by 0.1) → prerequisites (printer idle, bed clear, the plate type)
   → **Lancer**: slice and send, the print followed live in the card
   (progress, layer, the block being printed and its value).
4. **Reading the result**: a drawing of the printed model with its blocks
   labeled (« 215 °C », « +5 % »…): the user clicks the best one. For the
   MVS, a height field (mm) and the computed value next to it, the same
   formula as Orca. A photo is not needed.
5. **The profile in progress**: a summary card with the base profile, the
   values found so far, and their changes (« 210 → 220 °C »). **Enregistrer
   le profil** asks for a name, prefilled « <Marque> <Matière> (calibré) »,
   saves, and offers « Utiliser pour T2 ».

The same printed test can be read later from its record in **Prints**
(« Saisir le résultat »), because the job remembers it is a calibration.

## Data and storage

- **The profile**: a **user filament preset**, written as Orca writes its
  own user presets, a differential (`inherits` the base preset + the
  changed keys), in Snap Studio's own folder
  `<config>/fr.carlini.snapstudio/profiles/filament`, never in Snapmaker
  Orca's. Today only process presets are written
  (`presets::save_user_process`); a `save_user_filament` is the same code
  for `Kind::Filament` (same name checks, a user base flattened into the
  new preset, `compatible_printers` as `declare_compatible` does). Once
  saved, the index is read again and the preset appears under « Vos
  profils » in the head's profile picker (`headsPickProfile`, `p.user`).
- **The session** (tests printed, values read, not yet saved): small,
  per printer and head, in `localStorage` (`snapstudio.fcal`), dropped
  when the profile is saved or the spool changes.
- **The job**: `jobs.rs` gets an optional `calibration` tag (`kind`, head,
  parameters: start, end, step) so Prints can offer « Saisir le résultat »
  and the tab can show the test as printed. Old records read without it
  (serde default).
- The spool inventory of #19 can later point a spool to its calibrated
  profile.

## Technical approach

### Why not the engine's own calibration

Orca's tests are **GUI-only**: `Plater::calib_temp`, `calib_flowrate`,
`calib_max_vol_speed`, `calib_retraction` load the model, set the configs
and pass `Calib_Params` to the print; `GCode.cpp` then changes the
temperature, speed or retraction per layer. The command-line engine has no
calibration option (no `calib` in `src/OrcaSlicer.cpp` at `v2.4.0`), so
`--slice` never runs these branches. Snap Studio does the same thing in
two existing places:

1. **Config overrides and per-object settings** (what the slice request
   already carries): spiral vase, `filament_max_volumetric_speed` = 200,
   `max_volumetric_extrusion_rate_slope` = 0, wipe off for the retraction
   test; and per-object `print_flow_ratio` for the flow blocks, written in
   `Metadata/model_settings.config` by `write3mf.rs` as the pillars of #37
   already are (`plate.rs` `pillar_settings`, `pillar_object`).
2. **A G-code pass after slicing** (Snap Studio already rewrites the
   G-code: `gcode_thumbs.rs` embeds the images), on the engine's layer
   change comments, inserting per Z band:
   - temperature: `M104 T<n> S<t>` (Klipper's M104 takes the head index),
     the same values as `Calib_Temp_Tower`;
   - max volumetric speed: the wall sliced at the start speed, then
     `M220 S<pct>` per layer so the speed follows
     `start + z × step` (in vase mode the whole layer is the wall), with a
     comment per layer giving the flow for the reading;
   - retraction: the U1 has no firmware retraction (checked on a U1: no
     `firmware_retraction` in `printer/objects/list`), so the retract /
     unretract `E` moves are rewritten per band (wipe off makes them
     single `G1 E` lines).

### Models

Orca's four models are in Snapmaker Orca's `resources/calib/` (AGPL, like
the plate assets we already use), but our slimmed engine drops them
(`engine/keep.txt` is an allow list). Two ways:

- add `resources/calib/{temperature_tower,filament_flow,volumetric_speed,retraction}/**`
  to `keep.txt` (macOS under `Contents/Resources/`), which needs a new
  engine package from the Engine CI and an `engine.json` bump; about
  12 MB, mostly the temperature tower STL (5 MB) and the speed structure
  STEP (2.3 MB, the engine reads STEP);
- or generate simple equivalents in Rust (a block tower with an overhang
  and a bridge, a cylinder for the vase, nine flat blocks, two pillars).

Recommended: **keep Orca's models** (known and documented by the Orca
wiki, so the user's readings match its guide), through `keep.txt`.

### Machine side

- The tests are ordinary prints: they go through the normal slice and send
  path (`slice.rs`, `printers.rs`), not through `ctlRun`. The command
  service is reused for the **state and refusals** (`ctlSubscribe`,
  `ctlState`; refused while printing or paused, or when `main_state` is not
  `IDLE`, as `control.rs` already does), the spool (`ctlSpool`), and the
  emergency stop always visible.
- One head per test, the others idle; the prime tower off (one material).

### Profile writing

`presets.rs` `save_user_filament(index, name, base, values)` + a Tauri
command; the values: `nozzle_temperature`, `nozzle_temperature_initial_layer`
(same offset as in the base), `filament_max_volumetric_speed`,
`filament_flow_ratio`, `filament_retraction_length` (arrays of one value,
as Orca stores filament keys), plus `filament_vendor` from the spool.

### Tests

- `cargo test --lib`: the G-code pass (temperature per block, `M220` per
  layer, retraction per mm, idempotent, nothing outside the bands), the
  per-object flow ratio in `model_settings.config`, `save_user_filament`
  (differential, refused names, user base flattened), old job records
  without the tag.
- An ignored engine test per kind (as the existing `engine_*` tests): the
  slice runs and the G-code holds the expected commands.
- `scripts/test-fcal.js`: block ↔ value mapping, MVS formula, defaults from
  the profile, session reset on a spool change.
- `scripts/check-i18n.py`: en and fr.

## Open questions

Answered on a U1: the start-of-print calibration only applies K (no
`M221`), so the flow ratio test stays; no `[firmware_retraction]`, so the
retraction test rewrites the `E` moves.

1. `M104 T<n>` against the U1's own heater names: same as Control's
   `NozzleTemp` action, to reuse its command.
2. Must the tab wait for #38's machine assistants, or can the Filament
   section ship first with a minimal tab? #38 has no code yet.
3. Keep the session per head, or per spool (a spool moved to another head
   keeps its tests)?

## Difficulty

**Overall: medium to hard.** The slicing, sending, job records and
per-object settings exist; the new pieces are the G-code pass, the
profile writing, the four assistants and the engine package change. The
retraction test is the risky one (E moves rewritten in the G-code, no
firmware retraction on the U1).

- Tab shell, if #38 has not landed: +1 day.
- Temperature tower + G-code pass + profile writing + summary card:
  ~2.5 days.
- Max volumetric speed (same pass): +1 day.
- Flow ratio, two passes: +1 day.
- Retraction: +1.5–2 days.
- Engine package with the models: +0.5 day.

**Recommended first version (temperature, max volumetric speed, flow
ratio): medium, ~5–6 days**, after #38's tab. With retraction: **~7–8
days**.

## Depends on

- **#38** (Calibration tab and its assistant layout). #38 itself builds on
  #17's command service (merged).
