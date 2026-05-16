# Embedder Shootout Runbook

Operator-facing instructions for executing Sessions 4-5 of the
`docs/designs/2026_05_EVAL_PLAN.md` plan (which lives in the gbrain repo).
The plan describes the matrix and decision rationale; this runbook is
strictly the "how to actually press Go" companion.

**Cost ceiling:** ~$525 total. **Wallclock:** ~14h total, mostly overnight.

## One-time prereqs

You only need to do this setup once. After that, both phase scripts are
re-runnable.

### 1. Required API keys (export in the shell you'll run the script from)

```bash
export OPENAI_API_KEY=...      # Sonnet answer-gen + gpt-4o judge + A0/A1 cells
export ANTHROPIC_API_KEY=...   # Sonnet answer-gen
export VOYAGE_API_KEY=...      # B0/B1 cells
export ZEROENTROPY_API_KEY=... # C0/C1/C2 cells + zerank-2 reranker
```

### 2. LongMemEval dataset (gated HF download)

```bash
# Get a HuggingFace token from huggingface.co/settings/tokens
# Accept the dataset terms at https://huggingface.co/datasets/xiaowu0162/longmemeval
mkdir -p ~/datasets/longmemeval
cd ~/datasets/longmemeval

# Pull longmemeval_s.json (265MB)
huggingface-cli download xiaowu0162/longmemeval \
  longmemeval_s.json --local-dir . --local-dir-use-symlinks=False

# Sanity check
test -f ~/datasets/longmemeval/longmemeval_s.json && echo OK
```

### 3. LongMemEval evaluator (Python)

```bash
git clone https://github.com/xiaowu0162/LongMemEval ~/git/LongMemEval
cd ~/git/LongMemEval
python -m venv .venv
.venv/bin/pip install -r requirements.txt
# Verify
.venv/bin/python src/evaluation/evaluate_qa.py --help
```

### 4. gbrain v0.35.1.0+ on PATH

```bash
gbrain --version    # must print 0.35.1.0 or higher
# If older: bun install -g github:garrytan/gbrain#master
```

## Phase 1 — LongMemEval × 7 cells

**Cost:** ~$476. **Wallclock:** ~10.5h serial. Kick off overnight.

```bash
cd ~/git/gbrain-evals
git checkout garrytan/embedder-shootout
git pull origin garrytan/embedder-shootout

# Kick off — will fail-loud at the env check if anything's missing.
nohup bash scripts/run-shootout-phase1.sh \
  > results/shootout/phase1-stdout.txt 2>&1 &
echo $! > results/shootout/phase1.pid

# Or interactive (Ctrl-C aborts the active cell cleanly; --resume-from
# in the next run will pick up where it stopped):
bash scripts/run-shootout-phase1.sh
```

**What happens per cell** (7 cells in series, ~90min each):

1. Smoke gate (5 short embed queries + 1 long-haystack + 1 rerank payload
   for rerank-enabled cells). Fail → cell aborts, no token spend.
2. `gbrain eval longmemeval` in answer-gen mode (Anthropic Sonnet generates
   the answer per question, retrieved sessions are NOT used as hypothesis).
   With `--mode tokenmax --expansion`. Output: 500-line JSONL.
3. LongMemEval's `evaluate_qa.py` scores the JSONL via OpenAI gpt-4o. Output:
   per-cell correctness JSON.

**Resume:** if anything aborts mid-cell, re-run the script. Already-scored
cells are skipped. Mid-cell aborts resume via the v0.35.1.0 `--resume-from`
flag I added to `gbrain eval longmemeval`.

**Receipts land at:**
```
results/shootout/longmemeval-{A0,A1,B0,B1,C0,C1,C2}.jsonl         (raw hypothesis)
results/shootout/longmemeval-{A0,A1,B0,B1,C0,C1,C2}-scored.json   (gpt-4o correctness)
results/shootout/phase1-run-log.txt                               (full stderr)
```

## Phase 2 — BrainBench × 7 cells

**Cost:** ~$56. **Wallclock:** ~3.5h serial. Cheap; can interleave with
Phase 1 if you want, but the script assumes serial.

**Gap:** `scripts/run-shootout-phase2.sh` references
`eval/runner/shootout-driver.ts` which is the per-cell single-adapter
driver. **It doesn't exist yet** — Session 5 needs to add it before this
phase runs. The wrapper exits non-zero with a clear "add the driver"
message if it's missing.

The driver should:
- Accept `--embedder X --dim Y [--reranker Z] [--subset NAME]`.
- Load `eval/data/world-v1/` corpus.
- Spin up a single HybridNoGraphAdapter with `AdapterConfig.shootout` set.
- Run either `buildQueries()` (no `--subset`) or `loadSubset(name)` queries.
- Score via existing `precisionAtK` + `recallAtK`.
- Emit a per-cell JSON receipt to `--output PATH`.

Once added, run:

```bash
bash scripts/run-shootout-phase2.sh
```

Per cell, the script runs the driver twice: once on the relational
corpus, once on `--subset cat13-embedder`. Receipts:

```
results/shootout/brainbench-{cell}-relational.json
results/shootout/brainbench-{cell}-cat13.json
```

## After both phases

1. **Commit receipts** to the `garrytan/embedder-shootout` branch of
   `gbrain-evals` (PR #8).
2. **Write up** `docs/benchmarks/2026-05-22-embedder-shootout.md` with the
   comparison table, paired-bootstrap p-values, HNSW footnote, and the
   explicit "do NOT change `gbrain init` default" recommendation (per
   codex outside-voice on the plan).
3. **Merge PR β** to gbrain-evals main.
4. **Optionally ship** v0.35.2.0 in gbrain with a CHANGELOG entry that
   cross-links the benchmark (PR γ — Session 6 in the plan).

## Cost dashboard (running tally)

The wrapper logs per-cell wallclock and writes a budget marker if any
single cell exceeds $90. To check progress at a glance during the run:

```bash
tail -f results/shootout/phase1-run-log.txt
ls -la results/shootout/longmemeval-*-scored.json 2>/dev/null | wc -l   # cells complete out of 7
```

## Abort + recovery

- **Ctrl-C** (interactive run): kills the current bun process. The
  partial JSONL is preserved. Re-run the script — `--resume-from` skips
  question_ids already answered in the file.
- **Kill backgrounded run:** `kill $(cat results/shootout/phase1.pid)`.
- **Wedged cell:** delete the JSONL for that cell and re-run. The smoke
  gate at the top of each cell catches config drift before spending.
- **Out of budget mid-run:** stop the run. Already-completed cells are
  in `*-scored.json` and committable as partial progress.
