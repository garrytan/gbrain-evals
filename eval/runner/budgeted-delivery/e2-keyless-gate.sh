#!/usr/bin/env bash
# The budgeted delivery E2 keyless gate: every E2 stage end to end on small selections, with hash vectors, the reranker
# off and the stub proxy answering readers and judges (its scores mean nothing), then the E2 readings and the E3 gate.
# It proves the harness, the per-call packings and the receipts at the gbrain under test before any paid call.
#
#   bash eval/runner/budgeted-delivery/e2-keyless-gate.sh <out dir> <gbrain checkout@sha>
set -euo pipefail
OUT=$1 GB=$2
M=docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2/manifests/arms
H=eval/runner/budgeted-delivery
export GBRAIN_EVALS_QA_CACHE="$OUT/qa-cache-stub" GBRAIN_EVALS_EMBED_CACHE_ROOT="$OUT/embed-cache"
mkdir -p "$OUT"
PORT=$((8800 + RANDOM % 900))
bun $H/stub-proxy.ts --port "$PORT" & STUB=$!
trap 'kill $STUB 2>/dev/null || true' EXIT
sleep 1
COMMON=(--system gbrain-query --embed hash --embedding-model openai:text-embedding-3-large --embedding-dims 1536 --config search.reranker.enabled=false --gbrain "$GB" --policy-setting variants=e2 --provider-proxy "http://127.0.0.1:$PORT")
for B in lme-s locomo beam-100k; do
  case "$B" in
    lme-s) SEL=(--benchmark lme-s --limit 6 --seed 42); N=2; SET=all ;;
    locomo) SEL=(--benchmark locomo --split dev --limit 12 --seed 42); N=3; SET=primary ;;
    beam-100k) SEL=(--benchmark beam-100k --split dev --limit 8 --seed 42); N=2; SET=primary ;;
  esac
  D="$OUT/$B"
  bash $H/e2-parallel.sh "$N" "$D/freeze" -- "${SEL[@]}" "${COMMON[@]}" --arms $M/retrieval-only.json --policy-setting stage=freeze
  cat "$D"/freeze/shard-*/retrievals/rows.ndjson > "$D/frozen.ndjson"
  F=(--frozen-from "$D/frozen.ndjson")
  if [ "$SET" = all ]; then
    bash $H/e2-parallel.sh "$N" "$D/size" -- "${SEL[@]}" "${COMMON[@]}" --arms $M/retrieval-only.json --policy-setting stage=size --policy-setting grid=4000:7000:500 "${F[@]}"
    bash $H/e2-parallel.sh 1 "$D/size16" -- "${SEL[@]}" "${COMMON[@]}" --arms $M/retrieval-only.json --policy-setting stage=size --policy-setting grid16=9000:13500:500 "${F[@]}"
    bun $H/budget-sizing.ts --e2 --rows "$D"/size/shard-*/retrievals/rows.ndjson --budgets b_pseudo,b_native --benchmark "$B" > "$D/sizing.json"
    bun $H/budget-sizing.ts --e2 --rows "$D"/size16/shard-*/retrievals/rows.ndjson --budgets b16_pseudo --benchmark "$B" > "$D/sizing16.json"
  else
    bash $H/e2-parallel.sh "$N" "$D/size" -- "${SEL[@]}" "${COMMON[@]}" --arms $M/retrieval-only.json --policy-setting stage=size --policy-setting size_set=primary --policy-setting grid=4000:7000:500 "${F[@]}"
    bun $H/budget-sizing.ts --e2 --rows "$D"/size/shard-*/retrievals/rows.ndjson --budgets b_pseudo_primary --benchmark "$B" > "$D/sizing.json"
  fi
  BP=$(python3 -c "import json;d=json.load(open('$D/sizing.json'));print((d.get('b_pseudo') or d['b_pseudo_primary'])['budget'])")
  if [ "$SET" = all ]; then
    BN=$(python3 -c "import json;print(json.load(open('$D/sizing.json'))['b_native']['budget'])")
    B16=$(python3 -c "import json;print(json.load(open('$D/sizing16.json'))['b16_pseudo']['budget'])")
    DEL=(--policy-setting stage=deliver --policy-setting "b_pseudo=$BP" --policy-setting "b_native=$BN" --policy-setting "b16_pseudo=$B16" "${F[@]}")
    bash $H/e2-parallel.sh "$N" "$D/deliver" -- "${SEL[@]}" "${COMMON[@]}" --arms $M/retrieval-only.json "${DEL[@]}"
    bash $H/e2-parallel.sh 1 "$D/live" -- "${SEL[@]}" "${COMMON[@]}" --arms $M/retrieval-only.json --policy-setting stage=live --policy-setting "b_pseudo=$BP" --policy-setting live_reps=1 "${F[@]}"
    bash $H/e2-parallel.sh "$N" "$D/deliver" -- "${SEL[@]}" "${COMMON[@]}" --arms $M/lme-s-phase1.json --replay "${DEL[@]}"
    bash $H/e2-parallel.sh "$N" "$D/deliver" -- "${SEL[@]}" "${COMMON[@]}" --arms $M/lme-s-phase2-cap_only.json --replay "${DEL[@]}"
  else
    DEL=(--policy-setting stage=deliver --policy-setting deliver_set=primary --policy-setting "b_pseudo=$BP" "${F[@]}")
    bash $H/e2-parallel.sh "$N" "$D/deliver" -- "${SEL[@]}" "${COMMON[@]}" --arms $M/retrieval-only.json "${DEL[@]}"
    bash $H/e2-parallel.sh "$N" "$D/deliver" -- "${SEL[@]}" "${COMMON[@]}" --arms "$M/$B.json" --replay "${DEL[@]}"
  fi
done
cells() { python3 -c "import glob,json,sys;print(json.dumps(sorted(glob.glob(sys.argv[1]))))" "$1"; }
cat > "$OUT/readings-config.json" <<JSON
{ "lme-s": { "cells": $(cells "$OUT/lme-s/deliver/shard-*/"), "live": $(cells "$OUT/lme-s/live/shard-*/"), "slice": { "limit": 6, "seed": 42 } },
  "locomo": { "cells": $(cells "$OUT/locomo/deliver/shard-*/") }, "beam-100k": { "cells": $(cells "$OUT/beam-100k/deliver/shard-*/") } }
JSON
cat > "$OUT/e3-config.json" <<JSON
{ "benches": [ { "benchmark": "lme-s", "freeze": $(cells "$OUT/lme-s/freeze/shard-*/retrievals/rows.ndjson"), "cluster": "question" },
  { "benchmark": "locomo", "freeze": $(cells "$OUT/locomo/freeze/shard-*/retrievals/rows.ndjson"), "cluster": "conversation" },
  { "benchmark": "beam-100k", "freeze": $(cells "$OUT/beam-100k/freeze/shard-*/retrievals/rows.ndjson"), "cluster": "conversation" } ], "slice": { "limit": 6, "seed": 42 } }
JSON
bun $H/e2-readings.ts --config "$OUT/readings-config.json" --out "$OUT/readings.json" > /dev/null
bun $H/e3-retrieval-gate.ts --config "$OUT/e3-config.json" --out "$OUT/e3.json" > /dev/null
bun $H/e2-gate-check.ts "$OUT/readings.json" "$OUT/e3.json"
