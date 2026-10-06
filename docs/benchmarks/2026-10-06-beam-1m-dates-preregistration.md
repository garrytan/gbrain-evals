# Preregistration: BEAM-1M on the fixed date loader, at the starting-line build and at the pin (2026-10-06)

Frozen on October 6, 2026, in its own commit, before any BEAM-1M request. Nothing below changes after a request; a later change is a dated amendment at the end. Workstream W13 of the [2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md) (inventory row F7), with the answer half funded by Garry's decision G8 and its protocol reader and judge allowed by G9.

## Question

The held-out program's starting line (2026-10-05) put BEAM-1M dev strict recall at 18.2% and answer accuracy at 54.6%, measured on gbrain `6622a119e`. Those rows ran on a loader that dated only the first turn group of each BEAM batch, so about 96% of sessions reached gbrain and the reader without a date (gbrain-evals `d263dd8`, v0.10.32, fixed it; the BEAM-100K rerun moved by 2 questions). Two questions:

1. **Correction.** What do the same build and settings score once every session carries its date?
2. **P-series effect.** On the fixed loader, does the round's pin `c5fb0201` (which carries the nine held-out-program plans) retrieve better than `6622a119e` on BEAM-1M, where strict recall is weakest?

## Evidence class

Development evidence. BEAM-1M dev is a public split the program has measured before; nothing here is held out. The answer half uses the protocol's older reader and judge to correct a published row; it is not a model comparison.

## Build and data

- Baseline arm: gbrain `6622a119e40ea09a7719233046aca24741863ed2` (v0.60.48.0), the starting line's build, as a copied overlay of `~/gbrain`.
- Candidate arm: gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0), the round's pin, as a copied overlay.
- gbrain-evals: this branch, which carries the fixed BEAM loader (`beamGroupDates`, `eval/runner/memory-qa/corpus.ts`).
- Dataset: BEAM at revision `b2da22e` (manifest `eval/decisions/datasets/beam-b2da22e.json`, SHA-256 `cb154a2f...`, every file SHA-checked by `fetch`), size 1M, dev split: 11 conversations, 220 questions, 198 with gold sessions (22 abstention questions are excluded from recall as before).
- Decision spec: [`2026-10-06-beam-1m-dates/decision.json`](2026-10-06-beam-1m-dates/decision.json), written by `eval:decide init` and edited only to name the source `beam-1m` (benchmark `beam-1m`, real embeddings).

## Arms and settings

**Retrieval half (both arms).** Exactly the starting line's retrieval settings, read from its shard receipts: `search.mode=balanced`, `search.reranker.enabled=false`, `search.autocut=false`, `hybridSearch` with expansion off reduced to distinct sessions, top 10, seed 42, `openai:text-embedding-3-large` at 1,536 dimensions, no facts lane. Sequence:

```bash
bun run eval:decide init --plan P0 --id beam-1m-dates-2026-10-06 --gbrain ~/gbrain@c5fb0201... --baseline ~/gbrain@6622a119e... --budget-usd 5 --out docs/benchmarks/2026-10-06-beam-1m-dates
bun run eval:decide fetch --benchmark beam-1m
BRAINBENCH_BUDGET_LEDGER=/workspace/gbrain-evals/.budget/followups-2026-10.sqlite \
  bun run eval:decide dev --decision docs/benchmarks/2026-10-06-beam-1m-dates --only beam-1m --shards 3 --paid --budget-usd 5 \
  --budget-ledger /workspace/gbrain-evals/.budget/followups-2026-10.sqlite
bun run eval:decide verdict --decision docs/benchmarks/2026-10-06-beam-1m-dates --only beam-1m
```

Configuration identity check: `memory-qa/run.ts` hashes the benchmark, split, pins, embedding model and dimensions, QA settings, seed, top-k, gbrain build and dataset manifest. The baseline arm's `run_config_hash` must equal the starting line's `ed768142864d58051ce96588e1c95ced73e2fbd8b34c49cc56e6125e5c4877e9`; if it does not, the difference is reported and the correction is labeled as a changed configuration.

**Answer half (G8, G9).** The starting line's QA protocol, read from its receipt: reader mode, `openai:gpt-4.1-mini` reader, `openai:gpt-4.1-mini` per-rubric-item judge, 1 run, top 5 sessions as reader context in date order (the LongMemEval step-by-step reading prompt), same retrieval settings. Run with `eval/runner/memory-qa/run.ts --benchmark beam-1m --split dev --embed real --gbrain <arm> --pin ...(as above) --top-k 10 --seed 42 --qa reader --qa-runs 1 --qa-sessions 5 --reader openai:gpt-4.1-mini --judge openai:gpt-4.1-mini --shard i/2 --paid --budget-run-id <run>`, under one ledger run opened with `budget-ledger.ts open --budget-usd 2`. Order: the baseline arm `6622a119e` first (the correction). The candidate arm at `c5fb0201` runs only if the baseline arm's measured cost leaves enough of the $2 to cover it (the starting line's arm cost $1.12, so it is expected not to fit); otherwise it is published as Not run, with the reason.

## Metric and denominator

- Primary retrieval metric: recall of all gold sessions in the top 5 distinct sessions (strict), over the 198 questions with gold. Also recall of any gold session at 5, recall of all at 10, nDCG@10 and latency. Analysis unit: question; cluster: conversation (11).
- Answer metric: judged answer score over all 220 questions, abstention questions included (the starting line's `qa_score`), with the answerable-only score and the abstention score beside it.
- A row that errors stays in the denominator as a miss; harness errors and refusals are counted per arm.

## Decision rule

- **Correction:** no test. The baseline arm's strict recall and answer score replace nothing in the starting-line receipts (they stand as measured); they are published as the corrected row, labeled "fixed date loader, same build".
- **P-series effect:** `eval:decide verdict` on the frozen comparison family in `decision.json`: `recall-all-5` superiority (candidate minus baseline, clustered bootstrap by conversation, alpha 0.05, minimum effect 0), `recall-any-5` non-inferiority with a 1-point tolerance, nDCG@10 and latency exploratory. Holm across the two gated comparisons. With 11 conversations the test resolves only large differences, roughly 8 points or more of strict recall; a difference whose interval crosses zero is reported as "not distinguished at this sample size", never as a tie. There is no candidate-versus-baseline test on the answer half.

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| Starting-line row corrected; P-series retrieval effect on BEAM-1M published | Same | Same |

## Budget

One ledger, `/workspace/gbrain-evals/.budget/followups-2026-10.sqlite` (program cap $297). Retrieval half: the ledger run `eval:decide dev` opens with `--budget-usd 5` (estimate $3: $1.55 per build at the starting line's recorded cost, less if both builds chunk the same text and share the embedding cache); every embedding request is reserved and settled per request through that run. Answer half: a separate ledger run with `--budget-usd 2`. A request that would pass a run's cap is refused, the arm is published as Partial, and nothing is retried outside the ledger. Caches are lane-local (`GBRAIN_EVALS_EMBED_CACHE`, `GBRAIN_EVALS_QA_CACHE` under `~/.capy/work/lane-a/`), cold at the start.

## Amendments

None yet.
