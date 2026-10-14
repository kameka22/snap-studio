#!/usr/bin/env bash
# Publishes the bundled slicing engine for a Snapmaker Orca version: starts
# the "Engine" workflow (slimming, test slice on the four platforms,
# `engine-orca-<version>` release), then updates src-tauri/engine.json,
# commits and pushes it. The next Snap Studio release (scripts/release.sh)
# embeds this engine.
#
# Only to change the Orca version — not at every release.
#
#   scripts/engine.sh 2.4.0            publish engine 2.4.0
#   scripts/engine.sh 2.4.0 --force    rebuild an existing release
#   scripts/engine.sh 2.4.0 -y         without asking for confirmation
set -euo pipefail

version=""
force=false
yes=false
for a in "$@"; do
  case "$a" in
    -y|--yes) yes=true ;;
    --force) force=true ;;
    -*) echo "unknown option: $a" >&2; exit 1 ;;
    *) version="${a#v}" ;;
  esac
done
[ -n "$version" ] || { echo "usage: scripts/engine.sh <Orca version> [--force] [-y]" >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$ ]] || { echo "invalid version: $version" >&2; exit 1; }

ref=main
workflow="engine.yml"
tag="engine-orca-$version"
manifest="src-tauri/engine.json"
cd "$(dirname "$0")/.."
source scripts/lib-run.sh

command -v gh >/dev/null || { echo "gh not found: brew install gh" >&2; exit 1; }

# The engine.json commit starts from this copy: clean, on main, up to date.
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Uncommitted changes: commit them first." >&2
  exit 1
fi
if [ "$(git rev-parse --abbrev-ref HEAD)" != "$ref" ]; then
  echo "✗ Switch to \"$ref\" (git switch $ref)." >&2
  exit 1
fi
git fetch -q origin "$ref"
if [ -n "$(git rev-list "HEAD..origin/$ref")" ]; then
  echo "✗ origin/$ref has commits you do not have: git pull first." >&2
  exit 1
fi
if [ -n "$(git rev-list "origin/$ref..HEAD")" ]; then
  echo "✗ Unpushed commits: git push first (the workflow must be on GitHub)." >&2
  exit 1
fi

# Does the version exist at Snapmaker?
assets=$(gh release view "v$version" --repo Snapmaker/OrcaSlicer --json assets \
  -q '.assets[] | "\(.name)\t\(.size)"' 2>/dev/null || true)
[ -n "$assets" ] || { echo "✗ Snapmaker Orca v$version not found in Snapmaker's releases." >&2; exit 1; }

# No engine published yet: no engine.json (without this guard, sed's failure
# would stop the script silently, because of `set -e`).
current=""
if [ -f "$manifest" ]; then
  current=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$manifest" | head -1)
fi
exists=false
gh release view "$tag" >/dev/null 2>&1 && exists=true
if $exists && ! $force; then
  echo "✗ $tag is already published (--force to rebuild it)." >&2
  exit 1
fi

echo
echo "  Current Snap Studio engine : ${current:-none}"
echo "  Engine to publish          : Snapmaker Orca v$version ($tag)$($exists && echo " — rebuilt")"
echo "  Official packages:"
echo "$assets" | grep -E '\.(dmg|zip|AppImage)	' | while IFS=$'\t' read -r name size; do
  awk -v n="$name" -v s="$size" 'BEGIN { printf "    %-60s %6.1f MB\n", n, s / 1e6 }'
done || true
echo "  → commit \"Snapmaker Orca engine $version\" of $manifest on $ref"
echo

if ! $yes; then
  read -r -p "Publish engine $version? [y/N] " answer
  case "$answer" in
    o|O|oui|Oui|OUI|y|Y|yes) ;;
    *) echo "Cancelled."; exit 0 ;;
  esac
fi

run_and_watch "$workflow" "$ref" -f orca_version="$version" -f force="$force"

gh release download "$tag" -p engine.json -O "$manifest" --clobber
git add "$manifest"
git commit -q -m "Snapmaker Orca engine $version"
git push -q origin "HEAD:$ref"
echo "Engine published: $(gh release view "$tag" --json url -q .url)"
echo "$manifest updated and pushed: the next release (scripts/release.sh) embeds it."
