# Contributing to Snap Studio

**English** · [Français](CONTRIBUTING.fr.md)

Thanks for your interest! Snap Studio grows from what its users report:
bugs, needs, printers that behave oddly. Every contribution helps, code or
not.

## Report a bug

From the app: **Settings → About → Report a Bug** (or **Help → Report a
Bug…**). The form opens on GitHub with the version and the system already
filled in. Otherwise: [new issue](https://github.com/kameka22/snap-studio/issues/new/choose).

Before that, have a look at the [open issues](https://github.com/kameka22/snap-studio/issues):
the problem may be known. A good report says:

- what you did, what happened, what you expected;
- the steps to reproduce it, if you can;
- the 3MF file when a model is involved (attach it, or a smaller one that
  shows the same problem);
- the printer and its firmware when printing is involved.

## Suggest an idea

**Settings → About → Suggest an Idea**, or [new issue](https://github.com/kameka22/snap-studio/issues/new?template=feature.yml).
Describe the need — what you are trying to do and what gets in the way —
rather than the solution: there is often a simpler one. For questions and
ideas to talk over, use the [Discussions](https://github.com/kameka22/snap-studio/discussions).

## Contribute code

1. **Build**: Rust (stable) and the Tauri CLI, then `cargo tauri dev`. The
   interface is plain HTML/CSS/JavaScript in `ui/`, without npm.
2. **Test**: `cd src-tauri && cargo test --lib`. Some tests need the
   slicing engine or a real Claude Code and are opt-in (`--ignored`, see
   their comments).
3. **Write in English**: code, comments, commits and docs. Interface texts
   go in `ui/i18n/en.json` and `ui/i18n/fr.json` (never hard-coded);
   `python3 scripts/check-i18n.py` checks them.
4. **Follow the surrounding code**: its naming, its comment density, its
   idioms. The layout is described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#layout).
5. **One subject per pull request**, with what it changes and how it was
   checked. For a larger change, open an issue or a discussion first; the
   work in progress lives in [`docs/plans/`](docs/plans/).

## Translate

English is the reference, French a translation. Adding a language is
described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#languages).

## Code of conduct

Everyone taking part — issues, discussions, pull requests — follows the
[code of conduct](CODE_OF_CONDUCT.md): be respectful, constructive and
welcoming.

## License

Snap Studio is free software under the [GNU GPL v3](LICENSE) or later. By
contributing, you agree that your contribution is distributed under the
same license.
