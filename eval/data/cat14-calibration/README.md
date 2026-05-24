# cat14 — Calibration A/B (think with vs without --with-calibration)

The headline product question for gbrain v0.36.1.0's calibration
wave: **does `gbrain think --with-calibration` actually produce better
answers than plain `gbrain think` on questions where the user has a
relevant track record?**

If this category fails, the entire calibration wave is theater. If it
passes, the wave moves the needle.

## What the eval measures

For each probe:

1. Seed a synthetic in-memory PGLite brain with the probe's `brain_setup`:
   resolved takes (with `quality` = correct/incorrect, conviction weight,
   domain), plus a pre-populated `calibration_profile` row carrying the
   bias tags + narrative statements that aggregation *would* produce on
   that data.
2. Run `gbrain think "<question>"` against that brain → baseline answer.
3. Run `gbrain think --with-calibration "<question>"` against that
   brain → calibrated answer.
4. Judge model (Haiku) scores both answers against a 5-axis rubric.
5. Per-probe JSON dump records the question, both answers, and per-axis
   pass/fail — driving the fix-feedback loop below.

## The 5 rubric axes

| Axis | What it tests | Failure mode |
|------|--------------|--------------|
| `mentions_relevant_bias_tag` | Did the answer surface a bias from the profile when the question's domain matches? | Calibration block isn't reaching the model. Fix: prompt placement (D22), block format |
| `presents_counter_prior` | When the bias is over-confidence, did the answer name a counter-prior? | Anti-bias rewrite rule not firing. Fix: tighten "name both priors" instruction in `buildThinkSystemPrompt` |
| `changes_recommendation_meaningfully` | Did the calibrated recommendation differ from baseline in a domain-appropriate way? | Model treating calibration as decoration. Fix: stronger instruction wording, longer profile context |
| `voice_conversational` | Friend-not-doctor language across the whole answer | Voice rule isn't propagating. Fix: voice rubric examples in system prompt |
| `doesnt_force_fit_irrelevant_bias` | Negative-case probes test that an irrelevant bias tag doesn't get shoehorned into a domain-mismatched question | Over-eager bias surfacing. Fix: instruction must say "only mention bias if domain matches" |

## Probe taxonomy (8 probes ship in v1)

| Probe ID | Category | What's tested |
|----------|----------|---------------|
| `cat14-pos-1-geography` | `calibration-pattern-relevant` | 3/3 geography misses → calibrated answer must de-rate geography skepticism |
| `cat14-pos-2-tactics` | `calibration-pattern-confidence-boost` | Strong tactics record → calibrated answer reinforces velocity prior, doesn't manufacture fake counter-prior |
| `cat14-pos-3-macro` | `calibration-pattern-relevant` | 0/3 macro-timing → calibrated answer explicitly de-rates pull-back recommendation |
| `cat14-pos-4-hiring` | `calibration-pattern-confidence-boost` | Sharp stage-fit reads → reinforce no-hire prior |
| `cat14-neg-1-empty-profile` | `calibration-empty-profile` | Cold brain → calibrated answer behaves identically to baseline (NO fabricated bias mention) |
| `cat14-neg-2-irrelevant-bias` | `calibration-bias-irrelevant` | Geography bias + technical AI question → MUST NOT force-fit geography mention |
| `cat14-neg-3-multi-bias` | `calibration-multi-bias` | Question touches multiple domains → triage which bias is relevant, not all |
| `cat14-neg-4-voice` | `calibration-voice-stress` | Emotional question → voice stays friend-not-doctor, no clinical "Brier in this domain" |

## Pass thresholds

Aggregate metrics, from probe-level scores:

- **Overall win rate** (calibrated preferred to baseline): **>= 60%** target, **< 45% = doctor flag** (the `calibration_net_negative` warning the calibration_freshness doctor check listens for).
- **Per-axis pass rate** on positive probes: **>= 80%** for `mentions_relevant_bias_tag` and `presents_counter_prior`.
- **Per-axis pass rate** on negative probes: **>= 90%** for `doesnt_force_fit_irrelevant_bias` and `behaves_like_baseline`. Negative cases are stricter — over-eager bias surfacing is the failure mode that makes calibration annoying instead of useful.
- **Voice axis**: **>= 95%** across ALL probes. The voice rule is cheap and must not regress.

