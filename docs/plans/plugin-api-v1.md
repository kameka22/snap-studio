# Plugin API v1 and the first built-in plugin (Care)

Plan only (draft PR). Step 1 and step 2 of the plugin system
(`plugin-system.md`, draft PR
[#93](https://github.com/kameka22/snap-studio/pull/93)): the smallest API
that a real feature can live on, and the **Care** tab of Care & Tuning
moved onto it. No visible change for users; no user plugins yet (step 3).

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

- Small and self-contained: `ui/maint.js` (about 400 lines) and
  `src-tauri/src/maintenance.rs` (about 230 lines, tested).
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
  `user` (step 3, isolated, permissions granted by the user).
- `permissions`: what the plugin may call; a host call without its
  permission is refused and logged, for built-ins too, so the list stays
  honest.
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
| `snappy` | An action Snappy can call (open the plugin's tab on a printer). | open Care |

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
| `ctx.printer.query(id, objects)` | `printer.read` | Moonraker objects (read only) |
| `ctx.printer.jobTotals(id)` | `printer.read` | hours and jobs |
| `ctx.storage.get(key)`, `.set(key, value)` | `storage` | the log and the last counters read |
| `ctx.open.url(url)` | `open.url` | guide and video |
| `ctx.i18n.t(key, vars)`, `ctx.i18n.on("change", fn)` | none | texts, and a redraw when the language changes |
| `ctx.ui.toast(text, error)` | none | errors |
| `ctx.ui.badge(printerId, n)` | none | the ⚠ and the dot |
| `ctx.ui.showTab(printerId, tab)` | none | open itself (Snappy) |

- `printer.read` only reads; nothing in v1 writes to the printer.
- `storage` is one JSON store per plugin, in the app's data folder
  (`plugins/<id>.json`), read and written by the Rust side, size limited
  (1 MB in v1).
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
  - `printer_query` / `printer_job_totals`: read-only Moonraker calls,
    the same client as today (`printers.rs`, 4 s timeout).
- `maintenance.rs`: the parsing of the counters (`parse`) moves to the
  plugin (JavaScript) with its tests (`scripts/test-care.js`), using the
  real U1 answers from the current Rust tests as fixtures. The
  `printer_maintenance`, `maintenance_log`, `maintenance_done` and
  `maintenance_remove` commands go once the plugin uses the host API.
- **Migration**: at the first start, `maintenance.json` is copied into the
  plugin's storage (`migrate.rs`, as the earlier migrations), then kept
  as is for one release in case of a return to the previous version.

## Interface side

- New `ui/plugins.js`: the loader (manifests, lifecycle, permissions) and
  the contributions (tabs, actions, badges, schedules, Snappy actions).
- New `ui/plugins/care/` with `plugin.json` and `main.js`: today's
  `maint.js` Care code, rewritten against `ctx`.
- `maint.js` keeps the Care & Tuning page and its other tabs (Control,
  Bed Leveling); its tab list becomes the built-in tabs plus the
  plugins' ones, in `order`.
- Untangle: today `mtLoad` also reloads the bed mesh (`bmLoad`) and
  `mtSideDots` adds the bed's warning to Care's count. The bed keeps its
  own badge through the same `ctx.ui.badge` path, so the side dot is the
  sum of every plugin's badges, as today.
- `snappy-actions.js`: `maintenance` opens the plugin's tab through its
  contribution instead of `maintShow(…, "care")`.
- CSP: unchanged in v1 (built-ins are files of the app, `script-src
  'self'`). The sandboxed origin for user plugins comes with step 3.

## Out of scope

- User plugins, the sandbox, Settings › Plugins, the in-app editor,
  signing and the index (steps 3 to 5).
- Moving other features (one PR each, later).
- Any change users can see.

## Open questions for the owner

1. Name in the interface (needed at step 3 only): « Plugins »,
   « Modules » or « Extensions » ?
2. Counter parsing in JavaScript (proposed, so a plugin is whole and
   reloadable) or kept in Rust behind a `printer.maintenance` host call
   (less moved code, but an API made for one plugin)?

## Testing

- `src-tauri/tests`: manifest validation (missing field, unknown `api`,
  unknown permission or contribution → disabled, no crash); storage per
  plugin and size limit; migration of `maintenance.json` (present,
  absent, corrupt).
- `scripts/test-plugins.js`: lifecycle (activate, deactivate, reload
  leaves no tab, action, badge or schedule behind); a call without its
  permission is refused.
- `scripts/test-care.js`: the counters and due tasks, on the fixtures of
  today's Rust tests.
- `check-i18n.py`: no new text expected in v1.
- In the app, before and after, on a U1: same tab, same counters, same
  ⚠ and side dot, a task marked done and undone, links, the hourly check,
  Snappy opening Care, a printer offline (last counters, stale date).

## Docs and CHANGELOG

- No CHANGELOG line in this PR (plan only). At implementation, under
  *Unreleased › Changed*: "**Care & Tuning**: the Care tab now runs on
  the new plugin system (no visible change)."
- `docs/plugins.md`: a first page for plugin authors (manifest, lifecycle,
  `ctx`), marked experimental until step 3.

## Estimate

About 1.5 weeks: the API and loader 4 to 6 days, Care moved 2 to 3 days.
