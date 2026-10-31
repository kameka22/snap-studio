# Printer files: deleting several files deletes only one

A printer's Files page (Printer › Files, `ui/printer-files.js`): with
several files picked in Select mode, a delete often removes a single file,
and the other files are no longer picked afterwards.

## Root cause

The page has two ways to delete, and only one of them uses the picked
files.

- **Selection bar → Delete** works: `pflBarFiles()` returns every picked file
  in Select mode (`ui/printer-files.js:730`, `:738`), `pflDelete` sends them
  in one `pf_delete` call per root (`:444-485`, `pflDeleteBatches` in
  `ui/pfiles-logic.js:149`), and `pf_delete` deletes them one after the
  other and returns one result per path (`src-tauri/src/lib.rs:706-722`).
- **Right-click → Delete** deletes the clicked file only. The context menu
  handler (`ui/printer-files.js:672-695`) never looks at `PFL.selMode` or
  `PFL.picked`: it calls `pflSelect(item.dataset.k)` (`:681`, a single
  selection that Select mode does not even show) and offers the one-file
  menu (Print, Download, Share, Rename, Delete). Its handler then runs
  `pflDelete([f])` on that file (`onMenu("pfl")`, `:697-706`, delete at
  `:704`). The confirmation says "Delete … ?" for that one file, which is easy
  to miss.
- Then `pflDelete` empties the whole selection (`PFL.picked = new Set()`,
  `:482`), so the files that were not deleted are no longer picked either. It
  looks like the delete "lost" them.

Right-clicking a picked file is the usual way to act on a selection, as it
is in the app's own Files view (`ui/app.js:856-870`: the menu acts on every
selected file and says "Move {n} Files to Trash"). That is why the bug shows
up most of the time.

Reproduced outside the app with a jsdom harness. It loads `pfiles-logic.js`
and `printer-files.js`, mocks `invoke` with three files and picks the three
in Select mode:

```
1) selection bar Delete -> [ 'a.gcode', 'b.gcode', 'c.gcode' ]
   context menu items: pfiles.print | common.download | share.button | pfiles.rename | common.delete
2) context menu Delete -> [ 'b.gcode' ] remaining picked: 0
```

Also checked, and not the cause: the selection is keyed by `root/path`
(`pflKey`), not by index, and survives a reload (`:103`). The delete is one
sequential command with a list, not parallel requests. Each path gets its own
result, and a failure is shown in a toast. The busy flag blocks a second
delete while the first one runs. Keys are escaped the same way on both sides
(`data-k` ↔ `dataset.k`).

## Fix

1. **The menu acts on the picked files.** A pure helper in
   `ui/pfiles-logic.js`, for example
   `pflMenuTargets(selMode, picked, key) → keys`. In Select mode, a
   right-click on a picked file returns every picked key (in list order). A
   right-click on a file that is not picked returns that file alone, and the
   picks stay. Outside Select mode, it returns the clicked file.
2. **Context menu** (`:672-695`): with more than one target, show only the
   actions that work on several files: Download and "Delete {n} files" (new
   key `pfiles.delete_many`, plural forms, in all 9 languages). Print, Share,
   Rename and Play are hidden. Do not call `pflSelect` in Select mode. Keep
   the targets in `PFL.menuKeys` (replaces `PFL.menuKey`) so that
   `onMenu("pfl")` runs `pflDelete` / `pflDownload` on all of them. With one
   target, the menu stays as it is today.
3. **`pflDelete` keeps the other picks**: remove only the keys of the files
   it sent from `PFL.picked`, instead of clearing everything. The reload
   (`pflLoad`, `:103`) already drops what is gone, and a file that failed
   stays picked so it can be retried.

No Rust change: `pf_delete` already takes a list.

## Tests

- `scripts/test-pfiles.js`: `pflMenuTargets` covers several picked files
  with a right-click on one of them (all returned, in list order), a
  right-click on a file that is not picked (that one only), Select mode off
  (that one only), and an empty selection.
- `cargo fmt --check && cargo test --lib`, every `scripts/test-*.js`, and
  `python3 scripts/check-i18n.py`.

## Manual test (on a printer, files you can lose)

1. Printer › Files › Files tab, list view. Select, then pick 3 files.
   Right-click one of them: the menu reads "Delete 3 files" and has no
   Print, Share or Rename. Delete and confirm: the 3 files are gone.
2. Same in grid view, and in the Videos tab with 2 or 3 timelapses.
3. Pick 3 files and right-click a fourth one that is not picked: the menu is
   the one-file menu. Delete deletes only the fourth, and the 3 stay picked.
4. The selection bar's Delete with 3 picked files still deletes the 3.
5. A file that is printing stays protected, from the menu and from the bar.
6. Outside Select mode, right-click → Delete still deletes one file.
