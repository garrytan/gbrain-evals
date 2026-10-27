# BEAM-1M S1 fixes: the harness reranker is a clear retrieval gain, the diverse pool and wider reading are not distinguished, and the three frontier readers tie on identical evidence

Date: 2026-10-12. Item **S1** of wave 3 in the 10x memory advantage plan (`docs/plans/2026-10-07-10x-memory-advantage/PLAN.md` on branch `capy/10x-memory-advantage-plan`, thread GBRA-60). Evidence class: development evidence (BEAM-1M dev, 11 conversations, 220 questions; no sealed conversation was read). Preregistration: [2026-10-12-beam-1m-s1-fixes-preregistration.md](2026-10-12-beam-1m-s1-fixes-preregistration.md), committed before any paid request, with two amendments each committed before the cells it affects. Builds: gbrain PR [#6568](https://github.com/garrytan/gbrain/pull/6568) at `ed764bdc` (master `67fd2398` plus the `search.diverse_pool_depth` knob, off in every bundle) with `voyage:voyage-4` at 1,024 dimensions, balanced mode; gbrain-evals PR [#139](https://github.com/garrytan/gbrain-evals/pull/139). Spend: **$55.45 of a $60 cap** ($54.45 in the ledger plus the $1.00 amendment 2 counts for the lost first ledger). Status: every preregistered arm and cell **Complete**; none was cut by the stop rule.

## The finding

The [BEAM-1M failure analysis](2026-10-08-beam-1m-failure-analysis.md) ranked three cheap fixes: run gbrain's reranker in the harness, give the reranker a deeper pool with one row per session, and read 10 turn groups instead of 5. S1 built all three and measured them stacked, on the development split, with three current readers at an equal 4,096-token output limit.

| BEAM-1M dev, judge `gpt-4.1-mini` per rubric item | Answer score (220) | All rubric items met | Same reader, no memory |
|---|---:|---:|---:|
| `gpt-6.1-sol`, reranked top 5 (S1) | 66.7% | 107 (48.6%) | 28.6%, 41 (18.6%) |
| `gpt-6.1-sol`, diverse pool, top 5 (S3) | 67.0% | 101 (45.9%) | 28.6%, 41 (18.6%) |
| `gpt-6.1-sol`, diverse pool, top 10 (S3w) | **69.0%** | 107 (48.6%) | 28.6%, 41 (18.6%) |
| Sonnet 5.5, reranked top 5 (S1) | 68.1% | 113 (51.4%) | 32.0%, 47 (21.4%) |
| Sonnet 5.5, diverse pool, top 5 (S3) | 68.4% | 110 (50.0%) | 32.0%, 47 (21.4%) |
| Opus 5.5, reranked top 5 (S1) | **69.7%** | 114 (51.8%) | 30.0%, 45 (20.5%) |
| Opus 5.5, diverse pool, top 5 (S3) | 69.3% | 113 (51.4%) | 30.0%, 45 (20.5%) |

Four conclusions:

1. **The harness reranker is a clear retrieval gain at master.** gbrain's shipped balanced reranker (`voyage:rerank-2.5`) raises strict recall at 5 from 46 to 55 of 198 (+4.5 points, 95% interval [1.5, 8.1]), replicating the analysis's +5.1. It now runs by default in the memory-qa harness and stops the run with `RERANKER_INACTIVE` when it does not run, so a BEAM number measures the pipeline gbrain ships.
2. **The diverse pool improves strict recall at 10 by a margin this sample cannot separate from zero, and it does not reach answers.** With `search.diverse_pool_depth=100` strict recall at 10 goes from 76 to 83 of 198 (+3.5, [0.0, 6.6]); at 5 it is +0.5 ([-1.5, 2.5]). On the same questions the answer score moves +0.3, +0.3 and -0.4 points for the three readers, all within ±3.2. The knob ships off.
3. **Reading 10 turn groups instead of 5 helps answerable questions and hurts abstention.** Stacked on the diverse pool, `gpt-6.1-sol` gains +2.0 answer points ([-0.7, 4.7]) and +6 all-items-met answers ([0.5, 5.0] points): answerable questions rise from 67.3% to 71.9%, abstention questions fall from 63.6% to 43.2%. The harness default stays 5.
4. **The three frontier readers are not distinguished on identical evidence.** With the 1,024-token limit that cut 41 to 49% of Claude answers removed (no answer reached 4,096 here), Opus 5.5 is +3.0 points over `gpt-6.1-sol` ([-0.2, 7.0]) and +1.6 over Sonnet 5.5 ([-1.1, 4.5]). Opus costs about 3x `gpt-6.1-sol` per cell. Memory adds 36 to 40 points over each reader's floor.

**The reranker gain is a harness change, not a product change.** gbrain already shipped the reranker; what changed is that the evaluation harness now turns it on by default and refuses to run without it. So the +4.5 points of strict recall at 5 measure the harness catching up with the product, and BEAM-1M numbers measured under the old harness (reranker off, including the published 53.5% row and the failure analysis's top-5 arms) are not directly comparable with numbers from this harness.

## The experiment and results

### Retrieval arms (198 answerable questions; feasible subsets 145 at 5 and 160 at 10)

One gbrain build, fresh retrieval per arm, 11 shards (one conversation each), `--top-k 10`, search limit 30, expansion and autocut off.

| Arm | Strict@5 | Strict@5, feasible | Strict@10 | Strict@10, feasible | Any@5 | nDCG@10 | Search p50 / p95 | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| R-off: harness on main, reranker pinned off | 46 (23.2%) | 46 (31.7%) | 72 (36.4%) | 72 (45.0%) | 140 | 0.467 | 237 / 371 ms | $0.75 (cold voyage-4 embeddings) |
| R-on: + reranker (new harness default) | 55 (27.8%) | 55 (37.9%) | 76 (38.4%) | 76 (47.5%) | 152 | 0.509 | 340 / 542 ms | $0.14 |
| R-div: + `search.diverse_pool_depth=100` | 56 (28.3%) | 56 (38.6%) | 83 (41.9%) | 83 (51.9%) | 155 | 0.520 | 455 / 757 ms | $0.56 (ledger) |

Paired, cluster bootstrap by conversation (11 clusters, 10,000 draws, seed 42), percentage points over 198:

| Comparison | Strict@5 | Strict@10 | Strict@5 feasible | Strict@10 feasible |
|---|---:|---:|---:|---:|
| R-on minus R-off (harness reranker) | **+4.5 [1.5, 8.1]** | +2.0 [-1.5, 5.6] | +6.2 [2.0, 10.9] | +2.5 [-1.9, 6.9] |
| R-div minus R-on (gbrain knob) | +0.5 [-1.5, 2.5] | +3.5 [0.0, 6.6] | +0.7 [-2.1, 3.5] | +4.4 [0.0, 8.2] |
| R-div minus R-off (both) | +5.1 [2.5, 7.6] | +5.6 [1.0, 11.1] | +6.9 [3.5, 10.2] | +6.9 [1.2, 13.6] |

The diverse pool sends the reranker 100 candidates instead of 25, about 4x the rerank tokens per query, and adds about 115 ms at the median. Its top-5 set differs from R-on's on 88 of 220 questions and its top-10 set on 163.

**Rerank fidelity.** Every row of R-on and R-div carries `rerank.state = reranked` (220 of 220 each), and the ledger holds 220 `voyage:rerank-2.5` requests for R-on and 226 for R-div. Six R-div shards, started six at a time, stopped with `RERANKER_INACTIVE` (`rerank_failed`) under that parallel load; each resumed with the same command, one at a time, and completed. Those resumed shards' receipts counted only the final attempt (167 reranked queries and $0.42 across R-div's receipts, against 226 requests and $0.56 in the ledger). The runner in PR #139 now carries reranked queries, metered requests and cost across attempts into the receipt (`attempts`, `cost_usd_all_attempts`), with a test that fails on the old runner.

### Answer cells (220 questions; replayed ranked lists, so a reader comparison sees byte-identical evidence)

Each cell: the LongMemEval step-by-step reading prompt, sessions in date order, one answer per question, provider-default sampling, output limit 4,096 tokens, judge `openai:gpt-4.1-mini` one yes/no call per rubric item.

| Cell | Score, all 220 | Answerable (198) | Abstention (22) | All items met | Floor beside it | Input / output tokens per answer | Stopped at limit | Committed-wrong upper bound (approx.) | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `gpt-6.1-sol` F (reused A1) | 28.6% | 20.6% | 100% | 41 | | 97 / 213 | 0 | 119 | (reused) |
| `gpt-6.1-sol` S1 | 66.7% | 67.0% | 63.6% | 107 | 28.6% | 7,025 / 449 | 0 | 36 | $5.03 |
| `gpt-6.1-sol` S3 | 67.0% | 67.3% | 63.6% | 101 | 28.6% | 7,029 / 449 | 0 | 36 | $2.20 |
| `gpt-6.1-sol` S3w | 69.0% | 71.9% | 43.2% | 107 | 28.6% | 14,208 / 489 | 0 | 40 | $9.12 |
| Sonnet 5.5 F | 32.0% | 24.5% | 100% | 47 | | 134 / 468 | 0 | 95 | $1.21 |
| Sonnet 5.5 S1 | 68.1% | 68.1% | 68.2% | 113 | 32.0% | 11,562 / 1,032 | 0 | 38 | $7.52 |
| Sonnet 5.5 S3 | 68.4% | 68.4% | 68.2% | 110 | 32.0% | 11,574 / 1,024 | 0 | 36 | $3.24 |
| Opus 5.5 F | 30.0% | 22.3% | 100% | 45 | | 134 / 441 | 0 | 80 | $2.18 |
| Opus 5.5 S1 | 69.7% | 70.1% | 65.9% | 114 | 30.0% | 11,562 / 1,210 | 0 | 32 | $15.64 |
| Opus 5.5 S3 | 69.3% | 69.7% | 65.9% | 113 | 30.0% | 11,574 / 1,199 | 0 | 34 | $6.68 |

The S3 cells reused 128 answers each from their reader's S1 cell (questions whose top-5 set is identical render the same prompt; their paired difference is exactly zero). A no-memory reader is at the abstention ceiling (100% on all 22), so the abstention column can only fall when memory is added; read it against the answerable column. The committed-wrong column is the analysis's decline detector and over-counts.

Paired answer differences (points over 220, cluster bootstrap as above):

| Comparison | Score | All items met |
|---|---:|---:|
| S3 minus S1, `gpt-6.1-sol` | +0.3 [-1.7, 2.5] | -2.7 [-5.0, 0.0] |
| S3 minus S1, Sonnet 5.5 | +0.3 [-2.5, 3.1] | -1.4 [-4.5, 1.8] |
| S3 minus S1, Opus 5.5 | -0.4 [-3.2, 2.4] | -0.5 [-4.1, 3.2] |
| S3w minus S3, `gpt-6.1-sol` | +2.0 [-0.7, 4.7] | +2.7 [0.5, 5.0] |
| S1 minus floor: `gpt-6.1-sol` / Sonnet / Opus | +38.1 [33.8, 42.1] / +36.1 [29.4, 42.0] / +39.7 [35.3, 43.4] | |
| S3w minus floor, `gpt-6.1-sol` | +40.4 [36.9, 43.8] | |

Exploratory, not preregistered (readers on identical S1 evidence): Sonnet minus `gpt-6.1-sol` +1.4 [-3.4, 6.0]; Opus minus `gpt-6.1-sol` +3.0 [-0.2, 7.0]; Opus minus Sonnet +1.6 [-1.1, 4.5].

## Decisions under the frozen rules

**`search.diverse_pool_depth` stays 0 in balanced and tokenmax.** The flip needed all three preregistered conditions. Rule 1 fails: the strict@10 interval's lower bound is 0.0, not above zero, and strict@5's crosses zero. Rule 2 fails: Opus 5.5's S3 minus S1 point estimate is -0.4. Rule 3 was therefore not decisive, and no scratch build with the flip was made; the keyless checks that were run all pass: the offline BrainBench tier on this PR (34 of 34 categories pass, against gbrain-evals' pinned gbrain `77cf8e11`), and gbrain's search tests (126 pass), `bun run verify` (79 of 79) and the full Ubicloud CI gate on PR #6568 with the knob off. The knob ships off, so gbrain needs no `BEHAVIOR_CHANGES` row; a brain can opt in with `gbrain config set search.diverse_pool_depth 100`.

