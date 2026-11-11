# Plugin API v1 and the first built-in plugin (Care)

Plan only (draft PR). The first step of the plugin system
(`plugin-system.md`, draft PR
[#93](https://github.com/kameka22/snap-studio/pull/93)): the smallest API
that a real feature can live on, and the **Care** tab of Care & Tuning
moved onto it. No visible change for users; no user plugins yet.

## Steps of the plugin system

#93 gives the direction and "first step proposed"; the steps below are
this plan's breakdown of it (estimates are ours):

1. **API v1** (this plan): manifest, lifecycle, permissions, host calls,
   contributions. 4 to 6 days.
2. **First built-in plugin** (this plan): Care. 2 to 3 days.
3. **User plugins**: sandboxed origin, permissions granted by the user,
   Settings › Plugins, safe mode. 1 to 2 weeks.
4. **Live editing** in the app, Snappy writing plugins and calling every
   plugin action. About 1 week.
5. **Signed index**: signing, publishing, revocation. About 1 week.
6. **Larger features moved** (Prepare, Control, Calibration…), one PR
   each.

## Goal

- One API (`api: 1`) for built-in and, later, user plugins: a manifest, a
  lifecycle, permissions, a few host actions and a few places in the
  interface (contributions).
- Care rebuilt as a built-in plugin with only that API, so the API is
  shaped by a real feature before anyone outside depends on it.
- Everything Care does today still works the same way, in the 9 languages,
  with its data kept.

## Why Care first

Chosen on 2026-11-10 among the three candidates of the direction
(Maintenance, Favorites, bed mesh):

- Small: `ui/maint.js` (about 400 lines) and
  `src-tauri/src/maintenance.rs` (about 230 lines, tested). Not fully
  self-contained: the bed mesh and the printer simulator rely on it (see
  *Untangle* and *Simulator* below).
- It exercises most of what plugins need, without writing to the printer:
  - **a tab** in an existing page (Care & Tuning: Control, Care, Bed
    Leveling);
  - **badges**: the ⚠ on its tab and the dot on the printer in the side
    list (`mtSideDots`, `mtTabMarks`);
  - **a toolbar action** (Refresh, `#mt-refresh`);
  - **background work**: the counters read at launch, then hourly
    (`mtCheckAll`);
  - **reading the printer** (Moonraker status and job totals);
  - **its own data** (the log, `maintenance.json`) and a cache
    (`localStorage`);
  - **links** opened in the browser (guide and video);
  - **Snappy** opens it (`snappy-actions.js`, tab `maintenance`).
- The bed mesh (`bedmesh.js`, 1,300 lines) is three times bigger, and
  Favorites are woven into the library; both come later.

## Manifest

One `plugin.json` per plugin. Same shape for built-in and user plugins.

```json
{
  "id": "snapstudio.care",
  "api": 1,
  "version": "1.0.0",
  "name": "maint.tab.care",
  "kind": "builtin",
  "entry": "main.js",
  "permissions": ["printer.read", "storage", "open.url"],
  "contributes": {
    "tabs": [{ "id": "care", "page": "maint", "title": "maint.tab.care", "order": 20 }],
    "actions": [{ "id": "refresh", "where": "toolbar", "page": "maint", "tab": "care", "title": "maint.refresh", "icon": "refresh" }],
    "badges": ["tab", "printer"],
    "schedules": [{ "id": "check", "every": "1h", "atStart": true }]
  }
}
```

- `id`: reverse-domain style; `snapstudio.*` is reserved to built-ins.
- `api`: the API version the plugin was written for. The app refuses a
  plugin whose `api` it does not know.
- `name`, `title`: built-ins use the app's i18n keys (`ui/i18n`); user
  plugins (step 3) bring their own texts per language.
- `kind`: `builtin` (shipped with the app, every permission it lists) or
  `user` (step 3, isolated, permissions granted by the user). In v1,
  built-ins come inside the app's own package (already covered by the
  updater's signature), with no separate plugin signature; #93's signed
  bundles come with step 5.
- `permissions`: what the plugin may call; a host call without its
  permission is refused and logged, for built-ins too, so the list stays
  honest. In v1 this check is made by the loader (JavaScript): the Rust
  commands do not know yet which plugin calls them. Enforcing it on the
  Rust side, per origin, comes with the sandbox (step 3), and is required
  before any user plugin runs.
- `contributes`: where the plugin shows; the app draws it (below).

## Lifecycle

`found → checked → enabled → activated ⇄ deactivated`

- **Found**: built-ins are listed in `ui/plugins/index.json`, shipped with
  the app.
- **Checked**: the manifest is read and validated (fields, known `api`,
  known permissions and contribution kinds). A bad manifest disables the
  plugin with a line in the log, never a crash.
- **Enabled**: built-ins are on by default; the switch to turn one off
  comes with Settings › Plugins (step 3).
- **Activated**: `activate(ctx)` is called once the interface is ready;
  it registers what the contributions do (render the tab, run the action,
  count the badge). `deactivate()` undoes it: the tab, actions, badges and
  schedules go, the app removes them by itself.
- **Reload** (deactivate + activate) is supported from v1: live editing
  (step 4) needs it, and it is tested on Care.

## Contributions (places in the interface)

The plugin never touches the app's DOM outside the box it is given. It
declares places; the app draws the button, the tab and the badge in its
own style.

| Kind | v1 | Used by Care |
|---|---|---|
| `tabs` | A tab in an existing page that has tabs (v1: Care & Tuning). The plugin gets an empty box to render into, and `show` / `hide` calls. | yes |
| `actions` | A button in the page's toolbar, or an item in a menu; runs a plugin function. | Refresh |
| `badges` | A count on the plugin's tab, and a dot on a printer in the side list; the plugin returns a number per printer. | yes |
| `schedules` | A function run at start and/or every N minutes (minimum 5). | hourly check |
| `snappy` | v1: only "open the plugin's tab on a printer". #93's goal (every plugin action is a Snappy tool, under the same permissions) comes with step 4. | open Care |

Planned later, not in v1: slice recipes, G-code post-processing,
Prepare tools, panels in the side bar, printer macros (#93's extension
points).

## Host API (`ctx`)

What `activate(ctx)` receives. Every call is asynchronous and checked
against the manifest's permissions.

| Call | Permission | Care uses it for |
|---|---|---|
| `ctx.printers.list()`, `ctx.printers.current()` | none | the printer shown, every printer for the hourly check |
| `ctx.printers.on("change", fn)` | none | a printer added, removed or renamed |
| `ctx.printer.maintenance(id)` | `printer.read` | the U1's counters: tool changes and errors per head, hours, jobs (today's `maintenance::usage`, unchanged) |
| `ctx.printer.jobTotals(id)` | `printer.read` | hours and jobs |
| `ctx.storage.get(key)`, `.set(key, value)` | `storage` | the log and the last counters read |
| `ctx.open.url(url)` | `open.url` | guide and video |
| `ctx.i18n.t(key, vars)`, `ctx.i18n.on("change", fn)` | none | texts, and a redraw when the language changes |
| `ctx.ui.toast(text, error)` | none | errors |
| `ctx.ui.badge(printerId, { n, tip })` | none | the ⚠ and the dot, with the tab's tooltip |
| `ctx.ui.showTab(printerId, tab)` | none | open itself (Snappy) |

- `printer.read` only reads; nothing in v1 writes to the printer. A
  generic `query(objects)` is left for later: when it comes, object names
  are checked against Moonraker's naming (letters, digits, `_`, one space)
  and URL-encoded, as today's fixed list is safe only because it is fixed.
- `storage` is one JSON store per plugin, in the app's data folder
  (`plugins/<id>.json`), read and written by the Rust side, size limited
  (1 MB in v1). The Rust side checks the id before building the path
  (`^[a-z0-9]+(\.[a-z0-9-]+)+$`, so no `/` or `..`) and that it is a
  plugin of the index; anything else is refused.
- `ctx.storage` replaces Care's `localStorage` keys too: the last
  counters read (`snapstudio.maint.<printer>`) move into the plugin's
  store, imported once. The last tab chosen (`snapstudio.mtab.<printer>`)
  belongs to the Care & Tuning page, not to the plugin, and stays where
  it is.
- The badge function belongs to the app: plugins call it through `ctx`,
  and the bed mesh (not a plugin yet) calls the same function directly.
  Each badge carries its own tooltip (the bed's "out of tolerance" and
  "measurement due" texts stay).
- Built-ins call these from the main document (they are trusted). A
  check in `scripts/` makes sure files under `ui/plugins/` never call
  `invoke` or reach the DOM outside their box, so moving them to the
  sandbox of step 3 later costs nothing.

## Rust side

- New `src-tauri/src/plugins.rs`:
  - reads `index.json` and the manifests, validates them (`api`,
    permissions, contributions);
  - `plugin_storage_get` / `plugin_storage_set` commands, keyed by plugin
    id, with the size limit;
  - `printer_job_totals` (used by the plugin through `ctx` and by the bed
    mesh directly) and the existing `printer_maintenance`: read-only
    Moonraker calls,
    the same client as today (`printers.rs`, 4 s timeout).
- `maintenance.rs`: the counters stay read and parsed in Rust (`usage`,
  `parse` and their tests unchanged), behind the `printer.read` host call
  `ctx.printer.maintenance`. The log functions (`entries`, `done`,
  `remove`) and the `maintenance_log`, `maintenance_done` and
  `maintenance_remove` commands go: the log is the plugin's data, in its
  store.
- **Import of the log**: in `plugins.rs`, at the first read of
  `snapstudio.care`'s store: store absent and `maintenance.json` present
  → it is imported, never overwritten afterwards. (`migrate.rs` is the
  one-time carry-over from "3MF Studio" and is not used.)
  `maintenance.json` is left as it was; going back to the previous
  version shows the log as it was at the import, without the tasks
  marked done since.
- **Simulator** (`sim/`, Cargo feature `sim`): `sim/mod.rs` writes the
  scenario's log into the plugin's store (`plugins/snapstudio.care.json`)
  instead of `maintenance.json`; `sim/tests.rs` keeps testing
  `maintenance::usage`, unchanged since the parsing stays in Rust.

## Interface side

- New `ui/plugins.js`: the loader (manifests, lifecycle, permissions) and
  the contributions (tabs, actions, badges, schedules, Snappy actions).
- New `ui/plugins/care/` with `plugin.json` and `main.js`: today's
  `maint.js` Care code, rewritten against `ctx`.
- `maint.js` keeps the Care & Tuning page and its other tabs (Control,
  Bed Leveling); its tab list becomes the built-in tabs plus the
  plugins' ones, in `order`.
- Untangle, both ways:
  - Care → bed: today `mtLoad` also reloads the bed mesh (`bmLoad`) and
    `mtSideDots` adds the bed's warning to Care's count. The page calls
    `bmLoad` itself, and the bed sets its own badge through the app's
    badge function; the side dot is the sum of every badge, as today.
  - Bed → Care: `bmJobsNow` (`bedmesh.js`) reads the job count from
    Care's cache (`mtCached`) or `MT.usage`, for the "measurement due"
    reminder. Both go with Care: the bed reads the count itself through
    the app's `printer_job_totals` command, never through the plugin.
- `snappy-actions.js`: `maintenance` opens the plugin's tab through its
  contribution instead of `maintShow(…, "care")`.
- CSP: unchanged in v1 (built-ins are files of the app, `script-src
  'self'`). The sandboxed origin for user plugins comes with step 3.

## Out of scope

- User plugins, the sandbox, Settings › Plugins, the in-app editor,
  signing and the index (steps 3 to 5).
- Moving other features (one PR each, later).
- Any change users can see.

## Decisions and open questions

- Decided here: the counters stay parsed in Rust behind
  `ctx.printer.maintenance`. Moving them to JavaScript would also mean
  rewriting the simulator and its tests for no visible gain; the cost is
  one host call made for the U1, acceptable since Snap Studio targets the
  U1. A generic read can replace it later.
- Open, for the owner (needed at step 3 only): the name in the
  interface, « Plugins », « Modules » or « Extensions » ?

## Testing

- Rust unit tests in `plugins.rs` (`#[cfg(test)]`, as the rest of the
  project): manifest validation (missing field, unknown `api`, unknown
  permission or contribution → disabled, no crash); storage per plugin,
  size limit, ids refused (`../x`, `a/b`, unknown plugin); import of
  `maintenance.json` (present, absent, corrupt, store already there).
- `sim/tests.rs`: the simulated scenario's log is found in the plugin's
  store.
- `scripts/test-plugins.js`: lifecycle (activate, deactivate, reload
  leaves no tab, action, badge or schedule behind); a call without its
  permission is refused.
- `scripts/test-care.js`: the due tasks (`mtProgress`), on counters
  taken from today's Rust test fixtures.
- `check-i18n.py`: no new text expected in v1.
- In the app, before and after, on a U1: same tab, same counters, same
  ⚠ and side dot, a task marked done and undone, links, the hourly check,
  Snappy opening Care, a printer offline (last counters, stale date), the
  last tab remembered, the bed's "measurement due" reminder and its ⚠
  tooltip, the log kept after the update.

## Docs and CHANGELOG

- No CHANGELOG line in this PR (plan only). At implementation, under
  *Unreleased › Changed*: "**Care & Tuning**: the Care tab now runs on
  the new plugin system (no visible change)."
- `docs/plugins.md`: a first page for plugin authors (manifest, lifecycle,
  `ctx`), marked experimental until step 3.

## Estimate

About 1.5 weeks: the API and loader 4 to 6 days, Care moved 2 to 3 days.
