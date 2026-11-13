# Long prints: the G-code preview stops before the top

## The problem

On a long print (a statuette in 0.20 mm, 15 h 47), the sliced preview stops
part way up: the model is cut flat, and at the top of the layer slider the
time reads **11 h 42** while the total says **15 h 47**. The layer count
(609) is also too low, since it is counted on what is shown. It shows up on
prints of about ten hours or more, which are the ones with the most moves.

## Cause

`gcode::parse` (`src-tauri/src/gcode.rs`) keeps at most `MAX_SEGS`
(3 000 000) segments for the preview. Past that, the rest of the file is
read but its segments are dropped:

```rust
if segs.len() >= MAX_SEGS {
    truncated = true;
    continue;
}
```

What follows in the file is lost. A G-code is written layer by layer, so
those are the **top layers**:

- the preview shows the model up to the layer where the limit was reached,
  and stops there (the flat cut);
- `layers` is the highest layer among the **kept** segments (`gcode.rs`, after
  the loop), so the encoded preview, the slider and `stats().layers` (the
  "609 layers" in the panel) all stop at the same layer;
- the times keep being counted after the limit (`times.layer_end` is filled
  before the test), so the total is right, but the slider's last layer is
  the cut layer: its end time is 11 h 42, not 15 h 47.

Travel moves count in the budget too, though the preview hides them by
default (`showTravel: false`), and so do the start G-code's moves.

The only sign of the problem today is a "(truncated)" at the end of the
viewer's technical line (`viewer.truncated`, `#v-stats`), easy to miss.

## Proposal

### 1. Layers and times from the whole file

- Count `layers` during the read, over **every** move, not over the kept
  segments. `stats().layers`, the encoded header and the slider then give
  the file's real count (it can be checked against `; total layer number`,
  `meta.total_layers`, when the slicer writes it).
- The slider then goes to the last layer, and its time matches the total.
- `layerZ` (`ui/viewer.js`) is built from the segments: a layer with no
  kept segment takes the Z of the previous one today. With 2 below, every
  layer keeps segments, so this case goes away.

### 2. Never drop the end: simplify evenly instead

When the budget is reached, the preview should get **coarser**, not
**shorter**. The way:

- **Travel apart.** Travel moves get their own smaller budget (for example
  500 000) and are dropped first: they are hidden by default. Extrusions
  then have the whole of `MAX_SEGS`.
- **Merge tiny segments.** A statuette's surface is made of many
  segments a fraction of a millimetre long. Next to each other in the same
  layer, with the same feature, tool, width and height, and almost in line,
  they are merged into one segment (same start, last end). The tolerance
  starts at 0 (nothing merged) and grows only when the budget is exceeded.
- **Second pass if needed.** If the file is still over budget after a first
  read, it is read again with a larger tolerance (the size of the file and
  the count of the first read give the right one). Reading is fast next to
  the slicing, and only very large prints pay for it.

With this, the whole height is always shown; only the detail of the curves
is lighter on very large prints, which the eye doesn't see at preview
scale.

The budget itself (3 M) stays: it holds the memory of the read (about
32 bytes per segment) and of the WebGL buffers.

### 3. Say it when the preview is simplified

- `truncated` becomes `simplified` in the meaning (the header bit keeps its
  place). In the viewer and in Prepare's preview, a short note under the
  slider: "Simplified preview: very long print". The layers, times and
  filament are still exact.
- Remove the "(truncated)" wording from the technical line.

## Where it is used

`gcode::parse` and `encode` serve the viewer (`lib.rs`, G-code protocol),
Prepare after slicing (`slice.rs`), the Prints tab and the job's layer
times (`jobs.rs`, `ui/prints.js`), the printer simulator (`sim/print.rs`)
and thumbnails (`thumbs.rs`). Points 1 and 2 fix them all at once: today a
long job's layer times and layer count are wrong in the Prints tab too.

## Texts

New strings, in the 9 languages:

- `viewer.simplified`: "Simplified preview: very long print"
- `viewer.simplified_tip`: "All layers are shown with less detail.
  Layers, times and filament are exact."

`viewer.truncated` is then removed.

## Tests

- Rust (`gcode.rs`): a generated G-code over budget (many tiny segments over
  many layers):
  - `layers` equals the number of layers in the file;
  - the last layer's segments are in the preview (its Z is the top);
  - `layer_end_s.last()` equals the total time;
  - the merged path stays within the tolerance of the original points;
  - a file under the budget is read as today, segment for segment.
- Travel budget: past it, extrusions are all kept.
- By hand: the statuette from the report (15 h 47 in 0.20 mm): the model is
  whole, the slider ends at 609+ layers at about 15 h 47, the note shows;
  a small print shows no note and the same preview as today.

## Questions

1. **Note**: show the "Simplified preview" note, or keep it silent since
   the shape is whole?
2. **Travel**: when travel is shown on a large print, a travel layer can be
   incomplete (its budget is smaller). Fine, or should showing travel
   reload with a travel-first budget?

## CHANGELOG

At implementation, under *Unreleased › Fixed*: "**Preview**: on long prints
the sliced preview no longer stops part way up; all layers are shown, with
the right layer count and time on the slider."
