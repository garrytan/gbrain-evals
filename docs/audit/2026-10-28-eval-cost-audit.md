# Eval cost audit, October 14 to 28, 2026

## The finding

Paid evaluation spent about $10,400 on model APIs in these two weeks. Two programs account for 94% of it: the Q1 head-to-head scoreboard ($7,034 settled) and the Cat 40 next-wave confirmation ($2,863). Every other run, from a preregistered default flip to small smoke tests, cost about $520 together. The keyless CI tiers cost nothing in model spend.

Inside the Cat 40 confirmation, the files-only (fs) comparison arm was the largest line: 48% of the public worlds' cell spend, $582 of $1,214. Two changes cut that kind of cost without changing what a confirmation can decide, and both now have tools ([eval/CONTRIBUTING.md](../../eval/CONTRIBUTING.md#cut-the-cost-of-a-preregistered-run)):

- **Reuse arms that don't load gbrain.** The fs and oracle arms never call gbrain, so a confirmation of a new gbrain build on worlds that already ran them needs only the gbrain arms. For a re-confirmation of the shipping build on the four October worlds, run from the runner commit those arms ran at, that is about $650 instead of about $2,860. That figure is a projection: the public arms pass the check below, and the sealed worlds' arms would be checked the same way inside custody.
- **Size each arm by simulation before preregistering it.** On the public cells, running fs on half the tasks kept the primary verdict ("ahead") in 20 of 20 seeded draws and would have saved $291 on the public worlds. On a third of the tasks it still held in 20 of 20.

Both apply only to preregistrations written after 2026-10-28. Each such preregistration declares the arms it reuses and the simulation behind its sample sizes before any cell runs.

## Where the money went

| Program | Model spend | What it decided |
|---|---:|---|
| Q1 head-to-head scoreboard | $7,034 settled ($6,729 measured; measured October 9 to 27) | A published comparison. On BEAM-10M only differences of about 13.6 points are detectable, so no row is ranked. |
| Cat 40 next-wave confirmation, public and sealed worlds | $2,863 ($1,317 + $1,546) | The wave ships without F5; the wave's wrong-value reduction did not hold on the sealed worlds. |
| 8k answer-conversion wave | $157 | Turn the facts block on by default. |
| External ideas waves A, B and A2 | $138 | Verdicts on rank labels, relative dates and tail trim; already on batch APIs at half price. |
| Proactive brief development rounds 1 and 2 | $57 | Development only. |
| Brain-first install block A/B | $53 | The install block wording; $23 of it was rows superseded by a default change. |
| Spring-loaded skills A/B | $41 | Skill loading design. |
| Multi-source scope and starter tool list | $32 | Scope defaults; $9.80 is a reservation the ledger could not reconcile. |
| Take grading | $12 | The model gbrain uses to grade takes. |
| Smaller runs (brief smoke, setup runs, expansion latency, structure-aware chunks and others) | about $35 | Smoke and gate checks. |

Sources: each program's committed ledger summary or report. The scoreboard's split by date is in its sealed ledgers.

### Inside one Cat 40 confirmation

Per-cell costs from the public worlds' `results.jsonl` (600 cells per arm, three models):

| Arm | Opus 5.5 | Sonnet 5.5 | GPT-6.1 Sol | Total | Share |
|---|---:|---:|---:|---:|---:|
| fs (files only) | $361.37 | $182.04 | $38.93 | $582.34 | 48% |
| baseline gbrain | $156.20 | $98.12 | $54.51 | $308.84 | 25% |
| wave gbrain | $144.35 | $81.42 | $48.71 | $274.48 | 23% |
| oracle | $26.22 | $14.09 | $8.40 | $48.71 | 4% |

Totals are each cell's agent, embedding and gbrain provider spend plus the claims judge, which is 3.2% of it; the primary and D3 endpoints are scored from the answers without it. Running the judge only where a verdict needs it would save under $40 per confirmation. Opus in the fs arm costs $1.81 a cell against $0.72 to $0.78 on the gbrain arms, because a files-only agent reads much more text before it answers.

## Sizing the fs arm: the retrospective

`eval/runner/cat40/arm_power.py` reuses the frozen analysis code (`next_confirm_analysis.py`). For each fraction it draws a seeded random subset of each world's tasks, keeps the fs cells only on that subset, and recomputes the preregistered endpoints with 2,000 resamples per draw.

