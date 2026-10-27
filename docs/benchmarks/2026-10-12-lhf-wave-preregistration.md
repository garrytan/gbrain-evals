# Preregistration: the low-hanging-fruit wave's paid gates, `balanced` as the new-install default and `query` expansion following the mode (2026-10-12)

Frozen on October 12, 2026, in its own commit, before any measured run. A later change is a dated amendment appended at the end and written before the run it affects. One configuration smoke run of 3 questions (`search`, `balanced`, $0.05) preceded this file; it checked that the driver, the ledger guard and the via-operation harness execute, and it is not part of any result.

The plan is gbrain-evals `docs/plans/2026-10-11-low-hanging-fruit/PLAN.md` (gbrain-evals #134), approved by Garry on 2026-10-12 ("Approve all", relayed by GBRA-40). This file covers the paid gates of its items 1 and 1b. Items 0 and 2 to 5 are keyless and are gated in gbrain's own tests.

## Question

1. **Item 1.** May `gbrain init` recommend `balanced` instead of `tokenmax` to new installs that have a chat key? `tokenmax` reranks a pool of 50 candidates and `balanced` a pool of 25, so the mode changes ordinary `search` ranking as well as `query`.
2. **Item 1b.** May `query` stop rewriting the question with a language model by default under `balanced`? Today every `query` call expands in every mode; after item 1b the resolved mode decides (on only in `tokenmax`).

## Evidence class

Regression check (non-inferiority) on development evidence: LongMemEval-S has been used to tune gbrain's retrieval before (the September 6 ranker wave and the October 4 recount). No sealed set is opened.

## Build and data

- **Dataset:** the cleaned LongMemEval `_s` split, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, the 470 answerable questions (the 30 `_abs` questions are not run).
- **Harness:** gbrain's own `gbrain eval longmemeval` with the new `--via-operation search|query` mode (lane A of the wave, gbrain commit `97fad0f76`). Each question runs through the real `search` or `query` operation with an agent's stdio MCP context (remote, stdio transport, source `default`), at the operation's own default limit; the search mode resolves inside the operation. Strict `recall_all@5` is computed from the first five returned rows.
- **Driver:** [`2026-10-12-lhf-wave/scripts/driver-via-op.ts`](2026-10-12-lhf-wave/scripts/driver-via-op.ts) runs the harness from a gbrain checkout and installs this repository's paid-request guard before gbrain is imported, so every embedding, rerank and expansion request is reserved and settled in the budget ledger.
- **Providers:** embeddings OpenAI `text-embedding-3-large` at 1,536 dimensions, one embedding cache shared by every arm (built in phase 0, copied per arm); reranker Voyage `rerank-2.5`; query expansion gbrain's shipped default expansion model, `anthropic:claude-haiku-4-5-20251001`. The expansion model is the product default being measured, not a model comparison, so the model-selection rules for comparisons do not apply.
- **Settings shared by every arm:** `--retrieval-only --top-k 5 --by-type --no-trajectory --reranker on --autocut off` (both equal every mode's default; pinning them turns on the harness's reranker gate). Bun 1.4.2.
- **Trees.** Phase 0 runs at gbrain `e62f72c4b353b5d0fb2d410a95ef812b0c745585` (master `0460af288` plus lane A: items 1 and 1b and the harness). The counted arms run at the wave's measurement tree: current gbrain master after #6445 merges, plus every wave item, at one commit recorded in every receipt (`via_operation_summary.tree`). All five counted arms run at that one commit.

## Arms

| Arm | Operation | `--mode` | `--op-expand` | Role |
|---|---|---|---|---|
| S-B | `search` | `balanced` | n/a | control for phase 0; treatment of C1 |
| S-T | `search` | `tokenmax` | n/a | control of C1 |
| Q-B-off | `query` | `balanced` | `off` | treatment of C2 and C3 |
| Q-T-off | `query` | `tokenmax` | `off` | control of C2 |
| Q-B-on | `query` | `balanced` | `on` | control of C3 (expects expansion) |

**Phase 0 (harness validation and the shared embedding cache).** S-B at the phase-0 tree, in four shards of consecutive question ids, each with its own cache, merged afterwards. Its comparison is with the published October 4 `FINAL` receipt (`balanced`, reranker on, autocut off, the direct harness at gbrain `109b992`, 451/470): treatment S-B, control `FINAL`. It reproduces the baseline when its paired lower bound under the rule below is above -1.0 point; then the counted arms may run. If it does not, no counted arm runs; the difference is diagnosed, reported and fixed by a named repair before an amended rerun.

## Metric and denominator

Strict `recall_all@5`: a question counts when every labeled evidence session is among the distinct sessions of the first five returned rows. The denominator is the same 470 answerable questions in both arms of a comparison; the unit is the question, paired by `question_id`.

An arm is **invalid** when any row errored, any row's search meta records a rerank, embedding or vector degradation (`rerank_failed`, `embed_timeout`, ...), any row made no rerank call, any model call failed, an expansion-off arm expanded, or (Q-B-on) any row's expansion failed or was not attempted. An expansion that ran but returned no usable alternative (`no_variants`) is counted and reported and does not invalidate. An invalid arm is rerun once after a named repair; it never enters a comparison. A comparison with a question missing from either arm is invalid.

Also reported per arm, not gated: model calls per query by touchpoint, operation latency p50 and p95, the CRAG confidence-grade distribution (escalation is off by default), expansion outcomes, and cost.

## Decision rule

For every comparison, the estimate is treatment minus control in strict `recall_all@5`. The interval is the one-sided 95% lower bound of a paired bootstrap over questions: 10,000 resamples of the 470 per-question differences with replacement, mulberry32 seed 1, the resampled means sorted ascending, element 500. The non-inferiority margin is -0.01 (4.7 questions). A comparison **passes** when the lower bound is strictly above -0.01 and **fails** otherwise. Implemented in [`2026-10-12-lhf-wave/scripts/analyze-lme.ts`](2026-10-12-lhf-wave/scripts/analyze-lme.ts); boundary cases are unit-tested in `test/eval/lhf-wave-lme-analysis.test.ts` (identical arms, a loss exactly at the margin, five lost questions, one lost question, a missing pair, each invalidating stage, every expansion outcome, a row without a rerank call, duplicates and a short arm).

- **C1 (item 1, `search`):** S-B minus S-T.
- **C2 (item 1, `query`, expansion held off):** Q-B-off minus Q-T-off.
- **C3 (item 1b):** Q-B-off minus Q-B-on.

There are three comparisons and no multiplicity correction: each one gates a separate shipping decision and passing requires every comparison its decision names, which only makes shipping harder. **Power, computed with the analysis script.** With the estimate exactly zero, the lower bound is -0.64 points when the arms disagree on 4 questions, -1.06 at 8 and at 15, and -1.49 at 25. So an exact tie passes only when the arms disagree on about 7 questions or fewer; with more disagreement a pass needs a positive estimate. The published `balanced` and `tokenmax` arms (which also differed in expansion) disagreed on 15 questions (+3/-12). A result that fails for lack of power is reported as inconclusive, not as harm, and keeps today's default as the plan says.

The second piece of item 1's evidence is the Cat 40 Hard world M rerank-pool replay (25 vs 50 pool, gold hit@5 under 25 no more than 1 point below 50). Its exact procedure and receipts are written into this file as an amendment before it runs.

## What each outcome changes

| | Pass | Fail or inconclusive | Invalid |
|---|---|---|---|
| Item 1 (C1 and C2, plus the Cat 40 replay) | New installs with a chat key are recommended `balanced` (gbrain commit `e62f72c4b`, the default flip, ships) | The flip commit is dropped; only the Voyage-key branch of the picker, `--search-mode` and the doc corrections ship | Rerun the invalid arm after a named repair; nothing ships on an invalid comparison |
| Item 1b (C3) | `query` expansion follows the mode | Today's default (`query` always expands) stays; the 1b commits are dropped | As above |

Every outcome, including fail, inconclusive and invalid, is reported in a gbrain-evals report under `docs/benchmarks/`. Existing brains are never changed automatically.

## Budget

The program cap is **$30**, recorded in the SQLite budget ledger at `~/.capy/work/lhf/ledger.sqlite` on the GBRA-81 machine (created 2026-10-12 with Garry's approval as its reason); every run opens its own ledger run with a cap and is refused before a request that would cross either cap.

| Run | Expected | Run cap |
|---|---:|---:|
| Smoke (done, before this file) | $0.05 | $0.50 |
| Phase 0, S-B in four shards (cold embeddings, about 58M tokens, plus rerank) | $8 | $2.75 per shard |
| Five counted arms (warm cache: query embeddings, rerank, Haiku expansion for Q-B-on) | $0.40 to $0.90 each, $3.50 total | $1.50 per arm |
| Cat 40 world M rerank-pool replay | about $5 | set in its amendment |
| **Total** | **about $17** | **$30** |

A shard or arm that reaches its cap stops before the request that would cross it and is reported incomplete; it is resumed from its rows file with a new ledger run only if the program cap still covers the remaining work, and settings are never changed to make it cheaper. Spending beyond $30 needs Garry's approval.

## Amendments

### 2026-10-12, before any Cat 40 call: the rerank-pool replay

The procedure is [`cat40-hard/RERANK_POOL_REPLAY.md`](cat40-hard/RERANK_POOL_REPLAY.md) as of this commit, run by `eval/runner/cat40/rerank-pool-replay.ts`. In short: the 1,030 recorded hybrid `search` calls of the 2026-10-10 Hard confirmation's `gbrain-hard` cells (966 from tasks naming gold documents) are replayed on a freshly built world M brain (seed 20261021, frozen knobs, one slot, `text-embedding-3-large`) at the measurement tree, through `gbrain serve --surface starter`, under `search.reranker.top_n_in` 50 and 25 with `search.mode` pinned to `tokenmax` in both arms, so only the pool differs. The gate is gold hit@5 (any of the first five rows is one of the task's gold documents) under 25 minus under 50, paired over calls, with the same bootstrap, seed and margin as above: pass when the lower bound is strictly above -0.01, fail when the estimate is below -0.01, otherwise inconclusive. This is stricter than the plan's wording ("no more than 1 point below"), which reads as the point estimate; the stricter reading keeps an underpowered result from passing. The bootstrap resamples calls, not cells, so calls from one cell are treated as independent; the report also gives the estimate by task family. Also reported: top-20 overlap and how often fused rows 26 to 50 enter the top 20.

Budget: both runs use this program's ledger (`~/.capy/work/lhf/ledger.sqlite`). Slot build cap $4 (measured $2.74 at the confirmation), replay cap $1 (estimate $0.33).

### 2026-10-12, before any counted arm: the measurement tree

The coordinating thread (GBRA-40) asked for the wave's pull request now rather than after gbrain #6445 merges, so the counted arms and the Cat 40 replay run at gbrain `f77f1418caedc2f521e30ba14040134d09310a49` (tree `585e2fbf12a5`, branch `capy/lhf-wave`): master `52adb3d95` (v0.60.180.0) plus items 1, 1b, 2, 3 and 4, the via-operation harness fixes and the #6495 timeout-reason fix. That is the tree the wave's pull request ships, apart from release stamps and the commits a failed gate drops. #6445 is not in it; its two rankers (W3 confidence-gated reranking, W5 page-unit cut) are off by default, so the default path these arms measure does not include them either way. Item 5 (stage timings, results unchanged by construction and keyless-gated) ships later in its own pull request on top of #6445. Nothing else in this file changes: arms, rule, margin, seed and caps stay as written. Each counted arm uses its own copy of the phase-0 embedding cache (SHA-256 `cf0a0492…`).

### 2026-10-12, before any counted arm: one index for every arm

`tokenmax` differs from `balanced` in five resolved settings: the rerank pool (`reranker_top_n_in` 50 vs 25), `query`'s limit (50 vs 25) and token budget (none vs 12,000), expansion (held off here by `--op-expand off`; `search` never expands), and the index tier (`contextual_retrieval` `per_chunk_synopsis` vs `title`). The plan asks for both comparisons on the same index, and the harness would otherwise build tokenmax's per-chunk synopses for about 100,000 chunks with a chat model and re-embed them, which no cap in this file covers. So S-T and Q-T-off also pass `--search-pin search.contextual_retrieval=title`: every arm reads the one phase-0 index, and the comparisons measure what a `balanced` default changes at query time (pool, limit, budget). What tokenmax's synopsis vectors would add is not measured here and the report says so; the default flip does not touch existing brains' vectors either way.
