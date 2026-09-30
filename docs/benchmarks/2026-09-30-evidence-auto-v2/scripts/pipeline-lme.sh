#!/usr/bin/env bash
# Auto v2 LongMemEval sanity run: freeze 500 questions in 3 shards (one
# process per embedding cache), merge, parity, then chunk/auto/page readers.
# Run from the gbrain-evals checkout; ED, GBRAIN_DIR and DS must be set.
set -euo pipefail
R="bun eval/runner/evidence-auto-v2.ts"
WD=docs/benchmarks/2026-09-30-evidence-auto-v2/scripts/wd.sh
mkdir -p $ED/logs
step() { echo "$(date -u +%FT%TZ) $*" >> $ED/logs/pipeline.txt; }
[ -f $ED/run-id ] || $R campaign-open --budget-usd 150 > $ED/run-id
RUN=$(cat $ED/run-id); step "campaign run $RUN"
B="--budget-run-id $RUN"
if [ ! -f $ED/frozen/frozen-manifest.jsonl ]; then
  for k in 0 1 2; do
    bash $WD freeze-$k $ED/shard-$k $R freeze --dataset $DS --shard $k/3 --out-dir $ED/shard-$k --embed-cache $ED/cache-$k.sqlite $B &
  done
  wait
  $R merge-frozen --out-dir $ED/frozen --from $ED/shard-0,$ED/shard-1,$ED/shard-2 > $ED/logs/merge.json
fi
step "freeze done"
$R parity --frozen-dir $ED/frozen --dataset $DS > $ED/logs/parity-summary.json
for pass in 1 2 3 4; do
  STALL_SECS=600 bash $WD e1 $ED/e1 $R e1 --frozen-dir $ED/frozen --dataset $DS --out-dir $ED/e1 --concurrency 6 $B
done
step "e1 done"
$R analyze --rows-dir $ED/e1 --frozen-dir $ED/frozen --out $ED/sanity.json > $ED/logs/analyze.txt
step "lme complete"
