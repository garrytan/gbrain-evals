# Preregistration: A6, confirming the evidence brief on the 400-question confirm split

Date: 2026-10-08 (Pacific). Thread: GBRA-60. Plan: the approved "Build the 10x memory advantage" plan, section 4,
wave 1, item A6. This is a new decision with its own preregistration. It does not amend the
[evidence architecture pilot](2026-10-08-evidence-architecture-pilot.md) or its
[preregistration](2026-10-08-evidence-architecture-pilot-preregistration.md): the pilot's verdict (the off-ramp
fired because DIRECT matched the brief) and the defect in that off-ramp rule (it compared the cheaper design with the
brief, not with A0) stay on the record as published.

**Authority.** The maintainer decided on 2026-10-08 to "Continue and confirm": run A6 on the confirm split despite
the pilot's off-ramp, and give the cheap-reader option a verdict with the same test. A8 and A9 stay unstarted.

## Question

Does a 2,000-token evidence brief written by `claude-haiku-5-5` give a frontier reader the same supported task
success as the five whole retrieved sessions (A0), on questions the pilot never read? And does a cheap reader on the
whole sessions (DIRECT), or the cheap reader escalating to the frontier reader (FALLBACK), meet the same bar?

If the primary passes, the brief becomes the candidate for the joint sealed-confirmation v2 opening with GBRA-1's
budgeted-delivery candidate (a separate preregistration). This document authorizes no sealed opening.

## Evidence class

Development evidence. LongMemEval-S tuned gbrain's retrieval and the W10 answers on these questions are published.
The confirm split was set aside by the pilot's preregistration and no pilot cell read it; it is a development
confirm split, not held-out data.

## Build and data

- **gbrain-evals**: branch `capy/a6-evidence-brief-confirmation` from main `97e98bb9` (v0.10.53). Driver
  `eval/runner/pilot/` (`run.ts --split confirm`, `confirm.ts`, `cohort.ts`, `report.ts`), outcome instrument
  `eval/runner/outcomes/v3.ts`.
- **gbrain under test (retrieval)**: the W10a captures of gbrain `c5fb0201`'s own LongMemEval-S reader requests
  (release retrieval: balanced mode, reranker on, top 5 whole sessions), as in the pilot:
  `docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/capture/captures.ndjson.gz` sha256 `65e0def9...` and
  `harness-rows.ndjson.gz` sha256 `6be5e320...`. An arm replaces only the evidence section of the captured request.
- **Brief builder**: gbrain `src/eval/longmemeval/evidence-brief.ts` from the pinned dependency, gbrain `fc548317f`
  (v0.60.122.0), sha256 `a8da5b9b8baa8e52b3f644b89c6bfdbed977d3afc7ff3c96e820adbae71a0869` (the file the pilot ran).
- **Questions**: the confirm split, the 400 of 500 questions outside the pilot split (ids sorted, newline-joined,
  sha256 `a06ffb36a0f0ee5550ed2336ffd25af7dabd058b9a0dfdc8a2f2342f36c5427e`): temporal reasoning 102, multi-session 97,
  knowledge update 57, single-session user 51, single-session assistant 45, preference 24, unanswerable 24.
- **Committed A0 rows reused ($0)**: Sonnet 5.5 for all 400 from W10a (`arms/w10a-sonnet55-notes/rows.ndjson`), and
  `gpt-6.1-sol` for the 50 confirm questions inside W10c's subset (`w10c-sol-currentpin/rows.ndjson`). A test proves
  the pilot's A0 bodies are byte-identical to those arms' frozen manifests; the rows were produced through the batch
  lane on 2026-10-06/07 with the same model ids. The other 350 `gpt-6.1-sol` A0 rows and all 400 Opus 5.5 A0 rows are
  new synchronous calls with the identical bodies.

## Arms and settings

Reader instruction: the house notes reader (`gbrain-lme-reader-v4-notes-fullsessions`, sha256 `3db7ccbb...`).
Budgets are cl100k tokens of delivered evidence.

| Model | Role | Settings |
|---|---|---|
| `claude-sonnet-5-5` | frontier reader (primary), FALLBACK's escalation, commitment labeler | effort low, max_tokens 3,500 (W10a body); labeler as in the pilot |
| `claude-opus-5-5` | frontier reader | effort low, max_tokens 4,096 |
| `gpt-6.1-sol` | frontier reader | reasoning_effort medium, max_completion_tokens 12,000 |
| `claude-haiku-5-5` | brief builder, DIRECT reader | effort low, max_tokens 8,000 |
| `gpt-4o-2024-08-06` | official LongMemEval judge | temperature 0, max_tokens 10 |

No Fable, no older generation, no gpt-5.4-mini.

| Cell | Definition |
|---|---|
| A0 (comparator) | the frontier reader on the captured request (five whole sessions) |
| BRIEF@B | Haiku 5.5 writes `evidence-brief-v1` with the question; `validateBrief` grounds quotes and falls back to the full text on a parse or grounding failure; the frontier reader reads the rendered brief |
| TRUNC@B | whole session blocks in rank order while they fit B; else the top session's head |
| DIRECT | Haiku 5.5 reads the captured request |
| FALLBACK | DIRECT's answer, replaced by Sonnet 5.5's A0 answer when DIRECT's answer is an execution error, or its outcome-v3 commitment label (`judged-hedge-label-v1`, Sonnet 5.5 labeler) is `abstain` or `hedged`, or the label is missing; cost = Haiku call + label call + Sonnet call when escalated |

