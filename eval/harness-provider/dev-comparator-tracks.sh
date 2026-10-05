#!/usr/bin/env bash
# The comparator's dev-phase tracks (memory proof wave), run in parallel on one large VM.
# Each track runs its cells one after another because cells that share a store run serially.
# Usage: LEDGER=.budget/mpw-dev-vm.sqlite bash eval/harness-provider/dev-comparator-tracks.sh
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
L="--budget-ledger ${LEDGER:-.budget/mpw-dev-vm.sqlite}"
S=eval/harness-provider/cells/dev/subsets.json
mkdir -p eval/reports/harness-dev
q() { python3 -c "import json,sys; print(json.dumps(json.load(open('$S'))[sys.argv[1]], ensure_ascii=False))" "$1" > "eval/reports/harness-dev/$1.ids.json".tmp && mv "eval/reports/harness-dev/$1.ids.json".tmp "eval/reports/harness-dev/$(echo $1 | tr '/' '_').ids.json"; }
for k in longmemeval/s locomo/locomo10 lifebench/en_agent_sample longmemeval/s_agent_sample locomo/locomo10_agent_sample; do q "$k"; done
ids() { echo "eval/reports/harness-dev/$(echo $1 | tr '/' '_').ids.json"; }
D="bun eval/runner/harness-dev.ts sweep --provider comparator"
COMBINED='{"max_tokens":3500,"max_chunk_tokens":2000}'
FACTS='{"max_tokens":8000,"max_chunk_tokens":0}'
RAW='{"max_tokens":0,"max_chunk_tokens":8000}'

beam() {  # split units
  $D --dataset beam --split "$1" --units "$2" --lane combined --base "$COMBINED" --sample 60 -- $L
  $D --dataset beam --split "$1" --units "$2" --lane facts --base "$FACTS" --targets 8000 --no-default --sample 40 -- $L
  $D --dataset beam --split "$1" --units "$2" --lane raw --base "$RAW" --targets 8000 --no-default --sample 40 -- $L
}
public() {  # dataset split ids-key
  for lane in combined facts raw; do
    case $lane in combined) b=$COMBINED;; facts) b=$FACTS;; raw) b=$RAW;; esac
    $D --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --lane $lane --base "$b" --targets 8000 --no-default --sample 40 -- $L
  done
}
agent() {  # dataset split ids-key
  $D --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --lane combined --mode agentic-rag --base "$COMBINED" --targets 8000 --no-default --sample 20 --name "comparator-$1-agentic" -- $L
  # Agent mode answers with the server's own synthesis (reflect, its extraction model); no knobs, one default cell.
  $D --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --lane combined --mode agent --base '{}' --targets '' --name "comparator-$1-agent" -- $L
}
( beam 100k 3,11,12,15 > eval/reports/harness-dev/track-beam-100k.log 2>&1 ) &
( beam 500k 8,9,12,21,28,31,35 > eval/reports/harness-dev/track-beam-500k.log 2>&1 ) &
( beam 1m 1,6,16,21,22,25,26 > eval/reports/harness-dev/track-beam-1m.log 2>&1 ) &
( public longmemeval s longmemeval/s; agent longmemeval s longmemeval/s_agent_sample ) > eval/reports/harness-dev/track-lme.log 2>&1 &
( public locomo locomo10 locomo/locomo10; agent locomo locomo10 locomo/locomo10_agent_sample; agent lifebench en lifebench/en_agent_sample ) > eval/reports/harness-dev/track-locomo-lifebench.log 2>&1 &
wait
echo "all comparator tracks finished"
