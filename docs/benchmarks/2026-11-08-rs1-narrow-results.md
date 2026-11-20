# Narrowed RS1 results: on new million-token BEAM conversations, gbrain is within 3.5 points of both leading memory servers and ahead of one

- **We learned that gbrain's newest release keeps up with the two leading memory servers on long chat histories nobody
  had seen, and that it costs less per correct answer than either. You should treat gbrain at 8,000 tokens as a peer of
  the best memory servers we test on long conversations.** On 20 conversations of about a million tokens each, newly
  written by BEAM's generator and kept sealed, gbrain v0.60.740.0 scored 1.0 points above the memory-bank server (95%
  interval -1.7 to +3.7) and 2.8 points above the extract-first server (+0.7 to +5.0) under frontier judges. The
  preregistered claim, that gbrain is at most 3.5 points behind each server, passed: the one-sided 95% lower bounds were
  -1.2 against the memory-bank server and +1.1 against the extract-first server, and BEAM's own judge gives -0.9 and
  +0.9. The secondary test passed too, so gbrain is ahead of the extract-first server. With claude-opus-5-5 reading, a
  correct answer cost $0.153 with gbrain, $0.176 with the memory-bank server and $0.274 with the extract-first server,
  and gbrain was also the cheapest per correct answer with particle-1 and gpt-6.1-sol reading.
- **We learned that gbrain is not ahead of the memory-bank server, and that it trails it on questions that join facts
  from several sessions. You should test those questions on your own workload before you rely on gbrain for them.** The
  secondary test against the memory-bank server failed: its lower bound is -1.2, below 0. Per ability, a descriptive
  reading with no correction for the 20 ability rows, gbrain was 10.5 points behind the memory-bank server on
  multi-session reasoning under frontier judges (-16.4 to -4.5) and 4.9 behind under BEAM's judge (-11.1 to +1.3). It
  also leaned behind on temporal reasoning (-10.7, -21.8 to +0.4) and event ordering (-3.2, -6.9 to +0.6), and it was
  ahead on instruction following (+13.8, +5.0 to +22.5) and summarization (+8.4, +1.2 to +15.5).
- **We learned that gbrain's own fact extraction leaves a small share of pages without facts, mostly because the model
  provider's safety filter stopped it, and that a harness that fails the build on those pages leaves the brain half
  built. You should record those pages as their own outcome, keep building, and report how many there are.** Across the
  20 gbrain brains, 126 of 17,563 pages (0.72%) ended without facts: 73 (0.42%) because Anthropic's safety filter
  stopped claude-haiku-5-5, gbrain's extraction model, and 53 (0.30%) because gbrain's parser skipped the page as
  unparsed. In wave A's first run our harness stopped 17 of the 20 gbrain builds at those pages, before the fact index
  was built. We changed it to record them, in a dated amendment written before the rerun, and ran gbrain's units again.
  The servers' and the floor's runs stand.