Thirteen reported cells: A0 for Sonnet 5.5, Opus 5.5 and `gpt-6.1-sol`; BRIEF@2000 for the same three readers;
BRIEF@1000, @4000 and @7000 for Sonnet 5.5; TRUNC@2000 and TRUNC@7000 for Sonnet 5.5; DIRECT; FALLBACK.

## Metric and denominator

- **Supported task success**: the official judge says the answer is correct (for unanswerable questions: that it
  declined). Denominator: all 400 questions. Every execution error (failed or empty call, `max_tokens` finish,
  judge failure) counts as a failure; nothing is excluded.
- **Committed-wrong (outcome-v3)**: an incorrect answer that commits to a value or action however it is hedged;
  commitment from the Sonnet 5.5 labeler (abstain precision 0.985 on GBRA-49's held-back sample); a missing label
  counts committed. The hedge axis is not validated (hedged precision 0.877), so no hedged-wrong count is reported.
- **Tokens and dollars on every row**: reader input and output (provider-reported, usage-receipt/v1), delivered
  evidence (cl100k), builder input and output, and list dollars of every call in the design.
- **Latency on every row**: the timing cohort below.

## Decision rule

Tolerance: **3.0 points** of supported task success, T0's frozen loss tolerance
([program primary preregistration](2026-10-08-program-primary-preregistration.md), "Loss tolerance (frozen)").
Each comparison pairs the arm with its comparator by question (cluster = question; LongMemEval questions do not
share histories). The test is `evaluateFamily` in `eval/runner/stats/gates.ts`, gate `noninferiority`, direction
higher, tolerance 0.03, cluster bootstrap with 10,000 draws (seed 20261011), one-sided alpha 0.025: an arm passes
when the lower bound of the two-sided 95% interval for (arm minus comparator) is above -3.0 points; it fails when
the whole interval is below -3.0 points; anything else is inconclusive. The families are fixed in
`eval/runner/pilot/confirm.ts` at this commit.

- **Primary** (its own family, no adjustment): BRIEF@2000 (Haiku 5.5) read by Sonnet 5.5 against A0 on Sonnet 5.5.
- **Secondaries** (one family, Holm across all nine): BRIEF@2000 on Opus 5.5 against Opus 5.5 A0; BRIEF@2000 on
  `gpt-6.1-sol` against `gpt-6.1-sol` A0; BRIEF@1000, @4000 and @7000 on Sonnet 5.5; TRUNC@2000 and TRUNC@7000 on
  Sonnet 5.5 (controls; expected to fail); DIRECT and FALLBACK against Sonnet 5.5 A0.
- **Power.** The pilot saw 3 of 100 Sonnet 5.5 questions discordant between BRIEF@2000 and A0 (2 to 1). At that
  discordance and a true difference of -0.25 points, the 95% interval on 400 questions is about ±1.7 points, so the
  primary is expected to pass if the pilot's estimate holds; a true difference of -1.5 points or worse makes a pass
  unlikely. Insufficient power yields "inconclusive", never a wider tolerance.

## Timing cohort

24 confirm questions stratified by report type (`stratifiedSample(report types of the confirm split, 24, seed
20261012)`, id sha256 `61f6485a97f3623090a6d7784b38a3773bb12aea818f89c7df2b570bcf847947`), **all thirteen reported
cells**, 312 units in a seeded random order (seed 20261013), one synchronous request at a time with no answer
cache. Timers per unit: builder, reader, commitment label and fallback calls (retrieval is replayed and identical
across arms; not timed). Reader calls whose usage reports a prompt-cache read form the cache-hit stratum. p50 and
p95 are reported on every row, overall and per stratum. Batch prices are never used for latency.

## Reporting

`docs/benchmarks/2026-10-0x-evidence-brief-confirmation.md` in the repository's report shape, with every cell's
supported task success, committed-wrong (and the all-wrong-committed bound), builder and reader tokens, dollars,
p95 and discordance against its comparator; both families' results with intervals and Holm-adjusted p-values; the
receipts (reads, builds, judges, labels, cohort, the report and the decision as JSON).

| If the primary passes | If the primary fails | If inconclusive |
|---|---|---|
| the brief is the candidate for the joint sealed v2 opening with GBRA-1 (separate preregistration); A8 and A9 stay unstarted until that verdict | the brief does not go to sealed v2; the report says so | report the interval; no sealed candidacy |

DIRECT and FALLBACK get a verdict from their secondary comparisons; a pass makes either a supported opt-in reader
policy on this development evidence, a fail or inconclusive result says it is not shown to match A0.

## Budget

Ledger `.budget/a6-gbra60.sqlite`, program cap **$150**. Every request goes through `installPaidRequestGuard`.

**Pricing smoke first**: the full pipeline on 5 pilot-split questions (no confirm question is read), all
thirteen cells, to confirm the request shapes on the new pin and measure dollars per question. Estimate from the
pilot's receipts at list price: builders $4.6, BRIEF readers $14.2, A0 (Opus 400 and `gpt-6.1-sol` 350) $51.3,
TRUNC $11.1, DIRECT and FALLBACK $2.0, judge $2.6, labels $1.4, timing cohort about $7: about **$94**.

**Contingency, fixed now.** If the smoke's extrapolation of the full grid plus the cohort exceeds the cap, drop, in
this order and only as far as needed: BRIEF@1000 and BRIEF@4000, then TRUNC@7000. The primary and its three readers
are never dropped. A dropped cell is removed from the secondary family before any confirm cell runs, recorded as a
dated amendment.

Order: smoke, builders, A0 and BRIEF@2000 for the three readers, the remaining cells, judge, labels, the timing
cohort.

## Amendments

None yet.
