# Preregistration: cat13 three-way engine baseline (written 2026-11-18, before any paid run)

Bench: eval/runner/cat13-conceptual.ts, gbrain arm only (`--adapter gbrain --reranker off --autocut off`),
world-v1 corpus, default probe count (CAT13_PROBES unset, seed 42), openai:text-embedding-3-large @ 1536d.
All engines load the same gbrain build (rust-cli-members 6ad51d6b90dd).
One shared embedding cache: the first (warm-up) run pays for vectors; every scored run reads the same vectors.

Prediction:
- PGLite and Postgres return the same quality numbers within 0.5 points nDCG@5, because they run the same SQL
  and the same vectors. Any gap comes from ties and index (HNSW vs exact) ordering, not a quality difference.
- Postgres in Docker is slower per query than in-process PGLite at p50 on this 240-page corpus.
- Rust: the stub smoke run already refused an embedded import (upsertChunks option embeddingColumn).
  Prediction: the live run refuses the same way, so no Rust quality number is possible on this build.

Stop rules:
- Stop and report if Rust refuses any step of the fixed pipeline (import, extract, hybridSearch). Do not change
  the pipeline for one engine only.
- Stop if spend passes the budget-ledger program cap. [Amount redacted from this public copy, per repo policy; the private original is unchanged.]
- Never call a winner from one run; 3 scored runs per engine, interleaved, warm-up excluded.

Metrics (computed from saved per-query rows by summarize.py):
- nDCG@5 and P@5 exactly as cat13 scores them (graded gold: target=3, peer=1; P@5 counts grade>=1).
- R@5: share of the probe's grade-3 targets in the top 5. MRR@5: 1/rank of the first grade-3 target in the top 5, else 0.
- p50/p95 query latency from per-query wall time in the adapter (hybridSearch call), cost per query from the ledger.
