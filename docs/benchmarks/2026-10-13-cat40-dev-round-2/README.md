# Cat 40 next wave: development round 2 (World M, in-sample), and rounds 1+2 pooled

Round 2 of `docs/plans/2026-10-11-cat40-next-wave/PLAN.md` ("Development and confirmation"): the three full-family
arms repeated (control, all-on, f5), all-on kept full-family because round 1 did not trigger the stop rule. Same
build (`a798de1f966dcce401546170b9c1882b1fb56904`), harness, world, models, judge, flags and the same 20 slots as
round 1 (`../2026-10-13-cat40-dev-round-1/`, which documents the setup, the arm configs and the slots' `pages`
statistics); only the labels (`gbrain-dev-r2-*`) and the freeze-drift note's round number differ. M results are
in-sample and diagnostic. Round 1's per-item arms (f1, f1-no-names-row, f2, f4) stay single-round, as planned.

## Round 2 results

Canonical cells (last harness-clean attempt per model and task). control had 1 harness error (an MCP call with no
response in 300 s), retried clean; all-on and f5 had none. Intervals: arm minus control on the same cells, percentile
bootstrap over tasks, 4,000 resamples.

| Arm | Success | d ctrl pp [95%] | Wrong value | Not submitted | H4 `+long` | fs #93, same cells | d fs pp [95%] | Agent + judge USD |
|---|---|---|---|---|---|---|---|---|
| control | 237/300 | | 21 | 32 | 39/48 | 213/300 | +8.0 [+3.0, +13.0] | 156.23 |
| all-on | 249/300 | +4.0 [+0.3, +8.0] | 9 | 33 | 48/48 | 213/300 | +12.0 [+8.3, +16.0] | 129.17 |
| f5 | 236/300 | -0.3 [-3.7, +3.0] | 19 | 37 | 37/48 | 213/300 | +7.7 [+2.7, +12.7] | 148.98 |

| Arm | Opus 5.5 | Sonnet 5.5 | GPT-6.1 Sol | H1 | H2 | H3 | H4 | H5 |
|---|---|---|---|---|---|---|---|---|
| control | 80, w6 | 69, w15 | 88, w0 | 19, w0 | 52, w8 | 56, w3 | 50, w10 | 60, w0 |
| all-on | 87, w0 | 77, w6 | 85, w3 | 18, w0 | 53, w7 | 59, w1 | 60, w0 | 59, w1 |
| f5 | 79, w3 | 68, w16 | 89, w0 | 20, w0 | 49, w9 | 58, w0 | 49, w10 | 60, w0 |

(successes out of 100 per model and 60 per family; `w` = wrong-value cells.)

## Rounds 1+2 pooled (full arms)

`pooled_r12.py` → `pooled-r12.json`. Cells pair by round, model and task; the bootstrap resamples tasks, so all six
cells of a task (2 rounds × 3 models) move together (task-clustered), 4,000 resamples.

Success, arm minus control, pp [95%]:

| Slice | n | all-on vs control | f5 vs control |
|---|---|---|---|
| All | 600 | 504 vs 475, **+4.8 [+1.8, +7.8]** | 479 vs 475, +0.7 [-1.3, +2.8] |
| Opus 5.5 | 200 | 172 vs 164, +4.0 [+0.5, +7.5] | 157 vs 164, -3.5 [-8.0, +1.0] |
| Sonnet 5.5 | 200 | 159 vs 134, +12.5 [+6.0, +19.0] | 143 vs 134, +4.5 [-0.5, +10.0] |
| GPT-6.1 Sol | 200 | 173 vs 177, -2.0 [-5.5, +1.0] | 179 vs 177, +1.0 [0.0, +2.5] |
| H1 | 120 | 41 vs 39, +1.7 [-3.3, +7.5] | 40 vs 39, +0.8 [-2.5, +4.2] |
| H2 | 120 | 108 vs 101, +5.8 [-2.5, +14.2] | 104 vs 101, +2.5 [-3.3, +8.3] |
| H3 | 120 | 116 vs 114, +1.7 [-1.7, +5.0] | 115 vs 114, +0.8 [-4.2, +5.8] |
| H4 | 120 | 120 vs 101, +15.8 [+8.3, +24.2] | 100 vs 101, -0.8 [-6.7, +5.0] |
| H5 | 120 | 119 vs 120, -0.8 [-2.5, 0.0] | 120 vs 120, 0.0 |

Wrong-value cells, arm minus control, pp [95%] (negative is fewer wrong answers):

