# Preregistration: A4 abstention with System One S4 on (G8)

Written 2026-10-06, before any reader or S4 call of this experiment. Plan: rank 16 (D11) of the [2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md), funded by Garry's decision G8. Results go to [`2026-10-06-a4-s4-on/`](2026-10-06-a4-s4-on/).

## Question

Does gbrain's System One answerability check (S4, a TypeSafe Jev probability question "do these candidates contain the information needed to answer the query?") make an answerer abstain on questions the brain can't answer, without refusing ones it can? On 2026-10-01 and 2026-10-03, A4 measured only the reader without S4 ("S4 off"); the S4-on arm was not run because the runner had none (bug ledger A4-3).

## Evidence class

Development evidence. The A4 world is generated around known abstention failure modes (missing attribute, sibling attribute, absent entity) and has been run before.

## Build and data

- gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0) from `node_modules/gbrain`; `eval/runner/a4-abstention.ts` at the commit that adds this file.
- A4 world from `eval/generators/a4-abstention-gen.ts` at its default seed: 240 questions, 120 answerable (profile and note) and 120 unanswerable (missing attribute, sibling attribute, absent entity, 40 each). Hermetic retrieval as before: the `query` operation, top 5, keyword-only, no embedding gateway.

## Arms

| Arm | What answers |
|---|---|
| S4 off, retrieved (comparator) | gbrain's house reader (LongMemEval notes-mode system text, 1,024 output tokens) with **`anthropic:claude-sonnet-5-5`**, reading the question's top five query results |
| S4 off, oracle (control) | the same reader on the ledger's oracle evidence |
| **S4 on** (new) | the S4-off retrieved answer, replaced by an abstention wherever S4's verdict is `abstain`, which is what `think` does (it skips synthesis and lists the nearest pages) |

**S4 on, as wired.** For each question, the top five results become S4 evidence through gbrain's own `candidateItem`, `answerableK` and `answerableQuestion`; one `runDecide` request goes to `typesafe:jev-1.13.0` (key from `JEV_TYPESAFE_API_KEY`); gbrain's production reducer `reduceAnswerable` turns the probability into pass, abstain, margin_hold or incomplete, using the identity-hit and strong-CRAG-grade signals the hermetic arm already computes. **Threshold 0.50, margin 0.05** (gbrain's default margin floor), `force_on`. gbrain ships no reference calibration for the answerable slot, so on a fresh brain `decide.slots.answerable.mode: on` is inactive (`no_calibration`): this arm measures S4 at an explicit threshold, as a user would set with `decide.slots.answerable.threshold` and `force_on`. The A4 world is fictional with no private pages, so the arm allows TypeSafe egress of query and candidate text (`decide.egress.typesafe.query/candidates: allow`, `decide.egress.private: allow`); the receipt records the exact config.

The reader runs at the provider's default temperature: Claude Sonnet 5.5 rejects `temperature`. Results describe Sonnet 5.5 as reader, not gbrain's default chat model (`claude-sonnet-4-6`).

## Scoring: the A4-4 revision

Earlier A4 runs used a frozen rule (2026-10-01 preregistration): an answer that names another company's value is `wrong_source` even when it also says the information is unavailable, and the abstention pattern missed "I don't have the information". This preregistration revises the rule **for the S4-on arm and its matched S4-off comparison only** (`scoreAnswerV2`): the abstention pattern adds "don't / do not / doesn't have the information, data or details", and an answer that abstains while naming another value only as context counts as an abstention. A stated wrong value without an abstention is still wrong or wrong_source. Every metric is also reported under the frozen rule, beside it.

## Metric and denominator

Per arm (revised rule): abstain recall (abstentions over the 120 unanswerable), false refusal rate (abstentions over the 120 answerable), correct useful rate, unanswerable answered rate, abstain precision, coverage, risk, utility (λ = 1 and 4). Errors are excluded from every denominator and counted (the runner's existing rule). S4 verdict counts by question class, the probability per question, and k used are in the receipt.

## Decision rule

Primary: **S4 on "abstains usefully"** under A4's existing rule: abstain recall at least 0.80 and false refusal rate at most 0.10 (revised scoring). Secondary, paired on the same questions: S4 on against S4 off (retrieved) on abstain recall (120 unanswerable) and on false refusals (120 answerable), exact McNemar each, Holm-corrected across the two. S4 on can only add abstentions, so the questions are how many unanswerable questions it newly abstains on and how many answerable ones it newly refuses. A report-only threshold sweep (0.1 to 0.9) shows the trade-off from the recorded probabilities. Minimum detectable effect: a one-sided McNemar split of at least 6 discordant pairs (p < 0.05 before Holm).

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| S4 on abstains usefully and adds abstentions on unanswerable questions without significantly more false refusals: report S4 as helpful at threshold 0.5, and the report asks gbrain to ship a calibrated threshold for the answerable slot | S4 on adds false refusals, or adds no abstentions: report it, with the sweep; no recommendation to turn S4 on | S4 off already abstains on nearly every unanswerable question (a ceiling): report that S4 has little room to help on this world |

## Budget

Ledger `/workspace/gbrain-evals/.budget/followups-2026-10.sqlite`, one budget run opened first with `--budget-usd 8` (the plan's cap), joined by the reader and the S4 step; every request goes through the paid-request guard (TypeSafe requests priced at gbrain's `typesafe:jev-1.13.0` input price). Estimate $4 (480 reader calls at Sonnet 5.5 prices; S4 about $0.01). A refused reservation leaves the remaining answers as errors and the arm **Partial**.

Commands:

```bash
RUN=$(bun eval/runner/budget-ledger.ts open --runner a4-s4-on --budget-usd 8 --estimate-usd 4 --budget-ledger <ledger>)
bun eval/runner/a4-abstention.ts --paid --budget-run-id $RUN --budget-ledger <ledger> --reader-model anthropic:claude-sonnet-5-5 \
  --s4-on --s4-threshold 0.5 --preregistration docs/benchmarks/2026-10-06-a4-s4-on-preregistration.md --output docs/benchmarks/2026-10-06-a4-s4-on
bun eval/runner/budget-ledger.ts close --budget-run-id $RUN --budget-ledger <ledger>
```

## Amendments

None yet.
