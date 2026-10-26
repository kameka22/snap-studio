# Prints page redesign

## Goal

The Prints page is a single column of cards (In progress, Queued, Finished)
and a record that lists the slice summary. It works, but it says little at a
glance: no live view on the overview, no sense of time for the queue, no
search in the history, nothing learned from past prints.

This plan proposes **three directions**, as mockups, to choose from before
any code. Each one covers running prints, the queue, the history and an
opened print.

Mockup: [`docs/mockups/prints-redesign/index.html`](../mockups/prints-redesign/index.html)
(open it in a browser; the bar at the bottom switches proposal, view and
theme). Screenshots, 1440 × 900, light and dark, French UI, sample data for
two Snapmaker U1: `proposal-{a,b,c}-{overview,detail}-{light,dark}-fr.png`.
`shoot.sh` redraws them with headless Chrome.

## The three directions

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

### C — List and record (master–detail)

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
| Period stats (time, filament per material, cost, success rate) | sums over finished jobs; success = `complete` against `cancelled` / `error` |
| Busy share per printer (B) | sum of `started → finished` spans over the day |
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

- Which direction, or which mix (for example C's list with A's live tiles
  on top)?
- Period stats: on the page (A) or in a separate view?
- The Result card: asked at the end of every print (in the "next one?"
  sheet), or only in the record?
- How long to keep the history, and should the G-code go after a while?
- The sidebar's per-print entries: keep them as they are?
