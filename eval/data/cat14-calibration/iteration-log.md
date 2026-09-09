# Cat14: three prompt revisions on May 17, 2026

This experiment tested whether more detailed instructions improved advice informed by a person's track record. All three versions used the same eight probes, model, judge and fixtures on 2026-05-17.

The useful result was a failed improvement: instructions that seemed more careful made the answers sound more commanding or caused irrelevant bias claims. The team returned to the original prompt. These are historical measurements from that harness, not a fresh comparison of today's model.

The three tested prompt blocks below are preserved exactly.

## Version 1: one counterargument rule

```
Rules:
1. ONLY mention a bias if it is semantically relevant to the question's domain. Do not force-fit.
2. When you mention a bias, name BOTH priors transparently: "your prior says X; counter-prior from your track record says Y."
3. Adjust your recommendation in proportion to the bias strength.
4. Voice: friend, not doctor. Never "your Brier in this domain is 0.31." Use "you tend to miss" instead.
5. If no bias is relevant, answer as you would without the profile. Don't manufacture a counter-prior.
```

The calibrated answer won 75% of comparisons; baseline won 0% and 25% tied. Relevant-bias mentions scored 100%, appropriate counterarguments 75% (two misses), meaningful recommendation changes 63% (three misses), conversational voice 100%, and avoidance of irrelevant bias 100%. The recorded gate passed.

The two counterargument misses involved a good track record. The instruction to name both a prior and a counter-prior could produce an invented objection even when the history supported the person's judgment. Those probes expected no counter-prior.

## Version 2: distinguish a good record from a bad one

```
2. Bias tags come in two flavors:
   - "over-confident-X" tags signal the gut has been WRONG in domain X. Name BOTH priors and de-rate.
   - "well-calibrated-X" tags signal the gut has been RIGHT in domain X. Reinforce the gut WITHOUT manufacturing a counter-prior.
```

This version tried to fix that mistake directly. The calibrated win rate fell to 63%, with baseline wins at 25% and ties at 13%. Conversational voice fell to 88%, below the 95% gate. Counterarguments scored 88%, recommendation changes 63%, and irrelevant-bias avoidance 100%. The recorded gate failed.

Removing the counterargument instruction also let the model become too certain. Some answers sounded like commands, including “trust the pattern. Don't write the check.” The intended improvement in reasoning harmed the way the advice was delivered.

## Version 3: add explicit humility

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

The calibrated win rate returned to 75%, with baseline wins at 25% and no ties. But voice fell to 75%, below the 95% gate, and irrelevant-bias avoidance fell to 75%, below the 90% gate. The recorded gate failed on both.

The longer prompt sometimes appeared in the output itself: the answer repeated “Friend, not doctor.” Additional sub-rules also produced awkward hedging. More instructions had not produced more useful advice.

## Decision and limits

The experiment reverted to version 1: 75% calibrated wins, 100% conversational voice, 100% irrelevant-bias avoidance, and a passing gate. The two positive-track-record misses remained a v0.37 follow-up. Each iteration cost about $0.05 and took about three minutes.

This small experiment shows why a prompt change needs several checks. A better score on one reasoning criterion can coincide with worse tone or more irrelevant advice. It does not prove that longer prompts always perform worse, or that version 1 is best on every workload.

For the next revision, inspect whether the profile can be filtered more precisely before adding instructions. Keep the fixed negative-case thresholds, examine individual answers, and retain the simplest version that meets the measured requirements. The [current Cat14 guide](README.md) describes the runner after subsequent audit changes.
