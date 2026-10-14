---
name: export-3mf
description: How to save a part in this workspace — as a multicolor 3MF of named, colored parts with their print heads, through tools/mf.py and tools/export.py. Use it every time you install a result, add or change a color, split or merge parts, or need to read the current object's parts.
---

# Exporting a part as 3MF

Snap Studio shows, versions and prints **3MF** files only. A result is **one
object made of parts**; each part has:

| field | meaning |
|---|---|
| `name` | short and meaningful: `body`, `lid`, `eyes`, `label` |
| `color` | `#RRGGBB` (or `white`, `black`, `red`…), shown in the app and the previews |
| `extruder` | the head that prints it, 1 to 4 on the Snapmaker U1 |
| `mesh` | a `trimesh.Trimesh`, in millimeters |

An STL has no color and no parts: never hand one over as the result. STL
files are fine as intermediate files, to pass to `tools/export.py` with a
color.

`python3 tools/export.py …` is the only way to install a result: it checks
the parts, writes `out/current.3mf` at once, and the app archives a new
version and renders the previews again.

## Changing the current object (keep its parts)

```python
import sys; sys.path.insert(0, "tools")
import mf, trimesh

parts = mf.read("out/current.3mf")
for p in parts:
    print(p)                       # Part('body', #E8E8E8, head 1, 1204 faces)

body = next(p for p in parts if p.name == "body")
hole = trimesh.creation.cylinder(radius=2.1, height=40)
body.mesh = body.mesh.difference(hole)        # manifold3d does the boolean

mf.write("result.3mf", parts)                 # names, colors, heads kept
```

then `python3 tools/export.py result.3mf`.

## Building a multicolor object

```python
import sys; sys.path.insert(0, "tools")
import mf, numpy as np, trimesh

BODY, EYES = "#F2F2F2", "#151515"

body = trimesh.creation.box((40, 30, 20))     # front face at y = -15
body.apply_translation((0, 0, 10))            # resting on z = 0
facing = trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0])  # axis along Y
eyes = trimesh.util.concatenate([
    trimesh.creation.cylinder(radius=3, height=0.6, transform=facing).apply_translation((x, -14.7, 14))
    for x in (-8, 8)
])
# Colors must not overlap: the eyes are inlaid, flush with the front face.
body = body.difference(eyes)

mf.write("result.3mf", [
    mf.Part(body, "body", BODY, 1),
    mf.Part(eyes, "eyes", EYES, 2),
])
```

then `python3 tools/export.py result.3mf`.

Shortcut with STL files, one per color: `file[:color[:head]]`

```
python3 tools/export.py body.stl:#F2F2F2 eyes.stl:#151515
python3 tools/export.py body.stl:white eyes.stl:black:2
```

Without a head, each new color takes the next head; the same color keeps the
same head.

## Rules

- One color per part. Several parts may share a color and a head.
- At most **4 heads** on the U1: group the colors.
- Parts of different colors **must not overlap**: where they meet, subtract
  one from the other (`a.difference(b)`). Inlays and labels: dig a pocket
  about 0.6 mm deep, fill it with the colored part.
- Each part **watertight** (`p.mesh.is_watertight`), the whole object
  resting on `z = 0`. `export.py` warns otherwise: fix before going on.
- Thin colored details: at least 0.4 mm thick (one layer of a 0.4 mm nozzle
  is 0.2 mm; two layers are a minimum to show the color).
- Keep the colors the user chose; ask before changing them.
- `python3 tools/measure.py` gives dimensions part by part; then look at
  `preview/three-quarter.png`.
