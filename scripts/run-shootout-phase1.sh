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
# Cost control: this wrapper meters WALL CLOCK, not dollars (nothing here
# reads token counts; the old "$90/cell hard cap" comment described logic
# that never existed — audit orchestrators-10). Each cell's answer-gen step
# runs under timeout(1) with PHASE1_CELL_WALL_CAP_SECONDS (default 9000s =
# ~1.7x the expected ~90min); on overrun the cell is killed, marked FAILED,
# and stays resumable via --resume-from. If timeout(1) is missing (stock
# macOS without coreutils) the cap is disabled with a loud warning.
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

# Minimum-version gate (audit orchestrators-02: the old allowlist accepted
# only 0.35.x-0.36.x and rejected every NEWER version, including the repo's
# own pin). --resume-from needs >= 0.35.1.0; anything newer is fine.
GBRAIN_VERSION_RAW="$(gbrain --version 2>&1 | head -1)"
GBRAIN_VERSION="$(printf '%s' "$GBRAIN_VERSION_RAW" | grep -oE '[0-9]+(\.[0-9]+)+' | head -1)"
MIN_VERSION="0.35.1.0"
if [ -z "$GBRAIN_VERSION" ] || [ "$(printf '%s\n%s\n' "$MIN_VERSION" "$GBRAIN_VERSION" | sort -V | head -1)" != "$MIN_VERSION" ]; then
  echo "[phase1] FATAL: gbrain version is '$GBRAIN_VERSION_RAW' (need >= $MIN_VERSION for --resume-from)" >&2
  exit 1
fi

# Per-cell wall-clock cap (see header). Applied to the answer-gen step only —
# that is the step that spends money; smoke + scoring are bounded and cheap.
CELL_WALL_CAP_SECONDS="${PHASE1_CELL_WALL_CAP_SECONDS:-9000}"
CAP_CMD=()
if command -v timeout >/dev/null 2>&1; then
  CAP_CMD=(timeout "$CELL_WALL_CAP_SECONDS")
else
  echo "[phase1] WARN: timeout(1) not found — per-cell wall-clock cap DISABLED (install coreutils to enable)" >&2
fi

