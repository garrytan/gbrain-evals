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

### 2026-10-07, after every W10 cell had settled and before any `gpt-5.4`, Opus or Fable score was looked at: Fable is smoke-test only

Garry 2026-10-07: Fable smoke-only; Opus 5.5 is the top Anthropic model. From this date Fable (5 or 5.1) runs only in small smoke tests, never in paid counted cells, practice rounds or held-out runs.

The `w10b-fable51-notes` arm (200 questions) and its two judges had already run and settled on 2026-10-07 at 03:33 UTC, before the rule reached this lane, so no spend could be saved on it. Under the rule's "finished cells stay as recorded, add no more":

- The Fable rows are kept and published as recorded, labeled "Fable 5.1, 200-question subset; run before the 2026-10-07 smoke-only rule; not a counted cell going forward".
- No further Fable cell runs in W10 (no retry, no extension to 500, no Fable cell in W10a or W10c, which never had one).
- The preregistered W10b family `w10b-official.json` is not edited after its cells ran: the Fable comparison stays in it, so the Holm adjustment for every other arm is the one preregistered (keeping it can only make the other arms' adjusted p-values larger, never smaller). No decision, gate or README row rests on the Fable comparison; it is reported in its own labeled row after the others.
- Opus 5.5 is the top Anthropic reader in every W10b statement. No other arm, model, judge or setting changes.


### 2026-11-16, before any R3 request: R3 re-measures the whole-history comparison and the strict recall@5 rider at gbrain's newest release

Every number this preregistration produced was measured on gbrain `c5fb0201` (v0.60.95.0), 616 releases behind gbrain's newest release on 2026-11-16. Under the rule that a published gbrain number is re-measured at the newest release (R100), R3 re-runs W10c's question, and the strict recall@5 figure behind README's heading "Finding all the evidence: gbrain leads every system we can score strictly", at the newest release. Nothing in R3 changes a W10 cell that already ran, and W10's own families, verdicts and reports stand as recorded. R3's results go to [`2026-11-16-longmemeval-w10-newest/`](2026-11-16-longmemeval-w10-newest/). Written before any R3 provider request. The only results looked at were W10's and the 2026-11-01 particle-1 replay's, which were already published.

**What each outcome changes (R97).**

| Result | What changes |
|---|---|
| gbrain non-inferior to the whole history at the 7-point margin for a reader, under both judges | README's whole-history row and its third takeaway move to the newest release for that reader |
| The whole history better than gbrain by more than 7 points for a reader, under both judges | README's third takeaway says the whole history beats gbrain by more than 7 points at the newest release, and the multi-session failure classes go to gbrain's maintainers |
| Neither, or the two judges disagree | The row moves to the newest release with "no claim at the measured precision", and nothing reads as a tie |
| gbrain at the newest release worse than at `c5fb0201` on the paired regression test (GPT-6.1 Sol or particle-1) | The report names a regression at the newest release, with its failure classes. Nothing is tuned or re-run to make it go away |
| Strict recall@5 at the newest release below 423 of 470 (the verbatim-session system's 90.0%) | The heading comes down. At 423 or above it is restated at the newest release |

**Build.** gbrain v0.60.733.0, `6ce7195b44a034f85aec811f11fbf862db376f50`: the highest release tag on gbrain's master at launch (`git ls-remote --tags https://github.com/garrytan/gbrain.git`, 2026-11-16), not the weekly `stable` tag. The run machine installs it by commit (`eval/runner/batch/r3-vm-setup.sh`), and every R3 step that touches gbrain refuses any other build (`assertR3Gbrain`). `package.json`'s pin is unchanged. The build is frozen once the retrieval capture starts. If a newer release lands before then, a dated amendment re-pins it first. gbrain-evals: the commit that adds this amendment and R3's harness.

**Data and prompts.** Same dataset file and SHA-256, the same 150-question subset (seed `20261006`) and the same house notes reader prompt. The newest release reports the same prompt version and hash, `gbrain-lme-reader-v4-notes-fullsessions`, `3db7ccbb…`, checked by a keyless capture at `6ce7195b`.

**The whole-history text is `c5fb0201`'s, in every whole-history arm.** Re-rendered at the newest release, 91 of the 150 whole-history prompts differ from the stored ones. In `06878be2`, for example, `c5fb0201` rendered `[redacted](Prozorro)` where the newest release renders `system (Prozorro)`. `c5fb0201` reproduces all 150 byte for byte. So every whole-history arm (Opus 5.5's new arm, Sol's stored arm and particle-1's re-read) sends exactly the text W10c sent (text SHA-256 `dce4acb7…`, re-hashed at build time), and the report says so beside every whole-history number. The gbrain arms send what the newest release renders for the sessions it retrieves. The comparison is therefore gbrain at the newest release against the whole history as `c5fb0201` rendered it.

**Arms** (150 questions each, W10c's subset):

| Arm | Reader | Text | New requests? |
|---|---|---|---|
| `r3-opus55-newest` | `claude-opus-5-5` | gbrain at the newest release (R3's capture) | yes |
| `r3-opus55-full` | `claude-opus-5-5` | the whole history (`c5fb0201` rendering) | yes |
| `r3-sol-newest` | `gpt-6.1-sol` | gbrain at the newest release (R3's capture) | yes |
| `w10c-sol-full` | `gpt-6.1-sol` | the whole history | no: W10c's committed rows, same manifest, prompt, settings and official judge |
| `w10c-sol-currentpin` | `gpt-6.1-sol` | gbrain at `c5fb0201` | no: W10c's committed rows (the regression pair) |
| `r3-particle-newest` | `particle-1` | gbrain at the newest release (R3's capture) | yes |
| `r3-particle-full` | `particle-1` | the whole history (`c5fb0201` rendering) | yes, re-read |
| `r3-particle-currentpin` | `particle-1` | gbrain at `c5fb0201` (W10a's capture) | yes, re-read (the regression pair) |

Sonnet 5.5 is no longer a reader under test. Its W10c rows stay published as W10 recorded them.

Reader settings are the ones this preregistration and the particle-1 replay set: Opus 5.5 at `effort: low` with 4,096 output tokens (the settings table above), Sol at `reasoning_effort: medium` with 12,000, and particle-1 at effort `high` with 16,000 (the replay's settings).

The particle-1 replay's rows (2026-11-01) are not reused. The plan reused them only if today's weight version matched the one on their receipt, but Particle reported no weight version on any of the replay's 150 rows (`weight_versions: {"null": 150}`), so a match can't be shown. particle-1 therefore re-reads the whole-history and `c5fb0201` texts today. The replay's rows are compared with today's re-reads descriptively, as a weight-drift check (paired McNemar).

**Judges.** Every answer gets the official `gpt-4o-2024-08-06` judge with the verbatim `evaluate_qa.py` prompt, as the bridge to the published numbers. That judge is in Sol's own model family, so under R78 every row also gets a co-primary judge from another family, with the same verbatim prompt. `claude-opus-5-5` (effort `low`, 2,000 tokens) grades Sol's rows: `r3-sol-newest`, `w10c-sol-full` and `w10c-sol-currentpin`. `gpt-6.1-sol` (effort `low`, 2,000 tokens, the settings table's secondary judge) grades Opus 5.5's and particle-1's rows. No judge grades its own family's rows (`assertCrossFamily`), and particle-1 judges nothing.

**Judge check (R78)** (`eval/runner/batch/r3-judge-check.ts`). Its numbers count before any co-judge verdict does. The pool has 100 stored answers drawn with seed `20261116` from rows outside W10c's 150 questions. Set S has 50 Sol answers from W10b and W10c, for the Opus co-judge. Set N has 25 Opus 5.5 answers (W10b) and 25 particle-1 answers (the replay), for the Sol co-judge. Each set holds 28 answers the official judge called wrong and 22 it called right, so both classes are well represented. Two labellers from outside each set's reader family, `gpt-6-astra` and `claude-opus-5-5`, both at effort `high` with 8,000 tokens, grade every item. A label is an item both labellers agree on. The plan said about 60 answers. It is 100 because each co-judge needs at least 40 labels from its own set, and the labellers will disagree on some items. Gates: labeller kappa at least 0.6; for each co-judge, at least 40 labelled items with at least 15 of each class, kappa against the labels at least 0.6, and no judge errors. A co-judge that fails a gate leaves its readers with no claim. That fact is reported, and nothing is re-run to pass.

**Metric and denominator.** As in this preregistration: accuracy under each judge on 150 questions. A reader error (a failed request after the one allowed resubmission, a `max_tokens` or `length` finish, or an empty answer) is wrong under both judges. Pairs join by question id.

**Decision rule** (families in [`2026-11-16-longmemeval-w10-newest/families/`](2026-11-16-longmemeval-w10-newest/families/), run by `eval/runner/batch/r3-report.ts` through `compare.ts`):

- **Non-inferiority** (`r3-noninferiority-official.json`, `r3-noninferiority-cojudge.json`): gbrain at the newest release (B) against the whole history (A), tolerance 0.07, per reader (Opus 5.5 and Sol), with Holm across the two readers. A reader's claim "gbrain within 7 points of the whole history" counts only when it passes under both judges and its co-judge passed the judge check.
- **Loss** (`r3-loss-official.json`, `r3-loss-cojudge.json`): the whole history (B) better than gbrain (A) by more than 7 points (superiority, `min_effect` 0.07), per reader, with Holm across the two. The same both-judges rule applies.
- **Regression** (`r3-oldbuild-official.json`, `r3-oldbuild-cojudge.json`): gbrain at `c5fb0201` (B) better than gbrain at the newest release (A), superiority at `min_effect` 0, with Holm across Sol (W10c's `c5fb0201` rows against `r3-sol-newest`) and particle-1 (`r3-particle-currentpin` against `r3-particle-newest`). A pass under the official judge reports a regression, and the co-judge's result is shown beside it. Every comparison reports its paired difference with a 95% interval and its exact McNemar test.
- **particle-1 against the whole history** is descriptive: paired difference with a 95% interval under each judge, no gate.
- The matched table shows the two-reader mean of Opus 5.5 and Sol under the official judge for gbrain and for the whole history. Opus 5.5 gets a new whole-history arm, so the mean is matched.

**Smallest detectable differences, stated before any R3 row exists.** These are one-sided at Holm's strictest level (alpha 0.025) with 80% power, using SE = sqrt(discordant pairs) / n for paired binary outcomes. The table that opens this preregistration used sqrt(discordance / n), which is the same quantity written per question. The discordance figures come from the stored pairs:

| Pair from stored rows | Discordant of 150 |
|---|---|
| Sol, whole history against gbrain `c5fb0201` | 6 |
| Sonnet 5.5, whole history against gbrain `c5fb0201` | 9 |
| particle-1, whole history against gbrain `c5fb0201` (replay) | 9 |
| Sonnet 5.5, gbrain `c5fb0201` against `a7cb37b` (W10a against W10b) | 9 |
| Sol, gbrain `c5fb0201` against `a7cb37b` | 2 |
| particle-1, gbrain `c5fb0201` against `a7cb37b` | 1 |

At 9 discordant of 150 (6%), the smallest detectable difference is (1.96 + 0.84) × 3 / 150 = 5.6 points. At 12% it is 7.9 points. At a true difference of 0, the 7-point non-inferiority test has about 94% power at 6% discordance and about 70% at 12%. The regression test detects about 5.6 points at 6% discordance (Sonnet 5.5's build pair) and about 2.6 points at Sol's 2 of 150. With so few discordant pairs the normal approximation is rough, and the exact McNemar test decides.

**Rider: strict recall@5.** Strict recall@5 counts a question as hit when every labelled evidence session is among the top five retrieved sessions (the harness's `recall_all_hit`). It is measured on the 470 answerable questions of all 500 LongMemEval-S questions, from one retrieval capture at the newest release (`eval/runner/batch/w10a-capture.ts --r3`). The capture uses W10a's arguments, `--top-k 5 --no-trajectory --mode balanced --reranker on --autocut off`, with OpenAI `text-embedding-3-large` at 1,536 dimensions on a fresh embedding cache. The reranker is the newest release's shipped default, `voyage:rerank-3-lite` (gbrain-evals #148). `c5fb0201` used `voyage:rerank-2.5`, so the report counts the reranker as part of the build difference. The capture also records the reader requests R3's gbrain arms send, so the rider and the arms use one retrieval. Bar: 423 of 470. Paired with the same 470 questions at `c5fb0201` (449, W10a's capture) and at `109b992` (451, the published figure), shown with exact McNemar tests. These pairs are descriptive. At 3% discordance the smallest detectable difference is about 2.2 points.

**Order.** The retrieval capture runs first and builds R3's manifests, which are committed and pushed before any reader request, as W10a's were. Then come the judge check, the three Opus and Sol reader arms, and every judge over them and over W10c's stored Sol rows. particle-1's three arms run last, in their own paid window, followed by their co-judge. Each reader arm keeps this preregistration's pilot, resubmission and start-only-if-fits rules, and runs through the batch lane except particle-1. All paid steps run on one Ubicloud machine with a single ledger writer.

**Cost scope.** As in W10c. Each arm reports reader cost per question at the prices actually billed, and for Opus 5.5 and particle-1 the reader cost per correct answer under the official judge. Judging is excluded. Cached prompt tokens are reported beside every cost figure, since a cache hit lowers the cost of a whole-history prompt.
