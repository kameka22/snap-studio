# Changelog

What changes from one version of Snap Studio to the next. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (0.x: the app is still young, a
minor version may change how things work).

Each version is published on the [releases page](https://github.com/kameka22/snap-studio/releases),
with its packages for macOS, Windows and Linux. What comes next:
[Roadmap](README.md#roadmap).

## [Unreleased]

### Added
- **Care & Tuning › Control** ([#17](https://github.com/kameka22/snap-studio/pull/17)):
  the printer's basic actions without G-code — home, a jog pad (X, Y, Z,
  0.1 to 50 mm), one card per head in its spool's colour (temperature
  gauge and target, activate, load, unload, extrude, retract), the bed's
  temperature, part and chamber fans, purifier, chamber light, a camera
  view, all heaters off, motors off, firmware restart and the emergency
  stop. Locked during a print (emergency stop, light and camera stay);
  each move once its axis is homed (as Klipper; a U1 homes X and Y
  together, Z after them, and picks a head or loads after homing X and Y
  itself), Z never under 0.5 mm, temperatures
  within each heater's maximum, one action at a time. Load and unload run
  the U1 feeder's own procedures, as its screen does (homing X and Y when
  needed, the filament's own temperature), and follow the head's filament
  sensor: Load once the filament is in the feed port of an empty head,
  Unload when the head holds filament. **Material & colour** declares a
  head's spool as the printer's screen does, from the list the printer
  itself holds (material, brand, type) and a colour; loading a spool
  without an RFID tag asks it first, so the printer heats to the right
  temperature (a tagged spool declares itself). Also opened from the
  printer's page (**Control**).
- **3D printer view** ([#34](https://github.com/kameka22/snap-studio/pull/34)):
  the printer's page shows the U1 in 3D (three.js, bundled with the app),
  over the whole page. Hover a part to highlight it; click a spool, a head,
  the bed or the chamber light to open its quick controls in a panel over
  the view (Control's compact components: temperature, load, unload,
  light), with **All controls** leading to Care & Tuning › Control on that
  head. Selecting a head turns the view to its spool's side, the bed or
  the light to the front; clicking the background deselects and turns
  back to the front.
  The Heads and spools card (top left) has one row per head (spool and
  its details, temperature, active, unloaded) plus the bed; a row selects
  its head. The print's status sits top centre. Left / Front / Right / Back, drag or ← → to turn,
  1–4 for a head, Esc to close. A quick bar for the light and the camera
  (shown in a corner of the view), the printer's details bottom right, and
  the emergency stop in the toolbar beside Control. Without WebGL the page
  keeps its 2D picture.

### Fixed
- The send sheet's options (timelapse camera, automatic bed leveling, flow
  calibration) now reach the U1: the print starts with them, as Snapmaker
  Orca does (`server.files.start_local_print`), instead of a command the
  firmware does not know. If the printer does not apply one, a dialog says
  so once the print has started
  ([#39](https://github.com/kameka22/snap-studio/pull/39)).

## [0.12.0] — 2026-10-21

### Added
- **Prepare, reworked** ([#28](https://github.com/kameka22/snap-studio/pull/28)):
  - placement, rotation and scale as sliders (live 3D, one undo step per
    drag, 15° notches), each field can switch to typing; scale per axis
    X/Y/Z;
  - objects on or off the plate: only objects fully on it are sliced
    ("Slice 3 Objects"); off-plate objects are greyed, listed apart, and
    come back with + or Add All; Take All Off; an object sticking out can
    be recentered or excluded; drag and drop between the list and the bed;
  - off-plate objects are parked in rows beside the bed, no wider than it;
  - the object list floats over the bed, the inspector shows for one
    selected object;
  - range selection (Shift-click) and rubber band (⌘/Ctrl + drag);
  - the toolbar only shows buttons that can act;
  - a loading indicator while a large file is read and its objects load;
    messages show at the top of the view.
- **Display settings** ([#24](https://github.com/kameka22/snap-studio/pull/24)):
  - light, dark or system appearance; a forced mode also sets the window's
    own (title bar);
  - ten themes, each light and dark, with live previews: Snap Studio,
    Snapmaker Space, High contrast, Graphite, Deep Night, Paper, Nord,
    Solarized, Filament (the app takes the color of the spool on T0) and
    macOS (Tahoe-style glass layout);
  - accent color: the theme's, the system's, eight presets or a custom one;
  - color-blind safe colors, over any theme;
  - the 3D views and terminals follow the theme.

- **Care & Tuning**: Maintenance becomes a view with tabs, Care and **Bed
  Leveling** ([#21](https://github.com/kameka22/snap-studio/pull/21)):
  - the bed's mesh read from the printer and kept over time: 3D view and
    map, history, trend, comparing two measurements;
  - one card with the bed's state and the one thing to do; limits suited
    to the U1 (0.5 / 1 mm by default, three levels), a good bed said to be
    compensated by the mesh;
  - measuring with an assistant: the bed confirmed clear, a temperature
    proposed from the last print (never above the bed's maximum), each of
    the U1's steps with a countdown for the 2 min settle, a clean stop and
    an emergency stop, the result against the previous measurement; the
    bed is turned off if it fails, and a lost connection does not lose the
    measurement;
  - the bed's shape named and shown on the map, with what to do (the knobs
    under a U1's bed), and "I've fixed it: measure again";
  - reminders after 30 days or 50 prints; "Measure first" in the send
    sheet; the tabs of a printer's Files and of an AI conversation sit on
    the left.

### Fixed
- The app's window comes to the front at launch on macOS
  ([#28](https://github.com/kameka22/snap-studio/pull/28)).
- Dense models (from about 400,000 triangles, as some MakerWorld files) no
  longer show full of holes in Prepare, the 3D viewer and the thumbnails:
  they are simplified for display instead of keeping one triangle in so
  many. Slicing still uses the whole mesh
  ([#31](https://github.com/kameka22/snap-studio/pull/31)).

## [0.11.0] — 2026-10-20

### Added
- **A printer's files** — a *Files* entry under each printer, read live from
  the printer ([#20](https://github.com/kameka22/snap-studio/pull/20)):
  - print files as a list or a grid: thumbnail, duration, filament per head,
    size, last print result; search and sort;
  - Print (same sheet as after a slice: start there, queue it, or print it on
    another printer), Download, Rename, Delete; select several at once;
  - a bottom bar with the actions of the file selected;
  - timelapses with a player (streamed from the printer, speed 0.5×–4×,
    full screen, previous/next), download and delete — on a U1, through its
    camera service, never by guessing which video;
  - the heads a file uses are read from the G-code when the printer's
    metadata does not say, so a multicolor file is prepared as such.
- **Share** a print file or a timelapse: the macOS share menu (AirDrop,
  Messages, Mail…), a QR code to download it on a phone on the same Wi-Fi
  (local link, 15 minutes), the file on the clipboard, Save As.
- **Speed** in the slice sheet: one slider, 50–120 % of the profile, with
  marks (very safe, safe, profile, fast) and a ⚙ panel showing each speed
  and acceleration, profile → computed; rows can be set by hand; first layer
  and travel moves only on request; nothing is sent at 100 %
  ([#29](https://github.com/kameka22/snap-studio/pull/29)).

### Changed
- The slice sheet is laid out in three areas: printer, plate and quality on
  the left, adjustments on the right, heads and model colors below; heads as
  compact cards, two per row ([#29](https://github.com/kameka22/snap-studio/pull/29)).

### Fixed
- After a print sent with a head substitution, the printer's extruder map
  goes back to identity when the print ends (a print started from the
  printer's screen no longer inherits it).
- AI conversations: the details bar under the preview is read again at the
  end of each answer; a line of Claude's output that is not valid UTF-8 no
  longer makes the app start a second sandbox; Claude's exit code is shown
  when it stops.

## [0.10.0] — 2026-10-20

### Added
- **Spool check before sending** — before a print starts (send, or start from
  the queue), each color of the model is compared with the spool loaded on its
  head: material and color ([#15](https://github.com/kameka22/snap-studio/pull/15)).
  - When they differ, a sheet shows the print and one row per color: the
    expected color and the heads to print it with (✓ when the spool fits).
    Taking a head another color uses swaps the two.
  - **Send** routes each color to the head chosen, for this print only,
    through the printer's extruder map (the G-code is not rewritten).
  - **Edit in Prepare** brings the plate back to Prepare with the slice
    sheet open on the spools loaded now; from the queue, the queued print is
    replaced once the new slice is sent.
  - Colors compared with CIEDE2000; an unreachable printer stops the send;
    a printer that reports no spools is not checked.
- **AI conversations, reworked** ([#25](https://github.com/kameka22/snap-studio/pull/25)):
  - list with search, filters, sort, groups by date, pins, inline rename,
    duplicate, context menu and keyboard;
  - **Delete Conversation** also removes Claude's session files (never
    another session's, never `history.jsonl`);
  - preview and chat side by side, adjustable; details bar under the preview
    (versions, measurements, Save, Slice); Save tells whether the version
    shown is already saved; a Bed switch in the preview;
  - **Stop Claude** inside the message field, and Esc;
  - the **Terminal** tab shows the chat's own Claude session, live and read
    only, instead of starting a second one;
  - a new creation sheet: large description field, ideas, the file's
    thumbnail, destination folder, where it runs, and the **Claude model**.
- Queued print: "Print on" with one chip per printer and its state; the
  start options as switches.
- A landing page for the project ([#14](https://github.com/kameka22/snap-studio/pull/14)).

### Changed
- Every on/off setting uses a real switch, announced as such to screen
  readers; the printer camera is turned on and off with a switch
  ([#26](https://github.com/kameka22/snap-studio/pull/26)).
- AI in the sidebar always leads to the list of conversations.

## [0.9.0] — 2026-10-18

### Added
- **Maintenance** view per printer: usage, head counters (tool changes,
  errors, hotend), tasks by urgency with Snapmaker's guide and video, a log
  of what was done ([#12](https://github.com/kameka22/snap-studio/pull/12)).
- Choose the Claude model of an AI conversation.

### Fixed
- Small fixes: back from a print record, AI object placement, trackpad pan
  (⇧ + two fingers), update badge, camera controls ([#13](https://github.com/kameka22/snap-studio/pull/13)).
- The Slice button fits its label.

## [0.8.2] — 2026-10-18

### Added
- Linux ARM (arm64) packages ([#10](https://github.com/kameka22/snap-studio/pull/10)).

### Fixed
- Library on Linux: its pages show over the interface ([#10](https://github.com/kameka22/snap-studio/pull/10)).
- Heads chosen for supports, walls or infill are forgotten with the plate,
  and shown in the summary ([#11](https://github.com/kameka22/snap-studio/pull/11)).

## [0.8.1] — 2026-10-17

### Added
- The print's picture on the printer's screen (thumbnails in the G-code).
- Split an object into its parts in Prepare ([#9](https://github.com/kameka22/snap-studio/pull/9)).

### Fixed
- Prepare uses the right printer and its four heads ([#8](https://github.com/kameka22/snap-studio/pull/8)).

## [0.8.0] — 2026-10-17

### Added
- **Colors per object**: painted 3MF files keep their colors, and each color
  of each object goes to the head you pick ([#7](https://github.com/kameka22/snap-studio/pull/7)).

## [0.7.3] — 2026-10-17

### Fixed
- Printer discovery no longer freezes on busy networks ([#6](https://github.com/kameka22/snap-studio/pull/6)).

## [0.7.2] — 2026-10-16

### Fixed
- The Library no longer freezes on macOS.

## [0.7.1] — 2026-10-16

### Fixed
- Windows: no freeze when the Library opens; thumbnails shown through
  WebView2's protocol addresses ([#5](https://github.com/kameka22/snap-studio/pull/5)).

## [0.7.0] — 2026-10-16

### Added
- **Heads and spools** screen per printer, and the spools' live colors in
  Prepare ([#4](https://github.com/kameka22/snap-studio/pull/4)).
- Orca-style advanced slice settings and custom profiles ([#3](https://github.com/kameka22/snap-studio/pull/3)).
- Prepare asks to clear or keep a plate that is not empty ([#2](https://github.com/kameka22/snap-studio/pull/2)).

### Changed
- An offline printer shows a single "not connected" card ([#1](https://github.com/kameka22/snap-studio/pull/1)).

## [0.6.0] — 2026-10-14

### Added
- AI setup per mode (sandbox or this computer), checked in the welcome
  assistant and in Settings; Settings with a side menu; About.
- Library: several tabs per site; favorites as saved links.
- Project page: README, screenshots, contributing guide, code of conduct,
  security policy, GPL-3.0 license.

### Changed
- Clearer buttons; files no longer open in an external slicer.

## [0.5.0] — 2026-10-14

### Added
- AI chat view, Claude sign-in window, multicolor 3MF results.
- AI: create an object from scratch.
- The interface in English, with a French translation.

## [0.4.0] — 2026-10-13

### Added
- Built-in slicing engine (Snapmaker Orca 2.4.0): downloaded once, kept up
  to date by the app.
- G-code preview: material mode, paths as shaded ribbons.

## [0.3.0] — 2026-10-12

### Added
- Prints and queue, plate type choice, profile details.

### Changed
- Slice sheet redesigned: two columns, visual pickers.

## [0.2.0] — 2026-10-12

### Added
- Welcome assistant; printers found on the network.

## [0.1.1] — 2026-10-12

### Added
- First public version: a 3MF browser with thumbnails, Prepare, built-in
  slicing, packages for macOS, Windows and Linux, automatic updates.

[Unreleased]: https://github.com/kameka22/snap-studio/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/kameka22/snap-studio/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/kameka22/snap-studio/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/kameka22/snap-studio/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/kameka22/snap-studio/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/kameka22/snap-studio/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/kameka22/snap-studio/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/kameka22/snap-studio/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/kameka22/snap-studio/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/kameka22/snap-studio/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/kameka22/snap-studio/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/kameka22/snap-studio/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/kameka22/snap-studio/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/kameka22/snap-studio/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/kameka22/snap-studio/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/kameka22/snap-studio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kameka22/snap-studio/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kameka22/snap-studio/releases/tag/v0.1.1
