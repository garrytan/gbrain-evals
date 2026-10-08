# Open-source memory systems against gbrain, through one harness (2026-10-06 to 2026-10-08)

## The finding

We ran gbrain and five open-source memory systems through the same harness. Every system got the same conversations
in the same order, gave back its own evidence for each question, and one fixed reader model answered from that
evidence. The systems are described by kind here; their names, versions and licenses are in the
[systems in the open-source comparison](../comparison-systems.md#systems-in-the-open-source-comparison) table.

**gbrain finds the right sessions as well as or better than every system, but as measured through this adapter, its
evidence leads the reader to fewer correct answers than three of the five.** On the preregistered comparison
(LongMemEval-S, 100 questions, 8,000 tokens of each system's own evidence, `gpt-4o` reader), gbrain at its frozen
master build (`c5fb0201`) answered 59% correctly. The memory-bank server answered 91%, the knowledge-graph pipeline
83% and the extract-first server 79%, each ahead of gbrain after correction for five comparisons. The Markdown notes
server (69%) could not be told apart from gbrain on 100 questions, and gbrain was ahead of the temporal
knowledge-graph library (37%).

Recall tells the other half. gbrain returned every required session in its top five for 97.9% of questions, a tie
with the memory-bank server and ahead of or level with everyone else. Handed the same 8,000-token budget as the
original session text instead of its own chunks, gbrain's answers rise from 59% to 78%. The gap is in what the
adapter hands the reader, not in what gbrain finds.

**The adapter matters, and it is the main limit of this result.** The gbrain row calls gbrain's internal
`hybridSearch` (`eval/runner/systems/gbrain.ts`), not the `query` operation agents use, so gbrain's `auto` delivery
never ran, and the adapter handed the reader bare chunk text without page titles or dates. Read every gbrain number
here as "gbrain as measured through this adapter". The follow-up that measures gbrain through `query` is planned in
[the budgeted delivery plan](https://github.com/garrytan/gbrain-evals/blob/capy/gbrain-budgeted-delivery-plan/docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md),
which adds a `gbrain-query` adapter.

Status: every Phase 4 to 7 cell and the frontier-reader replays (D2) finished on 2026-10-08. Rules,
amendments and hashes are in the [preregistration](2026-10-06-oss-memory-shootout-preregistration.md).

## The concrete case

A LongMemEval-S question (invented here, in the benchmark's style): "How many weeks after I started the pottery class
did I finish my first bowl?" The history is about 50 chat sessions of ordinary talk. Two of them hold the answer, one
with the start date and one with the bowl. A memory system has to store all 50 sessions, then, given the question,
return evidence that contains both facts and their dates. The reader model sees only that evidence.

Two things can go wrong. The system can miss a session (a **retrieval** failure, measured by strict recall: did the
top five contain every required session?). Or the system can find both sessions but hand over text the reader cannot
use, such as chunks without the session date (a **delivery** failure, visible as a gap between recall and answers).
gbrain's results on this run are mostly the second kind.

## The experiment

### Systems

| Label | Kind | What it does with a session | Configurations |
|---|---|---|---|
| `memory-bank` | a memory-bank server | extracts facts and observations with an LLM, stores them with embeddings in Postgres | common, recipe |
| `graph-pipeline` | a knowledge-graph pipeline | chunks, extracts entities and relations with an LLM, searches chunks and graph | common, recipe |
| `extract-first` | an extract-first memory server | extracts short memories with an LLM per turn, stores them in a vector database | common, recipe |
| `markdown-notes` | a Markdown notes server | writes each session as a Markdown note, indexes it for hybrid search | common, recipe |
| `temporal-graph` | a temporal knowledge-graph library | turns sessions into dated entities and edges with an LLM, searches the graph | common, recipe |
| gbrain | this repository's subject | stores each session as a Markdown page, searches chunks with hybrid search and a reranker | common (pin `739e5cc` and master `c5fb0201`), recipe |
| `plain-hybrid` | control | keyword plus vector search over raw sessions | control |
| `full-context` | control | the most recent sessions that fit, no retrieval | control |
| `no-memory` | control | the question alone | control |

`common` runs every system on the same models where it uses one (`gpt-4.1-mini` for extraction,
`text-embedding-3-large` for embeddings); `recipe` follows each project's own documented setup. The fifth open-source candidate, a stateful agent
runtime (`agent-runtime`), has no passive memory API and is reserved for the agent-task phase.

### Arms

Each cell ingests once and retrieves once per policy; the arms differ only in what the reader sees.

- **Policy.** `fixed-evidence`: each system's evidence, cut to 8,000 tokens. `vendor-default`: the system's own
  documented retrieval amount, no token cap.
- **Context.** `native`: the items the system returned, rendered as the system returns them. `rehydrated`: the
  original session text behind the returned items, in rank order, under the same budget. Rehydrated isolates
  retrieval from delivery.
- **Reader and judge.** Per benchmark, the runner's preregistered pair: `gpt-4o-2024-08-06` reads and judges
  LongMemEval-S, `gpt-4o-mini` reads LoCoMo (judged by `gpt-4o`), `gpt-4.1-mini` reads and judges BEAM.

### Data

| Benchmark | Slice | Questions | Clusters | Role |
|---|---|---:|---:|---|
| LongMemEval-S | stratified 100, seed 42 | 100 | 100 | inferential |
| LoCoMo dev | 3 conversations | 587 | 3 | descriptive |
| BEAM-100K dev | 6 conversations | 120 | 6 | descriptive |
| LoCoMo sealed | 7 conversations, custodian, aggregates only | 1,399 | 7 | descriptive |
| BEAM-100K sealed | 14 conversations, P4's reserved questions excluded | 224 | 14 | descriptive |
| PrecisionMemBench | upstream fixture and scorer | 77 (43 search-only) | 43 | inferential (S3) |
| lifecycle-lite | synthetic, 5 seeds | 60 update, 60 as-of, 50 forget | 5 | report-only |

## Results

### Primary family: LongMemEval-S answers

`fixed-evidence`, `native`, `gpt-4o` reader, QA service quality (product failures count as wrong), paired by question,
cluster sign-flip test, Holm across the five comparisons. 0 of 100 questions excluded for harness failures.

| System | Correct | gbrain (master) | Difference, 95% interval | Holm p | Reading |
|---|---:|---:|---|---:|---|
| `memory-bank` common | 91% | 59% | +32 points [+21, +43] | <0.001 | system higher |
| `graph-pipeline` common | 83% | 59% | +24 [+14, +34] | <0.001 | system higher |
| `extract-first` common | 79% | 59% | +20 [+9, +31] | 0.004 | system higher |
| `markdown-notes` common | 69% | 59% | +10 [0, +20] | 0.088 | not distinguishable (a difference under about 15 points would not have been detected) |
| `temporal-graph` common | 37% | 59% | −22 [−33, −11] | 0.002 | gbrain higher |

The same five pairs against gbrain at the repository pin (`739e5cc`, 58%) give the same readings.

### Strict recall (S1)

`recall_all@5` on the same rows, systems whose items cite their sessions:

| System | recall_all@5 | gbrain 97.9% | Reading |
|---|---:|---|---|
| `memory-bank` common | 97.9% | | both at ceiling |
| `extract-first` common | 93.8% (partial provenance) | | not distinguishable |
| `graph-pipeline` common | 93.8% (partial provenance) | | not distinguishable |
| `markdown-notes` common | 83.3% | | gbrain higher (Holm p 0.002) |
| `temporal-graph` common | 39.6% (partial provenance) | | gbrain higher (Holm p <0.001) |

### Every LongMemEval-S arm

| System | native 8k | rehydrated 8k | vendor-default native | vendor-default rehydrated | recall_all@5 | p50 / p95 retrieval | ingest $ | cell $ |
|---|---:|---:|---:|---:|---:|---|---:|---:|
| `memory-bank` common | 91% | 78% | 90% | 83% | 97.9% | 3.96 / 5.24 s | 32.11 | 66.74 |
| `graph-pipeline` common | 83% | 74% | 85% | 90% | 93.8% | 1.10 / 1.30 s | 60.88 | 68.78 |
| `extract-first` common | 79% | 75% | 80% | 87% | 93.8% | 0.88 / 1.27 s | 42.26 | 55.78 |
| `markdown-notes` common | 69% | 72% | 85% | 86% | 83.3% | 0.68 / 0.91 s | 1.45 | 15.28 |
| `temporal-graph` common | 37% | 40% | 86% | 86% | 39.6% | 5.62 / 37.6 s | 108.69 | 186.54 |
| gbrain master common | 59% | 78% | 63% | 80% | 97.9% | 0.81 / 1.01 s | 1.53 | 19.91 |
| gbrain pin common | 58% | 75% | 58% | 84% | 97.9% | 0.82 / 1.04 s | 1.53 | 19.95 |
| `plain-hybrid` control | 72% | 71% | 87% | 85% | 89.6% | 0.37 / 0.45 s | 1.28 | 17.78 |
| `full-context` control | | 14% | | 78% | | | 0 | 29.70 |
| `no-memory` control | | | 9% | | | | 0 | 0.27 |

Cell dollars include ingest, retrieval, and the reader and judge calls of all four arms. `temporal-graph`'s `fixed-evidence` setting
returns far fewer sessions than its default (recall 39.6% against 51.0%), which is why its 8,000-token arms fall so
far below its default arms.

### Do you need a memory system at all? (S2)

Against gbrain in the rehydrated context: `full-context` at 8,000 tokens 14% (gbrain 78%, gbrain higher);
`full-context` with the whole history 78% (gbrain 80%, not distinguishable); `plain-hybrid` 71% and 85% (gbrain 78% and
80%, not distinguishable); `no-memory` 9% (gbrain higher). On these 100 questions a plain keyword-and-vector index over
raw sessions, or the whole history when it fits, did as well as gbrain's retrieval feeding the same reader.

### LoCoMo dev and BEAM-100K dev (descriptive)

Three and six conversations describe these systems on these conversations; they cannot rank them.

| System | LoCoMo native 8k | LoCoMo rehydrated 8k | LoCoMo recall_all@5 | BEAM native 8k | BEAM vendor-default rehydrated | BEAM recall_all@5 |
|---|---:|---:|---:|---:|---:|---:|
| `extract-first` common | 76.0 | 73.6 | 83.8 | 55.4 | 65.2 | 40.6 |
| `memory-bank` common | 75.6 | 72.4 | 80.6 | 58.3 | 62.8 | 39.8 |
| `graph-pipeline` common | 69.0 | 72.7 | 83.0 | 56.9 | 60.2 | 53.7 |
| `markdown-notes` common | 67.3 | 69.5 | 73.3 | 57.6 | 60.6 | 44.4 |
| `temporal-graph` common | 65.4 | 64.4 | 63.8 | 43.1 | 63.8 | 12.0 |
| gbrain master common | 64.9 | 72.7 | 87.3 | 60.5 | 62.0 | 57.4 |
| `plain-hybrid` control | 67.0 | 69.8 | 72.2 | 54.9 | 59.3 | 42.6 |

gbrain has the highest strict recall on both. On LoCoMo the native-to-rehydrated gap is the same story as
LongMemEval-S: gbrain's temporal questions go from 25 to 74 of 100 correct when the reader sees the dated sessions.

### Sealed splits (Phase 7, custodian, aggregates only)

Sealed LoCoMo and BEAM-100K ran once, last, under the sealed execution profile; only allowlisted aggregates left the
custody root. gbrain at master carries a fixed label: gbrain decisions P6 (think date frame), P2 E2 (date grounding)
and P3 E1 used these 7 LoCoMo sealed conversations, and the P4 core gate ingested these 14 BEAM-100K haystacks. The
pin row (`739e5cc`) contains none of those decisions' builds and is gbrain's blind row.

| System | BEAM sealed native 8k | rehydrated 8k | vendor-default native | vendor-default rehydrated | recall_all@5 | cell $ |
|---|---:|---:|---:|---:|---:|---:|
| `graph-pipeline` common | 52.4 | 52.9 | 49.8 | 55.2 | 46.9 | 9.57 |
| `markdown-notes` common | 50.1 | 48.8 | 52.8 | 55.5 | 37.5 | 4.09 |
| gbrain pin (blind) | 49.4 | 51.7 | 51.1 | 57.1 | 47.9 | 5.28 |
| gbrain master (labeled) | 50.4 | 51.9 | 50.2 | 55.7 | 47.9 | 4.67 |
| `extract-first` common | 47.9 | 49.9 | 47.1 | 54.3 | 42.2 | 8.72 |
| `memory-bank` common | 46.5 | 50.9 | 42.5 | 55.2 | 42.2 | 14.94 |
| `temporal-graph` common | 36.4 | 41.0 | 53.6 | 55.3 | 16.1 | 38.36 |

| System | LoCoMo sealed native 8k | rehydrated 8k | vendor-default native | vendor-default rehydrated | recall_all@5 | cell $ |
|---|---:|---:|---:|---:|---:|---:|
| extract-first common | 74.3 | 70.6 | 70.9 | 71.7 | 82.0 | 17.49 |
| memory-bank common | 72.8 | 69.6 | 74.0 | 63.8 | 79.8 | 15.15 |
| graph-pipeline common | 70.5 | 70.3 | 70.7 | 70.8 | 80.8 | 12.68 |
| markdown-notes common | 66.3 | 66.8 | 66.3 | 66.1 | 72.6 | 9.48 |
| temporal-graph common | 62.8 | 61.2 | 65.3 | 64.3 | 56.8 | 23.43 |
| gbrain pin (blind) | 60.2 | 70.9 | 60.0 | 65.5 | 87.6 | 15.07 |
| gbrain master (labeled) | 60.1 | 70.3 | 59.1 | 65.6 | 87.6 | 15.01 |

On sealed LoCoMo the order matches LoCoMo dev: gbrain has the highest strict recall (87.6%) and, through this adapter,
the lowest native answers; rehydrated, gbrain's blind pin row reaches 70.9%, level with the leaders. One
`extract-first` question was a `retrieval_error`. The blind and labeled gbrain rows are within a point of each other
on every arm.

### PrecisionMemBench (S3)

The upstream contract: only `searchText` goes through the system; persona, pins and relation expansion are the shared
evaluator's. 43 search-only cases, each system's `vendor-default` items cut at upstream's limit. Against gbrain at
master (precision 0.081 to 0.087, recall 1.000):

| System | Precision | Recall | Reading (Holm) | Items citing no source |
|---|---:|---:|---|---:|
| `markdown-notes` | 0.388 | 0.937 | precision higher than gbrain; recall not distinguishable | 0% |
| `graph-pipeline` | 0.144 | 0.992 | precision higher; recall not distinguishable | 66.7% (not counted against precision) |
| `temporal-graph` | 0.137 | 0.995 | precision higher; recall not distinguishable | 0% |
| `memory-bank` | 0.089 | 0.941 | not distinguishable | 0% |
| `extract-first` | 0.083 | 1.000 | not distinguishable | 0% |

Every system finds the right beliefs; gbrain returns the most extra ones under this contract.

### Update and forget (lifecycle-lite, report-only)

Five synthetic histories, 12 dated correction chains and 17 canaries each. The headline for updates is whether the
reader answers with the current value; the retrieval check (old value no longer served) is reported beside it,
because keeping history is a design choice.

| System | Update, reader | As-of, reader | Old value gone from retrieval | Forgotten after delete | Survivors kept | Lost on restart |
|---|---:|---:|---:|---:|---:|---:|
| `memory-bank` | 58/60 | 45/60 | 0/60 | 50/50 | 95/95 | 0 |
| `extract-first` | 58/60 | 55/60 | 0/60 | 47/50 | 95/95 | 0 |
| `markdown-notes` | 57/60 | 24/60 | 0/60 | 50/50 | 95/95 | 0 |
| `graph-pipeline` | 56/60 | 26/60 | 0/60 | 50/50 | 95/95 | 0 |
| `temporal-graph` | 45/60 | 47/60 | 0/60 | 10/50 | 95/95 | 0 |
| gbrain master | 29/60 | 17/60 | 0/60 | 50/50 | 95/95 | 0 |
| gbrain pin | 28/60 | 13/60 | 0/60 | 50/50 | 95/95 | 0 |

gbrain forgets cleanly and keeps everything else through a restart, but its readers pick the current value only half
the time: the adapter's items carry no dates, so the reader cannot tell the correction from the original.

### Frontier readers (D2)

The same frozen evidence (LongMemEval-S, 8,000 tokens, `native`) read by newer models, 100 questions per system, judged
by `gpt-4o` (amendment A9). Opus 5.5, Sonnet 5.5 and `gpt-6.1-sol` are counted readers; Fable 5.1 is descriptive only
(amendment A8). These rows are descriptive: they enter no test.

| System | `gpt-4o` (main) | Opus 5.5 | Sonnet 5.5 | `gpt-6.1-sol` | Fable 5.1 (descriptive) |
|---|---:|---:|---:|---:|---:|
| `memory-bank` common | 91% | 94% | 95% | 95% | 86% |
| `graph-pipeline` common | 83% | 93% | 90% | 92% | 86% |
| `extract-first` common | 79% | 94% | 92% | 83% | 84% |
| `markdown-notes` common | 69% | 73% | 71% | 72% | 70% |
| `temporal-graph` common | 37% | 43% | 41% | 45% | 40% |
| gbrain master common | 59% | 68% | 66% | 67% | 64% |

A stronger reader lifts every system, and most of all the systems whose evidence already carries dated facts or whole
notes (`extract-first` gains 15 points with Opus 5.5). gbrain gains 7 to 9 points with each frontier reader, but the
order does not change: through this adapter, its chunks still trail `memory-bank` and `graph-pipeline` by 25 points or
more with every counted reader, and `extract-first` by 16 to 26 points.

## What to use and what to avoid

- **For finding evidence, gbrain holds up.** Strict recall is at or near the top on every benchmark, it ingests for
  about $1.50 per 100 LongMemEval-S haystacks with no LLM in the write path, and retrieval runs under a second at p95.
- **For answers through this adapter, gbrain's chunks are not enough.** Systems that hand the reader dated facts or
  whole notes get more correct answers from the same reader. If you use gbrain this way today, hand the reader the
  pages behind the hits, with their dates; the rehydrated arm shows what that is worth (+25 questions, −6, on
  LongMemEval-S).
- **LLM extraction costs real money.** `temporal-graph` spent $109 to ingest 100 LongMemEval-S haystacks,
  `graph-pipeline` $61, `extract-first` $42, `memory-bank` $32; gbrain and `markdown-notes` about $1.50.
- **Settings change rankings.** `temporal-graph` is near the bottom at 8,000 tokens and level with the leaders at its
  own default; `markdown-notes` gains 16 points from its default. Read each row with its arm.

### Limits

- **The gbrain adapter.** It calls `hybridSearch`, not `query`; gbrain's `auto` delivery never ran; items are chunk
  text without titles or dates. Measured effect: rehydrated beats native on LongMemEval-S (+25 questions, −6) and on
  LoCoMo temporal questions (25 to 74 of 100). No counted number changes; the follow-up plan adds `gbrain-query`.
- **Sample sizes.** LongMemEval-S is 100 questions (differences under about 15 points are not detectable); LoCoMo and
  BEAM dev are descriptive.
- **Sealed LoCoMo is not untouched for gbrain.** Two shipped gbrain defaults were chosen on those 7 conversations; see
  the fixed label.
- **Harness failures and reruns.** Four cells failed for harness reasons and reran under amendment A7 (a database
  shared-memory limit in our `memory-bank` compose, two leases too small for parallel ingest, one finish wait); the
  `extract-first` LoCoMo r1 cell reran under A3. Failed attempts are kept in
  [results/README.md](2026-10-06-oss-memory-shootout/results/README.md).
- **Launch tree.** The A7 reruns and the sealed batch launched from `2d8cf62` plus `1aed137e`'s amendment files, so they
  run the same harness and gbrain pin as every other cell; main's later re-pin of gbrain did not reach them.

## Reproduce and inspect

- Code: gbrain-evals branch `capy/oss-memory-shootout`; gbrain pin `739e5cc`, gbrain master `c5fb0201`.
- Rules and hashes: [preregistration](2026-10-06-oss-memory-shootout-preregistration.md) (amendments A1 to A9),
  [lifecycle-lite preregistration](2026-10-06-oss-memory-shootout-lifecycle-lite-preregistration.md).
- Cells: [manifests](2026-10-06-oss-memory-shootout/manifests/) (`bun eval/runner/shootout-cell.ts reserve|launch|settle`),
  [lifecycle-lite manifests](2026-10-06-oss-memory-shootout-lifecycle-lite/manifests/).
- Results: [per-cell receipts and rows](2026-10-06-oss-memory-shootout/results/),
  [lifecycle-lite results](2026-10-06-oss-memory-shootout-lifecycle-lite/results/).
- Analysis: `bun eval/runner/shootout-report.ts --output <dir>` (primary, S1, S2, descriptive),
  `bun eval/runner/precisionmembench-s3.ts` (S3).
- Keys: `OPENAI_API_KEY`, `VOYAGE_API_KEY` (gbrain's reranker), `ANTHROPIC_API_KEY` (D2 only), `UBICLOUD_API_KEY`.
- D2 replay: `bun eval/runner/memory-qa/run.ts <cell selection> --arms docs/benchmarks/2026-10-06-oss-memory-shootout/manifests/arms/d2-frontier-lme-s-primary.json --replay --output <pulled cell>/mqa --paid ...`.
- Spend, measured: Phase 4 $734.06 (including failed attempts), Phase 5 $2.11, Phase 6 $5.39, Phase 7 $193.95,
  D2 replays $143.97; $1,079.48 in all. The campaign ledger also holds $283 for one `temporal-graph` lease whose VM was
  destroyed before its cell started (a reservation with unknown actual spend, counted against the $1,450 cap but not
  as spend), and a −$144.38 correction for 1,800 rejected D2 calls that were charged at their reservation (results
  README). Ubicloud VM time is extra.

## Changelog

- 2026-10-08: First publication, with the D2 frontier-reader rows.
