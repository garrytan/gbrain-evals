---
id: 2026-11-01-particle-1-longmemeval-w10b
kind: finding
title: "particle-1 answers 91.4% of 500 LongMemEval questions on gbrain's retrieval, 1.4 to 5.6 points behind Opus 5.5, at a twenty-third of its list cost per correct answer (near ceiling, one protocol judge)"
status: open
grade: exploratory (the paired comparisons are named in the preregistration as descriptive; the second judge is a sensitivity added afterwards)
repo_commit: 095d8711 for the replay rows (#247); the recheck, the second-judge rows and this file arrive in the commit that adds them
prereg: ../benchmarks/2026-11-01-longmemeval-particle-replay/PREREGISTRATION.md (sha256 9f002bd920d7f26c9d2d8c280e08becf8ca84ab91363170a8f42f90540530885)
data: committed in this repository; 40 files with their SHA-256 in 2026-11-01-particle-1-longmemeval-w10b/SHA256SUMS
author: GBEV-25
reviewed_by: pending; reproduced_by: pending
disclosures: PENDING decision H
---

# particle-1 answers 91.4% of 500 LongMemEval questions on gbrain's retrieval, 1.4 to 5.6 points behind Opus 5.5, at a twenty-third of its list cost per correct answer (near ceiling, one protocol judge)

## What we found

We gave particle-1 the exact prompts that four frontier readers answered in October: 500 LongMemEval-S questions, each
with the conversations gbrain retrieved for it. Under LongMemEval's own judge (`gpt-4o-2024-08-06`), particle-1
answered 457 correctly (91.4%) against Opus 5.5's 474 (94.8%), a paired difference of -3.4 points (95% interval -5.6
to -1.4). It cost $0.0043 per correct answer at list price against Opus 5.5's $0.0993.

Against Sonnet 5.5 (462) and GPT-6.1 Sol (464), the protocol judge cannot tell particle-1 apart: the intervals are -3.2
to +1.0 and -3.6 to +0.6 points, and the test could only have detected a gap of about 3 points. This is not evidence
of parity. When each pair is judged instead by a model from a lab with no arm in that pair, particle-1 trails Sonnet
5.5 by 2.4 points (-4.6 to -0.4) and GPT-6.1 Sol by 3.4 points (-5.6 to -1.2).

## How it works

