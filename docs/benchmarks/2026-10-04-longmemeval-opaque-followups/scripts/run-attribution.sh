#!/usr/bin/env bash
# Post-hoc attribution (not preregistered): A3 (legacy expansion, replayed variants) and A1 on the 40 development
# questions, at the published code 885bb91a1, once with raw dataset ids and once with the opaque-id copy.
set -u
cd "$(dirname "$0")"
W=${ATTR_DIR:?}; OLD=${GBRAIN_OLD:?}
R=../../2026-09-06-longmemeval-ranker-wave/longmemeval
export GBRAIN_SRC=$OLD GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large GBRAIN_EMBEDDING_DIMENSIONS=1536
run_ids() {
  local ids=$1
  DS=$W/longmemeval_s_cleaned.json; [ $ids = opaque ] && DS=$W/longmemeval_s_cleaned.opaque.json
  for arm in A1 A3; do
    X=""; [ $arm = A3 ] && X="--expansion-replay $R/A3-hybrid-expansion-rerank-off-autocut-off.ndjson"
    mkdir -p $W/$ids-$arm
    CALLS=$W/$ids-$arm/calls.ndjson bun driver-retrieval-at.ts $DS --retrieval-only --top-k 5 --by-type --no-trajectory \
      --embed-cache $W/cache-$ids.sqlite --mode balanced --reranker off --autocut off $X --question-ids $W/dev40.txt \
      --output $W/$ids-$arm/rows.ndjson --resume-from $W/$ids-$arm/rows.ndjson 2>> $W/$ids-$arm/stderr.log
    echo "$ids $arm rc=$?"
  done
}
# the raw and opaque runs use separate caches, so they run side by side
mkdir -p $W/raw-A1 $W/raw-A3 $W/opaque-A1 $W/opaque-A3; touch $W/raw-A1/rows.ndjson $W/raw-A3/rows.ndjson $W/opaque-A1/rows.ndjson $W/opaque-A3/rows.ndjson
run_ids raw & run_ids opaque & wait
