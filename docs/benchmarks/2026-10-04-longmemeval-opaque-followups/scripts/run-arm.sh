#!/usr/bin/env bash
# One harness arm under a watchdog. Usage: run-arm.sh <outdir> <cache.sqlite> <harness args...>
# Writes <outdir>/rows.ndjson (resumable), calls.ndjson (paid calls), stderr.log and watchdog.log. A process whose
# rows file has not grown for STALL seconds (gbrain #5092 stall) is killed and resumed from its rows file.
set -u
OUT=$1; CACHE=$2; shift 2
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
STALL=${STALL:-300}
mkdir -p "$OUT"; touch "$OUT/rows.ndjson"
export PATH=$HOME/.bun/bin:$PATH GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large GBRAIN_EMBEDDING_DIMENSIONS=1536 CALLS=$OUT/calls.ndjson
for attempt in $(seq 1 40); do
  ( cd "$REPO" && exec bun docs/benchmarks/2026-10-04-longmemeval-opaque-followups/scripts/driver-retrieval.ts "$HOME/lme/data/longmemeval_s_cleaned.json" \
      --retrieval-only --top-k 5 --by-type --no-trajectory --embed-cache "$CACHE" "$@" \
      --output "$OUT/rows.ndjson" --resume-from "$OUT/rows.ndjson" ) 2>> "$OUT/stderr.log" &
  PID=$!
  START=$(date +%s)
  while kill -0 $PID 2>/dev/null; do
    sleep 15
    age=$(( $(date +%s) - $(stat -c %Y "$OUT/rows.ndjson") ))
    up=$(( $(date +%s) - START ))
    if [ $age -gt $STALL ] && [ $up -gt $STALL ]; then
      echo "$(date -u +%FT%TZ) attempt=$attempt stall ${age}s rows=$(grep -c '"question_id"' "$OUT/rows.ndjson"); last: $(tail -1 "$OUT/stderr.log" | cut -c1-160)" >> "$OUT/watchdog.log"
      kill -9 $PID; sleep 3
    fi
  done
  wait $PID; rc=$?
  echo "$(date -u +%FT%TZ) attempt=$attempt rc=$rc rows=$(grep -c '"question_id"' "$OUT/rows.ndjson")" >> "$OUT/watchdog.log"
  if [ $rc -eq 0 ] && tail -1 "$OUT/rows.ndjson" | grep -q '"by_type_summary"'; then echo done > "$OUT/DONE"; exit 0; fi
  if [ $rc -ne 137 ] && tail -1 "$OUT/rows.ndjson" | grep -q '"by_type_summary"'; then echo "rc=$rc" > "$OUT/ENDED_NONZERO"; exit 2; fi
done
echo failed > "$OUT/FAILED"; exit 1
