#!/usr/bin/env bash
# Reruns after the harness fixes of the dev phase (repeated LongMemEval sessions, the unit-eviction race and
# LifeBench stage-file collisions). Waits for the first local tracks, then runs serially per store.
# Env: G (retrieval build), GA (agent build), LEDGER.
set -uo pipefail
L="--budget-ledger ${LEDGER:-.budget/mpw-dev-local.sqlite}"
D="bun eval/runner/harness-dev.ts sweep"
EMB='"embedding_model":"voyage:voyage-4","embedding_dimensions":1024'
X="$EMB,\"date_header\":false"
ids() { echo "eval/reports/harness-dev/$(echo $1 | tr '/' '_').ids.json"; }
while pgrep -f "dev-gbrain-local-tracks.sh" >/dev/null || pgrep -f "longmemeval_s.ids.json" >/dev/null; do sleep 60; done
(
  $D --provider gbrain --dataset beam --split 1m --units 1,6,16,21,22,25,26 --base '{"token_budget":8100}' --extra "{$EMB}" --sample 60 -- --gbrain "$G" $L
  $D --provider gbrain --dataset beam --split 1m --units 1,6,16,21,22,25,26 --base '{"token_budget":8100}' --extra "{$X,\"gbrain_config\":{}}" --targets 8000 --no-default --sample 40 --name gbrain-beam-1m-c1-off -- --gbrain "$G" $L
  $D --provider gbrain --dataset beam --split 1m --units 1,6,16,21,22,25,26 --base '{"token_budget":8100}' --extra "{$X,\"gbrain_config\":{\"search.evidence_date_header\":\"true\"}}" --targets 8000 --no-default --sample 40 --name gbrain-beam-1m-c1-on -- --gbrain "$G" $L
) > eval/reports/harness-dev/track-gbrain-1m-followup.log 2>&1 &
(
  $D --provider gbrain --dataset longmemeval --split s --question-ids-file "$(ids longmemeval/s)" --base '{"token_budget":8100}' --extra "{$EMB}" --targets 8000 --no-default --sample 40 -- --gbrain "$G" $L
  for ds in "longmemeval s longmemeval/s_agent_sample" "lifebench en lifebench/en_agent_sample"; do
    set -- $ds
    $D --provider gbrain --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --mode agentic-rag --base '{"token_budget":8100}' --extra "{$EMB}" --targets 8000 --no-default --sample 20 --gbrain-credentials voyage --name "gbrain-$1-agentic" -- --gbrain "$GA" $L
    $D --provider gbrain --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --mode agent --base '{}' --extra "{$EMB,\"think_model\":\"google:gemini-3.8-flash\"}" --targets '' --gbrain-credentials voyage,gemini --name "gbrain-$1-agent" -- --gbrain "$GA" $L
  done
) > eval/reports/harness-dev/track-gbrain-public-followup.log 2>&1 &
wait
