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
( c1 100k 3,11,12,15; c1 500k 8,9,12,21,28,31,35; c1 1m 1,6,16,21,22,25,26 ) > eval/reports/harness-dev/track-gbrain-c1.log 2>&1 &
( fullctx 100k 3,11,12,15; fullctx 500k 8,9,12,21,28,31,35 ) > eval/reports/harness-dev/track-full-context.log 2>&1 &
wait
