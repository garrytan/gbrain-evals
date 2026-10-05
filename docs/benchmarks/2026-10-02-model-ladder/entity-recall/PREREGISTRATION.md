# Cat 40 entity-recall wave: preregistration

Committed on 2026-10-04, before the entity-recall wave has a build and before any A3 cell exists. It freezes the
comparator, the decision rules and the commands for the
[entity-recall plan](../../../plans/2026-10-04-cat40-entity-recall/PLAN.md), as amended by Garry's gate decisions
(UC1-UC3, T1-T4). Where the plan and this file differ, this file governs the analysis.

## What is being decided

gbrain is a memory system for agents. Cat 40 asks whether an agent finishes company-knowledge tasks more often with
gbrain than with simpler setups, on a fictional company world with 50 tasks in five families (A authority, B true now,
C permissions, E renewal briefs, F write-back). The held-out world (seed 20261003, 4,036 documents, digest
`df9e4f65cf60`) is used here for the third time for a gbrain decision, after the fix wave and the cost wave. Nobody
opened its tasks to design the entity-recall wave.

Two held-out gbrain builds are compared with the simple setups:

- `a714410a5`, the cost wave's measured build (released as v0.60.44.0), already run on the fixed harness:
  [followups/holdout](../followups/holdout/), label `gbrain-c1234-holdout`.
- The entity-recall wave, run as A3 below, label `gbrain-entity-holdout`.

## Metric

Task success as `eval/runner/cat40/score.ts` decides it (sha256 `8a448051…` at this commit): the submitted value
matches the answer key, briefs need all five fields, and a leak or a protected write fails the cell. The claims judge
never decides success.

Every comparison is paired by task. Each task's success is averaged over repeats, and over models in pooled rows; the
95% CI is a percentile bootstrap over the 50 tasks (10,000 resamples, seed 20261003); the sign test is exact and
two-sided over tasks with a nonzero difference. Both sides must hold every (model, task, repeat) cell exactly once,
or `holdout_stats.py` refuses the comparison.

## The comparator

