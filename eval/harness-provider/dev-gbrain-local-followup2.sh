#!/usr/bin/env bash
# After a machine restart: the remaining gbrain dev cells, one at a time (the 4-core machine restarts under
# several parallel tracks). Env: G, GA, G3, LEDGER.
set -uo pipefail
L="--budget-ledger ${LEDGER:-.budget/mpw-dev-local.sqlite}"
D="bun eval/runner/harness-dev.ts sweep --provider gbrain"
EMB='"embedding_model":"voyage:voyage-4","embedding_dimensions":1024'
X="$EMB,\"date_header\":false"
ids() { echo "eval/reports/harness-dev/$(echo $1 | tr '/' '_').ids.json"; }
$D --dataset beam --split 1m --units 1,6,16,21,22,25,26 --base '{"token_budget":8100}' --extra "{$X,\"gbrain_config\":{\"search.evidence_date_header\":\"true\"}}" --targets 8000 --no-default --sample 40 --name gbrain-beam-1m-c1-on -- --gbrain "$G" $L
for ds in "locomo locomo10 locomo/locomo10_agent_sample" "lifebench en lifebench/en_agent_sample" "longmemeval s longmemeval/s_agent_sample"; do
  set -- $ds
  [ "$1" != longmemeval ] && $D --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --mode agentic-rag --base '{"token_budget":8100}' --extra "{$EMB}" --targets 8000 --no-default --sample 20 --gbrain-credentials voyage --name "gbrain-$1-agentic" -- --gbrain "$GA" $L
  $D --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --mode agent --base '{}' --extra "{$EMB,\"think_model\":\"google:gemini-3.8-flash\"}" --targets '' --gbrain-credentials voyage,gemini --name "gbrain-$1-agent" -- --gbrain "$GA" $L
done
G3="$G3" LEDGER="${LEDGER:-.budget/mpw-dev-local.sqlite}" bash eval/harness-provider/dev-gate3-anchoring.sh