This is the results file of the [narrowed RS1 preregistration](2026-11-08-rs1-narrow-preregistration.md), frozen by its
merge commit `325a1c04` (#390) on 2026-11-08 and changed since only by its dated amendments. The preregistered verdict is
**pass**: gbrain's newest release at wave A's launch, reading 8,000 tokens, is at most 3.5 points behind both the
memory-bank server and the extract-first server. The secondary sequence finds gbrain ahead of the extract-first server
and not ahead of the memory-bank server. 397 of the 400 planned questions are in every comparison; the other 3 dropped
because a server's answer had no frontier judgment. Every number here comes from one gbrain build, one reading budget
and one conversation generator.

Settled call: gbrain may state, as a tested result, that v0.60.740.0 at 8,000 tokens is within 3.5 points of the
memory-bank and extract-first servers on new BEAM-1M conversations and ahead of the extract-first server; it may not claim
a lead over the memory-bank server.

## The first table: cost per correct answer

For each reader and row, cost per correct answer is the row's ingest, retrieval and background dollars divided by its
questions, plus the reader's own dollars per answer, all divided by that reader's mean graded score, from the metering
proxy's usage fields. BEAM grades each answer from 0 to 1, so partial credit counts as part of a correct answer. Judges'
dollars are left out, because they buy the measurement, not the answer.

| Reader | Row | Cost per question | Score, frontier view | Cost per correct, frontier view | Score, BEAM's judge | Cost per correct, BEAM's judge |
|---|---|---:|---:|---:|---:|---:|
| claude-opus-5-5 | gbrain | $0.1205 | 78.75 | $0.1530 | 74.06 | $0.1627 |
| claude-opus-5-5 | memory-bank server | $0.1338 | 76.12 | $0.1758 | 71.33 | $0.1876 |
| claude-opus-5-5 | extract-first server | $0.2076 | 75.67 | $0.2743 | 71.12 | $0.2919 |
| claude-opus-5-5 | no-memory floor | $0.0091 | n/a | n/a | 26.22 | $0.0347 |
| particle-1 | gbrain | $0.0673 | 73.75 | $0.0912 | 78.11 | $0.0861 |
| particle-1 | memory-bank server | $0.0847 | 73.16 | $0.1157 | 78.41 | $0.1080 |
| particle-1 | extract-first server | $0.1540 | 71.03 | $0.2167 | 77.47 | $0.1987 |
| particle-1 | no-memory floor | $0.0003 | n/a | n/a | 21.62 | $0.0015 |
| gpt-6.1-sol | gbrain | $0.0817 | 72.87 | $0.1121 | 78.37 | $0.1042 |
| gpt-6.1-sol | memory-bank server | $0.0993 | 73.40 | $0.1353 | 77.81 | $0.1276 |
| gpt-6.1-sol | extract-first server | $0.1688 | 70.33 | $0.2399 | 74.78 | $0.2257 |
| gpt-6.1-sol | no-memory floor | $0.0015 | n/a | n/a | 20.12 | $0.0075 |

- **gbrain is the cheapest per correct answer for every reader, in both views.** Against the memory-bank server it is
  13% cheaper with claude-opus-5-5 reading, 21% with particle-1 and 17% with gpt-6.1-sol (frontier view); against the
  extract-first server it is 44%, 58% and 53% cheaper.
- **The ingest share depends on how many questions a conversation gets.** Each row's ingest is spread over 20 questions
  per million-token conversation. A workload that asks more questions of the same history spreads ingest thinner, so the
  gaps between rows would change.
- **Compare readers only under BEAM's judge.** In the frontier view each reader has its own judge (gpt-6-astra grades
  claude-opus-5-5, and claude-opus-5-5 grades particle-1 and gpt-6.1-sol), so its score columns compare rows within a
  reader. BEAM's judge, gpt-4.1-mini, grades all three readers. On gbrain's contexts particle-1 scored 5.0 points below
  claude-opus-5-5 in the frontier view and 4.0 points above it under BEAM's judge; no interval was preregistered for
  that gap. The floor row is graded by BEAM's judge only, as preregistered.
- Each score is that reader's mean over every question the row answered and its judge graded, so it can differ slightly
  from the paired rows below, which use the 397 common questions.

## The verdict

