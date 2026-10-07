# LongMemEval answers notice the wrong conversations: a live negative control

Measured 2026-10-06. Status: **Complete** (control 100 of 100 questions, partial fault 50 of 50). Evidence class: harness validity, on development data. Reader `claude-sonnet-5-5`; request text from gbrain `a7cb37b` (the 2026-09-29 reranked retrieval); judge LongMemEval's official `gpt-4o-2024-08-06`.

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. [LongMemEval](https://arxiv.org/abs/2410.10813) asks questions about long histories of old conversations: gbrain finds the relevant conversations, a reader model answers from them, and a judge model grades the answer. A benchmark score that stays high when the reader is handed the wrong conversations would measure the reader's guessing, not the memory system. This control checks that.

## The finding

**The answer score drops sharply when retrieval is broken, so LongMemEval answers keep their gate status.** With its own retrieved conversations, the reader answered 91 of 100 questions correctly. Given another question's conversations instead, it answered 19 of 100. The preregistered rule is that the broken arm must score at most half the real arm; 19 is 0.21 of 91, so the control **passes**. The real arm is above its signal floor of 50.

**Losing one conversation is enough to break most answers.** Removing only the best-ranked conversation that holds the answer, and keeping the other four, took the score on 50 questions from 47 to 7 (40 answers lost, none gained, exact McNemar p = 1.8e-12). This arm is report-only; it shows the score is sensitive to a realistic partial fault, not just to a total one.

**The 19 "correct" broken answers are judge mistakes.** In every one of the 19, the reader said the information was not available, which is the right behavior with the wrong conversations, and the official judge still replied "Yes" (the provider's own batch output confirms the replies). The official judge accepted a "not available" answer to an answerable question 19 times in 100 here. Real arms rarely abstain on answerable questions, so this inflates them far less, but it is a property of the official judge worth knowing; see [the judge note](#the-judge-accepts-some-not-available-answers).

## The concrete case

Question `129d1232` asks "How much money did I raise in total through all the charity events I participated in?" The reference answer is $5,850, spread across several conversations. In the broken arm the reader received five conversations retrieved for a different question, about baking, meal planning and gift ideas. It replied that none of them mention charity events and that it could not say. That is the answer a careful reader should give. The official judge graded it correct.

## The experiment

- **Sample.** 100 of the 470 answerable LongMemEval-S questions, a seeded random sample (seed `20261006`). The 30 abstention questions are excluded because the injection cannot apply to them: with the wrong conversations, "the information is not available" stays the correct answer to an unanswerable question.
- **Real arm.** The reader's answers from the W10b replay of the 2026-09-29 R1 requests (`w10b-sonnet55-notes`, [W10b report](2026-10-07-longmemeval-w10b-reader-replay.md)): each question with its own five retrieved conversations, house notes prompt. No new calls.
- **Broken arm (`w8-lme-swap`).** Each question's own text and date, followed by a donor question's retrieved conversations. The donor is the first question after it in a seeded permutation whose conversations include none of the target's answer sessions and none of its answer text. The build and `test/eval/batch-w10.test.ts` verify the donor rule for every question.
- **Partial fault (`w8-lme-partial`).** The best-ranked retrieved conversation that holds the answer is removed from the reader's input, leaving the others unchanged, on a seeded 50 of the 100. A gold conversation reached the reader in all 50, so the fault applied to all 50.
- **Settings.** `claude-sonnet-5-5`, adaptive thinking at `output_config.effort: "low"`, 4,096 output tokens, the same as the real arm. Judge: official `gpt-4o-2024-08-06`, verbatim `evaluate_qa.py` prompt, temperature 0, 10 tokens. Everything ran through the Anthropic and OpenAI batch APIs under the round's budget ledger.

## Results

| Arm | Questions | Correct, official judge (gpt-4o) | Reader errors | `max_tokens` finishes |
|---|---|---|---|---|
| Real (own conversations) | 100 | 91 | 0 | 0 |
| Broken (another question's conversations) | 100 | 19 | 0 | 0 |
| Real, on the partial-fault 50 | 50 | 47 | 0 | 0 |
| Partial fault (top gold conversation removed) | 50 | 7 | 0 | 0 |

| Check | Value | Rule | Status |
|---|---|---|---|
| Signal floor | real 91 of 100 | at least 50 | met |
| Ratio, broken / real | 19 / 91 = 0.21 | at most 0.5 | **pass** |
| Partial fault drop | 47 to 7 on 50 (+0 / -40) | report-only | measured |

By question type, the broken arm's 19 judged-correct answers were 9 single-session-user, 6 multi-session, 3 temporal-reasoning and 1 knowledge-update.

### The judge accepts some "not available" answers

The secondary judge (`gpt-6.1-sol`, the same verbatim prompt), added as a report-only diagnostic after the official verdicts were seen (amendment in the preregistration), graded the same answers:

| Arm | Questions | Official judge (gpt-4o) | Secondary judge (gpt-6.1-sol) |
|---|---|---|---|
| Real | 100 | 91 | 95 |
| Broken | 100 | 19 | **0** |
| Real, on the partial-fault 50 | 50 | 47 | 48 |
| Partial fault | 50 | 7 | 4 |

Under the secondary judge the broken arm scores 0 of 100 (ratio 0.00), so the 19 are not answers that happened to be right; they are the official judge accepting "not available" for an answerable question. The two judges agree on 81 of the 100 broken-arm answers, and every disagreement is one of those 19. The decision stays the preregistered official-judge rule, which passes either way.

## What to use and what to avoid

- **Keep LongMemEval answers as a gated measurement.** The score falls from 91 to 19 when retrieval is replaced with plausible but wrong conversations, and from 47 to 7 when one key conversation is missing.
- **Read the official judge's numbers with its abstention leniency in mind.** It graded 19 of at least 88 refusals on answerable questions as correct (88 is a phrase-match count; the true number of refusals is a little higher). Arms that abstain more often get a larger free bonus from it. Reports in this round show the secondary judge beside it for that reason.
- **Limits.** One reader (`claude-sonnet-5-5`, which applies to Sonnet 5.5 and not to gbrain's Sonnet 4.6 default), frozen 2026-09-29 retrieval rather than the current pin, single sample at provider-default temperature, development data.

## Cost and time

| Item | Requests | Reserved (worst case) | Settled |
|---|---|---|---|
| Broken arm, Sonnet 5.5 (batch) | 100 | $4.22 | $2.25 |
| Partial fault, Sonnet 5.5 (batch) | 50 | $1.90 | $0.93 |
| Official judge, both arms | 150 | $0.07 | $0.05 |
| Secondary judge, both arms (report-only diagnostic) | 150 | $1.56 | $0.04 |
| **Total** | | | **$3.27** |

Each reader and official-judge batch finished within about four minutes. The partial-fault secondary-judge batch stalled with 2 of 50 requests unfinished for 15 minutes; the lane cancelled it (no charge for unfinished requests) and the 2 requests used their one preregistered resubmission, which succeeded. No reader request failed or was retried, and no reservation was refused. All spend is in the round's ledger under the `w8-lme-batch` run ($5 cap).

## Reproduce and inspect

Keyless $0 re-score from the committed rows (recomputes every verdict from the stored judge replies and applies the ratio rule):

```bash
bun eval/runner/batch/w10-rescore.ts w8 docs/benchmarks/2026-10-06-w8-longmemeval-control docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay
```

Expected: `"real_correct": 91`, `"degraded_correct": 19`, `"control": "pass"`, partial fault `"real_correct": 47`, `"fault_correct": 7`, the degraded arm's secondary-judge count 0, and "re-score matches".

Receipts in [`2026-10-06-w8-longmemeval-control/`](2026-10-06-w8-longmemeval-control/): `arms/<arm>/rows.ndjson` (answers, both judges' replies, verdicts, usage and cost per question), `arms/<arm>/receipt.json` (summary, batch ids, reservations, the batch-price confirmation and the preregistration attestation) and `summary.json`. Manifests with each question's donor or removed session: [`2026-10-06-longmemeval-w10-manifests/w8-lme-*`](2026-10-06-longmemeval-w10-manifests/). Preregistration: [`2026-10-06-w8-longmemeval-control-preregistration.md`](2026-10-06-w8-longmemeval-control-preregistration.md).

Live re-run (about $3.30 and 30 minutes; `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`; needs the round's ledger or your own via `--budget-ledger`):

```bash
bun eval/runner/batch/w10.ts build w8-lme-swap && bun eval/runner/batch/w10.ts run w8-lme-swap && bun eval/runner/batch/w10.ts poll
bun eval/runner/batch/w10.ts judge w8-lme-swap official && bun eval/runner/batch/w10.ts poll
# the same for w8-lme-partial; then export each arm and re-score as above
```

The build reads only committed receipts (the R1 request text), so it needs no dataset download.
