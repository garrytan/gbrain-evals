# Embedding providers with and without reranking: the reranker matters, the embedder barely does

**Finding.** On concept questions, turning on Voyage's `rerank-2.5` reranker improves gbrain's search far more than switching embedders, and no supported embedder beat gbrain's default, Voyage `voyage-4`. On October 6, 2026, at gbrain `c5fb0201` (v0.60.95.0), on 181 held-out concept questions, `voyage-4` with the reranker put an exact target first on **130**, `voyage-4-large` on 128, OpenAI `text-embedding-3-large` on 126, and a local `qwen3-embedding:8b` (Ollama, on a CPU machine) on 120. The reranker added 13 to 17 points of first-place rate for every embedder (Holm-adjusted p = 0.03 each). Without it, the four embedders landed between 90 and 103. None of the three alternatives differed from `voyage-4` with the reranker at this sample size; `voyage-4-large` is within the preregistered 5-point margin, so it is as good, and the other two are not distinguished. The local embedder keeps document text on the machine at no API cost, but with the hosted reranker, queries and candidate passages still go to Voyage.

Status: **Complete** (8 of 8 Cat 13 runs and 8 of 8 synthetic-v1 cells valid; the local synthetic-v1 cells needed one rerun after a harness defect, see below). Evidence class: **development evidence**. Preregistration: [2026-10-06-embedding-matrix-preregistration.md](2026-10-06-embedding-matrix-preregistration.md), pushed before any cell (`f4377da`), with two amendments recorded before the affected runs.

## The question and the arms

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents: it stores notes as Markdown and searches them with keyword matching plus vector similarity from an embedding model. A reranker is a second model that reads the question together with each candidate passage and reorders the candidates. The question is which embedder `docs/settings.md` should recommend, with and without reranking, once cost, latency and where the data goes are counted.

