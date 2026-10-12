#!/usr/bin/env bash
# Lance le workflow de build GitHub sur une branche (main par défaut) et suit
# son déroulement. Nécessite la CLI GitHub : brew install gh && gh auth login.
#
#   scripts/release.sh            build de main
#   scripts/release.sh ma-branche build d'une autre branche
set -euo pipefail

ref="${1:-main}"
workflow="build.yml"
cd "$(dirname "$0")/.."

command -v gh >/dev/null || { echo "gh introuvable : brew install gh" >&2; exit 1; }

# Le workflow build ce qui est sur GitHub : prévenir si le local n'y est pas.
git fetch -q origin "$ref"
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠︎ Modifications locales non commitées : elles ne seront pas dans le build."
fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$ref")" ]; then
  echo "⚠︎ HEAD local différent de origin/$ref : pensez à git push."
fi

gh workflow run "$workflow" --ref "$ref"
echo "Workflow lancé sur $ref, en attente de l'exécution…"
sleep 5
id=$(gh run list --workflow "$workflow" --branch "$ref" --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$id" --exit-status
echo "Release : $(gh release view --json url -q .url)"
