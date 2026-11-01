# particle-1 on W10's LongMemEval prompts: 3.4 points behind Opus 5.5 at about a twenty-third of the cost per correct answer

Measured 2026-11-01, 05:46 to 05:59 UTC. Status: **Complete** (all four arms, 500 + 3 × 150 questions, no reader errors, no truncated answers, preregistered bars 1 to 4 pass in every arm). Evidence class: development (LongMemEval-S was used to tune gbrain's retrieval). Reader under test: Particle AI's `particle-1` (`particle:particle-1`), `reasoning_effort: "high"` with 16,000 `max_completion_tokens`, plus one descriptive arm at `"none"`. Comparators: the committed W10 rows of `claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol`; no comparator model was called again. Judge: LongMemEval's official prompt on `gpt-4o-2024-08-06`, W10's primary judge. [Preregistration](PREREGISTRATION.md) at `85f55688`, amended at `b6e7f7aa` before any paid call; runner `eval/runner/batch/w10-particle.ts` at `e29ad9c1`. **The 500-question and 150-question tables are separate cohorts; do not set one beside the other.**

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. [LongMemEval](https://arxiv.org/abs/2410.10813) asks questions about long histories of old conversations. In October, W10 measured which reader model should read gbrain's retrieval ([W10b](../2026-10-07-longmemeval-w10b-reader-replay.md), 500 questions on frozen gbrain `a7cb37b` retrieval) and whether gbrain's retrieval holds up against pasting the whole history into the reader ([W10c](../2026-10-07-longmemeval-w10c-full-context.md), 150 questions). particle-1 is a low-cost reasoning model with a 1,048,576-token window, served through an OpenAI-compatible API at $0.25 per million input tokens and $1.00 per million output tokens. This replay sends particle-1 the exact prompts W10's readers received, byte for byte, and pairs its answers question by question with theirs.

## The finding

**particle-1 answers 457 of 500 W10b questions, 3.4 points behind Opus 5.5 and within 1.5 points of Sonnet 5.5 and GPT-6.1 Sol, for about a twenty-third of Opus 5.5's cost per correct answer.** The paired difference against Opus 5.5 is -3.4 points (95% interval -5.6 to -1.4, exact McNemar p = 0.002); against Sonnet 5.5 and GPT-6.1 Sol the intervals include zero. particle-1 cost $0.0043 per correct answer at list price, against $0.099 for Opus 5.5 at list ($0.051 at the batch price W10 paid). Decision B's stop rule (an upper bound below -10 points against Opus 5.5) does not fire: the upper bound is -1.4.

**Most of the gap to Opus 5.5 is in preference questions, where particle-1 treats a request for advice as a lookup and declines.** Seven of the 17 net questions are single-session-preference questions: Opus 5.5 answered all 30, particle-1 23. The concrete case below shows the pattern.

**On W10c's 150 questions, gbrain's retrieval stays within the preregistered 7-point margin of particle-1 reading the whole history.** particle-1 answered 140 with the whole history (about 108,000 tokens per question) and 135 on gbrain's `c5fb0201` retrieval (about 14,000). Decision G's test passes both comparisons after Holm, particle-1 on gbrain's retrieval against particle-1 on the whole history (one-sided p = 0.036) and Sonnet 5.5 on gbrain's retrieval (W10a's 139) against particle-1 on the whole history (p = 0.035). The first pass is narrow and depends on the test. It rests on nine questions where the two arms disagree (2 for gbrain, 7 against), and Tango's score test, which estimates the variance under the null hypothesis, gives p = 0.060. The registered test is the paired bootstrap, so the verdict stands as registered. As in W10c, this is "within 7 points", not "the same".

**At this history size, a cheap whole-history reader narrows gbrain's cost case.** With particle-1 as the reader, gbrain's recurring cost per question is still about a sixth of the whole history's ($0.0047 against $0.0275 at list, rerank included). But particle-1 reading the whole history costs about what Sonnet 5.5 reading gbrain's retrieval costs at W10's batch price ($0.024), and a little over half of Sonnet's list price ($0.047), while answering 140 against Sonnet-on-gbrain's 139. README's "a seventh of the recurring cost" holds for a fixed reader; across readers it no longer separates gbrain from a long-context model at about 115,000 tokens of history. Per decision G, this report says so; moving README's headline toward histories past 1M tokens is a separate decision.

**The development-lane test is inconclusive, so the development loop stays on Sonnet 5.5.** particle-1's whole-history minus old-retrieval difference is +2.7 points, the same sign as Sonnet 5.5's +6.7, but its interval (-0.7 to +6.7) includes zero. Its agreement with Sonnet 5.5 on the whole history (92.0%) is within 5 points of GPT-6.1 Sol's (92.7%). By the preregistered rule, inconclusive leaves the lane on Sonnet 5.5 and spends nothing more.

**Reasoning effort matters: at `none`, particle-1 loses 11.3 points** on gbrain's retrieval (118 against 135 of 150; interval -18.0 to -4.7). Counted cells keep `high`.

## The concrete case

*From the data.* Question `09d032c9` (single-session-preference) asks: "I've been having trouble with the battery life on my phone lately. Any tips?" LongMemEval's rubric wants advice that builds on what the user said before, here a portable power bank they bought. Opus 5.5 found the power-bank conversation in the retrieved sessions, said what it did not know, and gave tips around it; the judge accepted it. particle-1 read the same prompt and answered: "The information is not available in the retrieved sessions; I don't know what phone battery-life tips were previously discussed." Question `0edc2aef` ("Can you suggest a hotel for my upcoming trip to Miami?") goes the same way: Opus 5.5 carried over the user's earlier taste for city views and rooftop pools; particle-1 said the Miami trip never came up and asked for preferences. gbrain's notes prompt tells the reader that if the retrieved sessions do not contain the information needed, it should say so ("The information is not available in the retrieved sessions; I don't know.") instead of guessing. particle-1 applies that rule, nearly word for word, to requests for advice, where the rubric expects remembered preferences rather than a stated fact.

## The experiment

- **Prompts.** Each comparator's committed request bodies, rebuilt with `eval/runner/batch/sources.ts` and checked against W10's manifests (`body_sha256`, [manifests](../2026-10-06-longmemeval-w10-manifests/)), then reduced to their system and user text; the Anthropic-shaped and OpenAI-shaped bodies of every question carry identical text. W10b's three arms and W10's current-pin arms rebuild at today's gbrain pin. The two whole-history arms do not, because today's pinned gbrain renders 91 of 150 bodies differently. As the plan provides, they were rendered from a gbrain `c5fb0201` (v0.60.95.0) checkout, where all 150 of both arms match ([build.json](build.json)).
- **Arms.** R1, `w10b-particle-notes`: the 500 W10b notes prompts on frozen gbrain `a7cb37b` retrieval. R2, on W10c's 150 stratified questions: `w10c-particle-currentpin`, W10's current-pin notes prompts on gbrain `c5fb0201` retrieval (the text W10a's Sonnet 5.5 and W10c's GPT-6.1 Sol read); `w10c-particle-full`, the whole history (`gbrain-lme-reader-v4-notes-fullsessions`); and `w10c-particle-currentpin-none`, the current-pin prompts at effort `none`.
- **Reader.** `particle:particle-1` through qa-v2's `ChatClient`: system and user messages, `reasoning_effort` sent explicitly, `max_completion_tokens` 16,000, no temperature or seed; up to 5 attempts, a 900-second deadline per attempt, 8 questions at a time, under the budget ledger. Every response reported `particle-ai/particle-1` at the `default` service tier and no weight version.
- **Comparator settings (W10's).** Opus 5.5 and Sonnet 5.5 at `output_config.effort: "low"`; GPT-6.1 Sol at `reasoning_effort: "medium"`. particle-1 ran at `high`, the setting counted cells use.
- **Judge and scoring.** LongMemEval's official prompt on `gpt-4o-2024-08-06`, temperature 0, 10 tokens, correct when the reply contains "yes". An answer cut off at its output limit would be judged as written and never retried; none was. An empty answer would be wrong without a judge call; none was. No secondary judge ran.
- **Tests.** Paired differences with 95% bootstrap intervals and exact McNemar tests (`eval/runner/compare.ts`, 10,000 draws, seed 20261101). Decision G: paired non-inferiority at 7 points, Holm across two ([family](families/g-noninferiority.json)). The development-lane test as preregistered. Everything else is descriptive.

## Results

### R1: the 500 W10b questions, frozen gbrain `a7cb37b` retrieval

| Reader | Effort | Correct, official judge | particle-1 minus this reader (95% interval) | particle-1 wins / losses | McNemar p | Mean input tokens | Mean output tokens | $ per correct, list | $ per correct, batch |
|---|---|---|---|---|---|---|---|---|---|
| `particle-1` | high | **457 (91.4%)** | | | | 13,951 | 425 | **$0.0043** | none (no batch API) |
| `claude-opus-5-5` | low | 474 (94.8%) | **-3.4 (-5.6 to -1.4)** | 6 / 23 | 0.002 | 22,077 | 294 | $0.0994 | $0.0507 |
| `claude-sonnet-5-5` | low | 462 (92.4%) | -1.0 (-3.2 to +1.0) | 13 / 18 | 0.47 | 22,077 | 203 | $0.0500 | $0.0255 |
| `gpt-6.1-sol` | medium | 464 (92.8%) | -1.4 (-3.6 to +0.6) | 11 / 18 | 0.26 | 13,695 | 110 | $0.0307 | $0.0154 |

Input tokens are as each provider counts them (particle-1's listing names DeepSeek's tokenizer). particle-1's output includes 357 reasoning tokens per answer on average. Its latency, wall time per reader call with retries, was 3.7 s at the median and 14.9 s at p95; the comparators ran through batch APIs, which record no latency.

| Question type | Questions | `particle-1` | `claude-opus-5-5` |
|---|---|---|---|
| single-session-preference | 30 | 23 | 30 |
| multi-session | 121 | 105 | 109 |
| knowledge-update | 72 | 67 | 70 |
| single-session-user | 64 | 62 | 64 |
| abstention | 30 | 28 | 29 |
| temporal-reasoning | 127 | 116 | 117 |
| single-session-assistant | 56 | 56 | 55 |
| **Total** | **500** | **457** | **474** |

### R2: W10c's 150 questions, 150-question pairs only

| Reader | Prompt | Effort | Correct, official judge | Mean input tokens | Mean output tokens | Reader $ per question, list | Reader $ per question, batch | Latency p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| `particle-1` | whole history | high | **140 (93.3%)** | 108,220 | 487 | $0.0275 | none | 7.1 s / 18.7 s |
| `particle-1` | gbrain `c5fb0201` | high | **135 (90.0%)** | 14,052 | 452 | $0.0040 | none | 4.1 s / 26.7 s (30 calls) |
| `particle-1` | gbrain `c5fb0201` | none | 118 (78.7%) | 14,027 | 127 | $0.0036 | none | 2.9 s / 6.7 s |
| `claude-sonnet-5-5` | whole history | low | 144 (96.0%) | 171,596 | 234 | $0.3455 | $0.1728 | not measured |
| `claude-sonnet-5-5` | gbrain `c5fb0201` (W10a) | low | 139 (92.7%) | 22,242 | 210 | $0.0466 | $0.0233 | not measured |
| `gpt-6.1-sol` | whole history | medium | 141 (94.0%) | 106,683 | 116 | $0.2145 | $0.1073 | not measured |
| `gpt-6.1-sol` | gbrain `c5fb0201` | medium | 137 (91.3%) | 13,794 | 114 | $0.0287 | $0.0144 | not measured |

Paired differences on these 150 questions (95% intervals; wins and losses are for the first-named arm):

| Contrast | Difference, points | Wins / losses | McNemar p |
|---|---|---|---|
| particle-1: gbrain minus whole history | -3.3 (-7.3 to +0.7) | 2 / 7 | 0.18 |
| whole history: particle-1 minus Sonnet 5.5 | -2.7 (-7.3 to +2.0) | 4 / 8 | 0.39 |
| whole history: particle-1 minus GPT-6.1 Sol | -0.7 (-5.3 to +3.3) | 5 / 6 | 1.00 |
| gbrain: particle-1 minus Sonnet 5.5 | -2.7 (-8.0 to +2.7) | 6 / 10 | 0.45 |
| gbrain: particle-1 minus GPT-6.1 Sol | -1.3 (-5.3 to +2.7) | 4 / 6 | 0.75 |
| particle-1: whole history minus old retrieval (`a7cb37b`) | +2.7 (-0.7 to +6.7) | 6 / 2 | 0.29 |
| Sonnet 5.5: whole history minus old retrieval | +6.7 (+2.0 to +11.3) | 12 / 2 | 0.013 |
| GPT-6.1 Sol: whole history minus old retrieval | +2.7 (+0.7 to +5.3) | 4 / 0 | 0.125 |
| particle-1 on gbrain: `none` minus `high` | -11.3 (-18.0 to -4.7) | 5 / 22 | 0.002 |

### Decision G: gbrain's retrieval against particle-1's whole history

| Comparison (B against A = particle-1, whole history) | B correct | A correct | B minus A (95% interval) | One-sided p | Holm p | Verdict |
|---|---|---|---|---|---|---|
| particle-1 on gbrain's retrieval | 135 | 140 | -3.3 (-7.3 to +0.7) | 0.036 | 0.036 | non-inferior at 7 points |
| Sonnet 5.5 on gbrain's retrieval (W10a) | 139 | 140 | -0.7 (-6.7 to +5.3) | 0.017 | 0.035 | non-inferior at 7 points |

The two-sided 95% interval for the first comparison reaches -7.3 points; the preregistered test is one-sided at alpha 0.05, which corresponds to a 90% interval, and it passes. That pass depends on the method. The paired bootstrap estimates the variance from the observed disagreement (9 of 150 questions), while Tango's score test, the usual paired non-inferiority test, estimates it under the null and gives T = 1.557 and one-sided p = 0.060, which fails at alpha 0.05 (`tango` under decision G in summary.json). The second comparison passes under either test (Tango p = 0.022). Under Tango with Holm, only the Sonnet 5.5 comparison would pass. Per question type, particle-1's net five-question gap comes from temporal reasoning (33 against 36), multi-session (32 against 33) and single-session-user (18 against 19); knowledge updates (one more for gbrain) and abstention (one more for the whole history) cancel.

### The development-lane test

| Measure | particle-1 | Bar | Met |
|---|---|---|---|
| Whole history minus old retrieval | +2.7 points (-0.7 to +6.7) | Sonnet 5.5's sign (+6.7) with an interval excluding zero | sign yes, interval no |
| Agreement with Sonnet 5.5 on the whole history | 92.0% | no more than 5 points below GPT-6.1 Sol's 92.7% | yes |
| **Verdict** | **inconclusive** | | |

The replay's bootstrap also gives GPT-6.1 Sol's own whole-history contrast an interval that excludes zero, but with four wins and no losses its exact McNemar p is 0.125; the preregistered test uses Sonnet 5.5's sign, which either reading leaves unchanged.

### Cost per W10c question

| | particle-1, gbrain | particle-1, whole history | Sonnet 5.5, gbrain | Sonnet 5.5, whole history |
|---|---|---|---|---|
| Reader, list price | $0.0040 | $0.0275 | $0.0466 | $0.3455 |
| Reader, W10's batch price | none | none | $0.0233 | $0.1728 |
| Retrieval query (Voyage rerank, from W10c) | $0.0007 | none | $0.0007 | none |
| One-time embedding of each history (from W10c) | $0.015 | none | $0.015 | none |

particle-1's list price is Particle's peak default. Particle charges half in its off-peak window (20:30 to 04:00 New York time); every particle-1 call in this replay ran off-peak, so Particle's actual charge was about half the list figures here. Judging is excluded.

### Preregistered bars

| Arm | Particle requests sent | Ledger $ (usage-field $) | Receipts complete | `finish: length` | Failed after retries | Bars 1 to 4 |
|---|---|---|---|---|---|---|
| `w10b-particle-notes` | 500 | 1.9565 (1.9565) | 500 of 500 | 0 of 500 | 0 of 500 | pass |
| `w10c-particle-currentpin` | 30 | 0.1168 (0.1168) | 30 of 30 | 0 of 150 | 0 of 150 | pass |
| `w10c-particle-full` | 150 | 4.1313 (4.1313) | 150 of 150 | 0 of 150 | 0 of 150 | pass |
| `w10c-particle-currentpin-none` | 150 | 0.5450 (0.5450) | 150 of 150 | 0 of 150 | 0 of 150 | pass |

Bar 1 reconciles on the usage-field basis, a named deviation approved before the run: Particle has no API that reads the credit balance, and the balance is shared across the account's keys ([amendment log](PREREGISTRATION.md#amendment-log)). No request went to a host the ledger could not price, and every particle request has one reconciled ledger entry. Bar 5 is Cat 40's and was not part of this replay.

### Weight canary and serving noise

Before R1, the weight canary (`scripts/particle-canary.ts`: 12 short prompts at effort `none`, temperature 0, a fixed seed, log probabilities) ran as three back-to-back pairs about ten seconds apart. Between the runs of a pair, 3, 1 and 2 of the 12 answers changed, and the mean per-answer log probability moved 0.0153, 0.0025 and 0.0062; no response model, fingerprint, weight version or tier changed. particle-1 is not deterministic at temperature 0 with a seed, so the canary can flag only large shifts. Its default warning thresholds are now more than 3 changed answers or a mean move above 0.02, and the six records are in [the canary history](../particle-canary/history.jsonl).

## What to use and what to avoid

- **Use particle-1 where cost per correct answer matters and a few points of accuracy do not.** On gbrain's retrieval it is within 1.5 points of Sonnet 5.5 and GPT-6.1 Sol at about a twelfth and a seventh of their list cost per correct answer. Opus 5.5 is still 3.4 points better, and that gap is real (p = 0.002).
- **Avoid particle-1 for preference-style requests without a prompt change.** It treats "any tips?" as a lookup and abstains when the retrieved sessions hold no explicit answer.
- **Keep `reasoning_effort: "high"`.** `none` saves only about 10% of the reader cost here and loses 11 points.
- **Read decision G with its margin.** gbrain on particle-1 is within 7 points of particle-1 on the whole history by the registered test, five questions behind on 150, and a score test puts it just outside; multi-session and temporal questions still favor the whole history.
- **Do not move the development loop to particle-1 yet.** The test was inconclusive, which by the preregistered rule leaves it on Sonnet 5.5.

## Deviations and disclosures

- **Bar 1's basis** is the usage-field total, not the change in Particle's balance; approved by the Captain before the run and recorded in the amendment log.
- **Whole-history rendering.** The whole-history prompts came from a gbrain `c5fb0201` checkout because today's pin renders 91 of 150 differently; this is the plan's own fallback, recorded in [build.json](build.json).
- **Shared answers between R1 and the current-pin arm.** For 120 of the 150 W10c questions, the current-pin prompt is byte-identical to the W10b prompt (both retrievals returned the same sessions), so those 120 particle-1 answers are R1's answers, served from the response cache rather than sampled again (`from_cache: true` in the rows). They are particle-1's answers to exactly that prompt at the same settings, but a fresh call could differ (see the canary's noise), and the arm's latency covers only its 30 uncached calls. Its reader cost per question counts every answer at the price R1 paid for it. The judge cache likewise served 128 repeated judge prompts.
- **No new comparator calls.** W10c has no Opus 5.5 rows, so R2 compares particle-1 with Sonnet 5.5 and GPT-6.1 Sol only. Comparators ran at W10's efforts (`low` and `medium`), particle-1 at `high`.
- **Prices.** List prices throughout; W10's comparators paid batch prices (half of list), shown as a second column. Particle offers no batch API.

## Reproduce and inspect

Keys: `PARTICLE_API_KEY` for the reader and `OPENAI_API_KEY` for the judge. Dataset: LongMemEval-S cleaned, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.

```bash
# $0: rebuild and check every comparator body, render the whole-history prompts from gbrain c5fb0201
git clone https://github.com/garrytan/gbrain /tmp/gbrain-c5fb0201 && git -C /tmp/gbrain-c5fb0201 checkout c5fb0201d1960a0a5a81c35d77718311b03154b7
# W10_PARTICLE_STATE_DIR holds the saved prompt text and the response cache. Effort and output limit are part of the cache
# key, so from an empty one each distinct prompt is paid once at each effort: 120 current-pin prompts repeat R1's and replay
# from the cache, while the effort-none arm pays again for the 150 prompts the current-pin arm answered at high
export W10_PARTICLE_STATE_DIR=<an empty directory>
LME_DATASET=<longmemeval_s_cleaned.json> W10_STATE_DIR=<another empty directory> \
  bun eval/runner/batch/w10-particle.ts build --gbrain-c5fb0201 /tmp/gbrain-c5fb0201

# paid, under one ledger run (this replay: $7.23 at list price)
RUN=$(bun eval/runner/budget-ledger.ts open --runner w10-particle-u3 --budget-usd 12 --estimate-usd 10.8)
# this replay wrote here; a rerun takes a fresh OUT, because run refuses an --out that already holds rows,
# and preflight and the canary would overwrite the committed records
OUT=docs/benchmarks/2026-11-01-longmemeval-particle-replay
bun eval/runner/batch/w10-particle.ts preflight --out $OUT/preflight --paid --budget-run-id $RUN
bun scripts/particle-canary.ts --paid --budget-run-id $RUN --out $OUT/canary/pair-1-a   # then pair-1-b with --compare, and pairs 2 and 3
for arm in w10b-particle-notes w10c-particle-currentpin w10c-particle-full w10c-particle-currentpin-none; do
  bun eval/runner/batch/w10-particle.ts run $arm --out $OUT/arms/$arm --paid --budget-run-id $RUN
done

# $0: re-score the committed rows; exits 1 if summary.json or a compare file differs, or a compare file is stale
bun eval/runner/batch/w10-particle.ts report docs/benchmarks/2026-11-01-longmemeval-particle-replay
```

Observed time: R1 6.5 minutes, R2's three arms 5 minutes. Observed cost, from the ledger's usage fields at list price: $7.23 (particle-1 $6.75 over 903 requests, the gpt-4o judge $0.48 over 823); about $3.38 of Particle's share at its off-peak price. Per arm: R1 $2.23, current pin $0.13, whole history $4.21, `none` $0.65, canary and preflight under $0.01.

Files: per-arm [rows](arms/), receipts (one per attempt) and `receipt.json` (bars, counts, tokens, ledger, attestation); [summary.json](summary.json) and the `compare-*.ndjson` paired files; [build.json](build.json); [preflight](preflight/preflight.json); [canary records](canary/).
