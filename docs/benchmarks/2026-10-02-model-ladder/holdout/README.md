# Cat 40 held-out confirmation (2026-10-03)

## The finding

The gbrain fix wave was developed against the Cat 40 dev world (`eval/data/model-ladder-v1`, seed 20261002). This run asks whether those fixes still help on a world nobody looked at while writing them. The held-out world uses seed 20261003. Its tasks were not opened until every run had finished.

They still help. On 50 held-out tasks, 6 models and 2 repeats, the shipped fix-wave build (`gbrain-next`, gbrain 77dcf414) succeeded on 78.8% of cells. The current release (`gbrain-base`, ad7900d) succeeded on 62.2%. Averaged per task, the paired difference is +16.7 points (95% bootstrap CI +9.7 to +23.8). 29 tasks improved, 10 got worse and 11 tied, with an exact sign-test p of 0.003.

The gains are largest in families E (+27.5 pp) and F (+23.3 pp), where all 10 tasks improved in each family. Family B shows no change. In family C, which tests restricted documents, `gbrain-next` leaked 0 restricted strings across 120 answers and never exposed one in a tool result. `gbrain-base` leaked in 29/120 answers and exposed restricted text in 58/120.

Against plain file search (`fs`), `gbrain-next` scores 6.0 points higher on the paired comparison (CI -0.2 to +12.3, sign-test p 0.42). That is a small, inconclusive lead. `gbrain-base` scored 10.7 points below `fs` (CI -18.2 to -3.5). The fix wave therefore moves gbrain from clearly behind file search to level with it or slightly ahead.

The cost is speed. `gbrain-next` cells took 184 s at the median and 384 s at p95. `gbrain-base` took 71 s and 223 s, and `fs` took 12 s and 39 s. See "What looked broken" below.

## The arms

- `oracle`: the task's evidence is handed to the model, with no retrieval. It measures how capable the model is.
- `fs`: grep and file reading over the Markdown corpus.
- `fs-acl`: `fs` with access control, run on family C only.
- `pg`: Postgres with pgvector hybrid search over the same documents.
- `memory`: the provider's native memory tool.
- `gbrain-base`: gbrain ad7900d (0.60.27.0), the current release. Its slots were built with the harness's operator ANALYZE, which is the default.
- `gbrain-next`: gbrain 77dcf414 (0.60.35.0), the head of `cat40-knowledge-layer-wave` and the build being shipped. Its slots were built with `--no-pglite-analyze`, so the product's own statistics handling is what gets measured.
- `gbrain-next-51a30c1`: gbrain 51a30c1, an earlier commit on the same branch, also built with `--no-pglite-analyze`. It was run as `gbrain-next` and then relabeled when the target moved to 77dcf414. 77dcf414 is 51a30c1 plus a merge of gbrain master, pretty-printed JSON tool results and fail-closed type lookups. The two commits score the same: the paired difference is -1.0 pp, with a CI of -3.7 to +1.8.

## Results

The full tables are in `holdout-stats.md`. The harness's own analysis is in `analysis-next.md` and `analysis-base.md`, written by `eval/runner/cat40/analyze.ts` with `--subject`.

Success by family, across all models and both repeats:

| Family | fs | pg | memory | gbrain-base | gbrain-next | oracle |
|---|---|---|---|---|---|---|
| A | 85.0% | 77.5% | 83.3% | 79.2% | 90.8% | 100.0% |
| B | 73.3% | 63.3% | 51.7% | 78.3% | 78.3% | 98.3% |
| C | 91.7% | 90.0% | 92.5% | 75.0% | 95.8% | 100.0% |
| E | 40.8% | 33.3% | 10.0% | 25.0% | 52.5% | 93.3% |
| F | 73.3% | 65.8% | 79.2% | 53.3% | 76.7% | 98.3% |
| all | 72.8% | 66.0% | 63.3% | 62.2% | 78.8% | 98.0% |

Success by model:

| Model | fs | pg | memory | gbrain-base | gbrain-next | oracle |
|---|---|---|---|---|---|---|
| claude-haiku-4-5 | 55.0% | 58.0% | 52.0% | 58.0% | 65.0% | 100.0% |
| claude-sonnet-4-6 | 62.0% | 60.0% | 62.0% | 55.0% | 84.0% | 97.0% |
| claude-sonnet-5-5 | 91.0% | 77.0% | 76.0% | 81.0% | 97.0% | 96.0% |
| gpt-5.4-mini | 62.0% | 52.0% | 54.0% | 43.0% | 57.0% | 95.0% |
| gpt-5.4 | 67.0% | 54.0% | 50.0% | 50.0% | 70.0% | 100.0% |
| gpt-6.1-sol | 100.0% | 95.0% | 86.0% | 86.0% | 100.0% | 100.0% |

Paired per-task differences are computed as follows. Each task's success is first averaged over repeats, and over models in the pooled rows. The 95% CI is a percentile bootstrap over the 50 tasks, with 10,000 resamples and seed 20261003.

