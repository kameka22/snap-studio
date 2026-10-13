# Fonctions partagées par release.sh et engine.sh (à sourcer).

# Date ISO 8601 (UTC) d'un horodatage Unix, sur macOS comme sous Linux.
iso_utc() {
  date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
}

# Lance un workflow et suit SON exécution jusqu'au bout, avec le détail des
# jobs. GitHub met parfois plusieurs secondes à créer l'exécution : on
# attend celle créée après le lancement (marge d'horloge de 30 s).
#   run_and_watch <workflow> <branche> [arguments de gh workflow run…]
run_and_watch() {
  local wf="$1" br="$2"
  shift 2
  local since id=""
  since=$(iso_utc $(($(date +%s) - 30)))
  gh workflow run "$wf" --ref "$br" "$@"
  printf "Workflow lancé sur %s, en attente de l'exécution" "$br"
  for _ in $(seq 1 30); do
    id=$(gh run list --workflow "$wf" --branch "$br" --event workflow_dispatch --limit 5 \
      --json databaseId,createdAt -q "[.[] | select(.createdAt >= \"$since\")][0].databaseId // empty")
    [ -n "$id" ] && break
    printf "."
    sleep 2
  done
  echo
  if [ -z "$id" ]; then
    echo "✗ Exécution introuvable après une minute : voir l'onglet Actions sur GitHub." >&2
    return 1
  fi
  echo "Suivi : $(gh run view "$id" --json url -q .url)"
  gh run watch "$id" --interval 5 --exit-status
}