| fs on | Primary "ahead" kept | Weakest primary lower bound | Saved on the public worlds |
|---|---|---:|---:|
| all 100 tasks per world | (full data: +12.50 pp [+9.00, +16.00]) | | |
| 67% | 20 of 20 | +4.98 pp | $192 |
| 50% | 20 of 20 | +5.00 pp | $291 |
| 33% | 20 of 20 | +2.53 pp | $390 |

D3 compares wave and baseline, so the fs fraction cannot change it and the tool doesn't count it for fs. The table measures how stable the verdict stays on fewer of the same tasks; it is not power against a smaller true effect. This retrospective covers the public worlds only; the sealed cells stay in custody. A smaller effect than this one needs more fs cells, which is why a preregistration runs the simulation on its own development cells rather than borrowing this table.

The same check rules out stopping the wrong-value endpoint early: with the wave arm cut to half the tasks, D3 passed in only 13 of 20 draws ([arm-power-wave-half.json](2026-10-28-eval-cost-audit/arm-power-wave-half.json)). A group-sequential design with a futility stop is still worth preregistering for the gbrain arms, but not an early efficacy stop on D3.

## Reusing an arm: the check

`eval/runner/cat40/reuse-check.ts` compares the `experiment.json` the runner bound to the earlier arm with one from the new experiment. On the October public worlds:

- fs and oracle from world P1 are reusable by the wave build on P1: same world digest, Hard identity, judge, scorer, settings and evaluator code hashes, the same runner commit, finished runs and 100 clean cells per model.
- fs from P1 is refused for P2 (different world digest and identity).
- The baseline gbrain arm is refused for the wave build (different gbrain commit, label and config flags).
- The Hard code hashes leave out files that shape a cell, such as the document renderer, so when the runner commits differ the check compares every file in the runner's import closure at both commits. Between the October runner commit and today's main, 43 of those 71 files changed, so a re-confirmation runs its new arms from the October runner commit or runs every arm again.

## CI

Every eval job in gbrain's own CI is keyless. Tier 2 (LLM Skills) runs on every E2E run but its three tests skip, because the test preload strips provider keys on purpose; the BrainBench gate and the BrainBench CLI test take under two minutes each on the full-profile runs. None of them is on the critical path of the pre-merge full run. In this repository, the `harness` job ran its Python tests and its metering proxy tests in series (about 6 and 2.5 minutes) and was the slowest job, so they now run as two parallel jobs with the same test files.

## What to use and what to avoid

- Use `reuse-check.ts` with `--preregistration` whenever a confirmation re-runs a world with a new gbrain build. Reuse is all of an arm's cells or none, declared before any new result is seen.
- Use `arm_power.py` on development cells before fixing per-arm sample sizes, and copy its output into the preregistration.
- Use batch APIs for single-shot readers and judges when a few hours of latency are acceptable (half price); agent sessions can't be batched.
- Don't stop D3 early for efficacy; don't apply either tool to a preregistration written before 2026-10-28 without an amendment that comes first.

## Reproduce and inspect

From the repository root, keyless, about 30 seconds:

```sh
python3 eval/runner/cat40/arm_power.py \
  --world P1=docs/benchmarks/2026-10-14-cat40-next-confirm-public/p1/wave/results.jsonl,docs/benchmarks/2026-10-14-cat40-next-confirm-public/p1/baseline/results.jsonl,docs/benchmarks/2026-10-14-cat40-next-confirm-public/p1/fs/results.jsonl \
  --world P2=docs/benchmarks/2026-10-14-cat40-next-confirm-public/p2/wave/results.jsonl,docs/benchmarks/2026-10-14-cat40-next-confirm-public/p2/baseline/results.jsonl,docs/benchmarks/2026-10-14-cat40-next-confirm-public/p2/fs/results.jsonl \
  --arm fs --draws 20 --resamples 2000 --json arm-power-fs.json
bun eval/runner/cat40/reuse-check.ts --prior docs/benchmarks/2026-10-14-cat40-next-confirm-public/p1/fs --planned docs/benchmarks/2026-10-14-cat40-next-confirm-public/p1/wave --arm fs
```

Without `--preregistration` the check runs every comparison and refuses only for the missing declaration.

The committed output is [arm-power-fs.json](2026-10-28-eval-cost-audit/arm-power-fs.json). Spend figures come from each program's ledger summary or report, linked from [docs/README.md](../README.md).
