# Plugins (experimental)

> **Experimental, API v1.** Only the plugins built into Snap Studio run
> for now; installing your own comes later (see the steps in
> [docs/plans/plugin-api-v1.md](plans/plugin-api-v1.md)). What is written
> here may still change.

A plugin adds things to Snap Studio's interface (a tab, a toolbar button,
a badge, a task run on a schedule) without touching the app's code. It
reaches the app only through the `ctx` it is given, and only for what its
manifest declares. The Care tab of Care & Tuning is the first one:
[`ui/plugins/care/`](../ui/plugins/care).

## Files

```
ui/plugins/
  index.json            the built-ins: [{ "id", "dir" }]
  <dir>/plugin.json     the manifest
  <dir>/main.js         the entry (the manifest's "entry")
```

## Manifest

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
    "schedules": [{ "id": "check", "every": "1h", "atStart": true }],
    "snappy": [{ "id": "maintenance", "opens": "care" }]
  }
}
```

- `id`: lowercase, dotted (`^[a-z0-9]+(\.[a-z0-9-]+)+$`); `api`: 1.
- `name`, `title`: translation keys (`ui/i18n/*.json`, every language).
- A bad manifest turns the plugin off with a line in the log; the app
  carries on.

| Contribution | v1 |
|---|---|
| `tabs` | A tab of Care & Tuning (`page: "maint"`), placed by `order` (Control 10, Bed Leveling 30, Calibration 40). The plugin draws into the empty box it gets. |
| `actions` | A toolbar button on the page, shown on its `tab`. `icon: "refresh"` takes the place of the page's own refresh. |
| `badges` | `"tab"`: the ⚠ on the plugin's tab; `"printer"`: the dot on the printer in the side list (the sum of every badge). |
| `schedules` | Run every `every` (`"30m"`, `"1h"`, 5 minutes at least) and/or once at start (`atStart`), when the printers are known. |
| `snappy` | Snappy's action `id` opens the tab `opens`. |

## The script

```js
(function () {
  snapPlugin({
    id: "snapstudio.example",
    activate(ctx) {
      ctx.tab("example", {
        show(printerId, box, { reload }) { box.textContent = ctx.i18n.t("example.title"); },
        hide() {},
      });
      ctx.action("refresh", (printerId) => {});
      ctx.schedule("check", async () => {});
    },
    deactivate() {},
  });
})();
```

- Wrap the script in a function: it is loaded again when the plugin is
  reloaded.
- `activate` registers what each declared contribution does; one not
  declared throws. When the plugin is deactivated (or `activate` fails),
  the app removes its tabs, buttons, badges, schedules and listeners by
  itself.
- `show` is called each time the tab is shown; `reload` is true when it
  is opened or refreshed (read the printer again).

## `ctx`

Every call returns a promise; a call whose permission is not declared is
refused (rejected, and logged).

| Call | Permission |
|---|---|
| `ctx.printers.list()` → `[{ id, name, model }]`, `ctx.printers.current()` | — |
| `ctx.printers.on("change" \| "bed", fn)` | — |
| `ctx.printer.maintenance(id)`: the U1's counters (heads, hours, jobs, filament) | `printer.read` |
| `ctx.printer.bed(id)`: `{ due, meshes }`, what the bed asks and its measurements | `printer.read` |
| `ctx.storage.get(key)`, `ctx.storage.set(key, value)` (`null` removes) | `storage` |
| `ctx.open.url(url)`: https only, in the browser | `open.url` |
| `ctx.i18n.t(key, vars)`, `.num(n)`, `.dec(n, digits)`, `.locale()`, `.on("change", fn)` | — |
| `ctx.ui.toast(text, error, { label, run })` | — |
| `ctx.ui.badge(printerId, { n, tip } \| null)` | — (needs `badges`) |
| `ctx.ui.showTab(printerId, tab)` | — |
| `ctx.ui.offline(text, attr)`: the app's "printer offline" line | — |

- Storage: one JSON file per plugin in the app's data folder
  (`plugins/<id>.json`), 1 MB at most; keys are `[A-Za-z0-9._-]`, 64
  characters at most.
- Two calls of a plugin may run at once (a schedule over every printer):
  when a key holds several printers, chain its read-change-write steps
  one after the other, as Care does.
- `printer.read` only reads: nothing in v1 writes to a printer.
- Plugin files never use `invoke`, `document`, `window`, `localStorage`
  or `fetch`: `scripts/test-plugins.js` checks it, so that plugins can
  move to a sandbox later without change.

## Testing

Export the plugin's logic for node (see the end of
`ui/plugins/care/main.js`) and run it through `plgCreate` with a fake
page, as `scripts/test-care.js` does.
