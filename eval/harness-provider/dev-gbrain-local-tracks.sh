#!/usr/bin/env bash
# gbrain-side dev tracks that run beside the gbrain BEAM sweep on the main machine:
# the C1 date-header test (gbrain's own header on vs off, provider header off in both arms)
# and the full-context baseline. Usage: G=<gbrain checkout>@<sha> LEDGER=... bash eval/harness-provider/dev-gbrain-local-tracks.sh
set -uo pipefail
L="--budget-ledger ${LEDGER:-.budget/mpw-dev-local.sqlite}"
D="bun eval/runner/harness-dev.ts sweep"
X='"embedding_model":"voyage:voyage-4","embedding_dimensions":1024,"date_header":false'
mkdir -p eval/reports/harness-dev
c1() {
  $D --provider gbrain --dataset beam --split "$1" --units "$2" --base '{"token_budget":8100}' --extra "{$X,\"gbrain_config\":{}}" --targets 8000 --no-default --sample 40 --name "gbrain-beam-$1-c1-off" -- --gbrain "$G" $L
  $D --provider gbrain --dataset beam --split "$1" --units "$2" --base '{"token_budget":8100}' --extra "{$X,\"gbrain_config\":{\"search.evidence_date_header\":\"true\"}}" --targets 8000 --no-default --sample 40 --name "gbrain-beam-$1-c1-on" -- --gbrain "$G" $L
}
fullctx() {
  $D --provider full-context --dataset beam --split "$1" --units "$2" --base '{}' --targets '' --budget 90 --name "full-context-beam-$1" -- $L
}
sweep() {
  $D --provider gbrain --dataset beam --split "$1" --units "$2" --base '{"token_budget":8100}' --extra '{"embedding_model":"voyage:voyage-4","embedding_dimensions":1024}' --sample 60 -- --gbrain "$G" $L
}
S=eval/harness-provider/cells/dev/subsets.json
python3 - "$S" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for k in ("longmemeval/s", "locomo/locomo10", "lifebench/en_agent_sample", "longmemeval/s_agent_sample", "locomo/locomo10_agent_sample"):
    open("eval/reports/harness-dev/" + k.replace("/", "_") + ".ids.json", "w").write(json.dumps(d[k], ensure_ascii=False))
PY
ids() { echo "eval/reports/harness-dev/$(echo $1 | tr '/' '_').ids.json"; }
EMB='"embedding_model":"voyage:voyage-4","embedding_dimensions":1024'
public_raw() {  # gbrain raw lane on the matched public benchmarks' dev subsets, 8k target
  $D --provider gbrain --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --base '{"token_budget":8100}' --extra "{$EMB}" --targets 8000 --no-default --sample 40 -- --gbrain "$G" $L
}
agent() {  # agentic-rag and agent (gbrain think) on gemini-3.8-flash, build with the Google base-URL override
  $D --provider gbrain --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --mode agentic-rag --base '{"token_budget":8100}' --extra "{$EMB}" --targets 8000 --no-default --sample 20 --gbrain-credentials voyage --name "gbrain-$1-agentic" -- --gbrain "$GA" $L
  $D --provider gbrain --dataset "$1" --split "$2" --question-ids-file "$(ids $3)" --mode agent --base '{}' --extra "{$EMB,\"think_model\":\"google:gemini-3.8-flash\"}" --targets '' --gbrain-credentials voyage,gemini --name "gbrain-$1-agent" -- --gbrain "$GA" $L
}
( sweep 100k 3,11,12,15; sweep 500k 8,9,12,21,28,31,35; sweep 1m 1,6,16,21,22,25,26 ) > eval/reports/harness-dev/track-gbrain-sweep.log 2>&1 &
( c1 100k 3,11,12,15; c1 500k 8,9,12,21,28,31,35; c1 1m 1,6,16,21,22,25,26 ) > eval/reports/harness-dev/track-gbrain-c1.log 2>&1 &
( fullctx 100k 3,11,12,15; fullctx 500k 8,9,12,21,28,31,35 ) > eval/reports/harness-dev/track-full-context.log 2>&1 &
( public_raw longmemeval s longmemeval/s; public_raw locomo locomo10 locomo/locomo10; agent longmemeval s longmemeval/s_agent_sample; agent locomo locomo10 locomo/locomo10_agent_sample; agent lifebench en lifebench/en_agent_sample ) > eval/reports/harness-dev/track-gbrain-public.log 2>&1 &
wait
