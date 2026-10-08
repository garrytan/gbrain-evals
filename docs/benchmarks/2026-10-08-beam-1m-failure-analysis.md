# BEAM-1M failure analysis: the 1M no-memory floor is 26 to 31%, perfect evidence lifts a frontier reader to 85%, and retrieval is most of the remaining gap

Date: 2026-10-08. Item B2 / E5.3 of wave 0 in the 10x memory advantage plan (`docs/plans/2026-10-07-10x-memory-advantage/PLAN.md` on [draft PR #97](https://github.com/garrytan/gbrain-evals/pull/97), thread GBRA-60). Evidence class: development evidence (BEAM-1M dev, 11 conversations, 220 questions; no sealed conversation was read). Preregistration: [2026-10-08-beam-1m-failure-analysis-preregistration.md](2026-10-08-beam-1m-failure-analysis-preregistration.md), committed before any paid request, with four amendments each committed before the cells it affects. Builds: the frozen ranked lists of the [2026-10-06 report](2026-10-06-beam-1m-dates.md) (gbrain `6622a119e`, `openai:text-embedding-3-large`) and fresh retrieval at gbrain `7aa2caa0` (v0.60.106.0) with `voyage:voyage-4`. Spend: $52.42 of a $60 cap. Status: every preregistered arm **Complete**.

## The finding

[BEAM](https://github.com/mohammadtavakoli78/BEAM) is a public benchmark of very long conversations; in its 1M size each conversation holds about a million tokens, so a memory system has to find the few turns that answer a question. [gbrain](https://github.com/garrytan/gbrain) scored 53.5% there on 2026-10-06 with a `gpt-4.1-mini` reader. That number had no floor, an old reader and no breakdown. This analysis supplies all three, on the development split only.

| BEAM-1M dev, 220 questions, judge `gpt-4.1-mini` per rubric item | Answer score | All rubric items met | Same reader, no memory |
|---|---:|---:|---:|
| Published row, `gpt-4.1-mini` reader, top 5 turn groups (2026-10-06) | 53.5% | 75 (34.1%) | 26.2%, 31 (14.1%) |
| Same evidence, `gpt-4.1-mini`, reader prompt's date order fixed (A0) | 53.9% | 78 (35.5%) | 26.2%, 31 (14.1%) |
| Same evidence, `gpt-6.1-sol` reader (A2) | **62.0%** | 96 (43.6%) | 28.6%, 41 (18.6%) |
| `gpt-6.1-sol`, top 10 turn groups instead of 5 (A3) | 64.9% | 107 (48.6%) | 28.6%, 41 (18.6%) |
| `gpt-6.1-sol`, voyage-4 retrieval with the reranker, top 5 (A5) | 66.1% | 104 (47.3%) | 28.6%, 41 (18.6%) |
| `gpt-6.1-sol`, every gold turn group and nothing else (oracle, A4) | **84.9%** | 165 (75.0%) | 28.6%, 41 (18.6%) |

Four conclusions:

1. **The 1M floor is 26.2% with the bridge reader**, and 28.6% to 31.3% with current frontier readers (Sonnet 5.5 31.3%, Opus 5.5 31.0%, gpt-6.1-sol 28.6%). The 0.278 quoted so far was BEAM-100K's. BEAM's rubric gives partial credit, so a reader that answers from general knowledge or declines politely already earns about a quarter of the points. Every BEAM-1M number should be read against that floor and against its strict all-items-met rate.
2. **The reader is the cheapest gain.** On byte-identical evidence, `gpt-6.1-sol` scores 8.1 points above `gpt-4.1-mini` (95% interval [4.4, 12.2]). The published 53.5% understates what gbrain's evidence supports with a current reader.
3. **Retrieval is most of what is left.** With perfect evidence `gpt-6.1-sol` reaches 84.9%, 22.9 points above its top-5 score ([18.8, 27.3]). Between its floor (28.6%) and that ceiling, gbrain's top 5 recovers 59% of the range.
4. **The reranker improves retrieval clearly; its answer gain is not yet distinguished.** gbrain's shipped reranker (`voyage:rerank-2.5`, balanced mode) raises strict recall at 5 from 47 to 57 of 198 (+5.1 points, [2.5, 8.1]); the answers move +3.2 points ([-1.9, 7.6]), which 11 conversations cannot separate from zero. Reading 10 turn groups instead of 5 (+2.9, [-0.4, 6.7]) and a deeper candidate pool without the reranker (no change) are weaker.

Two defects in the evaluation harness surfaced, and one reshapes how the published row should be read: the reader prompt listed BEAM sessions alphabetically by month name and gave the reader a wrong "Current Date" (fixed here; the published row moves +0.4 points, within noise), and the runner's output limit cut 41% of Sonnet 5.5's answers and 49% of Opus 5.5's, so this run cannot rank the three frontier readers (see [What to use and what to avoid](#what-to-use-and-what-to-avoid)).

## The concrete case

BEAM asks ten kinds of question. Three invented examples in its style show why one "accuracy" hides different failures:

- *Information extraction*: "What dose did I settle on after the March follow-up?" One turn group holds the answer. If retrieval finds it, any reader answers it.
- *Event ordering*: "In what order did I raise my seven cardiology questions? Mention ONLY and ONLY seven items." The gold is spread over a median of 24 turn groups. Strict recall at 5 (every gold turn group in the top 5) is impossible by construction; the rubric still gives partial credit per item.
- *Abstention*: "What did Dr. Kaya say about my MRI?" when the conversation never mentions an MRI. The right answer is to decline. A reader shown five plausible but unrelated sessions often answers anyway.

A **turn group** is one exchange of 2 to 6 messages, BEAM's own `turn_chunk` retrieval unit, which gbrain-evals imports as one session page. A BEAM **batch** is a dated block of about 100k tokens, ten per 1M conversation.

## The experiment and results

**Data.** BEAM revision `b2da22e` (manifest `eval/decisions/datasets/beam-b2da22e.json`), size 1M, dev split: 11 conversations, 220 questions (198 answerable, 22 abstention). 194 answerable questions have gold turn groups the loader can map; 4 do not (`1m-16:summarization:0`, `1m-16:summarization:1`, `1m-20:summarization:1`, `1m-3:preference_following:1`) and count as misses in the 198 denominator, as before. The runner now reads only the dev conversations' files on a dev run.

**Readers and judge.** Counted readers: `anthropic:claude-sonnet-5-5`, `anthropic:claude-opus-5-5`, `openai:gpt-6.1-sol`, the newest Sonnet, Opus and GPT on the run date. `openai:gpt-4.1-mini` runs only as the bridge to the published row. The judge is `openai:gpt-4.1-mini`, one yes/no call per rubric item, the fixed instrument of every BEAM row so far. One answer per question. Claude 5 models reject `temperature`, so they and `gpt-6.1-sol` sample at the provider default; `gpt-4.1-mini` runs at temperature 0. Paired differences use a cluster bootstrap over the 11 conversations (10,000 draws, seed 42); an interval that crosses zero means "not distinguished at this sample size".

### 1. Free decomposition of the published row ($0)

[`decompose.ts`](2026-10-08-beam-1m-failure-analysis/decompose.ts) recomputes these from the committed 2026-10-06 rows and the dataset ([`decomposition.json`](2026-10-08-beam-1m-failure-analysis/decomposition.json)).

**Strict recall has a ceiling that is a property of the questions.** Of 194 answerable questions with gold, 41 need 1 gold turn group, 40 need 2, 32 need 3, 24 need 4, 8 need 5, 15 need 6 to 10 and 34 need more than 10 (maximum 38). So 49 can never pass strict recall at 5 and 34 can never pass it at 10. On the feasible questions, strict recall is 36 of 145 at 5 (24.8%) and 57 of 160 at 10 (35.6%). By gold count at 5: 18 of 41, 13 of 40, 5 of 32, 0 of 24, 0 of 8. This feasibility figure is reported apart from the answer rubric: the 49 infeasible questions still average 0.411 on answers.

**The unit is BEAM's own, and batch-level credit is much higher.** BEAM's reference retrievers index `turn_chunk` (a turn group) or `pair_chunk` (one user and assistant message pair); gbrain-evals' unit matches the first, so the large gold counts are BEAM's, not an artifact of the loader. Scored at batch granularity instead, 123 of 194 questions have all their gold in one batch, and the published top 5 turn groups touch every gold batch for 124 of 194 (63.9%) and at least one for 181. Retrieval usually lands in the right 100k-token block; it does not pick the right turns inside it. A batch is too large to hand a reader, so batch-level credit is context, not a better score.

**Where the published answers lose points.** By retrieval bucket (answers with the bridge reader):

| Bucket | Questions | Mean score | All items met | Zero |
|---|---:|---:|---:|---:|
| Every gold turn group in the top 5 | 36 | 0.727 | 23 | 7 |
| Some gold in the top 5 | 101 | 0.586 | 30 | 19 |
| No gold in the top 5 | 57 | 0.409 | 14 | 19 |
| Answerable, gold not mappable | 4 | 0.625 | 2 | 0 |
| Abstention | 22 | 0.295 | 6 | 15 |

The plan's "61 none@5" counted the 4 unmappable questions with the 57.

| Category (22 each) | Median gold (upper) | all / some / none @5 | Published | `gpt-6.1-sol` top 5 | `gpt-6.1-sol` oracle | `gpt-6.1-sol` no memory |
|---|---:|---|---:|---:|---:|---:|
| Event ordering | 24 | 0 / 12 / 10 | 0.468 | 0.509 | 0.991 | 0.005 |
| Summarization | 14 | 0 / 11 / 8 | 0.397 | 0.397 | 0.372 | 0.124 |
| Information extraction | 1 | 8 / 2 / 12 | 0.412 | 0.571 | 0.945 | 0 |
| Temporal reasoning | 3 | 5 / 14 / 3 | 0.424 | 0.424 | 0.773 | 0.023 |
| Knowledge update | 3 | 5 / 16 / 1 | 0.455 | 0.500 | 0.955 | 0 |
| Multi-session reasoning | 4 | 3 / 15 / 4 | 0.601 | 0.677 | 0.817 | 0.180 |
| Contradiction resolution | 3 | 4 / 17 / 1 | 0.659 | 0.761 | 0.795 | 0.318 |
| Instruction following | 1 | 6 / 1 / 15 | 0.712 | 0.811 | 0.879 | 0.595 |
| Preference following | 3 | 5 / 13 / 3 | 0.924 | 0.977 | 0.962 | 0.614 |
| Abstention | 0 | n/a | 0.295 | 0.568 | 1.000 | 1.000 |

(The bucket counts cover questions with mappable gold; summarization has 3 answerable questions without it and preference following 1.) Event ordering, information extraction and knowledge update gain 37 to 46 points from perfect evidence: those are retrieval failures. Summarization does not gain at all, so its rubric (breadth of a long summary) is not a retrieval problem a top-k list can fix. Knowledge update scores 0.50 with 21 of 22 questions having some gold in the top 5 and 0.955 with only the gold: the reader is misled by the superseded values the top 5 also contains.

**The 57 none@5 questions.** Classified by the words they share with their gold ([rule in `decompose.ts`](2026-10-08-beam-1m-failure-analysis/decompose.ts)): **30 semantic drift** (most of the question's content words are in the gold text, but other turn groups outrank it; 8 event ordering, 8 summarization, 5 information extraction), **15 lexical gap** (fewer than half the question's words appear in the gold; 9 of them instruction following, where the gold is the turn that set a rule such as "always give version numbers" and the question is about something else) and **12 date-scoped** (the question names a date or a time relation; 18 of the 57 do under any label). For 42 of the 57, the top 5 turn groups contain at least as many of the question's words as the gold does: the distractors are lexically close, which is what a reranker is for. A keyword-only control (hash bag-of-words vectors through the same hybrid search, free) finds some gold for only 10 of the 57 and is far worse overall (any@5 70 of 194 against 137), so the misses are not keyword misses that the embedding lost.

**Committed-wrong answers, regardless of hedge.** Every one of the 60 zero-score answers in the published row was read and labelled ([`committed-wrong-labels.json`](2026-10-08-beam-1m-failure-analysis/committed-wrong-labels.json); labeller: Capy, a model, not a human): 50 commit to a wrong value (35 answerable, 15 of the 22 abstention questions), 5 decline an answerable question, and 5 are cut off before a conclusion (the runner stored only the first 2,000 characters of an answer; 151 of 220 stored answers were cut). So **50 of 220 (22.7%) are committed-wrong**, 55 at most; the audit's heuristic estimate was 56. Another 85 answers earn partial credit. A deterministic decline detector agrees with 52 of 55 decided labels on these answers but reads frontier answers less well (on `gpt-6.1-sol`'s top-5 arm it counts 45 committed-wrong where hand labels give 40), so detector counts below are upper bounds.

### 2. Reading arms on the frozen evidence

All arms read the same top-5 (or top-10) ranked lists the published row used, replayed from its committed rows; the replay reproduces the published retrieval exactly (strict@5 36 of 198).

| Arm | Reader | Score | All items met | Answerable | Abstention | No-memory floor | Committed-wrong | Input / output tokens per answer | Cost |
|---|---|---:|---:|---:|---:|---:|---|---|---:|
| A0 top 5 | `gpt-4.1-mini` | 0.539 | 78 | 0.571 | 0.250 | 0.262 (31) | 57 detector | 7,179 / 684 | $1.14 |
| A2 top 5 | Sonnet 5.5 | 0.573 | 104 | 0.561 | 0.682 | 0.313 (45) | 62 detector | 11,818 / 767 | $7.03 |
| A2 top 5 | Opus 5.5 | 0.527 | 89 | 0.507 | 0.705 | 0.310 (48) | 58 detector | 11,818 / 849 | $14.29 |
| A2 top 5 | `gpt-6.1-sol` | 0.620 | 96 | 0.625 | 0.568 | 0.286 (41) | **40 hand** (45 detector) | 7,178 / 438 | $4.30 |
| A3 top 10 | `gpt-6.1-sol` | 0.649 | 107 | 0.660 | 0.545 | 0.286 (41) | 43 detector | 14,121 / 465 | $7.42 |
| A4 oracle | `gpt-6.1-sol` | 0.849 | 165 | 0.832 | 1.000 | 0.286 (41) | 13 detector | 6,937 / 404 | $4.05 |

Floors (A1, empty history): `gpt-4.1-mini` 0.262 (31 all items met; answerable 0.216, abstention 0.682), Sonnet 5.5 0.313 (45; 0.236, 1.0), Opus 5.5 0.310 (48; 0.234, 1.0), `gpt-6.1-sol` 0.286 (41; 0.206, 1.0); cost $0.25, $1.18, $2.15 and $0.60.

| Paired comparison (b minus a) | Score difference [95% interval] | All items met difference | Better / worse questions |
|---|---|---|---|
| A0 fixed date order minus published (bridge) | +0.4 [-3.0, +3.1] | +1.4 [-1.8, +4.1] | 28 / 25 |
| `gpt-6.1-sol` minus bridge, same top 5 | **+8.1 [+4.4, +12.2]** | +8.2 [+4.1, +12.3] | 53 / 19 |
| Sonnet 5.5 minus bridge, same top 5 | +3.5 [-0.7, +8.3] | +11.8 [+6.8, +17.7] | 50 / 38 |
| Opus 5.5 minus bridge, same top 5 | -1.2 [-5.7, +3.6] | +5.0 [0, +10.9] | 46 / 57 |
| `gpt-6.1-sol` top 5 minus its floor | +33.4 [+29.1, +37.8] | +25.0 [+20.5, +29.6] | 131 / 14 |
| `gpt-6.1-sol` top 10 minus top 5 | +2.9 [-0.4, +6.7] | +5.0 [-0.5, +11.4] | 44 / 22 |
| `gpt-6.1-sol` oracle minus top 5 | **+22.9 [+18.8, +27.3]** | +31.4 [+25.5, +36.8] | 89 / 15 |

**Memory hurts abstention.** With no memory every frontier reader declines all 22 abstention questions (score 1.0). Shown five plausible turn groups, `gpt-6.1-sol` answers 9 of them anyway (0.568), and with ten turn groups slightly more (0.545). The oracle arm gives abstention questions an empty history, so its 1.0 there is the floor's.

### 3. Retrieval arms at gbrain `7aa2caa0` with voyage-4

| Retrieval (198 answerable; feasible subsets 145 at 5, 160 at 10) | Strict @5 | Strict @10 | Any @5 | nDCG@10 | Cost |
|---|---:|---:|---:|---:|---:|
| Published: OpenAI `text-embedding-3-large`, `6622a119e`, reranker off | 36 | 57 | 137 | 0.432 | (2026-10-06) |
| R0: voyage-4, balanced, reranker off | 47 | 71 | 140 | 0.462 | $0.74 |
| R1: R0 with the shipped reranker (`voyage:rerank-2.5`, top 25 in) | **57** | 76 | 152 | 0.508 | $0.14 |
| R2: R0 with a deeper pool (200 per arm, 100 chunks, one chunk per session) | 47 | 68 | 139 | 0.457 | $0.00 |
| R3: R1 with the deeper pool and the reranker reading the top 100 | **59** | **83** | 155 | 0.521 | $0.56 |

| Paired retrieval comparison | Strict @5 [95% interval] | Strict @10 |
|---|---|---|
| R0 minus published (different embedder and build) | +5.6 [+1.0, +10.1] | +7.1 [+2.5, +12.6] |
| R1 reranker minus R0 | **+5.1 [+2.5, +8.1]** | +2.5 [-0.5, +5.6] |
| R2 deeper pool minus R0 | 0 | -1.5 [-3.0, 0] |
| R3 deeper pool with reranker minus R1 | +1.0 [-1.0, +3.0] | +3.5 [0, +6.6] |
| R3 minus R0 | +6.1 [+4.0, +8.1] | +6.1 [+1.5, +11.1] |

The reranker ran on every query: each of R1's and R3's 220 queries carried rerank scores, none reported a degradation, and the budget ledger holds 220 `voyage:rerank-2.5` requests for each (the runner now fails closed on all three checks). A deeper pool without the reranker changes almost nothing (205 of 220 ranked lists identical), because fusion cannot lift a candidate from rank 150 into the top 10; with the reranker reading 100 candidates it adds 7 strict hits at 10. Event ordering and summarization stay at 0 strict hits at 10 in every arm (their gold is larger than 10), with nDCG@10 between 0.19 and 0.27.

**Do the retrieval gains reach the answers?** A5 reads R0's and R1's top 5 with `gpt-6.1-sol`:

| A5, `gpt-6.1-sol`, top 5 | Score | All items met | Abstention | Floor | Cost |
|---|---:|---:|---:|---:|---:|
| R0 (voyage-4, reranker off) | 0.628 | 100 | 0.591 | 0.286 (41) | $3.98 |
| R1 (voyage-4, reranker on) | 0.661 | 104 | 0.659 | 0.286 (41) | $4.19 |
| R1 minus R0 | +3.2 [-1.9, +7.6] | +1.8 [-3.2, +6.8] | | | |
| R0 minus the published OpenAI top 5 (A2 `gpt-6.1-sol`) | +0.9 [-2.9, +5.8] | +1.8 [-4.5, +9.5] | | | |

The reranker's retrieval gain is real; its answer gain is in the right direction but not distinguished on 11 conversations. Seven of R0's and three of R1's answers reused a cached answer to an identical prompt (the same top-5 set renders the same prompt).

## What to use and what to avoid

**Quote BEAM-1M with its floor, its strict rate and its reader.** "53.5%" means: `gpt-4.1-mini` reader, floor 26.2%, 34.1% of questions with every rubric item met. With `gpt-6.1-sol` on the same evidence it is 62.0% (floor 28.6%, 43.6% all items met).

**For S1 (wave 3), the evidence orders the candidates this way.** First, a current reader in every BEAM product claim (+8.1, distinguished). Second, the reranker on in the eval harness, failing closed when it does not run (+5.1 strict recall at 5, distinguished; answers +3.2, not yet). Third, the deeper pool only together with the reranker (+3.5 strict at 10, borderline). Reading 10 turn groups is not distinguished (+2.9) and doubles the reader's input tokens. The oracle ceiling says retrieval, not reading, holds the next 23 points; the abstention and knowledge-update numbers say the reader also needs a policy for distractors (answering 9 of 22 unanswerable questions, and preferring superseded values), which this analysis did not test.

**Limits.**

- **The three-reader comparison is confounded.** The runner gives `gpt-4.1-mini` and the Claude readers 1,024 output tokens and `gpt-6.1-sol` 2,000 (`eval/runner/memory-qa/run.ts:384` and `qa.ts:143` on main). With the step-by-step prompt, Sonnet 5.5 stopped at the limit on 91 of 220 top-5 answers and Opus 5.5 on 108 (4 with no text at all), against 5 for `gpt-6.1-sol`; Sonnet's and Opus's event-ordering scores (0.13, 0.15) show the cut-off lists. Do not read A2 as "gpt-6.1-sol is the best reader". A rerun with equal limits costs about $8 for Sonnet 5.5 and $16 for Opus 5.5 and did not fit the cap. Every within-reader comparison above keeps one limit on both sides. The bridge also stopped at the limit on 62 answers, as it did in the published run.
- One sample per question, one judge (`gpt-4.1-mini`), 11 conversations. Only large effects resolve.
- R0 differs from the published retrieval in two ways at once (embedder and gbrain build), so its +5.6 is a description, not an embedder comparison.
- The plan's "per-session diversity before fusion" does not exist as a gbrain knob: the per-page cap (`dedupOpts.maxPerPage`) applies after fusion. A cap inside each retrieval arm would be a gbrain change.
- The abstention and knowledge-update read policy named in the plan's B2 row was not run; it needs a designed policy first. A frontier re-judge of the rubric (audit B's question 5) was not run either.
- Committed-wrong counts are hand labels for the published row and for `gpt-6.1-sol`'s top-5 arm only; the rest are detector upper bounds.

**Harness defects found and fixed here** (gbrain-evals `eval/runner/memory-qa/`):

- `qa.ts:43` (main) sorted session dates as strings. BEAM writes `March-05-2024`, so "sessions in date order" was alphabetical by month name, and `run.ts:291` (main) took the alphabetically last date as the reader's "Current Date", earlier than the true latest session in 8 of 11 dev conversations (for `1m-28`, October 5, 2024 instead of May 5, 2025). `sessionDateKey` now maps BEAM's format to `YYYY-MM-DD`; every other date format keeps its string key, so LongMemEval and LoCoMo prompts are byte-identical. LoCoMo's own date strings ("1:56 pm on 8 May, 2023") have the same string-sort problem and are untouched here.
- `run.ts:219` (main) parsed every BEAM conversation file, sealed ones included, on a dev run; it now loads only the split's conversations.
- `run.ts:393` (main) stored only the first 2,000 characters of an answer; full answers and the provider's finish reason now go to `answers.ndjson`.
- Claude 5 readers were refused (`temperature` is deprecated for them); the reading lane now omits it for them and records `temperature_sent` in the receipt.
- The runner's up-front estimate prices every embedding as uncached (`run.ts:253`, main), which refused R1 and R2's first attempts against $2 run caps ($0.04 spent); they reran with larger run caps under the same $60 program cap.

## Reproduce and inspect

Keyless, $0, under a second each: recompute every number above from the committed rows.

```bash
bun run eval:decide fetch --benchmark beam-1m          # free dataset download; decompose.ts needs the dev files
bun docs/benchmarks/2026-10-08-beam-1m-failure-analysis/decompose.ts --check   # decomposition.json matches the committed rows
bun docs/benchmarks/2026-10-08-beam-1m-failure-analysis/analyze.ts --check     # arms-summary.json matches the committed rows
```

The keyless control arm (about 3 minutes, $0):

```bash
bun eval/runner/memory-qa/run.ts --benchmark beam-1m --split dev --embed hash --gbrain <gbrain checkout>@6622a119e40ea09a7719233046aca24741863ed2 \
  --top-k 10 --seed 42 --shard <i>/3 --output <dir>/shard-<i>
```

Live arms need `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`, a budget ledger and a gbrain checkout for the retrieval arms. The exact commands, one per arm, are in the [preregistration](2026-10-08-beam-1m-failure-analysis-preregistration.md#arms-in-run-order); each ran as 11 shards (3 for retrieval) joined to one ledger run, with `GBRAIN_EVALS_DATASETS`, `GBRAIN_EVALS_QA_CACHE` and `GBRAIN_EVALS_EMBED_CACHE` set to lane-local directories that started cold. Wall time: about 3 to 10 minutes per reading arm (11 shards in parallel on a 4-core machine), 18 minutes for R0's cold voyage-4 embedding and 3 to 4 minutes for R1 to R3 on the warm cache.

Receipts are in [`2026-10-08-beam-1m-failure-analysis/arms/`](2026-10-08-beam-1m-failure-analysis/arms/): one directory per arm with each shard's `receipt.json`, `run-config.json`, `rows.ndjson.gz` (per-question retrieval and scores) and `answers.ndjson.gz` (full answers, finish reasons, provider tokens), plus `ledger-run-id.txt`. Spend is in the ledger `.budget/b2-beam-1m-2026-10-08.sqlite` (program cap $60): $52.42 in 21,429 paid requests, of which $52.01 is the arms in `arms-summary.json`, $0.37 the smoke (arm S) and $0.04 R1's refused first attempt.
