# Preregistration: live negative controls for Cat 14, Cat 20, Cat 29 and Cat 35 (W8, lane B part)

Written 2026-10-06, before any control arm ran. Plan: [W8 in the 2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md). The LongMemEval control in the plan's W8 belongs to another lane and is preregistered there. Results go to [`2026-10-06-negative-controls/`](2026-10-06-negative-controls/).

## Question

Does each of these model-backed categories score a deliberately broken configuration clearly lower than the working one, with today's models? A category that can't is measuring something other than the capability it names. The rule is the audit's, as used on [2026-10-02](2026-10-02-live-negative-controls.md): on the same fixture and seed, the degraded arm must score **at most 0.5 times** the real arm (`NEGATIVE_CONTROL_RATIO = 0.5`). Report-only partial faults (Cat 14 and Cat 35) show how much a realistic, smaller fault moves the score.

## Evidence class

Harness validity. These runs test the instruments, not gbrain's quality.

## Build and data

gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0) from `node_modules/gbrain`; runners at the commit that adds this file. Fixtures: Cat 14 `eval/data/cat14-calibration/probes.jsonl` (all probes); Cat 20 synthetic-v1 and its three questions; Cat 29 synthetic-v1 and its derived questions; Cat 35 `eval/data/transcript-distill-v1`, this fixed 8-transcript subset: `coding-reflection-01`, `coding-reflection-02`, `emotional-processing-01`, `emotional-processing-02`, `people-deal-01`, `people-deal-02`, `startup-ideation-01`, `startup-ideation-02` (prose, expected high triage, four scenarios, two each).

## Models

Every arm uses `anthropic:claude-sonnet-5-5` as the category model (Cat 14 and Cat 29 `think`; Cat 35 distiller, fact extraction and dream triage; Cat 20 brainstorm generator) and `openai:gpt-6.1-sol` as the judge where the category has one (Cat 14, 29, 35). Cat 20 is judged by the four W7 judges (`claude-sonnet-5-5`, `gpt-6.1-sol`, `claude-opus-5-5`, `claude-fable-5-1`), the same way as its real arm. Anthropic calls keep each runner's existing settings (Cat 14 and 29 `think` at temperature 0). The OpenAI judge runs through `eval/runner/openai-judge-shim.ts`: OpenAI Responses API, the runner's forced tool schema as a JSON-schema output format, no temperature (the model rejects it), reasoning effort `low`, output limit at least 8,000 tokens. Results describe these models, not gbrain's default chat model.

New runner flags (defaults unchanged): `--model` and `--judge-model` on `cat14-calibration.ts`, `cat29-think-vs-search.ts` and `cat35-transcript-distill.ts`; `--profile-mode real|none|swap30` (Cat 14); `--embed-mode real|hash` (Cat 29); `--transcript-mode real|unrelated|half` (Cat 35, dream lane only); `--shuffle-corpus <seed>` (Cat 20, from W7).

## Arms

| Category | Real arm | Degraded arm (sanity control) | Partial fault (report-only) | Error it should detect |
|---|---|---|---|---|
| Cat 14 calibration | each probe's real calibration profile seeded | no profile seeded (`--profile-mode none`) | 30% of each profile's facts (bias tags and pattern statements, rounded up) swapped for facts from other probes' profiles, seed 20261006 (`swap30`) | calibration that ignores or misreads the profile |
| Cat 20 brainstorm | the W7 run (its receipt is the real arm) | the same run over synthetic-v1 with every body sentence shuffled across all pages, seed 20261006 (close and far pages say random things) | none | ideas that don't depend on what the brain holds |
| Cat 29 think vs search | live `text-embedding-3-large` embeddings | deterministic hash embeddings (`--embed-mode hash`), `think` and judge still live | none | answers that don't depend on retrieval quality |
| Cat 35 distillation (dream lane) | each transcript as written | each transcript replaced by one from another scenario in the subset (`unrelated`), scored against the original's gold | each transcript cut to its first half at a line break (`half`) | a distiller credited for content it never read |

In every degraded and partial arm the judge sees what the real arm's judge sees about the truth (Cat 14: the real profile; Cat 35: the original gold and transcript), so only the system's input is broken.

## Metric and denominator

