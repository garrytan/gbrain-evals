# Superiority p audit, November 4, 2026

gbrain is Garry Tan's own project. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator. See [disclosures](../disclosures.md).

## The finding

No published verdict in this repository changes. From November 4 the superiority gates use an exact one-sided
sign-flip p. Before that, `superiorityP` in [`eval/runner/stats/paired.ts`](../../eval/runner/stats/paired.ts)
returned the share of cluster-bootstrap draws at or below the minimum effect, which is not a p-value. With few units it
is anti-conservative. With three clusters that all improve, the share is about 1/(draws + 1), while the exact one-sided
sign-flip p can never fall below 1/2³ = 0.125. Harness Evals found the problem in its own copy (HARN-1). gstack-evals
measured p = 0.027 where the exact p is 0.125. The gates now use the exact one-sided cluster sign-flip p: all
2^clusters sign patterns are enumerated up to 20 clusters, and a seeded Monte Carlo with the family's draws is used
above that.

Every superiority verdict this repository publishes with its numbers rests on 11 or more clusters, most on hundreds,
so the numbers move but the calls hold:

- **The W10 LongMemEval reports' p values move.** W10a's one-sided p is 0.105 (published as 0.081). W10b's Holm p
  values for its six readers are 0.0002, 0.0002, 0.082, 0.12, 0.19 and 0.29 (published as 0.0006, 0.0006, 0.055,
  0.097, 0.15 and 0.25). W10c's two loss tests are 0.97 and 0.997 (published as 0.96 and 0.99). Every pass,
  inconclusive and "not shown" stays as published.
- **One sentence changes its conclusion.** W10b's sensitivity note said that dropping the Fable arm after the fact
  would have let Holm over five arms count `gpt-6.1-sol` as higher (adjusted p = 0.041). With the exact p the adjusted
  value is 0.061, so it would not. [corrections.md](../corrections.md#longmemeval) lists it.
- **Held-out verdicts whose rows stay in custody cannot be recomputed here.** Bounds and approximations from the
  published aggregates say the P1 E1 round-2 pass (set C) and the P5 H7 pass stand. H7 is certain. P1 is certain on two
  gates, exact on a third and approximate on the fourth, `during`. The Q2 C-gate selection publishes no p values, so
  only the custodian can recompute it, keyless and at no cost. Its shipped units were decided by the fixed-sequence
  confirmation, which never called `superiorityP`.
- **gbrain's own dev records change on two three-conversation LoCoMo sources** (P2 date grounding and P6 `think`
  dates). Each recorded a pass at p = 0.0001 where the exact p is 0.125. Both decisions' overall dev verdicts were
  already inconclusive and stay so. Those files live in gbrain's repository, and this repository's pages never state
  those two passes.

## What the gate tests now

For a superiority comparison with minimum effect `m`, each cluster's oriented summed difference has `m` times its item
count subtracted, and then its sign is kept or flipped. The p-value is the share of sign patterns whose mean is at
least the observed mean. That tests "B beats A by no more than `m`" at its boundary, at the same unit of randomization
the gate clusters by (`cluster_by`). With `m` = 0 it is the test behind `p_greater` (`p_less` for a lower-is-better
metric), which every comparison already reported. With 0/1 outcomes and one item per cluster it is the exact one-sided
binomial test on the discordant pairs. Holm adjusts these p values exactly as it adjusted the old ones.
[`test/eval/decide-kit.test.ts`](../../test/eval/decide-kit.test.ts) pins HARN-1's three-cluster case (p = 0.125,
Holm 0.25 across two gates, inconclusive) and the minimum-effect shift.

## Audit table

"Old p" is what the gate computed and published. "Exact p" is the one-sided cluster sign-flip p at the gate's own
unit, minimum effect and direction. Holm-adjusted values are in brackets. Every family's alpha is 0.05, one-sided.

### Rows committed here: exact

