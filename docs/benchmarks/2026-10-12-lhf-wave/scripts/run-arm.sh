#!/usr/bin/env bash
# One preregistered arm (or phase-0 shard) through driver-via-op.ts, resumable from its rows file.
# Usage: GBRAIN_SRC=<checkout> LEDGER=<ledger.sqlite> BUDGET=<usd per attempt> ARM=<label> \
#          run-arm.sh <outdir> <cache.sqlite> <question-ids file> <harness args...>
# Each attempt opens its own ledger run; a crashed attempt resumes from rows.ndjson (at most 3 attempts).
set -u
OUT=$1; CACHE=$2; IDS=$3; shift 3
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
export PATH=$HOME/.bun/bin:$PATH GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large GBRAIN_EMBEDDING_DIMENSIONS=1536 OUT
mkdir -p "$OUT"; touch "$OUT/rows.ndjson"
want=$(grep -c . "$IDS")
for attempt in 1 2 3; do
  ( cd "$REPO" && ARM="$ARM-a$attempt" OUT="$OUT/attempt$attempt" bun docs/benchmarks/2026-10-12-lhf-wave/scripts/driver-via-op.ts \
      --budget-ledger "$LEDGER" --budget-usd "$BUDGET" -- "$HOME/lme/data/longmemeval_s_cleaned.json" \
      --retrieval-only --top-k 5 --by-type --no-trajectory --reranker on --autocut off --embed-cache "$CACHE" \
      --question-ids "$IDS" "$@" --output "$OUT/rows.ndjson" --resume-from "$OUT/rows.ndjson" ) >> "$OUT/stderr.log" 2>&1
  rc=$?
  got=$(grep -c '"question_id"' "$OUT/rows.ndjson")
  echo "$(date -u +%FT%TZ) attempt=$attempt rc=$rc rows=$got/$want" >> "$OUT/attempts.log"
  if [ "$got" -ge "$want" ]; then echo "rc=$rc" > "$OUT/DONE"; exit 0; fi
done
echo failed > "$OUT/FAILED"; exit 1
