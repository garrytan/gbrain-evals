#!/usr/bin/env bash
# Parallel batch-runner wrapper for longmemeval.ts.
#
# Strategy: N workers in parallel (each its own PGLite + own slice of
# questions), each bounded by a wall budget. When the budget expires the
# workers exit cleanly; this wrapper waits for all of them, checks how many
# (adapter × question) pairs have been written to the shared NDJSON, and
# restarts the pool until all pairs land.
#
# Completion target: derived from the ACTUAL dataset (question count, minus
# whatever --stratify/--limit trims), not a hardcoded 500 (audit finding
# longmemeval-10). A batch that makes zero progress aborts the loop instead
# of burning all MAX_BATCHES on no-op workers.
#
# Why parallel:
#   - Each worker is independent. Worker N takes questions where i % 3 == N.
#   - Workers share the SQLite embedding cache (WAL mode = concurrent-write
#     safe). They share the NDJSON output (POSIX O_APPEND is atomic for
#     line-sized writes).
#   - 3x throughput on cold-embed runs, near-3x on cache hits too. Tier-1
#     OpenAI rate limit (3000 RPM) has plenty of headroom.
#
# Why batched:
#   - PGLite WASM has been observed to enter unrecoverable abort loops on
#     long sessions. Bounding each invocation with a wall budget plus
#     OS-level kill cleans up the abort regime cleanly. The NDJSON is the
#     resume state.
#
# Run:
#   bash eval/runner/longmemeval-batch.sh
#   bash eval/runner/longmemeval-batch.sh --top-k 8
#   bash eval/runner/longmemeval-batch.sh --dataset oracle
#   bash eval/runner/longmemeval-batch.sh --adapters keyword,hybrid --workers 4
#   bash eval/runner/longmemeval-batch.sh --limit 25 --adapters keyword
#
# Output (defaults; override with --ndjson):
#   eval/reports/longmemeval/longmemeval-<dataset>-k<topk>.ndjson
#   plus the aggregator's .json/.md next to it (final)
set -euo pipefail

cd "$(dirname "$0")/../.."

# Test seam: point LME_RUNNER at a stub to exercise this wrapper hermetically.
RUNNER="${LME_RUNNER:-eval/runner/longmemeval.ts}"
AGGREGATOR="${LME_AGGREGATOR:-eval/runner/longmemeval-aggregate.ts}"

BUDGET_SECONDS=600
MAX_BATCHES=50
TOP_K=5
DATASET=s
DATASET_PATH=""
WORKERS=3
ADAPTERS=""
NDJSON=""
LIMIT=""
STRATIFY=""
EXPECTED_QUESTIONS="${LME_EXPECTED_QUESTIONS:-}"
EXPECTED_ADAPTERS=4

EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --top-k) TOP_K="$2"; shift 2 ;;
    --adapters) ADAPTERS="$2"; shift 2 ;;
    --budget) BUDGET_SECONDS="$2"; shift 2 ;;
    --ndjson) NDJSON="$2"; shift 2 ;;
    --workers) WORKERS="$2"; shift 2 ;;
    --dataset) DATASET="$2"; shift 2 ;;
    --path) DATASET_PATH="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --stratify) STRATIFY="$2"; shift 2 ;;
    --expected-questions) EXPECTED_QUESTIONS="$2"; shift 2 ;;
    # Runner-side single-adapter mode: keep the completion target honest.
    # (--adapters still overrides below, matching the runner's precedence.)
    --keyword-only) EXTRA_ARGS+=("$1"); EXPECTED_ADAPTERS=1; shift ;;
    *) EXTRA_ARGS+=("$1"); shift ;;
  esac
done

# Mirror the runner's dataset-path derivation (longmemeval.ts parseOpts) so
# the wrapper and the workers always read the same file.
DATASET_PATH="${DATASET_PATH:-$HOME/datasets/longmemeval/longmemeval_${DATASET}.json}"
if [[ ! -f "$DATASET_PATH" ]]; then
  echo "[longmemeval-batch] FATAL: dataset not found at $DATASET_PATH" >&2
  echo "  Download from https://huggingface.co/datasets/xiaowu0162/longmemeval" >&2
  exit 1
fi

NDJSON="${NDJSON:-eval/reports/longmemeval/longmemeval-${DATASET}-k${TOP_K}.ndjson}"

if [[ -n "$ADAPTERS" ]]; then
  EXPECTED_ADAPTERS=$(echo "$ADAPTERS" | tr ',' '\n' | wc -l | tr -d ' ')
fi

