# Preregistration: BEAM-1M S1 fixes, paired dev measurement (2026-10-12)

Frozen on October 12, 2026, in its own commit, before any paid request of this measurement. Nothing below changes after a paid request; a later change is a dated amendment at the end, written before the cells it affects. Item **S1** of wave 3 in the 10x memory advantage plan (`docs/plans/2026-10-07-10x-memory-advantage/PLAN.md` on branch `capy/10x-memory-advantage-plan`, thread GBRA-60). Spend cap **$30**, the remainder of the maintainer's approved round for this item, a hard cap through the budget ledger.

## Question

The [BEAM-1M dev failure analysis](2026-10-08-beam-1m-failure-analysis.md) ranked the candidate fixes by evidence: the reranker on in the harness (+5.1 strict@5, distinguished), a deeper candidate pool with one row per session read by the reranker (+3.5 strict@10, borderline), reading 10 turn groups instead of 5 (+2.9 answer points, not distinguished), and an abstention / knowledge-update read policy (not designed, not run). S1 ships the first three:

1. **Harness:** the memory-qa runner reranks by default and fails closed (`RERANKER_INACTIVE`) when the reranker does not run; each searched row records its rerank state (gbrain-evals, this PR).
2. **Reading breadth:** `--qa-sessions N` is recorded in every receipt as `reading.breadth_sessions`; the default stays 5 unless this measurement says otherwise.
3. **gbrain retrieval:** `search.diverse_pool_depth` (gbrain PR [#6568](https://github.com/garrytan/gbrain/pull/6568)): with N > 0 every retrieval arm fetches at least N candidates, the deduped pool keeps one row per session and the reranker reads at least N rows. It ships off; this measurement decides whether balanced and tokenmax turn it on.

This measurement answers, on the development split only: how much does each fix, stacked on the one before, move strict recall at 5 and 10 and the answer score of current readers, against the harness as it stood on main (reranker pinned off, 5 turn groups)?

## Evidence class

Development evidence. BEAM-1M dev (11 conversations, 220 questions) is public and measured twice before. No sealed BEAM conversation is read: the runner loads only the dev conversations' files on a dev run, and GBRA-52 owns every BEAM sealed opening.

## Builds and data

- gbrain: PR #6568 head `ed764bdc07e8c72a5b5167aa66634bdf98af998e` (master `67fd2398` plus the knob, which is 0 in every bundle, so with the knob unset the pipeline is master's; `test/search/diverse-pool-hybrid.serial.test.ts` pins that), as a copied overlay (`--gbrain <checkout>@ed764bdc`).
- Embedding: `voyage:voyage-4` at 1,024 dimensions (gbrain's shipped default, as in the analysis's R0 to R3). Search mode `balanced`, autocut off (the runner's pins), expansion off, `--top-k 10`, search limit 30 (the runner default, top-k × 3).
- gbrain-evals: this PR's branch (main `d3fc5d79` plus the runner changes above).
- Dataset: BEAM `b2da22e` (manifest `eval/decisions/datasets/beam-b2da22e.json`), size 1M, dev split: 220 questions (198 answerable, 22 abstention; 194 with mappable gold; feasible subsets 145 at 5 and 160 at 10).

## Arms

Retrieval arms (one gbrain build, fresh retrieval, 11 shards, one conversation each):

| Arm | Stack step | Settings |
|---|---|---|
| R-off | harness on main (control) | `--reranker off` |
| R-on | + reranker (harness default from this PR) | reranker on, gbrain's balanced default (`voyage:rerank-2.5`, top_n_in 25) |
| R-div | + diverse pool | R-on plus `--pin search.diverse_pool_depth=100` (arms fetch 100, one row per session, reranker reads 100) |

Answer cells replay these arms' committed ranked lists (`--retrieved-from`), so a reader change is measured on byte-identical evidence:

| Cell | Evidence | Breadth | Compared with |
|---|---|---|---|
| S1 | R-on | 5 | (reference) |
| S3 | R-div | 5 | S1: the gbrain knob |
| S3w | R-div | 10 | S3: reading breadth stacked on the knob |
| F | none (`--qa-context none`) | | the reader's no-memory floor |

The control's answers (R-off, 5 turn groups) are not rerun: the analysis measured the reranker's answer effect on the same harness (A5, `gpt-6.1-sol`, +3.2 [-1.9, +7.6]); R-off's retrieval is measured here so the stack's retrieval is complete.

**Readers.** On 2026-10-12 `bun scripts/model-freshness.ts` names `claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol` as the newest Opus, Sonnet and GPT. Counted readers here: **`openai:gpt-6.1-sol` and `anthropic:claude-sonnet-5-5`**. **Opus 5.5 is cut** before any cell: at the analysis's measured token counts one Opus top-5 cell costs about $16 and the paired S1/S3 pair about $26 even with answer reuse, which does not fit the $30 cap beside the retrieval arms and one other reader; the cut is recorded here, not after results. Fable is not run (smoke-only rule). `gpt-5.4-mini` is never run.

**Reader settings.** The LongMemEval step-by-step reading prompt, sessions in date order (the analysis's fixed sort), 1 answer per question, provider-default sampling for both readers (neither accepts `temperature`). Output limit **4,096 tokens for both readers** (`--qa-max-tokens 4096`): the analysis's 1,024-token Claude limit cut 41% of Sonnet's answers, so this removes that confound. **Judge** `openai:gpt-4.1-mini`, one yes/no call per rubric item, as in the analysis and every BEAM row so far.

**Floors.** `gpt-6.1-sol`'s floor is the analysis's committed A1 cell (0.286, 41 all items met; its effective limit was 2,000 tokens and none of its 220 floor answers reached it), reused. Sonnet 5.5's floor is rerun at 4,096 tokens (its A1 floor stopped at the 1,024 limit on 13 answers).

## Run order, estimates and the stop rule

| # | Cell | Estimate |
|---|---|---:|
| 0 | Smoke: 2 questions, S1 evidence, both readers (after R-on) | $0.10 |
| 1 | R-off, R-on, R-div retrieval (voyage-4 embeddings cold once, then cached; rerank) | $1.50 |
| 2 | `gpt-6.1-sol` S1 | $4.40 |
| 3 | `gpt-6.1-sol` S3 | ≤ $4.40 |
| 4 | Sonnet 5.5 floor F | $1.30 |
| 5 | Sonnet 5.5 S1 | $8.50 |
| 6 | Sonnet 5.5 S3 | ≤ $8.50 |
| 7 | `gpt-6.1-sol` S3w | ≤ $7.50 |

Estimates use the analysis's measured tokens per answer (input 7,178 / 11,818 tokens for the two readers at 5 turn groups, 14,121 at 10) at the ledger's prices, plus the judge. A replayed question whose top-5 (or top-10) set is identical to one an earlier cell of the same reader already answered renders the same prompt and reuses that answer from the reader cache, so its paired difference is exactly zero; S3's estimate is the full cell times the share of questions whose R-div top-5 set differs from R-on's, computed from the retrieval rows before cell 3. The report counts reused answers.

One new ledger, `.budget/s1-beam-1m-2026-10-12.sqlite`, created with `init --program-cap-usd 30 --reason "GBRA-60 S1 BEAM-1M fixes, remaining approved round (hard cap)"`. Every paid request (embedding, rerank, reader, judge) is reserved there first and the ledger refuses past $30. Cells run in the order above. Before each cell its estimate is compared with what the ledger has left minus a $0.50 margin: a cell that would not fit does not start, measurement stops there, and it and every later cell are published as **Not run (cap)**. A refused reservation mid-cell leaves that cell Partial; nothing is retried outside the ledger. Caches (`GBRAIN_EVALS_EMBED_CACHE`, `GBRAIN_EVALS_QA_CACHE`) are lane-local and start cold.

**Reranker fidelity (fail closed).** R-on and R-div run with the reranker on and stop with `RERANKER_INACTIVE` at the first query without rerank scores or with a rerank degradation; a stopped arm resumes with the same command. An arm is reported as reranked only if its receipt is `complete`, every searched row has `rerank.state = reranked`, and the ledger holds at least one `voyage:rerank-2.5` request per reranked query.

Commands (repository root; `GBRAIN_EVALS_DATASETS` set; `<run>` a ledger run opened per arm with `bun eval/runner/budget-ledger.ts open --runner s1-<arm> --budget-usd <cap> --budget-ledger <ledger>`; shards `i/11`):

```bash
G=<gbrain checkout>@ed764bdc07e8c72a5b5167aa66634bdf98af998e
BASE="--benchmark beam-1m --split dev --embed real --embedding-model voyage:voyage-4 --embedding-dims 1024 --gbrain $G --top-k 10 --seed 42"
# R-off / R-on / R-div
bun eval/runner/memory-qa/run.ts $BASE --reranker off --shard i/11 --output <out>/r-off/shard-i --paid --budget-run-id <run> --budget-ledger <ledger>
bun eval/runner/memory-qa/run.ts $BASE --shard i/11 --output <out>/r-on/shard-i --paid --budget-run-id <run> --budget-ledger <ledger>
bun eval/runner/memory-qa/run.ts $BASE --pin search.diverse_pool_depth=100 --shard i/11 --output <out>/r-div/shard-i --paid --budget-run-id <run> --budget-ledger <ledger>
# S1 / S3 (--qa-sessions 5) and S3w (--qa-sessions 10), per reader
bun eval/runner/memory-qa/run.ts --benchmark beam-1m --split dev --retrieved-from <out>/r-on|r-div --top-k 10 --qa reader --qa-sessions 5|10 --qa-max-tokens 4096 \
  --reader <reader> --judge openai:gpt-4.1-mini --qa-runs 1 --seed 42 --shard i/11 --output <out>/<cell>/shard-i --paid --budget-run-id <run> --budget-ledger <ledger>
# F (Sonnet 5.5)
bun eval/runner/memory-qa/run.ts --benchmark beam-1m --split dev --qa reader --qa-context none --qa-max-tokens 4096 --reader anthropic:claude-sonnet-5-5 \
  --judge openai:gpt-4.1-mini --qa-runs 1 --seed 42 --shard i/11 --output <out>/f-sonnet55/shard-i --paid --budget-run-id <run> --budget-ledger <ledger>
```

## Metrics and denominators

- **Retrieval** for R-off, R-on, R-div: strict recall of every gold turn group at 5 and at 10 over the 198 answerable questions (the 4 without mappable gold count as misses, as before), and **beside them the same over the feasible subsets** (145 at 5, 160 at 10); any@5; nDCG@10; search latency p50 / p95; rerank requests and rerank cost per query.
- **Answers** for every cell: mean rubric score over 220; the strict all-items-met count over 220; both over the 198 answerable and 22 abstention questions; **the same reader's no-memory floor printed beside every answer number**; committed-wrong upper bound from the analysis's decline detector (labelled approximate); provider input / output tokens per answer; answers that stopped at the output limit.
- **Paired differences**: candidate minus comparator on the same questions, cluster bootstrap by conversation (`clusteredPairedDelta`, 11 clusters, 10,000 draws, seed 42), 95% interval. An interval that crosses zero is "not distinguished at this sample size", never a tie.

## Comparisons

| Comparison | Pairs | What it answers |
|---|---|---|
| R-on minus R-off (strict@5, @10) | 198 | the harness reranker default, at master |
| R-div minus R-on (strict@5, @10) | 198 | the gbrain knob's retrieval effect |
| S3 minus S1, per reader (answers) | 220 | whether the knob's retrieval change reaches answers |
| S3w minus S3, `gpt-6.1-sol` (answers) | 220 | reading 10 turn groups, stacked on the knob |
| each cell minus its reader's floor | 220 | what the memory adds |

## What each outcome changes (frozen decision rules)

**gbrain default (`search.diverse_pool_depth` in balanced and tokenmax, 0 → 100).** It flips only if all of these hold; otherwise the knob ships off with this evidence in the PR and the report:

1. R-div minus R-on: the 95% interval for strict@5 **or** strict@10 (198 denominator) lies above zero, and neither point estimate is below zero.
2. Answers: for every counted reader with both S1 and S3 complete, the S3 minus S1 point estimate is at or above zero.
3. Keyless regression: the offline BrainBench tier (`bun run eval:brainbench`) on a scratch build with the flip has no category whose verdict changes from pass to fail against the PR head, and gbrain's search tests (`test/search*`, `test/hybrid*`, the eval canary) pass with the flip.

Conservative is never flipped: it has no reranker, and the knob without one was not measured. A flip is a gbrain behavior change for every balanced and tokenmax brain and gets a `BEHAVIOR_CHANGES` row naming the search-result change, the reranker's larger input (about 4x the rerank tokens per query) and the opt-out (`gbrain config set search.diverse_pool_depth 0`).

**Harness reading breadth.** The runner's default stays 5 turn groups unless S3w minus S3 (`gpt-6.1-sol`) has an interval above zero; reading 10 doubles the reader's input tokens.

**Harness reranker default.** Ships on regardless of these results: it makes the harness measure gbrain's shipped balanced pipeline, which is what a BEAM product number claims. R-on minus R-off is reported as the at-master effect.

**Not in this measurement.** The abstention / knowledge-update read policy (S1's fourth item): the analysis supports a policy only in outline (memory lowers abstention from 1.0 to 0.568; knowledge update reaches 0.955 with only the gold), no policy is designed, and a full reader-prompt cell per reader does not fit the cap. It is listed as follow-up. A frontier re-judge is not run.

## Amendments

1. **2026-10-12, after the retrieval smoke and before cell 1.** The smoke (R-on settings, `--limit 2`, one shard holding two conversations, $0.13) found a harness defect: the runner's per-conversation reset truncated gbrain's schema-seeded `persistence_brain` singleton, and gbrain since #6482 refuses every write without it, so the second conversation's import failed (`requires exactly one known boolean persistence state`). Commit `59ddb918` keeps the seeded singletons (`persistence_brain`, `shared_skill_state`, `page_generation_clock`) across the reset in this runner, `longmemeval.ts` and `systems/gbrain.ts`; the smoke's second conversation then imported, searched and reranked. Every counted cell uses one conversation per shard, so none of them resets. Rows record the configured rerank model (`rerank.model`); the ledger's per-model rerank count remains the evidence. No rule, arm, reader or estimate changes.
2. **2026-10-12, before any answer cell and before any retrieval result was read.** Two changes, neither informed by a result:
   - **Cap $60.** The maintainer doubled this round's cap, so S1's cap rises from $30 to $60 (the plan's S1 range is $30 to $60). The run machine was replaced while R-off was running, and the local ledger, caches and partial outputs were lost with it; nothing from R-off was read. Spent before the loss: the smoke's $0.13 (its two receipts) plus R-off's partial voyage-4 embeddings, at most the analysis's full cold cost of $0.74; this amendment counts **$1.00** as spent. The new ledger `.budget/s1-beam-1m-2026-10-12b.sqlite` is created with a program cap of **$59.00**, so total S1 spend stays at or under $60. Each completed arm's receipts are committed and pushed as soon as it finishes, so spend survives another machine loss. The retrieval arms rerun from scratch with cold caches.
   - **Opus 5.5 restored** as a counted reader, which the larger cap now fits. Run order after cell 1 becomes: 2 `gpt-6.1-sol` S1 ($4.40); 3 `gpt-6.1-sol` S3 (≤ $4.40); 4 Sonnet 5.5 floor F ($1.30); 5 Sonnet 5.5 S1 ($8.50); 6 Sonnet 5.5 S3 (≤ $8.50); 7 Opus 5.5 floor F at 4,096 tokens ($2.40; its A1 floor stopped at the 1,024 limit on 10 answers); 8 Opus 5.5 S1 ($16.50); 9 Opus 5.5 S3 (≤ $16.50); 10 `gpt-6.1-sol` S3w (≤ $7.50). Opus uses the same prompt, 4,096-token output limit, judge and replay as the other readers. The stop rule, its $0.50 margin and every decision rule are unchanged; decision rule 2 now covers all three readers that complete both S1 and S3.

