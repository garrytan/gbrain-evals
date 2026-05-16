#!/usr/bin/env bash
# Phase 1 of the embedder shootout: 7 LongMemEval cells.
#
# Per cell:
#   1. Configure gbrain via env vars (file-plane stays stable; gateway
#      reads env at startup).
#   2. Pre-flight smoke against the configured provider.
#   3. Run `gbrain eval longmemeval` in answer-gen mode (NOT --retrieval-only).
#   4. Score the hypothesis JSONL via LongMemEval's published evaluate_qa.py.
#
# Serial across cells per docs/designs/2026_05_EVAL_PLAN.md D6 (clean
# rate-limit profile; first-contact run on ZE wants debuggable signal).
#
# Each cell is independently resumable via gbrain's --resume-from flag
# (added in v0.35.1.0). If a cell aborts mid-run, re-running the script
# picks up where it left off — already-answered question_ids are skipped.
#
# Required env (fail-loud at start):
#   OPENAI_API_KEY       gpt-4o judge + OpenAI cells
#   ANTHROPIC_API_KEY    Sonnet answer-gen
#   VOYAGE_API_KEY       Voyage cells
#   ZEROENTROPY_API_KEY  ZE cells
#
# Required tooling:
#   - gbrain CLI on PATH (v0.35.1.0+) — verify with `gbrain --version`
#   - LongMemEval evaluator checked out at $LONGMEMEVAL_REPO
#     git clone https://github.com/xiaowu0162/LongMemEval ~/git/LongMemEval
#     cd ~/git/LongMemEval && python -m venv .venv && .venv/bin/pip install -r requirements.txt
#   - Dataset at $LONGMEMEVAL_DATASET (default ~/datasets/longmemeval/longmemeval_s.json)
#     Gated on HuggingFace; one-time setup.
#
# Cost: ~$68/cell × 7 = ~$476. Wallclock: ~90min/cell × 7 = ~10.5h serial.
# Hard cap: $90/cell (wrapper aborts the cell on overrun).
#
# Resume:
#   bash scripts/run-shootout-phase1.sh                # initial run
#   bash scripts/run-shootout-phase1.sh                # rerun after abort: skips done cells, resumes partial cell

set -euo pipefail

# Locate repo root (this script lives in scripts/).
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# ─── Env validation ─────────────────────────────────────────────────

for key in OPENAI_API_KEY ANTHROPIC_API_KEY VOYAGE_API_KEY ZEROENTROPY_API_KEY; do
  if [ -z "${!key:-}" ]; then
    echo "[phase1] FATAL: $key is not set in env" >&2
    exit 1
  fi
done

LONGMEMEVAL_REPO="${LONGMEMEVAL_REPO:-$HOME/git/LongMemEval}"
LONGMEMEVAL_DATASET="${LONGMEMEVAL_DATASET:-$HOME/datasets/longmemeval/longmemeval_s.json}"
EVALUATE_QA="$LONGMEMEVAL_REPO/src/evaluation/evaluate_qa.py"

if [ ! -f "$LONGMEMEVAL_DATASET" ]; then
  echo "[phase1] FATAL: dataset not found at $LONGMEMEVAL_DATASET" >&2
  echo "         Download from https://huggingface.co/datasets/xiaowu0162/longmemeval" >&2
  exit 1
fi
if [ ! -f "$EVALUATE_QA" ]; then
  echo "[phase1] FATAL: evaluate_qa.py not found at $EVALUATE_QA" >&2
  echo "         git clone https://github.com/xiaowu0162/LongMemEval $LONGMEMEVAL_REPO" >&2
  echo "         cd $LONGMEMEVAL_REPO && python -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

if ! command -v gbrain >/dev/null 2>&1; then
  echo "[phase1] FATAL: gbrain CLI not on PATH" >&2
  exit 1
fi

GBRAIN_VERSION="$(gbrain --version 2>&1 | head -1)"
case "$GBRAIN_VERSION" in
  *0.35.1.0*|*0.35.2*|*0.36.*) ;; # ok
  *)
    echo "[phase1] FATAL: gbrain version is $GBRAIN_VERSION (need v0.35.1.0+ for --resume-from)" >&2
    exit 1
    ;;
esac

# Results land here. Receipts get committed to the PR β branch by the user
# after the run completes.
RESULTS_DIR="$REPO_ROOT/results/shootout"
mkdir -p "$RESULTS_DIR"
LOG="$RESULTS_DIR/phase1-run-log.txt"
: > "$LOG"

