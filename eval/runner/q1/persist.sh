#!/usr/bin/env bash
# Copy a public Q1 campaign's state (leases, ledgers, pulled rows, receipts; not store snapshots) to the results branch
# and push it, so a lost launching host loses at most the cells still in flight. Public campaigns only: sealed rows
# never leave the custodian's host.
#   eval/runner/q1/persist.sh <state dir> <campaign id> [interval minutes, default 10] [hours, default 5.8]
set -euo pipefail
state=$(cd "$1" && pwd); id=$2; every=${3:-10}; hours=${4:-5.8}
case $id in *sealed*) echo "persist.sh refuses sealed campaigns" >&2; exit 2 ;; esac
repo=$(cd "$(dirname "$0")/../../.." && pwd)
wt=${Q1_RESULTS_WORKTREE:-$HOME/.capy/work/q1-results}
branch=${Q1_RESULTS_BRANCH:-evals/q1-scoreboard-results}
if [ ! -d "$wt/.git" ] && [ ! -f "$wt/.git" ]; then
  git -C "$repo" fetch -q origin "$branch" 2>/dev/null && git -C "$repo" worktree add -q "$wt" "origin/$branch" -B "$branch" \
    || { git -C "$repo" worktree add -q --detach "$wt" && git -C "$wt" checkout -q --orphan "$branch" && git -C "$wt" rm -rqf . 2>/dev/null || true; }
fi
end=$(( $(date +%s) + ${hours%.*} * 3600 ))
while :; do
  mkdir -p "$wt/$id"
  rsync -a --delete --exclude 'snapshot/' --exclude '*.tar' --exclude 'setup/' "$state/" "$wt/$id/"
  git -C "$wt" add -A "$id"
  if ! git -C "$wt" diff --cached --quiet; then
    git -C "$wt" commit -qm "q1 results: $id $(date -u +%FT%TZ)"
    git -C "$wt" push -q origin "HEAD:$branch" || echo "push failed; retrying next round" >&2
  fi
  [ "$(date +%s)" -ge "$end" ] && break
  sleep $(( every * 60 ))
done
