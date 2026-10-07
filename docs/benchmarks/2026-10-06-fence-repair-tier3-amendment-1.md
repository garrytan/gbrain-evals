# Amendment 1 to the Tier 3 fence-repair preregistration: round 2 and a held-out set (2026-10-06)

Frozen on October 6, 2026, in its own commit, before any run at the round 2 code. [The original preregistration](2026-10-06-fence-repair-tier3-preregistration.md) stands except where this file changes it. Nothing here changes after a round 2 run; a later change gets a new dated file.

## Why a second round

[Round 1](2026-10-06-fence-repair-tier3.md) found that every model passes the validation gates on 96.5% to 100% of Tier 3 repairs, but the default `claude-opus-4-7` put a cell in the wrong column in 8 of 198 runs (4.0%, bar 1%). `gpt-6.1-sol` and `claude-fable-5-1` met the rule. The report proposed code changes, and gbrain's #6188 PR 4 lane is making them. Round 2 measures the changed code on the round 1 fixtures and on a new held-out set. The changes were designed from the round 1 fixtures, so the round 1 numbers will flatter the new code; the held-out set is the test that cannot.

## What changed in gbrain

The code under test is the PR 4 head that the coordinating thread names when it is ready. Its commit is not known at this writing; every run records it (`gbrain_commit` in each `.meta.json`) and the report names it. As described by the coordinating thread, the head:

1. adds a deterministic Tier 1 rule for stray empty cells (an empty cell is deleted when exactly one deletion makes the row valid) and bumps `FENCE_RULES_VERSION`;
2. fixes `wideLayout`, so a fence of typed 14-cell rows with no header is sent with the wide header;
3. raises the Tier 3 output budget and sets the default per-page cap to cover it;
4. holds before Tier 3 any row that may contain a split claim, and any row with extra non-empty cells;
5. adds `gpt-6.1-sol` to gbrain's price table;
6. ships prompt version 2, which lets the model decline with `HOLD`, recorded as `llm_declined`;
7. makes no corrective re-ask after a gate (f) failure (other gates keep one re-ask);
8. picks the default model by key and by these measurements: `gpt-6.1-sol` with an OpenAI key, else `claude-fable-5-1` with an Anthropic key, else the model tier off by default.

If the head differs from this list, the report says how. The gates are not changed by this experiment, and the prompt is not edited by it.

## The held-out set

