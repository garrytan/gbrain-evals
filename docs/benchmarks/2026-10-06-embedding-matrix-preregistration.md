# Preregistration: embedding-provider matrix with and without reranking (W6)

Written 2026-10-06, before any cell of this experiment ran on a live provider. Plan: [W6 in the 2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md). Results go to [`2026-10-06-embedding-matrix/`](2026-10-06-embedding-matrix/).

## Question

Which embedder that gbrain supports should `docs/settings.md` recommend, with and without the Voyage reranker, once cost, latency and where the data goes are counted? The current table (Cat 18/18b) predates the Voyage 4 family and has no local cell, and on synthetic-v1 its cells tie. The Cat 13 held-out concept split (181 questions) separates retrieval settings where synthetic-v1 does not, so it is the decision set.

## Evidence class

Development evidence. Synthetic-v1 and the Cat 13 world-v1 concept questions have been used in earlier tuning of gbrain's search defaults. Nothing here is a held-out confirmation; "held-out" below names Cat 13's seeded concept split, not a sealed set.

## Build and data

- gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0), installed as `node_modules/gbrain`.
- **Synthetic-v1** (`eval/data/synthetic-v1/`, 240 pages, 25 derived queries) through `eval/runner/cat18b-embedding-rerank-matrix.ts`.
- **Cat 13 held-out concept split** through `eval/runner/cat13-conceptual.ts --adapter gbrain`: world-v1 corpus (240 pages, 30 concept pages), 548 template questions at probe seed 42, concept split 20/10 at seed 42; the 181 questions about the 10 held-out concepts are the decision set. Pins exactly as the 2026-10-02 concept report: `search.mode=balanced`, autocut off, `search.metadata_boost_gate=lexical`, `search.expansion=false`, `search.cache.enabled=false`, `search.relational_rerank_pin=3`, `search.adaptive_return=false`.
- Every cell and run builds its index from scratch in its own fresh in-memory PGLite brain.

## Arms

Four embedders, each with the reranker off and with `voyage:rerank-2.5` on (gbrain's `balanced` reranker path, input depth sized to the fetch in Cat 18b and gbrain's mode default in Cat 13):

