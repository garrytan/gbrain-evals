# Preregistration: N2 contradiction judge on current models, including the cheapest that passes (W9)

Written 2026-10-06, after the free input regeneration and its verification, before any paid judge call. Plan: [W9 in the 2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md). Results go to [`2026-10-06-n2-judges/`](2026-10-06-n2-judges/).

## Question

gbrain's contradiction judge (`judgeContradiction`, prompt version 4) failed one of N2's preregistered rules with its default model, Claude Haiku 4.5: on 2026-10-03 it called 6 of 51 compatible pairs contradictions (11.8%, above the 10% limit). Is that failure specific to Haiku? Which current models pass N2's rules, how many false alerts each raises per 1,000 candidate pairs, and what each costs per 1,000 judged pairs, so that gbrain can consider the cheapest model that passes (decision G6)?

## Evidence class

Development evidence. The N2 world (seed 20261001) and its compatible negatives were written by the generator around known failure modes and have been judged before. This is a component replay of the judge, not a full N2 rerun: retrieval and pairing are fixed from the 2026-10-03 run.

## Build and data

- **Judge inputs, regenerated and verified ($0).** The 2026-10-03 receipt (`docs/benchmarks/2026-10-03-wave7-repin/n2/receipt-paid-48ed5e8.json`) stores slugs and verdicts, not the judge's input text. `eval/runner/n2-judge-replay.ts capture` regenerated the N2 world with the generator (`n2-contradiction-gen/1.0.0`) at seed 20261001 and reran the probe hermetically at gbrain `48ed5e8` (the receipt's build, copied overlay) with a recording judge: keyword-only search, top 5, cache off, four concurrent probe runs. `verify` then matched it to the receipt: **2,680 of 2,680 (query item, page, page) triples identical, 0 missing, 0 extra, 0 gold-class mismatches, ledger fingerprint `19459c10…` identical.**
- **Judge code:** gbrain `c5fb0201` (the round's pin), `src/core/eval-contradictions/judge.ts`. Prompt version 4, the same prompt text as at `48ed5e8` (the only change between the two commits is `allowFallback: false` on the chat call). Output limit 1,024 tokens (gbrain's own); no reasoning-effort control (out of scope); provider-default temperature.
- **Fresh compatible negatives ($0):** the same capture at seeds 20261011 to 20261016; the first 200 compatible-negative pairs offered under their own query, in seed order then item order.

## Pairs judged (741 per model)

| Split | Pairs | Source | Weight |
|---|---:|---|---|
| Planted, same item | 241 | all planted pairs offered under their own item's query: 150 conflicts, 40 dated changes, 51 compatible negatives (the 51 include the 6 namesakes) | 1 |
| Other judgments | 300 | a seeded sample (seed 20261006, without replacement) of the other 2,439 offered judgments (unplanted and cross-item pairs) | 2,439 / 300 |
| Fresh compatible negatives | 200 | seeds 20261011 to 20261016 | 1 |

The selection file and its SHA-256 are committed before the first paid call.

## Arms

`openai:gpt-6-luna` (current-generation cost tier), `anthropic:claude-sonnet-5-5`, `openai:gpt-6.1-sol`, `anthropic:claude-opus-5-5`, `anthropic:claude-fable-5-1`, run in that order, each on all 741 pairs, through gbrain's gateway `chat()`. Claude Haiku 4.5 is not rerun: its verdicts on the 541 original pairs come from the 2026-10-03 receipt (it has none on the fresh split).

## Metric and denominator

Per model, N2's existing rules:

- classification recall on offered conflicts (rule: at least 0.80), denominator 150;
- false-contradiction rate on offered dated changes (rule: at most 0.10), denominator 40;
- false-contradiction rate on compatible negatives, on the original 51 and pooled with the fresh split (251). **The decisive rule is the exact two-sided 95% Clopper-Pearson upper bound of the pooled rate: a model passes only when it is under 0.10.** (On the original split alone, 5 of 51 has an upper bound of 21%; only 0 of 51 is under 10%.) Haiku is scored on the original 51 only.