| Category | Statistic | Denominator |
|---|---|---|
| Cat 14 | calibrated win rate over win-eligible probes (the runner's `win_rate_calibrated`) | win-eligible probes (tie-expected categories excluded, as the runner does) |
| Cat 20 | median of the four judges' mean overall scores on **all** generated ideas (`cat20-judges.ts`, "on all"), because a degraded arm may pass few ideas | generated ideas with a valid judgment |
| Cat 29 | mean `think` score from the blind pairwise judge | judged questions |
| Cat 35 | dream-lane coverage (the runner's `coverage_by_lane.dream`) | gold items of the 8 transcripts |

Judge errors follow each runner's existing rule (excluded and counted, never scored 0). Each arm also reports wall time, spend, judge errors and refusals. For Cat 35, coverage is also broken down by where the item was planted (early, middle, late), since the half-transcript fault should hit late items.

## Decision rule

For each category: **pass** when the degraded statistic is at most 0.5 times the real statistic; **fail** otherwise. **Signal floor:** the real arm must show signal, or the control is **inconclusive**, not a pass: Cat 14 needs at least 2 calibrated wins; Cat 20 a real median above 1.0; Cat 29 a real `think` mean above 0; Cat 35 a real coverage above 0.10. **Injection checks,** verified from the receipts independently of the score: Cat 14 `none` seeds no profile row (the runner's wiring check reports no calibration block in any calibrated prompt) and `swap30` changes at most the stated number of facts per profile (recomputed by `degradeProbes`); Cat 20's shuffled corpus hash differs from synthetic-v1's; Cat 29's receipt records `embed_transport: stubbed-hash`; Cat 35's receipt lists each control input's donor or length and hash. A failed injection check makes that control invalid.

Each control is a binary rule on one pair of runs; no test statistic, so no multiple-comparison correction. Partial faults report the measured drop (real minus partial) and its direction, with no rule.

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| The category keeps its gate status | The category is marked unable to detect breakage and drops to report-only until fixed | n/a: the 0.5 rule is binary |

An inconclusive control (real arm under its signal floor, or an invalid injection) is reported as such, and the category keeps its current status with that caveat.

## Budget

Ledger `/workspace/gbrain-evals/.budget/followups-2026-10.sqlite`. W8's plan cap is $25; this lane's part is capped at $20, as budget runs: Cat 14 three runs at $0.75 each; Cat 29 two runs at $0.75 each; Cat 35 three runs at $3 each; Cat 20 degraded arm one run at $7.25. Every request goes through the ledger's paid-request guard in-process (the guard is installed before any SDK client is built). A run that hits its cap is published as **Partial** and not rerun.

Commands (each attests this preregistration before its first paid request; L is the ledger path, P this file):

```bash
bun eval/runner/cat14-calibration.ts --model anthropic:claude-sonnet-5-5 --judge-model openai:gpt-6.1-sol --profile-mode {real|none|swap30} --preregistration P --budget-ledger L --budget-usd 0.75
bun eval/runner/cat29-think-vs-search.ts --model anthropic:claude-sonnet-5-5 --judge-model openai:gpt-6.1-sol --embed-mode {real|hash} --preregistration P --budget-ledger L --budget-usd 0.75
bun eval/runner/cat35-transcript-distill.ts --lanes dream --transcripts <the 8 ids> --model anthropic:claude-sonnet-5-5 --judge-model openai:gpt-6.1-sol --transcript-mode {real|unrelated|half} --preregistration P --budget-ledger L --budget-usd 3
bun eval/runner/cat20-brainstorm.ts --model anthropic:claude-sonnet-5-5 --idea-judges <the four judges> --shuffle-corpus 20261006 --preregistration P --budget-ledger L --budget-usd 7.25
```

## Amendments

None yet.

**2026-10-06, before any paid request.** The first launch was refused at budget-run open, before any provider call: the runners' pre-run estimates (Cat 14 and Cat 29 $1, Cat 35's deliberately pessimistic $6 projection) exceeded the per-run budgets above. The runs now pass an explicit estimate (`--estimate-usd`: Cat 14 and Cat 29 $0.40, Cat 35 $1.50; Cat 35's $40 hard-stop check still uses its projection). Budgets, arms, metrics and decision rules are unchanged.

**2026-10-06, after a failed launch, before any scored control.** The second launch failed on the provider side: Claude Sonnet 5.5 rejects the `temperature` parameter ("temperature is deprecated for this model"), which Cat 14's and Cat 29's `think` clients send at 0. All 8 Cat 14 probes in each of the three runs and the first Cat 29 `think` calls failed with HTTP 400 before any answer was scored, and the ledger charged each failed request at its reservation ($1.95 for Cat 14, $0.44 for the partial Cat 29 run, mostly corpus embeddings). Those attempts are kept as receipts (`attempt1/`) and are not scored. The runners now send `temperature` only to models that accept it (`acceptsTemperature`: not Claude 5-family models, not OpenAI reasoning models); with `claude-sonnet-5-5` and `gpt-6.1-sol` every arm therefore samples at the provider default, which each receipt records (`temperature_sent`). Every arm reruns once with the same budgets. Because the failed attempts used $2.39 of this lane's $20, the Cat 20 degraded arm, which runs last, gets a budget of $20 minus this lane's W8 spend when it starts, at most $9; if that cannot cover it, it is published as **Partial** or **Not run**.
