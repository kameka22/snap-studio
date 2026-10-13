#!/usr/bin/env bash
# Publie une version de Snap Studio : incrémente la version dans les sources,
# commite et pousse ce changement, puis lance le workflow de release GitHub et
# suit son déroulement. Nécessite la CLI GitHub : brew install gh && gh auth login.
#
#   scripts/release.sh              correctif : 0.1.4 → 0.1.5
#   scripts/release.sh --minor      mineure   : 0.1.4 → 0.2.0
#   scripts/release.sh --major      majeure   : 0.1.4 → 1.0.0
#   scripts/release.sh --version 1.2.3   version exacte
#   scripts/release.sh -y           sans demander de confirmation
#   scripts/release.sh ma-branche   depuis une autre branche que main
#
# Si la version des sources n'a pas encore été publiée (premier lancement, ou
# build précédent en échec), elle est réutilisée telle quelle, sans bump.
set -euo pipefail

yes=false
level=patch
ref=main
exact=""
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) yes=true ;;
    --minor) level=minor ;;
    --major) level=major ;;
    --version)
      [ $# -ge 2 ] || { echo "--version attend un numéro (ex. --version 1.2.3)" >&2; exit 1; }
      exact="$2"
      shift
      ;;
    --version=*) exact="${1#--version=}" ;;
    -*) echo "option inconnue : $1" >&2; exit 1 ;;
    *) ref="$1" ;;
  esac
  shift
done
if [ -n "$exact" ]; then
  exact="${exact#v}"
  [[ "$exact" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version invalide : « $exact » (attendu : 1.2.3)" >&2; exit 1; }
fi
workflow="build.yml"
conf="src-tauri/tauri.conf.json"
cd "$(dirname "$0")/.."
source scripts/lib-run.sh

command -v gh >/dev/null || { echo "gh introuvable : brew install gh" >&2; exit 1; }

# Le commit de version part de cette copie : elle doit être propre, sur la
# bonne branche et à jour avec GitHub.
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Modifications non commitées : commitez-les (ou mettez-les de côté) avant une release." >&2
  exit 1
fi
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "$ref" ]; then
  echo "✗ Vous êtes sur « $branch » : passez sur « $ref » (git switch $ref)." >&2
  exit 1
fi
git fetch -q origin "$ref"
if [ -n "$(git rev-list "HEAD..origin/$ref")" ]; then
  echo "✗ origin/$ref a des commits que vous n'avez pas : git pull d'abord." >&2
  exit 1
fi

# Le moteur de découpe référencé doit être publié : sinon l'application
# publiée ne saurait pas le télécharger.
engine="src-tauri/engine.json"
if [ -f "$engine" ]; then
  ev=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$engine" | head -1)
  for url in $(sed -n 's/^ *"url": "\(.*\)",$/\1/p' "$engine"); do
    if ! curl -sfIL -o /dev/null "$url"; then
      echo "✗ Moteur $ev introuvable ($url) : lancez d'abord scripts/engine.sh $ev." >&2
      exit 1
    fi
  done
fi

current=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$conf" | head -1)
[ -n "$current" ] || { echo "version introuvable dans $conf" >&2; exit 1; }
IFS=. read -r major minor patch <<<"$current"

latest=$(gh release view --json tagName -q .tagName 2>/dev/null || true)
published=false
gh release view "v$current" >/dev/null 2>&1 && published=true

if [ -n "$exact" ]; then
  if gh release view "v$exact" >/dev/null 2>&1; then
    echo "✗ v$exact est déjà publiée." >&2
    exit 1
  fi
  # Les mises à jour ne sont proposées que vers une version plus récente.
  if [ -n "$latest" ] && [ "$(printf '%s\n%s\n' "${latest#v}" "$exact" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" != "$exact" ]; then
    echo "✗ $exact est antérieure à la dernière release ($latest) : les applications installées l'ignoreraient." >&2
    exit 1
  fi
  next="$exact"
  if [ "$exact" = "$current" ]; then bump=false; else bump=true; fi
elif ! $published && [ "$level" = patch ]; then
  next="$current"
  bump=false
else
  case "$level" in
    patch) next="$major.$minor.$((patch + 1))" ;;
    minor) next="$major.$((minor + 1)).0" ;;
    major) next="$((major + 1)).0.0" ;;
  esac
  bump=true
fi

echo
echo "  Version des sources      : $current$($published && echo " (publiée)" || echo " (pas encore publiée)")"
echo "  Dernière release publiée : ${latest:-aucune}"
echo "  Version à publier        : v$next"
echo "  Branche                  : $ref ($(git log -1 --format='%h %s'))"
if $bump; then
  echo "  → un commit « Version $next » sera créé et poussé sur $ref"
fi
if [ -n "$(git rev-list "origin/$ref..HEAD")" ]; then
  echo "  → vos commits non poussés partiront avec"
fi
echo

if ! $yes; then
  read -r -p "Publier la version $next ? [o/N] " answer
  case "$answer" in
    o|O|oui|Oui|OUI|y|Y|yes) ;;
    *) echo "Annulé."; exit 0 ;;
  esac
fi

if $bump; then
  # perl plutôt que sed -i, dont la syntaxe diffère entre macOS et Linux.
  perl -0pi -e "s/^  \"version\": \"[^\"]*\",/  \"version\": \"$next\",/m" "$conf"
  perl -0pi -e "s/^version = \"[^\"]*\"/version = \"$next\"/m" src-tauri/Cargo.toml
  perl -0pi -e "s/(name = \"snap-studio\"\nversion = )\"[^\"]*\"/\$1\"$next\"/" src-tauri/Cargo.lock
  git add "$conf" src-tauri/Cargo.toml src-tauri/Cargo.lock
  git commit -q -m "Version $next"
  echo "Commit « Version $next » créé."
fi
git push -q origin "HEAD:$ref"

run_and_watch "$workflow" "$ref"
echo "Release : $(gh release view "v$next" --json url -q .url)"
