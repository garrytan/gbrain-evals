# Starting the query embed alongside the keyword arms saves about 150 ms per search on a 20,000-page Postgres brain (2026-10-13)

## The finding

gbrain v0.60.214.0 (gbrain#6641, master `23fdb464a`) starts the vector side of `search` and `query` (modality, expansion, query embeds, vector searches) together with the keyword, title and relational arms. Before, it waited for them to finish. The vector side reads nothing those arms produce, so results are unchanged.

On a 20,000-page Postgres brain with real Voyage embeddings and reranking, median warm `search` fell from 578 / 572 ms to 424 / 402 ms over two rounds. `query` fell from 578 / 548 ms to 448 / 428 ms. On a 400-page PGLite brain the saving is only the keyword arms' 13 to 15 ms. For `query` on that brain, run-to-run variation in the LLM expansion time hides it.

This is the follow-up that the [low-hanging fruit plan](../plans/2026-10-11-low-hanging-fruit/PLAN.md) deferred until item 5's stage timings could show the embed's share of search time.

## How it was measured

Each run is one warm in-process `search` and `query` operation per question (`receipts/warm.ts`), after three warm-up calls. The question text is unique per call so gbrain's in-process query-embed cache never hits. Master `9d154bf53` and the branch were run in alternating rounds against the same database, both with the same provider keys.

| Brain | Questions | Op | master median (round 1 / 2) | branch median (round 1 / 2) |
|---|---|---|---|---|
| Postgres 16, 20,000 bench pages, 40,003 chunks | 40 (`receipts/queries-bench-brain.txt`) | `search` | 578 / 572 ms | 424 / 402 ms |
| same | same | `query` | 578 / 548 ms | 448 / 428 ms |
| PGLite, 400 pages of gbrain's own docs, 4,161 chunks | 40 (`receipts/queries-docs-brain.txt`) | `search` | 456 / 429 ms | 419 / 410 ms |
| same | same | `query` | 1,787 / 1,659 ms | 1,794 / 1,673 ms |

On the 20k brain, the query embed (about 120 to 130 ms) now finishes inside the keyword arms (90 to 175 ms). Each response's `_meta.retrieval.timings.overlapped_ms.embed` records the overlapped part, which the receipts show at a median of 90 to 118 ms. Rerank (200 to 260 ms) is still the largest stage for `search`. On the docs brain, `query`'s LLM expansion takes a median of about 1.0 to 1.1 s. It still has to finish before the variant embeds can start, so the overlap saves only the keyword arms' time there.

## Results unchanged

- **Bench digests:** on the refactor-wave-1 bench (stub embedder and reranker, 40 responses), result digests match master on PGLite and on Postgres at 400 pages (`7727530313ca5883`).
- **Retained 20k Postgres brain, stub providers:** 80 of 80 result lists match master (`receipts/s-*.json`; each row stores a hash of its result list, `ids_sha256`, not the slugs); master against itself is also 80 of 80.
- **Real-provider runs:** the result lists differ run to run for master against itself too (Voyage reranker scores vary slightly), so they are not a parity check.
- **Not a parity check either:** fresh 4,000-page Postgres imports, where master's own digests differ run to run because the HNSW index is rebuilt on each import.

## Validity notes

- **Synthetic content on Postgres.** The 20k brain is the bench's synthetic vocabulary (two-syllable nonsense words). It has real Voyage query embeddings but synthetic content, and its page embeddings are the bench's stub vectors. So the vector arm's results are not meaningful there. Its timings are, since the query embed is a real Voyage call.
- **One machine.** Both brains ran on a 4-vCPU cloud machine with Postgres in a local container. A brain whose keyword arms are slower than the embed (#6495's 8.6M-chunk brain) saves the full embed time. A brain whose keyword arms are faster than the embed saves only the keyword time.
- **Cost:** about $0.40 in provider calls: Voyage embeddings for the docs brain and the query and rerank calls across all runs.