| Result | Units (unit of randomization) | Old p [Holm] | Exact p [Holm] | Old verdict | Verdict under the exact p | Does alpha or Holm change the call? |
|---|---|---|---|---|---|---|
| [W10a](../benchmarks/2026-10-07-longmemeval-w10a-current-pin.md) current pin against 2026-09-29 retrieval, official judge, `m` = 0 | 500 questions (question), 16 discordant (+11 / −5) | 0.081 | 0.105 | no change shown | no change shown | No |
| [W10b](../benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md) Opus 5.5 notes against Sonnet 4.6 | 500 (question), +28 / −5 | 0.0001 [0.0006] | 0.000033 [0.00019] | higher | higher | No |
| W10b Sonnet 5.5 direct against Sonnet 4.6 direct | 500 (question), +38 / −10 | 0.0001 [0.0006] | 0.000031 [0.00019] | higher | higher | No |
| W10b GPT-6.1 Sol notes | 500 (question), +24 / −11 | 0.014 [0.055] | 0.020 [0.082] | no difference shown | no difference shown | No |
| W10b Sonnet 5.5 notes | 500 (question), +22 / −11 | 0.032 [0.097] | 0.040 [0.120] | no difference shown | no difference shown | No |
| W10b GPT-5.4 official prompt | 500 (question), +23 / −14 | 0.076 [0.15] | 0.094 [0.19] | no difference shown | no difference shown | No |
| W10b Fable 5.1 notes (200 subset) | 200 (question), +8 / −5 | 0.25 [0.25] | 0.29 [0.29] | no difference shown | no difference shown | No |
| W10b sensitivity, Holm over five arms without Fable (report-only) | as above | Sol [0.041] | Sol [0.061] | Sol "would have counted as higher" | would not | **Yes**: the five-arm Holm level moves above 0.05 |
| [W10c](../benchmarks/2026-10-07-longmemeval-w10c-full-context.md) whole history better than gbrain by more than 7 points, Sonnet 5.5, `m` = 0.07 | 150 (question), +7 / −2 | 0.965 [1] | 0.967 [1] | not shown | not shown | No |
| W10c the same, `gpt-6.1-sol` | 150 (question), +5 / −1 | 0.993 [1] | 0.997 [1] | not shown | not shown | No |
| [BEAM-1M dates](../benchmarks/2026-10-06-beam-1m-dates-preregistration.md) `recall-all-5` (eval:decide verdict) | 11 conversations | 1 [1] | 1 [1] | inconclusive | inconclusive | No: every paired difference is 0 |

