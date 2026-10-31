# Engine: Snapmaker Orca 2.4.0 → 2.4.1

**State: plan, awaiting a go.** Nothing in this plan is implemented: the
bundled engine stays at 2.4.0 (`src-tauri/engine.json`), no engine
workflow was started and no `engine-orca-2.4.1` release exists.

## Goal

Snap Studio bundles Snapmaker Orca's command line as its slicing engine,
pinned to [v2.4.0](https://github.com/Snapmaker/OrcaSlicer/tree/v2.4.0).
Snapmaker released
[v2.4.1](https://github.com/Snapmaker/OrcaSlicer/releases/tag/v2.4.1) on
2026-10-28 (published 04:07 Paris time). Its main change for us is a new
prime tower: the engine now splits its single tower into **blocks, one per
adhesiveness category of material**, which overlaps with what #35 (the
"materials that don't bond" warning) and #37 (one tower per material) do
on our side. This plan lists what changes upstream, what it means for Snap
Studio file by file, the decisions to take, and how to upgrade and test.

## Sources read

- The release notes of
  [v2.4.1](https://github.com/Snapmaker/OrcaSlicer/releases/tag/v2.4.1)
  (English part). The screenshots in the notes are hosted on Feishu and
  could not be opened.
- The compare
  [v2.4.0...v2.4.1](https://github.com/Snapmaker/OrcaSlicer/compare/v2.4.0...v2.4.1)
  through the GitHub API. **The API caps the file list at 300 files**, so
  the list is incomplete. Files were therefore read at both tags directly:
  - `src/libslic3r/PrintConfig.cpp`: every option's default, min and max
    diffed by a script;
  - `src/libslic3r/Print.cpp`, `src/libslic3r/GCode/WipeTower2.cpp`;
  - `src/slic3r/GUI/PartPlate.cpp`;
  - `resources/profiles/Snapmaker/filament/fdm_filament_*_category.json`;
  - every U1 process profile, and the U1 0.4 machine profile.
- Snap Studio at `main` (0.18.0): `src-tauri/engine.json`,
  `scripts/engine.sh`, `.github/workflows/engine.yml`, `ui/tower-logic.js`,
  `ui/prepare-tower.js`, `ui/slice-adv.js`, `ui/speed.js`,
  `ui/spoolcheck.js`, `ui/pillar-logic.js`, `src-tauri/src/slice.rs`,
  `src-tauri/src/plate.rs`, `scripts/test-tower.js`, `scripts/test-adv.js`,
  `scripts/test-pillars.js`, and `docs/plans/prime-tower-per-material.md`.

Nothing was sliced with 2.4.1. Each claim below is marked **verified in
the source** or **from the release notes only**, and the rest are open
questions for the measurements.

## What changes upstream

### 1. A prime tower in blocks, one per adhesiveness category

*Verified in the source.*

- A new filament option, `filament_adhesiveness_category` (an integer per
  filament, default `100`, shown in Developer mode only). Snapmaker's
  filament base profiles set it. The values below are quoted from
  `fdm_filament_<type>_category.json` at v2.4.1:

  | Upstream profile | Category |
  |---|---|
  | `pla`, `pla_cf` (and the other PLA variants) | 100 |
  | `abs`, `asa` | 200 |
  | `petg`, `pet`, `pctg` | 300 |
  | `pa` | 400 |
  | `pc` | 500 |
  | `tpu_90a` | 600 |
  | `pva` | 704 |
  | `support_bvoh` | 797 |

  `fdm_filament_common.json` does not set it, so a filament that does not
  inherit one of these profiles gets the default, **100, the same
  category as PLA**.
- For the U1 and other non-Bambu printers, `Print.cpp` now builds the
  tower with `WipeTower2::generate_new` (2.4.0: `generate`) and passes it
  the categories (`set_filament_categories`). `WipeTower2` keeps one
  `WipeTowerBlock` per category (`get_block_by_category`,
  `add_depth_to_block`). The tower's depth on a layer is **the sum of
  its blocks' depths**, and each tool change purges into its own
  category's block. A layer where a category starts or stops is marked
  `Contact` or `Solid` (solid infill up to 4 layers below). This is
  always on: there is no switch for it.
- New tower "interface" options, all off by default and in Developer
  mode: `enable_tower_interface_features`,
  `enable_tower_interface_cooldown_during_tower`, and per filament
  `filament_tower_interface_pre_extrusion_dist` / `_length` /
  `_print_temp`, plus `filament_tower_ironing_area`. There is also
  `prime_tower_enable_framework` ("Internal ribs", Advanced, off).
- *From the release notes only:* the extruder now goes around the tower
  and enters through the outer wall's opening at tool changes.
- *Open question:* the blocks sit side by side in one tower. Whether
  the tower's outer wall and brim are still shared, so that materials
  that don't bond still touch there, has to be measured (see the test plan).

### 2. Default tower position

*Verified in the source, with a caveat.*

- In the **GUI**, `PartPlateList::set_default_wipe_tower_pos_for_plate`
  now puts a new plate's tower at X 13 and **Y = half the plate depth**
  (2.4.0: Y 214.5). That is the middle of the left edge, the "left-center"
  of the release notes.
- The **engine's** defaults are unchanged: `wipe_tower_x` 15 and
  `wipe_tower_y` 220 in `PrintConfig.cpp`, at both tags.
- **Impact on Snap Studio: none by itself.** We slice with the command
  line, and Prepare always sends its own `wipe_tower_x` / `_y` /
  `_rotation_angle` (`prTowerOverrides`). The 15 / 220 fallback in
  `ptSpot` and the `plate.rs` tests remain the engine's defaults. Adopting
  the new place would be a product choice (decision D3).

### 3. Changed defaults and limits

*Verified with a script that diffs every option of `PrintConfig.cpp`.*

| Key | 2.4.0 | 2.4.1 | Where |
|---|---|---|---|
| `max_bridge_length` | 10 | **0** | engine default |
| `raft_first_layer_expansion` ("Initial layer expansion", raft / support first layer) | 2.0, min 0 | **−1 = auto**, min −1 | engine default |
| `bridge_density` (external) | max 100 % | max **120 %** | engine limit (default 100 % unchanged) |
| `support_threshold_angle` | min 0 | min **1** | engine limit (default 30 unchanged) |
| `bridge_flow` | 0.8 | **1** | U1 profile `0.20mm Standard @Snapmaker U1 (0.4 nozzle)` only (engine default already 1) |
| `bridge_density` | 80 % | **100 %** | same U1 profile only (engine default already 100 %) |

The release notes say "Bridge Flow default 0.8 → 1.0" and "External
Bridge Density 80 → 100". At v2.4.0, though, the engine's defaults are
already 1 and 100 %. What changes is the **U1 0.20 mm Standard 0.4
process profile**, the one #37's measurements used. The other U1 process
profiles don't set these keys.

The release notes call `raft_first_layer_expansion` "First Layer
Expansion". It belongs to rafts and supports. It does not expand the
model's own first layer.

No option was removed. New options:
`bottom_color_penetration_layers`, `top_color_penetration_layers` (set in
every U1 process profile), `first_layer_travel_acceleration`,
`first_layer_travel_jerk`, `support_interface_min_area`,
`support_transition_flow_ratio`, `support_transition_perimeter`,
`support_transition_speed`, `tree_support_transition_layers`, plus the
tower options above.

### 4. U1 profiles

*Verified in the source.*

- **Machine** (`Snapmaker U1 (0.4 nozzle).json`, the other nozzles
  changed too):
  - `change_filament_gcode`:
    - waits for the next head's temperature with **`M104` instead of
      `M109`**, so it no longer blocks;
    - lifts to a safe height in "by object" printing.
  - `machine_end_gcode`: the same safe lift.
  - `machine_start_gcode`:
    - adds a pre-extrusion of the first filament (`SM_PRINT_PREEXTRUDE_FILAMENT`);
    - adds fan commands;
    - changes the chamber settings for the weak cooling mode.
  - *From the release notes only:* this avoids nozzle collisions in
    sequential printing (upstream PR
    [#453](https://github.com/Snapmaker/OrcaSlicer/pull/453)).
- **Process**:
  - `top/bottom_color_penetration_layers` are added everywhere;
  - `filename_format` uses `filament_type[initial_tool]`;
  - `tree_support_branch_angle_organic` is now 45 in `fdm_process_U1_common`;
  - the bridge values above.
- **Filaments**: about 30 U1 filament profiles changed (bed temperatures,
  new colors, per the release notes). They were not diffed one by one.

### 5. Fixes that matter to us

*From the release notes only.* The numbers are those of the "Bug Fixes"
list.

- 38: non-SEMM towers (the U1's) now honor the per-filament minimum
  purge. The larger of the filament's and the tower's value wins.
- 39: colors lost or bleeding after slicing multi-color 3MF files.
- 13: the model's skirt overlapped the tower's skirt.
- 11: gaps in the tower when the purge line spacing isn't 100 %. The first
  layer now always uses 100 %.
- 7, 9: the tower preview size changed with the total number of filaments
  and showed unused filaments. Both concern the GUI only, but they confirm
  the size rules changed.
- 34: a per-object skirt took effect on one object only.
- 6: colors could be missing with filament IDs above 16.

### 6. 3MF compatibility

*From the release notes only:* a 3MF saved by 2.4.1 shows an error when
opened in an older Snapmaker Orca. The release notes put this under the
"First Layer Expansion" change. *Likely reason, not verified:* the new
value −1 is below 2.4.0's minimum of 0 for `raft_first_layer_expansion`.

For Snap Studio:

- **Our projects:** we save only a few keys in
  `Metadata/project_settings.config` (`plate.rs`: the tower's switch,
  place and angle, the filaments), not the whole engine config. They
  should open in Orca 2.4.0 and 2.4.1 alike. To check (T6).
- **Orca 2.4.1 projects opened in Snap Studio:** `model3mf.rs` reads the
  geometry and the filaments, not the process config, so the −1 should
  not bother us. To check with a real file (T6).
- **Our own engine 3MF** (`write3mf.rs`): we write it and the bundled
  engine reads it, so both sides upgrade together.

## Impact on Snap Studio, file by file

| File | Today | With 2.4.1 |
|---|---|---|
| `src-tauri/engine.json` | 2.4.0, four archives of the `engine-orca-2.4.0` release | Rewritten by `scripts/engine.sh 2.4.1` (never by hand) |
| `scripts/engine.sh`, `.github/workflows/engine.yml` | Generic per version | **No change needed.** The official v2.4.1 assets have the names the workflow builds (one `.dmg` serves both macOS builds): `Snapmaker_Orca_Mac_universal_V2.4.1.dmg`, `Snapmaker_Orca_Windows_V2.4.1_portable.zip`, `Snapmaker_Orca_Linux_AppImage_Ubuntu2404_V2.4.1.AppImage` (checked through the API) |
| `ui/tower-logic.js` `ptEstimate` | One block: depth = (heads − 1) × lines per tool change, calibrated on 2.4.0 | **Depth = sum of one estimate per category used.** The rib square and the brim margin are recomputed from that depth. A plate with a single category should keep today's size; to re-measure |
| `ui/tower-logic.js` `ptSpot` | Fallback X 15, Y 220, back-left corner first | Unchanged unless D3 |
| `ui/prepare-tower.js` | Sends `wipe_tower_x/y/rotation_angle`, reads the sliced size back (`gcode.rs` `TowerBox`) | Unchanged. The real size after slicing stays the reference |
| `ui/slice-adv.js` `ADV_ENGINE_DEFAULTS` | Copied from 2.4.0 | Header says 2.4.1. No listed key changes default. `max_bridge_length` and `raft_first_layer_expansion` are not in the list (they come from the profile or the engine) |
| `ui/slice-adv.js` steps / ranges | `bridge_flow` step only | If the catalog carries limits: `bridge_density` up to 120 %, `support_threshold_angle` from 1 |
| `ui/speed.js` `SPD_ENGINE_DEFAULTS` | Copied from 2.4.0 | **No change of value** (none of its keys changed). Header comment only. The new `first_layer_travel_acceleration` / `_jerk` are left to the engine |
| `ui/assets/orca-settings.*.json` | Generated from v2.4.0 (`scripts/gen-orca-settings.py`) | Regenerate from v2.4.1 for the new settings, labels and translations, and check the `FIXES` table still applies |
| `ui/spoolcheck.js` `spBonds`, `spTowerAdvice` | Our table of families that bond | Compare with upstream's categories (D4). They agree on ABS/ASA, PETG/PET/PCTG and the PLA variants. **We say PLA and PVA bond, while upstream puts them in different blocks.** We don't know about PA and PC; upstream gives each its own category |
| `slice.tower.conflict` (9 languages), `slice.tower.walled` | "The prime tower mixes materials that do not bond… may come off or collapse", with "No tower" / "Outer wall in X" | **Probably wrong as worded** with "One tower" on 2.4.1, if the blocks hold (D2). The "outer wall in one material" fix may no longer make sense |
| `ui/pillar-logic.js`, `plate.rs` pillars (#37) | Engine tower off (`enable_prime_tower 0`), ring pillars, `print_order as_obj_list` | Still valid (nothing engine-side changed for them), but no longer the only way to keep materials apart (D1). Re-check `as_obj_list` and the per-object walls-only settings on 2.4.1 |
| `src-tauri/src/slice.rs` `engine_prime_tower_position` | Opt-in test on 2.4.0 | Run on 2.4.1. Add a case with two categories (PLA + PETG) that checks a tower at the requested corner and its depth |
| `scripts/test-tower.js` | Real depths measured on 2.4.0 | Re-measure on 2.4.1 and add cases with two categories |
| `scripts/test-adv.js`, `test-pillars.js` | Assert the conflict message and the pillar overrides | Follow D1 / D2 |
| `src-tauri/src/slicers.rs` | Detects an installed Snapmaker Orca, comment "V2.4.0" | Comment only |
| Docs: `docs/technical-overview.md` (tower section), `docs/plans/prime-tower-per-material.md`, README / README.fr (engine version, if mentioned), CHANGELOG | 2.4.0 | Updated with the implementation PR. One CHANGELOG line: "Slicing engine updated to Snapmaker Orca 2.4.1", with its user-visible effects |

## Open decisions

- **D1. #37's per-material towers.** Choose one:
  - keep them as an **option** ("faster" / "separate pillars") next to
    the engine's block tower, which becomes the default for plates whose
    materials don't bond;
  - keep them as the default, and the block tower the option;
  - remove them.

  *Proposal: keep them as an option until T3 / T4 compare both on a real
  U1 (time, material, tower stability).*
- **D2. The conflict message (#35).** If 2.4.1's blocks really keep
  materials that don't bond apart:
  - drop the warning with one tower, or turn it into an information line
    ("The tower keeps materials that don't bond in separate blocks");
  - drop the "outer wall in one material" fix.

  If the shared outer wall still mixes them (T2), rewrite the warning
  instead. *Wording to decide after T2, in English and French first.*
- **D3. Default tower position.** Choose one:
  - keep ours (back-left corner first, then the other corners, then the
    first free spot);
  - follow the new GUI default (X 13, middle of the left edge).

  *Proposal: keep ours. The command line didn't change and existing
  projects keep their place.*
- **D4. Material table.** Choose one:
  - align `spBonds` with upstream's categories, at least for PLA/PVA and
    PA/PC;
  - keep our table and only use upstream's categories in the tower estimate.
- **D5. New bridge defaults.** Nothing to do if we follow the U1 profile:
  0.20 mm Standard gets bridge flow 1 and density 100 %, and every
  profile gets `max_bridge_length` 0. The other choice is to pin the 2.4.0
  values for continuity. *Proposal: follow the profile, and say so in the
  CHANGELOG.*
- **D6. Filaments without a category.** User or third-party filament
  profiles that don't inherit a Snapmaker base profile fall to category
  100, the PLA one. Choose one:
  - send `filament_adhesiveness_category` ourselves, derived from the
    filament type;
  - leave it to the engine.
- **D7. New 2.4.1 settings in the slice sheet**, for example internal
  ribs, paint penetration layers or minimum support contact area: none in
  this upgrade, or some. *Proposal: none in this upgrade, a follow-up if
  wanted.*

## Implementation plan (after the go)

1. **Engine**: `scripts/engine.sh 2.4.1` on an up-to-date `main`. It
   starts `engine.yml`, which builds the archives, runs a test slice on
   the four platforms and publishes the `engine-orca-2.4.1` release (never
   "latest"), then rewrites, commits and pushes `src-tauri/engine.json`.
   *This step publishes a release on kameka22/snap-studio, so kameka22
   runs it, or it needs an explicit OK.*
2. **Catalog**: `python3 scripts/gen-orca-settings.py <OrcaSlicer at
   v2.4.1>`, then `python3 scripts/check-i18n.py`.
3. **Defaults**: the 2.4.1 headers in `slice-adv.js` and `speed.js`;
   values only where the script diff says so (none today); ranges for
   `bridge_density` and `support_threshold_angle` if needed.
4. **Tower estimate**: `ptEstimate` takes the heads' categories (from
   the filament's type, mapped as upstream, or D6's value). Its depth is
   the sum of the blocks. Recalibrate on 2.4.1 slices.
5. **Warnings and pillars**: per D1 / D2 / D4. Update the strings in the
   nine languages and the tests.
6. **Tests**: `node scripts/test-tower.js`, `test-adv.js`,
   `test-pillars.js`, `test-spoolcheck.js`, the other `scripts/test-*.js`,
   `cargo test --lib`, and `engine_prime_tower_position` with
   `SNAPSTUDIO_ENGINE` pointing to 2.4.1.
7. **Docs and CHANGELOG**: as in the table.

## Test plan

- **T1, tower size**: re-run `test-tower.js`'s measured cases on 2.4.1.
  These are the plain wall at 2, 3 and 4 heads, 0.2 and 0.12 mm, 40 and
  60 mm, 45 and 90 mm³, and the U1 rib tower, all in one category. Then
  add cases in two and three categories (PLA + PETG, PLA + PETG + TPU).
- **T2, does the tower still mix?** On a PLA + PETG plate, read the
  G-code. Check which head prints the tower's outer wall, the brim, and
  the `Contact` / `Solid` layers, and whether a PETG line ever lands on a
  PLA line. This settles D2.
- **T3, #37 again**: redo the feasibility test of
  `prime-tower-per-material.md` (PLA cube on T0 / T1, PETG cube on T2,
  ring pillars) on 2.4.1:
  - each ring printed by its own head;
  - pillars printed before the model in every layer × head case with
    `as_obj_list`;
  - heights;
  - no new warnings.

  Compare its print time and filament use with the 2.4.1 block tower on
  the same plate.
- **T4, real U1 print**: the same PLA + PETG plate, once with the block
  tower and once with #37's pillars. Check that the tower stays standing
  and doesn't come off, the colors, the time, and the faster tool changes
  (`M104` instead of `M109`: does the next head start before it is hot
  enough?).
- **T5, tower place**: `engine_prime_tower_position` (corner, rotation,
  tower off) on 2.4.1, plus a two-category plate.
- **T6, 3MF**:
  - a Snap Studio project saved after the upgrade opens in Snapmaker
    Orca 2.4.0;
  - a project saved by Orca 2.4.1 opens in Snap Studio, both before and
    after the upgrade;
  - a multi-color 3MF slices with its colors (fix 39).
- **T7, bridges**: slice a bridge test in 0.20 mm Standard on 2.4.0 and
  2.4.1. Note the support under long bridges (`max_bridge_length` 0) and
  the bridge flow.

## Risks

- **3MF**: see § 6. Low for our own files, to confirm (T6).
- **Tower size before slicing**: until `ptEstimate` knows the categories,
  Prepare may show too small a tower on mixed plates. The size read
  after slicing corrects it.
- **Tool changes on the U1** now use `M104`. Upstream made this choice,
  and T4 must confirm it on a real print.
- **Unread upstream changes**: the compare stops at 300 files, so GUI-only
  changes were not all read. They don't affect the command line, but a
  CLI change outside the files read above could have been missed. The
  four-platform test slice in `engine.yml` and T1–T7 are the safety net.
