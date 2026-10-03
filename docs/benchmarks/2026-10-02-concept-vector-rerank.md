# Concept search with the same reranker on both sides

**Finding.** With the same Voyage reranker, vector search and gbrain finish close together on our held-out concept questions. On October 2, 2026, at gbrain `d44296c` (v0.60.30.0), gbrain with reranking put an exact target first on 130 of 181 held-out questions and vector search with the same reranker on 128 of 181. Question by question, gbrain won the first position on 8 questions and lost it on 10 (exact two-sided sign test p = 0.81), so this run shows no difference between them. Reranking helped both: vectors rose from 118 to 128, gbrain from 99 to 130.

This closes the gap the September 28 audit (finding B2) recorded. Until now, the reranked gbrain cell (130/181) had no reranked vector cell to compare with.

## The questions and the arms

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents: it stores notes as Markdown and builds a search index over them. A concept question names an idea in other words, for example "the framework I wrote about Brink Labs" for a page about agentic workflows (a fictional company in the synthetic world-v1 corpus). The system has to find the concept page even though the question shares few words with it.

The corpus has 240 pages, 30 of them concept pages. Cat 13 generates 548 questions from fixed templates (probe seed 42) and splits the 30 concepts 20/10; the 181 questions about the ten held-out concepts are the decision set. A reranker is a second model that reads the question together with each candidate passage and reorders the candidates.

| Arm | What it does |
|---|---|
| `vector` | Embeds each page once (title, compiled truth and timeline) and ranks pages by cosine similarity to the question |
| `vector-rerank` (new) | The same vector ranking, then the top 25 pages through gbrain's own `applyReranker` with `voyage:rerank-2.5`, the input depth and timeout of gbrain's `balanced` mode |
| `gbrain` | gbrain's hybrid search (keyword, vector and metadata signals), lexical metadata gate, reranker off |
| `gbrain` + reranker | The same with the reranker on |

Every arm used Voyage `voyage-4` embeddings at 1024 dimensions. gbrain arms were pinned to `search.mode=balanced`, autocut off, expansion off, cache off, `search.metadata_boost_gate=lexical`, `search.relational_rerank_pin=3`, `search.adaptive_return=false`, matching the September 9 cells. Both reranked arms had a reranker score on all 548 questions, with no skip, failure or pass-through.

One difference remains: gbrain reranks the matched chunk of each result, while `vector-rerank` reranks the page text the vector arm embedded, capped by gbrain's `capRerankDoc`. The reranker therefore did not read byte-identical documents in the two arms.

## Results

| Arm (gbrain `d44296c`, October 2) | Held-out exact target first (of 181) | Held-out nDCG@5 | All 548: nDCG@5 | All 548: exact target first |
|---|---:|---:|---:|---:|
| `vector` | 118 | 0.6058 | 0.5957 | 383 |
| `vector-rerank` | 128 | 0.6645 | 0.6497 | 436 |
| `gbrain` | 99 | 0.5771 | 0.5728 | 344 |
| `gbrain` + reranker | 130 | 0.6614 | 0.6370 | 419 |

nDCG@5 rewards placing more relevant pages near the top: the exact target has grade three and a related page grade one. "Exact target first" asks only whether the first result is an exact target. They measure different things.

Paired on the same 181 held-out questions:

| Change | First-place gained | First-place lost | nDCG gains | nDCG losses | Ties |
|---|---:|---:|---:|---:|---:|
| Add the reranker to vectors | 16 | 6 | 61 | 20 | 100 |
| Add the reranker to gbrain | 40 | 9 | 80 | 34 | 67 |
| Switch from reranked gbrain to reranked vectors | 8 | 10 | 42 | 28 | 111 |

Reranked vectors had higher nDCG@5 on 42 questions and lower on 28 (sign test p = 0.12); reranked gbrain had more exact targets first, 130 against 128. Neither margin is a demonstrated difference at this sample size.

## Against the September 9 cells

The September cells ran at gbrain v0.48.4.0 (`2efaaf8`). Vector search is unaffected by the gbrain version apart from the shared embedding gateway, and it reproduced exactly (118/181). gbrain without the reranker moved from 102 to 99, and gbrain with it stayed at 130. The September numbers remain the record of that pin; the October numbers are the matched set.

| Held-out exact target first (of 181) | September 9 (v0.48.4.0) | October 2 (v0.60.30.0) |
|---|---:|---:|
| `vector` | 118 | 118 |
| `vector-rerank` | not run | 128 |
| `gbrain` | 102 | 99 |
| `gbrain` + reranker | 130 | 130 |

## What to use

For concept-style questions, the reranker is the setting that matters, on either retrieval path. gbrain with reranking and vector search with the same reranker reached the same level here. gbrain gained more from reranking because it started lower. If you already run gbrain, turn reranking on for this kind of workload. If you compare gbrain with a plain vector store, compare like with like: both reranked or both not. This is one synthetic corpus with ten held-out concepts; it supports a starting point, not a claim about every domain.

## Reproduce

From the repository root, with `VOYAGE_API_KEY` set:

```bash
COMMON="--embedding-model voyage:voyage-4 --embedding-dims 1024 --autocut off --seed 42 \
  --tuning-concepts 20 --holdout-concepts 10 \
  --search-pin search.metadata_boost_gate=lexical --search-pin search.expansion=false \
  --search-pin search.cache.enabled=false --search-pin search.relational_rerank_pin=3 \
  --search-pin search.adaptive_return=false --budget-usd 3"
bun eval/runner/cat13-conceptual.ts --adapter vector --reranker off $COMMON
bun eval/runner/cat13-conceptual.ts --adapter vector-rerank --reranker on $COMMON
bun eval/runner/cat13-conceptual.ts --adapter gbrain --reranker off $COMMON
bun eval/runner/cat13-conceptual.ts --adapter gbrain --reranker on $COMMON
```

Each run overwrites `eval/reports/cat13-conceptual/receipt.json`; copy it before the next. Observed cost from the budget ledger: $0.51 for `vector-rerank`, $0.29 for reranked gbrain, about $0.01 for each unreranked arm, plus $0.26 for a 278-question smoke run of the new adapter. Each arm took 3 to 5 minutes. The run plan was committed beforehand in [the paid-reruns plan](2026-10-02-paid-reruns-plan.md).

Artifacts: [summary.json](2026-10-02-concept-vector-rerank/summary.json) (per-arm settings, observations and every question's top five per arm) and the four gzipped receipts and run logs in [the same folder](2026-10-02-concept-vector-rerank/).