echo "[phase1] gbrain $GBRAIN_VERSION  | dataset $LONGMEMEVAL_DATASET  | results $RESULTS_DIR"
echo "[phase1] gbrain $GBRAIN_VERSION" >>"$LOG"

# ─── Cell matrix ────────────────────────────────────────────────────

# Cell : (embedder, dim, reranker)
# A0/A1: openai:text-embedding-3-large @ 1536  (no rerank / +zerank-2)
# B0/B1: voyage:voyage-4-large         @ 2048  (no rerank / +zerank-2)
# C0/C1: zeroentropyai:zembed-1        @ 2560  (no rerank / +zerank-2)
# C2:    zeroentropyai:zembed-1        @ 1280  (+zerank-2, Matryoshka ablation)

CELLS=(
  "A0|openai:text-embedding-3-large|1536|"
  "A1|openai:text-embedding-3-large|1536|zeroentropyai:zerank-2"
  "B0|voyage:voyage-4-large|2048|"
  "B1|voyage:voyage-4-large|2048|zeroentropyai:zerank-2"
  "C0|zeroentropyai:zembed-1|2560|"
  "C1|zeroentropyai:zembed-1|2560|zeroentropyai:zerank-2"
  "C2|zeroentropyai:zembed-1|1280|zeroentropyai:zerank-2"
)

# ─── Per-cell runner ────────────────────────────────────────────────

run_cell() {
  local cell="$1" embedder="$2" dim="$3" reranker="$4"
  local out="$RESULTS_DIR/longmemeval-${cell}.jsonl"
  local scored="$RESULTS_DIR/longmemeval-${cell}-scored.json"

  echo
  echo "===== cell $cell  embedder=$embedder dim=$dim ${reranker:+reranker=$reranker}  ====="
  echo "===== cell $cell" >>"$LOG"

  # Skip scoring step if scored output already exists (resumed-and-completed).
  if [ -f "$scored" ]; then
    echo "  -> $cell already scored: $scored (skipping)"
    return 0
  fi

  # Smoke gate. If smoke fails, we abort the cell without spending judge tokens.
  echo "  smoke gate..."
  if ! bun run "$REPO_ROOT/eval/runner/smoke.ts" \
       --embedder "$embedder" --dim "$dim" ${reranker:+--reranker "$reranker"} \
       >>"$LOG" 2>&1; then
    echo "  -> $cell smoke FAILED (see $LOG); aborting cell" >&2
    return 2
  fi

  # gbrain config via env. File-plane config (~/.gbrain/config.json) is the
  # other path but env is faster + scoped to this invocation only.
  local resume_arg=""
  if [ -f "$out" ]; then
    resume_arg="--resume-from $out"
    echo "  resuming from existing $out ($(wc -l <"$out") rows present)"
  fi

  echo "  embed + answer-gen..."
  GBRAIN_EMBEDDING_MODEL="$embedder" \
  GBRAIN_EMBEDDING_DIMENSIONS="$dim" \
  ${reranker:+GBRAIN_RERANKER_MODEL="$reranker"} \
  ${reranker:+GBRAIN_SEARCH_RERANKER_ENABLED=true} \
  GBRAIN_SEARCH_MODE=tokenmax \
    gbrain eval longmemeval "$LONGMEMEVAL_DATASET" \
      --output "$out" \
      --mode tokenmax \
      --expansion \
      $resume_arg \
      >>"$LOG" 2>&1

  echo "  score via evaluate_qa.py..."
  (cd "$LONGMEMEVAL_REPO" && \
    .venv/bin/python src/evaluation/evaluate_qa.py \
      --input "$out" --output "$scored" \
      >>"$LOG" 2>&1)

  echo "  -> $cell done: $scored"
}

# ─── Sequence ───────────────────────────────────────────────────────

for entry in "${CELLS[@]}"; do
  IFS='|' read -r cell embedder dim reranker <<<"$entry"
  run_cell "$cell" "$embedder" "$dim" "$reranker" || {
    rc=$?
    echo "[phase1] cell $cell exit=$rc — continuing with next cell" >&2
  }
done

echo
echo "[phase1] complete. Results: $RESULTS_DIR"
echo "         Log: $LOG"
echo "         Next: bash scripts/run-shootout-phase2.sh"