The W10 rows are binary with one question per cluster, so the exact p is the binomial tail on the discordant
questions (W10c's 0.07 shift is handled by an exact convolution over the three shifted values). The new gate code, run
at the families' 10,000 seeded draws, gives Monte Carlo values within 0.005 of these: 0.103, 0.0001, 0.0001, 0.021,
0.038, 0.098, 0.30, 0.966 and 0.998.

### gbrain's dev records: recomputed from the recorded stats

These are eval:decide verdicts in gbrain's `docs/eval/decisions/` at the gbrain commit `package.json` pins. For
`m` = 0 the exact p is the recorded sign-flip `p_greater` (`p_less` for lower): exact up to 20 clusters, a 10,000-draw
Monte Carlo estimate (standard error at most 0.005) above that. The P1 dev gates have `m` > 0 and no rows, so their
entry is a Hoeffding upper bound from the recorded cluster-robust standard error.

| Result | Units | Old p [Holm] | Exact p [Holm] | Old verdict | Verdict under the exact p | Does alpha or Holm change the call? |
|---|---|---|---|---|---|---|
| P2 date grounding dev, LoCoMo, unresolved relative-date share (lower is better) | 3 conversations | 0.0001 [0.0002] | **0.125** [0.25] | comparison pass; source and decision inconclusive | comparison inconclusive; source and decision inconclusive | **Yes** for the comparison: 0.125 > 0.05 even before Holm. No for the decision |
| P2 date grounding dev, LongMemEval-S, same metric | 11 conversations | 0.0001 [0.0002] | 0.00049 [0.00098] | pass | pass | No |
| P6 `think` date frame dev, LoCoMo `qa-score` | 3 conversations | 0.0001 [0.0001] | **0.125** [0.125] | source pass; decision inconclusive | source inconclusive; decision inconclusive | **Yes** for the source. No for the decision, which another source already held at inconclusive |
| P6 `think` date frame dev, LongMemEval-S `qa-score` | 150 conversations | 0.0003 | ≈ 0.0010 (MC) | pass | pass | No |
| P6 notes-first dev, both sources | 150 and 3 | 0.75 and 1 | ≈ 0.82 and 1 | inconclusive | inconclusive | No |
| P2 speaker attribution dev | 30 conversations | 0.0001 | ≈ 0.0006 (MC) | pass | pass | No |
| P1 temporal edges dev, rounds 1 and 2 (4 gates per source, `m` 0.10 to 0.20) | 24 to 160 clusters | 0.0001 to 0.0004 [≤ 0.0006] | ≤ 0.0098 (bound) [≤ 0.014] | pass | pass | No |

### Held-out aggregates whose rows stay in custody: bounds

The custodian publishes means, intervals and cluster counts, not rows. All four P1 metrics and H7's are in [0, 1], so a
Hoeffding bound from the means is rigorous. The normal approximation uses the published interval and is not a bound.
`correction_ok` is 0/1 with one item per cluster and its baseline is 0 on every item, so its exact p follows from the
published means. The P1 family Holm-adjusts 6 tests (4 superiority, 2 non-inferiority at a 0.02 tolerance whose
published intervals sit well inside it).

| Result | Units | Exact p | Old verdict | Verdict under the exact p | Does alpha or Holm change the call? |
|---|---|---|---|---|---|
| [P1 E1 round 2, set C](../benchmarks/2026-10-05-heldout-verdicts/p1-e1-r2-heldout-2026-10-04.json), now-precision, `m` 0.10 | 36 clusters | ≤ 0.0011 (bound) | pass | pass | No (≤ 0.0068 even ×6) |
| set C as-of, `m` 0.15 | 240 clusters of 3 | ≤ 1.2e-7 (bound) | pass | pass | No |
| set C during-year F1, `m` 0.15 | 240 clusters | ≈ 0.0037 (approximation) | pass | pass, approximately | Not expected (≈ 0.022 even ×6); needs the rows to certify |
| set C correction, `m` 0.20 | 44 clusters | 0.018 (exact) | pass | pass | Not expected: Holm stays at or below 0.037 while correction's p ranks fifth or sixth, which the other five p values (bounds, approximation and published intervals) indicate |
| [P1 E1 set E](../benchmarks/2026-10-05-heldout-verdicts/p1-e1-sete-2026-10-05.json) (reported after the trap gate failed) | 36 to 240 | now-precision ≤ 0.089 and as-of ≤ 1.8e-5 (bounds), during ≈ 0.72, correction 1 (exact) | fail (trap gate) | fail | No: the exact gate decides |
| [P5 delta H7](../benchmarks/2026-10-05-heldout-verdicts/p5-delta-heldout-2026-10-05.json), as-of on range pages, `m` 0.10 (also below 1e-19 at `m` 0) | 117 clusters of 3 | ≤ 5e-19 (bound) | pass | pass | No |
| [P5 set G](../benchmarks/2026-10-05-heldout-verdicts/p5-delta-set-g-2026-10-05.json), P1 superiority report (report-only) | 36 to 240 | now-precision ≈ 2e-7, as-of ≤ 0.00085 (bound), during ≈ 0.80, correction 0.53 (exact) | report-only | report-only | No |
| [Q2 C-gate selection](../benchmarks/2026-10-05-heldout-program/q2.md) (U34, U1, U25 selected; Holm across 4 units at one-sided 0.025) | probe clusters on I1 | not published | U34, U1, U25 selected | unknown | Only the custodian's receipts can say. Shipping (U34, U1) was decided by the confirmation's bootstrap intervals, which never used `superiorityP` |

### Checked and not from `superiorityP`

- The memory proof wave's dev verdicts (C2 interleave, supersession threshold) came from gbrain's own fixture kit
  (`cluster-sign-flip`), and every delta there is 0 or negative, so any one-sided p is at least 0.5.
- Sealed v2 decision 1 (2026-10-02) predates `superiorityP` (added 2026-10-04). It used exact McNemar and a
  sign-flip p.
- The P2 E2 and E3 and P6 held-out passes used the custodian's preregistered interval rules.
- Budgeted delivery H1, the 8k conversion and the external-ideas waves used their own rules (interval with McNemar, or
  the sign-flip `p_greater`). Their families have no superiority gate, and neither do the power simulations of H1, the
  8k conversion and sealed v2.
- The Q1 scoreboard's restricted wild cluster bootstrap ([`wild-cluster.ts`](../../eval/runner/stats/wild-cluster.ts))
  imports only `seededRandom` from `paired.ts`. Its p-values impose the null before resampling, so it is not the
  bootstrap-share construction and is unaffected. Cat 21, the embedding matrix, the shootout report and PrecisionMemBench
  S3 use two-sided sign-flip p values with Holm. The A6 pilot uses non-inferiority only.

## Limits and follow-up

- `nonInferiorityP` uses the same bootstrap-share construction for non-inferiority gates and is anti-conservative at
  few clusters in the same way. It is not changed here. Recomputed with the exact sign-flip p at the tolerance, W10c's
  two non-inferiority passes stay passes (Holm 0.033 and 0.0058, published 0.035 and 0.014).
- The Q2 C-gate selection and the P1 set C `during` gate need the custodian's rows. Rerunning
  `bun eval/runner/q2/c-gates.ts select` and the P1 family on the custody receipts with this fix is keyless and costs
  nothing.
- The summary and verdict receipts keep the values as computed. The reports carry the exact values, and their changelogs
  keep the old ones.

## Reproduce

```bash
bun docs/audit/2026-11-04-superiority-p/recompute.ts > docs/audit/2026-11-04-superiority-p/results.json
```

Keyless, no model call, about a second. It reads the committed W10 compare rows and families, gbrain's dev records
under `node_modules/gbrain/docs/eval/decisions/` and the held-out aggregates, then writes every number above to
[`results.json`](2026-11-04-superiority-p/results.json).
