<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="128" alt="Snap Studio icon" />

# Snap Studio

**The desktop workshop for your Snapmaker U1 — from file to print.**

[![Latest release](https://img.shields.io/github/v/release/kameka22/snap-studio?label=release&color=0a84ff)](https://github.com/kameka22/snap-studio/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/kameka22/snap-studio/total?color=30d158)](https://github.com/kameka22/snap-studio/releases)
[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-ffd60a)](LICENSE)
![macOS · Windows · Linux](https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux-lightgrey)

[**Download**](https://github.com/kameka22/snap-studio/releases/latest) ·
[Features](#features) · [AI](#design-with-ai) · [FAQ](#faq) ·
[Changelog](CHANGELOG.md) · [Roadmap](#roadmap) · [Contributing](CONTRIBUTING.md)

**English** · [Français](README.fr.md)

<img src="docs/screenshots/files.png" alt="Snap Studio — your 3MF files at a glance" />

</div>

## Why Snap Studio

- **The whole way in one app** — find a model, prepare the plate, slice
  with the Snapmaker Orca engine, send it, follow it on the camera.
- **Made for the U1's four heads** — the spools loaded on the printer are
  read, the colors of a multicolor model are mapped to the heads, and checked
  again before a print starts.
- **Design with AI** — describe a change or a new part; Claude models it,
  you watch it take shape in 3D, version by version.

## Features

**📁 Files** — thumbnails of your 3MF files (Orca, Bambu, Prusa, MakerWorld)
or a 3D render when there is none; duration, filament, plates; a 3D viewer
and layer-by-layer G-code toolpaths.

<table>
<tr>
<td width="50%" valign="top">

### 🧩 Prepare
The U1 plate as in Orca: move, rotate, scale (per axis too) with sliders,
duplicate, lay on face, auto-orient, auto-arrange, undo — then slice.
Objects can be set aside off the plate (not sliced) and put back in a
click. Each object lists its colors, painted ones included, and sends each
to the head you pick.

<img src="docs/screenshots/prepare.png" alt="Prepare" />

</td>
<td width="50%" valign="top">

### ✦ AI
Claude modifies a part or creates one from a description, in a chat with a
live 3D preview and every version kept. Results are multicolor 3MF files
that slice as they are. Conversations can be searched, pinned, renamed,
duplicated; see [Design with AI](#design-with-ai).

<img src="docs/screenshots/ai-chat.png" alt="An AI conversation" />

</td>
</tr>
<tr>
<td valign="top">

### 🖨 Printers
Found on the network on their own; live state, the four heads'
temperatures, the spools loaded in each, their [files and timelapses](#-printer-files-and-timelapses)
and their [care and bed leveling](#-care--tuning). Works with any Klipper printer.

<img src="docs/screenshots/printer.png" alt="Printer and its spools" />

</td>
<td valign="top">

### 📷 Camera
The printer's camera, live, from the printer's page and from each print.

<img src="docs/screenshots/printer-camera.png" alt="The printer's camera" />

</td>
</tr>
<tr>
<td valign="top">

### ⏱ Prints
Running prints and a queue: when one ends, Snap Studio offers the next
(never on its own), on the printer you pick. Progress, slicing summary,
temperatures, pause, cancel. Before a print starts, the
[spools are checked](#-spool-check).

<img src="docs/screenshots/print-job.png" alt="A print in progress" />

</td>
<td valign="top">

### 📚 Library
MakerWorld, Printables, Thingiverse and Cults3D in tabs, sessions kept;
downloads land in Files; favorites in the sidebar.

<img src="docs/screenshots/library.png" alt="Library" />

</td>
</tr>
</table>

### 🔧 Care & Tuning

Each printer has its Care & Tuning view, in three tabs: Control, Care and Bed Leveling.

**Care**, from what the printer counts and Snapmaker's maintenance guide:

- **Usage**: print time, prints, filament used, longest print.
- **Heads** (U1): tool changes, how far each is from the contacts' cleaning
  (every 100,000 tool changes), pick errors and retries — a head with errors
  is flagged — and its hotend (standard or high flow).
- **Tasks** sorted by urgency — head contacts, docking balls and pins, linear
  shafts and X rods, Z lead screws, nozzles, build plate — due "in 80 h" or
  "overdue by 296 h". Each one unfolds into its steps, the chapter of
  Snapmaker's video and the guide; **Done** logs it with the counters of the
  moment, and the next due date counts from there (undo from the
  notification).
- A dot in the sidebar when a task is due. Nothing is written to the printer.

Contacts follow Snapmaker's figure; the other intervals are prudent
defaults, Snapmaker gives none. On another Klipper printer, the view keeps
usage and the hour-based tasks.

<img src="docs/screenshots/maintenance.png" alt="Care &amp; Tuning: maintenance tasks and the heads' counters" />

**Bed Leveling**: the bed's mesh, read from the printer, kept over time.

- One card says how the bed is and the one thing to do: good (compensated
  by the printer's mesh), to watch, out of tolerance, or measure again.
  The default limits (0.5 / 1 mm, three levels) suit the U1, whose mesh
  compensates what is below; it asks for manual leveling only above 2 mm.
- The surface in 3D or as a map with every point's height; history,
  trend and the comparison of two measurements.
- **Measure** with an assistant: the bed confirmed clear (a print that has
  just ended is pointed out), a temperature proposed from the last print,
  then each of the U1's steps — heating, the 2 min settle, preheat, the
  corner check, probing — a clean stop or an emergency stop, and the
  result against the previous measurement.
- When the bed asks for attention, its shape is named and shown on the map
  (a tilted side, a raised corner, a hollow or domed bed, one point apart),
  with what to do — on a U1, the knobs under the bed and the printer's
  manual leveling — then "I've fixed it: measure again".
- A reminder in Care after 30 days or 50 prints, and "Measure first" in
  the send sheet when the bed is out of tolerance.

**Control**: the printer's basic actions, without G-code — also opened from
the printer's page (**Control**).

- Home (all axes or one), a jog pad for X, Y and Z (0.1 to 50 mm), the
  position live; clean the nozzle, go to the purge position.
- One card per head, in its spool's colour: temperature as a gauge, its
  target on a slider, activate, load, unload, extrude, retract.
- The bed's temperature; the part fan, the chamber fan, the purifier and
  the chamber light; a small camera view.
- Turn all heaters off, turn the motors off, restart the firmware, and the
  emergency stop, always in reach.
- Safe by design: locked during a print (only the emergency stop, the light
  and the camera stay), moves and head changes only once homed, Z never
  under 0.5 mm, temperatures never above each heater's maximum, one action
  at a time; what cannot run says why.

### 📂 Printer files and timelapses

Under each printer, **Files** shows what is stored on it, read live:

- **Print files**, as a list or a grid: thumbnail, duration, filament per
  head, size, the result of their last print; search and sort. **Print** opens
  the same sheet as after a slice — start it there, queue it, or print it on
  another printer — and the heads it uses are read from the file itself.
  Download, rename, delete, several at once; the file being printed is
  protected.
- **Timelapses**, played straight from the printer (speed 0.5×–4×, full
  screen, previous / next), downloaded or deleted.
- **Share** a file or a video: the macOS share menu (AirDrop, Messages,
  Mail…), a QR code to download it on your phone on the same Wi-Fi (a local
  link that stops after 15 minutes or when the sheet closes), the file on the
  clipboard, or Save As.

<img src="docs/screenshots/printer-files.png" alt="A printer's files, as a grid of thumbnails" />

### ✂️ Slicing

The Snapmaker Orca engine, downloaded once (about 30 MB) and kept up to
date by the app: you do not need Snapmaker Orca installed. The slice sheet
puts the printer, plate and quality on the left, the adjustments on the
right, the U1's four heads and the model's colors below:

- the spools read from the printer, each color of each object sent to its
  head, the plate surface (textured PEI, smooth PEI…) and its temperature;
- infill, walls, supports, brim, seam, Orca's advanced settings, and saving
  them as a custom profile;
- **Speed**: one slider from 50 % to 120 % of the profile (speeds × f,
  accelerations × f²), with a ⚙ panel showing each value, profile →
  computed; at 100 % the G-code is the profile's;
- each profile's details as the engine gets them.

Then a toolpath preview with duration, filament and cost, sent to the
printer — with its picture on the printer's screen — or saved as G-code.

<img src="docs/screenshots/slicing.png" alt="The slice sheet" />

### 🎨 Spool check

Before a print starts — sent after a slice, started from the queue or from a
printer's files — each color of the model is compared with the spool loaded
on its head (material, and color as the eye sees it). When they differ, a
sheet shows one row per color with the heads you can print it with:

- pick another head, and that color is printed from it — for this print
  only, through the printer's extruder map, the G-code is not rewritten;
- or **Edit in Prepare**: the plate comes back with the slice sheet open on
  the spools loaded now.

The check can be turned off in Settings → Prepare.

### 🌓 Display

Settings → Display: light, dark or as the system; ten themes, each with a
light and a dark version and a live preview — Snap Studio, Snapmaker Space
(navy sidebar), High contrast, Graphite, Deep Night, Paper, Nord,
Solarized, Filament (the app takes the color of the spool on T0) and macOS
(a Tahoe-style layout in glass); the accent color: the theme's, the
system's, a preset or your own; and color-blind safe colors over any theme
(states never told apart by red and green alone).

<img src="docs/screenshots/display.png" alt="Settings › Display: appearance and the ten themes" />

## Download

| System | File, from the [latest release](https://github.com/kameka22/snap-studio/releases/latest) |
|---|---|
| macOS (Intel and Apple Silicon) | `Snap-Studio_…_macos-universal.dmg` |
| Windows | `Snap-Studio_…_x64-setup.exe` |
| Linux | `Snap-Studio_…_amd64.AppImage` (or `.deb`) |
| Linux ARM (Raspberry Pi 4/5…) | `Snap-Studio_…_arm64.AppImage` (or `.deb`) — no slicing engine for ARM yet |

The packages are not signed by Apple or Microsoft yet. First launch on
macOS: right-click → Open (or
`xattr -dr com.apple.quarantine "/Applications/Snap Studio.app"`); on
Windows: "More info" → "Run anyway".

What each version brought: [CHANGELOG.md](CHANGELOG.md).

A **welcome assistant** sets everything up: language, models folder, the
printer on your network, the slicing engine and the AI. Afterwards **the
app updates itself** (on Linux, the AppImage).

## Design with AI

The AI runs [Claude Code](https://docs.claude.com/en/docs/claude-code/setup)
with your Claude account, either in a sandbox (an isolated container) or
directly on your computer. The welcome assistant and Settings → AI check
what your choice needs and say how to install what is missing; a mode
opens once everything is ready.

| | Sandbox | This computer |
|---|---|---|
| Claude Code 2.1.286 or later, signed in | ✓ | ✓ |
| [yolobox](https://github.com/finbarr/yolobox) | ✓ | |
| A running container engine: Docker (or OrbStack), Podman, or Apple `container` | ✓ | |
| Python 3 with `trimesh`, `manifold3d`, `numpy` | | ✓ |

**A conversation**, from a file ("Edit with AI" in Files) or from scratch:
describe what you want — ideas are offered — choose where it runs and the
Claude model. The 3D preview and the chat sit side by side: every version
Claude exports is kept, measured (size, weight, watertight) and can be shown
again; **Save** puts the version shown in your files, **Slice** sends it to
Prepare. **Stop Claude** (or Esc) interrupts an answer; the **Terminal** tab
shows the same session as a terminal does, live.

**The list** of conversations: search, filters, groups by date, pins,
rename, duplicate (same files, a fresh Claude session). **Delete** removes the
conversation's folder and Claude's own files for that session — never your
saved 3MF files, never another session.

## FAQ

**What changed in the last versions?** See the [changelog](CHANGELOG.md).

**Do I need Snapmaker Orca?** No. Snap Studio downloads its own engine. If
Snapmaker Orca is installed, its custom profiles are offered too.

**Does it work with other printers?** Printer status and sending work with
any Klipper (Moonraker) printer; the plate, profiles and heads are the
U1's.

**What leaves my computer?** No telemetry. Snap Studio talks to GitHub (to
check for updates and download the engine), to your printers on the local
network, to the sites you open in the Library, and — if you use the AI —
to Anthropic through Claude Code.

**Why does macOS warn me at the first launch?** The app is not signed with
an Apple developer certificate yet; the commands above open it anyway.

**I used 3MF Studio.** That was Snap Studio's former name: settings,
printers, favorites and conversations are carried over on first launch.

## Shortcuts

| | |
|---|---|
| ⌥⌘1 … ⌥⌘4 | Library / AI / Files / Prepare |
| ⌘O · ⌘R · ⌘F | open a folder · refresh · search |
| ⌘1 / ⌘2 | thumbnails / list |
| ⏎ · double-click | prepare (add to the plate); G-code: toolpaths |
| V | 3D view |
| ⌘⌫ | move to Trash |
| ⌘, | Settings |

In Prepare: R rotate, F lay on face, Q orient (⇧Q: all), A arrange,
⌘D duplicate, arrows 1 mm (⇧: 10 mm), ⌘Z / ⇧⌘Z; ⌘ + drag from an empty
spot selects with a rectangle, ⇧-click in the list selects a range.

In the AI list: ⌘F search, ↑ / ↓ and ⏎ open, F2 rename, ⌫ delete. In a
conversation: ⌘⏎ send, Esc stop Claude.

In a printer's files: ⏎ details, Esc close; in the player: ← / → previous /
next video, Space pause, Esc back.

## Roadmap

What has shipped is in the [changelog](CHANGELOG.md). What is planned, each
with its pull request (drafts, approved or under discussion):

| Feature | |
|---|---|
| **Several plates in Prepare** — plate tabs, auto-arrange across plates, slice them all and queue them; multi-plate 3MF files kept as such | [#18](https://github.com/kameka22/snap-studio/pull/18) |
| **Print by object** — one object after the other, with collision checks for the U1's head and an adjustable order | [#22](https://github.com/kameka22/snap-studio/pull/22) |
| **Plate and material warnings** — an incompatible plate and filament flagged before printing, and a tip when glue is advised | [#16](https://github.com/kameka22/snap-studio/pull/16) |
| **Calibration assistants** — PID of nozzles and bed, and guided input shaper, offsets between heads and flow measurement, in Care & Tuning | [#17](https://github.com/kameka22/snap-studio/pull/17) |
| **Filaments** — your spool inventory (weight deducted after each print, low-stock alert) and filament deals | [#19](https://github.com/kameka22/snap-studio/pull/19) |
| **Snapmaker hub** — Snapmaker Space, Store, Wiki, Forum and account in one menu, models opened straight in Prepare | [#23](https://github.com/kameka22/snap-studio/pull/23) |
| **Integrated title bar on Windows and Linux** — the same clean window as on macOS | [#27](https://github.com/kameka22/snap-studio/pull/27) |
| **More AI agents** — OpenCode next to Claude Code (OpenAI, Google, Mistral, local models…), one active at a time | [plan](docs/plans/ai-agents.md) |

Work in progress, what remains to check on a real printer and ideas for later
live in [`docs/plans/`](docs/plans/). Ideas are welcome in the
[Discussions](https://github.com/kameka22/snap-studio/discussions).

## Contributing

Bugs, ideas, code or translations: see [CONTRIBUTING.md](CONTRIBUTING.md).
From the app, **Settings → About** (or the **Help** menu) opens a bug report
with the version and system already filled in. Building, publishing, the
code layout: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License and credits

Snap Studio is free software, under the [GNU General Public License v3](LICENSE)
or later. Built with [Tauri](https://tauri.app) and Rust.

- Slicing engine: [Snapmaker Orca](https://github.com/Snapmaker/OrcaSlicer)
  (AGPL-3.0), itself based on [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer);
  the U1 plate assets come from its profiles (AGPL-3.0).
- Interface libraries: [marked](https://github.com/markedjs/marked),
  [DOMPurify](https://github.com/cure53/DOMPurify),
  [xterm.js](https://github.com/xtermjs/xterm.js) — see `ui/vendor/NOTICE.md`.

Snap Studio is an independent project, not affiliated with or endorsed by
Snapmaker. Snapmaker and U1 are trademarks of their owners.
