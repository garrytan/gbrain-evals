#!/usr/bin/env bash
# Reruns comparator dev tracks that stopped early: BEAM 1M combined (its tuning hit a revision change after a
# mid-run code sync; the store is reused, so nothing is re-ingested) and LoCoMo combined / facts (tuning now steers
# the 95th percentile into the gate). Each waits until the cells sharing its store have finished.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
L="--budget-ledger ${LEDGER:-.budget/mpw-dev-vm.sqlite}"
D="bun eval/runner/harness-dev.ts sweep --provider comparator"
COMBINED='{"max_tokens":3500,"max_chunk_tokens":2000}'
FACTS='{"max_tokens":8000,"max_chunk_tokens":0}'
waitfor() { while pgrep -f -- "$1" >/dev/null; do sleep 60; done; }
(
  waitfor "--split 1m"
  $D --dataset beam --split 1m --units 1,6,16,21,22,25,26 --lane combined --base "$COMBINED" --sample 60 -- $L
) > eval/reports/harness-dev/track-beam-1m-rerun.log 2>&1 &
(
  waitfor "--dataset locomo"
  I=eval/reports/harness-dev/locomo_locomo10.ids.json
  $D --dataset locomo --split locomo10 --question-ids-file $I --lane combined --base "$COMBINED" --targets 8000 --no-default --sample 40 --name comparator-locomo-locomo10-rag-combined-rerun -- $L
  $D --dataset locomo --split locomo10 --question-ids-file $I --lane facts --base "$FACTS" --targets 8000 --no-default --sample 40 --name comparator-locomo-locomo10-rag-facts-rerun -- $L
) > eval/reports/harness-dev/track-locomo-rerun.log 2>&1 &
wait
