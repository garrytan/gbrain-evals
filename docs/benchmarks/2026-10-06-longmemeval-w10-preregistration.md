# W10 preregistration: LongMemEval answers at the new pin, against full context, and with frontier readers on frozen retrieval

Written 2026-10-06, before any W10 cell runs, for the 2026-10 follow-up round ([plan](../plans/2026-10-06-followups-round/PLAN.md), workstreams W10a, W10b and W10c, decisions G3, G8, G9 and T1). One preregistration covers all three parts. Runners attest this file against `origin` before their first paid request (`eval/runner/prereg.ts`) and write the attestation into every receipt.

## Question

1. **W10a.** What does gbrain at the round's pin answer end to end on LongMemEval-S, with its release retrieval and the house notes reader on `claude-sonnet-5-5`?
2. **W10c.** On the same reader, does gbrain's retrieval do as well as pasting the whole conversation history into the prompt, and at what cost per question?
3. **W10b.** On the fixed 2026-09-29 release retrieval (gbrain `a7cb37b`), how do today's frontier readers compare with the Sonnet 4.6 reader that produced the published 453/500, and what does `gpt-5.4` (the reader of the vendor rows in `docs/comparison-systems.md`) score on the same sessions?

## Evidence class

Development evidence for all three parts. LongMemEval-S was used to tune gbrain's retrieval configuration, and the 2026-09-29 retrieval was chosen on these same questions. Nothing here is a held-out confirmation. W10b is a component replay of the reader on frozen retrieval, not a measurement of today's gbrain.

## Build and data

- gbrain under test: `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0), the round's pin (`package.json`). gbrain-evals: the commit that adds this file.
- Frozen retrieval for W10b: gbrain `a7cb37b7884ca4a6dba8bb82a4cd430e6a6e806f` (v0.59.13.0), from `docs/benchmarks/2026-09-29-longmemeval-opaque-qa/reranker-on/r1|r2/` (`calls.ndjson.gz` reader lane joined to `rows.ndjson` by question text and date; 500 of 500 joined, no duplicates).
- Dataset: LongMemEval cleaned `_s` split, `longmemeval_s_cleaned.json`, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` (not committed; same file as every LongMemEval arm since September).
- Opaque session ids throughout: no request body may contain `answer_` (checked at build time for every arm).
- Seeds: `20261006` for every subset. W10c's subset is 150 questions stratified by the report's seven question types, proportional allocation with largest remainders: abstention 9, knowledge-update 22, multi-session 36, single-session-assistant 17, single-session-preference 9, single-session-user 19, temporal-reasoning 38 (`stratifiedSample` in `eval/runner/batch/sources.ts`). Fable's subset is a seeded simple random sample of 200 (`seededSample`).
- Row-level manifests: [`2026-10-06-longmemeval-w10-manifests/`](2026-10-06-longmemeval-w10-manifests/) freezes, per arm, every question id and the SHA-256 of the exact request body, the model, output limit, effort and prompt protocol hash. The W10b, W10c full-history and W8 manifests are committed with this file. W10a's and the W10c current-pin manifest are built from the capture and committed before their first paid batch. A manifest never changes; a body that hashes differently refuses to send.
- Comparison families for `eval/runner/compare.ts --family`: [`2026-10-06-longmemeval-w10-families/`](2026-10-06-longmemeval-w10-families/).

### What R1 changed, named from its driver

