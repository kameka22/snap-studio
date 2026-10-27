# Languages

## Goal

Snap Studio speaks English and French. The U1 is sold worldwide and the
slicer community reads its tools in many languages: OrcaSlicer ships 19.
Snap Studio adds languages in two waves, each a pull request, then opens
the catalogs to community review.

- **Wave 1** (this plan's first pull request): German (`de`), Spanish
  (`es`), Brazilian Portuguese (`pt-BR`), Italian (`it`).
- **Wave 2** (a separate pull request): Japanese (`ja`), Simplified Chinese
  (`zh-Hans`), Korean (`ko`). These need a look at fonts (CJK fallbacks in
  the font stack), line breaking (no spaces between words) and flags.
- **Follow-up**: [Weblate](https://weblate.org/) for review, so that
  native speakers correct and complete the catalogs without a pull request
  of their own.

The site and What's New stay in English and French; the release notes say
which languages a version adds.

## Infrastructure (wave 1)

- **One list of languages**, `LANGS` in `src-tauri/src/i18n.rs`: code, name
  in its own language (Deutsch, Español, Português (Brasil), Italiano), BCP 47
  locale, catalog. The interface reads it from `window.__I18N__.langs`
  (language picker in Settings and the welcome assistant, locale of dates and
  numbers): no list to keep in step in `ui/i18n.js`.
- **English fallback per key**: the window gets the English catalog and the
  current one; `tr()` looks a key up in the current catalog, then in English.
  A language chosen in Settings has its catalog fetched
  (`fetch("i18n/<code>.json")`, allowed by the CSP's `connect-src 'self'`)
  instead of inlining six catalogs in every window. Rust's `t!()` falls back
  the same way.
- **System language** on a fresh account: `from_locale` keeps the language
  part of the system locale (`de-AT` → `de`, `es_MX` → `es`), with `pt-*` →
  `pt-BR`; anything else → English.
- **Plurals**: `Intl.PluralRules` in the interface; in Rust, French and
  Brazilian Portuguese treat 0 and 1 as singular, the others only 1.
- **Dates and numbers**: `Intl` with the language's locale, everywhere
  (the old French special cases go through the same path).
- **Language picker**: with more than four languages it opens a searchable
  list; each language has its inline flag (`ui/segmented-logic.js`), a
  language without one shows its code.
- **Orca's settings**: `assets/orca-settings.<code>.json`, read in English
  when a language has none.
- **AI**: the reply language given to Claude follows the list (English name
  of the language).
- **macOS**: `CFBundleLocalizations` and one `InfoPlist.strings` per
  language for the permission prompts.
- **Check**: `scripts/check-i18n.py` checks every catalog: unknown keys,
  `{placeholders}` and HTML tags identical to English, plurals with an
  `other` form, and a completeness percentage per language. English and
  French must be complete; the others may lag behind English (fallback),
  unless `--strict`.

## Translations (wave 1)

The four catalogs are complete (2231 keys). They were translated in batches
of 150 keys from `en.json`, each batch checked by a script (placeholders,
tags, plural shape) before merging, in `en.json`'s order.

- **Words**: the slicer community's, taken from OrcaSlicer's own `.po`
  files where they exist: prime tower (*Reinigungsturm*, *Torre de purga*,
  *Torre de preparo*, *Torre di spurgo*), brim (*Umrandung*, *Borde*,
  *Borda*, *Tesa*), infill, supports, seam, slice (*Slicen*, *Laminar*,
  *Fatiar*, *Elabora*), plate, bed, nozzle, spool, travel.
- **Register**: German formal (*Sie*, like the French *vous*), Spanish
  *tú*, Brazilian Portuguese *você*, Italian *tu*.
- **Kept as is**: product names (Snap Studio, Snapmaker, U1, Orca, Claude
  Code, yolobox, bubblewrap), units, G-code commands, and texts that quote
  another program's own interface.
- **Spanish** is neutral, for Spain and Latin America alike: *equipo*,
  *teléfono*, *costo*, *video*; no *coger*.
- **Technical review**: each catalog was read again against English and
  Orca's labels in the same language, for the technical texts (slicing,
  hardware, calibration, Klipper, engine errors, AI setup): 20 keys changed
  in German, 52 in Spanish, 30 in Brazilian Portuguese, 44 in Italian
  (meaning, consistency with Orca, a unit, a few wordings). Kept after that
  review: "homing" in the four languages, *Umrandung*, *Torre de preparo*,
  *Elabora*, *Laminar*, *Torre de purga*, *Tesa*. Changed: Care & Tuning in
  German is *Wartung & Kalibrierung* (*Einstellung* read like *Einstellungen*,
  Settings, in the same sidebar).
- **Still to review by native speakers** (Weblate): the catalogs as a
  whole.

## Orca's settings

The Advanced settings and profile details use Orca's labels and tooltips,
generated into `ui/assets/orca-settings.<lang>.json` by
`scripts/gen-orca-settings.py` from OrcaSlicer's sources:

- `src/slic3r/GUI/Tab.cpp` and `src/libslic3r/PrintConfig.cpp` for the
  labels;
- `localization/i18n/<lang>/OrcaSlicer_<lang>.po` for the translations
  (`de`, `es`, `pt_BR`, `it`), from
  [Snapmaker/OrcaSlicer](https://github.com/Snapmaker/OrcaSlicer) at tag
  `v2.4.0` (the bundled engine's version).

Regenerate with a checkout of that tag:

```sh
python3 scripts/gen-orca-settings.py /path/to/OrcaSlicer
```

Labels Orca does not translate keep English. Entries Orca marks *fuzzy*
are kept: in v2.4.0 they are tooltips whose English moved a little, still
correctly translated. Out of 785 labels: German
615, Brazilian Portuguese 606, Italian 585, Spanish 538 (French 572).

## Layout

German is the longest of the four. Checked in the CSS: the sidebar and the
Settings menu cut their labels with an ellipsis; the Prepare toolbar folds
its labels to icons in narrow windows (thresholds set for French, which is
as long); the slice sheet's cards cut or wrap their texts. Fixed: the
Prints record's buttons now drop below the title when they do not fit, and
the slice sheet's toggles wrap centred. The Care & Tuning tab "Bed
Leveling" is shortened in es, pt-BR and it, as in French.

## To check

- On the Mac: the menu bar and the permission prompts in each language; a
  fresh account on a German, Spanish, Portuguese and Italian system.
- Long German labels in a narrow window (Prepare toolbar, Prints record,
  Care & Tuning tabs).
