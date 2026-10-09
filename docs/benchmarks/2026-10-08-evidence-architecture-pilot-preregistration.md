# Preregistration: the wave 1 evidence architecture pilot (A5), its outcome labeler (A10) and arm smoke (A4)

Date: 2026-10-08 (Pacific). Thread: GBRA-60 wave 1 builder. Plan: the approved "Build the 10x memory advantage" plan
(gbrain-evals branch `capy/10x-memory-advantage-plan`, `docs/plans/2026-10-07-10x-memory-advantage/PLAN.md`,
section 4 "Wave 1", items A3, A4, A5 and A10). Committed as a local commit before any paid request; the commit is
pushed unchanged when the wave's pull request opens (the parent thread opens it from this machine, so
`attestPreregistration`'s on-origin check cannot pass at run time; receipts record this commit's SHA instead).

## Question

At a matched evidence budget, which way of handing gbrain's retrieved conversations to a reader gives the frontier
reader's accuracy and committed-wrong rate at the lowest model dollars and interactive latency: the raw whole
sessions (today), a cheap model reading them directly, a cheap model with frontier fallback, a model-written
evidence brief, a write-time per-session digest, provider prompt caching, or plain truncation? The answer decides
whether the brief earns A6 (the confirmatory grid), A8 and A9, or whether the pre-committed off-ramp fires and a
cheaper design ships, and it orders waves 2 to 6.

This pilot does not measure the program-level primary (section 3.1 of the plan, T0's end-to-end task failures
against frozen release v0.60.106.0). It measures a component on a reading benchmark.

## Evidence class

Development evidence. LongMemEval-S was used to tune gbrain's retrieval, and the W10 answers on these questions
are already published. The 100-question pilot split below is a development split (plan section 1.3), not a
held-out or independent confirmation. No sealed set is opened.

## Build and data

- **gbrain-evals**: this branch, parent `8ff05c4` (main, v0.10.44). Driver `eval/runner/pilot/` (evidence, cells,
  call, run, report, cohort, smoke), outcome instrument `eval/runner/outcomes/v3.ts`, labeler validation
  `eval/runner/outcomes/validate-labeler.ts`.
- **Evidence**: the W10a captures of gbrain `c5fb0201`'s own `eval longmemeval` reader requests (release
  retrieval: balanced mode, reranker on, top 5 whole sessions; 500 questions; `longmemeval_s_cleaned`, dataset
  sha256 `d6f21ea9...`), joined to their harness rows by question text:
  - `docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/capture/captures.ndjson.gz` sha256 `65e0def9be56cb3290674b728200925c3b7e87d786be099f719fa96230eca512`
  - `.../capture/harness-rows.ndjson.gz` sha256 `6be5e320d6ec3b08419853450b6cb11e34429f053c15a302d0474d789faefc34`
  Every arm starts from the same captured request. An arm changes only the evidence section (the text after
  `Retrieved sessions:\n`); the question, the date line and the system text stay byte for byte.
