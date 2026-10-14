#!/usr/bin/env python3
"""Adds or updates keys in ui/i18n/{en,fr}.json, keeping insertion order.

    python3 scripts/i18n_add.py entries.json

`entries.json` maps each key to `[english, french]`; a plural value is
`[{"one": …, "other": …}, {"one": …, "other": …}]`. Existing keys are
overwritten in place, new keys are appended.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "ui" / "i18n"


def main():
    entries = json.loads(Path(sys.argv[1]).read_text())
    for i, lang in enumerate(["en", "fr"]):
        path = ROOT / f"{lang}.json"
        cat = json.loads(path.read_text()) if path.exists() else {}
        for key, values in entries.items():
            cat[key] = values[i]
        path.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n")
    print(f"{len(entries)} keys written")


if __name__ == "__main__":
    main()
