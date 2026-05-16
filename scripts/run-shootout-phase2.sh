#!/usr/bin/env bash
# Phase 2 of the embedder shootout: 7 BrainBench cells.
#
# Per cell, runs the multi-adapter BrainBench scorer TWICE:
#   - Once on the auto-built relational queries (P@5 / R@5)
#   - Once on the curated Cat 13 conceptual-recall subset
#     (--include-subset=cat13-embedder)
#
# Both runs use the HybridNoGraphAdapter wired with the per-cell
# {embedder, dim, reranker?, searchMode='tokenmax'} via AdapterConfig.shootout.
# This is the only adapter under test for the shootout — the existing
# RipgrepBm25/VectorOnly/GbrainAfterAdapter rows would just be noise.
#
# Cost: ~$8/cell × 7 = ~$56. Wallclock: ~30min/cell × 7 = ~3.5h serial.
# Required env: same as Phase 1.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

for key in OPENAI_API_KEY ANTHROPIC_API_KEY VOYAGE_API_KEY ZEROENTROPY_API_KEY; do
  if [ -z "${!key:-}" ]; then
    echo "[phase2] FATAL: $key is not set in env" >&2
    exit 1
  fi
done

RESULTS_DIR="$REPO_ROOT/results/shootout"
mkdir -p "$RESULTS_DIR"
LOG="$RESULTS_DIR/phase2-run-log.txt"
: > "$LOG"

# Cells: same matrix as Phase 1.
CELLS=(
  "A0|openai:text-embedding-3-large|1536|"
  "A1|openai:text-embedding-3-large|1536|zeroentropyai:zerank-2"
  "B0|voyage:voyage-4-large|2048|"
  "B1|voyage:voyage-4-large|2048|zeroentropyai:zerank-2"
  "C0|zeroentropyai:zembed-1|2560|"
  "C1|zeroentropyai:zembed-1|2560|zeroentropyai:zerank-2"
  "C2|zeroentropyai:zembed-1|1280|zeroentropyai:zerank-2"
)

# BrainBench multi-adapter currently picks adapter set from CLI; the
# shootout needs to thread AdapterConfig.shootout in. Until that wiring
# exists in multi-adapter.ts itself, the easiest path is a tiny driver
# (driver-shootout.ts) that imports HybridNoGraphAdapter directly and
# calls .init(pages, config) with shootout filled.
#
# We assume the wrapper script writer (per docs/designs/2026_05_EVAL_PLAN.md)
# wires that driver as scripts/shootout-driver.ts. If you're reading this
# and don't see one, that's the gap to fill in Session 5 before
# kicking off Phase 2.

DRIVER="$REPO_ROOT/eval/runner/shootout-driver.ts"
if [ ! -f "$DRIVER" ]; then
  echo "[phase2] NOTE: $DRIVER not present yet." >&2
  echo "         Add it as part of Session 5 — it should accept" >&2
  echo "         --embedder X --dim Y [--reranker Z] [--subset NAME]" >&2
  echo "         and drive a single HybridNoGraphAdapter cell against the" >&2
  echo "         eval/data/world-v1 corpus, emitting a per-cell receipt." >&2
  exit 2
fi

run_cell() {
  local cell="$1" embedder="$2" dim="$3" reranker="$4"
  local out_rel="$RESULTS_DIR/brainbench-${cell}-relational.json"
  local out_cat="$RESULTS_DIR/brainbench-${cell}-cat13.json"

  echo
  echo "===== cell $cell  embedder=$embedder dim=$dim ${reranker:+reranker=$reranker}  ====="
  echo "===== cell $cell" >>"$LOG"

  if [ ! -f "$out_rel" ]; then
    echo "  relational corpus..."
    bun run "$DRIVER" \
      --embedder "$embedder" --dim "$dim" ${reranker:+--reranker "$reranker"} \
      --output "$out_rel" \
      >>"$LOG" 2>&1
  else
    echo "  relational already done: $out_rel"
  fi

  if [ ! -f "$out_cat" ]; then
    echo "  Cat 13 conceptual subset..."
    bun run "$DRIVER" \
      --embedder "$embedder" --dim "$dim" ${reranker:+--reranker "$reranker"} \
      --subset cat13-embedder \
      --output "$out_cat" \
      >>"$LOG" 2>&1
  else
    echo "  Cat 13 already done: $out_cat"
  fi

  echo "  -> $cell done"
}

for entry in "${CELLS[@]}"; do
  IFS='|' read -r cell embedder dim reranker <<<"$entry"
  run_cell "$cell" "$embedder" "$dim" "$reranker" || {
    rc=$?
    echo "[phase2] cell $cell exit=$rc — continuing" >&2
  }
done

echo
echo "[phase2] complete. Results: $RESULTS_DIR"
echo "         Log: $LOG"
echo "         Next: write up the comparison (docs/benchmarks/2026-05-22-embedder-shootout.md)"