- **Brief builder (A3)**: gbrain `src/eval/longmemeval/evidence-brief.ts` (version `evidence-brief-v1`, digests
  `session-digest-v1`), sha256 `a8da5b9b8baa8e52b3f644b89c6bfdbed977d3afc7ff3c96e820adbae71a0869`, written on gbrain
  master `b5f12b12` (v0.60.117.0) and not yet committed there (the wave's gbrain pull request carries it). It
  reuses `src/core/cycle/synthesize-verify.ts` (sha256 `5725fa32...`), `src/core/think/sanitize.ts` (`ea556ca8...`)
  and `src/eval/longmemeval/sanitize.ts` (`f393ab8e...`). The driver records the sha256 of each file it loads and
  refuses nothing on mismatch, so any change after this commit is visible in the receipt and is an amendment.
- **Pilot split**: `stratifiedSample(report types of W10c's 150-question subset, 100, seed 20261007)`; every pilot
  question therefore has committed A0 rows for both counted readers. Allocation: temporal-reasoning 25,
  multi-session 24, knowledge-update 15, single-session-user 13, single-session-assistant 11,
  single-session-preference 6, abstention 6. Id list sha256 (ids sorted, newline-joined)
  `edd29930c878de4649fbd050ff2777aca30eff84e3c2e9b7b0f09d9527b6c245`. The other 400 questions are the confirm split
  (sha256 `a06ffb36a0f0ee5550ed2336ffd25af7dabd058b9a0dfdc8a2f2342f36c5427e`), which this pilot never reads. The plan's
  "100/400 split" was not committed anywhere before this document; this is its first definition.
- **Committed A0 rows reused ($0)**: Sonnet 5.5 from W10a (`arms/w10a-sonnet55-notes/rows.ndjson`, sha256
  `5d5c4763...`), gpt-6.1-sol from W10c (`arms/w10c-sol-currentpin/rows.ndjson`, sha256 `ce703d77...`). The test
  `test/eval/pilot-arms.test.ts` proves the pilot's A0 bodies are byte-identical to those arms' frozen manifests,
  so the reuse is a replay of the same request, run through the batch lane on 2026-10-06/07.

## Arms

Readers use the house notes reader instruction (`gbrain-lme-reader-v4-notes-fullsessions`, system sha256
`3db7ccbb12b2bda893755f560fdfe0d8d733253d38645d6d8124cb3ffb0887d0`). Budgets B are cl100k tokens of the delivered
evidence section: 1,000, 2,000, 4,000 and 7,000.

| Model | Role | Settings |
|---|---|---|
| `claude-sonnet-5-5` | frontier reader | effort low, max_tokens 3,500 (W10a's body) |
| `gpt-6.1-sol` | frontier reader | reasoning_effort medium, max_completion_tokens 12,000 (W10c's body) |
| `claude-opus-5-5` | frontier reader, A0 and the two leading arms | effort low, max_tokens 4,096 |
| `gpt-6-luna` | cheap: builder, digest writer, DIRECT | reasoning_effort low, max_completion_tokens 8,000 |
| `claude-haiku-5-5` | cheap: builder, digest writer, DIRECT | effort low, max_tokens 8,000 |
| `gpt-4o-2024-08-06` | official LongMemEval judge | temperature 0, max_tokens 10, protocol `longmemeval-official-evaluate_qa-anscheck` sha256 `efcf3d0d...` |

Fable is not run. No older generation is run; no gpt-5.4-mini.

| Arm | Definition | Cells |
|---|---|---|
| **A0** (comparator) | frontier reader on the captured request (raw whole sessions, about 13.6k cl100k of evidence) | Sonnet, sol (committed rows); Opus (new) |
| **DIRECT** | the cheap model reads the identical captured request | luna, haiku |
| **FALLBACK** | DIRECT's answer, replaced by the same reader's A0 answer when the cheap answer is an execution error, or its outcome-v3 label is `abstain` or `hedged`, or the label is missing (rule frozen here, `escalate` in `cells.ts`). Cost = cheap call + label call + the frontier call when escalated. | 2 cheap × 2 frontier |
| **BRIEF@B** | the cheap builder reads the five intact sessions with the question and writes `evidence-brief-v1` JSON (prompt from `buildBriefPrompt`); `validateBrief` grounds every quote, drops ungrounded claims, renders the brief, and falls back to the A0 evidence when parsing or grounding fails (MIN_GROUNDED_SHARE 0.5) | 4 B × 2 builders × 2 frontier |
| **DIGEST@B** | a question-independent digest of each session (`buildDigestPrompt`, B/5 tokens per session) written once per session and validated like a brief; the reader gets the five delivered sessions' digests (trimmed to B; a session whose digest fails is delivered as a head excerpt of B/5 tokens) | 4 B × 2 writers × 2 frontier |
| **CACHE** | A0's request with provider prompt caching on the whole prefix (Anthropic `cache_control: ephemeral` on the user block; OpenAI `prompt_cache_key`) | Sonnet, sol |
| **TRUNC@B** | whole captured session blocks in retrieval rank order while the next one fits B; when the top session alone exceeds B, its head cut at a line boundary | 4 B × 2 frontier |

**CACHE, defined before it runs.** Reusable prefix: the entire A0 request (system plus user), about 22k Claude or
14k GPT tokens. TTL: Anthropic ephemeral cache 5 minutes (refreshed on read); OpenAI in-memory prefix cache,
typically 5 to 10 minutes of inactivity, routed by `prompt_cache_key`. Write schedule: the first read of a prefix
writes it (Anthropic bills the write at 1.25x input; OpenAI has no write premium). Read schedule: every later read
of the same evidence inside the TTL, which in an agent session is a follow-up turn over the same retrieved
context. Expected hit rate on LongMemEval as measured here: zero, since each question reads its evidence once.
Quality: identical request text, so CACHE's accuracy is A0's (not re-measured). Cost and latency come from the
timing cohort, where each CACHE unit sends its request cold and then again inside the TTL; dollars per read are
reported at r = 1, 2 and 5 reads per prefix from the measured cold and warm usage. A local answer-cache hit is
never counted as a provider cache win (the driver has no answer cache).

**DIGEST, amortization and invalidation, defined before it runs.** A digest is written at ingest, once per
session and length, keyed on (session text sha256, `session-digest-v1`, writer model, length). It is invalidated
when the session text, the digest prompt version or the writer model changes; chat transcripts are append-only,
so in steady state only new sessions are digested. Two per-question costs are reported: (1) read attribution, the
five delivered sessions' digest costs charged to the question (reads per write = 1); (2) write-time cost, every
haystack session digested at ingest whether or not it is ever retrieved, estimated as measured digest input cost
scaled by the haystack's characters (W10c's `w10c-sol-full.meta.json`) plus the mean digest output cost times the
haystack's session count, divided by the questions asked of that brain (one per LongMemEval-S haystack). Digest
writing is not in the interactive path, so its latency is reported as write-time latency, not added to p95.

**Opus on the two leading arms.** After the Sonnet and sol cells are judged and labeled, the two leading
non-A0 cells are the two (design, budget, builder) cells with the highest mean supported task success across the
two frontier readers, ties to lower mean dollars; Opus reads those two cells and A0 on all 100 questions.

## Metric and denominator

- **Supported task success**: the official judge says the answer is correct (for the 6 abstention questions: it
  identifies the question as unanswerable). Denominator: all 100 questions. An execution error (failed call,
  `max_tokens` finish, empty answer, judge failure) is a failure, never excluded.
- **Committed-wrong (outcome-v3, A10)**: an incorrect answer that commits to a value or action, however hedged
  (answerable and incorrect with a non-`abstain` label, or unanswerable and judged as answered). Commitment comes
  from the outcome-v3 labeler; a missing label counts committed. Reported with a conservative bound that counts
  every answerable wrong answer as committed. Hedged-wrong and hedge-among-correct are reported only if the
  labeler passes the validation below.
- **Dollars**: every model call of the design (builder, digest writer, reader, labeler for FALLBACK routing,
  fallback reader) at list price from usage-receipt/v1 normalized usage (cache reads and writes at their rates).
  A batch-price column (0.5x, the factor W10's pilots confirmed) is reported beside it as a cost column only.
- **Tokens**: reader input and output (provider-reported, usage-receipt/v1), delivered evidence (cl100k), builder
  input and output.
- **Discordance vs A0** on the same reader: questions A0 got right and the cell wrong, and the reverse. It informs
  T0's tolerance check and A6's sample size; it does not set the tolerance.
- **Latency**: from the timing cohort only.

## Timing cohort

A stratified random 24 of the 100 pilot questions (`stratifiedSample(report types, 24, seed 20261008)`, id sha256
`8f9ade80c8026bc7dda20e1db595fbd23211488693bc7ef5c4e38786ecda8396`), 20 cells at B = 2,000: A0, CACHE and TRUNC for
Sonnet and sol; DIRECT for both cheap models; FALLBACK, BRIEF and DIGEST for every cheap × frontier pair.
(question, cell) units run in a seeded random order (seed 20261009), one request at a time, synchronously, with no
answer cache. Timers per unit: retrieval (0: the captures are replayed; retrieval is identical across arms and
not measured here), builder, reader, labeler, fallback, and their sum. BRIEF times its builder call in the unit;
DIGEST reads stored digests (write-time). Each reader call is classified cold or provider-cache-hit from its
usage (`cache_read > 0`), and p95 is reported overall and per stratum. Batch prices are never used for latency.

## Outcome labeler validation (A10), before it reports anything

`judged-hedge-label-v1` (`JUDGED_LABEL_SYSTEM`, sha256
`e7b4580693a24f86511ea4dbeb2933e8a5731969cfc64cbe54b26db3a0bdbf9f`; one model call per answer, answer text only)
labels each answer `abstain`, `hedged` or `confident` on its final answer, condensing GBRA-49's Q1 labeling
guide. It is validated against GBRA-49's 600 hand-labeled dev answers (LoCoMo dev and BEAM-1M dev; three blind
samples of 200, kept by GBRA-49, never committed; only aggregates and file hashes are published):

1. **Select** on samples 1 and 2 (400 answers): the ladder `gpt-6-luna`, `claude-haiku-5-5`, `claude-sonnet-5-5`
   runs in order; the first model with precision >= 0.90 on both `hedged` and `abstain` is selected.
2. **Confirm** once on sample 3 (200 answers, the only sample no Q1 classifier was tuned on). The hedge axis is
   validated only if precision >= 0.90 on both `hedged` and `abstain` there. If no ladder model passes selection,
   or the selected one fails confirmation, the hedge axis reports nothing and committed-wrong is reported with the
   selected (or cheapest) labeler plus the conservative bound.
3. Twelve synthetic mutation probes run with every candidate: a hedged wrong value and an abstention followed by
   a value must never be labeled `abstain`.

GBRA-49's lexical `hedge-v1` to `v3` are negative controls (their published sample 3 result: hedged precision
0.98, abstain precision 0.893, so the lexical path misses the bar on `abstain`).

## Decision rule

The plan's loss tolerance is frozen by T0 before this pilot. **T0's preregistration is not committed as of this
document**, so this pilot uses the plan's proposed 3.0 points as its working tolerance and labels every verdict
"provisional on T0's frozen tolerance". If T0 freezes a different value, the verdict is recomputed from the same
receipts with no new cell.

With n = 100 a point is one question; the pilot is decision support, not a confirmation, and every comparison is
reported with its paired discordance and exact McNemar p (two-sided), no multiplicity gate.

1. **Brief misses (off-ramp, part 1)**: if, on Sonnet 5.5 (A6's primary reader), BRIEF@2,000's supported task
   success is below A0's by more than 3.0 points for both builders, the brief misses. The sol result is reported
   beside it.
2. **A cheaper design wins (off-ramp, part 2)**: a design among DIRECT, FALLBACK, DIGEST@B (any B) and CACHE
   matches the best BRIEF@2,000 cell on the same reader when its supported task success is at least the brief's
   minus 3.0 points and its committed-wrong count is at most the brief's plus 3, at lower list dollars per question
   and lower synchronous p95 (timing cohort; DIGEST and FALLBACK at their cohort cells). If such a design exists on
   Sonnet 5.5, the off-ramp fires and the report recommends the cheapest matching design.
3. If neither fires, the brief qualifies for A6 at the builder and budget with the highest Sonnet 5.5 success
   (ties to lower dollars), and the pilot's discordance against A0 is handed to A6's power calculation.

The report states plainly which of the three happened and names the recommended order of waves 2 to 6.

## What each outcome changes

| If the brief qualifies | If the off-ramp fires | If inconclusive or at the ceiling |
|---|---|---|
| A6 runs the winning builder and budget; A5x runs it as a context mode; A8/A9 stay conditional on A6 | wave 1 stops before A6, A8 and A9; the cheaper design ships as an opt-in reader policy or digest with its cost row; the budget moves to the wave the pilot ranks first | report the ceiling (a design within 1 point of A0 on every reader cannot separate), keep the brief out of A6, and rank waves on dollars and latency |

## Budget

Ledger `.budget/wave1-gbra60.sqlite`, program cap **$80** for A4's live probe, the labeler validation, A5's
quality cells, the timing cohort and every label. Every request goes through `installPaidRequestGuard`, which
reserves its worst case before it leaves the process and settles to provider usage. Runs (each opened with its
own budget inside the program cap): `a4-probe` $1, `a10-labeler` $6, `a5-quality` $55, `a5-cohort` $15, plus Opus
inside `a5-quality`. Stages run in this order and a stage that the remaining cap cannot cover is cut and reported
as not run: (1) A4 live probe, (2) labeler select and confirm, (3) builders and digest writers, (4) the 2,000-token
cells and DIRECT, (5) the other budgets, (6) judge and labels after each reader stage, (7) the timing cohort,
(8) the Opus cells. Expected spend about $60 at list price; the ledger, not this estimate, enforces the cap.

## Amendments

### Amendment 1 (2026-10-08, after the A4 live shape probe, before any A5 cell or labeler call)

The probe (`bun eval/runner/pilot/run.ts probe`, run `a4-probe-2026-10-08T20-54-58-473Z-919bacdc`, $0.11, 12
requests) accepted every body shape the pilot sends. It also showed that OpenAI writes its prompt cache on its
own: `gpt-6.1-sol` and `gpt-6-luna` responses report `prompt_tokens_details.cache_write_tokens` on ordinary
requests (1,151 of a reader request's tokens; 12,371 on the CACHE cold request), and the ledger's price table bills
those at the model's cache-write rate (`gpt-6.1-sol` $2.50 per million against $2.00 input; `gpt-6-luna` $0.125
against $0.10). The CACHE definition above said OpenAI has no write premium; that sentence is wrong for these
models. Correction: on both providers the first read of a prefix pays a cache-write premium, and on OpenAI every
call may carry one, CACHE or not; dollars are computed from each call's reported buckets either way. No arm,
rule, model or threshold changes.
