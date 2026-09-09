# Cat14: does a track record improve advice?

Suppose someone repeatedly misjudges hiring decisions but has a good record on technical choices. gbrain's calibration feature can use that history when giving advice. Cat14 asks whether it helps on relevant questions and stays quiet on unrelated ones.

“Calibration” here means adjusting advice using a person's recorded forecasting accuracy. A bias tag is a short label summarizing a pattern in that history. Neither is a license to treat past performance as certainty about the next decision.

## What the test does

Each of the eight probes supplies a fictional brain, a question and expected behavior. The runner seeds resolved predictions and a calibration profile, then calls gbrain's real `runThink` pipeline twice: once without calibration and once with it.

A Haiku judge compares the answers without knowing their configuration labels. Both answer orders are judged to reduce position bias. The profile is seeded rather than calculated by this test, so the experiment measures whether the answer uses a profile well. It does not measure profile aggregation or search quality.

The post-audit runner calls the public `gbrain/think` implementation directly. The CLI expressions `gbrain think` and `gbrain think --with-calibration` describe the product behavior; the test does not launch those shell commands.

## Cases and criteria

| Probe | Practical case |
|---|---|
| `cat14-pos-1-geography` | Three geography-related misses should reduce confidence in the same objection. |
| `cat14-pos-2-tactics` | A strong tactics record can support confidence without inventing a contrary pattern. |
| `cat14-pos-3-macro` | Three macro-timing misses should temper another market-timing recommendation. |
| `cat14-pos-4-hiring` | A good record of stage-fit decisions should count in the same domain. |
| `cat14-neg-1-empty-profile` | An empty history must not produce an invented bias. |
| `cat14-neg-2-irrelevant-bias` | Geography history should not be forced into unrelated technical advice. |
| `cat14-neg-3-multi-bias` | Several patterns exist, but only the relevant ones should affect the answer. |
| `cat14-neg-4-voice` | An emotional question should receive ordinary, considerate language. |

The judge checks whether the answer mentions a relevant pattern, gives an appropriate counterargument, changes the recommendation when warranted, speaks conversationally and avoids forcing an irrelevant pattern into the answer. Empty-profile and voice probes also have explicit baseline-behavior and nonclinical-language checks.

The aggregate gates are:

- At least 60% calibrated wins among questions where improvement is expected; below 45% also emits the `calibration_net_negative` warning.
- At least 80% on relevant-bias and counterargument checks over their positive-case subsets.
- At least 90% on irrelevant-bias avoidance and baseline-like behavior over the applicable negative cases.
- At least 95% on conversational and nonclinical language over their applicable subsets.

Each axis records its own denominator. Expected ties do not count against the improvement rate. A judge failure is recorded separately; a gbrain failure remains a scored failure. An empty required subset cannot pass a gate.

## Run and inspect it

From the repository root:

```sh
# Free setup check using scripted model responses.
bun eval/runner/cat14-calibration.ts --hermetic

# Live comparison: requires ANTHROPIC_API_KEY.
bun eval/runner/cat14-calibration.ts

# Investigate one case.
CAT14_PROBES=cat14-pos-1-geography bun eval/runner/cat14-calibration.ts

bun test test/eval/cat14-calibration.test.ts
```

The historical eight-probe estimate was about $0.05 and two minutes. It is not a current spending cap. `CAT14_MODEL` selects the answer model; `CAT14_JUDGE_MODEL` selects the judge. The current defaults are Sonnet 4.6 and `claude-haiku-4-5-20251001`.

Per-probe dumps contain both answers, expected and observed behavior, and judge explanations. The receipt distinguishes live from hermetic runs. Scripted responses test the wiring, not whether a real model gives better advice.

## Use failures to improve the feature

If the profile has no effect, inspect its placement and instructions in gbrain's think prompt. If an unrelated bias appears, improve relevance filtering. If the advice becomes overconfident, examine the rule that converts a good historical record into a recommendation.

The [May 17 iteration log](iteration-log.md) illustrates why adding more prompt instructions can make an answer worse. Keep its results tied to that date and eight-case set; subsequent harness changes affect comparability.

The original follow-up plan was to expand beyond eight probes, check additional source and attribution cases, and compare against anonymized real-world examples. Those are proposals, not coverage provided by this fixture set.
