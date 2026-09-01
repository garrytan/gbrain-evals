# BrainBench v0.20.0 baseline — multi-adapter scorecard

> **Erratum status (2026-09-01): numbers below are pre-audit and pending
> re-measurement.** This run predates the 2026-08-31 audit's fixes to the
> shared metric helpers: recall could exceed 1.0 on chunk-grained duplicates
> (finding shared-infra-02) and precision divided by returned-list length
> instead of k (shared-infra-03). It also ran on the world-v1 corpus before
> the dangling person-to-company link fix (generators-06), and v0.5.0
> declared earlier BrainBench scores not comparable to post-audit runs. No
> receipt for this run is committed. Read 97.9% R@5 / 49.1% P@5 and the
> "graph layer worth ~31 points" delta as directional, not exact, until the
> re-measurement on the fixed helpers lands (queued in TODOS.md).
>
> **Methodology caveat (issue #24 finding 6):** the gbrain adapter in
> `eval/runner/multi-adapter.ts` (~lines 221-258) parses the exact four
> relational query templates that `buildRelationalQueries()` emits into graph
> traversals, while the baseline adapters text-match. The code comment is
> candid about why, and skipping non-applicable families beats shipping fake
> zeros — but part of the graph-layer delta rests on a parser co-designed
> with the query generator. A template-blind variant (paraphrased queries) is
> queued in TODOS.md to show how much of the lift survives.

**Date:** 2026-04-23
**gbrain commit:** `96852c0` (PR #195 HEAD, v0.20.0)
**gbrain-evals commit:** `8dab7f7` (post plain-English adapter rename)
**Run:** `BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts`
**N:** 1 (deterministic stddev=0 on all adapters; re-runs reproduce exactly)
**Wall clock:** ~3 min on an M3 laptop
**API cost:** ~$0 (embeddings cached; no agent loop, no judge)

## Why this run exists

First committed BrainBench baseline after v0.20's extraction of the eval harness into this sibling repo. Purpose: **establish the canonical v0.20.0 number for Cats 1+2 retrieval precision and recall**, pinned against the exact gbrain commit that ships (`96852c0`). All four adapters were renamed to plain-English slugs (`gbrain`, `vector-grep-rrf-fusion`, `grep-only`, `vector`) before this run — the numbers are identical to the `gbrain-after`/`hybrid-nograph`/`ripgrep-bm25`/`vector-only` readings from the v0.12.1 reference scorecard because nothing in v0.16→v0.20 touches retrieval.

## Side-by-side scorecard

| Adapter                     | Runs | Queries | P@5       | R@5       | correct in top-5 |
|-----------------------------|------|---------|-----------|-----------|------------------|
| **gbrain**                  |    1 |     145 | **49.1%** | **97.9%** | **248 / 261**    |
| vector-grep-rrf-fusion      |    1 |     145 |     17.8% |     65.1% |     129 / 261    |
| grep-only                   |    1 |     145 |     17.1% |     62.4% |     124 / 261    |
| vector                      |    1 |     145 |     10.8% |     40.7% |      78 / 261    |

## Deltas vs gbrain

| Adapter                | Δ P@5       | Δ R@5       | Δ correct-in-top-5 |
|------------------------|-------------|-------------|---------------------|
| vector-grep-rrf-fusion | −31.4 pts   | −32.9 pts   | −119                |
| grep-only              | −32.0 pts   | −35.5 pts   | −124                |
| vector                 | −38.4 pts   | −57.2 pts   | −170                |

**The graph layer is worth 31 points P@5.** Turn it off (`vector-grep-rrf-fusion`) and you land essentially on the keyword-only baseline (`grep-only`). Turn vectors off on top of that and you're at `grep-only` stone cold. Those are two separable wins, and they're both load-bearing.

## vs v0.12.1 historical reference

| Adapter                | v0.12.1 P@5 | v0.20.0 P@5 | Δ         |
|------------------------|-------------|-------------|-----------|
| gbrain                 | 49.1%       | 49.1%       | **0.0**   |
| vector-grep-rrf-fusion | 17.8%       | 17.8%       | 0.0       |
| grep-only              | 17.1%       | 17.1%       | 0.0       |
| vector                 | 10.7%       | 10.8%       | +0.1      |

Flat. All four adapters within ±0.1 pt of v0.12.1 → **no retrieval regression across v0.16 / 0.17 / 0.18.0 / 0.18.1 / 0.18.2 / 0.19.0 / 0.20.0**. Seven releases that shipped ops/infra work (gbrain dream, multi-source brains, RLS hardening, migration hardening, check-resolvable, eval-repo split) without disturbing retrieval.

## Config card

- **Adapters:** `gbrain` (PGLite + graph + hybrid fusion), `vector-grep-rrf-fusion` (gbrain with graph disabled), `grep-only` (classic BM25 keyword IR), `vector` (cosine with the same embedder as gbrain)
- **Corpus:** `eval/data/world-v1/` — 240 rich-prose fictional pages (80 people, 80 companies, 50 meetings, 30 concepts), Opus-generated, committed, regeneratable from seed
- **Gold:** 145 relational queries derived from `_facts` metadata; sealed at the adapter boundary via `PublicPage` / `PublicQuery`
- **Top-K:** 5
- **Runtime:** Bun 1.3.10, `pglite@0.4.3` in-memory, `postgres@3.4.9`, `pgvector@0.2.1`
- **Embedding model:** `text-embedding-3-large` (OpenAI)
- **Determinism:** stddev = 0.0 on all four adapters at N=1; re-runs reproduce byte-identically

## Methodology

- Each adapter re-ingests raw pages into an isolated PGLite instance.
- No gold data visible to adapters — `_facts` stripped at the `sanitizePage` boundary, `gold` stripped at `sanitizeQuery`.
- Metrics are macro-averaged P@5 / R@5 across all 145 queries.
- `gbrain` ingest runs `put_page` + auto-link post-hook + reconciliation. `vector-grep-rrf-fusion` disables auto-link via `GBRAIN_DISABLE_AUTO_LINK=1` to isolate the graph-layer contribution.
- Reproduction: clone `gbrain-evals`, `bun install && bun link gbrain` (points at a local gbrain checkout), `OPENAI_API_KEY=... bun run eval:run:dev`.

## What this does NOT cover

Full BrainBench v1 Complete includes 10/12 Cats. This scorecard runs only Cats 1+2 (retrieval precision / recall at K). The other shipped Cats — identity (Cat 3), temporal (Cat 4), provenance (Cat 5), prose-scale (Cat 6), performance (Cat 7), skill compliance (Cat 8), end-to-end workflows (Cat 9), adversarial (Cat 10), multi-modal (Cat 11), MCP contract (Cat 12) — are wired up in `eval/runner/all.ts` and driven by `bun run eval:brainbench:smoke`. They're not run here because (a) agent-loop Cats cost ~$22 of LLM calls at N=1 smoke tier, and (b) "does retrieval regress v0.16 → v0.20" is what this run was asked to answer. See the companion Cat 13 Conceptual Recall scorecard from the same date for the conceptual-retrieval axis.

Next time: `bun run eval:brainbench:smoke` for full Cat coverage, or `eval:brainbench:published` (N=10, ~$215) for a release-grade baseline with tolerance bands.
