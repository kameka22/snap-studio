# Full Spectrum color calibration (virtual heads)

Status: **analysis only**. No code yet.

## Request

Raised in the official Snapmaker Discord (`#third-party-software`,
<https://discord.com/channels/1086575708903571536/1391158072210096288>),
messages from the user "Somebody" on 2026-10-27, around 20:23 and 21:27
(Paris time). Somebody prints in Brazil with **local filament brands**
for which no reference values exist online: no color reference, no
transmission distance (TD), no community swatch.

Today the color shown for a virtual head (Full Spectrum, #64) is only a
forecast: the sheet even says so (« Aperçu indicatif »). The request:

1. a **test print** (a swatch card) that prints the ratios the sheet offers,
   **4:1 to 1:4**, with the two chosen spools;
2. the user compares the real swatches with the preview and **corrects or
   validates the color of each ratio**;
3. these values are **saved per filament pair** and used from then on by
   the virtual head preview (the sheet, the head cards, Prepare, the
   G-code images).

Also to evaluate: entering or measuring a **TD value** per filament, where
the data lives (filament profile, or the spool inventory of draft PR #19),
and what Snapmaker Orca and OrcaSlicer do.

## What exists today

| Piece | Where | What it does |
|---|---|---|
| Virtual heads | `ui/heads.js` (`headsVirtual`, `headsVirtualAdd/Set/Delete`), `localStorage["snapstudio.heads"]` | Per printer `[{ uid, a, b, pct }]`: two physical heads and the share of `b`. Deleted when one of the two spools is unloaded (`hdVirtualGone`). |
| Ratios | `ui/virtual-logic.js` | `VH_PCTS = [20, 25, 33, 50, 67, 75, 80]`: the seven notches of the slider, i.e. the cadences 4:1, 3:1, 2:1, 1:1, 1:2, 1:3, 1:4 (`vhCadence`, Orca's `compute_gradient_ratios`). `vhShare` is the share of B layers in a cycle. |
| Preview color | `src-tauri/src/mixcolor.rs`, command `mix_colors(a, b, shares)` | Rust port of Snapmaker Orca's MIT pigment mixer (`filament_mixer_model.h`, degree-4 polynomial fit of Mixbox). Inputs: two `#rrggbb` and the share. **Nothing else**: no TD, no layer height, no material. |
| Cache and fallback | `ui/heads.js` `hdMix`, `HD_MIX` | Keyed `lo|hi|share`, Orca's order (lower head to higher head). Linear light while the answer comes. `headsVirtualColor(pid, v)` is the single entry point used by the section, the sheet, the pickers and Prepare. |
| The sheet | `ui/virtual.js` `vsOpen`, `vsShades`, `vsColor`, `vsRender` | Asks the seven shades at once (`vsShades`) so dragging is instant. |
| Slicing | `src-tauri/src/slice.rs` `SliceRequest.virtual_heads`, `mixed_definitions` | The virtual heads travel **with the slice request**, not from the stored list: a request can carry its own mixes. Written as Orca's `mixed_filament_definitions` (`Simple` distribution, one row per head). |
| Spool identity | `headsSlots(pid)` (`{ index, present, kind, color, … }`), `control.rs` `Action::Filament { vendor, material, sub_type, color }` | What the U1 knows of a spool: RFID, or what the user declared on the machine / in Control. A local brand has no RFID: the user declares it. |
| Filament profiles | `src-tauri/src/presets.rs` | System presets of the engine, Orca's user presets, then Snap Studio's own (`<config>/fr.carlini.snapstudio/profiles/filament`). Only process presets are written today (`save_user_process`). |

## How others do it

- **Snapmaker Orca** (read at `v2.4.0`, `src/libslic3r/PrintConfig.cpp`,
  `MixedFilament.hpp`): the display color is
  `compute_mixed_filament_display_color` → the same pigment mixer we
  ported. There is **no TD key** and **no per-filament color correction**
  in the config or in the mixed-filament model. Snapmaker's answer is
  printed references: the
  [Full Spectrum Color Reference](https://wiki.snapmaker.cn/en/snapmaker_orca/full_spectrum_color_reference)
  gives 39 photographed mixes and a 177-swatch 3MF, **only for its own
  "PLA Full Spectrum" bundle** (fixed toolhead order, fixed colors), and
  says *"printing test swatches, and fine-tuning according to your
  specific print job"*. The
  [Full Spectrum FAQ](https://wiki.snapmaker.cn/en/snapmaker_u1/printing_guides/FAQ_for_Full_Spectrum)
  lists what changes the real color: filament color and TD, ratio, layer
  height, geometry, toolpaths, flow, conditions; and recommends a small
  swatch before an important print.
- **Snapmaker blog**
  ([Getting started with Full Spectrum](https://blog.snapmaker.com/blog/getting-started-with-full-spectrum-slicing/)):
  borrows HueForge's **TD** (the thickness in mm that blocks 99 % of the
  light) to sort filaments: TD ≤ ~1 very opaque, 2–3 opaque (still fine at
  50/50), 5–8 translucent (the best illusion), > 10 transparent (bleeds).
  It advises a test palette first, 0.08 mm layers, and notes that almost no
  manufacturer publishes TD.
- **OrcaSlicer mainline** (`main`, `PrintConfig.hpp`): has its own
  mixed-color model now (`filament_is_mixed`, `filament_mixed_components`,
  `filament_mixed_sublayer_ratios`, gradients), with other keys than
  Snapmaker's `mixed_filament_definitions`. No TD key there either.
- **HueForge** ([FAQ](https://hueforge.wiki/index.php/FAQ),
  [TD-1](https://hueforge.wiki/index.php/TD-1)): every filament is
  described by its hex color **and** its TD. TD comes from its library, a
  printed "seashell" test, or a sensor (AJAX-3D TD-1 / TD1S, which also
  estimates a hex color). Values vary by batch, ±10 % even for brands that
  control it, so a value belongs to *a spool*, not to a product.
- **Community tool**
  [snapmaker-u1-fullspectrum-helper](https://github.com/halloworld007/snapmaker-u1-fullspectrum-helper):
  gamma-corrected linear RGB, ΔE in CIE Lab, and TD as an *optional
  weighting* of the color model.

So nobody stores a correction per pair: the "calibration" everybody
recommends is to print swatches and look. Snap Studio can close that loop.

## Proposed UX

### Where

- In the **virtual head sheet** (`#vhmodal`): under the swatch, a line
  « Aperçu indicatif · **Calibrer ces deux filaments** ». Once calibrated:
  « Couleurs calibrées le 27 oct. · Modifier ».
- In **Heads and spools › Virtual heads**: the same action on each card's
  menu, and a small "calibrated" mark on a card whose color comes from a
  calibration.
- Later, in Care & Tuning › Calibration (#38) as one of the filament tests
  (see `filament-calibration.md`): same flow, entered from there.

### The swatch card

One plate, one row of **nine tiles**, left to right: pure A, 4:1, 3:1, 2:1,
1:1, 1:2, 1:3, 1:4, pure B. The two pure tiles are the reference for the
comparison (and for a photo, see below).

- A tile is about 14 × 14 mm, about 8 mm tall, with a **45° slope** on its
  front and a vertical back: Full Spectrum mixes on walls and slopes, while
  a flat top shows a single layer, hence one of the two colors (the
  plan of #64 already says so). The top is printed in the tile's mix
  anyway, only the slope and the walls are to be read.
- A thin base (0.6 mm, in A) holds the tiles together, with **notch marks**
  (1 to 9 dots, embossed) so a tile can be told apart without labels.
- Layer height: the bundled `0.10mm Color Mixing @Snapmaker U1 (0.4
  nozzle)` process, or 0.08 mm (blog advice), chosen in the sheet. The
  calibration is saved **with its layer height**: the same pair at 0.20 mm
  looks different.
- Prime tower on (a virtual head changes heads at every layer); the
  per-material pillars of #37 when the two materials bond.
- Print time: roughly 25–35 min at 0.10 mm (to check on the U1).

The sheet: « Imprimer le nuancier » → the usual slice sheet (read-only
heads, the two spools shown) → Send. The record of the print in Prints
carries a link « Saisir les couleurs » once it ends.

### Correcting the colors

A sheet with the nine tiles, each as **preview → printed**:

- by default "printed" = preview, with a **✓ Validé** state per tile;
- a click opens the color picker (hex, a hue / brightness field, and the
  eyedropper of the system where the WebView offers it);
- **from a photo** (optional, second step): drop or paste a photo of the
  card; the user clicks the nine tiles (or the app finds them along the
  row); the two pure tiles, whose real colors are the spools' own, give a
  **white balance**: each read color is corrected by the A and B
  references before being proposed. This avoids a yellowish room light
  shifting every value. The U1 camera is not used: its angle and light are
  not good enough for colors.
- « Tout valider » saves; « Réinitialiser » goes back to the mixer.

ΔE (CIEDE2000, already used by the spool check) between preview and
printed is shown per tile, as a hint ("très proche", "différent").

### Using the values

`headsVirtualColor` returns the **calibrated color** when one exists for
the pair, the cadence and the layer height of the current process (nearest
height within ±0.04 mm), else the mixer's. Everything that shows a virtual
head (sheet, cards, pickers, Prepare, the G-code images through
`VirtualHead.color`) follows without other change. The caveat line becomes
« Couleur calibrée sur un nuancier imprimé ».

## Data and storage

### What identifies a filament

The pair must survive a spool being unloaded and loaded again, and a head
change (A in T2 today, T0 tomorrow). So a calibration is keyed by the two
**filaments**, not by the heads:

`filamentKey = vendor | material | sub_type | color` (normalized: trimmed,
upper-case hex), as the U1 reports it for the spool (RFID or declared).
The pair is stored in a canonical order (by key); the cadence is flipped
when the heads are the other way round (2:1 of A over B is 1:2 of B over
A). Two spools of a local brand declared the same way share their
calibration, which is what the user expects; a new batch that looks
different can be calibrated again (the newer one wins).

### Where

| Option | For | Against |
|---|---|---|
| **Filament profile** (an extra key in the user's filament preset JSON) | Travels with the profile | A calibration belongs to a **pair**, not to one filament. A profile is shared by many colors (one "Generic PLA" for every spool). The engine drops unknown keys with a log line, so nothing breaks, but it is the wrong place. |
| **Spool inventory (#19)** | TD and color really belong to a spool (batch variance) | #19 is a placeholder draft with no data model yet. Pairs would still need their own table. |
| **Own file** `<config>/fr.carlini.snapstudio/fullspectrum.json`, through two Tauri commands | Independent of #19, survives a reinstall of the WebView storage, easy to export | One more file |

**Recommended: the own file**, written by Rust (as `retention.json` from
#65), not `localStorage`: calibrations take a print to make, they must not
be lost with the WebView data.

```json
{
  "version": 1,
  "filaments": {
    "<filamentKey>": { "td": 4.5, "td_source": "manual", "color": "#E2C044" }
  },
  "pairs": [
    {
      "a": "<filamentKey>", "b": "<filamentKey>",
      "layer_height": 0.1,
      "colors": { "4:1": "#…", "3:1": "#…", "2:1": "#…", "1:1": "#…", "1:2": "#…", "1:3": "#…", "1:4": "#…" },
      "validated": ["4:1", "1:1"],
      "at": "2026-10-27T21:30:00+01:00",
      "job": "<job id of the swatch print>"
    }
  ]
}
```

When #19 lands, a spool record points to its `filamentKey`, and the TD
can move there (per spool); the pairs stay in this file.

## TD (transmission distance)

- **Entering it**: an optional field « TD (mm) » per filament, in the
  calibration sheet and later in the spool inventory, with a link to what
  it means. Sources: a TD1/TD1S reading, HueForge's library, or a test.
- **Measuring it**: a second, optional test print: a wedge of the tested
  filament in steps (0.2 to 3.2 mm, 0.2 mm apart) over a black and a white
  strip; the user picks the first step where the strip no longer shows.
  That is HueForge's idea in its simplest form. It costs one print and
  one more sheet: **not in the first version**.
- **Using it**: neither Snapmaker Orca nor OrcaSlicer use TD in their
  preview, and a TD-weighted model is a research topic of its own. A
  **printed calibration beats any model**, and with only seven cadences
  there is nothing to interpolate. So in v1 TD is stored and used for
  **advice only**, as the Snapmaker blog sorts filaments: « Très opaque (TD
  ≤ 1) : les rayures resteront visibles » / « Transparent (TD > 10) : le
  mélange bave ». A TD-weighted preview for uncalibrated pairs can come
  later, checked against calibrated cards.

## Technical approach

1. **Swatch model**: generated in Rust, as the pillars of #37 already are
   (`plate.rs` builds their mesh with `tube()` and writes them as objects
   of their own with `pillar_object()` / `pillar_settings()` through
   `write3mf.rs`). Nine wedges and a base are a few dozen triangles. No
   asset to ship.
2. **Slice request**: the scene has the nine objects; pure tiles on the
   physical heads A and B, the seven others on **request-local virtual
   heads** (`SliceRequest.virtual_heads`, seven entries at the seven
   `VH_PCTS`). The printer's own list (max 8, `VH_MAX`) is **not** used or
   changed, so a user with eight virtual heads can still calibrate. The
   existing test `slice.rs` "a virtual head reaches the engine" is the
   model for an ignored engine test with seven heads.
3. **Send and follow**: the normal send path (`printers.rs`) and the job
   record (`jobs.rs`, #65) with a `calibration: { kind: "full_spectrum",
   a, b, layer_height }` tag, so Prints can offer « Saisir les couleurs ».
4. **Storage**: `fullspectrum.rs` with `fs_calibration_read()` /
   `fs_calibration_save(entry)`, serde defaults, written atomically.
5. **Preview**: `hdMix` gets a lookup first (pair key + cadence + layer
   height → color), then falls back to `mix_colors`. The calibration is
   loaded once at start and on save (`hdEmit({ what: "mix" })` redraws).
6. **Photo reading** (step 2): pure JS on a `<canvas>`: average a small
   square around each click, convert to linear RGB, scale each channel by
   the ratio of the known A/B colors to the read A/B colors (a diagonal
   white balance), back to sRGB.
7. **i18n**: en and fr; « Tour d'amorçage » kept for the prime tower.
8. **Tests**: `scripts/test-virtual.js` (keys, canonical order, cadence
   flip, nearest layer height, lookup before mixer), `scripts/test-fs-photo.js`
   (white balance on synthetic images), `cargo test --lib` (file
   round-trip, old file without new fields, the swatch mesh is closed).

## Open questions

1. Is the U1's spool identity stable enough for a local brand? A spool
   declared by hand on the machine as "PLA / Generic / #FFFFFF" will share
   its calibration with every other white generic PLA. Should the user be
   able to name a filament (« Marca X branco ») in the calibration sheet?
2. Nine tiles in one row (about 140 mm), or two rows? One row is easier to
   read and to photograph.
3. Calibrate per layer height, or only at the color-mixing height and
   warn otherwise?
4. Does a calibration also become the **default mix suggestion**: in the
   sheet, a ratio whose printed color is closer to a target color picked
   by the user? (Nice, not v1.)
5. Export / import of `fullspectrum.json` to share calibrations of a local
   brand with others (Somebody's community)? Cheap once the file exists.

## Difficulty

**Overall: medium.** The slice path already carries per-request virtual
heads, the preview has a single entry point, and the mixer is ours. The
work is the swatch generator, the correction sheet, the storage and the
lookup, plus a print on the U1 to tune the tile shape.

- Swatch card + print + manual correction + storage + preview lookup:
  **~3–4 days**.
- Photo reading with white balance: **+1 day**.
- TD field and advice: **+0.5 day**.
- TD measuring print: +1 day (later).

**Recommended first version: ~4–5 days** (card, manual correction, photo
reading, storage, preview, TD field with advice).
