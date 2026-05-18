# cat14 prompt iteration log

Evidence that the failure-loop methodology works. Three prompt variants
tested on the same 8-probe set on the same day (2026-05-17). Same model,
same judge model, same fixtures. The eval caught real regressions.

## v1 — original (5 short rules, single "name both priors" rule for all bias mentions)

```
Rules:
1. ONLY mention a bias if it is semantically relevant to the question's domain. Do not force-fit.
2. When you mention a bias, name BOTH priors transparently: "your prior says X; counter-prior from your track record says Y."
3. Adjust your recommendation in proportion to the bias strength.
4. Voice: friend, not doctor. Never "your Brier in this domain is 0.31." Use "you tend to miss" instead.
5. If no bias is relevant, answer as you would without the profile. Don't manufacture a counter-prior.
```

**Results:**
- Win calibrated: **75%** (baseline 0%, ties 25%)
- mentions_relevant_bias_tag: 100%
- presents_counter_prior: 75% (2 misses)
- changes_recommendation_meaningfully: 63% (3 misses)
- voice_conversational: **100%**
- doesnt_force_fit_irrelevant_bias: **100%**
- Gate: **PASS**

**Diagnosis:** The two soft-axis misses were both confidence-boost probes
(positive track record). The prompt rule "name BOTH priors" fires
unconditionally, so even when the user's track record is *confirming* the
gut, the model manufactures a fake counter-prior. The judge correctly
flagged this as failure on probes where `expected.presents_counter_prior:
false`.

## v2 — split bias-tag direction into two cases

```
2. Bias tags come in two flavors:
   - "over-confident-X" tags signal the gut has been WRONG in domain X. Name BOTH priors and de-rate.
   - "well-calibrated-X" tags signal the gut has been RIGHT in domain X. Reinforce the gut WITHOUT manufacturing a counter-prior.
```

**Results:**
- Win calibrated: 63% (baseline 25%, ties 13%) ← REGRESSION
- voice_conversational: 88% ← REGRESSION (95% gate fail)
- Counter-prior 88%, recommendation 63%, force-fit 100%
- Gate: **FAIL** (voice_conversational below threshold)

**Diagnosis:** Removing the counter-prior on well-calibrated tags caused
the model to slide into oracle voice — "trust the pattern. Don't write
the check." Over-correction. The eval caught it because the voice axis is
strict at 95%.

## v3 — restore epistemic humility on well-calibrated tags

```
Rules:
1. ONLY mention a bias if it is semantically relevant. Do not force-fit.
2. Read the direction of the bias from the tag name:
   - "over-confident-X" tags: name gut prior, name counter-prior, de-rate the gut.
   - "well-calibrated-X" tags: lean into the gut WITH epistemic humility — name the
     track record as confirmation, but acknowledge that past accuracy doesn't
     guarantee this case. Don't manufacture a fake counter-prior, but don't act
     as an oracle either.
3. Adjust recommendation in proportion to bias strength AND direction.
4. Voice rules:
   - Friend, not doctor.
   - Leave room to push back.
   - Avoid commanding language. Prefer suggestive.
5. If no bias is relevant, don't manufacture a counter-prior.
```

**Results:**
- Win calibrated: 75% (baseline 25%, ties 0%)
- voice_conversational: **75%** ← REGRESSION (95% gate fail)
- doesnt_force_fit_irrelevant_bias: **75%** ← REGRESSION (90% gate fail)
- Gate: **FAIL** (voice AND force-fit below thresholds)

**Diagnosis:** The longer, more detailed prompt caused the model to leak
meta-instructions into the answer ("Friend, not doctor" — the actual
phrase appeared in some outputs). And the detailed sub-rules created
ambiguity the model resolved by hedging more aggressively, which the
judge marked as voice failure.

## Reverted to v1; iteration log preserved.

**Final state:** v1 with 75% win rate, 100% voice, 100% force-fit
prevention, gate **PASS**. Two soft-axis misses on confidence-boost
probes remain — those are the v0.37 follow-up. Each iteration here
took ~$0.05 in API spend and ~3 minutes wallclock.

## What this proves about the methodology

The eval design surfaced THREE distinct prompt regressions in three
iterations, with detailed per-probe rationale at every step. The
strictness of the negative-axis gates (voice 95%, force-fit 90%) caught
exactly the failure modes that would make calibration annoying instead
of useful — the over-correction problems that less-strict eval gates
would have missed.

**Lesson for future prompt iteration:**
- Don't extend the prompt to fix a regression unless the regression
  *can't* be fixed by other means (e.g., upstream profile filtering).
  Longer prompts leak meta-language.
- The 95% voice gate is real; iterations that lose ground on voice
  should not ship even if they win on other axes.
- Over-correction in either direction (force-fit OR under-claim) is
  worse than the original issue. Keep the simplest working prompt.
