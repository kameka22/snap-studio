# Functions shared by release.sh and engine.sh (to source).

# ISO 8601 date (UTC) of a Unix timestamp, on macOS as on Linux.
iso_utc() {
  date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
}

# Starts a workflow and follows ITS run to the end, with the jobs' details.
# GitHub sometimes takes several seconds to create the run: wait for the one
# created after the start (30 s clock margin).
#   run_and_watch <workflow> <branch> [gh workflow run arguments…]
run_and_watch() {
  local wf="$1" br="$2"
  shift 2
  local since id=""
  since=$(iso_utc $(($(date +%s) - 30)))
  gh workflow run "$wf" --ref "$br" "$@"
  printf "Workflow started on %s, waiting for the run" "$br"
  for _ in $(seq 1 30); do
    id=$(gh run list --workflow "$wf" --branch "$br" --event workflow_dispatch --limit 5 \
      --json databaseId,createdAt -q "[.[] | select(.createdAt >= \"$since\")][0].databaseId // empty")
    [ -n "$id" ] && break
    printf "."
    sleep 2
  done
  echo
  if [ -z "$id" ]; then
    echo "✗ Run not found after a minute: see the Actions tab on GitHub." >&2
    return 1
  fi
  echo "Following: $(gh run view "$id" --json url -q .url)"
  gh run watch "$id" --interval 5 --exit-status
}