The comparator is the best pooled success among `fs` (Markdown files with grep), `memory` (the provider's memory tool)
and `pg` (Postgres full-text and vector search), with ties broken by lower cost per task. Under gate UC1 the
candidates are the 2026-10-02 held-out cells, rescored with today's scorer and audited in
[simple-arms-rescored/](simple-arms-rescored/README.md) (2,520 of 2,520 eligible, no score changed).

| Arm | Cells | Pooled success | $/task |
|---|---|---|---|
| fs | 600 | 72.8% | 0.0323 |
| memory | 600 | 63.3% | 0.1380 |
| pg | 600 | 66.0% | 0.0212 |

**The comparator is `fs`.** `oracle` (handed the evidence) and `fs-acl` (permission tasks only) are reported beside
the headline but are never comparators.

The comparator cells come from gbrain-evals `462e31f3` (old JSON ledger, explicit `--max-tool-chars 100000000`) on
2026-10-02, while both gbrain builds run on the fixed harness. The audit explains why neither difference moves these
arms' scores; provider drift between the dates is a disclosed confound, so the comparison is not contemporaneous.

## Pairs and the headline build

| Pair | Purpose |
|---|---|
| `gbrain-entity-holdout` − `fs` | The headline if the wave's gbrain PR merges |
| `gbrain-c1234-holdout` − `fs` | The headline otherwise; published now as the corrected headline (gate UC2) |
| `gbrain-entity-holdout` − `gbrain-c1234-holdout` | Ship rule and default-on decision, same harness |

The headline is reported pooled and per model, with the per-family breakdown, and the build is compared with every
other simple arm for context (`fs-acl` on family C only). The headline sentence is chosen by the pooled CI and filled
in by `holdout_stats.py --headline` exactly as written here, with the build named as `a714410a5` (v0.60.44.0) or as
"with the entity-recall wave":

- **Win (CI above 0):** "On the held-out world, agents using gbrain {build} finish {d} points more tasks than agents
  using plain Markdown files with grep, the best simple setup (95% CI {lo} to {hi})."
- **Tie (CI spans 0):** "On the held-out world, agents using gbrain {build} finish about as many tasks as agents using
  plain Markdown files with grep, the best simple setup: the difference is {d} points (95% CI {lo} to {hi})."
- **Loss (CI below 0):** "On the held-out world, agents using gbrain {build} finish {d} points fewer tasks than agents
  using plain Markdown files with grep, the best simple setup (95% CI {lo} to {hi})."

The headline is published whichever way it goes.

## Decision rules

**Ship rule (wave against `a714410a5`, held-out).** The wave passes when all hold:
- the pooled paired 95% CI lower bound is −5 points or better (the −3-point result is reported beside it)
- no new leaks: no (model, task, repeat, leak kind) cell has `output_leak`, `context_exposure` or `unsafe_write`
  under the wave without having it under `a714410a5`, whatever the totals
- models and families at −8 points or worse are flagged in the report (not gated)

**Default-on (gate T3).** The wave ships default-on when the ship rule passes, the held-out family-E paired difference
against `a714410a5` is above 0 as a point estimate, and cost per task (agent plus gbrain-internal dollars, judge
excluded) rises at most 25%. The point estimate, not the CI lower bound, is the frozen reading of "above 0". If the
ship rule fails, the headline is still published, the gbrain PR does not merge, and Garry decides between reworking
and a disable switch.

**G1 (development world).** Family E reaches at least 15 of 30 cells on development round 2 (GPT-5.4-mini, GPT-5.4,
Sonnet 4.6; one repeat) and scores above the master `739e5cc89` control round's family E, with the paired family-E
gain and its CI reported, with no family regressing beyond the harm screen and no new leaks. Dev2 (`ea851b39b`)
scored 4 of 30. G1 is a reported target: a round 2 that misses it but passes the harm screen still goes to the
held-out stage, and the report states the miss.

**Development harm screen (gate T2).** A round passes when its pooled paired success difference against the master
control is better than −5 points. It gates on success only. Families at −10 points or worse are flagged, not gated;
cost per task and per successful task are reported. Round 1 failing: fix the cause, rerun once, stop for Garry if it
fails again. Round 2 failing: drop B5, rerun once, stop for Garry if it fails again.

**Keyword-only round (gate UC3).** The master round with `search.mcp_keyword_only=true` runs beside the master control
before B1-B4 are built. If it reaches 15 of 30 on family E without failing the harm screen, the plan goes back to
Garry; otherwise Item B proceeds.

**Noise to keep in mind.** On 150 development cells the harm screen's standard error is about 4 to 5 points, so it
catches only large harms. Providers may have changed model behavior since `a714410a5` ran on 2026-10-04 and since the
simple arms ran on 2026-10-02.

## Amendment 1 (2026-10-04, before any A3 cell and before round 1): model set

Garry's rule (also in `CLAUDE.md`, "Choose models"): run the newest frontier Opus, GPT, Sonnet and Fable models; drop
older generations except one link to the previous eval; never run gpt-5.4-mini. The model set for every remaining run
in this wave is **Claude Sonnet 5.5, Claude Opus 5.5, Claude Fable 5.1, GPT-6.1 Sol and GPT-6 Astra**. Sonnet 5.5 and
GPT-6.1 Sol are also in the 2026-10-02 simple-arm cells and the `a714410a5` held-out cells, so they are the link to
the earlier results.

- **Keyword-only round (UC3), already run** on the earlier development models (GPT-5.4-mini, GPT-5.4, Sonnet 4.6)
  beside a master control on the same models: family E 5 of 30 against 2 of 30, below the 15-of-30 bar, and
  families A (−26.7) and C (−23.3) fall. Item B proceeds.
- **Development rounds.** The master `739e5cc89` control, round 1 and round 2 run on the five models above, one
  repeat. The harm screen, its failure actions and the cost reporting are unchanged.
- **G1** becomes: family E on round 2 scores above the master control's family E on the same five models (paired
  gain and CI reported), with no family beyond the harm screen and no new leaks. The 15-of-30 bar was set on the
  older models and does not carry over.
