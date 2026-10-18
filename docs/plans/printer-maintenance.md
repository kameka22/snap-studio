# Printer maintenance

## Goal

A Maintenance view per printer: what the printer counts, what is due, and a
log of what was done — the Snapmaker U1 keeps the counters, Snapmaker gives
the tasks, the app puts them together.

## What the U1 exposes (read on a U1, firmware 1.3, Moonraker 2.0)

| Data | Source |
|---|---|
| Tool changes per head | `extruder…extruder3.switch_count` |
| Count at the last maintenance done on the screen | `last_maintenance_count` |
| Tool change errors / retries per head | `error_count`, `retry_count` |
| Hotend per head | `nozzle_volume_type` (`standard`, `high_flow`), `nozzle_diameter` |
| Jobs, print hours, filament | `/server/history/totals` |
| Purifier fan time | `purifier.inner_fan_work_time` |

Nothing resets `last_maintenance_count` from outside: the log is the app's.
Any Klipper printer has the history totals; the rest is U1-specific.

## Tasks (Snapmaker's guide and FAQ)

| Task | Due | Source |
|---|---|---|
| Head contacts (pogo pins), both sides | 100,000 tool changes since | official FAQ: reminder every 100,000 swaps |
| Docking balls and pins | 100,000 tool changes since | maintenance guide (with the contacts) |
| Linear shafts, bearings, X carbon rods | 500 h or 6 months | guide, no official interval |
| Z lead screws and nuts | 250 h or 3 months | guide, no official interval |
| Nozzles (brass brush, hot) | 100 h | guide, "when needed" |
| Build plate (water, dish soap) | 50 h | guide, "regularly" |

Defaults without an official interval are prudent; each task links to the
guide and the video.

## Decisions

- Read only: nothing is written to the printer.
- The log (`maintenance.json`, per printer) keeps, for each task done, the
  date, print hours and each head's tool changes: "since" is counted from
  there; never done → since the printer's start (its totals), and for the
  contacts the printer's own `last_maintenance_count`.
- State per task: OK, soon (80 %), due. A head whose tool change errors
  grew is flagged (contacts to clean, error 0002-0523-…-0045).
- Sidebar: a "Maintenance" entry under each printer, a dot when a task is
  due.

## Steps

1. Rust: `maintenance.rs` (counters, totals, log), commands, tests on the
   U1's answers.
2. UI: the view (usage, heads, tasks, log), sidebar entry and dot, i18n.
3. Checks: harness with the real answers, docs.

## Later

- Per-head usage estimated from the history (filament index ≠ head).
- A "clean nozzles" action (`ROUGHLY_CLEAN_NOZZLE`), idle printer only.
- Editable intervals; the T3 `high_flow` hotend raising its flow limit.