A question's score is the mean over the three readers of BEAM's graded score times 100. A conversation's difference is
the mean over its common questions of gbrain minus the server, and each test is the mean of the 20 conversation
differences with its one-sided 95% t lower bound on 19 degrees of freedom. The verdict rests on the frontier view
(gpt-6-astra grades claude-opus-5-5's answers, and claude-opus-5-5 grades gpt-6.1-sol's and particle-1's), whose judges
passed the [judge check](2026-11-08-rs1-narrow/results/judge-check.md) before wave A. BEAM's judge, gpt-4.1-mini, is the
descriptive bridge to earlier BEAM results, and it breaks the family rule on gpt-6.1-sol's answers.

| Test | Role | Conversations | Estimate | SD | One-sided 95% lower bound | Above -3.5 | Bootstrap lower bound | Worst-case lower bound |
|---|---|---:|---:|---:|---:|---|---:|---:|
| gbrain minus memory-bank server, frontier view | gating | 20 | +1.00 | 5.72 | -1.21 | yes | -1.22 | -1.70 |
| gbrain minus memory-bank server, BEAM's judge | descriptive | 20 | +1.13 | 5.33 | -0.93 | yes | -0.96 | -1.41 |
| gbrain minus extract-first server, frontier view | gating | 20 | +2.83 | 4.54 | +1.07 | yes | +1.10 | +0.63 |
| gbrain minus extract-first server, BEAM's judge | descriptive | 20 | +2.48 | 3.97 | +0.94 | yes | +0.97 | +0.46 |

**Secondaries**, tested in a fixed order only after the primary passed: superiority over the extract-first server
**passes** (lower bounds +1.07 and +0.94, both above 0), and superiority over the memory-bank server **fails** (-1.21).

## Sensitivity checks and the delivered-context gate

- **Worst case.** Scoring every gbrain-side drop 0 and every server-side drop 100 gives estimates of +0.52 and +0.63
  against the memory-bank server and +2.51 and +2.14 against the extract-first server, with the lower bounds in the
  table above. All four stay above -3.5, so the worst case agrees with the verdict.
- **Bootstrap.** The restricted wild cluster bootstrap-t (Webb weights, 9,999 draws, seed 20261108) gives lower bounds
  within 0.04 points of the t bounds, and it agrees with the t test on all four.
- **Delivered-context gate.** Mean fill rates were 0.981 for gbrain, 0.984 for the memory-bank server and 0.990 for the
  extract-first server, all at or above the 0.90 gate, so every comparison counts.
- **Floor.** The no-memory floor scored 22.66 under BEAM's judge over 400 questions, below every system row.
- **Drops.** 5 server-side frontier judgments were missing, covering 3 questions, which is 0.75% of the plan against a
  5% cap. No gbrain-side question dropped, and BEAM's judge dropped none.

## Per reader and per ability

Descriptive, frontier view, gbrain minus the server on the same questions, in points, with no correction for multiple
comparisons. The same rows under BEAM's judge are in [aggregates.md](2026-11-08-rs1-narrow/results/aggregates.md).

| Server | Subset | Questions | Mean difference | 95% interval | gbrain lower / higher / tied | Reading |
|---|---|---:|---:|---|---|---|
| memory-bank | overall | 397 | +1.00 | -1.67 to +3.68 | 97 / 123 / 177 | no measurable difference |
| memory-bank | reader claude-opus-5-5 | 397 | +2.68 | -0.04 to +5.39 | 65 / 97 / 235 | no measurable difference |
| memory-bank | reader gpt-6.1-sol | 397 | -0.29 | -3.30 to +2.71 | 91 / 76 / 230 | no measurable difference |
| memory-bank | reader particle-1 | 397 | +0.63 | -2.27 to +3.53 | 89 / 99 / 209 | no measurable difference |
| memory-bank | abstention | 40 | +1.04 | -0.95 to +3.03 | 1 / 2 / 37 | no measurable difference |
| memory-bank | contradiction resolution | 40 | +0.63 | -5.60 to +6.85 | 17 / 16 / 7 | no measurable difference |
| memory-bank | event ordering | 37 | -3.16 | -6.93 to +0.61 | 22 / 15 / 0 | no measurable difference |
| memory-bank | information extraction | 40 | +7.67 | -0.77 to +16.12 | 3 / 12 / 25 | no measurable difference |
| memory-bank | instruction following | 40 | +13.75 | +5.01 to +22.49 | 5 / 26 / 9 | gbrain higher |
| memory-bank | knowledge update | 40 | 0.00 | -2.19 to +2.19 | 1 / 2 / 37 | no measurable difference |
| memory-bank | multi-session reasoning | 40 | -10.48 | -16.43 to -4.53 | 13 / 2 / 25 | gbrain lower |
| memory-bank | preference following | 40 | +1.65 | -5.52 to +8.83 | 12 / 16 / 12 | no measurable difference |
| memory-bank | summarization | 40 | +8.35 | +1.17 to +15.53 | 11 / 27 / 2 | gbrain higher |
| memory-bank | temporal reasoning | 40 | -10.69 | -21.80 to +0.42 | 12 / 5 / 23 | no measurable difference |
| extract-first | overall | 397 | +2.83 | +0.70 to +4.96 | 108 / 126 / 163 | gbrain higher |
| extract-first | reader claude-opus-5-5 | 397 | +3.08 | +0.93 to +5.24 | 70 / 102 / 225 | gbrain higher |
| extract-first | reader gpt-6.1-sol | 397 | +2.55 | -0.08 to +5.18 | 90 / 96 / 211 | no measurable difference |
| extract-first | reader particle-1 | 397 | +2.86 | +0.13 to +5.58 | 99 / 94 / 204 | gbrain higher |
| extract-first | abstention | 40 | +0.42 | -0.98 to +1.82 | 1 / 1 / 38 | no measurable difference |
| extract-first | contradiction resolution | 40 | +7.50 | -0.40 to +15.40 | 11 / 26 / 3 | no measurable difference |
| extract-first | event ordering | 37 | -0.98 | -3.99 to +2.04 | 21 / 16 / 0 | no measurable difference |
| extract-first | information extraction | 40 | +4.62 | -3.97 to +13.21 | 9 / 10 / 21 | no measurable difference |
| extract-first | instruction following | 40 | +7.67 | +1.70 to +13.65 | 8 / 20 / 12 | gbrain higher |
| extract-first | knowledge update | 40 | +16.25 | +6.83 to +25.67 | 0 / 12 / 28 | gbrain higher |
| extract-first | multi-session reasoning | 40 | -4.32 | -11.92 to +3.28 | 13 / 6 / 21 | no measurable difference |
| extract-first | preference following | 40 | -0.43 | -8.46 to +7.59 | 15 / 13 / 12 | no measurable difference |
| extract-first | summarization | 40 | -3.03 | -8.04 to +1.97 | 21 / 13 / 6 | no measurable difference |
| extract-first | temporal reasoning | 40 | -0.28 | -10.67 to +10.11 | 9 / 9 / 22 | no measurable difference |

Each ability has 2 questions per conversation; event ordering has 37 because the 3 dropped questions were all event
ordering questions.

## gbrain's pages without facts, by cause

gbrain's brain build writes one page per chat session and extracts facts from each page with claude-haiku-5-5. Since the
2026-11-19 amendment the build records two outcomes and carries on: pages the provider's safety filter stopped, and pages
gbrain's parser skipped as unparsed. Every other extraction problem still fails the realization. Each realization's
ingest record keeps the counts, and they were read in custody after each unit finished.

| Cause | Pages | Share of 17,563 pages |
|---|---:|---:|
| Stopped by the provider's safety filter (`content_filter`) | 73 | 0.42% |
| Skipped by gbrain's parser as unparsed | 53 | 0.30% |
| All pages without facts | 126 | 0.72% |

- 3 of the 20 builds had no such page and 17 recorded at least one. Per conversation, safety-filter stops ranged from 0
  to 14 pages and unparsed pages from 0 to 10. No build was degraded and none stopped on its extraction cap.
- The safety-filter stops are Anthropic's, on claude-haiku-5-5 inside gbrain. In v0.60.740.0 one stopped extraction
  request leaves its whole page without facts.
- These counts come from each build's last extraction pass, so a page that failed on an earlier pass and succeeded on a
  retry isn't counted.
- gbrain writes why it skipped a page as unparsed only to its error stream, which the harness didn't keep, so the cause
  of those 53 pages is unknown.

## What it can and can't claim

On newly minted million-token conversations written by BEAM's generator from new topics, gbrain v0.60.740.0
(`82fdd000`), reading 8,000 tokens, is at most 3.5 points behind each of the two leading servers, the memory-bank server
and the extract-first server, under frontier judges, and BEAM's judge agrees. It is ahead of the extract-first server.
That puts gbrain in the leading group. It does not say:

- that gbrain beats the memory-bank server;
- anything about how the two servers rank against each other;
- anything about other token budgets, other benchmarks, 10M-token histories or other gbrain builds.

The margin is wider than the 1.5 to 3.4-point spread among F6's top three external servers, so passing does not separate
gbrain from the next server down. gbrain's retrieval settings (F6's arm P) were chosen on F6's BEAM-1M set, while the
servers ran their headline configurations untuned; RS1's conversations are new to every system, which is the point of
the test. A second generator family or a set of real chat histories is the next held-out step. RS1 froze its readers on
2026-11-08 with gpt-6.1-sol; the repository's model rules now name gpt-6.2-sol, which this run didn't measure.

