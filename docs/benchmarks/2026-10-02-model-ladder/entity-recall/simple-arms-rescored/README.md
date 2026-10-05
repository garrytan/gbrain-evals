# Cat 40 held-out simple arms, rescored with today's scorer (UC1 audit)

## The finding

All 2,520 held-out simple-arm cells from 2026-10-02 can be reused, and today's scorer gives every one of them the
same score it got then. No cell needs a rerun, no cell needs the paid claims judge again, and no success value,
safety flag or other score field changed. The rescoring cost $0: it reads stored answers and transcripts and calls no
model.

These cells are the plain-file (`fs`), permission-filtered file (`fs-acl`), memory-tool (`memory`), Postgres (`pg`)
and evidence-in-prompt (`oracle`) arms of the [held-out check](../../holdout/README.md): 6 models, 50 tasks, 2 repeats
(`fs-acl` runs the 10 permission tasks only). Garry's gate decision UC1 on the
[entity-recall plan](../../../../plans/2026-10-04-cat40-entity-recall/PLAN.md) reuses them instead of paying about
$128 to run them again, on the condition this audit checks: only success and claims are rescored, the original
safety flags are kept where stored tool results were cut, and any cell whose eligibility cannot be shown is rerun.

The rescored cells pick the comparator for the corrected Cat 40 headline; see
[PREREGISTRATION.md](../PREREGISTRATION.md).

## What was checked

`eval/runner/cat40/rescore.ts` rescored each cell with `eval/runner/cat40/score.ts` as of gbrain-evals `54c7ada`
(file sha256 `8a448051…`, unchanged since `65e4ec7`). A cell counts as eligible only when all of these hold:

| Check | Why it matters | Cells passing |
|---|---|---|
| The regenerated world has the digest the receipts recorded (`df9e4f65cf60…`) | The answer key is the one the agents were scored against | 2,520 |
| Both receipts name one harness commit (`462e31f3`) with a clean tree | The cells come from one known harness | 2,520 |
| No tool result was truncated before the model saw it, and the largest result (121,548 characters) is under the run's `max_tool_chars` of 100,000,000 | Rescoring cannot undo a cap that changed what the agent read | 2,520 |
| The run did not end in a harness error | An error is a harness failure, not an agent outcome | 2,520 |
| Exactly one transcript line exists for the cell, and its tool calls match the record by session, count and name | The write arguments that decide `unsafe_write` are complete | 2,520 |
| The cell key occurs once in the results | No double counting | 2,520 |

Eligibility by arm:

| Arm | Cells | Eligible | Needs rerun | Success, original | Success, rescored | Cells with a cut tool result |
|---|---|---|---|---|---|---|
| oracle | 600 | 600 | 0 | 588 | 588 | 0 |
| fs | 600 | 600 | 0 | 437 | 437 | 1 |
| fs-acl | 120 | 120 | 0 | 99 | 99 | 0 |
| memory | 600 | 600 | 0 | 380 | 380 | 37 |
| pg | 600 | 600 | 0 | 396 | 396 | 0 |
| **All** | **2,520** | **2,520** | **0** | **1,900** | **1,900** | **38** |

## Differences from the original scores

- **Success:** 0 of 2,520 cells changed. Success is recomputed from the stored submitted answer, the final text and the
  write calls, all of which the record or transcript keeps whole.
- **Every other score field** (`said_wrong`, field verdicts for briefs, `evidence_cited`, `missed_evidence`, `wrote`,
  `over_refusal`) is identical in all 2,520 cells.
- **Claims:** today's judge prompt differs from the 2026-10-02 prompt only in how cited sources are read
  (`submittedSources` accepts a string as well as a list). For every stored cell the old and new readings select the
  same documents, so the judge would see the same prompt and the stored verdicts stand: 2,435 cells keep their claims.
  The other 85 cells (84 that hit the 16-turn cap and 1 that stopped without a tool call) submitted nothing, so there
  was nothing to judge then or now. No paid judge call is needed.
- **Safety flags** (`output_leak`, `context_exposure`, `unsafe_write`) keep their original values in every cell, as
  the gate requires. Today's recomputation is recorded beside them in each cell's `rescore.recomputed_safety` and
  agrees with the original in all 2,520 cells.

### Tool results cut at 40,000 characters

Saved transcripts keep the first 40,000 characters of each tool result, while the agent saw the whole result. A
leak detected in the tail of a long result could therefore disappear on recomputation. 66 results in 38 cells were
longer than that: 25 `memory` cells in family E (renewal briefs), 12 `memory` cells in family B and 1 `fs` cell in
family F. None is a permission task (family C), and none had an original `context_exposure` or `output_leak` flag. Their
original flags are kept.

## Harness differences from today

The cells come from gbrain-evals `462e31f3` (2026-10-02). The corrected headline compares them with gbrain
`a714410a5`, measured on 2026-10-04 by `12d7016`. Three things differ.

1. **The old budget ledger.** The JSON ledger stalled the runner's event loop on every paid request. That broke
   gbrain's embedding requests, which travel through the runner's metering proxy (see the correction at the top of
   [the Cat 40 report](../../../2026-10-02-model-ladder.md)). The `fs`, `fs-acl`, `memory` and `oracle` arms send no
   requests through that proxy. The `pg` arm embeds its queries inside the runner and waits for the answer rather than
   falling back, so its searches were slower but returned the same results. Wall-clock times in these cells are not
   comparable with fixed-harness runs; success, safety and dollar cost are.
2. **An explicit tool-result cap flag.** In `462e31f3` the default per-result cap was 20,000 characters, so these runs
   passed `--max-tool-chars 100000000`. Today results are uncapped by default and the flag is not needed. No result in
   these cells came near the explicit limit (the largest was 121,548 characters, and no call is marked `truncated`), so
   the agents saw what an uncapped run shows.
3. **Two days between runs.** The simple arms ran on 2026-10-02 and `a714410a5` on 2026-10-04, against the same
   provider model names. Provider-side drift over those two days cannot be ruled out, so the headline comparison is not
   contemporaneous.

## Files

- `results.jsonl`: the 2,520 rescored cells in the runner's record format, with a `rescore` object per cell
  (`eligible`, `needs_rerun`, `cut_results`, `recomputed_safety`, `success_original`, `success_changed`, `claims`).
  `holdout_stats.py` reads it directly.
- `audit.json`: the counts above, the scorer commit and hash, the source files and receipts, and the (empty) lists of
  cells needing a rerun, a judge call, a success change or a safety disagreement.

## Reproduce

From the repository root ($0, about 20 seconds):

```
bun eval/generators/model-ladder-gen.ts --seed 20261003 --out eval/reports/cat40/holdout
H=docs/benchmarks/2026-10-02-model-ladder/holdout
bun eval/runner/cat40/rescore.ts --world eval/reports/cat40/holdout/world.json \
  --results $H/results.jsonl --transcripts $H/transcripts.jsonl.gz \
  --receipt $H/receipt-1790985283350.json,$H/receipt-1790985351802.json \
  --arms oracle,fs,fs-acl,memory,pg --out docs/benchmarks/2026-10-02-model-ladder/entity-recall/simple-arms-rescored
```

The world file is not committed; the generator rebuilds it from the seed with digest
`df9e4f65cf603430934d6afa30073a44813ea670f78ae83c68bbde8210d1db9b`. A rerun at a later commit writes that commit into
`audit.json` and leaves every other field unchanged as long as `score.ts` is unchanged.
