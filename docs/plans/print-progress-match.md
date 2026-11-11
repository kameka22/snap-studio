# Print progress and time left: the app and the printer disagree

During a print, the percentage and the time left shown by Snap Studio
(Printers, Prints, the 3D printer view, the send sheet) are not those shown
on the U1's screen.

## How the app computes them today

Everything comes from one place, `apply_status` in
`src-tauri/src/printers.rs:668-701`, fed by the HTTP query (`status`) and by
the live feed (`watch.rs`, merged snapshot):

- **Percentage**: `display_status.progress`, or else
  `virtual_sdcard.progress` (`:689-694`). Klipper's `display_status.progress`
  is the last `M73 P` the G-code sent when there is one, otherwise the
  position in the file (bytes read / file size), the same as
  `virtual_sdcard.progress`.
- **Time left**: not read from the printer. The app extrapolates it from
  that percentage: `elapsed × (1 − p) / p`, with `elapsed =
  print_stats.print_duration`, only above 2 % (`:696-701`).
- **Display**: `Math.round` of the percentage everywhere
  (`ui/printers.js:307`, `ui/prints.js:125, 327, 576`,
  `ui/printer3d.js:210-211`, `ui/control.js:619`); `fmtHms` rounds the
  seconds then floors the minutes (`ui/printers.js:187-192`).

## Likely causes of the gap

1. **A different time left.** The extrapolation assumes a constant speed
   over the file. It is wrong at the start (heating, bed leveling and the
   purge count in `print_duration` but not in the bytes), and whenever the
   speed changes (first layer, supports, tool changes of the U1, which are
   long and take few bytes). The U1's screen most likely shows the slicer's
   estimate (`M73 R`, or the file's `estimated_time` minus the time spent),
   which follows the real schedule.
2. **A different percentage.** If the U1's screen shows the position in the
   file and the G-code sends `M73 P` (time-based, from the slicer), or the
   reverse, the two numbers drift apart, by a lot on prints with many tool
   changes.
3. **Rounding.** `Math.round` against a screen that may floor: at most 1 %,
   but visible at 99 % / 100 %.

What the U1's screen reads is not documented: it has to be measured (step 1).

## Plan

1. **Measure on the U1** (no code). During a print of a few colours,
   several times (start, first layer, a tool change, middle, end), note
   what the screen shows and save the raw answer of
   `/printer/objects/query?print_stats&display_status&virtual_sdcard`, plus
   `/server/files/metadata` of the job (`estimated_time`) and whether the
   G-code contains `M73`. That tells which value the screen uses for each
   number.
2. **The same percentage as the screen**: in `apply_status`, take the
   source the screen takes (expected: `display_status`, i.e. `M73 P` when
   present). If the U1 exposes a field of its own, read it first.
3. **The same time left as the screen**: a slicer-based estimate instead of
   the extrapolation.
   - Read the job's `estimated_time` once per job (`/server/files/metadata`,
     already parsed in `printer_files.rs`), kept with the job name in the
     poll and live-feed state.
   - Time left = `estimated_time × (1 − p)` with the time-based `p` of
     `M73 P`, or `max(0, estimated_time − print_duration)` without it, as
     Mainsail's "slicer" estimate does; scaled by the speed factor when it
     is not 100 %.
   - Back to the current extrapolation when the file has no estimate
     (G-code from another slicer).
4. **Rounding** like the screen (floor or round, per step 1), in one helper
   used by every view (`fmtPct` next to `fmtHms`).
5. **Tests**: `printers.rs` tests with recorded U1 answers from step 1 (with
   and without `M73`, with and without `estimated_time`); the simulator
   (`sim/machine.rs`) sends `M73`-like progress and `estimated_time`
   already, its scenario checks the new time left.

No new interface string. Changelog: Unreleased › Fixed.

## Open questions

- Which values the U1's screen uses (step 1 answers it).
- If the screen's estimate itself is poor, should the app follow it anyway?
  Proposed: yes, the same numbers on both is what is asked; a better
  estimate can come later, for both.
