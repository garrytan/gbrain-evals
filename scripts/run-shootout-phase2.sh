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

# Overridable so hermetic tests never truncate the committed
# results/shootout/phase2-run-log.txt or delete the committed A0 receipts.
RESULTS_DIR="${SHOOTOUT_RESULTS_DIR:-$REPO_ROOT/results/shootout}"
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

  # Build driver args as an array — the old ${reranker:+--reranker "$reranker"}
  # inline expansion is fragile, and --cell was never passed at all, so every
  # committed receipt shipped "cell": null (audit critic finding, visible in
  # results/shootout/*.json).
  local -a common_args=(--cell "$cell" --embedder "$embedder" --dim "$dim")
  if [ -n "$reranker" ]; then
    common_args+=(--reranker "$reranker")
  fi

  echo
  echo "===== cell $cell  embedder=$embedder dim=$dim ${reranker:+reranker=$reranker}  ====="
  echo "===== cell $cell" >>"$LOG"

  # Fully-resumed cell: nothing left to run, skip the smoke spend too.
  if [ -f "$out_rel" ] && [ -f "$out_cat" ]; then
    echo "  -> $cell already done: $out_rel + $out_cat (skipping)"
    return 0
  fi

  # Smoke gate — same per-cell pre-flight phase1 runs (audit orchestrators-19:
  # phase2 skipped it, so a dim typo in CELLS was only caught AFTER the driver
  # had embedded the full 240-page corpus). smoke.ts aborts the cell before
  # any corpus-scale embed spend: wiring + dim assert, long-haystack, and (for
  # reranker cells) a real rerank payload check.
  echo "  smoke gate..."
  if ! bun run "$REPO_ROOT/eval/runner/smoke.ts" \
       --embedder "$embedder" --dim "$dim" ${reranker:+--reranker "$reranker"} \
       >>"$LOG" 2>&1; then
    echo "  -> $cell smoke FAILED (see $LOG); aborting cell" >&2
    return 2
  fi

  # Every step has explicit error handling: set -e is suspended inside
  # functions called under `if`/`||`, so without these guards a failed
  # driver run fell through and printed "-> done" (audit orchestrators-06).
  if [ ! -f "$out_rel" ]; then
    echo "  relational corpus..."
    if ! bun run "$DRIVER" "${common_args[@]}" --output "$out_rel" >>"$LOG" 2>&1; then
      echo "  -> $cell relational FAILED (see $LOG)" >&2
      return 4
    fi
  else
    echo "  relational already done: $out_rel"
  fi

  if [ ! -f "$out_cat" ]; then
    echo "  Cat 13 conceptual subset..."
    if ! bun run "$DRIVER" "${common_args[@]}" --subset cat13-embedder --output "$out_cat" >>"$LOG" 2>&1; then
      echo "  -> $cell cat13 FAILED (see $LOG)" >&2
      return 5
    fi
  else
    echo "  Cat 13 already done: $out_cat"
  fi

  echo "  -> $cell done"
}

FAILED_CELLS=()
for entry in "${CELLS[@]}"; do
  IFS='|' read -r cell embedder dim reranker <<<"$entry"
  if run_cell "$cell" "$embedder" "$dim" "$reranker"; then
    :
  else
    rc=$?
    FAILED_CELLS+=("$cell:exit=$rc")
    echo "[phase2] cell $cell FAILED exit=$rc — continuing" >&2
  fi
done

echo
echo "[phase2] complete. Results: $RESULTS_DIR"
echo "         Log: $LOG"
if [ ${#FAILED_CELLS[@]} -gt 0 ]; then
  echo "[phase2] FAILED cells: ${FAILED_CELLS[*]} — matrix is PARTIAL, do not publish" >&2
  exit 1
fi
echo "         Next: write up the comparison (docs/benchmarks/2026-05-22-embedder-shootout.md)"