# Derive the completion target from the dataset, applying the same
# --stratify (min(perType, bucket) per question_type) then --limit
# truncation the runner applies. --expected-questions overrides.
if [[ -z "$EXPECTED_QUESTIONS" ]]; then
  EXPECTED_QUESTIONS=$(bun -e '
    const fs = require("fs");
    const qs = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const stratify = Number(process.argv[2] || 0);
    const limit = Number(process.argv[3] || 0);
    let n;
    if (stratify > 0) {
      const buckets = {};
      for (const q of qs) buckets[q.question_type] = (buckets[q.question_type] ?? 0) + 1;
      n = Object.values(buckets).reduce((a, b) => a + Math.min(stratify, b), 0);
    } else {
      n = qs.length;
    }
    if (limit > 0) n = Math.min(n, limit);
    console.log(n);
  ' "$DATASET_PATH" "${STRATIFY:-0}" "${LIMIT:-0}")
fi

EXPECTED_TOTAL=$((EXPECTED_QUESTIONS * EXPECTED_ADAPTERS))
mkdir -p "$(dirname "$NDJSON")"

# Count UNIQUE completed (adapter, question_id) pairs, not raw lines.
# Concurrent workers can write the same pair twice when their
# resume-skip-set was read before the other worker's write landed; dedup
# before checking completion. Rows with an `error` field are re-queued by
# the runner, so they don't count as completed here either.
count_done() {
  if [[ -f "$NDJSON" ]]; then
    bun -e '
      const fs = require("fs"); const seen = new Set();
      for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
        if (!l.trim()) continue;
        try {
          const o = JSON.parse(l);
          if (o.error === undefined) seen.add(`${o.adapter}::${o.question_id}`);
        } catch {}
      }
      console.log(seen.size);
    ' "$NDJSON"
  else
    echo 0
  fi
}

echo "[longmemeval-batch] dataset=$DATASET ($DATASET_PATH) expected=$EXPECTED_QUESTIONS questions × $EXPECTED_ADAPTERS adapters = $EXPECTED_TOTAL pairs"

COMPLETE=0
DONE=$(count_done)
if [[ "$DONE" -ge "$EXPECTED_TOTAL" ]]; then
  COMPLETE=1
  echo "All $EXPECTED_TOTAL pairs already complete."
fi

if [[ "$COMPLETE" -ne 1 ]]; then
  for batch in $(seq 1 $MAX_BATCHES); do
    echo "=== batch $batch — $(date +%H:%M:%S) — completed $DONE/$EXPECTED_TOTAL pairs (workers=$WORKERS, budget=${BUDGET_SECONDS}s) ==="

    # Spawn $WORKERS workers in parallel. Each takes a slice of questions
    # (worker N processes questions where i % WORKERS == N). Stagger the
    # starts so the migration boilerplate doesn't all hit at once.
    pids=()
    for w in $(seq 0 $((WORKERS - 1))); do
      bun "$RUNNER" \
        --top-k "$TOP_K" \
        --dataset "$DATASET" \
        --path "$DATASET_PATH" \
        --ndjson "$NDJSON" \
        --max-wall-seconds "$BUDGET_SECONDS" \
        --worker-id "$w" \
        --total-workers "$WORKERS" \
        ${ADAPTERS:+--adapters "$ADAPTERS"} \
        ${LIMIT:+--limit "$LIMIT"} \
        ${STRATIFY:+--stratify "$STRATIFY"} \
        ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} \
        > "/tmp/lme-worker-$w.log" 2>&1 &
      pids+=($!)
      sleep 0.5
    done
    echo "Workers PIDs: ${pids[*]}"

    # Wait for all workers in this batch to finish (or die).
    for pid in "${pids[@]}"; do
      wait "$pid" 2>/dev/null || true
    done

    # Drain WAL across workers — important when one process closed the SQLite
    # while another still had the WAL open. WAL gets folded back into the
    # main file on next open; this is a no-op now but worth the comment.
    sleep 1

    NEW_DONE=$(count_done)
    if [[ "$NEW_DONE" -ge "$EXPECTED_TOTAL" ]]; then
      DONE=$NEW_DONE
      COMPLETE=1
      echo "All pairs complete after batch $batch."
      break
    fi
    if [[ "$NEW_DONE" -le "$DONE" ]]; then
      echo "[longmemeval-batch] FATAL: batch $batch made zero progress ($NEW_DONE/$EXPECTED_TOTAL pairs — worker logs: /tmp/lme-worker-*.log)" >&2
      DONE=$NEW_DONE
      break
    fi
    DONE=$NEW_DONE
  done
fi

if [[ "$COMPLETE" -ne 1 ]]; then
  echo "[longmemeval-batch] FAILED: only $DONE/$EXPECTED_TOTAL pairs completed — NOT aggregating a partial run" >&2
  exit 1
fi

echo
echo "=== aggregating final results ==="
bun "$AGGREGATOR" "$NDJSON"
