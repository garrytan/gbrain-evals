#!/usr/bin/env bash
# Writes the files a nightly gbrain check needs on its VM into DEST: every tracked file outside docs/, plus the
# docs/benchmarks inputs the runner reads at night (Cat 40's frozen knobs, the tool-contract probe inputs and the
# refresh-barrier preregistration). The rest of docs/ is about 2 GB of past results that a night never reads.
# DEST/.evals-commit records the gbrain-evals commit, marked dirty when the working tree differs from it.
#
#   scripts/nightly-export.sh <dest>
#   cd <dest> && UBI_OWNER=<owner> scripts/ubicloud/ubi-runner.sh run -s standard-16 --src . --setup scripts/nightly-vm.sh -- '<night>'
set -euo pipefail
DEST=${1:?usage: scripts/nightly-export.sh <dest>}
cd "$(dirname "$0")/.."
if [ -e "$DEST" ] && [ ! -f "$DEST/.evals-commit" ]; then
  echo "nightly-export: $DEST exists and is not an earlier export; refusing to replace it" >&2
  exit 1
fi
rm -rf "$DEST"
mkdir -p "$DEST"
{
  git ls-files -z -- . ':!docs'
  git ls-files -z -- docs/benchmarks/cat40-hard docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md \
    docs/benchmarks/2026-11-01-skillopt-method/probe/frontier
} | tar --null -T - -cf - | tar -x -C "$DEST"
echo "$(git rev-parse HEAD)$(git diff --quiet HEAD || echo ' dirty')" > "$DEST/.evals-commit"
