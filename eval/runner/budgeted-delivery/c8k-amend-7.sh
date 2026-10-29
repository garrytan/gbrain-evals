#!/usr/bin/env bash
# Spec change 7 operator step (bash eval/runner/budgeted-delivery/c8k-amend-7.sh <custody root>) for an existing development cell: retire A4's reader, answer and score files and the
# step summaries into dev/retired/, and clear the freeze, read and score done markers, so the next c8k-run.sh dev adds
# only B3 (the freeze adds missing arms; readers and the judge resume per arm and question).
set -euo pipefail
ROOT=$1 V=$1/dev
mkdir -p "$V/retired/answers" "$V/retired/scores" "$V/retired/pre-amendment"
for f in "$V"/answers/*.A4.jsonl; do [ -e "$f" ] && mv "$f" "$V/retired/answers/"; done
for f in "$V"/scores/*.A4.json; do [ -e "$f" ] && mv "$f" "$V/retired/scores/"; done
for r in "$V"/readers/*/; do n=$(basename "$r"); [ -e "$r/A4.ndjson" ] && mkdir -p "$V/retired/readers/$n" && mv "$r/A4.ndjson" "$V/retired/readers/$n/"; done
for f in freeze.json gate-retrieval.json gate.json answers-summary.json scores-summary.json dev-summary.json ledger-status.json ledger-summary.json read; do [ -e "$V/$f" ] && mv "$V/$f" "$V/retired/pre-amendment/"; done
rm -f "$ROOT"/runs/done/cell-dev-freeze "$ROOT"/runs/done/cell-dev-read "$ROOT"/runs/done/cell-dev-score
echo amended