| Embedder | Dimensions | Where the text goes, reranker off | with `voyage:rerank-2.5` |
|---|---:|---|---|
| `voyage:voyage-4` (gbrain's default) | 1,024 | hosted embedding | hosted embedding, hosted reranking |
| `voyage:voyage-4-large` | 1,024 | hosted embedding | hosted embedding, hosted reranking |
| `openai:text-embedding-3-large` | 1,536 | hosted embedding | hosted embedding, hosted reranking |
| `ollama:qwen3-embedding:8b` (local) | 4,096 | no text leaves the machine | local embedding, hosted reranking |

The local cell ran Ollama 0.35.1 with `qwen3-embedding:8b` (digest `64b93349…`, Q4_K_M, 7.6B parameters) on a 16-vCPU, CPU-only Ubicloud VM, reached through an SSH tunnel from the machine that made every paid call. At 4,096 dimensions the vectors exceed pgvector's index limits (2,000 for `vector`, 4,000 for `halfvec`), so gbrain searched them by exact scan, which is fine at this size.

**Corpora.** The decision set is Cat 13's held-out concept split: the world-v1 corpus (240 pages, 30 concept pages), 548 template questions at seed 42, concepts split 20/10 at seed 42, and the 181 questions about the 10 held-out concepts. A concept question names an idea in other words ("the framework I wrote about Brink Labs" for a page about agentic workflows). Search was pinned exactly as in the [October 2 concept report](2026-10-02-concept-vector-rerank.md) (`balanced` mode, autocut off, expansion off, cache off). Synthetic-v1 (Cat 18b: 165 pages, 25 derived questions) is report-only. Every run built its index from scratch in its own in-memory brain, and every reranked run had a reranker score on every query (548 of 548, 25 of 25), so none is invalid.

## Results

Held-out concept questions (Cat 13, 181 questions; retrieval from gbrain `c5fb0201`):

| Embedder | Reranker | Exact target first (of 181) | nDCG@5 | All 548: exact target first | Query-phase cost per 1,000 queries | Mean / 95th pct query time |
|---|---|---:|---:|---:|---:|---:|
| `voyage-4` | on | **130** | 0.661 | 419 | $0.51 | 471 / 894 ms |
| `voyage-4-large` | on | 128 | 0.644 | 406 | $0.49 | 461 / 646 ms |
| `text-embedding-3-large` | on | 126 | 0.658 | 416 | $0.52 | 616 / 1,100 ms |
| `qwen3-embedding:8b` (local) | on | 120 | 0.624 | 367 | $0.38 | 794 / 1,029 ms |
| `voyage-4` | off | 99 | 0.577 | 344 | $0.0003 | 197 / 231 ms |
| `voyage-4-large` | off | 97 | 0.547 | 341 | $0.0007 | 222 / 267 ms |
| `text-embedding-3-large` | off | 103 | 0.582 | 327 | $0.0009 | 369 / 653 ms |
| `qwen3-embedding:8b` (local) | off | 90 | 0.531 | 322 | $0 API | 1,237 / 4,144 ms |

The cost column is ledger spend between the end of indexing and the end of the query loop, which covers query embeddings and reranking, per 1,000 queries; the reranker dominates it. Local embedding costs nothing in API fees but needs the machine (here a 16-vCPU VM); its latency includes the tunnel's network round trip. `voyage-4` with the reranker reproduces the October 2 result exactly (130 of 181).

Paired comparisons on held-out exact target first, clustered by concept (10 clusters, exact sign-flip test, cluster-bootstrap 95% interval; exact McNemar beside):

| Comparison | Difference | 95% interval | Gained / lost | p (Holm) | Reading |
|---|---:|---|---|---:|---|
| **Primary, reranker on:** `voyage-4-large` vs `voyage-4` | −1.1 points | −3.8 to +1.1 | 2 / 4 | 0.81 | as good (inside the 5-point margin) |
| `text-embedding-3-large` vs `voyage-4` | −2.2 points | −5.7 to +1.1 | 3 / 7 | 0.81 | not distinguished |
| `qwen3-embedding:8b` vs `voyage-4` | −5.5 points | −11.9 to 0 | 8 / 18 | 0.47 | not distinguished |
| Reranker off: `voyage-4-large` vs `voyage-4` | −1.1 | −5.1 to +2.7 | 6 / 8 | 1.0 | report-only |
| `text-embedding-3-large` vs `voyage-4` | +2.2 | −3.4 to +7.1 | 12 / 8 | 1.0 | report-only |
| `qwen3-embedding:8b` vs `voyage-4` | −5.0 | −8.4 to −1.1 | 6 / 15 | 0.19 | report-only |
| Reranker effect, `voyage-4` | +17.1 | +7.8 to +26.7 | 40 / 9 | 0.03 | report-only |
| Reranker effect, `voyage-4-large` | +17.1 | +9.2 to +25.7 | 36 / 5 | 0.03 | report-only |
| Reranker effect, `text-embedding-3-large` | +12.7 | +5.4 to +20.0 | 30 / 7 | 0.03 | report-only |
| Reranker effect, `qwen3-embedding:8b` | +16.6 | +8.2 to +26.0 | 34 / 4 | 0.03 | report-only |

With only 10 concept clusters, the smallest possible two-sided p is 0.002, and the Holm-adjusted 0.03 is the floor for these four reranker comparisons: every concept moved the same way.

Synthetic-v1 (Cat 18b, 165 pages, 25 questions; report-only). With the reranker, every embedder reaches the same MRR (0.660) and first-place rate (52%); Recall@10 is 0.62 for `voyage-4`, 0.65 for `voyage-4-large`, 0.50 for `text-embedding-3-large` and 0.69 for the local model. Without it, MRR is 0.42 to 0.45 and first place 12% to 16%. Rerank cost there is about $0.10 to $0.14 per 1,000 queries (shorter candidates than Cat 13's pages). 25 questions can't separate embedders; this corpus mostly confirms the reranker effect.

## What to use and what to avoid

- **Turn on the reranker** (`search.reranker.enabled`, `voyage:rerank-2.5`, the `balanced` default with a Voyage key). It is worth 13 to 17 points of first-place rate on concept questions whatever the embedder, for about $0.50 per 1,000 queries here.
- **Keep `voyage-4` as the default embedder.** Nothing beat it. `voyage-4-large` is as good at twice the embedding price; `text-embedding-3-large` is not distinguished from it, so an OpenAI-only setup is reasonable, but this run can't call it equivalent.
- **A local embedder is viable where documents must stay on the machine**, with a cost: `qwen3-embedding:8b` trailed `voyage-4` by about 5 points (not significant at this size), indexing on a 16-vCPU CPU machine took close to an hour for 240 pages, and its 4,096-dimension vectors can't use pgvector's index, so large brains would search by slow exact scan. With the hosted reranker, query and candidate text still leaves the machine.

`docs/settings.md` needs no change in recommendation from this run; it gains fresh evidence for the current one (the preregistered "keep the current recommendation" outcome).

Limits: one synthetic corpus per question set, 10 held-out concepts, one run per cell, keyword and vector signals at gbrain's defaults, and local timing on one CPU VM.

## Harness defects found and fixed (preregistration amendments)

1. Before any paid request, the first launch was refused because the runners' built-in cost estimates exceeded the per-run budgets; they now take explicit estimates.
2. In the first Cat 18b run, both local cells failed at indexing (0 of 165 pages embedded) because the runners configure gbrain's gateway directly, and gbrain reads `OLLAMA_BASE_URL` only when it builds the gateway itself. Cat 18b, Cat 13 and the `gbrain-inline` adapter now pass `base_urls.ollama`. The two local Cat 18b cells reran once on their own; the six hosted cells keep their first-run results ([`cat18b-hosted.receipt.json`](2026-10-06-embedding-matrix/cat18b-hosted.receipt.json) shows the failed local cells). The local Cat 13 runs started after the fix.

The four local runs finished inside the preregistered 120-minute time box (105 minutes from the first local Cat 13 start).

## Reproduce and inspect

Keyless, $0, from the committed receipts (every table above, validity, egress and the paired tests):

```bash
bun eval/runner/w6-embedding-matrix.ts summarize docs/benchmarks/2026-10-06-embedding-matrix
```

Expected: held-out first 130, 128, 126, 120 (reranker on) and 99, 97, 103, 90 (off); primary family p_holm 0.8125, 0.8125, 0.4688.

Live reruns (L is the ledger; hosted cells need `VOYAGE_API_KEY` and `OPENAI_API_KEY`; the local cell needs Ollama with `qwen3-embedding:8b` reachable at `OLLAMA_BASE_URL`):

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 bun eval/runner/cat18b-embedding-rerank-matrix.ts --budget-ledger L --budget-usd 3
# per embedder E with dimensions D, reranker R in off|on:
OLLAMA_BASE_URL=... OLLAMA_API_KEY=ollama bun eval/runner/cat13-conceptual.ts --adapter gbrain --reranker R --embedding-model E --embedding-dims D \
  --autocut off --seed 42 --tuning-concepts 20 --holdout-concepts 10 --search-pin search.metadata_boost_gate=lexical --search-pin search.expansion=false \
  --search-pin search.cache.enabled=false --search-pin search.relational_rerank_pin=3 --search-pin search.adaptive_return=false \
  --budget-ledger L --budget-usd 0.85 --estimate-usd 0.5
```

Spend: $1.17 in the round's ledger (Cat 13 runs $1.15, Cat 18b $0.02), against a $6 estimate and a $10 cap; no Ubicloud cost is counted. Wall time: hosted Cat 13 runs 3 to 7 minutes each, local Cat 13 runs 58 and 47 minutes, local Cat 18b cells 32 minutes. The Ubicloud VM was destroyed after the runs. Artifacts in [`2026-10-06-embedding-matrix/`](2026-10-06-embedding-matrix/): the eight gzipped Cat 13 receipts (every question's top five, observed reranker counts, per-phase cost and latency, preregistration attestation), both Cat 18b receipts, the run logs and `summary.json`.