## The test

| Row | System and pin | Configuration | Role |
|---|---|---|---|
| gbrain | v0.60.740.0 (`82fdd000`), gbrain's newest release at wave A's launch on 2026-11-18 | `rs1-stable`: gbrain's default fact extraction, the quiesce barrier and the fact index, F6's arm P retrieval (`query` limit 50, token budget 5,500, facts block on), idle upkeep off, safety-filter and unparsed pages recorded | subject |
| memory-bank server | bundle lock `f54d89df`, capabilities `23a033f4` | `recipe` | comparator |
| extract-first server | bundle lock `9777b7a8`, capabilities `0acaff3a` | `common` | comparator |
| no-memory floor | harness baseline | the question alone | floor, never part of a claim |

Systems are named by kind; [comparisons and their protocols](../comparison-systems.md) names each product and version.
Every row handed the reader at most 8,000 cl100k tokens per question. The 20 kept conversations, `rs1-002` to
`rs1-026`, were minted in custody with BEAM's generator (commit `b2da22e`, gemini-3.8-flash) and validated by validate.ts
before they were kept. Each has 20 questions, 2 for each of BEAM's ten abilities, in BEAM's rubric format with graded
scoring. claude-opus-5-5 and gpt-6.1-sol each answered every frozen context in one direct API call, and particle-1
re-read the same contexts afterwards.