*An explanation, not a result.* Every reader here is near the ceiling, so the comparison turns on 29 to 31 questions
where two readers disagree. Most of particle-1's 17-question gap to Opus 5.5 is in two types: single-session-preference
(23 of 30 against 30) and multi-session (105 of 121 against 109). gbrain's notes prompt tells the reader to say "The
information is not available in the retrieved sessions; I don't know." when the sessions lack what it needs. particle-1
applies that rule, nearly word for word, to requests for advice, where LongMemEval's rubric expects the reader to use
preferences the user stated earlier ([replay report, the concrete case](../benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md#the-concrete-case)).
Its answers are also short: a median of 192 characters against 520 for Opus 5.5, 469 for Sonnet 5.5 and 167 for GPT-6.1
Sol. Open-ended rubric questions are where judges disagree most. Five of the 15 particle-1 answers that the
`claude-sonnet-5-5` judge marks wrong, against gpt-4o's right, are single-session-preference answers.

## Setup

- **Question.** Accuracy of particle-1 minus each frontier reader, paired by question, reading the same retrieved
  context.
- **Tasks.** The 500 questions of LongMemEval's cleaned `_s` split (`longmemeval_s_cleaned.json`, SHA-256
  `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, not committed). Each prompt holds the
  conversations behind gbrain `a7cb37b`'s top five retrieved passages, frozen on 2026-09-29 for W10 and rendered
  with gbrain's notes prompt.
- **Arms.** This is a reader comparison on fixed retrieval, so it has no skill or placebo arm. W10c's whole-history
  arms, where the reader gets the entire history and no retrieval, are summarised in the replay report.
  - `particle:particle-1`, effort `high`, `max_completion_tokens` 16,000, no temperature or seed, through
    Particle's API on 2026-11-01 (every response reported `particle-ai/particle-1` at the `default` tier).
  - `claude-opus-5-5` and `claude-sonnet-5-5` at `output_config.effort: "low"`, and `gpt-6.1-sol` at
    `reasoning_effort: "medium"`. These are W10's settings, run through the providers' batch APIs on 2026-10-06
    ([W10b](../benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md)).
  - particle-1's prompts are the comparators' committed request bodies, rebuilt and checked against W10's manifests
    (`body_sha256`), so every reader saw the same system and user text.
- **Protocol judge.** LongMemEval's official prompt (`evaluate_qa` answer check, protocol digest
  `efcf3d0d581bcd5e4b278c3a77378a0c97b15941c58e77ba93f2b5f216414753`) on `gpt-4o-2024-08-06`, temperature 0,
  10 output tokens. An answer is correct when the reply contains "yes". gpt-4o is an OpenAI model, so by protocol it
  judges the GPT-6.1 Sol arm from Sol's own lab.
- **Second judges (sensitivity, not counted).** The same prompt, run on 2026-11-01. Each pair is judged by a model from a
  lab with no arm in it: `gpt-6.1-sol` judges particle-1, Opus 5.5 and Sonnet 5.5, and `claude-sonnet-5-5` judges
  particle-1 and GPT-6.1 Sol. Both run at effort `low` with 2,000 output tokens, because a reasoning model cannot
  answer in 10. Neither provider offers a dated snapshot of these models. The receipt records each listing's date
  (gpt-6.1-sol created 2026-09-27, claude-sonnet-5-5 2026-09-28) and every response's model, which was the requested
  id in all 2,500.
- **Statistics.** Paired differences with 95% cluster-bootstrap intervals (10,000 draws, seed 20261101, the method of
  `eval/runner/compare.ts`) and exact two-sided McNemar tests. One answer per question per reader.

## Result

The preregistered rule for this comparison is decision B's stop rule. If the upper bound of particle-1 minus Opus 5.5
were below -10 points, the report would have to say so first. The upper bound is -1.4, so the rule does not fire. The
paired differences are preregistered as descriptive.

| Reader | Correct, protocol judge | particle-1 minus this reader (95% interval) | particle-1 wins / losses | McNemar p | Smallest gap detectable at 80% power | $ per correct, list |
|---|---|---|---|---|---|---|
| `particle-1` | **457 (91.4%)** | | | | | **$0.0043** |
| `claude-opus-5-5` | 474 (94.8%) | **-3.4 (-5.6 to -1.4)** | 6 / 23 | 0.002 | 3.0 | $0.0993 |
| `claude-sonnet-5-5` | 462 (92.4%) | -1.0 (-3.2 to +1.0) | 13 / 18 | 0.47 | 3.1 | $0.0500 |
| `gpt-6.1-sol` | 464 (92.8%) | -1.4 (-3.6 to +0.6) | 11 / 18 | 0.26 | 3.0 | $0.0381[^sol] |

[^sol]: $0.0307 as committed in the replay report. W10 settled GPT-6.1 Sol's rows before the budget ledger priced
    OpenAI cache writes, and Sol's responses report almost every prompt token as a cache write, which OpenAI prices at
    $2.50 per million rather than $2.00. See [corrections](../corrections.md#longmemeval).

**Sensitivity: cross-family second judges.** Not counted. Agreement and Cohen's kappa are measured against the protocol
judge's verdicts on the same answers.

| Judge | Arm | Correct, protocol judge | Correct, second judge | Agreement | Kappa | Right to wrong | Wrong to right |
|---|---|---|---|---|---|---|---|
| `gpt-6.1-sol` | particle-1 | 457 | 456 | 97.4% | 0.836 | 7 | 6 |
| `gpt-6.1-sol` | Opus 5.5 | 474 | 480 | 98.4% | 0.818 | 1 | 7 |
| `gpt-6.1-sol` | Sonnet 5.5 | 462 | 468 | 98.0% | 0.846 | 2 | 8 |
| `claude-sonnet-5-5` | particle-1 | 457 | 444 | 96.6% | 0.810 | 15 | 2 |
| `claude-sonnet-5-5` | GPT-6.1 Sol | 464 | 461 | 98.2% | 0.870 | 6 | 3 |

| particle-1 minus | Protocol judge | Cross-family judge | Second judge's difference (95% interval) | Wins / losses | McNemar p | Interval moves? |
|---|---|---|---|---|---|---|
| Opus 5.5 | -3.4 (-5.6 to -1.4) | `gpt-6.1-sol` | -4.8 (-6.8 to -3.0) | 1 / 25 | < 0.001 | no: still excludes zero |
| Sonnet 5.5 | -1.0 (-3.2 to +1.0) | `gpt-6.1-sol` | -2.4 (-4.6 to -0.4) | 9 / 21 | 0.043 | yes: now excludes zero |
| GPT-6.1 Sol | -1.4 (-3.6 to +0.6) | `claude-sonnet-5-5` | -3.4 (-5.6 to -1.2) | 8 / 25 | 0.005 | yes: now excludes zero |

The `gpt-6.1-sol` judge is stable. On the Opus 5.5 and Sonnet 5.5 answers, W10 ran the same model as its secondary
judge in October. Those verdicts give the same totals (480 and 468) and agree with this run on 498 of 500 answers for
each arm. Every judgment is in the second-judge rows, and the per-type counts and every figure above are in
[analysis.txt](2026-11-01-particle-1-longmemeval-w10b/analysis.txt).

## Cost

Reader cost on the 500 questions, from each row's token usage at the list prices below. Judging is excluded.

| Reader | Mean input / output tokens per question | List $ per question | List $ per correct | Batch $ per correct | Arm total, list |
|---|---|---|---|---|---|
| `particle-1` | 13,951 / 425 (357 of them reasoning) | $0.0039 | $0.0043 | none | $1.96 |
| `claude-opus-5-5` | 22,077 / 294 | $0.0942 | $0.0993 | $0.0497 | $47.09 |
| `claude-sonnet-5-5` | 22,077 / 203 | $0.0462 | $0.0500 | $0.0250 | $23.09 |
| `gpt-6.1-sol` | 13,695 / 110 | $0.0353 | $0.0381 | $0.0190 | $17.67 |

At list price, particle-1's cost per correct answer is about a twenty-third of Opus 5.5's, a twelfth of Sonnet 5.5's
and a ninth of GPT-6.1 Sol's. Input tokens are as each provider counts them; particle-1's listing names DeepSeek's
tokenizer, and the Anthropic readers count about 60% more tokens for the same text than the other two. particle-1 has
no batch API. Every particle-1 call in the replay ran in Particle's off-peak window, so Particle's charge was about half
the list figure, about $0.0021 per correct answer. The comparators ran through batch APIs at half the list price.

**Price table**, USD per million tokens, checked on 2026-11-01 against each provider's page:

| Model | Input | Cache write | Output | Discount | Source |
|---|---|---|---|---|---|
| `particle-1` | $0.25 | none reported | $1.00 | 50% off-peak (20:30 to 04:00 New York time) and 50% on the flex tier; neither applied to the list figures | [Particle usage and billing](https://docs.particle.ai/usage-billing) |
| `claude-opus-5-5` | $4.00 | none reported | $20.00 | Batch API 50% | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| `claude-sonnet-5-5` | $2.00 | none reported | $10.00 | Batch API 50% | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| `gpt-6.1-sol` | $2.00 | $2.50 | $10.00 | Batch API 50% | [OpenAI pricing](https://developers.openai.com/api/docs/pricing) |
| `gpt-4o-2024-08-06` (protocol judge) | $2.50 | none reported | $10.00 | none used | [OpenAI pricing](https://developers.openai.com/api/docs/pricing) (listed as `gpt-4o`) |

**Cache tokens.** No reader's rows report cached reads. GPT-6.1 Sol's rows report 6,845,950 of their 6,847,450 prompt
tokens as cache writes, which are priced at the cache-write rate above. The replay report and W10 priced them at the
input rate, which is where the committed $0.0307 comes from. OpenAI's billing API refused our key, so the invoice could
not be checked; the Sol figures follow OpenAI's published rate and the usage the responses reported.

**Judging and this finding's spend.** The replay's gpt-4o judging cost $0.48 for all four of its arms. The second
judges cost $1.61 from the budget ledger (2,497 requests, including 6 in the smoke test): `gpt-6.1-sol` $0.86 for
1,500 judgments, `claude-sonnet-5-5` $0.75 for 1,000. The cap was $25, with a stop at $20.

## Why null? (R48)

This section covers the two comparisons the protocol judge cannot separate: particle-1 against Sonnet 5.5 and against
GPT-6.1 Sol.

- **Exposure.** particle-1 read every prompt in full, with the same text the comparators read. It answered all 500,
  with no reader errors and no answer cut off at its output limit, and spent 357 reasoning tokens per answer on average.
- **Task fit.** Answering from retrieved conversations is the whole reader task, and the 500 questions span all seven
  of LongMemEval's question types. particle-1's weak spot is single-session-preference (23 of 30, against 29 for both
  Sonnet 5.5 and GPT-6.1 Sol), where the rubric rewards using remembered preferences over saying the fact is missing.
- **Power and saturation.** Sonnet 5.5 and GPT-6.1 Sol answer 92.4% and 92.8%, so 36 to 38 questions are left to
  separate the readers, and 31 and 29 questions are discordant. With 500 pairs the test has 80% power for about 3.1
  and 3.0 points. The observed gaps of 1.0 and 1.4 points are below that, so the null is not evidence of no effect.
- **Frontier competence.** Today's frontier readers already score 92% to 95% on this retrieval, so particle-1 offers
  lower cost here, not higher accuracy.
- **Judge.** Both cross-family judges put particle-1 behind, by 2.4 and 3.4 points, with intervals that exclude zero.
  So the null depends on the judge as well as on power.
- **Verdict: FIX-METHOD.** This benchmark, at this ceiling and with one judge, cannot settle whether particle-1 matches
  Sonnet 5.5 or GPT-6.1 Sol as a reader. A useful next test is a harder memory set where readers score well below 90%,
  with a preregistered non-inferiority margin and a second judge counted beside the protocol judge.

## Limits and threats

- **Ceiling and power.** Every reader scores 91% to 95%. The gap to Opus 5.5 rests on 29 discordant questions, and the
  gaps to Sonnet 5.5 and GPT-6.1 Sol are below what the test can detect.
- **One protocol judge.** The counted verdicts come from one OpenAI model, which also judges the GPT-6.1 Sol arm. The
  [W8 control](../benchmarks/2026-10-06-w8-longmemeval-control.md) shows that the official judge accepts some "the
  information is not available" answers to answerable questions. The second judges are not counted, differ from the
  protocol in output room and reasoning, and have no dated snapshot. A rerun of all four arms judged by Gemini, a lab
  with no arm in this comparison, is future work.
- **One sample per question.** Each reader answered once at the provider's default sampling.
  [W10a](../benchmarks/2026-10-07-longmemeval-w10a-current-pin.md) found two identical runs of one reader differing on
  13 of 500 answers. particle-1 is not deterministic even at temperature 0 with a seed: in the replay's weight canary,
  1 to 3 of 12 answers changed between back-to-back runs.
- **Settings are W10's, not matched.** particle-1 ran at effort `high`, Opus 5.5 and Sonnet 5.5 at `low`, and GPT-6.1
  Sol at `medium`. Other settings would change both accuracy and cost. At effort `none`, particle-1 lost 11.3
  points on W10c's 150 questions (118 against 135).
- **Retrieval and time.** The retrieval is gbrain `a7cb37b` from 2026-09-29, not today's pin. The comparators
  answered through batch APIs on 2026-10-06, and particle-1 answered through Particle's real-time API on 2026-11-01.
- **Public, development data.** LongMemEval-S is public and has been used throughout gbrain's development, so the
  questions are not held out, and models may have seen them in training.
- **Cost.** List prices come from the providers' pages on 2026-11-01. The GPT-6.1 Sol invoice is unconfirmed, and
  Particle's charge is estimated from usage fields, because Particle has no API that reads the credit balance.
- **What this does not show.** Anything about gbrain's retrieval, other memory tasks, or particle-1 as an agent or as a
  memory writer.

## Replicate it

1. **Reanalysis, keyless.** Python 3's standard library is the only requirement.

   ```bash
   git clone https://github.com/garrytan/gbrain-evals && cd gbrain-evals
   git checkout <the commit that adds this file>
   sha256sum -c docs/findings/2026-11-01-particle-1-longmemeval-w10b/SHA256SUMS
   python3 scripts/finding-particle-w10b.py --check
   ```

   The script recounts every number in this file from the per-question rows. That covers verdicts from the stored judge
   replies, the paired intervals with `compare.ts`'s bootstrap, cost from each row's token usage and the price table,
   and the second-judge agreement. It checks the digests and the replay's `summary.json` first. `--check` exits 1
   unless its output equals the committed [analysis.txt](2026-11-01-particle-1-longmemeval-w10b/analysis.txt) and
   [analysis.json](2026-11-01-particle-1-longmemeval-w10b/analysis.json) byte for byte.

2. **Rerun the second judges, paid, about $1.61.** This needs `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, Bun and
   `jq`. The budget ledger is a local SQLite file.

   ```bash
   bun install --frozen-lockfile
   bun eval/runner/budget-ledger.ts init --budget-ledger <ledger> --program-cap-usd 25
   RUN=$(bun eval/runner/budget-ledger.ts open --budget-ledger <ledger> --runner w10-particle-second-judge --budget-usd 20 --estimate-usd 10 | jq -r .run_id)
   bun eval/runner/batch/w10-particle-second-judge.ts run --out <fresh dir> --budget-ledger <ledger> --paid --budget-run-id $RUN
   ```

   The fresh run's `rows.ndjson` files can replace the committed ones under
   `docs/findings/2026-11-01-particle-1-longmemeval-w10b/second-judge/` for the script to read. Expect a few verdicts
   per arm to differ: the same judge agreed with itself on 498 of 500 answers a month apart.

3. **Rerun particle-1, paid, about $2 at list price for the 500 questions (about half off-peak).** This needs
   `PARTICLE_API_KEY` and the LongMemEval file above. The commands are in the
   [replay report's reproduce section](../benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md#reproduce-and-inspect).
   A rerun is a fresh sample, so expect differences of the size the canary and W10a show, not the same 457.

## What is held out, and why

Nothing. LongMemEval-S is public, and its attribution is in [the credits](../../eval/CREDITS.md). This repository does
not redistribute the dataset file, but it commits the request manifests and every answer, judge reply and receipt
behind this file. The 40 files the numbers come from are listed with their digests in
[SHA256SUMS](2026-11-01-particle-1-longmemeval-w10b/SHA256SUMS).

## Changelog

### 2026-11-01: First version

Written from the particle-1 replay (#247), a keyless recheck of its rows, and the cross-family second-judge
sensitivity. The recheck reproduced every count and interval in the replay report and found three cost corrections:
Opus 5.5's list cost per correct answer ($0.0993, not $0.0994), the batch-rate figures for Opus 5.5 and Sonnet 5.5
($0.0497 and $0.0250, not $0.0507 and $0.0255), and GPT-6.1 Sol's costs at OpenAI's cache-write rate. All three are in
[corrections](../corrections.md#longmemeval). The disclosure line waits on decision H.
