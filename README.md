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
[Contributing](CONTRIBUTING.md)

**English** · [Français](README.fr.md)

<img src="docs/screenshots/files.png" alt="Snap Studio — your 3MF files at a glance" />

</div>

## Why Snap Studio

- **The whole way in one app** — find a model, prepare the plate, slice
  with the Snapmaker Orca engine, send it, follow it on the camera.
- **Made for the U1's four heads** — the spools loaded on the printer are
  read, the colors of a multicolor model are mapped to the heads.
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
The U1 plate as in Orca: move, rotate, scale, duplicate, lay on face,
auto-orient, auto-arrange, undo — then slice. Each object lists its
colors, painted ones included, and sends each to the head you pick.

<img src="docs/screenshots/prepare.png" alt="Prepare" />

</td>
<td width="50%" valign="top">

### ✦ AI
Claude modifies a part or creates one from a description, in a chat with a
live 3D preview and every version kept. Results are multicolor 3MF files
that slice as they are.

<img src="docs/screenshots/ai-chat.png" alt="An AI conversation" />

</td>
</tr>
<tr>
<td valign="top">

### 🖨 Printers
Found on the network on their own; live state, the four heads'
temperatures, the spools loaded in each, and their [maintenance](#-maintenance).
Works with any Klipper printer.

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
(never on its own). Progress, slicing summary, temperatures, pause, cancel.

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

### 🔧 Maintenance

Each printer has its maintenance view, from what the printer counts and
Snapmaker's maintenance guide:

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

<img src="docs/screenshots/maintenance.png" alt="The maintenance view" />

### ✂️ Slicing

The Snapmaker Orca engine, downloaded once (about 30 MB) and kept up to
date by the app: you do not need Snapmaker Orca installed. The U1's four
heads with the spools read from the printer, each color of each object sent
to its head, the plate surface (textured PEI, smooth PEI…) and its
temperature, quality and adjustments, each profile's details as the engine
gets them; then a toolpath preview with duration, filament and cost, sent to
the printer — with its picture on the printer's screen — or saved as G-code.

<img src="docs/screenshots/slicing.png" alt="The slice sheet" />

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

## FAQ

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
⌘D duplicate, arrows 1 mm (⇧: 10 mm), ⌘Z / ⇧⌘Z.

## Roadmap

What is in progress and what comes next lives in [`docs/plans/`](docs/plans/).
Ideas are welcome in the [Discussions](https://github.com/kameka22/snap-studio/discussions).

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