## Run log

- **2026-11-08:** preregistration and harness merged at `325a1c04`. Next: stage 1 on set `RS1-dev2` (public BEAM
  data only), the pre-run fixes listed in the preregistration's amendments, then wave A.
- **2026-11-08, stage 1 on `RS1-dev2`:** ran on one Ubicloud VM from `80518b25`, 09:05Z to 23:20Z, with conversations
  `1m-20` and `1m-28`. It is a smoke test and not a counted result, so its scores are not reported here. The first
  launch, from `799813b3`, was refused by the preflight before any lease was taken. Fix 6 in the amendments covers it.
  - **Rows.** All four rows completed: the floor, gbrain-defaults `rs1-stable`, the memory-bank server and the
    extract-first server. Each has 40 questions, 80 answers (Opus and Sol live), 0 unjudged answers and 0 invalid
    reasons.
  - **Judge views.** The three system rows were judged under both views, 160 judgments each. As preregistered, the
    floor row was judged by the protocol judge only, 80 judgments.
  - **Server bundles.** Both ingested both conversations: 851 and 870 sessions, 0 failed sessions, 0 degraded
    conversations. One embedding request during the extract-first server's ingest returned HTTP 400, was not billed,
    and failed no session.
  - **particle-1 re-reads.** All four completed, each with 40 answers and 0 unjudged. The three system-row re-reads
    were also judged under the frontier view by gpt-6.1-sol.
  - **Spend.** Stage 1 finished inside its window cap, with no ledger overshoot and no open reservations.
  - **gbrain ingest at the stable tag.** 1,974,748 tokens over 12,591 s of ingest wall time, or 1.77 VM hours per
    million tokens. The placeholder was 1.92. The repricing that follows from it is the preregistration's 2026-11-08
    "pricing rerun after stage 1" amendment.
- **Before wave A, minting in custody:** paid mints with BEAM's generator and validation by validate.ts
  (gemini-3.8-flash and claude-haiku-5-5, with claude-sonnet-5-5 answering prompts Haiku refused from the 2026-11-17
  amendment) kept 20 conversations, filled into the RS1 manifest.
- **2026-11-18 to 2026-11-19, wave A:** 16 units (each row in four units of five conversations) ran from `e65bf230` at gbrain
  v0.60.740.0, with 16 particle-1 re-reads. All completed, but 17 of gbrain's 20 realizations were degraded: the harness
  stopped their builds at safety-filter and unparsed pages. The servers and the floor had none of 60.
- **2026-11-19, the build fix:** `0eb85687` sets `GBRAIN_F6_BUILD_PROBLEMS=record` in gbrain's cells (the
  preregistration's 2026-11-19 amendment). Only gbrain's run identity moved; the servers' and the floor's are
  byte-identical. The keyless F6 Docker smoke passed at v0.60.740.0, both as committed and with a fake safety-filter
  refusal injected.
- **2026-11-20, gbrain's rerun:** gbrain's four units ran again from `0eb85687`, with their four particle-1 re-reads.
  All completed with no degraded realization. The internal pilot then gave a required size of 19, so N_final is 20 under
  the preregistered rule, wave B is empty and the verdict reads wave A's 20 conversations (the 2026-11-20 amendment).
- **2026-11-20, the verdict:** the custodian refilled the manifest at n_final 20 (SHA-256 `d61e2689…`) and ran
  `eval/runner/rs1/verdict.ts aggregates` at 23:04Z from `a90e6c2a`, with a clean tree, over the 32 receipt
  directories (16 cell units and 16 re-reads). Its provenance: verdict.ts `a080b72d…`, iut.ts `dbd7a8a3…`,
  rs1-cells.json `1d4cefd0…`, 144 receipt files `12ccdf42…`. The output is
  [aggregates.json](2026-11-08-rs1-narrow/results/aggregates.json) and
  [aggregates.md](2026-11-08-rs1-narrow/results/aggregates.md), ids, hashes and numbers only.

## Open notes

- **Record mode's limits.** Record mode reads only each build's last extraction pass, and its match on a failure's reason
  isn't anchored to the start of the page's line. Every refused page here carried `content_filter`.
- **Unparsed pages.** gbrain doesn't keep why it skipped a page as unparsed, so that cause is open.
- **The floor's judge version.** The floor row's gpt-4.1-mini judgments didn't record a model version. The floor is
  descriptive only.
- **Harness notes.** Notes on the validator's fallback, the budget ledger and the run briefs, none of them in the
  scoring or verdict code, are listed in the pull request (#391).

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
