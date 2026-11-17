### PGLite versus Postgres engine shootout: results at 1,000 and 10,000 pages

- [The report](docs/benchmarks/2026-11-16-engine-shootout.md) measures gbrain's PGLite and Postgres-with-pgvector engines
  on the same pages, vectors and queries. PGLite's hybrid search takes 1.35 times Postgres's time at 1,000 pages (95%
  interval 1.33 to 1.36) and 1.45 times at 10,000 pages (1.41 to 1.50), inside the preregistered 2x margin. PGLite reads
  pages and backlinks 2.5 times slower at 10,000 pages and holds about 2 GB of memory. The engines return identical
  results. The Rust engine is not measured. Receipts and charts are under `docs/benchmarks/2026-11-16-engine-shootout/`.