# Results land here. Receipts get committed to the PR β branch by the user
# after the run completes. Overridable so hermetic tests never touch the
# repo's committed artifacts under results/shootout/.
RESULTS_DIR="${SHOOTOUT_RESULTS_DIR:-$REPO_ROOT/results/shootout}"
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

  # Reranker cells: gbrain's CLI has NO way to configure a reranker for
  # `gbrain eval longmemeval` — the only entry is the programmatic
  # searchConfigSnapshot (v0.45 #3676), which is not exported. The old
  # script "configured" it via GBRAIN_RERANKER_MODEL / GBRAIN_SEARCH_MODE /
  # GBRAIN_SEARCH_RERANKER_ENABLED env vars that NOTHING in gbrain reads
  # (audit orchestrators-03) — and the ${var:+X=y} prefix expansion made
  # every such cell die with exit 127 anyway (audit orchestrators-01,
  # reproduced: expansion words are never treated as assignments). Running
  # the cell unreranked while labeling it reranked would be worse than not
  # running it. Abort loudly until upstream ships a --search-config flag
  # (TODOS.md); note zerank-2's hosted API sunsets 2026-09-04.
  if [ -n "$reranker" ]; then
    echo "  -> $cell SKIPPED: reranker cells are not configurable via the gbrain CLI (see TODOS.md); refusing to run unreranked under a reranked label" >&2
    return 3
  fi

  local resume_args=()
  if [ -f "$out" ]; then
    resume_args=(--resume-from "$out")
    echo "  resuming from existing $out ($(wc -l <"$out") rows present)"
  fi

  if [ ${#CAP_CMD[@]} -gt 0 ]; then
    echo "  embed + answer-gen... (wall cap: ${CELL_WALL_CAP_SECONDS}s)"
  else
    echo "  embed + answer-gen... (wall cap: DISABLED — timeout(1) missing)"
  fi
  # env(1) with array args: assignments here are ordinary arguments to env,
  # so they survive word-splitting rules that broke the old inline-prefix
  # form. GBRAIN_EMBEDDING_MODEL/DIMENSIONS are genuinely read by gbrain's
  # config loader (config.ts:712); --mode is the explicit search-mode flag.
  # ${array[@]+...} keeps set -u happy when either array is empty (bash < 4.4);
  # timeout(1) execs env → gbrain, so config still reaches the child, and an
  # overrun returns 124 which lands in the same FAILED path (resume-safe).
  if ! ${CAP_CMD[@]+"${CAP_CMD[@]}"} env \
      GBRAIN_EMBEDDING_MODEL="$embedder" \
      GBRAIN_EMBEDDING_DIMENSIONS="$dim" \
      gbrain eval longmemeval "$LONGMEMEVAL_DATASET" \
        --output "$out" \
        --mode tokenmax \
        --expansion \
        ${resume_args[@]+"${resume_args[@]}"} \
        >>"$LOG" 2>&1; then
    echo "  -> $cell answer-gen FAILED or exceeded the ${CELL_WALL_CAP_SECONDS}s wall cap (see $LOG)" >&2
    return 4
  fi

  # Published evaluator interface: positional <metric_model> <hyp> <ref>
  # (the old --input/--output flags do not exist upstream — audit
  # orchestrators-04). Verify against your LongMemEval checkout's README.
  echo "  score via evaluate_qa.py..."
  if ! (cd "$LONGMEMEVAL_REPO" && \
    .venv/bin/python src/evaluation/evaluate_qa.py \
      gpt-4o "$out" "$LONGMEMEVAL_DATASET" \
      >"$scored.log" 2>&1); then
    echo "  -> $cell scoring FAILED (see $scored.log)" >&2
    return 5
  fi
  # evaluate_qa.py writes its results next to the hypothesis file; collect
  # anything it produced plus the log into the scored artifact.
  {
    echo "{\"cell\": \"$cell\", \"embedder\": \"$embedder\", \"dim\": $dim, \"scored_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo " \"evaluator_log\": $(python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()))' "$scored.log")}"
  } > "$scored"

  echo "  -> $cell done: $scored"
}

# ─── Sequence ───────────────────────────────────────────────────────

# NOTE on errexit: calling run_cell inside `if` deliberately suspends set -e
# for the call, but every step INSIDE run_cell now has explicit error
# handling with distinct return codes — a failed step can no longer fall
# through to "done" (audit orchestrators-05). Failures are tallied and the
# script exits non-zero so a partial matrix can never be scored and locked
# in silently.
FAILED_CELLS=()
SKIPPED_CELLS=()
for entry in "${CELLS[@]}"; do
  IFS='|' read -r cell embedder dim reranker <<<"$entry"
  if run_cell "$cell" "$embedder" "$dim" "$reranker"; then
    :
  else
    rc=$?
    if [ "$rc" -eq 3 ]; then
      SKIPPED_CELLS+=("$cell")
      echo "[phase1] cell $cell SKIPPED (reranker unsupported via CLI) — continuing" >&2
    else
      FAILED_CELLS+=("$cell:exit=$rc")
      echo "[phase1] cell $cell FAILED exit=$rc — continuing with next cell" >&2
    fi
  fi
done

echo
echo "[phase1] complete. Results: $RESULTS_DIR"
echo "         Log: $LOG"
if [ ${#SKIPPED_CELLS[@]} -gt 0 ]; then
  echo "[phase1] SKIPPED cells (not runnable, see TODOS.md): ${SKIPPED_CELLS[*]}"
fi
if [ ${#FAILED_CELLS[@]} -gt 0 ]; then
  echo "[phase1] FAILED cells: ${FAILED_CELLS[*]}" >&2
  exit 1
fi
echo "         Next: bash scripts/run-shootout-phase2.sh"