## The fix-feedback loop

This is what the user asked for: "if the evals fail, we should consider how to improve the feature."

When a probe fails an axis, the per-probe JSON dump includes:
- `question`
- `baseline_answer`
- `calibrated_answer`
- `expected.{axis}` vs `actual.{axis}` per axis
- `judge_rationale` — the judge model's plain-English explanation of why each axis failed

Failure-mode → fix mapping:

| Failure mode | Diagnostic signal | Where to fix |
|--------------|-------------------|--------------|
| Calibration block ignored | Calibrated answer reads same as baseline; no bias mention; judge rationale: "no calibration context surfaced" | `src/core/think/prompt.ts:buildThinkSystemPrompt` — block placement (D22 was a guess; try BEFORE retrieval), block format (try YAML-style instead of XML) |
| Force-fit irrelevant bias | Negative probe fails; geography bias mentioned on AI tech question | `src/core/think/prompt.ts:buildCalibrationBlock` — instruction must say "only mention bias if domain semantically overlaps with question" |
| Counter-prior missing | Positive probe fails; answer mentions bias but doesn't name a counter-direction | `src/core/think/prompt.ts:buildThinkSystemPrompt` — anti-bias rewrite rules need a "name BOTH priors transparently" example |
| Voice clinical | Voice axis fails; "your Brier in domain X is 0.31" leaks through | `src/core/calibration/voice-gate.ts` — extend rubric examples; OR upstream gate the calibration_profile narrative more aggressively before it reaches think |
| Recommendation unchanged | `changes_recommendation_meaningfully` fails on relevant-bias probe | Profile context is too weak. Try: pattern_statements rendered as 3-4 short sentences instead of one paragraph; add explicit "Bayesian adjustment: ~X% down" hint |
| Win rate too low overall | Aggregate metric below 55% across the run | Calibration block is net-negative on user-perceived quality. Likely over-asserting bias. Consider: only mention bias when judge_model_agreement on the profile is high (>=0.8) |

## How to run

```bash
# Full run (8 probes, ~$0.05 in API costs, ~2 min wallclock)
bun eval/runner/cat14-calibration.ts

# Smoke (2 probes, judge stubbed, no API spend)
bun test eval/runner/cat14-calibration.test.ts

# Single probe (debugging a specific failure mode)
CAT14_PROBES=cat14-pos-1-geography bun eval/runner/cat14-calibration.ts
```

## Why this design

Three explicit choices worth flagging:

1. **Synthetic seeded brain, not user's real brain.** A real brain would
   give realistic results but no ground truth — we wouldn't know whether
   the calibrated answer is "right." Synthetic probes have known
   `expected.*` values per axis, so judge scoring has a target.

2. **Per-probe JSON dumps even on pass.** The failure-loop demands
   per-example visibility. Aggregate "60% win rate" tells you the
   feature shipped; per-example "this 40% lost because X" tells you
   what to fix next.

3. **Negative probes are explicitly the stricter half.** Calibration
   that over-claims (force-fits irrelevant bias) is worse than
   calibration that under-claims. A v0.36 ship with strong positive-axis
   numbers but weak negative-axis numbers should NOT pass the gate.

## What ships in v1 vs v2

**v1 (this PR):**
- 8 hand-authored probes covering the 4 main scenarios
- Shell-out runner against `gbrain think` CLI (tests the real user path end-to-end)
- 5-axis Haiku judge with structured tool-use output
- Per-probe JSON dumps for the fix-feedback loop

**v2 (follow-up):**
- Expand to 30+ probes covering the long tail (mounts, cross-brain
  attribution, abandoned-thread surfacing)
- Real-brain shadow eval: run cat14 against a contributor's anonymized
  brain export to validate the synthetic-probe results transfer
- Auto-iterate: failing probes → prompt-mutation candidates → re-run
  → measure win-rate delta. Closes the loop fully.
