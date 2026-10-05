# Memory proof wave: preregistration skeleton, 2026-10-05

This is a preregistration skeleton, not a result. It fixes the question, the data, the split, the statistic and what each outcome means for the memory proof wave's primary comparison. Values that other parts of the wave still have to measure or decide are marked `TODO`. The grouping runner refuses to open sealed conversations while this file contains a `TODO` marker or is not committed, so the sealed set stays closed until every value below is filled in and committed.

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. It keeps what it is told as Markdown pages and searches them with no model call on writes. The comparator is an extract-first memory server: it calls a language model on every write to pull out facts, keeps them in a database and also keeps the raw text. The wave asks whether gbrain answers questions about long conversations about as well as the comparator, at a lower total cost per correct answer.

## The question

The primary claim, as approved in the wave plan:

> On untouched sealed conversations, under one audited protocol with the same answer model, judge and delivered-context targets for both systems, gbrain's graded accuracy on BEAM 500k + 1M is non-inferior to the comparator's (one-sided 95% bound of the paired difference above −margin), at a lower total cost per correct answer under a preregistered cost formula.

[BEAM](https://arxiv.org/abs/2510.27246) is a public benchmark of very long chat histories. Each conversation has 20 questions of ten kinds (abstention, contradiction resolution, event ordering, information extraction, instruction following, knowledge update, multi-session reasoning, preference following, summarization, temporal reasoning). A judge scores each answer against a short rubric, item by item, so a question can earn partial credit between 0 and 1. The 500k and 1M sizes have 35 conversations each, of about 0.5 and 1 million tokens.

## What is fixed

| Item | Value |
|---|---|
| Decision id | TODO(decision id, assigned when this file is completed) |
| Benchmark harness | The public agent-memory benchmark harness at the commit in [`harness.lock.json`](../../eval/data/memory-proof-wave/harness.lock.json) (`f618ed7b1f0eb9cad7b42e876f91a42f0eadb150`). BEAM queries: 500k `fe4553ac…`, 1M `ed5fd003…` (SHA-256 of `queries.json.gz`). |
| Split | [`grouping-manifest.json`](../../eval/data/memory-proof-wave/grouping-manifest.json), committed before any tuning: 14 dev, 14 validation and 42 sealed conversations (7 / 7 / 21 per size), private file commitment `f67da64c…`, salt commitment `d7c382d8…`. Built by [`memory-proof-wave-grouping.ts`](../../eval/runner/memory-proof-wave-grouping.ts). |
| Sealed questions | 840: 42 conversations × 20 questions |
| gbrain build | TODO(SHA of the wave PR head, installed from GitHub; the merged `src/` tree is checked byte-identical at merge) |
| gbrain configuration | TODO(`token_budget`, `return_unit: page`, date header setting, remote budget clamp raised and asserted; values tuned on dev only) |
| Comparator build | TODO(pinned current release of the comparator server, its best supported mode: facts plus raw chunks) |
| Comparator configuration | TODO(fact and chunk budgets tuned on dev to the same delivered-context target) |
| Harness mode | TODO(`rag` expected; fixed before any paid cell) |
| Answer model | TODO(resolved model id, set through `OMB_ANSWER_LLM` / `OMB_ANSWER_MODEL` with `.env` loading disabled; same for both systems; preregistered fallback model run on an overlap) |
| Judge | TODO(BEAM's own judge as the harness forces it, asserted by model id on every call; one blinded, shuffled joint judging pass over both systems) |
| Delivered-context target | TODO(tokens, counted with `cl100k_base` on the exact text inserted into the final prompt; cells gated on mean and p95 within ±10% of the target; no truncation) |
| Scorer | TODO(audited scorer revision: typed outcomes, strict judge field validation, every rubric item scored) |
| Cost formula | TODO(A6: ingest LLM dollars + embedding dollars + CPU-hours at a stated rate + read-time context and answer dollars, amortized at a stated reads-per-write ratio; sensitivity at 1× and 10× reads) |
| Spending cap for this decision | TODO(dollars, from the paid smoke's rebuilt ledger; the wave cap is $2,500) |

## The estimand and the statistic

For each sealed question, the paired difference is gbrain's graded score minus the comparator's, times 100, in points. The estimand is the mean of these 840 differences. Every conversation has 20 questions, so this equals the mean of the 42 conversation means, and each BEAM size gets half the weight.

The analysis treats conversations, not questions, as the independent units, and keeps the two sizes as strata:

- **Standard error.** Stratified cluster-robust (CR1): within each size, the variance of conversation totals around the size mean, scaled by G/(G − 1), combined with question-share weights.
- **Primary lower bound.** The restricted wild cluster bootstrap-t with Webb six-point weights, 9,999 draws, seed `20261005`: the smallest null value the one-sided 5% test does not reject, found by bisection ([`ni-stats.ts`](../../eval/runner/memory-proof-wave/ni-stats.ts), `wildRestrictedLowerBound`). The upper bound uses the same test in the other direction.
- **Reported beside it, deciding nothing.** The analytic CR1 t bound with 40 degrees of freedom, and the stratified cluster bootstrap-t.

The [power report](2026-10-05-memory-proof-wave-power.md) checked these choices by simulation at 42 sealed conversations: one-sided coverage of the primary method was 94.5% to 95.4% across four assumption sets, including one in which a tenth of conversations lose 15 points. The percentile bootstrap undercovers and is not used.

## The margin

TODO(decision: the margin in points). The approved plan says 2.0 points. The [power report](2026-10-05-memory-proof-wave-power.md) finds that 42 sealed conversations cannot resolve 2.0: with no true difference, the bound clears −2.0 in 50% of simulations under the central assumptions (75% optimistic, 34% pessimistic). It recommends 3.0 points on the same split, which clears in 79% under the central assumptions. The plan requires the margin or datasets to change before any paid cell runs, never after. Whatever is chosen is written here, with its reason, before the first paid cell.

## What each outcome means

The outcome is computed by `decide()` in [`ni-stats.ts`](../../eval/runner/memory-proof-wave/ni-stats.ts) from the one-sided 95% lower and upper bounds of gbrain minus comparator. There is no "tied" outcome: a non-significant difference never becomes a claim of equality.

| Outcome | Rule | What is published |
|---|---|---|
| `ahead` | lower bound > 0 | gbrain's graded accuracy on sealed BEAM 500k + 1M is higher than the comparator's under this protocol, with the bound and both accuracies. |
| `non-inferior` | −margin < lower bound ≤ 0 | gbrain is at most `margin` points behind, with 95% confidence. If the upper bound is also below 0, the report says gbrain is measurably lower but within the margin. Cost per correct answer is reported beside it. |
| `behind` | lower bound ≤ −margin and upper bound < 0 | gbrain is measurably behind, and a loss larger than the margin cannot be ruled out. Published as such, with the per-kind breakdown. |
| `inconclusive` | lower bound ≤ −margin and upper bound ≥ 0 | The sample cannot tell. Published as inconclusive; no equality or parity claim. |

The cost claim ("lower total cost per correct answer") is reported with its own interval under the preregistered cost formula. TODO(cost decision rule: the interval method for the ratio and the sensitivity at 1× and 10× reads).

A sealed cell is marked incomplete, and the decision is `inconclusive`, if any sealed question lacks a scored row for either system, any BEAM rubric item is unscored, or the delivered-context gate fails. An answer failure, retrieval failure or incomplete ingest scores 0 for that system and is counted by type.

## Access rules

- **Dev** conversation ids are public in the manifest. Tuning, knob sweeps and the delivered-context fitting use dev only.
- **Validation** ids are opened through `memory-proof-wave-grouping.ts open --split validation`, which checks the private file against its commitment and appends a line to the access log. Every fix and configuration choice is confirmed on validation before it counts.
- **Sealed** ids open only with `--decision-id`, a purpose, and this file committed with no `TODO` marker. The log line records this file's SHA-256. Sealed runs once per system. A failed sealed result ends this decision; it is never rerun with `--only-failed` or merged reruns.
- BEAM is public, so after validation is opened the sealed set is the complement of dev and validation. The protection is procedural: the commitments prove the split was fixed before tuning, and the log shows every open.

## Secondary rows

Each secondary dataset is its own row, never pooled with BEAM. They are exploratory unless a Holm correction across them is written here. TODO(Holm family, if any).

| Dataset | Unit | Sealed clusters (questions) | Score | Note from the power report |
|---|---|---|---|---|
| PersonaMem 32k | persona (all histories of a persona together; 20 personas, 37 histories) | 12 (375) | multiple choice, its own row | Minimum detectable margin at 80% power: 3.5 to 7.4 points. Descriptive only. |
| LifeBench | user (10 users) | 6 (1,246) | binary | Coverage drops to 89–91% when a user can fail badly. Report the point estimate and per-user results only, no bound-based claim. |
| BEAM 100k | conversation (reserve) | 12 (240) | graded | Committed as a reserve with the same rule. Joins the primary test only if adopted here before any sealed cell. TODO(adopt or leave out). |

## Models

TODO(models). The answer model, the fallback model and any agent-mode readers follow the gbrain eval model rules: the newest frontier model of each family, no older generations except one shared link to a previous result, and no gpt-5.4-mini. A change to a model named here is written into this file, with its reason, before any new cell runs.

## Reproduce

```bash
bun eval/runner/memory-proof-wave-grouping.ts check
bun eval/runner/memory-proof-wave-grouping.ts open --split dev --strata beam/500k,beam/1m
bun test test/eval/memory-proof-wave-power.test.ts test/eval/memory-proof-wave-grouping.test.ts
```

TODO(launcher commands: `bun run harness:cell plan|run <cell-id>` for each sealed cell, with cell ids).
