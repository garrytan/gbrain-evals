# Cat 40 next wave: development round 3 (`all-on-no-f5`), comparisons declared before cells

Written 2026-10-13, before any cell of this arm ran and before its slots were built. Diagnostic, in-sample (World M).

## Why the arm exists

The d1b gate failed (`../2026-10-13-cat40-dev-d1b/`), and the owner kept the plan's default: F5 is off in the
confirmation. The plan's fallback takes F5's commits out of Part 1 before merge. That leaves one gap: no development
arm had run the exact confirmation configuration. This arm fills it. The decision was auto-approved under Garry's
standing rule (2026-10-12) and relayed by GBRA-39's parent on 2026-10-13.

## What runs

- **Arm.** `all-on-no-f5`: the all-on restore-time keys (`bun eval/runner/cat40/dev-arms.ts --round 3`) with no
  build config, so F5 is off. It runs the full family, on World M, for one round with the three models and judge
  `gpt-6.1-sol`. Concurrency, slots and flags are the same as rounds 1 and 2.
- **Build.** The Part 1 head with F5's commits removed, as reported by Subagent 16. A fresh F5-off slot family (10
  slots, `--no-pglite-analyze`) is built on that head under its own `--gbrain-root`. The head, its slot receipts and
  its `src/` difference from `a798de1f` are recorded in this directory's README before cells.
- **Budget.** Priced $198.43 per full arm, with `--budget-usd` 228.19 (1.15 ×). Slots are about $27. All of it is
  charged to the development ledger (program committed $1,331.29 after round 2; $445.86 left of $1,777.15).

## Declared comparisons

Every interval below is a percentile bootstrap that resamples tasks (4,000 resamples, seed 11; all cells of a task
move together).

1. **Primary diagnostic: Δ success against the pooled control.** Cells pair by model and task. The comparison value
   for each pair is the mean of that cell's round 1 and round 2 control results (0, 0.5 or 1). Δ = arm rate minus
   pooled-control rate, in pp, over the 300 cells.
2. **The same comparison against the pooled all-on arm** (rounds 1+2, F5 on). This gives what removing F5 costs in
   the shipped configuration.
3. **Wrong values** (`said_wrong`) and non-submission, against pooled control and pooled all-on, with the same
   pairing.
4. **Breakdowns:** H4, with `+long` stratified, every other family, and each model, against both references.
5. **Draft-first,** with `draft_first.py`'s settled definition: firing (draft-first names rows, H4 cells served one)
   and harm (wrong values and successes on the 15 draft-led tasks, against pooled control and pooled all-on).
6. **Firing counters** (`firing.ts`) and names-call p50/p99.

The same-round control is not used, because round 3 runs no control.

**Definition of "clearly worse than all-on":** the 95% interval of comparison 2 lies wholly below 0 on success, or
wholly above 0 on wrong values. If the arm is clearly worse, the preregistration records that as a known limitation of
the confirmation's wave arm. Whatever the result, the confirmation's wave arm stays all-on without F5 (owner
decision).

**Caveat stated in advance.** The reference cells ran on `a798de1f` and this arm runs on the F5-removed head, so any
`src/` difference besides F5's removal is part of the comparison. The README lists that difference.
