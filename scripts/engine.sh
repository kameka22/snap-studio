#!/usr/bin/env bash
# Publie le moteur de découpe embarqué pour une version de Snapmaker Orca :
# lance le workflow « Moteur » (allègement, découpe de test sur les quatre
# plateformes, release `engine-orca-<version>`), puis met à jour
# src-tauri/engine.json, le commite et le pousse. La prochaine release de
# Snap Studio (scripts/release.sh) embarque ce moteur.
#
# Seulement pour changer de version d'Orca — pas à chaque release.
#
#   scripts/engine.sh 2.4.0            publier le moteur 2.4.0
#   scripts/engine.sh 2.4.0 --force    reconstruire une release existante
#   scripts/engine.sh 2.4.0 -y         sans demander de confirmation
set -euo pipefail

version=""
force=false
yes=false
for a in "$@"; do
  case "$a" in
    -y|--yes) yes=true ;;
    --force) force=true ;;
    -*) echo "option inconnue : $a" >&2; exit 1 ;;
    *) version="${a#v}" ;;
  esac
done
[ -n "$version" ] || { echo "usage : scripts/engine.sh <version d'Orca> [--force] [-y]" >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$ ]] || { echo "version invalide : $version" >&2; exit 1; }

ref=main
workflow="engine.yml"
tag="engine-orca-$version"
manifest="src-tauri/engine.json"
cd "$(dirname "$0")/.."
source scripts/lib-run.sh

command -v gh >/dev/null || { echo "gh introuvable : brew install gh" >&2; exit 1; }

# Le commit d'engine.json part de cette copie : propre, sur main, à jour.
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Modifications non commitées : commitez-les d'abord." >&2
  exit 1
fi
if [ "$(git rev-parse --abbrev-ref HEAD)" != "$ref" ]; then
  echo "✗ Passez sur « $ref » (git switch $ref)." >&2
  exit 1
fi
git fetch -q origin "$ref"
if [ -n "$(git rev-list "HEAD..origin/$ref")" ]; then
  echo "✗ origin/$ref a des commits que vous n'avez pas : git pull d'abord." >&2
  exit 1
fi
if [ -n "$(git rev-list "origin/$ref..HEAD")" ]; then
  echo "✗ Commits non poussés : git push d'abord (le workflow doit être sur GitHub)." >&2
  exit 1
fi

# La version existe chez Snapmaker ?
assets=$(gh release view "v$version" --repo Snapmaker/OrcaSlicer --json assets \
  -q '.assets[] | "\(.name)\t\(.size)"' 2>/dev/null || true)
[ -n "$assets" ] || { echo "✗ Snapmaker Orca v$version introuvable dans les releases Snapmaker." >&2; exit 1; }

# Aucun moteur encore publié : pas d'engine.json (sans ce garde, l'échec de
# sed arrêterait le script en silence, à cause de `set -e`).
current=""
if [ -f "$manifest" ]; then
  current=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$manifest" | head -1)
fi
exists=false
gh release view "$tag" >/dev/null 2>&1 && exists=true
if $exists && ! $force; then
  echo "✗ $tag est déjà publiée (--force pour la reconstruire)." >&2
  exit 1
fi

echo
echo "  Moteur actuel de Snap Studio : ${current:-aucun}"
echo "  Moteur à publier             : Snapmaker Orca v$version ($tag)$($exists && echo " — reconstruit")"
echo "  Paquets officiels :"
echo "$assets" | grep -E '\.(dmg|zip|AppImage)	' | while IFS=$'\t' read -r name size; do
  awk -v n="$name" -v s="$size" 'BEGIN { printf "    %-60s %6.1f Mo\n", n, s / 1e6 }'
done || true
echo "  → commit « Moteur Snapmaker Orca $version » de $manifest sur $ref"
echo

if ! $yes; then
  read -r -p "Publier le moteur $version ? [o/N] " answer
  case "$answer" in
    o|O|oui|Oui|OUI|y|Y|yes) ;;
    *) echo "Annulé."; exit 0 ;;
  esac
fi

run_and_watch "$workflow" "$ref" -f orca_version="$version" -f force="$force"

gh release download "$tag" -p engine.json -O "$manifest" --clobber
git add "$manifest"
git commit -q -m "Moteur Snapmaker Orca $version"
git push -q origin "HEAD:$ref"
echo "Moteur publié : $(gh release view "$tag" --json url -q .url)"
echo "$manifest mis à jour et poussé : la prochaine release (scripts/release.sh) l'embarque."
