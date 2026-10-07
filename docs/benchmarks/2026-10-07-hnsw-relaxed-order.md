# Filtered vector search: relaxed HNSW scan order finds about 2 more true matches per 100 at a 50% filter, at the same latency

**Measured by gbrain's fix wave 11 lane on October 7, 2026, on real 1024- and 1536-dimension embeddings; mirrored into this repository the same day with the raw results and the bench script. This mirror reruns nothing and spent $0.**

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. It keeps notes as Markdown and indexes them in a database. On Postgres, its vector search uses pgvector's HNSW index, an approximate nearest-neighbour graph that finds close vectors without comparing the query with every stored chunk.

## The finding

gbrain fix wave 11 (branch `capy/fix-wave-11`, head [`b5c8fd5e8`](https://github.com/garrytan/gbrain/commit/b5c8fd5e8b0bbeef43606796e884de73ccfb292e), implementing commit `f7f08506f`, W6.3) changes how filtered vector searches scan the HNSW index: `hnsw.iterative_scan` goes from `strict_order` to `relaxed_order`. **Verdict: relaxed_order ships default-on.**

- With a filter that keeps half of the brain, recall@10 rose from 0.962 to 0.983 on `voyage-4` at 1,024 dimensions and from 0.950 to 0.967 on `text-embedding-3-small` at 1,536 dimensions. At k=50 it was unchanged (0.951 to 0.952, and 0.937 to 0.937).
- Recall was never lower in relaxed order.
- Latency did not move in a consistent direction. Across the 8 cells, the largest rise was +5.7% at p50 (+0.6 ms) and +7.0% at p95 (+5.7 ms); the largest fall was -7.9% at p95. No cell rose by more than 1 ms at both p50 and p95.
- With a filter that keeps 10%, both modes found every true match, so those rows cannot show a recall difference.

Wave 11's plan made this measurement the condition for changing the default: real embeddings at 1024 and 1536 dimensions, two filter selectivities, recall plus p50 and p95 latency, and the item leaves the wave if latency regresses beyond noise at either dimension. It did not. The numbers are in [`verdict.json`](2026-10-07-hnsw-relaxed-order/verdict.json).

## The concrete case

An agent asks a question in one source of a brain that holds several, so the vector search carries a source filter. HNSW walks its graph from the query outward and collects close chunks, but many of those chunks belong to other sources and are filtered out. pgvector's **iterative scan** keeps walking until enough chunks pass the filter.

In `strict_order`, the scan returns chunks in exact distance order, so a closer chunk that it reaches late, after farther ones were already returned, is dropped. In `relaxed_order` that late chunk is kept, and the output may be slightly out of order. gbrain sorts by distance again after it pools chunks into pages, so callers never see the relaxed order. The idea came from [#6132](https://github.com/garrytan/gbrain/pull/6132) by @MarvinDontPanic; the wave takes only the scan order and declines the PR's larger candidate envelope, which cost 25 to 30 times the vector latency in the lane's review.

## The experiment and results

**Corpus.** About 60,000 chunks of real text: gbrain's own `docs/`, `skills/`, `src/` and `test/` files (fixtures excluded), one page per file, chunks of up to 800 characters, at most 60 per page, 4,766 pages. Pages are spread over three sources by a hash of their slug: 10%, 40% and 50%. The **10% filter** keeps the first source; the **50% filter** keeps the first two.

**Queries and truth.** 100 queries, each the first sentence of a randomly chosen chunk (fixed seed), embedded as a query. The truth for each query is an exact scan with the same filter, pooled to each page's best chunk, top k pages. **Recall@k** is the share of those true pages that `PostgresEngine.searchVector` returned.

**Run.** Postgres 16 with pgvector 0.8.7 in a local Docker container (`pgvector/pgvector:pg16`) on the lane's cloud machine. HNSW with cosine distance and pgvector's default build settings; gbrain's own `ef_search` sizing and escalation loop, unchanged between modes. Five warm-up queries per mode, then the two modes alternate going first on each query so cache warmth is shared. One pass per lane.

`voyage-4` at 1,024 dimensions (60,022 chunks):

| Filter | k | Recall, strict | Recall, relaxed | p50 ms, strict / relaxed | p95 ms, strict / relaxed |
|---|---|---|---|---|---|
| 10% | 10 | 1.000 | 1.000 | 63.4 / 63.0 | 84.5 / 85.1 |
| 10% | 50 | 1.000 | 1.000 | 65.8 / 66.2 | 81.0 / 86.7 |
| 50% | 10 | 0.962 | **0.983** | 10.6 / 11.2 | 17.7 / 16.3 |
| 50% | 50 | 0.951 | 0.952 | 16.3 / 16.3 | 24.4 / 24.5 |

`text-embedding-3-small` at 1,536 dimensions (60,003 chunks):

| Filter | k | Recall, strict | Recall, relaxed | p50 ms, strict / relaxed | p95 ms, strict / relaxed |
|---|---|---|---|---|---|
| 10% | 10 | 1.000 | 1.000 | 70.7 / 74.4 | 89.0 / 89.3 |
| 10% | 50 | 1.000 | 1.000 | 77.2 / 76.1 | 90.2 / 89.6 |
| 50% | 10 | 0.950 | **0.967** | 12.3 / 12.3 | 17.5 / 18.7 |
| 50% | 50 | 0.937 | 0.937 | 18.9 / 18.9 | 28.4 / 28.0 |

No search in either mode exited underfilled (fewer results than asked for).

**Reading the 10% rows.** They are both exact (recall 1.000 in both modes) and five to six times slower than the 50% rows. That pattern fits Postgres choosing a non-HNSW plan for the more selective filter, which the bench did not check with `EXPLAIN`. Either way, the scan mode has nothing to change there, so those rows show only that relaxed order does no harm.

**Reading the latency.** Each cell is one pass of 100 queries, with no repeated runs to measure run-to-run spread. The differences go both ways (p50: 3 up, 2 down, 3 equal; p95: 5 up, 3 down), the biggest p50 change is under 4 ms, and no cell rose by more than 1 ms at both p50 and p95. We read that as noise, with the caveat that no repeat quantifies it.

## What to use and what to avoid

Leave the default on. Brains with several sources, or any filtered vector search where the filter keeps a large share of chunks, find slightly more of their true neighbours at no measured cost. To restore the old behaviour without a release, run `gbrain config set search.hnsw_iterative_scan strict_order` (or set `GBRAIN_HNSW_ITERATIVE_SCAN`) and restart the process that serves search; `off` turns iterative scans off.

Limits:

- **Small gain, one pass.** About 2 points of recall@10 at the 50% filter, nothing at k=50, from one pass per lane. The direction matches the lane's synthetic run and the lane's Postgres test fixture, but the size is not established beyond these runs.
- **The 128-dimension synthetic lane.** The wave's review lane first measured this on 128-dimension clustered synthetic vectors (200,000 chunks, 60 queries, Postgres 16, pgvector 0.8.7). There, relaxed order raised 10%-filter recall@10 from 0.867 to 0.950 (+8.3 points) at 7.0 to 6.6 ms p50, and left unfiltered search unchanged (k=10: 0.927 to 0.925 at 5.4 to 5.9 ms; k=50: 0.986 to 0.987 at 7.5 to 7.7 ms). That gain is much larger than anything seen on real embeddings, and its script was lane scratch, not published. It is recorded here as a limit, not as evidence for the default.
- **One corpus.** Source code and documentation text, not personal notes. The two lanes' corpora differ by 19 chunks because the checkout's files changed between the two runs.
- **One machine, local Docker.** Hardware load from other work on the machine was not controlled.
- **PGLite is not covered.** gbrain's PGLite engine showed no strict/relaxed difference on the lane's fixtures, so this result is about Postgres.

## Reproduce and inspect

The bench lives in gbrain at `scripts/bench/hnsw-iterative-scan.ts` (added in `f7f08506f`, byte-identical at the lane head `8e2c720b9` and the wave head `b5c8fd5e8`). A copy is in [`bench/`](2026-10-07-hnsw-relaxed-order/bench/hnsw-iterative-scan.ts) for reading; it imports gbrain's source, so run it from a gbrain checkout. It needs a Postgres role that may `CREATE DATABASE` and `CREATE EXTENSION vector`, and `VOYAGE_API_KEY` or `OPENAI_API_KEY`:

```sh
docker run -d --name hnsw-bench -e POSTGRES_PASSWORD=postgres -p 5434:5432 pgvector/pgvector:pg16
export DATABASE_URL=postgresql://postgres:postgres@localhost:5434/postgres
bun scripts/bench/hnsw-iterative-scan.ts --embed voyage --dims 1024 --chunks 60000 --queries 100
bun scripts/bench/hnsw-iterative-scan.ts --embed openai --dims 1536 --chunks 60000 --queries 100
```

The lane's exact command line was not recorded; its logs show about 60,000 chunks and 100 queries, which `--chunks 60000 --queries 100` reproduces (the script's default is 30,000 chunks).

Embedding about 60,000 chunks cost a few cents per lane (the lane's estimate; not metered by this repository's ledger). Embeddings are cached under `--cache`, so reruns are free. From the logs, the Voyage lane took 17 minutes and the OpenAI lane 9 minutes, most of it embedding and index building. The corpus is the checkout's own text, so a different gbrain commit gives a slightly different corpus.

Raw results: [`raw/voyage-1024.md`](2026-10-07-hnsw-relaxed-order/raw/voyage-1024.md) and [`raw/openai-1536.md`](2026-10-07-hnsw-relaxed-order/raw/openai-1536.md) are the bench's printed tables; the `.log` files beside them are the full run logs, with one JSON line per cell.