Every rate prints its exact Clopper-Pearson interval. Also per model: judge errors and truncations; paired exact McNemar against Haiku on correctness (a verdict of contradiction is correct only for a planted conflict) over the 541 original pairs; **false alerts per 1,000 candidate pairs** at the run's observed prevalence, (sample alerts / 300 × 2,439 + false contradictions on the 91 planted negatives) / 2,680 × 1,000; **cost per 1,000 judged pairs** from the ledger; wall time.

Errors: a judge error (refusal, unparseable output, transport failure) or a reply cut at the 1,024-token limit (`stopReason: length`, a truncation) counts as a judge error, never as a verdict: a conflict with a judge error is not recalled, and a negative with a judge error raises no false alert but is counted and reported. A model with judge errors on more than 5% of pairs is reported as unreliable beside its rules.

**Adjudication.** The union of every model's contradiction alerts on the 300 sampled other judgments, Haiku's included, is adjudicated against the generator's ledger, blind to which model raised each alert (pairs sorted by id, model names hidden): a genuine conflict between the two pages' stated facts, no conflict (false alert), or ambiguous. Ambiguous pairs are reported as bounds (false alerts with them counted and without).

## Decision rule

A model **passes** N2 when recall on conflicts is at least 0.80, the dated-change false-contradiction rate is at most 0.10, and the pooled compatible-negative rate's exact upper 95% bound is under 0.10. The decision question for G6 is "the cheapest model that passes all of N2's rules", by cost per 1,000 judged pairs. Each model is judged by its own rule, so there is no correction across models for the pass decisions; the five McNemar comparisons against Haiku are Holm-corrected together. The report says that passing the 10% bar is not the same as being ready to act on verdicts without review.

Minimum detectable effect: with 251 pooled compatible negatives, the upper bound is under 10% only at 15 or fewer false alerts (an observed rate of about 6% or less); with 541 paired original pairs, McNemar needs a one-sided split of at least 6 discordant pairs to reach p < 0.05.

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| A model passes when the exact 95% upper bound of its compatible-pair false-contradiction rate is under 10%: G6 may propose the cheapest such model for an independent production-path check before any default change | Keep Haiku; the 10% rule stays failing; file the false-alert pairs with gbrain | Report false alerts per 1,000 pairs; no default change |

## Budget

Ledger `/workspace/gbrain-evals/.budget/followups-2026-10.sqlite`, workstream cap $38 (the plan's), estimate $30 (about 1,100 input and 200 output tokens per call: Luna $0.20, Sonnet $3, GPT-6.1 Sol $3 to $5, Opus $6, Fable $16). One budget run per model, so cost per model comes from the ledger: Luna $1, Sonnet $5, GPT-6.1 Sol $6, Opus $9, Fable whatever is left of $38 when it starts (at least $17). Every request goes through the paid-request guard in-process; once a run's guard refuses, the remaining pairs are recorded as "not judged" and the model is reported as **Partial**. If spend passes $37.50 (25% over the estimate) before Fable runs, Fable is **Not run**.

Commands (each `judge` attests this preregistration before its first paid request):

```bash
bun eval/runner/n2-judge-replay.ts select --capture capture-20261001.json capture-2026101{1..6}.json --output selection.json
bun eval/runner/n2-judge-replay.ts judge --model <model> --selection selection.json --preregistration <this file> --budget-ledger <ledger> --budget-usd <cap> --output judge-<model>.json
bun eval/runner/n2-judge-replay.ts score --selection selection.json --receipt <2026-10-03 paid receipt> judge-*.json --output score.json   # keyless
```

## Amendments

### 2026-10-07: Fable 5.1 is smoke-only

On 2026-10-07 Garry set a new eval model rule: Claude Opus 5.5 is the top Anthropic model in counted runs, and Claude Fable runs only in small smoke tests, never in counted cells (gbrain project instructions, "Eval model selection"). This amendment is recorded after the run, under that rule. The finished `claude-fable-5-1` replay stays in the receipt as recorded, labeled smoke-only, and is not counted toward any decision. The preregistered rules are applied per model, so the counted result covers `gpt-6-luna`, `claude-sonnet-5-5`, `gpt-6.1-sol` and `claude-opus-5-5`: all four pass, and the cheapest passing model (`gpt-6-luna`) is unchanged. The Holm family over models against Haiku 4.5 keeps its preregistered five members, since removing one after the results would be a post-hoc change; every counted model's adjusted p is at most the five-member value. No further Fable cell runs.
