# Languages

## Goal

Snap Studio speaks English and French. The U1 is sold worldwide and the
slicer community reads its tools in many languages: OrcaSlicer ships 19.
Snap Studio adds languages in two waves, each a pull request, then opens
the catalogs to community review.

- **Wave 1** (this plan's first pull request): German (`de`), Spanish
  (`es`), Brazilian Portuguese (`pt-BR`), Italian (`it`).
- **Wave 2** (a separate pull request): Japanese (`ja`), Simplified Chinese
  (`zh-Hans`), Korean (`ko`), with CJK fonts, line breaking and flags
  (see Infrastructure and Translations, wave 2).
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

## Infrastructure (wave 2)

- **Plurals**: the Rust rule is an enum, `Plural::One` (1 is singular),
  `ZeroOne` (French, Brazilian Portuguese) or `Never` (Japanese, Chinese,
  Korean: always `other`). Their catalogs have only `other` forms;
  `check-i18n.py` refuses any other form for them.
- **System language**: `ja-*` → `ja`, `ko-*` → `ko`; Chinese goes to
  `zh-Hans` for `zh-CN`, `zh-SG`, `zh-Hans-*` and a bare `zh`. **Traditional
  Chinese** (`zh-TW`, `zh-HK`, `zh-MO`, `zh-Hant-*`) starts in **English for
  now**: a Simplified catalog would read wrong there. A `zh-Hant` catalog is
  a later addition.
- **Fonts**: `ui/style.css` sets `--font-ui` per language with `:lang()`
  (the root's `lang` follows the chosen language): Hiragino Sans / Yu
  Gothic UI / Meiryo for Japanese, PingFang SC / Microsoft YaHei for
  Chinese, Apple SD Gothic Neo / Malgun Gothic for Korean, then Noto CJK on
  Linux. No font is bundled.
- **Line breaking**: `line-break: strict` for Japanese and Chinese (no line
  starting with a small kana or closing punctuation), `word-break: keep-all`
  for Korean (breaks at spaces, like the language itself).
- **Uppercase labels**: section heads use `text-transform: uppercase` and
  letter spacing; CJK has no case, so the spacing is reset to 0 for these
  three languages, and the two 10px labels (picker sections, 3D tags) go to
  11px, the smallest size where kanji stay legible. No text relies on
  italics.
- **Flags**: inline SVG for Japan, China and South Korea (no ids, so they can
  repeat in a page).
- **macOS**: `ja`, `zh-Hans` and `ko` in `CFBundleLocalizations`, with an
  `InfoPlist.strings` each.

## Translations (wave 2)

The three catalogs are complete (2232 keys), translated in batches of 150
keys and checked by script as in wave 1 (placeholders, tags, plurals with
only `other`).

- **Words**: OrcaSlicer's own `ja`, `zh_CN` and `ko` translations:
  - Japanese: 造形 (print), 積層 / 積層ピッチ (layer, layer height),
    プライムタワー, ブリム, インフィル, サポート, 継ぎ目 (seam), スライス,
    プレート, ベッド, ノズル, フィラメント, スプール, 原点復帰 (homing),
    キャリブレーション.
  - Simplified Chinese: 打印, 层 / 层高, 擦拭塔 (prime tower), Brim (Orca
    keeps it in English), 填充, 支撑, 接缝, 切片, 打印板 (plate, also in the
    bed types), 热床, 喷嘴, 耗材, 料卷, 打印头, 回零, 校准, 空驶 (travel).
  - Korean: 출력, 레이어, 프라임 타워, 브림, 채우기 (infill), 서포트,
    재봉선 (seam), 슬라이스, 플레이트, 베드, 노즐, 필라멘트, 스풀, 원점 복귀,
    교정, 압출량 (flow).
- **Register**: Japanese です/ます; Chinese 你; Korean 합니다/하세요.
- **Punctuation**: full-width `：？！（）` in Japanese and Chinese, ASCII in
  Korean (as Korean writes it).
- **macOS words**: the system's own (Finder: 访达, Trash: 废纸篓, copy: 拷贝;
  フォルダ, ゴミ箱).
- **To review by native speakers**: Japanese 造形 against プリント and 積層
  against レイヤー (Orca's Japanese mixes them); Chinese 擦拭塔, Brim kept in
  English, 打印板 against 热床 in the bed types, 回零; Korean 채우기 against
  내부 채움, 재봉선, 교정 against 캘리브레이션, 후퇴 (retract); bed type
  names, which Orca's Japanese and Korean leave in English.

## Orca's settings

The Advanced settings and profile details use Orca's labels and tooltips,
generated into `ui/assets/orca-settings.<lang>.json` by
`scripts/gen-orca-settings.py` from OrcaSlicer's sources:

- `src/slic3r/GUI/Tab.cpp` and `src/libslic3r/PrintConfig.cpp` for the
  labels;
- `localization/i18n/<lang>/OrcaSlicer_<lang>.po` for the translations
  (`de`, `es`, `pt_BR`, `it`, `ja`, `zh_CN`, `ko`), from
  [Snapmaker/OrcaSlicer](https://github.com/Snapmaker/OrcaSlicer) at tag
  `v2.4.0` (the bundled engine's version).

Regenerate with a checkout of that tag:

```sh
python3 scripts/gen-orca-settings.py /path/to/OrcaSlicer
```

Labels Orca does not translate keep English. Entries Orca marks *fuzzy*
are kept: in v2.4.0 they are tooltips whose English moved a little, still
correctly translated. Out of 785 labels: Simplified
Chinese 627, German 615, Brazilian Portuguese 606, Italian 585, Korean 575,
Spanish 538, Japanese 375 (French 572). Japanese is the thinnest: about half
of the Advanced settings show in English there.

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
- Wave 2, on the Mac: the menu bar and permission prompts in Japanese,
  Chinese and Korean; a fresh account on a Japanese, Simplified Chinese,
  Korean and Traditional Chinese (English) system; the CJK fonts, line
  breaks and the 11px labels; the flags in the picker.
- Wave 2, on Windows and Linux: the font stacks (Yu Gothic UI, Microsoft
  YaHei, Malgun Gothic; Noto CJK).
