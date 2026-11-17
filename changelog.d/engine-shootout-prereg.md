### Preregistration and runner for the PGLite versus Postgres engine shootout

- [The preregistration](docs/benchmarks/2026-11-16-engine-shootout-preregistration.md) freezes the question (which engine
  to pick for a brain of 1,000 or 10,000 pages), the corpus and query fingerprints, the paired analysis with intervals,
  the decision rule and the stop rules, before any counted run. The Rust engine is a documented hook, not an arm.
- `bun run eval:engine-shootout` (`eval/runner/engine-shootout.ts`) runs gbrain's own PGLite and Postgres-with-pgvector
  engines on the same pages, vectors and queries, interleaved, and writes a receipt with per-query rows.
  `eval/runner/engine-shootout-chart.ts` turns receipts into SVG charts and a summary table. No results are included.
