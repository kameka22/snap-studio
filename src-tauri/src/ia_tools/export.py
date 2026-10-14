#!/usr/bin/env python3
"""Checks the parts then installs them as the current state (out/current.3mf).
Each install becomes a new version in the app.

    python3 tools/export.py result.3mf                  # parts written with mf.write
    python3 tools/export.py body.stl                     # one part
    python3 tools/export.py body.stl:#E8E8E8 eyes.stl:black:2 nose.stl:#D02020
                            # file[:color[:head]] — one part per file

Without a head, each new color takes the next head (1, 2, 3…); the same color
keeps the same head. A single STL keeps the color and head of a one-part
current state.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mf  # noqa: E402

CURRENT = "out/current.3mf"
# The Snapmaker U1 prints with four heads.
HEADS = 4


def parse(arg):
    """`file[:color[:head]]` — the color may start with #, which is no separator."""
    bits = arg.split(":")
    path, color, head = bits[0], None, None
    if len(bits) > 1 and bits[1]:
        color = bits[1]
    if len(bits) > 2 and bits[2]:
        head = int(bits[2])
    return path, color, head


def main(args):
    if not args:
        sys.exit(__doc__)
    parts = []
    if len(args) == 1 and args[0].lower().endswith(".3mf"):
        parts = mf.read(args[0])
    else:
        previous = []
        if os.path.exists(CURRENT):
            try:
                previous = mf.read(CURRENT)
            except Exception:
                previous = []
        heads = {}
        for arg in args:
            path, color, head = parse(arg)
            got = mf.read(path)
            if len(got) != 1:
                sys.exit(f"refused: {path} holds {len(got)} parts, give its parts one by one")
            part = got[0]
            if color is None and head is None and len(args) == 1 and len(previous) == 1:
                color, head = previous[0].color, previous[0].extruder
            part.color = mf.to_color(color) if color else mf.DEFAULT_COLOR
            if head is None:
                head = heads.get(part.color) or (max(heads.values(), default=0) + 1)
            heads.setdefault(part.color, head)
            part.extruder = head
            parts.append(part)

    if not parts:
        sys.exit("refused: no part")
    for p in parts:
        if len(p.mesh.faces) == 0:
            sys.exit(f"refused: {p.name} is an empty mesh")
        if not 1 <= p.extruder <= 16:
            sys.exit(f"refused: {p.name} on head {p.extruder}, heads go from 1 to 16")

    whole = mf.merged(parts)
    before = rendered_at()
    mf.write(CURRENT, parts)

    x, y, z = whole.extents
    print(f"installed: {x:.2f} x {y:.2f} x {z:.2f} mm, {len(parts)} part(s), {len(whole.faces)} faces")
    for p in parts:
        tight = "" if p.mesh.is_watertight else "  NOT WATERTIGHT"
        print(f"  {p.name:<20} {p.color}  head {p.extruder}  {len(p.mesh.faces)} faces{tight}")
    if any(not p.mesh.is_watertight for p in parts):
        print("warning: a part that is not watertight may fail to slice")
    used = sorted({p.extruder for p in parts})
    if max(used) > HEADS:
        print(f"warning: heads {used} — the Snapmaker U1 has {HEADS}; group the colors on {HEADS} heads at most")
    if abs(whole.bounds[0][2]) > 0.01:
        print(f"warning: the part rests at z = {whole.bounds[0][2]:.2f}, not on the plate (z = 0)")
    wait_for_previews(before)


PREVIEW = "preview/three-quarter.png"


def rendered_at():
    return os.path.getmtime(PREVIEW) if os.path.exists(PREVIEW) else 0.0


def wait_for_previews(before, timeout=8.0):
    """The app renders the previews again a moment after the install: wait for
    them, so that the next look shows this version and not the previous one."""
    end = time.time() + timeout
    while time.time() < end:
        if rendered_at() > before:
            print(f"previews updated: look at {PREVIEW}")
            return
        time.sleep(0.25)
    print("previews not updated yet (is the app open?) — look again in a moment")


if __name__ == "__main__":
    main(sys.argv[1:])