| Comparison | mean diff | 95% CI | better/worse/tied | sign-test p |
|---|---|---|---|---|
| gbrain-next minus gbrain-base | +16.7 pp | [+9.7, +23.8] | 29/10/11 | 0.003 |
| gbrain-next minus fs | +6.0 pp | [-0.2, +12.3] | 22/16/12 | 0.42 |
| gbrain-base minus fs | -10.7 pp | [-18.2, -3.5] | 11/22/17 | 0.08 |
| gbrain-next-51a30c1 minus gbrain-base | +17.7 pp | [+11.2, +24.7] | 30/8/12 | 0.0005 |
| gbrain-next minus gbrain-next-51a30c1 | -1.0 pp | [-3.7, +1.8] | 13/19/18 | 0.38 |

Per model, `gbrain-next` beats `gbrain-base` for every model. The bootstrap CI excludes zero for every model except claude-haiku-4-5, whose difference is +7 pp with a CI of -2 to +17. Against `fs`, claude-sonnet-4-6 gains 22 pp (CI 8 to 36) and claude-sonnet-5-5 gains 6 pp (CI 1 to 12). gpt-5.4-mini is 5 pp lower, with a CI of -17 to +7. gpt-6.1-sol is at 100% on both.

On the dev world, the fix-wave run (`../fix-wave-ladder/`) measured a pooled advantage over the best baseline of +7 points (CI 3 to 9). That run used 11 models, 1 repeat, 51a30c1 and the operator ANALYZE. Here the same statistic for `gbrain-next` is +5 points (CI 0 to 10). Because the model set, repeats and ANALYZE setting differ, this is context rather than a matched comparison.

## What looked broken

- **gbrain-next is about 2.5 times slower per cell than gbrain-base.** Median search time rose from 6.2 s to 16.6 s, and median `get_page` time rose from 1.4 s to 4.9 s. Base slots got the operator ANALYZE and next slots did not, so this run cannot separate the code change from missing planner statistics. A `gbrain-next` run with the operator ANALYZE would settle it.
- **`remember` returns a pending write.** In `gbrain-next`, 89 of about 123 `remember` calls returned `unavailable` / `write_pending` ("The write is accepted and awaiting completion; it is not committed") after about 5 s. All of them came in the first session of family F tasks. 52 of the 68 affected cells still succeeded. `gbrain-next-51a30c1` showed 38 of these errors, and `gbrain-base` showed none.
- **Harness scorer crash.** Two `fs` cells (claude-sonnet-4-6, C06 and F04, repeat 0) crashed the scorer with `(f?.sources ?? []).map is not a function` because the model sent `sources` as a non-array. The resumed run redrew them, and both succeeded. The upstream harness now fixes this in `submittedSources`.
- **Bun exit code.** Bun 1.4.2 exited with code 99 after writing the receipt on the two non-gbrain invocations. The results were complete.
- **Ambiguous family table.** The family table in `analyze.ts` abbreviates arms by their first letter, so `gbrain-base`, `gbrain-next` and `gbrain-next-51a30c1` all print as `g:`. Use `holdout-stats.md` for per-family numbers.

## Run log and provenance

- Harness: gbrain-evals 462e31f (`feat/cat40-model-ladder` at run time), with `evals_dirty: false` in every receipt. The analysis was run with the same `analyze.ts`.
- World: `bun eval/generators/model-ladder-gen.ts --seed 20261003 --out eval/reports/cat40/holdout`. This produced 4036 docs and 50 tasks, 10 in each of families A, B, C, E and F, with digest `df9e4f65cf603430934d6afa30073a44813ea670f78ae83c68bbde8210d1db9b`. The world file is not committed because it regenerates from the seed.
- Judge: gpt-5.4-mini. Tool results were uncapped (`--max-tool-chars 100000000`). The runs used 10 concurrent workers, 5 gbrain slots and the `starter` surface.
- The runs, in order, all with `--out eval/reports/cat40/holdout-run`:
  1. Arms `oracle,fs,fs-acl,memory,pg` with `--budget-usd 150`. All 2520 cells cost $127.77 (`receipt-1790985283350.json`). A resume reran the 2 crashed cells for $0.08 (`receipt-1790985351802.json`).
  2. `gbrain-base` on ad7900d with `--budget-usd 100`. All 600 cells cost $60.79 (`receipt-1790994812057.json`).
  3. Run as `gbrain-next` on 51a30c1 with `--no-pglite-analyze` and `--budget-usd 100`. A 4-hour operation timeout killed it at 599/600 before it wrote a receipt; its ledger run `cat40-model-ladder-2026-10-03T02-34-12-025Z-4a86bca3` cost $67.45. A resume ran the last cell for $0.06 (`receipt-1791009465920.json`). The arm was then relabeled `gbrain-next-51a30c1` in `results.jsonl` and `transcripts.jsonl`. Only the `arm` field and the label inside `key` changed.
  4. `gbrain-next` on 77dcf414 with `--no-pglite-analyze` and `--budget-usd 100`. All 600 cells cost $79.94 (`receipt-1791025297535.json`).
- Total spend from the budget ledger was $336.08, including slot-build embeddings. No run reached its budget, and no provider returned `insufficient_quota`.
- Each gbrain slot took about 39 minutes to build on a 4-vCPU machine.

To reproduce the statistics, run from the repository root: `python3 docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py docs/benchmarks/2026-10-02-model-ladder/holdout/results.jsonl`.
