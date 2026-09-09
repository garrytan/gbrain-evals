# Historical embedder comparison: status and operating notes

This is the operator record for Sessions 4–5 of the May 2026 embedder plan, `docs/designs/2026_05_EVAL_PLAN.md` in the gbrain repository. The two shell scripts remain incomplete as a current end-to-end recipe.

For current retrieval comparisons, start with the [September ranking report](../docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md), the [retrieval refresh](../docs/benchmarks/2026-09-09-retrieval-refresh.md), or the [evaluation runbook](../eval/RUNBOOK.md). Do not launch this historical matrix to reproduce their results.

## What the original matrix asked

An embedder turns text into vectors. A reranker then reads a short candidate list and changes its order. The plan varied those components to see which combinations helped on conversation retrieval and the fictional BrainBench corpus.

| Cells | Embedder and dimensions | Reranker |
|---|---|---|
| A0 / A1 | `openai:text-embedding-3-large`, 1536 | Off / `zeroentropyai:zerank-2` |
| B0 / B1 | `voyage:voyage-4-large`, 2048 | Off / `zeroentropyai:zerank-2` |
| C0 / C1 | `zeroentropyai:zembed-1`, 2560 | Off / `zeroentropyai:zerank-2` |
| C2 | `zeroentropyai:zembed-1`, 1280 | `zeroentropyai:zerank-2` |

The original estimate was approximately $525 and 14 hours in total. Its detailed estimates were $476 / 10.5 hours for Phase 1 and $56 / 3.5 hours for Phase 2. These were planning estimates, not enforced dollar limits or a current provider quote.

## Why it is incomplete

Phase 1 explicitly refuses A1, B1, C1 and C2. The August 31 audit found that the script's reranker environment variables were not read by the then-current CLI. Running without reranking under a reranked label would have invalidated the comparison. The refusal remains in this wrapper even though newer gbrain experiments expose additional configuration controls.

Both scripts still require all four provider keys at startup, including `ZEROENTROPY_API_KEY`. The historical plan recorded a September 4, 2026 sunset for ZeroEntropy's hosted API. The three non-reranked cells are therefore structurally unrefused, not a promise that this old matrix remains operational.

Phase 2 references `eval/runner/shootout-driver.ts`, which does not exist. The wrapper exits with an explanation when it cannot find that driver.

## What Phase 1 actually does

For each cell, `run-shootout-phase1.sh` checks the provider with a small live smoke test, then generates answers with `gbrain eval longmemeval --mode tokenmax --expansion`. Anthropic Sonnet supplies answers; the external LongMemEval evaluator judges them with OpenAI gpt-4o.

That is an answer-quality experiment, not retrieval recall. A smoke test can itself make paid calls. A refusal after smoke does not mean no provider calls occurred.

The historical setup requires:

- `OPENAI_API_KEY` for OpenAI embeddings and the answer judge.
- `ANTHROPIC_API_KEY` for answer generation.
- `VOYAGE_API_KEY` and `ZEROENTROPY_API_KEY` for their matrix cells.
- The dataset at `LONGMEMEVAL_DATASET`, defaulting to `~/datasets/longmemeval/longmemeval_s.json`.
- The evaluator checkout at `LONGMEMEVAL_REPO`, defaulting to `~/git/LongMemEval`, with its Python environment installed.
- A `gbrain` executable passing the script's minimum-version check of 0.35.1.0.

Passing that minimum does not prove compatibility with every newer CLI. A maintained version of this recipe would need an explicit tested code revision and dataset revision.

## Limits, output and resume behavior

`PHASE1_CELL_WALL_CAP_SECONDS` defaults to 9000. When `timeout` is installed, this limits the answer-generation step's wall time. It does not meter dollars, smoke calls or judge charges. The old “$90 per cell hard cap” description was incorrect.

`SHOOTOUT_RESULTS_DIR` selects the output directory; the default is `results/shootout/`. Phase 1 uses:

```text
longmemeval-{cell}.jsonl
longmemeval-{cell}-scored.json
phase1-run-log.txt
```

Completed scored files are skipped on another invocation. A partial answer file is passed through `--resume-from`. Preserve the file and settings before trying a resumed run; changing settings halfway through would mix experiments. The script resets its run log, so copy a log you need to retain.

If this procedure is deliberately revived and its missing prerequisites are resolved, its entry point remains:

```sh
bash scripts/run-shootout-phase1.sh
```

An interrupted or budget-limited run should be published as partial if retained. Do not delete an inconvenient cell and call the remaining matrix complete.

## What Phase 2 still needs

The missing driver must accept `--cell`, `--embedder`, `--dim`, optional `--reranker` and `--subset`, and `--output`. It should initialize one `HybridNoGraphAdapter` with `AdapterConfig.shootout`, load `world-v1`, and score either the relational questions or the Cat13 embedder subset with the shared metrics.

The wrapper intends to save `brainbench-{cell}-relational.json` and `brainbench-{cell}-cat13.json`. Implementing that driver, updating provider choices and establishing new spending controls is separate work from this documentation revision.

The original publication sequence named branch `garrytan/embedder-shootout`, PR #8, a May 22 report and a possible gbrain v0.35.2.0 release. Those are historical plan references, not current instructions to change branches, merge or publish.
