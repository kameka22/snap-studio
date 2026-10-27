#!/usr/bin/env python3
"""Adds or updates keys in the catalogs of ui/i18n/, keeping insertion order.

    python3 scripts/i18n_add.py entries.json

`entries.json` maps each key to `[english, french]`, or to an object by
language (`{"en": …, "fr": …, "de": …}`) to fill other catalogs too; a plural
value is `{"one": …, "other": …}`. Existing keys are overwritten in place, new
keys are appended. A language left out keeps its value; where it has none,
the app shows English until a translator fills it.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "ui" / "i18n"


def main():
    entries = json.loads(Path(sys.argv[1]).read_text())
    by_lang = {}
    for key, values in entries.items():
        if isinstance(values, list):
            values = dict(zip(["en", "fr"], values))
        for lang, value in values.items():
            by_lang.setdefault(lang, {})[key] = value
    for lang, values in by_lang.items():
        path = ROOT / f"{lang}.json"
        cat = json.loads(path.read_text()) if path.exists() else {}
        cat.update(values)
        path.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n")
    print(f"{len(entries)} keys written")


if __name__ == "__main__":
    main()