The plan asks for "the excerpt-limit setting R1 raised, named with its value from R1's driver". R1's driver (`reranker-on/scripts/driver-r.ts`) and launcher (`run-r.sh`) set no excerpt flag. R1 ran gbrain's harness unmodified with `--top-k 5 --no-trajectory --mode balanced --reranker on --autocut off --reader-mode notes --reader-max-tokens 1024`. The house reader reads the full text of each distinct retrieved session, bounded only by `READER_MAX_SESSION_CHARS = 60_000` characters per session (`src/eval/longmemeval/reader.ts`). The raised excerpt limit in the 2026-09-29 report belongs to arm c3 (`think`'s 2,400-character page excerpts, raised above the longest chunk), not to R1. `reader.ts`, `sanitize.ts` and `adapter.ts` are byte-identical between `a7cb37b` and `c5fb0201` (`git diff` is empty), so the reader-side setting is the same 60,000-character session bound at both builds, and no R1 row had a truncated session (`reader_sessions_truncated` 0). W10a against W10b's Sonnet 5.5 arm therefore differs in retrieval code (49 releases, including the P-series) and the harness around it, which the report still calls a combined build and configuration difference.

## Arms

Every reader row is single-sample at the provider's default temperature. Every reader and judge request goes through the batch lane (`eval/runner/batch/`), OpenAI Batch or Anthropic Message Batches.

### Preregistered settings per model

| Model | Role | Effort | Output limit | Notes |
|---|---|---|---|---|
| `claude-sonnet-5-5` | reader | `output_config.effort: "low"`, adaptive thinking (the model's default) | 4,096 | Claude 5.x models think by default and count thinking toward `max_tokens`; Sonnet 5.5 rejects `thinking: disabled`. `low` is the setting closest to R1's no-thinking Sonnet 4.6 that all three Claude readers accept. 4,096 leaves room for thinking beside notes that averaged 243 tokens in R1. |
| `claude-opus-5-5` | reader | `low`, adaptive thinking | 4,096 | same reason; Opus 5.5 rejects any way to turn thinking off |
| `claude-fable-5-1` | reader | `low`, adaptive thinking | 2,048 | the cap: at 4,096 its 200-question worst case ($42.35 at batch prices) would not fit after the Opus arm under the start-only-if-fits rule; at 2,048 it is $32.11 |
| `gpt-6.1-sol` | reader | `reasoning_effort: "medium"` | 12,000 `max_completion_tokens` | the plan's setting (the 2026-10-04 `gpt-5.4` arm's; its longest answer used 3,543) |
| `gpt-5.4` | reader | `medium` | 12,000 | the round's one older model under test (G3) |
| `gpt-4o-2024-08-06` | primary judge | none, temperature 0 | 10 | LongMemEval's official judge, verbatim `evaluate_qa.py` prompt (G9) |
| `gpt-6.1-sol` | secondary judge | `low` | 2,000 | same verbatim prompt; report-only |

A reasoning model's body refuses to build below its limit (test B11).

### W10a: today's gbrain end to end (denominator 500)

`gbrain eval longmemeval` at `c5fb0201`, release retrieval: `--top-k 5 --no-trajectory --mode balanced --reranker on --autocut off`, `voyage:rerank-2.5`, OpenAI `text-embedding-3-large` at 1,536 dimensions (the embedder of every LongMemEval arm since September), house notes reader (`gbrain-lme-reader-v4-notes-fullsessions`, prompt SHA-256 `3db7ccbb…`). Retrieval runs once through `eval/runner/batch/w10a-capture.ts`, which injects a reader client that records each request and returns a placeholder (the method R1's driver used), and refuses any reader call to a provider. The captured system and user text then go through the batch lane to `claude-sonnet-5-5` with the settings above. The harness sends 1,024 tokens and no effort field; on Sonnet 5.5 that request runs adaptive thinking at the API's default `high` effort inside 1,024 tokens, so the replay sets the limit and effort exactly as in W10b and leaves the text untouched. A question with no captured request (a harness error row) counts as a reader error.

Label in every table: "benchmark notes reader; not production `think`". The result applies to Sonnet 5.5, not to gbrain's Sonnet 4.6 default.

### W10c: full-context baseline (denominator 150, pairs only)

On the 150-question subset:

- `w10c-sonnet55-full` and `w10c-sol-full`: the same house notes prompt with every haystack session in place of the retrieved ones, in haystack order, rendered with gbrain's own page renderer, `<chat_session>` framing and 60,000-character session bound (`fullHistoryText`). Measured with each provider's free token-count endpoint: Sonnet 5.5 mean 171,596 input tokens (max 176,056), `gpt-6.1-sol` mean 106,683 (max 108,844). The build refuses any prompt over 200,000 tokens including the output limit (both providers' long-context price tiers start there).
- gbrain arms on the same 150: `w10a-sonnet55-notes` rows for those ids (no new calls), and `w10c-sol-currentpin`, `gpt-6.1-sol` on W10a's captured current-pin prompts.

The plan's 2,048-token limit for the full-context Sonnet notes reader becomes 4,096 for the thinking reason above, so all three Sonnet arms share one setting. Cut-off counts are reported for every arm.

Cost scope: recurring cost per question is reader input and output at batch prices plus retrieval queries (one query embedding and one rerank call per question for gbrain); one-time cost is ingesting and embedding the history (gbrain only). Judging is excluded from both. Latency is reported as provider request time where a provider reports it; batch turnaround is not latency. W10c is an architecture comparison at a fixed reader, so it uses the two cheapest frontier families.

### W10b: reader replay on frozen retrieval (denominators 500 and 200)

Header in every table: "retrieval from gbrain `a7cb37b` (2026-09-29)". Each arm replays the R1 or R2 request text with only the model, output limit and effort changed (test B9):

| Order | Arm | Request text | Comparator (same text) |
|---|---|---|---|
| 1 | `w10b-sonnet55-notes` | R1 notes | R1, Sonnet 4.6 notes (453/500 gbrain judge, 451/500 official) |
| 2 | `w10b-sonnet55-direct` | R2 direct | R2, Sonnet 4.6 direct (432/500, 437/500 official) |
| 3 | `w10b-sol-notes` | R1 notes | R1 |
| 4 | `w10b-gpt54-official` | LongMemEval's official notes-first prompt (`run_generation.py`, `con`, JSON history, sessions sorted by date) over exactly the sessions R1's reader saw, parsed from R1's user text and mapped to raw ids through R1's rows; protocol `longmemeval-official-run_generation-con-json`, its own hash | R1 |
| 5 | `w10b-opus55-notes` | R1 notes | R1 |
| 6 | `w10b-fable51-notes` | R1 notes, seeded 200-question subset (labeled "Fable, 200-question subset" wherever it appears) | R1 on the same 200 |

Judges: the committed official-judge verdicts in `r1|r2/official-judge.ndjson` serve as the comparators' primary-judge column (free). The secondary judge runs on R1's and R2's Sonnet 4.6 answers too (`r1-sonnet46--secondary`, `r2-sonnet46--secondary`), so both judges compare like with like.

### Arm order across the lane

W10b Sonnet 5.5 notes first (its rows also feed W8's LongMemEval control), then W10a, then W10c (`w10c-sol-currentpin`, `w10c-sol-full`, `w10c-sonnet55-full`), then the rest of W10b in the order above. Each arm's judges run after the arm settles.

## Metric and denominator

- Primary metric: answer accuracy under the official judge (`gpt-4o-2024-08-06`, verdict "yes" in the lowercased reply). Secondary: the same under `gpt-6.1-sol`, shown with fixed labels "official judge (gpt-4o)" and "secondary judge (gpt-6.1-sol)", and their agreement.
- Denominators: 500 (W10a, W10b except Fable), 200 (Fable), 150 (W10c pairs). Every manifest question is in the denominator.
- Reader errors count as wrong and are not judged: a failed, expired, canceled or missing request after the one allowed resubmission, a `max_tokens` finish (Anthropic) or `length` finish (OpenAI), any other finish reason, or an empty answer. Each arm reports its count of `max_tokens` finishes.
- Judge errors (a failed or empty judge reply after one resubmission) count as incorrect and are reported per arm.
- Retries: a failed, expired or missing request is resubmitted once, only after its batch settles (no automatic resubmission of a batch whose outcome is unknown). Completed rows are never resubmitted. Nothing is regenerated to get a better score.
- Analysis unit: the question; cluster: the question (independent items). Pairs join by question id, never by order; a paired analysis refuses mismatched id sets.
- Each report records wall time, refusals and retries per arm.

## Decision rule

**Primary judge** for every decision: the official `gpt-4o` judge. The secondary judge is report-only.

**W10b.** Family `w10b-official.json`: each of the six arms against its comparator (table above), one-sided superiority at `min_effect` 0, Holm across all six. A pass reads "this reader scored higher than Sonnet 4.6 on this retrieval"; an interval entirely below zero reads "lower"; anything else reads "no reader difference shown at the measured power". Report-only beside it: the same comparisons under the secondary judge (`w10b-secondary.json`), Sonnet 5.5 notes against Sonnet 5.5 direct (`w10b-exploratory.json`, the C2 follow-up), and `gpt-5.4` on reranked sessions against the 2026-10-04 `gpt-5.4` arm on reranker-off sessions (447/500; different sessions, context only).

**W10a.** Family `w10a-official.json`: W10a against `w10b-sonnet55-notes` on 500 pairs, superiority at `min_effect` 0. Pass: higher at the new pin. Interval entirely below zero: a drop. Otherwise: "no change shown at the measured power". Reported as a combined build and configuration difference, never attributed to the P-series alone. W10a's accuracy is also reported with its exact 95% interval.

**W10c.** Family `w10c-noninferiority.json`: gbrain (B) non-inferior to full context (A) at a 7-point margin (tolerance 0.07), per reader, Holm across the two readers. Family `w10c-loss.json`: full context (B) better than gbrain (A) by more than 7 points (superiority, `min_effect` 0.07), Holm across the two readers. Per reader: non-inferiority pass = "gbrain does as well or better, within 7 points"; loss pass = "full context better beyond the margin"; neither = "insufficient precision to distinguish these arms", never "a tie". The type-weighted estimate (each type's accuracy weighted by its share of all 500) is reported beside the stratified one. The full-context table shows only these 150-question pairs, never beside the 500-question numbers.

**Minimum detectable effects** (one-sided, as the gates test, 80% power, paired binary outcomes, SE = sqrt(discordance / n); R1 against R2 had 8.6% discordant pairs):

| Comparison | n | Assumed discordance | MDE at alpha 0.05 | MDE at the strictest Holm level |
|---|---|---|---|---|
| W10b arm against Sonnet 4.6 | 500 | 10% | 3.5 points | 4.6 points (alpha 0.05/6) |
| W10b Fable against Sonnet 4.6 | 200 | 10% | 5.6 points | 7.2 points |
| W10a against W10b Sonnet 5.5 | 500 | 8% | 3.1 points | 3.1 points (single test) |
| W10c non-inferiority at 7 points | 150 | 12% to 15% | power 60% to 69% when the true difference is 0 (first Holm step, alpha 0.025) | |

Every report prints `compare.ts`'s power note at its n.

## What each outcome changes

Copied from the plan's table.

| Part | If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|---|
| W10a | README's LongMemEval answer row moves to the new pin | README reports the drop next to the old pin's number, as a combined build and configuration difference; a gbrain issue asks for a bisect | Report "no change shown" at the measured power |
| W10c | gbrain non-inferior or better: README "how gbrain compares" gains a matched-reader row with cost per question | Full context better beyond the margin: publish it, and say where gbrain still earns its place (cost, privacy, histories too long to paste) | Insufficient precision: report accuracy with intervals plus the cost difference; no README claim of equivalence |
| W10b | A hypothesis for G6 (benchmark reader, not production `think`); a default change needs its own production-path evaluation | Same, other direction | Report "no reader difference shown" at the measured power |

A model at or near 100% on every arm is named as a ceiling.

## Budget

- Ledger: `/workspace/gbrain-evals/.budget/followups-2026-10.sqlite` (program cap $297, shared by the round). One budget run per workstream, opened at its cap: W10a $28, W10b $107, W10c $50. The `gpt-6.1-sol` current-pin arm (`w10c-sol-currentpin`), which the plan priced inside W10a, is charged to W10c's run: its worst case ($11.60 at batch prices, 12,000 completion tokens) does not fit W10a's cap after retrieval and the Sonnet arm, while W10c's actual-cost sequence leaves room for it. The two caps together are unchanged ($78).
- Reservations: each batch reserves the sum of its requests' worst cases before upload: provider-counted input tokens (Anthropic `count_tokens`; OpenAI `responses/input_tokens`, plus a 1% and 64-token margin) at the input price (the ledger prices `gpt-6.1-sol` input at its cache-write rate, accepted in the plan as G-28), plus the full output limit at the output price, times the batch factor. Settlement is provider-reported usage at list price times the same factor; a row without usable usage is charged its worst case.
- Batch factor: 1.0 (list price) for a provider and model until a 10-question pilot billed through the batch endpoint confirms the published 50% discount. Neither provider's billing API is readable with this round's keys (OpenAI 403, missing `api.usage.read`; Anthropic Admin API 401), so a pilot confirms the discount from the provider's own accounting of the pilot: every Anthropic message reports `usage.service_tier: "batch"`, and an OpenAI batch object's usage equals the sum of its rows' usage. A full submission refuses unless its provider and model are confirmed at 0.5 (test B13). The pilot is the first 10 ids of the committed `pilot20.txt` that are in the arm; pilot rows are part of the arm.
- Start-only-if-fits: an arm starts only when its full worst case fits both the workstream's remaining cap and the program's remaining money. Worst cases measured on 2026-10-06 with the token-count endpoints:

| Arm | Requests | Input tokens counted | Worst case at list | Worst case at batch factor 0.5 |
|---|---|---|---|---|
| `w10b-sonnet55-notes` | 500 | 11,046,576 | $42.57 | $21.29 |
| `w10b-sonnet55-direct` | 500 | 11,035,576 | $42.55 | $21.28 |
| `w10b-sol-notes` | 500 | 6,948,172 | $77.37 | $38.69 |
| `w10b-gpt54-official` | 500 | 7,333,469 | $108.33 | $54.17 |
| `w10b-opus55-notes` | 500 | 11,046,576 | $85.15 | $42.57 |
| `w10b-fable51-notes` | 200 | 4,373,696 | $64.22 | $32.11 |
| `w10c-sonnet55-full` | 150 | 25,741,767 | $57.63 | $28.81 |
| `w10c-sol-full` | 150 | 16,172,094 | $58.43 | $29.22 |
| `w10c-sol-currentpin` | 150 | about 2.1M (from W10a's capture) | about $23 | about $11.6 |
| `w10a-sonnet55-notes` | 500 | about 11M (from the capture) | about $43 | about $21.5 |

Claude 5.x models count about 1.6 times as many input tokens as `gpt-6.1-sol` for the same text (Sonnet 5.5 mean 22,077 per R1 request against Sonnet 4.6's reported 15,451), so the expected spend is above the plan's estimates: about $27 for W10a (with about $8 of retrieval on a cold embedding cache), $48 for W10c and $95 to $100 for W10b, inside the caps and inside the plan's 25% overrun rule except possibly W10b (estimate $87, 25% over is $108.75, above its $107 cap, so the cap binds first). If the cap is reached, no new arm starts, a partly finished arm is published as partial, and arms not run are listed as not run.

## Amendments

### 2026-10-06, after the `w10b-sonnet55-notes` arm settled: lane order while W10a's capture runs

W10a's retrieval capture runs for about four hours on a cold embedding cache (25 seconds per question). Instead of leaving the batch lane idle, the W10b arms after Sonnet 5.5 notes run in their preregistered order (direct, `gpt-6.1-sol`, `gpt-5.4`, Opus, Fable) while the capture runs, and W10a's and W10c's batches run when the capture ends. Each workstream has its own budget run and cap, so the change cannot move money between W10a, W10b and W10c, and the order inside each workstream is unchanged. Batches still run one at a time. No result had been looked at beyond the Sonnet 5.5 arm's settlement status when this was written.

### 2026-10-06, after W10a's retrieval capture and before any W10a reader request: W10a's Sonnet 5.5 output limit is 3,500 tokens

The capture finished with 500 of 500 questions captured, 0 harness errors and $7.90 of retrieval spend (embeddings on a cold cache plus Voyage rerank, 24,851 ledger-reserved requests). The `w10a-sonnet55-notes` arm's worst case at the preregistered 4,096-token limit is $21.33 at the confirmed batch factor (11,091,538 counted input tokens), which does not fit the $20.10 left of W10a's $28 cap, so under the start-only-if-fits rule it could not start. Its limit is therefore 3,500 tokens (worst case $19.84). The two W10b Sonnet 5.5 arms that already ran at 4,096 used at most 864 output tokens (notes, 500 rows, 99th percentile 672) and 624 (direct), and none finished at the limit, so the lower limit is not expected to bind; W10a reports its `max_tokens` finishes like every arm, and any such finish is named beside the W10a against W10b comparison. Nothing else changes: same captured text, model and effort. This was decided from the cost table and the W10b token counts only, before any W10a reader output existed.