**The harness reading breadth stays 5.** The rule asks for an S3w minus S3 interval above zero and does not name the metric. On the answer score, the measurement's headline metric everywhere else, the interval crosses zero ([-0.7, 4.7]); on all items met it lies above zero ([0.5, 5.0]). This report reads the rule on the answer score, keeps 5, and records that as an interpretation, not a rule change (auto-approved under Garry's standing rule, 2026-10-12). Reading 10 doubles the reader's input tokens and drops abstention from 63.6% to 43.2%, so a breadth change belongs with the abstention read policy below.

**The harness reranker is on by default**, as preregistered regardless of results; its at-master effect is the +4.5 strict@5 above.

## What to use and what to avoid

- Quote BEAM-1M numbers from reranked retrieval only. A receipt without `reranker.enabled: true`, `rerank.state = reranked` on every row and a matching ledger count is not gbrain's shipped pipeline.
- Do not start reranked arms many at a time against one voyage key: six parallel R-div shards produced `rerank_failed` refusals. Run them one or two at a time.
- Do not rank Opus, Sonnet and `gpt-6.1-sol` from this run. They differ by 1.4 to 3.0 points on identical evidence with intervals crossing zero; `gpt-6.1-sol` is the cheapest reader per point here.
- The next lever is abstention, not retrieval depth. Memory lowers the abstention score from 100% to 64 to 68% at 5 turn groups and to 43% at 10, so every extra turn group read costs abstention points that the answerable gain has to pay back. The abstention / knowledge-update read policy (S1's fourth item, not built) is the follow-up, and it needs its own preregistered reader prompt.

## Spend

| Ledger run | Cost |
|---|---:|
| R-off, R-on, R-div retrieval | $0.75, $0.14, $0.56 |
| Reader smoke (2 questions × readers) | $0.19 |
| `gpt-6.1-sol` S1, S3, S3w | $5.03, $2.20, $9.12 |
| Sonnet 5.5 F, S1, S3 | $1.21, $7.52, $3.24 |
| Opus 5.5 F, S1, S3 | $2.18, $15.64, $6.68 |
| **Ledger total** (`.budget/s1-beam-1m-2026-10-12b.sqlite`, program cap $59) | **$54.45** |
| Counted for the lost first ledger (amendment 2) | $1.00 |
| **S1 total** | **$55.45 of $60** |

Committed receipts sum to $54.12; the difference is the smoke ($0.19, not a counted cell) and R-div's refused attempts ($0.14, see rerank fidelity). The ledger refused nothing; overshoot across 17,045 requests was $0.0016.

## Reproduce and inspect

- Arms and cells: [`2026-10-12-beam-1m-s1-fixes/arms/`](2026-10-12-beam-1m-s1-fixes/arms/) (one directory per arm or cell, 11 shards each with `receipt.json`, `run-config.json`, `rows.ndjson.gz`). Commands: the preregistration's Commands block.
- Aggregates: `bun docs/benchmarks/2026-10-12-beam-1m-s1-fixes/analyze.ts` writes [`summary.json`](2026-10-12-beam-1m-s1-fixes/summary.json); `--check` confirms the committed file matches the receipts.
- Floors: `gpt-6.1-sol`'s is the analysis's committed A1 cell (`2026-10-08-beam-1m-failure-analysis/arms/a1-nomem-gpt61sol`).
- Keyless regression: `bun run eval:brainbench` (offline tier) on gbrain-evals PR #139, and gbrain's `test/search*` (including `test/search/diverse-pool.test.ts` and `test/search/diverse-pool-hybrid.serial.test.ts`, which pins that the knob unset leaves master's pipeline) and `bun run verify` on PR #6568.
