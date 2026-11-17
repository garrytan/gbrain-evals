### PGLite versus Postgres engine shootout: results at 1,000 and 10,000 pages

- [The report](docs/benchmarks/2026-11-16-engine-shootout.md) measures gbrain's PGLite and Postgres-with-pgvector engines
  on the same pages, vectors and queries. PGLite's hybrid search takes 1.35 times Postgres's time at 1,000 pages (95%
  interval 1.33 to 1.36) and 1.45 times at 10,000 pages (1.41 to 1.50), inside the preregistered 2x margin. At 10,000
  pages PGLite's hybrid-search p95 is 86.8 ms (13 ms inside the preregistered 100 ms limit) but its p99 is 142 ms, over
  100 ms, where Postgres is 39.5 ms and 47.7 ms. The preregistered outcome stays `pglite_adequate`. The advice to use
  PGLite as the default up to about 1,000 pages and Postgres beyond is a reading of secondary data. PGLite reads pages
  and backlinks 2.5 times slower at 10,000 pages and holds about 2 GB of memory. The engines gave the same top results
  on all 71 quality queries. On 200 extra probe queries at 10,000 pages they differed on 4 top results in vector and
  hybrid search. The Rust engine is not measured. Receipts and charts are under
  `docs/benchmarks/2026-11-16-engine-shootout/`.
