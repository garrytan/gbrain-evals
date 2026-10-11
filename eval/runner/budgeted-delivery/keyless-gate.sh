#!/usr/bin/env bash
# The budgeted delivery E1 accounting gate, keyless, for one benchmark: the committed adapters through memory-qa with
# hash vectors and the reranker off, both cells, every arm read by the stub proxy, then the gate check.
#
#   bash eval/runner/budgeted-delivery/keyless-gate.sh <lme-s|locomo|beam-100k> <out dir> <gbrain checkout@sha> [grid]
set -euo pipefail
BENCH=$1 OUT=$2 GBRAIN=$3 GRID=${4:-4000:8000:2000}
M=docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1/manifests/arms
case "$BENCH" in
  lme-s) SEL=(--benchmark lme-s --limit 100 --seed 42) ;;
  locomo|beam-100k) SEL=(--benchmark "$BENCH" --split dev) ;;
  *) echo "unknown benchmark $BENCH" >&2; exit 2 ;;
esac
COMMON=("${SEL[@]}" --embed hash --embedding-model openai:text-embedding-3-large --embedding-dims 1536 --config search.reranker.enabled=false --gbrain "$GBRAIN")
mkdir -p "$OUT"
PORT=$((8800 + RANDOM % 900))
bun eval/runner/budgeted-delivery/stub-proxy.ts --port "$PORT" & STUB=$!
trap 'kill $STUB 2>/dev/null || true' EXIT
sleep 1
PROXY=(--provider-proxy "http://127.0.0.1:$PORT")
run() { bun eval/runner/memory-qa/run.ts "${COMMON[@]}" "$@"; }

run --system gbrain-shootout --arms "$M/retrieval-only.json" --output "$OUT/cell-a" "${PROXY[@]}"
run --system gbrain-query --arms "$M/retrieval-only.json" --policy-setting stage=freeze --policy-setting "grid=$GRID" --output "$OUT/cell-b-freeze" "${PROXY[@]}"
bun eval/runner/budgeted-delivery/budget-sizing.ts --rows "$OUT/cell-b-freeze/retrievals/rows.ndjson" --benchmark "$BENCH" --out "$OUT/sizing.json" > /dev/null
BN=$(python3 -c "import json;print(json.load(open('$OUT/sizing.json'))['native']['budget'])")
BP=$(python3 -c "import json;print(json.load(open('$OUT/sizing.json'))['pseudo']['budget'])")
DELIVER=(--policy-setting stage=deliver --policy-setting "b_native=$BN" --policy-setting "b_pseudo=$BP" --frozen-from "$OUT/cell-b-freeze/retrievals/rows.ndjson")
run --system gbrain-query --arms "$M/retrieval-only.json" "${DELIVER[@]}" --output "$OUT/cell-b" "${PROXY[@]}"
for f in "$M/$BENCH"-cell-a*.json; do run --system gbrain-shootout --arms "$f" --replay --output "$OUT/cell-a" "${PROXY[@]}"; done
for f in "$M/$BENCH"-cell-b*.json; do run --system gbrain-query --arms "$f" "${DELIVER[@]}" --replay --output "$OUT/cell-b" "${PROXY[@]}"; done
bun eval/runner/budgeted-delivery/accounting-gate.ts --cell-a "$OUT/cell-a" --cell-b "$OUT/cell-b" --b-native "$BN" --b-pseudo "$BP" --out "$OUT/gate.json" > /dev/null && echo "[gate] $BENCH passed (B_native $BN, B_pseudo $BP)" || { echo "[gate] $BENCH FAILED: see $OUT/gate.json"; exit 1; }
