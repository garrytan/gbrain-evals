# BrainBench Cat 13b — Source Swamp Resistance

**Date:** 2026-04-25
**Corpus:** `eval/data/source-swamp-v1` (10 short curated `originals/` + 10 long `wintermute/chat/` pages, all committed JSON)
**Queries:** 30 hand-curated multi-word phrases, each appearing in ≥1 chat distractor
**Top-K:** 5
**Wall clock:** ~50s for full 4-adapter run
**API cost:** ~$0 (embeddings cached after first run)

## Why this Cat exists

`world-v1` (the 240-page rich-prose corpus driving Cats 1+2 and Cat 13) has zero `wintermute/chat/`, `daily/`, or `media/x/` content. The default boost map in `gbrain` v0.22.0 dampens those bulk directories, but `world-v1` can't measure the effect ... every page is curated.

Cat 13b ships a corpus deliberately shaped around the swamp pattern: short opinionated articles compete against long dense chat dumps that mention the same multi-word phrases. Without source-aware ranking, chat pages dominate (higher per-byte keyword density). With it, the curated article wins.

## Three-way scorecard (same corpus, same 30 queries)

| gbrain version           | Top-1 hit | Top-3 hit | Swamp@top (lower=better) |
|--------------------------|-----------|-----------|--------------------------|
| **v0.22.0** (this branch — source-boost) | **93.3%** | **100.0%** | **6.7%** |
| v0.21.0 master (two-pass retrieval)      | 90.0%     | 100.0%    | 10.0%                    |
| v0.20.4 master (pre-two-pass)            | 90.0%     | 100.0%    | 10.0%                    |

**Δ v0.22 vs v0.20.4:** +3.3pts top-1, −3.3pts swamp.
**Δ v0.22 vs v0.21.0:** +3.3pts top-1, −3.3pts swamp.

v0.21.0's two-pass retrieval is orthogonal to source-swamp resistance ... it's about call-graph edges and parent-scope chunking, which doesn't reach the directory-level ranking signal that source-boost provides.

## Adapter scorecard (v0.22.0 source-boost branch)

| Adapter                | Top-1 hit | Top-3 hit | Swamp@top | Notes                                     |
|------------------------|-----------|-----------|-----------|-------------------------------------------|
| **gbrain** (v0.22.0)   | **93.3%** | **100.0%** | **6.7%**  | Source-aware ranking + hybrid pipeline   |
| vector-grep-rrf-fusion | 93.3%     | 100.0%    | 6.7%      | Same as gbrain ... boost shows up here too |
| vector                 | 96.7%     | 100.0%    | 3.3%      | Vector wins on conceptual recall as expected |
| grep-only              | 80.0%     | 96.7%     | 20.0%     | Source-blind ... 20% of queries return chat at #1 |

Vector edges out gbrain at top-1 because Cat 13b is fundamentally a topic-recall workload, which favors vector similarity. The headline read: every gbrain-using adapter matches or beats grep-only by 13+ points top-1 and dramatically reduces swamp-at-top.

## What "swamp@top" means

For each query, `swamp@top` counts queries where ≥1 chat page ranked above the curated target. v0.20.4 and v0.21.0 both surface chat at #1 for 3/30 queries. v0.22.0 reduces that to 2/30. The two stubborn cases (q12, q27) involve queries where the chat page genuinely contains more direct discussion of the phrase than the curated article ... legitimately hard signal, not a defect.

## Per-query breakdown (v0.22.0 gbrain)

28/30 queries return the curated `originals/` page at rank 1. The two misses:

| Query | Phrase | Why it missed |
|-------|--------|---------------|
| q12 | "founder default-mode organizational drag" | Chat 04-10 has the most direct per-byte discussion of "organizational drag" as a phrase. Curated page mentions it once. Target ranks #3 (still in top-3). |
| q27 | "foundation models substitutability vendor diversification" | Chat 04-17 explicitly debates "vendor diversification". Curated page mentions it once. Target ranks #3. |

Both targets stay in top-3, so an agent reading top-3 results will see the curated answer.

## Methodology

- **Corpus:** 10 curated `originals/` pages (1KB each, single-topic, opinionated) + 10 `wintermute/chat/` pages (3-5KB each, multi-topic, dense). Committed JSON ... no regeneration.
- **Queries:** 30 multi-word phrases, hand-curated. Each query appears in BOTH the strict target (curated page) AND ≥1 chat distractor.
- **Qrel:** strict target = grade 3, chat distractors = grade 0.
- **Adapters:** gbrain (full hybrid pipeline), vector-grep-rrf-fusion (gbrain with graph disabled), vector (cosine-only), grep-only (BM25). Source-blind adapters expected to lose ... that's the corpus design.
- **No gold leakage:** queries don't reproduce `_facts` or compiled_truth content. Phrasing is paraphrased.
- **Determinism:** seed=42 mulberry32 for any randomized templates. The 30 queries are hand-written, not generated.

## Reproduction

```sh
# In gbrain-evals/
bun link gbrain                        # link a local gbrain checkout
bun eval/runner/cat13b-source-swamp.ts
```

To compare against a specific gbrain version:

```sh
# Pin gbrain to a specific commit hash in package.json:
#   "gbrain": "github:garrytan/gbrain#11abb24"
rm -rf node_modules/gbrain bun.lock && bun install
bun eval/runner/cat13b-source-swamp.ts
```

## What this Cat does NOT cover

- **Real-world swamp at scale.** This corpus has 20 pages. A real personal brain has 10K+. The shape is right; the scale is small.
- **Temporal-bypass correctness.** The `detail=high` gate that lets chat surface for date-framed queries isn't tested here. Cat 4 (Temporal) is the right home for that.
- **Tuning sensitivity.** Default boost map (`originals/` 1.5×, `wintermute/chat/` 0.5×) was used. Per-deployment tuning via `GBRAIN_SOURCE_BOOST` env var isn't exercised.

These belong in Cat 13b v2 if usage signal motivates them.
