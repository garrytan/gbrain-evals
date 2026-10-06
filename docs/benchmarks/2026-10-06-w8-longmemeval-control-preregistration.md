# W8 LongMemEval control preregistration: does the answer score notice the wrong conversations?

Written 2026-10-06, before any cell of this control runs, for the 2026-10 follow-up round ([plan](../plans/2026-10-06-followups-round/PLAN.md), W8 "Live negative controls", LongMemEval answers). It is the LongMemEval part of W8 only; the Cat 14, 20, 29 and 35 controls have their own preregistration. Runners attest this file against `origin` before their first paid request and write the attestation into the receipt.

## Question

Does LongMemEval answer accuracy drop when the reader gets another question's conversations instead of its own? If it does not, the answer score cannot detect broken retrieval and must not gate anything. A second, report-only arm asks how much one realistic fault costs: the best-ranked conversation that holds the answer goes missing.

## Evidence class

Harness validity (a live negative control). Development data: LongMemEval-S was used in gbrain's tuning.

## Build and data

- Request text: the 2026-09-29 R1 reader requests (gbrain `a7cb37b`, reranked retrieval, opaque ids), `docs/benchmarks/2026-09-29-longmemeval-opaque-qa/reranker-on/r1/`, the same source as W10b ([W10 preregistration](2026-10-06-longmemeval-w10-preregistration.md)). Dataset SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
- Sample: 100 questions, a seeded simple random sample (seed `20261006`) of the 470 answerable questions. The 30 abstention questions are excluded because the injection cannot apply to them: with another question's conversations, the correct answer to an unanswerable question ("the information is not available") stays correct, so they would score as free passes for the degraded arm.
- Partial-fault sample: a seeded 50 of those 100 (seed `20261008`), so its worst case fits this control's $5 share after the sanity arm. In all 50 a gold session reached the reader (applicable 50 of 50, checked when the manifest was built).
- Manifests: [`w8-lme-swap.json`](2026-10-06-longmemeval-w10-manifests/w8-lme-swap.json) and [`w8-lme-partial.json`](2026-10-06-longmemeval-w10-manifests/w8-lme-partial.json), with each question's donor and removed session in the `.meta.json` files beside them, committed with this file.

## Arms

All three use `claude-sonnet-5-5` with W10's settings (adaptive thinking at `output_config.effort: "low"`, 4,096 output tokens, house notes prompt `gbrain-lme-reader-v4-notes-fullsessions`), through the batch lane.

| Arm | What the reader sees | Calls |
|---|---|---|
| Real | its own R1 request text | none: W10b's `w10b-sonnet55-notes` rows for these 100 ids |
| Degraded (`w8-lme-swap`) | its own question and date, followed by a donor question's retrieved sessions | 100 |
| Partial fault (`w8-lme-partial`, report-only) | its own request text with the top-ranked retrieved gold session's `<chat_session>` block removed | 50 |

Donor rule: the first question after it in a seeded permutation of the 100 (seed `20261007`) whose retrieved sessions include none of the target's answer sessions and whose session text does not contain the target's answer string (answers of 3 or more characters, case-insensitive). The injections are verified independently of any score: the build and `test/eval/batch-w10.test.ts` check the donor rule for every question and that the partial fault removes exactly one block, the top-ranked gold one, leaving the others unchanged.

## Metric and denominator

Answer accuracy under LongMemEval's official judge (`gpt-4o-2024-08-06`, verbatim `evaluate_qa.py` prompt, temperature 0, 10 tokens), the same judge as W10's primary. Denominators 100 (real, degraded) and 50 (partial, with the real arm's score on the same 50 beside it). Reader errors (failed, expired or missing after one resubmission, a `max_tokens` finish, an empty answer) count as wrong; judge errors count as incorrect and are reported.

## Decision rule

The rule of `2026-10-02-live-negative-controls.md`: the control passes when degraded accuracy is at most 0.5 times real accuracy, same sample, reader and judge. Signal floor: if the real arm scores below 50 of 100, the control is inconclusive, not a pass. The partial fault has no ratio rule: the report gives the measured drop in correct answers on the 50 with its exact McNemar test, and states the error it should detect (the reader losing the one conversation that holds the answer).

## What each outcome changes

Copied from the plan's W8 row.

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| The category keeps its gate status | The category is marked unable to detect breakage and drops to report-only until fixed | n/a: the 0.5 rule is binary |

## Budget

Ledger `/workspace/gbrain-evals/.budget/followups-2026-10.sqlite`, budget run `w8-lme-batch` at $5 (this control's share of W8's $25 cap; the other W8 controls use at most $20). Worst cases measured with Anthropic's free `count_tokens`: degraded arm $8.45 at list, $4.22 at the batch factor of 0.5 that W10b's Sonnet 5.5 pilot must confirm first; partial fault $3.80 at list, $1.90 at 0.5. The degraded arm runs first; the partial fault starts only if its worst case fits what is left. If it does not fit, it is reported as not run.

## Amendments

### 2026-10-06, after the degraded arm was judged: a report-only secondary-judge diagnostic

The degraded arm scored 19 of 100 under the official judge. Reading the 19 rows shows the reader answered "the information is not available" in every one of them, and `gpt-4o-2024-08-06` still replied "Yes" (the provider's batch output file confirms the replies; no mapping error). To size that judge behavior, the round's secondary judge (`gpt-6.1-sol`, low effort, the same verbatim prompt) also grades the degraded and partial-fault arms. It is report-only: the control's decision stays the preregistered official-judge ratio rule, which this diagnostic cannot change. Cost: under $0.30 inside the $5 share.
