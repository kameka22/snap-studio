#!/usr/bin/env python3
"""Slimmed-down engine: copies the allow list, then archives and describes it.

    package.py prune   --platform macos --src <extracted> --dst <folder>
    package.py archive --dir <folder> --out <archive.tar.zst> --entry <entry point>
                       --platform-key macos-aarch64 --url <url>  → <archive>.json
    package.py manifest --version 2.4.0 <*.json fragments> → engine.json

zstd compression goes through the `zstandard` Python package (pip install
zstandard), available on all three systems.
"""

import argparse
import fnmatch
import hashlib
import json
import os
import shutil
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def patterns(platform):
    out, section = [], None
    for raw in (HERE / "keep.txt").read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
        elif section == platform:
            out.append(line)
    if not out:
        sys.exit(f"no pattern for {platform} in keep.txt")
    return out


def prune(args):
    src, dst = Path(args.src), Path(args.dst)
    if dst.exists():
        shutil.rmtree(dst)
    kept, missing = 0, []
    for pat in patterns(args.platform):
        # "folder/**": all its content (pathlib's `**` only yields folders
        # before Python 3.13).
        found = (src / pat[:-3]).rglob("*") if pat.endswith("/**") else src.glob(pat)
        hits = [p for p in found if p.is_file() or p.is_symlink()]
        if not hits:
            missing.append(pat)
        for p in hits:
            rel = p.relative_to(src)
            out = dst / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            # Symbolic links (macOS frameworks) kept as links.
            if p.is_symlink():
                os.symlink(os.readlink(p), out)
            else:
                shutil.copy2(p, out)
            kept += 1
    if missing:
        sys.exit("patterns without a match (official package changed?):\n  " + "\n  ".join(missing))
    size = sum(f.stat().st_size for f in dst.rglob("*") if f.is_file())
    print(f"{kept} files kept, {size / 1e6:.1f} MB")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def archive(args):
    import zstandard

    root, out = Path(args.dir), Path(args.out)
    unpacked = sum(f.stat().st_size for f in root.rglob("*") if f.is_file())
    with open(out, "wb") as fh:
        with zstandard.ZstdCompressor(level=19, threads=-1).stream_writer(fh) as zw:
            with tarfile.open(fileobj=zw, mode="w|") as tar:
                # Content at the archive's root; stable order.
                for p in sorted(root.rglob("*")):
                    tar.add(p, arcname=p.relative_to(root).as_posix(), recursive=False)
    info = {
        "key": args.platform_key,
        "url": args.url,
        "size": out.stat().st_size,
        "sha256": sha256(out),
        "unpacked": unpacked,
        "entry": args.entry,
    }
    out.with_suffix("").with_suffix(".json").write_text(json.dumps(info, indent=2))
    print(f"{out.name}: {info['size'] / 1e6:.1f} MB, sha256 {info['sha256']}")


def manifest(args):
    platforms = {}
    for frag in args.fragments:
        info = json.loads(Path(frag).read_text())
        platforms[info.pop("key")] = info
    doc = {
        "engine": "snapmaker-orca",
        "version": args.version,
        "source": f"https://github.com/Snapmaker/OrcaSlicer/tree/v{args.version}",
        "platforms": dict(sorted(platforms.items())),
    }
    Path(args.out).write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(doc, indent=2, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prune")
    p.add_argument("--platform", required=True, choices=["macos", "windows", "linux"])
    p.add_argument("--src", required=True)
    p.add_argument("--dst", required=True)
    a = sub.add_parser("archive")
    for k in ("dir", "out", "entry", "platform-key", "url"):
        a.add_argument("--" + k, required=True)
    m = sub.add_parser("manifest")
    m.add_argument("--version", required=True)
    m.add_argument("--out", default="engine.json")
    m.add_argument("fragments", nargs="+")
    args = ap.parse_args()
    {"prune": prune, "archive": archive, "manifest": manifest}[args.cmd](args)


if __name__ == "__main__":
    main()
