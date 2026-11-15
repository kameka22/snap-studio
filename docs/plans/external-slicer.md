# External slicer engine (installed Snapmaker Orca / OrcaSlicer forks)

Status: **analysis only**. No code yet.

## Request

Raised in the official Snapmaker Discord (`#third-party-software`, user
"Somebody", 2026-10-26): let Snap Studio slice with a slicer **already
installed** on the machine instead of the bundled Snapmaker Orca engine,
namely Snapmaker Orca, OrcaSlicer and its forks, and especially LixNix's
multi-nozzle fork. The underlying need: a U1 with **mixed nozzle sizes**
(2 × 0.4, 0.6, 0.2), which official Snapmaker Orca handles poorly.

## How the engine is integrated today

| Piece | Where | What it does |
|---|---|---|
| Pinned engine | `src-tauri/engine.json`, `engine.rs` | Snapmaker Orca **2.4.0**, slimmed by `engine/package.py` + `keep.txt`, built by the "Engine" CI, downloaded on first use to `<config>/fr.carlini.snapstudio/engine/orca-<version>/`, SHA-256 checked. No source patches: it is upstream Snapmaker Orca, pruned. |
| Engine choice | `slice.rs::engine()` | 1) `SNAPSTUDIO_ENGINE` env var (any `.app` / exe / `AppRun`, used by CI and the ignored `engine_*` tests), 2) the downloaded engine, 3) dev builds only: the installed Snapmaker Orca found by `slicers::list()`. |
| Detection of installed slicers | `slicers.rs` | Already knows the usual paths per OS: macOS `/Applications` + `~/Applications` bundles (main binary read from `CFBundleExecutable`), Windows `Program Files*` + `%LOCALAPPDATA%\Programs`, Linux `PATH` + `*.AppImage` in `/opt`, `~/Applications`, `~/Downloads`… Resources are read in place, or extracted once from an AppImage (`--appimage-extract resources/profiles/*`). **Flatpak is not handled.** |
| Profiles | `presets.rs` | The `Index` reads `<resources>/profiles/Snapmaker` **of the engine in use**, plus user presets from `<config>/Snapmaker_Orca/user/default` and Snap Studio's own `profiles/`. Inheritance is flattened and complete JSON configs are written (`type`, `from`, `nozzle_diameter` copied into the process config to dodge a `normalize_fdm` null-pointer crash). |
| Invocation | `slice.rs::run_job` | `--arrange 0 --allow-newer-file --slice 0 --datadir <own> --load-settings machine;process --load-filaments f1;…;f4 --outputdir <out> --debug 3 [--pipe <fifo>] <plate.3mf>` |
| Input | `plate.rs`, `write3mf.rs` | Snap Studio always re-emits a clean 3MF: one block per object, `Metadata/model_settings.config` with `extruder` and per-object keys (pillars: `sparse_infill_density`, `brim_type`…), wipe tower position; `Metadata/snapstudio_tower.json` is Snap Studio-only. |
| Outputs parsed | `slice.rs`, `gcode.rs`, `gcode_thumbs.rs` | Progress from the `--debug 3` log stage lines (`Tracker`) and the `--pipe` JSON (Linux build), errors from the log (`engine_error`), stats from the G-code header/footer comments, thumbnails injected by Snap Studio. |

Engine-specific features:

- **Virtual heads / Full Spectrum** (`mixed_filament_definitions`): exists in
  Snapmaker Orca 2.3.6+ and in LixNix's fork, **not in mainline OrcaSlicer**.