- **A3** runs the five models (2 repeats), with the argv otherwise unchanged.
- **Controls for the new models (Opus 5.5, Fable 5.1, GPT-6 Astra)** run on the held-out world before A3, with the
  same argv as their counterparts:
  - the simple arms oracle, fs, fs-acl and pg
  - gbrain `a714410a5`

  The comparator stays fs, as preregistered. Memory, the weakest simple arm on 2026-10-02 (63.3% pooled), is not
  run for the new models and is reported for Sonnet 5.5 and GPT-6.1 Sol only.
- **The ship rule and T3** are evaluated on all five models against `a714410a5`, pooled and per model.
- **Ceiling note.** GPT-6.1 Sol scored 100% on every arm on 2026-10-02 and 2026-10-04. A model at ceiling on both
  sides is reported as uninformative, not as a tie.

## A3: the exact commands

A3 copies the [followups/holdout](../followups/holdout/) receipt's argv. Only `--gbrain-ref`, `--gbrain-label`,
`--out`, `--budget-usd` and the wave-built slots change, and `--program-cap-usd` is dropped so the run adopts the
ledger's recorded cap. At launch, `<wave>` is the wave's gbrain commit and `<dollars>` is what remains on the
follow-up ledger; nothing else is filled in.

Slots, built by the wave itself (the build runs `gbrain extract --stale --catch-up` and records mention coverage
beside each snapshot):

```
bun eval/runner/cat40-model-ladder.ts --build-slots --world eval/reports/cat40/holdout/world.json --no-pglite-analyze \
  --gbrain-repo ../gbrain --gbrain-ref <wave> --slots 5 --slot-build-allowance-usd 2 --budget-usd 6 \
  --budget-ledger .budget/cat40-followups.sqlite --out eval/reports/cat40/entity-slots-holdout
```

Cells:

```
bun eval/runner/cat40-model-ladder.ts --arms gbrain --surface starter --gbrain-repo ../gbrain \
  --budget-ledger .budget/cat40-followups.sqlite --transcripts --world eval/reports/cat40/holdout/world.json \
  --repeat 2 --no-pglite-analyze --slots 5 --concurrency 10 \
  --models claude-sonnet-5-5,claude-opus-5-5,claude-fable-5-1,gpt-6.1-sol,gpt-6-astra \
  --gbrain-ref <wave> --gbrain-label gbrain-entity-holdout --budget-usd <dollars> --out eval/reports/cat40/entity-holdout
```

Before launch:
- The runner refuses slots whose recorded mention coverage is not `complete` with 0 pending pages.
- Project A3's cost as $48 × (round 2 cost per task ÷ master control cost per task) + 15%. If the ledger's remaining
  dollars are below that, stop for Garry instead of launching.
- `score.ts` must still hash to `8a448051…`. If it changed, rerun the rescoring command in
  [simple-arms-rescored/](simple-arms-rescored/README.md#reproduce) with the A3 commit and analyze against that output.

The results are copied to `docs/benchmarks/2026-10-02-model-ladder/entity-recall/holdout/` with the receipt.

## Analysis commands

From the repository root, with `D=docs/benchmarks/2026-10-02-model-ladder` and
`S=$D/holdout/holdout_stats.py`:

```
# Comparator (already run; its output is the table above)
python3 $S $D/entity-recall/simple-arms-rescored/results.jsonl --choose-comparator fs,memory,pg

# Corrected headline for a714410a5 (published now, gate UC2)
python3 $S $D/entity-recall/simple-arms-rescored/results.jsonl $D/followups/holdout/results.jsonl \
  --choose-comparator fs,memory,pg --headline gbrain-c1234-holdout,fs

# After A3: ship rule and default-on (T3), wave against a714410a5
python3 $S $D/followups/holdout/results.jsonl $D/entity-recall/holdout/results.jsonl \
  --default-on gbrain-entity-holdout,gbrain-c1234-holdout

# After A3: the headline for the wave
python3 $S $D/entity-recall/simple-arms-rescored/results.jsonl $D/entity-recall/holdout/results.jsonl \
  --headline gbrain-entity-holdout,fs

# Development rounds (gate T2 screen; family-E counts for G1 are in the "Success by family" table)
python3 $S <master-control>/results.jsonl <round>/results.jsonl --capability-screen <round-label>,<master-control-label>
```

`--default-on` prints the ship rule first, including the per-cell leak list. A command exits 1 when a comparison is
refused for coverage or a rule fails.
