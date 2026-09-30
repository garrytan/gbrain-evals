#!/usr/bin/env bash
# Evidence-delivery paid program, steps 1-6 of the preregistration, in order.
# Run from the gbrain-evals checkout on the VM with the keys in ~/.edenv.
set -euo pipefail
source ~/.edenv
export PATH="$HOME/.bun/bin:$PATH" GBRAIN_DIR=$HOME/gbrain ED=$HOME/ed
DS=$HOME/data/longmemeval_s_cleaned.json
R="bun eval/runner/evidence-delivery.ts"
SCRIPTS=docs/benchmarks/2026-09-30-evidence-delivery/scripts
mkdir -p $ED/logs
step() { echo "$(date -u +%FT%TZ) $*" >> $ED/logs/pipeline.txt; }
[ -f $ED/run-id ] || $R campaign-open --budget-usd 400 > $ED/run-id
RUN=$(cat $ED/run-id); step "campaign run $RUN"
B="--budget-run-id $RUN"

if [ ! -f $ED/frozen/frozen-manifest.jsonl ]; then
  step "freeze: 5 shards"
  for k in 0 1 2 3 4; do
    bash $SCRIPTS/wd.sh freeze-$k $ED/shard-$k $R freeze --dataset $DS --set all --shard $k/5 --out-dir $ED/shard-$k --embed-cache $ED/cache-$k.sqlite $B &
  done
  wait
  $R merge-frozen --out-dir $ED/frozen --from $ED/shard-0,$ED/shard-1,$ED/shard-2,$ED/shard-3,$ED/shard-4 > $ED/logs/merge.json
fi
$R parity --frozen-dir $ED/frozen --dataset $DS > $ED/logs/parity-summary.json
step "parity done"

PILOT_ARMS=chunk,window1,window2,section,page,auto4k,auto6k,auto7_5k,k10,page_legacy
for pass in 1 2 3 4; do
  STALL_SECS=600 bash $SCRIPTS/wd.sh e1-pilot $ED/e1 $R e1 --frozen-dir $ED/frozen --dataset $DS --out-dir $ED/e1 --set pilot --arms $PILOT_ARMS --concurrency 8 $B
done
step "e1 pilot done"
for pass in 1 2 3 4; do
  STALL_SECS=600 bash $SCRIPTS/wd.sh e1-agent $ED/e1 $R e1 --frozen-dir $ED/frozen --dataset $DS --out-dir $ED/e1 --set pilot --arms agent_fetch --concurrency 6 $B
done
step "agent_fetch done"
$R analyze --rows-dir $ED/e1 --stage pilot --frozen-dir $ED/frozen --out $ED/pilot-decision.json > $ED/logs/pilot-analyze.txt
ADV=$(python3 -c "import json;print(','.join(json.load(open('$ED/pilot-decision.json'))['selection']['advanced']))")
step "advanced: $ADV"

E3_ARMS=page${ADV:+,$ADV}
for k in 0 1 2 3; do
  STALL_SECS=900 bash $SCRIPTS/wd.sh e3-$k $ED/e3-$k $R e3 --frozen-dir $ED/frozen --dataset $DS --out-dir $ED/e3-$k --set pilot --shard $k/4 --arms $E3_ARMS --score --embed-cache $ED/e3-cache-$k.sqlite $B &
done
wait
cat $ED/e3-*/e3.ndjson > $ED/e3.ndjson
step "e3 done"

CONF_ARMS=chunk,page${ADV:+,$ADV}
for pass in 1 2 3 4; do
  STALL_SECS=600 bash $SCRIPTS/wd.sh e1-conf $ED/e1 $R e1 --frozen-dir $ED/frozen --dataset $DS --out-dir $ED/e1 --set confirmatory --arms $CONF_ARMS --decision $ED/pilot-decision.json --concurrency 8 $B || { step "confirmatory refused or failed"; break; }
done
$R analyze --rows-dir $ED/e1 --stage confirmatory --pilot-decision $ED/pilot-decision.json --out $ED/confirmatory-decision.json > $ED/logs/conf-analyze.txt || step "confirmatory analyze failed"
step "confirmatory done"

G4=$(python3 -c "import json;d=json.load(open('$ED/confirmatory-decision.json'));print(d['gpt4o_second_arm']['arm'] or '')" 2>/dev/null || true)
if [ -n "$G4" ]; then
  for pass in 1 2 3 4; do
    STALL_SECS=600 bash $SCRIPTS/wd.sh e1-gpt4o $ED/e1 $R e1 --frozen-dir $ED/frozen --dataset $DS --out-dir $ED/e1 --set confirmatory --reader gpt4o --arms chunk,$G4 --decision $ED/confirmatory-decision.json --concurrency 8 $B
  done
  $R analyze --rows-dir $ED/e1 --stage confirmatory --pilot-decision $ED/pilot-decision.json --out $ED/confirmatory-decision.json > $ED/logs/conf-analyze.txt
fi
step "gpt4o done"
bun eval/runner/budget-ledger.ts status > $ED/logs/ledger-status.json
cp .budget/ledger.json $ED/ledger.json
step "pipeline complete"