`evals/fence-repair-tier3/heldout.jsonl` in gbrain at [`840dd95b`](https://github.com/garrytan/gbrain/commit/840dd95b010d7bcd703c1d11053ee17faadbb74c), generated from the hand-written `heldout-cases.ts` and copied here unchanged as [`round-2/heldout.jsonl`](2026-10-06-fence-repair-tier3/round-2/heldout.jsonl), sha256 `d0b45d4ce492c0ba9b728f70beb7f01969e4e6ccabddfb074ca9ca4c520fb448`. The agent running the experiment (Capy) wrote it after the round 1 results and before any round 2 code existed for it to read or run; no person reviewed it. It uses new pages and new placeholder names, and no fixture id repeats round 1.

| Set | Fences | Correct outcome |
|---|---|---|
| Repairable | 40 | The hand-written table. Short rows with trailing cells missing 9, short rows with a cell missing in the middle 4, no header 6, a row before the header 5, extra cells 7, an unknown header column 6, several problems at once 3. 27 pages hold a facts fence, 12 a takes fence and one holds both. |
| Adversarial, ambiguous | 6 | Stay held: two confidences, two takes kinds, a `team` column with no home in a facts table, a `rationale` column the gates would accept as either a date or a source, a notice-period date that could be its start or its end, two free-text notes neither of which reads clearly as the source |
| Adversarial, split claim | 4 | Stay held: an unescaped pipe cut the claim in two (in a facts row with an extra cell, a takes row, a row whose kind cell is also missing so the cut half sits in the kind column, and a fence with no header) |
| Adversarial, unrecoverable | 2 | Stay held: a weight, or a notability, is missing |

The repairable rows carry the same kinds of content as round 1: links, struck-through claims, k/M/$ values, escaped pipes, world-visible pages, timeline fences, typed rows, rows without numbers and a percent confidence.

**The $0 check** at gbrain `840dd95b` (round 1 code plus the harness changes below): 0 violations over the 52 fences. Every repairable ground truth passes every gate and comes out byte-identical (the two rows-without-numbers cases also with the `#` cells left empty); every ambiguous and split-claim probe that reaches Tier 3 is accepted by the gates, so only the model or a routing rule can hold them; both unrecoverable probes are rejected. One routing note: at the round 1 code, Tier 1 itself rewrites `h-spl-03` (the split claim with no kind cell: the cut half is mapped to `fact` and kept as `original kind`), which is a wrong write by the free tiers today.

**Exposure.** The set is committed here and on gbrain branch `capy/6188-t4-eval`. If any part of it informs a code change before round 2 runs, the report names the fences affected and reports them separately.

## Harness changes

At gbrain `840dd95b` (harness files hash `f66ec12e…`, recorded in each run's metadata):

- A fence the free tiers settle is reported with that tier instead of as a fixture defect: a Tier 1 repair is compared with the ground truth like any repair, and a fence held before Tier 3 is a hold. Rescoring the round 1 results with the new scorer gives identical numbers.
- `--fixtures` selects the set; a price is registered in `pricing.overrides` only for a model gbrain's own table lacks.
- Round 2 runs in a worktree at the PR 4 head with `evals/fence-repair-tier3/` taken from `840dd95b` (or the head's own copy, if identical), so the code under test is exactly the head.

## Measurements

Unchanged from the preregistration except:

- **Gate-pass and false-accept** are computed over the repairable fixture runs that **reach Tier 3** at the round 2 code. That set is the same for every model; the $0 check at the head lists it before any paid run. In round 1 every fixture reached Tier 3, so the definitions agree.
- A repairable fence the model declines (`llm_declined`) is not repaired: it counts against gate-pass and is not a false accept.
- **End to end** (reported): every repairable fence whatever tier settled it, with wrong writes per tier. A Tier 1 repair that differs from the ground truth is a wrong write by Tier 1.
- **Held correctly on adversarial items** (reported, secondary): adversarial runs that stay held by any tier, over adversarial runs, split by kind (ambiguous, split claim, unrecoverable) and by how they were held (before Tier 3, declined, a gate, or the output budget running out).

## Decision rule

Unchanged: per model, pooled over three runs, a Tier 3 gate-pass rate of at least 80% and a false-accept rate of at most 1%.

In round 2 a model **qualifies** only if it meets the rule on the held-out set and on the round 1 fixtures. The held-out set is decisive; a model that meets the rule only on the round 1 fixtures does not qualify. If fewer than 25 held-out repairable fences reach Tier 3 at the head, the held-out result is inconclusive, no model qualifies in round 2, and the report recommends keeping the model tier off by default until a larger held-out set runs.

## Models

Unchanged: `claude-opus-4-7`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol` and `claude-fable-5-1`. `claude-opus-4-7` is no longer gbrain's default at the round 2 code and runs as part of the unchanged set.

## Picking the default model

Key-aware, from qualifying models only:

- **An install with an OpenAI key** uses `gpt-6.1-sol` if it qualifies.
- **An install with only an Anthropic key** uses the qualifying Anthropic model with the highest held-out gate-pass rate; if its Wilson interval overlaps that of a cheaper qualifying Anthropic model, the cheaper one.
- **An install with both keys** uses the qualifying model with the higher held-out gate-pass rate, or the cheaper one if their intervals overlap. If that differs from the head's order (`gpt-6.1-sol` first), the report says so.
- **No qualifying model for the install's keys:** the model tier is off by default.

Adversarial results do not change the pick. Any accepted ambiguous or split-claim fixture is reported with the model's answer.

## Procedure and budget

As in round 1: a fresh brain per model and run, `models.fence_repair` set to the model, the daily ledger capped at $10 per run brain, the per-page cap at the head's default, a 90-second call timeout, and provider errors retried twice. Order: the $0 check at the head on both sets; a 3-fixture setup run on `claude-sonnet-5-5`, excluded from scoring; then 2 sets × 5 models × 3 runs, 1,950 fixture runs. The two sets are scored and reported separately. Expected spend is $15 to $25; the program cap is $40.