| Embedder | Dimensions | Where the text goes |
|---|---:|---|
| `voyage:voyage-4` (gbrain's default embedder; comparator) | 1,024 | hosted embedding |
| `voyage:voyage-4-large` | 1,024 | hosted embedding |
| `openai:text-embedding-3-large` | 1,536 | hosted embedding |
| `ollama:qwen3-embedding:8b` (local) | 4,096 | local embedding |

With the reranker on, every cell also sends queries and candidate passages to Voyage; the local cell is then labeled "local embedding, hosted reranking", never "local".

**Local cell.** Ollama 0.35.1 on a Ubicloud `standard-16` VM (16 vCPU, 62 GB RAM, CPU only, eu-central-h1), model `qwen3-embedding:8b`, digest `64b933495768fbd3b87c20583d379728a07471e0c66733a9df87cd1901b3c44b` (Q4_K_M, 7.6B parameters). The runners reach it from the primary machine through an SSH tunnel (`OLLAMA_BASE_URL=http://127.0.0.1:21434/v1`, no public port), so every paid reranker call still starts on the primary machine under the ledger. The VM holds no provider keys. 4,096 dimensions exceed pgvector's index limits (2,000 for `vector`, 4,000 for `halfvec`), so gbrain searches this cell by exact scan; that is valid on 240 pages and is reported. Its query latency includes the tunnel's network round trip to the VM. Time box: the four local runs get 120 minutes of wall time in total; a local run not finished inside it, or one whose VM or model fails, is published as **Failed** (or **Not run** if it never started) with the reason, and the hosted cells are reported without it.

No model generates or judges anything.

## Metric and denominator

- **Primary (Cat 13 held-out):** exact target first (`p1_strict`), denominator 181 questions per run. Secondary: held-out nDCG@5 (target grade 3, related page grade 1), and both metrics on all 548 questions.
- **Synthetic-v1 (report-only):** Recall@10, MRR and first-place rate over 25 queries per cell.
- **Per cell:** query-phase cost per 1,000 queries (ledger spend between the end of indexing and the end of the query loop, which covers query embeddings and reranking; local embedding compute is not counted and is reported as $0 API cost plus the VM size), indexing cost, mean, median and 95th-percentile query latency, and data egress.
- **Errors:** a query that errors or degrades to keyword-only scores 0 and stays in the denominator. A reranked cell or run whose reranker did not score every query is **invalid** (Cat 18b's existing fail-open check; for Cat 13, `observed.rerank_scored_queries` must equal 548), and is published as invalid, not scored. Analysis unit: the question. Cluster for intervals: the held-out concept (10 clusters, `cluster_id` in the receipt).

## Decision rule

Primary family, Cat 13 held-out, reranker on: each of `voyage-4-large`, `text-embedding-3-large` and `qwen3-embedding:8b` against `voyage-4` on exact target first, paired question by question and clustered by concept (exact sign-flip test over the 10 concepts, cluster-bootstrap 95% interval, seed 20261006, 10,000 draws), Holm-corrected across the three. The exact McNemar test on the same pairs is reported beside it. Report-only families, each Holm-corrected on its own: the same three comparisons with the reranker off; the reranker's effect per embedder (on minus off); nDCG@5; and everything on synthetic-v1.

Minimum detectable effect: with 10 clusters the smallest exact two-sided p is 2/1024; a Holm-adjusted p under 0.05 needs nearly every concept to move the same way, roughly an 8 to 10 point difference in first-place rate (15 to 18 of 181 questions) with consistent direction.

Non-inferiority margin: 5 points of first-place rate. An embedder is "as good as `voyage-4`" only when its interval's lower bound is above −0.05; otherwise a non-significant difference is "not distinguished at this sample size".

## What each outcome changes

| If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|
| `docs/settings.md` recommends the winning embedder per workload | Keep the current recommendation with fresh evidence | No recommendation change; cells reported as not distinguished at this sample size |

"Wins" means an embedder beats `voyage-4` in the primary family (Holm-adjusted p under 0.05); "loses" means none does and `voyage-4` is at least non-inferior. Cost per 1,000 queries and egress are reported beside every row and can qualify a recommendation (for example, a local embedder that is non-inferior can be recommended where data must stay on the machine) but cannot turn a loss into a win.

## Budget

Ledger `/workspace/gbrain-evals/.budget/followups-2026-10.sqlite`, workstream cap $10 (the plan's), estimate $6. Cat 18b runs once for all 8 cells with `--budget-usd 3`; each of the 8 Cat 13 runs has `--budget-usd 0.85` (worst case $9.80 together). Every paid request passes the ledger's paid-request guard; local Ollama calls go to localhost and cost nothing. A refused reservation stops that run, which is published as partial. If spend passes $7.50 (25% over the estimate) before the matrix is done, the remaining runs are reported as **Not run**.

Commands (each attests this preregistration before its first paid request and records the attestation in its receipt):

```bash
OLLAMA_BASE_URL=http://127.0.0.1:21434/v1 bun eval/runner/cat18b-embedding-rerank-matrix.ts --preregistration <this file> --budget-ledger <ledger> --budget-usd 3
# for each embedder E (model, dims) and R in off, on:
OLLAMA_BASE_URL=... OLLAMA_API_KEY=ollama bun eval/runner/cat13-conceptual.ts --adapter gbrain --reranker R --embedding-model E --embedding-dims D \
  --autocut off --seed 42 --tuning-concepts 20 --holdout-concepts 10 <the five --search-pin flags above> \
  --preregistration <this file> --budget-ledger <ledger> --budget-usd 0.85
```

The keyless summary, `bun eval/runner/w6-embedding-matrix.ts summarize <results dir>`, computes every table and test from the committed receipts.

## Amendments

**2026-10-06, before any paid request.** The first launch was refused at budget-run open, before any provider call: the runners' built-in estimates ($4 for Cat 18b's 8 cells, the Cat 13 registry's $3 per run) exceeded the per-run budgets above. Cat 18b now estimates from the corpus size and list prices (`estimateMatrixUsd`), and Cat 13 takes `--estimate-usd` (0.5 for reranked runs, 0.1 otherwise). Budgets, arms, metrics and decision rules are unchanged.

**2026-10-06, after the Cat 18b run, before any local Cat 13 run.** In the Cat 18b run both local cells failed at indexing (0 of 165 pages embedded, "embedding_deferred"): the runners configure gbrain's gateway directly, and gbrain reads `OLLAMA_BASE_URL` only when it builds the gateway config itself, so the local cells tried `localhost:11434` instead of the tunnel. This is a harness defect, not the embedder's. The runners (Cat 18b, Cat 13 and the `gbrain-inline` adapter) now pass `base_urls.ollama` from `OLLAMA_BASE_URL`. The two local Cat 18b cells are rerun once on their own (`--cells qwen3-local,qwen3-local+rerank`, same budget rules); the six hosted cells keep their first-run results, and the failed first attempt stays in the receipts.
