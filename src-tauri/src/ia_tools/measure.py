#!/usr/bin/env python3
"""Dimensions, volume and health of the current state (or of a given file),
as a whole and part by part.

    python3 tools/measure.py [file.3mf | file.stl]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mf  # noqa: E402

path = sys.argv[1] if len(sys.argv) > 1 else "out/current.3mf"
if not os.path.exists(path):
    sys.exit(f"{path}: nothing yet — the first export creates it")
parts = mf.read(path)
m = mf.merged(parts)
x, y, z = m.extents
print(f"file       : {path}")
print(f"dimensions : {x:.2f} x {y:.2f} x {z:.2f} mm")
print(f"minimum    : {m.bounds[0].round(2).tolist()}")
print(f"maximum    : {m.bounds[1].round(2).tolist()}")
print(f"volume     : {sum(p.mesh.volume for p in parts) / 1000:.2f} cm3")
print(f"faces      : {len(m.faces)}")
tight = all(p.mesh.is_watertight for p in parts)
print(f"watertight : {'yes' if tight else 'NO'}")
print(f"parts      : {len(parts)}")
for p in parts:
    px, py, pz = p.mesh.extents
    print(
        f"  {p.name:<20} {p.color}  head {p.extruder}  {px:.1f} x {py:.1f} x {pz:.1f} mm"
        f"  {len(p.mesh.faces)} faces{'' if p.mesh.is_watertight else '  NOT WATERTIGHT'}"
    )
if not tight:
    print("warning    : a part that is not watertight will not slice")
