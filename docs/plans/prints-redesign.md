# Prints page redesign

## Goal

The Prints page is a single column of cards (In progress, Queued, Finished)
and a record that lists the slice summary. It works, but it says little at a
glance: no live view on the overview, no sense of time for the queue, no
search in the history, nothing learned from past prints.

This plan first proposed **three directions** (A, B, C) as mockups, then a
mix of A and C drawn as **D**. The user finally chose **C — List and
record**, which is the direction to implement; A, B and D stay in the
mockup for reference (D is superseded).

Mockup: [`docs/mockups/prints-redesign/index.html`](../mockups/prints-redesign/index.html)
(open it in a browser; the bar at the bottom switches proposal, view and
theme; C opens by default). Screenshots, 1440 × 900, light and dark, French
UI, sample data for two Snapmaker U1:
`proposal-c-{running,finished}-{light,dark}-fr.png` for C,
`proposal-{a,b}-{overview,detail}-{light,dark}-fr.png` and
`proposal-d-{overview,detail-running,detail-finished}-{light,dark}-fr.png`
for the others. `shoot.sh` redraws them with headless Chrome.

## Chosen direction: C — List and record

A mail-style split, the list on the left, the record on the right, always
open (no dashboard and no back button).

- **List**: search (name, file), a segmented filter (All, Active,
  Finished, Failed), chips per printer and material; groups **In
  progress**, **Queue** (with its total time and each print's estimated
  start), **Today**, **Yesterday**, then by day with the filament used.
  Running rows show a progress line; history rows show printer, time,
  duration and state.
- **Record of a running print**: header with Pause / Cancel; camera and a
  big progress block (percent, layer, remaining, end time, elapsed,
  temperatures, speed); **time per layer** with the current layer marked;
  filament per head (the active head marked); timeline.
- **Record of a finished print**: the timelapse in place of the camera, the
  **Result** card (Success / Failed, a note), real against estimated
  duration, filament and cost, settings chips, timeline with pauses, time
  per feature; **Reprint** and **Open in Prepare** in the header.

### What does not change

- **The sidebar's Prints submenu stays as it is today**: the running prints
  with their progress (or "pause"), then the queued prints, numbered. The
  count next to Prints keeps counting running and queued prints.

### What is left out

- **No stats strip on the Prints page.** Period stats (print time,
  filament per material, cost, success rate) and the busy share per
  printer leave this page.

## Follow-up (separate pull request): statistics

- **New tabs on the printer page**, with that printer's stats (print time,
  filament, success rate, busy share) next to what the page shows today.
- A separate **Statistics page** for all printers, over a period (7 d /
  30 d / All).
- Both read the same sums over finished jobs as listed below, and benefit
  from the Result field and the longer history in *New data*.

## Other directions (reference)

### A — Dashboard

A page made of tiles, for someone who glances at the app between prints.

- **Stats strip** over a period (7 days, 30 days, all, a segmented control
  in the title bar): print time with a per-day sparkline, filament used with
  a per-color bar and per-material split, estimated cost, success rate.
- **One tile per busy printer**: camera frame, state, progress, layer,
  time left and end time, head tokens with the active one ringed,
  temperatures, Pause/Resume and Cancel on the tile.
- **Queue** (drag to reorder, estimated start, why it waits: "after
  Support casque", "bed to clear first") and a **compact history table**
  (printer, real duration, filament per color, state) side by side.
- **Record**: large camera, progress ring with end time, elapsed, layer and
  speed, temperatures; then three cards: filament per head, time per
  feature, timeline of the print.

### B — Agenda per printer

Time is the axis: for someone who runs a queue over a day.

- **One lane per printer** on a day axis (Day / 3 days / Week, Now): past
  prints in their state color, the running print filled to its progress
  (a paused span hatched), queued prints as dashed blocks at their
  estimated start, a "clear the bed" marker between two prints, "free"
  after the last one, a red Now line.
- **Earlier days** as rows with a mini lane per printer and the day's
  totals; **Today**: busy share of each printer, print time, filament,
  done and failed counts, when both printers will be free.
- **Record**: an inspector docked on the right (the agenda zooms in), with
  camera, progress, end and estimate, then Follow / Slice / Timeline tabs,
  and what comes next on that printer.

### C — List and record (master–detail), as first drawn

A mail-style split: for someone who looks back and compares.

- **List** on the left: search (name, file), a segmented filter (All,
  Active, Finished, Failed), chips per printer and material; groups In
  progress, Queue (with its total time), Today, Yesterday, then by day with
  the filament used. Running rows show a progress line.
- **Record** on the right, always open: header with actions; for a running
  print, camera and a big progress block, **time per layer** (the current
  layer marked), filament per head, timeline.
- For a **finished print**: the timelapse in place of the camera, a
  **Result** card (Success / Failed, a note), real against estimated
  duration, filament, settings chips, timeline with pauses, time per
  feature; Reprint and Open in Prepare.

### D — A + C (superseded)

A's dashboard (stats strip, one live card per busy printer, the queue and a
Today card) over C's history; a click turned the page into C's split with
a back button. Superseded by C alone: the stats move to the printer page
and a Statistics page, and the split is the whole page.

## What is shown and where it comes from

| Information | Source |
|---|---|
| Name, printer, state, created / started / finished | `Job` (`jobs.rs`) |
| Thumbnail | `Job.file` → G-code thumbnail (`thumbSrc`) |
| Estimated time, layers, filament total, cost | `Job.stats` (`print_time_s`, `layers`, `filament_g`, `cost`) |
| Filament per head (g, m), material and color | `stats.per_tool_g`, `per_tool_m`, `filament_types`, `filament_colors`; `profile.colors` / `filaments` |
| Time per feature | `stats.features` |
| Time per layer | `stats.layer_end_s` (difference between two layers) |
| Process, plate, options | `profile.process`, `profile.bed_label`, `Job.options` |
| Progress, elapsed, remaining, layer, temperatures, speed, active head | live `Status` (`printers.rs`) |
| Camera | printer camera, as in today's record |
| Estimated start in the queue, "free at" | `pjStartEstimate` (already in `prints.js`) |
| Real duration, real against estimate | `finished − started` against `print_time_s` |
| Period stats (follow-up: printer tabs, Statistics page) | sums over finished jobs; success = `complete` against `cancelled` / `error` |
| Busy share per printer (B; follow-up) | sum of `started → finished` spans over the day |
| Timelapse of a finished print (C) | printer files (`printer-files.js`), matched to the job by printer and end time |

## New data

- **Result** of a print (Success / Failed, an optional reason and note):
  new fields on `Job`, set by the user. A failed outcome would count against
  the success rate instead of the state alone.
- **Pause and resume times**: new events on `Job`, recorded by the
  background tracking (today a pause leaves no trace). Needed for the hatched
  span (B) and the timeline (A, C).
- **Timelapse link**: store the matched timelapse path on the job once
  found, so the record does not search every time.
- History kept **longer and lighter**: stats need finished jobs; today
  removing a job from the history deletes its G-code. A job could keep its
  record (stats, thumbnail) without the G-code.

## Open questions

- The Result card: asked at the end of every print (in the "next one?"
  sheet), or only in the record?
- How long to keep the history, and should the G-code go after a while?
- The record when nothing is selected on opening the page: the first
  running print, else the latest finished one?

Decided: the split page (not a panel over a dashboard); no stats on this
page, stats per printer go to the printer page in the follow-up; the
sidebar's Prints submenu unchanged.