| Slice | n | all-on vs control | f5 vs control |
|---|---|---|---|
| All | 600 | 15 vs 42, **-4.5 [-7.3, -1.7]** | 34 vs 42, -1.3 [-3.2, +0.3] |
| Opus 5.5 | 200 | 0 vs 9, -4.5 [-7.5, -2.0] | 7 vs 9, -1.0 [-4.0, +1.5] |
| Sonnet 5.5 | 200 | 11 vs 32, -10.5 [-17.0, -4.5] | 27 vs 32, -2.5 [-7.5, +2.0] |
| GPT-6.1 Sol | 200 | 4 vs 1, +1.5 [-1.0, +4.5] | 0 vs 1, -0.5 [-1.5, 0.0] |
| H1 | 120 | 0 vs 0 | 0 vs 0 |
| H2 | 120 | 12 vs 18, -5.0 [-13.3, +4.2] | 14 vs 18, -3.3 [-8.3, +1.7] |
| H3 | 120 | 2 vs 5, -2.5 [-5.8, +0.8] | 1 vs 5, -3.3 [-6.7, -0.8] |
| H4 | 120 | 0 vs 19, -15.8 [-24.2, -8.3] | 19 vs 19, 0.0 [-5.8, +5.0] |
| H5 | 120 | 1 vs 0, +0.8 [0.0, +2.5] | 0 vs 0 |

Reading (diagnostic): all-on's gain repeats. It is positive in both rounds (+5.7, +4.0), clears H4 in both rounds
(60/60, 0 wrong values, 48/48 `+long` each time), and its pooled success and wrong-value intervals exclude zero. The
gain sits in H4 and on Sonnet and Opus. Sol is near ceiling: pooled -2.0 pp success and 4 vs 1 wrong-value cells under
all-on, with both intervals including zero; round 2's 3 Sol wrong values under all-on (one on H5) are the only place
all-on adds wrong answers, and they should be watched in confirmation. f5's round 1 H2 gain (+6 cells) did not
repeat (round 2 H2 49 vs 52): pooled, f5 is flat on success (+0.7 [-1.3, +2.8]) with a small, not-significant drop in
wrong values that sits in H3. H5 and Sol are ceilings for most comparisons.

## Firing counters (round 2)

| Arm | Names rows | with `referenced_by_count` | with records | Record rows | Delivered units | `page_status` rows | `known_as` rows | Owner-phrase referrer rows | Instructions sha256 |
|---|---|---|---|---|---|---|---|---|---|
| control | 2,640 | 0 | 0 | 0 | none | 0 | 0 | n/a | `202e24831d66` |
| all-on | 3,263 | 3,263 | 2,673 | 2,934 | section 140, chunk 173 | 0 | 70 | 4,052 | `3bb1d6aafd23` |
| f5 | 2,609 | 0 | 0 | 0 | none | 0 | 44 | 634 | `202e24831d66` |

Same pattern as round 1: each item fires only where configured; F3 does not fire in a config-only world. control's
`firing.json` counts 301 cells because it reads every attempt, including the one harness-error attempt.

## Draft-first (round 2)

Settled definition (both rounds; see round 1's record): an H4 item is draft-led when the account's contract and
amendment documents referencing it by name, code or nickname, newest document date first (ties by id), lead with a
`DRAFT` amendment. 21 of 70 items, 15 of 20 tasks; `draft_first.py r2` asserts 21.

| Arm | H4 names rows with records | with a draft | draft-first | H4 cells served a draft-first row (on draft-led tasks) |
|---|---|---|---|---|
| all-on | 277 | 77 | 66 | 34/60 (32) |
| control, f5 | 0 | 0 | 0 | 0 |

On all-on's 34 served cells: 0 wrong values vs control's 6, 34 successes vs 28. On the 45 cells of draft-led tasks:
control 6 wrong and 39 successes, all-on 0 and 45, f5 6 and 38. Pooled over both rounds, all-on was served
draft-first rows in 69 cells and had 0 wrong values on them (control 12).

## `entity` names-call latency (round 2)

| Arm | n | p50 ms | p99 ms |
|---|---|---|---|
| control | 323 | 283 | 2,008 |
| all-on | 410 | 357 | 2,201 |
| f5 | 338 | 261 | 1,725 |

Close to round 1 (control 300 / 1,789, all-on 349 / 2,154, f5 293 / 1,976). As in round 1, the p99 comes from the
large H1/H5 names calls (up to 50 names). The slots are the same snapshots whose `pages` statistics are documented
in round 1's record.

## Spend

| Arm | Committed USD | Cap |
|---|---|---|
| control | 168.53 | 228.19 |
| all-on | 140.38 | 228.19 |
| f5 | 161.12 | 228.19 |
| Round 2 | 470.03 | priced 595.29 |
| Round 1 arms | 806.54 | priced 1,026.85 |
| Slot builds (both rounds) | 54.72 | 54.72 |
| Development program committed | **1,331.29** | approved 1,777.15 (ledger cap 1,800) |

Every arm finished under its cap; the program's recorded overshoot is $0.01. Development came in $445.86 under the
approved total. The Ubicloud VM was destroyed after the outputs were copied; the slots went with it.

## Files

- `<arm>/`: `experiment.json`, budget receipt, `results.jsonl`, `attempts.jsonl`, served instructions and tools,
  `firing.json`, `transcripts.jsonl.gz`.
- `summarize_round.py r2` → `r2-summary.json`; `draft_first.py r2` → `r2-draft-first.json`; `pooled_r12.py` →
  `pooled-r12.json`; `ledger-runs.json`, `ledger-program.json` (whole development ledger after round 2).
