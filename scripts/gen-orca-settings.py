#!/usr/bin/env python3
"""Génère ui/assets/orca-settings.json à partir des sources de Snapmaker Orca.

Le détail des profils reprend les onglets d'Orca, en français, sans rien écrire
à la main :

- src/slic3r/GUI/Tab.cpp          pages, groupes et réglages de chaque onglet ;
- src/libslic3r/PrintConfig.cpp   libellé, infobulle, unité, valeurs d'une liste ;
- localization/i18n/fr/*.po       traduction française de ces textes.

À relancer quand Orca évolue :

    python3 scripts/gen-orca-settings.py [chemin/vers/OrcaSlicer]
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORCA = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "OrcaSlicer"
OUT = ROOT / "ui" / "assets" / "orca-settings.json"

STR = r'"(?:[^"\\]|\\.)*"'


def unescape(s):
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m[1], m[1]), s)


def literals(text):
    """Concatène les chaînes C consécutives d'une expression."""
    return "".join(unescape(m[1:-1]) for m in re.findall(STR, text))


# ---------------------------------------------------------------- traduction


def load_po(path):
    tr, msgid, msgstr, cur = {}, None, None, None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("msgid "):
            if msgid and msgstr:
                tr[msgid] = msgstr
            msgid, msgstr, cur = literals(line[6:]), None, "id"
        elif line.startswith("msgstr "):
            msgstr, cur = literals(line[7:]), "str"
        elif line.startswith('"'):
            if cur == "id":
                msgid += literals(line)
            elif cur == "str":
                msgstr += literals(line)
        else:
            cur = None if not line.startswith("#") else cur
    if msgid and msgstr:
        tr[msgid] = msgstr
    return tr


po = next((ORCA / "localization" / "i18n" / "fr").glob("*.po"))
TR = load_po(po)


def fr(text):
    return TR.get(text, text) if text else text


# ---------------------------------------------------------------- définitions


def load_defs(path):
    src = path.read_text(encoding="utf-8")
    keys = {}
    starts = list(re.finditer(r'def\s*=\s*this->add(?:_nullable)?\(\s*"([a-z0-9_]+)"\s*,\s*co([A-Za-z]+)', src))
    for i, m in enumerate(starts):
        block = src[m.end(): starts[i + 1].start() if i + 1 < len(starts) else len(src)]
        info = {}
        for field, name in (("label", "label"), ("full_label", "full_label"), ("tooltip", "tooltip"), ("sidetext", "unit")):
            f = re.search(r"def->" + field + r"\s*=\s*(?:L\()?((?:\s*" + STR + r")+)", block)
            if f:
                info[name] = literals(f.group(1))
        values = [literals(v) for v in re.findall(r"def->enum_values\.(?:push|emplace)_back\(\s*(" + STR + r")\s*\)", block)]
        labels = [literals(v) for v in re.findall(r"def->enum_labels\.(?:push|emplace)_back\(\s*(?:L\()?\s*(" + STR + r")", block)]
        if values:
            info["enum"] = {v: fr(labels[j]) if j < len(labels) else v for j, v in enumerate(values)}
        label = info.get("full_label") or info.get("label")
        entry = {"label": fr(label) if label else m.group(1)}
        if info.get("label") and info.get("full_label") and info["label"] != info["full_label"]:
            entry["short"] = fr(info["label"])
        if info.get("tooltip"):
            entry["tooltip"] = fr(info["tooltip"])
        if info.get("unit"):
            entry["unit"] = fr(info["unit"])
        if info.get("enum"):
            entry["enum"] = info["enum"]
        # bool, enum, percent, string… : guide la mise en forme des valeurs.
        entry["type"] = re.sub(r"s$", "", m.group(2).lower()).replace("floatsorpercent", "percent").replace("floatorpercent", "percent")
        # Une définition répétée (variantes) garde la plus complète.
        if m.group(1) not in keys or len(entry) > len(keys[m.group(1)]):
            keys[m.group(1)] = entry
    return keys


# ---------------------------------------------------------------- onglets


def body(src, signature):
    """Corps d'une fonction `void Classe::methode(...)`."""
    start = src.index(signature)
    i = src.index("{", start)
    depth = 0
    for j in range(i, len(src)):
        depth += {"{": 1, "}": -1}.get(src[j], 0)
        if depth == 0:
            return src[i: j + 1]
    raise ValueError(signature)


def pages_of(code, default_page="Extrudeur"):
    """Pages > groupes > réglages. Un réglage placé dans une ligne composée
    (« PEI texturé » : première couche, autres couches) garde le titre de
    cette ligne dans `lines`."""
    pages, page, group, row = [], None, None, None
    for raw in code.splitlines():
        line = raw.split("//", 1)[0]
        r = re.search(r"\bline\s*=\s*(?:Line\s*)?\{\s*L\(\s*(" + STR + r")", line, re.I)
        if r:
            row = fr(literals(r.group(1)))
        if "append_line(" in line or "append_single_option_line(" in line:
            row_end = True
        else:
            row_end = False
        p = re.search(r"add_options_page\(\s*(?:L\(\s*(" + STR + r")\s*\)|[a-z_]+)", line)
        if p:
            title = fr(literals(p.group(1))) if p.group(1) else default_page
            page = next((x for x in pages if x["title"] == title), None)
            if not page:
                page = {"title": title, "groups": []}
                pages.append(page)
            group = None
            continue
        g = re.search(r"new_optgroup\(\s*L\(\s*(" + STR + r")", line)
        if g and page is not None:
            title = fr(literals(g.group(1)))
            group = next((x for x in page["groups"] if x["title"] == title), None)
            if not group:
                group = {"title": title, "keys": []}
                page["groups"].append(group)
            continue
        if group is None:
            continue
        for k in re.findall(r'(?:append_single_option_line|get_option)\(\s*"([a-z0-9_]+)(?:#\d+)?"', line):
            if k not in group["keys"]:
                group["keys"].append(k)
            if row and "append_option(" in line:
                group.setdefault("lines", {})[k] = row
        if row_end:
            row = None
    # Groupes et pages vides : rien à afficher.
    for p in pages:
        p["groups"] = [g for g in p["groups"] if g["keys"]]
    return [p for p in pages if p["groups"]]


tab = (ORCA / "src" / "slic3r" / "GUI" / "Tab.cpp").read_text(encoding="utf-8")
layout = {
    "process": pages_of(body(tab, "void TabPrint::build()")),
    "filament": pages_of(body(tab, "void TabFilament::build()")),
    "machine": pages_of(body(tab, "void TabPrinter::build_fff()") + "\n" + body(tab, "void TabPrinter::build_unregular_pages(")),
}
keys = load_defs(ORCA / "src" / "libslic3r" / "PrintConfig.cpp")

used = {k for kind in layout.values() for p in kind for g in p["groups"] for k in g["keys"]}
missing = sorted(k for k in used if k not in keys)
out = {"source": "Snapmaker Orca (Tab.cpp, PrintConfig.cpp, fr.po)", **layout, "keys": keys}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

translated = sum(1 for k in keys.values() if k["label"] in TR.values())
print(f"{OUT.relative_to(ROOT)} : {len(keys)} réglages ({translated} libellés traduits), "
      + ", ".join(f"{kind} {len(p)} pages" for kind, p in layout.items()))
if missing:
    print("sans définition :", ", ".join(missing))
