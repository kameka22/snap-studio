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
  `ui/printer3d.js:210-211`, `ui/control.js:619`). The time left goes
  through `fmtHms` (`ui/printers.js:187-192, 322`; it rounds the seconds
  then floors the minutes), `fmtDuration` (`ui/app.js:91`, in
  `ui/prints.js:583-584`) and, as an end time, `fmtClock`
  (`ui/prints.js:328, 567, 584`, `ui/slice.js:937`).

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

One limit to keep in mind: Klipper does not keep `M73 R` (time left sent
by the G-code); only `M73 P` ends up in `display_status.progress`. If the
screen shows `M73 R` and the U1 does not expose it in an object of its
own, the app can only come close to it, from `estimated_time` and
`M73 P`, not show the exact same minutes.

## Plan

1. **Measure on the U1** (no code). During a print of a few colours,
   several times (start, first layer, a tool change, middle, end), note
   what the screen shows and save:
   - `/printer/objects/list`, then a full query of every object that is
     not standard Klipper (the U1 has some: `print_task_config`), to find
     a progress or time left of its own;
   - `/printer/objects/query?print_stats&display_status&virtual_sdcard`;
   - `/server/files/metadata` of the job (`estimated_time`), and whether
     the G-code contains `M73` (`P` and `R`).

   That tells which value the screen uses for each number, and whether
   the U1 exposes the time left it shows.
2. **The same percentage as the screen**: in `apply_status`, take the
   source the screen takes (expected: `display_status`, i.e. `M73 P` when
   present). If the U1 exposes a field of its own, read it first.
3. **The same time left as the screen**: a slicer-based estimate instead of
   the extrapolation.
   - Read the job's `estimated_time` at each new job, not per file name
     (the slicer can write a new file under the same name): when the state
     turns to `printing` with another name or another start. Kept with the
     job in both paths, the poll (`printers.rs`) and the live feed
     (`watch.rs`). The metadata is read beside the status, never before it:
     it must not delay the status (4 s timeout when the printer is slow).
   - Time left = `estimated_time × (1 − p)` with the time-based `p` of
     `M73 P`, or `max(0, estimated_time − print_duration)` without it, as
     Mainsail's "slicer" estimate does. Scaled by the speed factor only if
     step 1 shows that the screen does it.
   - Back to the current extrapolation when the file has no estimate
     (G-code from another slicer).
4. **Rounding** like the screen (floor or round, per step 1), in one helper
   for the percentage used by every view (`fmtPct`), and the same rule for
   the time left in `fmtHms` and `fmtDuration`.
5. **Tests**: `printers.rs` tests with recorded U1 answers from step 1 (with
   and without `M73`, with and without `estimated_time`). The simulator
   gives `estimated_time` already, but the same value to
   `display_status.progress` and `virtual_sdcard.progress`
   (`sim/machine.rs:1086-1089`): a time-based `M73 P` that differs from the
   file position is to be added, and its scenario checks the new time
   left.

No new interface string. Changelog: Unreleased › Fixed.

## Open questions

- Which values the U1's screen uses (step 1 answers it), and whether its
  time left can be matched exactly or only closely (see `M73 R` above).
- If the screen's estimate itself is poor, should the app follow it anyway?
  Proposed: yes, the same numbers on both is what is asked; a better
  estimate can come later, for both.
