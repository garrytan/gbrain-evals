# Cat 40 Model Ladder: uncapped baseline run (2026-10-02)

Raw output from the first full Cat 40 ladder with tool results uncapped (`--max-tool-chars 100000000`). No tool result was truncated; the largest single tool result was 182,859 characters. This folder holds the measurements only. The write-up belongs in the Cat 40 report.

<a id="correction-2026-10-09"></a>

> **Correction, 2026-10-09: the gbrain arm reranked in only part of this run.** Each restored slot brain kept the slot build's metering-proxy port in its Voyage URL, and that port was closed when the cells ran, so every rerank request failed and gbrain quietly returned unreranked results (fixed in gbrain-evals #76, commit `7709a70`, and #109). 362 of the 1,456 gbrain cells' metered calls include a rerank request: repeat 0's families A to C and 33 of its 110 family E cells. No family F cell and no cell of repeats 1 and 2 reranked ([audit](../../2026-10-08-program-primary-hard/root-cause/restore-audit.json)). The gbrain arm therefore mixes two conditions, and its gaps to the other arms, which have no reranker, mostly measure gbrain without its reranker. See the [Cat 40 report correction](../../2026-10-02-model-ladder.md#correction-2026-10-09).

## What finished

The run stopped at its $800 budget with 7,624 of 8,580 planned cells recorded.

| Repeat | Families complete | Missing |
|---|---|---|
| 0 | A, B, C, E, F | none |
| 1 | A, B, C, E, F | none |
| 2 | A, B, C | E: 406 of 550 cells (tasks E03 to E10 partly or wholly missing), F: all 550 cells |

Every task has at least two repeats for every model and arm. `analyze.ts` averages success over the repeats of each (model, arm, task), so the partial third repeat gives some E tasks a third sample and leaves the rest at two. `analysis-repeats-0-1.md` repeats the analysis on repeats 0 and 1 only, where every cell is balanced. Every model and arm success rate is within 7 points of `analysis.md`, and the pooled gbrain advantage is the same (-8 points).

No recorded cell has an agent-loop error (`run.stop == "error"`). Non-submitted cells are turn-cap or no-tool-call endings, which the scorer counts as failures.

## Command

From the repository root, with gbrain cloned at `../gbrain`:

```
bun eval/runner/cat40-model-ladder.ts --models claude-haiku-4-5,claude-sonnet-4-6,claude-sonnet-5,claude-sonnet-5-5,claude-opus-5-5,gpt-5.4-mini,gpt-5.4,gpt-5.5,gpt-6-sol,gpt-6.1-sol,gpt-6-astra --arms oracle,fs,fs-acl,memory,pg,gbrain --repeat 3 --max-tool-chars 100000000 --slots 5 --gbrain-repo ../gbrain --gbrain-ref ad7900d --budget-usd 800 --program-cap-usd 2000 --concurrency 10 --out eval/reports/cat40/ladder-uncapped
bun eval/runner/cat40/analyze.ts eval/reports/cat40/ladder-uncapped/results.jsonl --md eval/reports/cat40/ladder-uncapped/analysis.md --json eval/reports/cat40/ladder-uncapped/analysis.json
```

gbrain under test: `ad7900d8dcd2` (0.60.27.0), surface `starter`, 5 slots. Judge: `gpt-5.4-mini`. Bun 1.4.2.

## Run segments

The run went through three segments that all wrote to the same `--out`. A rerun resumes and skips cells already in `results.jsonl`.

1. **Started 18:19 UTC at `ed2c423`, budget $800.** Built the five gbrain slots (about 26 minutes, $0.096 each). It recorded 1,930 cells, and then the OpenAI account ran out of credits at 19:48 UTC. I stopped this segment by hand, so it wrote no receipt. Its spend is in `ledger-summary.json` and its build lines are in `run.log`.
2. **Resumed 20:13 UTC at `fcc510d`, budget $634.** That is $800 minus segment 1. It recorded cells up to 5,467. I stopped it by hand to load the budget fix below, so it also wrote no receipt.
3. **Resumed 23:19 UTC at `9d5eefe`, budget $165.** That is $800 minus everything committed so far. It recorded cells up to 7,624, then stopped itself at the budget and wrote `receipt-1790989124257.json`.

Harness fixes made during the run, each with a test:

- `65e4ec7`: the scorer crashed when a model sent `submit_answer.sources` as a string. That dropped one paid cell (`claude-sonnet-4-6|memory|C09|0`), which was rerun later.
- `fcc510d`: a failed claims judge now records the cell with `claims: null` and `judge_error`, instead of discarding a paid agent run. No recorded cell has a `judge_error`.
- `9d5eefe`: a budget refusal now stops the run. Before this fix, the agent loop recorded refusals as ordinary `stop: "error"` cells, so reaching the cap would have filled `results.jsonl` with fake model errors.

None of these fixes changes the score of any cell that scored successfully before it.

Cells that were attempted but not recorded, all rerun later or still pending: 16 judge failures during the credit outage, 1 scorer crash, and 5 cells refused at the final budget stop.

## Spend

The ledger committed $798.34 in total (`ledger-summary.json`):

- three run segments: $165.19, $469.32 and $163.76;
- two verification checks: $0.08;
- $2.32 of reservations left open by the two manual stops, charged at their worst case.

Recorded cells account for $777.00. The rest is cells lost in flight, slot builds, pg embeddings and the checks.

## Files

- `results.jsonl`: one line per cell (17 MB, not gzipped).
- `receipt-1790989124257.json`: receipt from segment 3.
- `run.log`: the full run log across all segments.
- `analysis.md`, `analysis.json`: analysis of all 7,624 cells.
- `analysis-repeats-0-1.md`, `analysis-repeats-0-1.json`: balanced analysis of 5,720 cells.
- `ledger-summary.json`: per-segment spend from the local budget ledger.

## Changelog

- 2026-10-09: [Correction](#correction-2026-10-09) added: 362 of 1,456 gbrain cells reranked (stale metering-proxy port in restored slots; fixed in gbrain-evals #76 and #109). Original numbers unchanged.
