# Preregistration: particle-1 replays W10's LongMemEval reader prompts

Registered 2026-11-01, before any paid call. This is unit U3 of the approved plan "particle-1 as a first-class model in gbrain-evals" (revision 5, sha256 `23b9eaa7d50772b3c398db9836fb7268ac094420be12ddbd1c91d0ff93148c04`; autoplan run `particle-1-20261031193823`, gate_rev 3, rec_hash `e6c129ce9db1`; Garry: "Do it"). Thread GBEV-20, issue GST-644. Runner: [`eval/runner/batch/w10-particle.ts`](../../../eval/runner/batch/w10-particle.ts).

The plan's own text comes first, copied verbatim. The sections after it say how this run carries it out; where they add detail, the plan's text still governs.

## The plan's "Replay" section (verbatim)

A new dated experiment, `docs/benchmarks/<date>-longmemeval-particle-replay/`, with this section copied into its PREREGISTRATION.md before any call. A replay runner (`eval/runner/batch/w10-particle.ts`) rebuilds each comparator's committed request body with `eval/runner/batch/sources.ts`, checks it against the manifest's `body_sha256`, extracts the system and user text, and sends it through qa-v2's `ChatClient` and `chatWithReceipts` (Particle has no batch API), so it inherits their retries, receipts and cache (a rerun resumes without paying twice), at concurrency 8 with a request timeout above 300 seconds, under the budget ledger. Only the window check learns particle-1 (`assertFitsWindow` at `sources.ts:249`, or a replay-local limit); `readerBody`, `MODEL_SETTINGS`, the batch lane's provider type and `batch/manifest.ts` stay untouched, because the replay never builds a batch body for particle-1. The replay keeps its own stop state: a `BudgetExceededError` ends it after the failing receipt is written. A test checks that the Sonnet-shaped and Sol-shaped bodies of each question give identical extracted text, and a $0 pass re-hashes every comparator body the replay reads before any paid call. The W10c whole-history bodies were rendered with gbrain `c5fb0201` (v0.60.95.0) and no test checks they rebuild at today's pin, so a $0 dry build of all 150 `w10c-sonnet55-full` bodies (LongMemEval-S, SHA-256 `d6f21ea9…`) must pass before any paid call; on a mismatch the runner renders from a gbrain `c5fb0201` checkout and records that.
- R1, W10b reader replay: the 500 frozen-retrieval prompts (gbrain `a7cb37b`), particle-1 at `high`, official judge `gpt-4o-2024-08-06`; paired with the committed Opus 5.5 (474 of 500), Sonnet 5.5 and GPT-6.1 Sol rows. Estimate $3.
- R2, W10c: the 150 stratified questions, particle-1 at `high` on gbrain's current-pin prompts and on the whole-history prompts, and at `none` on gbrain's prompts; set beside W10c's Sonnet 5.5 and GPT-6.1 Sol rows. Estimate $6 to $8, almost all of it the whole-history input.
- Reported: paired differences with 95% intervals (the repo's `compare.ts`), cost per correct answer from list prices (`list_usd`, with W10's batch prices as a second column, since W10's rows were batch-priced at factor 0.5), latency p50 and p95, truncation count, and each arm's effort (comparators ran at `low` for Opus and Sonnet 5.5 and `medium` for GPT-6.1 Sol; particle-1 at `high`).
- Decision G's test, preregistered on W10c's design: paired non-inferiority at a 7-point margin, Holm across two comparisons, of particle-1 on gbrain's retrieval against particle-1 on the whole history, and of Sonnet 5.5 on gbrain's retrieval (W10a's rows) against particle-1 on the whole history. Whatever the result, README's comparison paragraph (`README.md:190`) gains one sentence with particle-1's two rows and their costs; its headline changes only by a separate decision.
- Development-lane test, preregistered on the same 150-question cohort: particle-1 passes if its whole-history minus old-retrieval difference has the same sign as Sonnet 5.5's (+6.7 points, the only W10 retrieval contrast whose interval excludes zero) with an interval that excludes zero, and its per-question agreement with Sonnet 5.5 on the whole-history arm is no more than 5 points below GPT-6.1 Sol's agreement with Sonnet 5.5; it fails on the opposite sign with an interval excluding zero; anything else is inconclusive. Fail or inconclusive leaves the lane on a counted reader (Sonnet 5.5) and spends nothing more.
- Then the rule docs land (wording below), carrying the replay's numbers.

## The plan's bars, cap and stop rule (verbatim)

Bars, all required, written before the run; the denominator is every particle request the ledger saw:
1. Metering: no unknown-host request; every particle request priced; the ledger total within 2% of the change in Particle's prepaid credit balance across a run window with no other Particle traffic on the project key (other threads share it) when Particle shows the balance, else within 2% of the usage-field total, with the report saying which basis it used.
2. Receipts: on every path, workload suites and the development lane included, every particle request has a persisted receipt with its request identity, effort sent and effective, output limit sent and status. Successful responses also carry `response_model particle-ai/particle-1` and reasoning tokens, and the weight version when Particle reports one; failed attempts (429, network errors, 402) carry those fields as explicit nulls, never invented values.
3. Truncation: `finish: length` on at most 1% of particle reader calls at the 16,000 floor.
4. Errors: at most 2% of particle calls still failing after retries (429, 503).
5. Cat 40: at most 2% of particle turns end in an unparseable tool call, and the oracle arm succeeds on at least 9 of 10 tasks.

Reported without a bar: the paired differences, costs, latencies and arm ranks listed under the replay; no setting or role changes on them except through the flips in decisions B and G.

Cap and stop rule: $25 for all live calls in the build (replay about $10, everything else about $3), from the ledger and reconciled as in bar 1. A `ParticleCreditExhausted` stop ends the runs and is reported. Stop a run at its first failed bar, fix it with a named repair, and rerun that run once. Never rerun to move a descriptive number. Stop all paid work at $20 and report.

## Decisions B and G (verbatim)

From decision B: Flip: if the upper bound of the paired 95% interval for particle-1 minus Opus 5.5 on the 500 W10b questions is below -10 points, the report says so in its first sentence and the Captain brings B back to Garry before the wording lands.

**G. A whole-history particle-1 arm.** 1) Run it: particle-1 reads the full history on W10c's 150 questions, beside its own reading of gbrain's retrieval, and the report sets both against W10c's Sonnet and GPT rows with cost per question. 2) Skip it. Pick 1, because a cheap 1M-token model is the direct challenge to README's "within 7 points at a seventh of the cost", and gbrain should measure that first. Flip to 2 never by default; if the result narrows gbrain's cost case at this history size, the report says so and the headline moves toward histories past 1M tokens, as a separate decision.

## How this run carries it out

### Arms

| Arm | Run | Questions | Prompt text, as the comparators read it | particle-1 effort | Paired with |
|---|---|---|---|---|---|
| `w10b-particle-notes` | R1 | the 500 W10b questions | W10b's notes prompts on frozen gbrain `a7cb37b` retrieval (text of `w10b-sonnet55-notes`, `w10b-sol-notes`, `w10b-opus55-notes`) | `high` | Opus 5.5 (low), Sonnet 5.5 (low), GPT-6.1 Sol (medium), W10b rows |
| `w10c-particle-currentpin` | R2 | the 150 W10c questions | W10's current-pin notes prompts on gbrain `c5fb0201` retrieval (text of `w10a-sonnet55-notes`, `w10c-sol-currentpin`) | `high` | Sonnet 5.5 (W10a rows), GPT-6.1 Sol (W10c rows) |
| `w10c-particle-full` | R2 | the 150 W10c questions | the whole history, `gbrain-lme-reader-v4-notes-fullsessions` (text of `w10c-sonnet55-full`, `w10c-sol-full`) | `high` | Sonnet 5.5 and GPT-6.1 Sol, W10c rows |
| `w10c-particle-currentpin-none` | R2 | the 150 W10c questions | as `w10c-particle-currentpin` | `none` | descriptive only |

"gbrain's current-pin prompts" means W10's current pin, gbrain `c5fb0201` (v0.60.95.0), the build W10a captured and W10c compared against. gbrain-evals has since bumped its pin; this replay reads the prompts W10's comparators read, not a new capture. W10c has no Opus 5.5 rows, so R2 pairs particle-1 with Sonnet 5.5 and GPT-6.1 Sol only, as the plan says. No comparator model is called again.

### Prompt text

`build` ($0) rebuilds every comparator body the replay reads through `sources.ts` (w10.ts's arm definitions), checks each against its committed manifest's `body_sha256` in `docs/benchmarks/2026-10-06-longmemeval-w10-manifests/`, and checks that the Anthropic-shaped and OpenAI-shaped bodies of each question carry the same system and user text. Only text that passed both checks is sent. Measured before registration, on LongMemEval-S (SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`):

- W10b's three arms (500 each), `w10a-sonnet55-notes` (500) and `w10c-sol-currentpin` (150) rebuild byte for byte at today's pin.
- `w10c-sonnet55-full` and `w10c-sol-full` do not: today's pinned gbrain renders 91 of the 150 whole-history bodies differently (its reader and sanitizer changed after `c5fb0201`). Per the plan, the runner renders them from a gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7` checkout, where all 150 of both arms match, and records that in `build.json`.
- Text SHA-256 of what is sent: R1 `52e3520ca8ec8199daeb561eae5ca46106ef2893a197afcd726cd7821ad05c4d` (500), current pin `f44153dee1c38c3e6cde8de8a7f2459ed99b61964037de087491daf817102cfb` (150), whole history `dce4acb7fe76f3b0eb9a69917e2a4c0098a05cb469d2a092ee446c72ea0ad92b` (150).

The window check is replay-local: a prompt's UTF-8 bytes plus a 1,024-token template margin plus the 16,000-token output limit must fit particle-1's 1,048,576-token window. The longest whole-history prompt is 525,764 bytes.

### Reader and judge

- Reader: `particle:particle-1` through qa-v2's `ChatClient` and `chatWithReceipts`: the comparator's system and user text as two messages, `reasoning_effort` sent explicitly, `max_completion_tokens` 16,000, no `temperature` or `seed`. Up to 5 attempts per call, a Retry-After capped at 120 seconds, a 900-second deadline per attempt, 8 questions at a time, under the budget ledger. Answers already paid for replay from the response cache on a rerun.
- Judge: LongMemEval's official prompt (`officialJudgePrompt`, W10's primary judge) on `openai:gpt-4o-2024-08-06`, temperature 0, 10 output tokens, correct when the lowercased reply contains "yes". No secondary judge runs; the paired numbers use W10's official verdicts on both sides.
- An answer cut off at its output limit (`finish: length`) is judged as written and never retried; its row records `truncated: true` and the finish reason, and each arm reports its truncation count. An empty answer is wrong without a judge call. A reader call still failing after its retries, or a judge call still failing after its retries, scores the question wrong and is counted.
- A budget stop (the ledger's cap, or Particle's credit 402) ends the arm after the failing question's row; questions not started are listed as `not_run`. A stopped or failed arm reruns only into a fresh output directory.

### Reported numbers

- Paired differences in official-judge accuracy with 95% bootstrap intervals and exact McNemar tests through `compare.ts` (10,000 draws, seed 20261101): particle-1 minus Opus 5.5, minus Sonnet 5.5 and minus GPT-6.1 Sol on the 500 W10b questions; on the 150 W10c questions, particle-1 on gbrain's retrieval minus particle-1 on the whole history, particle-1's whole history minus Sonnet 5.5's and Sol's, particle-1 on gbrain's retrieval minus Sonnet 5.5 (W10a) and Sol (W10c), each reader's whole history minus its old retrieval, and particle-1 at `none` minus `high`. All of these are descriptive except decision G's family.
- Cost per correct answer at list prices (`list_usd`), with W10's batch prices (`usd`, factor 0.5) as a second column for the comparators. particle-1's list price is the ledger's: $0.25 uncached input, $0.03 cached input, $1.00 output per million tokens, Particle's peak default. Particle charges half of that in its off-peak window (20:30 to 04:00 New York time), which no response field shows; the report says which window the runs fell in and quotes list prices throughout.
- Latency p50 and p95 per arm: wall time of each uncached reader call, retries included. Truncations, reader errors, judge errors and empty answers per arm. Each arm's effort.

### Decision G's test

The family file [`families/g-noninferiority.json`](families/g-noninferiority.json) is registered with this document: paired non-inferiority at a 7-point margin, Holm across two comparisons, alpha 0.05, on the 150 W10c questions. A is particle-1 on the whole history (`w10c-particle-full`) in both. B is particle-1 on gbrain's retrieval (`w10c-particle-currentpin`) in the first, and Sonnet 5.5 on gbrain's retrieval (W10a's `w10a-sonnet55-notes` rows) in the second. B is non-inferior when the lower bound of B minus A clears -7 points after Holm.

### Development-lane test

On the 150 W10c questions: particle-1's difference is `w10c-particle-full` minus `w10b-particle-notes` restricted to those 150; Sonnet 5.5's is `w10c-sonnet55-full` minus `w10b-sonnet55-notes` on the same 150 (+6.7 points in W10c). Agreement is the share of the 150 questions where two arms' official verdicts are equal: particle-1's `w10c-particle-full` against `w10c-sonnet55-full`, and GPT-6.1 Sol's `w10c-sol-full` against `w10c-sonnet55-full`. Pass, fail and inconclusive are as the plan defines them. The development-lane test needs R1, so it reads only when R1 and R2 both finished.

### Bars, as measured here

The bars are computed per arm over every particle request the ledger saw. Bar 5 is Cat 40's and is not measured by this replay.

- Bar 1: Particle exposes no credit-balance read by API (credits show only on its platform Billing page, and the balance is shared across the account's keys), so bar 1 uses the plan's fallback basis: no unknown-host request, every particle request priced and reconciled, one ledger entry per particle request sent, and the ledger total within 2% of the total priced from the responses' usage fields.
- Bar 2: every particle receipt carries its request identity, effort sent and effective, output limit and status; successful ones carry `response_model particle-ai/particle-1` and a reasoning-token count (not required at effort `none`); failed ones carry those fields as explicit nulls.
- Bar 3: at most 1% of an arm's answered reader calls end `finish: length`.
- Bar 4: at most 2% of an arm's questions still fail after retries (a budget stop is not counted here; it stops the arm).

### Order, cap and stop

1. `build` ($0), as above.
2. A paid window granted by the Captain. Inside it: one preflight (one short particle-1 request and one one-token judge request), then the weight canary as three back-to-back pairs of runs (`scripts/particle-canary.ts`, six runs, each pair compared with `--compare`). The warning thresholds are set from those pairs: `--warn-changed` at the largest changed-answer count seen (a warning fires on any count above it) and `--warn-logprob` at the next multiple of 0.01 above the largest mean log-probability change seen. They become the canary's defaults, and the six records go to `docs/benchmarks/particle-canary/history.jsonl` with this report.
3. R1, then R2's three arms (`w10c-particle-currentpin`, `w10c-particle-full`, `w10c-particle-currentpin-none`).
4. `report` ($0), re-scored from the committed rows.

All of it runs under one shared ledger run capped at $12, U3's share of the build's $25 cap (all paid build work stops at $20). An arm that fails a bar stops the unit there; nothing after it runs until a named repair, and that arm reruns once, into a fresh directory, from the Captain's $7.50 reserve. No arm reruns to move a descriptive number.

If the upper bound of the paired 95% interval for particle-1 minus Opus 5.5 on the 500 W10b questions is below -10 points, the report's first sentence says so and decision B goes back to Garry through the Captain before any wording lands.

Whatever decision G's test shows, README's comparison paragraph gains one sentence with particle-1's two W10c rows and their costs; its headline changes only by a separate decision.

### Result files

Results land only after this file is committed and on origin: `arms/<arm>/{rows.ndjson,receipts.ndjson,receipt.json}`, `build.json`, `preflight/`, `canary/`, `compare-*.ndjson`, `summary.json` and `REPORT.md` in this directory.

## Amendment log

- 2026-11-01T05:42:37Z, before any paid call (window granted by GBEV-3): bar 1's basis. Particle exposes no credit-balance read by API, and its balance is shared across every key on the account, so bar 1 reconciles the ledger against the total priced from the responses' usage fields instead of the change in the prepaid balance. GBEV-3 approved this as a named deviation from the plan's balance basis. The ledger prices particle-1 at Particle's peak list price, and Particle charges half in its off-peak window (20:30 to 04:00 New York time), so the ledger total is a conservative upper bound on what Particle charges. Each row records when its reader call started, and the report gives both the ledger's list-price total and the off-peak-adjusted estimate.
