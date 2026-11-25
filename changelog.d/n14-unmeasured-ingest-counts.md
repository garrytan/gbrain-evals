- **N14 large-page fidelity no longer reports counts it could not take as 0 on an engine without raw SQL.** On such an
  engine (the Rust engine today), `eval/runner/n14-large-page-fidelity.ts` wrote the stored page and chunk counts, the
  append's chunk counts and the stored-needle count as 0, so a page the engine had chunked read as "stored with 0
  chunks" and could be filed as the zero-chunk finding N14-1. Those counts are now null, with a `not_applicable` reason
  on the ingest and append rows, the stored-needle rate is null, the findings skip a null chunk count, and the
  printed tables show n/a. No committed receipt is from such an engine, so no published number changes.