- **Per-material pillars** (#37): `enable_prime_tower=0`,
  `print_order=as_obj_list`, `independent_support_layer_height=0` plus
  per-object metadata. All standard Orca keys.
- `--allow-newer-file`, `--arrange`, `--pipe`, `--load-*`, `--datadir`,
  `--debug`: present in all three code bases (checked in each
  `PrintConfig.cpp`).
- Log stage strings and the error text read by `engine_error` are
  Snapmaker-Orca-wording; a fork that rewords them only degrades the progress
  bar, it does not break slicing.

## The candidate engines

| | Snapmaker Orca 2.4.0 (bundled) | OrcaSlicer mainline (2.4.2 / 2.5.0-alpha) | LixNix fork, `LixNix-Swap-Org/Snapmaker-Orca` |
|---|---|---|---|
| CLI flags we use | ✔ | ✔ | ✔ (fork of Snapmaker Orca) |
| U1 profiles | 0.2 / 0.4 / 0.6 / 0.8 | same + **`Snapmaker U1 (0.4+0.6 nozzle)`** | 0.2 / 0.4 / 0.6 / 0.8, plus "extruder presets with a default per nozzle size" |
| Full Spectrum (virtual heads) | ✔ | ✘ | ✔ |
| Mixed nozzle diameters | `nozzle_diameter` is already a per-extruder array; one layer height and shared line widths for the whole print | same, plus per-feature filament assignment | **per-extruder layer height, speeds and line widths** (`extruder_layer_height`, `extruder_layer_height_exact`, …) |
| Binary / app name | `Snapmaker Orca.app`, `snapmaker-orca.exe`, `Snapmaker_Orca*.AppImage` | `OrcaSlicer.app`, `orca-slicer.exe` | **same names as Snapmaker Orca**; `v2.5.0-beta` (2026-10-11): macOS universal dmg (not notarized), Windows installer/portable, Linux AppImage and flatpak |
| Datadir | `Snapmaker_Orca` | `OrcaSlicer` | `Snapmaker_Orca` (shared with the official app) |
| Upstreaming | – | LixNix's PR OrcaSlicer#13782 closed unmerged | Snapmaker/OrcaSlicer#580 closed unmerged; the author says it is being discussed with Snapmaker for a future release |

A version is not exposed by a `--version` flag. It can be read from the
bundle (`CFBundleShortVersionString`), the Windows file version resource, the
AppImage file name, or the engine's own log line
`cli mode, Current Snapmaker_Orca Version X` (written at `--debug` ≥ 2, so
on every slice). `--help-fff` is compiled out in Snapmaker Orca, so
capabilities cannot be listed from the CLI; a **probe slice** (a 10 mm cube,
a few seconds) is the reliable check. The engine loads configs with
`ForwardCompatibilitySubstitutionRule::Enable`: unknown keys are dropped
with a log line, **not** an error, so a missing feature fails silently
unless we probe for it.

## Options

### A. Custom engine path with a compatibility check

Settings → Slicing engine: *Bundled (recommended)* / *Installed app*,
offered from `slicers::list()` (Snapmaker Orca family + OrcaSlicer) or
picked by hand. On selection, and when the app's version changes:

1. resolve the binary and `resources` (existing code);
2. read the version;
3. run a probe slice and record capabilities: slices at all, honours
   `--arrange 0`, `mixed_filament_definitions` (G-code alternates heads),
   per-extruder `nozzle_diameter`, `extruder_layer_height`;
4. show the result ("Full Spectrum not supported by this engine") and hide
   the features it lacks, instead of failing at slice time.

Work: settings + persistence, use the chosen path in `engine()` (the
release-build branch currently ignores installed apps), profile root per
engine (`profiles/Snapmaker` exists in all three), datadir per vendor
(`Snapmaker_Orca` vs `OrcaSlicer`) for user presets, flatpak detection
(`flatpak run --command=… <id>`, resources under
`/var/lib/flatpak/app/<id>/current/active/files/share`), probe + capability
gating in the UI, i18n, tests.

**Effort: medium, ~4–6 days** incl. testing on the three OSes.

### B. Curated list of supported forks

Same as A, but only known engines/versions are accepted (e.g. "Snapmaker
Orca ≥ 2.4", "LixNix 2.5.0-beta"), each with a known capability set, maybe
even offered as an alternative download in `engine.json` (the fork is AGPL,
it has CI builds for all platforms).

Cheaper per check, but **every fork release needs us**: re-test, update the
list, possibly re-package. Unnotarized macOS builds can't be re-shipped
cleanly. **Effort: A + an ongoing support burden.** Not recommended as a
starting point.

### C. Mixed nozzles in the bundled engine

The U1 already reports each head's `nozzle_diameter` over Moonraker
(`maintenance.rs` reads it). Snap Studio could build the machine config
with a per-head `nozzle_diameter` / `min_layer_height` / `max_layer_height`
array (as OrcaSlicer's `U1 (0.4+0.6 nozzle)` profile does), pick filaments
compatible with each head's nozzle, and warn on a mismatch. The stock
engine then prints with one layer height and shared line widths: correct,
but not the quality gain the user is after (fine 0.2 detail at 0.1 mm layer
next to a 0.6 at 0.3 mm). That gain only exists in LixNix's fork.

**Effort: small–medium, ~2–3 days**, and useful even without A.

## Risks

- **CLI / behaviour divergence**: forks may reword logs (progress bar),
  change crash workarounds we rely on (`nozzle_diameter` in the process
  config), or rename keys. Mitigated by the probe and a per-version cache.
- **Silent feature loss**: unknown keys are ignored, e.g. virtual heads on
  mainline OrcaSlicer slice as if they did not exist. Must be gated in the UI.
- **Profiles**: a fork's U1 profiles and G-code macros differ from the
  bundled ones (LixNix changed presets); Snap Studio's own process presets
  and the user's tuned presets may not match. User presets are shared with
  the official app through the `Snapmaker_Orca` datadir: convenient, but the
  same preset may behave differently on two engines.
- **Support burden**: bug reports from slices made with a beta fork. The
  settings and error messages must say which engine sliced, and the
  bundled engine stays the default.
- **macOS**: an unnotarized fork may be blocked by Gatekeeper when launched
  headless; the user has to open it once.

## Difficulty

**Overall: medium.** Most of the plumbing exists (detection, binary and
resources resolution, AppImage extraction, a CLI shared by all three
engines, an env override). The real work is capability probing/gating and
the per-engine profiles/datadir, plus testing across OSes and forks.

- C alone: ~2–3 days.
- A (recommended scope): ~4–6 days.
- A + C: ~1.5 weeks.
- B: A plus continuing maintenance.

## Recommended first step

1. **Today, no code**: an advanced user can already point Snap Studio at an
   installed engine with the `SNAPSTUDIO_ENGINE` environment variable (e.g.
   the LixNix build of `Snapmaker Orca.app`). This is unsupported, but it
   would show quickly whether the fork's profiles and per-extruder layer
   heights work through our pipeline.
2. **First PR: option A, restricted to the Snapmaker Orca family**
   (official + LixNix, same CLI, same profiles folder, same datadir): an
   "Installed app" choice in Settings → Slicing engine, version read from
   the bundle/log, a probe slice, Full Spectrum gated on the probe. Bundled
   stays the default.
3. Then **C** (per-head nozzle diameters from the printer), which helps
   with both engines, and only after that mainline OrcaSlicer
   (datadir `OrcaSlicer`, no Full Spectrum) and flatpak.
