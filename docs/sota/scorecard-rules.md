# SOTA scorecard rules

gbrain-evals keeps a monthly scorecard of where gbrain stands against the strongest system we know for each benchmark,
the *leader*: today the whole-history reader on LongMemEval (every past conversation pasted into the prompt) and the
grep agent on BEAM (a model with list, grep and read tools over the conversations as files). This page gives the rules
the scorecard and the fix ledger follow, so a reader can check any row. The code is
[`eval/runner/sota/scorecard.ts`](../../eval/runner/sota/scorecard.ts) and
[`eval/runner/sota/ledger.ts`](../../eval/runner/sota/ledger.ts). The filled-in scorecard stays internal, because it
records what each run cost; findings it surfaces are published through the usual reports.

## What a row measures

A row is gbrain's score minus the leader's on the same questions, in points, as the mean over the three readers under
test (Claude Opus 5.5, GPT-6.1 Sol and particle-1), with a 95% interval from a bootstrap that resamples whole
conversations, so questions from one conversation don't count as independent evidence. Only answerable questions
count: those whose cited turns support the answer, or whose answer a reader given only the gold evidence gets right
([answerability](../nightly.md#the-sota-loop-answerability-attribution-and-the-fix-list)). Cost per correct answer and
median (p50) latency sit beside every row.

## Status

The first rule that applies sets a row's status:

1. **Ahead** when the interval's lower bound is above 0.
2. **Behind** when its upper bound is below 0.
3. **At parity** when the interval holds 0 and sits strictly inside ±3.5 points, the margin approved for the held-out
   RS1 test.
4. **Not enough data** otherwise, including a row with no interval.

So an interval from 0 to 3 is at parity, 0 to 9 is not enough data, and −3.5 to 1 is not enough data because it touches
the margin.

Some rows show a status but can't earn one:

- **Descriptive** rows used other readers, or ran on dev questions gbrain's settings were tuned on. gbrain's
  configuration for a held-out row is chosen on dev in advance.
- **Sealed, pending RS1 verdict** rows are on held-out questions still in custody. They stay that way until RS1's
  verdict is written.

The status is called once a quarter, at a fixed horizon. A monthly row shows it as a trend only, beside the change in
points since last month.

## What a fix can claim

Each fix gbrain ships for a fix-list item is recorded in
[`eval/data/nightly/fixes.json`](../../eval/data/nightly/fixes.json) with the bucket it targets.

- **Prediction.** The bucket's share of held-out questions, measured in custody, times the fix's success rate on its own
  dev questions, times a fixed 0.5 that is never adjusted from results.
- **Dev result.** The same-night contrast of master (with the fix) against stable (without it) on the fix's dev
  questions, shown beside the noise baseline: the share of untouched outcomes that flip between the two refs on the same
  night. Collateral losses are questions elsewhere that pass every trial on stable and none on master, counted only where
  both refs ran the question the same number of trials.
- **Held-out credit.** Each release is compared with the previous stable on the same held-out questions, and that gain
  is shared among the release's fixes in proportion to their predictions. A single fix gets its own held-out verdict
  only from a revert build in custody, and only when it was predicted at 3 points or more: *helps* when the release
  minus the revert is above 0 on its whole interval, *hurts* when below, *can't tell* otherwise.
- **Detectable difference.** Every contrast states the smallest difference its design detects (two-sided 5% test, 80%
  power, from the clustered standard error). A null smaller than that isn't evidence of no effect.

The loop has a stop rule for itself. After three quarterly status calls with RS1 scored, if the summed release-over-release
gain in the targeted buckets is below the detectable difference of that sum while the summed predictions exceed twice
it, the fix-list step gets one "Why null?" review and then a keep, fix-the-method or cut-candidate verdict.

## Changelog

### 2026-11-12: First version

New page: what a scorecard row measures, the status rules in order with their edges, descriptive and sealed rows, the
quarterly call, and what a shipped fix can claim on dev and held-out questions.
