#!/usr/bin/env bash
# Comparator reruns with the p95-steering tuner, collision-free LifeBench stage files and
# --off-target-closest (a target no setting tunes into the gate runs at the setting whose mean is nearest it
# and reports the gate miss). Each block waits for the earlier tracks on the same store.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
L="--budget-ledger ${LEDGER:-.budget/mpw-dev-vm.sqlite}"
D="bun eval/runner/harness-dev.ts sweep --provider comparator"
COMBINED='{"max_tokens":3500,"max_chunk_tokens":2000}'
FACTS='{"max_tokens":8000,"max_chunk_tokens":0}'
RAW='{"max_tokens":0,"max_chunk_tokens":8000}'
ids() { echo "eval/reports/harness-dev/$(echo $1 | tr '/' '_').ids.json"; }
waitfor() { while pgrep -f -- "harness-dev.ts sweep.*$1" >/dev/null; do sleep 60; done; }
# needed TRACK T1,T2,...: the targets ("default" for the system default) without a complete cell in the track log.
needed() { python3 - "eval/reports/harness-dev/$1.jsonl" "$2" <<'PY'
import json, os, sys
done = set()
if os.path.exists(sys.argv[1]):
    for line in open(sys.argv[1]):
        r = json.loads(line)
        s = r.get("summary") or {}
        if r.get("step") == "run" and r.get("cell") and (s.get("gates") or {}).get("complete"):
            done.add(str(r.get("target") or "default"))
print(",".join(t for t in sys.argv[2].split(",") if t not in done))
PY
}
beam() {  # split units
  waitfor "--split $1"
  T=$(needed "comparator-beam-$1-rag-combined" 4000,8000,16000,32000)
  [ -n "$T" ] && $D --dataset beam --split "$1" --units "$2" --lane combined --base "$COMBINED" --targets "$T" --no-default --sample 60 --off-target-closest --name "comparator-beam-$1-rag-combined" -- $L
  [ -n "$(needed comparator-beam-$1-rag-facts 8000)" ] && $D --dataset beam --split "$1" --units "$2" --lane facts --base "$FACTS" --targets 8000 --no-default --sample 40 --off-target-closest -- $L
  [ -n "$(needed comparator-beam-$1-rag-raw 8000)" ] && $D --dataset beam --split "$1" --units "$2" --lane raw --base "$RAW" --targets 8000 --no-default --sample 40 --off-target-closest -- $L
}
agent() {  # dataset split ids-key
  [ -n "$(needed comparator-$1-agentic 8000)" ] && $D --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --lane combined --mode agentic-rag --base "$COMBINED" --targets 8000 --no-default --sample 20 --off-target-closest --name "comparator-$1-agentic" -- $L
  [ -n "$(needed comparator-$1-agent default)" ] && $D --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --lane combined --mode agent --base '{}' --extra '{"serve_model":"gemini:gemini-3.8-flash"}' --targets '' --name "comparator-$1-agent" -- $L
}
lme() {
  waitfor "--dataset longmemeval"
  I=$(ids longmemeval/s)
  for lane in combined facts raw; do
    case $lane in combined) b=$COMBINED;; facts) b=$FACTS;; raw) b=$RAW;; esac
    [ -n "$(needed comparator-longmemeval-s-rag-$lane 8000)" ] && $D --dataset longmemeval --split s --question-ids-file "$I" --lane $lane --base "$b" --targets 8000 --no-default --sample 40 --off-target-closest -- $L
  done
  agent longmemeval s longmemeval/s_agent_sample
}
# BLOCKS picks a subset (e.g. BLOCKS=lme to rerun LongMemEval after a provider fix); TAG names the logs.
B=" ${BLOCKS:-beam100k beam500k beam1m lme lifebench} "
T=${TAG:-f3}
[[ $B == *" beam100k "* ]] && ( beam 100k 3,11,12,15 ) > eval/reports/harness-dev/track-beam-100k-$T.log 2>&1 &
[[ $B == *" beam500k "* ]] && ( beam 500k 8,9,12,21,28,31,35 ) > eval/reports/harness-dev/track-beam-500k-$T.log 2>&1 &
[[ $B == *" beam1m "* ]] && ( beam 1m 1,6,16,21,22,25,26 ) > eval/reports/harness-dev/track-beam-1m-$T.log 2>&1 &
[[ $B == *" lme "* ]] && ( lme ) > eval/reports/harness-dev/track-lme-$T.log 2>&1 &
[[ $B == *" lifebench "* ]] && ( agent lifebench en lifebench/en_agent_sample ) > eval/reports/harness-dev/track-lifebench-$T.log 2>&1 &
wait
echo "followup3 finished"
