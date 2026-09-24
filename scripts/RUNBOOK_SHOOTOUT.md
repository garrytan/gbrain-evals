# Embedder comparison: current cells and historical limits

This is the operator record for Sessions 4–5 of the May 2026 embedder plan, `docs/designs/2026_05_EVAL_PLAN.md` in the gbrain repository. The scripts now use supported providers, but Phase 1 remains incomplete as an end-to-end reranker comparison. Updating a model does not produce a new benchmark result.

For current retrieval comparisons, start with the [September ranking report](../docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md), the [retrieval refresh](../docs/benchmarks/2026-09-09-retrieval-refresh.md), or the [evaluation runbook](../eval/RUNBOOK.md). Do not launch this historical matrix to reproduce their results.

## What the original matrix asked

An embedder turns text into vectors. A reranker then reads a short candidate list and changes its order. The plan varied those components to see which combinations helped on conversation retrieval and the fictional BrainBench corpus.

| Cells | Embedder and dimensions | Reranker |
|---|---|---|
| A0 / A1 | `openai:text-embedding-3-large`, 1536 | Off / retired reranker |
| B0 / B1 | `voyage:voyage-4-large`, 2048 | Off / retired reranker |
| C0 / C1 | Retired embedder, 2560 | Off / retired reranker |
| C2 | Retired embedder, 1280 | Retired reranker |

The retired identities in this historical table were redacted on September 23, 2026. The original is in commit `9238ec8456bc94c3c082db105d7d8169a10a0b0f` at `scripts/RUNBOOK_SHOOTOUT.md`. Dimensions, cell IDs and estimates remain historical; none are attributed to a replacement provider.

The original estimate was approximately $525 and 14 hours in total. Its detailed estimates were $476 / 10.5 hours for Phase 1 and $56 / 3.5 hours for Phase 2. These were planning estimates, not enforced dollar limits or a current provider quote.

## Current supported matrix

| Cells | Embedder and dimensions | Reranker |
|---|---|---|
| A0 / A1-voyage-rerank-2.5 | `openai:text-embedding-3-large`, 1536 | Off / `voyage:rerank-2.5` |
| B0 / B1-voyage-rerank-2.5 | `voyage:voyage-4-large`, 2048 | Off / `voyage:rerank-2.5` |

The new reranked cell IDs prevent the wrappers from resuming old reranker artifacts as if they used the new model. The retired embedder cells are no longer runnable. No paid measurement, cost estimate or quality claim has been made for this replacement matrix.

Cat18b separately uses OpenAI 1536d and `voyage:voyage-3-large` 1024d, each without reranking or with `voyage:rerank-2.5`. Its new reranked cell names end in `+voyage-rerank-2.5`; the historical `+rerank` results have not been relabeled.

## Why Phase 1 is incomplete

Phase 1 explicitly refuses its two reranked cells. The August 31 audit found that the script's reranker environment variables were not read by the then-current CLI. Running without reranking under a reranked label would have invalidated the comparison. The refusal remains in this wrapper even though newer gbrain experiments expose additional configuration controls. The other cells pass no explicit reranker setting to the CLI, so their behavior still depends on that CLI's resolved defaults. Do not treat them as a controlled reranker-off baseline without verifying those settings.

Both scripts require OpenAI, Anthropic and Voyage keys at startup. Missing keys fail before any cell starts.

Phase 2 uses `eval/runner/shootout-driver.ts`, which runs the existing no-graph hybrid adapter with explicit per-cell embedding and reranker settings.

## What Phase 1 actually does

For each cell, `run-shootout-phase1.sh` checks the provider with a small live smoke test, then generates answers with `gbrain eval longmemeval --mode tokenmax --expansion`. Anthropic Sonnet supplies answers; the external LongMemEval evaluator judges them with OpenAI gpt-4o.

That is an answer-quality experiment, not retrieval recall. A smoke test can itself make paid calls. A refusal after smoke does not mean no provider calls occurred.

The current wrappers require:

- `OPENAI_API_KEY` for OpenAI embeddings and the answer judge.
- `ANTHROPIC_API_KEY` for answer generation.
- `VOYAGE_API_KEY` for Voyage embedding and reranker cells.
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

## Phase 2 behavior

The driver accepts `--cell`, `--embedder`, `--dim`, optional `--reranker` and `--subset`, and `--output`. It initializes one no-graph hybrid adapter with `AdapterConfig.shootout`, loads `world-v1`, and scores either the relational questions or the Cat13 embedder subset with the shared metrics.

The wrapper saves `brainbench-{cell}-relational.json` and `brainbench-{cell}-cat13.json`. A smoke gate runs before either scorer. These are paid calls without a dollar cap; establish an explicit spending budget before running either wrapper. Keyless tests exercise the argument forwarding and failure paths, not model quality.

The original publication sequence named branch `garrytan/embedder-shootout`, PR #8, a May 22 report and a possible gbrain v0.35.2.0 release. Those are historical plan references, not current instructions to change branches, merge or publish.
